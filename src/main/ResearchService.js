'use strict';
/**
 * ResearchService（知更）— AI 深度研究（F8）
 *
 * 输入一个研究主题 → 聚合本地库与 AIHOT 素材 → LLM 生成带引用编号的
 * 流式研究报告 → 存知识中心（v17 research_reports）→ 可继续追问。
 *
 * 设计约束：
 * - gather 不依赖 AI：本路（FTS 相关度 + 知识库高亮/笔记）永远可用；
 *   AIHOT 路失败静默跳过（无网/服务不可用时本地路照常）；
 * - 报告生成复用 generateTodayDigest 模式（_requireAIReady + llm.complete + onDelta
 *   流式）；llm.complete 支持 signal，取消后已收到部分保留为草稿（is_complete=0）；
 * - 引用编号 [n] 严格对应素材列表下标 +1，提示词显式约束「只允许 [1]-[N]」；
 * - 单飞锁：生成/追问共用一把锁，进行中拒绝第二个研究；
 * - 网络路（AIHOT）可注入替换（探针离线化：_aihotItemsImpl）。
 */
const { i18n } = require('./I18N');
const { ArticleChunker } = require('./LLMService');
const { randomUUID } = require('node:crypto');

const LOCAL_LIMIT = 20;        // 本库 FTS 相关度前 20
const KNOWLEDGE_LIMIT = 10;    // 知识库高亮/笔记命中前 10
const AIHOT_LIMIT = 20;        // AIHOT 精选前 20
const MATERIAL_CAP = 40;       // 素材总量上限
const SNIPPET_MAX = 300;       // 素材摘要上限（字）
const LIST_LIMIT = 100;        // 历史列表上限
const FLUSH_INTERVAL_MS = 900; // 流式期间草稿落库节流

/** 标题归一（去重口径）：小写 + 去全部空白。 */
function normalizeTitle(title) {
  return String(title || '').toLowerCase().replace(/\s+/g, '');
}

/** 素材条目归一：snippet ≤300 字、字段白名单。 */
function normalizeMaterial(m) {
  return {
    title: String(m.title || '').slice(0, 500),
    source: String(m.source || '').slice(0, 200),
    snippet: String(m.snippet || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX),
    url: m.url ? String(m.url) : null,
    entryID: m.entryID ? String(m.entryID) : null,
    lane: ['local', 'knowledge', 'aihot'].includes(m.lane) ? m.lane : 'local',
  };
}

/** 素材去重（标题归一相似）+ 总量截断。先到先得（保持本地路优先的排列）。 */
function dedupeMaterials(candidates) {
  const seen = new Set();
  const out = [];
  for (const raw of candidates) {
    const m = normalizeMaterial(raw);
    if (!m.title && !m.snippet) continue;
    const key = normalizeTitle(m.title);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(m);
    if (out.length >= MATERIAL_CAP) break;
  }
  return out;
}

