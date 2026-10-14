'use strict';
/**
 * diag-r68-window.js — R68 窗口与布局三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 极窄窗（换题记档固化）：原题「<900px 侧栏降级」不成立——主窗 minWidth 980 + U26
 *    @media 1020px 三列视口钳制 + 侧栏手动折叠（按钮迁移）三重护栏在册；真实存在的极窄场景
 *    = 独立阅读窗（下限 480px）：minWidth/标题省略/版心收窄/阅读列 min-width:0 固化
 *  2 分栏把手双击重置默认宽：dblclick 清行内样式 + 变量归 240/340 出厂值 + 与拖拽同一
 *    持久化通路（commitColumnWidths 共用）；把手 title 可发现性（原空串 title 退役）
 *  3 全屏（禅模式）进出保持焦点与滚动位置：焦点随侧栏/列表蒸发时进入后落阅读区、
 *    退出归还进入前焦点；reader-scroll scrollTop 进出零位移
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r68-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

// bootstrap 第一 await = robin.getState()（app:state）——最小快照 mock 让 init 走完全套绑定；
// 拖拽/重置的持久化通道同样 mock（commitColumnWidths 不因离线拒决中断）。
ipcMain.handle('app:state', () => ({
  ok: true,
  data: {
    strings: {}, language: 'zh-CN', prefersDark: false,
    hasAPIKey: false, llm: {}, theme: null,
    preferences: { articleFontSize: 17, readerLayout: {}, feedTypography: {} },
  },
}));
ipcMain.handle('prefs:setColumnWidths', () => ({ ok: true, data: {} }));

app.whenReady().then(async () => {
  try {
    // ── Phase A：源码在册断言 ──────────────────────────────────────────────
    const appSrc = read('src/renderer/app.js');
    const robin = read('src/renderer/styles/robin.css');
    const ipcSrc = read('src/main/ipc.js');
    const rwSrc = read('src/main/ReaderWindows.js');
    const indexSrc = read('src/renderer/index.html');

    ok(/minWidth: 980,/.test(ipcSrc), '1 记档证据：主窗 minWidth 980 在册（<900px 主窗视口不可达）');
    ok(/@media \(max-width: 1020px\)\s*\{\s*\.column-sidebar\s*\{\s*flex: 0 1 auto; min-width: min\(240px, 24vw\);/.test(robin),
      '1 记档证据：U26 @media 1020px 三列视口钳制在册');
    ok(/function applySidebarCollapsed\(\)/.test(appSrc) && /sidebarButtons.*listZone|insertBefore\(b, listTitle/.test(appSrc),
      '1 记档证据：侧栏手动折叠 + 工具栏按钮迁移在册');
    ok(/minWidth: 480,/.test(rwSrc), '1 等价题证据：独立阅读窗下限 480px 在册');
    ok(/\.rw-title \{[^}]*text-overflow: ellipsis;/.test(robin) && /\.rw-reader \{[^}]*min-width: 0;/.test(robin),
      '1 等价题固化：阅读窗标题省略号 + 阅读列 min-width:0（480px 不溢出）');
    ok(/\.reader-article\s*\{[^}]*--article-gutter: min\(40px, 5vw\);[^}]*padding: 22px var\(--article-gutter\) 0;/s.test(robin),
      '1 等价题固化：版心内边距随视口收窄（槽令牌 min(40px,5vw)；R94-② 顶槽 32→22）');

    ok(/const SIDEBAR_DEFAULT_WIDTH = 240;/s.test(appSrc) && /const LIST_DEFAULT_WIDTH = 340;/.test(appSrc),
      '2 出厂宽度常量 240/340 在册');
    ok(/splitter\.addEventListener\('dblclick'/.test(appSrc), '2 把手 dblclick 重置在册');
    ok(/function commitColumnWidths\(\)/.test(appSrc) && appSrc.split('commitColumnWidths();').length >= 3,
      '2 拖拽结束/双击重置共用持久化收口（commitColumnWidths ≥2 消费）');
    ok(/splitter\.title = t\('拖拽调整栏宽，双击恢复默认'\);/.test(appSrc), '2 把手 title 可发现性在册');
    ok(!/id="splitter-sidebar" title=""/.test(indexSrc), '2 原空串 title 退役（JS 侧 i18n 下发）');
    ok(/column\.style\.width = '';\n    column\.style\.minWidth = '';\n    column\.style\.maxWidth = '';/.test(appSrc),
      '2 重置 = 清行内样式回 CSS 变量出厂值');

    ok(/let zenFocusReturn = null;/.test(appSrc) && /if \(!state\.zenMode\) zenFocusReturn = active;/.test(appSrc),
      '3 禅模式进入前焦点快照在册');
    ok(/const evicted = active && \(!active\.isConnected \|\| active\.offsetParent === null\);/.test(appSrc)
      && /if \(state\.zenMode && evicted\) document\.getElementById\('reader'\)\?\.focus\(\);/.test(appSrc),
      '3 焦点随 display:none 蒸发 → 进入后落阅读区');
    ok(/if \(!state\.zenMode\) \{\n      if \(zenFocusReturn\?\.isConnected/.test(appSrc)
      && /zenFocusReturn = null; \/\/ 归还消费后清账/.test(appSrc),
      '3 退出时焦点归还进入前位置');

    // ── Phase B：真实渲染窗口断言 ─────────────────────────────────────────
    const win = new BrowserWindow({
      show: false, width: 1280, height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1400); // bootstrap + 绑定完成
    win.showInactive(); // 禅模式焦点守卫走 rAF——隐藏窗不产帧、rAF 停摆（探针实证）；后台非激活显示让帧流动且不抢用户焦点

    const b = await win.webContents.executeJavaScript(`(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        // ② 分栏把手双击重置：先把侧栏拖宽（模拟拖拽结果），双击后回出厂 240
        const sidebar = document.getElementById('sidebar');
        const splitterSb = document.getElementById('splitter-sidebar');
        sidebar.style.width = '320px';
        sidebar.style.minWidth = '320px';
        sidebar.style.maxWidth = '320px';
        await sleep(30);
        out.draggedWidth = Math.round(sidebar.getBoundingClientRect().width);
        out.handleTitle = splitterSb.title || '';
        splitterSb.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await sleep(60);
        out.resetWidth = Math.round(sidebar.getBoundingClientRect().width);
        out.inlineCleared = !sidebar.style.width && !sidebar.style.minWidth && !sidebar.style.maxWidth;
        out.varReset = document.documentElement.style.getPropertyValue('--sidebar-width') === '240px'
          && document.documentElement.style.getPropertyValue('--list-width') === '340px';

        // ③ 禅模式进出：焦点守卫 + 滚动保位（focus 调用插值日志定位守卫时序）
        const readerScroll = document.getElementById('reader-scroll');
        readerScroll.innerHTML = '<div style="height:4000px"></div>';
        readerScroll.scrollTop = 500;
        await sleep(30);
        const listCol = document.getElementById('list');
        listCol.focus();
        out.focusBefore = document.activeElement && document.activeElement.id;
        window.__focusLog = [];
        const origFocus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (...args) { window.__focusLog.push(this.id || this.tagName); return origFocus.apply(this, args); };
        document.dispatchEvent(new Event('rc-zen-toggle')); // 进入禅模式
        let probeRafFired = false;
        requestAnimationFrame(() => { probeRafFired = true; });
        await sleep(400); // 越过 rAF 焦点守卫（后台窗 rAF 节奏保守等待）
        HTMLElement.prototype.focus = origFocus;
        out.focusLog = window.__focusLog.join(',');
        out.probeRafFired = probeRafFired;
        out.listOffsetParentNull = document.getElementById('list').offsetParent === null;
        out.zenOn = document.body.classList.contains('zen');
        out.focusInZen = (document.activeElement && document.activeElement.id) || document.activeElement?.tagName || '';
        // 诊断：禅模式下直接对 #reader 调 focus() 是否可用（隔离 app 守卫 vs 元素可聚焦性）
        document.getElementById('reader')?.focus();
        await sleep(30);
        out.manualFocusWorks = document.activeElement && document.activeElement.id;
        // 还原到 body 态再走退出路径（模拟守卫未生效的真实时序）
        document.activeElement?.blur?.();
        await sleep(30);
        out.scrollInZen = readerScroll.scrollTop;
        document.dispatchEvent(new Event('rc-zen-toggle')); // 退出
        await sleep(400);
        out.zenOff = !document.body.classList.contains('zen');
        out.focusRestored = document.activeElement && document.activeElement.id;
        out.scrollRestored = readerScroll.scrollTop;
        readerScroll.innerHTML = '';
        return out;
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'window-flow');
    if (b.__err) ok(false, '窗口流程探针异常 — ' + b.__err);
    else {
      ok(b.draggedWidth === 320, `2 预置拖宽 320px（实际 ${b.draggedWidth}）`);
      ok(b.handleTitle.includes('双击'), `2 把手 title 可发现（${b.handleTitle}）`);
      ok(b.resetWidth === 240, `2 双击后侧栏回出厂 240px（实际 ${b.resetWidth}）`);
      ok(b.inlineCleared, '2 行内样式清零');
      ok(b.varReset, '2 CSS 变量归出厂 240/340');
      ok(b.focusBefore === 'list', `3 进入前焦点在列表列（${b.focusBefore}）`);
      ok(b.zenOn, '3 禅模式进入');
      console.log('  [diag] focusLog=' + (b.focusLog || '') + ' manualFocus=' + (b.manualFocusWorks || '')
        + ' probeRaf=' + b.probeRafFired + ' listOffsetNull=' + b.listOffsetParentNull);
      ok(b.focusInZen === 'reader', `3 焦点蒸发 → 落到阅读区（${b.focusInZen}）`);
      ok(b.scrollInZen === 500, `3 进入禅模式滚动位置保持（${b.scrollInZen}）`);
      ok(b.zenOff, '3 禅模式退出');
      ok(b.focusRestored === 'list', `3 退出后焦点归还原位（${b.focusRestored}）`);
      ok(b.scrollRestored === 500, `3 退出后滚动位置保持（${b.scrollRestored}）`);
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
