'use strict';
/**
 * RobinRead（知更）— 全文抓取引擎（F1）
 *
 * 很多源只输出摘要（公众号 / 摘要型 RSS）：本服务在刷新灌文完成后，把启用全文的
 * 源的新文章排入后台队列，复用 ArticleExtractor 提取链路（utilityProcess worker）
 * 补抓全文并写入现有正文缓存表——列表、搜索、期刊、AI 读端零改动即吃到全文。
 *
 * 每源三态偏好（存偏好 JSON，仿每源翻译模式 RobinRead.translate.feedModes）：
 * - 'off'（默认，删除键）/ 'on'（开：刷新补新文章 + 手动刷新全量补抓存量）/ 'newOnly'
 *   （仅新文章：刷新补新文章，存量永不回补）。
 *
 * 队列契约：
 * - 有界并发 CONCURRENCY=2：与相邻预取（并发 3）协调，不打爆提取 worker；
 * - 单篇失败静默重试至多 1 次（同篇不进死循环）；
 * - 队列上限 QUEUE_CAP：满了丢弃剩余（下次手动刷新可全量补回），退出即内存清空；
 * - 判定复用现有逻辑：无正文缓存（article_caches）+ needsExtraction；
 * - 提取走 store.extractArticle（priority='prefetch'，排在用户任务之后）：
 *   落库（含 FTS 正文索引、坏壳守门、LRU 逐出）全部复用，本服务不另写缓存。
 */
const ArticleExtractor = require('./ArticleExtractor');
const { i18n } = require('./I18N');

const MODES_KEY = 'RobinRead.fulltext.feedModes';
const CONCURRENCY = 2;     // 后台补抓在途上限（与相邻预取并发协调后的约定值）
const QUEUE_CAP = 120;     // 后台队列上限：满了丢剩余，防失控刷巨量旧文
const BACKFILL_LIMIT = 200; // 手动刷新触发的单源存量补抓上限
const NOTIFY_THROTTLE_MS = 5000; // 补抓落库后的状态推送节流（徽标消失用，不打断 UI）

class FullTextService {
  constructor(store) {
    this.store = store;
    this.queue = [];            // 待提取 entryID（FIFO）
    this.queuedIDs = new Set(); // 防重：已在队列 / 在途的条目
    this.pendingNew = new Map(); // feedID -> entryID[]（本轮流灌进来的新文章，kick 时再筛）
    this.inFlight = 0;
    this.retryTried = new Set(); // 已重试过一次的条目（同篇至多重试 1 次）
    this._kickTimer = null;
    this._notifyTimer = null;
    this._notifyDirty = false;
    this.counters = { enqueued: 0, extracted: 0, failed: 0, retried: 0, queueDropped: 0, maxInFlight: 0 };
  }

  // MARK: - 每源三态偏好

