'use strict';
/**
 * ChallengeService（知更）— 挑战赛季（F40，有趣档 · 联动 F23 花园）
 *
 * 主题阅读挑战：给定主题（如「AI 前沿」）与天数/篇数目标，从订阅库组装一份
 * 挑战书单；期内（ends_at 前）读完 ≥ target 篇 → done + 花园限定装饰 + 可分享
 * 挑战卡；超时未达标 → failed（花园不扣分，温和设计）；可主动放弃重建。
 *
 * - 书单召回（照 CourseService 召回惯例）：关键词扩展（lib/keywords 同源 + CJK
 *   前缀滑窗）走 store.fullTextSearch + article_tags 双向包含标签通道，限最近
 *   180 天、封顶 40。LLM 在候选里挑 target 篇：**编造 ID 逐一对照候选剔除**、
 *   同文不重复、越界钳制；剔完不足 target 用未用候选确定性回填（候选耗尽允许
 *   短书单）。无 Key 降级：标签聚合选文（不出题单主题文案），模板挑战零 AI。
 * - 预设模板 3 个（固定参数 + 标签过滤，零 AI）：AI 前沿 7 天 10 篇 /
 *   长文深读 30 天 6 篇 / 新源尝鲜 7 天 5 源各 1 篇（spreadFeeds：5 源各挑 1 篇）。
 * - 单飞：进行中挑战全库至多一条（创建前查 active，另开需先放弃）。
 * - 进度：懒算——书单内 article_states.is_read=1 计数（读取侧投影，无定时器）；
 *   markRead 钩子（onRead）只在存在 active 挑战且命中书单时才算进度（轻量），
 *   达标即刻翻 done + 发奖；到期（ends_at 过）由读取侧懒结算翻 done/failed。
 * - 奖励：GardenService.grantDecor 发「限定装饰」（garden_state.challenge_decor
 *   v30 列，按 decor id 幂等）；reward_granted 防重发。
 * - 挑战卡：ChallengeCardArt 确定性 SVG（主题/天数/完成数/日期，令牌色）。
 *
 * 注入缝（探针）：_now 时钟可注入；_llmComplete 整路可换；书单召回走真库。
 */
const { nowSeconds, uuid } = require('./Models');
const { LLMServiceError } = require('./LLMService');
const { extractKeywords } = require('./lib/keywords');

/** 规则常量（模板/召回/钳制/单飞全部集中于此）。 */
const CHALLENGE = {
  THEME_MAX: 60,           // 自定义主题文本上限
  DAYS_MIN: 1,             // 天数下限
  DAYS_MAX: 60,            // 天数上限
  TARGET_MIN: 1,           // 目标篇数下限
  TARGET_MAX: 30,          // 目标篇数上限
  RECALL_WINDOW_DAYS: 180, // 候选回看窗口（照 CourseService）
  CANDIDATE_CAP: 40,       // 候选封顶（照 CourseService）
  KEYWORD_MAX: 4,          // 关键词扩展个数
  TAG_SLICE: 12,           // 标签匹配键截断
  TITLE_SLICE: 120,        // 书单标题截断
  SPREAD_FEEDS: 5,         // 「新源尝鲜」取源数
  /**
   * 预设挑战模板（固定参数 + 标签过滤，零 AI 可用）。
   * mode: 'tags'（标签聚合选文）| 'spreadFeeds'（N 源各挑 1 篇）。
   */
  TEMPLATES: [
    {
      id: 'ai-frontier', theme: 'AI 前沿速读', days: 7, target: 10, mode: 'tags',
      tags: ['AI', '人工智能', 'LLM', '大模型', '机器学习', 'ai'],
    },
    {
      id: 'longform', theme: '长文深读', days: 30, target: 6, mode: 'tags',
      tags: ['深度', '长文', '特稿', '深度报道', '随笔'],
    },
    {
      id: 'fresh-sources', theme: '新源尝鲜', days: 7, target: 5, mode: 'spreadFeeds',
      tags: [],
    },
  ],
};

