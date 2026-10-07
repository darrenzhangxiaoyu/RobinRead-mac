'use strict';
/**
 * RobinRead（知更）— 中文平台适配器服务（F5）
 *
 * 把中文平台内容转成知更的原生订阅流：
 * - bilibili：UP 主投稿 = space.bilibili.com/:uid/video 页面 + 内嵌 JSON
 *   （window.__INITIAL_STATE__）解析投稿列表；正文 = 描述 + 封面 + B 站 iframe 播放器；
 * - weibo：用户时间线 = m.weibo.cn container getIndex API（多数用户无需登录），
 *   转发条目取原微博文本；被风控（非 200 / ok≠1）时给出明确错误。
 *
 * 网络通路：复用 FeedService.httpFetch（net.fetch = 系统代理；纯 node 探针回退
 * 全局 fetch，可经 useNetFetch 注入 mock）；单源 30s 超时；ETag/If-None-Match
 * 条件请求语义与 FeedService.fetchFeed 一致。HTML/JSON 解析全部正则 + 局部解析
 * （jsdom 只允许在 extractor worker——项目铁律），平台抓取不碰 jsdom。
 */
const { httpFetch } = require('./FeedService');
const { i18n } = require('./I18N');

/** 平台抓取失败（风控/改版/网络）：statusCode 非 null 时视同 HTTP 错误（不再自动重试）。 */
class PlatformError extends Error {
  constructor(message, { statusCode = null } = {}) {
    super(message);
    this.name = 'PlatformError';
    this.statusCode = statusCode;
  }
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const FETCH_TIMEOUT_MS = 30 * 1000;
const MAX_ENTRIES = 30;

// MARK: - 小工具

function escapeHTMLText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 宽松 HTML → 纯文本（摘要用；实体解码 + 去标签）。 */
function htmlToText(value) {
  return String(value ?? '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * 从文本中 marker（如 `window.__INITIAL_STATE__=`）之后提取第一个完整 JSON 对象。
 * 花括号深度扫描 + 字符串/转义感知——比 `\{.*?\}` 非贪婪更抗「字符串里含 };(function」。
 */
function extractJSONObjectAfter(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  let i = at + marker.length;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (text[i] !== '{') return null;
  const start = i;
  let depth = 0;
  let inString = false;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

/** 深度遍历 JSON 树，收集满足 predicate 的节点（数组与对象都走；防环，深度限 12）。 */
function deepCollect(node, predicate, out = [], depth = 0) {
  if (node == null || depth > 12 || out.length > 500) return out;
  if (Array.isArray(node)) {
    for (const item of node) deepCollect(item, predicate, out, depth + 1);
    return out;
  }
  if (typeof node === 'object') {
    if (predicate(node)) out.push(node);
    for (const value of Object.values(node)) deepCollect(value, predicate, out, depth + 1);
  }
  return out;
}

/** "MM:SS" / "HH:MM:SS" / 秒数 → 秒。 */
function parseDurationSeconds(raw) {
  if (raw == null || raw === '') return null;
  if (Number.isFinite(Number(raw))) return Number(raw) > 0 ? Math.round(Number(raw)) : null;
  const parts = String(raw).split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0) || null;
}

function toSeconds(value) {
  if (value == null || value === '') return null;
  // 秒/毫秒时间戳直接收敛（Date.parse(数字) 会按年份字符串误解析）
  if (Number.isFinite(Number(value))) {
    const n = Number(value);
    if (n > 1e12) return Math.floor(n / 1000); // 毫秒
    return n > 1e9 ? Math.floor(n) : null;
  }
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/** 微博 cards 树收集：card.mblog 命中即收且不深入（转发层原微博不单独成条）。 */
function collectMblogs(node, out) {
  if (!node || typeof node !== 'object' || out.length > 200) return;
  if (Array.isArray(node)) {
    for (const item of node) collectMblogs(item, out);
    return;
  }
  if (node.mblog && typeof node.mblog === 'object') {
    collectMblogs(node.mblog, out);
    return;
  }
  if (node.id != null && (node.text != null || node.text_raw != null) && node.user != null) {
    out.push(node);
    return;
  }
  for (const value of Object.values(node)) collectMblogs(value, out);
}

/** 微博 created_at 宽松解析：
 * - "Wed Mar 13 12:30:00 +0800 2024"（标准 API 格式，手工解析防 V8 兼容差异）
 * - "刚刚" / "N分钟前" / "N小时前" / "今天 HH:mm" / "MM-DD" / "YYYY-MM-DD"
 */
function parseWeiboDate(raw, nowMs = Date.now()) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (value === '刚刚') return Math.floor(nowMs / 1000);
  const rel = value.match(/^(\d+)\s*(秒钟|分钟|小时)前$/);
  if (rel) {
    const unit = rel[2] === '秒钟' ? 1000 : rel[2] === '分钟' ? 60 * 1000 : 3600 * 1000;
    return Math.floor((nowMs - Number(rel[1]) * unit) / 1000);
  }
  const today = value.match(/^今天\s*(\d{1,2}):(\d{2})$/);
  if (today) {
    const d = new Date(nowMs);
    d.setHours(Number(today[1]), Number(today[2]), 0, 0);
    return Math.floor(d.getTime() / 1000);
  }
  const std = value.match(/^(\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+\+0800\s+(\d{4})$/);
  if (std) {
    const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const month = months[std[2]];
    if (month != null) {
      // +0800 固定时区：以 UTC 表示的北京时间
      return Math.floor(Date.UTC(Number(std[7]), month, Number(std[3]), Number(std[4]) - 8, Number(std[5]), Number(std[6])) / 1000);
    }
  }
  const md = value.match(/^(\d{1,2})-(\d{1,2})$/);
  if (md) {
    const year = new Date(nowMs).getFullYear();
    return Math.floor(Date.parse(`${year}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}T12:00:00+08:00`) / 1000) || null;
  }
  return toSeconds(value);
}

// MARK: - B 站适配器

const BILIBILI = {
  id: 'bilibili',
  /** 输入（纯数字 UID 或 space.bilibili.com 链接）→ UID 字符串；不可识别返回 null。 */
  parseRef(input) {
    const text = String(input || '').trim();
    if (/^\d{3,}$/.test(text)) return text;
    const m = text.match(/space\.bilibili\.com\/(\d+)/i);
    return m ? m[1] : null;
  },
  spaceURL(uid) { return `https://space.bilibili.com/${uid}`; },
  feedURL(uid) { return `bilibili://user/${uid}`; },
  requestURL(uid) { return `${this.spaceURL(uid)}/video`; },
  headers(uid) {
    return {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: this.spaceURL(uid),
      'Accept-Language': 'zh-CN,zh;q=0.9',
    };
  },

  /** 空间页 HTML → { title, siteURL, iconURL, entries }（正文含描述/封面/iframe 播放器）。 */
  parse(buf, uid) {
    const html = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    // 主路：花括号深度扫描；回退：任务书给定的非贪婪模式
    let state = extractJSONObjectAfter(html, 'window.__INITIAL_STATE__=');
    if (!state) {
      const m = html.match(/<script>window\.__INITIAL_STATE__=(\{.*?\});\(function/s);
      if (m) { try { state = JSON.parse(m[1]); } catch (_) { state = null; } }
    }
    if (!state || typeof state !== 'object') {
      throw new PlatformError(i18n.localized('B 站空间页解析失败：页面结构可能已改版，稍后自动重试。'), { statusCode: 502 });
    }

    // UP 主名：upData / upInfo 里的 name；深度扫描兜底（mid 匹配的对象带 name）
    const upName = state.upData?.name || state.upInfo?.name
      || deepCollect(state, (n) => n && n.name && (n.mid === Number(uid) || n.mid === String(uid)))[0]?.name
      || null;
    const title = upName || `B站UP主 ${uid}`;
    const iconURL = state.upData?.face || state.upInfo?.face || null;

    // 投稿列表：深度收集含 bvid+title 的节点（对页面状态结构改版鲁棒）
    const archives = deepCollect(
      state,
      (n) => n && typeof n.bvid === 'string' && /^BV[\w-]{6,}/i.test(n.bvid) && typeof n.title === 'string' && n.title.length > 0,
    )
      // 同一 BV 可能出现在多处分组：按 bvid 去重
      .filter((a, index, all) => all.findIndex((b) => b.bvid === a.bvid) === index)
      .slice(0, MAX_ENTRIES);

    const entries = archives.map((a) => this.entryFromArchive(a));
    return { title, siteURL: this.spaceURL(uid), iconURL, entries };
  },

  /** 单条投稿 → FeedParser 同构条目。封面/描述缺失时逐项退化，绝不抛错。 */
  entryFromArchive(a) {
    const bvid = String(a.bvid);
    const title = htmlToText(a.title) || bvid;
    const url = `https://www.bilibili.com/video/${bvid}`;
    const publishedAt = toSeconds(a.pubdate) ?? toSeconds(a.created) ?? toSeconds(a.ctime) ?? null;
    const cover = typeof a.pic === 'string' && /^https?:\/\//.test(a.pic) ? a.pic.replace(/^http:\/\//, 'https://') : null;
    const description = htmlToText(a.description || a.desc || '');
    const duration = parseDurationSeconds(a.length ?? a.duration);

    const parts = [];
    if (cover) parts.push(`<figure><img src="${escapeHTMLText(cover)}" alt=""></figure>`);
    if (description) parts.push(`<p>${escapeHTMLText(description)}</p>`);
    parts.push(
      `<p><iframe src="https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&autoplay=0" scrolling="no" frameborder="no" allowfullscreen="true"></iframe></p>`,
    );

    return {
      id: `bilibili:${bvid}`,
      title,
      url,
      publishedAt,
      summary: description || title,
      contentHTML: parts.join('\n'),
      cover,
      // 媒体中心（F3）目录：kind=video + 播放页 URL（播放走阅读器 iframe，此处只作目录）
      enclosure: { url, kind: 'video', mime: 'video/x-bilibili', durationSeconds: duration },
    };
  },
};

// MARK: - 微博适配器

const WEIBO = {
  id: 'weibo',
  /** 输入（纯数字 UID 或 weibo.com/u/:uid、m.weibo.cn/u/:uid 链接）→ UID 字符串。 */
  parseRef(input) {
    const text = String(input || '').trim();
    if (/^\d{4,}$/.test(text)) return text;
    const m = text.match(/(?:weibo\.com|m\.weibo\.cn)\/u\/(\d+)/i);
    return m ? m[1] : null;
  },
  siteURL(uid) { return `https://weibo.com/u/${uid}`; },
  feedURL(uid) { return `weibo://user/${uid}`; },
  requestURL(uid) {
    return `https://m.weibo.cn/api/container/getIndex?type=uid&value=${uid}&containerid=107603${uid}`;
  },
  headers(uid) {
    return {
      'User-Agent': MOBILE_UA,
      Accept: 'application/json, text/plain, */*',
      Referer: `https://m.weibo.cn/u/${uid}`,
      'X-Requested-With': 'XMLHttpRequest',
    };
  },

  /** getIndex JSON → { title, siteURL, iconURL, entries }；风控（非 200 语义/ok≠1/无 data）抛明确错误。 */
  parse(buf, uid) {
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    let res = null;
    try { res = JSON.parse(text); } catch (_) { res = null; }
    if (!res || typeof res !== 'object' || res.ok !== 1 || !res.data || !Array.isArray(res.data.cards)) {
      throw new PlatformError(i18n.localized('微博接口暂时不可用（可能被风控），稍后自动重试。'), { statusCode: 502 });
    }

    // cards 可能嵌套分组（card.cards）：递归收集所有 mblog。
    // 命中 mblog 即停（不深入内部）——retweeted_status（被转发的原微博）不是时间线独立条目。
    const mblogs = [];
    collectMblogs(res.data, mblogs);
    const deduped = mblogs.filter((m, index, all) => all.findIndex((b) => String(b.id) === String(m.id)) === index);

    const title = deduped[0]?.user?.screen_name || res.data.userInfo?.screen_name || `微博用户 ${uid}`;
    const iconURL = deduped[0]?.user?.avatar_hd || deduped[0]?.user?.profile_image_url || res.data.userInfo?.avatar_hd || null;

    const entries = deduped.slice(0, MAX_ENTRIES).map((m) => this.entryFromMblog(m, uid)).filter(Boolean);
    return { title, siteURL: this.siteURL(uid), iconURL, entries };
  },

  /** 单条 mblog → 条目。转发取原微博文本；正文/时间缺失退化为 null 字段。 */
  entryFromMblog(m, uid) {
    const id = String(m.bid || m.id || m.mid || '');
    if (!id) return null;
    const origin = m.retweeted_status && typeof m.retweeted_status === 'object' ? m.retweeted_status : null;
    const rawText = (origin ? (origin.text || origin.text_raw || '') : (m.text || m.text_raw || ''));
    const text = htmlToText(rawText);

    const parts = [];
    if (text) parts.push(`<p>${escapeHTMLText(text).replace(/\n/g, '<br>')}</p>`);
    const pics = (Array.isArray(m.pics) ? m.pics : [])
      .map((p) => (p && typeof p === 'object' ? (p.large?.url || p.url) : null))
      .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u))
      .map((u) => u.replace(/^http:\/\//, 'https://')) // 与 BILIBILI 同口径：明文图链升级 https（微博图床支持）
      .slice(0, 9);
    for (const pic of pics) parts.push(`<figure><img src="${escapeHTMLText(pic)}" alt=""></figure>`);
    const pageInfo = m.page_info && typeof m.page_info === 'object' ? m.page_info : null;
    if (pageInfo && pageInfo.type === 'video' && /^https?:\/\//i.test(String(pageInfo.page_url || ''))) {
      parts.push(`<p><a href="${escapeHTMLText(pageInfo.page_url)}">${escapeHTMLText(i18n.localized('查看视频'))}</a></p>`);
    }

    return {
      id: `weibo:${id}`,
      title: (text || i18n.localized('微博动态')).split('\n')[0].slice(0, 60) || i18n.localized('微博动态'),
      url: `https://weibo.com/${uid}/${id}`,
      publishedAt: parseWeiboDate(m.created_at),
      summary: text,
      contentHTML: parts.join('\n') || '<p></p>',
      cover: pics[0] || null,
      enclosure: null,
    };
  },
};

// MARK: - 服务

const ADAPTERS = { bilibili: BILIBILI, weibo: WEIBO };

class PlatformService {
  constructor(store) {
    this.store = store;
  }

  /** 是否平台源（platform 列非空且非 'web'）。 */
  static isPlatformFeed(feed) {
    return Boolean(feed && feed.platform && feed.platform !== 'web');
  }

  adapter(platform) {
    return ADAPTERS[platform] || null;
  }

  /** 平台合成 feed 的预取对象（preview 用：不落库）。 */
  pseudoFeed(platform, ref) {
    const adapter = this.adapter(platform);
    return {
      id: null,
      platform,
      platformRef: ref,
      feedURL: adapter.feedURL(ref),
      etag: null,
      lastModified: null,
    };
  }

  /**
   * 试抓预览（添加对话框）：解析 UID → 抓一轮 → 返回前 3 条 + 解析出的标题。
   * 抛 PlatformError 时 message 已本地化，UI 可直接回显。
   */
  async preview({ platform, input } = {}) {
    const adapter = this.adapter(String(platform || ''));
    if (!adapter) throw new PlatformError(i18n.localized('不支持的平台类型。'));
    const ref = adapter.parseRef(input);
    if (!ref) {
      throw new PlatformError(platform === 'bilibili'
        ? i18n.localized('无法识别的 B 站 UP 主，请输入纯数字 UID 或 space.bilibili.com 主页链接。')
        : i18n.localized('无法识别的微博用户，请输入纯数字 UID 或 weibo.com/u/… 主页链接。'));
    }
    const result = await this.fetchFeed(this.pseudoFeed(platform, ref), { force: true });
    const entries = (result.parsed?.entries || []).slice(0, 3).map((e) => ({
      title: e.title,
      url: e.url,
      publishedAt: e.publishedAt,
      summary: (e.summary || '').slice(0, 120),
      cover: e.cover || null,
    }));
    return { platform, ref, title: result.parsed?.title || null, siteURL: result.parsed?.siteURL || null, entries };
  }

  /**
   * 平台源抓取（与 FeedService.fetchFeed 同构返回）：
   * 30s 超时；If-None-Match 条件请求（304 短路）；force 跳过条件头。
   */
  async fetchFeed(feed, { force = false } = {}) {
    const adapter = this.adapter(feed.platform);
    if (!adapter) throw new PlatformError(i18n.localized('不支持的平台类型。'));
    const ref = String(feed.platformRef || adapter.parseRef(feed.feedURL) || '');
    if (!ref) throw new PlatformError(i18n.localized('平台源缺少用户 ID，请删除后重新添加。'));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers = adapter.headers(ref);
      if (!force && feed.etag) headers['If-None-Match'] = feed.etag;
      const { status, headers: respHeaders, buf } = await httpFetch(adapter.requestURL(ref), { headers, signal: controller.signal });
      if (status === 304) {
        return {
          notModified: true,
          etag: respHeaders.get('etag') ?? feed.etag,
          lastModified: respHeaders.get('last-modified') ?? feed.lastModified,
        };
      }
      if (status >= 400) {
        throw platformFailure(adapter.id, status);
      }
      if (!buf || buf.length === 0) {
        throw platformFailure(adapter.id, 0);
      }
      const parsed = adapter.parse(buf, ref);
      return {
        notModified: false,
        parsed,
        etag: respHeaders.get('etag') ?? null,
        lastModified: respHeaders.get('last-modified') ?? null,
      };
    } catch (err) {
      if (err instanceof PlatformError) throw err;
      // AbortError / 连接级错误：包成平台错误（message 保留原因），statusCode=null 语义（可重试）
      const reason = err?.name === 'AbortError' ? i18n.localized('请求超时') : String(err?.message || err);
      throw new PlatformError(`${platformLabel(adapter.id)}：${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function platformLabel(platform) {
  return platform === 'bilibili' ? 'B站' : '微博';
}

/** 非平台语义错误（HTTP 状态级）：带明确指引；风控语义走各适配器 parse 内的专属文案。 */
function platformFailure(platform, status) {
  if (platform === 'weibo') {
    return new PlatformError(i18n.localized('微博接口暂时不可用（可能被风控），稍后自动重试。'), { statusCode: status || 502 });
  }
  return new PlatformError(
    i18n.localized('B 站空间页抓取失败（可能是反爬或网络限制），稍后自动重试。'),
    { statusCode: status || 502 },
  );
}

module.exports = { PlatformService, PlatformError, ADAPTERS, parseWeiboDate, extractJSONObjectAfter };
