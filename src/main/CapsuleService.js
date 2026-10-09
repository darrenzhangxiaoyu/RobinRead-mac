'use strict';
/**
 * CapsuleService（知更）— 时间胶囊（F27，有趣档）
 *
 * 批注（高亮/笔记）创建时可选「装进胶囊」，封存给未来的自己：
 * - seal：指定 30/90/365 天后开启，落 v25 time_capsules（status='sealed'，
 *   open_at = 封存时刻 + days*86400）；可附一句写给未来自己的话（message）。
 * - 到期判定 = 懒结算：没有定时器，due()/pendingCount()/digestProjection()
 *   读取时对比 open_at <= now；注释的「未来某天打开应用」就是结算时机。
 * - 浮出通道：每日简报顶部「时间胶囊」段（digestProjection 投影：当年批注原文
 *   + 文章标题 + 「当时写下的」语态）；无简报习惯的用户走侧栏胶囊徽章
 *   （pendingCount 兜底入口）。
 * - 开启仪式：open(capsuleID) → 返回批注全文 + 文章上下文（当时高亮段落原文
 *   selection_text/anchor 由批注行自带），status 翻 opened + opens_count+1；
 *   渲染层据此播全屏轻遮罩动画（reduced-motion 直达终态，见 robin.css）。
 * - 防重复浮出：opened 即不再进 due/简报段；历史（list）里保留全部胶囊——
 *   报告里留痕。同日多枚按 open_at 升序（先到期先浮出）。
 *
 * 注入缝（探针）：_now 时钟可注入（确定性到期判定）；无 AI 依赖、纯本地。
 */
const { nowSeconds, uuid } = require('./Models');

/** 规则常量（期限/展示截断全部集中于此）。 */
const CAPSULE = {
  DURATIONS: [30, 90, 365], // 可选封存天数（渲染层三档）
  DIGEST_MAX: 5,            // 简报段最多浮出枚数（同日多枚按 open_at 排序取前 N）
  MESSAGE_SLICE: 280,       // 封存留言截断
  TEXT_SLICE: 600,          // 投影/仪式里批注原文截断
  NOTE_SLICE: 1200,         // 投影/仪式里批注附言截断
  TITLE_SLICE: 120,         // 文章标题截断
};

/** 判断封存期限是否合法（30/90/365 天三档；自定义期限须为 1-3650 的整数）。 */
function isValidDuration(days) {
  const n = Number(days);
  if (!Number.isInteger(n)) return false;
  if (CAPSULE.DURATIONS.includes(n)) return true;
  return n >= 1 && n <= 3650;
}

class CapsuleService {
  constructor(store, { now = null } = {}) {
    this.store = store;
    this._now = now || (() => Date.now() / 1000); // 注入时钟（探针确定性）
    this.counters = { sealed: 0, opened: 0, duplicateSealRejected: 0 };
    const required = ['time_capsules'];
    const missing = required.filter((t) => !this.store.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(t));
    if (missing.length) {
      throw new Error(`数据库 schema 缺少时间胶囊表（${missing.join(', ')}）：DatabaseMigrations v25 未执行`);
    }
  }

  now() { return this._now(); }

  // MARK: 封存

