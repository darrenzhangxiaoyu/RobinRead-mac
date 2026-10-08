'use strict';
/**
 * PageMonitorService（知更）— 网页追更（F18）
 *
 * 把任意网页（无 RSS）转成可订阅的合成源：
 * - 用户提交 URL + 可选 CSS 选择器（默认启发取正文主体）→ 定时抓取（每源 ≥30min 节流）；
 * - 对选定区文本做段落哈希 diff（零依赖：按段落 split + sha1，不做 LCS）→
 *   变化时生成「合成文章」入库（title=页面 title、url=原页、正文=未变段 +
 *   <ins class="monitor-add">新增段</ins> + 「N 段已移除」折叠行）；
 * - 首次抓取只存基线不生成文章；无变化零文章；
 * - 存储：monitor_baselines（v21 迁移，feed_id PK / content_hash / baseline_text 截 512KB）；
 *   合成 feed：platform='monitor'、feed_url='monitor://<hash(url+selector)>'、
 *   site_url=原页 URL、platform_ref=选择器——复用 F5/F9 平台源架构与展示通路；
 * - 停止追更：platform 转 'monitor-stopped'（保留文章，不再自动抓取）。
 *
 * 主进程无 DOM：选择器提取仅支持 #id / .class / tag 三形态正则定位；
 * 默认启发 = <article> / <main> / [role=main] 块级宽松配对，取最大文本块。
 * 网络通路：复用 FeedService.httpFetch（net.fetch = 系统代理；探针可注入 mock）。
 */
const crypto = require('node:crypto');
const { httpFetch } = require('./FeedService');
const { i18n } = require('./I18N');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 30 * 1000;
/** 每源抓取节流：≥30 分钟（全局刷新随动，但单源两次实抓间隔不低于此值）。 */
const MIN_INTERVAL_MS = 30 * 60 * 1000;
/** 基线正文截断上限（512KB）。 */
const BASELINE_MAX_BYTES = 512 * 1024;
/** 抓取页面字节上限（防内存炸弹；超出按截断处理）。 */
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
/** 合成文章摘要长度。 */
const SUMMARY_MAX_CHARS = 200;

// MARK: - 提取（主进程无 DOM：正则块级配对 + 文本归一）

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

function escapeHTMLText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 宽松 HTML → 纯文本（实体解码 + 去标签 + 块级换行）。 */
function htmlToText(value) {
  return String(value ?? '')
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|blockquote|h[1-6]|tr|figcaption|dd|dt)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 页面 <title> / og:title / JSON-LD headline 提取（失败返回 null）。 */
function extractPageTitle(html) {
  const patterns = [
    /<title[^>]*>([\s\S]*?)<\/title>/i,
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
    /"headline"\s*:\s*"([^"]{1,300})"/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1]) return decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  }
  return null;
}

/**
 * 显式选择器定位（#id / .class / tag 三形态，主进程无 DOM 的宽松配对）：
 * 返回匹配块内的 HTML 片段；找不到返回 null（调用方回退启发）。
 */
function extractBySelector(html, selector) {
  const raw = String(selector || '').trim();
  if (!raw || raw.length > 200 || /[<>]/.test(raw)) return null;
  let openRe = null;
  let name = '';
  const idMatch = raw.match(/^#([A-Za-z0-9_-]+)$/);
  const classMatch = raw.match(/^\.([A-Za-z0-9_-]+)$/);
  const tagMatch = raw.match(/^([a-z][a-z0-9]*)$/i);
  if (idMatch) {
    name = idMatch[1];
    openRe = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\bid\\s*=\\s*["']${name}["'][^>]*>`, 'i');
  } else if (classMatch) {
    name = classMatch[1];
    openRe = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${name}\\b[^"']*["'][^>]*>`, 'i');
  } else if (tagMatch) {
    name = tagMatch[1].toLowerCase();
    openRe = new RegExp(`<${name}\\b[^>]*>`, 'i');
  } else {
    return null; // 复合选择器不支持：显式回退启发式
  }
  const open = openRe.exec(html);
  if (!open) return null;
  const tagName = (open[1] || name).toLowerCase();
  const body = html.slice(open.index + open[0].length);
  // 宽松配对：取同名闭合标签（嵌套同名标签容忍——取第一个闭合即可，文本级 diff 容忍噪声）
  const close = new RegExp(`</${tagName}\\s*>`, 'i').exec(body);
  const fragment = close ? body.slice(0, close.index) : body.slice(0, PAGE_MAX_BYTES);
  return fragment;
}

/**
 * 正文主体启发提取（零依赖）：
 * 1) <article>…</article> / <main>…</main> / role="main" 块，取文本最长者；
 * 2) 全无 → 去头（head/script/style）后整页文本。
 */
function extractMainContent(html) {
  const candidates = [];
  const blockPatterns = [
    /<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi,
    /<main\b[^>]*>([\s\S]*?)<\/main\s*>/gi,
    /<div\b[^>]*\brole\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/div\s*>/gi,
  ];
  for (const re of blockPatterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      if (m[1]) candidates.push(m[1]);
      if (candidates.length > 12) break; // 防极端页面回溯爆炸
    }
  }
  let best = null;
  let bestLen = 0;
  for (const candidate of candidates) {
    const len = htmlToText(candidate).length;
    if (len > bestLen) { best = candidate; bestLen = len; }
  }
  if (bestLen >= 200) return best;
  // 回退：去 head/script/style/svg 的整页（<body> 优先）
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html);
  return bodyMatch ? bodyMatch[1] : html;
}

/** HTML 片段 → 段落数组（空段剔除；每段截 2000 字防极端长段拖慢哈希）。 */
function toParagraphs(text) {
  return String(text || '')
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => (p.length > 2000 ? `${p.slice(0, 2000)}…` : p));
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value), 'utf8').digest('hex');
}

