'use strict';
/**
 * PerspectiveService（知更）— 观点对照镜（F24）
 *
 * 读观点文时，从「你读过的旧文」里找矛盾 / 互补 / 呼应的对照：
 * 「三个月前的你读过的那篇正好唱反调」。
 *
 * - 候选召回（本地，无 AI 也能跑）：复用 SimilarService 基建取相似文，
 *   时间差 ≥ MIN_GAP_DAYS 优先（旧观点更有对照价值）、不同源优先；
 * - AI 关系判定：批量（一批候选一次 prompt）输出 JSON 数组
 *   [{index, relation: contradict|complement|echo|none, reason}]；
 *   坏输出容错（围栏/前后杂文/越界 index/非法 relation → none 兜底）；
 * - 持久化：perspectives 表 PRIMARY KEY(entry_id, related_entry_id) 防重——
 *   同一对文章终身只判一次（含「无关」，省 token，读取侧只投影前三类）；
 * - 单飞锁 + 可取消：对照 activeAICancellers 惯例（key=`perspectives:<entryID>`）；
 * - 无 Key 降级：mirror 直接返回「相似旧文」列表并明示未判定（judged=false），
 *   渲染层照常出卡片流，不调 LLM。
 *
 * 入口按需触发（阅读器点按钮才跑，不做后台自动）。时间可注入（_now，探针）。
 */
const { nowSeconds } = require('./Models');
const { LLMServiceError } = require('./LLMService');

/** 规则常量（召回/判定/解析全部集中于此）。 */
const PERSPECTIVE = {
  CANDIDATE_LIMIT: 10,   // 一次判定的候选上限（一批 prompt）
  RECALL_POOL: 20,       // 相似引擎召回池（再精排出前 CANDIDATE_LIMIT）
  MIN_GAP_DAYS: 14,      // 时间差 ≥ 14 天才有「对照价值」加分
  GAP_BONUS: 0.15,       // 时间差加分（加在相似分上）
  SOURCE_BONUS: 0.08,    // 不同源加分（同源唱和不算对照）
  RELATIONS: ['contradict', 'complement', 'echo', 'none'],
  DISPLAY_RELATIONS: ['contradict', 'complement', 'echo'],
  TITLE_SLICE: 80,       // prompt 里标题截断
  SUMMARY_SLICE: 200,    // prompt 里摘要截断
  REASON_SLICE: 120,     // 理由落库截断
};

/** 归一 relation：非法值兜底 none（LLM 越词表时判「无关」，不误导读者）。 */
function normalizeRelation(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return PERSPECTIVE.RELATIONS.includes(v) ? v : 'none';
}

/**
 * 从 LLM 回包解析判定数组（容错：```json 围栏 / 前后杂文 / 缺 index 顺位兜底 /
 * 非法 relation → none / reason 截断）。完全解析不出返回 null（调用方不落库，可重试）。
 * @returns null | [{relation, reason}]
 */
function parseMirrorPayload(text, count) {
  if (!text) return null;
  let raw = String(text).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
  if (!Array.isArray(parsed) || !parsed.length) return null;
  const out = new Array(count).fill(null);
  for (const item of parsed) {
    let index = -1;
    if (item && typeof item === 'object' && Number.isFinite(Number(item.index))) {
      index = Number(item.index) - 1;
    }
    if (index < 0 || index >= count) {
      if (index >= count || (Number.isFinite(Number(item && item.index)) && Number(item.index) > 0)) {
        // 显式越界（0 起始/11/10/乱序大号）：丢弃该条，绝不顺位张冠李戴（批 B 审查 P2-1）。
        continue;
      }
      // 缺 index：填入第一个空位（顺位兜底）
      index = out.findIndex((slot) => slot === null);
      if (index === -1) break;
    }
    const reason = String((item && item.reason) || '').replace(/\s+/g, ' ').trim().slice(0, PERSPECTIVE.REASON_SLICE);
    out[index] = { relation: normalizeRelation(item && item.relation), reason };
  }
  // 完全没填进任何槽位 → 视为整体解析失败
  if (out.every((slot) => slot === null)) return null;
  // 缺槽不落 none（批 B 审查 P2-2）：落库层只写非空槽，空槽留给下次重判——
  // LLM 截断输出不应把未判定对永久判死（none 防重会挡住重试）。
  return out;
}

/** 单条候选的 prompt 块。 */
function candidateBlock(index, candidate) {
  const title = String(candidate.title || '').replace(/\s+/g, ' ').trim().slice(0, PERSPECTIVE.TITLE_SLICE) || '（无标题）';
  const summary = String(candidate.summary || '').replace(/\s+/g, ' ').trim().slice(0, PERSPECTIVE.SUMMARY_SLICE) || '（无摘要）';
  return `[${index + 1}] 《${title}》\n${summary}`;
}

class PerspectiveService {
  constructor(store, { now = null } = {}) {
    this.store = store;
    this._now = now || (() => Date.now() / 1000);
    // LLM 完成通路可整路注入（探针 mock）；默认走 store.llm.complete（非流式）
    this._llmComplete = null;
    this._runningEntryID = null; // 单飞锁（同一时刻至多一次判定）
    this.counters = { recalls: 0, mirrors: 0, judged: 0, persisted: 0, parseFailures: 0, degraded: 0, cancelled: 0 };
  }

