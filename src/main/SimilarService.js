'use strict';
/**
 * SimilarService（知更）— 相关文章「继续读」+ 线索视图（F13）
 *
 * 相似引擎（similar）：
 * - 候选粗筛（性能红线：禁全表逐篇 Jaccard）：同库近 90 天 + SQL 级 OR 预筛
 *   （显著词 LIKE 标题/摘要 ∨ 同源 ∨ 同标签），命中集截 500，再内存精排；
 * - 相似度 = 标题/摘要 bigram Jaccard × 0.7 + 同标签（article_tags 交集）× 0.2
 *   + 同源 × 0.1；同分按发布时间新者在前；
 * - 排除自身与同 feed 直接邻居（时间线上前后各一篇——同源连播不算「相关发现」）；
 * - 理由标签：取最大分量（同主题/同标签/同源）+ 总相似度百分比（「同主题 87%」）；
 * - per-entryID 快速缓存（读进即命中，跨切换不重算；上限 300 条 FIFO 淘汰）。
 *
 * 线索视图（threads）：
 * - 近 90 天文章按 F9 显著词（lib/keywords.extractKeywords）共现聚类：
 *   每篇取显著词（≤3），词的文章数 df ≥ 3 才成簇种子（独词不成线索），
 *   每簇 3–20 篇成时间线；与已收簇重叠 > 60% 判为同题重复簇丢弃；Top 12。
 * - threadsDetail(keyword) 返回该线索的时间线（发布时间降序）。
 *
 * 无新表（article_tags / items / articles 既有结构直接投影），无网络路；
 * 注入缝（探针离线化）：_nowImpl / _candidateRowsImpl / _threadRowsImpl。
 */
const { i18n } = require('./I18N');
const { extractKeywords } = require('./lib/keywords');

const WINDOW_DAYS = 90;          // 相似/线索共用回看窗口
const CANDIDATE_CAP = 500;       // 粗筛候选上限（内存精排 N 侧约束）
const KEYWORD_POOL = 4;          // 粗筛显著词个数
const SIMILAR_LIMIT_DEFAULT = 6; // 默认返回条数（渲染层只取前 3）
const MIN_CARD_ITEMS = 3;        // 「继续读」卡最少素材（不足则渲染层优雅隐藏）
const TEXT_SLICE = 400;          // 参与分词的标题+摘要长度
const TAG_POOL = 8;              // 自篇标签参与数
const CACHE_MAX = 300;           // per-entryID 缓存条数上限
const W_TAG = 0.2, W_SOURCE = 0.1; // 文本分量恒为 1 - W_TAG - W_SOURCE
const THREADS_TOP = 12;          // 线索条数上限
const THREADS_SCAN_CAP = 1200;   // 线索扫描文章上限（近 90 天最新优先）
const THREAD_MIN = 3, THREAD_MAX = 20; // 单线索篇数边界
const THREAD_DF_MIN = 3;         // 词至少共现于 3 篇才成种子
const THREAD_DUP_OVERLAP = 0.6;  // 与已收簇条目重叠超 60% 视为同题簇
const SUMMARY_KEY_SLICE = 240;   // 线索关键词提取的摘要参与长度

// MARK: - 纯函数（探针直测）