// MARK: - 段落哈希 diff（零依赖，不做 LCS）

/**
 * 基线段 vs 本次段的集合比对：
 * - 新文本顺序遍历：哈希在基线集合中 → 未变段（原样）；不在 → 新增段（<ins>）；
 * - 基线集合中存在而新文本没有的段 → 计数折叠为一行「N 段已移除」；
 * - 段内容改写 = 旧段消失 + 新段出现（diff 语义天然覆盖「变更段」）。
 * @returns {{html:string, added:number, removed:number}}
 */
function diffToHTML(oldParas, newParas) {
  const oldSet = new Set(oldParas.map(sha1));
  const newSet = new Set(newParas.map(sha1));
  const removedCount = oldParas.filter((p) => !newSet.has(sha1(p))).length;
  const parts = [];
  let added = 0;
  let lastWasIns = false;
  for (const para of newParas) {
    const isNew = !oldSet.has(sha1(para));
    if (isNew) {
      parts.push(`<ins class="monitor-add">${escapeHTMLText(para)}</ins>`);
      added += 1;
      lastWasIns = true;
    } else {
      parts.push(`<p>${escapeHTMLText(para)}</p>`);
      lastWasIns = false;
    }
  }
  if (removedCount > 0) {
    const note = `<p class="monitor-del-note">${escapeHTMLText(
      i18n.localized('%lld 段已移除').replace('%lld', String(removedCount)),
    )}</p>`;
    if (lastWasIns) parts.push(note);
    else parts.unshift(note);
  }
  return { html: parts.join('\n') || '<p></p>', added, removed: removedCount };
}

// MARK: - 服务

class PageMonitorService {
  constructor(store) {
    this.store = store;
    /** 抓取实现可注入（探针离线化）：默认 FeedService.httpFetch（系统代理）。 */
    this._fetchImpl = httpFetch;
    /** 时间可注入（探针测 30min 节流）。 */
    this._now = () => Date.now();
    this.counters = { fetches: 0, changes: 0, errors: 0, throttled: 0 };
  }

  /** 是否追更源（active 或 stopped）。 */
  static isMonitorFeed(feed) {
    return feed?.platform === 'monitor' || feed?.platform === 'monitor-stopped';
  }

  /** feed_url 合成地址：monitor://<hash(url+selector)>。 */
  static monitorFeedURL(url, selector) {
    return `monitor://${sha1(`${String(url || '').trim()}\n${String(selector || '').trim()}`).slice(0, 24)}`;
  }

  baselineRow(feedID) {
    return this.store.database.prepare('SELECT * FROM monitor_baselines WHERE feed_id = ?').get(feedID) || null;
  }

  /**
   * 试抓预览（添加对话框）：抓页面 → 提取 → 返回标题 + 正文前 200 字。
   * 抛错时 message 已本地化，UI 可直接回显。
   */
  async preview({ url, selector } = {}) {
    const pageURL = this.normalizeURL(url);
    const { html } = await this._fetchPage(pageURL);
    const fragment = extractBySelector(html, selector) ?? extractMainContent(html);
    const text = htmlToText(fragment);
    if (!text) throw new Error(i18n.localized('没有抓到页面正文，请检查地址或改用其他选择器。'));
    return {
      url: pageURL,
      title: extractPageTitle(html) || new URL(pageURL).host,
      excerpt: text.slice(0, 200),
      textLength: text.length,
    };
  }

