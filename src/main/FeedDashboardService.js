'use strict';
/**
 * FeedDashboardService（知更）— 订阅源体检仪表盘（F16）
 *
 * 每源 30 天指标 × 健康分（0-100）× 建议文案，全部从既有表聚合：
 * - items + articles + article_states：发文量 / 已读 / 收藏（一条聚合 SQL）；
 * - reading_behavior：每源打开计数（停留数据缺失 → 用阅读率替代口径）；
 * - feed_health：抓取健康（累计失败率 + 连续失败 + 最近成功抓取）。
 * 零新表（DDL 红线）；禁 N+1——每指标一条 GROUP BY feed_id 聚合，
 * 200 源量级全程 <300ms（探针回归）。
 *
 * 健康分 = 发文活跃 30 + 阅读率 30 + 抓取健康 40：
 * - 发文活跃：30 × min(1, 30天发文/15)（半月更即满分）；
 * - 阅读率：30 × (已读/发文)，无发文为 0；
 * - 抓取健康：40 × (1-失败率)，连续失败 ≥5（死源）记 0。
 * 徽标档位：绿 ≥80 / 黄 50-79 / 红 <50（前端只用语义档位类 + accent 派生色）。
 *
 * 缓存：overview 聚合结果缓存 60s（可注入时钟），避免每次打开重算；
 * 详情 dash:feed 复用同一份缓存（不发额外查询），缓存冷时惰性重建。
 */

const { feedIconURL } = require('./Models');

const CACHE_TTL_SECONDS = 60;  // 计算缓存窗口
const WINDOW_DAYS = 30;        // 指标窗口（天）
const POSTS_FULL_SCORE = 15;   // 30 天发文达到该篇数即发文活跃满分
const FAILING_CONSECUTIVE = 3; // 连续失败 ≥3 判「失败源」
const DEAD_CONSECUTIVE = 5;    // 连续失败 ≥5 判死源（与 EvolutionEngine is_dead 口径一致）

class FeedDashboardService {
  constructor(store, { now = () => Date.now() / 1000 } = {}) {
    this.store = store;
    this._now = now;
    this._cache = null; // { at, overview }
    this.counters = { computed: 0, cacheHits: 0 };
  }

  /** 缓存冷/过期时重建；TTL 内直接返回（cacheHits 计数供探针断言）。 */
  overview() {
    const now = this._now();
    if (this._cache && now - this._cache.at < CACHE_TTL_SECONDS) {
      this.counters.cacheHits += 1;
      return this._cache.overview;
    }
    const overview = this._compute();
    this._cache = { at: now, overview };
    this.counters.computed += 1;
    return overview;
  }

  /** 单源详情：复用 overview 缓存的聚合行，附错误信息与建议文案（结构化 code，前端 i18n）。 */
  feedDetail(feedID) {
    const data = this.overview();
    const row = data.feeds.find((f) => f.feedID === feedID);
    if (!row) return null;
    const health = this._healthRow(feedID);
    return {
      ...row,
      lastError: health?.lastError || null,
      lastFailureAt: health?.last_failure_at || null,
      attempts: (health?.fetch_success_count || 0) + (health?.fetch_failure_count || 0),
      suggestions: this._suggestions(row, health),
    };
  }

  invalidate() { this._cache = null; }

  // MARK: - 聚合（每指标一条 SQL，禁 N+1）