/** 文本 → 字符 bigram 集合（空白折叠；长度 < 2 时空集）。 */
function bigrams(text) {
  const clean = String(text || '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + 2 <= clean.length; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

/** Jaccard 相似度（|A∩B| / |A∪B|，空集对为 0）。 */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return hit / (a.size + b.size - hit);
}

/**
 * 单对相似度：bigram Jaccard × 0.7 + 标签交集 × 0.2 + 同源 × 0.1。
 * @returns {{ score, textSim, tagSim, sameSource }} score ∈ [0,1]
 */
function similarityOf(self, cand, caches = {}) {
  const a = caches.selfGrams || (caches.selfGrams = bigrams(self.text));
  const b = bigrams(cand.text);
  const textSim = jaccard(a, b);
  const tagSim = tagOverlapScore(self.tags, cand.tags);
  const sameSource = self.feedID && cand.feedID === self.feedID ? 1 : 0;
  const score = textSim * (1 - W_TAG - W_SOURCE) + tagSim * W_TAG + sameSource * W_SOURCE;
  return { score, textSim, tagSim, sameSource };
}

/** 标签分量：交集非空计 0.5 起步、每多一个 +0.25，封顶 1（1 个交集=0.5，2 个及以上=1）。 */
function tagOverlapScore(selfTags, candTags) {
  if (!selfTags?.length || !candTags?.length) return 0;
  const set = new Set(selfTags.map((t) => String(t).toLowerCase()));
  let hit = 0;
  for (const t of candTags) if (set.has(String(t).toLowerCase())) hit += 1;
  return hit > 0 ? Math.min(1, 0.5 + (hit - 1) * 0.25) : 0;
}

/** 理由标签：最大分量 → kind；渲染层按 kind 取本地化文案 + 百分比。 */
function reasonOf({ textSim, tagSim, sameSource }) {
  const max = Math.max(textSim, tagSim, sameSource);
  if (max <= 0) return 'topic';
  if (max === textSim) return 'topic';
  if (max === tagSim) return 'tag';
  return 'source';
}

// MARK: - 服务

class SimilarService {
  constructor(store) {
    this.store = store;
    this.counters = { computed: 0, cacheHits: 0, threadsBuilt: 0, threads: 0 };
    this._cache = new Map(); // entryID -> { items, at }
    this._nowImpl = null;    // 注入缝：时间（探针固定窗口）
    this._candidateRowsImpl = null; // 注入缝：粗筛候选行（探针灌数即所得）
    this._threadRowsImpl = null;    // 注入缝：线索扫描行
  }

  now() {
    return this._nowImpl ? this._nowImpl() : Date.now() / 1000;
  }

  // MARK: 相似引擎

  /**
   * 相关文章：entryID 的 Top limit 相似文（不含自身/同 feed 直接邻居）。
   * @returns {{ items: [{id, feedID, title, sourceTitle, url, publishedAt, score, pct, reason}] }}
   *          reason ∈ 'topic'|'tag'|'source'；分数阈值过滤零相关噪声。
   */
  similar(entryID, { limit = SIMILAR_LIMIT_DEFAULT } = {}) {
    const id = String(entryID || '');
    if (!id) return { items: [] };
    const cached = this._cache.get(id);
    if (cached) {
      this.counters.cacheHits += 1;
      return { items: cached.items.slice(0, Math.max(1, Math.min(Number(limit) || SIMILAR_LIMIT_DEFAULT, 20))) };
    }
    const items = this._computeSimilar(id);
    this.counters.computed += 1;
    if (this._cache.size >= CACHE_MAX) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest); // FIFO 淘汰（读序近似访问序，够用且 O(1)）
    }
    this._cache.set(id, { items, at: Date.now() });
    return { items: items.slice(0, Math.max(1, Math.min(Number(limit) || SIMILAR_LIMIT_DEFAULT, 20))) };
  }

  /** 「继续读」卡准入：素材 >= MIN_CARD_ITEMS 才值得展示（渲染层据此优雅隐藏）。 */
  cardFor(entryID) {
    const { items } = this.similar(entryID);
    return { items: items.slice(0, 3), visible: items.length >= MIN_CARD_ITEMS, minItems: MIN_CARD_ITEMS };
  }

  _computeSimilar(entryID) {
    const db = this.store.database;
    const self = db.prepare(`
      SELECT i.id AS id, i.feed_id AS feedID,
             IFNULL(a.title, '') AS title, IFNULL(a.summary, '') AS summary,
             COALESCE(a.published_at, i.created_at) AS publishedAt
      FROM items i
      INNER JOIN articles a ON a.item_id = i.id
      WHERE i.id = ?
    `).get(entryID);
    if (!self) return [];
    const selfTags = db.prepare('SELECT tag FROM article_tags WHERE item_id = ? LIMIT ?')
      .all(entryID, TAG_POOL).map((r) => r.tag);
    const selfText = `${self.title} ${self.summary}`.replace(/\s+/g, ' ').slice(0, TEXT_SLICE * 2);
    const cache = { selfGrams: bigrams(selfText) };

    // 同 feed 直接邻居（时间线上前后各一篇）：同源连播不算相关发现
    const neighborIDs = this._directNeighbors(self);
    const candidates = this._coarseCandidates(self, selfTags, neighborIDs);

    const scored = [];
    for (const cand of candidates) {
      cand.text = `${cand.title} ${cand.summary}`.replace(/\s+/g, ' ').slice(0, TEXT_SLICE * 2);
      const { score, textSim, tagSim, sameSource } = similarityOf(
        { text: selfText, tags: selfTags, feedID: self.feedID },
        cand,
        cache,
      );
      if (score < 0.05) continue; // 纯噪声（文本零重叠且不同源无标签）不入推荐
      scored.push({
        id: cand.id,
        feedID: cand.feedID,
        title: cand.title,
        sourceTitle: cand.feedTitle,
        url: cand.url || null,
        publishedAt: cand.publishedAt,
        score: Math.round(score * 1000) / 1000,
        pct: Math.max(1, Math.min(99, Math.round(score * 100))),
        reason: reasonOf({ textSim, tagSim, sameSource }),
      });
    }
    scored.sort((a, b) => b.score - a.score || (b.publishedAt || 0) - (a.publishedAt || 0) || String(a.id).localeCompare(String(b.id)));
    return scored;
  }

  /** 同 feed 直接邻居：按 (published_at, id) 紧邻的前后各一篇。 */
  _directNeighbors(self) {
    const out = new Set();
    const since = `COALESCE(a.published_at, i.created_at)`;
    try {
      const prev = this.store.database.prepare(`
        SELECT i.id FROM items i INNER JOIN articles a ON a.item_id = i.id
        WHERE i.feed_id = ? AND i.id != ? AND ${since} <= ?
        ORDER BY ${since} DESC, i.id DESC LIMIT 1
      `).get(self.feedID, self.id, self.publishedAt ?? 0);
      if (prev) out.add(prev.id);
      const next = this.store.database.prepare(`
        SELECT i.id FROM items i INNER JOIN articles a ON a.item_id = i.id
        WHERE i.feed_id = ? AND i.id != ? AND ${since} >= ?
        ORDER BY ${since} ASC, i.id ASC LIMIT 1
      `).get(self.feedID, self.id, self.publishedAt ?? 0);
      if (next) out.add(next.id);
    } catch (_) { /* 邻居探测失败不阻塞推荐 */ }
    return out;
  }

  /**
   * 粗筛（SQL 级，禁全表逐篇 Jaccard）：近 90 天 AND（显著词 LIKE 标题/摘要
   * ∨ 同源 ∨ 共标签），发布时间新者优先采样，截 CANDIDATE_CAP。
   */
  _coarseCandidates(self, selfTags, neighborIDs) {
    if (this._candidateRowsImpl) return this._candidateRowsImpl(self, selfTags);
    const db = this.store.database;
    const keywords = extractKeywords(`${self.title}。${self.summary}`, KEYWORD_POOL);
    const where = ['f.is_deleted = 0', 'i.id != ?',
      `COALESCE(a.published_at, i.created_at) >= ?`];
    const params = [self.id, this.now() - WINDOW_DAYS * 86400];
    const ors = ['i.feed_id = ?'];
    params.push(self.feedID);
    for (const kw of keywords) {
      const like = `%${kw.replace(/([%_\\])/g, '\\$1')}%`;
      ors.push(`IFNULL(a.title, '') LIKE ? ESCAPE '\\'`, `IFNULL(a.summary, '') LIKE ? ESCAPE '\\'`);
      params.push(like, like);
    }
    if (selfTags.length) {
      ors.push(`i.id IN (SELECT item_id FROM article_tags WHERE tag IN (${selfTags.map(() => '?').join(',')}))`);
      params.push(...selfTags);
    }
    where.push(`(${ors.join(' OR ')})`);
    const rows = db.prepare(`
      SELECT i.id AS id, i.feed_id AS feedID,
             IFNULL(a.title, '') AS title, IFNULL(a.summary, '') AS summary, a.url AS url,
             IFNULL(f.title, '') AS feedTitle,
             COALESCE(a.published_at, i.created_at) AS publishedAt
      FROM items i
      INNER JOIN feeds f ON f.id = i.feed_id
      INNER JOIN articles a ON a.item_id = i.id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(a.published_at, i.created_at) DESC, i.id DESC
      LIMIT ${CANDIDATE_CAP}
    `).all(...params);
    // 同 feed 直接邻居在 SQL 后剔除（行数少，代价可忽略）
    return rows.filter((r) => !neighborIDs.has(r.id));
  }

  // MARK: 线索视图

  /**
   * 线索列表：近 90 天文章显著词共现聚类，Top top 条。
   * @returns {{ threads: [{keyword, count, entries:[{id,title,sourceTitle,publishedAt}]}], windowDays, scanned }}
   */
  threadsList({ windowDays = WINDOW_DAYS, top = THREADS_TOP } = {}) {
    const { clusters, scanned } = this._buildThreads(Number(windowDays) || WINDOW_DAYS);
    const capped = Number(top) > 0 ? Math.min(Number(top), THREADS_TOP) : THREADS_TOP;
    this.counters.threadsBuilt += 1;
    this.counters.threads = clusters.length;
    return { threads: clusters.slice(0, capped), windowDays, scanned };
  }

  /** 线索详情：时间线（发布时间降序）。线索随库内容变化，找不到即明确报错。 */
  threadsDetail(keyword) {
    const key = String(keyword || '').trim();
    if (!key) throw new Error(i18n.localized('缺少线索关键词。'));
    const { clusters } = this._buildThreads(WINDOW_DAYS);
    const hit = clusters.find((c) => c.keyword.toLowerCase() === key.toLowerCase());
    if (!hit) throw new Error(i18n.localized('线索不存在或文章已变化，请刷新后重试。'));
    return { keyword: hit.keyword, count: hit.count, entries: hit.entries };
  }

  /**
   * 聚类核心：显著词 → 文章倒排 → df ≥ 3 成种子 → 簇内 3–20 篇 →
   * 与已收簇重叠 > 60% 丢弃 → 按（簇大小，词）确定性排序。
   */
  _buildThreads(windowDays) {
    const db = this.store.database;
    let rows;
    if (this._threadRowsImpl) {
      rows = this._threadRowsImpl();
    } else {
      rows = db.prepare(`
        SELECT i.id AS id, IFNULL(a.title, '') AS title, IFNULL(a.summary, '') AS summary,
               IFNULL(f.title, '') AS feedTitle,
               COALESCE(a.published_at, i.created_at) AS publishedAt
        FROM items i
        INNER JOIN feeds f ON f.id = i.feed_id
        INNER JOIN articles a ON a.item_id = i.id
        WHERE f.is_deleted = 0 AND COALESCE(a.published_at, i.created_at) >= ?
        ORDER BY COALESCE(a.published_at, i.created_at) DESC, i.id DESC
        LIMIT ${THREADS_SCAN_CAP}
      `).all(this.now() - windowDays * 86400);
    }
    // 倒排：显著词（小写键）→ 文章 id 集（保持发布序）
    const posting = new Map(); // key -> { keyword, ids: [] }
    const rowByID = new Map();
    for (const row of rows) {
      rowByID.set(row.id, row);
      const kws = extractKeywords(
        `${row.title}。${String(row.summary || '').replace(/<[^>]*>/g, ' ').slice(0, SUMMARY_KEY_SLICE)}`,
        3,
      );
      const seen = new Set();
      for (const kw of kws) {
        const key = kw.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (!posting.has(key)) posting.set(key, { keyword: kw, ids: [] });
        posting.get(key).ids.push(row.id);
      }
    }
    const seeds = [...posting.values()]
      .filter((p) => p.ids.length >= THREAD_DF_MIN && p.ids.length <= THREAD_MAX)
      .sort((a, b) => b.ids.length - a.ids.length || (a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0));

    const clusters = [];
    for (const seed of seeds) {
      if (clusters.length >= THREADS_TOP) break;
      const entries = seed.ids
        .map((id) => rowByID.get(id))
        .filter(Boolean)
        .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
        .slice(0, THREAD_MAX);
      if (entries.length < THREAD_MIN || entries.length > THREAD_MAX) continue;
      const idSet = new Set(entries.map((e) => e.id));
      // 同题簇去重：新簇条目与任一已收簇的重叠率过高则丢弃（同一批文章的别名词）
      const dup = clusters.some((acc) => {
        let inter = 0;
        for (const e of acc.entries) if (idSet.has(e.id)) inter += 1;
        return inter / entries.length > THREAD_DUP_OVERLAP;
      });
      if (dup) continue;
      clusters.push({
        keyword: seed.keyword,
        count: entries.length,
        entries: entries.map((e) => ({
          id: e.id, title: e.title, sourceTitle: e.feedTitle, publishedAt: e.publishedAt,
        })),
      });
    }
    return { clusters, scanned: rows.length };
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return {
      ...this.counters,
      windowDays: WINDOW_DAYS,
      candidateCap: CANDIDATE_CAP,
      similarLimit: SIMILAR_LIMIT_DEFAULT,
      minCardItems: MIN_CARD_ITEMS,
      threadsTop: THREADS_TOP,
      threadBounds: [THREAD_MIN, THREAD_MAX],
      threadDfMin: THREAD_DF_MIN,
      weights: { text: 1 - W_TAG - W_SOURCE, tag: W_TAG, source: W_SOURCE },
      cacheSize: this._cache.size,
    };
  }
}

module.exports = {
  SimilarService,
  bigrams,
  jaccard,
  similarityOf,
  tagOverlapScore,
  reasonOf,
  WINDOW_DAYS,
  CANDIDATE_CAP,
  SIMILAR_LIMIT_DEFAULT,
  MIN_CARD_ITEMS,
  THREADS_TOP,
  THREAD_MIN,
  THREAD_MAX,
  THREAD_DF_MIN,
};
