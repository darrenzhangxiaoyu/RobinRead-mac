'use strict';
/**
 * CourseService（知更）— 自学课程引擎（F30，有用档）
 *
 * 给一个学习目标，AI 从订阅库组装 7/14 天课程，每日「今日课」推进 + 进度 + 完成解锁：
 * - createCourse(goal, { days })：先本地召回——目标关键词扩展（lib/keywords 同源 +
 *   CJK 前缀滑窗）走 store.fullTextSearch（FTS5 trigram / LIKE 回退），限最近 180 天
 *   订阅文章、去重封顶 40 篇；召回为空 → 明确报错（不打 LLM）。LLM 依目标在候选里
 *   选文排 14 天（或 7 天）大纲：每天 1 主题要点 + 2-3 篇文章（entryIDs 引用候选）。
 *   合同容错照 QuizService：围栏/杂文/坏 JSON → invalidResponse 可重试；**LLM 编造的
 *   文章 ID 逐一对照候选表剔除**，剔空的天用未用候选确定性回填；天数越界钳制到
 *   days_total（LLM 返回 20 天只取前 14，缺的天自动补齐）。
 * - 存储 v26：courses（goal/plan_json/status/days_total）+ course_days（PK(course_id,day)
 *   即 UNIQUE；point/entry_ids_json/completed_at）。
 * - 每日推进（实现简单化——手动制，不做日历强制）：「今日课」= 最小的未完成天；
 *   completeDay 校验该天全部文章已读（article_states.is_read）才落 completed_at，
 *   完成后自动解锁下一天；全部天完成 → status='done'（惰性毕业）。
 * - 无 Key 降级：不做纯检索降级（大纲质量是功能核心）——明确报错「课程引擎需要
 *   AI Key」，渲染层创建按钮灰置（course:available）。
 * - 理解题联动（预留接口，未接线）：completeDay 返回 quizHook 字段标明当日首篇
 *   entryID，QuizService.generateQuiz 可对其出题；每日 1 题的小测合同（题目数、
 *   存储列、判分归课）留待后续批次，避免本轮在 quiz 表上做破坏性加列。
 *
 * 注入缝（探针）：_now 时钟可注入；_llmComplete 整路可换；召回走真库（灌数即所得）。
 */
const { nowSeconds, uuid } = require('./Models');
const { LLMServiceError } = require('./LLMService');
const { extractKeywords } = require('./lib/keywords');

/** 规则常量（召回/大纲/推进全部集中于此）。 */
const COURSE = {
  GOAL_MAX: 120,          // 目标文本上限
  DAYS_OPTIONS: [7, 14],  // 时长档位
  CANDIDATE_CAP: 40,      // 候选封顶
  RECALL_WINDOW_DAYS: 180,// 候选回看窗口
  ENTRIES_PER_DAY_MAX: 3, // 每天文章上限
  POINT_SLICE: 80,        // 要点落库截断
  GOAL_SLICE: 120,
  TITLE_SLICE: 120,
  KEYWORD_MAX: 4,         // 关键词扩展个数
  CAND_SUMMARY_SLICE: 60, // prompt 里候选摘要长度
};

function squash(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** 时长钳制：7/14 之外的入参归入最近合法档（0-10 → 7，其余 → 14）。 */
function clampDays(days) {
  const n = Number(days);
  if (COURSE.DAYS_OPTIONS.includes(n)) return n;
  if (!Number.isFinite(n) || n <= 0) return 14;
  return n <= 10 ? 7 : 14;
}

/**
 * 从 LLM 回包解析大纲（容错：```json 围栏 / 前后杂文 / 坏 JSON → null）。
 * 字段级校验（编造 ID 剔除/天数钳制）在 validateOutline——需要候选表。
 * @returns null | [{ point, entryIDs }]
 */
function parseOutlineRaw(text) {
  if (!text) return null;
  let raw = String(text).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
  const list = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.days) ? parsed.days : null);
  if (!list || !list.length) return null;
  return list;
}

class CourseService {
  constructor(store, { now = null } = {}) {
    this.store = store;
    this._now = now || (() => Date.now() / 1000); // 注入时钟（探针确定性）
    this._llmComplete = null;                     // 注入缝（探针 mock）
    this.counters = { created: 0, fabricatedDropped: 0, parseFailures: 0, completedDays: 0, graduated: 0, abandoned: 0, recallEmpty: 0 };
    const required = ['courses', 'course_days'];
    const missing = required.filter((t) => !this.store.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(t));
    if (missing.length) {
      throw new Error(`数据库 schema 缺少课程表（${missing.join(', ')}）：DatabaseMigrations v26 未执行`);
    }
  }

