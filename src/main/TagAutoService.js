'use strict';
/**
 * TagAutoService（知更）— AI 自动标签（F15）
 *
 * 两条打标通路 + 一个复核视图的数据面：
 * 1. 规则继承打标（零 AI、确定性）：新文章入库时按订阅源既有标签
 *    （article_tags 同源文章的高频标签 Top 5）继承打标，source='inherit'。
 *    由 AppStore._applyParsedEntries 灌文钩子同步调用（纯 SQL，零网络零 LLM）。
 * 2. AI 批量打标（可选，默认关）：开启后每小时对最近入库且未打标的文章
 *    （≤20 篇/批）调 LLM 打 1-3 个标签；复用 ResearchService 的
 *    _requireAIReady + llm.complete 模式（非流式）；标签走既有规范化
 *    （小写、≤24 字）；source='ai'。无 Key 静默跳过，解析失败静默跳过。
 *
 * 设计约束：
 * - 图谱联动零改动：KnowledgeEngine.getGraphData 对 source 无过滤，inherit/ai
 *   行天然进入图谱；标签云/知识中心既有逻辑不因新 source 变化（只做展示过滤）。
 * - 节流可注入：now() 与 llmComplete() 均可替换（探针离线化：注入时间 + mock LLM）。
 * - 单飞锁：上一批未跑完时 kick 直接返回 running（定时器侧不堆积）。
 */

const BATCH_LIMIT = 20;        // 每批最多处理篇数
const RECENT_WINDOW_DAYS = 7;  // 「最近入库」窗口（天）
const TAG_MAX_LEN = 24;        // 标签规范化上限（字）
const TAGS_PER_ARTICLE = 3;    // 每篇最多 AI 标签数
const INHERIT_TOP_N = 5;       // 同源继承标签 Top N

/** 标签规范化：小写、去首尾空白、压内部空白、≤24 字；空串返回 null。 */
function normalizeTag(raw) {
  const tag = String(raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, TAG_MAX_LEN).trim();
  return tag || null;
}

