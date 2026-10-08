'use strict';
/**
 * RobinRead（知更）— 个人文集自动成书服务（F12）
 *
 * 文集（Book）= 绑定若干订阅源的「书」。手动「立即成书」经保存对话框落盘；
 * schedule=auto 的文集在刷新完成后自动成书（≥24h 节流 + 该源有新文章才成），
 * 产物写 userData/books/<bookId>/（应用数据区白名单内，无需 pickSavePath token）。
 *
 * 结构（EpubBuilder.buildBookEpub）：
 * - 文章按发布时间升序；章节 = 按月分章（`YYYY年M月`），章内按时间升序；
 * - 分卷：每 VOLUME_SIZE(200) 篇一卷（`书名 vol.2`），确定性（同输入同输出）；
 * - 封面：首个绑定源的本地缓存 icon；无缓存 icon 则纯色标题封面（不阻塞、不打网络）。
 *
 * 写盘安全（ipc.js P2-11 契约）：自动目录固定在 userData 子目录（assertWritablePath
 * 白名单语义内）；用户手动成书经主进程保存对话框（backup:export 同款先例），不经渲染层写通道。
 */
const fs = require('node:fs');
const path = require('node:path');
const EpubBuilder = require('./EpubBuilder');
const { sanitizeStem } = require('./ObsidianExportService');
const { nowSeconds } = require('./Models');

const VOLUME_SIZE = 200;             // 每卷篇数（1000 篇 → 5 卷 vol.1–5，确定性切分）
const MAX_BUILD_ARTICLES = 20000;    // 单次成书篇数硬上限（防失控；确定性截断保留最早的 VOLUME_SIZE 整数倍）
const AUTO_INTERVAL_SECONDS = 24 * 3600; // 自动成书节流：≥24h
const BOOKS_DIR_NAME = 'books';
const PICKED_AT_PREF = (id) => `RobinRead.books.pickedAt.${id}`;

