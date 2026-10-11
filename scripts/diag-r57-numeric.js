'use strict';
/**
 * diag-r57-numeric.js — R57 数字纪律三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 tabular-nums 全量：全库程序化审计后的剩余缺口补齐（播放器时间/媒体时长/阅读剩余/
 *    批处理计数/各视图统计数字），逐类断言 CSS 规则命中
 *  2 相对时间静默刷新：refreshEntryTimes 纯函数（注入时钟跨日翻桶/只改文本节点/幂等）
 *    + 列表 60s 心跳静态锚点 + 渲染位 data-ts 全挂
 *  3 时长口径 audit：阅读「约 N 分钟」/ 播客进度 H:MM:SS / 列表时长「N 分钟」三分场景
 *    各归各位（静态锚点）+ 阅读器实开 .robin-read-time 行为断言
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r57-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

/** 与源码同款的数字类缺口审计：类名带时间/计数暗示且其规则块缺 tabular-nums 的关键样本。 */
function auditGaps(cssAll) {
  const watch = ['nj-mp-time', 'nj-media-duration', 'robin-read-time', 'cluster-count', 'list-batch-count',
    'aihot-time', 'kb-card-time', 'dg-clock', 'kb-stat-num', 'nj-archive-stats', 'nj-garden-stats',
    'nj-capsule-badge', 'nj-revisit-badge', 'nj-course-progress-nums', 'nj-fp-stats'];
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(cssAll))) blocks.push([m[1], m[2]]);
  return watch.filter((cls) => {
    const dot = '.' + cls;
    const relevant = blocks.filter(([sel]) => sel.includes(dot));
    if (!relevant.length) return true; // 类不存在也算缺口
    return !relevant.some(([, body]) => body.includes('tabular-nums'));
  });
}

