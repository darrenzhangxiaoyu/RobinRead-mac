'use strict';
/**
 * diag-f16-dashboard.js — F16 订阅源体检仪表盘探针（run-all OFFLINE，全程离线）
 *
 * 覆盖：
 *  1 指标聚合：源 A 30 篇 20 已读 2 收藏 + feed_health 失败 2 次；源 B 0 篇失败 5 次
 *    → 健康分 A>B、B 红档（<50）、A 黄档；阅读率/收藏率口径正确
 *  2 总览三计数：健康源/沉默源/失败源（补源 C → top≥1）
 *  3 缓存 60s：注入时钟 → TTL 内命中缓存不重算（computed 不变），过窗重算
 *  4 建议文案：30 天无更新 / 连续失败 N 次 / 失败率过高 / 从未成功 / 运行良好
 *  5 详情接口：feedDetail 返回失败率/趋势桶/最近成功
 *  6 UI：知识中心「源体检」tab 渲染 + 总览卡点击过滤 + 详情面板（真 IPC）
 *  7 聚合无 N+1：200 源全量重算 <300ms
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f16-dash-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 170 * 1000).unref();

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400;

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { FeedDashboardService } = require('../src/main/FeedDashboardService');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(userData);
    const now = Math.floor(Date.now() / 1000);

    // ── 预灌：源 A（30 篇 / 20 已读 / 2 收藏 / 抓取失败 2 次）──
    const feedA = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F16 活跃刊 A', feedURL: 'https://f16.test/a.xml' });
    const entriesA = [];
    for (let i = 1; i <= 30; i++) {
      entriesA.push({ id: `a-${i}`, title: `活跃刊文章${i}`, url: `https://f16.test/a/${i}`, publishedAt: now - i * 8 * 3600, summary: '', contentHTML: null });
    }
    store._applyParsedEntries(feedA, entriesA);
    const idsA = store.database.prepare('SELECT id FROM items WHERE feed_id = ?').all(feedA.id).map((r) => r.id);
    const readSet = new Set(idsA.slice(0, 20));
    const starSet = new Set(idsA.slice(0, 2));
    store.database.transaction(() => {
      const upd = store.database.prepare('UPDATE article_states SET is_read = ?, is_starred = ? WHERE item_id = ?');
      for (const id of idsA) upd.run(readSet.has(id) ? 1 : 0, starSet.has(id) ? 1 : 0, id);
    });
    store.evolution.recordFetch({ feedID: feedA.id, ok: false, error: 'mock 失败甲' });
    store.evolution.recordFetch({ feedID: feedA.id, ok: false, error: 'mock 失败乙' });

    // ── 预灌：源 B（0 篇 / 连续失败 5 次 → 死源口径）──
    const feedB = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F16 沉默刊 B', feedURL: 'https://f16.test/b.xml' });
    for (let i = 1; i <= 5; i++) store.evolution.recordFetch({ feedID: feedB.id, ok: false, error: `mock 连败 ${i}` });

    // ── 预灌：源 C（20 篇 / 15 已读 / 抓取成功 → 高分）──
    const feedC = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F16 健康刊 C', feedURL: 'https://f16.test/c.xml' });
    const entriesC = [];
    for (let i = 1; i <= 20; i++) entriesC.push({ id: `c-${i}`, title: `健康刊文章${i}`, url: `https://f16.test/c/${i}`, publishedAt: now - i * 3 * 3600, summary: '', contentHTML: null });
    store._applyParsedEntries(feedC, entriesC);
    const idsC = store.database.prepare('SELECT id FROM items WHERE feed_id = ?').all(feedC.id).map((r) => r.id);
    store.database.transaction(() => {
      const upd = store.database.prepare('UPDATE article_states SET is_read = 1 WHERE item_id = ?');
      for (const id of idsC.slice(0, 15)) upd.run(id);
    });
    store.evolution.recordFetch({ feedID: feedC.id, ok: true, entryCount: 20 });

    // ── 1. 指标聚合与健康分 ──
    const dash = new FeedDashboardService(store, { now: () => now });
    const ov = dash.overview();
    const byID = new Map(ov.feeds.map((f) => [f.feedID, f]));
    const A = byID.get(feedA.id), B = byID.get(feedB.id), C = byID.get(feedC.id);
    ok(A && B && C, '1 三源均入体检列表');
    ok(A.score > B.score, `1 健康分 A>B（A=${A.score}，B=${B.score}）`);
    ok(B.band === 'bad' && B.score < 50, `1 源 B 红档（${B.band}/${B.score}）`);
    ok(A.band === 'warn', `1 源 A 黄档（${A.band}/${A.score}）`);
    ok(A.posts30 === 30 && A.reads30 === 20 && A.stars30 === 2, `1 发文/已读/收藏（${A.posts30}/${A.reads30}/${A.stars30}）`);
    ok(Math.abs(A.readRate - 20 / 30) < 0.01 && Math.abs(A.starRate - 2 / 30) < 0.01,
      `1 阅读率/收藏率口径（${A.readRate}/${A.starRate}）`);
    ok(A.failureRate === 1 && B.consecutiveFailures === 5, `1 抓取口径（A 失败率=${A.failureRate}，B 连败=${B.consecutiveFailures}）`);
    ok(Array.isArray(A.trend) && A.trend.length === 30 && A.trend.reduce((s, n) => s + n, 0) === 30,
      `1 30 天趋势桶守恒（sum=${A.trend.reduce((s, n) => s + n, 0)}）`);

    // ── 2. 总览三计数 ──
    ok(ov.summary.top >= 1 && ov.summary.silent >= 1 && ov.summary.failing >= 1,
      `2 总览三计数（top=${ov.summary.top}，silent=${ov.summary.silent}，failing=${ov.summary.failing}）`);
    ok(C.band === 'good' && C.score >= 80, `2 源 C 绿档（${C.band}/${C.score}）`);
    ok(ov.feeds[0].feedID === feedC.id, '2 列表按健康分降序（C 居首）');

    // ── 3. 缓存 60s（注入时钟） ──
    let clock = now;
    const dash2 = new FeedDashboardService(store, { now: () => clock });
    dash2.overview();
    clock += 30;
    dash2.overview();
    const midSnap = dash2.snapshot();
    clock += 31;
    dash2.overview();
    const endSnap = dash2.snapshot();
    ok(midSnap.computed === 1 && midSnap.cacheHits === 1, `3 TTL 内命中缓存不重算（computed=${midSnap.computed}，hits=${midSnap.cacheHits}）`);
    ok(endSnap.computed === 2, `3 过 60s 窗口后重算（computed=${endSnap.computed}）`);

    // ── 4/5. 建议文案 + 详情接口 ──
    const dB = dash.feedDetail(feedB.id);
    const codesB = dB.suggestions.map((s) => s.code);
    ok(codesB.includes('noUpdate30d'), `4 沉默源建议「30 天无更新」（${JSON.stringify(codesB)}）`);
    ok(codesB.includes('consecutiveFailures') && dB.suggestions.find((s) => s.code === 'consecutiveFailures').count === 5,
      '4 连败源建议「连续失败 N 次，建议检查源」');
    const dA = dash.feedDetail(feedA.id);
    const codesA = dA.suggestions.map((s) => s.code);
    ok(codesA.includes('highFailureRate') && codesA.includes('neverSucceeded'), `4 高失败率 + 从未成功建议（${JSON.stringify(codesA)}）`);
    const dC = dash.feedDetail(feedC.id);
    ok(dC.suggestions.length === 1 && dC.suggestions[0].code === 'healthy', '4 健康源建议「运行良好」');
    ok(dA.attempts === 2 && dA.lastSuccessAt === null && dC.lastSuccessAt > 0,
      `5 详情接口：尝试数/最近成功抓取（A=${dA.attempts}/null，C 成功）`);
    ok(dash.feedDetail('no-such-feed') === null, '5 详情接口：未知源返回 null');

    // ── 7. 聚合无 N+1：200 源全量重算 <300ms ──
    {
      const bulk = [];
      for (let i = 1; i <= 200; i++) {
        const f = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: `F16 压力刊 ${i}`, feedURL: `https://f16.test/bulk/${i}.xml` });
        bulk.push({ feed: f, entries: [
          { id: `bk-${i}-1`, title: `压力文章${i}-1`, url: `https://f16.test/bulk/${i}/1`, publishedAt: now - 3600 * (i % 24), summary: '', contentHTML: null },
          { id: `bk-${i}-2`, title: `压力文章${i}-2`, url: `https://f16.test/bulk/${i}/2`, publishedAt: now - 3600 * 26, summary: '', contentHTML: null },
        ] });
      }
      for (const { feed, entries } of bulk) store._applyParsedEntries(feed, entries);
      dash.invalidate();
      const t0 = process.hrtime.bigint();
      const big = dash.overview();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      ok(big.feeds.length >= 203 && ms < 300, `7 ${big.feeds.length} 源全量重算 ${ms.toFixed(1)}ms < 300ms（无 N+1 聚合）`);
    }

    // ── 6. UI：知识中心「源体检」tab + 总览卡过滤 + 详情（真 IPC）──
    const { BrowserWindow } = require('electron');
    const { registerIPCHandlers } = require('../src/main/ipc');
    const win = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
    });
    registerIPCHandlers(store, win);
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    await sleep(900);
    const ui = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, ms = 8000) => {
        const t0 = Date.now();
        for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); }
      };
      try {
        const { KnowledgeCenter } = await import('./views/knowledge.js');
        const kc = new KnowledgeCenter({ onOpenArticle: () => {}, onOpenURL: () => {} });
        kc.present('dash');
        const tabOn = await waitFor(() => document.querySelector('.kb-dash-cards') ? true : null);
        const cards = [...document.querySelectorAll('.kb-dash-card-label')].map((n) => n.textContent);
        const cardNums = [...document.querySelectorAll('.kb-dash-card-num')].map((n) => n.textContent);
        const rows = await waitFor(() => document.querySelectorAll('.kb-dash-row').length >= 3 ? document.querySelectorAll('.kb-dash-row') : null);
        const badges = [...rows].map((r) => r.querySelector('.kb-dash-score-badge')?.className || '');
        const hasBands = ['good', 'warn', 'bad'].every((b) => badges.some((x) => x.includes(b)));
        const barsOn = Boolean(rows[0].querySelector('.kb-dash-bars i'));
        const metaOn = [...rows].some((r) => (r.querySelector('.kb-dash-meta')?.textContent || '').includes('最近成功抓取'));
        // 点击「沉默源」总览卡 → 过滤到 1 行（源 B）
        [...document.querySelectorAll('.kb-dash-card')].find((c) => c.textContent.includes('沉默源')).click();
        await sleep(150);
        const filteredN = document.querySelectorAll('.kb-dash-row').length;
        const filteredTitle = document.querySelector('.kb-dash-row .kb-dash-title')?.textContent || '';
        // 取消过滤 → 详情：点首行（C，最高分）
        [...document.querySelectorAll('.kb-dash-card')].find((c) => c.textContent.includes('沉默源')).click();
        await sleep(150);
        document.querySelector('.kb-dash-row').click();
        const detail = await waitFor(() => document.querySelector('.kb-dash-metrics') ? true : null);
        const detailText = document.querySelector('.modal-scroll')?.textContent || '';
        const hasMetrics = detailText.includes('30 天发文') && detailText.includes('阅读率') && detailText.includes('抓取失败率');
        const hasTrend = Boolean(document.querySelector('.kb-dash-trend i'));
        const hasSuggest = detailText.includes('体检建议') && detailText.includes('运行良好');
        const backOn = [...document.querySelectorAll('button')].some((b) => b.textContent.includes('返回源体检'));
        // IPC 直读
        const ov = await window.robin.dashOverview();
        const fd = await window.robin.dashFeed(ov.feeds[0].feedID);
        kc.dismiss();
        return { tabOn, cards, cardNums, rowsN: rows.length, hasBands, barsOn, metaOn, filteredN, filteredTitle,
          detailOn: Boolean(detail), hasMetrics, hasTrend, hasSuggest, backOn,
          ipcOk: ov && ov.summary && fd && typeof fd.failureRate === 'number' };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`);
    if (ui && ui.__err) ok(false, '6 UI 探针异常 — ' + ui.__err);
    else {
      ok(ui.tabOn, '6 「源体检」tab 打开渲染');
      ok(JSON.stringify(ui.cards) === JSON.stringify(['健康源', '沉默源', '失败源']), `6 总览三卡（${JSON.stringify(ui.cards)}）`);
      ok(ui.rowsN >= 3 && ui.hasBands, `6 源行 + 三档徽标（rows=${ui.rowsN}）`);
      ok(ui.barsOn && ui.metaOn, '6 迷你发文条 + 最近成功抓取时间');
      ok(ui.cardNums.length === 3 && ui.cardNums.every((x) => /^\d+$/.test(x)), `6 总览计数（${JSON.stringify(ui.cardNums)}）`);
      ok(ui.filteredN === 1 && ui.filteredTitle.includes('B'), `6 沉默源卡点击过滤（rows=${ui.filteredN}，${ui.filteredTitle}）`);
      ok(ui.detailOn && ui.hasMetrics && ui.hasTrend, '6 详情：指标 + 月度趋势条');
      ok(ui.hasSuggest && ui.backOn, '6 详情：建议文案 + 返回按钮');
      ok(ui.ipcOk, '6 IPC dash:overview / dash:feed 可用');
    }

    win.destroy();
    store.database.close();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
