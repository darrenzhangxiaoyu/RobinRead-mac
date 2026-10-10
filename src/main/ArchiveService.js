'use strict';
/**
 * ArchiveService（知更）— 网页存档馆（F34，有用档）
 *
 * 重要文章 + 追更源的永久本地快照馆——原文失效也能读，可导 MHTML：
 * - archive(entryID)：把文章当前正文 HTML 原样存档（入库消毒 HTML 或全文抓取 HTML；
 *   追更源变更时传合成 diff HTML）。单篇 ≤6MB（超限拒绝），重存档覆盖更新；
 * - 回落判定：阅读器打开文章时正文 404/缓存缺失且有存档 → articleContent 自动回落
 *   存档内容（AppStore 接线），渲染层据 payload.content.fromArchive 显示「存档模式」徽记；
 * - listArchived()：存档馆列表（标题/来源/存档时间/大小 + 关键词搜索）；
 * - exportMHTML：手工组装 MIME multipart/related 单文件（boundary 防撞轮换），
 *   走保存对话框许可链（ipc 层 showSaveDialog → 主进程落盘，bundle:export 同款）；
 * - 取消存档：删行，全局配额统计联动；
 * - 追更源自动存档：订阅级开关（默认关），PageMonitor 检出变更落新文时顺带快照。
 *
 * DDL 只进 DatabaseMigrations v28（archives）；构造器只校验不建表（F36 同款口径）。
 */
const { nowSeconds } = require('./Models');
const { i18n } = require('./I18N');

const AUTO_KEY = 'RobinRead.archive.autoFeeds';
/** 单篇存档体积上限（6MB）。 */
const MAX_ENTRY_BYTES = 6 * 1024 * 1024;
/** 存档馆列表单页上限。 */
const LIST_LIMIT = 300;

class ArchiveService {
  constructor(store) {
    this.store = store;
    this._now = () => Date.now() / 1000;
    this.counters = { archived: 0, rearchived: 0, removed: 0, rejected: 0, fallbacks: 0, autoArchived: 0 };
    const missing = ['archives'].filter((t) => !this.store.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(t));
    if (missing.length) {
      throw new Error(`数据库 schema 缺少存档表（${missing.join(', ')}）：DatabaseMigrations v28 未执行`);
    }
  }

  // MARK: - 存档 / 取消 / 探测

