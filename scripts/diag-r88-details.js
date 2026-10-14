'use strict';
/**
 * diag-r88-details.js — R88 滚动驱动收官探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 进度线 scroll() 纯 CSS 直驱：可滚动档 .is-scrollable 交给滚动时间线（合成器逐帧，
 *    主线程滚动路径零写入）；短文不上时间线（防零时长→满格假进度）
 *  2 插图视差微浮现：figure 图片 view() 元素时间线 ±6px 缓漂（@supports + no-preference 双门）
 *  3 艺术批次收官审计：新关键帧闭包（njProgressGrow/njFigureDrift）、timeline-scope 提升、
 *    R84-R88 轮次标记、新 i18n 键、60ms 谱系零回归
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r88-')));
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
    // ── 静态锚点 ──
    ok(/\.reader-scroll \{ scroll-timeline-name: --nj-reader-scroll; \}/.test(css) && /\.robin-surface\.column-reader \{ timeline-scope: --nj-reader-scroll; \}/.test(css),
      '1 滚动时间线命名 + 作用域提升在册（进度线在滚动容器外可达）');
    ok(/@keyframes njProgressGrow \{ from \{ width: 0%; \} to \{ width: 100%; \} \}/.test(css)
      && /\.reading-progress\.is-scrollable \.reading-progress-fill \{[\s\S]*?animation-timeline: --nj-reader-scroll;[\s\S]*?transition: none;/s.test(css),
      '1 可滚动档时间线直驱 + 过渡让位在册');
    ok(readerSrc.includes("this.progressEl.classList.toggle('is-scrollable', max0 > 40);"),
      '1 JS 档门在册（不可滚不上时间线防满格假进度）');
    ok(/@supports \(animation-timeline: view\(\)\) \{\s*@media \(prefers-reduced-motion: no-preference\) \{\s*\.reader-article figure img\.nj-img \{[\s\S]*?animation-timeline: view\(\);[\s\S]*?animation-range: entry 0% cover 62%;/s.test(css),
      '2 插图视差双门 + 元素时间线在册（entry→cover 62%）');
    ok(/@keyframes njFigureDrift \{[\s\S]*?translateY\(6px\);[\s\S]*?translateY\(-4px\);/.test(css), '2 漂移幅度 ±6→-4px 在册');
    const cssClean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const defined = new Set([...cssClean.matchAll(/@keyframes ([a-zA-Z0-9_-]+)/g)].map((m) => m[1]));
    ok(defined.has('njProgressGrow') && defined.has('njFigureDrift'), '3 新关键帧两枚在册');
    const delays = [...cssClean.matchAll(/animation-delay: ([\d.]+)(ms|s);/g)].map((m) => m[1] * (m[2] === 's' ? 1000 : 1));
    const offLadder = delays.filter((d) => Math.abs(d / 60 - Math.round(d / 60)) > 1e-6 && d !== 150);
    ok(offLadder.length === 0, `3 60ms 谱系零回归（离群 ${offLadder.length}）`);
    let tagged = 0;
    for (const tag of ['R84', 'R85', 'R86', 'R87', 'R88']) tagged += (css.match(new RegExp(`${tag}-`, 'g')) || []).length + (readerSrc.match(new RegExp(`${tag}`, 'g')) || []).length;
    ok(tagged >= 10, `3 R84-R88 轮次标记在册（${tagged} 处锚）`);
    for (const key of ['农历%@', '视点引导', '已折叠 %lld 段']) ok(i18nSrc.includes(`"${key}"`), `3 i18n 新键 ${key} 在册`);

    // ── UI 行为 ──
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(app.getPath('userData'));
    const uiWin = await openUIWindow();
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, uiWin);
    const filler = '滚动驱动验证用的正文填充段落，制造充足滚动高度以触发时间线档门。'.repeat(24);
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R88 素材源', feedURL: 'https://r88.test/feed.xml' });
    const [entryID] = await store._applyParsedEntries(feed, [{
      id: 'r88-a1', title: '滚动驱动的文章', url: 'https://r88.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R88 素材。',
      contentHTML: `<figure><img src="https://r88.test/a.gif" width="600" height="400" alt="漂移图"></figure><p>${filler}</p>`,
    }]);
    await loadUI(uiWin);
    await sleep(1200);
    const b = await execJS(uiWin, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = {};
      out.scrollSupport = CSS.supports('animation-timeline: scroll()');
      out.viewSupport = CSS.supports('animation-timeline: view()');
      window.__robinReaderOpen('${entryID}');
      const t0 = Date.now();
      for (;;) {
        if (document.querySelector('.robin-body p')) break;
        if (Date.now() - t0 > 12000) return { found: false };
        await sleep(50);
      }
      await sleep(1600); // 隐藏窗 rAF 帧率极低（~850ms/帧，R54 记档）：等 _onScroll 首帧落定再读档门
      out.found = true;
      const prog = document.getElementById('reading-progress');
      const fill = prog.querySelector('.reading-progress-fill');
      out.scrollableClass = prog.classList.contains('is-scrollable');
      const fcs = getComputedStyle(fill);
      out.fillTimeline = fcs.animationTimeline;
      out.fillName = fcs.animationName;
      const fig = document.querySelector('.robin-body figure img');
      out.figTimeline = fig ? getComputedStyle(fig).animationTimeline : null;
      out.figRange = fig ? getComputedStyle(fig).animationRange : null;
      return out;
    })()`, 'r88-live');
    if (b.__err) ok(false, '行为探针异常 — ' + b.__err);
    else if (!b.found) ok(false, '阅读区未渲染（环境性）');
    else {
      ok(b.scrollSupport && b.viewSupport, `支持度（scroll=${b.scrollSupport} view=${b.viewSupport}）`);
      ok(b.scrollableClass && String(b.fillTimeline).includes('--nj-reader-scroll') && b.fillName === 'njProgressGrow',
        `1 进度线时间线直驱（档门${b.scrollableClass} timeline=${b.fillTimeline} name=${b.fillName}）`);
      ok(String(b.figTimeline).includes('view()') && String(b.figRange).includes('entry'),
        `2 插图视差实挂（timeline=${b.figTimeline} range=${String(b.figRange).slice(0, 40)}）`);
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
