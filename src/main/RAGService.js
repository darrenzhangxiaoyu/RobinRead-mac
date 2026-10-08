'use strict';
/**
 * RAGService（知更）— 全库 RAG 问答（F9）
 *
 * 「问知识库」的升级版：检索范围从高亮/笔记扩到全库全文（FTS5 + 正文缓存命中段），
 * 多轮会话持久化（v18 rag_sessions / rag_messages），回答带引用编号 [n] 可跳原文。
 *
 * 设计约束（对齐 F8 ResearchService 模式）：
 * - gatherRAG 不依赖 AI：FTS 文章路 / 知识库路 / 正文缓存路全本地；AIHOT 路失败静默跳过；
 * - 流式回答复用 llm.complete + onDelta + AbortSignal + 单飞锁（全会话共用一把）；
 * - 无 Key 降级：ask 在 gather 之后才查 Key——纯检索模式素材照常返回（UI 用
 *   rag:gather 通道展示「已找到 N 条相关素材」），LLM 缺 Key 抛明确错误；
 * - 性能红线：正文缓存检索先由 FTS 拿 entryID 限集（≤12），再在这些行的缓存里
 *   LIKE 命中 + instr 定位截窗——绝不全表 LIKE；
 * - 网络路（AIHOT）可注入替换（探针离线化：_aihotItemsImpl）。
 */
const { i18n } = require('./I18N');
const { randomUUID } = require('node:crypto');
// F13 抽取：显著词提取移入 lib/keywords 共享模块（SimilarService/线索聚类同源复用）。
// 此处原样再导出（module.exports 末尾），既有导入面（diag-f9-rag 等）零变化。
const { STOPWORDS, isCJK, normalizeTitle, extractKeywords } = require('./lib/keywords');

const ARTICLE_LIMIT = 12;      // FTS 相关度前 12（entryID 限集来源）
const KB_LIMIT = 8;            // 知识库高亮/笔记命中前 8
const BODY_SEG_LIMIT = 6;      // 正文缓存命中段最多 6
const BODY_WINDOW = 300;       // 命中点前后各 300 字截窗
const HOT_LIMIT = 6;           // AIHOT 可选路条数
const MATERIAL_CAP = 30;       // 素材总量上限
const SNIPPET_MAX = 300;       // 素材摘要上限（字）
const HISTORY_ROUNDS = 3;      // 会话内最近 3 轮 Q/A 拼上下文
const QUESTION_MAX = 2000;     // 问题长度上限
const TITLE_MAX = 40;          // 新会话标题 = 首问前 40 字
const RENAME_MAX = 120;        // 手动重命名上限
const HISTORY_MSG_CAP = 2000;  // 历史消息逐条截断（拼上下文时）
const SESSION_LIST_LIMIT = 100;
const FLUSH_INTERVAL_MS = 900; // 流式期间消息落库节流

/** 中英停用词/口语词（关键词提取时剔除——它们在正文里高频出现，LIKE 命中无意义）。 */
// F13 抽取：STOPWORDS / isCJK / normalizeTitle / extractKeywords 实现移至 lib/keywords.js，
// 本文件经顶部 require 引用同名绑定（dedupeMaterials/搜索路等调用点零改动）。

/** 素材条目归一：kind 白名单、snippet 截断（正文截窗素材上限 ±300×2，其余 300）、字段白名单。 */
function normalizeMaterial(m) {
  const cap = Math.max(SNIPPET_MAX, Math.min(Number(m.snippetCap) || SNIPPET_MAX, BODY_WINDOW * 2 + 2));
  return {
    kind: ['article', 'highlight', 'note', 'hot'].includes(m.kind) ? m.kind : 'article',
    title: String(m.title || '').slice(0, 500),
    source: String(m.source || '').slice(0, 200),
    snippet: String(m.snippet || '').replace(/\s+/g, ' ').trim().slice(0, cap),
    entryID: m.entryID ? String(m.entryID) : null,
    url: m.url ? String(m.url) : null,
  };
}

