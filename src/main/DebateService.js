'use strict';
/**
 * DebateService（知更）— AI 反方辩手（F25，有趣档）
 *
 * 观点文一键召唤「钢人（steelman）」反方与你辩论，你当裁判投票：
 * - startDebate：LLM 读文章正文（截断 + 分隔包裹，注入防护），生成钢人开场
 *   （最强反方立场，3 段以内：核心反驳 / 被忽略的证据 / 反方结论）；
 * - 此后多轮：用户发言 → AI 回合（每次 ≤250 字，引用文章原句佐证，不许稻草人
 *   —— prompt 明确钢人规则）；AI 回合上限 MAX_TURNS（含开场）防失控；
 * - 裁决：verdict_up（反方说服了我）/ verdict_down（我坚持原文）→ 气泡流定格，
 *   辩论摘要可一键「存为批注」落 highlights 管线（KnowledgeEngine.addHighlight）；
 * - 持久化 v24 debates 表：rounds_json 存完整回合流；一篇文章可多次辩论，
 *   但进行中（open）仅一场（服务层单飞）；
 * - 取消/互斥：对齐 activeAICancellers 惯例（key=`debate:<entryID>`）；
 * - 无 Key：available().ai=false，渲染层灰置（服务层 _requireAIReady 兜底拒绝）。
 *
 * 注入防护：文章内容进 prompt 前截断（≤ CONTENT_SLICE 字）并包裹
 * <article>…</article> 分隔标记；用户发言只进 user prompt 的 <reader> 区，
 * 绝不进 system。
 *
 * 注入缝（探针 mock）：_llmComplete 整路可换；时间可注入（_now）。
 */
const { nowSeconds, uuid } = require('./Models');
const { LLMServiceError } = require('./LLMService');

/** 规则常量（轮数/截断/引用全部集中于此）。 */
const DEBATE = {
  MAX_TURNS: 6,          // AI 发言上限（含开场）——到顶必须裁决，防失控
  CONTENT_SLICE: 4000,   // 文章内容进 prompt 前截断（注入防护合同）
  OPENING_SLICE: 2200,   // 开场落库硬上限（prompt 要求 3 段以内）
  REPLY_SLICE: 600,      // 回合落库硬上限（prompt 要求 ≤250 字，此处防失控护栏）
  QUOTE_MAX: 3,          // 每回合引用原句上限
  QUOTE_SLICE: 140,      // 每条引用截断
  USER_SLICE: 2000,      // 用户发言截断
  TRANSCRIPT_TURNS: 6,   // 上下文携带的最近回合数
  HIGHLIGHT_TEXT_SLICE: 160, // 存为批注：卡面文字截断
};

const SYSTEM_RULES = [
  '你是「钢人辩手」：永远构造对方立场中最强、最诚实的版本，绝不使用稻草人谬误。',
  '规则：1) 只依据 <article> 标签内的原文内容反驳，不得编造文中不存在的论据；',
  '2) 引用文章原句佐证（quotes 数组，逐字摘录，每条不超过一句话）；',
  '3) 每次发言不超过 250 字；4) 承认对方（读者）有力的反驳，不诡辩、不重复。',
  '只输出 JSON 对象 {"content":"发言正文","quotes":["原句1"]}，不要输出任何其他文字。',
].join('\n');

/** 用户发言的注入中性化：剥掉伪标记，防止冒充文章/系统区块。 */
function sanitizeUserText(raw) {
  return String(raw || '')
    .replace(/<\/?(article|reader|transcript|system)>/gi, '＜$1＞')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DEBATE.USER_SLICE);
}

/**
 * 从 LLM 回包解析回合（容错：```json 围栏 / 前后杂文 / 非法结构）。
 * JSON 完全解析不出 → 降级把整段文本当 content（degraded=true），不浪费一次发言。
 * @returns {{ content, quotes, degraded }}
 */
function parseDebateTurn(text, { slice = DEBATE.REPLY_SLICE } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let body = raw;
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) body = fenced[1].trim();
  let parsed = null;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { parsed = JSON.parse(body.slice(start, end + 1)); } catch (_) { parsed = null; }
  }
  if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string' && parsed.content.trim()) {
    const quotes = Array.isArray(parsed.quotes)
      ? parsed.quotes.map((q) => String(q || '').replace(/\s+/g, ' ').trim().slice(0, DEBATE.QUOTE_SLICE))
        .filter(Boolean).slice(0, DEBATE.QUOTE_MAX)
      : [];
    return { content: parsed.content.replace(/\s+/g, ' ').trim().slice(0, slice), quotes, degraded: false };
  }
  // 降级：纯文本输出照常展示（引用为空），degraded 标记供诊断
  const content = body.replace(/\s+/g, ' ').trim().slice(0, slice);
  return content ? { content, quotes: [], degraded: true } : null;
}

