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
// ── 转写（F22）──
const TRANSCRIBE_PREF_KEY = 'RobinRead.media.transcribe'; // 配置（JSON：enabled/url/model；apiKey 走 CredentialStore DPAPI，批 A 审查 P1-2）
const TRANSCRIBE_TIMEOUT_MS = 30 * 60 * 1000;  // 单次转写总看门狗（本地 whisper 长音频可到数十分钟）
const TRANSCRIBE_HEADERS_MS = 30000;           // 建连/出响应头超时（照下载看门狗 30s 口径）
const TRANSCRIBE_TEXT_CAP = 2 * 1024 * 1024;   // 文字稿落库上限（2MB，超出截断）

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
    // 转写（F22）：状态徽标（queued/running/done/error）与「稿」徽标数据面
    transcriptStatus: row.transcript_status ?? null,
    hasTranscript: Number(row.has_transcript ?? 0) === 1,
    transcriptLanguage: row.transcript_language ?? null,
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
    // 转写（F22）：单飞队列 + 进度订阅 + FTS 可用性缓存
    this._transcribeListeners = new Set();
    this._transcribeQueue = [];       // 排队 itemID（单飞：同时仅 1 个 running）
    this._transcribeRunning = null;   // 在途 itemID
    this._ftsReady = null;            // null = 未探测；boolean 缓存
    this._llmComplete = null;         // 注入缝：AI 摘要 LLM 调用（探针 mock；缺省走 store.llm）
    // 崩溃恢复（批 A 审查 P1-1）：上次进程在 queued/running 中途退出→标 error 可重试，
    // 否则重启后该行永久停在「转写中…」且无重试按钮
    try {
      this.store.database.prepare(`
        UPDATE media_transcripts SET status = 'error', error = '上次中断，可重试', updated_at = ?
        WHERE status IN ('queued', 'running')
      `).run(nowSeconds());
    } catch (_) { /* 表尚未迁移（极老库）时静默，迁移后自然为空 */ }
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
             a.published_at AS published_at, i.created_at AS item_created_at,
             tr.status AS transcript_status,
             CASE WHEN tr.status = 'done' AND IFNULL(tr.text, '') != '' THEN 1 ELSE 0 END AS has_transcript,
             tr.language AS transcript_language
      FROM media_items m
      LEFT JOIN articles a ON a.item_id = m.item_id
      LEFT JOIN items i ON i.id = m.item_id
      LEFT JOIN feeds f ON f.id = i.feed_id
      LEFT JOIN media_transcripts tr ON tr.item_id = m.item_id
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
   * query（F22）：文字稿关键字过滤——非空时仅返回文字稿命中该词的媒体行
   * （FTS trigram 命中；<3 字符或 FTS 不可用回退 LIKE，与 SearchIndex 同口径）。
   */
  list({ filter = 'all', kind = null, query = null, limit = 100, offset = 0 } = {}) {
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
    const needle = String(query || '').trim();
    if (needle) {
      const fts = this._ftsAvailable();
      if (fts && [...needle].length >= 3) {
        // FTS5 短语查询：双引号包裹防语法注入（内嵌双引号翻倍转义）
        where.push(`m.item_id IN (SELECT item_id FROM media_transcripts_fts WHERE media_transcripts_fts MATCH ?)`);
        params.push(`"${needle.replace(/"/g, '""')}"`);
      } else {
        where.push(`m.item_id IN (SELECT item_id FROM media_transcripts WHERE text LIKE ? ESCAPE '\\')`);
        params.push(`%${needle.replace(/([%_\\])/g, '\\$1')}%`);
      }
    }
    const rows = this.store.database.prepare(`
      SELECT m.*, a.title AS title, f.title AS feed_title,
             f.stored_icon_url AS stored_icon_url, f.site_url AS site_url, f.feed_url AS feed_url,
             a.published_at AS published_at, i.created_at AS item_created_at,
             tr.status AS transcript_status,
             CASE WHEN tr.status = 'done' AND IFNULL(tr.text, '') != '' THEN 1 ELSE 0 END AS has_transcript,
             tr.language AS transcript_language
      FROM media_items m
      LEFT JOIN articles a ON a.item_id = m.item_id
      LEFT JOIN items i ON i.id = m.item_id
      LEFT JOIN feeds f ON f.id = i.feed_id
      LEFT JOIN media_transcripts tr ON tr.item_id = m.item_id
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
             a.published_at AS published_at, i.created_at AS item_created_at,
             tr.status AS transcript_status,
             CASE WHEN tr.status = 'done' AND IFNULL(tr.text, '') != '' THEN 1 ELSE 0 END AS has_transcript,
             tr.language AS transcript_language
      FROM media_items m
      LEFT JOIN articles a ON a.item_id = m.item_id
      LEFT JOIN items i ON i.id = m.item_id
      LEFT JOIN feeds f ON f.id = i.feed_id
      LEFT JOIN media_transcripts tr ON tr.item_id = m.item_id
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
    // 只允许远程 http(s) 源：恶意 feed 可构造 file:// 等 URL 诱导主进程拷贝本机文件
    if (!/^https?:\/\//i.test(String(media.url || ''))) {
      throw new Error(i18n.localized('仅支持下载 http(s) 链接的媒体。'));
    }
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
      await this._downloadToFile(media, filePath, controller);
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

  async _downloadToFile(media, filePath, controller, { onProgress = null } = {}) {
    const signal = controller.signal;
    const STALL_MS = 45000; // inactivity 看门狗：45s 无新字节视为流停摆（对照 fetchFeed 30s 超时口径）
    const attempt = async () => {
      const partPath = `${filePath}.part`;
      let received = 0;
      let lastPushAt = 0;
      // 建连/出 header 阶段超时：30s 拿不到响应头即中止底层连接（避免永久挂起占用下载槽）
      let headerTimer = null;
      const source = await Promise.race([
        httpStream(media.url, {
          headers: { 'User-Agent': APP_UA, Accept: '*/*' },
          signal,
        }),
        new Promise((_, reject) => {
          headerTimer = setTimeout(() => {
            try { controller.abort(); } catch (_) { /* 已中止 */ }
            reject(Object.assign(new Error(i18n.localized('下载连接超时。')), { permanent: true }));
          }, 30000);
        }),
      ]).finally(() => headerTimer && clearTimeout(headerTimer));
      if (source.status >= 400) {
        try { await source.webStream?.cancel?.(); } catch (_) { /* 已关闭 */ }
        // 4xx/5xx 是永久性失败：重试只会再打一次服务器（客户端错误不可能自愈）
        throw Object.assign(new Error(`HTTP ${source.status}`), { permanent: source.status < 500 || source.status === 501 });
      }
      const totalHeader = Number(source.headers?.get?.('content-length'));
      const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : (media.sizeBytes ?? null);
      if (total && total > MAX_DOWNLOAD_BYTES) {
        try { await source.webStream?.cancel?.(); } catch (_) { /* 已关闭 */ }
        throw Object.assign(new Error(i18n.localized('文件超过 500MB 上限，已取消下载。')), { permanent: true });
      }
      let stallTimer = null;
      let lastDataAt = Date.now();
      try {
        const nodeStream = Readable.fromWeb(source.webStream);
        const fileStream = fs.createWriteStream(partPath);
        stallTimer = setInterval(() => {
          if (Date.now() - lastDataAt > STALL_MS) {
            nodeStream.destroy(Object.assign(new Error(i18n.localized('下载连接超时。')), { permanent: false })); // 停摆属瞬时故障，可重试
          }
        }, 10000);
        nodeStream.on('data', (chunk) => {
          lastDataAt = Date.now();
          received += chunk.length;
          if (received > MAX_DOWNLOAD_BYTES) nodeStream.destroy(Object.assign(new Error(i18n.localized('文件超过 500MB 上限，已取消下载。')), { permanent: true }));
          const now = Date.now();
          if (now - lastPushAt > 250) { // 4 次/秒封顶的进度推送（IPC 频率护栏）
            lastPushAt = now;
            this._emitProgress({ itemID: media.itemID, state: 'downloading', received, total });
            if (onProgress) onProgress(received, total); // 转写取源进度（F22：媒体视图「转写中 %」徽标）
          }
        });
        await pipeline(nodeStream, fileStream);
        fs.renameSync(partPath, filePath); // 原子替换：半成品绝不冒充成品
      } catch (err) {
        try { fs.rmSync(partPath, { force: true }); } catch (_) { /* 清理失败可忽略 */ }
        throw err;
      } finally {
        if (stallTimer) clearInterval(stallTimer);
      }
    };
    // 失败重试 1 次（网络抖动 / 短暂 5xx）；用户中止（abort）与永久性失败（4xx/超限/超时）不重试
    try {
      await attempt();
    } catch (err) {
      if (signal.aborted || err?.permanent) throw err;
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

  /** 批量删除离线文件（条目淘汰/清理路径用）：只删 media 目录内的文件，防误删。 */
  deleteLocalFiles(paths) {
    for (const p of Array.isArray(paths) ? paths : []) {
      try {
        if (p && path.resolve(p).startsWith(this.mediaDir + path.sep)) fs.rmSync(p, { force: true });
      } catch (_) { /* 尽力而为 */ }
    }
  }

  // MARK: - 转写（F22：媒体音频 → 本地 ASR → 可搜索/可看/可 AI 摘要）

  onTranscribeProgress(listener) {
    this._transcribeListeners.add(listener);
    return () => this._transcribeListeners.delete(listener);
  }

  _emitTranscribe(payload) {
    for (const listener of this._transcribeListeners) {
      try { listener(payload); } catch (_) { /* 单监听异常不外溢 */ }
    }
  }

  /** FTS 虚表可用性（v22 建，FTS5 缺失环境静默跳过；结果缓存）。 */
  _ftsAvailable() {
    if (this._ftsReady != null) return this._ftsReady;
    try {
      this._ftsReady = !!this.store.database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='media_transcripts_fts'"
      ).get();
    } catch (_) {
      this._ftsReady = false;
    }
    return this._ftsReady;
  }

  /** 转写端点配置（偏好持久化；默认关闭且未配置——不内置任何云端默认）。
   *  apiKey 不在此返回（批 A 审查 P1-2）：走 CredentialStore DPAPI，对外只给 hasKey。 */
  transcribeConfig() {
    let raw = {};
    try { raw = JSON.parse(this.store.preferences.get(TRANSCRIBE_PREF_KEY, '{}') || '{}') || {}; }
    catch (_) { raw = {}; }
    // 旧版明文迁移：preferences.json 里残留的 apiKey 一次性搬进 CredentialStore 并从 JSON 剥离
    if (raw.apiKey) {
      try { this.store.credentials.setTranscribeAPIKey(String(raw.apiKey)); } catch (_) { /* 凭据写失败保留原值不丢 */ }
      delete raw.apiKey;
      try { this.store.preferences.set(TRANSCRIBE_PREF_KEY, JSON.stringify(raw)); } catch (_) { /* 忽略 */ }
    }
    return {
      enabled: raw.enabled === true,
      url: String(raw.url || '').trim(),
      model: String(raw.model || '').trim() || 'whisper-1',
      hasKey: Boolean(this._transcribeApiKey()),
    };
  }

  /** ASR 鉴权 Key（仅主进程内部上传使用；DPAPI 落盘）。 */
  _transcribeApiKey() {
    try { return this.store.credentials.transcribeAPIKey() || ''; }
    catch (_) { return ''; }
  }

  /** 写回配置（URL 必须是 http(s)；apiKey 仅在 patch 显式携带时写凭据库，空串=清除）。 */
  transcribeSetConfig(patch) {
    const p = patch || {};
    const next = { ...this.transcribeConfig(), ...(p || {}) };
    next.enabled = next.enabled === true;
    next.url = String(next.url || '').trim();
    next.model = String(next.model || '').trim() || 'whisper-1';
    if (next.url && !/^https?:\/\//i.test(next.url)) {
      throw new Error(i18n.localized('转写端点必须是 http(s) 地址。'));
    }
    if (Object.prototype.hasOwnProperty.call(p, 'apiKey')) {
      this.store.credentials.setTranscribeAPIKey(String(p.apiKey || ''));
    }
    this.store.preferences.set(TRANSCRIBE_PREF_KEY, JSON.stringify({
      enabled: next.enabled, url: next.url, model: next.model,
    }));
    return this.transcribeConfig();
  }

  /** 单条转写是否可用（配置开启且端点已填）→ UI 灰置依据。 */
  transcribeReady() {
    const cfg = this.transcribeConfig();
    return Boolean(cfg.enabled && cfg.url);
  }

  /** 转写产物读回（面板载荷；segments_json 解析失败按纯文本降级）。 */
  transcript(itemID) {
    const row = this.store.database.prepare(
      'SELECT * FROM media_transcripts WHERE item_id = ?'
    ).get(String(itemID || ''));
    if (!row) {
      return { itemID: String(itemID || ''), status: 'none', text: '', language: null,
        durationSeconds: null, segments: null, summary: null, error: null };
    }
    let segments = null;
    try {
      const parsed = JSON.parse(row.segments_json || 'null');
      if (Array.isArray(parsed) && parsed.length) segments = parsed;
    } catch (_) { /* 坏 JSON：按纯文本降级 */ }
    return {
      itemID: row.item_id,
      status: row.status,
      text: row.text || '',
      language: row.language ?? null,
      durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
      segments,
      summary: row.summary ?? null,
      error: row.error ?? null,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 发起转写：状态机 queued →（单飞）running → done | error。
   * 已 done 幂等返回现状；在途去重；error/none 入队（失败重试 = 再次调用本方法）。
   * 未配置端点 / 非音频条目 → 明确报错（渲染层按钮灰置前置拦截）。
   */
  transcribe(itemID) {
    const id = String(itemID || '');
    const media = this.forItem(id);
    if (!media) throw new Error(i18n.localized('媒体不存在或已被删除。'));
    if (media.kind !== 'audio') throw new Error(i18n.localized('仅支持为音频条目转写文字稿。'));
    if (!this.transcribeReady()) {
      throw new Error(i18n.localized('尚未配置转写端点：请在设置 → 转写中开启并填写 OpenAI 兼容端点。'));
    }
    const current = this.transcript(id);
    if (current.status === 'done') return current;
    if (current.status === 'running') return current;
    const now = nowSeconds();
    this.store.database.prepare(`
      INSERT INTO media_transcripts (item_id, status, text, created_at, updated_at)
      VALUES (?, 'queued', '', ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET status = 'queued', error = NULL, updated_at = excluded.updated_at
    `).run(id, now, now);
    this._emitTranscribe({ itemID: id, state: 'queued' });
    if (!this._transcribeQueue.includes(id) && this._transcribeRunning !== id) {
      this._transcribeQueue.push(id);
      while (this._transcribeQueue.length > QUEUE_MAX) this._transcribeQueue.shift();
    }
    this._pumpTranscribe();
    return this.transcript(id);
  }

  _pumpTranscribe() {
    if (this._transcribeRunning || !this._transcribeQueue.length) return;
    const id = this._transcribeQueue.shift();
    this._transcribeRunning = id;
    this._runTranscribe(id)
      .catch(() => { /* _runTranscribe 内部落库收尾，异常不再外溢 */ })
      .finally(() => {
        this._transcribeRunning = null;
        this._pumpTranscribe(); // 队列接力（单飞）
      });
  }

  isTranscribing(itemID) {
    return this._transcribeRunning === String(itemID) || this._transcribeQueue.includes(String(itemID));
  }

  /** 单飞执行体：取音频（本地缓存优先，否则整文件临时下载 ≤500MB）→ multipart 上传 → 落库。 */
  async _runTranscribe(itemID) {
    const db = this.store.database;
    const now = () => nowSeconds();
    const fail = (message) => {
      db.prepare("UPDATE media_transcripts SET status = 'error', error = ?, updated_at = ? WHERE item_id = ?")
        .run(String(message || ''), now(), itemID);
      this._emitTranscribe({ itemID, state: 'error', error: String(message || '') });
    };
    const cfg = this.transcribeConfig();
    if (!cfg.enabled || !cfg.url) {
      this._transcribeRunning = null; // 配置中途被清：不占单飞槽
      fail(i18n.localized('尚未配置转写端点：请在设置 → 转写中开启并填写 OpenAI 兼容端点。'));
      return;
    }
    db.prepare("UPDATE media_transcripts SET status = 'running', error = NULL, updated_at = ? WHERE item_id = ?")
      .run(now(), itemID);
    this._emitTranscribe({ itemID, state: 'running', phase: 'prepare', pct: null });
    const controller = new AbortController();
    const watchdog = setTimeout(() => {
      try { controller.abort(); } catch (_) { /* 已中止 */ }
    }, TRANSCRIBE_TIMEOUT_MS);
    let tempPath = null;
    try {
      const media = this.forItem(itemID);
      if (!media) throw Object.assign(new Error(i18n.localized('媒体不存在或已被删除。')), { permanent: true });
      let audioBuffer = null;
      if (media.hasLocal && media.localPath && fs.existsSync(media.localPath)) {
        // 本地缓存优先：离线下载过的直接读盘（零网络）
        const stat = fs.statSync(media.localPath);
        if (stat.size > MAX_DOWNLOAD_BYTES) {
          throw Object.assign(new Error(i18n.localized('文件超过 500MB 上限，已取消转写。')), { permanent: true });
        }
        audioBuffer = fs.readFileSync(media.localPath);
      } else {
        // 远端源：整文件临时下载（复用下载护栏与重试；进度照推送）
        if (!/^https?:\/\//i.test(String(media.url || ''))) {
          throw Object.assign(new Error(i18n.localized('仅支持转写 http(s) 链接的媒体。')), { permanent: true });
        }
        fs.mkdirSync(this.mediaDir, { recursive: true });
        tempPath = path.join(this.mediaDir, `${stableDigest(itemID)}.asr-tmp${downloadExtension(media.mime, media.url)}`);
        await this._downloadToFile({ ...media, itemID }, tempPath, controller, {
          onProgress: (received, total) => {
            const pct = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : null;
            this._emitTranscribe({ itemID, state: 'running', phase: 'fetch', pct });
          },
        });
        const stat = fs.statSync(tempPath);
        if (stat.size <= 0) throw new Error(i18n.localized('下载内容为空。'));
        audioBuffer = fs.readFileSync(tempPath);
      }
      // multipart 上传（OpenAI 兼容 /v1/audio/transcriptions）
      this._emitTranscribe({ itemID, state: 'running', phase: 'asr', pct: null });
      const form = new FormData();
      form.append('file', new Blob([audioBuffer], { type: media.mime || 'audio/mpeg' }),
        `audio${downloadExtension(media.mime, media.url)}`);
      form.append('model', cfg.model);
      form.append('response_format', 'verbose_json');
      const headers = { Accept: 'application/json' };
      const apiKey = this._transcribeApiKey();
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      // 建连/响应头看门狗：30s 拿不到响应头即中止（与下载同口径）
      let headerTimer = null;
      const response = await Promise.race([
        fetch(cfg.url, { method: 'POST', headers, body: form, signal: controller.signal }),
        new Promise((_, reject) => {
          headerTimer = setTimeout(() => {
            try { controller.abort(); } catch (_) { /* 已中止 */ }
            reject(Object.assign(new Error(i18n.localized('转写端点连接超时。')), { permanent: false }));
          }, TRANSCRIBE_HEADERS_MS);
        }),
      ]).finally(() => headerTimer && clearTimeout(headerTimer));
      if (!response.ok) {
        // 4xx（配置/鉴权错）与 5xx 同为终态：重试只会再打一次服务器
        throw Object.assign(new Error(`HTTP ${response.status}`), { permanent: true });
      }
      const payload = await response.json().catch(() => null);
      if (!payload || typeof payload.text !== 'string') {
        throw Object.assign(new Error(i18n.localized('转写端点返回的内容无法识别。')), { permanent: true });
      }
      const text = payload.text.slice(0, TRANSCRIBE_TEXT_CAP);
      const segments = Array.isArray(payload.segments) && payload.segments.length
        ? payload.segments.slice(0, 5000).map((s) => ({
          start: Number(s?.start) || 0, end: Number(s?.end) || 0, text: String(s?.text || ''),
        })) : null;
      db.prepare(`
        UPDATE media_transcripts SET status = 'done', text = ?, language = ?, duration_seconds = ?,
          segments_json = ?, error = NULL, updated_at = ?
        WHERE item_id = ?
      `).run(
        text, payload.language ? String(payload.language).slice(0, 16) : null,
        Number(payload.duration) > 0 ? Number(payload.duration) : media.durationSeconds ?? null,
        segments ? JSON.stringify(segments) : null, now(), itemID,
      );
      this._indexTranscript(itemID, text);
      this._emitTranscribe({ itemID, state: 'done' });
    } catch (err) {
      if (controller.signal.aborted && !err?.permanent) {
        fail(i18n.localized('转写超时或被中止，可重试。'));
      } else {
        fail(err?.message || err);
      }
    } finally {
      clearTimeout(watchdog);
      if (tempPath) {
        try { fs.rmSync(tempPath, { force: true }); } catch (_) { /* 临时文件清理失败可忽略 */ }
      }
    }
  }

  /** 文字稿进 FTS（旁路 articles_fts；FTS 不可用静默跳过——搜索回退 LIKE）。 */
  _indexTranscript(itemID, text) {
    try {
      if (!this._ftsAvailable()) return;
      const db = this.store.database;
      db.prepare('DELETE FROM media_transcripts_fts WHERE item_id = ?').run(itemID);
      db.prepare('INSERT INTO media_transcripts_fts (item_id, text) VALUES (?, ?)').run(itemID, String(text || ''));
    } catch (_) { /* 索引失败不阻塞转写主流程 */ }
  }

  /**
   * 转写 AI 摘要（走 LLMService；无 Key 由 store._requireAIReady 抛 missingAPIKey → UI 灰置）。
   * 摘要随行落库（media_transcripts.summary），面板顶部展示。
   */
  async transcriptSummary(itemID) {
    const id = String(itemID || '');
    const row = this.transcript(id);
    if (row.status !== 'done' || !row.text) {
      throw new Error(i18n.localized('该条目还没有完成的文字稿，无法生成摘要。'));
    }
    const { config, apiKey } = this.store._requireAIReady();
    const complete = this._llmComplete
      ? (payload) => this._llmComplete(payload)
      : (payload) => this.store.llm.complete(payload);
    const summary = String(await complete({
      prompt: `Podcast transcript:\n\n${String(row.text).slice(0, 28000)}`,
      system: `Summarize this podcast transcript in ${config.targetLanguage}. Start with one concise conclusion, then 3 to 6 factual bullets. Do not invent facts.`,
      configuration: config,
      apiKey,
    }) || '').trim();
    if (!summary) throw new Error(i18n.localized('模型没有返回摘要内容。'));
    this.store.database.prepare('UPDATE media_transcripts SET summary = ?, updated_at = ? WHERE item_id = ?')
      .run(summary.slice(0, 20000), nowSeconds(), id);
    return { itemID: id, summary };
  }

  /** 应用退出：中止在途下载（.part 由 attempt 的 catch 清理）。 */
  dispose() {
    for (const controller of this._downloads.values()) {
      try { controller.abort(); } catch (_) { /* 已中止 */ }
    }
    this._downloads.clear();
    this._transcribeQueue.length = 0; // 在途任务自然收尾；排队任务丢弃
  }
}

module.exports = {
  MediaService,
  enclosureExtension: downloadExtension,
  LIMITS: {
    MAX_DOWNLOAD_BYTES, DOWNLOAD_RETRY, LIST_PAGE_MAX, QUEUE_MAX, FINISHED_RATIO,
    TRANSCRIBE_TIMEOUT_MS, TRANSCRIBE_HEADERS_MS, TRANSCRIBE_TEXT_CAP,
  },
};
