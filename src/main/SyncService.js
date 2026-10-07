'use strict';
/**
 * RobinRead（知更）— WebDAV 多设备同步服务（F7）
 *
 * 本地优先：WebDAV 只是快照交换点（<base>/robinread/sync.json 单文件），
 * 任何设备可离线，重连后合并；合并语义见 Sync/merge.js（幂等，批注/本地独有数据永不删）。
 *
 * 同步决策：
 * - 远端无快照 → 直接 PUT 本机快照；
 * - 本机任一同步范围数据（订阅行/批注/阅读位置/白名单偏好）的最新变动时间戳
 *   晚于远端快照 updatedAt → 合并进本机后 PUT 合并结果；
 * - 否则只 GET 合并不上传（本机无新变更时绝不回写远端）。
 *
 * 工程约束：
 * - 零新依赖；网络走 WebDAVClient（net.fetch = 系统代理通路，单连接顺序请求无 TLS 竞态）；
 * - 原子写：PUT sync.json.tmp → MOVE；MOVE 不可用退回直接 PUT；
 * - 护栏：快照 >8MB 拒绝上传；批注 >5000 截最旧；进度 >2000 截最旧；
 * - 无新表：deviceId/配置存偏好，密码存 CredentialStore（DPAPI）；
 *   阅读位置与「暂无本地文章可挂载的远端批注」落 userData/sync/ 下 JSON。
 */
const fs = require('node:fs');
const path = require('node:path');
const { uuid, nowSeconds, LOCAL_ACCOUNT_ID } = require('./Models');
const { i18n } = require('./I18N');
const { WebDAVClient, DAVError, useNetFetch } = require('./Sync/WebDAVClient');
const {
  SNAPSHOT_VERSION,
  ANNOTATION_LIMIT,
  PROGRESS_LIMIT,
  SyncError,
  annotationKey,
  serializeSnapshot,
  parseSnapshot,
  mergeSnapshots,
} = require('./Sync/merge');

const REMOTE_DIR = 'robinread';
const REMOTE_FILE = 'sync.json';
const REMOTE_TMP = 'sync.json.tmp';
const AUTO_THROTTLE_SECONDS = 10 * 60; // 自动同步节流 ≥10 分钟

const PREF = {
  serverURL: 'RobinRead.sync.serverURL',
  username: 'RobinRead.sync.username',
  autoEnabled: 'RobinRead.sync.autoEnabled',
  deviceId: 'RobinRead.sync.deviceId',
  lastSyncAt: 'RobinRead.sync.lastSyncAt',
  prefsDirtyAt: 'RobinRead.sync.prefsDirtyAt',
};

/**
 * 偏好白名单（主题/字号/语言/排版等跨设备漫游键）。
 * key = 快照内字段名，value = { pref: 偏好键, type: 期望类型 }。
 */
const PREF_WHITELIST = {
  appTheme: { pref: 'RobinRead.appTheme', type: 'string' },
  articleFontSize: { pref: 'RobinRead.articleFontSize', type: 'number' },
  appLanguage: { pref: 'RobinRead.appLanguage', type: 'string' },
  dailyGoal: { pref: 'RobinRead.stats.dailyGoal', type: 'number' },
  titleZh: { pref: 'RobinRead.list.titleZh', type: 'boolean' },
  autoTranslateEnglish: { pref: 'RobinRead.autoTranslateEnglish', type: 'boolean' },
  fontFamily: { pref: 'RobinRead.readerFontFamily', type: 'string' },
  pageWidth: { pref: 'RobinRead.readerPageWidth', type: 'string' },
  lineHeight: { pref: 'RobinRead.readerLineHeight', type: 'string' },
  paraStyle: { pref: 'RobinRead.paraStyle', type: 'string' },
  textAlign: { pref: 'RobinRead.textAlign', type: 'string' },
  letterSpacing: { pref: 'RobinRead.letterSpacing', type: 'string' },
  microTypography: { pref: 'RobinRead.microTypography', type: 'string' },
  dropCap: { pref: 'RobinRead.dropCap', type: 'string' },
  titleFont: { pref: 'RobinRead.titleFont', type: 'string' },
  bilingualStyle: { pref: 'RobinRead.bilingualStyle', type: 'string' },
  listDensity: { pref: 'RobinRead.listDensity', type: 'string' },
  listViewMode: { pref: 'RobinRead.listViewMode', type: 'string' },
};

