'use strict';
/**
 * QuizService（知更）— 读后点亮测验（F26，有趣+有用档）
 *
 * 读完 AI 出 3 道理解单选题，答对点亮知识图谱节点，错题自动变 SM-2 复习卡：
 * - generateQuiz：LLM 依正文出 3 道单选（4 选项 + 正确项下标 + 一句话解析），
 *   JSON 合同 + 容错解析（照 PerspectiveService 惯例：围栏/前后杂文/非法选项数
 *   → 剔除该题；全无效 → null 不落库可重试）；
 * - 存储 v24：quizzes 表——一篇可重测（每次新行），保留全部历史，
 *   最高分 = MAX(score)，最近一次 = created_at DESC（读取侧投影）；
 * - 点亮：得分 ≥ PASS_SCORE（2/3）→ 该文既有标签落 quiz_lights（tag/entry_id，
 *   PK 防重），知识图谱渲染时与 article_tags 投影合并（getGraphData.lit）；
 * - 错题 → SM-2 复习卡进既有复习管线（KnowledgeEngine.addToReview 后补
 *   source='quiz' + quiz_json 题面快照，复习面板照常翻转评分）；
 * - 单飞（同篇在途不重复生成，key=`quiz:<entryID>`）+ 可取消；无 Key 灰置。
 *
 * 注入防护：文章内容进 prompt 前截断（≤ CONTENT_SLICE 字）并包裹
 * <article>…</article> 分隔标记。注入缝（探针 mock）：_llmComplete 整路可换。
 */
const { nowSeconds, uuid } = require('./Models');
const { LLMServiceError } = require('./LLMService');

/** 规则常量（出题/评分/点亮全部集中于此）。 */
const QUIZ = {
  QUESTION_COUNT: 3,     // 每次出题数
  OPTIONS: 4,            // 每题选项数
  PASS_SCORE: 2,         // ≥2/3 点亮该文标签
  CONTENT_SLICE: 4000,   // 文章内容进 prompt 前截断（注入防护合同）
  Q_SLICE: 240,          // 题干落库截断
  OPT_SLICE: 120,        // 选项落库截断
  EXPLAIN_SLICE: 200,    // 解析落库截断
  TITLE_SLICE: 120,      // 标题截断
};

/**
 * 从 LLM 回包解析题目数组（容错：```json 围栏 / 前后杂文 / 坏 JSON /
 * 非法选项数 / 越界 answer → 剔除该题）。一题都剩不下 → null（不落库可重试）。
 * @returns null | [{q, options:[4], answer, explain}]
 */
function parseQuizPayload(text) {
  if (!text) return null;
  let raw = String(text).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.questions) ? parsed.questions : null);
  if (!list || !list.length) return null;
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const q = String(item.q || item.question || '').replace(/\s+/g, ' ').trim().slice(0, QUIZ.Q_SLICE);
    if (!q) continue;
    if (!Array.isArray(item.options) || item.options.length !== QUIZ.OPTIONS) continue; // 非法选项数：剔题
    const options = item.options.map((o) => String(o || '').replace(/\s+/g, ' ').trim().slice(0, QUIZ.OPT_SLICE));
    if (options.some((o) => !o)) continue; // 空选项：剔题
    const answer = Number(item.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer >= QUIZ.OPTIONS) continue; // 越界答案：剔题
    const explain = String(item.explain || '').replace(/\s+/g, ' ').trim().slice(0, QUIZ.EXPLAIN_SLICE);
    out.push({ q, options, answer, explain });
    if (out.length >= QUIZ.QUESTION_COUNT) break;
  }
  return out.length ? out : null;
}

class QuizService {
  constructor(store, { now = null } = {}) {
    this.store = store;
    this._now = now || (() => Date.now() / 1000);
    this._llmComplete = null; // 注入缝（探针 mock）
    this._runningEntryID = null;
    this.counters = { generated: 0, submitted: 0, lights: 0, reviewAdded: 0, parseFailures: 0, cancelled: 0 };
    const required = ['quizzes', 'quiz_lights'];
    const missing = required.filter((t) => !this.store.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(t));
    if (missing.length) {
      throw new Error(`数据库 schema 缺少测验表（${missing.join(', ')}）：DatabaseMigrations v24 未执行`);
    }
  }

  now() { return this._now(); }

  /** AI 可用性（渲染层按钮灰置）。 */
  available() {
    return { ai: this.store.hasAIAPIKey() };
  }