  /**
   * 把一条既有批注装进胶囊。
   * @param {object} p { entryID, annotationID, annotationKind: 'highlight'|'note',
   *                     days: 30|90|365, message?: string }
   * @returns shaped capsule
   */
  seal({ entryID, annotationID, annotationKind, days, message = null } = {}) {
    const id = String(annotationID || '');
    const kind = String(annotationKind || '') === 'note' ? 'note' : 'highlight';
    const entry = String(entryID || '');
    if (!entry) throw new Error('文章不存在或已被清理。');
    if (!isValidDuration(days)) throw new Error('封存期限只支持 30 / 90 / 365 天（或 1-3650 的整数天）。');
    // 批注必须真实存在（防悬空胶囊：批注被删后开启仪式无从展示原文）
    const found = kind === 'note'
      ? this.store.database.prepare('SELECT id FROM notes WHERE id = ? AND item_id = ?').get(id, entry)
      : this.store.database.prepare('SELECT id FROM highlights WHERE id = ? AND item_id = ?').get(id, entry);
    if (!found) throw new Error('批注不存在或已删除，无法封存。');
    // 同一条批注只装一枚在途胶囊（sealed 状态防重；opened 的历史不拦重封）
    const dup = this.store.database.prepare(
      "SELECT id FROM time_capsules WHERE annotation_id = ? AND annotation_kind = ? AND status = 'sealed'"
    ).get(id, kind);
    if (dup) {
      this.counters.duplicateSealRejected += 1;
      throw new Error('这条批注已经装进一枚未开启的胶囊了。');
    }
    const capsuleID = uuid();
    const now = this.now(); // 服务时钟：createdAt 与 openAt 同源（注入时钟下时长推导仍自洽）
    this.store.database.prepare(`
      INSERT INTO time_capsules (id, annotation_id, annotation_kind, entry_id, open_at, opens_count, status, message, created_at, opened_at)
      VALUES (?, ?, ?, ?, ?, 0, 'sealed', ?, ?, NULL)
    `).run(capsuleID, id, kind, entry, now + Number(days) * 86400,
      message ? String(message).replace(/\s+/g, ' ').trim().slice(0, CAPSULE.MESSAGE_SLICE) || null : null,
      now);
    this.counters.sealed += 1;
    return this.get(capsuleID);
  }

  // MARK: 到期与浮出（懒结算：全部在读取时对比 open_at，无定时器）

  /**
   * 已到期且未开启的胶囊（open_at <= now，status='sealed'）。
   * 同日多枚按 open_at 升序（先到期先浮出）。
   */
  due(nowMs = null) {
    const now = nowMs != null ? Number(nowMs) / 1000 : this.now();
    return this.store.database.prepare(`
      SELECT * FROM time_capsules
      WHERE status = 'sealed' AND open_at <= ?
      ORDER BY open_at ASC, created_at ASC
    `).all(now).map((row) => this._shape(row));
  }

  /** 侧栏徽章计数：到期未开启枚数。 */
  pendingCount(nowMs = null) {
    return this.due(nowMs).length;
  }

  /**
   * 每日简报「时间胶囊」段投影（顶部段渲染数据面）：
   * 今日到期 N 枚，每枚带当年批注原文 + 文章标题（「当时写下的」语态由渲染层拼装）。
   * opened 即剔除（防重复浮出）；封顶 DIGEST_MAX。
   */
  digestProjection(nowMs = null) {
    const now = nowMs != null ? Number(nowMs) / 1000 : this.now();
    const list = this.due(nowMs).slice(0, CAPSULE.DIGEST_MAX);
    return {
      count: this.pendingCount(nowMs),
      shown: list.length,
      items: list.map((capsule) => ({
        id: capsule.id,
        entryID: capsule.entryID,
        kind: capsule.annotationKind,
        message: capsule.message,
        annotationText: capsule.annotation ? String(capsule.annotation.text || '').slice(0, CAPSULE.TEXT_SLICE) : null,
        annotationNote: capsule.annotation ? String(capsule.annotation.note || '').slice(0, CAPSULE.NOTE_SLICE) || null : null,
        articleTitle: capsule.article ? String(capsule.article.title || '').slice(0, CAPSULE.TITLE_SLICE) : null,
        articleGone: !capsule.article,
        openAt: capsule.openAt,
        sealedAt: capsule.createdAt,
        daysAgo: Math.max(1, Math.round((now - capsule.createdAt) / 86400)),
      })),
    };
  }

  // MARK: 开启仪式