  /**
   * 存档一篇：html 显式传入（追更 diff）或取 articleContent 当前正文。
   * 重存档 = 覆盖更新（captured_at/html 刷新）。
   * @returns {{ entryID, htmlSize, capturedAt, rearchived }}
   */
  archive(entryID, { html = null } = {}) {
    const id = String(entryID || '');
    const entry = this.store.articlesRepo.entry(id);
    if (!entry) throw new Error(i18n.localized('文章不存在或已被清理。'));
    const content = html != null ? { html } : (this.store.articleContent(id) || {});
    const body = String(content.html || '').trim();
    if (!body) throw new Error(i18n.localized('这篇文章没有可存档的正文。'));
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > MAX_ENTRY_BYTES) {
      this.counters.rejected += 1;
      throw new Error(i18n.localized('正文超过 6MB 存档上限，已拒绝存档。'));
    }
    const existing = this.has(id);
    const now = nowSeconds();
    this.store.database.prepare(`
      INSERT INTO archives (item_id, html_captured, captured_at, html_size)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        html_captured = excluded.html_captured,
        captured_at = excluded.captured_at,
        html_size = excluded.html_size
    `).run(id, body, now, bytes);
    if (existing) this.counters.rearchived += 1;
    else this.counters.archived += 1;
    this.store._emitState();
    return { entryID: id, htmlSize: bytes, capturedAt: now, rearchived: Boolean(existing) };
  }

  /** 取消存档（删行；配额统计随行消失）。 */
  unarchive(entryID) {
    const info = this.store.database.prepare('DELETE FROM archives WHERE item_id = ?').run(String(entryID || ''));
    if (info.changes > 0) {
      this.counters.removed += 1;
      this.store._invalidatePrepared(); // 回落判定失效：逐出该篇 reader 载荷
      this.store._emitState();
    }
    return info.changes > 0;
  }

  /** 是否已存档。 */
  has(entryID) {
    return !!this.store.database.prepare('SELECT 1 FROM archives WHERE item_id = ?').get(String(entryID || ''));
  }

  /** 存档正文（回落/导出用；无则 null）。 */
  html(entryID) {
    const row = this.store.database.prepare('SELECT html_captured FROM archives WHERE item_id = ?').get(String(entryID || ''));
    return row ? row.html_captured : null;
  }

  /** 存档行元数据投影（徽记时间戳 / 列表回显；无则 null）。 */
  get(entryID) {
    const row = this.store.database.prepare('SELECT item_id, captured_at, html_size FROM archives WHERE item_id = ?').get(String(entryID || ''));
    return row ? { entryID: row.item_id, capturedAt: row.captured_at, htmlSize: Number(row.html_size) || 0 } : null;
  }

  // MARK: - 回落判定（阅读器 404/缓存缺失 → 存档模式）

  /**
   * 正文回落：html 为空/过短（<10 可见字符）且有存档 → 返回存档 HTML。
   * AppStore.articleContent 接线；命中计入 fallbacks（探针断言）。
   */
  fallback(entryID, currentHTML) {
    const text = String(currentHTML || '').replace(/<[^>]+>/g, ' ').trim();
    if (text.length >= 10) return null;
    const saved = this.html(entryID);
    if (!saved) return null;
    this.counters.fallbacks += 1;
    return saved;
  }

  // MARK: - 存档馆列表 / 统计

  /**
   * 存档馆列表：标题/来源/存档时间/大小，captured_at 倒序；query 对标题+来源 LIKE。
   */
  list({ query = '', limit = LIST_LIMIT, offset = 0 } = {}) {
    const q = String(query || '').trim().replace(/[%_\\]/g, (c) => `\\${c}`); // LIKE 转义（批 G 审查 P2：搜「100%」不再全表命中）
    const like = `%${q}%`;
    const rows = this.store.database.prepare(`
      SELECT ar.item_id, ar.captured_at, ar.html_size,
             COALESCE(a.title, '') AS title, a.url AS url,
             COALESCE(f.title, '') AS source_title, i.feed_id AS feed_id
      FROM archives ar
      INNER JOIN items i ON i.id = ar.item_id
      LEFT JOIN articles a ON a.item_id = ar.item_id
      LEFT JOIN feeds f ON f.id = i.feed_id
      WHERE (? = '' OR COALESCE(a.title, '') LIKE ? ESCAPE '\\' OR COALESCE(f.title, '') LIKE ? ESCAPE '\\')
      ORDER BY ar.captured_at DESC
      LIMIT ? OFFSET ?
    `).all(q, like, like, Math.max(1, Number(limit) || LIST_LIMIT), Math.max(0, Number(offset) || 0));
    return rows.map((r) => ({
      entryID: r.item_id,
      title: r.title || r.entryID,
      url: r.url || null,
      sourceTitle: r.source_title || '',
      feedID: r.feed_id || null,
      capturedAt: r.captured_at,
      htmlSize: Number(r.html_size) || 0,
    }));
  }

  /** 全局配额统计（篇数 + 字节；设置存储统计接线）。 */
  stats() {
    const row = this.store.database.prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(html_size), 0) AS bytes FROM archives'
    ).get();
    return { count: Number(row?.n ?? 0), bytes: Number(row?.bytes ?? 0), maxEntryBytes: MAX_ENTRY_BYTES };
  }

  // MARK: - MHTML 导出

  /**
   * 手工组装 MHTML（multipart/related，UTF-8 8bit）：
   * - 头部含 MIME-Version / Content-Type(multipart+boundary) / Snapshot-Content-Location；
   * - boundary 轮换防撞（正文包含候选 boundary 时换后缀重排）；
   * - 返回字符串，落盘与对话框由 ipc 层包（保存对话框许可链）。
   */
  buildMHTML(entryID) {
    const id = String(entryID || '');
    const entry = this.store.articlesRepo.entry(id);
    if (!entry) throw new Error(i18n.localized('文章不存在或已被清理。'));
    const saved = this.html(id);
    if (saved == null) throw new Error(i18n.localized('这篇文章还没有存档，请先存档再导出。'));
    const url = entry.url || 'about:blank';
    const title = entry.title || id;
    const boundary = this._makeBoundary(saved);
    const date = new Date().toUTCString();
    const header = [
      'From: <Saved by RobinRead>',
      `Snapshot-Content-Location: ${url}`,
      `Subject: =?utf-8?B?${Buffer.from(title, 'utf8').toString('base64')}?=`,
      `Date: ${date}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/related; type="text/html"; boundary="${boundary}"`,
      '',
      '',
    ].join('\r\n');
    const part = [
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      `Content-Location: ${url}`,
      '',
      saved,
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    return header + part;
  }

  /** boundary 候选：正文不包含才采用（最多 5 轮）。 */
  _makeBoundary(body) {
    for (let i = 0; i < 5; i += 1) {
      const candidate = `----=_RobinPart-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      if (!body.includes(candidate)) return candidate;
    }
    return '----=_RobinPart-fallback';
  }

  // MARK: - 追更源自动存档（订阅级开关，默认关）

  autoFeeds() {
    try {
      const parsed = JSON.parse(this.store.preferences.get(AUTO_KEY, '{}') || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  autoArchiveOn(feedID) {
    return this.autoFeeds()[feedID] === true;
  }

  /** enabled=true 开启；false 关闭（删键回默认关）。 */
  setAutoArchive(feedID, enabled) {
    const map = this.autoFeeds();
    if (enabled === true) map[feedID] = true;
    else delete map[feedID];
    this.store.preferences.set(AUTO_KEY, JSON.stringify(map));
    this.store._emitState();
    return map;
  }

  /** 灌文钩子（追更源落新文时）：开关开启才快照，异常静默不阻塞灌文。 */
  autoArchiveIfEnabled(feedID, entryID, html) {
    if (!this.autoArchiveOn(feedID)) return null;
    try {
      const result = this.archive(entryID, { html });
      this.counters.autoArchived += 1;
      return result;
    } catch (_) {
      return null; // 超 6MB / 无正文：跳过（不阻塞追更主流程）
    }
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return { ...this.counters, ...this.stats(), autoFeeds: this.autoFeeds() };
  }
}

module.exports = { ArchiveService, MAX_ENTRY_BYTES, LIST_LIMIT };
