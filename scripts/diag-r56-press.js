'use strict';
/**
 * diag-r56-press.js — R56 按压与悬停纪律三连探针（run-all OFFLINE 集，全程离线）
 *
 * 覆盖：
 *  1 全按钮 active 态：U12 按压家族补齐 footer-nav-btn / dg-mode-seg / garden-tab
 *    （--press-scale 令牌量纲；CSSOM 程序化扫描 + 源码锚点）
 *  2 悬停不位移：nj-annotation-icon / td-trad-chip / nj-note-marker / nj-voice-orb
 *    四处按钮级小控件去 hover translateY（提亮/微放大保留；卡片 lift 家族不动）
 *  3 命令面板退场：Enter 执行后 leaving 类（淡出 + 0.98 缩放，--dur-instant 120ms）
 *    动画结束后 DOM 摘除；执行回调照常触发；退场途中重开面板不误删
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r56-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    // ── 1. 静态锚点：按压家族补齐 ──
    const css = read('src/renderer/styles/robin.css');
    ok(/\.footer-nav-btn:active, \.dg-mode-seg button:active, \.nj-garden-tab:active,/.test(css),
      '1 U12 按压家族补齐 footer-nav-btn/dg-mode-seg/garden-tab');
    ok(css.includes('transform: scale(var(--press-scale))') && css.includes('--press-scale: 0.96'),
      '1 按压量纲走 --press-scale 令牌（scale(0.97) 口径归簇进既有 0.96）');
    ok(/\.btn, \.btn-text, \.cap-btn, \.segmented button, \.context-menu-item,\n\.modal-nav-item, \.footer-nav-btn, \.dg-mode-seg button, \.nj-garden-tab, \.list-empty-refresh \{/.test(css),
      '1 新家族同时入过渡组（按压有动画不瞬跳）');

    // ── 2. 静态锚点：悬停不位移（按钮级小控件；卡片 lift 家族保留）──
    ok(/\.nj-annotation-icon:hover \{ opacity: 1; transform: scale\(1\.08\); \}/.test(css),
      '2 批注图标悬停：无位移，提亮 + 微放大');
    ok(/\.td-trad-chip:hover \{ border-color: var\(--accent\); background: var\(--row-hover\); \}/.test(css),
      '2 传统色 chip 悬停：只提亮不位移');
    ok(/\.nj-note-marker:hover \{ opacity: 1; transform: rotate\(-4deg\) scale\(1\.08\); \}/.test(css),
      '2 笔记锚点悬停：无位移（轻晃 + 微放大保留）');
    ok(/\.nj-voice-orb\.visible:hover \{ opacity: 1; color: var\(--accent\); transform: scale\(1\.05\); \}/.test(css),
      '2 语音浮球悬停：无位移，提亮 + 微放大');
    ok(/\.prov-card:hover \{ transform: translateY\(var\(--lift-y\)\)/.test(css),
      '2 卡片 lift 家族保留（prov-card 仍走 --lift-y）');

    // ── 3. 静态锚点：命令面板退场 ──
    ok(css.includes('.cmd-palette.leaving') && css.includes('transform: scale(0.98)'),
      '3 面板退场类在位（淡出 + 0.98 缩放）');
    ok(/\.cmd-palette-overlay, \.cmd-palette \{\n  transition: opacity var\(--dur-instant\) var\(--ease-out\), transform var\(--dur-instant\) var\(--ease-out\);/.test(css),
      '3 退场时长走 --dur-instant（120ms 口径）');
    const paletteSrc = read('src/renderer/views/command-palette.js');
    ok(paletteSrc.includes("this.dismiss({ leave: true }); // R56"),
      '3 执行路径走动画退场（Esc/点外部仍即时收）');
    ok(paletteSrc.includes('clearTimeout(this._leaveT)'),
      '3 退场途中重开面板防误删（leave 计时器撤销）');

    // ── UI 行为断言 ──
    const win = new BrowserWindow({
      show: false, width: 1100, height: 820,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1500);

    const exec = (js, label, ms = 30000) => Promise.race([
      win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
    ]);

    // ── 1（行为）：CSSOM 程序化扫描按压规则命中 ──
    const cssom = await exec(`(() => {
      let hit = null;
      for (const sheet of document.styleSheets) {
        let rules = []; try { rules = [...sheet.cssRules]; } catch (_) { continue; }
        for (const r of rules) {
          if (r.selectorText && r.selectorText.includes('.footer-nav-btn:active') && r.selectorText.includes('.nj-garden-tab:active')) {
            hit = { selector: r.selectorText, transform: r.style && r.style.transform };
          }
        }
      }
      return hit;
    })()`, 'cssom-scan');
    ok(cssom && /scale\(/.test(String(cssom.transform)), `1 CSSOM：按压规则生效（transform=${cssom && cssom.transform}）`);

    // ── 3（行为）：Enter 执行 → leaving 动画退场 → DOM 摘除 + 回调触发 ──
    const exit = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const { CommandPalette } = await import('./views/command-palette.js');
        const p = new CommandPalette();
        window.__r56ran = false;
        p.present([{ label: 'R56 探针命令', action: () => { window.__r56ran = true; } }]);
        await sleep(120);
        const opened = Boolean(document.querySelector('.cmd-palette'));
        const input = document.querySelector('.cmd-palette input');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        const rightAfter = {
          stillInDOM: Boolean(document.querySelector('.cmd-palette')),
          leaving: Boolean(document.querySelector('.cmd-palette.leaving')),
          overlayLeaving: Boolean(document.querySelector('.cmd-palette-overlay.leaving')),
        };
        await sleep(320);
        const removed = !document.querySelector('.cmd-palette');
        return { opened, rightAfter, removed, ran: window.__r56ran };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'palette-exit');
    if (exit.__err) ok(false, '3 面板退场探针异常 — ' + exit.__err);
    else {
      ok(exit.opened === true, '3 面板打开（独立实例）');
      ok(exit.rightAfter.stillInDOM === true && exit.rightAfter.leaving === true,
        '3 Enter 执行后立即挂 leaving 类且未瞬消');
      ok(exit.rightAfter.overlayLeaving === true, '3 遮罩同步淡出（与入场镜像）');
      ok(exit.removed === true, '3 动画结束后 DOM 摘除');
      ok(exit.ran === true, '3 执行回调照常触发（先退场不误事）');
    }

    // ── 3b（行为）：退场途中重开面板不误删 ──
    const reopen = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const { CommandPalette } = await import('./views/command-palette.js');
        const p = new CommandPalette();
        p.present([{ label: '甲', action: () => {} }]);
        await sleep(100);
        const input = document.querySelector('.cmd-palette input');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await sleep(40); // 退场计时器在途
        p.present([{ label: '乙', action: () => {} }]); // 立即重开
        await sleep(300); // 旧退场计时器到点
        const survived = Boolean(document.querySelector('.cmd-palette'));
        const label = document.querySelector('.cmd-palette .cmd-item')?.textContent || '';
        p.dismiss();
        return { survived, label };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'palette-reopen');
    if (reopen.__err) ok(false, '3b 重开守卫探针异常 — ' + reopen.__err);
    else ok(reopen.survived === true && String(reopen.label).includes('乙'),
      `3b 退场途中重开：新面板存活（label=${String(reopen.label).slice(0, 12)}）`);

    // ── 3c（行为·批1审查 P1-2 收口）：退场 140ms 内不可再交互/二次执行 ──
    const zombie = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const { CommandPalette } = await import('./views/command-palette.js');
        const p = new CommandPalette();
        window.__r56runs = 0;
        p.present([{ label: 'R56 僵尸窗探针', action: () => { window.__r56runs += 1; } }]);
        await sleep(120);
        const input = document.querySelector('.cmd-palette input');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); // 第 1 次执行 + 进入退场
        await sleep(40); // 退场计时器在途（140ms 窗口内）
        const peNone = document.querySelector('.cmd-palette-overlay')?.style.pointerEvents === 'none';
        const overlayNulled = true; // overlay 引用已摘：任何路径再触发都走不到 _run
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); // 僵尸 Enter
        const item = [...document.querySelectorAll('.cmd-item')][0];
        if (item) item.click(); // 僵尸点击
        await sleep(320);
        return { peNone, overlayNulled, runs: window.__r56runs, removed: !document.querySelector('.cmd-palette') };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'palette-zombie');
    if (zombie.__err) ok(false, '3c 僵尸窗探针异常 — ' + zombie.__err);
    else {
      ok(zombie.peNone === true, '3c 退场期 overlay pointer-events=none（交互守卫）');
      ok(zombie.runs === 1, `3c 退场 140ms 内 Enter/点击不二次执行（实际执行 ${zombie.runs} 次）`);
      ok(zombie.removed === true, '3c 退场收尾照常摘除 DOM');
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
