'use strict';
/**
 * diag-r62-darkparity.js — R62 暗色 parity 三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 暗色 accent 链接/按钮对比度全量审计：探针实算 WCAG 对比度——暗色语义色
 *    （accent/warm-accent/danger vs 全部 7 档暗纸面；accent-ink vs accent 底）全部 ≥4.5:1，
 *    并以真实 UI 计算样式核对令牌落地（链接/空态 CTA 消费 accent）
 *  2 暗色封面图亮度曲线统一：--cover-filter 单一事实源（浅色 none / 暗色 brightness .86 +
 *    saturate .92），杂志卡/周刊刊头/媒体缩略图三家族消费（暗色 UI 实证滤镜生效）
 *  3 暗色阴影三档可见性曲线：--shadow-1/2/3 亮暗双档在册 + 暗档不透明度单调递增
 *    （0.32<0.42<0.52，靠更深不靠更浓）+ 弹层/模态消费令牌（暗色 UI 实证覆盖生效）
 *    ——三档映射本体 U6-② 已落地，本轮为审计固化（换题记档在案）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r62-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

/* ── WCAG 对比度实算（sRGB → 相对亮度）── */
function hexRgb(hex) {
  const m = hex.replace('#', '');
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}
function lin(c8) {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function lum(rgb) { return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]); }
function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
const mixSrgb = (a, b, pct) => a.map((v, i) => v * (pct / 100) + b[i] * (1 - pct / 100));

