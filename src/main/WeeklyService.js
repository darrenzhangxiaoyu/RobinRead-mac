'use strict';
/**
 * WeeklyService（知更）— AI 周刊编辑部（F29，有用档）
 *
 * 每周一自动把上周阅读编成《知更周刊》：AI 导语 + 主题板块归纳 + 金句摘录，
 * 报纸版面呈现，可导出 EPUB。
 * - generateWeek(weekStart)：聚合上周（周一 00:00 ~ 周日 24:00，本地时区）阅读数据
 *   （完读文章 + 标题 + 来源 + 标签 + 批注摘选，走 article_states.updated_at 读时窗）；
 *   LLM 生成版面 JSON 合同 + 容错解析（照 QuizService 惯例：围栏/前后杂文/坏 JSON →
 *   null；板块 entryIDs 不在聚合窗口内 → 剔除；金句逐字校验——原句必须在文章
 *   摘要/正文缓存里找得到，编造的金句出局）；
 * - 无 Key 降级：纯模板版面（标签聚合 + 完读排行 + 本周批注金句，零 AI）；
 * - 存储 v26：weeklies（week_start UNIQUE 防重；generating|ready|failed）；
 *   生成中可取消（activeAICancellers 惯例 key=`weekly:<weekStart>`），失败可重试；
 * - 自动触发：AppStore 刷新完成钩子 → autoCheck()：周一且上周刊未生成才起后台
 *   生成，偏好键按周节流（一周只尝试一次，失败不自动重试）；完成 emit
 *   'weekly:changed'（渲染层 toast 兜底，静默不打扰）；
 * - 导出：buildEpub 走 EpubBuilder.buildBookEpub 通路（书名=知更周刊第 N 期，
 *   板块=分章，金句=末章），写盘由 ipc 层保存对话框承接（BooksService 同款先例）。
 *
 * 注入缝（探针）：_now 时钟可注入（窗口/周一判定确定性）；_llmComplete 整路可换。
 */
const { nowSeconds, uuid } = require('./Models');
const { LLMServiceError } = require('./LLMService');
const EpubBuilder = require('./EpubBuilder');

/** 规则常量（窗口/版面/截断全部集中于此）。 */
const WEEKLY = {
  NAME: '知更周刊',
  INTRO_MAX: 200,        // 导语字数上限
  SECTION_MAX: 4,        // 主题板块上限
  SECTION_ENTRIES_MAX: 6,// 单板块入选文章上限
  QUOTES_MAX: 5,         // 金句上限
  QUOTE_MIN: 3,          // AI 版金句下限（不足按实际收录）
  READ_CAP: 120,         // 聚合窗口完读文章上限
  ANNOT_CAP: 30,         // 批注摘选上限
  TITLE_SLICE: 120,
  SUMMARY_SLICE: 240,    // 聚合侧摘要参与 LLM 的长度
  QUOTE_SLICE: 160,      // 金句落库截断
  ANNOT_SLICE: 200,      // 批注摘选截断
  BODY_SEARCH_SLICE: 20000, // 金句逐字校验的正文搜索窗（缓存 text 前段）
};

// MARK: - 日期工具（本地时区；探针注入秒级时钟）

/** 本地日期键 YYYY-MM-DD。 */
function localDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 日期字符串 → 该日本地 00:00 的秒级时间戳（非法返回 null）。 */
function localDayStart(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime()) || localDayKey(d) !== String(dayKey)) return null;
  return Math.floor(d.getTime() / 1000);
}

/** 某时刻所在周的周一（本地时区）日期键。 */
function mondayOf(nowSec) {
  const d = new Date(Number(nowSec) * 1000);
  const shift = (d.getDay() + 6) % 7; // 周一=0 … 周日=6
  d.setDate(d.getDate() - shift);
  return localDayKey(d);
}

/** 某时刻的「上一周」周一起点（每周一自动刊 = 上周阅读）。
 *  日历运算而非 epoch 减 7*86400（批 E 审查 P2：DST 春令时周会算出周日 23:00 → 键变周日 → 全年缺刊）。 */