/** 引用校验：只保留真实出自原文的原句（normalize 空白后子串匹配）。 */
function filterQuotes(quotes, articleText) {
  const hay = String(articleText || '').replace(/\s+/g, ' ');
  if (!hay) return [];
  return (quotes || []).filter((q) => q && hay.includes(q.replace(/\s+/g, ' ')));
}

class DebateService {
  constructor(store, { now = null } = {}) {
    this.store = store;
    this._now = now || (() => Date.now() / 1000);
    // LLM 完成通路可整路注入（探针 mock）；默认走 store.llm.complete（非流式）
    this._llmComplete = null;
    this._runningEntryID = null; // 单飞锁镜像（同 PerspectiveService 惯例）
    this.counters = { started: 0, replies: 0, verdicts: 0, savedHighlights: 0, cancelled: 0, degraded: 0, quoteDropped: 0 };
    const required = ['debates'];
    const missing = required.filter((t) => !this.store.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(t));
    if (missing.length) {
      throw new Error(`数据库 schema 缺少辩论表（${missing.join(', ')}）：DatabaseMigrations v24 未执行`);
    }
  }

  now() { return this._now(); }

  /** AI 可用性（渲染层按钮显隐/灰置）。 */
  available() {
    return { ai: this.store.hasAIAPIKey() };
  }

  // MARK: 读取投影

  _row(id) {
    return this.store.database.prepare('SELECT * FROM debates WHERE id = ?').get(String(id || ''));
  }

