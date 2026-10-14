'use strict';
/**
 * diag-r96-details.js — R96 正文边缘净化探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 头部噪音清除：头像小图块（≤140px 已知宽）/「阅读原文·关注」短引导/链接农场——
 *    遇标题或 ≥50 字实文即停（保守门），绝不深清正文
 *  2 尾部链接农场清除（「相关阅读」链接堆，最多 3 块）
 *  3 正文保全：实文段落、正文图片、正常链接段落不受牵连
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r96-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const readerSrc = read('src/renderer/views/reader.js');
    // ── 静态锚点 ──
    ok(readerSrc.includes('_stripBoilerplateEdges()') && readerSrc.includes('JUNK_TEXT_RE'),
      '1 净化器接线 + 垃圾文案判据在册');
    ok(readerSrc.includes('links.length >= 3') && readerSrc.includes('0.7'),
      '1 链接农场判据在册（≥3 链接且 70% 链接文字）');
    ok(readerSrc.includes('guard = 6') && readerSrc.includes('guard = 3'),
      '1 头 6 尾 3 浅层上限在册');
    ok(readerSrc.includes("text.length >= 50) break;") || /text\.length >= 50[\s\S]{0,80}break/.test(readerSrc),
      '1 实文停扫门在册（≥50 字不动）');

    // ── UI 行为 ──
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(app.getPath('userData'));
    const { registerIPCHandlers } = require('../src/main/ipc');
    const uiWin = await openUIWindow();
    registerIPCHandlers(store, uiWin);
    const real = '这是正文第一段的实质性内容，用来验证净化器遇到足够长的真实文字段落时会立即停止清扫，绝不误伤正文。'.repeat(3);
    const real2 = '第二段正文内容，验证正文完整保留。'.repeat(4);
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R96 素材源', feedURL: 'https://r96.test/feed.xml' });
    const [entryID] = await store._applyParsedEntries(feed, [{
      id: 'r96-a1', title: '边缘净化', url: 'https://r96.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R96 素材。',
      contentHTML: `<p><img src="https://r96.test/avatar.png" width="80" height="80" alt="头像"></p>`
        + `<p><a href="https://r96.test/orig">阅读原文</a> · <a href="https://r96.test/follow">关注我们</a></p>`
        + `<p>相关推荐：<a href="https://r96.test/1">帖子一</a> <a href="https://r96.test/2">帖子二</a> <a href="https://r96.test/3">帖子三</a> <a href="https://r96.test/4">帖子四</a></p>`
        + `<p>${real}</p><p>${real2}</p>`
        + `<p>延伸阅读：<a href="https://r96.test/t1">尾链一</a> <a href="https://r96.test/t2">尾链二</a> <a href="https://r96.test/t3">尾链三</a></p>`,
    }]);
    await loadUI(uiWin);
    await sleep(1200);
    const b = await execJS(uiWin, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__robinReaderOpen('${entryID}');
      const t0 = Date.now();
      for (;;) {
        if (document.querySelector('.robin-body p')) break;
        if (Date.now() - t0 > 12000) return { found: false };
        await sleep(50);
      }
      await sleep(1500);
      const out = { found: true };
      const body = document.querySelector('.robin-body');
      out.text = (body.innerText || '').slice(0, 400);
      out.hasAvatar = !!body.querySelector('img[src*="avatar"]');
      out.hasReadOrig = /阅读原文/.test(body.innerText || '');
      out.hasRelHead = /相关推荐/.test(body.innerText || '');
      out.hasTailFarm = /延伸阅读/.test(body.innerText || '');
      out.firstP = (body.querySelector('p') || { textContent: '' }).textContent.trim().slice(0, 20);
      out.pCount = body.querySelectorAll('p').length;
      return out;
    })()`, 'r96-live');
    if (b.__err) ok(false, '行为探针异常 — ' + b.__err);
    else if (!b.found) ok(false, '阅读区未渲染（环境性）');
    else {
      ok(!b.hasAvatar && !b.hasReadOrig && !b.hasRelHead, `1 头部三连噪音清除（头像${b.hasAvatar}/原文${b.hasReadOrig}/关联${b.hasRelHead}）`);
      ok(!b.hasTailFarm, `2 尾部链接农场清除（${!b.hasTailFarm}）`);
      ok(b.firstP.includes('实质性内容') || b.firstP.includes('正文第一段'), `3 实文保全（首段「${b.firstP}」）`);
      ok(b.pCount >= 2, `3 正文段落在位（${b.pCount}）`);
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
    show: false, width: 1400, height: 900,
    webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
}

async function execJS(win, js, label = 'step', ms = 30000) {
  return Promise.race([
    win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}
