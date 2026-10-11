'use strict';
/**
 * diag-r73-consistency.js — R73 收官一致性三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 z-index 谱表文档化 + 探针固化：三样式表全量 z-index 值 ⊆ robin.css 谱表冻结档位
 *    （局部层叠 0-120 / 全局浮层底座 240-1200 / 划词批注强占位 45-47 上限三档）；
 *    关键层序合同断言（右键菜单顶 / toast>灯箱>命令面板>期刊 / 引导<模态 等）
 *  2 焦点环 / 选区色 / 滚动条三件套跟随 accent 终检：选区 color-mix(accent) 化
 *    （纸感期刊独立档冻结例外）；:focus-visible outline 全量 accent；滚动条 thumb accent 家族
 *  3 reduced-motion 全量断言：全局收敛块四声明锚；@keyframes 定义与 animation 引用闭包；
 *    reveal 渐显 no-preference 档；JS 动效 reduced 门（双击回顶滚动 / 渐显观察器）；
 *    本批新动效件（批量重试条/inline 重试钮）纯 transition（自动被全局块覆盖）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r73-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const css = read('src/renderer/styles/robin.css');
    const storeCss = read('src/renderer/styles/store.css');
    const accountCss = read('src/renderer/styles/account.css');
    const allCss = css + '\n' + storeCss + '\n' + accountCss;
    const listSrc = read('src/renderer/views/list.js');
    const readerSrc = read('src/renderer/views/reader.js');

    // ── 1. z-index 谱表固化 ──
    ok(/R73-① z-index 谱表（全库冻结口径/.test(css), '1 谱表文档块在册（robin.css 头部）');
    const SPECTRUM = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '20', '25', '30', '40', '42', '44', '50', '60', '70', '85', '90',
      '110', '115', '120', '240', '380', '500', '600', '780', '800', '850', '860', '900', '920', '950', '980', '999', '1000', '1200',
      '2147483645', '2147483646', '2147483647']);
    const found = new Map(); // value -> count
    for (const m of allCss.matchAll(/z-index:\s*(-?\d+)/g)) {
      const v = m[1];
      found.set(v, (found.get(v) || 0) + 1);
    }
    const outOfSpectrum = [...found.keys()].filter((v) => !SPECTRUM.has(v));
    ok(outOfSpectrum.length === 0, `1 全库 z-index 值域 ⊆ 谱表（${found.size} 档在用，越界=${outOfSpectrum.length}${outOfSpectrum.length ? '：' + outOfSpectrum.join(',') : ''}）`);
    ok((found.get('2147483645') || 0) >= 2 && (found.get('2147483646') || 0) >= 3 && (found.get('2147483647') || 0) === 1,
      '1 强占位族三档在册（45 划词浮条族 / 46 popover 菜单卡族 / 47 仅笔记编辑器）');
    // 关键层序合同（值从 CSS 实测而非硬编码双写）
    const zOf = (selectorFragment) => {
      const re = /([^{}]+)\{([^{}]*)\}/g;
      let m;
      while ((m = re.exec(allCss))) {
        if (m[1].includes(selectorFragment) && /z-index:\s*(-?\d+)/.test(m[2])) return Number(m[2].match(/z-index:\s*(-?\d+)/)[1]);
      }
      return null;
    };
    const pairs = [
      ['.context-menu', 1200, '右键菜单全库之顶'],
      ['#nj-toast-stack', 1000, null], ['.nj-lightbox', 999, null],
      ['.cmd-palette-overlay', 920, null], ['.er-overlay', 900, null],
      ['.nj-onboarding-overlay', 780, null], ['.modal-overlay', 800, null],
      ['.search-history', 600, null], ['.list-batch-bar', 500, null],
    ];
    let orderOk = true;
    for (const [frag, , ] of pairs) { if (zOf(frag) === null) orderOk = false; }
    ok(orderOk, '1 层序合同取样全命中（context-menu/toast 栈/lightbox/cmd/er/onboarding/modal/history/batch）');
    ok(zOf('.context-menu') > zOf('#nj-toast-stack') && zOf('#nj-toast-stack') > zOf('.nj-lightbox')
      && zOf('.nj-lightbox') > zOf('.cmd-palette-overlay') && zOf('.cmd-palette-overlay') > zOf('.er-overlay')
      && zOf('.er-overlay') > zOf('.modal-overlay') && zOf('.modal-overlay') > zOf('.nj-onboarding-overlay')
      && zOf('.nj-onboarding-overlay') > zOf('.search-history') && zOf('.search-history') > zOf('.list-batch-bar'),
      '1 层序链右→左单调（菜单>toast>灯箱>命令面板>期刊>模态>引导>搜索历史>批量条）');
    // JS 侧无 zIndex 直写（层级变化全走样式表，谱表即单一事实源）
    const jsFiles = ['src/renderer/app.js'].concat(fs.readdirSync(path.join(ROOT, 'src/renderer/views')).map((f) => 'src/renderer/views/' + f));
    const jsHits = jsFiles.filter((f) => /zIndex\s*=|style\.zIndex/.test(read(f)));
    ok(jsHits.length === 0, `1 渲染层 JS 无 zIndex 直写（${jsHits.length} 处）`);

    // ── 2. 三件套 accent 终检 ──
    // 剥注释后解析（注释里的示例值不得计入）
    const cssClean = allCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const selRules = [...cssClean.matchAll(/([^{}]*::selection[^{}]*)\{([^{}]*)\}/g)];
    const selBg = selRules.map((m) => m[2].trim());
    const accentSel = selBg.filter((b) => b.includes('color-mix(in srgb, var(--accent)')).length;
    ok(selRules.length === 3 && accentSel === 2, `2 选区规则 3 处、accent 化 2 处（${selRules.length}/${accentSel}）`);
    ok(selBg.some((b) => b.includes('rgba(97, 115, 87, 0.34)')), '2 纸感期刊选区独立档冻结例外（--erp 纸面系统，R17 记档口径）');
    ok(!/rgba\(116, 137, 100[^)]*\)[^;]*::selection|::selection[^}]*rgba\(116, 137, 100/.test(allCss),
      '2 选区硬编码缺省 accent rgba 全数退役');
    // 焦点环：:focus-visible outline 全量 accent（或 --focus-ring 光环族）
    const outlineBad = [];
    for (const m of allCss.matchAll(/([^{}]*:focus-visible[^{}]*)\{([^{}]*)\}/g)) {
      const body = m[2];
      if (/outline:\s*(?!.*var\(--accent\))/.test(body) && !/var\(--focus-ring\)|transparent/.test(body) && /outline:[^;]*solid/.test(body)) {
        outlineBad.push(m[1].trim().slice(0, 60));
      }
    }
    ok(outlineBad.length === 0, `2 :focus-visible outline 全量 accent（离群 ${outlineBad.length}${outlineBad.length ? '：' + outlineBad.slice(0, 3).join(' | ') : ''}）`);
    ok(/--focus-ring: 0 0 0 2px color-mix\(in srgb, var\(--accent\) 80%, transparent\);/.test(css),
      '2 --focus-ring 光环族 accent 派生在册');
    // 滚动条 thumb accent 家族（正文/列表细条 hover、浮空滑轨、浮层内滚 5px 家族）
    ok(/\.reader-scroll:hover::-webkit-scrollbar-thumb:hover, \.list-scroll:hover::-webkit-scrollbar-thumb:hover \{ background: var\(--accent\); \}/.test(css),
      '2 正文/列表滚动条 thumb hover accent');
    ok(/color-mix\(in srgb, var\(--accent\) 24%, transparent\)/.test(css),
      '2 浮层内滚 5px 家族 hover accent 24% 细条（R63 家族）');

    // ── 3. reduced-motion 全量 ──
    ok(/@media \(prefers-reduced-motion: reduce\) \{\n  \*,\n  \*::before,\n  \*::after \{\n    animation-duration: 0\.01ms !important;\n    animation-iteration-count: 1 !important;\n    transition-duration: 0\.01ms !important;\n    scroll-behavior: auto !important;\n  \}\n\}/.test(css),
      '3 全局收敛块四声明锚在册（时长/迭代/过渡/滚动行为全压制）');
    // keyframes 定义与 animation 引用闭包（剥注释：注释里的 "animation: none" 字样不得计入；animation: none 声明豁免）
    const defined = new Set([...cssClean.matchAll(/@keyframes ([a-zA-Z0-9_-]+)/g)].map((m) => m[1]));
    const referenced = new Set();
    for (const m of cssClean.matchAll(/animation:\s*([^;]+);/g)) {
      const name = m[1].trim().split(/\s+/)[0];
      if (name && name !== 'none') referenced.add(name);
    }
    const missing = [...referenced].filter((n) => !defined.has(n));
    ok(missing.length === 0, `3 animation 引用闭包（定义 ${defined.size} 帧 / 引用 ${referenced.size} 帧，悬空 ${missing.length}${missing.length ? '：' + missing.join(',') : ''}）`);
    // reveal 渐显在 no-preference 档内（reduced 直接不进 pending——观察器入口也有门）
    ok(/@media \(prefers-reduced-motion: no-preference\) \{\n  \.nj-reveal-pending/.test(css)
      && listSrc.includes("if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;"),
      '3 reveal 渐显 CSS no-preference 档 + 观察器 JS 双门');
    // JS 动效 reduced 门（R69-② 双击回顶平滑降级）
    ok(readerSrc.includes("behavior: reduced ? 'auto' : 'smooth'"), '3 双击回顶滚动 reduced 降级 instant');
    // 本批新动效件零 keyframes（纯 transition → 全局块自动覆盖）
    const batchRules = ['.nj-img-batch-bar {', '.nj-img-batch-retry {', '.study-panel-retry {'];
    const hasAnim = batchRules.filter((frag) => {
      const re = /([^{}]+)\{([^{}]*)\}/g;
      let m;
      while ((m = re.exec(css))) {
        if (m[1].includes(frag.replace(' {', '')) && /animation/.test(m[2])) return true;
      }
      return false;
    });
    ok(hasAnim.length === 0, '3 本批新件（批量重试条/inline 重试钮）纯 transition 零 keyframes');

    // ── UI 实证：CSSOM 选区规则真实解析 + 主题换色时 accent 跟随（改 --accent → color-mix 跟变）──
    const win = new BrowserWindow({
      show: false, width: 1200, height: 800,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    global.__r73win = win;
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1000);
    const rt = await exec(`(async () => {
      const out = {};
      // CSSOM 实扫 ::selection 规则（静态扫描之外的真实样式表解析面）
      const sels = [];
      let sheetCount = 0;
      for (const sheet of document.styleSheets) {
        sheetCount += 1;
        let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
        const walk = (list) => {
          for (const r of list) {
            if (r.cssRules && r.cssRules.length) { walk(r.cssRules); continue; }
            if (r.selectorText && r.selectorText.includes('::selection')) sels.push(r.cssText);
          }
        };
        walk(rules);
      }
      out.sheetCount = sheetCount;
      out.selCount = sels.length;
      out.selAccent = sels.filter((s) => s.includes('color-mix(in srgb, var(--accent)')).length;
      // accent 换色跟随实证：.reader-article a 消费 var(--accent)（真实规则选择器）→
      // 改根变量消费面即变、移除即还原——选区 color-mix 走同一令牌通道
      const holder = document.createElement('div');
      holder.className = 'reader-article';
      const a = document.createElement('a');
      a.href = '#'; a.textContent = 'x';
      holder.appendChild(a);
      document.body.appendChild(holder);
      const before = getComputedStyle(a).color;
      document.documentElement.style.setProperty('--accent', '#b3541e');
      const after = getComputedStyle(a).color;
      document.documentElement.style.removeProperty('--accent');
      const restored = getComputedStyle(a).color;
      holder.remove();
      out.accentSwap = { before, changed: before !== after, restored: restored === before };
      return out;
    })()`, 'r73-runtime');
    if (rt.__err) ok(false, 'UI 实证探针异常 — ' + rt.__err);
    else {
      ok(rt.sheetCount >= 1 && rt.selCount >= 3 && rt.selAccent >= 2, `2 CSSOM 实扫选区规则（sheets=${rt.sheetCount}，命中 ${rt.selCount} 条，accent 化 ${rt.selAccent}）`);
      ok(rt.accentSwap.changed && rt.accentSwap.restored, '2 accent 换色消费面跟随（改根变量链接色即变、移除即还原——选区同令牌通道）');
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});

function exec(js, label, ms = 45000) {
  return Promise.race([
    global.__r73win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}