function squash(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** 天数/篇数钳制到合法区间（整数）。 */
function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** 本地日期串（YYYY-MM-DD；注入时钟口径与 GardenService 一致）。 */
function dayOf(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 从 LLM 回包解析书单 entryID 数组（容错：```json 围栏 / 前后杂文 / 坏 JSON /
 * {"entries":[…]} 或裸数组两种合同 / 非字符串项剔除 / 去重保序）。一条都剩不下 → null。
 * @returns null | string[]
 */
function parseEntryIDs(text) {
  if (!text) return null;
  let raw = String(text).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  const start = raw.indexOf('{');
  const firstArr = raw.indexOf('[');
  let list = null;
  const tryParse = (slice) => { try { return JSON.parse(slice); } catch (_) { return null; } };
  if (firstArr !== -1 && (start === -1 || firstArr < start)) {
    const end = raw.lastIndexOf(']');
    if (end > firstArr) list = tryParse(raw.slice(firstArr, end + 1));
  }
  if (!list && start !== -1) {
    const end = raw.lastIndexOf('}');
    if (end > start) {
      const parsed = tryParse(raw.slice(start, end + 1));
      if (parsed && Array.isArray(parsed.entries)) list = parsed.entries;
      else if (parsed && Array.isArray(parsed.entryIDs)) list = parsed.entryIDs;
    }
  }
  if (!list && firstArr !== -1) {
    const end = raw.lastIndexOf(']');
    if (end > firstArr) list = tryParse(raw.slice(firstArr, end + 1));
  }
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    const id = String(item || '').trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out.length ? out : null;
}

class ChallengeService {
  constructor(store, { now = null } = {}) {
    this.store = store;
    this._now = now || (() => Date.now() / 1000); // 注入时钟（探针确定性）
    this._llmComplete = null;                     // 注入缝（探针 mock）
    this.counters = {
      created: 0, fromTemplate: 0, aiPicked: 0, tagFallback: 0,
      fabricatedDropped: 0, completed: 0, failed: 0, abandoned: 0,
      rewarded: 0, dedupCreate: 0, recallEmpty: 0, parseFailures: 0,
    };
    const required = ['challenges'];
    const missing = required.filter((t) => !this.store.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(t));
    if (missing.length) {
      throw new Error(`数据库 schema 缺少挑战表（${missing.join(', ')}）：DatabaseMigrations v30 未执行`);
    }
  }

  now() { return this._now(); }

  /** AI 可用性（渲染层自定义挑战表单提示文案用；模板/降级路径零 AI 照常可用）。 */
  available() {
    return { ai: this.store.hasAIAPIKey() };
  }

  /** 预设模板（渲染层新挑战表单数据面）。 */
  templates() {
    return CHALLENGE.TEMPLATES.map((tpl) => ({ ...tpl, tags: [...tpl.tags] }));
  }

  // MARK: 书单选文

  /** 关键词扩展（CourseService.expandKeywords 同口径）。 */
  expandKeywords(theme) {
    const words = [];
    const push = (w) => {
      const k = squash(w);
      if (k && k.length >= 2 && !words.includes(k)) words.push(k);
    };
    for (const w of extractKeywords(theme, CHALLENGE.KEYWORD_MAX)) push(w);
    const clean = squash(theme);
    if (/[\u4e00-\u9fff]/.test(clean)) {
      push(clean.slice(0, 6)); // 中文主题前缀滑窗兜底
      push(clean.slice(0, 4));
    } else {
      push(clean.slice(0, 24));
    }
    return words.slice(0, CHALLENGE.KEYWORD_MAX + 2);
  }

  /**
   * 候选召回（照 CourseService.recallCandidates 惯例）：FTS 关键词 + article_tags
   * 双向包含标签通道两路合并，180 天窗外与已删源全程过滤，封顶 40，去重保序。
   */
  recallCandidates(theme) {
    const cutoff = this.now() - CHALLENGE.RECALL_WINDOW_DAYS * 86400;
    const byID = new Map();
    const put = (row) => {
      if (byID.has(row.id)) return;
      if (row.publishedAt != null && row.publishedAt < cutoff) return;
      byID.set(row.id, row);
    };
    for (const kw of this.expandKeywords(theme)) {
      let hits = [];
      try { hits = this.store.fullTextSearch(kw, { limit: CHALLENGE.CANDIDATE_CAP }) || []; } catch (_) { hits = []; }
      for (const hit of hits) {
        put({
          id: hit.id, title: hit.title || '', sourceTitle: hit.sourceTitle || '',
          publishedAt: hit.publishedAt ?? null,
          summaryPreview: String(hit.summaryPreview || hit.summary || '').slice(0, 60),
        });
        if (byID.size >= CHALLENGE.CANDIDATE_CAP) return [...byID.values()];
      }
    }
    const entryCard = this.store.database.prepare(`
      SELECT i.id AS id, COALESCE(a.title, '') AS title, COALESCE(f.title, '') AS sourceTitle,
             a.published_at AS publishedAt, COALESCE(a.summary, '') AS summaryPreview
      FROM items i
      INNER JOIN articles a ON a.item_id = i.id
      INNER JOIN feeds f ON f.id = i.feed_id
      WHERE i.id = ? AND f.is_deleted = 0
    `);
    for (const kw of this.expandKeywords(theme)) {
      const key = squash(kw).slice(0, CHALLENGE.TAG_SLICE);
      if (!key) continue;
      let tagIDs = [];
      try {
        tagIDs = this.store.database.prepare(`
          SELECT DISTINCT at.item_id AS item_id FROM article_tags at
          WHERE instr(?, at.tag) > 0 OR at.tag LIKE ? ESCAPE '\\'
          LIMIT ?
        `).all(squash(theme).slice(0, CHALLENGE.THEME_MAX), `%${key.replace(/[%_\\]/g, (c) => '\\' + c)}%`, CHALLENGE.CANDIDATE_CAP)
          .map((r) => r.item_id);
      } catch (_) { tagIDs = []; }
      for (const id of tagIDs) {
        const row = entryCard.get(id);
        if (row) put(row);
        if (byID.size >= CHALLENGE.CANDIDATE_CAP) return [...byID.values()];
      }
    }
    return [...byID.values()];
  }

  /**
   * 标签聚合选文（零 AI 降级 / 模板 tags 模式）：article_tags 命中任一标签 →
   * 最近优先，未读优先（已读文章不占挑战名额——选书单时刻的公平口径）。
   * 标签命中不足 target → 最近文章窗回填（书单始终满额，挑战才成立）。
   */
  selectByTags(tags, target) {
    const cutoff = this.now() - CHALLENGE.RECALL_WINDOW_DAYS * 86400;
    const seen = new Set();
    const picked = [];
    const put = (row) => {
      if (seen.has(row.id)) return;
      seen.add(row.id);
      picked.push(row);
    };
    const queryByTag = (tagKey) => this.store.database.prepare(`
      SELECT i.id AS id, COALESCE(a.title, '') AS title, COALESCE(f.title, '') AS sourceTitle,
             a.published_at AS publishedAt, COALESCE(s.is_read, 0) AS isRead
      FROM article_tags atg
      INNER JOIN items i ON i.id = atg.item_id
      INNER JOIN articles a ON a.item_id = i.id
      INNER JOIN feeds f ON f.id = i.feed_id
      LEFT JOIN article_states s ON s.item_id = i.id
      WHERE (atg.tag = ? OR instr(?, atg.tag) > 0) AND f.is_deleted = 0
        AND COALESCE(a.published_at, i.created_at) >= ?
      ORDER BY COALESCE(a.published_at, i.created_at) DESC
      LIMIT ?
    `).all(String(tagKey), `%${String(tagKey).slice(0, CHALLENGE.TAG_SLICE)}%`, cutoff, CHALLENGE.CANDIDATE_CAP);
    for (const tag of (tags || [])) {
      const key = squash(tag).slice(0, CHALLENGE.TAG_SLICE);
      if (!key) continue;
      for (const row of queryByTag(key)) {
        put(row);
        if (picked.length >= CHALLENGE.CANDIDATE_CAP) break;
      }
      if (picked.length >= CHALLENGE.CANDIDATE_CAP) break;
    }
    return this._finalizeBookList(picked, target);
  }

  /**
   * 新源尝鲜选文：非删除源里各挑 1 篇最近文章（未读优先），凑满 min(源数, target) 篇。
   */
  selectSpreadFeeds(feedCount, target) {
    const n = Math.max(1, Math.min(Number(feedCount) || CHALLENGE.SPREAD_FEEDS, target));
    const feeds = this.store.database.prepare(`
      SELECT f.id AS feedID FROM feeds f WHERE f.is_deleted = 0
    `).all();
    // 有最近文章的源优先（发文新者先）
    const active = [];
    for (const f of feeds) {
      const row = this.store.database.prepare(`
        SELECT i.id AS id, COALESCE(a.title, '') AS title, COALESCE(f.title, '') AS sourceTitle,
               a.published_at AS publishedAt, COALESCE(s.is_read, 0) AS isRead
        FROM items i
        INNER JOIN articles a ON a.item_id = i.id
        INNER JOIN feeds f ON f.id = i.feed_id
        LEFT JOIN article_states s ON s.item_id = i.id
        WHERE i.feed_id = ? AND f.is_deleted = 0
        ORDER BY COALESCE(s.is_read, 0) ASC, COALESCE(a.published_at, i.created_at) DESC
        LIMIT 1
      `).get(f.feedID);
      if (row) active.push(row);
    }
    active.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
    return this._finalizeBookList(active.slice(0, Math.min(n, target)), target);
  }

  /** 书单收口：未读优先排序（同篇数下挑战更公平），不足 target 由最近文章窗回填。 */
  _finalizeBookList(picked, target) {
    const sorted = [...picked].sort((a, b) => (Number(a.isRead) || 0) - (Number(b.isRead) || 0)
      || (b.publishedAt || 0) - (a.publishedAt || 0));
    let list = sorted.slice(0, target);
    if (list.length < target) {
      const seen = new Set(list.map((r) => r.id));
      const recent = this.store.database.prepare(`
        SELECT i.id AS id, COALESCE(a.title, '') AS title, COALESCE(f.title, '') AS sourceTitle,
               a.published_at AS publishedAt, COALESCE(s.is_read, 0) AS isRead
        FROM items i
        INNER JOIN articles a ON a.item_id = i.id
        INNER JOIN feeds f ON f.id = i.feed_id
        LEFT JOIN article_states s ON s.item_id = i.id
        WHERE f.is_deleted = 0
        ORDER BY COALESCE(a.published_at, i.created_at) DESC
        LIMIT ?
      `).all(CHALLENGE.CANDIDATE_CAP);
      for (const row of recent) {
        if (list.length >= target) break;
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        list.push(row);
      }
    }
    list = list.map((r) => ({ id: r.id, title: String(r.title || '').slice(0, CHALLENGE.TITLE_SLICE), sourceTitle: r.sourceTitle || '', publishedAt: r.publishedAt ?? null, isRead: Number(r.isRead) === 1 }));
    return list;
  }

  // MARK: LLM 书单（可整路注入 mock）

  async llmComplete({ theme, days, target, candidates }, { config, apiKey }, signal = null) {
    if (this._llmComplete) return this._llmComplete({ theme, days, target, candidates }, { config, apiKey }, signal);
    const lines = candidates.map((c, i) => (
      `${i + 1}. id=${c.id} 《${String(c.title || '').slice(0, CHALLENGE.TITLE_SLICE)}》 来源：${c.sourceTitle || ''}`
    )).join('\n');
    const prompt = [
      `挑战主题：「${theme}」（${days} 天内读完 ${target} 篇）。`,
      '以下是订阅库里可用的候选文章（id 必须原样引用，不许编造）：',
      lines,
      '',
      `请从候选里挑出最适合该主题的 ${target} 篇（entryIDs），由浅入深排列；同一篇不重复。`,
      `只输出 JSON：{"entries":["…"]}，恰好 ${target} 个 id，不要输出任何其他文字。`,
    ].join('\n');
    return this.store.llm.complete({
      prompt,
      system: '你是严谨的阅读挑战策划人，只使用候选清单里真实存在的文章（id 原样引用），不编造、不重复，只输出 JSON，不输出其他内容。',
      configuration: config,
      apiKey,
      signal,
      forceDisableReasoning: true,
      overrideTemperature: 0.3,
    });
  }

  /** 书单合同校验：编造剔除 / 同文去重 / 越界钳制 / 未用候选确定性回填。 */
  validateBookList(ids, target, candidates) {
    const candMap = new Map(candidates.map((c) => [c.id, c]));
    const out = [];
    const seen = new Set();
    for (const id of (ids || [])) {
      if (out.length >= target) break;
      const key = String(id || '');
      if (!key || seen.has(key)) continue;
      if (!candMap.has(key)) { this.counters.fabricatedDropped += 1; continue; }
      seen.add(key);
      out.push(candMap.get(key));
    }
    if (out.length < target) {
      for (const c of candidates) {
        if (out.length >= target) break;
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
      }
    }
    return this._finalizeBookList(out.map((r) => ({ ...r, isRead: this._isRead(r.id) ? 1 : 0 })), target);
  }

  _isRead(entryID) {
    const row = this.store.database.prepare('SELECT is_read FROM article_states WHERE item_id = ?').get(entryID);
    return Number(row?.is_read ?? 0) === 1;
  }

  // MARK: 创建

  /**
   * 创建挑战。templateID → 模板固定参数（零 AI）；自定义 → AI 书单（无 Key 标签聚合降级）。
   * 单飞：已有 active 挑战时拒绝（另开需先放弃）。
   */
  async createChallenge({ theme = '', days = 7, target = 10, templateID = '' } = {}) {
    const tpl = templateID ? CHALLENGE.TEMPLATES.find((t) => t.id === String(templateID)) : null;
    const cleanTheme = squash(tpl ? tpl.theme : theme).slice(0, CHALLENGE.THEME_MAX);
    if (!cleanTheme) throw new Error('先给挑战起个主题吧。');
    const daysN = clampInt(tpl ? tpl.days : days, CHALLENGE.DAYS_MIN, CHALLENGE.DAYS_MAX, 7);
    const targetN = clampInt(tpl ? tpl.target : target, CHALLENGE.TARGET_MIN, CHALLENGE.TARGET_MAX, 10);
    if (this.active()) {
      this.counters.dedupCreate += 1;
      throw new Error('已有一个进行中的挑战——先完成或放弃它，再开新赛季。');
    }

    let entries = [];
    if (tpl) {
      // 模板：固定参数 + 标签过滤，零 AI
      if (tpl.mode === 'spreadFeeds') entries = this.selectSpreadFeeds(CHALLENGE.SPREAD_FEEDS, targetN);
      else entries = this.selectByTags(tpl.tags, targetN);
      if (entries.length) this.counters.fromTemplate += 1;
    } else if (this.store.hasAIAPIKey()) {
      // 自定义 + AI：召回 → LLM 挑书（合同容错）
      const ai = this.store._requireAIReady();
      const candidates = this.recallCandidates(cleanTheme);
      if (!candidates.length) {
        this.counters.recallEmpty += 1;
        throw new Error('订阅库最近 180 天里没有与主题相关的文章，先订阅或读一些相关内容再来。');
      }
      const raw = await this.llmComplete({ theme: cleanTheme, days: daysN, target: targetN, candidates }, ai, null);
      const ids = parseEntryIDs(raw);
      if (!ids) {
        this.counters.parseFailures += 1;
        throw new LLMServiceError('invalidResponse'); // 坏输出零残留，可重试
      }
      entries = this.validateBookList(ids, targetN, candidates);
      this.counters.aiPicked += 1;
    } else {
      // 自定义无 Key：标签聚合选文降级（不出题单主题文案）
      const candidates = this.recallCandidates(cleanTheme);
      if (!candidates.length) {
        this.counters.recallEmpty += 1;
        throw new Error('订阅库里没有与主题相关的文章，先订阅或读一些相关内容再来。');
      }
      entries = this.validateBookList(candidates.slice(0, targetN).map((c) => c.id), targetN, candidates);
      this.counters.tagFallback += 1;
    }
    if (!entries.length) {
      this.counters.recallEmpty += 1;
      throw new Error('订阅库还是空的——先添加订阅、灌几篇文章，再开挑战。');
    }

    const id = uuid();
    const now = this.now();
    // 单飞 TOCTOU 闸（批 I 审查 P2：active 检查与 INSERT 之间隔着 await llmComplete，
    // 两个并发 createChallenge 都能过闸 → v30 无部分唯一索引，进程内创建锁兜底）
    if (this._creating) throw new Error('已有一个进行中的挑战——先完成或放弃它，再开新赛季。');
    this._creating = true;
    try {
      this.store.database.prepare(`
        INSERT INTO challenges (id, theme, days, target, entry_ids_json, started_at, ends_at, status, reward_granted, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?)
      `).run(id, cleanTheme, daysN, targetN, JSON.stringify(entries.map((e) => e.id)), now, now + daysN * 86400, nowSeconds());
    } finally {
      this._creating = false;
    }
    this.counters.created += 1;
    try { this.store.emit('challenge:changed', {}); } catch (_) { /* 无订阅者不阻塞 */ }
    return this.get(id);
  }

  // MARK: 单飞 / 进度 / 懒结算

  /** 进行中挑战（单飞语义：active 唯一；读取侧懒结算先行）。 */
  active() {
    this.settle();
    return this._shape(this.store.database.prepare(
      "SELECT * FROM challenges WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
    ).get());
  }

  /** 书单内已读计数（懒算进度：is_read=1 的书单条目数）。 */
  _readCount(entryIDs) {
    let n = 0;
    const q = this.store.database.prepare(
      'SELECT COALESCE(is_read, 0) AS r FROM article_states WHERE item_id = ?'
    );
    for (const id of entryIDs) n += Number(q.get(id)?.r ?? 0) === 1 ? 1 : 0;
    return n;
  }

  progress(challengeID) {
    const row = this.store.database.prepare('SELECT * FROM challenges WHERE id = ?').get(String(challengeID || ''));
    if (!row) return null;
    const entryIDs = this._entryIDs(row);
    const done = this._readCount(entryIDs);
    const now = this.now();
    return {
      done,
      target: row.target,
      pct: row.target ? Math.min(100, Math.round((done / row.target) * 100)) : 0,
      daysLeft: Math.max(0, Math.ceil((row.ends_at - now) / 86400)),
      ended: now >= row.ends_at,
      entryIDs,
    };
  }

  /**
   * 到期懒结算（读取时跑，无定时器）：ends_at 过 → 达标翻 done + 发奖；
   * 未达标翻 failed（花园不扣分）。@returns 结算行数。
   */
  settle() {
    const now = this.now();
    const rows = this.store.database.prepare(
      "SELECT * FROM challenges WHERE status = 'active' AND ends_at <= ?"
    ).all(now);
    for (const row of rows) {
      const done = this._readCount(this._entryIDs(row));
      this._finish(row.id, done >= row.target ? 'done' : 'failed', row.theme, done >= row.target);
    }
    return rows.length;
  }

  /** markRead 钩子：命中 active 书单才算进度（轻量），达标即刻提前毕业 + 发奖。 */
  onRead({ entryID } = {}) {
    const id = String(entryID || '').trim();
    if (!id) return { settled: false };
    const row = this.store.database.prepare(
      "SELECT * FROM challenges WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
    ).get();
    if (!row) return { settled: false };
    // 过期先结算（批 I 审查 P2：ends_at 已过但懒结算未跑时，补读书单末篇不得曲解为「提前完成」
    // 翻 done 发奖——达标与否以期末快照计，过期即走 failed）
    if (this._now() >= row.ends_at) {
      this.settle();
      return { settled: false, expired: true };
    }
    const entryIDs = this._entryIDs(row);
    if (!entryIDs.includes(id)) return { settled: false };
    const done = this._readCount(entryIDs);
    if (done >= row.target) {
      this._finish(row.id, 'done', row.theme, true);
      return { settled: true, status: 'done' };
    }
    return { settled: false, done };
  }

  /** 收口：翻状态 + 发奖（reward_granted 防重发；花园装饰幂等）。 */
  _finish(id, status, theme, grant) {
    const rewardGranted = (status === 'done' && grant) ? 1 : 0;
    this.store.database.prepare('UPDATE challenges SET status = ?, reward_granted = MAX(reward_granted, ?) WHERE id = ?')
      .run(status, rewardGranted, id);
    if (rewardGranted) {
      try {
        this.store.garden.grantDecor({ id: `challenge:${id}`, kind: 'challenge', label: String(theme || '').slice(0, 60) });
        this.counters.rewarded += 1;
      } catch (_) { /* 花园钩子不阻塞挑战 */ }
    }
    if (status === 'done') this.counters.completed += 1;
    else if (status === 'failed') this.counters.failed += 1;
    try { this.store.emit('challenge:changed', { id, status }); } catch (_) { /* 无订阅者不阻塞 */ }
  }

  // MARK: 读取 / 放弃 / 挑战卡

  _entryIDs(row) {
    try {
      const list = JSON.parse(row.entry_ids_json || '[]');
      return Array.isArray(list) ? list.map(String) : [];
    } catch (_) { return []; }
  }

  _shape(row) {
    if (!row) return null;
    const entryIDs = this._entryIDs(row);
    const done = this._readCount(entryIDs);
    const now = this.now();
    return {
      id: row.id,
      theme: row.theme,
      days: row.days,
      target: row.target,
      status: row.status,
      startedAt: row.started_at,
      endsAt: row.ends_at,
      rewardGranted: Number(row.reward_granted) === 1,
      createdAt: row.created_at,
      done,
      pct: row.target ? Math.min(100, Math.round((done / row.target) * 100)) : 0,
      daysLeft: Math.max(0, Math.ceil((row.ends_at - now) / 86400)),
      daysTotal: Math.max(1, Math.ceil((row.ends_at - row.started_at) / 86400)),
      startDate: dayOf(row.started_at),
      endDate: dayOf(row.ends_at),
      entries: this._entriesWithReadState(entryIDs),
    };
  }

  /** 书单条目（标题/来源/已读态——「读完自动勾选」数据面；条目消失诚实降级）。 */
  _entriesWithReadState(entryIDs) {
    const out = [];
    for (const id of entryIDs) {
      const row = this.store.database.prepare(`
        SELECT i.id AS id, a.title AS title, COALESCE(f.title, '') AS feed_title,
               COALESCE(s.is_read, 0) AS is_read
        FROM items i
        LEFT JOIN articles a ON a.item_id = i.id
        LEFT JOIN feeds f ON f.id = i.feed_id
        LEFT JOIN article_states s ON s.item_id = i.id
        WHERE i.id = ?
      `).get(id);
      if (!row) { out.push({ entryID: id, title: '(文章已不在库里)', sourceTitle: '', isRead: true }); continue; }
      out.push({
        entryID: id,
        title: String(row.title || '').slice(0, CHALLENGE.TITLE_SLICE),
        sourceTitle: String(row.feed_title || ''),
        isRead: Number(row.is_read ?? 0) === 1,
      });
    }
    return out;
  }

  get(challengeID) {
    this.settle();
    return this._shape(this.store.database.prepare('SELECT * FROM challenges WHERE id = ?').get(String(challengeID || '')));
  }

  /** 挑战列表（active 在前，组内新→旧；历史含 failed 诚实展示）。 */
  list() {
    this.settle();
    return this.store.database.prepare(
      "SELECT * FROM challenges ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END ASC, created_at DESC"
    ).all().map((row) => this._shape(row));
  }

  /** 放弃（仅 active 可弃；历史保留）。 */
  abandon(challengeID) {
    const row = this.store.database.prepare('SELECT * FROM challenges WHERE id = ?').get(String(challengeID || ''));
    if (!row) throw new Error('挑战不存在。');
    if (row.status !== 'active') throw new Error('只有进行中的挑战可以放弃。');
    this.store.database.prepare("UPDATE challenges SET status = 'abandoned' WHERE id = ?").run(row.id);
    this.counters.abandoned += 1;
    try { this.store.emit('challenge:changed', { id: row.id, status: 'abandoned' }); } catch (_) { /* 无订阅者不阻塞 */ }
    return this.get(challengeID);
  }

  /** 挑战卡 SVG（确定性；tokens 缺省走渲染层默认令牌色）。 */
  card(challengeID, { accent = '#617357', paper = '#eae8e1', ink = '#3f3a30' } = {}) {
    const c = this.get(challengeID);
    if (!c) throw new Error('挑战不存在。');
    const { challengeCardArt } = require('./ChallengeCardArt');
    return challengeCardArt({
      theme: c.theme,
      days: c.days,
      done: c.done,
      target: c.target,
      status: c.status,
      dateText: `${c.startDate} → ${c.endDate}`,
      accent, paper, ink,
    });
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return {
      ...this.counters,
      ...CHALLENGE,
      templates: CHALLENGE.TEMPLATES.length,
      total: this.store.database.prepare('SELECT COUNT(*) AS n FROM challenges').get().n,
    };
  }
}

module.exports = {
  ChallengeService,
  CHALLENGE,
  clampInt,
  parseEntryIDs,
  dayOf,
};
