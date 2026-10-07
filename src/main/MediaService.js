'use strict';
/**
 * RobinRead（知更）— 媒体中心服务（F3，播客/视频）
 *
 * - enclosure 入库：FeedParser 解析出媒体附件后由 _applyParsedEntries 事务内
 *   调 upsertFromParsed（PK 防重，重复刷新零重复行）；
 * - 媒体视图查询：media_items JOIN items/articles/feeds，索引命中 + LIMIT 分页，
 *   筛选 全部 / 未播完 / 已播完（已播完 = played_at 非空且续播位为 0）；
 * - 进度持久化：渲染层 5s 节流 + 暂停/关闭 flush 走 IPC；>95% 自动归零（视为播完）；
 * - 播放队列：主进程持有（偏好持久化），自动连播取下一条 queueNext；
 * - 离线下载：httpStream（net.fetch = 系统代理）流式写 userData/media/，
 *   大小上限 500MB、失败重试 1 次、进度经事件推给渲染层；播放器优先本地文件。
 *
 * 并发与安全：
 * - 同一条目同时只允许一个下载任务（_downloads 去重）；
 * - 下载写盘走 .part 临时文件，完成后原子 rename；
 * - 播放互斥（媒体 ↔ TTS）在渲染层裁决（单窗口内只有一个发声源），
 *   本服务只负责提供「当前是谁在播」之外的全部数据面。
 */
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { pathToFileURL } = require('node:url');
const { i18n } = require('./I18N');
const { stableDigest, nowSeconds, feedIconURL } = require('./Models');
const { httpStream } = require('./FeedService');

const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024; // 离线下载大小上限（500MB）
const DOWNLOAD_RETRY = 1;                      // 失败重试次数
const LIST_PAGE_MAX = 200;                     // 单页上限（视图分页 100）
const QUEUE_MAX = 100;                         // 队列上限
const FINISHED_RATIO = 0.95;                   // >95% 视为播完（归零）
const APP_UA = 'RobinRead/2.0 (+personal RSS reader)';