/** 秒级时间戳 → `YYYY年M月`（分章标题；无效时间归入「早期文章」）。 */
function monthChapterTitle(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '早期文章';
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return '早期文章';
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

/** 卷文件名：单卷 `书名.epub`；多卷 `书名 vol.N.epub`（v1 同样带卷号，顺序浏览不歧义）。 */
function volumeFileName(bookTitle, volumeIndex, totalVolumes) {
  const stem = sanitizeStem(bookTitle) || 'RobinRead Book';
  return totalVolumes > 1 ? `${stem} vol.${volumeIndex}.epub` : `${stem}.epub`;
}

/** 手动成书第 N 卷路径：第 1 卷用用户所选路径，第 N 卷落在其旁 `<stem> vol.N<ext>`。 */
function manualVolumePath(savePath, volumeIndex, totalVolumes) {
  if (volumeIndex <= 1) return savePath;
  const ext = path.extname(savePath) || '.epub';
  const stem = savePath.slice(0, savePath.length - ext.length);
  return `${stem} vol.${volumeIndex}${ext}`;
}

class BooksService {
  constructor(store, userDataPath) {
    this.store = store;
    this.booksRoot = path.join(userDataPath, BOOKS_DIR_NAME);
    this._chain = Promise.resolve(); // 自动成书串行化（防并发写同一文集目录）
    // 封面 icon 只读本地缓存（内存/磁盘，与 robin-icon:// 协议共享同一 favicons 目录），
    // 绝不在成书路径上打网络——保证离线确定性（无缓存即纯色标题封面）。
    const { FeedIconStore } = require('./FeedIconStore');
    this._icons = new FeedIconStore(path.join(userDataPath, 'favicons'));
  }

  // MARK: 行映射与 CRUD

  _rowToBook(row) {
    let feedIDs = [];
    try { feedIDs = JSON.parse(row.feed_ids_json || '[]'); } catch (_) { feedIDs = []; }
    if (!Array.isArray(feedIDs)) feedIDs = [];
    return {
      id: row.id,
      title: row.title,
      feedIDs,
      schedule: row.schedule,
      lastBuiltAt: row.last_built_at ?? null,
      lastEntryCount: row.last_entry_count ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  _book(id) {
    const row = this.store.database.prepare('SELECT * FROM books WHERE id = ?').get(id);
    return row ? this._rowToBook(row) : null;
  }

  listBooks() {
    const rows = this.store.database.prepare('SELECT * FROM books ORDER BY created_at ASC').all();
    return rows.map((row) => {
      const book = this._rowToBook(row);
      return {
        ...book,
        feedCount: book.feedIDs.length,
        pendingPick: this.pendingPick(book),
        autoDir: this.autoDir(book.id),
        lastFiles: this.lastFiles(book),
      };
    });
  }

  createBook({ title, feedIDs, schedule } = {}) {
    const name = String(title ?? '').trim();
    if (!name) throw new Error('文集名称不能为空');
    if (name.length > 120) throw new Error('文集名称过长（最多 120 字）');
    const ids = (Array.isArray(feedIDs) ? feedIDs : []).map((v) => String(v)).filter(Boolean);
    const now = nowSeconds();
    const id = `bk-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const sched = schedule === 'auto' ? 'auto' : 'manual';
    this.store.database.prepare(`
      INSERT INTO books (id, title, feed_ids_json, schedule, last_built_at, last_entry_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, 0, ?, ?)
    `).run(id, name, JSON.stringify(ids), sched, now, now);
    return this._book(id);
  }

  updateBook(id, patch = {}) {
    const book = this._book(id);
    if (!book) throw new Error('文集不存在');
    const next = { ...book };
    if (patch.title != null) {
      const name = String(patch.title).trim();
      if (!name) throw new Error('文集名称不能为空');
      if (name.length > 120) throw new Error('文集名称过长（最多 120 字）');
      next.title = name;
    }
    if (patch.feedIDs != null) {
      next.feedIDs = (Array.isArray(patch.feedIDs) ? patch.feedIDs : []).map((v) => String(v)).filter(Boolean);
    }
    if (patch.schedule === 'auto' || patch.schedule === 'manual') next.schedule = patch.schedule;
    this.store.database.prepare(`
      UPDATE books SET title = ?, feed_ids_json = ?, schedule = ?, updated_at = ? WHERE id = ?
    `).run(next.title, JSON.stringify(next.feedIDs), next.schedule, nowSeconds(), id);
    return this._book(id);
  }

  /** 右键「加入文集」：把订阅源并入文集（幂等去重，保持既有顺序）。 */
  addFeeds(id, feedIDs) {
    const book = this._book(id);
    if (!book) throw new Error('文集不存在');
    const merged = [...book.feedIDs];
    for (const feedID of (Array.isArray(feedIDs) ? feedIDs : []).map((v) => String(v))) {
      if (feedID && !merged.includes(feedID)) merged.push(feedID);
    }
    return this.updateBook(id, { feedIDs: merged });
  }

  /** 删除文集：只删 books 行 + userData/books/<id> 自动目录；用户 pickSavePath 落盘的书不删。 */
  deleteBook(id) {
    const book = this._book(id);
    if (!book) return false;
    this.store.database.prepare('DELETE FROM books WHERE id = ?').run(id);
    try { fs.rmSync(this.autoDir(id), { recursive: true, force: true }); } catch (_) { /* 目录不存在等 */ }
    try { this.store.preferences.remove?.(PICKED_AT_PREF(id)); } catch (_) { /* 偏好清理尽力而为 */ }
    return true;
  }

  // MARK: 目录与「待取」态

  autoDir(bookID) { return path.join(this.booksRoot, String(bookID)); }

  /** 自动目录内现存的 EPUB 文件名（新→旧）。 */
  lastFiles(book) {
    try {
      return fs.readdirSync(this.autoDir(book.id))
        .filter((f) => f.toLowerCase().endsWith('.epub'))
        .map((f) => {
          let m = 0;
          try { m = fs.statSync(path.join(this.autoDir(book.id), f)).mtimeMs; } catch (_) { /* 已消失 */ }
          return { name: f, mtimeMs: m };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map((f) => f.name);
    } catch (_) { return []; }
  }

  /** 「待取」：自动文集有产物、且自上次成书后用户尚未打开过目录。 */
  pendingPick(book) {
    if (book.schedule !== 'auto' || !book.lastBuiltAt) return false;
    if (!this.lastFiles(book).length) return false;
    const pickedAt = Number(this.store.preferences.get(PICKED_AT_PREF(book.id), 0)) || 0;
    return pickedAt < book.lastBuiltAt;
  }

  /** 用户点了「打开目录」：清除「待取」徽标。 */
  markPicked(bookID) {
    try { this.store.preferences.set(PICKED_AT_PREF(bookID), nowSeconds()); } catch (_) { /* 尽力而为 */ }
  }

  // MARK: 数据收集（升序 + 正文解析）

  /**
   * 收集文集全部文章（发布时间升序；published 缺失回退 created_at，同序 tiebreak id 保稳定）。
   * 正文：正文缓存 → 消毒后的 feed 正文 → 摘要段落。无任何内容则跳过。
   */
  gatherEntries(book) {
    const ids = book.feedIDs.filter(Boolean);
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.store.database.prepare(`
      SELECT i.id, i.feed_id, i.created_at,
             a.title, a.author, a.url, a.published_at, a.summary, a.content_html,
             c.html AS cached_html, c.is_sanitized AS cache_sanitized,
             f.title AS feed_title
      FROM items i
      JOIN articles a ON a.item_id = i.id
      LEFT JOIN article_caches c ON c.item_id = i.id
      JOIN feeds f ON f.id = i.feed_id
      WHERE i.feed_id IN (${placeholders})
      ORDER BY COALESCE(a.published_at, i.created_at) ASC, i.id ASC
      LIMIT ?
    `).all(...ids, MAX_BUILD_ARTICLES);
    const ArticleExtractor = require('./ArticleExtractor');
    const out = [];
    for (const row of rows) {
      let html = '';
      if (row.cached_html && String(row.cached_html).trim()) html = String(row.cached_html);
      else if (row.content_html && String(row.content_html).trim()) {
        try {
          html = ArticleExtractor.sanitizedHTML(ArticleExtractor.normalizeFeedMarkup(String(row.content_html)), row.url);
        } catch (_) { html = ''; }
      }
      if (!html.trim() && row.summary && String(row.summary).trim()) html = `<p>${String(row.summary)}</p>`;
      if (!html.trim()) continue;
      out.push({
        id: row.id,
        title: String(row.title || '').trim() || '未命名文章',
        feedTitle: String(row.feed_title || ''),
        publishedAt: Number(row.published_at) || Number(row.created_at) || 0,
        html,
      });
    }
    return out;
  }

  /** 该源自上次成书以来是否有新文章（自动成书门槛）。 */
  hasNewEntriesSince(book, sinceSeconds) {
    const ids = book.feedIDs.filter(Boolean);
    if (!ids.length) return false;
    const placeholders = ids.map(() => '?').join(',');
    const row = this.store.database.prepare(`
      SELECT MAX(COALESCE(a.published_at, i.created_at)) AS newest
      FROM items i JOIN articles a ON a.item_id = i.id
      WHERE i.feed_id IN (${placeholders})
    `).get(...ids);
    const newest = Number(row?.newest) || 0;
    return newest > (Number(sinceSeconds) || 0);
  }

  // MARK: 组卷与成书

  /** 文章 → 月分章 sections（升序连续分组；篇数无上限，分卷由调用方切）。 */
  static monthSections(entries) {
    const sections = [];
    for (const entry of entries) {
      const title = monthChapterTitle(entry.publishedAt);
      const last = sections[sections.length - 1];
      if (last && last.title === title) last.articles.push(entry);
      else sections.push({ title, articles: [entry] });
    }
    return sections;
  }

  /** 组卷：每 VOLUME_SIZE 篇一卷，返回 [{ title, fileName, buffer, entryCount }]（确定性）。
   *  entries 缺省时自行收集（gatherEntries）。 */
  async buildVolumes(book, entriesArg, { cover = undefined } = {}) {
    const list = (entriesArg ?? this.gatherEntries(book)).slice(0, MAX_BUILD_ARTICLES);
    if (!list.length) throw new Error('文集内暂无有正文的文章');
    const coverImage = cover !== undefined ? cover : await this.feedCover(book);
    const volumes = [];
    const total = Math.ceil(list.length / VOLUME_SIZE);
    for (let v = 0; v < total; v += 1) {
      const slice = list.slice(v * VOLUME_SIZE, (v + 1) * VOLUME_SIZE);
      const volumeTitle = total > 1 ? `${book.title} vol.${v + 1}` : book.title;
      const buffer = EpubBuilder.buildBookEpub({
        title: volumeTitle,
        author: 'RobinRead',
        sections: BooksService.monthSections(slice),
        cover: coverImage,
      });
      volumes.push({
        title: volumeTitle,
        fileName: volumeFileName(book.title, v + 1, total),
        buffer,
        entryCount: slice.length,
      });
    }
    return volumes;
  }

  /** 封面图：首个绑定源的本地缓存 icon（dataURL → { mime, base64 }）；无则 null（纯色标题封面）。 */
  async feedCover(book) {
    for (const feedID of book.feedIDs) {
      const feed = this.store.feedsRepo.feed?.(feedID);
      if (!feed) continue;
      let host = '';
      try { host = ((feed.siteURL && new URL(feed.siteURL).hostname) || (feed.feedURL && new URL(feed.feedURL).hostname) || '').toLowerCase(); } catch (_) { /* 忽略 */ }
      const dataURL = this._icons.loadCached({
        storedIconURL: feed.storedIconURL || '',
        siteURL: feed.siteURL || '',
        feedURL: feed.feedURL || '',
        host,
      });
      if (!dataURL) continue;
      const comma = dataURL.indexOf(',');
      if (comma < 0) continue;
      const mime = dataURL.slice(5, comma).split(';')[0] || 'image/png';
      if (!mime.startsWith('image/') || /svg/i.test(mime)) continue; // SVG icon 直接跳过：统一走纯色标题封面
      return { mime, base64: dataURL.slice(comma + 1) };
    }
    return null;
  }

  /** 自动成书落盘：清空该文集自动目录后写入全部卷（产物可再生，只保留最新一次）。 */
  async buildToAutoDir(book) {
    const entries = this.gatherEntries(book);
    if (!entries.length) return null;
    const volumes = await this.buildVolumes(book, entries);
    const dir = this.autoDir(book.id);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of this.lastFiles(book)) {
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch (_) { /* 尽力而为 */ }
    }
    const files = [];
    for (const volume of volumes) {
      fs.writeFileSync(path.join(dir, volume.fileName), volume.buffer);
      files.push(volume.fileName);
    }
    this._markBuilt(book.id, entries.length);
    return { dir, files, entryCount: entries.length, volumes: volumes.length };
  }

  /** 手动成书落盘：第 1 卷写用户所选路径，第 N 卷落其旁。返回 [{ path, name }]。 */
  async buildToPath(book, savePath) {
    const entries = this.gatherEntries(book);
    if (!entries.length) throw new Error('文集内暂无有正文的文章');
    const volumes = await this.buildVolumes(book, entries);
    const written = [];
    volumes.forEach((volume, index) => {
      const target = manualVolumePath(savePath, index + 1, volumes.length);
      fs.writeFileSync(target, volume.buffer);
      written.push({ path: target, name: path.basename(target) });
    });
    this._markBuilt(book.id, entries.length);
    return { path: savePath, files: written, entryCount: entries.length, volumes: volumes.length };
  }

  _markBuilt(bookID, entryCount) {
    this.store.database.prepare('UPDATE books SET last_built_at = ?, last_entry_count = ?, updated_at = ? WHERE id = ?')
      .run(nowSeconds(), entryCount, nowSeconds(), bookID);
  }

  // MARK: 自动成书（刷新完成后 kick；≥24h 节流 + 有新文章才成）

  /** 刷新收尾入口（AppStore.refresh 完成后调用；逐文集独立容错，绝不阻塞刷新路径）。 */
  kick() {
    const run = this._chain.catch(() => {}).then(() => this._kickOnce());
    this._chain = run.catch(() => {});
    return run;
  }

  async _kickOnce() {
    let autos = [];
    try {
      autos = this.store.database.prepare("SELECT * FROM books WHERE schedule = 'auto'").all().map((r) => this._rowToBook(r));
    } catch (_) { return { built: 0, skipped: 0 }; }
    let built = 0;
    let skipped = 0;
    for (const book of autos) {
      try {
        const due = !book.lastBuiltAt || (nowSeconds() - book.lastBuiltAt) >= AUTO_INTERVAL_SECONDS;
        if (!due) { skipped += 1; continue; }
        if (!book.feedIDs.length || !this.hasNewEntriesSince(book, book.lastBuiltAt)) { skipped += 1; continue; }
        const result = await this.buildToAutoDir(book);
        if (result) built += 1; else skipped += 1;
      } catch (_) { skipped += 1; /* 单文集失败不拖垮其余 */ }
    }
    return { built, skipped };
  }
}

module.exports = {
  BooksService,
  VOLUME_SIZE,
  MAX_BUILD_ARTICLES,
  AUTO_INTERVAL_SECONDS,
  BOOKS_DIR_NAME,
  monthChapterTitle,
  volumeFileName,
  manualVolumePath,
};
