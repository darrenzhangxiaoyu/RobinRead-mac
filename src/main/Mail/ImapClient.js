'use strict';
/**
 * RobinRead（知更）— 自研轻量 IMAPS 客户端（F6，零新依赖）
 *
 * Electron 主进程经 node:tls 直连 IMAPS（默认 993，TLS 即连无 STARTTLS）。
 * 只实现 Newsletter 收件所需的最小命令集：
 *   LOGIN / SELECT INBOX / SEARCH（SINCE + FROM）/ FETCH（BODY.PEEK 头+正文）/
 *   NOOP / LOGOUT。
 *
 * 协议解析要点：
 * - 命令严格串行（tag 前缀 A001…），同一时刻至多 1 个在途命令；
 * - literal `{n}`：行尾出现 {n} 时按字节数读后续裸块（Keep in sync RFC 3501 §4.3），
 *   以「逻辑行记录 {line, literal}」交付上层，literal 永远是原始 Buffer；
 * - unsolicited 响应（* OK / * BYE / * EXISTS 等）归入当前命令的 units，由调用方按需读取；
 * - 错误分类：auth（认证失败）/ network（不可达/连接中断）/ tls（证书校验失败）/
 *   protocol（NO/BAD 语义）/ timeout（连接 15s、命令 30s）。
 * - 并发约束在 MailService 层（单账户单连接 + 全局 ≤2 账户），客户端只管单连接语义。
 */
const tls = require('node:tls');
const net = require('node:net');
const { i18n } = require('../I18N');

/** IP 字面量（IPv4/IPv6）不可作 SNI servername。 */
function isIPLiteral(host) {
  return net.isIP(host) !== 0;
}

const CONNECT_TIMEOUT_MS = 15 * 1000;
const COMMAND_TIMEOUT_MS = 30 * 1000;
const MAX_LINE_BYTES = 16 * 1024;          // 命令行（非 literal 部分）上限
const CRLF = '\r\n';

/** TLS 证书类错误特征码：rejectUnauthorized 时归为 tls 类（提示可开自签名开关）。 */
const TLS_ERROR_PATTERNS = [
  'certificate', 'self-signed', 'self signed', 'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SSL routines',
];

/** 统一错误：kind ∈ auth | network | tls | protocol | timeout，message 已本地化。 */
class MailError extends Error {
  constructor(kind, message, { cause = null, serverText = null } = {}) {
    super(message);
    this.name = 'MailError';
    this.kind = kind;
    if (cause) this.cause = cause;
    if (serverText) this.serverText = serverText;
  }
}

/** 按来源分类连接级错误（connect 阶段与 socket 中断共用）。 */
function classifySocketError(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || err || '');
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN'
    || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ECONNRESET'
    || code === 'EPIPE' || code === 'ETIMEDOUT') {
    return new MailError('network', i18n.localized('邮箱服务器连接失败（网络不可达或服务拒绝）。'), { cause: err });
  }
  const lower = msg.toLowerCase();
  if (TLS_ERROR_PATTERNS.some((p) => lower.includes(p.toLowerCase()))) {
    return new MailError('tls', i18n.localized('TLS 证书校验失败。若服务器使用自签名证书，可在设置中开启「允许自签名」（有安全风险）。'), { cause: err });
  }
  return new MailError('network', i18n.localized('邮箱连接中断。'), { cause: err });
}