  // MARK: 出题

  /**
   * 出 3 道理解题（新建一行——重测允许，历史行保留最高分投影）。
   * 单飞：同篇在途再次调用 → requestInProgress。
   */
  async generateQuiz(entryID) {
    const id = String(entryID || '');
    if (!id) throw new Error('文章不存在或已被清理。');
    const lockKey = `quiz:${id}`;
    if (this._runningEntryID === id || this.store.activeAICancellers.has(lockKey)) {
      throw new LLMServiceError('requestInProgress');
    }
    const ai = this.store._requireAIReady(); // 无 Key 抛 missingAPIKey（渲染层灰置兜底）
    const { title, articleText } = this._articleContext(id);
    const quizID = uuid();
    this.store.database.prepare(`
      INSERT INTO quizzes (id, entry_id, questions_json, score, answered_at, created_at)
      VALUES (?, ?, '[]', NULL, NULL, ?)
    `).run(quizID, id, nowSeconds());
    const canceller = { cancelled: false, controller: new AbortController() };
    this.store.activeAICancellers.set(lockKey, canceller);
    this._runningEntryID = id;
    try {
      const raw = await this.llmComplete({ entryID: id, title, articleText }, ai, canceller.controller.signal);
      if (canceller.cancelled) {
        this.counters.cancelled += 1;
        return this.get(quizID);
      }
      const questions = parseQuizPayload(raw);
      if (!questions) {
        this.counters.parseFailures += 1;
        throw new LLMServiceError('invalidResponse'); // 坏输出：行保留（questions=[]），可重试
      }
      this.store.database.prepare('UPDATE quizzes SET questions_json = ? WHERE id = ?')
        .run(JSON.stringify(questions), quizID);
      this.counters.generated += 1;
      return this.get(quizID);
    } catch (err) {
      if (canceller.cancelled || String((err && err.message) || '').includes('cancelled')) {
        this.counters.cancelled += 1;
        return this.get(quizID);
      }
      throw err;
    } finally {
      this.store.activeAICancellers.delete(lockKey);
      this._runningEntryID = null;
    }
  }

  // MARK: 作答与点亮

  /**
   * 提交作答：判分回填 → 达标点亮 → 错题入复习队列。
   * @returns {{ score, total, passed, litTags, reviewAdded, results }}
   */
  submit(quizID, answers) {
    const row = this.store.database.prepare('SELECT * FROM quizzes WHERE id = ?').get(String(quizID || ''));
    if (!row) throw new Error('测验不存在。');
    let questions = [];
    try { questions = JSON.parse(row.questions_json || '[]'); } catch (_) { questions = []; }
    if (!Array.isArray(questions) || !questions.length) throw new Error('这套卷子还没有题目，请重新生成。');
    const picks = Array.isArray(answers) ? answers : [];
    const results = [];
    const wrong = [];
    let score = 0;
    questions.forEach((q, i) => {
      const picked = Number(picks[i]);
      const correct = Number.isInteger(picked) && picked === q.answer;
      if (correct) score += 1; else wrong.push({ q, index: i });
      results.push({ index: i, picked: Number.isInteger(picked) ? picked : null, correct, answer: q.answer, explain: q.explain || '' });
    });
    this.store.database.prepare('UPDATE quizzes SET score = ?, answered_at = ? WHERE id = ?')
      .run(score, nowSeconds(), row.id);
    this.counters.submitted += 1;

    // ── 点亮：≥ PASS_SCORE → 该文既有标签落 quiz_lights（PK 防重）──
    let litTags = [];
    if (score >= QUIZ.PASS_SCORE) {
      const tags = this.store.database.prepare('SELECT DISTINCT tag FROM article_tags WHERE item_id = ?')
        .all(row.entry_id).map((r) => String(r.tag || '').trim()).filter(Boolean);
      const insert = this.store.database.prepare(
        'INSERT OR IGNORE INTO quiz_lights (tag, entry_id, created_at) VALUES (?, ?, ?)'
      );
      for (const tag of tags) {
        const info = insert.run(tag, row.entry_id, nowSeconds());
        if (info.changes > 0) litTags.push(tag);
      }
      this.counters.lights += litTags.length;
    }

    // ── 错题 → SM-2 复习卡（既有管线，来源标记 quiz + 题面快照）──
    let reviewAdded = 0;
    for (const { q } of wrong) {
      try {
        const cardID = this.store.knowledge.addToReview({ itemID: row.entry_id });
        this.store.database.prepare(
          "UPDATE review_queue SET source = 'quiz', quiz_json = ? WHERE id = ?"
        ).run(JSON.stringify({
          q: q.q, options: q.options, answer: q.answer, explain: q.explain || '', quizID: row.id,
        }), cardID);
        reviewAdded += 1;
      } catch (_) { /* 单题入队失败不阻塞判分回显 */ }
    }
    this.counters.reviewAdded += reviewAdded;

    return {
      quizID: row.id,
      score,
      total: questions.length,
      passed: score >= QUIZ.PASS_SCORE,
      litTags,
      reviewAdded,
      results,
      best: this.bestScore(row.entry_id),
    };
  }

