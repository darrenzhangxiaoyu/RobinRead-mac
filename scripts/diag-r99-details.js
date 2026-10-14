'use strict';
/**
 * diag-r99-details.js — R99 commit 页头噪音簇清扫 + 进度线 0% 气泡静默探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 R99-① 清扫在册与接线：_stripCommitHeadNoise 挂 _classifyDiffTables 之后（diff 表分类是启用门）
 *  2 UI 行为（合成 commit 页，镜像安装版实测结构：h3 导航标题 + mega-div 内 17 链接/头像/h2/碎片/diff 表）：
 *    Browse 族与 SHA 链接清零、avatar CDN 头像清零、「Repository navigation」标题退场、
 *    作者碎片簇（and / <a>vincentkoc</a> authored / 5 file s changed）退场、
 *    h2 标题与长段落与 diff 表保全
 *  3 门控对照：无 diff 表的普通文章带同样噪音块 → 不清（零波及）
 *  4 R99-② 起点静默：data-pct="0%" 时端点气泡 ::after content 为 none
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r99-')));
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
    ok(readerSrc.includes('this._stripCommitHeadNoise(); // R99-①')
      && readerSrc.indexOf('_stripCommitHeadNoise(); // R99-①') > readerSrc.indexOf('_classifyDiffTables(); // R91-②'),
      '1 清扫器在册且挂 diff 表分类之后（分类是启用门）');
    ok(readerSrc.includes('avatars\\d*\\.githubusercontent\\.com')
      && readerSrc.includes('browse\\s+files|browse\\s+the\\s+repository'),
      '1 头像 CDN 与 Browse 族导航链接判据在册');
    ok(css.includes('.reading-progress[data-pct="0%"]::after { content: none; }'),
      '4 起点静默 CSS 在册（0% 档气泡退场）');

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
    const head = '<h3>Repository navigation</h3>'
      + '<div><a href="https://github.com/openclaw/openclaw"></a><div>'
      + '<a href="https://github.com/o/r/tree/abc">Browse files</a>'
      + '<a href="https://github.com/o/r/tree/abc">Browse the repository at this point in the history</a>'
      + '<a href="https://github.com/o/r/commit/1234567890abcdef">Commit 1234567</a>'
      + '<a href="https://github.com/o/r/commit/1234567890abcdef">1234567890abcdef</a>'
      + '<a href="https://github.com/o/r/commit/1234567890abcdef">Copy full SHA</a>'
      + '<a href="https://github.com/vincentkoc"><img src="https://avatars.githubusercontent.com/u/118?v=4" width="20" height="20" alt=""></a>'
      + '<h2>Commit d5e82b9</h2>'
      + '<p>and</p>'
      + '<p><a href="https://github.com/vincentkoc">vincentkoc</a> authored</p>'
      + '<p>5 file s changed</p>'
      + '<p>The commit message body explains the fix in detail and is long enough to count as an anchor paragraph well over fifty characters.</p>'
      + '<div>10 file s changed+ 178- 66Lines changed: 178 additions &amp; 66 deletions</div>'
      + '<p>3 file s changed</p>'
      + '<p>Browse the repository at this point in the historyBrowse files</p>'
      + '<div>Expand file tree Collapse file tree</div>'
      + '<p>Open diff view settings</p>'
      + '<pre>1 parent 060ba26\ncommit e902bed \nCopy full SHA for e902bed</pre>'
      + '<p>10 files changed the way we ship software in this release, here is why that matters for the team going forward.</p>'
      + `<table><tbody>${rows.join('')}</tbody></table></div></div>`;
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R99 素材源', feedURL: 'https://r99.test/feed.xml' });
    const [entryA] = await store._applyParsedEntries(feed, [{
      id: 'r99-a1', title: 'commit 页头噪音清扫', url: 'https://r99.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R99 素材。', contentHTML: head,
    }]);
    const [entryB] = await store._applyParsedEntries(feed, [{
      id: 'r99-b1', title: '门控对照（普通文章）', url: 'https://r99.test/x/2', publishedAt: Math.floor(Date.now() / 1000) - 3500,
      summary: 'R99 素材。',
      contentHTML: '<h3>Repository navigation</h3><p>普通文章没有 diff 表，清扫门不开启。</p>'
        + '<p><a href="https://github.com/o/r/tree/abc">Browse files</a>'
        + '<img src="https://avatars.githubusercontent.com/u/118?v=4" width="20" height="20" alt=""></p>'
        + '<p>正文照常。</p>',
    }]);
    await loadUI(uiWin);
    await sleep(1200);
    const a = await execJS(uiWin, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__robinReaderOpen('${entryA}');
      const t0 = Date.now();
      for (;;) {
        if (document.querySelector('.robin-body .nj-diff-table')) break;
        if (Date.now() - t0 > 12000) return { found: false };
        await sleep(50);
      }
      await sleep(300);
      const body = document.querySelector('.robin-body');
      const links = Array.from(body.querySelectorAll('a'));
      const navLeft = links.filter((x) => /^(browse|view commit|commit [0-9a-f]|copy full sha)/i.test((x.textContent || '').trim())
        || /^[0-9a-f]{7,40}$/i.test((x.textContent || '').trim())).length;
      const avatars = Array.from(body.querySelectorAll('img')).filter((im) => /avatars\\d*\\.githubusercontent\\.com/.test(im.getAttribute('src') || '')).length;
      const navHeading = Array.from(body.querySelectorAll('h3, h4, h5')).filter((h) => /navigation/i.test(h.textContent || '')).length;
      const text = body.textContent || '';
      const h2Kept = !!Array.from(body.querySelectorAll('h2')).find((h) => /d5e82b9/.test(h.textContent || ''));
      const longKept = text.includes('anchor paragraph');
      const diffKept = body.querySelectorAll('.nj-diff-table').length;
      const fragGone = !/(^|\\n)\\s*and\\s*(\\n|$)/.test(body.innerText) && !/authored/.test(text) && !/file s changed/.test(text);
      const statGone = !/additions\\s*&/.test(text) && !/Lines changed/.test(text);
      const uiGone = !/historyBrowse|file\\s+tree|diff\\s+view\\s+settings/i.test(text);
      const meta = body.querySelector('.nj-commit-meta');
      const metaClean = !!meta && /1 parent/.test(meta.textContent) && !/copy full sha/i.test(meta.textContent);
      const proseKept = text.includes('10 files changed the way we ship');
      return { navLeft, avatars, navHeading, h2Kept, longKept, diffKept, fragGone, statGone, uiGone, metaClean, proseKept, totalLinks: links.length };
    })()`);
    ok(a.found !== false, '2 合成 commit 页渲染就绪');
    ok(a.navLeft === 0, `2 Browse/SHA 导航链接清零（残 ${a.navLeft}）`);
    ok(a.avatars === 0, `2 avatar CDN 头像清零（残 ${a.avatars}）`);
    ok(a.navHeading === 0, '2 「Repository navigation」标题退场');
    ok(a.fragGone, '2 作者碎片簇退场（and / authored / 5 file s changed）');
    ok(a.statGone, '2 diffstat 小部件退场（±对/裸短/additions 三形态）');
    ok(a.uiGone, '2 拍平按钮文案退场（historyBrowse 粘连/file tree 双文案/settings）');
    ok(a.metaClean, '2 commit 元信息卡净化（Copy full SHA 按钮文案剥离，1 parent 保全）');
    ok(a.proseKept, '2 散文保全（"10 files changed the way…" 不误伤）');
    ok(a.h2Kept && a.longKept && a.diffKept >= 1, `2 内容保全（h2=${a.h2Kept} 长段=${a.longKept} diff表=${a.diffKept}）`);
    ok(a.totalLinks === 0, `2 作者碎片连带其链接整块清（正文链接数 ${a.totalLinks}）`);

    const b = await execJS(uiWin, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__robinReaderOpen('${entryB}');
      await sleep(700);
      const body = document.querySelector('.robin-body');
      return {
        browseKept: !!Array.from(body.querySelectorAll('a')).find((x) => /^browse files/i.test((x.textContent || '').trim())),
        avatarKept: !!Array.from(body.querySelectorAll('img')).find((im) => /avatars\\d*\\.githubusercontent\\.com/.test(im.getAttribute('src') || '')),
        textKept: (body.textContent || '').includes('正文照常'),
      };
    })()`);
    ok(b.browseKept && b.avatarKept && b.textKept, '3 门控对照：无 diff 表普通文章零波及（噪音块原样、正文保全）');

    const c = await execJS(uiWin, `(async () => {
      const track = document.getElementById('reading-progress');
      if (!track) return { no: true };
      track.dataset.pct = '0%';
      const none = getComputedStyle(track, '::after').content;
      track.dataset.pct = '42%';
      const shown = getComputedStyle(track, '::after').content;
      return { none, shown };
    })()`);
    ok(c.none === 'none' && /42%/.test(c.shown), `4 端点气泡 0% 静默/42% 显形（0% → ${c.none}，42% → ${c.shown}）`);

    console.log(failed === 0 ? 'ALL PASSED' : `FAILED: ${failed}`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (e) {
    console.error('ERROR', e);
    app.exit(2);
  }
});

// —— 与 r91 同构的窗口/加载/执行三件套 ——
async function openUIWindow() {
  return new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
}
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
async function execJS(win, js, label = 'step', ms = 30000) {
  return Promise.race([
    win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}