/** IMAP quoted string：包裹双引号并转义 \ 与 "；控制字符直接拒绝（密码不应含）。 */
function quoteString(value) {
  const text = String(value ?? '');
  if (/[\r\n\x00-\x1f]/.test(text)) {
    throw new MailError('protocol', i18n.localized('用户名或密码含不允许的控制字符。'));
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** IMAP SEARCH 日期：dd-Mon-yyyy（服务器按 UTC 日界比较）。 */
function imapDate(seconds) {
  const d = new Date(Number(seconds) * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (x) => String(x).padStart(2, '0');
  return `${p2(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

class ImapClient {
  /**
   * @param {object} opts
   * @param {string} opts.host  IMAP 主机
   * @param {number} [opts.port=993]
   * @param {string} opts.username
   * @param {string} opts.password
   * @param {boolean} [opts.allowSelfSigned=false] 自签名证书放行（明示风险，默认拒绝）
   * @param {Function} [opts.tlsFactory] 可注入（探针离线化）：默认 node:tls.connect
   */
  constructor({
    host, port = 993, username, password,
    allowSelfSigned = false,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    commandTimeoutMs = COMMAND_TIMEOUT_MS,
    tlsFactory = null,
  } = {}) {
    this.host = String(host || '').trim();
    this.port = Number(port) || 993;
    this.username = String(username ?? '');
    this.password = String(password ?? '');
    this.allowSelfSigned = Boolean(allowSelfSigned);
    this.connectTimeoutMs = connectTimeoutMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this._tlsFactory = tlsFactory || tls.connect.bind(tls);

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.units = [];          // 当前命令收集的响应行记录 [{line, literal}]
    this._pending = null;     // {resolve, reject, tag, timer}
    this._tagCounter = 0;
    this._closed = false;
    this._greeting = null;    // Promise<* OK 行>
    this._closedPromise = null; // socket 完全 close 后 resolve（会话衔接用，见 waitClosed）
  }

  // MARK: 连接

  /** TLS 连接并等待服务器问候（* OK / * PREAUTH）。 */
  connect() {
    if (this.socket) return Promise.reject(new MailError('protocol', i18n.localized('连接已存在。')));
    if (process.env.ROBIN_IMAP_DEBUG) console.error('[imap-debug] connect() enter');
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
                if (settled) return;
        settled = true;
        this._destroy();
        reject(new MailError('timeout', i18n.localized('连接邮箱服务器超时。')));
      }, this.connectTimeoutMs);

      let socket;
      try {
        // RFC 6066：SNI 不可为 IP 字面量（Node 25 起直接抛 ERR_INVALID_ARG_VALUE，
        // 旧版也仅是告警）——IP 直连时省略 servername，证书校验按 IP SAN 走。
        const tlsOptions = {
          host: this.host,
          port: this.port,
          rejectUnauthorized: !this.allowSelfSigned,
        };
        if (!isIPLiteral(this.host)) tlsOptions.servername = this.host;
        socket = this._tlsFactory(tlsOptions);       } catch (err) {
        clearTimeout(timer);
        reject(classifySocketError(err));
        return;
      }
      this.socket = socket;

      socket.once('connect', () => {
        if (process.env.ROBIN_IMAP_DEBUG) console.error('[imap-debug] tcp connect fired');
      });
      socket.once('secureConnect', () => {
        if (process.env.ROBIN_IMAP_DEBUG) console.error('[imap-debug] secureConnect fired');
        clearTimeout(timer);
        // 问候行由 read loop 归入 units；此处等第一条逻辑行
        this._awaitGreeting().then(resolve, reject);
      });
      socket.once('close', () => {
        if (process.env.ROBIN_IMAP_DEBUG) console.error('[imap-debug] socket close fired');
      });
      socket.once('error', (err) => {         clearTimeout(timer);
        if (!settled) { settled = true; reject(classifySocketError(err)); }
        this._failAll(classifySocketError(err));
      });
      socket.once('close', () => {
        this._closed = true;
        this._failAll(new MailError('network', i18n.localized('邮箱连接中断。')));
      });
      socket.on('data', (chunk) => this._onData(chunk));
      socket.setNoDelay(true);
    });
  }

  /** 等待服务器问候行（* OK … / * PREAUTH …；* BYE = 拒绝）。 */
  _awaitGreeting() {
    if (this._greeting) return this._greeting;
    this._greeting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new MailError('timeout', i18n.localized('等待邮箱服务器响应超时。'))), this.connectTimeoutMs);
      const poll = () => {
        const record = this.units.find((u) => u.line.startsWith('* '));
        if (record) {
          clearTimeout(timer);
          if (/^\*\s+(OK|PREAUTH)/i.test(record.line)) resolve(true);
          else reject(new MailError('protocol', i18n.localized('邮箱服务器拒绝连接。'), { serverText: record.line }));
          return true;
        }
        return false;
      };
      if (poll()) return;
      this._greetingWaiter = () => { if (poll()) this._greetingWaiter = null; };
    });
    return this._greeting;
  }

  // MARK: 命令

  /** 发送一条命令并等待 tagged 响应（串行；返回 {status, text, units}）。 */
  async _command(body) {
    if (!this.socket || this._closed) {
      throw new MailError('network', i18n.localized('邮箱连接已关闭。'));
    }
    const tag = `A${String(++this._tagCounter).padStart(3, '0')}`;
    const units = [];
    if (process.env.ROBIN_IMAP_DEBUG) console.error(`[imap-debug] >> ${tag} ${body.slice(0, 60)}`);
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._destroy();
        reject(new MailError('timeout', i18n.localized('邮箱命令超时（30 秒无响应）。')));
      }, this.commandTimeoutMs);
      this._pending = {
        tag, units, resolve, reject, timer,
        line: `${tag} ${body}`,
      };
      this.socket.write(this._pending.line + CRLF);
    });
    if (process.env.ROBIN_IMAP_DEBUG) console.error(`[imap-debug] << ${tag} ${result.status}`);
    return result;
  }

  /** LOGIN：OK 即成功；NO = 凭据无效（auth 类）。 */
  async login() {
    const result = await this._command(`LOGIN ${quoteString(this.username)} ${quoteString(this.password)}`);
    if (result.status === 'OK') return true;
    throw new MailError('auth', i18n.localized('登录邮箱失败：用户名或密码不正确（或未开启 IMAP 访问）。'), { serverText: result.text });
  }

  /** SELECT INBOX → { exists }（* n EXISTS）。 */
  async selectInbox() {
    const result = await this._command('SELECT INBOX');
    if (result.status !== 'OK') {
      throw new MailError('protocol', i18n.localized('打开收件箱失败。'), { serverText: result.text });
    }
    let exists = 0;
    for (const unit of result.units) {
      const m = unit.line.match(/^\*\s+(\d+)\s+EXISTS\b/i);
      if (m) exists = Number(m[1]);
    }
    return { exists };
  }

  /**
   * SEARCH：SINCE（必填，秒）+ FROM（可选）→ 命中的序号数组（升序）。
   * 无命中时服务器回 `* SEARCH`（无数字）→ []。
   */
  async searchMessages({ sinceSeconds, from = null } = {}) {
    const parts = ['SEARCH', `SINCE ${imapDate(sinceSeconds)}`];
    if (from) parts.push(`FROM ${quoteString(from)}`);
    const result = await this._command(parts.join(' '));
    if (result.status !== 'OK') {
      throw new MailError('protocol', i18n.localized('邮箱搜索失败。'), { serverText: result.text });
    }
    for (const unit of result.units) {
      const m = unit.line.match(/^\*\s+SEARCH\b(.*)$/i);
      if (m) {
        return m[1].trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
      }
    }
    return [];
  }

  /**
   * FETCH 单条（头 + 正文，BODY.PEEK 不动 \Seen 标志）→
   * { headerText, bodyText }（均为原始字节解码前的 latin1 安全字符串）。
   */
  async fetchMessage(seq) {
    const result = await this._command(
      `FETCH ${Number(seq)} (BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE MESSAGE-ID)] BODY.PEEK[TEXT])`,
    );
    if (result.status !== 'OK') {
      throw new MailError('protocol', i18n.localized('邮件抓取失败。'), { serverText: result.text });
    }
    let headerText = null;
    let bodyText = null;
    // FETCH 响应可能拆成多条逻辑行（每条带各自 literal）：
    //   行1 `* n FETCH (BODY[HEADER.FIELDS …] {h}` + literal
    //   行2 ` BODY[TEXT] {b}` + literal
    //   行3 `)`
    // 逐行匹配条目说明符（literal 是独立 Buffer，不会污染行文本）。
    for (const unit of result.units) {
      if (headerText == null && /BODY(?:\.PEEK)?\[HEADER\.FIELDS[^\]]*\]\s*\{(\d+)\}/i.test(unit.line)) {
        headerText = unit.literal ? unit.literal.toString('latin1') : '';
        continue;
      }
      if (bodyText == null && /BODY(?:\.PEEK)?\[TEXT\]\s*\{(\d+)\}/i.test(unit.line)) {
        bodyText = unit.literal ? unit.literal.toString('latin1') : '';
      }
    }
    if (headerText == null || bodyText == null) {
      if (process.env.ROBIN_IMAP_DEBUG) {
        console.error('[imap-debug] units:', JSON.stringify(result.units.map((u) => ({ line: u.line.slice(0, 120), lit: u.literal ? u.literal.length : null }))));
      }
      throw new MailError('protocol', i18n.localized('邮件响应解析失败（服务器返回结构异常）。'));
    }
    return { headerText, bodyText };
  }

  async noop() {
    const result = await this._command('NOOP');
    if (result.status !== 'OK') throw new MailError('protocol', i18n.localized('邮箱心跳失败。'), { serverText: result.text });
    return true;
  }

  /** LOGOUT：尽力而为（服务器随后关连接，属预期，不视为错误）。 */
  async logout() {
    if (!this.socket || this._closed) return false;
    try {
      this._intentionalClose = true;
      await this._command('LOGOUT');
    } catch (_) { /* BYE 后的连接关闭已在预期内 */ }
    this._destroy();
    return true;
  }

  /** 强制断开（超时/错误路径）。 */
  _destroy() {
    if (this.socket) {
      const s = this.socket;
      // 记录「socket 完全关闭」信号：destroy 是异步生效的，下一个会话必须等
      // close 事件落地后再创建新 TLS socket——Windows 上同进程「前一会话 destroy
      // 与下一会话 tls.connect 竞态」会同步阻塞主线程（原生层死锁，实测连非 unref
      // 定时器都不触发），必须串行化衔接。
      if (!this._closedPromise) {
        this._closedPromise = new Promise((resolve) => {
          let done = false;
          const fin = () => { if (!done) { done = true; resolve(); } };
          s.once('close', fin);
          setTimeout(fin, 5000); // 兜底：close 事件极端不达时也不无限等
        });
      }
      try { s.destroy(); } catch (_) { /* 尽力而为 */ }
      this.socket = null;
    }
    if (!this._closedPromise) this._closedPromise = Promise.resolve();
    this._closed = true;
  }

  /**
   * 会话衔接：等本客户端的 socket 完全关闭（见 _destroy 注释）。
   * MailService 在每个 IMAP 会话收尾调用，保证下一条连接不会再撞 destroy 竞态。
   */
  async waitClosed(maxWaitMs = 6000) {
    if (!this._closedPromise) this._destroy();
    await Promise.race([
      this._closedPromise,
      new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
    ]);
  }

  // MARK: 读循环（literal 感知的逻辑行解析）

  _onData(chunk) {
    if (!this.socket) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this._drain();
  }

  /**
   * 从 buffer 中抽取完整逻辑行（含 literal 续读）：
   * 逻辑行 = 一条 CRLF 结尾的命令行；若行尾为 {n}，则随后必须紧跟 n 字节裸块 + CRLF。
   */
  _drain() {
    let guard = 0;
    for (;;) {
      guard += 1;
      if (process.env.ROBIN_IMAP_DEBUG && guard > 500) {
        console.error(`[imap-debug] drain loop guard=${guard} bufLen=${this.buffer.length}`);
        if (guard > 1000) throw new Error('drain runaway loop');
      }
      if (this.buffer.length === 0) return;
      const idx = this.buffer.indexOf(CRLF, 0, 'latin1');
      if (idx < 0) {
        if (this.buffer.length > MAX_LINE_BYTES * 16) this._failAll(new MailError('protocol', i18n.localized('邮箱响应解析失败（行过长）。')));
        return; // 等更多数据
      }
      const lineText = this.buffer.subarray(0, idx).toString('latin1');
      const literalMatch = lineText.match(/\{(\d+)\}$/);
      if (literalMatch) {
        const need = Number(literalMatch[1]);
        const afterLiteral = idx + 2 + need; // literal 结束后还须紧跟 CRLF
        if (this.buffer.length < afterLiteral + 2) return; // literal 未齐，等
        const literal = Buffer.from(this.buffer.subarray(idx + 2, idx + 2 + need));
        // literal 后必须紧跟 CRLF（RFC 3501），宽容处理缺失
        let consumed = idx + 2 + need;
        if (this.buffer.subarray(consumed, consumed + 2).toString('latin1') === CRLF) consumed += 2;
        this.buffer = this.buffer.subarray(consumed);
        this._emitLine(lineText, literal);
        continue;
      }
      this.buffer = this.buffer.subarray(idx + 2);
      this._emitLine(lineText, null);
    }
  }

  /** 交付一条逻辑行：归属当前在途命令（或问候）。tagged 行完结当前命令。 */
  _emitLine(line, literal) {
    // 空行（literal 之后的多余 CRLF 等）跳过
    const pending = this._pending;
    if (pending) {
      if (line.startsWith(`${pending.tag} `)) {
        const status = line.slice(pending.tag.length + 1).trim().split(/\s+/)[0].toUpperCase();
        const text = line.slice(pending.tag.length + 1).trim();
        clearTimeout(pending.timer);
        this._pending = null;
        pending.resolve({ status, text, units: pending.units });
        return;
      }
      pending.units.push({ line, literal });
      return;
    }
    // 无在途命令：问候或服务器主动推送
    this.units.push({ line, literal });
    if (this._greetingWaiter) this._greetingWaiter();
  }

  /** 连接级失败：拒绝在途命令（socket error/close 路径）。 */
  _failAll(err) {
    const pending = this._pending;
    if (pending) {
      clearTimeout(pending.timer);
      this._pending = null;
      pending.reject(err);
    }
  }
}

module.exports = { ImapClient, MailError, classifySocketError, imapDate, quoteString };
