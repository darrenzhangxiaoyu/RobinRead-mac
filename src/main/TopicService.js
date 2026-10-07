'use strict';
/**
 * TopicService（知更）— 话题盯梢（F4）
 *
 * 任意关键词一键「盯梢」→ 持续聚合三路内容为专属信息流：
 * - local：本库订阅源新文章标题/摘要命中（纯本地 SQL，零网络）；
 * - aihot：AIHOT 精选流按关键词过滤（走 AihotService.items，网络）；
 * - pool：验证 feed 池（feed-pool.json）按关键词命中源 → 抓取其最新文章（网络）。
 *
 * 设计约束：
 * - 聚合全程异步（refresh 收尾后 kick，不阻塞刷新主路径）；单话题 45s 硬预算；
 * - AI 精筛（可选档）：≤40 条候选一次批量请求，无 Key/失败自动降级为不过滤；
 * - topic_hits 按 UNIQUE(topic_id,url_norm) 去重，每话题滚动保留 200 条；
 * - 频率：refresh=每次刷新后聚合；daily=距 last_run ≥24h 才聚合；
 * - 网络 lane 可注入替换（探针离线化：_laneAihotImpl/_lanePoolImpl）。
 */
const { i18n } = require('./I18N');
const { fetchFeed } = require('./FeedService');
const POOL = require('./data/feed-pool.json');

const { randomUUID } = require('node:crypto');

const MAX_TOPICS = 30;
const MAX_KEYWORDS = 3;
const KEYWORD_MAX_LEN = 60;
const HITS_PER_TOPIC = 200;      // 每话题保留上限
const CANDIDATE_CAP = 40;        // AI 精筛候选上限
const LANE_LOCAL_CAP = 60;       // 单路单次聚合候选上限
const LANE_AIHOT_LIMIT = 30;
const POOL_FEEDS_PER_RUN = 2;    // 每话题每次聚合至多抓 2 个池源（控网络量）
const TOPIC_BUDGET_MS = 45000;   // 单话题聚合硬预算
const DAILY_INTERVAL_MS = 24 * 3600 * 1000;

