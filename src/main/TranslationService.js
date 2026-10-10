'use strict';
/**
 * TranslationService（知更）— 外文源自动译（F33，有用档）
 *
 * 订阅级开关：非中文源后台整篇译文缓存，阅读时原文/译文一键切换。
 * - 整篇翻译 = 正文分段翻译防截断：按既有 ArticleChunker 口径分块（HTML 按块级
 *   标签边界切，纯文本退回 ArticleChunker.translationSegments）、逐块译、按序拼接；
 * - 产物必须过 ArticleExtractor.sanitizedHTML 消毒白名单才落库（LLM 输出不可信：
 *   script/iframe/onerror 等在写入前剥除）；
 * - 幂等：translations 行 is_complete=1 时零 LLM 请求直接返回；
 * - 可续译：分块中途失败保留已完成块进度（translations.segments_json），
 *   重试从断点续译（已完成的块不再发请求）；
 * - 触发：a) 订阅级「自动翻译」开关开启后刷新灌文钩子对新条目入队（照 F1 模式：
 *   只登记 ID，kick() 后台合批）；b) 阅读器「翻译全文」按钮（单篇，开关无关可用）；
 * - 语言判定：标题/摘要 CJK 占比 <20% 视为外文源（可被订阅级开关强制/关闭）；
 * - 单飞：并发 ≤2（同 F1 惯例），队列排队；可取消（activeAICancellers）；
 *   单篇失败自动重试 1 次，再失败记入 failed（行保留进度可手动续译）。
 *
 * DDL 只进 DatabaseMigrations v28（translations）；构造器只校验不建表（F36 同款口径）。
 */
const { nowSeconds } = require('./Models');
const { LLMServiceError } = require('./LLMService');
const ArticleExtractor = require('./ArticleExtractor');
const { i18n } = require('./I18N');

const AUTO_KEY = 'RobinRead.autotrans.feedModes';
const CONCURRENCY = 2;      // 在途翻译上限（F1 全文抓取同款约定值）
const QUEUE_CAP = 60;       // 队列上限：满了丢弃并计数（下次 kick 可补回）
const CHUNK_MAX_CHARS = 4500;   // 单块字符预算（ArticleChunker 5000 口径略收紧，给标签余量）
const CHUNK_MIN_CHARS = 900;    // 块级边界合块的下限（避免一块一句碎片化请求）
const RETRY_LIMIT = 1;      // 单篇自动重试次数（同 F1：重试优先插入队首）
const FAILED_CAP = 200;     // 失败登记上限（LRU 淘汰）

/** 标题/摘要 CJK 占比（外文启发判定）。 */
function cjkRatio(text) {
  const s = String(text || '').trim();
  if (!s) return 0;
  const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return cjk / s.length;
}

/**
 * HTML 按块级标签边界切段（不切断行内结构）：累计块长度到预算即断块；
 * 超预算的单个块自成一整块（LLM 侧容忍，HTML 标签不计入可译正文）。
 * @returns {string[]}
 */
