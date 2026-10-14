'use strict';
/**
 * diag-r84-details.js — R84 沉浸刊头三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 首图全幅出血 hero：图先行文章的首 figure 破版心槽到页缘（≥3 块才启用，短文让位；
 *    caption 回内容区对齐；--article-gutter 槽令牌随窄窗档改写）
 *  2 灯晕 vignette：阅读面径向压暗（中心透明→缘 3.5% 墨，暗档 6%；pointer-events none）
 *  3 农历 folio：中文界面公历旁附小字农历（Intl 中华历法 hanidec 数字，能力缺失静默）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r84-')));
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
    ok(/--article-gutter: 40px;.*R84-①/.test(css) && /padding: 22px var\(--article-gutter\) 0;/.test(css),
      '1 版心槽令牌在册（base 40px + padding 消费；R94-② 顶槽 32→22）');
    ok(/\.reader-article \{ --article-gutter: min\(40px, 5vw\);/.test(css), '1 窄窗档槽令牌改写（min(40px,5vw)）');
    ok(/R108 首图同轴/.test(css) && !/figure:first-child:nth-last-child\(n \+ 3\) \{/.test(css)
      && /\.robin-body img \{/.test(css),
      '1 R108 首图出血退役在册（hero 豁免删除，全部图同轴——用户实见「首图比正文宽没必要」）');
    ok(/\.robin-surface\.column-reader::after \{[^}]*?pointer-events: none;[^}]*?rgba\(24, 20, 14, 0\.035\)/s.test(css),
      '2 灯晕规则在册（3.5% 墨 + 不挡阅读）');
    ok(/body\.dark \.robin-surface\.column-reader::after \{[^}]*?rgba\(8, 6, 4, 0\.06\)/s.test(css), '2 暗档灯晕加深（6% 夜读包裹感）');
    ok(readerSrc.includes("new Intl.DateTimeFormat('zh-CN-u-ca-chinese-nu-hanidec', { month: 'long', day: 'numeric' })"),
      '3 农历 Intl 中华历法 + hanidec 数字在册');
    ok(readerSrc.includes("currentLanguage() === 'zh'") && /农历%@/.test(readerSrc), '3 中文界面门 + t() 占位键');
    ok(i18nSrc.includes('"农历%@": { zh: "农历%@", en: "Lunar %@" }'), '3 农历双语键在册');

    // ── UI 实证（挂载 + 真渲染双段）──
    const win = new BrowserWindow({
      show: false, width: 1280, height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    global.__r84win = win;
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1000);
    const b = await exec(`(() => {
      const out = {};
      // 1 hero 出血（长文形态）与让位（短文形态）
      const mk = (nBlocks) => {
        const art = document.createElement('div');
        art.className = 'reader-article';
        let html = '<div class="robin-body"><p>引导段样本，占住 lead 位。</p><figure><img src="x" width="600" height="400"><figcaption>图注样本</figcaption></figure>';
        for (let i = 0; i < nBlocks; i += 1) html += '<p>正文段落样本' + i + '。</p>';
        html += '</div>';
        art.innerHTML = html;
        document.body.appendChild(art);
        const fig = art.querySelector('figure');
        const p = art.querySelector('.robin-body > p:nth-of-type(2)') || art.querySelector('p'); // 避开 lead 首段（÷1.07 度量）
        const r = { figW: fig.getBoundingClientRect().width, pW: p.getBoundingClientRect().width, radius: getComputedStyle(fig).borderTopLeftRadius, artW: art.getBoundingClientRect().width };
        art.remove();
        return r;
      };
      out.long = mk(4);
      out.short = mk(1);
      // 2 灯晕实体
      const col = document.querySelector('.robin-surface.column-reader');
      if (col) {
        const af = getComputedStyle(col, '::after');
        out.vignette = { bg: af.backgroundImage, pe: af.pointerEvents, pos: af.position };
      } else out.vignette = null;
      // 3 农历格式化能力（同 reader 通道）
      try {
        out.lunar = new Intl.DateTimeFormat('zh-CN-u-ca-chinese-nu-hanidec', { month: 'long', day: 'numeric' }).format(new Date());
      } catch (_) { out.lunar = null; }
      return out;
    })()`, 'r84-mount');
    if (b.__err) ok(false, 'UI 实证探针异常 — ' + b.__err);
    else {
      ok(Math.abs(b.long.figW - b.long.pW) <= 3 && Math.abs(b.short.figW - b.short.pW) <= 3,
        `1 R108 首图与正文同轴（长文 fig=${Math.round(b.long.figW)}≈p=${Math.round(b.long.pW)}；短文 fig=${Math.round(b.short.figW)}≈p=${Math.round(b.short.pW)}）`);
      if (b.vignette) ok(/radial-gradient/.test(b.vignette.bg) && b.vignette.pe === 'none' && b.vignette.pos === 'absolute',
        `2 灯晕实体（径向渐变 + 不挡阅读）`);
      else ok(false, '2 .robin-surface.column-reader 不在页面（环境性）');
      ok(typeof b.lunar === 'string' && /月/.test(b.lunar) && /[一二三四五六七八九十]/.test(b.lunar),
        `3 农历格式化能力（今日=${b.lunar}，hanidec 数字）`);
    }

    // 3（行为）：真渲染 meta 行含农历
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(app.getPath('userData'));
    const { registerIPCHandlers } = require('../src/main/ipc');
    const uiWin = await openUIWindow();
    registerIPCHandlers(store, uiWin);
    const filler = '沉浸刊头验证用的正文填充段落，保持内容链完整以避开补抓阈值。'.repeat(20);
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R84 素材源', feedURL: 'https://r84.test/feed.xml' });
    const [entryID] = await store._applyParsedEntries(feed, [{
      id: 'r84-a1', title: '沉浸刊头的文章', url: 'https://r84.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R84 素材。',
      contentHTML: `<figure><img src="https://r84.test/hero.gif" width="600" height="400" alt="题图"><figcaption>题图注</figcaption></figure><p>${filler}</p><p>${filler}</p>`,
    }]);
    await loadUI(uiWin);
    await sleep(1200);
    const m = await execJS(uiWin, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__robinReaderOpen('${entryID}');
      const t0 = Date.now();
      for (;;) {
        if (document.querySelector('.robin-body figure')) break;
        if (Date.now() - t0 > 12000) return { found: false };
        await sleep(50);
      }
      await sleep(300);
      const meta = document.querySelector('.robin-header-meta');
      const lunar = meta ? meta.querySelector('.robin-lunar') : null;
      const fig = document.querySelector('.robin-body > figure');
      const p = document.querySelector('.robin-body > p');
      const p2 = document.querySelectorAll('.robin-body > p')[1] || document.querySelector('.robin-body > p'); // 非首段（lead 有 ÷1.07）
      return { found: true, lunar: lunar ? lunar.textContent : '', figW: fig.getBoundingClientRect().width, pW: p2.getBoundingClientRect().width };
    })()`, 'r84-live');
    if (m.__err) ok(false, '3 行为探针异常 — ' + m.__err);
    else if (!m.found) ok(false, '3 阅读区未渲染（环境性）');
    else {
      ok(/农历/.test(m.lunar) && /月/.test(m.lunar), `3 meta 行农历在位（${m.lunar}）`);
      ok(Math.abs(m.figW - m.pW) <= 3, `1 真实渲染首图同轴（fig=${Math.round(m.figW)} ≈ p=${Math.round(m.pW)}——R108）`);
    }

    win.destroy(); uiWin.destroy();
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

function exec(js, label, ms = 45000) {
  return Promise.race([
    global.__r84win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}

async function execJS(win, js, label = 'step', ms = 30000) {
  return Promise.race([
    win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}