/** 行 → 报告 API 形态（JSON 列解包，坏数据惰性化）。 */
function reportFromRow(row) {
  let keywords = [];
  let sources = [];
  try { keywords = JSON.parse(row.keywords_json || '[]'); } catch (_) { /* 惰性 */ }
  try { sources = JSON.parse(row.sources_json || '[]'); } catch (_) { /* 惰性 */ }
  if (!Array.isArray(keywords)) keywords = [];
  if (!Array.isArray(sources)) sources = [];
  return {
    id: row.id,
    topic: row.topic,
    keywords,
    reportMd: row.report_md || '',
    sources,
    isComplete: Number(row.is_complete) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class ResearchService {
  constructor(store) {
    this.store = store;
    this.counters = { gathers: 0, generated: 0, drafts: 0, followups: 0, aihotFailures: 0 };
    // 单飞锁：进行中的运行 { reportID, kind, controller }；null = 空闲
    this._active = null;
    // AIHOT 路可注入（探针离线化）：默认走真实通路
    this._aihotItemsImpl = async (q) => this.store.aihot.items({ q, window: '30d', limit: AIHOT_LIMIT });
  }

  // MARK: - 素材聚合（不依赖 AI）

  /**
   * 聚合素材：本路（FTS 相关度前 20 + 知识库高亮/笔记前 10）+ AIHOT 路（失败静默跳过）。
   * 返回 { topic, keywords, materials }，素材统一为
   * { title, source, snippet(≤300), url?, entryID?, lane }，标题归一去重，总量 ≤40。
   */
  async gather(topic) {
    const t = String(topic || '').trim();
    if (!t) throw new Error(i18n.localized('请输入研究主题。'));
    if (t.length > 200) throw new Error(i18n.localized('研究主题过长（最多 200 字）。'));
    this.counters.gathers += 1;
    const candidates = [];

    // 本库路：FTS5 trigram + bm25 相关度排序；FTS 不可用/零命中回退 store.searchEntries（LIKE）
    let localRows = [];
    try { localRows = this._localLaneFTS(t); } catch (_) { localRows = []; }
    if (!localRows.length) {
      try {
        localRows = (this.store.searchEntries(t, { limit: LOCAL_LIMIT }) || []).map((it) => ({
          entry_id: it.id, title: it.title, url: it.url,
          summary: it.summaryPreview || it.summary || '', source_name: it.sourceTitle || '',
        }));
      } catch (_) { localRows = []; }
    }
    for (const r of localRows) {
      candidates.push({
        title: r.title || '', source: r.source_name || '', snippet: r.summary || '',
        url: r.url || null, entryID: r.entry_id || null, lane: 'local',
      });
    }

    // 知识库路：高亮/笔记命中（KnowledgeEngine.searchKnowledge 前 10）
    try {
      const kb = this.store.knowledge.searchKnowledge(t, { limit: KNOWLEDGE_LIMIT }) || {};
      const kbHits = [
        ...(kb.highlights || []).map((h) => ({ title: h.articleTitle || h.text, source: h.articleTitle || '', snippet: h.text || '', entryID: h.itemID })),
        ...(kb.notes || []).map((n) => ({ title: n.articleTitle || n.content, source: n.articleTitle || '', snippet: n.content || '', entryID: n.itemID })),
      ].slice(0, KNOWLEDGE_LIMIT);
      for (const h of kbHits) candidates.push({ ...h, lane: 'knowledge' });
    } catch (_) { /* 知识库路失败不阻塞 */ }

    // AIHOT 路：失败静默跳过（无网/AIHOT 不可用时本地路照常）
    try {
      const items = await this._aihotItemsImpl(t);
      for (const it of (Array.isArray(items) ? items : [])) {
        candidates.push({
          title: it.title || '', source: it.source || 'AIHOT', snippet: it.summary || '',
          url: it.originalURL || it.url || null, entryID: null, lane: 'aihot',
        });
      }
    } catch (_) { this.counters.aihotFailures += 1; }

    return { topic: t, keywords: [t], materials: dedupeMaterials(candidates) };
  }

  /**
   * 本库 FTS 路：trigram MATCH + bm25 相关度。
   * 列权重（列序 item_id/title/author/summary/body，首列 UNINDEXED 忽略）：
   * 标题命中权重最高——否则正文高频重复的行会仅凭词频压过标题命中。
   */
  _localLaneFTS(topic) {
    const db = this.store.database;
    const hasFts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='articles_fts'").get();
    if (!hasFts) return [];
    const match = `"${String(topic).replace(/"/g, '""')}"`;
    return db.prepare(`
      SELECT i.id AS entry_id, IFNULL(a.title, '') AS title, a.url AS url,
             IFNULL(a.summary, '') AS summary, IFNULL(f.title, '') AS source_name
      FROM articles_fts
      INNER JOIN items i ON i.id = articles_fts.item_id
      INNER JOIN feeds f ON f.id = i.feed_id AND f.is_deleted = 0
      LEFT JOIN articles a ON a.item_id = i.id
      WHERE articles_fts MATCH ?
      ORDER BY bm25(articles_fts, 1.0, 8.0, 1.0, 1.0, 0.6), COALESCE(a.published_at, i.created_at) DESC
      LIMIT ${LOCAL_LIMIT}
    `).all(match);
  }

  // MARK: - 报告生成（流式 + 可取消 + 单飞锁）

  /**
   * 生成研究报告。流式分片经 onDelta 推送；阶段经 onStatus('gather'|'generate') 推送。
   * signal 中止（或 cancelActive）→ 已收到部分存为草稿（is_complete=0）并返回
   * { report, cancelled: true }，不按错误抛出。同主题旧草稿在再次生成时被覆盖。
   */
  async generate(topic, { onDelta = null, onStatus = null, signal = null } = {}) {
    const t = String(topic || '').trim();
    if (!t) throw new Error(i18n.localized('请输入研究主题。'));
    this._acquireLock();

    let reportID = null;
    let streamed = '';
    let flushTimer = null;
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) { this._active = null; throw this._cancelledError(); }
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    this._active = { kind: 'generate', controller };

    const flushDraft = (isComplete) => {
      if (!reportID) return;
      this.store.database.prepare(
        'UPDATE research_reports SET report_md=?, is_complete=?, updated_at=? WHERE id=?'
      ).run(streamed, isComplete ? 1 : 0, Date.now() / 1000, reportID);
    };
    try {
      onStatus?.('gather');
      const { materials } = await this.gather(t);
      const { config, apiKey } = this.store._requireAIReady(); // gather 之后才查 Key：聚合路径不依赖 AI

      // 覆盖同主题旧草稿（未完成即草稿——取消后再次生成不应留下一串半成品）
      this.store.database.prepare(
        "DELETE FROM research_reports WHERE is_complete = 0 AND TRIM(topic) = ?"
      ).run(t);

      reportID = randomUUID();
      const now = Date.now() / 1000;
      this.store.database.prepare(`
        INSERT INTO research_reports (id, topic, keywords_json, report_md, sources_json, is_complete, created_at, updated_at)
        VALUES (?, ?, ?, '', ?, 0, ?, ?)
      `).run(reportID, t, JSON.stringify([t]), JSON.stringify(materials), now, now);

      onStatus?.('generate');
      const prompt = buildReportPrompt(t, materials);
      // 流式期间节流落库：进程意外退出时草稿最多丢一个节流窗
      flushTimer = setInterval(() => flushDraft(false), FLUSH_INTERVAL_MS);
      let aborted = false;
      try {
        streamed = await this.store.llm.complete({
          prompt,
          system: '你是一位严谨的中文研究编辑，为读者撰写深度研究报告。输出简体中文 Markdown，遵循用户给定的结构；引用编号必须只使用素材列表中真实存在的编号；只基于素材写作，不编造素材之外的事实与来源。',
          configuration: config,
          apiKey,
          onDelta: (delta) => { streamed += delta; onDelta?.(delta); },
          signal: controller.signal,
          forceDisableReasoning: true,
          overrideTemperature: 0.3,
        });
      } catch (err) {
        if (controller.signal.aborted || String(err?.message || err) === 'cancelled') aborted = true;
        else {
          flushDraft(false); // 失败前已流到的部分也保留为草稿（与取消同语义）
          throw err;
        }
      }
      clearInterval(flushTimer);
      flushTimer = null;
      flushDraft(!aborted);
      if (aborted) {
        this.counters.drafts += 1;
        return { report: this.report(reportID), cancelled: true };
      }
      this.counters.generated += 1;
      return { report: this.report(reportID), cancelled: false };
    } finally {
      if (flushTimer) clearInterval(flushTimer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      this._active = null;
    }
  }

  /**
   * 追问：报告 MD + 素材列表 + 追问拼上下文走 llm.complete（流式），
   * 问答对追加存 report_md 的「### 追问」区段。取消则不落库（返回 cancelled）。
   */
  async followUp(reportID, question, { onDelta = null, onStatus = null, signal = null } = {}) {
    const q = String(question || '').trim();
    if (!q) throw new Error(i18n.localized('请输入追问内容。'));
    if (q.length > 2000) throw new Error(i18n.localized('追问内容过长（最多 2000 字）。'));
    const report = this.report(reportID);
    if (!report) throw new Error(i18n.localized('报告不存在或已被删除。'));
    this._acquireLock();

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) { this._active = null; throw this._cancelledError(); }
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    this._active = { kind: 'followUp', controller };
    try {
      onStatus?.('followup');
      const { config, apiKey } = this.store._requireAIReady();
      const prompt = buildFollowUpPrompt(report, q);
      let answer = '';
      try {
        answer = await this.store.llm.complete({
          prompt,
          system: '你是一位严谨的中文研究助手，基于给定研究报告与素材列表回答读者的追问。输出简体中文 Markdown；如引用素材沿用其编号 [n]；报告与素材中没有的信息明确说明，不编造。',
          configuration: config,
          apiKey,
          onDelta: (delta) => onDelta?.(delta),
          signal: controller.signal,
          forceDisableReasoning: true,
          overrideTemperature: 0.3,
        });
      } catch (err) {
        if (controller.signal.aborted || String(err?.message || err) === 'cancelled') {
          return { report, cancelled: true };
        }
        throw err;
      }
      const updated = appendFollowUp(report, q, answer);
      const now = Date.now() / 1000;
      this.store.database.prepare(
        'UPDATE research_reports SET report_md=?, updated_at=? WHERE id=?'
      ).run(updated.reportMd, now, report.id);
      this.counters.followups += 1;
      return { report: this.report(report.id), answer, cancelled: false };
    } finally {
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      this._active = null;
    }
  }

  // MARK: - 历史

  /** 历史列表（新→旧）：含报告首行预览与素材数。 */
  listReports({ limit = LIST_LIMIT } = {}) {
    // 列表只需元数据：不拉全量 report_md/sources_json（多轮追问膨胀后 SELECT * 会拖慢列表）；
    // 排序走 updated_at 索引（v17 建在该列上）
    const rows = this.store.database.prepare(`
      SELECT id, topic, is_complete AS isComplete, created_at AS createdAt, updated_at AS updatedAt,
             (SELECT COUNT(*) FROM json_each(research_reports.sources_json)) AS sourceCount,
             substr(report_md, 1, 400) AS reportHead
      FROM research_reports ORDER BY updated_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(Number(limit) || LIST_LIMIT, 500)));
    return rows.map((row) => {
      const firstLine = String(row.reportHead || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';
      return {
        id: row.id, topic: row.topic, isComplete: Number(row.isComplete) === 1,
        sourceCount: Number(row.sourceCount) || 0, createdAt: row.createdAt, updatedAt: row.updatedAt,
        preview: firstLine.slice(0, 120),
      };
    });
  }

  report(id) {
    if (!id) return null;
    const row = this.store.database.prepare('SELECT * FROM research_reports WHERE id = ?').get(id);
    return row ? reportFromRow(row) : null;
  }

  deleteReport(id) {
    const info = this.store.database.prepare('DELETE FROM research_reports WHERE id = ?').run(id);
    return info.changes > 0;
  }

  // MARK: - 取消与锁

  /** 取消进行中的生成/追问（AbortSignal 通路）。空闲时返回 false。 */
  cancelActive() {
    if (!this._active) return false;
    this._active.controller.abort();
    return true;
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return { ...this.counters, running: Boolean(this._active), activeKind: this._active?.kind || null, materialCap: MATERIAL_CAP };
  }

  _acquireLock() {
    if (this._active) {
      throw new Error(i18n.localized('已有一项研究正在进行，请等它完成或先取消。'));
    }
  }

  _cancelledError() {
    const err = new Error('cancelled');
    err.name = 'CancelledError';
    return err;
  }
}

/** 报告提示词：结构化 Markdown + 引用编号硬约束（「只允许 [1]-[N]」随素材数内联）。 */
function buildReportPrompt(topic, materials) {
  const lines = materials.map((m, index) => {
    const src = m.source ? `（${m.source}）` : '';
    return `${index + 1}. 《${m.title}》${src}：${m.snippet || '（无摘要）'}`;
  });
  return [
    `研究主题：${topic}`,
    '',
    `以下是聚合到的 ${materials.length} 条素材（每条前的编号即其引用编号 [n]）：`,
    ...lines,
    '',
    '请就该主题写一份深度研究报告，严格输出以下 Markdown 结构（不要添加结构之外的标题）：',
    '## 背景',
    '两三段讲清这个主题是什么、为什么现在值得研究。',
    '## 核心发现',
    '4-8 条，每条以「- **加粗结论**」开头，后接 1-3 句展开，并在句末标注来源编号，如 [1][3]。',
    '## 分歧与争议',
    '素材中相互矛盾或立场不同的地方，1-3 条；没有则写「素材中未发现明显分歧」。',
    '## 结论',
    '两三句收束：当前最可信的判断与最不确定的部分。',
    '## 延伸阅读',
    '1-4 条最值得完整阅读的素材，每条一句推荐理由 + 来源编号。',
    '',
    `硬性要求：引用编号只允许 [1]-[${materials.length}]，不得出现素材列表之外的编号；只基于给定素材写作，禁止编造。`,
  ].join('\n');
}

/** 追问提示词：原报告全文 + 素材列表 + 追问。 */
function buildFollowUpPrompt(report, question) {
  const lines = (report.sources || []).map((m, index) => `${index + 1}. 《${m.title}》${m.source ? `（${m.source}）` : ''}`);
  return [
    `原始研究主题：${report.topic}`,
    '',
    '研究报告全文：',
    ArticleChunker.truncate(report.reportMd || '（空）', 24000),
    '',
    '素材列表（编号即引用编号）：',
    ...lines,
    '',
    `读者追问：${question}`,
    '',
    '请基于上述报告与素材回答；引用素材时沿用对应编号 [n]；没有依据的部分明确说明，不编造。',
  ].join('\n');
}

/** 问答对追加进 report_md 的「### 追问」区段（首次追加时补区段头）。 */
function appendFollowUp(report, question, answer) {
  const block = `**问：${question}**\n\n${answer.trim()}\n`;
  const md = String(report.reportMd || '');
  const section = '### 追问';
  if (md.includes(`\n${section}`) || md.startsWith(section)) {
    return { reportMd: `${md.replace(/\s*$/, '')}\n\n${block}` };
  }
  return { reportMd: `${md.replace(/\s*$/, '')}\n\n---\n\n${section}\n\n${block}` };
}

module.exports = {
  ResearchService,
  normalizeTitle,
  dedupeMaterials,
  buildReportPrompt,
  buildFollowUpPrompt,
  appendFollowUp,
  MATERIAL_CAP,
  SNIPPET_MAX,
};
