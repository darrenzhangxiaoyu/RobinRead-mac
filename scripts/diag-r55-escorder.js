'use strict';
/**
 * diag-r55-escorder.js — R55 浮层秩序三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 Esc 逐层裁决：overlay-stack 浮层栈单元（入栈/出栈/僵尸层跳过/顶层先关）
 *    + 真实叠层行为（设置模态上开命令面板 → 第 1 次 Esc 只关面板、第 2 次才关设置）
 *  2 模态关闭焦点归还：captureFocusReturn 单元（不抢已转移的焦点）
 *    + 真实流程（聚焦「设置」按钮开窗 → Esc 关窗 → 焦点回到按钮）
 *  3 胶囊仪式 Esc=先收下（静态锚点：app.js 仪式段 onEsc→close + 浮层栈挂账）
 *    + 右键菜单 Esc 关菜单新行为（菜单在场时不殃及底下模态）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r55-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    // ── 静态锚点：浮层栈 util 与各浮层挂账 ──
    const stackSrc = read('src/renderer/views/overlay-stack.js');
    ok(stackSrc.includes('export function registerEscapeLayer') && stackSrc.includes('export function isTopEscapeLayer'),
      '1 overlay-stack：registerEscapeLayer/isTopEscapeLayer 统一入口在位');
    ok(stackSrc.includes('export function captureFocusReturn'),
      '2 overlay-stack：captureFocusReturn 焦点归还 util 在位');
    const families = [
      ['src/renderer/views/context-menu.js', 'context-menu'],
      ['src/renderer/views/dialogs.js', 'settings'],
      ['src/renderer/views/knowledge.js', 'knowledge'],
      ['src/renderer/views/weekly-view.js', 'weekly'],
      ['src/renderer/views/garden-view.js', 'garden'],
      ['src/renderer/views/media-view.js', 'media'],
      ['src/renderer/views/course-view.js', 'course'],
      ['src/renderer/views/revisit-view.js', 'revisit'],
      ['src/renderer/views/archive-hall.js', 'archive'],
      ['src/renderer/views/aihot-view.js', 'aihot'],
      ['src/renderer/views/command-palette.js', 'palette'],
      ['src/renderer/views/theme-designer.js', 'theme-designer'],
      ['src/renderer/views/feed-store.js', 'feed-store'],
      ['src/renderer/views/focus-session.js', 'focus'],
      ['src/renderer/views/evolution-view.js', 'evolution'],
    ];
    let hooked = 0;
    for (const [file, kind] of families) {
      const src = read(file);
      const has = kind === 'context-menu'
        ? src.includes('registerEscapeLayer') && src.includes('_escKey') // 菜单 capture 独占裁决，天然顶层，无需 isTop
        : src.includes('isTopEscapeLayer') && src.includes('registerEscapeLayer');
      if (has) hooked += 1;
      else console.error('  未挂账: ' + file);
    }
    ok(hooked === families.length, `1 全部 ${families.length} 个浮层家族已挂账（实际 ${hooked}）`);
    const appSrc = read('src/renderer/app.js');
    ok(appSrc.includes("registerEscapeLayer({ id: 'capsule-ceremony'"),
      '3 胶囊仪式浮层栈挂账（nj-capsule-ceremony）');
    ok(/const onEsc = \(event\) => \{[\s\S]*?isTopEscapeLayer\(ceremonyLayer\)[\s\S]*?close\(\);/.test(appSrc),
      '3 仪式 Esc = 先收下（onEsc → close 同一通路）');

    // ── UI 行为断言 ──
    const { AppStore } = require('../src/main/AppStore');
    const store = new AppStore(app.getPath('userData'));
    const win = new BrowserWindow({
      show: false, width: 1100, height: 820,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, win);
    console.log('UI: loading renderer…');
    let loaded = false;
    for (let attempt = 1; attempt <= 3 && !loaded; attempt += 1) {
      try {
        await Promise.race([
          win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html')),
          new Promise((_, reject) => setTimeout(() => reject(new Error('loadFile timeout')), 25000)),
        ]);
        loaded = true;
      } catch (err) {
        console.error(`UI: load attempt ${attempt} failed — ${String(err && err.message || err)}`);
        if (attempt < 3) { try { await win.loadURL('about:blank'); } catch (_) { /* 原地再试 */ } }
      }
    }
    if (!loaded) throw new Error('UI 渲染层加载失败');
    await sleep(1200);

    const exec = (js, label, ms = 30000) => Promise.race([
      win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
    ]);

    // ── 1（单元）：浮层栈裁决语义 ──
    const unit = await exec(`(async () => {
      const m = await import('./views/overlay-stack.js');
      const aliveA = () => Boolean(window.__aLive);
      const aliveB = () => Boolean(window.__bLive);
      const relA = m.registerEscapeLayer({ id: 'a', isAlive: aliveA });
      const relB = m.registerEscapeLayer({ id: 'b', isAlive: aliveB });
      window.__aLive = true; window.__bLive = true;
      const bothAlive = { aTop: m.isTopEscapeLayer(relA), bTop: m.isTopEscapeLayer(relB) };
      window.__bLive = false; // 顶层僵尸（已被别途关闭）
      const zombieSkipped = { aTop: m.isTopEscapeLayer(relA), bTop: m.isTopEscapeLayer(relB) };
      window.__bLive = true; relB.release(); // 正常释放顶层
      const afterRelease = { aTop: m.isTopEscapeLayer(relA), bTop: m.isTopEscapeLayer(relB) };
      relA.release(); relB.release(); // 幂等释放
      return { bothAlive, zombieSkipped, afterRelease };
    })()`, 'stack-unit');
    ok(unit.bothAlive.aTop === false && unit.bothAlive.bTop === true, '1 双层在栈：顶层是后挂的 b（顶层先关）');
    ok(unit.zombieSkipped.aTop === true && unit.zombieSkipped.bTop === false, '1 顶层僵尸（已从别途关闭）被跳过：a 视为顶');
    ok(unit.afterRelease.aTop === true && unit.afterRelease.bTop === false, '1 释放顶层后 a 回到栈顶（release 幂等）');

    // ── 2（单元）：焦点归还 util ──
    const focusUnit = await exec(`(async () => {
      const m = await import('./views/overlay-stack.js');
      const btn = document.createElement('button');
      document.body.appendChild(btn);
      btn.focus();
      const restore = m.captureFocusReturn();
      btn.focus(); // 模拟焦点仍在打开者
      const el = document.createElement('input');
      document.body.appendChild(el);
      el.focus(); // 用户已把焦点点去别处
      restore();
      const notStolen = document.activeElement === el;
      el.remove();
      btn.focus(); // 回到「模态退场后焦点回落 body」场景
      restore(); // 已消费：幂等
      const idempotent = document.activeElement === btn;
      return { notStolen, idempotent };
    })()`, 'focus-unit');
    ok(focusUnit.notStolen === true, '2 焦点已被用户点去别处 → 不抢（克制）');
    ok(focusUnit.idempotent === true, '2 restore 幂等（二次调用不再动作）');

    // ── 1/2（真实流程）：设置模态上叠命令面板 → Esc 两次逐层退场 + 焦点归还 ──
    const flow = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const sbtn = [...document.querySelectorAll('.footer-nav-btn')].find((b) => (b.title || '').includes('设置'));
        if (!sbtn) return { __err: 'no settings button' };
        sbtn.focus();
        sbtn.click();
        await sleep(800);
        const settingsOpen = Boolean(document.querySelector('.settings-modal'));
        // 设置之上叠命令面板（Ctrl+Shift+P）
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
        await sleep(500);
        const paletteOpen = Boolean(document.querySelector('.cmd-palette, [class*="cmd-palette"]'));
        const paletteSel = document.querySelector('.cmd-palette') ? '.cmd-palette' : (paletteOpen ? Object.keys(document.body.children).length : null);
        // 第 1 次 Esc：只关面板
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await sleep(400);
        const paletteClosed = !document.querySelector('.cmd-palette');
        const settingsKept = Boolean(document.querySelector('.settings-modal'));
        // 第 2 次 Esc：轮到设置
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await sleep(400);
        const settingsClosed = !document.querySelector('.settings-modal');
        const focusBack = document.activeElement === sbtn;
        return { settingsOpen, paletteOpen, paletteClosed, settingsKept, settingsClosed, focusBack };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'esc-order-flow');
    if (flow.__err) ok(false, '1/2 逐层裁决流程探针异常 — ' + flow.__err);
    else {
      ok(flow.settingsOpen === true, '1 设置模态打开');
      ok(flow.paletteOpen === true, '1 命令面板叠在设置之上');
      ok(flow.paletteClosed === true && flow.settingsKept === true, '1 第 1 次 Esc 只关面板、设置不动（顶层先关）');
      ok(flow.settingsClosed === true, '1 第 2 次 Esc 轮到设置（逐层退场）');
      ok(flow.focusBack === true, '2 设置关窗后焦点归还打开按钮（captureFocusReturn 接线）');
    }

    // ── 1（真实流程）：右键菜单叠在设置上 → Esc 先关菜单（新行为），再 Esc 关设置 ──
    const menuFlow = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const { ContextMenu } = await import('./views/context-menu.js');
        const sbtn = [...document.querySelectorAll('.footer-nav-btn')].find((b) => (b.title || '').includes('设置'));
        sbtn.click();
        await sleep(800);
        const settingsOpen = Boolean(document.querySelector('.settings-modal'));
        ContextMenu.show(200, 200, [{ label: '探针菜单项', onClick: () => {} }]);
        await sleep(200);
        const menuOpen = Boolean(document.querySelector('.context-menu'));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await sleep(300);
        const menuClosed = !document.querySelector('.context-menu');
        const settingsKept = Boolean(document.querySelector('.settings-modal'));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await sleep(300);
        const settingsClosed = !document.querySelector('.settings-modal');
        return { settingsOpen, menuOpen, menuClosed, settingsKept, settingsClosed };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'menu-esc-flow');
    if (menuFlow.__err) ok(false, '1 右键菜单流程探针异常 — ' + menuFlow.__err);
    else {
      ok(menuFlow.settingsOpen === true && menuFlow.menuOpen === true, '1 设置模态上叠出右键菜单');
      ok(menuFlow.menuClosed === true, '1 Esc 关闭右键菜单（此前不响应 Esc——补齐）');
      ok(menuFlow.settingsKept === true, '1 菜单层消费 Esc：底下设置不动');
      ok(menuFlow.settingsClosed === true, '1 再一次 Esc 关设置（逐层）');
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