function segmentHTMLBlocks(html, maxChars = CHUNK_MAX_CHARS) {
  const source = String(html || '');
  if (!source.trim()) return [];
  const tokenRe = /<[^>]+>|[^<]+/g;
  const blockTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'figure', 'figcaption', 'pre', 'div', 'td', 'th', 'tr', 'section', 'article']);
  const chunks = [];
  let current = '';
  let depth = 0;
  let token;
  while ((token = tokenRe.exec(source)) !== null) {
    const t = token[0];
    current += t;
    const close = t.match(/^<\/([a-z0-9]+)>/i);
    const open = t.match(/^<([a-z0-9]+)\b/i);
    if (close && blockTags.has(close[1].toLowerCase())) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        chunks.push(current);
        current = '';
      }
      continue;
    }
    if (open) {
      if (blockTags.has(open[1].toLowerCase()) && !/\/\s*>$/.test(t)) depth += 1;
    }
    // 块外自由文本（未包裹）累积到预算也断块
    if (depth === 0 && current.length >= maxChars) {
      chunks.push(current);
      current = '';
    }
  }
  if (current.trim()) chunks.push(current);
  // 合并碎片（块太小则与后续块合并，减少请求数）
  const merged = [];
  for (const chunk of chunks) {
    const last = merged[merged.length - 1];
    if (last && last.length + chunk.length <= maxChars && (last.length < CHUNK_MIN_CHARS || chunk.length < CHUNK_MIN_CHARS)) {
      merged[merged.length - 1] = last + '\n' + chunk;
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

class TranslationService {
  constructor(store) {
    this.store = store;
    this.queue = [];            // 待翻译 entryID（FIFO；手动翻译 unshift 优先）
    this.queuedIDs = new Set(); // 防重：已在队列 / 在途
    this.inFlight = 0;
    this.retryTried = new Set();
    this.failed = new Map();    // entryID -> error message（终态，可手动重试）
    this._waiters = new Map();  // entryID -> [resolve]（translateNow 等待终态，阅读器点击语义）
    this._kickTimer = null;
    this._llmComplete = null;   // 注入缝（探针 mock，QuizService 同款）
    this._now = () => Date.now() / 1000;
    this.counters = { enqueued: 0, translated: 0, cacheHits: 0, failed: 0, retried: 0, cancelled: 0, queueDropped: 0, chunksDone: 0, maxInFlight: 0 };
    const missing = ['translations'].filter((t) => !this.store.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(t));
    if (missing.length) {
      throw new Error(`数据库 schema 缺少译文表（${missing.join(', ')}）：DatabaseMigrations v28 未执行`);
    }
  }

  // MARK: - 订阅级「自动翻译」开关

  feedModes() {
    try {
      const parsed = JSON.parse(this.store.preferences.get(AUTO_KEY, '{}') || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  isEnabled(feedID) {
    return this.feedModes()[feedID] === true;
  }

  /** enabled=true 开启；false 关闭（删键回默认）。 */
  setFeedEnabled(feedID, enabled) {
    const map = this.feedModes();
    if (enabled === true) map[feedID] = true;
    else delete map[feedID];
    this.store.preferences.set(AUTO_KEY, JSON.stringify(map));
    this.store._emitState();
    return map;
  }

  /** 启用自动翻译的源 ID 集合（设置页 / 徽标用）。 */
  enabledFeedIDs() {
    return Object.keys(this.feedModes()).filter((id) => this.feedModes()[id] === true);
  }

  // MARK: - 语言判定（外文启发）

  /** 标题/摘要 CJK 占比 < 20% → 外文条目。 */
  isForeignEntry(entry) {
    if (!entry) return false;
    const text = `${entry.title || ''} ${entry.summary || entry.summaryPreview || ''}`;
    return cjkRatio(text) < 0.2;
  }

  // MARK: - 入队（灌文钩子 + 手动按钮）

  /**
   * 灌文完成后的登记（_applyParsedEntries 事务外调用）：只收集 ID 不做任何判定，
   * 筛选（开关/外文/已有译文/有正文）与网络全部推迟到 kick()。
   */
  noteNewEntries(feedID, entryIDs) {
    if (!entryIDs || !entryIDs.length || !this.isEnabled(feedID)) return;
    this._pendingByFeed = this._pendingByFeed || new Map();
    const list = this._pendingByFeed.get(feedID) || [];
    list.push(...entryIDs);
    this._pendingByFeed.set(feedID, list);
  }

  /** 刷新收尾（fulltext.kick 同款 60ms 让出）：筛出待翻译条目并入队。 */
  kick() {
    if (this._kickTimer) return;
    this._kickTimer = setTimeout(() => {
      this._kickTimer = null;
      try { this._drainPendingNew(); } catch (err) { console.warn('[autotrans] kick failed:', err?.message || err); }
    }, 60);
  }

  _drainPendingNew() {
    if (!this._pendingByFeed || this._pendingByFeed.size === 0) return;
    const batches = [...this._pendingByFeed.entries()];
    this._pendingByFeed.clear();
    const ids = [];
    for (const [feedID, entryIDs] of batches) {
      if (!this.isEnabled(feedID)) continue; // 灌文后用户改了设置：尊重最新值
      ids.push(...entryIDs);
    }
    this.enqueueAuto(ids);
  }

  /** 自动翻译入队：只收外文 + 有正文 + 无完整译文的条目。 */
  enqueueAuto(entryIDs) {
    const fresh = (Array.isArray(entryIDs) ? entryIDs : []).filter((id) => id && !this.queuedIDs.has(id));
    if (!fresh.length) return 0;
    const entries = this.store.articlesRepo.entriesByIDs(fresh);
    let enqueued = 0;
    for (const entry of entries) {
      if (!this.isForeignEntry(entry)) continue;       // 中文源不翻
      if (this.get(entry.id)?.isComplete) { this.counters.cacheHits += 1; continue; } // 幂等
      if (!this._sourceHTML(entry.id)) continue;        // 无正文可译
      if (this.queue.length >= QUEUE_CAP) { this.counters.queueDropped += 1; break; }
      this.queuedIDs.add(entry.id);
      this.queue.push(entry.id);
      this.counters.enqueued += 1;
      enqueued += 1;
    }
    if (enqueued > 0) this._pump();
    return enqueued;
  }

  /**
   * 手动「翻译全文」：单篇直入队首，订阅开关无关（划词翻译的整篇版）。
   * 已有完整译文 → 零请求直接返回缓存（幂等）。
   * 返回 Promise 等待终态（完成/取消/失败）：阅读器「译文」按钮点击后拿最终投影。
   */
  async translateNow(entryID) {
    const id = String(entryID || '');
    if (!id) throw new Error('文章不存在或已被清理。');
    if (this.queuedIDs.has(id)) return this._addWaiter(id); // 已在队列/在途：不重复入队，等终态
    const cached = this.get(id);
    if (cached?.isComplete) { this.counters.cacheHits += 1; return cached; }
    this.failed.delete(id);
    this.queuedIDs.add(id);
    this.queue.unshift(id);
    this.counters.enqueued += 1;
    const promise = this._addWaiter(id);
    this._pump();
    return promise;
  }

  /** 终态等待（translateNow 语义；_translateOne 到达终态时 resolve 最新投影）。 */
  _addWaiter(entryID) {
    return new Promise((resolve) => {
      const list = this._waiters.get(entryID) || [];
      list.push(resolve);
      this._waiters.set(entryID, list);
    });
  }

  _flushWaiters(entryID) {
    const list = this._waiters.get(entryID);
    if (!list) return;
    this._waiters.delete(entryID);
    const result = this.get(entryID);
    for (const resolve of list) {
      try { resolve(result); } catch (_) { /* 唤醒失败不影响其余 */ }
    }
  }

  // MARK: - 队列泵（并发 ≤2；失败自动重试 1 次）

  _pump() {
    while (this.inFlight < CONCURRENCY && this.queue.length > 0) {
      const entryID = this.queue.shift();
      this.inFlight += 1;
      this.counters.maxInFlight = Math.max(this.counters.maxInFlight, this.inFlight);
      this._translateOne(entryID)
        .catch(() => { /* _translateOne 内部已消化全部失败 */ })
        .finally(() => {
          this.inFlight -= 1;
          this._pump();
        });
    }
  }

  _hasQueued(entryID) {
    return this.queue.includes(entryID);
  }

  async _translateOne(entryID) {
    try {
      await this.translateEntry(entryID);
      this.queuedIDs.delete(entryID);
      this.failed.delete(entryID);
      this.counters.translated += 1;
    } catch (err) {
      if (this._isCancelled(err, entryID)) {
        this.queuedIDs.delete(entryID);
        this.counters.cancelled += 1;
        this._emitProgress(entryID, 0, 1, 'cancelled'); // 批 G 审查 P2：阅读器按钮复位
        return;
      }
      // 单篇失败：同篇至多重试 1 次（重试插队首尽快出结果）；再失败记入 failed（进度保留可续译）
      if (!this.retryTried.has(entryID)) {
        this.retryTried.add(entryID);
        this.counters.retried += 1;
        this.queue.unshift(entryID);
        this._pump();
        return; // 重试在途：waiter 保持登记，终态时统一唤醒
      }
      this.queuedIDs.delete(entryID);
      this.failed.set(entryID, String((err && err.message) || err));
      if (this.failed.size > FAILED_CAP) this.failed.delete(this.failed.keys().next().value);
      this.counters.failed += 1;
      this._emitProgress(entryID, 0, 1, 'failed'); // 批 G 审查 P2：阅读器按钮复位
    } finally {
      if (!this.queuedIDs.has(entryID)) this._flushWaiters(entryID); // 终态（完成/取消/最终失败）唤醒等待方
    }
  }

  /**
   * 翻译一篇：读缓存 → 分块（跳过已完成块）→ 逐块 LLM → 消毒 → 按序拼接落库。
   * @returns {{entryID, isComplete, cached: boolean}}
   */
  async translateEntry(entryID) {
    const id = String(entryID || '');
    const entry = this.store.articlesRepo.entry(id);
    if (!entry) throw new Error('文章不存在或已被清理。');
    const lang = i18n.language === 'en' ? 'en' : 'zh';
    const existing = this.get(id);
    if (existing?.isComplete && existing.lang === lang) {
      this.counters.cacheHits += 1;
      return { ...existing, cached: true }; // 幂等：已有译文零请求
    }
    const ai = this.store._requireAIReady(); // 无 Key 抛 missingAPIKey（渲染层灰置兜底）
    const html = this._sourceHTML(id);
    if (!html) throw new Error(i18n.localized('没有可翻译的正文。'));

    // 分块：HTML 块级切分；无块级结构的纯文本退回 ArticleChunker 口径
    let chunks = segmentHTMLBlocks(html, CHUNK_MAX_CHARS);
    if (chunks.length === 0) {
      chunks = ArticleExtractor.plainText(html)
        ? [html] : [];
    }
    if (chunks.length === 0) throw new Error(i18n.localized('没有可翻译的正文。'));

    // 断点续译：读回已完成块（segments_json）
    const done = new Map();
    if (existing && Array.isArray(existing.segments)) {
      for (const seg of existing.segments) {
        if (seg && Number.isInteger(seg.i) && seg.i >= 0 && seg.i < chunks.length && seg.html) done.set(seg.i, seg.html);
      }
    }
    this._upsertRow(id, lang, existing?.html || '', [...done.entries()].map(([i, seg]) => ({ i, html: seg })), 0);

    const lockKey = `autotrans:${id}`;
    if (this.store.activeAICancellers.has(lockKey)) throw new LLMServiceError('requestInProgress');
    const canceller = { cancelled: false, controller: new AbortController() };
    this.store.activeAICancellers.set(lockKey, canceller);
    try {
      const translated = [];
      for (let i = 0; i < chunks.length; i += 1) {
        if (canceller.cancelled) throw new LLMServiceError('cancelled');
        if (done.has(i)) { translated.push(done.get(i)); continue; } // 断点续译：跳过已完成块
        const piece = await this.llmComplete({
          html: chunks[i], index: i, total: chunks.length,
          title: entry.title || '', target: lang === 'en' ? 'English' : '简体中文',
        }, ai, canceller.controller.signal);
        if (canceller.cancelled) throw new LLMServiceError('cancelled');
        // 消毒白名单：LLM 输出不可信（script/iframe/onerror…写入前剥除）
        const safe = ArticleExtractor.sanitizedHTML(String(piece || ''), entry.url || null);
        if (!safe || !ArticleExtractor.plainText(safe).trim()) {
          throw new LLMServiceError('invalidResponse'); // 坏输出（消毒后为空）：计失败走重试/续译
        }
        translated.push(safe);
        done.set(i, safe);
        this.counters.chunksDone += 1;
        this._upsertRow(id, lang, existing?.html || '', [...done.entries()].map(([si, seg]) => ({ i: si, html: seg })), 0); // 进度落库
        this._emitProgress(id, done.size, chunks.length, 'running');
      }
      // 按序拼接 + 终道消毒 → 完整译文落库
      const full = ArticleExtractor.sanitizedHTML(translated.join('\n'), entry.url || null);
      if (!full || !ArticleExtractor.plainText(full).trim()) throw new LLMServiceError('invalidResponse');
      this._upsertRow(id, lang, full, [], 1);
      this._emitProgress(id, chunks.length, chunks.length, 'done');
      this.store._invalidatePrepared();
      this.store._emitState();
      return this.get(id);
    } finally {
      this.store.activeAICancellers.delete(lockKey);
    }
  }

  // MARK: - 取消

  cancel(entryID) {
    const id = String(entryID || '');
    // 队列中：直接摘除
    const qi = this.queue.indexOf(id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.queuedIDs.delete(id);
      this.counters.cancelled += 1;
      this._flushWaiters(id); // 队列摘除即终态：唤醒等待方（拿进度行投影）
    }
    // 在途：走全局取消通道（abort controller；终态由 _translateOne 唤醒）
    try { this.store.cancelAI(`autotrans:${id}`); } catch (_) { /* 未在途 */ }
  }

  _isCancelled(err, entryID) {
    if (!err) return false;
    const msg = String(err.message || err);
    if (/cancel/i.test(msg)) return true;
    const c = this.store.activeAICancellers.get(`autotrans:${entryID}`);
    return Boolean(c && c.cancelled);
  }

  // MARK: - 投影

  _upsertRow(entryID, lang, html, segments, isComplete) {
    const now = nowSeconds();
    this.store.database.prepare(`
      INSERT INTO translations (item_id, lang, translated_html, segments_json, is_complete, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        lang = excluded.lang,
        translated_html = excluded.translated_html,
        segments_json = excluded.segments_json,
        is_complete = excluded.is_complete,
        updated_at = excluded.updated_at
    `).run(entryID, lang, html || '', segments && segments.length ? JSON.stringify(segments) : null, isComplete ? 1 : 0, now, now);
  }

  /** 译文投影（无则 null）。 */
  get(entryID) {
    const row = this.store.database.prepare('SELECT * FROM translations WHERE item_id = ?').get(String(entryID || ''));
    if (!row) return null;
    let segments = [];
    try { segments = row.segments_json ? JSON.parse(row.segments_json) : []; } catch (_) { segments = []; }
    return {
      entryID: row.item_id,
      lang: row.lang,
      html: row.translated_html || '',
      segments: Array.isArray(segments) ? segments : [],
      isComplete: Number(row.is_complete) === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      running: this.queuedIDs.has(row.item_id),
    };
  }

  /** 批量探测（列表徽标数据面）：entryID → 是否有完整译文。 */
  hasTranslations(entryIDs) {
    const map = {};
    const ids = (Array.isArray(entryIDs) ? entryIDs : []).filter(Boolean);
    if (!ids.length) return map;
    const rows = this.store.database.prepare(
      `SELECT item_id FROM translations WHERE is_complete = 1 AND item_id IN (${ids.map(() => '?').join(',')})`
    ).all(...ids);
    for (const r of rows) map[r.item_id] = true;
    return map;
  }

  /** 批量有无探测：给一批 entryID，返回其中已有完整译文的 id 数组。 */
  translatedIDs(entryIDs) {
    return Object.keys(this.hasTranslations(entryIDs));
  }

  _sourceHTML(entryID) {
    try {
      const content = this.store.articleContent(entryID);
      const html = content?.html || '';
      return html && ArticleExtractor.plainText(html).trim().length > 40 ? html : '';
    } catch (_) {
      return '';
    }
  }

  _emitProgress(entryID, done, total, state) {
    try { this.store.emit('translation:progress', { entryID, done, total, state }); }
    catch (_) { /* 推送失败不阻塞翻译 */ }
  }

  /** 无 Key 检测（渲染层按钮灰置）。 */
  available() {
    return { ai: this.store.hasAIAPIKey() };
  }

  /** 队列安全清空（退出 / 诊断用）。 */
  dispose() {
    this.queue = [];
    this.queuedIDs.clear();
    if (this._pendingByFeed) this._pendingByFeed.clear();
    if (this._kickTimer) { clearTimeout(this._kickTimer); this._kickTimer = null; }
    for (const entryID of [...this._waiters.keys()]) this._flushWaiters(entryID);
  }

  /** 诊断快照（探针 scripts/diag-f33-autotrans.js 断言用）。 */
  snapshot() {
    return {
      queued: this.queue.length,
      inFlight: this.inFlight,
      pendingFeeds: this._pendingByFeed ? this._pendingByFeed.size : 0,
      failures: Object.fromEntries(this.failed),
      ...this.counters,
    };
  }

  // MARK: - LLM（注入缝）

  /** 单块翻译。可整路注入（探针 mock）。 */
  async llmComplete({ html, index, total, title, target }, { config, apiKey }, signal = null) {
    if (this._llmComplete) return this._llmComplete({ html, index, total, title, target }, { config, apiKey }, signal);
    void title;
    const prompt = [
      'Translate the following HTML fragment into ' + String(target) + '.',
      `This is part ${index + 1} of ${total} of one article — translate it faithfully and completely.`,
      'Keep the exact HTML tags, attributes and structure; only translate the visible text.',
      'Do not add, remove or reorder any tags. Output ONLY the translated HTML, nothing else.',
      '',
      String(html),
    ].join('\n');
    return this.store.llm.complete({
      prompt,
      system: 'You are a professional translator. You translate news article HTML fragments, preserving markup exactly, and output only the translated HTML.',
      configuration: config,
      apiKey,
      signal,
      forceDisableReasoning: true,
      overrideTemperature: 0.2,
    });
  }
}

module.exports = {
  TranslationService,
  segmentHTMLBlocks,
  cjkRatio,
  CONCURRENCY,
  QUEUE_CAP,
  CHUNK_MAX_CHARS,
  RETRY_LIMIT,
};
