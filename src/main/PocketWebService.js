'use strict';
/**
 * PocketWebService（知更）— 口袋知更（F31，数据主权档）
 *
 * 一键起局域网服务，手机扫码读轻量 Web 版（列表 / 阅读 / 已读回传），零云零账号。
 * 与 F39 LocalApiService（本机只读 JSON API）定位不同：口袋知更是**给手机用的
 * 完整轻量 Web 阅读界面**（服务端渲染 HTML，零前端框架），且必须支持局域网
 * 访问——因此安全设计是第一约束：
 *
 * - 默认关闭；绑定模式二选一：仅本机（127.0.0.1）/ 局域网（0.0.0.0）。
 *   **切到局域网必须显式确认**（渲染层弹窗警告「同网络任何人可访问」，确认后
 *   才允许传 confirmLan——服务层再验一次，两层闸）；运行中改绑定立即重启生效；
 * - 鉴权：访问令牌随机生成（首次开启时落库），所有页面路径先校验 token
 *   （cookie nj_pocket_t 或 ?t= 查询参数；常数时间比较 sha256+timingSafeEqual），
 *   无 token 一律登录页；登录成功种 HttpOnly cookie；
 * - 只写一个口子：POST /api/read（已读回传，走 store.markRead 既有管线），
 *   其余全只读 GET；
 * - 注入防护：列表标题/来源/时间全 HTML 转义；正文回传前再过一次
 *   ArticleExtractor 白名单消毒（入库已消毒，服务侧双保险）；
 * - 限流：每 IP 每分钟 ≤60 请求（固定分钟窗），超限 429；
 * - 二维码：lib/QRCode 纯 JS 生成 SVG（确定性输出），设置页展示/重显；
 * - 生命周期：stop() 即关 socket 断全部连接；应用退出自动停服
 *   （AppStore.shutdown + main.js will-quit 双锚）。
 *
 * 注入缝（探针）：_now 时钟可注入（限流窗口确定性）；端口可指定（探针高位端口）。
 */
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const { qrSvg } = require('./lib/QRCode');
const { i18n } = require('./I18N');
const ArticleExtractor = require('./ArticleExtractor');

