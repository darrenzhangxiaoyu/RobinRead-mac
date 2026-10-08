'use strict';
/**
 * diag-f17-windows.js — F17 多窗并读端到端探针（run-all OFFLINE 集，全程离线）
 *
 * 覆盖（对应 F17 验收 7 条）：
 *  1 弹出窗口创建 + 窗口标题 = 文章标题（主进程 setTitle + 渲染层 document.title 双保险）
 *  2 同 entryID 重复打开 → 聚焦既有窗口（每文章一个窗口上限，不新建）
 *  3 并发上限 4 个：第 5 个抛本地化错误
 *  4 主窗口关闭 → 全部弹出窗级联关闭（main.js close 事件同款接线）
 *  5 弹出窗内 reader 渲染文章（同 ReaderView）+ 已读/批注写回同库（同 preload IPC 通路）
 *  6 右键菜单入口：列表行 contextmenu 菜单含「在独立窗口打开」+ 阅读器工具栏弹出按钮存在
 *  7 TTS/媒体在弹出窗禁用（mode:'popup' 构造选项）：无「听」按钮 / 无媒体卡 / toggleTTS 短路
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f17-windows-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 170 * 1000).unref();

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 12000) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (_) { /* 未就绪 */ }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(150);
  }
}

app.whenReady().then(async () => {
  let owner = null;
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { registerIPCHandlers } = require('../src/main/ipc');
    const { readerWindows, MAX_READER_WINDOWS } = require('../src/main/ReaderWindows');

    const store = new AppStore(userData);
    const content = ('这是一篇用于多窗并读探针的文章正文。').repeat(30);
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '多窗周刊', feedURL: 'https://f17.test/a.xml' });
    const mk = (title, html) => {
      store._applyParsedEntries(feed, [{
        id: `f17-${title}`, title, url: `https://f17.test/${encodeURIComponent(title)}`,
        publishedAt: Math.floor(Date.now() / 1000) - 60, summary: title, contentHTML: html || `<p>${content}</p>`,
      }]);
      return store.database.prepare('SELECT id FROM items WHERE feed_id = ? ORDER BY rowid DESC LIMIT 1').get(feed.id).id;
    };
    const entryA = mk('多窗并读：第一篇文章');
    const entryB = mk('多窗并读：第二篇文章');
    const entryC = mk('多窗并读：第三篇文章');
    const entryD = mk('多窗并读：第四篇文章');
    const entryE = mk('多窗并读：第五篇文章');
    const entryMedia = mk('多窗并读：带音频的文章');
    // 媒体行（F3）：验证弹出窗不启用媒体卡
    store.media.upsertFromParsed(entryMedia, { url: 'https://f17.test/ep1.mp3', kind: 'audio', mime: 'audio/mpeg' });

    // 主窗口替身 + 与 main.js 同款的级联接线 + IPC（真信封）
    owner = new BrowserWindow({
      show: false, width: 1100, height: 800,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
    });
    registerIPCHandlers(store, owner);
    owner.on('close', (event) => {
      if (event.defaultPrevented) return; // 关闭到托盘：仅隐藏
      try { readerWindows.closeAll(); } catch (_) { /* 退出路径不抛错 */ }
    });

    // ── 1. 弹出窗口创建 + 标题 = 文章标题 ──
    const r1 = readerWindows.open(store, owner, entryA);
    ok(r1.created === true && readerWindows.count() === 1, `1 弹出窗口创建（count=${readerWindows.count()}）`);
    const winA = (await waitFor(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getTitle().includes('多窗并读：第一篇文章'))));
    ok(!!winA, `1 窗口标题 = 文章标题（title=${winA && winA.webContents.getTitle()}）`);

    // ── 2. 同 entryID 重复打开 → 聚焦 ──
    const r2 = readerWindows.open(store, owner, entryA);
    ok(r2.created === false && r2.focused === true && readerWindows.count() === 1 && r2.windowId === r1.windowId,
      '2 同 entryID 重复打开：聚焦既有窗口（不新建）');

    // ── 3. 上限 4 个 ──
    readerWindows.open(store, owner, entryB);
    readerWindows.open(store, owner, entryC);
    readerWindows.open(store, owner, entryD);
    ok(readerWindows.count() === MAX_READER_WINDOWS, `3 并发达上限（count=${readerWindows.count()}）`);
    let capped = false;
    let capMessage = '';
    try { readerWindows.open(store, owner, entryE); } catch (err) { capped = true; capMessage = String(err.message || err); }
    ok(capped && capMessage.includes('4'), `3 第 5 个被拒并给出上限提示（${capMessage.trim().slice(0, 30)}…）`);

    // ── 5. 弹出窗内 reader 渲染文章 + 已读/批注写回同库（先于 ④ 级联验证） ──
    const rendered = await winA.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, ms = 12000) => {
        const t0 = Date.now();
        for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(150); }
      };
      try {
        const hasRobin = typeof window.robin?.getReader === 'function';
        const reader = await waitFor(() => (window.__robinReader && window.__robinReader.entry) ? window.__robinReader : null);
        if (!reader) return { ok: false, why: 'reader-not-open', hasRobin };
        const h1 = await waitFor(() => document.querySelector('.reader-article h1')?.textContent || null);
        const read = await window.robin.markRead(window.__robinReader.entryID, true);
        return {
          ok: true, hasRobin, h1,
          entryID: window.__robinReader.entryID,
          markReadOk: read && read.ok === true,
          mode: window.__robinReader.handlers.mode || null,
        };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    })()`);
    ok(rendered && rendered.ok === true && rendered.h1 === '多窗并读：第一篇文章',
      `5 弹出窗 reader 渲染文章（h1=${rendered && rendered.h1}）`);
    ok(rendered && rendered.hasRobin === true && rendered.mode === 'popup',
      '5 弹出窗同 preload（robin API 可用）+ mode=popup 构造选项生效');
    ok(rendered && rendered.markReadOk === true
      && Number(store.database.prepare('SELECT is_read FROM article_states WHERE item_id = ?').get(entryA)?.is_read) === 1,
      '5 已读状态写回同一 DB');
    {
      // 批注写回同库：弹出窗页面内走 kbAddHighlight（与主窗同通路）
      const hl = await winA.webContents.executeJavaScript(`(async () => {
        try {
          const r = await window.robin.kbAddHighlight({ itemID: ${JSON.stringify(entryA)}, text: '弹出窗批注', color: 'yellow' });
          return { ok: r && r.ok === true };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })()`);
      const dbRow = store.database.prepare("SELECT id FROM highlights WHERE item_id = ? AND text = '弹出窗批注'").get(entryA);
      ok(hl.ok === true && !!dbRow, '5 批注经弹出窗写回同一 DB（highlights 落行）');
    }

    // ── 7. TTS/媒体在弹出窗禁用 ──
    // 已满 4 窗：先关 B/C/D 三窗腾位，再开媒体文章窗
    for (const id of [entryB, entryC, entryD]) {
      const rec = readerWindows.list().find((w) => w.entryID === id);
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && rec && x.webContents.id === rec.windowId);
      if (w) w.close();
    }
    await waitFor(() => readerWindows.count() === 1);
    const rm = readerWindows.open(store, owner, entryMedia);
    const winM = await waitFor(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getTitle().includes('带音频的文章')));
    ok(rm.created === true && !!winM, '7 媒体文章弹出窗已开');
    const mediaProbe = await winM.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, ms = 12000) => {
        const t0 = Date.now();
        for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(150); }
      };
      try {
        const reader = await waitFor(() => (window.__robinReader && window.__robinReader.entry) ? window.__robinReader : null);
        if (!reader) return { ok: false, why: 'reader-not-open' };
        await waitFor(() => document.querySelector('.reader-article h1') ? true : null);
        await sleep(400); // 媒体卡为异步判断，等一拍再查
        return {
          ok: true,
          ttsBtn: !!document.querySelector('.nj-tts-header-btn'),
          mediaCard: !!document.querySelector('.nj-media-card'),
          mediaInfo: !!reader.mediaInfo,
          before: reader.ttsState,
        };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    })()`);
    ok(mediaProbe && mediaProbe.ok === true && mediaProbe.mediaInfo === true,
      '7 载荷含媒体元数据（mediaInfo 非空，禁用发生在渲染层构造选项）');
    ok(mediaProbe && mediaProbe.ttsBtn === false && mediaProbe.mediaCard === false,
      `7 弹出窗无「听」按钮 / 无媒体卡（tts=${mediaProbe && mediaProbe.ttsBtn}，media=${mediaProbe && mediaProbe.mediaCard}）`);
    {
      const ttsProbe = await winM.webContents.executeJavaScript(`(() => {
        const reader = window.__robinReader;
        reader.toggleTTS();
        const afterToggle = reader.ttsState;
        reader._onTTSKeyDown({ key: 'r', ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, preventDefault() {}, stopPropagation() {} });
        const afterKey = reader.ttsState;
        return { before: 'idle', afterToggle, afterKey };
      })()`);
      ok(ttsProbe.afterToggle === 'idle' && ttsProbe.afterKey === 'idle',
        '7 toggleTTS / R 键在弹出窗全部短路（state 恒 idle）');
    }

    // ── 4. 主窗口关闭 → 级联关闭全部弹出窗 ──
    ok(readerWindows.count() === 2, `4 级联前弹出窗数（count=${readerWindows.count()}）`);
    owner.close();
    await waitFor(() => readerWindows.count() === 0);
    ok(readerWindows.count() === 0, '4 主窗口关闭 → 全部弹出窗级联关闭');

    // ── 6. 右键菜单入口（真 IPC + index.html 全量启动） ──
    {
      const win = new BrowserWindow({
        show: false, width: 1280, height: 860,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
      });
      // 注意：owner 已关闭——为本窗重挂 readerWindow:open 无需（handler 全局）；级联钩子仅 owner 需要
      await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
      await sleep(1200);
      const menuProbe = await win.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const waitFor = async (fn, ms = 15000) => {
          const t0 = Date.now();
          for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(200); }
        };
        try {
          const { ContextMenu } = await import('./views/context-menu.js');
          const row = await waitFor(() => document.querySelector('.entry-row[data-entry-id]'));
          if (!row) return { ok: false, why: 'no-row' };
          row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
          await sleep(300);
          const labels = [...document.querySelectorAll('.context-menu .context-menu-item .label')].map((el) => el.textContent);
          const target = '在独立窗口打开';
          const found = labels.includes(target);
          const capBtn = !!document.getElementById('cap-popout') && !!document.getElementById('cap-popout').innerHTML;
          return { ok: found, labels: labels.slice(0, 8), capBtn };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })()`);
      ok(menuProbe && menuProbe.ok === true,
        `6 右键菜单含「在独立窗口打开」（labels=${menuProbe && JSON.stringify(menuProbe.labels)}）`);
      ok(menuProbe && menuProbe.capBtn === true, '6 阅读器工具栏「弹出」按钮存在（cap-popout）');
      win.destroy();
    }

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