/** 本地文件扩展名（按 mime 优先，URL 扩展名兜底）。 */
function downloadExtension(mime, url) {
  const m = String(mime || '').toLowerCase();
  const byMime = {
    'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/aac': '.aac',
    'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/ogg': '.ogg',
    'audio/opus': '.opus', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
    'audio/flac': '.flac', 'video/mp4': '.mp4', 'video/webm': '.webm',
    'video/quicktime': '.mov', 'video/x-matroska': '.mkv',
  };
  if (byMime[m]) return byMime[m];
  const clean = String(url || '').split(/[?#]/)[0].toLowerCase();
  const ext = path.extname(clean);
  if (/^\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|mp4|m4v|webm|mov|mkv)$/.test(ext)) return ext;
  return m.startsWith('video/') ? '.mp4' : '.mp3';
}

/** media_items 行 → 视图载荷（JSON 列语义归一 + 派生字段）。 */
function rowToMediaItem(row) {
  const position = row.position_seconds == null ? null : Number(row.position_seconds);
  const duration = row.duration_seconds == null ? null : Number(row.duration_seconds);
  const playedAt = row.played_at == null ? null : Number(row.played_at);
  const finished = playedAt != null && (position == null || position <= 0);
  return {
    itemID: row.item_id,
    url: row.url,
    mime: row.mime ?? null,
    kind: row.kind === 'video' ? 'video' : 'audio',
    durationSeconds: duration,
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    playedAt,
    positionSeconds: position,
    finished,
    hasLocal: Boolean(row.local_path) && row.download_state === 'done',
    localPath: row.local_path ?? null,
    downloadState: row.download_state || 'none',
    downloadError: row.download_error ?? null,
    createdAt: row.created_at,
    // JOIN 投影（媒体视图行）
    title: row.title ?? '',
    sourceTitle: row.feed_title ?? '',
    publishedAt: row.published_at ?? row.item_created_at ?? null,
    // 封面 = 源图标（robin-icon:// 协议，与侧栏/列表同一缓存管线）
    feedIconURL: feedIconURL({
      storedIconURL: row.stored_icon_url ?? null,
      siteURL: row.site_url ?? null,
      feedURL: row.feed_url ?? '',
    }),
  };
}

class MediaService {
  /**
   * @param store AppStore（database / preferences）
   * @param userDataPath 应用数据目录（media/ 落盘根）
   */
  constructor(store, userDataPath) {
    this.store = store;
    this.userDataPath = userDataPath;
    this.mediaDir = path.join(userDataPath, 'media');
    this._progressListeners = new Set();
    this._downloads = new Map();      // itemID -> AbortController（在途下载）
    this._countsDirty = true;
    this._countsCache = null;
    this._queueCache = null;          // itemID 数组缓存（写时失效）
  }

  // MARK: - 进度推送（渲染层订阅）

  onDownloadProgress(listener) {
    this._progressListeners.add(listener);
    return () => this._progressListeners.delete(listener);
  }

  _emitProgress(payload) {
    for (const listener of this._progressListeners) {
      try { listener(payload); } catch (_) { /* 单监听异常不外溢 */ }
    }
  }

  // MARK: - 入库（灌文事务内调用）

  /**
   * enclosure 入库：PK(item_id) 防重——重复刷新零重复行；已存在时仅回填
   * 元数据（url/mime/kind/duration/size），绝不触碰播放进度与下载状态。
   */
  upsertFromParsed(itemID, enclosure) {
    if (!itemID || !enclosure || !enclosure.url) return false;
    const now = nowSeconds();
    this.store.database.prepare(`
      INSERT INTO media_items (item_id, url, mime, kind, duration_seconds, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        url = excluded.url,
        mime = COALESCE(excluded.mime, media_items.mime),
        kind = excluded.kind,
        duration_seconds = COALESCE(excluded.duration_seconds, media_items.duration_seconds),
        size_bytes = COALESCE(excluded.size_bytes, media_items.size_bytes)
    `).run(
      itemID, enclosure.url, enclosure.mime ?? null,
      enclosure.kind === 'video' ? 'video' : 'audio',
      enclosure.durationSeconds ?? null, enclosure.lengthBytes ?? null, now
    );
    this._invalidateCounts();
    return true;
  }

  forItem(itemID) {
    if (!itemID) return null;
    const row = this.store.database.prepare(`
      SELECT m.*, a.title AS title, f.title AS feed_title,
             f.stored_icon_url AS stored_icon_url, f.site_url AS site_url, f.feed_url AS feed_url,
             a.published_at AS published_at, i.created_at AS item_created_at
      FROM media_items m
      LEFT JOIN articles a ON a.item_id = m.item_id
      LEFT JOIN items i ON i.id = m.item_id
      LEFT JOIN feeds f ON f.id = i.feed_id
      WHERE m.item_id = ?
    `).get(itemID);
    return row ? rowToMediaItem(row) : null;
  }

  hasMedia(itemID) {
    if (!itemID) return false;
    return Boolean(this.store.database.prepare('SELECT 1 FROM media_items WHERE item_id = ?').get(itemID));
  }

  // MARK: - 媒体视图查询（走索引 + LIMIT 分页）

  /**
   * filter: all | unfinished | finished；kind: null | audio | video。
   * 已播完 = played_at 非空且 position_seconds 为 0/空；未播完 = 其余（含从未播放）。
   */
  list({ filter = 'all', kind = null, limit = 100, offset = 0 } = {}) {
    const cappedLimit = Math.max(1, Math.min(Number(limit) || 100, LIST_PAGE_MAX));
    const cappedOffset = Math.max(0, Number(offset) || 0);
    const where = [];
    const params = [];
    if (filter === 'unfinished') {
      where.push('(m.played_at IS NULL OR COALESCE(m.position_seconds, 0) > 0)');
    } else if (filter === 'finished') {
      where.push('m.played_at IS NOT NULL AND COALESCE(m.position_seconds, 0) = 0');
    }
    if (kind === 'audio' || kind === 'video') {
      where.push('m.kind = ?');
      params.push(kind);
    }
    const rows = this.store.database.prepare(`
      SELECT m.*, a.title AS title, f.title AS feed_title,
             f.stored_icon_url AS stored_icon_url, f.site_url AS site_url, f.feed_url AS feed_url,
             a.published_at AS published_at, i.created_at AS item_created_at
      FROM media_items m
      LEFT JOIN articles a ON a.item_id = m.item_id
      LEFT JOIN items i ON i.id = m.item_id
      LEFT JOIN feeds f ON f.id = i.feed_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(a.published_at, i.created_at, m.created_at) DESC
      LIMIT ${cappedLimit} OFFSET ${cappedOffset}
    `).all(...params);
    return rows.map(rowToMediaItem);
  }

  counts() {
    if (this._countsCache && !this._countsDirty) return this._countsCache;
    const row = this.store.database.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN played_at IS NOT NULL AND COALESCE(position_seconds, 0) = 0 THEN 1 ELSE 0 END) AS finished,
        SUM(CASE WHEN kind = 'video' THEN 1 ELSE 0 END) AS videos
      FROM media_items
    `).get();
    const total = Number(row?.total ?? 0);
    const finished = Number(row?.finished ?? 0);
    this._countsCache = {
      total,
      finished,
      unfinished: total - finished,
      videos: Number(row?.videos ?? 0),
    };
    this._countsDirty = false;
    return this._countsCache;
  }

  unfinishedCount() {
    return this.counts().unfinished;
  }

  _invalidateCounts() {
    this._countsDirty = true;
  }

  // MARK: - 播放进度（渲染层 5s 节流 + flush；主进程做 >95% 归零裁决）

  /**
   * 保存续播位置。finished=true（渲染层 'ended' 事件）或 position/duration > 95%
   * → 位置归零（= 已播完，媒体视图进「已播完」筛选）。position ≤ 0.5s 的保存
   * 跳过（拖回开头不算播完，且无可续播的值）。
   */
  saveProgress(itemID, positionSeconds, { finished = false } = {}) {
    if (!itemID || !this.hasMedia(itemID)) return null;
    const row = this.store.database.prepare(
      'SELECT duration_seconds FROM media_items WHERE item_id = ?'
    ).get(itemID);
    const duration = Number(row?.duration_seconds) || 0;
    const position = Math.max(0, Number(positionSeconds) || 0);
    const ratioDone = duration > 0 && position / duration > FINISHED_RATIO;
    const isDone = finished === true || ratioDone;
    const nextPosition = isDone ? 0 : position;
    if (!isDone && nextPosition <= 0.5) return this.forItem(itemID);
    this.store.database.prepare(
      'UPDATE media_items SET position_seconds = ?, played_at = ? WHERE item_id = ?'
    ).run(nextPosition, nowSeconds(), itemID);
    this._invalidateCounts();
    return this.forItem(itemID);
  }

  // MARK: - 播放源（本地优先）

  /**
   * 播放源解析：已离线（download_state=done 且文件存在）→ file:// 本地；
   * 否则远程 URL。position 为服务端裁决后的续播点（>95% 已归零）。
   */
  source(itemID) {
    const media = this.forItem(itemID);
    if (!media) return null;
    let localURL = null;
    if (media.hasLocal && media.localPath) {
      try {
        if (fs.existsSync(media.localPath)) localURL = pathToFileURL(media.localPath).href;
        else this.store.database.prepare(
          "UPDATE media_items SET download_state = 'none', local_path = NULL WHERE item_id = ?"
        ).run(itemID); // 文件被外部清理：状态回退远程
      } catch (_) { /* existsSync 异常按远程 */ }
    }
    return {
      itemID,
      kind: media.kind,
      url: localURL || media.url,
      isLocal: Boolean(localURL),
      position: media.finished ? 0 : (media.positionSeconds || 0),
      duration: media.durationSeconds,
      finished: media.finished,
      // 播放器元信息条（标题 / 源名）
      title: media.title,
      sourceTitle: media.sourceTitle,
      mime: media.mime,
    };
  }

  // MARK: - 播放队列（主进程持有，偏好持久化）

  _queue() {
    if (this._queueCache) return this._queueCache;
    try {
      const raw = JSON.parse(this.store.preferences.get('RobinRead.media.queue', '[]') || '[]');
      this._queueCache = Array.isArray(raw) ? raw.map(String).filter(Boolean).slice(0, QUEUE_MAX) : [];
    } catch (_) {
      this._queueCache = [];
    }
    return this._queueCache;
  }

  _saveQueue() {
    this.store.preferences.set('RobinRead.media.queue', JSON.stringify(this._queue() || []));
  }

  queueList() {
    const ids = this._queue();
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    const byID = new Map(this.store.database.prepare(`
      SELECT m.*, a.title AS title, f.title AS feed_title,
             f.stored_icon_url AS stored_icon_url, f.site_url AS site_url, f.feed_url AS feed_url,
             a.published_at AS published_at, i.created_at AS item_created_at
      FROM media_items m
      LEFT JOIN articles a ON a.item_id = m.item_id
      LEFT JOIN items i ON i.id = m.item_id
      LEFT JOIN feeds f ON f.id = i.feed_id
      WHERE m.item_id IN (${ph})
    `).all(...ids).map((row) => [row.item_id, rowToMediaItem(row)]));
    return ids.map((id) => byID.get(id)).filter(Boolean); // 保持队列顺序，孤儿 id 剔除
  }

  queueAdd(itemID) {
    if (!itemID || !this.hasMedia(itemID)) return this.queueList();
    const queue = this._queue();
    const index = queue.indexOf(itemID);
    if (index >= 0) queue.splice(index, 1); // 重复加入 → 移到队尾
    queue.push(itemID);
    while (queue.length > QUEUE_MAX) queue.shift();
    this._saveQueue();
    return this.queueList();
  }

  queueRemove(itemID) {
    const queue = this._queue();
    const index = queue.indexOf(itemID);
    if (index >= 0) {
      queue.splice(index, 1);
      this._saveQueue();
    }
    return this.queueList();
  }

  queueClear() {
    this._queueCache = [];
    this._saveQueue();
    return [];
  }

  /** 自动连播 / 跳下一首：afterID 在队列中的下一条（不在队列则取队首；空 → null）。 */
  queueNext(afterItemID) {
    const queue = this._queue();
    if (!queue.length) return null;
    const index = afterItemID ? queue.indexOf(afterItemID) : -1;
    const nextID = index >= 0 && index + 1 < queue.length ? queue[index + 1] : queue[0];
    return nextID === afterItemID ? null : this.source(nextID);
  }

  // MARK: - 离线下载（流式落盘 + 进度推送 + 重试 1 次）

  isDownloading(itemID) {
    return this._downloads.has(itemID);
  }

  activeDownloads() {
    return [...this._downloads.keys()];
  }

  /**
   * 下载媒体到 userData/media/。已离线 → 幂等返回现状；在途 → 去重。
   * 返回 { started, ok, item }；进度与终态经 onDownloadProgress 推送：
   *   { itemID, state: 'downloading'|'done'|'failed', received, total, error? }
   */
  async download(itemID) {
    const media = this.forItem(itemID);
    if (!media) throw new Error(i18n.localized('媒体不存在或已被删除。'));
    if (media.downloadState === 'done' && media.hasLocal) {
      return { started: false, ok: true, item: media };
    }
    if (this._downloads.has(itemID)) return { started: false, ok: true, item: media };

    const controller = new AbortController();
    this._downloads.set(itemID, controller);
    this.store.database.prepare(`
      UPDATE media_items SET download_state = 'downloading', download_error = NULL WHERE item_id = ?
    `).run(itemID);
    this._invalidateCounts();
    this._emitProgress({ itemID, state: 'downloading', received: 0, total: media.sizeBytes ?? null });

    try {
      fs.mkdirSync(this.mediaDir, { recursive: true });
      const filePath = path.join(
        this.mediaDir,
        `${stableDigest(itemID)}${downloadExtension(media.mime, media.url)}`
      );
      await this._downloadToFile(media, filePath, controller.signal);
      const bytes = fs.statSync(filePath).size;
      if (bytes <= 0) throw new Error(i18n.localized('下载内容为空。'));
      this.store.database.prepare(`
        UPDATE media_items SET download_state = 'done', local_path = ?, size_bytes = ?, download_error = NULL
        WHERE item_id = ?
      `).run(filePath, bytes, itemID);
      this._invalidateCounts();
      const item = this.forItem(itemID);
      this._emitProgress({ itemID, state: 'done', received: bytes, total: bytes });
      return { started: true, ok: true, item };
    } catch (err) {
      const message = String(err?.message || err);
      this.store.database.prepare(`
        UPDATE media_items SET download_state = 'failed', download_error = ?, local_path = NULL WHERE item_id = ?
      `).run(message, itemID);
      this._invalidateCounts();
      this._emitProgress({ itemID, state: 'failed', received: 0, total: null, error: message });
      return { started: true, ok: false, error: message, item: this.forItem(itemID) };
    } finally {
      this._downloads.delete(itemID);
    }
  }

  async _downloadToFile(media, filePath, signal) {
    const attempt = async () => {
      const partPath = `${filePath}.part`;
      let received = 0;
      let lastPushAt = 0;
      const source = await httpStream(media.url, {
        headers: { 'User-Agent': APP_UA, Accept: '*/*' },
        signal,
      });
      if (source.status >= 400) {
        try { await source.webStream?.cancel?.(); } catch (_) { /* 已关闭 */ }
        throw new Error(`HTTP ${source.status}`);
      }
      const totalHeader = Number(source.headers?.get?.('content-length'));
      const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : (media.sizeBytes ?? null);
      if (total && total > MAX_DOWNLOAD_BYTES) {
        try { await source.webStream?.cancel?.(); } catch (_) { /* 已关闭 */ }
        throw new Error(i18n.localized('文件超过 500MB 上限，已取消下载。'));
      }
      try {
        const nodeStream = Readable.fromWeb(source.webStream);
        const fileStream = fs.createWriteStream(partPath);
        nodeStream.on('data', (chunk) => {
          received += chunk.length;
          if (received > MAX_DOWNLOAD_BYTES) nodeStream.destroy(new Error(i18n.localized('文件超过 500MB 上限，已取消下载。')));
          const now = Date.now();
          if (now - lastPushAt > 250) { // 4 次/秒封顶的进度推送（IPC 频率护栏）
            lastPushAt = now;
            this._emitProgress({ itemID: media.itemID, state: 'downloading', received, total });
          }
        });
        await pipeline(nodeStream, fileStream);
        fs.renameSync(partPath, filePath); // 原子替换：半成品绝不冒充成品
      } catch (err) {
        try { fs.rmSync(partPath, { force: true }); } catch (_) { /* 清理失败可忽略 */ }
        throw err;
      }
    };
    // 失败重试 1 次（网络抖动 / 短暂 5xx）；用户中止（abort）不重试
    try {
      await attempt();
    } catch (err) {
      if (signal.aborted) throw err;
      await attempt();
    }
  }

  /** 删除离线文件（恢复远程播放；下载状态回 none）。失败可重试下载。 */
  deleteDownload(itemID) {
    const media = this.forItem(itemID);
    if (!media) return null;
    if (media.localPath) {
      try { fs.rmSync(media.localPath, { force: true }); } catch (_) { /* 尽力而为 */ }
    }
    if (this._downloads.has(itemID)) {
      try { this._downloads.get(itemID).abort(); } catch (_) { /* 在途任务自行收尾 */ }
    }
    this.store.database.prepare(`
      UPDATE media_items SET download_state = 'none', local_path = NULL, download_error = NULL WHERE item_id = ?
    `).run(itemID);
    this._invalidateCounts();
    return this.forItem(itemID);
  }

  /** 应用退出：中止在途下载（.part 由 attempt 的 catch 清理）。 */
  dispose() {
    for (const controller of this._downloads.values()) {
      try { controller.abort(); } catch (_) { /* 已中止 */ }
    }
    this._downloads.clear();
  }
}

module.exports = {
  MediaService,
  enclosureExtension: downloadExtension,
  LIMITS: {
    MAX_DOWNLOAD_BYTES, DOWNLOAD_RETRY, LIST_PAGE_MAX, QUEUE_MAX, FINISHED_RATIO,
  },
};