  now() { return this._now(); }

  // MARK: 候选召回（本地零 AI）

  /**
   * 相似旧文召回：复用 SimilarService，再按「时间差 ≥14 天 + 不同源」精排。
   * @returns {{ self, items: [{id, feedID, title, sourceTitle, url, publishedAt, score, gapDays, differentSource}] }}
   */
  recall(entryID, { limit = PERSPECTIVE.CANDIDATE_LIMIT } = {}) {
    const id = String(entryID || '');
    this.counters.recalls += 1;
    const self = this.store.database.prepare(`
      SELECT i.id AS id, i.feed_id AS feedID,
             IFNULL(a.title, '') AS title, IFNULL(a.summary, '') AS summary,
             COALESCE(a.published_at, i.created_at) AS publishedAt
      FROM items i INNER JOIN articles a ON a.item_id = i.id
      WHERE i.id = ?
    `).get(id);
    if (!self) return { self: null, items: [] };
    const { items } = this.store.similar.similar(id, { limit: PERSPECTIVE.RECALL_POOL });
    const gapSeconds = PERSPECTIVE.MIN_GAP_DAYS * 86400;
    const reranked = items.map((cand) => {
      const gap = Math.abs((self.publishedAt || 0) - (cand.publishedAt || 0));
      const gapDays = Math.floor(gap / 86400);
      const differentSource = cand.feedID && cand.feedID !== self.feedID ? 1 : 0;
      const adjusted = (cand.score || 0)
        + (gap >= gapSeconds ? PERSPECTIVE.GAP_BONUS : 0)
        + (differentSource ? PERSPECTIVE.SOURCE_BONUS : 0);
      return {
        id: cand.id,
        feedID: cand.feedID,
        title: cand.title,
        sourceTitle: cand.sourceTitle,
        url: cand.url || null,
        summary: '',
        publishedAt: cand.publishedAt,
        score: Math.round(adjusted * 1000) / 1000,
        gapDays,
        differentSource: Boolean(differentSource),
      };
    });
    // 同分旧者在前（旧观点对照价值更高，确定性 tie-break）
    reranked.sort((a, b) => b.score - a.score || (a.publishedAt || 0) - (b.publishedAt || 0) || String(a.id).localeCompare(String(b.id)));
    const top = reranked.slice(0, Math.max(1, Math.min(Number(limit) || PERSPECTIVE.CANDIDATE_LIMIT, PERSPECTIVE.CANDIDATE_LIMIT)));
    // 摘要补齐（prompt 需要；SimilarService 投影不带 summary，此处按选中集一次取回）
    if (top.length) {
      const marks = top.map(() => '?').join(',');
      const summaries = this.store.database.prepare(`
        SELECT item_id, IFNULL(summary, '') AS summary FROM articles WHERE item_id IN (${marks})
      `).all(...top.map((c) => c.id));
      const byID = new Map(summaries.map((r) => [r.item_id, r.summary]));
      for (const cand of top) cand.summary = byID.get(cand.id) || '';
    }
    return { self, items: top };
  }

  // MARK: 已判定关系（持久化投影）

  _persistedRows(entryID) {
    return this.store.database.prepare(`
      SELECT p.related_entry_id AS relatedID, p.relation AS relation, p.reason AS reason,
             p.model AS model, p.created_at AS judgedAt,
             IFNULL(a.title, '') AS title, IFNULL(f.title, '') AS sourceTitle,
             COALESCE(a.published_at, i.created_at) AS publishedAt
      FROM perspectives p
      INNER JOIN items i ON i.id = p.related_entry_id
      LEFT JOIN articles a ON a.item_id = p.related_entry_id
      LEFT JOIN feeds f ON f.id = i.feed_id
      WHERE p.entry_id = ?
      ORDER BY p.created_at DESC
    `).all(String(entryID || ''));
  }

  /** 三组视图（唱反调/相辅相成/遥相呼应；none 只用于防重不入组）。 */
  groups(entryID) {
    const out = { contradict: [], complement: [], echo: [] };
    for (const row of this._persistedRows(entryID)) {
      if (!Object.prototype.hasOwnProperty.call(out, row.relation)) continue;
      out[row.relation].push({
        id: row.relatedID,
        title: row.title,
        sourceTitle: row.sourceTitle,
        publishedAt: row.publishedAt,
        reason: row.reason || '',
        judgedAt: row.judgedAt,
        model: row.model || null,
      });
    }
    return out;
  }

  // MARK: 判定主流程（点按钮才跑）

