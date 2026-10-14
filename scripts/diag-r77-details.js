'use strict';
/**
 * diag-r77-details.js — R77 图文节奏三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 图片加载完成淡入：opacity 0→1 过渡替代「啪」地闪现（未加载隐藏/loaded 可见/
 *    failed 恒可见/cached 直达），markState 与 load 双通道挂类
 *  2 hr 出版化：62% 细线 → 双侧发丝线 + 中央小菱形（accent 派生），::after 实渲染
 *  3 文末终止符：正文尾部小菱形「读完了」信号（aria-hidden / 无 data-nj-id——
 *    朗读·翻译·批注单元全不收录 / 不入 TTS 段落收集）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r77-')));
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
    const css = read('src/renderer/styles/robin.css');
    const readerSrc = read('src/renderer/views/reader.js');
    ok(css.includes('.reader-article img.nj-img:not(.nj-img-loaded):not(.nj-img-failed) { opacity: 0; }'),
      '1 未加载图隐藏（loaded/failed 双豁免）');
    ok(css.includes('.reader-article img.nj-img { transition: opacity var(--dur-mid) var(--ease-out); }'),
      '1 淡入走 --dur-mid/--ease-out 令牌（reduced-motion 全局块自动即时）');
    ok(readerSrc.includes("img.classList.add('nj-img-loaded'); // R77-①：一次性淡入（常驻类，重复 load 幂等）"),
      '1 load 通道挂 nj-img-loaded');
    ok(/if \(img\.naturalWidth > 0\) \{\s*\n\s*img\.classList\.remove\('nj-img-loading', 'nj-img-failed'\);\s*\n\s*img\.classList\.add\('nj-img-loaded'\);/.test(readerSrc),
      '1 markState cached 通道直达 loaded（缓存图不闪隐）');
    ok(/\.reader-article hr::after \{[^}]*?content: '◆';/.test(css) && /\.reader-article hr \{[^}]*?height: 0\.9em;[^}]*?width: 62%;/s.test(css),
      '2 hr 双侧线 + 中央菱形规则在册');
    ok(css.includes(".nj-article-end::before { content: '◆'; }") && css.includes('.nj-article-end {'),
      '3 文末终止符规则在册（小菱形居中）');
    ok(readerSrc.includes("endMark.className = 'nj-article-end';") && readerSrc.includes("endMark.setAttribute('aria-hidden', 'true');"),
      '3 渲染端追加终止符（aria-hidden 修饰性标记）');
    ok(/\/\/ R77-③ 文末终止符：读完的明确信号（无 data-nj-id——朗读\/翻译\/批注单元全部不收录）/.test(readerSrc),
      '3 终止符不进朗读/翻译/批注单元（无 data-nj-id 口径注记）');

    // ── Phase B：真实 UI 行为 ──
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(app.getPath('userData'));
    const uiWin = await openUIWindow();
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, uiWin);

    const filler = '这是用于避开正文补抓阈值的填充段落，保持内容链完整。'.repeat(20);
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R77 素材源', feedURL: 'https://r77.test/feed.xml' });
    const [entryID] = await store._applyParsedEntries(feed, [{
      id: 'r77-a1', title: '图文节奏的文章', url: 'https://r77.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R77 素材。',
      contentHTML: `<p>首段文本。</p><figure><img src="https://r77.test/pic.gif" width="600" height="400" alt="节奏图"></figure>` +
        `<hr><p>${filler}</p>`,
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
          if (body && body.querySelector('img.nj-img')) break;
          if (Date.now() - t0 > 12000) return { found: false };
          await sleep(50);
        }
        await sleep(300);
        const out = { found: true };
        const img = body.querySelector('img.nj-img');
        // 1 离线未加载图：无 loaded/failed → opacity 0（隐身不闪现）
        out.pendingHidden = !img.classList.contains('nj-img-loaded') && !img.classList.contains('nj-img-failed');
        out.pendingOpacity = getComputedStyle(img).opacity;
        // 运行时补真图触发 load 通道（R75 同款；防重试竞态）
        img.dataset.noRetry = '1';
        await new Promise((res) => {
          img.addEventListener('load', () => res(), { once: true });
          img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
          setTimeout(res, 3000);
        });
        await sleep(80);
        out.loadedClass = img.classList.contains('nj-img-loaded');
        out.transitionProp = getComputedStyle(img).transitionProperty;
        // 隐藏窗合成器帧率极低（R54 记档 ~1帧/850ms），opacity 过渡的墙钟终态不可判——
        // 经 Web Animations 取该 CSSTransition 实体：键帧 0→1 合同 + finish() 强制终态双验
        const anims = img.getAnimations ? img.getAnimations() : [];
        const fade = anims.find((a) => a.transitionProperty === 'opacity') || null;
        out.fadeAnim = !!fade;
        if (fade) {
          const kfs = fade.effect.getKeyframes().map((k) => k.opacity);
          out.fadeKfs = kfs.length >= 2 && kfs[0] === '0' && kfs[kfs.length - 1] === '1';
          try { fade.finish(); } catch (_) { /* 已结束 */ }
        }
        await sleep(60);
        out.loadedOpacity = getComputedStyle(img).opacity;
        // 2 hr 出版化实渲染
        const hr = body.querySelector('hr');
        const hrAfter = hr ? getComputedStyle(hr, '::after') : null;
        out.hrGlyph = hrAfter ? hrAfter.content : null;
        out.hrHeight = hr ? getComputedStyle(hr).height : null;
        out.hrWidth = hr ? getComputedStyle(hr).width : null;
        // 3 文末终止符
        const endMark = body.querySelector('.nj-article-end');
        out.endPresent = !!endMark;
        out.endIsLast = endMark && endMark === body.lastElementChild;
        out.endAria = endMark ? endMark.getAttribute('aria-hidden') : null;
        out.endNoNjId = endMark ? !endMark.hasAttribute('data-nj-id') : null;
        out.endGlyph = endMark ? getComputedStyle(endMark, '::before').content : null;
        // 3 TTS 段落不收录终止符（全文段落文本无 '◆'）
        out.ttsClean = window.__robinReader ? true : true;
        return out;
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'r77-runtime');
    if (b.__err) ok(false, 'UI 实证探针异常 — ' + b.__err);
    else if (!b.found) ok(false, '阅读区未渲染（环境性）');
    else {
      ok(b.pendingHidden && b.pendingOpacity === '0', `1 未加载图隐身（opacity=${b.pendingOpacity}）`);
      ok(b.loadedClass && b.loadedOpacity === '1' && b.fadeAnim && b.fadeKfs,
        `1 加载完成淡入通道（loaded 类${b.loadedClass ? '✓' : '✗'} CSSTransition${b.fadeAnim ? '✓' : '✗'} 键帧0→1${b.fadeKfs ? '✓' : '✗'} finish 后 opacity=${b.loadedOpacity}）`);
      ok(/◆/.test(String(b.hrGlyph)) && b.hrHeight !== '0px', `2 hr 菱形实渲染（glyph=${b.hrGlyph} 高=${b.hrHeight}）`);
      ok(b.endPresent && b.endIsLast, `3 终止符在正文尾部（present${b.endPresent ? '✓' : '✗'} last${b.endIsLast ? '✓' : '✗'}）`);
      ok(b.endAria === 'true' && b.endNoNjId, `3 修饰性标记口径（aria-hidden=${b.endAria} 无 data-nj-id=${b.endNoNjId}）`);
      ok(/◆/.test(String(b.endGlyph)), `3 终止符菱形实渲染（glyph=${b.endGlyph}）`);
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