  now() { return this._now(); }

  /** AI 可用性（渲染层创建按钮灰置）。 */
  available() {
    return { ai: this.store.hasAIAPIKey() };
  }

  // MARK: 召回（订阅库最近 180 天 · 关键词扩展 ≤40 篇）

  /**
   * 关键词扩展：extractKeywords（F9/F13 同源显著词）+ CJK 目标的前缀滑窗
   * （整句 LIKE 零命中时短前缀兜底）。返回去重后的检索词数组。
   */
  expandKeywords(goal) {
    const words = [];
    const push = (w) => {
      const k = squash(w);
      if (k && k.length >= 2 && !words.includes(k)) words.push(k);
    };
    for (const w of extractKeywords(goal, COURSE.KEYWORD_MAX)) push(w);
    const clean = squash(goal);
    if (/[\u4e00-\u9fff]/.test(clean)) {
      push(clean.slice(0, 6)); // 中文长目标无分隔符时：前缀滑窗兜底
      push(clean.slice(0, 4));
    } else {
      push(clean.slice(0, 24));
    }
    return words.slice(0, COURSE.KEYWORD_MAX + 2);
  }

  /**
   * 候选召回：三路合并——①关键词 FTS（标题/摘要/正文）；②标签通道（article_tags
   * 双向包含：目标含标签 / 标签含关键词——中文长目标「三个月学会机器学习」的
   * 显著词截断常让 FTS 零命中，标签是库内现成的主题索引）；③空窗兜底=最近文章。
   * 180 天窗外与已删源全程过滤，封顶 40。
   */
  recallCandidates(goal) {
    const cutoff = this.now() - COURSE.RECALL_WINDOW_DAYS * 86400;
    const byID = new Map();
    const put = (item) => {
      if (byID.has(item.id)) return;
      if (item.publishedAt != null && item.publishedAt < cutoff) return; // 180 天窗外
      byID.set(item.id, item);
    };
    for (const kw of this.expandKeywords(goal)) {
      let hits = [];
      try { hits = this.store.fullTextSearch(kw, COURSE.CANDIDATE_CAP) || []; } catch (_) { hits = []; }
      for (const item of hits) {
        put(item);
        if (byID.size >= COURSE.CANDIDATE_CAP) return [...byID.values()];
      }
    }
    // ② 标签通道（双向包含；每关键词各查一次，索引友好）
    const entryCard = this.store.database.prepare(`
      SELECT i.id AS id, COALESCE(a.title, '') AS title, COALESCE(f.title, '') AS sourceTitle,
             a.published_at AS publishedAt, COALESCE(a.summary, '') AS summaryPreview
      FROM items i
      INNER JOIN articles a ON a.item_id = i.id
      INNER JOIN feeds f ON f.id = i.feed_id
      WHERE i.id = ? AND f.is_deleted = 0
    `);
    for (const kw of this.expandKeywords(goal)) {
      const key = squash(kw).slice(0, 12);
      if (!key) continue;
      let tagIDs = [];
      try {
        tagIDs = this.store.database.prepare(`
          SELECT DISTINCT at.item_id AS item_id FROM article_tags at
          WHERE instr(?, at.tag) > 0 OR at.tag LIKE ? ESCAPE '\\'
          LIMIT ?
        `).all(goal.slice(0, COURSE.GOAL_SLICE), `%${key.replace(/[%_\\]/g, (c) => '\\' + c)}%`, COURSE.CANDIDATE_CAP)
          .map((r) => r.item_id);
      } catch (_) { tagIDs = []; }
      for (const id of tagIDs) {
        const row = entryCard.get(id);
        if (row) put({ id: row.id, title: row.title, sourceTitle: row.sourceTitle, publishedAt: row.publishedAt, summaryPreview: row.summaryPreview });
        if (byID.size >= COURSE.CANDIDATE_CAP) return [...byID.values()];
      }
    }
    return [...byID.values()];
  }

  // MARK: 创建