/** 从 LLM 回包里解析标签数组：容忍 ```json 围栏 / 前后杂文；结构不对返回 null（调用方静默跳过）。 */
function parseTagsPayload(text) {
  if (!text) return null;
  let raw = String(text).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
  if (!Array.isArray(parsed)) return null;
  const tags = [];
  for (const item of parsed.slice(0, TAGS_PER_ARTICLE)) {
    const tag = normalizeTag(typeof item === 'string' ? item : (item && item.tag));
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

class TagAutoService {
  /**
   * @param store AppStore
   * @param opts intervalMs 定时器间隔（默认 1h；可注入）；now() 时钟（可注入）
   */
  constructor(store, { intervalMs = 60 * 60 * 1000, now = () => Date.now() / 1000 } = {}) {
    this.store = store;
    this.intervalMs = intervalMs;
    this._now = now;
    // LLM 完成通路可注入（探针 mock）；默认复用 store.llm.complete（非流式）
    this._llmComplete = null;
    this._running = false;
    this._timer = null;
    this.counters = {
      inheritedEntries: 0,   // 继承打标覆盖的文章数
      inheritedTags: 0,      // 继承打标写入的 (文章,标签) 对数
      aiRuns: 0,             // AI 批次实际跑过的次数（过闸口后）
      aiEntries: 0,          // AI 打标成功的文章数
      aiTags: 0,             // AI 写入的标签对数
      parseFailures: 0,      // LLM 回包解析失败（静默跳过）
      skippedNoKey: 0,       // 无 Key 静默跳过
      skippedDisabled: 0,    // 开关关闭跳过
      skippedThrottled: 0,   // 节流窗口内跳过
    };
  }

  // MARK: - 开关（偏好持久化）

  static PREF_ENABLED = 'RobinRead.tags.autoAI';
  static PREF_LAST_RUN = 'RobinRead.tags.autoLastRun';

  get enabled() {
    return this.store.preferences.get(TagAutoService.PREF_ENABLED, false) === true;
  }

  setEnabled(on) {
    this.store.preferences.set(TagAutoService.PREF_ENABLED, on === true);
    return this.enabled;
  }

  get lastRunAt() {
    return Number(this.store.preferences.get(TagAutoService.PREF_LAST_RUN, 0)) || 0;
  }

  // MARK: - 通路 1：规则继承打标（入库钩子）

  /** 同源既有标签 Top N（确定性：频次降序、同频按标签名字典序稳定）。 */
  topTagsForFeed(feedID, limit = INHERIT_TOP_N) {
    return this.store.database.prepare(`
      SELECT at.tag AS tag, COUNT(*) AS n
      FROM article_tags at
      INNER JOIN items i ON i.id = at.item_id
      WHERE i.feed_id = ?
      GROUP BY at.tag
      ORDER BY n DESC, at.tag ASC
      LIMIT ?
    `).all(String(feedID || ''), Math.max(1, Number(limit) || INHERIT_TOP_N))
      .map((r) => r.tag).filter(Boolean);
  }

  /**
   * 给一批新入库文章继承同源高频标签（source='inherit'）。
   * 单事务批量 INSERT OR IGNORE；同源无既有标签时零成本返回。
   * @returns 写入的 (文章,标签) 对数
   */
  inheritFor(feedID, entryIDs) {
    if (!entryIDs || !entryIDs.length) return 0;
    const tags = this.topTagsForFeed(feedID);
    if (!tags.length) return 0;
    const insert = this.store.database.prepare(
      "INSERT OR IGNORE INTO article_tags (item_id, tag, source) VALUES (?, ?, 'inherit')"
    );
    let written = 0;
    this.store.database.transaction(() => {
      for (const entryID of entryIDs) {
        let touched = false;
        for (const tag of tags) {
          const info = insert.run(entryID, tag);
          if (info.changes > 0) { written += 1; touched = true; }
        }
        if (touched) this.counters.inheritedEntries += 1;
      }
    });
    this.counters.inheritedTags += written;
    return written;
  }

  // MARK: - 通路 2：AI 批量打标（每小时节流）

  /** 最近入库且未打标（article_tags 无任何行）的候选，≤20 篇。 */
  untaggedCandidates(sinceSeconds) {
    return this.store.database.prepare(`
      SELECT i.id AS itemID, IFNULL(a.title, '') AS title, IFNULL(a.summary, '') AS summary
      FROM items i
      INNER JOIN article_states s ON s.item_id = i.id
      INNER JOIN articles a ON a.item_id = i.id
      LEFT JOIN article_tags at ON at.item_id = i.id
      WHERE at.item_id IS NULL AND s.date_arrived >= ?
      ORDER BY s.date_arrived DESC
      LIMIT ?
    `).all(sinceSeconds, BATCH_LIMIT);
  }

  /** 构建打标 prompt：标题 + 摘要前 300 字 → JSON 数组 1-3 个标签。 */
  static buildPrompt(title, summary) {
    return [
      `文章标题：${String(title || '').slice(0, 120)}`,
      `文章摘要：${String(summary || '').replace(/\s+/g, ' ').trim().slice(0, 300) || '（无摘要）'}`,
      '',
      '请为这篇文章输出 1-3 个主题标签。只输出一个 JSON 字符串数组，例如 ["人工智能","芯片"]；不要输出任何解释文字。',
    ].join('\n');
  }

  /**
   * 跑一批 AI 打标。闸口顺序：开关 → 无 Key → 节流（持久化 lastRun）→ 单飞。
   * 所有跳过与失败均为静默（返回 { skipped, reason } 或 { ran, ... }），不向调用方抛错。
   */
  async kick({ force = false } = {}) {
    if (!this.enabled) { this.counters.skippedDisabled += 1; return { skipped: true, reason: 'disabled' }; }
    let ai;
    try { ai = this.store._requireAIReady(); } catch (_) {
      this.counters.skippedNoKey += 1;
      return { skipped: true, reason: 'noKey' };
    }
    const now = this._now();
    if (!force && this.lastRunAt && now - this.lastRunAt < this.intervalMs / 1000) {
      this.counters.skippedThrottled += 1;
      return { skipped: true, reason: 'throttled' };
    }
    if (this._running) return { skipped: true, reason: 'running' };
    this._running = true;
    try {
      const candidates = this.untaggedCandidates(now - RECENT_WINDOW_DAYS * 86400);
      let taggedEntries = 0;
      let tagPairs = 0;
      for (const entry of candidates) {
        let tags = null;
        try {
          const text = await this.llmComplete(entry, ai);
          tags = parseTagsPayload(text);
        } catch (_) { tags = null; } // 网络/LLM 失败与解析失败同语义：静默跳过本篇
        if (!tags || !tags.length) { this.counters.parseFailures += 1; continue; }
        const insert = this.store.database.prepare(
          "INSERT OR IGNORE INTO article_tags (item_id, tag, source) VALUES (?, ?, 'ai')"
        );
        let written = 0;
        for (const tag of tags) written += insert.run(entry.itemID, tag).changes;
        if (written > 0) { taggedEntries += 1; tagPairs += written; }
      }
      this.counters.aiRuns += 1;
      this.counters.aiEntries += taggedEntries;
      this.counters.aiTags += tagPairs;
      this.store.preferences.set(TagAutoService.PREF_LAST_RUN, now);
      return { skipped: false, candidates: candidates.length, taggedEntries, tagPairs };
    } finally {
      this._running = false;
    }
  }

  /** LLM 调用（非流式）。可整路注入替换（探针 mock），默认走 store.llm.complete。 */
  async llmComplete(entry, { config, apiKey }) {
    if (this._llmComplete) return this._llmComplete(entry);
    return this.store.llm.complete({
      prompt: TagAutoService.buildPrompt(entry.title, entry.summary),
      system: '你是严谨的中文内容标签器，只输出 JSON 字符串数组，不输出其他内容。',
      configuration: config,
      apiKey,
      forceDisableReasoning: true,
      overrideTemperature: 0.2,
    });
  }

  // MARK: - 定时器

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => { this.kick().catch(() => { /* 定时批次静默 */ }); }, this.intervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  /** 诊断快照（探针 / 设置页回显用）。 */
  snapshot() {
    return {
      enabled: this.enabled,
      lastRunAt: this.lastRunAt,
      intervalMs: this.intervalMs,
      batchLimit: BATCH_LIMIT,
      recentWindowDays: RECENT_WINDOW_DAYS,
      tagMaxLen: TAG_MAX_LEN,
      inheritTopN: INHERIT_TOP_N,
      running: this._running,
      ...this.counters,
    };
  }

  dispose() { this.stop(); }
}

module.exports = { TagAutoService, normalizeTag, parseTagsPayload, BATCH_LIMIT, INHERIT_TOP_N, TAG_MAX_LEN };