  // MARK: 投影

  _shape(row) {
    if (!row) return null;
    let questions = [];
    try { questions = JSON.parse(row.questions_json || '[]'); } catch (_) { questions = []; }
    if (!Array.isArray(questions)) questions = [];
    return {
      id: row.id,
      entryID: row.entry_id,
      questions,
      score: row.score,
      answeredAt: row.answered_at,
      createdAt: row.created_at,
      best: this.bestScore(row.entry_id),
    };
  }

  get(quizID) {
    return this._shape(this.store.database.prepare('SELECT * FROM quizzes WHERE id = ?').get(String(quizID || '')));
  }

  /** 最近一次测验（读后重开；无则 null）。 */
  latest(entryID) {
    const row = this.store.database.prepare(
      'SELECT * FROM quizzes WHERE entry_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
    ).get(String(entryID || ''));
    return this._shape(row);
  }

  /** 历史最高分（保留最高分语义；从未作答为 null）。 */
  bestScore(entryID) {
    const row = this.store.database.prepare(
      'SELECT MAX(score) AS best FROM quizzes WHERE entry_id = ?'
    ).get(String(entryID || ''));
    return row && row.best != null ? Number(row.best) : null;
  }

  /** 点亮标签全集（图谱合并投影数据面）。 */
  litTags() {
    return this.store.database.prepare('SELECT DISTINCT tag FROM quiz_lights').all().map((r) => r.tag);
  }

  cancel(entryID) {
    this.store.cancelAI(`quiz:${String(entryID || '')}`);
  }

  // MARK: 内部

  _articleContext(entryID) {
    const entry = this.store.articlesRepo.entry(entryID);
    if (!entry) throw new Error('文章不存在或已被清理。');
    const cache = this.store.cachesRepo.cache(entryID);
    const articleText = this.store._entrySourceText(entry, cache).replace(/\s+/g, ' ').trim();
    return {
      title: String(entry.title || '').slice(0, QUIZ.TITLE_SLICE),
      articleText: articleText.slice(0, QUIZ.CONTENT_SLICE),
    };
  }

  /** 文章块（注入防护合同：截断 + 分隔标记，与 F25 同口径）。 */
  static articleBlock(articleText) {
    return `<article>\n${articleText}\n</article>`;
  }

  /** LLM 出题。可整路注入（探针 mock）。 */
  async llmComplete({ entryID, title, articleText }, { config, apiKey }, signal = null) {
    if (this._llmComplete) return this._llmComplete({ entryID, title, articleText }, { config, apiKey }, signal);
    const prompt = [
      QuizService.articleBlock(articleText),
      '',
      `文章标题：《${title}》。请依据上述原文出 ${QUIZ.QUESTION_COUNT} 道阅读理解单选题：`,
      `- 每题 ${QUIZ.OPTIONS} 个选项（options 数组），恰好 1 个正确；`,
      '- answer 为正确选项的下标（0 起）；explain 用一句话点破考点（不超过 40 字）；',
      '- 只考原文给过的信息，不考标题党联想，不出的太容易。',
      `只输出 JSON：{"questions":[{"q":"题干","options":["A","B","C","D"],"answer":0,"explain":"…"}]}，不要输出任何其他文字。`,
    ].join('\n');
    return this.store.llm.complete({
      prompt,
      system: '你是严谨的中文阅读理解出题人，只依据 <article> 标签内的原文出题，不编造原文没有的信息，只输出 JSON，不输出其他内容。',
      configuration: config,
      apiKey,
      signal,
      forceDisableReasoning: true,
      overrideTemperature: 0.2,
    });
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return { ...this.counters, ...QUIZ, running: this._runningEntryID };
  }
}

module.exports = {
  QuizService,
  QUIZ,
  parseQuizPayload,
};