  _compute() {
    const now = this._now();
    const monthAgo = Math.floor(now) - WINDOW_DAYS * 86400;

    // 1) 30 天发文量 + 已读 + 收藏（一条聚合；COALESCE(published_at, created_at) 与
    //    TimelineQueryService 的 today 口径一致）
    const items30 = new Map();
    for (const r of this.store.database.prepare(`
      SELECT i.feed_id AS feedID, COUNT(*) AS posts,
             SUM(COALESCE(s.is_read, 0)) AS reads,
             SUM(COALESCE(s.is_starred, 0)) AS stars
      FROM items i
      INNER JOIN articles a ON a.item_id = i.id
      LEFT JOIN article_states s ON s.item_id = i.id
      WHERE COALESCE(a.published_at, i.created_at) >= ?
      GROUP BY i.feed_id
    `).all(monthAgo)) {
      items30.set(r.feedID, r);
    }

    // 2) 30 天逐日发文桶（迷你条形 / 月趋势同源；0-29 桶，越界丢弃）
    const daily = new Map(); // feedID -> Array(30)
    for (const r of this.store.database.prepare(`
      SELECT i.feed_id AS feedID,
             CAST((COALESCE(a.published_at, i.created_at) - ?) / 86400 AS INTEGER) AS dayIdx,
             COUNT(*) AS n
      FROM items i
      INNER JOIN articles a ON a.item_id = i.id
      WHERE COALESCE(a.published_at, i.created_at) >= ?
      GROUP BY i.feed_id, dayIdx
    `).all(monthAgo, monthAgo)) {
      if (r.dayIdx < 0 || r.dayIdx >= WINDOW_DAYS) continue;
      if (!daily.has(r.feedID)) daily.set(r.feedID, new Array(WINDOW_DAYS).fill(0));
      daily.get(r.feedID)[r.dayIdx] = r.n;
    }

    // 3) 30 天打开计数（reading_behavior per-feed；无停留时长数据 → 打开率/阅读率替代口径）
    const opens = new Map();
    for (const r of this.store.database.prepare(`
      SELECT feed_id AS feedID, COUNT(*) AS n
      FROM reading_behavior
      WHERE action = 'read' AND created_at >= ? AND feed_id IS NOT NULL
      GROUP BY feed_id
    `).all(monthAgo)) {
      opens.set(r.feedID, r.n);
    }

    // 4) 抓取健康（feed_health 全表行数 = 源数，非 N+1）
    const health = new Map();
    for (const r of this.store.database.prepare('SELECT * FROM feed_health').all()) {
      health.set(r.feed_id, r);
    }

    // 5) 源清单（含停用账户的源不剔除——体检正是要看见它们）
    const feeds = this.store.database.prepare(`
      SELECT id, title, site_url, feed_url, stored_icon_url
      FROM feeds WHERE is_deleted = 0
    `).all();

    const rows = feeds.map((f) => {
      const agg = items30.get(f.id) || { posts: 0, reads: 0, stars: 0 };
      const posts = Number(agg.posts) || 0;
      const reads = Number(agg.reads) || 0;
      const stars = Number(agg.stars) || 0;
      const h = health.get(f.id) || null;
      const success = h?.fetch_success_count || 0;
      const failure = h?.fetch_failure_count || 0;
      const attempts = success + failure;
      const failureRate = attempts > 0 ? failure / attempts : 0;
      const consecutive = h?.consecutive_failures || 0;
      const readRate = posts > 0 ? Math.min(1, reads / posts) : 0;
      const starRate = posts > 0 ? Math.min(1, stars / posts) : 0;
      const opens30 = opens.get(f.id) || 0;

      const publishScore = 30 * Math.min(1, posts / POSTS_FULL_SCORE);
      const readScore = 30 * readRate;
      const fetchScore = consecutive >= DEAD_CONSECUTIVE ? 0 : 40 * (1 - failureRate);
      const score = Math.round(publishScore + readScore + fetchScore);

      return {
        feedID: f.id,
        title: f.title || f.feed_url || f.id,
        iconURL: feedIconURL({ storedIconURL: f.stored_icon_url, siteURL: f.site_url, feedURL: f.feed_url }),
        score,
        band: score >= 80 ? 'good' : score >= 50 ? 'warn' : 'bad',
        posts30: posts,
        reads30: reads,
        stars30: stars,
        readRate: Number(readRate.toFixed(3)),
        starRate: Number(starRate.toFixed(3)),
        opens30,
        failureRate: Number(failureRate.toFixed(3)),
        attempts,
        consecutiveFailures: consecutive,
        isDead: consecutive >= DEAD_CONSECUTIVE || Boolean(h?.is_dead),
        lastSuccessAt: h?.last_success_at || null,
        trend: daily.get(f.id) || new Array(WINDOW_DAYS).fill(0),
      };
    }).sort((a, b) => b.score - a.score || b.posts30 - a.posts30 || a.title.localeCompare(b.title));

    return {
      generatedAt: Math.floor(now),
      windowDays: WINDOW_DAYS,
      postsFullScoreAt: POSTS_FULL_SCORE,
      summary: {
        total: rows.length,
        top: rows.filter((r) => r.score >= 80).length,
        silent: rows.filter((r) => r.posts30 === 0).length,
        failing: rows.filter((r) => r.consecutiveFailures >= FAILING_CONSECUTIVE || r.isDead).length,
      },
      feeds: rows,
    };
  }

  _healthRow(feedID) {
    return this.store.database.prepare('SELECT * FROM feed_health WHERE feed_id = ?').get(feedID) || null;
  }

  /** 建议文案（结构化 code + 参数，渲染层走 I18NStrings）。 */
  _suggestions(row, health) {
    const out = [];
    if (row.posts30 === 0) out.push({ code: 'noUpdate30d' });
    if (row.consecutiveFailures >= FAILING_CONSECUTIVE) {
      out.push({ code: 'consecutiveFailures', count: row.consecutiveFailures });
    } else if (row.attempts >= 2 && row.failureRate >= 0.5) {
      out.push({ code: 'highFailureRate', rate: Math.round(row.failureRate * 100) });
    }
    if (row.attempts > 0 && !(health?.fetch_success_count > 0)) out.push({ code: 'neverSucceeded' });
    if (!out.length) out.push({ code: 'healthy' });
    return out;
  }

  snapshot() {
    return { ...this.counters, cacheTTL: CACHE_TTL_SECONDS, windowDays: WINDOW_DAYS, cached: Boolean(this._cache) };
  }
}

module.exports = { FeedDashboardService, CACHE_TTL_SECONDS, WINDOW_DAYS, FAILING_CONSECUTIVE };
