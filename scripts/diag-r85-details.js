'use strict';
/**
 * diag-r85-details.js — R85 结构谱三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 结构谱几何化：标题刻度按真实比例落位（单调递增且非等距；与拖拽滚动同语义）
 *    + 密度 glyph（小点=插图 / 细条=代码块）
 *  2 活跃章节：thumb 落活跃章节几何位 + 刻度生长 + 章节切换 peak 闪光（1.4s 自隐）
 *  3 进度线章节记号针：h2 位置 2px 记号（填充越过即读过一章）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r85-')));
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
    ok(/R85-① 结构谱几何化[\s\S]*?const ratioOf = \(el\) => clamp01\(/.test(readerSrc), '1 几何落位函数在册（clamp01 防溢界）');
    ok(readerSrc.includes("dot.className = 'toc-dot';") && readerSrc.includes("bar.className = 'toc-bar';"),
      '1 密度 glyph 渲染接线（图点/码条）');
    ok(/\.toc-dot \{[^}]*?width: 2\.5px;[^}]*?border-radius: 50%;/s.test(css) && /\.toc-bar \{[^}]*?height: 7px;/s.test(css),
      '1 glyph 形态在册（点 2.5px / 条 2×7px）');
    ok(/\.toc-tick\.active \{ left: -6px; width: 16px; \}/.test(css), '2 活跃刻度生长在册');
    ok(/R85-② 章节切换闪光[\s\S]*?setTimeout\(\(\) => this\.tocPeak\.classList\.remove\('visible'\), 1400\);/.test(readerSrc),
      '2 章节名 1.4s 自隐闪光在册');
    ok(/\.reading-progress \.nj-progress-notch \{[^}]*?width: 2px;/s.test(css) && readerSrc.includes('nj-progress-notch'),
      '3 进度线记号针 CSS+渲染接线在册');
    ok(readerSrc.includes('this.tocThumb.style.top = `${(this.tocEntries[active].position * 100).toFixed(2)}%`;'),
      '2 thumb 落活跃章节几何位（与刻度同语义）');

    // ── UI 行为（真渲染）──
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(app.getPath('userData'));
    const uiWin = await openUIWindow();
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, uiWin);
    const para = (n) => Array.from({ length: n }, () => '<p>结构谱验证正文段落，用于制造真实比例的滚动高度分布。</p>').join('');
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R85 素材源', feedURL: 'https://r85.test/feed.xml' });
    const [entryID] = await store._applyParsedEntries(feed, [{
      id: 'r85-a1', title: '结构谱的文章', url: 'https://r85.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R85 素材。',
      contentHTML: para(3) + '<h2>第一章</h2>' + para(4) + '<figure><img src="https://r85.test/a.gif" width="600" height="400"></figure>' + para(2) +
        '<h2>第二章</h2>' + para(2) + '<pre><code>const a = 1;</code></pre>' + para(3) +
        '<h2>第三章</h2>' + para(5),
    }]);
    ok(typeof entryID === 'string', '播种文章入库');
    await loadUI(uiWin);
    await sleep(1200);
    const b = await execJS(uiWin, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__robinReaderOpen('${entryID}');
      const t0 = Date.now();
      let track = null;
      for (;;) {
        track = document.querySelector('.toc-track');
        if (track && track.querySelectorAll('.toc-tick').length >= 3) break;
        if (Date.now() - t0 > 12000) return { found: false };
        await sleep(50);
      }
      await sleep(400);
      const out = { found: true };
      const ticks = [...track.querySelectorAll('.toc-tick')];
      out.positions = ticks.map((t) => parseFloat(t.style.top));
      out.monotonic = out.positions.every((v, i) => i === 0 || v > out.positions[i - 1]);
      const gaps = out.positions.slice(1).map((v, i) => +(v - out.positions[i]).toFixed(1));
      out.gaps = gaps;
      out.nonUniform = Math.max(...gaps) - Math.min(...gaps) > 2;
      out.dots = track.querySelectorAll('.toc-dot').length;
      out.bars = track.querySelectorAll('.toc-bar').length;
      // 3 记号针
      const prog = document.getElementById('reading-progress');
      out.notches = prog ? prog.querySelectorAll('.nj-progress-notch').length : -1;
      // 2 滚到第二章附近：active 刻度 + thumb 跟随 + peak 闪光
      const scrollEl = document.querySelector('.reader-scroll');
      const h2s = [...document.querySelectorAll('.robin-body h2')];
      if (h2s[1]) {
        scrollEl.scrollTop = h2s[1].getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop + 4;
        scrollEl.dispatchEvent(new Event('scroll'));
        await sleep(1300); // 隐藏窗 rAF 帧率极低（~850ms/帧，R54 记档）：等 _onScroll 节流帧落地
        out.activeIdx = ticks.findIndex((t) => t.classList.contains('active'));
        out.thumbTop = parseFloat(document.querySelector('.toc-thumb').style.top);
        out.activeTop = out.positions[out.activeIdx];
        out.peakVisible = !!document.querySelector('.toc-peak.visible');
        await sleep(2200);
        out.peakHidden = !document.querySelector('.toc-peak.visible');
      }
      return out;
    })()`, 'r85-live');
    if (b.__err) ok(false, '行为探针异常 — ' + b.__err);
    else if (!b.found) ok(false, '阅读区未渲染（环境性）');
    else {
      ok(b.monotonic && b.nonUniform, `1 刻度几何落位（单调${b.monotonic ? '✓' : '✗'} 非等距 gaps=${JSON.stringify(b.gaps)}）`);
      ok(b.dots >= 1 && b.bars >= 1, `1 密度 glyph（图点×${b.dots} 码条×${b.bars}）`);
      ok(b.notches === 3, `3 记号针三枚齐（${b.notches}/3）`);
      ok(b.activeIdx === 1 && Math.abs(b.thumbTop - b.activeTop) < 0.5, `2 活跃章跟随（active=${b.activeIdx} thumb=${b.thumbTop?.toFixed(1)} vs 刻度${b.activeTop?.toFixed(1)}）`);
      ok(b.peakVisible === true && b.peakHidden === true, `2 章节名闪光自隐（显${b.peakVisible} → 隐${b.peakHidden}）`);
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
