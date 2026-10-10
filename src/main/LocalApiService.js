'use strict';
/**
 * LocalApiService（知更）— 阅读数据开放 API（F39，数据主权档）
 *
 * 本地 REST 端点导出阅读行为/批注/统计 JSON——个人数据主权的终极形态：
 * 自建仪表盘、脚本、年度报告都能直接读自己的数据。安全是第一约束：
 *
 * - 绑定：**默认且永远 127.0.0.1**（永不 0.0.0.0）——数据不出本机；
 * - 鉴权：Bearer token（随机生成、设置页显示/复制/重生成），缺头或错值一律
 *   401；token 比较走 sha256 摘要 + crypto.timingSafeEqual（无时序侧信道）；
 * - CORS：默认拒绝跨域（全响应不发任何 Access-Control-* 头）；
 * - 只读：只开 GET（其余方法 405）；全部端点只投影元数据/统计——批注端点
 *   **永不返回文章正文**，订阅源端点**永不返回凭据**；
 * - SQL 全参数化：统计/清单复用既有 service 查询（clock/capsule/weekly/dashboard），
 *   批注分页是唯一新增查询且为固定 prepared 语句（LIMIT/OFFSET 走绑定参数）；
 * - 限流：每分钟 ≤120 请求（滑动窗口计数），超限 429 + Retry-After；
 * - 生命周期：stop() 即关socket+断全部连接（端口立即释放）；应用退出
 *   （main.js will-quit）自动 stop。
 *
 * 注入缝（探针）：_now 时钟可注入（限流窗口确定性）；端口可指定（探针用高位端口）。
 */
const http = require('node:http');
const crypto = require('node:crypto');

/** 规则常量（端口/限流/日志全部集中于此）。 */
const LOCAL_API = {
  DEFAULT_PORT: 7962,
  PORT_MIN: 1024,
  PORT_MAX: 65535,
  HOST: '127.0.0.1',           // 红线：永不 0.0.0.0
  RATE_LIMIT_PER_MINUTE: 120,  // 每分钟请求上限（超限 429）
  LOG_CAPACITY: 100,           // 请求日志内存保留条数（可选开关，默认关）
  ANNOTATION_PAGE_MAX: 200,    // 批注分页单页上限
  TEXT_SLICE: 280,             // 批注高亮/笔记文本截断（不是正文，只是批注本身）
  KEYS: {
    enabled: 'RobinRead.api.enabled',
    port: 'RobinRead.api.port',
    logRequests: 'RobinRead.api.logRequests',
    token: 'RobinRead.api.token',
  },
};