  /**
   * 创建课程：召回 → LLM 大纲（mockable）→ 合同校验 → 落库。
   * 全部天校验通过才写库（中途失败零残留，可重试）。
   */
  async createCourse(goal, { days = 14 } = {}) {
    const cleanGoal = squash(goal).slice(0, COURSE.GOAL_SLICE);
    if (!cleanGoal) throw new Error('请先写下你的学习目标。');
    const daysTotal = clampDays(days);
    const ai = this.store._requireAIReady(); // 无 Key 抛 missingAPIKey（渲染层灰置兜底）
    const candidates = this.recallCandidates(cleanGoal);
    if (!candidates.length) {
      this.counters.recallEmpty += 1;
      throw new Error('订阅库最近 180 天里没有与目标相关的文章，先订阅或阅读一些相关内容再来。');
    }
    const lockKey = 'course:new';
    if (this.store.activeAICancellers.has(lockKey)) throw new LLMServiceError('requestInProgress');
    const canceller = { cancelled: false, controller: new AbortController() };
    this.store.activeAICancellers.set(lockKey, canceller);
    try {
      const raw = await this.llmComplete({ goal: cleanGoal, days: daysTotal, candidates }, ai, canceller.controller.signal);
      if (canceller.cancelled) throw new Error('已取消。');
      const list = parseOutlineRaw(raw);
      if (!list) {
        this.counters.parseFailures += 1;
        throw new LLMServiceError('invalidResponse'); // 坏输出：零残留，可重试
      }
      const outline = this.validateOutline(list, daysTotal, candidates);
      return this._persist(cleanGoal, daysTotal, outline);
    } finally {
      this.store.activeAICancellers.delete(lockKey);
    }
  }

  /**
   * 大纲合同校验：
   * - 天数越界钳制：LLM 多给（20 天）只取前 days_total，缺的天由未用候选确定性回填；
   * - 编造剔除：entryIDs 逐一对照候选表（LLM 编造的文章 ID 进不了课程），
   *   剔空的天用未用候选按序回填（候选耗尽才允许空文章天）；
   * - point 缺失 → 用目标拼默认要点。
   * @returns [{ point, entryIDs }]
   */
  validateOutline(list, daysTotal, candidates) {
    const candMap = new Map(candidates.map((c) => [c.id, c]));
    const used = new Set();
    const days = [];
    for (const item of list) {
      if (days.length >= daysTotal) break; // 越界钳制
      if (!item || typeof item !== 'object') continue;
      const point = squash(item.point || item.topic || item.title || '').slice(0, COURSE.POINT_SLICE);
      const ids = Array.isArray(item.entryIDs) ? item.entryIDs
        : (Array.isArray(item.entry_ids) ? item.entry_ids : []);
      const entryIDs = [];
      for (const id of ids) {
        const key = String(id || '');
        if (!key || entryIDs.includes(key)) continue;
        if (!candMap.has(key)) { this.counters.fabricatedDropped += 1; continue; } // 编造：剔除
        if (used.has(key)) continue; // 同篇文章不重复排课
        used.add(key);
        entryIDs.push(key);
        if (entryIDs.length >= COURSE.ENTRIES_PER_DAY_MAX) break;
      }
      days.push({ point, entryIDs });
    }
    // 未用候选按序回填（每天补 2 篇，直到排满或候选耗尽）
    let pool = candidates.filter((c) => !used.has(c.id)).map((c) => c.id);
    for (const day of days) {
      while (day.entryIDs.length < 2 && pool.length) {
        const id = pool.shift();
        if (!used.has(id)) { used.add(id); day.entryIDs.push(id); }
      }
    }
    // 缺天补齐（LLM 给少了）：要点默认化，候选耗尽允许 point-only 天
    const fallbackPoint = (n) => `自主研读（第 ${n} 天）：继续推进学习目标`;
    while (days.length < daysTotal) {
      const n = days.length + 1;
      const entryIDs = [];
      while (entryIDs.length < 2 && pool.length) {
        const id = pool.shift();
        if (!used.has(id)) { used.add(id); entryIDs.push(id); }
      }
      days.push({ point: fallbackPoint(n), entryIDs });
    }
    return days;
  }

  /** 落库：courses 行 + daysTotal 条 course_days（单事务，零残留语义）。 */
  _persist(goal, daysTotal, outline) {
    const courseID = uuid();
    const now = nowSeconds();
    this.store.database.transaction(() => {
      this.store.database.prepare(`
        INSERT INTO courses (id, goal, plan_json, status, days_total, error, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, NULL, ?, ?)
      `).run(courseID, goal, JSON.stringify({ candidates: outline.reduce((n, d) => n + d.entryIDs.length, 0), days: daysTotal, createdAt: now }), daysTotal, now, now);
      const insert = this.store.database.prepare(`
        INSERT INTO course_days (course_id, day, point, entry_ids_json, completed_at)
        VALUES (?, ?, ?, ?, NULL)
      `);
      outline.forEach((d, i) => {
        insert.run(courseID, i + 1, d.point || `第 ${i + 1} 天`, JSON.stringify(d.entryIDs));
      });
    });
    this.counters.created += 1;
    return this.get(courseID);
  }