function safeNumber(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

class SyncService {
  constructor(store, userDataPath) {
    this.store = store;
    this.dataDir = path.join(userDataPath, 'sync');
    try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch (_) { /* 只读环境容忍 */ }
    this._progress = new Map();       // entryURL → { pct, at }
    this._pending = new Map();        // annotationKey → annotation record（本地暂无文章可挂载的远端批注）
    this._chain = Promise.resolve();  // 单飞：同步串行化
    this._running = false;
    this._lastAutoAt = 0;             // 自动同步节流游标（注入点：探针 mock 时间）
    this._lastResult = null;          // 最近一次同步结果（UI 展示）
    this._progressForwarder = null;   // 合并后的进度回推 renderer（ipc 注册）
    this._progressSaveTimer = null;
    this._loadProgressFile();
    this._loadPendingFile();
  }

  // MARK: 配置与设备身份

  autoEnabled() { return this.store.preferences.get(PREF.autoEnabled, true) !== false; }

  setAutoEnabled(enabled) {
    this.store.preferences.set(PREF.autoEnabled, enabled === true);
    return this.autoEnabled();
  }

  /** 设备身份：首同步时生成并持久化（读取不产生副作用）。 */
  deviceId() { return this.store.preferences.get(PREF.deviceId, null) || null; }

  _ensureDeviceId() {
    let id = this.deviceId();
    if (!id) {
      id = uuid();
      this.store.preferences.set(PREF.deviceId, id);
    }
    return id;
  }

  getConfig() {
    return {
      serverURL: this.store.preferences.get(PREF.serverURL, '') || '',
      username: this.store.preferences.get(PREF.username, '') || '',
      hasPassword: Boolean(this.store.credentials.webDAVPassword()),
      autoEnabled: this.autoEnabled(),
      deviceId: this.deviceId(),
      lastSyncAt: this.store.preferences.get(PREF.lastSyncAt, null) || null,
      lastResult: this._lastResult,
      running: this._running,
    };
  }

  /**
   * 保存配置：serverURL/username 入偏好；password 非空串 → 覆盖 CredentialStore（DPAPI），
   * password === null → 显式清除（改配置不传密码 = 保留原密码）。
   */
  saveConfig({ serverURL, username, password } = {}) {
    if (serverURL != null) {
      const clean = String(serverURL).trim().replace(/\/+$/, '');
      if (clean && !/^https?:\/\//i.test(clean)) {
        throw new SyncError('config', i18n.localized('同步服务器地址必须以 http:// 或 https:// 开头。'));
      }
      if (clean) this.store.preferences.set(PREF.serverURL, clean);
      else this.store.preferences.remove(PREF.serverURL);
    }
    if (username != null) {
      const clean = String(username).trim();
      if (clean) this.store.preferences.set(PREF.username, clean);
      else this.store.preferences.remove(PREF.username);
    }
    if (typeof password === 'string' && password.length) {
      this.store.credentials.setWebDAVPassword(password);
    } else if (password === null) {
      this.store.credentials.deleteWebDAVPassword();
    }
    return this.getConfig();
  }

  /** 断开并清除：服务器/用户名/密码/最近同步记录全部移除（本机数据不受影响）。 */
  disconnect() {
    this.store.preferences.remove(PREF.serverURL);
    this.store.preferences.remove(PREF.username);
    this.store.preferences.remove(PREF.lastSyncAt);
    this.store.credentials.deleteWebDAVPassword();
    this._lastResult = null;
    return this.getConfig();
  }

  _credentials(override = {}) {
    const serverURL = String(override.serverURL ?? (this.store.preferences.get(PREF.serverURL, '') || '')).trim();
    const username = String(override.username ?? (this.store.preferences.get(PREF.username, '') || '')).trim();
    const password = String(override.password ?? (this.store.credentials.webDAVPassword() ?? ''));
    if (!serverURL) throw new SyncError('config', i18n.localized('尚未配置 WebDAV 服务器，请先在 设置 → 同步 中填写。'));
    if (!username || !password) throw new SyncError('config', i18n.localized('WebDAV 用户名或密码缺失，请补全后再同步。'));
    return { serverURL, username, password };
  }

  /** 测试连接：PROPFIND base（Depth 0）。支持表单覆盖凭据。 */
  async testConnection(override = {}) {
    const startedAt = Date.now();
    const cfg = this._credentials(override);
    const client = new WebDAVClient({ base: cfg.serverURL, username: cfg.username, password: cfg.password });
    const probe = await client.propfind(client.base, 0);
    return { elapsedMs: Date.now() - startedAt, exists: probe.exists, serverURL: cfg.serverURL };
  }

  // MARK: 白名单偏好（新者胜基准时间戳）

  /** 本机白名单偏好发生变更（AppStore 各 setter 调用）：推高新者胜基准。远端应用期间抑制。 */
  notePrefsChanged(at = nowSeconds()) {
    if (this._applyingRemote) return; // 合并落库不算本机变更（防新者胜基准被远端数据顶掉）
    const current = safeNumber(this.store.preferences.get(PREF.prefsDirtyAt, 0));
    if (at > current) this.store.preferences.set(PREF.prefsDirtyAt, at);
  }

  _prefsDirtyAt() { return safeNumber(this.store.preferences.get(PREF.prefsDirtyAt, 0)); }

  _prefsValues() {
    const values = {};
    for (const [key, meta] of Object.entries(PREF_WHITELIST)) {
      const v = this.store.preferences.get(meta.pref, undefined);
      if (v === undefined) continue;
      if (meta.type === 'number' && typeof v !== 'number') continue;
      if (meta.type === 'boolean' && typeof v !== 'boolean') continue;
      if (meta.type === 'string' && typeof v !== 'string') continue;
      values[key] = v;
    }
    return values;
  }

  // MARK: 阅读位置（progress）

  /** 渲染层上报（reader 续读节流批）：按 entryURL 记录，取 at 更新者。 */
  reportProgress(entries) {
    let changed = false;
    for (const entry of (Array.isArray(entries) ? entries : [])) {
      const url = String(entry?.url || '');
      const pct = Number(entry?.pct);
      const at = Number(entry?.at) || nowSeconds();
      if (!/^https?:\/\//i.test(url) || !Number.isFinite(pct)) continue;
      const existing = this._progress.get(url);
      if (existing && safeNumber(existing.at) >= at) continue;
      this._progress.set(url, { pct, at });
      changed = true;
    }
    if (changed) {
      this._capProgress();
      this._schedulePersistProgress();
    }
    return changed;
  }

  _capProgress() {
    if (this._progress.size <= PROGRESS_LIMIT) return;
    const sorted = Array.from(this._progress.entries())
      .sort((a, b) => safeNumber(a[1].at) - safeNumber(b[1].at));
    for (const [url] of sorted.slice(0, this._progress.size - PROGRESS_LIMIT)) this._progress.delete(url);
  }

  _progressNewestAt() {
    let newest = 0;
    for (const rec of this._progress.values()) newest = Math.max(newest, safeNumber(rec.at));
    return newest;
  }

  setProgressForwarder(fn) { this._progressForwarder = typeof fn === 'function' ? fn : null; }

  _pushProgressToRenderer(updates) {
    if (!this._progressForwarder || !updates.length) return;
    try { this._progressForwarder({ entries: updates }); } catch (_) { /* 推送失败不影响同步 */ }
  }

  // MARK: 本地快照构建

  /** 本机同步范围数据 → 快照（不含本地 id；批注含 pending）。 */
  buildLocalSnapshot() {
    const db = this.store.database;
    const feedRows = db.prepare(`
      SELECT f.id, f.title, f.site_url, f.feed_url, f.platform, f.platform_ref, f.updated_at,
             (SELECT fo.name FROM feed_folders ff JOIN folders fo ON fo.id = ff.folder_id
               WHERE ff.feed_id = f.id AND fo.is_deleted = 0 LIMIT 1) AS folder_name
      FROM feeds f
      WHERE f.account_id = ? AND f.is_deleted = 0
      ORDER BY f.updated_at ASC
    `).all(LOCAL_ACCOUNT_ID);

    const feeds = feedRows.map((row) => ({
      feedURL: row.feed_url,
      title: row.title,
      siteURL: row.site_url ?? null,
      folder: row.folder_name ?? null,
      platform: row.platform ?? 'web',
      platformRef: row.platform_ref ?? null,
      updatedAt: safeNumber(row.updated_at),
    }));

    // 批注：highlights + notes（经 items/articles 拿 entryURL）
    const annotations = [];
    for (const row of db.prepare(`
      SELECT h.id, h.text, h.color, h.note, h.paragraph_id, h.start_offset, h.end_offset, h.anchor, h.created_at,
             a.url AS entry_url
      FROM highlights h JOIN articles a ON a.item_id = h.item_id
      WHERE a.url IS NOT NULL AND a.url != ''
    `).all()) {
      annotations.push({
        entryURL: row.entry_url,
        kind: 'highlight',
        text: row.text ?? '',
        color: row.color ?? 'yellow',
        note: row.note ?? null,
        paragraphID: row.paragraph_id ?? null,
        startOffset: row.start_offset ?? null,
        endOffset: row.end_offset ?? null,
        anchor: this._parseJSON(row.anchor),
        createdAt: safeNumber(row.created_at),
        updatedAt: safeNumber(row.created_at),
      });
    }
    for (const row of db.prepare(`
      SELECT n.id, n.content, n.tags, n.anchor, n.created_at, n.updated_at,
             a.url AS entry_url
      FROM notes n JOIN articles a ON a.item_id = n.item_id
      WHERE a.url IS NOT NULL AND a.url != ''
    `).all()) {
      annotations.push({
        entryURL: row.entry_url,
        kind: 'note',
        content: row.content ?? '',
        tags: this._parseJSON(row.tags) || [],
        anchor: this._parseJSON(row.anchor),
        createdAt: safeNumber(row.created_at),
        updatedAt: safeNumber(row.updated_at) || safeNumber(row.created_at),
      });
    }
    for (const record of this._pending.values()) annotations.push(record);

    // 标签：article_tags → entryURL → [{t, s}]
    const tags = {};
    for (const row of db.prepare(`
      SELECT t.tag, t.source, a.url AS entry_url
      FROM article_tags t JOIN articles a ON a.item_id = t.item_id
      WHERE a.url IS NOT NULL AND a.url != ''
    `).all()) {
      const url = row.entry_url;
      (tags[url] = tags[url] || []).push({ t: String(row.tag), s: String(row.source || 'manual') });
    }

    const progress = {};
    for (const [url, rec] of this._progress.entries()) progress[url] = { pct: rec.pct, at: rec.at };

    return {
      version: SNAPSHOT_VERSION,
      deviceId: this.deviceId() || '',
      updatedAt: nowSeconds(),
      feeds,
      prefs: { values: this._prefsValues(), updatedAt: this._prefsDirtyAt() },
      annotations,
      progress,
      tags,
    };
  }

  _parseJSON(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  /** 本机同步范围最新变动时间戳（PUT 决策依据；不含未纳入同步的表）。 */
  _localNewestAt() {
    const q = (sql) => {
      try { return safeNumber(this.store.database.prepare(sql).get()?.m); } catch (_) { return 0; }
    };
    return Math.max(
      q(`SELECT MAX(updated_at) AS m FROM feeds WHERE account_id = '${LOCAL_ACCOUNT_ID}' AND is_deleted = 0`),
      q('SELECT MAX(created_at) AS m FROM highlights'),
      q('SELECT MAX(updated_at) AS m FROM notes'),
      this._progressNewestAt(),
      this._prefsDirtyAt(),
    );
  }

  // MARK: 远端应用（合并落库；只写真变化，携带源时间戳防 PUT 循环）

  _applySnapshot(snapshot, stats) {
    if (!this._knownAnnotationKeys) this._knownAnnotationKeys = this._loadLocalAnnotationKeys();
    const feedApply = this._applyFeeds(snapshot.feeds || []);
    stats.feedsInserted = feedApply.inserted;
    stats.feedsUpdated = feedApply.updated;

    const annApply = this._applyAnnotations(snapshot.annotations || []);
    stats.annotationsInserted = annApply.inserted;
    stats.annotationsPending = annApply.pending;

    const progressApply = this._applyProgress(snapshot.progress || {});
    stats.progressApplied = progressApply.applied;
    this._pushProgressToRenderer(progressApply.updates);

    stats.tagsApplied = this._applyTags(snapshot.tags || {});
    stats.prefsApplied = this._applyPrefs(snapshot.prefs || { values: {}, updatedAt: 0 });
  }

  _applyFeeds(feeds) {
    const db = this.store.database;
    let inserted = 0;
    let updated = 0;
    for (const feed of feeds) {
      if (!feed || typeof feed.feedURL !== 'string' || !feed.feedURL) continue;
      const existing = db.prepare(
        'SELECT id, title, site_url, platform, platform_ref, updated_at FROM feeds WHERE account_id = ? AND feed_url = ? AND is_deleted = 0',
      ).get(LOCAL_ACCOUNT_ID, feed.feedURL);
      const platform = (feed.platform && typeof feed.platform === 'string') ? feed.platform : 'web';
      const platformRef = feed.platformRef ?? null;
      const title = String(feed.title || '未命名订阅').slice(0, 500);
      const siteURL = feed.siteURL ?? null;
      const remoteT = safeNumber(feed.updatedAt);
      let feedID = existing?.id ?? null;
      if (!existing) {
        // 携带远端时间戳落库（不打 now 戳 → 不制造假「本机更新」）
        feedID = uuid();
        db.prepare(`
          INSERT INTO feeds (id, account_id, external_id, title, site_url, feed_url, updated_at, stored_icon_url, sort_order, platform, platform_ref)
          VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, 0, ?, ?)
        `).run(feedID, LOCAL_ACCOUNT_ID, title, siteURL, feed.feedURL, remoteT || nowSeconds(), platform, platformRef);
        inserted += 1;
      } else if (remoteT > safeNumber(existing.updated_at)) {
        const changed = existing.title !== title || existing.site_url !== siteURL
          || (existing.platform ?? 'web') !== platform || (existing.platform_ref ?? null) !== platformRef;
        if (changed) {
          db.prepare('UPDATE feeds SET title = ?, site_url = ?, platform = ?, platform_ref = ?, updated_at = ? WHERE id = ?')
            .run(title, siteURL, platform, platformRef, remoteT, existing.id);
        } else {
          // 内容相同只对齐时间戳（防陈旧远端时间戳反复触发新者胜比较）
          db.prepare('UPDATE feeds SET updated_at = ? WHERE id = ?').run(remoteT, existing.id);
        }
        updated += 1;
      }
      // folder：跟随整条记录的新者胜结果；无变化不写
      if (feedID) this._applyFeedFolder(feedID, feed.folder);
    }
    return { inserted, updated };
  }

  _applyFeedFolder(feedID, folderName) {
    const name = folderName && String(folderName).trim() ? String(folderName).trim() : null;
    const current = this.store.database.prepare(`
      SELECT fo.name FROM feed_folders ff JOIN folders fo ON fo.id = ff.folder_id
      WHERE ff.feed_id = ? AND fo.is_deleted = 0 LIMIT 1
    `).get(feedID);
    const currentName = current?.name ?? null;
    if ((currentName || null) === (name || null)) return; // 无变化不写
    const folderID = name ? this.store.feedsRepo.ensureFolder(LOCAL_ACCOUNT_ID, name).id : null;
    this.store.feedsRepo.setFeedFolder(feedID, folderID);
  }

  /** entryURL → 本地 itemID（articles.url / url_norm 双路匹配）。 */
  _itemIDByURL(url) {
    const row = this.store.database.prepare(`
      SELECT i.id FROM items i JOIN articles a ON a.item_id = i.id
      WHERE a.url = ? OR a.url_norm = ? LIMIT 1
    `).get(url, url);
    return row?.id ?? null;
  }

  _applyAnnotations(records) {
    const db = this.store.database;
    let inserted = 0;
    let pending = 0;
    for (const record of records) {
      if (!record || typeof record.entryURL !== 'string' || !record.entryURL) continue;
      const key = annotationKey(record);
      if (this._knownAnnotationKeys.has(key)) continue; // 本地已有（按锚点摘要去重）
      const itemID = this._itemIDByURL(record.entryURL);
      if (!itemID) {
        // 本地暂无该文章：暂存 pending（随下次快照上行；文章到达后自动落库）
        if (!this._pending.has(key)) {
          this._pending.set(key, record);
          pending += 1;
        }
        continue;
      }
      if (this._insertAnnotation(itemID, record)) inserted += 1;
    }
    const materialized = this._materializePending();
    if (pending) this._schedulePersistPending(); // 新增 pending 落盘（不丢）
    return { inserted: inserted + materialized, pending };
  }

  _insertAnnotation(itemID, record) {
    const db = this.store.database;
    if (record.kind === 'note') {
      db.prepare(`
        INSERT INTO notes (id, item_id, content, tags, linked_notes, anchor, created_at, updated_at)
        VALUES (?, ?, ?, ?, '[]', ?, ?, ?)
      `).run(`note-sync-${uuid()}`, itemID, String(record.content ?? ''),
        JSON.stringify(Array.isArray(record.tags) ? record.tags : []),
        record.anchor != null ? JSON.stringify(record.anchor) : null,
        safeNumber(record.createdAt) || nowSeconds(),
        safeNumber(record.updatedAt) || safeNumber(record.createdAt) || nowSeconds());
      return true;
    }
    if (record.kind === 'highlight') {
      db.prepare(`
        INSERT INTO highlights (id, item_id, text, color, note, paragraph_id, start_offset, end_offset, anchor, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`hl-sync-${uuid()}`, itemID, String(record.text ?? ''),
        String(record.color || 'yellow'), record.note ?? null, record.paragraphID ?? null,
        record.startOffset ?? null, record.endOffset ?? null,
        record.anchor != null ? JSON.stringify(record.anchor) : null,
        safeNumber(record.createdAt) || nowSeconds());
      return true;
    }
    return false;
  }

  /** pending 批注重试落库（对应文章可能已在两次同步之间入库）。 */
  _materializePending() {
    if (!this._pending.size) return 0;
    let materialized = 0;
    for (const [key, record] of Array.from(this._pending.entries())) {
      const itemID = this._itemIDByURL(record.entryURL);
      if (!itemID) continue;
      if (this._insertAnnotation(itemID, record)) {
        this._pending.delete(key);
        materialized += 1;
      }
    }
    if (materialized) this._schedulePersistPending();
    return materialized;
  }

  _applyProgress(progress) {
    const updates = [];
    let applied = 0;
    for (const [url, rec] of Object.entries(progress || {})) {
      if (!rec || typeof rec !== 'object') continue;
      const at = safeNumber(rec.at);
      const existing = this._progress.get(url);
      if (existing && safeNumber(existing.at) >= at) continue;
      this._progress.set(url, { pct: Number(rec.pct) || 0, at });
      applied += 1;
      const entryID = this._itemIDByURL(url);
      if (entryID) updates.push({ entryID, url, pct: Number(rec.pct) || 0, at });
    }
    if (applied) {
      this._capProgress();
      this._schedulePersistProgress();
    }
    return { applied, updates };
  }

  _applyTags(tags) {
    const db = this.store.database;
    let applied = 0;
    for (const [url, list] of Object.entries(tags || {})) {
      if (!Array.isArray(list)) continue;
      const itemID = this._itemIDByURL(url);
      if (!itemID) continue;
      const existing = new Set(db.prepare('SELECT tag, source FROM article_tags WHERE item_id = ?')
        .all(itemID).map((r) => `${r.tag}\u0000${r.source}`));
      for (const item of list) {
        const tag = String(item?.t ?? item ?? '').trim();
        const source = String(item?.s ?? 'manual') || 'manual';
        if (!tag) continue;
        const key = `${tag}\u0000${source}`;
        if (existing.has(key)) continue;
        db.prepare('INSERT OR IGNORE INTO article_tags (item_id, tag, source) VALUES (?, ?, ?)').run(itemID, tag, source);
        applied += 1;
      }
    }
    return applied;
  }

  _applyPrefs(prefs) {
    const values = (prefs && typeof prefs.values === 'object' && prefs.values) || {};
    const remoteT = safeNumber(prefs.updatedAt);
    let applied = 0;
    this._applyingRemote = true; // 应用远端值不算本机变更（走 setter 也不推高新者胜基准）
    try {
      for (const [key, value] of Object.entries(values)) {
        const meta = PREF_WHITELIST[key];
        if (!meta) continue; // 非白名单键一律忽略
        if (typeof value !== meta.type) continue;
        // 活偏好（主题/语言/字号/目标）走 setter：nativeTheme / i18n / 状态推送即时生效
        if (key === 'appTheme') { this.store.setAppTheme(value); applied += 1; continue; }
        if (key === 'appLanguage') { this.store.setAppLanguage(value); applied += 1; continue; }
        if (key === 'articleFontSize') { this.store.setArticleFontSize(value); applied += 1; continue; }
        if (key === 'dailyGoal') { this.store.setDailyGoal(value); applied += 1; continue; }
        const current = this.store.preferences.get(meta.pref, undefined);
        if (current === value) continue;
        this.store.preferences.set(meta.pref, value);
        applied += 1;
      }
    } finally {
      this._applyingRemote = false;
    }
    if (remoteT > 0) {
      // 应用远端偏好后，把本地「新者胜基准」对齐到远端时间戳（防同值反复覆盖）
      const current = safeNumber(this.store.preferences.get(PREF.prefsDirtyAt, 0));
      if (remoteT > current) this.store.preferences.set(PREF.prefsDirtyAt, remoteT);
    }
    return applied;
  }

  // MARK: 同步主流程

  /** 手动/自动同步统一入口（串行化；返回统计）。 */
  syncNow({ origin = 'manual' } = {}) {
    const run = this._chain.then(() => this._syncOnce({ origin }));
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * 刷新完成后的自动同步 kick：默认开，≥10 分钟节流。
   * 返回本次排程的 promise（节流中返回 null）——异步执行，绝不阻塞刷新路径。
   */
  kick(origin = 'refresh') {
    if (!this.autoEnabled()) return null;
    const now = nowSeconds();
    if (this._lastAutoAt && (now - this._lastAutoAt) < AUTO_THROTTLE_SECONDS) return null;
    this._lastAutoAt = now;
    return this.syncNow({ origin }).catch(() => { /* 自动同步失败静默（UI 手动同步可见错误） */ });
  }

  async _syncOnce({ origin = 'manual' } = {}) {
    const cfg = this._credentials();
    const client = new WebDAVClient({ base: cfg.serverURL, username: cfg.username, password: cfg.password });
    this._running = true;
    const startedAt = Date.now();
    try {
      this._ensureDeviceId();
      await this._ensureRemoteDirs(client);
      this._knownAnnotationKeys = this._loadLocalAnnotationKeys();

      const fileURL = client.url(REMOTE_DIR, REMOTE_FILE);
      let remoteSnap = null;
      try {
        const remote = await client.get(fileURL);
        remoteSnap = parseSnapshot(remote.body.toString('utf8'));
      } catch (err) {
        if (!(err instanceof DAVError && err.kind === 'notFound')) throw err;
      }

      const stats = {
        origin,
        direction: 'upload',
        elapsedMs: 0,
        feedsAddedFromRemote: 0,
        feedsInserted: 0,
        feedsUpdated: 0,
        annotationsAddedFromRemote: 0,
        annotationsInserted: 0,
        annotationsPending: 0,
        progressUpdatedFromRemote: 0,
        progressApplied: 0,
        tagsAddedFromRemote: 0,
        tagsApplied: 0,
        prefsSource: 'local',
        prefsApplied: 0,
        atomic: false,
      };

      if (!remoteSnap) {
        // 远端空：首次上行
        const local = this.buildLocalSnapshot();
        stats.atomic = (await this._putAtomic(client, serializeSnapshot(local))).atomic;
        stats.direction = 'upload';
        stats.uploadedEntries = {
          feeds: local.feeds.length,
          annotations: local.annotations.length,
          progress: Object.keys(local.progress).length,
        };
      } else {
        const localNewest = this._localNewestAt();
        const local = this.buildLocalSnapshot();
        const { merged, stats: mergeStats } = mergeSnapshots(local, remoteSnap, { prefsDirtyAt: this._prefsDirtyAt() });
        this._applySnapshot(merged, stats);
        Object.assign(stats, {
          feedsAddedFromRemote: mergeStats.feedsAddedFromRemote,
          annotationsAddedFromRemote: mergeStats.annotationsAddedFromRemote,
          progressUpdatedFromRemote: mergeStats.progressUpdatedFromRemote,
          tagsAddedFromRemote: mergeStats.tagsAddedFromRemote,
          prefsSource: mergeStats.prefsSource,
        });
        // 本机有比远端新的变更 → 上行合并结果；否则只下行（本机无新变更绝不动远端）
        if (localNewest > remoteSnap.updatedAt + 0.001) {
          const payload = this.buildLocalSnapshot();
          stats.atomic = (await this._putAtomic(client, serializeSnapshot(payload))).atomic;
          stats.direction = 'merge-upload';
          stats.uploadedEntries = {
            feeds: payload.feeds.length,
            annotations: payload.annotations.length,
            progress: Object.keys(payload.progress).length,
          };
        } else {
          stats.direction = 'merge-download';
        }
      }

      stats.elapsedMs = Date.now() - startedAt;
      stats.deviceId = this.deviceId();
      stats.remoteDeviceId = remoteSnap?.deviceId ?? null;
      this._lastResult = { ok: true, at: nowSeconds(), ...stats };
      this._lastAutoAt = nowSeconds(); // 手动同步完成同样刷新自动节流窗（数据已新鲜，免得 kick 重复上行）
      this.store.preferences.set(PREF.lastSyncAt, nowSeconds());
      return stats;
    } catch (err) {
      const kind = err instanceof DAVError ? err.kind
        : (err instanceof SyncError ? err.kind : 'server');
      // SyncError（invalid/tooLarge/config 等）的 message 在纯函数层生成（英文技术串），
      // 在此统一映射为本地化文案；DAVError 走 _davErrorText；未知兜底原文。
      let message;
      if (err instanceof DAVError) message = this._davErrorText(err);
      else if (err instanceof SyncError) {
        message = err.kind === 'invalid' ? i18n.localized('远端同步快照已损坏或版本不兼容，已拒绝合并（本机数据不受影响）。')
          : err.kind === 'tooLarge' ? i18n.localized('同步快照超过大小上限，已拒绝上传。')
          : err.kind === 'config' ? err.message
          : String(err.message || err);
      } else message = String((err && err.message) || err);
      const wrapped = new SyncError(kind, message);
      this._lastResult = { ok: false, at: nowSeconds(), origin, error: message, kind };
      throw wrapped;
    } finally {
      this._running = false;
      this._knownAnnotationKeys = null;
    }
  }

  _davErrorText(err) {
    switch (err.kind) {
      case 'auth': return i18n.localized('WebDAV 认证失败：请检查用户名与应用密码。');
      case 'notFound': return i18n.localized('WebDAV 资源不存在。');
      case 'locked': return i18n.localized('WebDAV 资源被锁定（423），请稍后重试。');
      case 'timeout': return i18n.localized('WebDAV 请求超时，请检查网络后重试。');
      case 'network': return i18n.localized('WebDAV 网络错误：无法连接服务器。');
      default: return i18n.localizedFormat('WebDAV 服务器错误（HTTP %lld）。', err.status ?? 0);
    }
  }

  /** 本地已存在批注的去重键集合（应用远端批注时避免重复插入）。 */
  _loadLocalAnnotationKeys() {
    const keys = new Set();
    const db = this.store.database;
    for (const row of db.prepare(`
      SELECT h.text, h.paragraph_id, h.start_offset, h.end_offset, h.anchor, a.url AS entry_url
      FROM highlights h JOIN articles a ON a.item_id = h.item_id
      WHERE a.url IS NOT NULL AND a.url != ''
    `).all()) {
      keys.add(annotationKey({
        entryURL: row.entry_url, kind: 'highlight', text: row.text ?? '',
        paragraphID: row.paragraph_id ?? null, startOffset: row.start_offset ?? null,
        endOffset: row.end_offset ?? null, anchor: this._parseJSON(row.anchor),
      }));
    }
    for (const row of db.prepare(`
      SELECT n.content, n.anchor, a.url AS entry_url
      FROM notes n JOIN articles a ON a.item_id = n.item_id
      WHERE a.url IS NOT NULL AND a.url != ''
    `).all()) {
      keys.add(annotationKey({
        entryURL: row.entry_url, kind: 'note', content: row.content ?? '',
        anchor: this._parseJSON(row.anchor),
      }));
    }
    for (const [key] of this._pending.entries()) keys.add(key);
    return keys;
  }

  // MARK: 远端目录与原子写

  async _ensureRemoteDirs(client) {
    const remoteDirURL = client.url(REMOTE_DIR);
    const probe = await client.propfind(remoteDirURL, 0);
    if (probe.exists) return;
    // 父目录（base 本身）缺失时先补建（自建 DAV 常见；坚果云 base 一般已存在）
    const baseProbe = await client.propfind(client.base, 0)
      .catch((err) => (err instanceof DAVError && err.kind === 'notFound' ? { exists: false } : Promise.reject(err)));
    if (!baseProbe.exists) {
      try { await client.mkcol(client.base); } catch (_) { /* 已存在/不支持按后续探测处理 */ }
    }
    try {
      await client.mkcol(remoteDirURL);
    } catch (err) {
      // 建目录失败后再探测一次：并发创建（两台设备同时首同步）下 405 也算成功
      const recheck = await client.propfind(remoteDirURL, 0).catch(() => ({ exists: false }));
      if (!recheck.exists) throw err;
    }
  }

  /** 原子上行：PUT tmp → MOVE；MOVE 不可用退回直接 PUT（坚果云支持 MOVE）。 */
  async _putAtomic(client, text) {
    const fileURL = client.url(REMOTE_DIR, REMOTE_FILE);
    const tmpURL = client.url(REMOTE_DIR, REMOTE_TMP);
    await client.put(tmpURL, text);
    try {
      await client.move(tmpURL, fileURL);
      return { atomic: true };
    } catch (err) {
      // MOVE 不支持/失败（404 源已被并发消费 / 5xx 不支持）→ 直接 PUT 兜底
      await client.put(fileURL, text);
      return { atomic: false, moveError: err && err.kind };
    }
  }

  // MARK: 本地持久化（进度 / pending 批注）

  _progressFile() { return path.join(this.dataDir, 'progress.json'); }
  _pendingFile() { return path.join(this.dataDir, 'pending-annotations.json'); }

  _loadProgressFile() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._progressFile(), 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [url, rec] of Object.entries(raw)) {
          if (rec && typeof rec === 'object' && /^https?:\/\//i.test(url)) {
            this._progress.set(url, { pct: Number(rec.pct) || 0, at: Number(rec.at) || 0 });
          }
        }
      }
    } catch (_) { /* 首次/损坏：空表起步 */ }
  }

  _loadPendingFile() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._pendingFile(), 'utf8'));
      if (Array.isArray(raw)) {
        for (const record of raw) {
          if (record && typeof record === 'object' && record.entryURL) {
            this._pending.set(annotationKey(record), record);
          }
        }
      }
    } catch (_) { /* 首次/损坏：空表起步 */ }
  }

  _schedulePersistProgress() {
    clearTimeout(this._progressSaveTimer);
    this._progressSaveTimer = setTimeout(() => this._persistProgress(), 500);
  }

  _persistProgress() {
    try {
      this._writeAtomic(this._progressFile(), JSON.stringify(Object.fromEntries(this._progress.entries())));
    } catch (_) { /* 落盘失败不阻塞同步 */ }
  }

  _schedulePersistPending() {
    // pending 变更低频：直接同步写
    try {
      this._writeAtomic(this._pendingFile(), JSON.stringify(Array.from(this._pending.values())));
    } catch (_) { /* 落盘失败不阻塞同步 */ }
  }

  _writeAtomic(filePath, text) {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
  }

  /** 退出前冲刷（AppStore will-quit 调用；幂等）。 */
  dispose() {
    clearTimeout(this._progressSaveTimer);
    this._persistProgress();
    this._schedulePersistPending();
  }
}

module.exports = {
  SyncService,
  SyncError,
  REMOTE_DIR,
  REMOTE_FILE,
  AUTO_THROTTLE_SECONDS,
  PREF_WHITELIST,
  useNetFetch,
};
