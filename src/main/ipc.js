'use strict';
/**
 * RobinRead Windows — IPC 桥接层
 *
 * 渲染进程（三栏 UI）与主进程 AppStore 之间的全部通道。
 * 采用 request/response（invoke）+ 推送（state:changed / ai:delta）两种形态。
 */
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, clipboard, session, nativeImage, protocol, shell, Notification, net } = require('electron');
const { checkForUpdate } = require('./UpdateCheckService');
const { UpdaterService } = require('./UpdaterService');
const { errorMessage } = require('./AppStore');
const { readerWindows } = require('./ReaderWindows'); // F17 多窗并读
const ArticleExtractor = require('./ArticleExtractor');
const { NeuralTTSService, NEURAL_VOICES } = require('./NeuralTTSService');
let neuralTTS = null;
let updater = null;

// 自定义图标协议必须先注册为 privileged（仅限 app ready 之前调用）。
// 生产入口 main.js 在 ready 前 require 本模块，特权始终生效；
// selftest 等 harness 在 ready 后才 require，跳过注册——非特权 scheme 的 <img> 加载仍可用。
try {
  if (!app.isReady()) {
    protocol.registerSchemesAsPrivileged([
      { scheme: 'robin-icon', privileges: { standard: false, secure: true, supportFetchAPI: true, stream: true } },
    ]);
  }
} catch (_) { /* 已注册过或环境限制：退化为非特权 scheme */ }

function createMainWindow(store) {
  let bounds = store.preferences.get('RobinRead.windowBounds', null);
  // 屏幕外窗口治理：记忆的坐标落在已断开的显示器（或越界）时丢弃，
  // 回退主屏居中——否则窗口存在于屏幕外，表现为「软件打不开」。
  if (bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
    const { screen } = require('electron');
    const area = { x: bounds.x, y: bounds.y, width: bounds.width || 1280, height: bounds.height || 820 };
    const display = screen.getDisplayMatching(area);
    const visible = bounds.x >= display.workArea.x - 8 && bounds.y >= display.workArea.y - 8
      && bounds.x < display.workArea.x + display.workArea.width
      && bounds.y < display.workArea.y + display.workArea.height;
    if (!visible) bounds = null;
  } else if (bounds && (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y))) {
    bounds = null;
  }
  const primary = require('electron').screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    width: bounds?.width || 1280,
    height: bounds?.height || 820,
    x: bounds?.x ?? Math.round(primary.x + (primary.width - 1280) / 2),
    y: bounds?.y ?? Math.round(primary.y + (primary.height - 820) / 2),
    minWidth: 980,
    minHeight: 600,
    show: false,
    title: 'RobinRead',
    backgroundColor: '#eae8e1',
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
    icon: resolveIcon(),
  });

  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  window.once('ready-to-show', () => window.show());

  // 主题同步到 Chromium
  const applyTheme = () => {
    window.webContents.send('theme:changed', { shouldUseDarkColors: nativeTheme.shouldUseDarkColors });
  };
  nativeTheme.on('updated', applyTheme);
  window.webContents.on('did-finish-load', applyTheme);

  // 外链默认走系统浏览器
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 同窗口导航防护：正文/期刊里点击 <a href> 不许替换应用窗口，一律转系统浏览器。
  // file:// 仅放行应用自身 renderer 目录（index.html 所在目录）前缀——放行一切 file://
  // 等于把用户本机任意 HTML 当作应用页面加载（可绕过沙箱约定读取本地资源）。
  const appRendererDirPrefix = pathToFileURL(path.join(__dirname, '..', 'renderer') + path.sep).href;
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('devtools://') || url.startsWith('data:')) return;
    if (url.startsWith('file://') && url.startsWith(appRendererDirPrefix)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // 记忆窗口位置
  const saveBounds = () => {
    if (!window.isDestroyed() && !window.isMinimized()) {
      store.setWindowBounds(window.getBounds());
    }
  };
  window.on('resize', debounce(saveBounds, 500));
  window.on('move', debounce(saveBounds, 500));
  window.on('close', saveBounds);

  return window;
}

function resolveIcon() {
  const candidates = [
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    path.join(__dirname, '..', '..', 'assets', 'icon.png'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch (_) { /* 跳过 */ }
  }
  return undefined;
}

// MARK: 桌面四件套共享助手（托盘 / 通知 / 开机自启 / 备份 / 存储）

// 通知构造的可替换缝：生产路径就是 new Notification(options)；
// diag 探针替换 notificationBridge.create 即可无头验证观察器门控逻辑
// （真实系统气泡的弹出效果仍需真机确认）。
const notificationBridge = {
  create(options) { return new Notification(options); },
};

// MARK: 写文件路径许可（P2-11：一次性路径 token）
// 渲染层的写文件通道（app:writeTextFile / app:writeBinaryFile）只接受两类路径：
//   1. 主进程保存对话框（app:pickSavePath）刚返回、仍在有效期内的路径（5 分钟）；
//   2. userData 子目录内的路径（应用自身数据区）。
// 其余任意路径一律拒绝——否则被入侵/走样的渲染层可以把内容写到本机任何位置。
const SAVED_PATH_TTL_MS = 5 * 60 * 1000;
const savedPathTokens = new Map(); // path(字符串原样) -> expiresAt(ms)

/** 过期清扫（懒清理：每次查询/登记时顺带删）。 */
function sweepSavedPathTokens() {
  const now = Date.now();
  for (const [p, expiresAt] of savedPathTokens) {
    if (expiresAt <= now) savedPathTokens.delete(p);
  }
}

/** 保存对话框返回路径时登记（续期式：同路径重复 pick 以最后一次为准）。 */
function registerSavedPath(filePath) {
  sweepSavedPathTokens();
  savedPathTokens.set(String(filePath), Date.now() + SAVED_PATH_TTL_MS);
}

/** 写文件前置校验：未登记（或已过期）且不在 userData 内的路径直接拒绝。 */
function assertWritablePath(filePath) {
  if (!filePath || typeof filePath !== 'string') throw new Error('缺少有效的文件路径');
  sweepSavedPathTokens();
  if (savedPathTokens.has(filePath)) return;
  try {
    const userData = app.getPath('userData');
    const rel = path.relative(userData, path.resolve(filePath));
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (inside) return;
  } catch (_) { /* userData 不可用时只认 token */ }
  throw new Error('该路径未经保存对话框授权，已拒绝写入');
}

/** 一次性消费：写成功后注销 token（同一 pick 只允许一次成功写入；失败可在 TTL 内重试）。 */
function consumeSavedPath(filePath) {
  savedPathTokens.delete(String(filePath));
}

// 应用退出标志：「关闭到托盘」会拦截一切 close（含 Alt+F4 / 任务栏关闭），
// 显式退出路径（托盘菜单退出、备份恢复重启）必须先 markAppQuitting 置位绕过拦截。
let appQuitting = false;
function markAppQuitting() { appQuitting = true; }
function isAppQuitting() { return appQuitting; }

/** 开机自启状态：仅打包环境（app.isPackaged）可靠，dev（electron .）下 supported=false。 */
function loginItemState() {
  try {
    return {
      supported: app.isPackaged === true,
      enabled: app.getLoginItemSettings().openAtLogin === true,
      message: app.isPackaged ? '' : '开机自启仅打包版（安装版）可用',
    };
  } catch (_) {
    return { supported: false, enabled: false, message: '当前环境不支持开机自启' };
  }
}

/** 开机自启写操作：打包环境写注册表（path 固定为当前 exe），dev 下直接回显不支持。 */
function setLoginItemEnabled(enabled) {
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath });
    } catch (_) { /* 写失败时原样回读系统状态 */ }
  }
  return loginItemState();
}

/**
 * 备份导出核心（可直调；对话框由 IPC handler 包装）。
 * 方案：VACUUM INTO 生成紧凑完整快照（天然合并 WAL）→ base64，连同偏好打包成单文件 JSON。
 * 重管线整体在 utilityProcess 内执行（workers/backup-worker.js：源库只读连接跑
 * VACUUM INTO + 3MB 分片流式 base64）——此前主进程内「同步 VACUUM INTO 数分钟 +
 * readFileSync 整读 + base64/stringify 双份大字符串」曾把启动后的主进程冻结数分钟、
 * 堆峰值冲到 GB 级，进程被杀还留 .tmp.db 垃圾（连续多日备份静默失败即此因）。
 * utilityProcess 不可用时回退主进程内同款流式实现：仍无内存炸弹，仅 VACUUM INTO 占主线程。
 */
const BACKUP_WORKER_PATH = path.join(__dirname, 'workers', 'backup-worker.js');
const BACKUP_WORKER_TIMEOUT_MS = 15 * 60 * 1000; // 大库 VACUUM INTO 在慢盘上可能数分钟

/** 主进程内回退路径：VACUUM INTO（主线程）+ 流式 base64（与 worker 同构）。 */
function backupExportInProcess(store, tmpSnapshot, outPath, version, exportedAt, preferencesJSON) {
  const escaped = String(tmpSnapshot).replace(/'/g, "''");
  store.database.exec(`VACUUM INTO '${escaped}'`);
  return new Promise((resolve, reject) => {
    const header = `{"version":${JSON.stringify(String(version))},`
      + `"exportedAt":${JSON.stringify(String(exportedAt))},"dbBase64":"`;
    const footer = `","preferences":${preferencesJSON}}`;
    const read = fs.createReadStream(tmpSnapshot, { highWaterMark: 3 * 1024 * 1024 });
    const write = fs.createWriteStream(outPath, { encoding: 'utf8' });
    const fail = (err) => {
      try { read.destroy(); } catch (_) { /* 已销毁 */ }
      try { write.destroy(); } catch (_) { /* 已销毁 */ }
      reject(err);
    };
    read.on('error', fail);
    write.on('error', fail);
    write.on('finish', () => resolve());
    write.write(header);
    read.on('data', (chunk) => write.write(chunk.toString('base64')));
    read.on('end', () => write.end(footer));
  });
}

async function backupExportTo(store, filePath) {
  const tmpSnapshot = `${filePath}.vacuum-snapshot.tmp.db`;
  try { fs.rmSync(tmpSnapshot, { force: true }); } catch (_) { /* 目标不存在 */ }
  const version = app.getVersion();
  const exportedAt = new Date().toISOString();
  const preferencesJSON = JSON.stringify(store.preferences.values ?? {});

  const runInWorker = () => new Promise((resolve, reject) => {
    const electron = require('electron');
    if (!electron || typeof electron.utilityProcess?.fork !== 'function') {
      return reject(new Error('utilityProcess 不可用'));
    }
    let child;
    try { child = electron.utilityProcess.fork(BACKUP_WORKER_PATH); } catch (err) { return reject(err); }
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* 已退出 */ }
      reject(new Error('备份超时'));
    }, BACKUP_WORKER_TIMEOUT_MS);
    const settle = (fn) => {
      clearTimeout(timer);
      try { child.kill(); } catch (_) { /* 已退出 */ }
      fn();
    };
    child.on('message', (m) => {
      if (!m || m.type !== 'result') return;
      if (m.ok) settle(() => resolve(m.bytes));
      else settle(() => reject(new Error(m.error || '备份失败')));
    });
    child.on('exit', () => settle(() => reject(new Error('备份进程提前退出'))));
    child.postMessage({
      type: 'backup', id: 1,
      sourcePath: store.database.filePath, tmpPath: tmpSnapshot, outPath: filePath,
      version, exportedAt, preferencesJSON,
    });
  });

  try {
    await runInWorker();
  } catch (_) {
    await backupExportInProcess(store, tmpSnapshot, filePath, version, exportedAt, preferencesJSON);
  } finally {
    try { fs.rmSync(tmpSnapshot, { force: true }); } catch (_) { /* 临时快照清理 */ }
  }
  return { path: filePath, bytes: fs.statSync(filePath).size, exportedAt };
}

/**
 * 备份导入核心：校验结构 → 解码写 restore-pending 三件套。
 * 真正替换发生在下次启动（main.js applyPendingRestore，先于 AppStore 打开数据库）。
 */
