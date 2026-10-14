'use strict';
/**
 * diag-r82-details.js — R82 阅读仪式三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 完读时刻绽放：终止符首次滚入视口 scale 0.4→1 + 45°→0 归位（一次性；
 *    reduced/无 IO 恒可见直达终态）
 *  2 继续读卡片区入场：行卡 0/60/120ms 错峰上浮（与正文三拍同语言）
 *  3 灯箱图注条：alt 图注底部居中纸片胶囊（延迟 150ms 入场不抢焦点）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r82-')));
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
    const readerSrc = read('src/renderer/views/reader.js');
    // ── 静态锚点 ──
    ok(/@keyframes njEndBloom \{[^}]*?from \{ opacity: 0; transform: scale\(0\.4\) rotate\(45deg\); \}/.test(css), '1 绽放关键帧在册（scale 0.4 + 45° 起）');
    ok(/\.nj-article-end\.bloom-pending \{ opacity: 0; \}/.test(css) && /\.nj-article-end\.bloomed \{ animation: njEndBloom/.test(css),
      '1 pending 隐藏态 + bloomed 绽放（no-preference 门内）');
    ok(readerSrc.includes('endMark.classList.add(\'bloom-pending\');') && readerSrc.includes('entry.target.classList.add(\'bloomed\');'),
      '1 渲染端 IO 一次性绽放接线');
    ok(/if \('IntersectionObserver' in window && !window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches\) \{\s*\n\s*endMark\.classList\.add\('bloom-pending'\);/.test(readerSrc),
      '1 reduced/无 IO 恒可见（pending 只在动画可用时挂）');
    ok(/\.nj-continue-reading \.nj-cr-row \{ animation: njRise/.test(css) && /\.nj-cr-row:nth-of-type\(2\) \{ animation-delay: 60ms; \}/.test(css),
      '2 继续读行卡错峰上浮在册（0/60/120ms）');
    ok(/\.nj-lightbox-caption \{[^}]*?animation: njCaptionIn var\(--dur-mid\) var\(--ease-out\) 0\.15s both;/s.test(css), '3 图注条延迟入场在册');
    ok(readerSrc.includes('${alt ? `<div class="nj-lightbox-caption">${attr(alt)}</div>` : \'\'}'), '3 灯箱模板按 alt 条件渲染图注');

    // ── UI 实证 ──
    const win = new BrowserWindow({
      show: false, width: 1280, height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    global.__r82win = win;
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1000);
    const b = await exec(`(() => {
      const out = {};
      // 1 绽放：pending 隐藏 → bloomed 动画接管
      const end1 = document.createElement('div');
      end1.className = 'nj-article-end bloom-pending';
      document.body.appendChild(end1);
      out.pendingHidden = getComputedStyle(end1).opacity === '0';
      end1.classList.remove('bloom-pending');
      end1.classList.add('bloomed');
      out.bloomAnim = getComputedStyle(end1).animationName;
      end1.remove();
      // 1 reduced 直达：无 pending 类即恒可见
      const end2 = document.createElement('div');
      end2.className = 'nj-article-end';
      document.body.appendChild(end2);
      out.reducedVisible = getComputedStyle(end2).opacity === '1';
      end2.remove();
      // 2 继续读行卡错峰
      const cr = document.createElement('div');
      cr.className = 'nj-continue-reading';
      cr.innerHTML = '<div class="nj-cr-head">继续读</div><button class="nj-cr-row">一</button><button class="nj-cr-row">二</button><button class="nj-cr-row">三</button>';
      document.body.appendChild(cr);
      const rows = cr.querySelectorAll('.nj-cr-row');
      out.rows = {
        r1: getComputedStyle(rows[0]).animationName + '@' + getComputedStyle(rows[0]).animationDelay,
        r2: getComputedStyle(rows[1]).animationDelay,
        r3: getComputedStyle(rows[2]).animationDelay,
      };
      cr.remove();
      // 3 图注条样式实体
      const cap = document.createElement('div');
      cap.className = 'nj-lightbox-caption';
      cap.textContent = 'x';
      document.body.appendChild(cap);
      const cc = getComputedStyle(cap);
      out.caption = { anim: cc.animationName, delay: cc.animationDelay, pos: cc.position, pointer: cc.pointerEvents };
      cap.remove();
      return out;
    })()`, 'r82-runtime');
    if (b.__err) ok(false, 'UI 实证探针异常 — ' + b.__err);
    else {
      ok(b.pendingHidden && b.bloomAnim === 'njEndBloom', `1 绽放实渲染（pending 隐${b.pendingHidden ? '✓' : '✗'} → bloomed 动画=${b.bloomAnim}）`);
      ok(b.reducedVisible, '1 无 pending 时恒可见（reduced 直达终态）');
      ok(b.rows.r1.startsWith('njRise@') && b.rows.r2 === '0.06s' && b.rows.r3 === '0.12s', `2 行卡错峰（${b.rows.r1}/${b.rows.r2}/${b.rows.r3}）`);
      ok(b.caption.anim === 'njCaptionIn' && b.caption.delay === '0.15s' && b.caption.pointer === 'none',
        `3 图注条实体（${b.caption.anim}@${b.caption.delay} 不抢焦点）`);
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
    global.__r82win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}
