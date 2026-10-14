'use strict';
/**
 * diag-r78-details.js — R78 阅读器收官三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 译文切换保位：原文⇄译文切换按比率恢复滚动位置（两容器高度不同，绝对像素会
 *    错位到别的段落；切前记比率 + 双 rAF 后按新高度恢复）
 *  2 译文容器微排版：盘古之白扩面到译文容器（此前只处理原文）+ 译文表格同享
 *    横滚容器缘提示 + 译文链接同享域名悬停/图链让位/锚点寻址语义
 *  3 pre 横滚提示同族：代码块右缘渐隐（与表格同语言；左缘避让语言标签只做右单侧）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r78-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    // ── Phase A：静态锚点 ──
    const readerSrc = read('src/renderer/views/reader.js');
    const css = read('src/renderer/styles/robin.css');
    ok(/R78-① 译文切换保位：原文⇄译文两容器高度不同[\s\S]*?const ratio = maxBefore > 0 \? clamp01\(scrollEl\.scrollTop \/ maxBefore\) : 0;/.test(readerSrc),
      '1 切换前比率记账在册（clamp01 防溢界）');
    ok(/requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => \{\s*\n\s*const maxAfter = scrollEl\.scrollHeight - scrollEl\.clientHeight;\s*\n\s*if \(maxAfter > 0\) scrollEl\.scrollTop = ratio \* maxAfter;/.test(readerSrc),
      '1 双 rAF 后按新高度比率恢复');
    ok(/R78-② 译文容器微排版[\s\S]*?CJKMicro\.insertGaps\(this\.translatedBody\);/.test(readerSrc),
      '2 盘古之白扩面译文容器（尊重 microTypography off 档）');
    ok(readerSrc.includes('this.translatedBody.querySelectorAll(\'.table-scroll\')') && /R78-② 译文表格同享横滚容器/.test(readerSrc),
      '2 译文表格同享横滚容器 + 缘提示');
    ok(readerSrc.includes("this._navigateToAnchor(href.slice(1));") && /译文内锚点同享寻址/.test(readerSrc),
      '2 译文链接三语义同享（域名悬停/图链让位/锚点寻址）');
    ok(css.includes('.reader-article pre.can-right::after') && css.includes('R78-③ 代码块横滚提示'),
      '3 pre 右缘渐隐规则在册（避让语言标签只做右单侧）');
    ok(readerSrc.includes("pre.dataset.njHintBound") && /R78-③：代码块横滚提示（高亮换壳后再量宽）/.test(readerSrc),
      '3 渲染端 pre 提示接线（高亮后量宽 + 滚轮监听幂等）');

    // ── Phase B：真实 UI 行为 ──
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(app.getPath('userData'));
    const uiWin = await openUIWindow();
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, uiWin);

    const longLine = 'X'.repeat(300);
    const filler = 'Filling paragraph to give the article enough body length for scroll testing without triggering extraction.'.repeat(12);
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R78 素材源', feedURL: 'https://r78.test/feed.xml' });
    const [entryID] = await store._applyParsedEntries(feed, [{
      id: 'r78-a1', title: '收官细节的文章', url: 'https://r78.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R78 素材。',
      contentHTML: `<p>Opening paragraph with enough words to be safe for the content governance.</p>` +
        `<pre><code>const sample = "${longLine}";</code></pre>` +
        `<p>${filler}</p><p>${filler}</p><p>${filler}</p>`,
    }]);
    ok(typeof entryID === 'string' && entryID.startsWith('local:'), `播种文章入库（entryID=${String(entryID).slice(0, 24)}…）`);

    await loadUI(uiWin);
    await sleep(1200);
    const b = await execJS(uiWin, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        window.__robinReaderOpen('${entryID}');
        const t0 = Date.now();
        let body = null;
        for (;;) {
          body = document.querySelector('.robin-body');
          if (body && body.querySelector('pre')) break;
          if (Date.now() - t0 > 12000) return { found: false };
          await sleep(50);
        }
        await sleep(400);
        const out = { found: true };
        // 3 pre 横滚提示：长行代码块溢出 → can-right
        const pre = body.querySelector('pre');
        out.preOverflow = pre.scrollWidth > pre.clientWidth;
        out.preCanRight = pre.classList.contains('can-right');
        pre.scrollLeft = pre.scrollWidth;
        pre.dispatchEvent(new Event('scroll'));
        await sleep(120);
        out.preCanRightEnd = pre.classList.contains('can-right');
        // 1 译文切换保位：滚到 50% → 注入整篇译文（高度不同）→ 切译文 → 比率恢复
        const reader = window.__robinReader;
        const scrollEl = document.querySelector('.reader-scroll');
        const max0 = scrollEl.scrollHeight - scrollEl.clientHeight;
        scrollEl.scrollTop = Math.round(max0 * 0.5);
        await sleep(80);
        reader._fullTranslation = { html: Array.from({ length: 24 }, (_, i) => '<p>译文第' + (i + 1) + '段：这是中文English混排的整篇译文段落，足够多以制造与原文不同的滚动高度。</p>').join('') + '<table><tbody><tr><td>译表</td></tr></tbody></table>' };
        reader._showFullTranslation('translated');
        await sleep(250); // 双 rAF + 布局稳定
        const tBody = reader.translatedBody;
        out.transShown = tBody && tBody.style.display !== 'none' && reader.body.style.display === 'none';
        const max1 = scrollEl.scrollHeight - scrollEl.clientHeight;
        out.ratioTranslated = max1 > 0 ? scrollEl.scrollTop / max1 : -1;
        // 2 译文微排版 + 表格容器
        out.transGap = tBody.querySelectorAll('.nj-gap').length;
        out.transTableWrapped = !!tBody.querySelector('.table-scroll table');
        // 1 切回原文：比率保持
        reader._showFullTranslation('original');
        await sleep(250);
        const max2 = scrollEl.scrollHeight - scrollEl.clientHeight;
        out.ratioOriginal = max2 > 0 ? scrollEl.scrollTop / max2 : -1;
        out.origShown = reader.body.style.display !== 'none' && tBody.style.display === 'none';
        return out;
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'r78-runtime');
    if (b.__err) ok(false, 'UI 实证探针异常 — ' + b.__err);
    else if (!b.found) ok(false, '阅读区未渲染（环境性）');
    else {
      ok(b.preOverflow === true && b.preCanRight === true && b.preCanRightEnd === false,
        `3 代码块横滚提示（溢出${b.preOverflow} can-right${b.preCanRight} 滚到尾退${!b.preCanRightEnd}）`);
      ok(b.transShown, '1 译文容器互换显示（原文隐/译文显）');
      ok(Math.abs(b.ratioTranslated - 0.5) < 0.1, `1 切译文按比率恢复（50% → ${(b.ratioTranslated * 100).toFixed(1)}%）`);
      ok(Math.abs(b.ratioOriginal - 0.5) < 0.1, `1 切回原文比率保持（50% → ${(b.ratioOriginal * 100).toFixed(1)}%）`);
      ok(b.origShown, '1 回切原文容器互换正确');
      ok(b.transGap > 0, `2 译文盘古之白生效（.nj-gap ×${b.transGap}）`);
      ok(b.transTableWrapped, '2 译文表格同享横滚容器');
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
    } catch (err) {
      console.error(`UI: load attempt ${attempt} failed — ${String(err && err.message || err)}`);
      if (attempt < 3) { try { await win.loadURL('about:blank'); } catch (_) { /* 原地再试 */ } }
    }
  }
  if (!loaded) throw new Error('UI 渲染层加载失败（3 次尝试均悬挂）');
}

async function openUIWindow() {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
  win.webContents.on('render-process-gone', (_e, details) => console.error('UI RENDER GONE:', details && details.reason));
  win.webContents.on('did-fail-load', (_e, code, desc) => console.error('UI LOAD FAIL:', code, desc));
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer:${level}] ${String(message).slice(0, 240)} (${path.basename(String(sourceId))}:${line})`);
  });
  return win;
}

async function execJS(win, js, label = 'step', ms = 30000) {
  return Promise.race([
    win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}