function backupImportFrom(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    throw new Error('无法解析该文件：不是有效的 JSON 备份');
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.version
    || typeof parsed.dbBase64 !== 'string' || parsed.dbBase64.length < 32) {
    throw new Error('不是有效的 RobinRead 备份文件（缺少 version / dbBase64 字段）');
  }
  const dbBytes = Buffer.from(parsed.dbBase64, 'base64');
  if (dbBytes.length < 100 || dbBytes.subarray(0, 15).toString('utf8') !== 'SQLite format 3') {
    throw new Error('备份中的数据库内容无效或已损坏');
  }
  const userData = app.getPath('userData');
  fs.writeFileSync(path.join(userData, 'restore-pending.db'), dbBytes);
  fs.writeFileSync(path.join(userData, 'restore-pending.preferences.json'),
    JSON.stringify(parsed.preferences && typeof parsed.preferences === 'object' ? parsed.preferences : {}, null, 2),
    'utf8');
  fs.writeFileSync(path.join(userData, 'restore-pending.json'),
    JSON.stringify({ done: false, importedAt: new Date().toISOString(), from: path.basename(filePath) }),
    'utf8');
  return { ready: true, importedAt: new Date().toISOString() };
}

/** 目录递归求体积（容错：目录不存在 / 无权限按 0）。 */
function directoryBytes(dir) {
  let total = 0;
  const walk = (p) => {
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch (_) { /* 跳过 */ }
      }
    }
  };
  walk(dir);
  return total;
}

/** 存储体积统计：db / wal / 正文缓存 / AI 产物 / 站点图标。 */
function storageStatsFor(store) {
  const userData = app.getPath('userData');
  const fileSize = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
  let cachesCount = 0;
  let cachesBytes = 0;
  let artifactsCount = 0;
  try {
    const row = store.database.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(text)+LENGTH(html)),0) AS bytes FROM article_caches').get();
    cachesCount = Number(row?.n ?? 0);
    cachesBytes = Number(row?.bytes ?? 0);
  } catch (_) { /* 表缺失按 0 */ }
  try {
    artifactsCount = Number(store.database.prepare('SELECT COUNT(*) AS n FROM ai_artifacts').get()?.n ?? 0);
  } catch (_) { /* 同上 */ }
  // F34 网页存档馆：存档篇数 + 总体积（全局存储统计联动）
  let archivesCount = 0;
  let archivesBytes = 0;
  try {
    const archRow = store.database.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(html_size), 0) AS bytes FROM archives').get();
    archivesCount = Number(archRow?.n ?? 0);
    archivesBytes = Number(archRow?.bytes ?? 0);
  } catch (_) { /* 表缺失按 0 */ }
  return {
    dbSize: fileSize(path.join(userData, 'library.db')),
    walSize: fileSize(path.join(userData, 'library.db-wal')),
    cachesCount,
    cachesBytes,
    artifactsCount,
    archivesCount,
    archivesBytes,
    iconsBytes: directoryBytes(path.join(userData, 'favicons')),
  };
}

/**
 * 立即清理：与 AppStore.housekeeping 相同口径的 SQL（孤儿 AI 产物 7 天、
 * 孤儿/过期正文缓存 45 天；explored_feeds 属探索画像不清理）+ 全文索引孤儿
 * 兜底 + VACUUM 压缩体积。返回清理后的最新统计。
 */
function cleanupStorage(store) {
  store.database.exec(`
    DELETE FROM ai_artifacts WHERE (item_id IS NULL OR item_id NOT IN (SELECT id FROM items))
      AND updated_at < strftime('%s','now','-7 days');
    DELETE FROM article_caches WHERE item_id NOT IN (SELECT id FROM items)
      OR fetched_at < strftime('%s','now','-45 days');
  `);
  try {
    const { sweepOrphans } = require('./Persistence/SearchIndex');
    sweepOrphans(store.database);
  } catch (_) { /* 全文索引兜底失败不阻塞 */ }
  try {
    // P2-12：同 item 同 kind 只保留最新 3 条（重试/重生成路径曾每次 uuid 新行导致表膨胀）
    store.database.exec(`
      DELETE FROM ai_artifacts WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY item_id, kind ORDER BY updated_at DESC) AS rn
          FROM ai_artifacts WHERE item_id IS NOT NULL AND is_deleted = 0
        ) WHERE rn > 3
      );
    `);
  } catch (_) { /* 行膨胀清理失败不阻塞 */ }
  try {
    store.database.exec('VACUUM');
    // P1-4：VACUUM 可能重排 FTS rowid，必须重建映射（SearchIndex 明文要求），否则首查全表扫
    const { rebuildMap } = require('./Persistence/SearchIndex');
    rebuildMap(store.database);
  } catch (_) { /* VACUUM 失败不阻塞统计回显 */ }
  return storageStatsFor(store);
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// MARK: Feed 图标协议（robin-icon:// → FeedIconStore 三级缓存）
let _iconProtocolInstalled = false;
function registerIconProtocol() {
  if (_iconProtocolInstalled) return;
  _iconProtocolInstalled = true;
  const { FeedIconStore } = require('./FeedIconStore');
  const icons = new FeedIconStore(path.join(app.getPath('userData'), 'favicons'));
  protocol.handle('robin-icon', async (request) => {
    try {
      const url = new URL(request.url);
      const dataURL = await icons.load({
        storedIconURL: url.searchParams.get('stored') || '',
        siteURL: url.searchParams.get('site') || '',
        feedURL: url.searchParams.get('feed') || '',
        host: url.searchParams.get('host') || '',
      });
      if (!dataURL) return new Response('', { status: 404 });
      const comma = dataURL.indexOf(',');
      const mime = dataURL.slice(5, comma).split(';')[0] || 'image/png';
      const body = Buffer.from(dataURL.slice(comma + 1), 'base64');
      return new Response(body, { headers: { 'Content-Type': mime, 'Cache-Control': 'max-age=86400' } });
    } catch (_) {
      return new Response('', { status: 404 });
    }
  });
}

// 图片防盗链通用治理：本地页面（file://）发起的图片请求不带 Referer，
// 部分国内 CDN（少数派 cdnfile、微信、知乎等）会因此 403。
// 策略：图片子请求若 Referer 为空 → 注入 Referer。微信图片 CDN（qpic.cn）要求
// 注入 mp.weixin.qq.com（文章源站），其余注入图片自身站点根。
// 注册在 registerIPCHandlers 内，保证测试 harness 直接调用时同样生效。
let _networkInterceptorsInstalled = false;
function registerNetworkInterceptors() {
  if (_networkInterceptorsInstalled) return;
  _networkInterceptorsInstalled = true;
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (details.resourceType === 'image' && !headers.Referer && !headers.referer) {
      try {
        const url = new URL(details.url);
        if (url.protocol === 'https:' || url.protocol === 'http:') {
          const host = url.host.toLowerCase();
          const refererHost = (host === 'mmbiz.qpic.cn' || host.endsWith('.qpic.cn'))
            ? 'mp.weixin.qq.com'
            : url.host;
          headers.Referer = `${url.protocol}//${refererHost}/`;
        }
      } catch (_) { /* 非法地址跳过 */ }
    }
    callback({ requestHeaders: headers });
  });
}