  /**
   * 开启胶囊：status sealed→opened、opens_count+1、opened_at 落库；
   * 返回批注全文 + 文章上下文（当时高亮段落重现的数据面）。
   * 幂等语义：已开启的胶囊再次 open → alreadyOpen=true + 首次开启的完整上下文
   * （历史回看），不再累计 opens_count、不改 opened_at。
   */
  open(capsuleID) {
    const row = this.store.database.prepare('SELECT * FROM time_capsules WHERE id = ?').get(String(capsuleID || ''));
    if (!row) throw new Error('胶囊不存在。');
    const alreadyOpen = row.status === 'opened';
    if (!alreadyOpen) {
      this.store.database.prepare(
        'UPDATE time_capsules SET status = ?, opened_at = ?, opens_count = opens_count + 1 WHERE id = ?'
      ).run('opened', nowSeconds(), row.id);
      this.counters.opened += 1;
    }
    const shaped = this.get(row.id);
    return {
      ...shaped,
      alreadyOpen,
      // 渲染层开启仪式：due 投影即刻剔除本枚（opened 不再浮出）
      remainingAfterOpen: this.pendingCount(),
    };
  }

  // MARK: 投影与读取

  _shape(row) {
    if (!row) return null;
    const annotation = this._annotation(row.annotation_kind, row.annotation_id);
    const article = this.store.database.prepare(
      'SELECT i.id, a.title, a.url, a.published_at FROM items i LEFT JOIN articles a ON a.item_id = i.id WHERE i.id = ?'
    ).get(row.entry_id) || null;
    return {
      id: row.id,
      annotationID: row.annotation_id,
      annotationKind: row.annotation_kind,
      entryID: row.entry_id,
      openAt: row.open_at,
      opensCount: row.opens_count,
      status: row.status,
      message: row.message || null,
      createdAt: row.created_at,
      openedAt: row.opened_at ?? null,
      annotation: annotation ? {
        kind: row.annotation_kind,
        text: String(annotation.text || '').slice(0, CAPSULE.TEXT_SLICE),
        note: annotation.note ? String(annotation.note).slice(0, CAPSULE.NOTE_SLICE) : null,
        color: annotation.color || null,
        anchor: annotation.anchor ?? null,
      } : null,
      article: article ? {
        entryID: article.id,
        title: String(article.title || '').slice(0, CAPSULE.TITLE_SLICE),
        url: article.url || null,
        publishedAt: article.published_at ?? null,
      } : null,
    };
  }

  _annotation(kind, id) {
    if (kind === 'note') {
      const r = this.store.database.prepare('SELECT * FROM notes WHERE id = ?').get(id);
      if (!r) return null;
      let anchor = null;
      try { anchor = r.anchor ? JSON.parse(r.anchor) : null; } catch (_) { anchor = null; }
      return { text: r.content, note: null, color: null, anchor };
    }
    const r = this.store.database.prepare('SELECT * FROM highlights WHERE id = ?').get(id);
    if (!r) return null;
    let anchor = null;
    try { anchor = r.anchor ? JSON.parse(r.anchor) : null; } catch (_) { anchor = null; }
    return { text: r.text, note: r.note, color: r.color, anchor };
  }

  get(capsuleID) {
    return this._shape(this.store.database.prepare('SELECT * FROM time_capsules WHERE id = ?').get(String(capsuleID || '')));
  }

  /** 历史胶囊（报告留痕：opened + sealed 全量，新→旧）。 */
  list({ limit = 50, status = null } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const rows = status === 'opened' || status === 'sealed'
      ? this.store.database.prepare('SELECT * FROM time_capsules WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(status, cap)
      : this.store.database.prepare('SELECT * FROM time_capsules ORDER BY created_at DESC, id DESC LIMIT ?').all(cap);
    return rows.map((row) => this._shape(row));
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return {
      ...this.counters,
      durations: [...CAPSULE.DURATIONS],
      digestMax: CAPSULE.DIGEST_MAX,
      pending: this.pendingCount(),
      total: this.store.database.prepare('SELECT COUNT(*) AS n FROM time_capsules').get().n,
    };
  }
}

module.exports = {
  CapsuleService,
  CAPSULE,
  isValidDuration,
};