  /**
   * 首次抓取只存基线（不生成文章）：添加流程与 changeSelector 共用。
   * @returns {{title:string, textLength:number}}
   */
  async captureBaseline(feedID, url, selector) {
    const { html } = await this._fetchPage(url);
    const fragment = extractBySelector(html, selector) ?? extractMainContent(html);
    const text = htmlToText(fragment);
    if (!text) throw new Error(i18n.localized('没有抓到页面正文，请检查地址或改用其他选择器。'));
    const baseline = text.length > BASELINE_MAX_BYTES ? text.slice(0, BASELINE_MAX_BYTES) : text;
    const now = Math.floor(this._now() / 1000);
    this.store.database.prepare(`
      INSERT INTO monitor_baselines (feed_id, content_hash, baseline_text, page_url, selector, checked_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feed_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        baseline_text = excluded.baseline_text,
        page_url = excluded.page_url,
        selector = excluded.selector,
        checked_at = excluded.checked_at,
        updated_at = excluded.updated_at
    `).run(feedID, sha1(baseline), baseline, url, selector || '', now, now);
    return { title: extractPageTitle(html), textLength: text.length };
  }

  /**
   * 追更源抓取（AppStore._fetchForFeed 分派目标，返回与 FeedService.fetchFeed 同构）。
   * - 停止态（monitor-stopped）：直接 notModified（保留文章，不再自动抓）；
   * - 节流：距 checked_at < 30min 且非 force → notModified；
   * - 首抓（无基线行）：只存基线 → notModified；
   * - 无变化：推进 checked_at → notModified；
   * - 有变化：段落 diff → 1 条合成文章 entries → 更新基线。
   */
  async fetchFeed(feed, { force = false } = {}) {
    const pageURL = feed.siteURL;
    if (!/^https?:\/\//i.test(String(pageURL || ''))) {
      throw new Error(i18n.localized('追更源缺少有效网页地址，请删除后重新添加。'));
    }
    const selector = String(feed.platformRef || '');
    const row = this.baselineRow(feed.id);
    const nowMs = this._now();

    // 停止追更：不再自动抓取（手动刷新同样短路——语义是「停」，保留文章）
    if (feed.platform === 'monitor-stopped') {
      this.counters.throttled += 1;
      return { notModified: true, etag: feed.etag, lastModified: feed.lastModified };
    }
    // ≥30min 节流（force = 用户显式刷新，跳过）
    if (!force && row && row.checked_at && (nowMs - Number(row.checked_at) * 1000) < MIN_INTERVAL_MS) {
      this.counters.throttled += 1;
      return { notModified: true, etag: feed.etag, lastModified: feed.lastModified };
    }

    const { html } = await this._fetchPage(pageURL);
    const fragment = extractBySelector(html, selector) ?? extractMainContent(html);
    const text = htmlToText(fragment);
    if (!text) throw new Error(i18n.localized('没有抓到页面正文，请检查地址或改用其他选择器。'));
    const baseline = text.length > BASELINE_MAX_BYTES ? text.slice(0, BASELINE_MAX_BYTES) : text;
    const hash = sha1(baseline);
    const nowSeconds = Math.floor(nowMs / 1000);
    this.counters.fetches += 1;

    // 首抓：只存基线，不生成文章
    if (!row) {
      this._saveBaseline(feed.id, hash, baseline, pageURL, selector, nowSeconds);
      return { notModified: true, etag: null, lastModified: null };
    }

    const title = extractPageTitle(html) || feed.title || new URL(pageURL).host;
    if (hash === row.content_hash) {
      // 无变化：只推进 checked_at（基线内容保持）
      this.store.database.prepare('UPDATE monitor_baselines SET checked_at = ? WHERE feed_id = ?')
        .run(nowSeconds, feed.id);
      return { notModified: true, etag: null, lastModified: null };
    }

    // 有变化：段落 diff → 合成文章（1 条）
    const oldParas = toParagraphs(row.baseline_text || '');
    const newParas = toParagraphs(baseline);
    const { html: diffHTML, added, removed } = diffToHTML(oldParas, newParas);
    this._saveBaseline(feed.id, hash, baseline, pageURL, selector, nowSeconds);
    this.counters.changes += 1;

    const entryIDSeed = `monitor:${feed.id}:${hash.slice(0, 12)}:${nowSeconds}`;
    // URL 带内容 hash 片段：同页多次更新互不撞 _applyParsedEntries 的 url_norm 判重
    //（灌文判重把 url 视为聚合源的稳定身份——追更源每次检测都应落一篇新「更新」文章）
    const entryURL = `${pageURL}#monitor-${hash.slice(0, 12)}`;
    const entries = [{
      id: entryIDSeed,
      title,
      url: entryURL,
      publishedAt: nowSeconds,
      summary: baseline.slice(0, SUMMARY_MAX_CHARS),
      contentHTML: diffHTML,
      cover: null,
      enclosure: null,
    }];
    return {
      notModified: false,
      parsed: { title, siteURL: pageURL, iconURL: null, entries, monitorDiff: { added, removed } },
      etag: null,
      lastModified: null,
    };
  }

