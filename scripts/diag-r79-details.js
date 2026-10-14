'use strict';
/**
 * diag-r79-details.js — R79 版面艺术品位三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 lead 首段：首段 1.07em 导语（缩进式段落传统下让位）
 *  2 h2 章节竖标：左缘 accent 竖条（发丝下划线退役；h3 保留下划线区分子级）
 *  3 行长护栏（R89/R95 演进）：任意深度文本块 48em 居中「文字通道」；图/裸图/代码同轴等宽（不再全幅——用户定案图文同轴）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r79-')));
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
    ok(/R79-① lead 首段[\s\S]*?\.robin-body > p:first-of-type \{ font-size: 1\.07em; max-width: calc\(48em \/ 1\.07\); \}/.test(css),
      '1 lead 首段规则在册（通道除回 1.07 与后续段落同轴——R1 审查修正）');
    ok(/body\[data-reader-para="indent"\] \.robin-body > p:first-of-type \{ font-size: inherit; \}/.test(css), '1 缩进式让位规则在册');
    const h2Block = (/\.reader-article h2:not\(:first-child\) \{([^}]*)\}/.exec(css) || [])[1] || '';
    ok(h2Block.includes('border-bottom: none') && !h2Block.includes('border-left'),
      '2 h2 下划线退役（U5-② accent 短横线成为唯一章节标记）');
    ok(/\.robin-body :where\(p, ul, ol, dl, blockquote\):not\(:is\(table, pre, \.table-scroll\) \*\) \{[\s\S]*?max-width: 48em;[\s\S]*?margin-right: auto;/.test(css)
      && /\.reader-article\.cjk-em \.robin-body :where[\s\S]*?max-width: 54em;/.test(css),
      '3 行长护栏规则在册（R89 任意深度五类文本块 + auto 居中；R95 定案 48em/中文 54em）');

    // ── UI 实证（直接挂载，r74 同款轻量法）──
    const win = new BrowserWindow({
      show: false, width: 1280, height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    global.__r79win = win;
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1000);
    const b = await exec(`(() => {
      const out = {};
      const art = document.createElement('div');
      art.className = 'reader-article';
      art.innerHTML =
        '<div class="robin-body">' +
        '<p id="lead-p">首段导语样本。</p>' +
        '<h2>章节一</h2>' +
        '<p id="body-p">后续正文段落样本。</p>' +
        '<h3>子节</h3>' +
        '<figure><img src="x" width="600" height="400"></figure>' +
        '<ul><li>列表项</li></ul>' +
        '</div>';
      document.body.appendChild(art);
      const cs = (el) => getComputedStyle(el);
      const lead = art.querySelector('#lead-p');
      const bodyP = art.querySelector('#body-p');
      out.leadBigger = parseFloat(cs(lead).fontSize) > parseFloat(cs(bodyP).fontSize);
      out.leadRatio = parseFloat(cs(lead).fontSize) / parseFloat(cs(bodyP).fontSize);
      const h2 = art.querySelector('h2');
      const h3 = art.querySelector('h3');
      out.h2Bar = cs(h2).borderBottomWidth === '0px' && parseFloat(cs(h2, '::before').width) > 0;
      out.h3Underline = cs(h3).borderBottomWidth !== '0px';
      // 行长护栏（R89/R95）：文本块 ≤48em 居中；figure 与文字同轴等宽
      const em = parseFloat(cs(bodyP).fontSize);
      const pw = bodyP.getBoundingClientRect().width;
      out.pCapped = pw <= 48 * em + 2;
      const cw = art.getBoundingClientRect().width;
      out.pCentered = Math.abs((art.getBoundingClientRect().left + (cw - pw) / 2) - bodyP.getBoundingClientRect().left) < 2;
      const fig = art.querySelector('figure');
      out.figCoAxis = Math.abs(fig.getBoundingClientRect().width - pw) <= 2;
      // 缩进式让位
      document.body.dataset.readerPara = 'indent';
      out.leadIndentYield = cs(lead).fontSize === cs(bodyP).fontSize;
      delete document.body.dataset.readerPara;
      art.remove();
      return out;
    })()`, 'r79-runtime');
    if (b.__err) ok(false, 'UI 实证探针异常 — ' + b.__err);
    else {
      ok(b.leadBigger && Math.abs(b.leadRatio - 1.07) < 0.02, `1 lead 首段导语放大（ratio=${b.leadRatio.toFixed(3)}）`);
      ok(b.leadIndentYield, '1 缩进式段落传统下让位');
      ok(b.h2Bar, '2 h2 下划线退役实渲染（U5-② 短横线仍在场）');
      ok(b.h3Underline, '2 h3 保留发丝下划线（子级区分）');
      ok(b.pCapped && b.pCentered, `3 文本块 ≤48em 居中通道（width=${b.pCapped ? '≤48em' : '超限'} 居中${b.pCentered ? '✓' : '✗'}）`);
      ok(b.figCoAxis, '3 图文同轴等宽（R95 用户定案：图与文字通道一致）');
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
    global.__r79win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}
