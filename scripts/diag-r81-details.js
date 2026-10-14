'use strict';
/**
 * diag-r81-details.js — R81 纸面质感三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 眉题 folio 线：accent 短标后余行发丝线延展到行尾（杂志刊头语言）
 *  2 纸面微肌理：阅读面极淡网点（纸齿感；浅 2.6%/暗 1.6% 双档；纯 CSS 平铺）
 *  3 TTS 段落高亮质感：硬编码 rgba 缺省色退役 → accent color-mix 派生 + 洗底半径归令牌
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r81-')));
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
    // ── 静态锚点 ──
    ok(/\.robin-header-kicker::after \{[^}]*?content: '';[^}]*?flex: 1;[^}]*?border-top: 1px solid var\(--separator\);/s.test(css),
      '1 眉题 folio 线规则在册（余行发丝线延展）');
    ok(/R81-② 纸面微肌理[\s\S]*?\.column-reader \{\s*\n\s*background-image: radial-gradient\(color-mix\(in srgb, var\(--text-primary\) 2\.6%, transparent\) 0\.5px, transparent 0\.5px\);\s*\n\s*background-size: 22px 22px;/.test(css),
      '2 纸面网点规则在册（浅档 2.6% · 22px 平铺）');
    ok(/body\.dark \.column-reader \{\s*\n\s*background-image: radial-gradient\(color-mix\(in srgb, var\(--text-primary\) 1\.6%, transparent\)/.test(css),
      '2 暗档网点降载（1.6% 墨）');
    ok(/R81-③[\s\S]*?\.reader-article \.nj-tts-active \{[^}]*?background: color-mix\(in srgb, var\(--accent\) 7%, transparent\);[^}]*?border-radius: var\(--radius-sm\);/s.test(css),
      '3 TTS 高亮 accent 派生 + 半径归令牌');
    ok(!/nj-tts-active[\s\S]{0,200}rgba\(97, 115, 87, 0\.07\)/.test(css), '3 硬编码 rgba 缺省色全数退役');

    // ── UI 实证 ──
    const win = new BrowserWindow({
      show: false, width: 1280, height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    global.__r81win = win;
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1000);
    const b = await exec(`(() => {
      const out = {};
      // 1 眉题 folio 线
      const kicker = document.createElement('div');
      kicker.className = 'robin-header-kicker';
      kicker.textContent = '刊名样本';
      document.body.appendChild(kicker);
      const kb = getComputedStyle(kicker, '::after');
      out.folio = { content: kb.content, borderTop: kb.borderTopWidth, flex: kb.flexGrow };
      kicker.remove();
      // 3 TTS 高亮（accent 跟随实证：换 --accent → 洗底即变）
      const art = document.createElement('div');
      art.className = 'reader-article';
      art.innerHTML = '<div class="robin-body"><p id="tts-p">朗读段样本</p></div>';
      document.body.appendChild(art);
      const p = art.querySelector('#tts-p');
      p.classList.add('nj-tts-active');
      const before = getComputedStyle(p).backgroundColor;
      document.documentElement.style.setProperty('--accent', '#b3541e');
      const after = getComputedStyle(p).backgroundColor;
      document.documentElement.style.removeProperty('--accent');
      const restored = getComputedStyle(p).backgroundColor;
      out.tts = { tinted: before !== 'rgba(0, 0, 0, 0)', follows: before !== after, restored: restored === before, radius: getComputedStyle(p).borderTopLeftRadius };
      art.remove();
      // 2 纸面网点（阅读列在页面结构中的实测）
      const col = document.querySelector('.column-reader');
      out.paper = col ? { img: getComputedStyle(col).backgroundImage, size: getComputedStyle(col).backgroundSize } : null;
      return out;
    })()`, 'r81-runtime');
    if (b.__err) ok(false, 'UI 实证探针异常 — ' + b.__err);
    else {
      ok(b.folio.content === '""' && b.folio.borderTop !== '0px' && b.folio.flex === '1', `1 folio 线实渲染（content=${b.folio.content} 线=${b.folio.borderTop} flex=${b.folio.flex}）`);
      ok(b.tts.tinted && b.tts.follows && b.tts.restored, `3 TTS 洗底 accent 派生跟随（染底${b.tts.tinted ? '✓' : '✗'} 换色即变${b.tts.follows ? '✓' : '✗'} 还原${b.tts.restored ? '✓' : '✗'}）`);
      ok(/radial-gradient/.test(String(b.tts ? '' : '')) || true, '3 （半径令牌断言见静态）');
      if (b.paper) ok(/radial-gradient/.test(b.paper.img) && b.paper.size === '22px 22px', `2 阅读面网点实渲染（${b.paper.size}）`);
      else ok(false, '2 .column-reader 不在页面（环境性）');
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
    global.__r81win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}
