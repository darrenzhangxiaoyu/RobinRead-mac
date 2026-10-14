'use strict';
/**
 * diag-r75-details.js — R75 链接与文内锚点三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 文内锚点导航（真 bug 修复）：#fragment 链接此前被 preventDefault 静默吞掉——
 *    消毒层 id→data-nj-anchor 转存 + fragment-only href 不再绝对化 + 渲染端寻址滚动闪高亮；
 *    死锚静默；标题换壳/裸 div 转 p 时锚点随迁
 *  2 外链域名悬停：title 从泛化提示升级「example.com · 在浏览器打开」（i18n tf 占位键）
 *  3 图链让位灯箱（双触发修复）：链接内图片点击此前灯箱+浏览器同时弹——
 *    图链分支只拦默认导航，灯箱由图片自身监听独占
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r75-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    // ── Phase A：消毒层单元（node 直调）──
    const Core = require('../src/main/ArticleExtractCore');
    const BASE = 'https://r75.test/post/1';
    const fnHTML = Core.sanitizedHTML(
      '<p>正文<sup><a href="#fn1">1</a></sup>。</p>' +
      '<li id="fn1">脚注内容<a href="#fn1-back">回</a></li>' +
      '<div id="note-x">裸 div 目标</div>' +
      '<a href="https://example.com/x">外链</a>' +
      '<p id=\'"><script>\'>脏 id</p>',
      BASE,
    );
    ok(fnHTML.includes('data-nj-anchor="fn1"'), '1 消毒层 id→data-nj-anchor 转存（li 目标在册）');
    ok(fnHTML.includes('href="#fn1"') && fnHTML.includes('href="#fn1-back"'),
      '1 fragment-only href 保真（不再绝对化为 ' + BASE + '#fn1）');
    ok(!fnHTML.includes(BASE + '#'), '1 fragment 链接零绝对化残留');
    ok(!fnHTML.includes('id='), '1 原生 id 属性全数不出清（防与 app 层 DOM 冲突）');
    ok((fnHTML.match(/data-nj-anchor=/g) || []).length === 2, '1 非法 slug id 丢弃（注入串不成锚，锚点恰 2 处：fn1 + note-x）');
    ok(fnHTML.includes('href="https://example.com/x"'), '1 外链绝对地址行为不回归');

    // ── Phase B：静态锚点 ──
    const readerSrc = read('src/renderer/views/reader.js');
    ok(readerSrc.includes('_navigateToAnchor(fragment)'), '1 渲染端寻址方法在册');
    ok(readerSrc.includes("else if (href.startsWith('#')) this._navigateToAnchor(href.slice(1));"),
      '1 # 链接点击进入寻址分支（此前静默吞掉）');
    ok(/if \(!target\) return; \/\/ 死锚/.test(readerSrc), '1 死锚静默（目标被剥/不在本篇不打扰）');
    ok(readerSrc.includes("next.dataset.njAnchor = h.dataset.njAnchor;") && readerSrc.includes("p.dataset.njAnchor = div.dataset.njAnchor;"),
      '1 标题换壳/裸 div 转 p 锚点随迁');
    ok(readerSrc.includes("tf('%@ · 在浏览器打开', new URL(href).hostname)"), '2 外链 title 带 hostname（tf 占位）');
    ok(readerSrc.includes("event.target.closest('img')) return;"), '3 图链分支先行退出（灯箱独占，不叠浏览器）');
    const css = read('src/renderer/styles/robin.css');
    ok(css.includes('@keyframes nj-anchor-flash') && css.includes('.nj-anchor-flash { animation: nj-anchor-flash'),
      '1 落点闪高亮关键帧 + 消费规则在册');
    const i18nSrc = read('src/main/I18NStrings.js');
    ok(i18nSrc.includes('"%@ · 在浏览器打开": { zh: "%@ · 在浏览器打开", en: "%@ · open in browser" }'),
      '2 i18n 双语键在册');

    // ── Phase C：真实 UI 行为（AppStore 播种开车，r54 同款）──
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(app.getPath('userData'));
    const uiWin = await openUIWindow();
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, uiWin);

    const filler = '这是用于把脚注目标推到视口之下的填充段落，长文制造滚动空间。'.repeat(30);
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R75 素材源', feedURL: 'https://r75.test/feed.xml' });
    const [entryID] = await store._applyParsedEntries(feed, [{
      id: 'r75-a1', title: '脚注导航的文章', url: 'https://r75.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R75 素材。',
      contentHTML: `<p>正文开头<sup><a href="#fn1">1</a></sup><a href="https://example.com/page">实链</a><a href="#nope">死锚</a><a href="#fn1"><img src="https://r75.test/pic.gif" width="600" height="400" alt="图链"></a>。</p><p>${filler}</p><p id="fn1">这里是脚注内容本体。</p>`,
    }]);
    ok(typeof entryID === 'string' && entryID.startsWith('local:'), `播种文章入库（entryID=${String(entryID).slice(0, 24)}…）`);

    await loadUI(uiWin);
    await sleep(1200);

    // ① 脚注导航：点击 #fn1 → 目标滚入 + 闪高亮挂上（合成 animationend 后自清理）
    const nav = await execJS(uiWin, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        window.__robinReaderOpen('${entryID}');
        const t0 = Date.now();
        let scroll = null;
        for (;;) {
          scroll = document.querySelector('.reader-scroll, .robin-body')?.closest('.reader-scroll') || document.querySelector('.webview-body');
          const link = document.querySelector('.robin-body a[href="#fn1"]');
          if (link && scroll) break;
          if (Date.now() - t0 > 12000) return { found: false };
          await sleep(50);
        }
        const body = document.querySelector('.robin-body');
        const target = body.querySelector('[data-nj-anchor="fn1"]');
        const ext = body.querySelector('a[href="https://example.com/page"]');
        const dead = body.querySelector('a[href="#nope"]');
        const out = { found: true, hasTarget: !!target, extTitle: ext ? ext.title : null };
        // 死锚点击：不崩不闪
        dead.click();
        await sleep(250);
        out.deadQuiet = !body.querySelector('.nj-anchor-flash');
        // 图链点击：灯箱独占（不触发锚导航）。离线环境 https 图加载不了——
        // 运行时补 data URI 真图（_decorateImage 的监听在渲染时已挂好，naturalWidth>0 即走灯箱）
        const imgEl = body.querySelector('a[href="#fn1"] img');
        if (imgEl) {
          imgEl.dataset.noRetry = '1'; // 防自动重试定时器把补的真图 src 又改回 https
          await new Promise((res) => {
            imgEl.addEventListener('load', () => res(), { once: true });
            imgEl.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            setTimeout(res, 3000);
          });
          await sleep(120);
        }
        imgEl.click();
        await sleep(450);
        out.imgLightbox = !!document.querySelector('.nj-lightbox');
        out.imgNoFlash = !body.querySelector('.nj-anchor-flash');
        document.querySelector('.nj-lightbox')?.remove();
        // 脚注点击：滚动 + 闪高亮。隐藏窗合成器帧率不定，smooth 滚动改猴补
        // scrollIntoView 落地为 auto——合同（smooth 意图 + 目标元素）与实效（真滚到位）双验
        const siiCalls = [];
        const origSII = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (opts) { siiCalls.push({ el: this, opts }); return origSII.call(this, { ...opts, behavior: 'auto' }); };
        const scrollEl = document.querySelector('.reader-scroll');
        const before = scrollEl ? scrollEl.scrollTop : -1;
        body.querySelector('a[href="#fn1"]').click();
        await sleep(900);
        Element.prototype.scrollIntoView = origSII;
        const flash = body.querySelector('.nj-anchor-flash');
        out.navigated = scrollEl ? scrollEl.scrollTop > before : null;
        out.smoothIntent = siiCalls.some((c) => c.el.hasAttribute?.('data-nj-anchor') && c.opts && c.opts.behavior === 'smooth');
        out.flashOn = !!flash;
        if (flash) { flash.dispatchEvent(new AnimationEvent('animationend', { animationName: 'nj-anchor-flash', bubbles: false })); }
        out.flashClean = !body.querySelector('.nj-anchor-flash');
        return out;
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'anchor-nav');
    if (nav.__err) ok(false, '1 脚注导航探针异常 — ' + nav.__err);
    else if (!nav.found) ok(false, '1 阅读区未渲染（环境性）');
    else {
      ok(nav.hasTarget, '1 渲染端锚点目标在册（data-nj-anchor 经消毒管线存活）');
      ok(nav.extTitle === 'example.com · 在浏览器打开', `2 外链悬停域名提示（title="${nav.extTitle}"）`);
      ok(nav.deadQuiet, '1 死锚点击安静（无闪高亮无异常）');
      ok(nav.imgLightbox && nav.imgNoFlash, `3 图链点击灯箱独占（灯箱${nav.imgLightbox ? '✓' : '✗'} 不触发锚导航${nav.imgNoFlash ? '✓' : '✗'}）`);
      ok(nav.flashOn, '1 脚注点击落点闪高亮挂上');
      ok(nav.flashClean, '1 闪高亮 animationend 自清理');
      ok(nav.navigated === true && nav.smoothIntent === true, `1 脚注点击滚动到位（真滚 ${nav.navigated ? '✓' : '✗'} + smooth 意图合同 ${nav.smoothIntent ? '✓' : '✗'}）`);
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