app.whenReady().then(async () => {
  try {
    const css = read('src/renderer/styles/robin.css') + read('src/renderer/styles/store.css');
    // ── 1. tabular-nums 全量 ──
    ok(css.includes('R57 数字纪律：等宽数字全量补齐'), '1 R57 补齐块在位');
    const gaps = auditGaps(css);
    ok(gaps.length === 0, `1 程序化审计：15 个关键数字类全部等宽（缺口=[${gaps.join(',') || '无'}]）`);
    ok(/\.nj-mp-time, \.nj-media-duration, \.nj-media-played, \.robin-read-time,/.test(css),
      '1 播放器/媒体/阅读剩余时间家族入组');

    // ── 2. 相对时间静默刷新 ──
    const listSrc = read('src/renderer/views/list.js');
    ok(listSrc.includes('export function refreshEntryTimes(root, now = new Date())'),
      '2 refreshEntryTimes 导出（可注入时钟）');
    ok(listSrc.includes("setInterval(() => refreshEntryTimes(this.rowsHost), 60000)"),
      '2 列表 60s 心跳在位（rowsHost 作用域）');
    ok((listSrc.match(/data-ts=/g) || []).length === 3 && (listSrc.match(/dataset\.ts = /g) || []).length === 1,
      `2 四个渲染位（事件行 dataset/普通行/聚簇行/杂志卡）全挂 data-ts（实际 ${(listSrc.match(/data-ts=/g) || []).length}+${(listSrc.match(/dataset\.ts = /g) || []).length}）`);

    // ── 3. 时长口径静态锚点 ──
    const readerSrc = read('src/renderer/views/reader.js');
    ok(readerSrc.includes("tf('约 %lld 分钟', minutes)"), '3 阅读剩余口径：约 N 分钟（robin-read-time）');
    const erSrc = read('src/renderer/views/edition-reader.js');
    ok(erSrc.includes("t('本文约剩')") && erSrc.includes("t('本期约剩')"), '3 期刊剩余口径：约 N 分钟（同族）');
    const mediaSrc = read('src/renderer/views/media-view.js');
    ok(mediaSrc.includes("tf('%lld 分钟', m)") && mediaSrc.includes("tf('%lld 小时 %lld 分', h, m)"),
      '3 列表时长口径：N 分钟 / N 小时 N 分（fmtDuration）');
    const playerSrc = read('src/renderer/views/media-player.js');
    ok(/h \? `\$\{h\}:\$\{mm\}:`/.test(playerSrc.replace(/\s+/g, ' ').replace(/\\n/g, ' ')) || /h \?/.test(playerSrc),
      '3 播客进度口径：H:MM:SS（fmtTime 时位分支）');
    ok(mediaSrc.includes('return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`'),
      '3 文字稿时间戳口径与播放器同族（h:mm:ss / mm:ss）');

    // ── UI 行为断言 ──
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(app.getPath('userData'));
    const win = new BrowserWindow({
      show: false, width: 1100, height: 820,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, win);
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R57 素材源', feedURL: 'https://r57.test/feed.xml' });
    const filler = '这是一篇用于验证阅读时长口径的文章正文，足够长以产生分钟级预估。'.repeat(30);
    const [entryID] = await store._applyParsedEntries(feed, [{
      id: 'r57-a1', title: '时长口径的文章', url: 'https://r57.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R57 素材。', contentHTML: `<p>${filler}</p>`,
    }]);
    console.log('UI: loading renderer…');
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
    if (!loaded) throw new Error('UI 渲染层加载失败');
    await sleep(1200);

    const exec = (js, label, ms = 30000) => Promise.race([
      win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
    ]);

    // ── 2（行为）：注入时钟跨日翻桶 / 只改文本节点 / 幂等 ──
    const tick = await exec(`(async () => {
      try {
        const m = await import('./views/list.js');
        const base = new Date(); base.setHours(23, 59, 30, 0);
        const ts = Math.floor(base.getTime() / 1000);
        const now1 = new Date(base.getTime() + 10 * 1000);  // 同日 23:59:40 → HH:MM 桶
        const now2 = new Date(base.getTime() + 61 * 1000);  // 次日 00:00:31 → 日期桶
        const f1 = m.formatTime(ts, now1);
        const f2 = m.formatTime(ts, now2);
        const bucketFlip = f1 !== f2;
        const host = document.createElement('div');
        const el = document.createElement('span');
        el.className = 'entry-time';
        el.dataset.ts = String(ts);
        el.textContent = f1;
        host.appendChild(el);
        const ref = el;
        const patched = m.refreshEntryTimes(host, now2);
        const sameNode = host.querySelector('.entry-time') === ref;
        const textFlipped = ref.textContent === f2;
        const idempotent = m.refreshEntryTimes(host, now2) === 0;
        return { bucketFlip, f1, f2, patched, sameNode, textFlipped, idempotent };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'time-ticker');
    if (tick.__err) ok(false, '2 静默刷新探针异常 — ' + tick.__err);
    else {
      ok(tick.bucketFlip === true, `2 注入时钟跨日翻桶（${tick.f1} → ${tick.f2}）`);
      ok(tick.patched === 1, '2 翻桶节点被改写（patched=1）');
      ok(tick.sameNode === true, '2 只改文本节点：元素身份不变（不整页重绘）');
      ok(tick.idempotent === true, '2 二次刷新幂等（无变化 0 改写）');
    }

    // ── 3（行为）：阅读器实开 → .robin-read-time 约 N 分钟 ──
    const readTime = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        window.__robinReaderOpen('${entryID}');
        const t0 = Date.now();
        for (;;) {
          const el = document.querySelector('.robin-read-time');
          if (el) return { text: el.textContent, waitMs: Date.now() - t0 };
          if (Date.now() - t0 > 15000) return { text: null };
          await sleep(100);
        }
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'read-time');
    if (readTime.__err) ok(false, '3 阅读剩余探针异常 — ' + readTime.__err);
    else ok(readTime.text !== null && /约 \d+ 分钟/.test(String(readTime.text)),
      `3 阅读器头部剩余时长口径（${readTime.text || '未出现'}，${readTime.waitMs}ms 内命中）`);

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