  /**
   * 更改选择器：更新 platform_ref 与 feed_url（hash 变化）→ 立即重抓基线。
   * 停止态源改选择器 = 恢复追更（用户显式动作）。
   */
  async changeSelector(feedID, selector) {
    const feed = this.store.feedsRepo.feed(feedID);
    if (!feed) throw new Error(i18n.localized('订阅源不存在。'));
    if (!PageMonitorService.isMonitorFeed(feed)) throw new Error(i18n.localized('不是追更订阅源。'));
    const cleanSelector = String(selector || '').trim().slice(0, 200);
    if (cleanSelector && !/^([.#][A-Za-z0-9_-]+|[a-z][a-z0-9]*)$/i.test(cleanSelector)) {
      throw new Error(i18n.localized('选择器仅支持 #id、.class 或标签名（如 article）。'));
    }
    const pageURL = feed.siteURL;
    if (!/^https?:\/\//i.test(String(pageURL || ''))) {
      throw new Error(i18n.localized('追更源缺少有效网页地址，请删除后重新添加。'));
    }
    const nextURL = PageMonitorService.monitorFeedURL(pageURL, cleanSelector);
    this.store.feedsRepo.updateFeed(feedID, (f) => ({
      ...f, platformRef: cleanSelector, platform: 'monitor',
    }));
    this.store.feedsRepo.updateFeedURL(feedID, nextURL); // feed_url 不在 updateFeed 更新列（保持既有调用零影响）
    const baseline = await this.captureBaseline(feedID, pageURL, cleanSelector);
    this.store._invalidatePrepared();
    this.store._emitState();
    return { feed: this.store.feedsRepo.feed(feedID), ...baseline };
  }

  /** 停止追更：platform 转 monitor-stopped（不再自动抓取；文章保留；可改选择器恢复）。 */
  stopMonitor(feedID) {
    const feed = this.store.feedsRepo.feed(feedID);
    if (!feed) throw new Error(i18n.localized('订阅源不存在。'));
    if (!PageMonitorService.isMonitorFeed(feed)) throw new Error(i18n.localized('不是追更订阅源。'));
    this.store.feedsRepo.updateFeed(feedID, (f) => ({ ...f, platform: 'monitor-stopped' }));
    this.store._invalidatePrepared();
    this.store._emitState();
    return { stopped: true };
  }

  // MARK: - 内部

  normalizeURL(url) {
    const value = String(url || '').trim();
    if (!/^https?:\/\//i.test(value)) {
      throw new Error(i18n.localized('请输入以 http(s):// 开头的网页地址。'));
    }
    return value;
  }

  async _fetchPage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const { status, buf } = await this._fetchImpl(url, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: controller.signal,
      });
      if (status >= 400) {
        throw new Error(i18n.localized('页面抓取失败（HTTP %lld）。').replace('%lld', String(status)));
      }
      let html = buf.toString('utf8');
      if (html.length > PAGE_MAX_BYTES) html = html.slice(0, PAGE_MAX_BYTES);
      return { html };
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(i18n.localized('页面抓取超时，请稍后重试。'));
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  _saveBaseline(feedID, hash, baseline, pageURL, selector, nowSeconds) {
    this.store.database.prepare(`
      INSERT INTO monitor_baselines (feed_id, content_hash, baseline_text, page_url, selector, checked_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feed_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        baseline_text = excluded.baseline_text,
        page_url = excluded.page_url,
        selector = excluded.selector,
        checked_at = excluded.checked_at,
        updated_at = excluded.updated_at
    `).run(feedID, hash, baseline, pageURL, selector || '', nowSeconds, nowSeconds);
  }
}

module.exports = {
  PageMonitorService,
  diffToHTML,
  extractBySelector,
  extractMainContent,
  extractPageTitle,
  htmlToText,
  toParagraphs,
  sha1,
  MIN_INTERVAL_MS,
  BASELINE_MAX_BYTES,
};