function lastWeekStart(nowSec) {
  const thisMonday = mondayOf(nowSec);
  const start = localDayStart(thisMonday);
  const d = new Date(start * 1000);
  d.setDate(d.getDate() - 7); // 本地日历减 7 天，DST 安全
  return localDayKey(d);
}

function isMondayKey(dayKey) {
  const start = localDayStart(dayKey);
  if (start == null) return false;
  return new Date(start * 1000).getDay() === 1;
}

/** 版面文本净化：折叠空白（落库与逐字比对同口径）。 */
function squash(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * 从 LLM 回包解析版面合同（容错：```json 围栏 / 前后杂文 / 坏 JSON → null；
 * 字段级合同校验在 parseWeeklyPayload——需要聚合窗口数据做存在性/逐字校验）。
 * @returns null | { intro, sections, quotes }
 */
function parseWeeklyRaw(text) {
  if (!text) return null;
  let raw = String(text).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const quotes = Array.isArray(parsed.quotes) ? parsed.quotes : [];
  return {
    intro: typeof parsed.intro === 'string' ? parsed.intro : '',
    sections,
    quotes,
  };
}

class WeeklyService {
  constructor(store, { now = null } = {}) {
    this.store = store;
    this._now = now || (() => Date.now() / 1000); // 注入时钟（探针确定性）
    this._llmComplete = null;                     // 注入缝（探针 mock）
    this.counters = { generated: 0, template: 0, parseFailures: 0, cancelled: 0, autoKicks: 0, autoSkips: 0, exports: 0 };
    const required = ['weeklies'];
    const missing = required.filter((t) => !this.store.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(t));
    if (missing.length) {
      throw new Error(`数据库 schema 缺少周刊表（${missing.join(', ')}）：DatabaseMigrations v26 未执行`);
    }
    // 崩溃/硬失败清扫（批 E 审查 P1）：generating 行卡死则该周期数永久不可生成不可重试
    try {
      this.store.database.prepare(
        "UPDATE weeklies SET status = 'failed', error = '上次中断，可重试', updated_at = ? WHERE status = 'generating'"
      ).run(this._now());
    } catch (_) { /* 表异常静默：与上方 schema 校验互斥 */ }
  }

  now() { return this._now(); }

  /** AI 可用性（渲染层「AI 版式/模板版式」提示与灰置）。 */
  available() {
    return { ai: this.store.hasAIAPIKey() };
  }

  // MARK: 聚合（上周阅读窗口）

  /**
   * 聚合某周（weekStart=周一）的阅读数据面：完读文章（读时窗=article_states.updated_at
   * 落在窗口内）+ 标签 + 来源 + 本周批注摘选。零 AI，纯 SQL。
   */
  weekData(weekStart) {
    const start = localDayStart(weekStart);
    if (start == null) throw new Error('周刊周期无效（需要 YYYY-MM-DD 的周一）。');
    // 窗口终点走日历运算（批 E 审查 P2 同根：epoch +7*86400 在 DST 周会 ±3600s 截尾/漏读）
    const endCal = new Date(start * 1000);
    endCal.setDate(endCal.getDate() + 7);
    const end = localDayStart(localDayKey(endCal));
    const db = this.store.database;
    const reads = db.prepare(`
      SELECT i.id AS entry_id, a.title AS title, a.url AS url,
             COALESCE(f.title, '') AS feed_title,
             COALESCE(a.summary, '') AS summary,
             COALESCE(c.text, '') AS body_text,
             s.updated_at AS read_at,
             (SELECT group_concat(tag, ' ') FROM article_tags at WHERE at.item_id = i.id) AS tags
      FROM article_states s
      INNER JOIN items i ON i.id = s.item_id
      INNER JOIN articles a ON a.item_id = i.id
      INNER JOIN feeds f ON f.id = i.feed_id
      LEFT JOIN article_caches c ON c.item_id = i.id
      WHERE s.is_read = 1 AND s.updated_at >= ? AND s.updated_at < ? AND f.is_deleted = 0
      ORDER BY s.updated_at DESC
      LIMIT ?
    `).all(start, end, WEEKLY.READ_CAP).map((row) => ({
      entryID: row.entry_id,
      title: String(row.title || '').slice(0, WEEKLY.TITLE_SLICE),
      url: row.url || null,
      sourceTitle: String(row.feed_title || '').slice(0, WEEKLY.TITLE_SLICE),
      summary: squash(row.summary).slice(0, WEEKLY.SUMMARY_SLICE),
      bodyText: squash(row.body_text).slice(0, WEEKLY.BODY_SEARCH_SLICE),
      readAt: row.read_at,
      tags: String(row.tags || '').split(/\s+/).filter(Boolean).slice(0, 4),
    }));
    const annotations = [];
    const pushAll = (rows, kind) => {
      for (const r of rows) {
        const text = squash(kind === 'note' ? r.content : r.text);
        if (!text) continue;
        annotations.push({
          kind,
          entryID: r.item_id,
          text: text.slice(0, WEEKLY.ANNOT_SLICE),
          note: r.note ? squash(r.note).slice(0, WEEKLY.ANNOT_SLICE) : null,
          createdAt: r.created_at,
        });
        if (annotations.length >= WEEKLY.ANNOT_CAP) return;
      }
    };
    pushAll(db.prepare(`
      SELECT h.* FROM highlights h WHERE h.created_at >= ? AND h.created_at < ? ORDER BY h.created_at DESC
    `).all(start, end), 'highlight');
    if (annotations.length < WEEKLY.ANNOT_CAP) {
      pushAll(db.prepare(`
        SELECT n.*, NULL AS note FROM notes n WHERE n.created_at >= ? AND n.created_at < ? ORDER BY n.created_at DESC
      `).all(start, end), 'note');
    }
    return { weekStart, start, end, reads, annotations };
  }

  // MARK: 生成（AI 版式 / 模板降级）

  /**
   * 生成某周周刊。week_start 唯一防重：
   * - ready → 幂等返回既有期（alreadyReady=true）；
   * - generating（在途）→ requestInProgress（单飞，可 cancel）；
   * - failed / 无行 → 生成（重试覆盖 error）。
   * @param {string} weekStart 周一日期键（缺省=上周）
   * @returns shaped weekly
   */
  async generateWeek(weekStart = null, { origin = 'manual' } = {}) {
    const target = weekStart ? String(weekStart) : lastWeekStart(this.now());
    if (localDayStart(target) == null || !isMondayKey(target)) {
      throw new Error('周刊只能以周一为起点（YYYY-MM-DD）。');
    }
    const existing = this._row(target);
    if (existing && existing.status === 'ready') {
      return { ...this.get(existing.id), alreadyReady: true, origin };
    }
    if (existing && existing.status === 'generating') {
      throw new LLMServiceError('requestInProgress');
    }
    const data = this.weekData(target);
    if (!data.reads.length) {
      this._fail(target, existing, '这一周没有阅读记录，无可编辑的版面。');
      throw new Error('这一周没有阅读记录，无可编辑的版面。');
    }
    let ai = null;
    try { ai = this.store._requireAIReady(); } catch (_) { ai = null; } // 无 Key → 模板降级
    const weeklyID = (existing && existing.id) || uuid();
    this.store.database.prepare(`
      INSERT INTO weeklies (id, week_start, status, content_json, error, created_at, updated_at)
      VALUES (?, ?, 'generating', NULL, NULL, ?, ?)
      ON CONFLICT(week_start) DO UPDATE SET status = 'generating', content_json = NULL, error = NULL, updated_at = excluded.updated_at
    `).run(weeklyID, target, nowSeconds(), nowSeconds());

    const canceller = { cancelled: false, controller: new AbortController() };
    const lockKey = `weekly:${target}`;
    this.store.activeAICancellers.set(lockKey, canceller);
    try {
      let content;
      if (!ai) {
        content = this.templateEdition(data);
        this.counters.template += 1;
      } else {
        const raw = await this.llmComplete(data, ai, canceller.controller.signal);
        if (canceller.cancelled) {
          this.counters.cancelled += 1;
          this._fail(target, { id: weeklyID }, '已取消，可重试。');
          return this.get(weeklyID);
        }
        const parsed = parseWeeklyRaw(raw);
        const edition = parsed ? this.validateEdition(parsed, data) : null;
        if (!edition) {
          this.counters.parseFailures += 1;
          this._fail(target, { id: weeklyID }, 'AI 排版输出无法解析，可重试。');
          throw new LLMServiceError('invalidResponse');
        }
        content = edition;
        this.counters.generated += 1; // AI 版式成功计数（模板降级单独计 template）
      }
      content.weekStart = target;
      content.generatedAt = nowSeconds();
      this.store.database.prepare(
        "UPDATE weeklies SET status = 'ready', content_json = ?, error = NULL, updated_at = ? WHERE id = ?"
      ).run(JSON.stringify(content), nowSeconds(), weeklyID);
      this.store.emit('weekly:changed', { weekStart: target, status: 'ready', origin });
      return this.get(weeklyID);
    } catch (err) {
      if (canceller.cancelled || String((err && err.message) || '').includes('cancelled')) {
        this.counters.cancelled += 1;
        this._fail(target, { id: weeklyID }, '已取消，可重试。');
        return this.get(weeklyID);
      }
      // 一般性失败（网络/HTTP 429/超时）也落 failed（批 E 审查 P1：否则 generating 卡死，
      // 该周期数永久不可生成不可重试——canceller 已删、cancelAI 无对象、无启动清扫）。
      // 解析失败路径已自行 _fail（error='无法解析…'），此处仅兜底仍停在 generating 的行。
      const cur = this.getByWeek(target);
      if (cur && cur.status === 'generating') {
        this._fail(target, { id: weeklyID }, String((err && err.message) || err).slice(0, 200));
      }
      throw err;
    } finally {
      this.store.activeAICancellers.delete(lockKey);
    }
  }

  /** 失败落库（failed 可重试；无行时兜底建行）。 */
  _fail(weekStart, existingRow, message) {
    const id = (existingRow && existingRow.id) || uuid();
    this.store.database.prepare(`
      INSERT INTO weeklies (id, week_start, status, content_json, error, created_at, updated_at)
      VALUES (?, ?, 'failed', NULL, ?, ?, ?)
      ON CONFLICT(week_start) DO UPDATE SET status = 'failed', error = excluded.error, updated_at = excluded.updated_at
    `).run(id, weekStart, message, nowSeconds(), nowSeconds());
    this.store.emit('weekly:changed', { weekStart, status: 'failed' });
  }

  // MARK: 模板降级（无 Key：标签聚合 + 完读排行 + 批注金句，零 AI）

  templateEdition(data) {
    const { reads, annotations } = data;
    // 按标签聚合（≥2 篇才成板块），不足时按来源聚合兜底
    const byTag = new Map();
    for (const r of reads) {
      for (const tag of (r.tags || [])) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push(r);
      }
    }
    let sections = [...byTag.entries()]
      .filter(([, list]) => list.length >= 2)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, WEEKLY.SECTION_MAX)
      .map(([tag, list]) => ({
        title: `# ${tag}`,
        summary: `本周「${tag}」方向读了 ${list.length} 篇。`,
        entries: this._entryCards(list.slice(0, WEEKLY.SECTION_ENTRIES_MAX)),
      }));
    if (!sections.length) {
      const bySource = new Map();
      for (const r of reads) {
        const key = r.sourceTitle || '其他来源';
        if (!bySource.has(key)) bySource.set(key, []);
        bySource.get(key).push(r);
      }
      sections = [...bySource.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, WEEKLY.SECTION_MAX)
        .map(([source, list]) => ({
          title: source,
          summary: `本周来自「${source}」的阅读 ${list.length} 篇。`,
          entries: this._entryCards(list.slice(0, WEEKLY.SECTION_ENTRIES_MAX)),
        }));
    }
    // 完读排行：按阅读时刻新者在前（窗口内 Top5 榜单板块）
    const top = {
      title: '完读排行',
      summary: `本周共完读 ${reads.length} 篇，最近读的 ${Math.min(5, reads.length)} 篇在此。`,
      entries: this._entryCards(reads.slice(0, 5)),
    };
    const quotes = annotations.slice(0, WEEKLY.QUOTES_MAX).map((a) => ({
      text: a.text.slice(0, WEEKLY.QUOTE_SLICE),
      entryID: a.entryID,
      title: this._titleOf(a.entryID, reads),
      sourceTitle: this._sourceOf(a.entryID, reads),
    }));
    return {
      intro: null, // 模板版无 AI 导语（红线：不伪造 AI 口吻）
      sections: [...sections, top],
      quotes,
      template: true,
    };
  }

  _titleOf(entryID, reads) {
    const hit = reads.find((r) => r.entryID === entryID);
    return hit ? hit.title : '';
  }

  _sourceOf(entryID, reads) {
    const hit = reads.find((r) => r.entryID === entryID);
    return hit ? hit.sourceTitle : '';
  }

  _entryCards(list) {
    return list.map((r) => ({
      entryID: r.entryID,
      title: r.title,
      sourceTitle: r.sourceTitle,
      tags: r.tags || [],
    }));
  }

  // MARK: 合同校验（存在性 + 金句逐字）

  /**
   * LLM 版面合同校验：
   * - intro 截 200 字（空 intro 保留 null——渲染层隐去导语区）；
   * - 板块 1..4 个：标题非空、归纳非空、entryIDs 逐一对照聚合窗口（编造剔除，
   *   剔完为空的板块整块丢弃）；AI 未归组的文章不出现在板块里（版面是精选不是全量）；
   * - 金句：文本非空 + 出处必须是窗口内文章 + 原句逐字可查（squash 后 indexOf，
   *   在摘要或正文缓存前段里找）——编造金句出局；上限 5 条。
   * 全部板块被剔且无金句 → null（坏输出，不落库可重试）。
   */
  validateEdition(parsed, data) {
    const readMap = new Map(data.reads.map((r) => [r.entryID, r]));
    const intro = squash(parsed.intro).slice(0, WEEKLY.INTRO_MAX) || null;
    const sections = [];
    for (const sec of parsed.sections) {
      if (!sec || typeof sec !== 'object' || sections.length >= WEEKLY.SECTION_MAX) break;
      const title = squash(sec.title || sec.name || '').slice(0, 60);
      const summary = squash(sec.summary || sec.digest || '').slice(0, 400);
      if (!title || !summary) continue;
      const ids = Array.isArray(sec.entryIDs) ? sec.entryIDs : (Array.isArray(sec.entry_ids) ? sec.entry_ids : []);
      const entries = [];
      const seen = new Set();
      for (const id of ids) {
        const key = String(id || '');
        if (!key || seen.has(key) || !readMap.has(key)) continue; // 编造/重复 ID：剔除
        seen.add(key);
        entries.push({ entryID: key, title: readMap.get(key).title, sourceTitle: readMap.get(key).sourceTitle, tags: readMap.get(key).tags });
        if (entries.length >= WEEKLY.SECTION_ENTRIES_MAX) break;
      }
      if (!entries.length) continue; // 空板块丢弃
      sections.push({ title, summary, entries });
    }
    const quotes = [];
    for (const q of parsed.quotes) {
      if (!q || typeof q !== 'object' || quotes.length >= WEEKLY.QUOTES_MAX) break;
      const text = squash(q.text || q.quote || '').slice(0, WEEKLY.QUOTE_SLICE);
      const id = String(q.entryID || q.entry_id || '');
      if (!text || !id || !readMap.has(id)) continue; // 出处不在窗口：出局
      const article = readMap.get(id);
      const needle = text.replace(/\s+/g, '');
      const haystack = `${article.summary.replace(/\s+/g, '')}${article.bodyText.replace(/\s+/g, '')}`;
      if (!needle || !haystack.includes(needle)) continue; // 逐字校验失败（编造）：出局
      quotes.push({ text, entryID: id, title: article.title, sourceTitle: article.sourceTitle });
    }
    if (!sections.length && !quotes.length) return null;
    return { intro, sections, quotes, template: false };
  }

  // MARK: LLM（可整路注入 mock）

  async llmComplete(data, { config, apiKey }, signal = null) {
    if (this._llmComplete) return this._llmComplete(data, { config, apiKey }, signal);
    const articleLines = data.reads.slice(0, 40).map((r, i) => (
      `${i + 1}. id=${r.entryID} 《${r.title}》 来源：${r.sourceTitle} 标签：${(r.tags || []).join('/') || '无'}`
    )).join('\n');
    const annotLines = data.annotations.slice(0, 15).map((a) => `- 「${a.text}」`).join('\n');
    const prompt = [
      `以下是读者上周（${data.weekStart} 起一周）的完读文章清单与批注摘选：`,
      articleLines,
      annotLines ? `\n本周批注摘选：\n${annotLines}` : '',
      '',
      '请为《知更周刊》排版：',
      `- intro：本周导语，不超过 ${WEEKLY.INTRO_MAX} 字，像主编写给读者的一段话；`,
      `- sections：2-4 个主题板块，每板块 title + 一段归纳 summary + 入选文章 entryIDs（2-6 篇，必须从上面清单里原样选，不许编造）；`,
      `- quotes：${WEEKLY.QUOTE_MIN}-${WEEKLY.QUOTES_MAX} 条金句，逐字摘录文章或批注原句（text）并注明出处 entryID，不许改写；`,
      '只输出 JSON：{"intro":"…","sections":[{"title":"…","summary":"…","entryIDs":["…"]}],"quotes":[{"text":"…","entryID":"…"}]}，不要输出任何其他文字。',
    ].join('\n');
    return this.store.llm.complete({
      prompt,
      system: '你是《知更周刊》的主编，只依据读者真实的阅读清单编排周刊，不编造文章、不改写金句，只输出 JSON，不输出其他内容。',
      configuration: config,
      apiKey,
      signal,
      forceDisableReasoning: true,
      overrideTemperature: 0.3,
    });
  }

  // MARK: 自动触发（周一 + 未生成 + 周内一次节流）

  /**
   * AppStore 刷新完成钩子：今天（注入时钟）是周一、且「上周刊」不存在 ready 行时，
   * 起后台生成。偏好键 `RobinRead.weekly.autoAttempt.<weekStart>` 保证一周只尝试
   * 一次（无论成败——失败由用户手动重试，避免每次刷新重打 LLM）。
   * @returns {{ triggered, weekStart, origin, reason } | null} promise 或跳过原因
   */
  autoCheck() {
    const now = this.now();
    const monday = mondayOf(now);
    const isMonday = localDayKey(new Date(now * 1000)) === monday;
    if (!isMonday) {
      this.counters.autoSkips += 1;
      return { triggered: false, reason: 'notMonday' };
    }
    const weekStart = lastWeekStart(now);
    const prefKey = `RobinRead.weekly.autoAttempt.${weekStart}`;
    if (this.store.preferences.get(prefKey, false) === true) {
      this.counters.autoSkips += 1;
      return { triggered: false, reason: 'alreadyAttempted' };
    }
    const existing = this._row(weekStart);
    if (existing && existing.status === 'ready') {
      this.store.preferences.set(prefKey, true);
      this.counters.autoSkips += 1;
      return { triggered: false, reason: 'alreadyReady' };
    }
    this.store.preferences.set(prefKey, true); // 节流先行：失败也不自动重试
    this.counters.autoKicks += 1;
    const promise = this.generateWeek(weekStart, { origin: 'auto' }).catch(() => null);
    return { triggered: true, weekStart, origin: 'auto', promise };
  }

  // MARK: 读取与导出

  _row(weekStart) {
    return this.store.database.prepare('SELECT * FROM weeklies WHERE week_start = ?').get(String(weekStart || ''));
  }

  _shape(row, issueMap = null) {
    if (!row) return null;
    let content = null;
    try { content = row.content_json ? JSON.parse(row.content_json) : null; } catch (_) { content = null; }
    return {
      id: row.id,
      weekStart: row.week_start,
      status: row.status,
      error: row.error || null,
      content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      issue: issueMap ? (issueMap.get(row.id) || null) : null,
    };
  }

  /** 期号映射（按创建时间升序 1..N，同周内唯一且稳定）。 */
  _issueMap() {
    const rows = this.store.database.prepare('SELECT id FROM weeklies ORDER BY created_at ASC, id ASC').all();
    const map = new Map();
    rows.forEach((r, i) => map.set(r.id, i + 1));
    return map;
  }

  get(weeklyID) {
    return this._shape(
      this.store.database.prepare('SELECT * FROM weeklies WHERE id = ?').get(String(weeklyID || '')),
      this._issueMap(),
    );
  }

  getByWeek(weekStart) {
    return this._shape(this._row(weekStart), this._issueMap());
  }

  /** 历史周刊（期号倒序）。 */
  list({ limit = 30 } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const map = this._issueMap();
    return this.store.database.prepare('SELECT * FROM weeklies ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(cap).map((row) => this._shape(row, map));
  }

  /**
   * 组 EPUB（纯 Buffer，写盘由 ipc 层对话框承接）：书名=知更周刊第 N 期，
   * 板块=分章（章内文章以标题+来源+导语卡呈现），金句=末章。
   */
  buildEpub(weeklyID) {
    const weekly = this.get(weeklyID);
    if (!weekly || weekly.status !== 'ready' || !weekly.content) {
      throw new Error('周刊尚未生成完成，无法导出。');
    }
    const c = weekly.content;
    const issue = weekly.issue || 1;
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const articleHTML = (e) => `<h3>${esc(e.title)}</h3><p class="meta">${esc(e.sourceTitle || '')}</p><p>收录于本周刊主题版面。</p>`;
    const sections = [];
    if (c.intro) {
      sections.push({
        title: '本周导语',
        articles: [{ title: '导语', feedTitle: WEEKLY.NAME, html: `<p>${esc(c.intro)}</p>` }],
      });
    }
    for (const sec of (c.sections || [])) {
      sections.push({
        title: sec.title,
        articles: [
          { title: `编者归纳：${sec.title}`, feedTitle: WEEKLY.NAME, html: `<p>${esc(sec.summary)}</p>` },
          ...(sec.entries || []).map((e) => ({ title: e.title, feedTitle: e.sourceTitle, html: articleHTML(e) })),
        ],
      });
    }
    if ((c.quotes || []).length) {
      sections.push({
        title: '金句摘录',
        articles: c.quotes.map((q) => ({
          title: `「${q.text.slice(0, 24)}${q.text.length > 24 ? '…' : ''}」`,
          feedTitle: q.sourceTitle || WEEKLY.NAME,
          html: `<blockquote><p>${esc(q.text)}</p></blockquote><p class="meta">——《${esc(q.title || '')}》</p>`,
        })),
      });
    }
    const end = localDayStart(weekly.weekStart) + 6 * 86400;
    const range = `${weekly.weekStart} ~ ${localDayKey(new Date(end * 1000))}`;
    this.counters.exports += 1;
    return EpubBuilder.buildBookEpub({
      title: `${WEEKLY.NAME} 第 ${issue} 期`,
      author: WEEKLY.NAME,
      sections,
      cover: null,
    });
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return {
      ...this.counters,
      ...WEEKLY,
      total: this.store.database.prepare('SELECT COUNT(*) AS n FROM weeklies').get().n,
      running: [...this.store.activeAICancellers.keys()].filter((k) => k.startsWith('weekly:')),
    };
  }
}

module.exports = {
  WeeklyService,
  WEEKLY,
  localDayKey,
  localDayStart,
  mondayOf,
  lastWeekStart,
  isMondayKey,
  parseWeeklyRaw,
};
