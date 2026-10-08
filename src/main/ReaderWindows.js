'use strict';
/**
 * RobinRead（知更）— 多窗并读管理（F17）
 *
 * 独立阅读窗口（每篇文章一个 BrowserWindow）：
 * - 同一 entryID 已开窗 → 聚焦既有窗口（每文章一个窗口上限）；
 * - 全局并发上限 4 个（每窗口独立 webContents，超出给明确提示）；
 * - 渲染层加载 reader-window.html?entry=<entryID>（同 preload / 同 CSP / 同 sandbox），
 *   数据经同一 IPC 通路 getReader(entryID)——同一 DB 天然一致；
 * - 主窗口关闭 → 全部弹出窗级联关闭（closeAll 由 main.js 挂在主窗 close 事件）；
 *   app quit 路径 BrowserWindow 随进程销毁，无需额外处理；
 * - 窗口标题 = 文章标题；尺寸 720×900 可调、位置/尺寸记忆（屏幕外治理同主窗）。
 */
const path = require('node:path');
const { BrowserWindow } = require('electron');
const { i18n } = require('./I18N');

/** 并发上限：每窗口独立 webContents（渲染进程内存 ~几十 MB/个），4 个是体验与内存的平衡点。 */
const MAX_READER_WINDOWS = 4;

/** 位置记忆偏好键（与主窗 windowBounds 同库不同键）。 */
const BOUNDS_KEY = 'RobinRead.readerWindowBounds';

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

class ReaderWindowManager {
  constructor() {
    /** entryID -> BrowserWindow（同 entryID 去重 + 级联关闭遍历） */
    this.windows = new Map();
    /** 探针可注入（创建窗参数不变、只换实现）；默认真实 BrowserWindow。 */
    this._windowFactory = (options) => new BrowserWindow(options);
  }

  /** 当前存活弹出窗数量。 */
  count() {
    this._sweep();
    return this.windows.size;
  }

  /** 存活窗口元信息（探针断言用）。 */
  list() {
    this._sweep();
    return [...this.windows.entries()].map(([entryID, win]) => ({
      entryID,
      windowId: win.webContents?.id ?? null,
      title: win.getTitle(),
    }));
  }

  /**
   * 打开（或聚焦）一篇文章的独立阅读窗口。
   * @returns {{created:boolean, focused:boolean, windowId:number|null}}
   * @throws 同文章已开窗聚焦时不抛；超过并发上限抛本地化错误（UI toast 回显）。
   */
  open(store, owner, entryID) {
    const id = String(entryID || '');
    if (!id) throw new Error(i18n.localized('缺少文章。'));
    this._sweep();

    // 每文章一个窗口：同 entryID 已开 → 聚焦既有窗口
    const existing = this.windows.get(id);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return { created: false, focused: true, windowId: existing.webContents.id };
    }

    if (this.windows.size >= MAX_READER_WINDOWS) {
      throw new Error(i18n.localized('最多同时打开 %lld 个独立阅读窗口。').replace('%lld', String(MAX_READER_WINDOWS)));
    }

    const entry = store.entry ? store.entry(id) : null;
    const title = entry?.title || i18n.localized('阅读');
    const bounds = this._savedBounds(store);
    const primary = require('electron').screen.getPrimaryDisplay().workArea;

    const win = this._windowFactory({
      width: bounds?.width || 720,
      height: bounds?.height || 900,
      x: bounds?.x ?? Math.round(primary.x + Math.max(0, (primary.width - 720) / 2)),
      y: bounds?.y ?? Math.round(primary.y + Math.max(0, (primary.height - 900) / 2)),
      minWidth: 480,
      minHeight: 620,
      show: false,
      title,
      backgroundColor: '#eae8e1',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'), // 与主窗口一致：同信封 / 同白名单 / sandbox 不破坏
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
      icon: require('./ipc').resolveIcon(),
    });

    // 窗口标题 = 文章标题（loadFile 不改标题；渲染层加载后同样回填 document.title 兜底）
    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(__dirname, '..', 'renderer', 'reader-window.html'), {
      query: { entry: id },
    });

    // 主题跟随：ipc.js 的 nativeTheme 推送只发主窗——弹出窗在此自挂同款监听
    // （加载完成后补发一次当前态；窗口销毁时退订，防监听器泄漏）
    const { nativeTheme } = require('electron');
    const pushTheme = () => {
      try {
        if (!win.isDestroyed()) win.webContents.send('theme:changed', { shouldUseDarkColors: nativeTheme.shouldUseDarkColors });
      } catch (_) { /* 已销毁 */ }
    };
    nativeTheme.on('updated', pushTheme);
    win.webContents.on('did-finish-load', pushTheme);
    win.on('closed', () => {
      try { nativeTheme.removeListener('updated', pushTheme); } catch (_) { /* 尽力而为 */ }
    });

    // 外链走系统浏览器；同窗导航防护与主窗口同口径（只放行应用 renderer 目录 file://）
    const { shell } = require('electron');
    const { pathToFileURL } = require('node:url');
    const appRendererDirPrefix = pathToFileURL(path.join(__dirname, '..', 'renderer') + path.sep).href;
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('devtools://') || url.startsWith('data:')) return;
      if (url.startsWith('file://') && url.startsWith(appRendererDirPrefix)) return;
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    });

    // 位置/尺寸记忆（防抖；close 时补一次最终值）
    const saveBounds = debounce(() => this._persistBounds(store, win), 500);
    win.on('resize', saveBounds);
    win.on('move', saveBounds);
    win.on('close', () => this._persistBounds(store, win));

    this.windows.set(id, win);
    win.on('closed', () => {
      if (this.windows.get(id) === win) this.windows.delete(id);
    });
    return { created: true, focused: false, windowId: win.webContents.id };
  }

  /** 主窗口关闭：级联关闭全部弹出窗（app quit 路径无需调用）。 */
  closeAll() {
    this._sweep();
    for (const win of this.windows.values()) {
      try { win.destroy(); } catch (_) { /* 已销毁 */ }
    }
    this.windows.clear();
  }

  /** 清理已销毁窗口的映射残留（closed 事件的兜底）。 */
  _sweep() {
    for (const [id, win] of this.windows) {
      try { if (win.isDestroyed()) this.windows.delete(id); } catch (_) { this.windows.delete(id); }
    }
  }

  /** 记忆的位置（屏幕外/越界治理与主窗同口径：丢弃，回退主屏居中）。 */
  _savedBounds(store) {
    try {
      const bounds = store.preferences.get(BOUNDS_KEY, null);
      if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return null;
      const { screen } = require('electron');
      const area = { x: bounds.x, y: bounds.y, width: bounds.width || 720, height: bounds.height || 900 };
      const display = screen.getDisplayMatching(area);
      const visible = bounds.x >= display.workArea.x - 8 && bounds.y >= display.workArea.y - 8
        && bounds.x < display.workArea.x + display.workArea.width
        && bounds.y < display.workArea.y + display.workArea.height;
      return visible ? bounds : null;
    } catch (_) {
      return null;
    }
  }

  _persistBounds(store, win) {
    try {
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      store.preferences.set(BOUNDS_KEY, win.getBounds());
    } catch (_) { /* 尽力而为 */ }
  }
}

/** 模块级单例：ipc.js 的 readerWindow:open 与 main.js 的级联共用同一张映射表。 */
module.exports = {
  ReaderWindowManager,
  MAX_READER_WINDOWS,
  readerWindows: new ReaderWindowManager(),
};
