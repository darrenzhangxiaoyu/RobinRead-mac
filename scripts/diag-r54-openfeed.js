'use strict';
/**
 * diag-r54-openfeed.js — R54 开卷体验三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 简报缓存落顶（真 bug 修复）：renderInto 仅流式分支跟随落底，缓存命中从报头读起（UI 行为 + 静态锚点）
 *  2 文章微入场：.reader-article 挂 nj-article-enter（--dur-fast/--ease-out 令牌，160ms 级），
 *    动画结束自清理，翻页动效在场时让位；reduced-motion 全局收敛块兜底
 *  3 续读提示降噪：R18 提醒契约保持（有记忆 → 提示、落位正确）；
 *    延迟窗口内已先行翻页 → 过时提示安静跳过；audit 锚点（pointer-events none / 单实例计时器）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r54-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    // ── 1. 静态锚点：缓存落顶修复 ──
    const appSrc = read('src/renderer/app.js');
    ok(appSrc.includes('if (job.streaming && nearBottom) body.scrollTop = body.scrollHeight;'),
      '1 renderInto 仅流式分支跟随落底（job.streaming 门控）');
    ok(appSrc.includes('else body.scrollTop = prevTop;'),
      '1 非流式渲染重绘保位（缓存首帧 prevTop=0 即落顶）');
    ok(!appSrc.includes('if (nearBottom) body.scrollTop = body.scrollHeight;'),
      '1 旧的无条件落底语句已移除（真 bug 退场）');

    // ── 2. 静态锚点：文章微入场 ──
    const readerSrc = read('src/renderer/views/reader.js');
    ok(readerSrc.includes("article.classList.add('nj-article-enter')"),
      '2 reader _render 挂微入场类');
    ok(readerSrc.includes("article.addEventListener('animationend', () => article.classList.remove('nj-article-enter'), { once: true })"),
      '2 动画结束自清理（once 监听）');
    ok(/if \(this\._pageTurn\) \{[\s\S]*?\} else \{\s*\/\/ R54 文章微入场/.test(readerSrc),
      '2 翻页动效在场时让位（else 分支不叠两场）');
    const css = read('src/renderer/styles/robin.css');
    ok(css.includes('@keyframes njArticleEnter') && css.includes('scale(0.985)'),
      '2 微入场关键帧在位（淡入 + 0.985→1）');
    ok(css.includes('.nj-article-enter { animation: njArticleEnter var(--dur-fast) var(--ease-out) both; }'),
      '2 微入场消费 --dur-fast/--ease-out 令牌（无裸时长）');
    ok(/@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{\s*animation-duration: 0\.01ms !important;/m.test(css),
      '2 全局 reduced-motion 收敛块兜底新动画');

    // ── 3. 静态锚点：续读提示降噪 audit ──
    const erSrc = read('src/renderer/views/edition-reader.js');
    ok(erSrc.includes('if (this.open && this.index === this.startIndex) this._notice('),
      '3 过时提示安静跳过（已先行翻页不再补提示）');
    ok(erSrc.includes('clearTimeout(this._noticeT)'),
      '3 audit：单实例计时器（新提示清旧计时，不叠显）');
    ok(/\.er-notice \{[^}]*pointer-events: none;/.test(css),
      '3 audit：提示层 pointer-events none（不打断焦点/点击）');
    ok(/\.er-notice \{[^}]*z-index: 85;/.test(css),
      '3 audit：提示层局部 z=85 小胶囊（不叠满屏）');

    // ── UI 行为断言（真 IPC 开窗，f36 同款）──
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(app.getPath('userData'));
    const uiWin = await openUIWindow();
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, uiWin);

    // 播种：当日缓存简报（超长内容制造溢出）+ 一篇文章（微入场载体）
    const longLines = ['## 总览', '今日简报正文（R54 缓存落顶载体）。'];
    for (let i = 0; i < 160; i += 1) longLines.push(`- 要点 ${i + 1}：这是一段足够长的简报条目，用于让简报正文溢出可视区制造滚动。`);
    store._saveTodayDigest(longLines.join('\n'), 160, [], 'brief');
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R54 素材源', feedURL: 'https://r54.test/feed.xml' });
    // 正文 ≥400 字：避开「显示不全治理」的补抓网络分支（离线确定性）
    const filler = '这是一篇用于验证微入场的文章正文，足够长以避开正文补抓阈值。'.repeat(20);
    const [entryID] = await store._applyParsedEntries(feed, [{
      id: 'r54-a1', title: '微入场的文章', url: 'https://r54.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R54 微入场素材。', contentHTML: `<p>第一段。</p><p>${filler}</p>`,
    }]);
    ok(typeof entryID === 'string' && entryID.startsWith('local:'), `播种文章入库（entryID=${String(entryID).slice(0, 30)}…）`);

    console.log('UI: loading renderer…');
    await loadUI(uiWin);
    await sleep(1200);

    // ── 1（行为）：缓存简报打开落在报头 ──
    const digest = await execJS(uiWin, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); } };
      try {
        document.querySelector('#digest-btn')?.click();
        const body = await waitFor(() => document.querySelector('.digest-modal .digest-body:not(.loading)'));
        if (!body) return { found: false };
        await sleep(700); // 等 rAF 合帧渲染 + 顶部挂件（目标/胶囊/生物钟）落定
        const top = body.scrollTop;
        const overflow = body.scrollHeight > body.clientHeight;
        const scrollHeight = body.scrollHeight;
        const clientHeight = body.clientHeight;
        document.querySelector('.digest-modal')?.closest('.modal-overlay')?.remove();
        return { found: true, top, overflow, scrollHeight, clientHeight };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'digest-open');
    if (digest.__err) ok(false, '1 缓存简报探针异常 — ' + digest.__err);
    else if (!digest.found) ok(false, '1 缓存简报浮层未打开（环境性）');
    else {
      ok(digest.overflow === true, `1 播种内容确已溢出（scrollHeight=${digest.scrollHeight} > clientHeight=${digest.clientHeight}）`);
      ok(digest.top === 0, `1 缓存命中打开落在报头（scrollTop=${digest.top}，期望 0）`);
    }

    // ── 2（行为）：文章打开微入场（入场类在场 → 动画结束自清理）──
    const enter = await execJS(uiWin, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        window.__robinReaderOpen('${entryID}');
        const t0 = Date.now();
        for (;;) {
          const el = document.querySelector('.reader-article');
          if (el) return { entered: el.classList.contains('nj-article-enter'), waitMs: Date.now() - t0 };
          if (Date.now() - t0 > 12000) return { entered: null };
          await sleep(16); // 高频轮询捕捉 ~180ms 入场窗口
        }
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'article-enter');
    if (enter.__err) ok(false, '2 微入场探针异常 — ' + enter.__err);
    else if (enter.entered === null) ok(false, '2 阅读区未渲染出 .reader-article');
    else ok(enter.entered === true, `2 文章打开即挂微入场类（轮询 ${enter.waitMs}ms 内命中）`);
    // 隐藏窗合成器帧率极低（~1 帧/850ms），180ms 合成器动画的 animationend 不以墙钟到点——
    // 清理接线改用合成 animationend 断言（once 监听 + 移除类），确定性等价
    const enterClean = await execJS(uiWin, `(() => {
      const el = document.querySelector('.reader-article');
      if (!el) return { left: false, still: false };
      el.dispatchEvent(new AnimationEvent('animationend', { animationName: 'njArticleEnter', bubbles: true }));
      return { left: !el.classList.contains('nj-article-enter'), still: Boolean(document.querySelector('.reader-article')) };
    })()`, 'article-enter-clean');
    ok(enterClean.left === true, `2 animationend 接线：收尾即自清理（合成事件；文章仍在场=${enterClean.still}）`);

    // ── 3（行为）：续读提醒契约 + 过时跳过（diag-edition-resume 同款直开）──
    const resumeA = await execJS(uiWin, `(async () => {
      const mod = await import('./views/edition-reader.js');
      const mk = (i) => ({ id: 'r54-' + i, title: '条目 ' + i, summaryPreview: '摘要 ' + i, sourceTitle: '潮流周刊', publishedAt: 1758902400 - i * 86400, contentHead: '' });
      const er = new mod.EditionReader({ items: Array.from({ length: 40 }, (_, i) => mk(i)), fetchArticle: async () => '', feedKey: 'r54:keep' });
      window.__er54 = er;
      localStorage.setItem('robinread.editionPos', JSON.stringify({ 'r54:keep': 1 }));
      er.present(); clearTimeout(er._autoTimer); er._doOpen();
      await new Promise((r) => setTimeout(r, 1600));
      const notice = document.querySelector('.er-notice');
      const out = { text: notice && !notice.hidden ? notice.textContent : '', landed: er.index, atStart: er.index === er.startIndex };
      er.dismiss();
      return out;
    })()`, 'resume-contract');
    if (resumeA.__err) ok(false, '3 续读契约探针异常 — ' + resumeA.__err);
    else {
      ok(resumeA.landed === 1, '3 R18 契约保持：位置记忆落位（index=' + resumeA.landed + '）');
      ok(String(resumeA.text).includes('续读') && String(resumeA.text).includes('2'), `3 R18 契约保持：提醒文案（${resumeA.text}）`);
    }
    const resumeB = await execJS(uiWin, `(async () => {
      const mod = await import('./views/edition-reader.js');
      const mk = (i) => ({ id: 'r54b-' + i, title: '条目 ' + i, summaryPreview: '摘要 ' + i, sourceTitle: '潮流周刊', publishedAt: 1758902400 - i * 86400, contentHead: '' });
      const er = new mod.EditionReader({ items: Array.from({ length: 40 }, (_, i) => mk(i)), fetchArticle: async () => '', feedKey: 'r54:stale' });
      localStorage.setItem('robinread.editionPos', JSON.stringify({ 'r54:stale': 1 }));
      er.present(); clearTimeout(er._autoTimer); er._doOpen();
      er._go(3); // 950ms 延迟窗口内已先行翻页：落位提示过时 → 安静跳过
      await new Promise((r) => setTimeout(r, 1600));
      const notice = document.querySelector('.er-notice');
      const out = { text: notice && !notice.hidden ? notice.textContent : '', index: er.index };
      er.dismiss();
      return out;
    })()`, 'resume-stale');
    if (resumeB.__err) ok(false, '3 过时跳过探针异常 — ' + resumeB.__err);
    else ok(!String(resumeB.text).includes('续读') && resumeB.index === 3,
      `3 先行翻页 → 过时提示不补发（index=${resumeB.index}，text="${resumeB.text}"）`);

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
    // backgroundThrottling 关：隐藏窗不掐合成器帧——微入场（opacity/transform 合成器动画）
    // 的 animationend 才会如期到点（diag-edition-resume 同款）
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