function registerIPCHandlers(store, window) {
  registerNetworkInterceptors();
  registerIconProtocol();
  const send = (channel, payload) => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };

  // 状态推送
  const { STRINGS } = require('./I18NStrings');
  const { i18n } = require('./I18N');
  const onStateChanged = () => send('state:changed', {
    ...store.snapshot(),
    version: app.getVersion(), // R-D2：推送快照也带版本（关于页/设置在任意推送后仍可显示）
    language: i18n.language,
    prefersDark: nativeTheme.shouldUseDarkColors,
    customTheme: store.preferences.get('RobinRead.customTheme', null),
  });
  store.on('state:changed', onStateChanged);
  store.on('ai:delta', (payload) => send('ai:delta', payload));
  store.on('ai:status', (payload) => send('ai:status', payload));

  // MARK: 新文章通知（刷新完成 × 未读净增 × 偏好开启 × 窗口不在前台）
  // 模块级观察状态：refreshing → 非refreshing 的转变时刻比较刷新前后的全站未读数。
  let notifyWasRefreshing = false;
  let notifyUnreadAtRefreshStart = null;
  store.on('state:changed', () => {
    try {
      const snap = store.snapshot();
      const unread = Number(snap.sidebarCounts?.allUnread ?? 0) || 0;
      const refreshing = snap.refreshStatus?.state === 'refreshing';
      if (refreshing && !notifyWasRefreshing) {
        notifyUnreadAtRefreshStart = unread; // 记录刷新前基线
      }
      if (!refreshing && notifyWasRefreshing) {
        const baseline = notifyUnreadAtRefreshStart;
        notifyUnreadAtRefreshStart = null;
        // 基线缺失（如启动即处于刷新中）时退回 store 给出的本次新增数
        const fallback = Number(snap.lastRefreshOutcome?.newUnreadCount ?? 0) || 0;
        const gained = Math.max(0, baseline == null ? fallback : unread - baseline);
        if (gained >= 1
          && store.preferences.get('RobinRead.newArticleNotify', true) !== false
          && !window.isDestroyed()
          && !(window.isVisible() && !window.isMinimized())) {
          // 仅窗口隐藏 / 最小化时提醒，前台阅读不打扰；主进程通知无需请求权限
          const notification = notificationBridge.create({
            title: '知更 · 新文章',
            body: `本次刷新新增 ${gained} 篇文章`,
            icon: resolveIcon(),
          });
          notification.on('click', () => {
            try {
              const win = !window.isDestroyed() ? window : BrowserWindow.getAllWindows()[0];
              if (!win) return;
              if (win.isMinimized()) win.restore();
              win.show();
              win.focus();
            } catch (_) { /* 通知点击不抛错 */ }
          });
          notification.show();
        }
      }
      notifyWasRefreshing = refreshing;
    } catch (_) { /* 通知链路异常不干扰状态推送 */ }
  });

  // 系统主题变化 → 同步推送到渲染层（含非 createMainWindow 创建的窗口）
  nativeTheme.on('updated', () => {
    send('theme:changed', { shouldUseDarkColors: nativeTheme.shouldUseDarkColors });
    send('state:changed', { ...store.snapshot(), version: app.getVersion(), language: i18n.language, prefersDark: nativeTheme.shouldUseDarkColors, customTheme: store.preferences.get('RobinRead.customTheme', null) });
  });

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    });
  };

  // MARK: 状态查询
  handle('app:state', () => ({
    ...store.snapshot(),
    llm: store.llmConfigurationSnapshot(),
    hasAPIKey: store.hasAIAPIKey(),
    strings: STRINGS,
    language: i18n.language,
    prefersDark: nativeTheme.shouldUseDarkColors,
    customTheme: store.preferences.get('RobinRead.customTheme', null),
    version: app.getVersion(),
  }));
  handle('app:sidebar', () => store.sidebarStructure());
  handle('app:syncStates', () => store.accountSyncStates());
  handle('app:list', (scope, options) => store.listItems(scope, options || {}));
  handle('app:reader', (entryID) => store.readerArticle(entryID));
  handle('app:entry', (entryID) => {
    const entry = store.entry(entryID);
    if (!entry) return null;
    const feed = store.feed(entry.feedID);
    const content = store.articleContent(entryID);
    const summary = store.existingSummary(entryID);
    return { entry, feed, content, summary };
  });
  handle('app:adjacent', (scope, entryID, direction) => store.adjacentItem(scope, entryID, direction));

  // MARK: Feed / 文件夹
  handle('feeds:add', (url, folder) => store.addFeed(url, folder));
  // 中文平台适配器（F5）：试抓预览（添加对话框 B 站/微博 tab）+ 平台源添加
  handle('platforms:preview', (payload) => store.platforms.preview(payload || {}));
  handle('feeds:addPlatform', (payload) => store.addPlatformFeed(payload || {}));
  handle('feeds:delete', (feedIDs) => store.deleteFeeds(feedIDs));
  handle('feeds:setFolder', (feedIDs, folderName) => store.setFeedFolder(feedIDs, folderName));
  handle('feeds:reorder', (orderedIDs) => store.reorderFeeds(orderedIDs));
  handle('folders:add', (name) => store.addFolder(name));
  handle('folders:rename', (folderID, newName) => store.renameFolder(folderID, newName));
  handle('folders:delete', (folderID) => store.deleteFolder(folderID));

  // MARK: OPML（文件对话框在主进程）
  handle('opml:import', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '导入 OPML',
      filters: [{ name: 'OPML', extensions: ['opml', 'xml'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const data = fs.readFileSync(result.filePaths[0]);
    return store.importOPML(data);
  });
  handle('opml:export', async () => {
    const result = await dialog.showSaveDialog(window, {
      title: '导出 OPML',
      defaultPath: 'RobinRead-subscriptions.opml',
      filters: [{ name: 'OPML', extensions: ['opml'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const xml = store.exportOPML();
    fs.writeFileSync(result.filePath, xml, 'utf8');
    return { path: result.filePath };
  });

  // MARK: 刷新
  handle('refresh:run', () => store.refresh('manual'));
  handle('refresh:feed', (feedID) => store.refreshFeed(feedID));

  // MARK: 搜索
  handle('app:search', (query, options) => store.searchEntries(query, options || {}));
  handle('app:smartFolderSearch', (query, limit) => store.searchEntries(query, { limit: Number(limit) || 200 }));

  // MARK: 今日简报（流式 + 当日缓存秒开）
  handle('ai:digest', (mode) => store.generateTodayDigest((delta) => send('ai:digest-delta', { delta }), mode === 'deep' ? 'deep' : 'brief'));
  handle('ai:digestCache', (mode) => store.cachedTodayDigest(mode === 'deep' ? 'deep' : 'brief'));

  // MARK: 阅读排版
  handle('prefs:setReaderLayout', (patch) => store.setReaderLayout(patch));
  handle('prefs:readerCustomCSS', () => store.readerCustomCSS());
  handle('prefs:setFeedTypography', ({ feedID, patch } = {}) => store.setFeedTypography(feedID, patch));
  handle('prefs:setFilterRules', (patch) => store.setFilterRules(patch));
  // 命令面板自学习（U30）：频次 JSON map 持久化
  handle('prefs:paletteFrequency', () => store.paletteFrequency());
  handle('prefs:recordPaletteUse', (label) => store.recordCommandUse(label));

  // MARK: 阅读状态
  handle('read:mark', (entryID, read) => store.markRead(entryID, read));
  handle('read:toggleStar', (entryID) => store.toggleStar(entryID));
  handle('read:toggleLater', (entryID, later) => store.toggleLater(entryID, later));
  handle('read:markAll', (scope) => store.markAllRead(scope));
  handle('read:markMany', (entryIDs, read) => store.markMany(entryIDs, read));
  handle('read:starMany', (entryIDs, starred) => store.starMany(entryIDs, starred));
  handle('read:laterMany', (entryIDs, later) => store.laterMany(entryIDs, later));

  // MARK: 正文提取
  handle('extract:run', (entryID) => store.extractArticle(entryID));
  // R-D3：任意 URL → 精读（不落库，供链接精读/出图流程）
  handle('extract:url', async (url) => {
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('仅支持 http(s) 链接');
    return ArticleExtractor.extract(String(url), { priority: 'user' });
  });

  // MARK: 存储治理（保留期限 + 立即清理）
  handle('maintenance:get', () => store.getMaintenance());
  handle('maintenance:set', (days) => store.setRetentionDays(days));
  handle('maintenance:cleanup', () => store.cleanupNow());

  // MARK: 每源翻译模式 + 单篇自动翻译记忆
  handle('translate:setFeedMode', (feedID, mode) => store.setTranslateFeedMode(feedID, mode));
  handle('translate:skipArticle', (entryID) => store.skipArticleTranslate(entryID));

  // MARK: 每源全文抓取三态 + 补抓统计（F1）
  handle('fulltext:setFeedMode', (feedID, mode) => store.setFulltextFeedMode(feedID, mode));
  handle('fulltext:stats', () => store.fulltext.feedStats());

  // MARK: 规则过滤引擎（F2：CRUD / 顺序 / 测试器 / 回放 / 样本）
  const R = () => store.rules;
  handle('rules:list', () => R().listRules());
  handle('rules:save', (payload) => R().saveRule(payload || {}));
  handle('rules:delete', (id) => R().deleteRule(id));
  handle('rules:setEnabled', (id, enabled) => R().setRuleEnabled(id, enabled));
  handle('rules:move', (id, direction) => R().moveRule(id, direction));
  handle('rules:test', (payload, sample) => R().testRule(payload || {}, sample || {}));
  handle('rules:replay', (opts) => R().replayRecent(opts || {}));
  handle('rules:samples', (limit) => R().recentSamples(limit));

  // MARK: 媒体中心（F3：视图查询 / 进度 / 队列 / 离线下载；下载进度走推送）
  const M = () => store.media;
  if (store.media) store.media.onDownloadProgress((payload) => send('media:download-progress', payload));
  handle('media:list', (filter, opts) => M().list({ filter, ...(opts || {}) }));
  handle('media:counts', () => M().counts());
  handle('media:source', (entryID) => M().source(entryID));
  handle('media:progress', (entryID, positionSeconds, finished) => M().saveProgress(entryID, positionSeconds, { finished: finished === true }));
  handle('media:queue:list', () => M().queueList());
  handle('media:queue:add', (entryID) => M().queueAdd(entryID));
  handle('media:queue:remove', (entryID) => M().queueRemove(entryID));
  handle('media:queue:clear', () => M().queueClear());
  handle('media:queue:next', (afterID) => M().queueNext(afterID));
  handle('media:download', (entryID) => M().download(entryID));
  handle('media:download:delete', (entryID) => M().deleteDownload(entryID));

  // MARK: 事件聚类去重（F21：事件卡摘要——代表条目/N 源/成员清单；簇行惰性回收）
  handle('events:summaries', (ids) => store.events.summaries(ids));
  // F21 审查遗留收口（批 C）：rebuild 用户入口——命令面板「重建事件索引」对近 7 天存量补聚类
  handle('events:rebuild', () => store.events.rebuild({ windowDays: 7 }));

  // MARK: 播客转文字稿（F22：发起/读回/配置/AI 摘要；进度走推送）
  if (store.media) store.media.onTranscribeProgress((payload) => send('media:transcribe-progress', payload));
  handle('media:transcribe', (itemID) => M().transcribe(itemID));
  handle('media:transcript', (itemID) => M().transcript(itemID));
  handle('media:transcribeConfig:get', () => M().transcribeConfig());
  handle('media:transcribeConfig:set', (patch) => M().transcribeSetConfig(patch || {}));
  handle('media:transcribeReady', () => M().transcribeReady());
  handle('media:transcript:summary', (itemID) => M().transcriptSummary(itemID));

  // MARK: 话题盯梢（F4：CRUD / 聚合 / 信息流）
  const TP = () => store.topics;
  handle('topics:list', () => TP().listTopics());
  handle('topics:save', (payload) => TP().saveTopic(payload || {}));
  handle('topics:delete', (id) => TP().deleteTopic(id));
  handle('topics:setEnabled', (id, enabled) => TP().setTopicEnabled(id, enabled === true));
  handle('topics:aggregate', (id) => TP().aggregateTopic(id, { force: true }));
  handle('topics:hits', (id, opts) => TP().hits(id, opts || {}));

  // MARK: Newsletter 收件（F6：邮箱账户 / 白名单发件人 / 测试连接）
  const ML = () => store.mail;
  handle('mail:accounts', () => ML().listAccounts());
  handle('mail:add', (payload) => ML().addAccount(payload || {}));
  handle('mail:test', (payload) => ML().testConnection(payload || {}));
  handle('mail:delete', (id) => ML().deleteAccount(id));
  handle('mail:setEnabled', (id, enabled) => ML().setAccountEnabled(id, enabled === true));
  handle('mail:setSelfSigned', (id, allow) => ML().setSelfSigned(id, allow === true));
  handle('mail:senders', (accountID) => ML().listSenders(accountID));
  handle('mail:addSender', (payload) => ML().addSender(payload || {}));
  handle('mail:removeSender', (feedID) => ML().removeSender(feedID));

  // MARK: WebDAV 多设备同步（F7：配置 / 测试 / 立即同步 / 自动开关 / 阅读位置上报）
  const SY = () => store.sync;
  if (store.sync) {
    // 合并后的远端阅读位置回推 renderer（reader 并入续读表）
    store.sync.setProgressForwarder((payload) => send('sync:progress', payload));
    // 渲染层阅读位置上报走 fire-and-forget（ipcMain.on，不占 invoke 往返）
    ipcMain.on('sync:reportProgress', (_event, entries) => {
      try { store.sync.reportProgress(Array.isArray(entries) ? entries : []); } catch (_) { /* 上报失败静默 */ }
    });
  }
  handle('sync:getConfig', () => (store.sync ? SY().getConfig() : null));
  handle('sync:saveConfig', (patch) => (store.sync ? SY().saveConfig(patch || {}) : null));
  handle('sync:disconnect', () => (store.sync ? SY().disconnect() : null));
  handle('sync:test', (payload) => (store.sync ? SY().testConnection(payload || {}) : null));
  handle('sync:setAuto', (enabled) => (store.sync ? SY().setAutoEnabled(enabled === true) : null));
  handle('sync:now', () => (store.sync ? SY().syncNow({ origin: 'manual' }) : null));

  // MARK: Obsidian 知识库导出（F11：选目录授权 / 预览 / 增量导出 / 全量重导 / 配置）
  // 目录授权与 pickSavePath 写盘 token 同源不同形：openDirectory 结果只登记进
  // ObsidianExportService 的内存态（DAV 式），重启/换实例即失效，绝不持久化写权限。
  const OB = () => store.obsidian;
  handle('obsidian:pickDir', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '选择 Obsidian 库目录',
      buttonLabel: '授权此目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return { dir: OB().authorizeDirectory(result.filePaths[0]) };
  });
  handle('obsidian:preview', () => OB().preview());
  handle('obsidian:export', () => OB().exportOrchestrate());
  handle('obsidian:fullExport', () => OB().fullExport());
  handle('obsidian:config', (patch) => (patch ? OB().saveConfig(patch) : OB().getConfig()));

  // MARK: 个人文集自动成书（F12：书架 CRUD / 手动成书 / 自动目录 / 打开目录）
  // 手动成书走保存对话框（EPUB 过滤器）后由主进程直接落盘（backup:export 同款先例，
  // 不经渲染层 writeBinaryFile 通道）；多卷时第 1 卷用所选路径，第 N 卷落其旁 ` vol.N.epub`。
  const BK = () => store.books;
  handle('books:list', () => ({ books: BK().listBooks() }));
  handle('books:create', (payload) => BK().createBook(payload || {}));
  handle('books:update', (payload) => BK().updateBook(payload?.id, payload || {}));
  handle('books:addFeeds', (payload) => BK().addFeeds(payload?.id, payload?.feedIDs));
  handle('books:delete', (id) => BK().deleteBook(id));
  handle('books:build', async (id) => {
    const book = BK().listBooks().find((b) => b.id === id);
    if (!book) throw new Error('文集不存在');
    const safeName = `${book.title}`.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'RobinRead Book';
    const result = await dialog.showSaveDialog(window, {
      title: '立即成书',
      defaultPath: `${safeName}.epub`,
      filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return BK().buildToPath(book, result.filePath);
  });
  handle('books:openDir', (id) => {
    const book = BK().listBooks().find((b) => b.id === id);
    if (!book) throw new Error('文集不存在');
    BK().markPicked(id); // 打开目录即「已取」：清除书架「待取」徽标
    const dir = BK().autoDir(id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* 已存在 */ }
    const files = book.lastFiles;
    if (files.length) shell.showItemInFolder(path.join(dir, files[0]));
    else shell.openPath(dir);
    return { dir, file: files[0] || null };
  });

  // MARK: 相关文章 + 线索视图（F13：文末继续读 / 知识中心线索 tab）
  const SIM = () => store.similar;
  handle('similar:for', (entryID, limit) => SIM().similar(String(entryID || ''), { limit: Number(limit) || 6 }));
  handle('threads:list', () => SIM().threadsList());
  handle('threads:detail', (keyword) => SIM().threadsDetail(String(keyword || '')));

  // MARK: 知识花园 · 知更养成（F23：状态 / 开花报告 / 阶段变更推送）
  handle('garden:state', () => store.garden.state());
  handle('garden:report', () => store.garden.weeklyReport());
  store.on('garden:changed', (payload) => send('garden:changed', payload));

  // MARK: AI 周刊编辑部（F29）：后台自动生成完成 → 渲染层 toast（静默不打扰）
  store.on('weekly:changed', (payload) => send('weekly:changed', payload));

  // MARK: 观点对照镜（F24：按需判定（点按钮才跑）/ 取消 / 已判三组）
  handle('perspectives:available', () => ({ ai: store.hasAIAPIKey() }));
  handle('perspectives:mirror', async (entryID) => store.perspectives.mirror(String(entryID || '')));
  handle('perspectives:cancel', (entryID) => store.cancelAI(`perspectives:${String(entryID || '')}`));
  handle('perspectives:groups', (entryID) => store.perspectives.groups(String(entryID || '')));

  // MARK: AI 反方辩手（F25：开场 / 多轮回合 / 取消 / 读回 / 裁决 / 存为批注）
  const DB = () => store.debates;
  handle('debates:available', () => DB().available());
  handle('debates:start', (entryID) => DB().startDebate(String(entryID || '')));
  handle('debates:reply', (debateID, text) => DB().reply(String(debateID || ''), String(text || '')));
  handle('debates:cancel', (entryID) => DB().cancel(String(entryID || '')));
  handle('debates:current', (entryID) => DB().current(String(entryID || '')));
  handle('debates:verdict', (debateID, verdict) => DB().verdict(String(debateID || ''), verdict));
  handle('debates:saveHighlight', (debateID) => DB().saveHighlight(String(debateID || '')));

  // MARK: 读后点亮测验（F26：出题 / 判分点亮 / 取消 / 读回最近一次 / 可用性）
  const QZ = () => store.quiz;
  handle('quiz:available', () => QZ().available());
  handle('quiz:generate', (entryID) => QZ().generateQuiz(String(entryID || '')));
  handle('quiz:submit', (quizID, answers) => QZ().submit(String(quizID || ''), Array.isArray(answers) ? answers : []));
  handle('quiz:cancel', (entryID) => QZ().cancel(String(entryID || '')));
  handle('quiz:latest', (entryID) => QZ().latest(String(entryID || '')));

  // MARK: 深读重访（F37：每日温和提示 / 到期懒结算列表 / 回应推迟 / AI 重读指引（缓存））
  const RV = () => store.revisit;
  handle('revisit:nudge', () => RV().nudge());
  handle('revisit:due', () => RV().due());
  handle('revisit:respond', (revisitID, action) => RV().respond(String(revisitID || ''), String(action || '')));
  handle('revisit:guidance', (revisitID) => RV().guidance(String(revisitID || '')));
  handle('revisit:cancel', (revisitID) => RV().cancel(String(revisitID || '')));
  store.on('revisit:changed', (payload) => send('revisit:changed', payload));

  // MARK: 来源立场光谱（F38：可用性 / 光谱视图投影 / 手动批量分析 / 单源画像 / 文章级联动）
  const SPECT = () => store.spectrum;
  handle('spectrum:available', () => SPECT().available());
  handle('spectrum:view', () => SPECT().view());
  handle('spectrum:analyze', (opts) => SPECT().analyze({ force: Boolean(opts && opts.force) }));
  handle('spectrum:cancel', () => SPECT().cancel());
  handle('spectrum:forEntry', (entryID) => SPECT().forEntry(String(entryID || '')));

  // MARK: 挑战赛季（F40：列表懒结算 / 模板 / 创建 / 放弃 / 挑战卡 SVG / 变更推送）
  const CH = () => store.challenge;
  handle('challenge:list', () => ({ challenges: CH().list() }));
  handle('challenge:templates', () => ({ templates: CH().templates() }));
  handle('challenge:available', () => CH().available());
  handle('challenge:create', (payload) => CH().createChallenge(payload || {}));
  handle('challenge:abandon', (challengeID) => CH().abandon(String(challengeID || '')));
  handle('challenge:card', (challengeID) => CH().card(String(challengeID || '')));
  store.on('challenge:changed', (payload) => send('challenge:changed', payload));

  // MARK: 阅读数据开放 API（F39：配置读回 / 变更（开关即时启停/端口校验）/ 令牌重生成 / 状态）
  handle('api:config', () => ({ config: store.api.getConfig(), status: store.api.status() }));
  handle('api:setConfig', (patch) => store.api.configure(patch || {}));
  handle('api:regenerateToken', () => ({ token: store.api.regenerateToken(), status: store.api.status() }));
  store.on('api:changed', (payload) => send('api:changed', payload));

  // MARK: 口袋知更（F31：局域网轻量 Web 阅读服务——配置读回 / 变更（开关即时启停/
  //   端口校验 / 绑定模式须显式确认 confirmLan）/ 访问二维码 SVG）
  handle('pocket:config', () => ({ config: store.pocket.getConfig(), status: store.pocket.status() }));
  handle('pocket:setConfig', (patch) => store.pocket.configure(patch || {}));
  handle('pocket:qr', () => store.pocket.qrSVG() || { url: null, svg: null });
  store.on('pocket:changed', (payload) => send('pocket:changed', payload));

  // MARK: 知更实验室 · 用户脚本（F32：账本管理全在主进程；沙箱执行在渲染层）
  const US = () => store.userScripts;
  handle('userScripts:list', () => ({ scripts: US().list() }));
  handle('userScripts:enabled', () => ({ scripts: US().enabledScripts() }));
  handle('userScripts:get', (id) => US().get(String(id || '')));
  // 脚本输出消毒（批 J 审查 P2）：用户脚本变换结果直达 innerHTML 前的最后闸门
  handle('userScripts:sanitize', (html) => ArticleExtractor.sanitizedHTML(String(html || '')));
  handle('userScripts:import', (payload) => US().importScript(payload)); // 载荷=JSON 字符串或对象（文件导入走 importPick 对话框）
  handle('userScripts:importPick', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '导入用户脚本（.ruser）',
      filters: [{ name: 'RobinRead 用户脚本', extensions: ['ruser', 'json'] }, { name: 'All Files', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return US().importFromFile(result.filePaths[0]);
  });
  handle('userScripts:setEnabled', (id, enabled) => US().setEnabled(String(id || ''), enabled === true));
  handle('userScripts:remove', (id) => US().remove(String(id || '')));
  handle('userScripts:exportExample', async () => {
    const json = US().exportExample();
    const result = await dialog.showSaveDialog(window, {
      title: '导出示例脚本',
      defaultPath: '段落间距压缩.ruser',
      filters: [{ name: 'RobinRead 用户脚本', extensions: ['ruser'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, json, 'utf8');
    return { path: result.filePath, bytes: Buffer.byteLength(json, 'utf8') };
  });

  // MARK: 外文源自动译（F33：手动整篇翻译 / 读回 / 取消 / 订阅级开关 / 可用性 / 诊断；
  //   分块进度走推送通道 translate:progress（阅读器进度提示），终态走信封返回）
  const TR = () => store.translation;
  if (store.translation) {
    store.on('translation:progress', (payload) => send('translate:progress', payload));
  }
  handle('translate:fullAvailable', () => TR().available());
  handle('translate:full', (entryID) => TR().translateNow(String(entryID || '')));
  handle('translate:fullGet', (entryID) => TR().get(String(entryID || '')));
  handle('translate:fullCancel', (entryID) => TR().cancel(String(entryID || '')));
  handle('translate:autoConfig', (patch) => {
    if (patch && typeof patch === 'object' && patch.feedID) TR().setFeedEnabled(String(patch.feedID), patch.enabled === true);
    return TR().feedModes();
  });
  handle('translate:autoSnapshot', () => TR().snapshot());

  // MARK: 网页存档馆（F34：存档 / 取消 / 探测 / 列表搜索 / MHTML 导出（保存对话框→主进程落盘）/
  //   追更源自动存档开关 / 配额统计）
  const AR = () => store.archive;
  handle('archive:do', (entryID) => AR().archive(String(entryID || '')));
  handle('archive:undo', (entryID) => AR().unarchive(String(entryID || '')));
  handle('archive:has', (entryID) => AR().has(String(entryID || '')));
  handle('archive:list', (opts) => AR().list(opts || {}));
  handle('archive:stats', () => AR().stats());
  handle('archive:autoConfig', (patch) => {
    if (patch && typeof patch === 'object' && patch.feedID) AR().setAutoArchive(String(patch.feedID), patch.enabled === true);
    return AR().autoFeeds();
  });
  handle('archive:export', async (entryID) => {
    const entry = store.entry(String(entryID || ''));
    if (!entry) throw new Error('文章不存在');
    const safeName = `${entry.title || 'RobinRead Article'}`.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'RobinRead Article';
    const result = await dialog.showSaveDialog(window, {
      title: '导出存档 MHTML',
      defaultPath: `${safeName}.mhtml`,
      filters: [{ name: 'MHTML 网页存档', extensions: ['mhtml', 'mht'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const mime = AR().buildMHTML(String(entryID || ''));
    fs.writeFileSync(result.filePath, mime, 'utf8');
    return { path: result.filePath, bytes: Buffer.byteLength(mime, 'utf8'), title: safeName };
  });

  // MARK: 时间胶囊（F27：封存 / 到期浮出（懒结算）/ 开启仪式 / 历史报告 / 侧栏徽标计数 / 简报段投影）
  const CP = () => store.capsule;
  handle('capsule:seal', (payload) => CP().seal(payload || {}));
  handle('capsule:due', () => CP().due());
  handle('capsule:pending', () => CP().pendingCount());
  handle('capsule:open', (capsuleID) => CP().open(String(capsuleID || '')));
  handle('capsule:list', (opts) => CP().list(opts || {}));
  handle('capsule:digest', () => CP().digestProjection());

  // MARK: 批注漂流瓶（F28：导出（保存对话框→主进程落盘，照 BooksService 手动成书先例）/
  //   导入（打开对话框→主进程读取→消毒/版本/大小三道闸））
  const RB = () => store.bundles;
  handle('bundle:export', async (payload) => {
    const { entryID, includeFullText = true } = payload || {};
    const bundle = RB().buildBundle(String(entryID || ''), { includeFullText });
    const result = await dialog.showSaveDialog(window, {
      title: '打包批注分享',
      defaultPath: bundle.suggestedName,
      filters: [{ name: 'RobinRead 批注包', extensions: ['robin'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const written = RB().writeBundleFile(bundle.json, result.filePath);
    return { ...written, annotationCount: bundle.annotationCount, title: bundle.payload.article.title };
  });
  handle('bundle:importPick', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '导入批注包',
      filters: [{ name: 'RobinRead 批注包', extensions: ['robin'] }, { name: 'All Files', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return RB().importFromFile(result.filePaths[0]);
  });

  // MARK: AI 周刊编辑部（F29：生成 / 取消 / 列表 / 详情 / 导出 EPUB（保存对话框→主进程落盘））
  const WK = () => store.weekly;
  handle('weekly:available', () => WK().available());
  handle('weekly:generate', (weekStart) => WK().generateWeek(weekStart ? String(weekStart) : null));
  handle('weekly:cancel', (weekStart) => {
    // running[0] 已是完整键（批 E 审查 P1：再拼 weekly: 前缀得 weekly:weekly:，取消静默 no-op）
    const key = String(weekStart || '') ? `weekly:${String(weekStart)}` : String(WK().snapshot().running[0] || '');
    return store.cancelAI(key);
  });
  handle('weekly:list', () => ({ weeklies: WK().list() }));
  handle('weekly:get', (weeklyID) => WK().get(String(weeklyID || '')));
  handle('weekly:export', async (weeklyID) => {
    const weekly = WK().get(String(weeklyID || ''));
    if (!weekly || weekly.status !== 'ready') throw new Error('周刊尚未生成完成，无法导出。');
    const safeName = `知更周刊 第 ${weekly.issue || 1} 期`.replace(/[\\/:*?"<>|]/g, ' ').trim();
    const result = await dialog.showSaveDialog(window, {
      title: '导出周刊 EPUB',
      defaultPath: `${safeName}.epub`,
      filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const buffer = WK().buildEpub(weekly.id);
    fs.writeFileSync(result.filePath, buffer);
    return { path: result.filePath, bytes: buffer.length, title: `${safeName}` };
  });

  // MARK: 自学课程引擎（F30：可用性 / 创建 / 列表 / 详情 / 今日课 / 完成打卡 / 放弃 / 取消）
  const CS = () => store.course;
  handle('course:available', () => CS().available());
  handle('course:create', (goal, days) => CS().createCourse(String(goal || ''), { days }));
  handle('course:list', () => ({ courses: CS().list() }));
  handle('course:get', (courseID) => CS().get(String(courseID || '')));
  handle('course:today', (courseID) => CS().todayCourse(String(courseID || '')));
  handle('course:completeDay', (courseID, day) => CS().completeDay(String(courseID || ''), Number(day)));
  handle('course:abandon', (courseID) => CS().abandon(String(courseID || '')));
  handle('course:cancel', () => CS().cancelCreate());

  // MARK: 语音指挥舱（F35：口令表 / 模糊匹配（单一事实源在主进程，渲染层识别回调走此通道）/
  //   开关持久化）。识别本体（webkitSpeechRecognition）与浮球 UI 在渲染层，可用性探测后启用。
  const VC = () => store.voice;
  handle('voice:config', () => VC().getConfig());
  handle('voice:setEnabled', (value) => VC().setEnabled(value === true));
  handle('voice:commands', (lang) => ({ lang: VC().lang(), commands: VC().commands(lang ? String(lang) : null) }));
  handle('voice:match', (text, lang) => VC().match(String(text || ''), lang ? String(lang) : null));

  // MARK: 阅读生物钟（F36：高峰状态（热力条 24 桶）/ 对齐动作开关 / 刷新调度建议；
  //   时长脉冲走 fire-and-forget（ipcMain.on，渲染层 15s 心跳，不占 invoke 往返））
  handle('clock:status', () => store.clock.status());
  handle('clock:advice', () => store.clock.refreshAdvice({ anchorHour: store.refreshAnchorHour() }));
  handle('clock:config', (patch) => (patch ? store.clock.configure(patch || {}) : store.clock.getConfig()));
  handle('clock:shouldPromptFocus', () => store.clock.shouldPromptFocus());
  handle('clock:markFocusPrompted', () => store.clock.markFocusPrompted());
  ipcMain.on('clock:pulse', (_event, ms) => {
    try { store.clock.pulse(Number(ms) || 0); } catch (_) { /* 生物钟喂入失败不阻塞 */ }
  });

  // MARK: AI 自动标签（F15：开关（偏好持久化）/ 立即跑一批 / 诊断快照）
  handle('tags:autoConfig', (patch) => {
    if (patch && typeof patch === 'object' && 'enabled' in patch) store.tagAuto.setEnabled(patch.enabled === true);
    return store.tagAuto.snapshot();
  });
  handle('tags:autoKick', () => store.tagAuto.kick({ force: true }));
  handle('tags:autoSnapshot', () => store.tagAuto.snapshot());

  // MARK: 订阅源体检仪表盘（F16：总览（60s 缓存）/ 单源详情）
  handle('dash:overview', () => store.dash.overview());
  handle('dash:feed', (feedID) => store.dash.feedDetail(String(feedID || '')));

  // MARK: 多窗并读（F17：弹出独立阅读窗口；同 entryID 聚焦既有窗口 / 上限 4 窗）
  handle('readerWindow:open', (entryID) => readerWindows.open(store, window, String(entryID || '')));

  // MARK: 网页追更（F18：试抓预览 / 添加 / 更改选择器 / 停止追更）
  handle('monitor:preview', (payload) => store.monitor.preview(payload || {}));
  handle('monitor:add', (payload) => store.addMonitorFeed(payload || {}));
  handle('monitor:setSelector', (feedID, selector) => store.monitor.changeSelector(String(feedID || ''), selector));
  handle('monitor:stop', (feedID) => store.monitor.stopMonitor(String(feedID || '')));

  // MARK: AI 深度研究（F8：素材聚合 / 流式生成 / 追问 / 历史 / 取消）
  // 流式分片与阶段经推送通道下行（research:delta / research:status），最终结果走信封返回。
  const RS = () => store.research;
  handle('research:list', () => RS().listReports());
  handle('research:get', (id) => RS().report(id));
  handle('research:delete', (id) => RS().deleteReport(id));
  handle('research:generate', (topic) => RS().generate(String(topic || ''), {
    onDelta: (delta) => send('research:delta', { delta }),
    onStatus: (phase) => send('research:status', { phase }),
  }));
  handle('research:followUp', (id, question) => RS().followUp(id, String(question || ''), {
    onDelta: (delta) => send('research:delta', { delta }),
    onStatus: (phase) => send('research:status', { phase }),
  }));
  handle('research:cancel', () => RS().cancelActive());
  handle('research:snapshot', () => RS().snapshot());

  // MARK: 全库 RAG 问答（F9：会话 / 流式问答 / 纯检索 / 取消 / 重命名 / 素材）
  // 流式分片与阶段经推送通道下行（rag:delta / rag:status），最终结果走信封返回；
  // 纯检索模式（无 Key）走 rag:gather——不调 LLM，只聚合本地素材。
  const RG = () => store.rag;
  handle('rag:sessions', () => RG().listSessions());
  handle('rag:session', (id) => RG().session(id));
  handle('rag:gather', (question) => RG().gatherRAG(String(question || '')));
  handle('rag:ask', (sessionID, question) => RG().ask(sessionID, String(question || ''), {
    onDelta: (delta) => send('rag:delta', { delta }),
    onStatus: (phase) => send('rag:status', { phase }),
  }));
  handle('rag:cancel', () => RG().cancelActive());
  handle('rag:delete', (id) => RG().deleteSession(id));
  handle('rag:rename', (id, title) => RG().renameSession(id, String(title || '')));
  handle('rag:sources', (messageID) => RG().sources(messageID));
  handle('rag:snapshot', () => RG().snapshot());

  // MARK: 智能每日精选（F10：画像摘要 / Top N 精选 / 不感兴趣 / 播报文稿 / 数量档位）
  const SP = () => store.smartPicks;
  handle('picks:profile', () => SP().profileSummary());
  handle('picks:get', (opts) => SP().pickTop(opts || {}));
  handle('picks:exclude', (entryID) => SP().exclude(entryID));
  handle('picks:broadcast', (opts) => SP().broadcastScript(opts || {}));
  handle('picks:setLimit', (n) => SP().setLimit(n));

  // MARK: 简报电台（F19：电台文稿 / 播放位置记忆 / 诊断快照）
  const DR = () => store.digestRadio;
  handle('radio:script', (opts) => DR().radioScript(opts || {}));
  handle('radio:savePosition', (sessionKey, index, meta) => DR().savePosition(sessionKey, index, meta || {}));
  handle('radio:getPosition', (sessionKey, hash) => DR().getPosition(sessionKey, { hash }));
  handle('radio:snapshot', () => DR().snapshot());

  // MARK: 阅读目标与专注会话（F20：进度聚合 / 周目标 / 达标恭喜一次性）
  handle('goal:progress', () => store.readingGoalsProgress());
  handle('goal:setWeekly', (n) => store.setWeeklyGoal(n));
  handle('goal:celebrate', () => store.celebrateDailyGoalIfDue());

  handle('titles:translateBulk', (items) => store.translateTitlesBulk(items));
  handle('prefs:setTitleZh', (on) => {
    store.preferences.set('RobinRead.list.titleZh', on === true);
    store.sync?.notePrefsChanged(); // F7：titleZh 在漫游白名单内——变更须抬上行基准
    return on === true;
  });

  // MARK: 图片字节抓取（深色纸面插图反相的像素分析）
  handle('net:fetchImage', (url) => store.fetchImageBytes(url));

  // 分享卡片封面：抓取后降采样（原图最大 3MB，直接内嵌会让导出慢、渲染内存高）
  handle('net:fetchCardCover', async (url) => {
    const base64 = await store.fetchImageBytes(url);
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    if (image.isEmpty()) throw new Error('封面图片无效');
    const { width } = image.getSize();
    let out = image;
    if (width > 1400) out = image.resize({ width: 1400 });
    const jpeg = out.toJPEG(82);
    return (jpeg.length > 0 ? jpeg : image.toPNG()).toString('base64');
  });

  // MARK: 账户
  handle('accounts:addFreshRSS', (payload) => store.addFreshRSSAccount(payload));
  handle('accounts:validate', ({ endpointURL, username, password }) => store.validateFreshRSSCredentials(endpointURL, username, password));
  handle('accounts:remove', (accountID) => store.removeAccount(accountID));
  handle('accounts:setEnabled', (accountID, isEnabled) => store.setAccountEnabled(accountID, isEnabled));
  handle('accounts:sync', (accountID) => store.syncFreshRSS(accountID, { origin: 'manual' }));

  // MARK: AI
  handle('ai:generateSummary', (entryID) => store.generateSummary(entryID));
  handle('ai:clusterBrief', (items) => store.generateClusterBrief(items));
  handle('app:exportEpub', (entryID) => store.exportEntryEpub(entryID));
  handle('app:exportEditionEpub', (entryIDs) => store.exportEditionEpub(entryIDs));
  handle('app:exportHtml', (entryID) => store.exportEntryHtml(entryID));
  handle('ai:deepRead', (entryID) => store.deepRead(entryID));
  handle('ai:richSummary', (entryID) => store.richSummary(entryID));
  handle('ai:existingWork', (entryID, kind) => store.existingArticleWork(entryID, kind));
  handle('ai:explain', (payload) => store.explainSelection({ ...payload, onDelta: (delta) => send('ai:selection-delta', { requestID: payload.requestID, delta }) }));
  handle('ai:ask', (payload) => store.askSelection({ ...payload, onDelta: (delta) => send('ai:selection-delta', { requestID: payload.requestID, delta }) }));
  handle('ai:translateSelection', (payload) => store.translateSelection({ ...payload, onDelta: (delta) => send('ai:selection-delta', { requestID: payload.requestID, delta }) }));
  handle('ai:translateParagraphs', (entryID, html, paragraphIDs) => store.translateBilingualParagraphs({ entryID, html, paragraphIDs }));
  handle('ai:cachedBilingual', (entryID, html) => store.cachedBilingual(entryID, html));
  handle('ai:annotations', (entryID) => store.selectionAnnotations(entryID));
  handle('ai:cancel', (key) => store.cancelAI(key));
  handle('ai:test', () => store.testAIConnection());

  // MARK: 偏好
  handle('prefs:setTheme', (theme) => {
    if (['light', 'dark'].includes(theme)) nativeTheme.themeSource = theme;
    else nativeTheme.themeSource = 'system';
    store.setAppTheme(theme);
  });
  handle('prefs:setFontSize', (size) => store.setArticleFontSize(size));
  handle('prefs:setLanguage', (language) => store.setAppLanguage(language));
  handle('prefs:setRefreshInterval', (raw) => store.setRefreshInterval(raw));
  handle('prefs:setRefreshOnLaunch', (enabled) => store.setRefreshOnLaunch(enabled));
  handle('prefs:setLLM', (patch) => store.setLLMConfiguration(patch));
  handle('ai:persona', () => store.aiPersona());
  handle('ai:setPersona', (patch) => store.setAIPersona(patch || {}));
  handle('ai:personas', () => store.aiPersonaList());

  // MARK: 高品质朗读（神经语音 / 自定义 TTS）
  handle('tts:neuralVoices', () => NEURAL_VOICES);
  handle('tts:getConfig', () => store.ttsConfig());
  handle('tts:setConfig', (patch) => store.setTTSConfig(patch || {}));
  handle('tts:synthesize', async (payload) => {
    neuralTTS = neuralTTS || new NeuralTTSService(app.getPath('userData'));
    const buffer = await neuralTTS.synthesize({
      ...(payload || {}),
      custom: store.ttsCustomCredentials(),
    });
    return buffer.toString('base64');
  });
  handle('prefs:setAPIKey', (key) => store.setAIAPIKey(key));
  handle('llm:providers', () => store.providersSnapshot());
  handle('llm:addProvider', (payload) => store.addProvider(payload || {}));
  handle('llm:updateProvider', (id, patch) => store.updateProvider(id, patch || {}));
  handle('llm:removeProvider', (id) => store.removeProvider(id));
  handle('llm:setActive', (id) => store.setActiveProvider(id));
  handle('prefs:setColumnWidths', (payload) => store.setColumnWidths(payload));
  handle('prefs:setThemeTokens', (tokens) => {
    store.preferences.set('RobinRead.customTheme', tokens);
  });
  handle('prefs:clearThemeTokens', () => {
    store.preferences.remove('RobinRead.customTheme');
  });

  // MARK: 更新
  handle('update:check', async () => checkForUpdate(store.preferences.get('RobinRead.ignoredVersion', null)));
  handle('update:ignoreVersion', (version) => {
    store.preferences.set('RobinRead.ignoredVersion', version);
  });
  // 应用内更新：下载 GitHub release 的 setup.exe（进度推 update:progress），随后 /S 静默重装
  // P0-1：release 带 sha256（asset 级或 release 级）时下载后强制完整性校验
  handle('update:download', async () => {
    updater = updater || new UpdaterService(app.getPath('userData'));
    const result = await checkForUpdate(store.preferences.get('RobinRead.ignoredVersion', null));
    const assetURL = updater.resolveSetupAssetURL(result?.release);
    if (!assetURL) throw new Error('更新源未提供安装包直链，请到 GitHub Releases 页下载');
    const tag = String(result.release.tagName || '').replace(/^v/i, '');
    const fileName = `RobinRead-${tag}-setup.exe`;
    const expectedSHA256 = updater.resolveSetupAssetSHA256(result?.release, fileName);
    const push = (p) => { try { if (!window.isDestroyed()) window.webContents.send('update:progress', p); } catch (_) { /* 窗口已关 */ } };
    return await updater.download(assetURL, fileName, push, (url, opts) => net.fetch(url, opts), expectedSHA256);
  });
  handle('update:install', () => {
    if (!updater) throw new Error('尚未下载更新包');
    return updater.install();
  });
  // P2-8：下载中途取消（中止 fetch、销毁读写流、清理半成品）
  handle('updater:cancel', () => (updater ? updater.cancel() : false));

  // MARK: 无边框窗口控制
  ipcMain.on('window:minimize', () => window.minimize());
  ipcMain.on('window:maximize', () => {
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  // MARK: 关闭到托盘
  // 偏好 RobinRead.closeToTray（默认 false）开启时：窗口按钮的关闭 → hide；
  // 系统级关闭（Alt+F4 / 任务栏关闭）经 close 事件拦截同样 hide。
  // 显式退出（托盘菜单退出 / 备份恢复重启）先 markAppQuitting 置位绕过拦截。
  const closeToTrayEnabled = () => store.preferences.get('RobinRead.closeToTray', false) === true;
  ipcMain.on('window:close', () => {
    if (closeToTrayEnabled()) window.hide();
    else window.close();
  });
  window.on('close', (event) => {
    if (!appQuitting && closeToTrayEnabled()) {
      event.preventDefault();
      window.hide();
    }
  });
  handle('window:isMaximized', () => window.isMaximized());
  const sendMaxState = () => {
    if (!window.isDestroyed()) window.webContents.send('window:maximized-changed', window.isMaximized());
  };
  window.on('maximize', sendMaxState);
  window.on('unmaximize', sendMaxState);


  // MARK: 知识引擎（高亮/笔记/复习/标签/统计/收藏/连接/导出）
  const K = () => store.knowledge;
  handle('kb:highlights', (itemID) => K().getHighlights(itemID));
  handle('kb:allHighlights', () => K().getAllHighlights(200));
  handle('kb:addHighlight', (payload) => K().addHighlight(payload));
  handle('kb:removeHighlight', (id) => K().removeHighlight(id));
  handle('kb:updateHighlight', (id, patch) => K().updateHighlight(id, patch));
  handle('kb:notes', (itemID) => itemID ? K().getNotes(itemID) : K().getAllNotes());
  handle('kb:addNote', (payload) => K().addNote(payload));
  handle('kb:updateNote', (id, patch) => K().updateNote(id, patch));
  handle('kb:deleteNote', (id) => K().deleteNote(id));
  handle('kb:dueReviews', () => K().getDueReviews());
  handle('kb:review', (id, quality) => K().reviewCard(id, quality));
  handle('kb:addToReview', (payload) => K().addToReview(payload));
  handle('kb:removeFromReview', (id) => K().removeFromReview(id));
  handle('kb:tags', (itemID) => itemID ? K().getItemTags(itemID) : K().getTags());
  handle('kb:tagsSource', () => K().getTagsWithSource()); // F15：标签×来源计数（复核过滤 chips）
  handle('kb:entriesForTag', (tag, limit) => K().entriesForTag(tag, limit));
  handle('kb:addTag', (itemID, tag) => K().addManualTag(itemID, tag));
  handle('kb:removeTag', (itemID, tag) => K().removeTag(itemID, tag));
  handle('kb:stats', (days) => K().getStats(days || 30));
  handle('kb:wrapped', () => K().wrapped()); // U25 阅读年报：本年统计聚合（只读）
  handle('kb:collections', () => K().listCollections());
  handle('kb:createCollection', (name, desc) => K().createCollection(name, desc));
  handle('kb:updateCollection', (id, patch) => K().updateCollection(id, patch || {}));
  handle('kb:collectionItems', (colID) => K().getCollectionItems(colID));
  handle('kb:addToCollection', (colID, itemID) => K().addToCollection(colID, itemID));
  handle('kb:removeFromCollection', (colID, itemID) => K().removeFromCollection(colID, itemID));
  handle('kb:deleteCollection', (id) => K().deleteCollection(id));
  handle('kb:smartFolders', () => K().listSmartFolders());
  handle('kb:createSmartFolder', (name, query) => K().createSmartFolder(name, query));
  handle('kb:deleteSmartFolder', (id) => K().deleteSmartFolder(id));
  handle('kb:related', (itemID) => K().findRelated(itemID));
  handle('kb:exportMarkdown', (itemID) => K().exportToMarkdown(itemID));
  handle('kb:exportNotes', () => K().exportAllNotes());
  handle('kb:dailyReview', (dateStr) => K().dailyReview(dateStr));
  handle('kb:exportAnki', () => K().exportAnki());
  handle('kb:searchKnowledge', (query, options) => K().searchKnowledge(query, options || {}));
  handle('kb:heatmap', (days) => K().readingHeatmap(days || 90));
  handle('kb:statsExtras', () => K().statsExtras());
  handle('stats:getGoal', () => store.dailyGoal());
  handle('stats:setGoal', (n) => store.setDailyGoal(n));
  handle('kb:graph', (limit) => K().getGraphData(limit));
  handle('kb:ask', (question) => store.knowledgeAsk(question, { onDelta: (delta) => send('ai:delta', { key: 'kb:ask', delta }) }));
  handle('kb:dashboard', () => K().dashboard());
  handle('kb:exportJSON', () => K().exportJSON());
  handle('kb:exportHTML', () => K().exportHTML());
  handle('kb:refreshLinks', (noteID) => K().refreshNoteLinks(noteID));
  handle('kb:backlinks', (noteID) => K().backlinks(noteID));

  // MARK: 自进化引擎（源健康/行为/画像/反馈/推荐/诊断/密度）
  const E = () => store.evolution;
  handle('evo:health', () => E().healthSnapshot());
  handle('evo:deadFeeds', () => E().deadFeeds());
  handle('evo:profile', () => E().interestProfile());
  handle('evo:recommend', (limit) => E().recommendArticles(limit || 8));
  handle('evo:feedback', (payload) => E().recordFeedback(payload));
  handle('evo:feedbackSummary', () => E().feedbackSummary());
  handle('evo:diagnose', () => E().diagnose());
  handle('evo:densityByFeed', (days) => E().densityByFeed(days || 14));
  handle('evo:densityByDay', (days) => E().densityByDay(days || 14));

  // MARK: 信息维度
  handle('app:fullTextSearch', (query, options) => store.fullTextSearch(query, options || {}));

  // MARK: AIHOT（热点榜 / 故事时间线 / 精选 / 日报 / 本地状态 / AI 深读）
  handle('aihot:hotTopics', () => store.aihot.hotTopics());
  handle('aihot:story', (publicId) => store.aihot.story(publicId));
  handle('aihot:selected', (limit) => store.aihot.selected(limit || 30));
  handle('aihot:daily', () => store.aihot.daily());
  handle('aihot:dailyIndex', (limit) => store.aihot.dailies(limit || 30));
  handle('aihot:dailyByDate', (date) => store.aihot.dailyByDate(date));
  handle('aihot:items', (opts) => store.aihot.items(opts || {}));
  handle('aihot:selectedPage', (opts) => store.aihot.selectedPage(opts || {}));
  handle('aihot:leaderboard', () => store.aihot.leaderboard());
  handle('aihot:extractURL', (url) => {
    // P2-7：与 extract:url 同款协议校验（原先这里放行任意字符串，file:// 等会被当 URL 抓取）
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('仅支持 http(s) 链接');
    return store.aihot.extractURL(String(url));
  });
  handle('aihot:snapshot', () => store.aihotSnapshot());
  handle('aihot:toggleFavorite', (item) => store.aihotToggleFavorite(item));
  handle('aihot:markRead', (ids) => store.aihotMarkRead(ids));
  handle('aihot:setKeywords', (kw) => store.aihotSetKeywords(kw));
  handle('aihot:deepRead', (payload) => store.aihotDeepRead(payload));

  // MARK: 商店健康 + AI 探索（订阅源发现）
  handle('store:health', () => store.healthByFeedURL());
  handle('explore:run', (payload) => store.explore.run(payload || {}));
  handle('explore:explain', (payload) => store.explore.explain(payload || {}));
  handle('explore:dismiss', (payload) => store.explore.dismiss(payload || {}));

  // MARK: 账号与会员（微信登录 / 会员状态 / 订单）
  const { AuthService } = require('./Account/AuthService');
  const auth = new AuthService({
    credentialStore: store.credentials,
    preferences: store.preferences,
    getMainWindow: () => window,
    onChange: (user) => send('account:changed', { user }),
  });
  // 订阅源数量门控（addFeed / importOPML 统一走这里，覆盖 OPML 导入与商店快捷订阅）
  store.accountGate = auth;
  handle('account:config', async () => ({ apiBase: auth.apiBase, ...(await auth.config()) }));
  handle('account:loginWechat', () => auth.loginWithWechat());
  handle('account:loginDev', (nickname) => auth.loginDev(nickname));
  handle('account:register', (username, password, nickname) => auth.register(username, password, nickname));
  handle('account:loginPassword', (username, password) => auth.loginWithPassword(username, password));
  handle('account:redeem', (code) => auth.redeem(code));
  handle('account:logout', () => auth.logout());
  handle('account:me', (force) => auth.me(!!force));
  handle('account:consumeAIQuota', () => auth.consumeAIQuota());
  handle('account:updateProfile', (patch) => auth.updateProfile(patch || {}));
  // 本地图片 → 居中方形裁剪 → 128px 缩放 → PNG（过大转 JPEG）→ data URL
  handle('account:pickAvatar', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '选择头像图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const image = nativeImage.createFromPath(result.filePaths[0]);
    if (image.isEmpty()) throw new Error('无法读取该图片，请换一张试试');
    const { width, height } = image.getSize();
    const side = Math.min(width, height);
    const square = image.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
    const resized = square.resize({ width: 128, height: 128, quality: 'good' });
    const png = resized.toPNG();
    if (png.length <= 96 * 1024) return `data:image/png;base64,${png.toString('base64')}`;
    return `data:image/jpeg;base64,${resized.toJPEG(85).toString('base64')}`;
  });
  handle('pay:createOrder', (plan) => auth.createOrder(plan));
  handle('pay:queryOrder', (outTradeNo) => auth.queryOrder(outTradeNo));

  // MARK: 渲染进程文章内链接（阅读器 iframe 内点击）
  ipcMain.on('reader:openLink', (_event, url) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // 剪贴板兜底：页面侧 navigator.clipboard 在窗口失焦/隐藏时会失败，走主进程必成
  handle('app:copyText', (text) => { clipboard.writeText(String(text ?? '')); return true; });

  // MARK: 导出（另存为对话框 + 同步写文本文件；canceled / 异常由 handle 统一包装）
  // 返回的路径同时登记为一次性写许可（P2-11）：随后的 write*File 只认这个路径或 userData 子目录。
  handle('app:pickSavePath', async ({ defaultName } = {}) => {
    const result = await dialog.showSaveDialog(window, {
      title: '导出文章',
      defaultPath: defaultName || 'export.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return null;
    registerSavedPath(result.filePath);
    return result.filePath;
  });
  handle('app:writeTextFile', ({ filePath, content } = {}) => {
    assertWritablePath(filePath);
    fs.writeFileSync(filePath, String(content ?? ''), 'utf8');
    consumeSavedPath(filePath);
    return true;
  });
  handle('app:writeBinaryFile', ({ filePath, base64 } = {}) => {
    assertWritablePath(filePath);
    fs.writeFileSync(filePath, Buffer.from(String(base64 ?? ''), 'base64'));
    consumeSavedPath(filePath);
    return true;
  });
  // 分享卡片图：复制 PNG 到剪贴板（renderer 端 clipboard 失焦会失败，必须走主进程）
  handle('app:copyImage', ({ base64 } = {}) => {
    const image = nativeImage.createFromBuffer(Buffer.from(String(base64 ?? ''), 'base64'));
    if (image.isEmpty()) throw new Error('图片数据无效');
    clipboard.writeImage(image);
    return true;
  });

  // 期刊当前页导出（R13）：主进程按 DIP 矩形截取窗口区域，返回 PNG base64
  // P1-1：原先误用未定义的 win（本作用域参数名是 window）→ 通道 100% ReferenceError。
  // R114：渲染层传的是 CSS 像素矩形，应用级 zoom ≠ 1 时与 DIP 矩形错位——
  // 用户实见「导出的不是当前界面」（边缘带入邻页内容）。按 zoomFactor 换算后再截。
  handle('app:captureRect', async (rect) => {
    if (!window || window.isDestroyed()) throw new Error('主窗口不可用，无法截图');
    const z = window.webContents.getZoomFactor() || 1;
    const image = await window.capturePage({
      x: Math.max(0, Math.round((Number(rect?.x) || 0) * z)),
      y: Math.max(0, Math.round((Number(rect?.y) || 0) * z)),
      width: Math.max(1, Math.round((Number(rect?.width) || 1) * z)),
      height: Math.max(1, Math.round((Number(rect?.height) || 1) * z)),
    });
    return image.toPNG().toString('base64');
  });

  // MARK: 精读/摘要卡片导出 PNG（隐藏 offscreen 窗口 + 真 Chromium 渲染 + capturePage）
  let cardExportWin = null;
  let cardExportChain = Promise.resolve();
  const getCardExportWindow = () => {
    if (cardExportWin && !cardExportWin.isDestroyed()) return cardExportWin;
    cardExportWin = new BrowserWindow({
      show: false, width: 1500, height: 1000, useContentSize: true,
      webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    cardExportWin.on('closed', () => { cardExportWin = null; });
    return cardExportWin;
  };
  let templatesModule = null;
  const loadTemplatesModule = async () => {
    if (!templatesModule) {
      templatesModule = await import(pathToFileURL(path.join(__dirname, '../renderer/card-export/templates.js')).href);
    }
    return templatesModule;
  };
  let scenesModule = null;
  const loadScenesModule = async () => {
    if (!scenesModule) {
      scenesModule = await import(pathToFileURL(path.join(__dirname, '../renderer/card-export/scenes.js')).href);
    }
    return scenesModule;
  };
  handle('card:renderPng', (payload = {}) => {
    const { templateId, data, options, zoom = 2, ratio = null, format = 'png' } = payload || {};
    // 串行化：隐藏窗口同一时刻只渲染一张（排队执行，结果按序返回）

    const task = cardExportChain.catch(() => {}).then(() =>
      renderCardPngOnce({ templateId, data, options, zoom, ratio, format }));
    cardExportChain = task.catch(() => {});
    return task;
  });
  async function renderCardPngOnce({ templateId, data, options, zoom, ratio, format = 'png' }) {
    const { renderStagePage, CARD_WIDTH } = await loadTemplatesModule();
    const win = getCardExportWindow();
    const tmpPath = path.join(app.getPath('temp'), `robin-card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.html`);
    const settle = async (ms) => {
      await win.webContents.executeJavaScript('document.fonts.ready.then(()=>1)');
      await new Promise((r) => setTimeout(r, ms));
    };
    const load = async (page) => {
      fs.writeFileSync(tmpPath, page.html, 'utf8');
      await win.loadFile(tmpPath);
      await settle(260);
    };
    // 探针：卡尺寸/滚动高/填充 spacer 高/溢出探针底缘（相对画幅顶）
    const probe = async () => JSON.parse(await win.webContents.executeJavaScript(
      '(()=>{const c=document.querySelector(".xc-card");const s=document.querySelector(".xc-stage");if(!c||!s)return JSON.stringify({w:0,h:0,sh:0,ch:0,sp:0,bt:0});const sp=c.querySelector(".xc-fill-spacer");const pb=c.querySelector(".xc-overflow-probe");const r=c.getBoundingClientRect();const bt=pb?Math.ceil(pb.getBoundingClientRect().bottom-s.getBoundingClientRect().top):0;return JSON.stringify({w:Math.ceil(r.width),h:Math.ceil(r.height),sh:Math.ceil(c.scrollHeight),ch:Math.ceil(c.clientHeight),sp:sp?Math.ceil(sp.getBoundingClientRect().height):0,bt})})()'
    ));
    try {
      // R-D8 场景排版 v2（比例合同）：基准宽测自然高 → 超比例等比放大重排（≤3 轮）→ 锁定比例画幅弹性填满。零截断。
      if (ratio && options.sceneId) {
        const scenes = await loadScenesModule();
        if (scenes.sceneLayout(options.sceneId)) {
          const { variantFilter } = await loadTemplatesModule();
          const vf = variantFilter(options.variant);
          const sceneOpts = () => ({ ...options, sceneId: options.sceneId, tplId: templateId || options.templateId, variantFilterCss: vf !== 'none' ? `filter:${vf};` : '' });
          const measureNat = async (W) => {
            const pg = scenes.renderScenePage(data, { ...sceneOpts(), width: W }, zoom); // height 缺省 = auto
            await load(pg);
            return JSON.parse(await win.webContents.executeJavaScript(
              '(()=>{const c=document.querySelector(".sp-card");return JSON.stringify({h:c?Math.ceil(c.getBoundingClientRect().height):0})})()'
            )).h;
          };
          const SCENE_BOX = { '1:1': [750, 1], '3:4': [750, 4 / 3], '9:16': [750, 16 / 9], '4:3': [1000, 3 / 4], '16:9': [1333, 9 / 16], '2.35:1': [1763, 1 / 2.35] };
          let [W, R] = SCENE_BOX[options.sceneId] || [750, 1];
          for (let round = 0; round < 4; round++) {
            const Hn = await measureNat(W);
            if (Hn <= W * R + 4) break;
            W = Math.max(W + 60, Math.ceil((Hn + 8) / R)); // 内容超比例 → 放大画布重排
          }
          const page = scenes.renderScenePage(data, { ...sceneOpts(), width: W, height: Math.round(W * R) }, zoom);
          await load(page);
          win.setContentSize(page.width, page.height);
          win.setBackgroundColor(page.bg);
          await new Promise((r) => setTimeout(r, 150));
          const imgS = await win.webContents.capturePage();
          const pngS = format === 'jpeg' ? imgS.toJPEG(92) : imgS.toPNG();
          if (pngS.length < 1000) throw new Error('卡片渲染结果为空');
          return { base64: pngS.toString('base64'), width: page.width, height: page.height, truncated: false, format: format === 'jpeg' ? 'jpeg' : 'png' };
        }
      }
      if (!ratio) {
        const page = renderStagePage(data, options, { zoom });
        await load(page);
        const rect = await probe();
        const height = Math.min(rect.h, 16000);
        win.setContentSize(rect.w || Math.round(750 * zoom), height);
        win.setBackgroundColor(page.bg);
        await new Promise((r) => setTimeout(r, 140));
        const image = await win.webContents.capturePage();
        const isJpeg = format === 'jpeg';
        const png = isJpeg ? image.toJPEG(92) : image.toPNG();
        if (png.length < 1000) throw new Error('卡片渲染结果为空');
        return { base64: png.toString('base64'), width: rect.w, height, truncated: rect.h > 16000, format: isJpeg ? 'jpeg' : 'png' };
      }
      // ── 固定画幅 fit-to-fill：画幅是硬约束，内容自适应铺满；内容完整优先于铺满 ──
      const landscape = ratio < 1;
      const stageW = landscape ? Math.round(CARD_WIDTH / ratio) : CARD_WIDTH;
      const boxH = Math.round(stageW * ratio);
      // pass1：自然内容高（横版=满宽重排渲染高 ÷ (满宽比 × 页 zoom)；竖版=流式卡高/zoom）
      let page = renderStagePage(data, options, { zoom, ratio });
      await load(page);
      const natRect = await probe();
      const natH = landscape
        ? Math.round(natRect.h / ((stageW / CARD_WIDTH) * zoom))
        : Math.round(natRect.h / zoom);
      let fill = null;
      let finalZoom;
      if (natH > 0 && natH < boxH * 0.965) {
        // 内容不足 → 填充迭代：间距/行距/头图放大 + spacer 吃余量，至 spacer ≤ 3% 或溢出回退
        let s = Math.min(1.8, boxH / Math.max(1, natH));
        for (let i = 0; i < 3; i++) {
          page = renderStagePage(data, options, { zoom, ratio, fill: { scale: s } });
          await load(page);
          const m = await probe();
          if (m.sh > m.ch + 2) { s = Math.max(1.001, s * (boxH / m.sh)); continue; } // 溢出回退
          if (m.sp > boxH * 0.03) { s = Math.min(1.8, s * (1 + (m.sp / boxH) * 0.9)); continue; } // 仍不足加大
          break;
        }
        fill = { scale: s };
      } else if (natH > boxH * 1.02) {
        // 内容超出 → 锁高双栏密排分级密度（d1 间距/行距/头图收紧 → d2 再收字号/段距/头图）
        // 仍超 → 多栏铺满（直排模板：内容按画幅高切栏，字号保持）；4 栏仍超 → 整卡等比 contain 兜底
        const measureCompact = async (density) => {
          page = renderStagePage(data, options, { zoom, ratio, fill: { compact: true, density } });
          await load(page);
          const m = await probe();
          return Math.max(m.bt || 0, m.sh || 0, 1);
        };
        const H1 = await measureCompact(1);
        if (H1 > boxH + 2) {
          const H2 = await measureCompact(2);
          if (H2 > boxH + 2) {
            const est = Math.min(6, Math.max(2, Math.ceil(H2 / boxH)));
            const Hmax = Math.round(boxH * 0.42);
            // 双杠杆 ladder（heroH 大杠杆 → 字号/间距 Z）：
            // 每档用 auto+balance 渲染测「每栏均衡高 colH」，选 colH≈画幅高（填满）的档，再锁高正式渲染
            const ladder = [
              { boost: 1, heroH: 170 },
              { boost: 1, heroH: Math.round(Hmax * 0.6) },
              { boost: 1, heroH: Hmax },
              { boost: 1.18, heroH: Hmax },
              { boost: 1.32, heroH: Hmax },
            ];
            let colOk = false;
            let chosen = null;
            let colH = Infinity;
            for (const step of ladder) {
              page = renderStagePage(data, options, { zoom, ratio, fill: { compact: true, density: 2, cols: est, ...step, auto: true } });
              await load(page);
              const m = await probe();
              colH = m.sh || 0; // balance 模式下容器高 = 每栏均衡高
              chosen = { ...step };
              if (colH <= boxH * 1.03) break; // 该档已能装下
            }
            if (colH <= boxH * 1.03) {
              fill = { compact: true, density: 2, cols: est, boost: chosen.boost, heroH: chosen.heroH };
              colOk = true;
            }
            if (!colOk) {
              // 画幅硬合同：6 栏密排仍装不下 → 整卡等比 contain 缩进精确画幅（内容完整、输出严格 = 所选画幅，永不回落长图）
              const containZoom = Math.min(1, (boxH * 0.995) / Math.max(1, H2));
              page = renderStagePage(data, options, { zoom, ratio, fill: { compact: true, density: 2, auto: true }, finalZoom: containZoom });
              await load(page);
              win.setContentSize(page.width, page.height);
              win.setBackgroundColor(page.bg);
              await new Promise((r) => setTimeout(r, 150));
              const img = await win.webContents.capturePage();
              const pngC = format === 'jpeg' ? img.toJPEG(92) : img.toPNG();
              if (pngC.length < 1000) throw new Error('卡片渲染结果为空');
              return { base64: pngC.toString('base64'), width: page.width, height: page.height, truncated: false, format: format === 'jpeg' ? 'jpeg' : 'png' };
            }
          }
          if (!fill || !fill.cols) fill = { compact: true, density: 2 };
        } else { fill = { compact: true, density: 1 }; }
      }
      // 最终渲染：auto 布局（全内容参与布局，永不锁高裁切）+ 单次缩放进画幅；多栏时锁高（分栏需定高）
      const finalFill = (fill && fill.compact) ? { ...fill, auto: !fill.cols } : fill;
      page = renderStagePage(data, options, { zoom, ratio, fill: finalFill, finalZoom });
      await load(page);
      const W = page.width, H = page.height;
      win.setContentSize(W, H);
      win.setBackgroundColor(page.bg);
      await new Promise((r) => setTimeout(r, 150));
      const image = await win.webContents.capturePage();
      const isJpeg = format === 'jpeg';
      const png = isJpeg ? image.toJPEG(92) : image.toPNG();
      if (png.length < 1000) throw new Error('卡片渲染结果为空');
      return { base64: png.toString('base64'), width: W, height: H, truncated: false, format: isJpeg ? 'jpeg' : 'png' };
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* 临时文件清理失败可忽略 */ }
    }
  }

  // MARK: 桌面通用偏好（关闭到托盘 / 新文章通知 / 微交互音效）
  handle('prefs:getGeneral', () => ({
    closeToTray: store.preferences.get('RobinRead.closeToTray', false) === true,
    newArticleNotify: store.preferences.get('RobinRead.newArticleNotify', true) !== false,
    sfxEnabled: store.preferences.get('RobinRead.sfx.enabled', false) === true, // U27：默认关
  }));
  // 批量导出：当前卡片一次渲染全部模板，打包 ZIP
  handle('card:renderAllTemplates', async ({ data, options, zoom, ratio }) => {
    const mod = await loadTemplatesModule();
    const out = [];
    for (const tpl of mod.CARD_TEMPLATES) {
      const png = await renderCardPngOnce({ templateId: tpl.id, data, options: { ...options, templateId: tpl.id }, zoom, ratio });
      out.push({ name: `RobinRead-card-${tpl.id}.png`, base64: png.base64 });
    }
    const { buildZip } = require('./EpubBuilder');
    const zip = buildZip(out.map((r) => ({ name: r.name, data: Buffer.from(r.base64, 'base64') })), Date.now());
    return { base64: zip.toString('base64'), count: out.length };
  });
  handle('prefs:setGeneral', (patch) => {
    const p = patch || {};
    if (typeof p.closeToTray === 'boolean') store.preferences.set('RobinRead.closeToTray', p.closeToTray);
    if (typeof p.newArticleNotify === 'boolean') store.preferences.set('RobinRead.newArticleNotify', p.newArticleNotify);
    if (typeof p.sfxEnabled === 'boolean') store.preferences.set('RobinRead.sfx.enabled', p.sfxEnabled); // U27
    return {
      closeToTray: store.preferences.get('RobinRead.closeToTray', false) === true,
      newArticleNotify: store.preferences.get('RobinRead.newArticleNotify', true) !== false,
      sfxEnabled: store.preferences.get('RobinRead.sfx.enabled', false) === true,
    };
  });

  // MARK: 开机自启（无参读取 / 带参写入；dev 下 supported=false 并提示仅打包版可用）
  handle('app:loginItem', (enabled) => {
    if (enabled == null) return loginItemState();
    return setLoginItemEnabled(enabled);
  });

  // MARK: 备份与恢复（单文件 JSON：VACUUM INTO 快照 + 偏好）
// MARK: - 自动备份（数据安全）：每日一次全量快照到 userData/backups，滚动保留
const AUTO_BACKUP_DIR = () => path.join(app.getPath('userData'), 'backups');
const AUTO_BACKUP_KEEP_KEY = 'RobinRead.autoBackup.keep';

function autoBackupKeep() {
  // R98：默认 7→3——全量快照按库体积倍增（用户实况 1.3GB 库 × 7 份 = 9.4GB 磁盘黑洞，
  // 升级首启风暴的帮凶）；显式设置过的用户不受影响
  const v = Number(store.preferences.get(AUTO_BACKUP_KEEP_KEY, 3));
  return [3, 7, 14, 30].includes(v) ? v : 3;
}

function autoBackupEnabled() {
  return store.preferences.get('RobinRead.autoBackup.enabled', true) !== false;
}

function autoBackupDue() {
  try {
    const dir = AUTO_BACKUP_DIR();
    // 只认完整 .json 成品——中途被杀留下的 .tmp.db 快照不算备份（曾导致当天永不重试）
    const files = fs.readdirSync(dir).filter((f) => /^RobinRead-auto-backup-\d{8}\.json$/.test(f));
    if (files.length === 0) return true;
    const latest = files.sort().at(-1);
    const stamp = latest.match(/(\d{8})/);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return !stamp || stamp[1] !== today;
  } catch (_) {
    return true;
  }
}

/** 清掉历史失败备份留下的临时快照（进程被杀时 finally 清理不会执行，会无限堆积）。 */
function purgeStaleBackupTmps() {
  try {
    const dir = AUTO_BACKUP_DIR();
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.tmp.db')) {
        try { fs.rmSync(path.join(dir, f), { force: true }); } catch (_) { /* 尽力而为 */ }
      }
    }
  } catch (_) { /* 目录不存在等 */ }
}

/** 每日自动备份：到期才写；写完按保留份数滚动删除。返回备份路径，未到期返回 null。 */
async function autoBackupIfDue(force = false) {
  purgeStaleBackupTmps();
  if (!autoBackupEnabled() && !force) return null;
  if (!force && !autoBackupDue()) return null;
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dir = AUTO_BACKUP_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `RobinRead-auto-backup-${stamp}.json`);
  if (!force && fs.existsSync(filePath)) return null; // 当日已有自动备份：非强制直接跳过
  await backupExportTo(store, filePath);
  pruneAutoBackups(dir);
  return filePath;
}

function pruneAutoBackups(dir) {
  try {
    const keep = autoBackupKeep();
    const files = fs.readdirSync(dir)
      .filter((f) => /^RobinRead-auto-backup-\d{8}\.json$/.test(f))
      .sort()
      .reverse();
    for (const f of files.slice(keep)) fs.rmSync(path.join(dir, f), { force: true });
    // R98 总量闸：份数之外再守磁盘——按新到旧累计，超过 4GB 即删最老（至少留 1 份）。
    // 大库全量快照按库体积倍增，仅份数滚动守不住磁盘（用户实况 9.4GB 累积）。
    const kept = files.slice(0, keep);
    let total = 0;
    const sizes = [];
    for (const f of kept) {
      try {
        const s = fs.statSync(path.join(dir, f)).size;
        sizes.push([f, s]);
        total += s;
      } catch (_) { /* 刚被并发删除等 */ }
    }
    for (let i = sizes.length - 1; i >= 0 && total > 4 * 1024 * 1024 * 1024 && sizes.length > 1; i -= 1) {
      total -= sizes[i][1];
      try { fs.rmSync(path.join(dir, sizes[i][0]), { force: true }); } catch (_) { /* 尽力而为 */ }
      sizes.pop();
    }
  } catch (_) { /* 忽略 */ }
}


  // 自动备份：启动 20 秒后首查；应用常开时每 6 小时复查（跨天补备）
  setTimeout(() => { autoBackupIfDue().catch(() => {}); }, 20_000).unref();
  setInterval(() => { autoBackupIfDue().catch(() => {}); }, 6 * 3600 * 1000).unref();

  handle('backup:autoNow', async () => await autoBackupIfDue(true));
  handle('backup:getConfig', () => ({
    enabled: autoBackupEnabled(),
    keep: autoBackupKeep(),
    dir: AUTO_BACKUP_DIR(),
  }));
  handle('backup:setConfig', ({ enabled, keep } = {}) => {
    if (typeof enabled === 'boolean') store.preferences.set('RobinRead.autoBackup.enabled', enabled);
    if ([3, 7, 14, 30].includes(Number(keep))) store.preferences.set(AUTO_BACKUP_KEEP_KEY, Number(keep));
    return { enabled: autoBackupEnabled(), keep: autoBackupKeep(), dir: AUTO_BACKUP_DIR() };
  });
  handle('backup:openFolder', () => { shell.openPath(AUTO_BACKUP_DIR()); });

  handle('backup:export', async () => {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const result = await dialog.showSaveDialog(window, {
      title: '导出备份',
      defaultPath: `RobinRead-backup-${stamp}.json`,
      filters: [{ name: 'RobinRead 备份', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return backupExportTo(store, result.filePath);
  });
  handle('backup:import', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '导入备份',
      filters: [{ name: 'RobinRead 备份', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return backupImportFrom(result.filePaths[0]);
  });
  // 渲染层 alertBox（「将重启应用完成恢复」）确认后调用：优雅关闭 → relaunch
  ipcMain.on('backup:relaunch', () => {
    try {
      store.preferences.flushSync();
      store.database.close();
    } catch (_) { /* 关闭失败也继续重启 */ }
    markAppQuitting();
    app.relaunch();
    app.exit(0);
  });

  // MARK: 存储管理（体积统计 / 立即清理 / 打开数据目录）
  handle('storage:stats', () => storageStatsFor(store));
  handle('storage:cleanup', () => cleanupStorage(store));
  handle('storage:openDataDir', async () => shell.openPath(app.getPath('userData')));
}

module.exports = {
  registerIPCHandlers,
  createMainWindow,
  registerNetworkInterceptors,
  resolveIcon,
  markAppQuitting,
  isAppQuitting,
  loginItemState,
  setLoginItemEnabled,
  backupExportTo,
  backupImportFrom,
  storageStatsFor,
  cleanupStorage,
  notificationBridge,
  registerSavedPath,
  assertWritablePath,
  consumeSavedPath,
};
