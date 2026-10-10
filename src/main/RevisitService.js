'use strict';
/**
 * RevisitService（知更）— 深读重访（F37，有趣+学习科学档）
 *
 * 读过的长文按遗忘曲线温和重现：正文 ≥1500 字的长文首次读完时登记重访计划
 * （due = read_at + 30d），到期后以「回顾卡」浮出——侧栏重访徽章 + 浮层列表。
 * 每张卡可请求「AI 重读指引」：LLM 输入当时的正文与批注，输出 3 条指引
 * （当时的关键论点 / 今天的你该重点重看哪段 / 一句挑战性提问）。
 *
 * 分工边界：SM-2 复习卡（review_queue）管短记忆（段落/题面级），
 * 重访管全文语境（整篇长文）——两者共存，但同文不重复登记：
 * 已有 SM-2 复习卡的原文跳过登记（该文已在复习管线里被照顾）。
 *
 * - 登记：AppStore.markRead 钩子（未读→已读才计；INSERT OR IGNORE 同文防重）；
 * - 到期：懒结算（无定时器）——due()/badge()/nudge() 读取时对比 due <= now；
 *   skipped（稍后再说）到期后由结算翻回 pending 再次浮出，done（已读过了）为
 *   终态不再浮出（+30d 只是记录中的自然下一触点）；
 * - 指引：结果缓存 guidance_json（一次一存，重开零 token）；
 *   无 Key 降级 {degraded:true}，渲染层显示「重读全文」按钮；
 * - 温和设计：不做简报强推；侧栏徽章呼吸动画每日至多一次（nudge 记账）。
 *
 * 注入缝（探针）：_now 时钟可注入（确定性到期判定）；_llmComplete 整路可换。
 */
const { nowSeconds, uuid } = require('./Models');
const { LLMServiceError } = require('./LLMService');

/** 规则常量（登记/推迟/截断全部集中于此）。 */
const REVISIT = {
  LONG_READ_CHARS: 1500,  // 长文门槛（正文纯文本字符数 ≥ N 才登记）
  DUE_DAYS: 30,           // 首次重访：读完 30 天后
  DEFER_DAYS: 30,         // done/skipped 推迟：+30 天
  GUIDANCE_COUNT: 3,      // AI 指引条数
  GUIDANCE_SLICE: 200,    // 单条指引落库截断
  CONTENT_SLICE: 3000,    // 正文进 prompt 前截断（注入防护合同）
  ANNOTATION_SLICE: 240,  // 单条批注进 prompt 截断
  ANNOTATION_MAX: 8,      // 批注进 prompt 上限
  TITLE_SLICE: 120,       // 标题截断
  NUDGE_KEY: 'RobinRead.revisit.lastNudgeDay', // 每日一次呼吸动画记账
};