/** 生成只读令牌：24 字节随机 → base64url（43 字符，无歧义字符集）。 */
function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** 常数时间 token 比较：sha256 摘要等长后 timingSafeEqual（长度差异不泄漏）。 */
function tokenMatches(presented, expected) {
  const a = crypto.createHash('sha256').update(String(presented || ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(expected || ''), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

class LocalApiService {
  constructor(store, { now = null } = {}) {
    this.store = store;
    this._now = now || (() => Date.now() / 1000); // 注入时钟（限流窗口确定性）
    this._server = null;
    this._port = null;
    this._startedAt = null;
    this._token = this._loadOrCreateToken();
    this._rlWindowStart = 0;   // 限流：固定分钟窗
    this._rlCount = 0;
    this.counters = {
      requests: 0, unauthorized: 0, methodNotAllowed: 0, notFound: 0,
      rateLimited: 0, started: 0, stopped: 0, errors: 0,
    };
    this._log = []; // 请求日志（logRequests 开启时才记录）
    this.lastError = null;
  }

  now() { return this._now(); }

  // MARK: 配置

  _loadOrCreateToken() {
    let token = String(this.store.preferences.get(LOCAL_API.KEYS.token, '') || '');
    if (!token) {
      token = generateToken();
      this.store.preferences.set(LOCAL_API.KEYS.token, token);
    }
    return token;
  }

  /** 重新生成只读令牌（旧令牌即刻失效——内存即判据，无需重启）。 */
  regenerateToken() {
    this._token = generateToken();
    this.store.preferences.set(LOCAL_API.KEYS.token, this._token);
    return this._token;
  }

  getConfig() {
    return {
      enabled: this.store.preferences.get(LOCAL_API.KEYS.enabled, false) === true,
      port: this._configuredPort(),
      logRequests: this.store.preferences.get(LOCAL_API.KEYS.logRequests, false) === true,
      token: this._token,
    };
  }

  _configuredPort() {
    const p = Math.floor(Number(this.store.preferences.get(LOCAL_API.KEYS.port, LOCAL_API.DEFAULT_PORT)));
    if (!Number.isFinite(p) || p < LOCAL_API.PORT_MIN || p > LOCAL_API.PORT_MAX) return LOCAL_API.DEFAULT_PORT;
    return p;
  }

  /**
   * 配置变更：enabled 即时启停；port 落库（运行中改端口须重启生效——设置页说明）；
   * logRequests 即时生效。@returns {config, status}
   */
  configure(patch = {}) {
    if (patch.enabled === true || patch.enabled === false) {
      this.store.preferences.set(LOCAL_API.KEYS.enabled, patch.enabled);
      if (patch.enabled) {
        try { this.start(); } catch (err) { this.lastError = String((err && err.message) || err); }
      } else {
        this.stop();
      }
    }
    if (patch.port != null) {
      const p = Math.floor(Number(patch.port));
      if (!Number.isFinite(p) || p < LOCAL_API.PORT_MIN || p > LOCAL_API.PORT_MAX) {
        throw new Error(`端口须在 ${LOCAL_API.PORT_MIN}-${LOCAL_API.PORT_MAX} 之间。`);
      }
      this.store.preferences.set(LOCAL_API.KEYS.port, p);
    }
    if (patch.logRequests === true || patch.logRequests === false) {
      this.store.preferences.set(LOCAL_API.KEYS.logRequests, patch.logRequests);
      if (!patch.logRequests) this._log = [];
    }
    return { config: this.getConfig(), status: this.status() };
  }

  // MARK: 生命周期

  /** 启动本地服务（127.0.0.1 绑定；已运行时幂等返回现端口）。 */
  start(port = null) {
    if (this._server) return { port: this._port, host: LOCAL_API.HOST, alreadyRunning: true };
    const target = port != null ? Math.floor(Number(port)) : this._configuredPort();
    if (!Number.isFinite(target) || target < LOCAL_API.PORT_MIN || target > LOCAL_API.PORT_MAX) {
      throw new Error(`端口须在 ${LOCAL_API.PORT_MIN}-${LOCAL_API.PORT_MAX} 之间。`);
    }
    const server = http.createServer((req, res) => this._handle(req, res));
    server.on('error', (err) => {
      this.counters.errors += 1;
      this.lastError = String((err && err.message) || err);
      try { this.stop(); } catch (_) { /* 关不停就算了 */ }
    });
    // 同步 listen（backlog 0）：探针/设置页 start() 返回后端口立即可连
    server.listen(target, LOCAL_API.HOST);
    this._server = server;
    this._port = target;
    this._startedAt = this._now();
    this._rlWindowStart = Math.floor(this._now() / 60);
    this._rlCount = 0;
    this.counters.started += 1;
    this.lastError = null;
    try { this.store.emit('api:changed', this.status()); } catch (_) { /* 无订阅者不阻塞 */ }
    return { port: target, host: LOCAL_API.HOST };
  }

  /** 停止并立即释放端口（断开全部 keep-alive 连接；幂等）。 */
  stop() {
    const server = this._server;
    if (!server) return { stopped: false };
    this._server = null;
    this._port = null;
    this._startedAt = null;
    this.counters.stopped += 1;
    try { server.closeAllConnections?.(); } catch (_) { /* 老内核无此 API */ }
    try { server.close(); } catch (_) { /* 幂等 */ }
    try { this.store.emit('api:changed', this.status()); } catch (_) { /* 无订阅者不阻塞 */ }
    return { stopped: true };
  }

  status() {
    return {
      running: Boolean(this._server),
      host: LOCAL_API.HOST,
      port: this._port,
      startedAt: this._startedAt,
      requests: this.counters.requests,
      unauthorized: this.counters.unauthorized,
      rateLimited: this.counters.rateLimited,
      errors: this.counters.errors,
      lastError: this.lastError,
      rateLimitPerMinute: LOCAL_API.RATE_LIMIT_PER_MINUTE,
    };
  }

  // MARK: 请求处理（只读 JSON）

  _handle(req, res) {
    const startedMs = Date.now();
    const respond = (status, payload) => {
      // CORS 红线：全响应不发任何 Access-Control-* 头（跨域默认拒绝）
      const body = JSON.stringify(payload ?? { ok: status < 400 });
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
      });
      res.end(body);
      this._record(req, status, Date.now() - startedMs);
    };
    try {
      this.counters.requests += 1;
      const url = new URL(req.url || '/', `http://${LOCAL_API.HOST}`);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      // ① 鉴权先行：无 token / 错 token 的请求连「哪些方法可用」都不可见
      const header = String(req.headers.authorization || '');
      const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!presented || !tokenMatches(presented, this._token)) {
        this.counters.unauthorized += 1;
        return respond(401, { error: 'unauthorized' });
      }

      // ② 只读红线：只开 GET（HEAD 同语义放行由 http 层处理；其余一律 405）
      if (req.method !== 'GET') {
        this.counters.methodNotAllowed += 1;
        return respond(405, { error: 'method_not_allowed', allowed: ['GET'] });
      }

      // ③ 限流：每分钟 ≤ 120（固定分钟窗计数）
      const windowNow = Math.floor(this._now() / 60);
      if (windowNow !== this._rlWindowStart) {
        this._rlWindowStart = windowNow;
        this._rlCount = 0;
      }
      this._rlCount += 1;
      if (this._rlCount > LOCAL_API.RATE_LIMIT_PER_MINUTE) {
        this.counters.rateLimited += 1;
        return respond(429, { error: 'rate_limited', limitPerMinute: LOCAL_API.RATE_LIMIT_PER_MINUTE });
      }

      // ④ 路由（全只读 JSON）
      switch (path) {
        case '/api/v1/stats': return respond(200, this._statsPayload());
        case '/api/v1/feeds': return respond(200, this._feedsPayload());
        case '/api/v1/annotations': return respond(200, this._annotationsPayload(url));
        case '/api/v1/reading-clock': return respond(200, this._readingClockPayload());
        case '/api/v1/capsules': return respond(200, this._capsulesPayload());
        case '/api/v1/weeklies': return respond(200, this._weekliesPayload());
        default:
          this.counters.notFound += 1;
          return respond(404, { error: 'not_found' });
      }
    } catch (err) {
      this.counters.errors += 1;
      return respond(500, { error: 'internal', message: String((err && err.message) || err).slice(0, 200) });
    }
  }

  _record(req, status, ms) {
    try {
      if (this.store.preferences.get(LOCAL_API.KEYS.logRequests, false) !== true) return;
      this._log.push({ at: Math.floor(this._now()), method: req.method, path: String(req.url || '').slice(0, 200), status, ms });
      while (this._log.length > LOCAL_API.LOG_CAPACITY) this._log.shift();
    } catch (_) { /* 日志永不阻塞响应 */ }
  }

  // MARK: 端点数据面（全只读投影）

  /** /api/v1/stats：存储统计 + 阅读统计（完读数/批注数/连续天数）。 */
  _statsPayload() {
    const db = this.store.database;
    const count = (sql, ...args) => Number(db.prepare(sql).get(...args)?.n ?? 0);
    let reading = { totals: null, streak: 0 };
    try {
      const s = this.store.knowledge.getStats(365);
      reading = { totals: s.totals || null, streak: s.streak || 0 };
    } catch (_) { /* 统计缺失降级为空 */ }
    let clock = null;
    try {
      const st = this.store.clock.status();
      clock = { peak: st.peak, peakLabel: st.peakLabel, samples: st.samples };
    } catch (_) { /* 生物钟缺失降级 */ }
    return {
      generatedAt: Math.floor(this._now()),
      storage: {
        feeds: count('SELECT COUNT(*) AS n FROM feeds WHERE is_deleted = 0'),
        entries: count('SELECT COUNT(*) AS n FROM items'),
        read: count('SELECT COUNT(*) AS n FROM article_states WHERE is_read = 1'),
        starred: count('SELECT COUNT(*) AS n FROM article_states WHERE is_starred = 1'),
        caches: count('SELECT COUNT(*) AS n FROM article_caches'),
        archives: count('SELECT COUNT(*) AS n FROM archives'),
        highlights: count('SELECT COUNT(*) AS n FROM highlights'),
        notes: count('SELECT COUNT(*) AS n FROM notes'),
        annotationsTotal: count('SELECT COUNT(*) AS n FROM highlights') + count('SELECT COUNT(*) AS n FROM notes'),
      },
      reading: {
        finishedCount: count('SELECT COUNT(*) AS n FROM article_states WHERE is_read = 1'),
        annotationCount: count('SELECT COUNT(*) AS n FROM highlights') + count('SELECT COUNT(*) AS n FROM notes'),
        streakDays: reading.streak || 0,
        totals: reading.totals,
        clock,
      },
      api: { rateLimitPerMinute: LOCAL_API.RATE_LIMIT_PER_MINUTE, startedAt: this._startedAt },
    };
  }

  /** /api/v1/feeds：订阅源列表（标题/URL/健康分；凭据永不外发——本端点不触碰账户密码面）。 */
  _feedsPayload() {
    let rows = [];
    try {
      const dash = this.store.dash.overview();
      rows = (dash.feeds || dash.rows || []).map((r) => ({
        feedID: r.feedID, title: r.title, score: r.score, band: r.band,
        posts30: r.posts30, readRate: r.readRate, isDead: r.isDead,
      }));
    } catch (_) { rows = []; }
    return { generatedAt: Math.floor(this._now()), total: rows.length, feeds: rows };
  }

  /** /api/v1/annotations：批注分页（高亮文本/笔记/文章标题/时间；正文全文永不返回）。 */
  _annotationsPayload(url) {
    const clamp = (v, min, max, dflt) => {
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n)) return dflt;
      return Math.max(min, Math.min(max, n));
    };
    const limit = clamp(url.searchParams.get('limit'), 1, LOCAL_API.ANNOTATION_PAGE_MAX, 50);
    const offset = clamp(url.searchParams.get('offset'), 0, 1_000_000, 0);
    const db = this.store.database;
    // 单条 SQL 并表投影（highlights ∪ notes；固定 prepared 形状，参数全部绑定）
    const rows = db.prepare(`
      SELECT * FROM (
        SELECT h.id AS id, 'highlight' AS kind, h.item_id AS entryID,
               COALESCE(h.text, '') AS text, COALESCE(h.note, '') AS note,
               h.color AS color, h.created_at AS createdAt,
               COALESCE(a.title, '') AS articleTitle, COALESCE(f.title, '') AS sourceTitle
        FROM highlights h
        LEFT JOIN items i ON i.id = h.item_id
        LEFT JOIN articles a ON a.item_id = h.item_id
        LEFT JOIN feeds f ON f.id = i.feed_id
        UNION ALL
        SELECT n.id AS id, 'note' AS kind, n.item_id AS entryID,
               COALESCE(n.content, '') AS text, '' AS note,
               NULL AS color, n.created_at AS createdAt,
               COALESCE(a.title, '') AS articleTitle, COALESCE(f.title, '') AS sourceTitle
        FROM notes n
        LEFT JOIN items i ON i.id = n.item_id
        LEFT JOIN articles a ON a.item_id = n.item_id
        LEFT JOIN feeds f ON f.id = i.feed_id
      )
      ORDER BY createdAt DESC, id ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM highlights').get()?.n ?? 0)
      + Number(db.prepare('SELECT COUNT(*) AS n FROM notes').get()?.n ?? 0);
    return {
      generatedAt: Math.floor(this._now()),
      total,
      limit,
      offset,
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        entryID: r.entryID,
        articleTitle: String(r.articleTitle || '').slice(0, 160),
        sourceTitle: String(r.sourceTitle || '').slice(0, 80),
        text: String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, LOCAL_API.TEXT_SLICE),
        note: r.note ? String(r.note).slice(0, LOCAL_API.TEXT_SLICE) : null,
        color: r.color || null,
        createdAt: r.createdAt,
      })),
    };
  }

  /** /api/v1/reading-clock：F36 时段桶数据（24 小时桶 + 高峰判定）。 */
  _readingClockPayload() {
    const st = this.store.clock.status();
    return {
      generatedAt: Math.floor(this._now()),
      from: st.from,
      to: st.to,
      windowDays: 7,
      samples: st.samples,
      minSamples: st.minSamples,
      peak: st.peak,
      peakLabel: st.peakLabel,
      buckets: st.buckets,
      ms: st.ms,
    };
  }

  /** /api/v1/capsules：胶囊元数据（id/状态/开启时刻；批注原文不外发）。 */
  _capsulesPayload() {
    let items = [];
    try {
      items = this.store.capsule.list({ limit: 200 }).map((c) => ({
        id: c.id,
        status: c.status,
        annotationKind: c.annotationKind,
        entryID: c.entryID,
        openAt: c.openAt,
        opensCount: c.opensCount,
        createdAt: c.createdAt,
        openedAt: c.openedAt,
      }));
    } catch (_) { items = []; }
    return { generatedAt: Math.floor(this._now()), total: items.length, items };
  }

  /** /api/v1/weeklies：周刊元数据（期号/周起点/状态；版面内容不外发）。 */
  _weekliesPayload() {
    let items = [];
    try {
      items = this.store.weekly.list({ limit: 100 }).map((w) => ({
        id: w.id,
        weekStart: w.weekStart,
        status: w.status,
        issue: w.issue,
        createdAt: w.createdAt,
      }));
    } catch (_) { items = []; }
    return { generatedAt: Math.floor(this._now()), total: items.length, items };
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return {
      ...this.counters,
      ...LOCAL_API,
      tokenLength: this._token.length,
      rateWindow: this._rlWindowStart,
      rateCount: this._rlCount,
      logSize: this._log.length,
      status: this.status(),
    };
  }
}

module.exports = {
  LocalApiService,
  LOCAL_API,
  generateToken,
  tokenMatches,
};