/** 素材去重（entryID+kind 优先；无 entryID 按 kind+标题归一）+ 总量截断。先到先得。 */
function dedupeMaterials(candidates) {
  const seen = new Set();
  const out = [];
  for (const raw of candidates) {
    const m = normalizeMaterial(raw);
    if (!m.title && !m.snippet) continue;
    const key = m.entryID ? `${m.kind}:${m.entryID}` : `${m.kind}:${normalizeTitle(m.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
    if (out.length >= MATERIAL_CAP) break;
  }
  return out;
}

/** 正文缓存检索语句（entryID 限集 + 关键词 LIKE 预筛）。探针用它做 EXPLAIN 断言。 */
function bodyCacheQuery(ids, keywords) {
  const placeholders = ids.map(() => '?').join(',');
  const likes = keywords.map(() => 'text LIKE ? ESCAPE \'\\\'').join(' OR ');
  return {
    sql: `SELECT item_id, text FROM article_caches WHERE item_id IN (${placeholders}) AND (${likes})`,
    params: [...ids, ...keywords.map((k) => `%${k.replace(/([%_\\])/g, '\\$1')}%`)],
  };
}

/** 行 → 会话 API 形态（messages 内 sources_json 解包，坏数据惰性化）。 */
function sessionFromRow(row, messageRows) {
  const messages = (messageRows || []).map((r) => {
    let sources = [];
    try { sources = JSON.parse(r.sources_json || '[]'); } catch (_) { /* 惰性 */ }
    if (!Array.isArray(sources)) sources = [];
    return {
      id: r.id,
      role: r.role === 'assistant' ? 'assistant' : 'user',
      content: r.content || '',
      sources,
      createdAt: r.created_at,
    };
  });
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages,
  };
}

class RAGService {
  constructor(store) {
    this.store = store;
    this.counters = { gathers: 0, asked: 0, cancelled: 0, bodyWindows: 0, aihotFailures: 0 };
    // 单飞锁：全会话共用——进行中的问答 { sessionID, controller }；null = 空闲
    this._active = null;
    // AIHOT 路可注入（探针离线化）：默认走真实通路
    this._aihotItemsImpl = async (q) => this.store.aihot.items({ q, window: '30d', limit: HOT_LIMIT });
  }

  // MARK: - 素材聚合（不依赖 AI）

  /**
   * 全库素材聚合：
   * ① FTS5 文章路（MATCH + bm25 相关度前 12，FTS 不可用回退 store.searchEntries LIKE）；
   * ② 知识库路（searchKnowledge 高亮/笔记前 8）；
   * ③ 正文缓存命中段（先 FTS 拿 entryID 限集，再在这些行的 article_caches 里
   *    LIKE 预筛 + instr 定位 ±300 字截窗，最多 6 段——命中段就地升级同文章素材的
   *    snippet，比摘要更贴问题）；
   * ④ AIHOT 路（失败静默跳过）。
   * 素材统一 {kind,title,source,snippet,entryID?,url?}，entryID+kind 去重，总量 ≤30。
   */
  async gatherRAG(question) {
    const q = String(question || '').trim();
    if (!q) throw new Error(i18n.localized('请输入你想问的问题。'));
    this.counters.gathers += 1;
    const keywords = extractKeywords(q);
    const candidates = [];

    // ① FTS 文章路
    let articleRows = [];
    try { articleRows = this._articleLaneFTS(q); } catch (_) { articleRows = []; }
    if (!articleRows.length) {
      try {
        articleRows = (this.store.searchEntries(q, { limit: ARTICLE_LIMIT }) || []).map((it) => ({
          entry_id: it.id, title: it.title, url: it.url,
          summary: it.summaryPreview || it.summary || '', source_name: it.sourceTitle || '',
        }));
      } catch (_) { articleRows = []; }
    }
    for (const r of articleRows) {
      candidates.push({
        kind: 'article', title: r.title || '', source: r.source_name || '',
        snippet: r.summary || '', url: r.url || null, entryID: r.entry_id || null,
      });
    }

    // ③ 正文缓存命中段：只在 ① 的 entryID 限集内找（性能红线：不做全表 LIKE）。
    // 命中段覆盖该文章素材的 snippet——正文中段命中比标题/摘要更贴问题。
    const entryIDs = articleRows.map((r) => r.entry_id).filter(Boolean);
    const bodyHits = this._bodyCacheSegments(entryIDs, keywords);
    this.counters.bodyWindows += bodyHits.length;
    for (const hit of bodyHits) {
      const existing = candidates.find((c) => c.kind === 'article' && c.entryID === hit.itemID);
      if (existing) { existing.snippet = hit.window; existing.snippetCap = BODY_WINDOW * 2 + 2; }
      else {
        // FTS 限集外（如 LIKE 回退路无 FTS snippet）：以命中段自成素材
        const meta = articleRows.find((r) => r.entry_id === hit.itemID) || {};
        candidates.push({
          kind: 'article', title: meta.title || '', source: meta.source_name || '',
          snippet: hit.window, snippetCap: BODY_WINDOW * 2 + 2, url: meta.url || null, entryID: hit.itemID,
        });
      }
    }

    // ② 知识库路：高亮/笔记命中（整句零命中时退显著词——口语化问题整句 LIKE 难命中）
    try {
      let kb = this.store.knowledge.searchKnowledge(q, { limit: KB_LIMIT }) || {};
      if (!kb.total) {
        for (const kw of keywords) {
          kb = this.store.knowledge.searchKnowledge(kw, { limit: KB_LIMIT }) || {};
          if (kb.total) break;
        }
      }
      const kbHits = [
        ...(kb.highlights || []).map((h) => ({ kind: 'highlight', title: h.articleTitle || h.text, source: h.articleTitle || '', snippet: h.text || '', entryID: h.itemID || null })),
        ...(kb.notes || []).map((n) => ({ kind: 'note', title: n.articleTitle || n.content, source: n.articleTitle || '', snippet: n.content || '', entryID: n.itemID || null })),
      ].slice(0, KB_LIMIT);
      for (const h of kbHits) candidates.push(h);
    } catch (_) { /* 知识库路失败不阻塞 */ }

    // ④ AIHOT 路：失败静默跳过（无网/不可用时本地路照常）
    try {
      const items = await this._aihotItemsImpl(q);
      for (const it of (Array.isArray(items) ? items : []).slice(0, HOT_LIMIT)) {
        candidates.push({
          kind: 'hot', title: it.title || '', source: it.source || 'AIHOT',
          snippet: it.summary || '', url: it.originalURL || it.url || null, entryID: null,
        });
      }
    } catch (_) { this.counters.aihotFailures += 1; }

    return { question: q, keywords, materials: dedupeMaterials(candidates) };
  }

  /**
   * FTS 文章路：trigram MATCH + bm25 相关度（标题列 8x 权重，F8 同款）。
   * 先整句短语匹配（区分度高）；零命中回退显著词 OR。snippet 取 body 列命中窗。
   */
  _articleLaneFTS(question) {
    const db = this.store.database;
    const hasFts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='articles_fts'").get();
    if (!hasFts) return [];
    const quoted = (s) => `"${String(s).replace(/"/g, '""')}"`;
    let rows = this._ftsQuery(quoted(question));
    if (!rows.length) {
      const keywords = extractKeywords(question);
      if (keywords.length > 1) rows = this._ftsQuery(keywords.map(quoted).join(' OR '));
    }
    return rows;
  }

  _ftsQuery(matchExpr) {
    return this.store.database.prepare(`
      SELECT i.id AS entry_id, IFNULL(a.title, '') AS title, a.url AS url,
             IFNULL(a.summary, '') AS summary, IFNULL(f.title, '') AS source_name,
             snippet(articles_fts, 4, '', '', '…', 60) AS body_snippet
      FROM articles_fts
      INNER JOIN items i ON i.id = articles_fts.item_id
      INNER JOIN feeds f ON f.id = i.feed_id AND f.is_deleted = 0
      LEFT JOIN articles a ON a.item_id = i.id
      WHERE articles_fts MATCH ?
      ORDER BY bm25(articles_fts, 1.0, 8.0, 1.0, 1.0, 0.6), COALESCE(a.published_at, i.created_at) DESC
      LIMIT ${ARTICLE_LIMIT}
    `).all(matchExpr).map((r) => ({
      ...r,
      // body 列命中时 FTS snippet 优于空摘要；summary 非空仍优先（更完整）
      summary: r.summary || r.body_snippet || '',
    }));
  }

  /**
   * 正文缓存命中段：entryID 限集内（≤12 行，主键 IN 查询）LIKE 预筛，
   * 再按问题词 instr（indexOf 同义）定位首个命中点，截 ±300 字窗。最多 6 段。
   */
  _bodyCacheSegments(entryIDs, keywords) {
    if (!entryIDs.length || !keywords.length) return [];
    const { sql, params } = bodyCacheQuery(entryIDs.slice(0, ARTICLE_LIMIT), keywords);
    let rows = [];
    try { rows = this.store.database.prepare(sql).all(...params); } catch (_) { return []; }
    const out = [];
    for (const row of rows) {
      const text = String(row.text || '');
      if (!text) continue;
      let hit = -1;
      for (const kw of keywords) {
        const idx = text.indexOf(kw);
        if (idx >= 0) { hit = idx; break; }
      }
      if (hit < 0) continue;
      const start = Math.max(0, hit - BODY_WINDOW);
      const end = Math.min(text.length, hit + BODY_WINDOW);
      out.push({
        itemID: row.item_id,
        window: (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : ''),
      });
      if (out.length >= BODY_SEG_LIMIT) break;
    }
    return out;
  }

  // MARK: - 问答（流式 + 可取消 + 单飞锁 + 多轮会话）

  /**
   * 提问。无 sessionID 自动新建会话（标题=首问前 40 字）；有则校验存在。
   * 流式分片经 onDelta 推送；阶段经 onStatus('gather'|'generate') 推送。
   * 取消（signal/cancelActive）→ 已收到部分照存 assistant 消息（未完成语义），
   * 返回 { ..., cancelled: true } 不按错误抛出。
   * 无 Key：gather 照常执行（纯检索不依赖 AI），随后抛 missingAPIKey——纯检索
   * 素材经 rag:gather 通道单独获取（IPC 信封不携带错误附加字段）。
   */
  async ask(sessionID, question, { onDelta = null, onStatus = null, signal = null } = {}) {
    const q = String(question || '').trim();
    if (!q) throw new Error(i18n.localized('请输入你想问的问题。'));
    if (q.length > QUESTION_MAX) throw new Error(i18n.localized('问题内容过长（最多 2000 字）。'));
    this._acquireLock();

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) { this._active = null; throw this._cancelledError(); }
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    this._active = { kind: 'ask', sessionID: sessionID || null, controller };

    let flushTimer = null;
    const db = this.store.database;
    try {
      onStatus?.('gather');
      const { materials } = await this.gatherRAG(q);
      // gather 之后才查 Key：纯检索路径不依赖 AI（无 Key 的错误向上抛，素材可用 rag:gather 获取）
      const ai = this.store._requireAIReady();

      // 会话：新建或校验
      let session = sessionID ? this.session(sessionID) : null;
      if (sessionID && !session) throw new Error(i18n.localized('会话不存在或已被删除。'));
      const now = Date.now() / 1000;
      if (!session) {
        const id = randomUUID();
        db.prepare('INSERT INTO rag_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
          .run(id, q.slice(0, TITLE_MAX), now, now);
        session = { id, title: q.slice(0, TITLE_MAX), messages: [] };
      }
      const history = this._recentHistory(session.id, HISTORY_ROUNDS);

      // user 消息落库 + assistant 占位行（sources_json 先行落素材，流式只更新 content）
      db.prepare('INSERT INTO rag_messages (id, session_id, role, content, sources_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), session.id, 'user', q, '[]', now);
      const assistantID = randomUUID();
      db.prepare('INSERT INTO rag_messages (id, session_id, role, content, sources_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(assistantID, session.id, 'assistant', '', JSON.stringify(materials), now);

      onStatus?.('generate');
      const prompt = buildRAGPrompt(q, materials, history);
      let streamed = '';
      // 流式期间节流落库：进程意外退出时已流部分最多丢一个节流窗
      const updateRow = () => db.prepare('UPDATE rag_messages SET content = ? WHERE id = ?').run(streamed, assistantID);
      flushTimer = setInterval(updateRow, FLUSH_INTERVAL_MS);
      let aborted = false;
      try {
        streamed = await this.store.llm.complete({
          prompt,
          system: '你是一位严谨的中文问答助手，只依据给定的全库检索素材回答读者问题。输出简体中文 Markdown，语言精炼、分点清晰；引用编号必须只使用素材列表中真实存在的编号；素材中没有的信息明确说明，不编造。',
          configuration: ai.config,
          apiKey: ai.apiKey,
          onDelta: (delta) => { streamed += delta; onDelta?.(delta); },
          signal: controller.signal,
          forceDisableReasoning: true,
          overrideTemperature: 0.3,
        });
      } catch (err) {
        if (controller.signal.aborted || String(err?.message || err) === 'cancelled') aborted = true;
        else {
          clearInterval(flushTimer); flushTimer = null;
          updateRow(); // 失败前已流到的部分也照存（与取消同语义）
          this._touchSession(session.id);
          throw err;
        }
      }
      clearInterval(flushTimer); flushTimer = null;
      updateRow();
      this._touchSession(session.id);
      if (aborted) {
        this.counters.cancelled += 1;
        return { sessionID: session.id, sessionTitle: session.title, messageID: assistantID, content: streamed, materials, cancelled: true };
      }
      this.counters.asked += 1;
      return { sessionID: session.id, sessionTitle: session.title, messageID: assistantID, content: streamed, materials, cancelled: false };
    } finally {
      if (flushTimer) clearInterval(flushTimer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      this._active = null;
    }
  }

  /** 会话内最近 N 轮 Q/A（时间升序），供多轮上下文。空内容行跳过。 */
  _recentHistory(sessionID, rounds) {
    const rows = this.store.database.prepare(`
      SELECT role, content FROM rag_messages
      WHERE session_id = ? AND TRIM(content) != ''
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(sessionID, rounds * 2).reverse();
    return rows.map((r) => ({
      role: r.role,
      content: String(r.content || '').slice(0, HISTORY_MSG_CAP),
    }));
  }

  // MARK: - 会话管理

  /** 会话列表（新→旧）：只取元数据，不拉消息。 */
  listSessions({ limit = SESSION_LIST_LIMIT } = {}) {
    return this.store.database.prepare(`
      SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
      FROM rag_sessions ORDER BY updated_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(Number(limit) || SESSION_LIST_LIMIT, 500)));
  }

  /** 重开会话：元数据 + 消息流（assistant 消息带 sources 解包）。 */
  session(id) {
    if (!id) return null;
    const row = this.store.database.prepare('SELECT * FROM rag_sessions WHERE id = ?').get(id);
    if (!row) return null;
    const messages = this.store.database.prepare(
      'SELECT id, role, content, sources_json, created_at FROM rag_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC'
    ).all(id);
    return sessionFromRow(row, messages);
  }

  deleteSession(id) {
    const db = this.store.database;
    db.prepare('DELETE FROM rag_messages WHERE session_id = ?').run(id);
    const info = db.prepare('DELETE FROM rag_sessions WHERE id = ?').run(id);
    return info.changes > 0;
  }

  renameSession(id, title) {
    const t = String(title || '').trim();
    if (!t) throw new Error(i18n.localized('请输入会话标题。'));
    if (t.length > RENAME_MAX) throw new Error(i18n.localized('标题过长（最多 120 字）。'));
    const info = this.store.database.prepare('UPDATE rag_sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(t, Date.now() / 1000, id);
    if (info.changes === 0) throw new Error(i18n.localized('会话不存在或已被删除。'));
    return this.session(id);
  }

  /** 某条 assistant 消息的素材 JSON（渲染层重开/深链时按需取）。 */
  sources(messageID) {
    if (!messageID) return [];
    const row = this.store.database.prepare('SELECT sources_json FROM rag_messages WHERE id = ?').get(messageID);
    try {
      const parsed = JSON.parse(row?.sources_json || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }

  // MARK: - 取消与锁

  /** 取消进行中的问答（AbortSignal 通路）。空闲时返回 false。 */
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
      throw new Error(i18n.localized('已有一个问答正在进行，请等它完成或先取消。'));
    }
  }

  _touchSession(id) {
    try {
      this.store.database.prepare('UPDATE rag_sessions SET updated_at = ? WHERE id = ?').run(Date.now() / 1000, id);
    } catch (_) { /* 会话已被删：不阻塞回答返回 */ }
  }

  _cancelledError() {
    const err = new Error('cancelled');
    err.name = 'CancelledError';
    return err;
  }
}

/** 问答提示词：素材列表（编号即引用）+ 最近对话 + 问题 + 引用编号硬约束。 */
function buildRAGPrompt(question, materials, history = []) {
  const lines = materials.map((m, index) => {
    const src = m.source ? `（${m.source}）` : '';
    return `${index + 1}. 《${m.title}》${src}：${m.snippet || '（无摘要）'}`;
  });
  const parts = [
    `以下是检索到的 ${materials.length} 条全库素材（每条前的编号即其引用编号 [n]）：`,
    ...lines,
  ];
  if (history.length) {
    parts.push('', '最近对话（仅供理解本轮问题的语境）：');
    for (const h of history) {
      parts.push(`${h.role === 'user' ? '用户' : '助手'}：${h.content}`);
    }
  }
  parts.push(
    '',
    `问题：${question}`,
    '',
    '请基于素材回答，严格遵循：',
    '- 用到某条素材时在句末标注其编号，如 [1][3]',
    '- 素材不足以回答的部分明确说「素材中未找到」，禁止编造',
    '- 直接给答案，Markdown 分点清晰，不要复述素材原文',
    `硬性要求：引用编号只允许 [1]-[${materials.length}]，不得出现素材列表之外的编号。`,
  );
  return parts.join('\n');
}

module.exports = {
  RAGService,
  extractKeywords,
  normalizeTitle,
  dedupeMaterials,
  buildRAGPrompt,
  bodyCacheQuery,
  MATERIAL_CAP,
  SNIPPET_MAX,
  BODY_SEG_LIMIT,
  BODY_WINDOW,
  ARTICLE_LIMIT,
  KB_LIMIT,
  HISTORY_ROUNDS,
  // F13 起实现驻 lib/keywords：再导出保持既有导入面（extractKeywords/normalizeTitle 等）稳定
  STOPWORDS,
  isCJK,
};
