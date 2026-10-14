'use strict';
/**
 * diag-r80-details.js — R80 阅读动效编排三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 进文三拍编排：眉题→标题→meta 0/60/120ms njRise 上浮淡入（no-preference 双门）
 *  2 首屏正文 stagger：前三块 160/220/280ms 跟随（视线从标题滑入正文）
 *  3 标题下划线生长：hover 发丝线自左 scaleX 生长（accent 渐变，瞬变色变退役）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r80-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 180 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const css = read('src/renderer/styles/robin.css');
    const readerSrc = read('src/renderer/views/reader.js');
    // ── 静态锚点 ──
    ok(/@keyframes njRise \{\s*\n\s*from \{ opacity: 0; transform: translateY\(8px\); \}/.test(css), '1 njRise 关键帧在册（8px 上浮淡入）');
    ok(/@media \(prefers-reduced-motion: no-preference\) \{\s*\n\s*\.nj-enter-compose \.robin-header-kicker,/.test(css),
      '1 编排在 no-preference 档内（reduced 一律即时呈现）');
    const delayOf = (frag) => {
      const esc = frag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let m = new RegExp(esc + '[^}]*?animation-delay: (\\d+(?:\\.\\d+)?)ms').exec(css);
      if (m) return Number(m[1]);
      m = new RegExp(esc + '[^}]*?animation-delay: (\\d+(?:\\.\\d+)?)s').exec(css);
      return m ? Math.round(Number(m[1]) * 1000) : null;
    };
    const k = delayOf('.nj-enter-compose .robin-header-kicker {');
    const t = delayOf('.nj-enter-compose .robin-header-title {');
    const m = delayOf('.nj-enter-compose .robin-header-meta {');
    ok(k === 0 && t === 60 && m === 120, `1 三拍阶梯（kicker=${k}/title=${t}/meta=${m}ms）`);
    const b1 = delayOf('.reader-article .robin-body > *:nth-child(1)');
    const b2 = delayOf('.reader-article .robin-body > *:nth-child(2)');
    const b3 = delayOf('.reader-article .robin-body > *:nth-child(3)');
    ok(b1 === 180 && b2 === 210 && b3 === 240, `2 既有 article-rise 阶梯重排（${b1}/${b2}/${b3}ms，标题三拍先行正文随后滑入）`);
    ok(!css.includes('.nj-enter-compose .robin-body'), '2 编排不与既有正文入场动画叠写（单一动效源）');
    ok(readerSrc.includes("if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) article.classList.add('nj-enter-compose');"),
      '1 渲染端 reduced 双门（不发类即无延迟填充）');
    ok(/\.robin-header-title a::after \{[^}]*?transform: scaleX\(0\);[^}]*?transition: transform var\(--dur-mid\) var\(--ease-out\);/s.test(css),
      '3 标题下划线生长规则在册（scaleX 0 起 + 令牌过渡）');
    ok(/\.robin-header-title a:hover::after \{ transform: scaleX\(1\); \}/.test(css), '3 hover 全长生长');

    // ── UI 实证（挂载编排类验计算动画）──
    const win = new BrowserWindow({
      show: false, width: 1280, height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    global.__r80win = win;
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1000);
    const b = await exec(`(() => {
      const out = {};
      const art = document.createElement('div');
      art.className = 'reader-article nj-enter-compose';
      art.innerHTML =
        '<div class="robin-header-container"><div class="robin-header-kicker">刊名</div>' +
        '<h1 class="robin-header-title"><a href="#">标题样本</a></h1>' +
        '<div class="robin-header-meta">作者 · 日期</div></div>' +
        '<div class="robin-body"><p>一</p><p>二</p><p>三</p><p>四</p></div>';
      document.body.appendChild(art);
      const cs = (el) => getComputedStyle(el);
      const kicker = art.querySelector('.robin-header-kicker');
      const title = art.querySelector('.robin-header-title');
      const meta = art.querySelector('.robin-header-meta');
      const ps = art.querySelectorAll('.robin-body > p');
      out.k = { name: cs(kicker).animationName, delay: cs(kicker).animationDelay, dur: cs(kicker).animationDuration };
      out.t = { name: cs(title).animationName, delay: cs(title).animationDelay };
      out.m = { name: cs(meta).animationName, delay: cs(meta).animationDelay };
      out.b1 = { name: cs(ps[0]).animationName, delay: cs(ps[0]).animationDelay };
      out.b2 = { delay: cs(ps[1]).animationDelay };
      // 3 下划线：:after 存在 scaleX(0) 起态（直调 getComputedStyle 伪元素重载——cs 辅助函数不收第二参）
      const a = art.querySelector('.robin-header-title a');
      const after = getComputedStyle(a, '::after');
      out.underline = { content: after.content, transform: after.transform, h: after.height, pos: after.position };
      art.remove();
      return out;
    })()`, 'r80-runtime');
    if (b.__err) ok(false, 'UI 实证探针异常 — ' + b.__err);
    else {
      ok(b.k.name === 'njRise' && b.t.name === 'njRise' && b.m.name === 'njRise', `1 三元素 njRise 编排（k=${b.k.name}/${b.t.name}/${b.m.name}）`);
      ok(b.k.delay === '0s' && b.t.delay === '0.06s' && b.m.delay === '0.12s', `1 计算延迟阶梯（${b.k.delay}/${b.t.delay}/${b.m.delay}）`);
      ok(b.b1.name === 'article-rise' && b.b1.delay === '0.18s' && b.b2.delay === '0.21s', `2 正文阶梯实渲染（${b.b1.name}@${b.b1.delay}/${b.b2.delay}，标题先行）`);
      ok(b.underline.content === '""' && /matrix\(0[, ]/.test(String(b.underline.transform)) && parseFloat(b.underline.h) > 0 && b.underline.pos === 'absolute',
        `3 下划线 scaleX(0) 起态实渲染（transform=${String(b.underline.transform).slice(0, 24)} h=${b.underline.h}）`);
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
    global.__r80win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}
