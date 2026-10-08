'use strict';
/**
 * diag-f14-sort.js — F14 智能排序 + 信息密度三档探针（run-all OFFLINE，全程离线）
 *
 * 覆盖：
 *  1 智能排序：预灌画像行为 → 命中画像词的文章排前
 *  2 空画像降级：纯时间序 + 菜单仍可选
 *  3 密度三档：body[data-list-density] 切换 + 偏好持久化
 *  4 智能排序偏好持久化
 *  5 200 篇排序 <200ms
 *  6 与既有三态循环兼容（shortFirst 不再被吞）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f14-sort-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 170 * 1000).unref();

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(userData);

    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F14 周刊', feedURL: 'https://f14.test/a.xml' });
    let seq = 0;
    const mk = (title, ageHours) => ({
      id: `f14-${++seq}`, title, url: `https://f14.test/${seq}`,
      publishedAt: Math.floor(Date.now() / 1000) - ageHours * 3600, summary: '', contentHTML: null,
    });

    // 候选 20 篇未读：10 篇命中画像词 + 10 篇噪声
    // 时间基准取「今日 00:00 起」的绝对锚点，而非相对 now 的小时偏移——
    // 修正：在 00:00–03:00 本地时段运行时，1–12h 相对钟会把种子推到昨日，today 域变空产生假阴性。
    const startOfDayTs = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime() / 1000);
    const candidates = [];
    for (let i = 1; i <= 10; i++) {
      candidates.push({ id: `f14-hit-${i}`, title: `量子计算新进展${i}`, url: `https://f14.test/hit/${i}`, publishedAt: startOfDayTs + i * 60, summary: '', contentHTML: null });
    }
    for (let i = 1; i <= 10; i++) {
      candidates.push({ id: `f14-noise-${i}`, title: `美食探店${i}`, url: `https://f14.test/noise/${i}`, publishedAt: startOfDayTs + (10 + i) * 60, summary: '', contentHTML: null });
    }

    // 画像行为：对 10 篇「历史已读」量子计算文章记已读（真实 entryID，FK 才能满足）
    const history = [];
    for (let i = 1; i <= 10; i++) history.push(mk(`量子计算历史读物${i}`, 24 * (i + 1)));
    store._applyParsedEntries(feed, history);
    for (const h of history) {
      const row = store.database.prepare('SELECT i.id AS id FROM items i INNER JOIN articles a ON a.item_id = i.id WHERE a.title = ?').get(h.title);
      store.evolution.recordBehavior({ itemID: row.id, feedID: feed.id, action: 'read', weight: 1 });
    }

    store._applyParsedEntries(feed, candidates);

    // ── 1. 智能排序 ──
    const t0 = process.hrtime.bigint();
    const smart = store.listItems({ kind: 'today' }, { limit: 20, sort: 'smart' });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const top5 = smart.slice(0, 5).map((x) => x.title);
    ok(smart.length > 0 && top5.every((t) => t.includes('量子计算')), `1 智能排序 Top5 全命中（${top5.slice(0, 3).join('/')}）`);
    ok(ms < 200, `1 智能排序 20 篇 ${ms.toFixed(1)}ms < 200ms`);

    // ── 5. 200 篇压力 ──
    {
      const bulk = [];
      for (let i = 1; i <= 200; i++) bulk.push(mk(`量子计算压力样本${i}`, 3 + (i % 72)));
      store._applyParsedEntries(feed, bulk);
      const t1 = process.hrtime.bigint();
      store.listItems({ kind: 'today' }, { limit: 30, sort: 'smart' });
      const ms1 = Number(process.hrtime.bigint() - t1) / 1e6;
      ok(ms1 < 200, `5 200+ 篇智能排序 ${ms1.toFixed(1)}ms < 200ms`);
    }

    // ── 2. 空画像降级（新库）──
    {
      const store2 = new AppStore(fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f14-empty-')));
      const f2 = store2.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '空画像刊', feedURL: 'https://f14.test/e.xml' });
      const items = [];
      for (let i = 1; i <= 5; i++) {
        const e = { id: `e-${i}`, title: `空画像文章${i}`, url: `https://f14.test/e/${i}`, publishedAt: Math.floor(Date.now() / 1000) - i * 60, summary: '', contentHTML: null };
        store2._applyParsedEntries(f2, [e]);
        items.push(e);
      }
      const list = store2.listItems({ kind: 'today' }, { limit: 10, sort: 'smart' });
      // 降级=纯时间序：最新的在前
      ok(list.length === 5 && list[0].title === '空画像文章1', '2 空画像降级纯时间序（最新在前）');
      store2.database.close();
    }

    // ── 3/4/6. UI：密度三档 + 四态循环 + 持久化 ──
    const { BrowserWindow } = require('electron');
    const { registerIPCHandlers } = require('../src/main/ipc');
    const win = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
    });
    registerIPCHandlers(store, win);
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    await new Promise((r) => setTimeout(r, 900));
    const ui = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        // 密度三档
        const densities = ['compact', 'comfortable', 'relaxed'];
        const seen = [];
        for (const d of densities) {
          await window.robin.setReaderLayout({ listDensity: d });
          await sleep(150);
          seen.push(document.body.dataset.listDensity);
        }
        // 智能排序设置
        await window.robin.setReaderLayout({ listSort: 'smart' });
        await sleep(150);
        const sortBtnText = document.querySelector('#list-sort-btn')?.textContent || '';
        return { seen, sortBtnText, sortPersist: true };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`);
    if (ui && ui.__err) ok(false, 'UI 探针异常 — ' + ui.__err);
    else {
      ok(JSON.stringify(ui.seen) === JSON.stringify(['compact', 'comfortable', 'relaxed']),
        `3 密度三档切换（${JSON.stringify(ui.seen)}）`);
      ok(ui.sortBtnText.includes('智能'), `3 智能排序按钮文案（${ui.sortBtnText.trim()}）`);
    }

    // 持久化：读回偏好
    const snap = store.readerLayout();
    ok(snap.listDensity === 'relaxed', `3 密度偏好持久化（${snap.listDensity}）`);
    ok(snap.listSort === 'smart', `4 智能排序偏好持久化（${snap.listSort}）`);

    // 6. shortFirst 不再被吞（四态验证回归）
    await win.webContents.executeJavaScript(`window.robin.setReaderLayout({ listSort: 'shortFirst' })`);
    await new Promise((r) => setTimeout(r, 150));
    const snap2 = store.readerLayout();
    ok(snap2.listSort === 'shortFirst', `6 shortFirst 四态透传不再被吞（${snap2.listSort}）`);

    win.destroy();
    store.database.close();

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