/** 规则常量（端口/绑定/限流/分页全部集中于此）。 */
const POCKET = {
  DEFAULT_PORT: 7963,
  PORT_MIN: 1024,
  PORT_MAX: 65535,
  BIND_LOOPBACK: 'loopback', // 仅本机 127.0.0.1
  BIND_LAN: 'lan',           // 局域网 0.0.0.0（须显式确认）
  HOST_LOOPBACK: '127.0.0.1',
  HOST_LAN: '0.0.0.0',
  RATE_LIMIT_PER_MINUTE: 60, // 每 IP 每分钟上限
  PAGE_SIZE: 20,             // 列表分页
  LIST_MAX: 2000,            // 上一页/下一页索引扫描上限（ID 轻量行）
  TITLE_SLICE: 160,
  BODY_MAX_BYTES: 64 * 1024, // POST 表单体上限
  TOKEN_COOKIE: 'nj_pocket_t',
  KEYS: {
    enabled: 'RobinRead.pocket.enabled',
    port: 'RobinRead.pocket.port',
    bind: 'RobinRead.pocket.bind',
    token: 'RobinRead.pocket.token',
  },
};

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** 常数时间 token 比较（sha256 摘要等长后 timingSafeEqual）。 */
function tokenMatches(presented, expected) {
  const a = crypto.createHash('sha256').update(String(presented || ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(expected || ''), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/** HTML 转义（列表标题/来源/属性值全走这里）。 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 局域网展示地址：首个非内部 IPv4（取不到回退 127.0.0.1）。 */
function lanAddress() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return POCKET.HOST_LOOPBACK;
}

const t = (key) => i18n.localized(key);
const tf = (key, ...args) => i18n.localizedFormat(key, ...args);

class PocketWebService {
  constructor(store, { now = null } = {}) {
    this.store = store;
    this._now = now || (() => Date.now() / 1000); // 注入时钟（限流窗口确定性）
    this._server = null;
    this._port = null;
    this._host = null;
    this._token = String(store.preferences.get(POCKET.KEYS.token, '') || '') || null;
    this._rlByIP = new Map(); // ip -> { window, count }（固定分钟窗）
    this.counters = {
      requests: 0, unauthorized: 0, rateLimited: 0, notFound: 0,
      readMarks: 0, started: 0, stopped: 0, errors: 0,
    };
    this.lastError = null;
  }

  now() { return this._now(); }

  // MARK: 配置

  _configuredPort() {
    const p = Math.floor(Number(this.store.preferences.get(POCKET.KEYS.port, POCKET.DEFAULT_PORT)));
    if (!Number.isFinite(p) || p < POCKET.PORT_MIN || p > POCKET.PORT_MAX) return POCKET.DEFAULT_PORT;
    return p;
  }

  _configuredBind() {
    const b = String(this.store.preferences.get(POCKET.KEYS.bind, POCKET.BIND_LOOPBACK) || '');
    return b === POCKET.BIND_LAN ? POCKET.BIND_LAN : POCKET.BIND_LOOPBACK;
  }

  getConfig() {
    return {
      enabled: this.store.preferences.get(POCKET.KEYS.enabled, false) === true,
      port: this._configuredPort(),
      bind: this._configuredBind(),
      hasToken: Boolean(this._token),
    };
  }

  /**
   * 配置变更：enabled 即时启停；port 落库（重启/重开生效）；bind 变更须显式确认
   * （confirmLan），运行中立即按新绑定重启。@returns {config, status}
   */
  configure(patch = {}) {
    if (patch.enabled === true || patch.enabled === false) {
      this.store.preferences.set(POCKET.KEYS.enabled, patch.enabled);
      if (patch.enabled) {
        try { this.start(); } catch (err) { this.lastError = String((err && err.message) || err); }
      } else {
        this.stop();
      }
    }
    if (patch.port != null) {
      const p = Math.floor(Number(patch.port));
      if (!Number.isFinite(p) || p < POCKET.PORT_MIN || p > POCKET.PORT_MAX) {
        throw new Error(t('端口须在 1024-65535 之间。'));
      }
      this.store.preferences.set(POCKET.KEYS.port, p);
    }
    if (patch.bind != null) {
      const bind = String(patch.bind);
      if (bind !== POCKET.BIND_LOOPBACK && bind !== POCKET.BIND_LAN) {
        throw new Error(t('绑定模式仅支持 仅本机 / 局域网。'));
      }
      if (bind === POCKET.BIND_LAN && patch.confirmLan !== true) {
        throw new Error(t('开启局域网绑定须先在弹窗中确认「同网络任何人可访问」的安全提示。'));
      }
      this.store.preferences.set(POCKET.KEYS.bind, bind);
      const targetHost = bind === POCKET.BIND_LAN ? POCKET.HOST_LAN : POCKET.HOST_LOOPBACK;
      if (this._server && targetHost !== this._host) this._restart(); // 运行中改绑定立即按新模式重启
    }
    return { config: this.getConfig(), status: this.status() };
  }

  // MARK: 生命周期

  /** 启动服务（按配置绑定 127.0.0.1 / 0.0.0.0；令牌首次开启时生成落库；幂等）。 */
  start(port = null) {
    if (this._server) return { port: this._port, host: this._host, alreadyRunning: true };
    const target = port != null ? Math.floor(Number(port)) : this._configuredPort();
    if (!Number.isFinite(target) || target < POCKET.PORT_MIN || target > POCKET.PORT_MAX) {
      throw new Error(t('端口须在 1024-65535 之间。'));
    }
    const bind = this._configuredBind();
    if (!this._token) {
      this._token = generateToken();
      this.store.preferences.set(POCKET.KEYS.token, this._token);
    }
    const host = bind === POCKET.BIND_LAN ? POCKET.HOST_LAN : POCKET.HOST_LOOPBACK;
    const server = http.createServer((req, res) => this._handle(req, res));
    server.on('error', (err) => {
      this.counters.errors += 1;
      this.lastError = String((err && err.message) || err);
      try { this.stop(); } catch (_) { /* 关不停就算了 */ }
    });
    // 同步 listen（backlog 0）：设置页/探针 start() 返回后端口立即可连
    server.listen(target, host);
    this._server = server;
    this._port = target;
    this._host = host;
    this._rlByIP.clear();
    this.counters.started += 1;
    this.lastError = null;
    try { this.store.emit('pocket:changed', this.status()); } catch (_) { /* 无订阅者不阻塞 */ }
    return { port: target, host, bind };
  }

  /** 停止并立即释放端口（断开全部 keep-alive 连接；幂等）。 */
  stop() {
    const server = this._server;
    if (!server) return { stopped: false };
    this._server = null;
    this._port = null;
    this._host = null;
    this._rlByIP.clear();
    this.counters.stopped += 1;
    try { server.closeAllConnections?.(); } catch (_) { /* 老内核无此 API */ }
    try { server.close(); } catch (_) { /* 幂等 */ }
    try { this.store.emit('pocket:changed', this.status()); } catch (_) { /* 无订阅者不阻塞 */ }
    return { stopped: true };
  }

  _restart() {
    const port = this._port;
    this.stop();
    try { this.start(port); } catch (err) { this.lastError = String((err && err.message) || err); }
  }

  status() {
    const bind = this._configuredBind();
    return {
      running: Boolean(this._server),
      bind,
      host: this._host,
      port: this._port,
      url: this.running ? this.accessURL() : null,
      requests: this.counters.requests,
      unauthorized: this.counters.unauthorized,
      rateLimited: this.counters.rateLimited,
      readMarks: this.counters.readMarks,
      errors: this.counters.errors,
      lastError: this.lastError,
      rateLimitPerMinute: POCKET.RATE_LIMIT_PER_MINUTE,
    };
  }

  /** 手机访问地址（局域网模式用首个非内部 IPv4；回退 127.0.0.1）。 */
  accessURL() {
    if (!this._server || !this._token) return null;
    const displayHost = this._configuredBind() === POCKET.BIND_LAN ? lanAddress() : POCKET.HOST_LOOPBACK;
    return `http://${displayHost}:${this._port}/?t=${this._token}`;
  }

  /** 访问二维码 SVG（确定性：同参数同输出）。 */
  qrSVG() {
    const url = this.accessURL();
    if (!url) return null;
    return { url, svg: qrSvg(url) };
  }

  // MARK: 请求处理

  _handle(req, res) {
    const respondHTML = (status, html, extraHeaders = {}) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        ...extraHeaders,
      });
      res.end(html);
    };
    const respondRedirect = (location, cookie = null) => {
      res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) });
      res.end();
    };
    try {
      this.counters.requests += 1;
      const ip = this._clientIP(req);
      // ① 限流先行（每 IP 每分钟 ≤60；未授权流量同样计入，防爆破令牌）
      if (this._rateLimited(ip)) {
        this.counters.rateLimited += 1;
        return respondHTML(429, this._pageShell(t('请求过于频繁'), `<p class="hint">${esc(t('请求过于频繁，请一分钟后再试。'))}</p>`), { 'Retry-After': '60' });
      }
      const url = new URL(req.url || '/', `http://${POCKET.HOST_LOOPBACK}`);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      // ② POST 只开一个口：/api/read（已读回传）
      if (req.method === 'POST') {
        if (path !== '/api/read') {
          this.counters.notFound += 1;
          return respondHTML(404, this._pageShell(t('页面不存在'), `<p class="hint">${esc(t('页面不存在。'))}</p>`));
        }
        return this._handleReadPost(req, res, respondHTML, respondRedirect);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return respondHTML(405, this._pageShell(t('页面不存在'), `<p class="hint">${esc(t('页面不存在。'))}</p>`), { Allow: 'GET, POST' });
      }

      // ③ 登录端点（?t= 换 cookie）
      if (path === '/login') {
        const presented = url.searchParams.get('t') || '';
        if (presented && tokenMatches(presented, this._token || '')) {
          const cookie = `${POCKET.TOKEN_COOKIE}=${encodeURIComponent(presented)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
          return respondRedirect('/', cookie);
        }
        this.counters.unauthorized += 1;
        return respondHTML(200, this._loginPage(url.searchParams.has('t')));
      }

      // ④ 其余页面鉴权：无 token 一律登录页
      const token = this._presentedToken(req, url);
      if (!token || !tokenMatches(token, this._token || '')) {
        this.counters.unauthorized += 1;
        return respondHTML(200, this._loginPage(false));
      }

      if (path === '/') return respondHTML(200, this._listPage(url));
      if (path.startsWith('/read/')) {
        // 链接侧 encodeURIComponent（ID 含 ':' 等 URI 保留字），路由侧解码还原
        let entryID = path.slice('/read/'.length);
        try { entryID = decodeURIComponent(entryID); } catch (_) { /* 坏编码按原样查库 */ }
        const page = this._articlePage(entryID, url);
        if (!page) {
          this.counters.notFound += 1;
          return respondHTML(404, this._pageShell(t('页面不存在'), `<p class="hint">${esc(t('页面不存在。'))}</p><p><a href="/">${esc(t('返回列表'))}</a></p>`));
        }
        return respondHTML(200, page);
      }
      this.counters.notFound += 1;
      return respondHTML(404, this._pageShell(t('页面不存在'), `<p class="hint">${esc(t('页面不存在。'))}</p>`));
    } catch (err) {
      this.counters.errors += 1;
      this.lastError = String((err && err.message) || err);
      return respondHTML(500, this._pageShell(t('服务错误'), `<p class="hint">${esc(t('服务出现内部错误，请稍后再试。'))}</p>`));
    }
  }

  _clientIP(req) {
    return String(req.socket?.remoteAddress || 'unknown').slice(0, 64);
  }

  _presentedToken(req, url) {
    const cookie = String(req.headers.cookie || '');
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${POCKET.TOKEN_COOKIE}=([^;]+)`));
    if (m) return decodeURIComponent(m[1]);
    return url.searchParams.get('t') || '';
  }

  /** 每 IP 固定分钟窗计数（窗推进惰性清理，表体量 = 活跃 IP 数）。 */
  _rateLimited(ip) {
    const window = Math.floor(this._now() / 60);
    let entry = this._rlByIP.get(ip);
    if (!entry || entry.window !== window) {
      if (this._rlByIP.size > 500) this._rlByIP.clear(); // IP 表防爆（活跃终端有限）
      entry = { window, count: 0 };
      this._rlByIP.set(ip, entry);
    }
    entry.count += 1;
    return entry.count > POCKET.RATE_LIMIT_PER_MINUTE;
  }

  /** POST /api/read：表单体（entryID [+ token]）→ store.markRead 既有管线。 */
  _handleReadPost(req, res, respondHTML, respondRedirect) {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > POCKET.BODY_MAX_BYTES) { req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const url = new URL('/', `http://${POCKET.HOST_LOOPBACK}`);
        const cookieToken = this._presentedToken(req, url);
        const formToken = form.get('token') || '';
        const token = cookieToken || formToken;
        if (!token || !tokenMatches(token, this._token || '')) {
          this.counters.unauthorized += 1;
          return respondHTML(401, this._loginPage(false));
        }
        const entryID = String(form.get('entryID') || '').slice(0, 200);
        const entry = entryID ? this.store.articlesRepo.entry(entryID) : null;
        if (!entry) {
          this.counters.notFound += 1;
          return respondHTML(404, this._pageShell(t('页面不存在'), `<p class="hint">${esc(t('页面不存在。'))}</p>`));
        }
        this.store.markRead(entryID, true); // 既有管线（花园/生物钟/挑战/重访钩子全部生效）
        this.counters.readMarks += 1;
        return respondRedirect(`/read/${encodeURIComponent(entryID)}?done=1`);
      } catch (err) {
        this.counters.errors += 1;
        return respondHTML(500, this._pageShell(t('服务错误'), `<p class="hint">${esc(t('服务出现内部错误，请稍后再试。'))}</p>`));
      }
    });
    req.on('error', () => { /* 连接中断：无响应可写 */ });
  }

  // MARK: 数据面（只读 SQL，全参数化）

  _listRows({ unreadOnly = false, limit = POCKET.PAGE_SIZE, offset = 0 } = {}) {
    const db = this.store.database;
    const where = unreadOnly ? 'WHERE COALESCE(s.is_read, 0) = 0' : '';
    return db.prepare(`
      SELECT i.id AS id, a.title AS title, a.published_at AS publishedAt,
             COALESCE(s.is_read, 0) AS isRead, COALESCE(f.title, '') AS source
      FROM items i
      JOIN articles a ON a.item_id = i.id
      LEFT JOIN article_states s ON s.item_id = i.id
      LEFT JOIN feeds f ON f.id = i.feed_id
      ${where}
      ORDER BY COALESCE(a.published_at, i.created_at) DESC, i.id ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  _listTotal(unreadOnly = false) {
    const db = this.store.database;
    const where = unreadOnly ? 'WHERE COALESCE(s.is_read, 0) = 0' : '';
    return Number(db.prepare(`
      SELECT COUNT(*) AS n
      FROM items i
      JOIN articles a ON a.item_id = i.id
      LEFT JOIN article_states s ON s.item_id = i.id
      ${where}
    `).get()?.n ?? 0);
  }

  _articleRow(entryID) {
    return this.store.database.prepare(`
      SELECT i.id AS id, a.title AS title, a.author AS author, a.published_at AS publishedAt,
             COALESCE(s.is_read, 0) AS isRead, COALESCE(f.title, '') AS source
      FROM items i
      JOIN articles a ON a.item_id = i.id
      LEFT JOIN article_states s ON s.item_id = i.id
      LEFT JOIN feeds f ON f.id = i.feed_id
      WHERE i.id = ?
    `).get(entryID);
  }

  /** 正文（走 articleContent 既有装配——缓存/存档回落一致）+ 服务侧再消毒一遍。 */
  _articleBody(entryID) {
    let html = '';
    try { html = String(this.store.articleContent(entryID)?.html || ''); } catch (_) { html = ''; }
    if (!html) {
      const row = this.store.database.prepare('SELECT summary FROM articles WHERE item_id = ?').get(entryID);
      html = row?.summary ? `<p>${esc(row.summary)}</p>` : '';
    }
    if (!html) return '';
    // 白名单消毒双保险（入库已消毒；服务出口再过一遍 script/iframe/事件属性）
    return ArticleExtractor.sanitizedHTML(html, null);
  }

  /** 上一页/下一页（同过滤口径的 ID 序列定位；轻量 ID 行封顶 2000）。 */
  _neighbors(entryID, unreadOnly) {
    const db = this.store.database;
    const where = unreadOnly ? 'WHERE COALESCE(s.is_read, 0) = 0' : '';
    const rows = db.prepare(`
      SELECT i.id AS id FROM items i
      JOIN articles a ON a.item_id = i.id
      LEFT JOIN article_states s ON s.item_id = i.id
      ${where}
      ORDER BY COALESCE(a.published_at, i.created_at) DESC, i.id ASC
      LIMIT ?
    `).all(POCKET.LIST_MAX);
    const idx = rows.findIndex((r) => r.id === entryID);
    if (idx < 0) return { prev: null, next: null };
    return {
      prev: idx > 0 ? rows[idx - 1].id : null,
      next: idx < rows.length - 1 ? rows[idx + 1].id : null,
    };
  }

  // MARK: 页面（服务端渲染 HTML 字符串，零前端框架；纸感极简内联 CSS）

  _pageShell(title, inner) {
    return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">`
      + `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
      + `<title>${esc(title)}</title><style>${POCKET_CSS}</style></head>`
      + `<body><main class="page">${inner}</main></body></html>`;
  }

  _loginPage(showError) {
    const inner = `<section class="login">
      <h1>🐦 ${esc(t('口袋知更'))}</h1>
      <p class="hint">${esc(t('输入访问令牌，继续你的阅读。'))}</p>
      ${showError ? `<p class="error">${esc(t('令牌不正确，请重试。'))}</p>` : ''}
      <form method="get" action="/login">
        <input type="password" name="t" placeholder="${esc(t('访问令牌'))}" autocomplete="off" autofocus>
        <button type="submit">${esc(t('进入'))}</button>
      </form>
      <p class="fine">${esc(t('令牌在桌面端 设置 → 口袋知更 里，扫码即含令牌。'))}</p>
    </section>`;
    return this._pageShell(t('口袋知更'), inner);
  }

  _listPage(url) {
    const unreadOnly = url.searchParams.get('unread') === '1';
    const page = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));
    const offset = (page - 1) * POCKET.PAGE_SIZE;
    const rows = this._listRows({ unreadOnly, offset });
    const total = this._listTotal(unreadOnly);
    const pages = Math.max(1, Math.ceil(total / POCKET.PAGE_SIZE));
    const ctx = unreadOnly ? '&unread=1' : '';

    const items = rows.map((r) => {
      const date = r.publishedAt ? new Date(r.publishedAt * 1000) : null;
      const dateText = date ? `${date.getMonth() + 1}-${date.getDate()}` : '';
      const readCtx = unreadOnly ? 'unread=1&' : '';
      return `<li class="${r.isRead ? 'read' : 'unread'}">
        <a href="/read/${encodeURIComponent(r.id)}?${readCtx}"><span class="t">${esc(String(r.title || t('(无标题)')).slice(0, POCKET.TITLE_SLICE))}</span></a>
        <span class="meta">${esc(String(r.source || '').slice(0, 40))}${dateText ? ` · ${dateText}` : ''}</span>
      </li>`;
    }).join('\n');

    const pager = [];
    if (page > 1) pager.push(`<a class="pg" href="/?page=${page - 1}${ctx}">${esc(t('上一页'))}</a>`);
    pager.push(`<span class="pg-info">${esc(t('第 %lld / %lld 页', page, pages))}</span>`);
    if (page < pages) pager.push(`<a class="pg" href="/?page=${page + 1}${ctx}">${esc(t('下一页'))}</a>`);

    const filter = unreadOnly
      ? `<a class="chip" href="/?page=1">${esc(t('全部文章'))}</a>`
      : `<a class="chip" href="/?page=1&unread=1">${esc(t('只看未读'))}</a>`;

    const inner = `<header class="bar"><h1>🐦 ${esc(t('口袋知更'))}</h1>${filter}</header>
      <ul class="list">${items || `<li class="empty">${esc(t('这里什么都没有——换一页或清掉未读过滤看看。'))}</li>`}</ul>
      <nav class="pager">${pager.join('')}</nav>`;
    return this._pageShell(t('口袋知更'), inner);
  }

  /** 阅读页 HTML（文章不存在返回 null，由路由转 404）。 */
  _articlePage(entryID, url) {
    const row = this._articleRow(entryID);
    if (!row) return null;
    const unreadOnly = url.searchParams.get('unread') === '1';
    const done = url.searchParams.get('done') === '1';
    const body = this._articleBody(entryID);
    const { prev, next } = this._neighbors(entryID, unreadOnly);
    const ctx = unreadOnly ? '&unread=1' : '';
    const date = row.publishedAt ? new Date(row.publishedAt * 1000).toLocaleString() : '';

    const nav = (id, label) => id
      ? `<a class="pn" href="/read/${encodeURIComponent(id)}?done=0${ctx}">${esc(label)}</a>`
      : `<span class="pn off">${esc(label)}</span>`;

    const inner = `<header class="bar"><a class="back" href="/?${unreadOnly ? 'unread=1' : ''}">← ${esc(t('列表'))}</a></header>
      <article>
        <h1>${esc(String(row.title || t('(无标题)')).slice(0, POCKET.TITLE_SLICE))}</h1>
        <p class="meta">${esc(String(row.source || '').slice(0, 40))}${row.author ? ` · ${esc(String(row.author).slice(0, 60))}` : ''}${date ? ` · ${esc(date)}` : ''}</p>
        ${done ? `<p class="done">✓ ${esc(t('已标为已读'))}</p>` : ''}
        ${row.isRead ? '' : `<form method="post" action="/api/read" class="readform">
          <input type="hidden" name="entryID" value="${esc(entryID)}">
          <button type="submit">${esc(t('标为已读'))}</button>
        </form>`}
        <div class="body">${body || `<p class="hint">${esc(t('这篇文章没有可提取的正文。'))}</p>`}</div>
      </article>
      <nav class="pnbar">${nav(prev, t('上一篇'), '')}${nav(next, t('下一篇'), '')}</nav>`;
    return this._pageShell(String(row.title || t('口袋知更')).slice(0, POCKET.TITLE_SLICE), inner);
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return {
      ...this.counters,
      ...POCKET,
      hasToken: Boolean(this._token),
      rateIPs: this._rlByIP.size,
      status: this.status(),
    };
  }
}

/** 轻量 Web 界面内联 CSS：纸感极简（应用同款配色变量近似值：暖纸底/墨字/赭石强调）。 */
const POCKET_CSS = `
:root { color-scheme: light; --paper:#f7f3ec; --card:#fffdf9; --ink:#2f2a24; --ink2:#6f675c; --line:#e5ddcf; --accent:#b3541e; --ok:#3d7a4f; }
* { box-sizing: border-box; }
body { margin:0; background:var(--paper); color:var(--ink); font:16px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",serif; }
.page { max-width:640px; margin:0 auto; padding:20px 18px 60px; }
.bar { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:6px 0 18px; }
h1 { font-size:20px; margin:0; letter-spacing:.5px; }
.hint { color:var(--ink2); font-size:13.5px; }
.fine { color:var(--ink2); font-size:12px; margin-top:18px; }
.error { color:#b3341e; font-size:13.5px; }
.login { max-width:340px; margin:14vh auto 0; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px 24px; text-align:center; box-shadow:0 6px 24px rgba(60,40,10,.06); }
.login input { width:100%; margin:16px 0 12px; padding:11px 12px; border:1px solid var(--line); border-radius:9px; background:#fff; font-size:15px; }
.login button, .readform button { padding:9px 22px; border:0; border-radius:9px; background:var(--accent); color:#fff; font-size:15px; cursor:pointer; }
.list { list-style:none; margin:0; padding:0; background:var(--card); border:1px solid var(--line); border-radius:14px; overflow:hidden; }
.list li { padding:13px 16px; border-bottom:1px solid var(--line); }
.list li:last-child { border-bottom:0; }
.list li a { text-decoration:none; color:var(--ink); display:block; }
.list li.read .t { color:var(--ink2); }
.list li .t { display:block; font-size:15.5px; line-height:1.5; }
.list li .meta { display:block; color:var(--ink2); font-size:12px; margin-top:3px; }
.empty { color:var(--ink2); text-align:center; }
.chip { font-size:13px; color:var(--accent); text-decoration:none; border:1px solid var(--line); border-radius:99px; padding:3px 12px; background:var(--card); }
.pager { display:flex; align-items:center; justify-content:center; gap:14px; margin-top:18px; }
.pg { color:var(--accent); text-decoration:none; font-size:14px; }
.pg-info { color:var(--ink2); font-size:13px; }
article h1 { font-size:22px; line-height:1.45; margin:10px 0 6px; }
article .meta { color:var(--ink2); font-size:13px; margin:0 0 14px; }
article .done { color:var(--ok); font-size:13.5px; }
.readform { margin:0 0 14px; }
.body { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 18px 6px; overflow-wrap:break-word; }
.body img { max-width:100%; height:auto; border-radius:8px; }
.body pre { overflow-x:auto; background:#f2ede3; padding:10px 12px; border-radius:8px; font-size:13px; }
.body blockquote { margin:12px 0; padding:2px 14px; border-left:3px solid var(--accent); color:var(--ink2); }
.pnbar { display:flex; justify-content:space-between; gap:12px; margin-top:20px; }
.pn { text-decoration:none; color:var(--accent); font-size:14.5px; }
.pn.off { color:var(--line); }
.back { color:var(--accent); text-decoration:none; font-size:14px; }
`;

module.exports = { PocketWebService, POCKET, generateToken, tokenMatches, esc, lanAddress };
