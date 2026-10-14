'use strict';
/**
 * diag-r89-details.js — R89/R90/R92/R93 栏目级度量 + 嵌套缩放地板探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 R89 任意深度文字通道：:where(p,ul,ol,dl,blockquote) + table/pre/.table-scroll 子树豁免
 *    ——直接子级与嵌套（div 包裹 / fold 内）同受度量；表格同轴进通道（R101 全要素同轴）
 *  2 R90 嵌套缩放地板：table max(0.92em,13px) / pre max(0.85em,12px) / code max(0.86em,12px)
 *    ——14px 基准下 table>td>code 链不再跌穿 12px（用户实见 11.08px 根治锚）
 *  3 R92/R93 行宽-字号 em 联动：度量随 --article-font-size 等比伸缩（页宽预设只控出血件）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r89-')));
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
    // ── 静态锚点 ──
    ok(/\.robin-body :where\(p, ul, ol, dl, blockquote\):not\(:is\(table, pre, \.table-scroll\) \*\) \{/.test(css)
      && /\.robin-body :where[\s\S]*?max-width: min\(100%, var\(--nj-measure\)\);[\s\S]*?margin-left: auto;[\s\S]*?margin-right: auto;/.test(css),
      '1 R89 任意深度度量选择器在册（子树豁免 + auto 居中；R107 改用 --nj-measure）');
    ok(!/\.robin-body > p, \.robin-body > ul, \.robin-body > ol,/.test(css), '1 R79 直接子级旧护栏已退役');
    ok(/--reader-page-width, 820px/.test(css), '3 页宽预设槽位保持（出血件专用）');
    ok(/\.reader-article table \{[\s\S]*?border-collapse: separate; border-spacing: 0;[\s\S]*?font-size: max\(0\.92em, 13px\);/s.test(css), '2 table 地板 13px + R91 卡片基座在册');
    ok(/container-type: inline-size/.test(css)
      && /--nj-measure: clamp\(calc\(var\(--article-font-size, 17px\) \* 48\), 90cqi, calc\(var\(--article-font-size, 17px\) \* 62\)\);/.test(css)
      && /\.reader-article\.cjk-em \{[\s\S]*?--nj-measure: clamp\(calc\(var\(--article-font-size, 17px\) \* 54\), 92cqi, calc\(var\(--article-font-size, 17px\) \* 76\)\);/.test(css),
      '1 R107 自适应度量在册（地板 48/54 字 · 90/92cqi 流动 · 封顶 62/76 字——用户实见「大屏段落显窄」）');
    ok(/\.robin-body figure,\s*\.robin-body pre,\s*\.robin-body table,/.test(css)
      && /\.robin-body img \{[\s\S]{0,200}max-width: min\(100%, var\(--nj-measure\)\);/.test(css)
      && /\.robin-body h1, \.robin-body h2, \.robin-body h3,[\s\S]*?max-width: min\(100%, var\(--nj-measure\)\);[\s\S]*?margin-right: auto;/.test(css),
      '1 R95b/R101/R108 同轴消费族在册（figure/pre/table/标题/全部图同吃 --nj-measure，无豁免）');
    ok(/\.reader-article pre \{[\s\S]*?font-size: max\(0\.85em, 12px\);/s.test(css), '2 pre 地板 12px 在册');
    ok(/\.reader-article code \{[\s\S]*?font-size: max\(0\.86em, 12px\);/s.test(css), '2 code 地板 12px 在册');

    // ── UI 行为 ──
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(app.getPath('userData'));
    const { registerIPCHandlers } = require('../src/main/ipc');
    const uiWin = await openUIWindow();
    registerIPCHandlers(store, uiWin);
    const para = '任意深度度量验证用的中文正文段落，需要足够长以触发行宽护栏的完整测量。'.repeat(6);
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R89 素材源', feedURL: 'https://r89.test/feed.xml' });
    const [entryID] = await store._applyParsedEntries(feed, [{
      id: 'r89-a1', title: '嵌套度量与地板', url: 'https://r89.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R89 素材。',
      contentHTML: `<p>${para}</p><p id="rr-channel">${para}</p><ul><li><p>${para}</p></li></ul>`
        + `<table><tbody><tr><td>1</td><td><code><p>${para}</p></code></td></tr></tbody></table>`
        + `<blockquote><p>${para}</p></blockquote>`,
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
      await sleep(1400);
      const out = { found: true };
      const art = document.querySelector('.reader-article');
      // 探针正文是中文 → cjk-em 生效，通道系数 54；拉丁 48（R95 定案）
      out.cjk = art.classList.contains('cjk-em');
      out.emFactor = out.cjk ? 54 : 48;
      // 版心 ~729px（1800 窗）容不下 54em@17px（918）——降至 13px 让帽绑定再测
      document.documentElement.style.setProperty('--article-font-size', '13px');
      await sleep(120);
      const direct = document.querySelector('.robin-body > p');
      const nested = document.querySelector('.robin-body li > p');
      const inTable = document.querySelector('.robin-body table p');
      const quote = document.querySelector('.robin-body blockquote p');
      const table = document.querySelector('.robin-body table');
      const w = (el) => Math.round(el.getBoundingClientRect().width);
      // 应用级 zoom 会缩放 rect——用 computed max-width（布局像素）断言，zoom 免疫
      const mw = (el) => parseFloat(getComputedStyle(el).maxWidth) || 0;
      const fsOf = (el) => parseFloat(getComputedStyle(el).fontSize);
      out.font = fsOf(nested); // 基准字号取非首段（首段是 lead 1.07em，其 maxWidth 为 calc(54em/1.07) 殊途同归）
      out.directMW = mw(direct); out.nestedMW = mw(nested); out.quoteMW = mw(quote);
      out.tableMW = mw(table);
      out.tableFont = fsOf(table);
      out.tablePFont = inTable ? fsOf(inTable) : null;
      out.directW = w(direct); out.tableW = w(table);
      // R107：computed max-width 是 min()/clamp() 字面串（parseFloat 会 NaN）——一律量 used 宽度。
      // 13px 基准地板绑定（54em×13=702 < 版心）：四类块全等 702
      out.nestedW = w(nested); out.quoteW = w(quote); out.font = fsOf(nested);
      const ch = (document.querySelectorAll('.robin-body > p') || [])[1]; // 消毒层会收走 id——按位取非 lead 顶层段
      out.channelW = ch ? w(ch) : 0; // 基准通道（列表/引用的容器缩进不计入同轴口径）
      return out;
    })()`, 'r89-live');
    if (b.__err) ok(false, '行为探针异常 — ' + b.__err);
    else if (!b.found) ok(false, '阅读区未渲染（环境性）');
    else {
      ok(b.channelW > 200 && Math.abs(b.channelW - b.directW * 1.07) <= 4,
        `1 任意深度通道自洽（cjk=${b.cjk} lead${b.directW}×1.07=${Math.round(b.directW * 1.07)} ≈ 通道基准${b.channelW}——嵌${b.nestedW}/引${b.quoteW} 为容器合法缩进）`);
      ok(Math.abs(b.tableW - b.directW * 1.07) <= 4, `1 表格同轴进通道（R101：tableW${b.tableW} ≈ 通道${b.directW}×1.07=${Math.round(b.directW * 1.07)}——direct 取首段 lead 有 ÷1.07 度量）`);
      ok(b.tableFont >= 13, `2 表格地板 13px（实测 ${b.tableFont}）`);
      ok(b.tablePFont >= 12, `2 表内段落地板 12px（实测 ${b.tablePFont}）`);
      // R107 自适应：拉宽窗口 → 通道随 cqi 增长并在天花板（76em×13=988）收口
      uiWin.setBounds({ width: 2400, height: 950 });
      await sleep(500);
      const c = await execJS(uiWin, `(() => {
        const table = document.querySelector('.robin-body table');
        return { wideW: Math.round(table.getBoundingClientRect().width) };
      })()`, 'r89-wide');
      if (!c.__err && c.wideW) {
        ok(c.wideW > b.tableW + 30, `3 R107 阅读栏变宽通道增长（table ${b.tableW} → ${c.wideW}——用户实见「大屏段落显窄」根治）`);
        const capPx = Math.round(76 * b.font);
        ok(c.wideW <= capPx + 4 && c.wideW >= capPx - 60, `3 R107 天花板收口（${c.wideW} ∈ [${capPx - 60}, ${capPx}]——76em 行长护栏不越顶）`);
      } else ok(false, '3 宽窗相位测量失败（环境性）');
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
    show: false, width: 1800, height: 950, // R89：54em@13px=702px 通道需版心 >702（1100px 三栏下正文仅 ~400px，护栏不绑定）
    webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
}

async function execJS(win, js, label = 'step', ms = 30000) {
  return Promise.race([
    win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}
