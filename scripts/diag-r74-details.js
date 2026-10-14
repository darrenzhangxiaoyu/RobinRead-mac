'use strict';
/**
 * diag-r74-details.js — R74 正文排版语义件三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 kbd 键帽：.reader-article kbd 从零视觉到键帽胶囊（描边+底缘厚边+等宽小号+浅底），
 *    实渲染计算样式断言（border-bottom 2px / mono / inline-block）
 *  2 中文着重号：.cjk-em em 斜体退役改 text-emphasis 着重点（字下 accent 派生）；
 *    渲染层按 _isEnglishArticle 挂类（中文文=着重号 / 西文文=保留 italic 传统）
 *  3 上下标行高保护：sub/sup normalize 手法（line-height:0 + relative + baseline），
 *    实渲染布局断言——含脚注标/角标的行与纯文本行等高（行距不再被撑大）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r74-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const robin = read('src/renderer/styles/robin.css');
    const readerSrc = read('src/renderer/views/reader.js');

    // ── 1. kbd 键帽 ──
    const kbdBlock = (/\.reader-article kbd \{([^}]*)\}/.exec(robin) || [])[1] || '';
    ok(kbdBlock.includes('border-bottom-width: 2px') && kbdBlock.includes('font-family: var(--font-mono)') && kbdBlock.includes('background: var(--note-background)'),
      '1 kbd 键帽规则在册（底缘厚边 + 等宽令牌 + note 浅底）');
    ok(kbdBlock.includes('font-size: 0.8em') && kbdBlock.includes('text-align: center;'), '1 kbd 小号居中（多键位等宽排布）');
    ok(!/\.reader-article kbd \{\s*\}/.test(robin), '1 kbd 不再是零视觉（仅 letter-spacing 重置的时代退役）');

    // ── 2. 中文着重号 ──
    ok(/\.reader-article\.cjk-em em \{[^}]*?font-style: normal;[^}]*?text-emphasis: filled dot color-mix\(in srgb, var\(--accent\) 52%, var\(--text-primary\)\);/s.test(robin),
      '2 cjk-em em 着重号规则在册（去斜体 + accent 派生着重点）');
    ok(/text-emphasis-position: under right;/.test(robin), '2 着重点位置随横排传统置字下');
    ok(readerSrc.includes("article.classList.toggle('cjk-em', !this._isEnglishArticle());"),
      '2 渲染层按文章语言挂类（_isEnglishArticle 判定，西文文章保留 italic）');

    // ── 3. 上下标行高保护 ──
    ok(/\.reader-article sub, \.reader-article sup \{[^}]*?line-height: 0;[^}]*?position: relative;[^}]*?vertical-align: baseline;/s.test(robin),
      '3 sub/sup normalize 手法在册（行盒不再被 vertical-align 撑高）');
    ok(/\.reader-article sup \{ top: -0\.5em; \}/.test(robin) && /\.reader-article sub \{ bottom: -0\.22em; \}/.test(robin),
      '3 上下标位移补回（sup 上提 / sub 下沉）');

    // ── Phase B：真实渲染窗口断言 ──
    const win = new BrowserWindow({
      show: false, width: 1280, height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    global.__r74win = win;
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1000);
    const b = await exec(`(() => {
      const out = {};
      const host = document.createElement('div');
      host.className = 'reader-article';
      host.innerHTML =
        '<p>按键 <kbd>Ctrl</kbd> + <kbd>K</kbd> 唤起。</p>' +
        '<p id="plain-line">脚注与角标行高样本正文。</p>' +
        '<p id="sub-line">角标 H<sub>2</sub>O 与 E = mc<sup>2</sup> 混排行。</p>' +
        '<p><em>中文强调样本</em> 与 <em>English emphasis</em>。</p>';
      document.body.appendChild(host);
      const cs = (el) => getComputedStyle(el);
      // 1 kbd 键帽实渲染（读值即时化：getComputedStyle 是活对象，全部在加类前读定）
      const kbd = host.querySelector('kbd');
      const kbdBorderBottom = cs(kbd).borderBottomWidth;
      const kbdTop = parseFloat(cs(kbd).borderTopWidth); // DPI 缩放下 1px 可计算为亚像素，取数值下界
      const kbdMono = cs(kbd).fontFamily.toLowerCase().includes('cascadia');
      const kbdDisplay = cs(kbd).display;
      const kbdBg = cs(kbd).backgroundColor !== 'rgba(0, 0, 0, 0)';
      // 3 含上下标的行与纯文本行等高（line-height 保护实证）
      const plain = host.querySelector('#plain-line');
      const subbed = host.querySelector('#sub-line');
      const lineSameHeight = Math.abs(plain.getBoundingClientRect().height - subbed.getBoundingClientRect().height) <= 1;
      const supEl = host.querySelector('sup');
      const supPos = cs(supEl).position, supLH = cs(supEl).lineHeight, supVA = cs(supEl).verticalAlign;
      // 2 无 cjk-em（西文文章形态）：em 保留 italic 传统（读值即时化——活对象在加类后会变值）
      const emRaw = host.querySelector('em');
      const emDefaultStyle = cs(emRaw).fontStyle;
      // 2 挂 cjk-em（中文文章形态）：着重号生效 + 斜体退役
      host.classList.add('cjk-em');
      const emCjkStyle = cs(emRaw).fontStyle;
      const tes = String(cs(emRaw).textEmphasisStyle || cs(emRaw).webkitTextEmphasisStyle || '');
      host.remove();
      return {
        kbdBorderBottom, kbdTop, kbdMono, kbdDisplay, kbdBg,
        lineSameHeight, supPos, supLH, supVA,
        emDefaultStyle, emCjkStyle, tes,
      };
    })()`, 'r74-runtime');
    if (b.__err) ok(false, 'UI 实证探针异常 — ' + b.__err);
    else {
      ok(b.kbdBorderBottom === '2px' && b.kbdTop >= 0.5 && b.kbdMono && b.kbdDisplay === 'inline-block' && b.kbdBg,
        `1 kbd 键帽实渲染（底厚边${b.kbdBorderBottom === '2px' ? '✓' : '✗'} 等宽${b.kbdMono ? '✓' : '✗'} 浅底${b.kbdBg ? '✓' : '✗'}）`);
      ok(b.emDefaultStyle === 'italic', '2 西文文章 em 保留 italic（默认形态不受影响）');
      ok(b.emCjkStyle === 'normal' && /dot/.test(b.tes),
        `2 中文文章 em 着重号（斜体退役${b.emCjkStyle === 'normal' ? '✓' : '✗'} 着重点${/dot/.test(b.tes) ? '✓' : '✗'}）`);
      ok(b.supPos === 'relative' && b.supLH === '0px' && b.supVA === 'baseline', '3 sub/sup normalize 计算样式（relative + line-height 0 + baseline）');
      ok(b.lineSameHeight, '3 含角标行与纯文本行等高（行距不被撑大实证）');
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
    global.__r74win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}
