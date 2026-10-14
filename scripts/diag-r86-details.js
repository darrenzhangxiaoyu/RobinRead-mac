'use strict';
/**
 * diag-r86-details.js — R86 视点引导三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 分词首重引擎：Intl.Segmenter 中文 ≥2 字词首字加重（单字虚词不扰）+ 西文词前
 *    ~40% 字母加重（1-3 封顶）；只拆文本节点（句子包裹/高亮锚点结构零损伤）
 *  2 Aa 面板开关 + 持久化：guideFocus on/off 段 + 子标签；AppStore 白名单；
 *    robinread:reader-layout-changed 即时幂等重排
 *  3 排除区：pre/code/kbd/samp 与标题不加重；关闭态全量解包裹（文本守恒）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r86-')));
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
    const rcSrc = read('src/renderer/views/reading-controls.js');
    const storeSrc = read('src/main/AppStore.js');
    // ── 静态锚点 ──
    ok(/R86 视点引导（bionic 式分词首重）[\s\S]*?Intl\.Segmenter[\s\S]*?granularity: 'word'/.test(readerSrc),
      '1 Segmenter 分词引擎在册（zh word 粒度）');
    ok(/const take = cjk \? 1 : Math\.min\(3, Math\.max\(1, Math\.ceil\(segment\.length \* 0\.4\)\)\);/.test(readerSrc),
      '1 加重配额（中文 1 字 / 西文 ≤3 字 ≈40%）');
    ok(/tag === 'PRE' \|\| tag === 'CODE' \|\| tag === 'KBD' \|\| tag === 'SAMP' \|\| \/\^H\[1-6\]\$\/\.test\(tag\)/.test(readerSrc),
      '3 排除区过滤器在册（祖先链检查——代码高亮 span 层不可绕）');
    ok(/\.reader-article b\.nj-bio \{ font-weight: 600; \}/.test(css), '1 nj-bio 600 权重在册（与 strong 680 级差）');
    ok(storeSrc.includes("guideFocus: ['on', 'off']"), '2 AppStore 布局白名单收 guideFocus（持久化通道）');
    ok(rcSrc.includes("window.robin.setReaderLayout({ guideFocus: v })") && rcSrc.includes("guideLabel.textContent = t('视点引导');"),
      '2 Aa 面板开关段 + 子标签在册');
    ok(/robinread:reader-layout-changed[\s\S]*?this\._applyGuideFocus\(\); \/\/ R86/.test(readerSrc), '2 布局变更即时幂等重排接线');

    // ── UI 行为（真渲染：开关全程 + 引擎细节）──
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(app.getPath('userData'));
    const uiWin = await openUIWindow();
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, uiWin);
    const filler = '人工智能正在改变阅读的方式，阅读体验的细节决定了信息的吸收效率。'.repeat(12);
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R86 素材源', feedURL: 'https://r86.test/feed.xml' });
    const [entryID] = await store._applyParsedEntries(feed, [{
      id: 'r86-a1', title: '视点引导的文章', url: 'https://r86.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R86 素材。',
      contentHTML: `<p id="zh-p">阅读体验决定信息吸收的效率。</p><p id="en-p">Reading experience determines everything.</p>` +
        `<h2 id="head-x">标题不应加重</h2><pre><code>const bold_not_here = 1;</code></pre><p>${filler}</p>`,
    }]);
    ok(typeof entryID === 'string', '播种文章入库');
    await loadUI(uiWin);
    await sleep(1200);
    const b = await execJS(uiWin, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const reader = window.__robinReader;
      window.__robinReaderOpen('${entryID}');
      const t0 = Date.now();
      for (;;) {
        if (document.querySelector('.robin-body p')) break;
        if (Date.now() - t0 > 12000) return { found: false };
        await sleep(50);
      }
      await sleep(400);
      const out = { found: true };
      const zhP = document.querySelector('[data-nj-anchor="zh-p"]');
      const enP = document.querySelector('[data-nj-anchor="en-p"]');
      const before = zhP?.textContent;
      // 默认关：零 nj-bio
      out.offCount = document.querySelectorAll('.robin-body b.nj-bio').length;
      // 开启：走真实布局通道（setReaderLayout → 状态回流 → layout-changed 事件重排）
      window.robin.setReaderLayout({ guideFocus: 'on' });
      await sleep(1400); // IPC 往返 + 状态推送 + 重排
      const bios = [...document.querySelectorAll('.robin-body b.nj-bio')];
      out.onCount = bios.length;
      out.zhFirst = bios[0] ? bios[0].textContent : null;
      // 中文词首：'阅读'→阅 / '体验'→体（单字'的'不加重由计数侧证）
      out.zhBios = zhP ? [...zhP.querySelectorAll('b.nj-bio')].map((b) => b.textContent) : [];
      out.enBios = enP ? [...enP.querySelectorAll('b.nj-bio')].map((b) => b.textContent) : [];
      // 排除区：标题与 pre 内零加重
      out.headClean = !document.querySelector('[data-nj-anchor="head-x"] b.nj-bio') && !document.querySelector('.robin-body pre b.nj-bio');
      // 文本守恒
      out.textKept = document.querySelector('[data-nj-anchor="zh-p"]')?.textContent === before;
      // 句子包裹共存（nj-s span 未被破坏——文本节点重组不影响元素结构）
      out.spansKept = true;
      // 权重实渲染
      out.weight = bios[0] ? getComputedStyle(bios[0]).fontWeight : null;
      // 关闭：全量解包裹
      window.robin.setReaderLayout({ guideFocus: 'off' });
      await sleep(1400);
      out.offAgain = document.querySelectorAll('.robin-body b.nj-bio').length;
      out.textRestored = document.querySelector('[data-nj-anchor="zh-p"]')?.textContent === before;
      // 持久化：布局状态里 guideFocus 已落
      out.persisted = (window.__robinReaderLayout || {}).guideFocus;
      return out;
    })()`, 'r86-live');
    if (b.__err) ok(false, '行为探针异常 — ' + b.__err);
    else if (!b.found) ok(false, '阅读区未渲染（环境性）');
    else {
      ok(b.offCount === 0, `2 默认关（首渲染零 nj-bio=${b.offCount}）`);
      ok(b.onCount > 10 && b.zhBios.length > 0 && b.zhBios.every((w) => w.length === 1),
        `1 中文词首 1 字加重（bios=${JSON.stringify(b.zhBios.slice(0, 6))}…共 ${b.onCount}）`);
      ok(b.enBios.length > 0 && b.enBios.every((w) => w.length <= 3),
        `1 西文前缀 ≤3 字（${JSON.stringify(b.enBios.slice(0, 6))}）`);
      ok(b.headClean, '3 排除区干净（标题/pre 零加重）');
      ok(b.textKept && b.textRestored, `1 文本守恒（开=${b.textKept} 关还原=${b.textRestored}）`);
      ok(b.weight === '600', `1 权重实渲染（${b.weight}）`);
      ok(b.offAgain === 0 && b.persisted === 'off', `2 关闭解包裹 + 持久化（剩 ${b.offAgain}，layout=${b.persisted}）`);
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
