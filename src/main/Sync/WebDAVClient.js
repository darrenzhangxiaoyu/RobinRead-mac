'use strict';
/**
 * RobinRead（知更）— 自研轻量 WebDAV 客户端（F7 多设备同步）
 *
 * 零新依赖：底层统一走注入的 fetch 实现（生产 = Electron net.fetch（系统代理），
 * 与 FeedService.httpFetch 同一条网络通路；纯 node（探针）回退全局 fetch）。
 * - 方法：PROPFIND（列目录/存在性，Depth 0/1）/ GET / PUT（If-Match ETag 可选）/
 *   MKCOL（建目录）/ MOVE（原子替换）；
 * - 鉴权：Basic Auth（用户名 + CredentialStore DPAPI 密码，本体不落日志）；
 * - 超时：单请求默认 30s（AbortController），超时归类 kind='timeout'；
 * - 响应护栏：单响应默认 8MB 上限（对齐上传侧快照护栏），超限中断下载并归类
 *   kind='tooLarge'（P2-6：原先 arrayBuffer() 无上限，异常响应可拖垮主进程内存）；
 * - 错误分类：auth（401/403）/ notFound（404）/ locked（423）/ conflict（412）/
 *   server（5xx 及其余 4xx）/ network（连接层）/ timeout / tooLarge。
 * 单连接顺序请求、无 TLS 会话复用 → 不存在 F6 那类 TLS destroy 竞态，无需 worker。
 */

/** 分类错误：kind ∈ auth|notFound|locked|conflict|server|network|timeout|tooLarge。 */
class DAVError extends Error {
  constructor(kind, message, { status = null } = {}) {
    super(message);
    this.name = 'DAVError';
    this.kind = kind;
    this.status = status;
  }
}

let netFetchImpl = null;
/** 注入 Electron net.fetch（main.js 启动时调用，与 FeedService 同一回退包装）。 */
function useNetFetch(fn) { netFetchImpl = fn; }

/** 统一请求通路：注入实现优先，纯 node 环境回退全局 fetch。 */
function transportFetch() {
  return netFetchImpl || fetch;
}

/** URL 路径段编码（保留既有分隔符语义：只编码单段）。 */
function encodeSegment(segment) {
  return encodeURIComponent(String(segment)).replace(/%2F/gi, '/');
}

/** 拼接 base 与相对路径段（base 允许带尾斜杠；段逐个编码）。 */
function joinURL(base, ...segments) {
  const trimmed = String(base || '').replace(/\/+$/, '');
  return [trimmed, ...segments.map(encodeSegment)].join('/');
}

/** 从 multistatus XML 提取 <href> 列表（兼容 D:/d: 前缀；轻量正则，够列目录用）。 */
function parseHrefs(xmlText) {
  const out = [];
  const re = /<(?:[A-Za-z0-9]+:)?href\s*>([^<]+)<\/(?:[A-Za-z0-9]+:)?href\s*>/g;
  let m;
  while ((m = re.exec(String(xmlText || ''))) !== null) {
    try { out.push(decodeURIComponent(m[1].trim())); } catch (_) { out.push(m[1].trim()); }
  }
  return out;
}

/** 单响应字节上限（对齐上传侧快照 8MB 护栏；超限中断下载）。 */
const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 流式读响应体并施加字节上限（P2-6）：超限立即 cancel 连接并抛 tooLarge，
 * 不再无上限 arrayBuffer() 把异常大响应整吞进主进程内存。
 * body 流不可用（罕见实现）时退回整体读取后校验。
 */