/** 本地日期串（YYYY-MM-DD；注入时钟下与 GardenService 同口径）。 */
function dayOf(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 从 LLM 回包解析重读指引（容错：```json 围栏 / 前后杂文 / 坏 JSON /
 * 对象或数组两种合同 / 非字符串项剔除 / 超量截到 3）。一条都剩不下 → null
 * （不落缓存可重试）。
 * @returns null | string[≤3]
 */
function parseGuidancePayload(text) {
  if (!text) return null;
  let raw = String(text).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  // 两步截取按「括号出现先后」排序（裸数组 ["…"] 若先切 {…} 会得到合法 JSON
  // 但错误形状），解析出列表合同（数组或 guidance/points/items 键）才算成功。
  const firstObj = raw.indexOf('{');
  const firstArr = raw.indexOf('[');
  const pairs = (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj))
    ? [['[', ']'], ['{', '}']]
    : [['{', '}'], ['[', ']']];
  let list = null;
  for (const [open, close] of pairs) {
    const start = raw.indexOf(open);
    const end = raw.lastIndexOf(close);
    if (start === -1 || end <= start) continue;
    let parsed = null;
    try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (_) { parsed = null; }
    if (Array.isArray(parsed)) { list = parsed; break; }
    if (parsed && typeof parsed === 'object') {
      const inner = Array.isArray(parsed.guidance) ? parsed.guidance
        : Array.isArray(parsed.points) ? parsed.points
          : Array.isArray(parsed.items) ? parsed.items : null;
      if (inner) { list = inner; break; }
    }
  }
  if (!list || !list.length) return null;
  const out = [];
  for (const item of list) {
    const line = String(item || '').replace(/\s+/g, ' ').trim();
    // 数字/布尔等非字符串被 String() 强转后剔除不成句的（纯数字行没有指引价值）
    if (!line || /^-?\d+(\.\d+)?$/.test(line)) continue;
    out.push(line.slice(0, REVISIT.GUIDANCE_SLICE));
    if (out.length >= REVISIT.GUIDANCE_COUNT) break;
  }
  return out.length ? out : null;
}

class RevisitService {
  constructor(store, { now = null } = {}) {
    this.store = store;
    this._now = now || (() => Date.now() / 1000); // 注入时钟（探针确定性）
    this._llmComplete = null; // 注入缝（探针 mock）
    this._runningRevisitID = null; // 指引单飞锁
    this.counters = {
      registered: 0, skippedShort: 0, skippedSM2: 0, dedupHits: 0,
      done: 0, skipped: 0, settled: 0, guidance: 0, guidanceCached: 0,
      parseFailures: 0, degraded: 0, cancelled: 0,
    };
    const required = ['revisits'];
    const missing = required.filter((t) => !this.store.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(t));
    if (missing.length) {
      throw new Error(`数据库 schema 缺少深读重访表（${missing.join(', ')}）：DatabaseMigrations v29 未执行`);
    }
  }

  now() { return this._now(); }

  // MARK: 登记（markRead 钩子）

  /**
   * 长文首次读完登记重访计划。三道闸顺序：短文 → 已有 SM-2 卡 → 同文防重。
   * @param {{ entryID: string }} p
   * @returns {{ registered: boolean, reason: 'ok'|'short'|'sm2'|'duplicate'|'missing' }}
   */
  onCompleted({ entryID } = {}) {
    const id = String(entryID || '').trim();
    if (!id) return { registered: false, reason: 'missing' };
    const entry = this.store.articlesRepo.entry(id);
    if (!entry) return { registered: false, reason: 'missing' };
    // 长文闸：正文纯文本（全文缓存优先，回落 summary/contentHTML）≥ 1500 字
    const cache = this.store.cachesRepo.cache(id);
    const text = this.store._entrySourceText(entry, cache);
    if (String(text || '').length < REVISIT.LONG_READ_CHARS) {
      this.counters.skippedShort += 1;
      return { registered: false, reason: 'short' };
    }
    // SM-2 分工闸：已有复习卡的原文跳过（复习管线管短记忆，不重复打扰）
    const sm2 = this.store.database.prepare(
      'SELECT 1 FROM review_queue WHERE item_id = ? LIMIT 1'
    ).get(id);
    if (sm2) {
      this.counters.skippedSM2 += 1;
      return { registered: false, reason: 'sm2' };
    }
    // 同文防重：entry_id UNIQUE（含 done/skipped 历史行——一篇终身一条计划）
    const now = this.now();
    const info = this.store.database.prepare(`
      INSERT OR IGNORE INTO revisits (id, entry_id, read_at, due, status, guidance_json, created_at)
      VALUES (?, ?, ?, ?, 'pending', NULL, ?)
    `).run(uuid(), id, now, now + REVISIT.DUE_DAYS * 86400, nowSeconds());
    if (info.changes <= 0) {
      this.counters.dedupHits += 1;
      return { registered: false, reason: 'duplicate' };
    }
    this.counters.registered += 1;
    return { registered: true, reason: 'ok', due: now + REVISIT.DUE_DAYS * 86400 };
  }

  // MARK: 到期与浮出（懒结算：无定时器，读取时结算）

  /** 懒结算：skipped 推迟到期 → 翻回 pending（done 是终态不参与）。返回结算行数。 */
  _settle() {
    const now = this.now();
    const info = this.store.database.prepare(
      "UPDATE revisits SET status = 'pending' WHERE status = 'skipped' AND due <= ?"
    ).run(now);
    if (info.changes > 0) this.counters.settled += info.changes;
    return info.changes;
  }

  /**
   * 已到期的重访卡（pending AND due <= now，先到期先浮出）。
   * 带文章标题/来源/距上次天数（浮层列表渲染数据面）。
   */
  due(nowMs = null) {
    this._settle();
    const now = nowMs != null ? Number(nowMs) / 1000 : this.now();
    return this.store.database.prepare(`
      SELECT r.id AS id, r.entry_id AS entryID, r.read_at AS readAt, r.due AS due,
             r.status AS status, r.guidance_json AS guidanceJson, r.created_at AS createdAt,
             IFNULL(a.title, '') AS title, IFNULL(f.title, '') AS sourceTitle
      FROM revisits r
      INNER JOIN items i ON i.id = r.entry_id
      LEFT JOIN articles a ON a.item_id = r.entry_id
      LEFT JOIN feeds f ON f.id = i.feed_id
      WHERE r.status = 'pending' AND r.due <= ?
      ORDER BY r.due ASC, r.created_at ASC
    `).all(now).map((row) => this._shape(row, now));
  }

  /** 侧栏徽章计数：到期待重访篇数。 */
  badge(nowMs = null) {
    return this.due(nowMs).length;
  }

  /**
   * 每日一次温和提示：到期数 + 今天是否该呼吸（徽章呼吸动画每日至多一次，
   * preferences 记账当天日期；count=0 永不呼吸）。
   */
  nudge(nowMs = null) {
    const now = nowMs != null ? Number(nowMs) / 1000 : this.now();
    const count = this.badge(nowMs); // nowMs 口径原样透传（badge→due 同一换算）
    const today = dayOf(now);
    const last = this.store.preferences.get(REVISIT.NUDGE_KEY, '');
    const breathe = count > 0 && last !== today;
    if (breathe) this.store.preferences.set(REVISIT.NUDGE_KEY, today);
    return { count, breathe, day: today };
  }

  // MARK: 回应（已读过了 / 稍后再说）

  /**
   * 回应一张到期卡：done（已读过了，终态）/ skipped（稍后再说）——
   * 两者都把 due 推迟 DEFER_DAYS（温和设计：不强推，也不删除历史）。
   * 推迟基准 = max(原 due, 当前时刻)——晚回应不瞬间再到期（回应时刻 + 30 天起算）。
   * done 不再浮出；skipped 由 _settle 在新 due 过后翻回 pending。
   */
  respond(revisitID, action) {
    const id = String(revisitID || '');
    const act = String(action || '');
    if (act !== 'done' && act !== 'skipped') throw new Error('回应只支持 done（已读过了）或 skipped（稍后再说）。');
    const row = this.store.database.prepare('SELECT * FROM revisits WHERE id = ?').get(id);
    if (!row) throw new Error('重访卡不存在。');
    const due = Math.max(Number(row.due), this.now()) + REVISIT.DEFER_DAYS * 86400;
    this.store.database.prepare('UPDATE revisits SET status = ?, due = ? WHERE id = ?')
      .run(act, due, id);
    if (act === 'done') this.counters.done += 1;
    else this.counters.skipped += 1;
    try { this.store.emit('revisit:changed', { count: this.badge() }); } catch (_) { /* 无订阅者不阻塞 */ }
    return this.get(id);
  }

  // MARK: AI 重读指引

  /**
   * 重读指引：LLM 输入正文 + 当时的批注 → 3 条指引。guidance_json 缓存防重烧；
   * 无 Key 降级 {degraded:true}（渲染层显示「重读全文」按钮）。
   * @returns {{ degraded?, cached?, guidance?: string[], revisitID }}
   */
  async guidance(revisitID) {
    const id = String(revisitID || '');
    const row = this.store.database.prepare('SELECT * FROM revisits WHERE id = ?').get(id);
    if (!row) throw new Error('重访卡不存在。');
    if (row.guidance_json) {
      let guidance = null;
      try { guidance = JSON.parse(row.guidance_json); } catch (_) { guidance = null; }
      if (Array.isArray(guidance) && guidance.length) {
        this.counters.guidanceCached += 1;
        return { revisitID: id, guidance, cached: true };
      }
    }
    let ai = null;
    try { ai = this.store._requireAIReady(); } catch (_) { ai = null; }
    if (!ai) {
      this.counters.degraded += 1;
      return { revisitID: id, degraded: true, guidance: null }; // 渲染层显示「重读全文」
    }
    const lockKey = `revisit-guidance:${id}`;
    if (this._runningRevisitID === id || this.store.activeAICancellers.has(lockKey)) {
      throw new LLMServiceError('requestInProgress');
    }
    const context = this._articleContext(row.entry_id);
    if (!context.articleText) throw new Error('文章不存在或已被清理。');
    const canceller = { cancelled: false, controller: new AbortController() };
    this.store.activeAICancellers.set(lockKey, canceller);
    this._runningRevisitID = id;
    try {
      const raw = await this.llmComplete({ ...context, annotations: this._annotations(row.entry_id) }, ai, canceller.controller.signal);
      if (canceller.cancelled) {
        this.counters.cancelled += 1;
        return { revisitID: id, cancelled: true, guidance: null };
      }
      const guidance = parseGuidancePayload(raw);
      if (!guidance) {
        this.counters.parseFailures += 1;
        throw new LLMServiceError('invalidResponse'); // 坏输出不落缓存，可重试
      }
      this.store.database.prepare('UPDATE revisits SET guidance_json = ? WHERE id = ?')
        .run(JSON.stringify(guidance), id);
      this.counters.guidance += 1;
      return { revisitID: id, guidance, cached: false };
    } catch (err) {
      if (canceller.cancelled || String((err && err.message) || '').includes('cancelled')) {
        this.counters.cancelled += 1;
        return { revisitID: id, cancelled: true, guidance: null };
      }
      throw err;
    } finally {
      this.store.activeAICancellers.delete(lockKey);
      this._runningRevisitID = null;
    }
  }

  cancel(revisitID) {
    this.store.cancelAI(`revisit-guidance:${String(revisitID || '')}`);
  }

  // MARK: 投影

  _shape(row, now = null) {
    const at = now != null ? now : this.now();
    let guidance = null;
    try { guidance = row.guidanceJson ? JSON.parse(row.guidanceJson) : null; } catch (_) { guidance = null; }
    return {
      id: row.id,
      entryID: row.entryID,
      title: String(row.title || '').slice(0, REVISIT.TITLE_SLICE) || row.entryID,
      sourceTitle: row.sourceTitle || '',
      readAt: row.readAt,
      due: row.due,
      status: row.status,
      daysSinceRead: Math.max(0, Math.round((at - row.readAt) / 86400)),
      hasGuidance: Array.isArray(guidance) && guidance.length > 0,
      createdAt: row.createdAt,
    };
  }

  get(revisitID) {
    const row = this.store.database.prepare(`
      SELECT r.id AS id, r.entry_id AS entryID, r.read_at AS readAt, r.due AS due,
             r.status AS status, r.guidance_json AS guidanceJson, r.created_at AS createdAt,
             IFNULL(a.title, '') AS title, IFNULL(f.title, '') AS sourceTitle
      FROM revisits r
      INNER JOIN items i ON i.id = r.entry_id
      LEFT JOIN articles a ON a.item_id = r.entry_id
      LEFT JOIN feeds f ON f.id = i.feed_id
      WHERE r.id = ?
    `).get(String(revisitID || ''));
    return row ? this._shape(row) : null;
  }

  /** 历史（浮层「之后再看」区可选；新→旧）。 */
  list({ limit = 50 } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
    return this.store.database.prepare(`
      SELECT r.id AS id, r.entry_id AS entryID, r.read_at AS readAt, r.due AS due,
             r.status AS status, r.guidance_json AS guidanceJson, r.created_at AS createdAt,
             IFNULL(a.title, '') AS title, IFNULL(f.title, '') AS sourceTitle
      FROM revisits r
      LEFT JOIN items i ON i.id = r.entry_id
      LEFT JOIN articles a ON a.item_id = r.entry_id
      LEFT JOIN feeds f ON f.id = i.feed_id
      ORDER BY r.created_at DESC, r.id DESC LIMIT ?
    `).all(cap).map((row) => this._shape(row));
  }

  // MARK: 内部

  _articleContext(entryID) {
    const entry = this.store.articlesRepo.entry(entryID);
    if (!entry) return { title: '', articleText: '' };
    const cache = this.store.cachesRepo.cache(entryID);
    const articleText = this.store._entrySourceText(entry, cache).replace(/\s+/g, ' ').trim();
    return {
      title: String(entry.title || '').slice(0, REVISIT.TITLE_SLICE),
      articleText: articleText.slice(0, REVISIT.CONTENT_SLICE),
    };
  }

  /** 当时的批注（高亮 + 笔注，进 prompt 上下文；最多 ANNOTATION_MAX 条）。 */
  _annotations(entryID) {
    const out = [];
    const cap = REVISIT.ANNOTATION_MAX;
    for (const h of this.store.database.prepare(
      'SELECT text, note FROM highlights WHERE item_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(entryID, cap)) {
      out.push({ kind: 'highlight', text: String(h.text || '').replace(/\s+/g, ' ').trim().slice(0, REVISIT.ANNOTATION_SLICE), note: String(h.note || '').slice(0, REVISIT.ANNOTATION_SLICE) || null });
      if (out.length >= cap) return out;
    }
    for (const n of this.store.database.prepare(
      'SELECT content FROM notes WHERE item_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(entryID, cap)) {
      out.push({ kind: 'note', text: String(n.content || '').replace(/\s+/g, ' ').trim().slice(0, REVISIT.ANNOTATION_SLICE), note: null });
      if (out.length >= cap) return out;
    }
    return out;
  }

  /** 文章块（注入防护合同：截断 + <article> 包裹，与 F25/F26 同口径）。 */
  static articleBlock(articleText) {
    return `<article>\n${articleText}\n</article>`;
  }

  /** LLM 重读指引。可整路注入（探针 mock）。 */
  async llmComplete({ title, articleText, annotations = [] }, { config, apiKey }, signal = null) {
    if (this._llmComplete) return this._llmComplete({ title, articleText, annotations }, { config, apiKey }, signal);
    const annotationLines = annotations.length
      ? ['读者当时划过的批注：', ...annotations.map((a) => `- 「${a.text}」${a.note ? `（附记：${a.note}）` : ''}`), '']
      : [];
    const prompt = [
      RevisitService.articleBlock(articleText),
      '',
      `文章标题：《${title}》。这是读者 ${REVISIT.DUE_DAYS} 天前读完的长文，今天温和地重访它。`,
      ...annotationLines,
      `请给出 ${REVISIT.GUIDANCE_COUNT} 条重读指引：`,
      '- 第 1 条：当时这篇文章的关键论点是什么（一句话）；',
      '- 第 2 条：隔了这些天，今天的读者最该重点重看哪一段、为什么；',
      '- 第 3 条：一句挑战性提问（检验当时的判断今天还站不站得住）。',
      `只输出 JSON：{"guidance":["…","…","…"]}（恰好 ${REVISIT.GUIDANCE_COUNT} 条，每条不超过 60 字），不要输出任何其他文字。`,
    ].join('\n');
    return this.store.llm.complete({
      prompt,
      system: '你是温和的重读向导，只依据 <article> 标签内的原文与读者批注给指引，不编造原文没有的内容，只输出 JSON，不输出其他内容。',
      configuration: config,
      apiKey,
      signal,
      forceDisableReasoning: true,
      overrideTemperature: 0.3,
    });
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return {
      ...this.counters,
      ...REVISIT,
      running: this._runningRevisitID,
      total: this.store.database.prepare('SELECT COUNT(*) AS n FROM revisits').get().n,
    };
  }
}

module.exports = {
  RevisitService,
  REVISIT,
  parseGuidancePayload,
  dayOf,
};