  // MARK: LLM（可整路注入 mock）

  async llmComplete({ goal, days, candidates }, { config, apiKey }, signal = null) {
    if (this._llmComplete) return this._llmComplete({ goal, days, candidates }, { config, apiKey }, signal);
    const lines = candidates.map((c, i) => (
      `${i + 1}. id=${c.id} 《${String(c.title || '').slice(0, COURSE.TITLE_SLICE)}》 来源：${c.sourceTitle || ''} 摘要：${String(c.summaryPreview || '').slice(0, COURSE.CAND_SUMMARY_SLICE)}`
    )).join('\n');
    const prompt = [
      `学习目标：「${goal}」（课程时长 ${days} 天）。`,
      '以下是订阅库里可用的候选文章（id 必须原样引用，不许编造）：',
      lines,
      '',
      `请编排 ${days} 天课程：每天 1 个学习要点（point，一句话）+ 2-3 篇该天要读的文章（entryIDs，从上面候选里选）；`,
      '由浅入深、每天主题聚焦；同一篇文章只排一次。',
      `只输出 JSON：{"days":[{"point":"…","entryIDs":["…"]}]}，恰好 ${days} 天，不要输出任何其他文字。`,
    ].join('\n');
    return this.store.llm.complete({
      prompt,
      system: '你是严谨的自学课程编排师，只使用候选清单里真实存在的文章（id 原样引用），不编造、不重复排课，只输出 JSON，不输出其他内容。',
      configuration: config,
      apiKey,
      signal,
      forceDisableReasoning: true,
      overrideTemperature: 0.3,
    });
  }

  // MARK: 今日课与推进

  /** 进行中课程当前应学天（最小未完成天；全部完成 → 惰性毕业 status=done）。 */
  todayCourse(courseID) {
    const course = this.get(courseID);
    if (!course) throw new Error('课程不存在。');
    if (course.status === 'abandoned') return { course, finished: true, abandoned: true };
    const row = this.store.database.prepare(
      'SELECT * FROM course_days WHERE course_id = ? AND completed_at IS NULL ORDER BY day ASC LIMIT 1'
    ).get(course.id);
    if (!row) {
      if (course.status !== 'done') {
        this.store.database.prepare("UPDATE courses SET status = 'done', updated_at = ? WHERE id = ?").run(nowSeconds(), course.id);
        this.counters.graduated += 1;
      }
      return { course: this.get(courseID), finished: true };
    }
    const day = this._shapeDay(row);
    return {
      course: this.get(courseID),
      finished: false,
      today: { ...day, entries: this._entriesWithReadState(day.entryIDs) },
    };
  }

  _shapeDay(row) {
    let entryIDs = [];
    try { entryIDs = JSON.parse(row.entry_ids_json || '[]'); } catch (_) { entryIDs = []; }
    if (!Array.isArray(entryIDs)) entryIDs = [];
    return { day: row.day, point: row.point, entryIDs, completedAt: row.completed_at ?? null };
  }

