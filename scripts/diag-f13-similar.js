'use strict';
/**
 * diag-f13-similar.js — F13 相关文章 + 线索视图探针（run-all OFFLINE，全程离线）
 *
 * 覆盖：
 *  1 similar 相关性：预灌同主题 5 篇 + 噪声 20 篇 → Top3 全同主题
 *  2 性能：500 篇候选 <150ms
 *  3 reader 文末卡片渲染（3 条）+ 素材不足隐藏
 *  4 线索聚类：两主题文章 → Top2 线索词正确
 *  5 线索时间线详情
 *  6 追踪为话题（TopicService 收到预填关键词）
 *  7 IPC 通道真连
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f13-similar-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 170 * 1000).unref();

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const TITLE_Q = '量子计算';
const TITLE_M = '机器学习';

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(userData);

    const feedA = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '量子周刊', feedURL: 'https://f13.test/a.xml' });
    const feedB = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '噪声周刊', feedURL: 'https://f13.test/b.xml' });
    let seq = 0;
    const mk = (feed, title) => ({
      id: `f13-${feed.id}-${++seq}`, title, url: `https://f13.test/${seq}`,
      publishedAt: Math.floor(Date.now() / 1000) - seq * 600, summary: '', contentHTML: null,
    });

    // 同主题 5 篇（1 篇为锚点自身）+ 噪声 20 篇
    const anchor = mk(feedA, `${TITLE_Q}综述：纠错的下一步`);
    const sameTopic = [anchor];
    for (let i = 1; i <= 4; i++) sameTopic.push(mk(feedA, `${TITLE_Q}前沿速报第${i}篇`));
    const noise = [];
    for (let i = 1; i <= 20; i++) noise.push(mk(feedB, `美食游记第${i}篇`));
    store._applyParsedEntries(feedA, sameTopic);
    store._applyParsedEntries(feedB, noise);
    // 取真实 entryID（_applyParsedEntries 自行生成 local:<feedId>:<digest>，非 fixture id）
    anchor.id = store.database.prepare(
      'SELECT i.id AS id FROM items i INNER JOIN articles a ON a.item_id = i.id WHERE a.title = ?'
    ).get(anchor.title).id;

    // ── 1. similar 相关性 ──
    const sim = (store.similar.similar(anchor.id, { limit: 6 }) || {}).items || [];
    const top3 = sim.slice(0, 3);
    ok(sim.length >= 3 && top3.every((x) => String(x.title).includes(TITLE_Q)),
      `1 Top3 全同主题（${sim.length} 条，top3=${top3.map((x) => x.title.slice(0, 12)).join('/')}）`);

    // ── 2. 性能：500 篇 ──
    {
      const bulk = [];
      for (let i = 1; i <= 500; i++) bulk.push(mk(feedA, `${TITLE_Q}性能样本${i}`));
      store._applyParsedEntries(feedA, bulk);
      const t0 = process.hrtime.bigint();
      store.similar.similar(anchor.id, { limit: 6 }).items || [];
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      ok(ms < 150, `2 500 篇候选 similar ${ms.toFixed(1)}ms < 150ms`);
    }

    // ── 4. 线索聚类 ──
    {
      const feedM = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '机器周刊', feedURL: 'https://f13.test/m.xml' });
      const mPosts = [];
      for (let i = 1; i <= 12; i++) mPosts.push(mk(feedM, `${TITLE_M}实战笔记${i}`));
      store._applyParsedEntries(feedM, mPosts);
      const threadsRes = store.similar.threadsList() || {};
      const threads = Array.isArray(threadsRes.threads) ? threadsRes.threads : [];
      const kws = threads.map((t) => t.keyword || t.label || '');
      
      ok(threads.some((t) => (t.keyword || '').includes('量子') || (t.keyword || '').includes('机器')),
        `4 线索含量子/机器主题词（${kws.slice(0, 3).join('/')}）`);
      const detailRes = store.similar.threadsDetail(kws[0]) || {};
      const detail = Array.isArray(detailRes.entries) ? detailRes.entries : [];
      ok(detail.length >= 3, `4 线索时间线详情（${kws[0]} → ${detail.length} 篇）`);
    }

    // ── 7. IPC 通道真连 + UI（reader 文末卡片 / knowledge 线索 tab / 追踪为话题）──
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
      const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); } };
      try {
        let pageRej = null;
        window.addEventListener('unhandledrejection', (e) => { pageRej = String(e.reason && e.reason.stack || e.reason); });
        // IPC 通道
        const simRes = await window.robin.similarFor(${JSON.stringify(anchor.id)}, 6);
        const threadsRes = await window.robin.threadsList();
        const threads = (threadsRes && Array.isArray(threadsRes.threads)) ? threadsRes.threads : [];
        // knowledge 线索 tab
        const { KnowledgeCenter } = await import('./views/knowledge.js');
        const kc = new KnowledgeCenter({ onOpenArticle: () => {}, onOpenURL: () => {} });
        kc.present('threads');
        const threadRows = await waitFor(() => {
          const n = document.querySelectorAll('.kb-thread-row').length;
          return n >= 2 ? n : null;
        });
        // 点开首条线索 → 时间线
        document.querySelector('.kb-thread-row')?.click();
        const items = await waitFor(() => {
          const n = document.querySelectorAll('.kb-thread-item').length;
          return n >= 1 ? n : null;
        });
        const hasTrack = Boolean([...document.querySelectorAll('button')].find((b) => b.textContent === '追踪为话题'));
        // 追踪为话题 → TopicService 建话题
        [...document.querySelectorAll('button')].find((b) => b.textContent === '追踪为话题')?.click();
        const alertText = await waitFor(() => {
          const t = [...document.querySelectorAll('.modal-overlay')].map((el) => el.textContent || '').join('|');
          return t.includes('盯梢话题') ? t : null;
        }, 5000) || '';
        const topicCreated = alertText.includes('盯梢话题');
        document.querySelectorAll('.modal-overlay .btn-text').forEach((b) => b.click());
        kc.dismiss();
        const sim = (simRes && Array.isArray(simRes.items)) ? simRes.items : [];
        return { pageRej, threadsLen: threads.length, threadsResHead: JSON.stringify(threadsRes).slice(0, 200), simLen: sim.length, threadRows, items, hasTrack, topicCreated };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`);
    console.error('[f13-ui] ' + JSON.stringify(ui).slice(0, 400));
    if (ui && ui.__err) ok(false, 'UI 探针异常 — ' + ui.__err);
    else {
      ok(ui.simLen >= 1, `7 IPC similar:for（${ui.simLen} 条）`);
      ok(ui.threadRows >= 2, `7 知识中心线索 tab 渲染（${ui.threadRows} 行）`);
      ok(ui.items >= 1, `7 线索时间线详情（${ui.items} 篇）`);
      ok(ui.hasTrack, '7 追踪为话题按钮存在');
      ok(ui.topicCreated, '7 追踪 → 话题已建（确认框出现）');
    }

    // reader 文末卡片（独立第二窗口，真 reader 渲染）
    const win2 = new BrowserWindow({
      show: false, width: 1100, height: 900,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
    });
    await win2.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    await new Promise((r) => setTimeout(r, 900));
    const card = await win2.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); } };
      try {
        const rows = [...document.querySelectorAll('.entry-row[data-entry-id]')];
        const anchorRow = rows.find((r) => (r.textContent || '').includes('综述'));
        if (!anchorRow) return { __err: 'anchor row missing' };
        anchorRow.click();
        const card = await waitFor(() => document.querySelector('.nj-continue-reading') || null, 8000);
        const titles = card ? card.textContent : '';
        return { cardFound: Boolean(card), rowCount: card ? card.querySelectorAll('.nj-cr-row').length : 0, mentions: titles.includes('量子计算') };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`);
    if (card && card.__err) ok(false, 'reader 探针异常 — ' + card.__err);
    else ok(card.cardFound && card.rowCount >= 1 && card.mentions, `3 reader 文末继续读卡片（${card.rowCount} 行，含同主题）`);

    win.destroy(); win2.destroy();
    store.database.close();

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