/** URL 规范化：&amp; 实体还原 + 去尾斜杠 + 去 hash（同库判重口径）。 */
function normalizeTopicURL(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  u = u.replace(/&amp;/gi, '&');
  u = u.replace(/#.*$/, '');
  if (u.length > 1 && u.endsWith('/')) u = u.slice(0, -1);
  return u;
}

/** 关键词命中（不分大小写，多关键词任一命中即 true）。 */
function matchesKeywords(keywords, ...texts) {
  const haystack = texts.filter(Boolean).join('\n').toLowerCase();
  if (!haystack) return false;
  return keywords.some((kw) => haystack.includes(String(kw).toLowerCase()));
}

/** 话题行 → API 形态（JSON 列解包，坏数据惰性化）。 */
function topicFromRow(row) {
  let keywords = [];
  let lanes = {};
  try { keywords = JSON.parse(row.keywords_json || '[]'); } catch (_) { /* 惰性 */ }
  try { lanes = JSON.parse(row.lanes_json || '{}'); } catch (_) { /* 惰性 */ }
  if (!Array.isArray(keywords)) keywords = [];
  return {
    id: row.id,
    name: row.name,
    keywords: keywords.map(String).slice(0, MAX_KEYWORDS),
    lanes: {
      local: lanes.local !== false,
      aihot: lanes.aihot === true,
      pool: lanes.pool === true,
    },
    frequency: row.frequency === 'daily' ? 'daily' : 'refresh',
    aiFilter: Number(row.ai_filter) === 1,
    enabled: Number(row.enabled) === 1,
    lastRun: row.last_run,
    hitCount: Number(row.hit_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class TopicService {
  constructor(store) {
    this.store = store;
    this.counters = { runs: 0, errors: 0, inserted: 0, filtered: 0 };
    // 网络 lane 可注入（探针离线化）：默认走真实通路
    this._laneAihotImpl = async (keywords) => {
      const items = await this.store.aihot.items({ q: keywords[0], window: '7d', limit: LANE_AIHOT_LIMIT });
      return (Array.isArray(items) ? items : []).map((it) => ({
        title: it.title || '',
        url: it.originalURL || it.url || '',
        summary: it.summary || '',
        sourceName: it.source || 'AIHOT',
        publishedAt: it.publishedAt ? new Date(it.publishedAt).getTime() / 1000 : null,
      })).filter((h) => h.url);
    };
    this._lanePoolImpl = async (keywords) => this._poolLane(keywords);
  }

  // MARK: - CRUD

  listTopics() {
    return this.store.database.prepare('SELECT * FROM topics ORDER BY created_at DESC').all().map(topicFromRow);
  }

  topic(id) {
    const row = this.store.database.prepare('SELECT * FROM topics WHERE id = ?').get(id);
    return row ? topicFromRow(row) : null;
  }

  _validate({ name, keywords, lanes, frequency, aiFilter }) {
    const kws = (Array.isArray(keywords) ? keywords : [])
      .map((k) => String(k || '').trim())
      .filter(Boolean);
    const seen = new Set();
    const deduped = kws.filter((k) => (seen.has(k.toLowerCase()) ? false : (seen.add(k.toLowerCase()), true)));
    if (deduped.length < 1 || deduped.length > MAX_KEYWORDS) {
      throw new Error(i18n.localized('关键词需要 1-3 个。'));
    }
    for (const k of deduped) {
      if (k.length > KEYWORD_MAX_LEN) throw new Error(i18n.localized('单个关键词不能超过 %lld 字。').replace('%lld', String(KEYWORD_MAX_LEN)));
    }
    if (lanes && !lanes.local && !lanes.aihot && !lanes.pool) {
      throw new Error(i18n.localized('至少启用一个聚合来源。'));
    }
    if (frequency && frequency !== 'refresh' && frequency !== 'daily') {
      throw new Error(i18n.localized('聚合频率不合法。'));
    }
    const finalName = String(name || '').trim() || deduped.join(' / ');
    if (finalName.length > 100) throw new Error(i18n.localized('话题名不能超过 100 字。'));
    return { name: finalName, keywords: deduped };
  }

  _assertQuotas(excludeID = null) {
    const count = this.store.database.prepare('SELECT COUNT(*) AS n FROM topics').get().n;
    if (count >= MAX_TOPICS) {
      throw new Error(i18n.localized('最多创建 %lld 个话题。').replace('%lld', String(MAX_TOPICS)));
    }
    void excludeID;
  }

  saveTopic(payload = {}) {
    const { name, keywords } = this._validate(payload);
    const lanes = {
      local: payload.lanes ? payload.lanes.local !== false : true,
      aihot: !!(payload.lanes && payload.lanes.aihot),
      pool: !!(payload.lanes && payload.lanes.pool),
    };
    const frequency = payload.frequency === 'daily' ? 'daily' : 'refresh';
    const aiFilter = payload.aiFilter === true;
    const now = Date.now() / 1000;
    if (payload.id) {
      const existing = this.topic(payload.id);
      if (!existing) throw new Error(i18n.localized('话题不存在或已被删除。'));
      this.store.database.prepare(`
        UPDATE topics SET name=?, keywords_json=?, lanes_json=?, frequency=?, ai_filter=?, updated_at=? WHERE id=?
      `).run(name, JSON.stringify(keywords), JSON.stringify(lanes), frequency, aiFilter ? 1 : 0, now, payload.id);
      return this.topic(payload.id);
    }
    this._assertQuotas();
    const id = randomUUID();
    this.store.database.prepare(`
      INSERT INTO topics (id, name, keywords_json, lanes_json, frequency, ai_filter, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, name, JSON.stringify(keywords), JSON.stringify(lanes), frequency, aiFilter ? 1 : 0, now, now);
    return this.topic(id);
  }

  deleteTopic(id) {
    const info = this.store.database.prepare('DELETE FROM topics WHERE id = ?').run(id);
    return info.changes > 0;
  }

  setTopicEnabled(id, enabled) {
    this.store.database.prepare('UPDATE topics SET enabled=?, updated_at=? WHERE id=?')
      .run(enabled ? 1 : 0, Date.now() / 1000, id);
    return this.topic(id);
  }

  // MARK: - 聚合

  /** 单话题聚合（force=手动「立即聚合」）。返回摘要 { inserted, candidates, filtered, lanes }。 */
  async aggregateTopic(id, { force = false } = {}) {
    const topic = this.topic(id);
    if (!topic) throw new Error(i18n.localized('话题不存在或已被删除。'));
    if (!topic.enabled && !force) return { skipped: 'disabled', inserted: 0 };
    if (!force && !this._due(topic)) return { skipped: 'not-due', inserted: 0 };

    const startedAt = Date.now();
    this.counters.runs += 1;
    const candidates = [];
    const laneSummary = { local: 0, aihot: 0, pool: 0 };

    if (topic.lanes.local) {
      try {
        const rows = this._localLane(topic);
        laneSummary.local = rows.length;
        candidates.push(...rows);
      } catch (err) { this.counters.errors += 1; console.warn('[topics] local lane failed:', err?.message || err); }
    }
    // 网络 lanes 共享硬预算：local 之后剩余时间给了才跑
    const budget = () => TOPIC_BUDGET_MS - (Date.now() - startedAt);
    if (topic.lanes.aihot && budget() > 8000) {
      try {
        const rows = await this._withTimeout(this._laneAihotImpl(topic.keywords), Math.min(budget(), 20000));
        const filtered = rows.filter((h) => matchesKeywords(topic.keywords, h.title, h.summary));
        laneSummary.aihot = filtered.length;
        candidates.push(...filtered.map((h) => ({ ...h, lane: 'aihot' })));
      } catch (err) { this.counters.errors += 1; console.warn('[topics] aihot lane failed:', err?.message || err); }
    }
    if (topic.lanes.pool && budget() > 8000) {
      try {
        const rows = await this._withTimeout(this._lanePoolImpl(topic.keywords), Math.min(budget(), 25000));
        laneSummary.pool = rows.length;
        candidates.push(...rows.map((h) => ({ ...h, lane: 'pool' })));
      } catch (err) { this.counters.errors += 1; console.warn('[topics] pool lane failed:', err?.message || err); }
    }

    // URL 归一去重（批内）+ 截断
    const seen = new Set();
    let unique = [];
    for (const c of candidates) {
      const norm = normalizeTopicURL(c.url);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      unique.push({ ...c, urlNorm: norm });
    }
    unique = unique.slice(0, CANDIDATE_CAP * 2);

    // AI 精筛（可选档，失败降级不过滤）
    let filtered = 0;
    if (topic.aiFilter && unique.length > 0) {
      try {
        const keep = await this._aiFilterBatch(topic, unique);
        filtered = unique.length - keep.length;
        unique = keep;
      } catch (err) { this.counters.errors += 1; console.warn('[topics] ai filter failed (degraded):', err?.message || err); }
    }

    const inserted = this._insertHits(topic, unique);
    this.counters.inserted += inserted;
    this.counters.filtered += filtered;
    this.store.database.prepare('UPDATE topics SET last_run=?, updated_at=? WHERE id=?')
      .run(Date.now() / 1000, Date.now() / 1000, id);
    return { inserted, filtered, candidates: unique.length, lanes: laneSummary, elapsedMs: Date.now() - startedAt };
  }

  /** 刷新收尾自动聚合（AppStore 在 FullTextService kick 之后调用）。逐话题独立 try/catch。 */
  async aggregateDue() {
    const due = this.listTopics().filter((t) => t.enabled && this._due(t));
    for (const topic of due) {
      try { await this.aggregateTopic(topic.id); } catch (_) { /* 单话题失败不影响其他 */ }
    }
    return due.length;
  }

  _due(topic) {
    if (!topic.lastRun) return true;
    if (topic.frequency === 'refresh') return true;
    return Date.now() - topic.lastRun * 1000 >= DAILY_INTERVAL_MS;
  }

  _withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('lane timeout')), ms)),
    ]);
  }

  /** 本库路：订阅源文章标题/摘要关键词命中（近 14 天，最新优先）。 */
  _localLane(topic) {
    const since = Date.now() / 1000 - 14 * 86400;
    const likes = topic.keywords.map(() => '1').join(',');
    void likes;
    const conditions = topic.keywords.map(() => `(IFNULL(a.title,'') LIKE ? ESCAPE '\\' OR IFNULL(a.summary,'') LIKE ? ESCAPE '\\')`).join(' OR ');
    const params = [];
    for (const kw of topic.keywords) {
      const like = `%${kw.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
      params.push(like, like);
    }
    params.push(since);
    const rows = this.store.database.prepare(`
      SELECT i.id AS entry_id, a.title AS title, a.url AS url,
             IFNULL(a.summary,'') AS summary,
             f.title AS source_name,
             COALESCE(a.published_at, i.created_at) AS published_at
      FROM items i
      INNER JOIN feeds f ON f.id = i.feed_id
      LEFT JOIN articles a ON a.item_id = i.id
      WHERE f.is_deleted = 0 AND (${conditions})
        AND COALESCE(a.published_at, i.created_at) >= ?
      ORDER BY COALESCE(a.published_at, i.created_at) DESC, i.created_at DESC, i.rowid DESC
      LIMIT ${LANE_LOCAL_CAP}
    `).all(...params);
    return rows.map((r) => ({
      lane: 'local', entryID: r.entry_id, title: r.title || '', url: r.url || '',
      summary: r.summary || '', sourceName: r.source_name || '', publishedAt: r.published_at,
    }));
  }

  /** 源池路：feed-pool 按关键词命中源（名称/描述/标签计分）→ 抓取最新文章。 */
  async _poolLane(keywords) {
    const kws = keywords.map((k) => k.toLowerCase());
    const scored = [];
    for (const s of POOL.sources || []) {
      const hay = [s.name, s.desc, ...(s.tags || [])].join(' ').toLowerCase();
      const score = kws.reduce((acc, k) => acc + (hay.includes(k) ? 1 : 0), 0);
      if (score > 0) scored.push({ s, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const picks = scored.slice(0, POOL_FEEDS_PER_RUN);
    const hits = [];
    for (const { s } of picks) {
      try {
        const result = await fetchFeed({ feedURL: s.feedURL }, { force: true });
        const entries = (result && result.parsed && Array.isArray(result.parsed.entries)) ? result.parsed.entries : [];
        for (const e of entries) {
          const title = e.title || '';
          const summary = typeof e.summary === 'string' ? e.summary : '';
          if (!matchesKeywords(keywords, title, summary)) continue;
          hits.push({
            title, url: e.link || '', summary,
            sourceName: s.name, publishedAt: e.publishedAt || null,
          });
        }
      } catch (_) { /* 单源失败跳过 */ }
      if (hits.length >= LANE_LOCAL_CAP) break;
    }
    return hits.slice(0, LANE_LOCAL_CAP).map((h) => ({ ...h, lane: 'pool' }));
  }

  /** AI 精筛：一次批量请求，LLM 返回 JSON 数组（判定相关才保留）。失败抛错由调用方降级。 */
  async _aiFilterBatch(topic, candidates) {
    const { config, apiKey } = this.store._requireAIReady();
    const lines = candidates.map((c, i) => `${i + 1}. ${c.title}${c.summary ? ' — ' + String(c.summary).replace(/\s+/g, ' ').slice(0, 120) : ''}`);
    const prompt = `话题关键词：${topic.keywords.join('、')}\n\n以下是 ${lines.length} 篇候选文章：\n${lines.join('\n')}\n\n请判断每篇是否与该话题真正相关（泛泛提及不算）。只输出 JSON 数组，形如 [1,3,4]，元素为相关文章的编号，不要输出任何其他文字。`;
    const content = await this.store.llm.complete({
      prompt,
      system: '你是信息流过滤助手。严格只输出 JSON 数字数组，不输出解释。',
      configuration: config,
      apiKey,
      forceDisableReasoning: true,
      overrideTemperature: 0,
    });
    const match = String(content).match(/\[[\d\s,]*\]/);
    if (!match) throw new Error('unparseable filter response');
    const keepIdx = new Set(JSON.parse(match[0]).map(Number).filter((n) => n >= 1 && n <= candidates.length));
    return candidates.filter((_, i) => keepIdx.has(i + 1));
  }

  /** 命中入库：INSERT OR IGNORE 去重 + 计数 + 每话题滚动保留 200 条。 */
  _insertHits(topic, hits) {
    if (!hits.length) return 0;
    const now = Date.now() / 1000;
    let inserted = 0;
    this.store.database.transaction(() => {
      const ins = this.store.database.prepare(`
        INSERT OR IGNORE INTO topic_hits
          (id, topic_id, lane, title, url, url_norm, summary, source_name, entry_id, published_at, hit_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const h of hits) {
        const info = ins.run(randomUUID(), topic.id, h.lane || 'local',
          String(h.title || '').slice(0, 500), String(h.url || ''), h.urlNorm,
          String(h.summary || '').slice(0, 600), String(h.sourceName || '').slice(0, 120),
          h.entryID || null, h.publishedAt || null, now);
        inserted += info.changes;
      }
      // 滚动保留（含历史累计）
      this.store.database.prepare(`
        DELETE FROM topic_hits WHERE topic_id = ? AND id NOT IN (
          SELECT id FROM topic_hits WHERE topic_id = ? ORDER BY hit_at DESC, id DESC LIMIT ${HITS_PER_TOPIC}
        )
      `).run(topic.id, topic.id);
      const total = this.store.database.prepare('SELECT COUNT(*) AS n FROM topic_hits WHERE topic_id = ?').get(topic.id).n;
      this.store.database.prepare('UPDATE topics SET hit_count=?, updated_at=? WHERE id=?').run(total, now, topic.id);
    });
    return inserted;
  }

  // MARK: - 读取

  /** 话题信息流（最新优先，分页）。 */
  hits(topicID, { limit = 100, offset = 0 } = {}) {
    const cappedLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
    const cappedOffset = Math.max(0, Number(offset) || 0);
    return this.store.database.prepare(`
      SELECT * FROM topic_hits WHERE topic_id = ?
      ORDER BY hit_at DESC, published_at DESC LIMIT ? OFFSET ?
    `).all(topicID, cappedLimit, cappedOffset).map((r) => ({
      id: r.id,
      lane: r.lane,
      title: r.title,
      url: r.url,
      summary: r.summary || '',
      sourceName: r.source_name || '',
      entryID: r.entry_id || null,
      publishedAt: r.published_at,
      hitAt: r.hit_at,
    }));
  }

  /** 侧栏入口计数：启用话题数。 */
  enabledCount() {
    return this.store.database.prepare('SELECT COUNT(*) AS n FROM topics WHERE enabled = 1').get().n;
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return { ...this.counters, maxTopics: MAX_TOPICS, hitsPerTopic: HITS_PER_TOPIC };
  }
}

module.exports = { TopicService, normalizeTopicURL, matchesKeywords };