  /**
   * 对照镜主入口：召回 → 查重 → 批量判定 → 持久化 → 返回三组 + 降级标记。
   * @returns {{ entryID, candidates, judged, persisted, degraded, cancelled, parseFailed, groups, similar }}
   */
  async mirror(entryID) {
    const id = String(entryID || '');
    if (!id) throw new Error('文章不存在或已被清理。');
    const { items: candidates } = this.recall(id);
    this.counters.mirrors += 1;

    const known = new Set(this._persistedRows(id).map((r) => r.relatedID));
    const pending = candidates.filter((c) => !known.has(c.id));

    let degraded = false;
    let cancelled = false;
    let parseFailed = false;
    let judgedCount = 0;
    let persistedCount = 0;

    if (pending.length > 0) {
      let ai = null;
      try { ai = this.store._requireAIReady(); } catch (_) { ai = null; }
      if (!ai) {
        // 无 Key 降级：明示未判定，直接出「相似旧文」列表（不调 LLM）
        degraded = true;
        this.counters.degraded += 1;
      } else {
        const lockKey = `perspectives:${id}`;
        if (this._runningEntryID === id || this.store.activeAICancellers.has(lockKey)) {
          throw new LLMServiceError('requestInProgress');
        }
        const canceller = { cancelled: false, controller: new AbortController() };
        this.store.activeAICancellers.set(lockKey, canceller);
        this._runningEntryID = id;
        try {
          const text = await this.llmComplete(id, pending, ai, canceller.controller.signal);
          if (canceller.cancelled) {
            cancelled = true;
            this.counters.cancelled += 1;
          } else {
            const verdicts = parseMirrorPayload(text, pending.length);
            if (!verdicts) {
              parseFailed = true; // 坏输出：不落库（下次点击可重试），不谎报已判定
              this.counters.parseFailures += 1;
            } else {
              const insert = this.store.database.prepare(`
                INSERT OR IGNORE INTO perspectives (entry_id, related_entry_id, relation, reason, model, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
              `);
              for (let i = 0; i < pending.length; i += 1) {
                const verdict = verdicts[i];
                if (!verdict) continue; // 缺槽不落 none（审查 P2-2）：留给下次重判，不被防重挡死
                judgedCount += 1;
                const info = insert.run(
                  id, pending[i].id, verdict.relation, verdict.reason || '',
                  String(ai.config?.model || ''), nowSeconds(),
                );
                if (info.changes > 0) persistedCount += 1;
              }
              this.counters.judged += judgedCount;
              this.counters.persisted += persistedCount;
            }
          }
        } catch (err) {
          if (canceller.cancelled || String((err && err.message) || '').includes('cancelled')) {
            cancelled = true;
            this.counters.cancelled += 1;
          } else {
            throw err; // 网络/HTTP 错误上抛 → 渲染层显示失败态
          }
        } finally {
          this.store.activeAICancellers.delete(lockKey);
          this._runningEntryID = null;
        }
      }
    }

    return {
      entryID: id,
      candidates: candidates.length,
      judged: judgedCount,
      persisted: persistedCount,
      degraded,
      cancelled,
      parseFailed,
      groups: this.groups(id),
      similar: candidates,
    };
  }

  /** LLM 调用（批量：一批候选一次 prompt）。可整路注入（探针 mock）。 */
  async llmComplete(entryID, candidates, { config, apiKey }, signal = null) {
    if (this._llmComplete) return this._llmComplete(entryID, candidates, { config, apiKey }, signal);
    const self = this.store.database.prepare(`
      SELECT IFNULL(a.title, '') AS title, IFNULL(a.summary, '') AS summary
      FROM items i INNER JOIN articles a ON a.item_id = i.id WHERE i.id = ?
    `).get(entryID) || { title: '', summary: '' };
    const blocks = candidates.map((c, i) => candidateBlock(i, c)).join('\n\n');
    const prompt = [
      `当前文章：《${String(self.title).slice(0, PERSPECTIVE.TITLE_SLICE)}》`,
      String(self.summary || '').replace(/\s+/g, ' ').trim().slice(0, PERSPECTIVE.SUMMARY_SLICE) || '（无摘要）',
      '',
      `以下是读者已读过的 ${candidates.length} 篇旧文：`,
      blocks,
      '',
      '请逐条判定每篇旧文与当前文章的观点关系：',
      '- contradict：观点相反/唱反调',
      '- complement：互补/补充了当前文章没讲的面向',
      '- echo：观点呼应/相互印证',
      '- none：话题无关或只是同领域不同主题',
      '每条给一句话理由（不超过 40 字），说明两篇文章具体在哪里矛盾/互补/呼应。',
      `只输出 JSON 数组（${candidates.length} 个元素，按候选编号顺序），例如 [{"index":1,"relation":"contradict","reason":"…"}]，不要输出任何其他文字。`,
    ].join('\n');
    return this.store.llm.complete({
      prompt,
      system: '你是严谨的中文观点关系分析器，只依据给出的标题与摘要判断，不编造内容，只输出 JSON 数组，不输出其他内容。',
      configuration: config,
      apiKey,
      signal,
      forceDisableReasoning: true,
      overrideTemperature: 0.1,
    });
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return { ...this.counters, ...PERSPECTIVE, running: this._runningEntryID };
  }
}

module.exports = {
  PerspectiveService,
  PERSPECTIVE,
  parseMirrorPayload,
  normalizeRelation,
  candidateBlock,
};
