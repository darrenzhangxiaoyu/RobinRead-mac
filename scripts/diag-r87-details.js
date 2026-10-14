'use strict';
/**
 * diag-r87-details.js — R87 长文折叠三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 折叠交互：长文（≥3 章 ≥10 块）h2 可点折叠（chevron/键盘 Enter·空格/拖选与链接不触发；
 *    短文不启用）
 *  2 跳转自动展开：TOC 刻度与文内锚点跳进折叠章先开门再滚
 *  3 折叠计数提示：「已折叠 N 段」胶囊（data-fold-hint 属性呈现——标题文本与 TOC 文案不受污染）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r87-')));
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
    const i18nSrc = read('src/main/I18NStrings.js');
    ok(/R87：长文章 h2 章节折叠[\s\S]*?if \(h2s\.length < 3 \|\| blocks\.length < 10\) return;/.test(readerSrc),
      '1 真长文门在册（≥3 章 ≥10 块）');
    ok(readerSrc.includes("if (!window.getSelection()?.isCollapsed) return; // 拖选标题文本不折叠"),
      '1 拖选标题文本不触发折叠');
    ok(readerSrc.includes("event.target.closest('a, button')") && /event\.key !== 'Enter' && event\.key !== ' '/.test(readerSrc),
      '1 标题内链接让位（click+keydown 双守卫）+ 键盘 Enter/空格可达');
    ok(readerSrc.includes('this._expandSectionOf(heading); // R87-②') && readerSrc.includes('this._expandSectionOf(target); // R87-②'),
      '2 TOC 刻度与锚点寻址双通道先开门再滚');
    ok(/nj-fold-head\[aria-expanded="false"\]\[data-fold-hint\]::before \{[^}]*?content: attr\(data-fold-hint\);/s.test(css),
      '3 折叠计数胶囊在册（attr 呈现——不污染标题文本）');
    ok(/\.nj-folded \{ display: none; \}/.test(css), '1 折叠块隐藏规则在册');
    ok(i18nSrc.includes('"已折叠 %lld 段": { zh: "已折叠 %lld 段", en: "%lld sections folded" }'), '3 计数文案双语键在册');

    // ── UI 行为 ──
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(app.getPath('userData'));
    const uiWin = await openUIWindow();
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, uiWin);
    const para = (n) => Array.from({ length: n }, () => '<p>长文折叠验证段落，制造真实章节体量分布。</p>').join('');
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R87 素材源', feedURL: 'https://r87.test/feed.xml' });
    const [entryID] = await store._applyParsedEntries(feed, [{
      id: 'r87-a1', title: '长文折叠的文章', url: 'https://r87.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R87 素材。',
      contentHTML: para(2) + '<h2 id="alpha">第一章</h2>' + para(4) + '<h2>第二章</h2>' + para(3) + '<p id="anchor-p">锚点目标段落。</p>' + '<h2>第三章</h2>' + para(3),
    }]);
    // 短文对照
    const [shortID] = await store._applyParsedEntries(feed, [{
      id: 'r87-a2', title: '短文不折叠', url: 'https://r87.test/x/2', publishedAt: Math.floor(Date.now() / 1000) - 3500,
      summary: 'R87 素材。',
      contentHTML: '<h2>一</h2><p>短。</p><h2>二</h2><p>文。</p><h2>三</h2><p>样本。</p>',
    }]);
    ok(typeof entryID === 'string' && typeof shortID === 'string', '播种长文+短文入库');
    await loadUI(uiWin);
    await sleep(1200);
    const b = await execJS(uiWin, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__robinReaderOpen('${entryID}');
      const t0 = Date.now();
      let h2a = null;
      for (;;) {
        h2a = document.querySelector('.robin-body h2[data-nj-anchor="alpha"]');
        if (h2a) break;
        if (Date.now() - t0 > 12000) return { found: false };
        await sleep(50);
      }
      await sleep(400);
      const out = { found: true };
      out.foldable = h2a.classList.contains('nj-fold-head') && h2a.getAttribute('tabindex') === '0' && h2a.getAttribute('aria-expanded') === 'true';
      const h2aText = h2a.textContent;
      // 1 点击折叠：后续块隐藏 + aria 收起 + 计数
      h2a.click();
      await sleep(120);
      const folded = document.querySelectorAll('.robin-body .nj-folded');
      out.foldedCount = folded.length;
      out.ariaFolded = h2a.getAttribute('aria-expanded') === 'false';
      out.hint = h2a.dataset.foldHint || '';
      out.headTextClean = h2a.textContent === h2aText; // 计数走 attr：标题文本零污染
      out.chevFolded = getComputedStyle(h2a, '::after').content;
      const hintShown = getComputedStyle(h2a, '::before').content;
      out.hintShown = /已折叠/.test(String(hintShown)) && /4/.test(String(hintShown));
      // 2 锚点跳进折叠章：自动展开
      const anchorP = document.querySelector('.robin-body [data-nj-anchor="anchor-p"]');
      // anchor-p 在第二章（未折叠）——先折第二章再验自动展开
      const h2b = [...document.querySelectorAll('.robin-body h2')][1];
      h2b.click();
      await sleep(120);
      out.anchorHidden = anchorP.classList.contains('nj-folded');
      document.querySelector('.robin-body a[href="#anchor-p"]')?.click();
      // 无现成锚链：直接走 _navigateToAnchor 通道（与链接触达同一方法）
      window.__robinReader._navigateToAnchor('anchor-p');
      await sleep(150);
      out.autoExpanded = !anchorP.classList.contains('nj-folded') && h2b.getAttribute('aria-expanded') === 'true';
      // 1 键盘：focus 第三章 + 空格折叠
      const h2c = [...document.querySelectorAll('.robin-body h2')][2];
      h2c.focus();
      h2c.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
      await sleep(120);
      out.kbdFolded = h2c.getAttribute('aria-expanded') === 'false';
      // 再展开第一章（还原现场）
      h2a.click();
      await sleep(50);
      // 1 短文不启用
      window.__robinReaderOpen('${shortID}');
      await sleep(900);
      const sh = document.querySelector('.robin-body h2');
      out.shortClean = sh ? !sh.classList.contains('nj-fold-head') : null;
      return out;
    })()`, 'r87-live');
    if (b.__err) ok(false, '行为探针异常 — ' + b.__err);
    else if (!b.found) ok(false, '阅读区未渲染（环境性）');
    else {
      ok(b.foldable, '1 长文 h2 折叠头在册（role=button + chevron）');
      ok(b.foldedCount === 4 && b.ariaFolded, `1 点击折叠后续块（${b.foldedCount}/4 隐藏，aria=${b.ariaFolded}）`);
      ok(b.kbdFolded, '1 键盘空格折叠可达');
      ok(b.shortClean === true, '1 短文不启用（无折叠头）');
      ok(b.headTextClean && b.hintShown, `3 计数胶囊（attr 呈现=${b.hintShown} 标题文本零污染=${b.headTextClean}）`);
      ok(b.anchorHidden && b.autoExpanded, `2 锚点跳进折叠章自动展开（先隐${b.anchorHidden} → 开门${b.autoExpanded}）`);
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