  /** feedID → 'on' | 'newOnly'（缺省 = 'off'，默认关闭）。 */
  feedModes() {
    try {
      const parsed = JSON.parse(this.store.preferences.get(MODES_KEY, '{}') || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  modeFor(feedID) {
    const mode = this.feedModes()[feedID];
    return mode === 'on' || mode === 'newOnly' ? mode : 'off';
  }

  /** mode: 'off'（删除键回默认）/ 'on' / 'newOnly'。 */
  setFeedMode(feedID, mode) {
    const map = this.feedModes();
    if (mode === 'off') delete map[feedID];
    else if (mode === 'on' || mode === 'newOnly') map[feedID] = mode;
    else throw new Error(i18n.localized('不支持的全文抓取模式。'));
    this.store.preferences.set(MODES_KEY, JSON.stringify(map));
    this.store._emitState();
    return map;
  }

  /** 启用全文（任一模式）的源 ID 集合（列表徽标 / 批量开关用）。 */
  enabledFeedIDs() {
    const ids = [];
    for (const [feedID, mode] of Object.entries(this.feedModes())) {
      if (mode === 'on' || mode === 'newOnly') ids.push(feedID);
    }
    return ids;
  }

  // MARK: - 刷新接线（灌文事务之后异步启动，主路径零阻塞）

  /**
   * 灌文完成后的登记（_applyParsedEntries 事务外调用）：只收集 ID 不做任何判定，
   * 筛选（模式 / needsExtraction / 无缓存）与网络全部推迟到 kick()。
   */
  noteNewEntries(feedID, entryIDs) {
    if (!entryIDs || !entryIDs.length || this.modeFor(feedID) === 'off') return;
    const list = this.pendingNew.get(feedID) || [];
    list.push(...entryIDs);
    this.pendingNew.set(feedID, list);
  }

  /** 刷新收尾：异步（让出灌文→UI 推送链路）筛出待补抓条目并入队。 */
  kick() {
    if (this._kickTimer) return;
    this._kickTimer = setTimeout(() => {
      this._kickTimer = null;
      try { this._drainPendingNew(); } catch (err) { console.warn('[fulltext] kick failed:', err?.message || err); }
    }, 60);
  }

  _drainPendingNew() {
    if (this.pendingNew.size === 0) return;
    const batches = [...this.pendingNew.entries()];
    this.pendingNew.clear();
    const ids = [];
    for (const [feedID, entryIDs] of batches) {
      if (this.modeFor(feedID) === 'off') continue; // 灌文后用户改了设置：尊重最新值
      ids.push(...entryIDs);
    }
    this.enqueueCandidates(ids);
  }

  /**
   * 手动刷新此源 = 强制全量补抓存量（仅 'on' 模式；'newOnly' 存量永不回补）。
   * 无缓存的存量按到达时间倒序取 BACKFILL_LIMIT 篇，交同一队列消化。
   */
  backfillFeed(feedID) {
    if (this.modeFor(feedID) !== 'on') return 0;
    let rows = [];
    try {
      rows = this.store.database.prepare(`
        SELECT i.id AS id
        FROM items i
        LEFT JOIN articles a ON a.item_id = i.id
        LEFT JOIN article_caches c ON c.item_id = i.id
        WHERE i.feed_id = ? AND c.item_id IS NULL
        ORDER BY COALESCE(a.published_at, i.created_at) DESC
      `).all(feedID).map((r) => r.id);
    } catch (err) {
      console.warn('[fulltext] backfill query failed:', err?.message || err);
      return 0;
    }
    const count = this.enqueueCandidates(rows.slice(0, BACKFILL_LIMIT));
    if (count > 0) console.log(`[fulltext] 手动刷新补抓存量：${count} 篇`);
    return count;
  }

  /** 批量筛出确实需要补抓的条目（无缓存 + needsExtraction + 有原文链接）并入队。 */
  enqueueCandidates(entryIDs) {
    const fresh = (Array.isArray(entryIDs) ? entryIDs : []).filter((id) => id && !this.queuedIDs.has(id));
    if (!fresh.length) return 0;
    const entries = this.store.articlesRepo.entriesByIDs(fresh);
    let enqueued = 0;
    for (const entry of entries) {
      if (!entry.url) continue;
      if (this.store.cachesRepo.cache(entry.id)) continue; // 已有正文缓存：读端直接可见
      if (!ArticleExtractor.needsExtraction(entry)) continue; // 富内容源不浪费请求
      if (this.queue.length >= QUEUE_CAP) {
        this.counters.queueDropped += 1;
        break; // 队列满：丢弃剩余（下次手动刷新可全量补回）
      }
      this.queuedIDs.add(entry.id);
      this.queue.push(entry.id);
      this.counters.enqueued += 1;
      enqueued += 1;
    }
    if (enqueued > 0) this._pump();
    return enqueued;
  }

  // MARK: - 队列泵（并发 ≤ CONCURRENCY；单篇失败重试至多 1 次）

  _pump() {
    while (this.inFlight < CONCURRENCY && this.queue.length > 0) {
      const entryID = this.queue.shift();
      this.inFlight += 1;
      this.counters.maxInFlight = Math.max(this.counters.maxInFlight, this.inFlight);
      this._extractOne(entryID)
        .catch(() => { /* _extractOne 内部已消化全部失败 */ })
        .finally(() => {
          this.inFlight -= 1;
          this._pump();
          if (this.inFlight === 0 && this.queue.length === 0) this._notifyChanged(true);
        });
    }
  }

  async _extractOne(entryID) {
    let ok = false;
    try {
      const cache = await this.store.extractArticle(entryID, { priority: 'prefetch' });
      ok = Boolean(cache && cache.text);
    } catch (_) {
      ok = false;
    }
    if (ok) {
      this.queuedIDs.delete(entryID); // 完成才释放：重试在途期间保持登记，防新刷新重复入队
      this.counters.extracted += 1;
      this._bumpStats(entryID, true);
      this._notifyChanged(false);
      return;
    }
    // 单篇失败：同篇至多重试 1 次（重试优先，尽快出结果），再失败静默记录。
    if (!this.retryTried.has(entryID)) {
      this.retryTried.add(entryID);
      this.counters.retried += 1;
      if (this.retryTried.size > 400) this.retryTried.delete(this.retryTried.keys().next().value);
      this.queue.unshift(entryID);
      this._pump();
      return;
    }
    this.queuedIDs.delete(entryID); // 终态（最终失败）同样释放
    this.counters.failed += 1;
    this._bumpStats(entryID, false);
  }

  // MARK: - 指标（feed_fulltext_stats，v11 迁移建表；F11 仪表盘复用）

  _bumpStats(entryID, success) {
    try {
      const entry = this.store.articlesRepo.entry(entryID);
      if (!entry) return;
      const now = Date.now() / 1000;
      this.store.database.prepare(`
        INSERT INTO feed_fulltext_stats (feed_id, fetched_count, failed_count, last_fetched_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(feed_id) DO UPDATE SET
          fetched_count = fetched_count + excluded.fetched_count,
          failed_count = failed_count + excluded.failed_count,
          last_fetched_at = CASE WHEN excluded.fetched_count = 1 THEN excluded.last_fetched_at ELSE last_fetched_at END,
          updated_at = excluded.updated_at
      `).run(entry.feedID, success ? 1 : 0, success ? 0 : 1, success ? now : null, now);
    } catch (_) { /* 指标失败不影响主流程 */ }
  }

  /** 每源补抓统计（feedID → {fetched, failed, lastFetchedAt}），设置页 / F11 仪表盘用。 */
  feedStats() {
    const map = {};
    try {
      const rows = this.store.database.prepare(`
        SELECT f.id AS feed_id, f.title AS title, s.fetched_count, s.failed_count, s.last_fetched_at
        FROM feed_fulltext_stats s INNER JOIN feeds f ON f.id = s.feed_id
      `).all();
      for (const row of rows) {
        map[row.feed_id] = {
          title: row.title,
          fetched: Number(row.fetched_count) || 0,
          failed: Number(row.failed_count) || 0,
          lastFetchedAt: row.last_fetched_at ?? null,
        };
      }
    } catch (_) { /* 表缺失按空 */ }
    return map;
  }

  // MARK: - 状态推送与清理

  /**
   * 补抓落库后的静默推送：正文缓存对侧栏计数无影响，但列表徽标（「全文」）依赖
   * hasBodyCache 消失。节流合并 + 队列排空时兜底一次，绝不打断阅读。
   * try/catch：退出关库后到点的定时器不再连库抛错。
   */
  _notifyChanged(drain) {
    const emit = () => {
      try { this.store._emitState(); } catch (_) { /* 库已关闭（退出中）：静默 */ }
    };
    this._notifyDirty = true;
    if (drain) {
      if (this._notifyTimer) { clearTimeout(this._notifyTimer); this._notifyTimer = null; }
      this._notifyDirty = false;
      emit();
      return;
    }
    if (this._notifyTimer) return;
    this._notifyTimer = setTimeout(() => {
      this._notifyTimer = null;
      if (!this._notifyDirty) return;
      this._notifyDirty = false;
      emit();
    }, NOTIFY_THROTTLE_MS);
  }

  /** 队列安全清空（退出 / 诊断用；在途任务任其自然结束，不落任何脏数据）。 */
  dispose() {
    this.queue = [];
    this.pendingNew.clear();
    this.queuedIDs.clear();
    if (this._kickTimer) { clearTimeout(this._kickTimer); this._kickTimer = null; }
    if (this._notifyTimer) { clearTimeout(this._notifyTimer); this._notifyTimer = null; }
  }

  /** 诊断快照（探针 scripts/diag-f1-fulltext.js 断言并发 / 计数用）。 */
  snapshot() {
    return {
      queued: this.queue.length,
      inFlight: this.inFlight,
      pendingFeeds: this.pendingNew.size,
      ...this.counters,
    };
  }
}

module.exports = { FullTextService };
