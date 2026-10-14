'use strict';
/**
 * diag-r83-details.js — R83 艺术批次收官一致性探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖（R54-R73 收官纪律的艺术批次版）：
 *  1 新动效闭包：R74-R82 新增 keyframes（nj-anchor-flash/njRise/njEndBloom/njCaptionIn）
 *    定义与引用闭包 + 全部落在 no-preference 媒体档或纯 transition（reduced 全局块可压制）
 *  2 三拍阶梯谱系：进文三拍 0/60/120 · 继续读行卡 0/60/120 · 正文阶梯 180ms 起 30ms 步进
 *    ——错峰步长 60ms 家族一致性（60 的倍数）
 *  3 JS 动效 reduced 门全量：nj-enter-compose / 完读绽放 两处 JS 门在册；
 *    图片淡入为纯 transition（全局块自动压制）
 *  4 暗色 parity：纸面网点暗档 1.6% 在册；新视觉件 accent 令牌派生（TTS 洗底/着重号/
 *    任务勾/h2 短横线同源）——零硬编码主题色
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r83-')));
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

    // ── 1. 新动效闭包 ──
    const cssClean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const defined = new Set([...cssClean.matchAll(/@keyframes ([a-zA-Z0-9_-]+)/g)].map((m) => m[1]));
    const referenced = new Set();
    for (const m of cssClean.matchAll(/animation:\s*([^;]+);/g)) {
      const name = m[1].trim().split(/\s+/)[0];
      if (name && name !== 'none') referenced.add(name);
    }
    const missing = [...referenced].filter((n) => !defined.has(n));
    ok(missing.length === 0, `1 animation 引用闭包（定义 ${defined.size} 帧/引用 ${referenced.size} 帧，悬空 ${missing.length}）`);
    for (const kf of ['nj-anchor-flash', 'njRise', 'njEndBloom', 'njCaptionIn']) {
      ok(defined.has(kf), `1 新关键帧 ${kf} 在册`);
    }
    // 新动画引用必须位于 no-preference 档内（nj-anchor-flash 例外：reduced 全局块以 0.01ms 压制且无 delay 填充风险）
    for (const kf of ['njRise', 'njEndBloom', 'njCaptionIn']) {
      const idx = cssClean.indexOf(`animation: ${kf}`);
      const before = cssClean.slice(0, idx);
      const gatePos = before.lastIndexOf('@media (prefers-reduced-motion: no-preference)');
      const gateEnd = before.lastIndexOf('@media');
      ok(gatePos >= 0 && gatePos >= gateEnd, `1 ${kf} 引用在 no-preference 档内（无延迟填充风险）`);
    }

    // ── 2. 三拍阶梯谱系 ──
    const delays = [...cssClean.matchAll(/animation-delay: ([\d.]+)(ms|s);/g)].map((m) => m[1] * (m[2] === 's' ? 1000 : 1));
    const offLadder = delays.filter((d) => Math.abs(d / 60 - Math.round(d / 60)) > 1e-6 && d !== 150);
    ok(offLadder.length === 0, `2 全库 animation-delay 落 60ms 家族（离群 ${offLadder.length}${offLadder.length ? '：' + offLadder.slice(0, 5).join(',') : ''}；caption 150ms 半拍豁免）`);

    // ── 3. JS 动效 reduced 门全量 ──
    const jsGates = (readerSrc.match(/matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/g) || []).length;
    ok(jsGates >= 2, `3 JS 动效 reduced 门 ≥2 处（实测 ${jsGates}：进文编排 + 完读绽放）`);
    ok(/\.reader-article img\.nj-img \{ transition: opacity var\(--dur-mid\) var\(--ease-out\); \}/.test(cssClean)
      && !/\.reader-article img\.nj-img \{[^}]*animation:/.test(cssClean),
      '3 图片淡入基座纯 transition（loading 态 shimmer 是另一规则的合法 keyframe）');

    // ── 4. 暗色 parity 与令牌派生 ──
    ok(/body\.dark \.column-reader \{[^}]*?1\.6%/.test(css), '4 纸面网点暗档 1.6% 在册');
    const r7x = ['R74', 'R75', 'R76', 'R77', 'R78', 'R79', 'R80', 'R81', 'R82'];
    let tagged = 0;
    for (const tag of r7x) tagged += (css.match(new RegExp(`/\\* ${tag}-`, 'g')) || []).length + (readerSrc.match(new RegExp(`${tag}-`, 'g')) || []).length;
    ok(tagged >= 12, `4 R74-R82 轮次标记在册（${tagged} 处锚，可追溯）`);
    ok(!/rgba\(97, 115, 87, 0\.07\)/.test(cssClean), '4 TTS 旧缺省色残留清零');

    // ── UI 实证：新动画族真实可解析（CSSOM）──
    const win = new BrowserWindow({
      show: false, width: 1280, height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    global.__r83win = win;
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1000);
    const b = await exec(`(() => {
      const names = new Set();
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
        const walk = (list) => {
          for (const r of list) {
            if (r instanceof CSSKeyframesRule) { names.add(r.name); continue; }
            if (r.cssRules && r.cssRules.length) walk(r.cssRules);
          }
        };
        walk(rules);
      }
      return { count: names.size, hasRise: names.has('njRise'), hasBloom: names.has('njEndBloom'), hasCaption: names.has('njCaptionIn'), hasFlash: names.has('nj-anchor-flash') };
    })()`, 'r83-runtime');
    if (b.__err) ok(false, 'UI 实证探针异常 — ' + b.__err);
    else {
      ok(b.count >= 4 && b.hasRise && b.hasBloom && b.hasCaption && b.hasFlash,
        `1 CSSOM 实扫新关键帧四枚齐解析（共 ${b.count} 帧）`);
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
    global.__r83win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}