async function readBodyCapped(response, maxBytes, method) {
  const reader = response.body && typeof response.body.getReader === 'function'
    ? response.body.getReader()
    : null;
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new DAVError('tooLarge', `WebDAV response exceeds limit (${buf.length} > ${maxBytes} bytes) (${method})`);
    }
    return buf;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value ? value.byteLength : 0;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) { /* 连接已中止 */ }
      throw new DAVError('tooLarge', `WebDAV response exceeds limit (> ${maxBytes} bytes) (${method})`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

class WebDAVClient {
  /**
   * @param {object} opts
   * @param {string} opts.base        服务器基础地址（如 https://dav.jianguoyun.com/dav/）
   * @param {string} [opts.username]
   * @param {string} [opts.password]
   * @param {number} [opts.timeoutMs] 单请求超时（默认 30s）
   * @param {Function} [opts.fetchImpl] 测试注入；缺省用注入的 net.fetch / 全局 fetch
   */
  constructor({ base, username = '', password = '', timeoutMs = 30000, fetchImpl = null } = {}) {
    if (!base || !/^https?:\/\//i.test(String(base))) {
      throw new DAVError('server', 'WebDAV base URL must be http(s)');
    }
    this.base = String(base).replace(/\/+$/, '');
    this.username = String(username || '');
    this.password = String(password || '');
    this.timeoutMs = Number(timeoutMs) || 30000;
    this._fetch = fetchImpl || transportFetch();
  }

  /** Basic Auth 头（无用户名时不带 Authorization）。 */
  authHeaders(extra = {}) {
    const headers = { ...extra };
    if (this.username) {
      const token = Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64');
      headers.Authorization = `Basic ${token}`;
    }
    return headers;
  }

  /** 单请求：超时（AbortController）+ 响应字节护栏 + 错误分类。返回 { status, headers, buf }。 */
  async request(method, url, { headers = {}, body = null, timeoutMs = null, maxBytes = RESPONSE_MAX_BYTES } = {}) {
    const budget = Number(timeoutMs) || this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    let response;
    try {
      response = await this._fetch(url, {
        method,
        headers: this.authHeaders(headers),
        body,
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new DAVError('timeout', `WebDAV request timed out after ${budget}ms (${method})`);
      }
      throw new DAVError('network', `WebDAV request failed: ${String((err && err.message) || err)}`);
    } finally {
      clearTimeout(timer);
    }
    // P2-6：响应体流式读取 + 字节上限（默认 8MB，对齐上传侧护栏）；超限中断连接
    const buf = await readBodyCapped(response, maxBytes, method);
    const status = response.status;
    // HTTP 层错误分类（2xx/3xx 由调用方按方法语义处理）
    if (status === 401 || status === 403) {
      throw new DAVError('auth', `WebDAV auth failed (HTTP ${status})`, { status });
    }
    return { status, headers: response.headers, buf };
  }

  /** PROPFIND：Depth 0 = 存在性检查；Depth 1 = 列直接子项。404 → { exists:false }。 */
  async propfind(url, depth = 0) {
    const { status, headers, buf } = await this.request('PROPFIND', url, {
      headers: { Depth: String(depth) },
    });
    if (status === 404) return { exists: false, hrefs: [], status };
    if (status === 423) throw new DAVError('locked', 'WebDAV resource is locked (423)', { status });
    if (status < 200 || status >= 300) {
      throw new DAVError('server', `PROPFIND failed (HTTP ${status})`, { status });
    }
    const contentType = String(headers.get('content-type') || '');
    if (contentType.includes('json')) {
      // 某些服务端以 JSON 报 207（罕见）：尽量容错
      let parsed = null;
      try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { parsed = null; }
      return { exists: true, hrefs: Array.isArray(parsed) ? parsed : [], status };
    }
    return { exists: true, hrefs: parseHrefs(buf.toString('utf8')), status };
  }

  /** GET：200 → body Buffer；404 → DAVError('notFound')。 */
  async get(url) {
    const { status, buf, headers } = await this.request('GET', url);
    if (status === 404) throw new DAVError('notFound', 'WebDAV resource not found (404)', { status });
    if (status === 423) throw new DAVError('locked', 'WebDAV resource is locked (423)', { status });
    if (status < 200 || status >= 300) {
      throw new DAVError('server', `GET failed (HTTP ${status})`, { status });
    }
    return { status, body: buf, etag: headers.get('etag') || null };
  }

  /** PUT：2xx/3xx 成功；412（If-Match 不匹配）→ conflict；423 → locked。 */
  async put(url, body, { ifMatch = null, contentType = 'application/json' } = {}) {
    const headers = { 'Content-Type': contentType };
    if (ifMatch) headers['If-Match'] = ifMatch;
    const { status, headers: respHeaders } = await this.request('PUT', url, {
      headers, body: Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8'),
    });
    if (status === 412) throw new DAVError('conflict', 'WebDAV PUT conflict (412 If-Match)', { status });
    if (status === 423) throw new DAVError('locked', 'WebDAV resource is locked (423)', { status });
    if (status < 200 || status >= 400) {
      throw new DAVError('server', `PUT failed (HTTP ${status})`, { status });
    }
    return { status, etag: respHeaders.get('etag') || null };
  }

  /** MKCOL：201 创建；405 已存在（按成功处理返回 created:false）。 */
  async mkcol(url) {
    const { status } = await this.request('MKCOL', url);
    if (status === 201 || status === 200) return { created: true, status };
    if (status === 405 || status === 301) return { created: false, status }; // 已存在
    if (status === 423) throw new DAVError('locked', 'WebDAV collection is locked (423)', { status });
    throw new DAVError('server', `MKCOL failed (HTTP ${status})`, { status });
  }

  /** MOVE（WebDAV 原子替换；Destination 绝对地址）。 */
  async move(fromURL, toURL) {
    const { status } = await this.request('MOVE', fromURL, {
      headers: { Destination: toURL, Overwrite: 'T' },
    });
    if ((status >= 200 && status < 300) || status === 201) return { moved: true, status };
    if (status === 404) throw new DAVError('notFound', 'MOVE source not found (404)', { status });
    if (status === 423) throw new DAVError('locked', 'WebDAV resource is locked (423)', { status });
    throw new DAVError('server', `MOVE failed (HTTP ${status})`, { status });
  }

  url(...segments) {
    return joinURL(this.base, ...segments);
  }
}

module.exports = { WebDAVClient, DAVError, useNetFetch, joinURL, encodeSegment, parseHrefs, RESPONSE_MAX_BYTES };