  /** 文章卡（标题/来源/已读态——「读完回来自动勾选」的数据面）。 */
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
        title: String(row.title || '').slice(0, COURSE.TITLE_SLICE),
        sourceTitle: String(row.feed_title || ''),
        isRead: Number(row.is_read ?? 0) === 1,
      });
    }
    return out;
  }

  /**
   * 完成本日：day 必须是当前应学天（未完成天里最小者——解锁语义），
   * 且该天全部文章已读；通过 → completed_at 落库，全部完成 → 惰性毕业。
   * @returns {{ completed, day, progress, courseDone, quizHook }}
   */
  completeDay(courseID, day) {
    const course = this.get(courseID);
    if (!course) throw new Error('课程不存在。');
    if (course.status === 'abandoned') throw new Error('课程已放弃，无法继续打卡。');
    const row = this.store.database.prepare(
      'SELECT * FROM course_days WHERE course_id = ? AND day = ?'
    ).get(course.id, Number(day));
    if (!row) throw new Error('这一天不在课程大纲里。');
    if (row.completed_at != null) return { completed: true, alreadyDone: true, progress: this.progress(course.id) };
    const current = this.store.database.prepare(
      'SELECT day FROM course_days WHERE course_id = ? AND completed_at IS NULL ORDER BY day ASC LIMIT 1'
    ).get(course.id);
    if (!current || current.day !== Number(day)) {
      throw new Error('先完成前面的天，才能解锁这一天。'); // 手动推进的解锁闸
    }
    const dayShape = this._shapeDay(row);
    const unread = this._entriesWithReadState(dayShape.entryIDs).filter((e) => !e.isRead).length;
    if (unread > 0) {
      throw new Error(`这一天还有 ${unread} 篇文章没读完，读完才能打卡。`);
    }
    this.store.database.prepare('UPDATE course_days SET completed_at = ? WHERE course_id = ? AND day = ?')
      .run(nowSeconds(), course.id, Number(day));
    this.counters.completedDays += 1;
    const progress = this.progress(course.id);
    const courseDone = progress.completed >= course.daysTotal;
    if (courseDone) {
      this.store.database.prepare("UPDATE courses SET status = 'done', updated_at = ? WHERE id = ?").run(nowSeconds(), course.id);
      this.counters.graduated += 1;
    }
    return {
      completed: true,
      day: Number(day),
      progress,
      courseDone,
      // 理解题联动（预留接口）：当日首篇可交 QuizService.generateQuiz 出题；
      // 每日 1 题小测合同留待后续批次（见文件头注）。
      quizHook: dayShape.entryIDs[0] || null,
    };
  }

  /** 进度（进度条数据面）：完成天数 / days_total。 */
  progress(courseID) {
    const course = this.get(courseID);
    if (!course) throw new Error('课程不存在。');
    const done = this.store.database.prepare(
      'SELECT COUNT(*) AS n FROM course_days WHERE course_id = ? AND completed_at IS NOT NULL'
    ).get(course.id).n;
    return { completed: done, total: course.daysTotal, pct: course.daysTotal ? Math.round((done / course.daysTotal) * 100) : 0 };
  }

  // MARK: 读取 / 放弃 / 取消

  _shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      goal: row.goal,
      status: row.status,
      daysTotal: row.days_total,
      plan: (() => { try { return row.plan_json ? JSON.parse(row.plan_json) : null; } catch (_) { return null; } })(),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      progress: this._progressForRow(row),
      days: this._daysFor(row.id),
    };
  }

  _progressForRow(row) {
    const done = this.store.database.prepare(
      'SELECT COUNT(*) AS n FROM course_days WHERE course_id = ? AND completed_at IS NOT NULL'
    ).get(row.id).n;
    const total = row.days_total || 1;
    return { completed: done, total, pct: Math.round((done / total) * 100) };
  }

  _daysFor(courseID) {
    return this.store.database.prepare(
      'SELECT * FROM course_days WHERE course_id = ? ORDER BY day ASC'
    ).all(courseID).map((row) => {
      const day = this._shapeDay(row);
      return { ...day, entries: this._entriesWithReadState(day.entryIDs) };
    });
  }

  get(courseID) {
    return this._shape(this.store.database.prepare('SELECT * FROM courses WHERE id = ?').get(String(courseID || '')));
  }

  /** 课程列表（active 在前，组内新→旧；历史含 done/abandoned）。 */
  list() {
    const rows = this.store.database.prepare(
      "SELECT * FROM courses ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END ASC, created_at DESC"
    ).all();
    return rows.map((row) => this._shape(row));
  }

  /** 放弃（仅 active 可弃；历史保留）。 */
  abandon(courseID) {
    const course = this.get(courseID);
    if (!course) throw new Error('课程不存在。');
    if (course.status !== 'active') throw new Error('只有进行中的课程可以放弃。');
    this.store.database.prepare("UPDATE courses SET status = 'abandoned', updated_at = ? WHERE id = ?")
      .run(nowSeconds(), course.id);
    this.counters.abandoned += 1;
    return this.get(courseID);
  }

  cancelCreate() {
    this.store.cancelAI('course:new');
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return {
      ...this.counters,
      ...COURSE,
      total: this.store.database.prepare('SELECT COUNT(*) AS n FROM courses').get().n,
    };
  }
}

module.exports = {
  CourseService,
  COURSE,
  clampDays,
  parseOutlineRaw,
};