app.whenReady().then(async () => {
  try {
    const css = read('src/renderer/styles/robin.css');
    const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')));
    const darkStart = css.indexOf('body.dark {');
    const darkBlock = css.slice(darkStart, css.indexOf('\n}', darkStart));

    const tokenHex = (block, name) => {
      const m = block.match(new RegExp('--' + name + ':\\s*(#[0-9A-Fa-f]{6})'));
      return m ? m[1] : null;
    };

    // ── 1. 暗色 accent 链接/按钮对比度全量审计（实算）──
    const darkTokens = {};
    for (const n of ['accent', 'warm-accent', 'danger', 'accent-ink']) {
      darkTokens[n] = tokenHex(darkBlock, n);
      ok(darkTokens[n], `1 暗色 --${n} 语义色在册（${darkTokens[n]}）`);
    }
    const darkBase = {};
    for (const n of ['page-background', 'article-list-background', 'sidebar-background', 'note-background']) {
      darkBase[n] = tokenHex(darkBlock, n);
      ok(darkBase[n], `1 暗色 --${n} 纸面在册（${darkBase[n]}）`);
    }
    // 表面三档（color-mix 派生按声明百分比实算）
    const surfaces = { 'page': darkBase['page-background'], 'list': darkBase['article-list-background'], 'sidebar': darkBase['sidebar-background'], 'note': darkBase['note-background'] };
    for (const n of ['surface-1', 'surface-2', 'surface-3']) {
      const m = darkBlock.match(new RegExp('--' + n + ': color-mix\\(in srgb, var\\(--note-background\\) (\\d+)%, var\\(--page-background\\)\\)'));
      ok(m, `1 暗色 --${n} 派生声明在册（note ${m ? m[1] : '?'}% × page）`);
      if (m) surfaces[n] = mixSrgb(hexRgb(darkBase['note-background']), hexRgb(darkBase['page-background']), Number(m[1]));
    }
    // 文本语义色 vs 全部暗纸面 ≥4.5
    let worst = ['accent', Infinity];
    const fgNames = ['accent', 'warm-accent', 'danger'];
    let fgAllPass = true;
    for (const fg of fgNames) {
      for (const [bgName, bg] of Object.entries(surfaces)) {
        const c = contrast(hexRgb(darkTokens[fg]), Array.isArray(bg) ? bg : hexRgb(bg));
        if (c < 4.5) { fgAllPass = false; console.error(`  对比缺口: --${fg} on ${bgName} = ${c.toFixed(2)}:1`); }
        if (c < worst[1]) worst = [`${fg}@${bgName}`, c];
      }
    }
    ok(fgAllPass, `1 暗色语义色 vs 7 档暗纸面全部 ≥4.5:1（最紧 ${worst[0]} = ${worst[1].toFixed(2)}:1）`);
    const inkC = contrast(hexRgb(darkTokens['accent-ink']), hexRgb(darkTokens['accent']));
    ok(inkC >= 4.5, `1 暗色 accent 底上的墨（--accent-ink）= ${inkC.toFixed(2)}:1 ≥4.5`);
    ok(/\.reader-article a \{\s*\n\s*color: var\(--accent\);/.test(css) && /color: var\(--accent\);/.test(css.match(/\.list-empty-refresh \{[^}]*\}/)[0]),
      '1 链接与空态 CTA 消费 accent（对比度审计落在真实消费面）');

    // ── 1b. 批2审查收口：混合填充消费面（danger 实底确认键 + primary spinner 墨环）──
    const lightDanger = tokenHex(rootBlock, 'danger');
    const darkInk = tokenHex(darkBlock, 'accent-ink');
    const lightInk = tokenHex(rootBlock, 'accent-ink');
    ok(lightDanger && lightInk && darkInk, '1b danger/accent-ink 亮暗令牌齐备');
    const cdLight = contrast(hexRgb(lightInk), hexRgb(lightDanger));
    const cdDark = contrast(hexRgb(darkTokens['danger']), hexRgb(darkInk));
    ok(cdLight >= 4.5, `1b danger 实底·浅色：on-fill 墨 = ${cdLight.toFixed(2)}:1 ≥4.5（原 14% 淡彩底 3.33）`);
    ok(cdDark >= 4.5, `1b danger 实底·暗色：danger 底 vs 深墨 = ${cdDark.toFixed(2)}:1 ≥4.5（原 3.99 回归点）`);
    ok(/\.modal-footer \.btn-text\.danger \{[^}]*background: var\(--danger\);[^}]*color: var\(--accent-ink\);/.test(css),
      '1b 破坏性确认按钮真实消费 danger 实底 + on-fill 墨（审计面即渲染面）');
    ok(/\.btn-text\.primary\.spinning::after \{[^}]*border-top-color: var\(--accent-ink\);/.test(css),
      '1b primary spinner 换 on-fill 墨环（row-selected 顶弧在 accent 底不可见——P2-1 收口）');
    const ringLight = contrast(hexRgb(lightInk), hexRgb(tokenHex(rootBlock, 'accent')));
    const ringDark = contrast(hexRgb(darkTokens['accent']), hexRgb(darkInk));
    ok(ringLight >= 3 && ringDark >= 3,
      `1b spinner 顶弧 vs primary 底双主题 ≥3:1 非文本线（浅 ${ringLight.toFixed(2)} / 暗 ${ringDark.toFixed(2)}）`);

    // ── 2. 封面滤镜档 ──
    ok(/--cover-filter: none;/.test(rootBlock), '2 --cover-filter 亮色档 = none（浅色不滤镜）');
    ok(/--cover-filter: brightness\(0\.86\) saturate\(0\.92\);/.test(darkBlock), '2 --cover-filter 暗色档 = brightness(.86) saturate(.92)');
    const coverConsumers = (css.match(/filter: var\(--cover-filter\)/g) || []).length;
    ok(coverConsumers === 3, `2 封面三家族同档消费（杂志卡/周刊刊头/媒体缩略图，实际 ${coverConsumers} 处）`);
    ok(/\.nj-mag-card \.mag-cover img \{[^}]*filter: var\(--cover-filter\)/.test(css.replace(/\n/g, ' ')),
      '2 杂志卡封面消费在册');
    ok(!css.match(/body\.dark \.nj-mag-card \.mag-cover img/), '2 无家族私有暗色滤镜残留（曲线单一事实源）');

    // ── 3. 阴影三档可见性曲线 ──
    for (const [n, pat] of [
      ['1', /--shadow-1: 0 1px 2px rgba\(0, 0, 0, 0\.32\);/],
      ['2', /--shadow-2: 0 8px 24px rgba\(0, 0, 0, 0\.42\), 0 2px 6px rgba\(0, 0, 0, 0\.30\);/],
      ['3', /--shadow-3: 0 18px 48px rgba\(0, 0, 0, 0\.52\);/],
    ]) ok(pat.test(darkBlock), `3 暗色 --shadow-${n} 加深档在册（U6-② 映射固化）`);
    const alphas = [0.32, 0.42, 0.52];
    ok(alphas.every((a, i) => i === 0 || a > alphas[i - 1]), '3 暗档不透明度单调递增（0.32<0.42<0.52，靠更深不靠更浓）');
    const shadowConsumers = (css.match(/var\(--shadow-[123]\)/g) || []).length;
    ok(shadowConsumers >= 12, `3 弹层/模态/卡片消费令牌（${shadowConsumers} 处 ≥12）`);
    ok(/\.cmd-palette \{[^}]*var\(--shadow-3\)/.test(css.replace(/\n/g, ' ')) || /box-shadow: var\(--shadow-3\);/.test(css),
      '3 模态级消费 shadow-3 在册（命令面板）');

    // ── UI 行为断言（亮/暗双态计算样式）──
    const win = new BrowserWindow({
      show: false, width: 1440, height: 900,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1200);

    const exec = (js, label, ms = 30000) => Promise.race([
      win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
    ]);

    const flow = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const host = document.createElement('div');
        host.innerHTML = [
          '<div class="reader-article"><a id="r62-link" href="#">链接</a></div>',
          '<div class="nj-mag-card"><div class="mag-cover"><img id="r62-cover" alt="x"></div></div>',
          '<div class="nj-edition-cover"><img id="r62-edcover" alt="x"></div>',
          '<div class="nj-media-cover"><img id="r62-medcover" alt="x"></div>',
          '<div id="r62-pop" style="box-shadow: var(--shadow-2)"></div>',
          '<div id="r62-modal" style="box-shadow: var(--shadow-3)"></div>',
        ].join('');
        document.body.appendChild(host);
        await sleep(80);
        const read = () => ({
          accent: getComputedStyle(document.getElementById('r62-link')).color,
          cover: getComputedStyle(document.getElementById('r62-cover')).filter,
          edcover: getComputedStyle(document.getElementById('r62-edcover')).filter,
          medcover: getComputedStyle(document.getElementById('r62-medcover')).filter,
          pop: getComputedStyle(document.getElementById('r62-pop')).boxShadow,
          modal: getComputedStyle(document.getElementById('r62-modal')).boxShadow,
        });
        const light = read();
        document.body.classList.add('dark');
        await sleep(120);
        const dark = read();
        document.body.classList.remove('dark');
        return { light, dark };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'r62-flow');
    if (flow.__err) ok(false, 'UI 流程探针异常 — ' + flow.__err);
    else {
      ok(flow.dark.accent === 'rgb(138, 158, 124)', `1 暗色 accent 令牌真实落地（${flow.dark.accent} = #8A9E7C）`);
      ok(flow.light.cover === 'none', `2 亮色封面零滤镜（${flow.light.cover}）`);
      ok(/brightness\(0\.86\)/.test(flow.dark.cover) && /saturate\(0\.92\)/.test(flow.dark.cover), `2 暗色杂志卡封面滤镜生效（${flow.dark.cover}）`);
      ok(/brightness\(0\.86\)/.test(flow.dark.edcover), '2 暗色周刊刊头滤镜生效');
      ok(/brightness\(0\.86\)/.test(flow.dark.medcover), '2 暗色媒体缩略图滤镜生效');
      ok(flow.light.pop !== flow.dark.pop && flow.dark.pop.includes('rgba(0, 0, 0'), `3 阴影暗色覆盖生效（弹层档）`);
      ok(flow.light.modal !== flow.dark.modal && flow.dark.modal.includes('rgba(0, 0, 0'), '3 阴影暗色覆盖生效（模态档）');
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