  _shape(row) {
    if (!row) return null;
    let rounds = [];
    try { rounds = JSON.parse(row.rounds_json || '[]'); } catch (_) { rounds = []; }
    if (!Array.isArray(rounds)) rounds = [];
    const aiTurns = rounds.filter((r) => r && r.role === 'ai').length;
    return {
      id: row.id,
      entryID: row.entry_id,
      status: row.status,
      verdict: row.verdict || null,
      rounds,
      aiTurns,
      turnsLeft: Math.max(0, DEBATE.MAX_TURNS - aiTurns),
      capped: row.status === 'open' && aiTurns >= DEBATE.MAX_TURNS,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** 某篇文章的最近一场辩论（回看/续辩；无则 null）。 */
  current(entryID) {
    const row = this.store.database.prepare(
      'SELECT * FROM debates WHERE entry_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
    ).get(String(entryID || ''));
    return this._shape(row);
  }

  get(debateID) {
    return this._shape(this._row(debateID));
  }

  // MARK: 开场（startDebate）

  /**
   * 一键召唤钢人：已有 open 场直接续（单飞语义），否则建新场并生成开场。
   * 并发生成中再次调用 → requestInProgress（canceller 注册表判重）。
   */
  async startDebate(entryID) {
    const id = String(entryID || '');
    if (!id) throw new Error('文章不存在或已被清理。');
    let debateID = null;
    const existing = this.store.database.prepare(
      "SELECT * FROM debates WHERE entry_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1"
    ).get(id);
    if (existing && this._shape(existing).rounds.length > 0) {
      return this._shape(existing); // 已有进行中的场：单飞语义，直接续辩
    }
    if (existing) debateID = existing.id; // 半途取消的空场可复用（不堆行）
    const lockKey = `debate:${id}`;
    if (this._runningEntryID === id || this.store.activeAICancellers.has(lockKey)) {
      throw new LLMServiceError('requestInProgress');
    }
    const ai = this.store._requireAIReady(); // 无 Key 抛 missingAPIKey（渲染层灰置兜底）
    const { title, articleText } = this._articleContext(id);
    if (!debateID) {
      debateID = uuid();
      this.store.database.prepare(`
        INSERT INTO debates (id, entry_id, status, rounds_json, verdict, created_at, updated_at)
        VALUES (?, ?, 'open', '[]', NULL, ?, ?)
      `).run(debateID, id, nowSeconds(), nowSeconds());
    }
    const canceller = { cancelled: false, controller: new AbortController() };
    this.store.activeAICancellers.set(lockKey, canceller);
    this._runningEntryID = id;
    try {
      const text = await this.llmComplete('opening', { entryID: id, title, articleText }, ai, canceller.controller.signal);
      if (canceller.cancelled) {
        this.counters.cancelled += 1;
        return this.get(debateID); // 取消：空场保留（open、零回合），可重开
      }
      const turn = parseDebateTurn(text, { slice: DEBATE.OPENING_SLICE });
      if (!turn) throw new LLMServiceError('invalidResponse');
      if (turn.degraded) this.counters.degraded += 1;
      const kept = filterQuotes(turn.quotes, articleText);
      this.counters.quoteDropped += turn.quotes.length - kept.length;
      this._appendRound(debateID, { role: 'ai', kind: 'opening', content: turn.content, quotes: kept });
      this.counters.started += 1;
      return this.get(debateID);
    } catch (err) {
      if (canceller.cancelled || String((err && err.message) || '').includes('cancelled')) {
        this.counters.cancelled += 1;
        return this.get(debateID);
      }
      throw err; // 网络/HTTP 错误上抛 → 渲染层失败态（空场保留可重试）
    } finally {
      this.store.activeAICancellers.delete(lockKey);
      this._runningEntryID = null;
    }
  }

  // MARK: 多轮回合（用户发言 → AI 回合）

  /**
   * 用户发言一轮：先落用户回合（取消也保留发言），再取 AI 回合。
   * 轮数上限：AI 回合（含开场）达 MAX_TURNS 后拒绝，要求先裁决。
   */
  async reply(debateID, userText) {
    const row = this._row(debateID);
    if (!row) throw new Error('辩论不存在。');
    if (row.status !== 'open') throw new Error('本场辩论已裁决定格，不能再发言。');
    const debate = this._shape(row);
    if (debate.capped) throw new Error('本场辩论已达回合上限，请先投票裁决。');
    const text = sanitizeUserText(userText);
    if (!text) throw new Error('先说一句你的反驳再发给反方。');

    const id = String(row.entry_id);
    const lockKey = `debate:${id}`;
    if (this._runningEntryID === id || this.store.activeAICancellers.has(lockKey)) {
      throw new LLMServiceError('requestInProgress');
    }
    const ai = this.store._requireAIReady();
    this._appendRound(row.id, { role: 'user', kind: 'user', content: text, quotes: [] });
    const { title, articleText } = this._articleContext(id);

    const canceller = { cancelled: false, controller: new AbortController() };
    this.store.activeAICancellers.set(lockKey, canceller);
    this._runningEntryID = id;
    try {
      const raw = await this.llmComplete('reply', {
        entryID: id, title, articleText,
        transcript: this.get(row.id).rounds.slice(-DEBATE.TRANSCRIPT_TURNS),
      }, ai, canceller.controller.signal);
      if (canceller.cancelled) {
        this.counters.cancelled += 1;
        return this.get(row.id); // 用户发言已落库；重试 reply 会再取一轮 AI
      }
      const turn = parseDebateTurn(raw, { slice: DEBATE.REPLY_SLICE });
      if (!turn) throw new LLMServiceError('invalidResponse');
      if (turn.degraded) this.counters.degraded += 1;
      const kept = filterQuotes(turn.quotes, articleText);
      this.counters.quoteDropped += turn.quotes.length - kept.length;
      this._appendRound(row.id, { role: 'ai', kind: 'reply', content: turn.content, quotes: kept });
      this.counters.replies += 1;
      return this.get(row.id);
    } catch (err) {
      if (canceller.cancelled || String((err && err.message) || '').includes('cancelled')) {
        this.counters.cancelled += 1;
        return this.get(row.id);
      }
      throw err;
    } finally {
      this.store.activeAICancellers.delete(lockKey);
      this._runningEntryID = null;
    }
  }

  // MARK: 裁决与批注

  /** 投票裁决：verdict_up=反方说服了我 / verdict_down=我坚持原文 → 定格。 */
  verdict(debateID, verdictValue) {
    const v = String(verdictValue || '');
    if (!['verdict_up', 'verdict_down'].includes(v)) throw new Error('裁决只有两态：verdict_up / verdict_down。');
    const row = this._row(debateID);
    if (!row) throw new Error('辩论不存在。');
    if (row.status !== 'open') throw new Error('本场辩论已裁决过。');
    this.store.database.prepare(
      "UPDATE debates SET status = 'closed', verdict = ?, updated_at = ? WHERE id = ?"
    ).run(v, nowSeconds(), row.id);
    this.counters.verdicts += 1;
    return this.get(row.id);
  }

  /** 辩论摘要 → 一条批注（highlights 管线，KnowledgeEngine 统一入口）。 */
  saveHighlight(debateID) {
    const debate = this.get(debateID);
    if (!debate) throw new Error('辩论不存在。');
    const aiRounds = debate.rounds.filter((r) => r.role === 'ai');
    const userRounds = debate.rounds.filter((r) => r.role === 'user');
    const firstAI = aiRounds[0]?.content || '';
    if (!firstAI) throw new Error('这场辩论还没有开场，无可存内容。');
    const digest = [
      `【反方辩手 · ${debate.verdict === 'verdict_up' ? '反方说服了我' : debate.verdict === 'verdict_down' ? '我坚持原文' : '未裁决'}】`,
      ...debate.rounds.map((r) => `${r.role === 'ai' ? '反方' : '我'}：${r.content}`),
    ].join('\n').slice(0, 4000);
    const highlight = this.store.knowledge.addHighlight({
      itemID: debate.entryID,
      text: `【反方辩手】${firstAI.slice(0, DEBATE.HIGHLIGHT_TEXT_SLICE)}`,
      color: 'blue',
      note: digest + (userRounds.length ? '' : '\n（本场只有开场）'),
    });
    this.counters.savedHighlights += 1;
    return highlight;
  }

  /** 取消在途生成（对齐 activeAICancellers 惯例）。 */
  cancel(entryID) {
    this.store.cancelAI(`debate:${String(entryID || '')}`);
  }

  // MARK: 内部

  _articleContext(entryID) {
    const entry = this.store.articlesRepo.entry(entryID);
    if (!entry) throw new Error('文章不存在或已被清理。');
    const cache = this.store.cachesRepo.cache(entryID);
    const articleText = this.store._entrySourceText(entry, cache).replace(/\s+/g, ' ').trim();
    return {
      title: String(entry.title || '').slice(0, 120),
      articleText: articleText.slice(0, DEBATE.CONTENT_SLICE),
    };
  }

  /** 追加一个回合并持久化（rounds_json 单列整体写）。 */
  _appendRound(debateID, round) {
    const debate = this.get(debateID);
    const rounds = [...(debate ? debate.rounds : []), { ...round, at: nowSeconds() }];
    this.store.database.prepare(
      'UPDATE debates SET rounds_json = ?, updated_at = ? WHERE id = ?'
    ).run(JSON.stringify(rounds), nowSeconds(), debateID);
  }

  /** 文章块（注入防护合同：截断 + 分隔标记）。 */
  static articleBlock(articleText) {
    return `<article>\n${articleText}\n</article>`;
  }

  /** LLM 调用（kind='opening'|'reply'）。可整路注入（探针 mock）。 */
  async llmComplete(kind, { entryID, title, articleText, transcript = [] }, { config, apiKey }, signal = null) {
    if (this._llmComplete) return this._llmComplete(kind, { entryID, title, articleText, transcript }, { config, apiKey }, signal);
    const articleBlock = DebateService.articleBlock(articleText);
    let prompt;
    if (kind === 'opening') {
      prompt = [
        articleBlock,
        '',
        `文章标题：《${title}》。你是这篇作者的最强反方。请输出钢人开场，content 分三小段：`,
        '① 核心反驳（直击文章的中心主张）；② 被忽略的证据（原文中被轻描淡写或忽略的事实）；',
        '③ 反方结论（一两句收束）。quotes 里给出你反驳时依据的原文原句（至多 3 句）。',
        '只输出 JSON 对象 {"content":"…","quotes":["…"]}。',
      ].join('\n');
    } else {
      const lines = transcript.map((r) => (r.role === 'ai'
        ? `反方：${r.content}`
        : `<reader>${r.content}</reader>`));
      prompt = [
        articleBlock,
        '',
        '辩论至今的回合记录：',
        lines.join('\n'),
        '',
        '请给出你的下一轮反驳：不超过 250 字，正面回应读者最新的发言；',
        '若读者说到点子上就明说并让进（钢人不诡辩），再补一层更深的追问。quotes 引原文佐证。',
        '只输出 JSON 对象 {"content":"…","quotes":["…"]}。',
      ].join('\n');
    }
    return this.store.llm.complete({
      prompt,
      system: SYSTEM_RULES,
      configuration: config,
      apiKey,
      signal,
      forceDisableReasoning: true,
      overrideTemperature: 0.4,
    });
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return { ...this.counters, ...DEBATE, running: this._runningEntryID };
  }
}

module.exports = {
  DebateService,
  DEBATE,
  parseDebateTurn,
  filterQuotes,
  sanitizeUserText,
  SYSTEM_RULES,
};
