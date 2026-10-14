'use strict';
/**
 * diag-r91-details.js — R91/R94 diff 表语义化 + patch 着色 + commit 元信息卡探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 R91-② diff 表：GitHub 形态（多行 + 等宽主导 / ± 行密度）→ nj-diff-table；
 *    行级语义（+ → nj-d-add / - → nj-d-del / @@ → nj-d-hunk）、纯数字首列 → nj-ln 行号槽
 *  2 R94-① patch 块：无 code 子元素的裸 pre 命中 diff 特征 → data-nj-patch + hljs 行级着色 + 软换行
 *  3 R94-② commit 元信息卡：「Copy full SHA / N parents」pre → nj-commit-meta 信息卡形态
 *  4 R91-① 普通数据表卡片基座：横线律（无竖线）+ 圆角外框
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r91-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const css = read('src/renderer/styles/robin.css');
    const readerSrc = read('src/renderer/views/reader.js');
    // ── 静态锚点 ──
    ok(readerSrc.includes('_classifyDiffTables()') && readerSrc.includes("table.classList.add('nj-diff-table')"),
      '1 diff 表分类器在册（渲染管线接线 + 类标记）');
    ok(readerSrc.includes("tr.classList.add('nj-d-add')") && readerSrc.includes("tr.classList.add('nj-d-del')")
      && readerSrc.includes("tr.classList.add('nj-d-hunk')") && readerSrc.includes("first.classList.add('nj-ln')"),
      '1 行级语义与行号槽类标记在册');
    ok(/table\.nj-diff-table[\s\S]{0,400}white-space: pre-wrap; overflow-wrap: anywhere;/.test(css)
      && /\.nj-diff-table tr\.nj-d-add td \{ background: rgba\(46, 160, 67, 0\.10\); \}/.test(css)
      && /\.nj-diff-table tr\.nj-d-del td \{ background: rgba\(248, 81, 73, 0\.10\); \}/.test(css),
      '1 diff 表 CSS（± 行底色 + 软换行）在册');
    ok(readerSrc.includes("pre.dataset.njPatch = '1'") && readerSrc.includes("pre.dataset.lang = 'patch'"),
      '2 裸 pre patch 识别在册（njPatch + lang 角标）');
    ok(/pre\[data-nj-patch\] \{[\s\S]*?white-space: pre-wrap;[\s\S]*?overflow-wrap: anywhere;/s.test(css)
      && css.includes('.reader-article pre[data-nj-patch] .hljs-addition { background: rgba(46, 160, 67, 0.13); }'),
      '2 patch CSS（软换行 + hljs 行级出血着色）在册');
    ok(readerSrc.includes("pre.classList.add('nj-commit-meta')") && /pre\.nj-commit-meta \{[\s\S]*?font-family: var\(--font-sans\);/s.test(css),
      '3 commit 元信息卡（JS 标记 + sans 信息卡形态）在册');
    ok(css.includes('.reader-article th, .reader-article td {\n  border: none;')
      && css.includes('border-bottom: 1px solid color-mix(in srgb, var(--separator) 55%, transparent);'),
      '4 普通数据表横线律在册（竖线退场）');

    // ── UI 行为 ──
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(app.getPath('userData'));
    const { registerIPCHandlers } = require('../src/main/ipc');
    const uiWin = await openUIWindow();
    registerIPCHandlers(store, uiWin);
    const rows = [];
    rows.push('<tr><td>10</td><td><code>@@ -1,4 +1,6 @@</code></td></tr>');
    rows.push('<tr><td>11</td><td><code> module.exports = {}</code></td></tr>');
    rows.push('<tr><td>12</td><td><code>+const fixed = true</code></td></tr>');
    rows.push('<tr><td>13</td><td><code>+const also = 2</code></td></tr>');
    rows.push('<tr><td>14</td><td><code>-const broken = false</code></td></tr>');
    rows.push('<tr><td>15</td><td><code>+const third = 3</code></td></tr>');
    rows.push('<tr><td>16</td><td><code> module.exports.fixed = fixed</code></td></tr>');
    rows.push('<tr><td>17</td><td><code>-module.exports.broken = broken</code></td></tr>');
    const patchText = [
      'diff --git a/src/app.js b/src/app.js',
      'index 1234567..89abcde 100644',
      '@@ -10,7 +10,7 @@ function run() {',
      '  const a = 1;',
      '+  const b = 2;',
      '-  const c = 3;',
      '  return a + b;',
    ].join('\n');
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R91 素材源', feedURL: 'https://r91.test/feed.xml' });
    const [entryID] = await store._applyParsedEntries(feed, [{
      id: 'r91-a1', title: 'diff 形态治理', url: 'https://r91.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R91 素材。',
      contentHTML: `<p>diff 形态治理样例。</p><table><tbody>${rows.join('')}</tbody></table>`
        + `<pre>diff --git a/x b/x\nindex 1..2 100644\n@@ -1,2 +1,2 @@\n-a\n+b\n</pre>`
        + `<pre>1 parent abc1234\ncommit def5678 \nCopy full SHA for def5678</pre>`,
    }]);
    await loadUI(uiWin);
    await sleep(1200);
    const b = await execJS(uiWin, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__robinReaderOpen('${entryID}');
      const t0 = Date.now();
      for (;;) {
        if (document.querySelector('.robin-body table')) break;
        if (Date.now() - t0 > 12000) return { found: false };
        await sleep(50);
      }
      await sleep(1500);
      const out = { found: true };
      const t = document.querySelector('.robin-body table');
      out.diffCls = t.classList.contains('nj-diff-table');
      out.add = document.querySelectorAll('.robin-body tr.nj-d-add').length;
      out.del = document.querySelectorAll('.robin-body tr.nj-d-del').length;
      out.hunk = document.querySelectorAll('.robin-body tr.nj-d-hunk').length;
      out.ln = document.querySelectorAll('.robin-body td.nj-ln').length;
      const pres = Array.from(document.querySelectorAll('.robin-body pre'));
      const patch = pres.find(p => p.dataset.njPatch === '1');
      out.patchMarked = !!patch;
      out.patchAdd = patch ? patch.querySelectorAll('.hljs-addition').length : 0;
      out.patchDel = patch ? patch.querySelectorAll('.hljs-deletion').length : 0;
      out.patchWrap = patch ? getComputedStyle(patch).whiteSpace : null;
      out.patchLang = patch ? patch.dataset.lang : null;
      const meta = pres.find(p => p.classList.contains('nj-commit-meta'));
      out.metaMarked = !!meta;
      out.metaFont = meta ? getComputedStyle(meta).fontFamily : null;
      out.lnBg = (function () { const ln = document.querySelector('.robin-body td.nj-ln'); return ln ? getComputedStyle(ln).textAlign : null; })();
      return out;
    })()`, 'r91-live');
    if (b.__err) ok(false, '行为探针异常 — ' + b.__err);
    else if (!b.found) ok(false, '阅读区未渲染（环境性）');
    else {
      ok(b.diffCls, '1 diff 表分类命中');
      ok(b.add === 3 && b.del === 2, `1 ± 行语义（+${b.add}/-${b.del}）`);
      ok(b.hunk === 1, `1 @@ 分段带（${b.hunk}）`);
      ok(b.ln >= 8, `1 行号槽全列命中（${b.ln}/8）`);
      ok(b.patchMarked && b.patchAdd >= 1 && b.patchDel >= 1, `2 裸 pre patch 着色（标记${b.patchMarked} +${b.patchAdd} -${b.patchDel}）`);
      ok(String(b.patchWrap).includes('pre-wrap') && b.patchLang === 'patch', `2 patch 软换行 + PATCH 角标（${b.patchWrap}/${b.patchLang}）`);
      ok(b.metaMarked && String(b.metaFont).toLowerCase().includes('sans'), `3 commit 元信息卡（${b.metaMarked}/${String(b.metaFont).slice(0, 24)}）`);
      ok(b.lnBg === 'right', `1 行号槽右对齐（${b.lnBg}）`);
    }

    uiWin.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});

async function loadUI(win) {
  let loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt += 1) {
    try {
      await Promise.race([
        win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html')),
        new Promise((_, reject) => setTimeout(() => reject(new Error('loadFile timeout')), 25000)),
      ]);
      loaded = true;
    } catch (_) {
      if (attempt < 3) { try { await win.loadURL('about:blank'); } catch (_) { /* 原地再试 */ } }
    }
  }
  if (!loaded) throw new Error('UI 渲染层加载失败');
}

async function openUIWindow() {
  return new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
}

async function execJS(win, js, label = 'step', ms = 30000) {
  return Promise.race([
    win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}
