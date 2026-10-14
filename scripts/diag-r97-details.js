'use strict';
/**
 * diag-r97-details.js — R94-②/R95/R97 头部秩序 + 空洞收紧探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 R97-① 头部动作分层：核心键（听 + 阅读原文）外全部收进「更多」浮层——浮层存在性、
 *    收纳数量、开合行为（点击开 / 外点关 / Esc 关）；标签 chips 上限 6→3
 *  2 R94-② 标题→正文空洞收紧：divider 20/26 → 12/16 + 版心顶槽 32 → 22（两级 margin 相加
 *    不再形成 100px+ 空洞）
 *  3 R95 段落节奏保持锚：p 1.35em 段距 / 标题 1.9em 0.7em 节奏不被本轮改动回归
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r97-')));
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
    ok(readerSrc.includes("dataset?.role === 'read-original'") && readerSrc.includes("'nj-header-more-pop'")
      && readerSrc.includes('actions.replaceChildren(...core, moreBtn)'),
      '1 头部动作分层 JS 在册（核心键标记 + 浮层收纳 + replaceChildren）');
    ok(/\.nj-header-more-pop \{[\s\S]*?position: absolute;[\s\S]*?display: none;[\s\S]*?\.nj-header-more-pop\.open \{ display: flex; \}/s.test(css),
      '1 浮层 CSS（绝对定位 + open 开合）在册');
    ok(readerSrc.includes('.slice(0, 3); // R97-①'), '1 标签 chips 上限 3 在册');
    ok(/\.robin-header-divider \{[\s\S]*?margin: 12px auto 16px;/s.test(css)
      && /\.reader-article \.robin-header-divider,[\s\S]*?margin: 12px auto 16px;[\s\S]*?--article-font-size, 17px\) \* 48/.test(css),
      '2 divider 收紧 12/16 + R104 与正文通道同缘（auto + 48 链帽）在册');
    ok(/\.reader-article \{[\s\S]*?padding: 22px var\(--article-gutter\) 0;/s.test(css), '2 版心顶槽 22px 在册');
    ok(/\.reader-article p \{ margin: 0 0 1\.35em;/.test(css)
      && /\.reader-article h1, \.reader-article h2, \.reader-article h3,[\s\S]*?margin: 1\.4em 0 0\.45em;/.test(css),
      '3 段落节奏基线（1.35em 段距 + R100 标题 1.4em/0.45em 收紧）');

    // ── UI 行为 ──
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(app.getPath('userData'));
    const { registerIPCHandlers } = require('../src/main/ipc');
    const uiWin = await openUIWindow();
    registerIPCHandlers(store, uiWin);
    const para = '头部秩序验证用正文段落。'.repeat(40);
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R97 素材源', feedURL: 'https://r97.test/feed.xml' });
    const [entryID] = await store._applyParsedEntries(feed, [{
      id: 'r97-a1', title: '头部秩序', url: 'https://r97.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R97 素材。',
      contentHTML: `<p>${para}</p>`,
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
      const meta = document.querySelector('.robin-header-meta');
      const actions = meta.querySelector('.robin-header-original-actions');
      const pop = meta.querySelector('.nj-header-more-pop');
      out.inlineBtns = actions ? actions.querySelectorAll('.btn-text').length : 0;
      out.inlineHasRead = actions ? !!actions.querySelector('[data-role="read-original"]') : false;
      out.popExists = !!pop;
      out.popBtns = pop ? pop.querySelectorAll('.btn-text').length : 0;
      out.chips = document.querySelectorAll('.robin-tag-chip').length;
      if (pop) {
        const more = actions.querySelector('.nj-header-more');
        more.click();
        await sleep(150);
        out.openAfterClick = pop.classList.contains('open');
        document.body.click();
        await sleep(150);
        out.closedByOutside = !pop.classList.contains('open');
        more.click();
        await sleep(150);
        const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
        document.dispatchEvent(ev);
        await sleep(150);
        out.closedByEsc = !pop.classList.contains('open');
      }
      const divider = getComputedStyle(document.querySelector('.robin-header-divider'));
      out.dividerMargin = divider.marginTop + '/' + divider.marginBottom;
      const art = document.querySelector('.reader-article');
      out.artPadTop = getComputedStyle(art).paddingTop;
      return out;
    })()`, 'r97-live');
    if (b.__err) ok(false, '行为探针异常 — ' + b.__err);
    else if (!b.found) ok(false, '阅读区未渲染（环境性）');
    else {
      ok(b.popExists && b.popBtns >= 3, `1 浮层收纳（存在${b.popExists} 收纳 ${b.popBtns} 键）`);
      ok(b.inlineBtns <= 3 && b.inlineHasRead, `1 核心行收敛（${b.inlineBtns} 键，含阅读原文）`);
      ok(b.openAfterClick && b.closedByOutside && b.closedByEsc,
        `1 浮层开合（点击${b.openAfterClick}/外关${b.closedByOutside}/Esc${b.closedByEsc}）`);
      ok(b.chips <= 3, `1 标签 chips ≤3（${b.chips}）`);
      ok(b.dividerMargin === '12px/16px', `2 divider 实算（${b.dividerMargin}）`);
      ok(b.artPadTop === '22px', `2 版心顶槽实算（${b.artPadTop}）`);
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
