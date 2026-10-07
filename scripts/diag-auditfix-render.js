'use strict';
/**
 * diag-auditfix-render.js — 渲染层审查修复探针（run-all OFFLINE 集）
 *
 * 与 diag-phase2-renderer 同骨架：真实后端（AppStore + registerIPCHandlers + 样本 RSS）+
 * show:false 窗口，全部断言走 App 真实接线（index.html → app.js bootstrap）。
 *
 * 断言覆盖（对应本轮修复项）：
 *  P1-1 期刊 dismiss 后 selection-delta 不再到达（退订生效；开关两次不累积）
 *  P1-2 期刊灯箱换文不串图（关文置空，下一篇图集重建，无上一篇残留）
 *  P1-3 摘要/研读面板切文后不串文（await 挂起期间 entryID 已换 → 结果丢弃）
 *  P1-7 J/K 单触发（列表栏：仅光标移动不打开文章；阅读器栏：_navKey 让路由全局导航打开恰好一篇）
 *  P1-5 runSearch 后 searchMode 闭环（搜索态进文自动高亮查询词；清空后不再自动高亮）
 *  P1-6 文件夹未读徽标 updateCounts 刷新（data-folder-key 锚点）
 *  P2-1 命令面板空态「清空搜索」按钮清输入框并聚焦
 *  P2-4 列表早退分支同步 this.scope；签名含 folderName
 *  P2-5 I18N 新键中英双语齐备（主进程侧）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

// 必须在 app ready 前 require：ipc.js 顶层注册 robin-icon 特权 scheme（与生产 main.js 相同）
require('../src/main/ipc');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-auditfix-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 180 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

// >400 字正文：绕过「正文过短补全抓取」，渲染确定且离线
const LONG = '这是一段足够长的中文正文，确保条目自带内容超过补全抓取阈值，让端到端探测完全确定、不依赖外部网络与站点行为。'.repeat(10);

function sampleRSS() {
  const iso = (ms) => new Date(ms).toUTCString();
  const now = Date.now();
  // 关键词「量子纠缠」只出现在条目 A（标题+正文）——B/C 完全不含，
  // 搜索结果行与今日列表行才可区分（探针靠标题定位命中行）
  const item = (title, key, extra) => `<item>
      <title>${title}</title>
      <link>https://example.com/weekly/${key}</link>
      <pubDate>${iso(now)}</pubDate>
      <description>${title}的摘要，供标题/摘要检索路径使用。</description>
      <content:encoded><![CDATA[<h2>${title}</h2><p>${LONG}${extra || ''}</p>]]></content:encoded>
    </item>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>审查修复探测周刊</title>
    <link>https://example.com/weekly</link>
    ${item('量子纠缠阵列读取器取得进展', 'a', '量子纠缠探针正文关键词。')}
    ${item('深海火山口的生态系统观察', 'b')}
    ${item('城市地铁新线通车运营纪实', 'c')}
  </channel>
</rss>`;
}

// ── P2-5：I18N 新键中英双语齐备（主进程字符串表直查）──
function checkI18N() {
  const { STRINGS } = require(path.join(__dirname, '..', 'src', 'main', 'I18NStrings.js'));
  const keys = ['翻页阅读', '翻页阅读本期文章', '纸感', '素白', '书卷', '牛皮', 'API Key',
    '琥珀', '苔绿', '黛蓝', '胭脂', '青莲', '点击前往下载新版本 v%@', '我的 Mac', '我的 Mac (本地账号)'];
  let allOk = true;
  for (const k of keys) {
    const v = STRINGS[k];
    if (!v || typeof v.zh !== 'string' || !v.zh || typeof v.en !== 'string' || !v.en) {
      allOk = false;
      console.error('  i18n 缺失: ' + k + ' => ' + JSON.stringify(v));
    }
  }
  ok(allOk, 'P2-5 I18N 新键中英双语齐备（' + keys.length + ' 键）');
  ok(STRINGS['我的 Mac'].zh === '本机' && STRINGS['我的 Mac'].en === 'My PC', 'P2-5 「我的 Mac」值已改本机/My PC');
}

app.whenReady().then(async () => {
  checkI18N();
  try {
    // 真实后端：样本 RSS → AppStore → IPC handlers（与生产 main.js 同一套）
    const FeedParser = require('../src/main/FeedParser');
    const { AppStore } = require('../src/main/AppStore');
    const { registerIPCHandlers } = require('../src/main/ipc');
    const parsed = FeedParser.parse(Buffer.from(sampleRSS(), 'utf8'), 'https://example.com/weekly/feed.xml');
    const store = new AppStore(userData);
    const feed = store.feedsRepo.insertFeed({
      accountID: 'local-default',
      title: parsed.title,
      siteURL: parsed.siteURL,
      feedURL: 'https://example.com/weekly/feed.xml',
    });
    store._applyParsedEntries(feed, parsed.entries);

    const win = new BrowserWindow({
      show: false, width: 1600, height: 1000,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
    });
    registerIPCHandlers(store, win);
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    const run = (tag, js) => {
      console.log('PHASE ' + tag);
      return win.webContents.executeJavaScript('(async () => { try { ' + js + ' } catch (e) { return { __err: String(e && e.stack || e) }; } })()');
    };
    const sendDelta = () => win.webContents.send('ai:selection-delta', { requestID: 'probe', delta: 'x' });

    // boot：等 app.js bootstrap 完成（真实 IPC → 视图就绪 → 列表渲染）
    let booted = false;
    for (let i = 0; i < 80 && !booted; i++) {
      await sleep(250);
      booted = await win.webContents.executeJavaScript('!!window.__robinReader && document.querySelectorAll("#list-scroll .entry-row").length >= 3');
    }
    ok(booted, 'boot 应用启动、列表渲染 ≥3 行');

    // ── P1-1 / P1-2：期刊（真实 App 页面内构造，fetchArticle 注入正文）──
    await run('edition-setup', `
      const mod = await import('./views/edition-reader.js');
      const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      window.__SRC_A = GIF + '#a'; window.__SRC_B = GIF + '#b';
      const art = (src) => '<h2>Probe Section</h2><p>' + ('Race probe body paragraph with enough words for the pagination engine to pack blocks onto leaves. '.repeat(8)) + '</p><p><img src="' + src + '"></p><p>' + ('Tail paragraph to force at least one more block. '.repeat(4)) + '</p>';
      const mkE = (i) => ({ id: 'fx-' + i, title: '期刊修复探针条目 ' + i, summaryPreview: '摘要文本'.repeat(8), sourceTitle: '潮流周刊', publishedAt: 1758902400 + i * 86400, contentHead: '<p>无图</p>' });
      const items = [mkE(0), mkE(1)];
      window.__mkEdition = () => new mod.EditionReader({ items, startIndex: 0, reduceMotion: true, onOpen: () => {}, fetchArticle: async (id) => art(id === 'fx-0' ? window.__SRC_A : window.__SRC_B) });
      return 'ok';
    `);

    let er1 = await run('edition-er1', `
      const er = window.__mkEdition();
      window.__erHits = 0;
      const orig = er._selDelta.bind(er);
      er._selDelta = (p) => { window.__erHits += 1; return orig(p); };
      er.present();
      window.__er = er;
      await new Promise((r) => setTimeout(r, 350));
      return { unsubType: typeof er._unsubSelDelta };
    `);
    if (er1.__err) throw new Error('edition-er1: ' + er1.__err);
    ok(er1.unsubType === 'function', 'P1-1 期刊 present 后持有 selection-delta 退订函数');
    sendDelta(); await sleep(150);
    let h1 = await run('read-hits', 'return window.__erHits;');
    ok(h1 === 1, 'P1-1 打开期间 selection-delta 到达（hits=' + h1 + '）');
    await run('edition-dismiss', 'window.__er.dismiss(); await new Promise((r) => setTimeout(r, 120)); return window.__er._unsubSelDelta;');
    sendDelta(); sendDelta(); await sleep(150);
    h1 = await run('read-hits', 'return window.__erHits;');
    ok(h1 === 1, 'P1-1 dismiss 后 delta 不再到达（退订生效，hits 仍为 ' + h1 + '）');
    await run('edition-er2', `
      const er = window.__mkEdition();
      window.__er2Hits = 0;
      const orig = er._selDelta.bind(er);
      er._selDelta = (p) => { window.__er2Hits += 1; return orig(p); };
      er.present();
      window.__er2 = er;
      await new Promise((r) => setTimeout(r, 350));
      return 'ok';
    `);
    sendDelta(); await sleep(150);
    const [h1b, h2b] = await run('read-hits2', 'return [window.__erHits, window.__er2Hits];');
    ok(h1b === 1 && h2b === 1, 'P1-1 二次开关不累积（旧实例 ' + h1b + ' / 新实例 ' + h2b + '）');

    let lb = await run('edition-lightbox', `
      const er = window.__er2;
      await er._openArticle(er.items[0]);
      await new Promise((r) => setTimeout(r, 250));
      const resetAfterOpen = er._lbList === null;
      er._openLightbox(window.__SRC_A);
      const listA = (er._lbList || []).slice();
      er.overlay.querySelector('.er-lightbox').classList.remove('on'); er._lightboxOn = false;
      er._closeArticle();
      const afterClose = er._lbList;
      await er._openArticle(er.items[1]);
      await new Promise((r) => setTimeout(r, 250));
      er._openLightbox(window.__SRC_B);
      const listB = (er._lbList || []).slice();
      window.__er2.dismiss();
      return { resetAfterOpen, listA, afterClose, listB };
    `);
    if (lb.__err) throw new Error('edition-lightbox: ' + lb.__err);
    ok(lb.resetAfterOpen, 'P1-2 打开新文章分页后 _lbList 已重置');
    ok(lb.listA.length === 1 && lb.listA[0].indexOf('#a') !== -1, 'P1-2 篇 A 灯箱取到 A 图（' + lb.listA.length + ' 图）');
    ok(lb.afterClose === null, 'P1-2 关闭正文后 _lbList 置空');
    ok(lb.listB.length === 1 && lb.listB[0].indexOf('#b') !== -1, 'P1-2 换到篇 B 图集重建且无 A 残留（' + lb.listB.length + ' 图）');

    // ── P1-3：摘要 / 研读面板切文竞态（快速切换 + IPC 延迟 resolve）──
    let race = await run('reader-race', `
      const reader = window.__robinReader;
      reader.clear();
      reader.entryID = 'race-a';
      reader.entry = { id: 'race-a', title: 'Race A', summary: 'a', url: '', publishedAt: 1758902400 };
      reader.feed = null;
      reader.html = '<p>Race article A body text long enough to count as article text for the summary generation path.</p>';
      reader._render();
      await new Promise((r) => setTimeout(r, 150));
      // generateSummary 挂起在 IPC await 上；同步切换 entryID（与 open() 顶部同步段等价），
      // IPC 至少一个宏任务后才 resolve —— 确保守卫必然命中
      const p1 = reader.generateSummary(false);
      reader.entryID = 'race-b';
      await p1;
      const summaryClean = reader.summary.artifact === null && reader.summary.error === null;
      const p2 = reader.openStudy('deepRead');
      reader.entryID = 'race-d';
      await p2;
      const studyClean = reader._study != null && reader._study.artifact === null && reader._study.error === null;
      reader.clear();
      return { summaryClean, studyClean };
    `);
    if (race.__err) throw new Error('reader-race: ' + race.__err);
    ok(race.summaryClean, 'P1-3 切文后摘要结果不写回（无串文）');
    ok(race.studyClean, 'P1-3 切文后研读面板结果不写回（无串文）');

    // ── P1-7：J/K 单触发（App 真实列表 + 真实栏切换）──
    let jk = await run('jk-single', `
      const host = document.getElementById('list-scroll');
      const reader = window.__robinReader;
      const origOpen = reader.open.bind(reader);
      let globalOpens = 0;
      reader.open = function (...a) { globalOpens += 1; return origOpen.apply(this, a); };
      const cur = () => host.querySelector('.entry-row.nj-cursor')?.dataset.entryId || null;
      const key = (k) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k === 'j' ? 'KeyJ' : 'KeyK', bubbles: true, cancelable: true }));
      // 1) 列表栏活动（启动默认态）：J → 光标到首行；全局处理器不得再打开文章
      key('j'); await new Promise((r) => setTimeout(r, 120));
      const cursor1 = cur();
      const opensListMode = globalOpens;
      // 2) 点阅读器栏 → activeColumn=2：J → _navKey 让路，全局导航打开恰好一篇
      document.getElementById('reader').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 80));
      key('j'); await new Promise((r) => setTimeout(r, 400));
      const cursorReaderMode = cur();
      const opensReaderMode = globalOpens;
      // 3) 回列表栏：J → 光标继续移动（R28 光标模型恢复主导）
      document.getElementById('list').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 80));
      key('j'); await new Promise((r) => setTimeout(r, 120));
      const cursorBack = cur();
      const opensBack = globalOpens;
      reader.open = origOpen;
      return { cursor1, opensListMode, cursorReaderMode, opensReaderMode, cursorBack, opensBack };
    `);
    if (jk.__err) throw new Error('jk-single: ' + jk.__err);
    ok(!!jk.cursor1, 'P1-7 列表栏 J 落光标（' + jk.cursor1 + '）');
    ok(jk.opensListMode === 0, 'P1-7 列表栏 J/K 仅一处效果：全局未打开文章（opens=' + jk.opensListMode + '）');
    ok(jk.opensReaderMode === 1, 'P1-7 阅读器栏 J 由全局导航打开恰好一篇（opens=' + jk.opensReaderMode + '）');
    ok(jk.cursorReaderMode === jk.cursor1, 'P1-7 阅读器栏活动时 _navKey 让路（光标停在 ' + jk.cursorReaderMode + '）');
    ok(jk.opensBack === 1 && jk.cursorBack !== jk.cursorReaderMode, 'P1-7 回列表栏后光标模型恢复（' + jk.cursorReaderMode + ' → ' + jk.cursorBack + '，opens 仍 ' + jk.opensBack + '）');

    // ── P1-5：runSearch 后 searchMode 闭环（搜索框 → runSearch → 搜索结果行 → 自动高亮）──
    let sm1 = await run('searchmode-on', `
      const input = document.getElementById('list-search-input');
      input.value = '量子纠缠';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const topInset = document.querySelector('#list-scroll .list-top-inset');
      let modeOn = false; let hitRow = null;
      // 搜索态 + 标题命中行（关键词只在条目 A，今日列表不误匹配）
      for (let i = 0; i < 50 && !(modeOn && hitRow); i++) {
        await new Promise((r) => setTimeout(r, 100));
        modeOn = topInset.classList.contains('search-mode');
        hitRow = [...document.querySelectorAll('#list-scroll .entry-row')].find((el) => (el.querySelector('.entry-title')?.textContent || '').indexOf('量子纠缠') !== -1) || null;
      }
      if (!hitRow) return {
        err: 'search hit row missing',
        modeOn,
        rows: document.querySelectorAll('#list-scroll .entry-row').length,
        inset: topInset.className,
        inputVal: input.value,
        ftDirect: await Promise.race([window.robin.fullTextSearch('量子纠缠'), new Promise((r) => setTimeout(() => r('__timeout__'), 4000))]),
        seDirect: await window.robin.search('量子纠缠'),
      };
      const reader = window.__robinReader;
      if (!window.__asrHooked) {
        window.__asrHooked = true; window.__asrRuns = 0; window.__asrQueries = [];
        const o = reader.articleSearch.run.bind(reader.articleSearch);
        reader.articleSearch.run = (q) => { window.__asrRuns += 1; window.__asrQueries.push(String(q)); return o(q); };
      }
      hitRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      for (let i = 0; i < 50 && window.__asrRuns === 0; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 200));
      return { modeOn, runs: window.__asrRuns, last: window.__asrQueries[window.__asrQueries.length - 1] || '' };
    `);
    if (sm1.__err) throw new Error('searchmode-on: ' + sm1.__err);
    ok(!sm1.err && sm1.modeOn, 'P1-5 搜索后进入搜索态且结果行渲染' + (sm1.err ? '（' + sm1.err + ' rows=' + sm1.rows + ' inset=' + sm1.inset + ' ft=' + JSON.stringify(Array.isArray(sm1.ftDirect) ? sm1.ftDirect.length : sm1.ftDirect) + ' se.ok=' + (sm1.seDirect && sm1.seDirect.ok) + ' seN=' + (sm1.seDirect && sm1.seDirect.ok ? sm1.seDirect.data.length : '') + '）' : ''));
    ok(sm1.runs >= 1 && sm1.last === '量子纠缠', 'P1-5 搜索态进文自动高亮查询词（runs=' + sm1.runs + '，q=' + sm1.last + '）');

    let sm2 = await run('searchmode-off', `
      const input = document.getElementById('list-search-input');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const topInset = document.querySelector('#list-scroll .list-top-inset');
      let modeOff = false; let rows = 0;
      for (let i = 0; i < 50 && !(modeOff && rows >= 3); i++) {
        await new Promise((r) => setTimeout(r, 100));
        modeOff = !topInset.classList.contains('search-mode');
        rows = document.querySelectorAll('#list-scroll .entry-row').length;
      }
      if (!(modeOff && rows >= 3)) return { err: 'today rows not restored', modeOff, rows };
      const before = window.__asrRuns;
      const row = document.querySelector('#list-scroll .entry-row');
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 1800));
      return { modeOff, runsAfter: window.__asrRuns - before };
    `);
    if (sm2.__err) throw new Error('searchmode-off: ' + sm2.__err);
    ok(!sm2.err && sm2.modeOff, 'P1-5 清空搜索退出搜索态并恢复列表');
    ok(sm2.runsAfter === 0, 'P1-5 非搜索态进文不再自动高亮（新增 runs=' + sm2.runsAfter + '）');

    // ── P1-6：文件夹未读徽标 updateCounts 刷新（SidebarView 直构，mock counts）──
    let sb = await run('sidebar-folder', `
      const { SidebarView } = await import('./views/sidebar.js');
      const host = document.createElement('div');
      document.body.appendChild(host);
      const foot = document.createElement('div');
      document.body.appendChild(foot);
      const sv = new SidebarView(host, foot, { onSelect: () => {}, onFeedContext: () => {}, onFolderContext: () => {} });
      const account = { id: 'local-default', type: 'local', displayName: 'Local' };
      const folder = { id: 'f1', name: '工程', feedIDs: [], feeds: [] };
      sv.render([{ account, rootFeeds: [], folders: [folder] }], { unreadByFolder: { 'local-default::工程': 0 }, unreadByFeed: {} }, { kind: 'today' });
      const row = host.querySelector('.sidebar-row[data-folder-key]');
      const key = row ? row.dataset.folderKey : null;
      const visBefore = row ? getComputedStyle(row.querySelector('.sidebar-count')).visibility : 'n/a';
      sv.updateCounts({ unreadByFolder: { 'local-default::工程': 7 }, unreadByFeed: {} });
      const countEl = row.querySelector('.sidebar-count');
      const visAfter = getComputedStyle(countEl).visibility;
      const textAfter = countEl.textContent;
      host.remove(); foot.remove();
      return { hasAnchor: !!row, key, visBefore, visAfter, textAfter };
    `);
    if (sb.__err) throw new Error('sidebar-folder: ' + sb.__err);
    ok(sb.hasAnchor && sb.key === 'local-default::工程', 'P1-6 文件夹行带 data-folder-key 锚点（' + sb.key + '）');
    ok(sb.visBefore === 'hidden' && sb.visAfter === 'visible' && sb.textAfter === '7', 'P1-6 updateCounts 刷新文件夹徽标（hidden→' + sb.visAfter + ' ' + sb.textAfter + '）');

    // ── P2-1：命令面板空态清空按钮 ──
    let cp = await run('palette-clear', `
      const { CommandPalette } = await import('./views/command-palette.js');
      const p = new CommandPalette();
      p.present([{ label: '命令甲', action: () => {} }, { label: '命令乙', action: () => {} }]);
      await new Promise((r) => setTimeout(r, 80));
      p.input.value = 'zzz-绝不匹配';
      p._filter(p.input.value);
      await new Promise((r) => setTimeout(r, 50));
      const resetBtn = document.querySelector('.cmd-empty-reset');
      const emptyShown = !!resetBtn;
      resetBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 80));
      const valueCleared = p.input.value === '';
      const refocused = document.activeElement === p.input;
      const itemsBack = document.querySelectorAll('.cmd-palette .cmd-item').length;
      p.dismiss();
      return { emptyShown, valueCleared, refocused, itemsBack };
    `);
    if (cp.__err) throw new Error('palette-clear: ' + cp.__err);
    ok(cp.emptyShown, 'P2-1 空态出现「清空搜索」按钮');
    ok(cp.valueCleared, 'P2-1 点击后输入框被清空');
    ok(cp.refocused, 'P2-1 清空后焦点回到输入框');
    ok(cp.itemsBack === 2, 'P2-1 清空后回到全量命令（' + cp.itemsBack + ' 条）');

    // ── P2-4：列表签名含 folderName + 早退分支同步 this.scope ──
    let ls = await run('list-scope', `
      const { ListView } = await import('./views/list.js');
      const host = document.createElement('div');
      host.className = 'list-scroll';
      document.body.appendChild(host);
      const lv = new ListView(host, { onSelect: () => {}, onContext: () => {}, onLoadMore: () => {}, onSearch: () => {} });
      const mk = (i) => ({ id: 'sc-' + i, title: '范围探针 ' + i, summaryPreview: '摘要', sourceTitle: '潮流周刊', publishedAt: 1758902400 + i, contentHead: '' });
      const items = [mk(0), mk(1)];
      const s1 = { kind: 'folder', accountID: 'local-default', folderName: '甲' };
      const s2 = { kind: 'folder', accountID: 'local-default', folderName: '乙' };
      lv.setViewMode('list');
      lv.render(items, s1, null, true);
      lv.render(items, s2, null, true); // 不同 folderName：签名必须区分 → 真重渲染
      const titleAfter = host.querySelector('.list-top-title')?.textContent || '';
      const scopeAfterDiff = lv.scope && lv.scope.folderName;
      // 结构等价 scope（早退分支）：this.scope 仍要跟随最新对象
      const s3 = { kind: 'folder', accountID: 'local-default', folderName: '乙' };
      lv.render(items, s3, null, true);
      const sameObject = lv.scope === s3;
      host.remove();
      return { scopeAfterDiff, titleAfter, sameObject };
    `);
    if (ls.__err) throw new Error('list-scope: ' + ls.__err);
    ok(ls.scopeAfterDiff === '乙', 'P2-4 签名含 folderName：不同文件夹触发真重渲染且 scope 跟随（' + ls.scopeAfterDiff + '）');
    ok(ls.sameObject, 'P2-4 早退分支同步 this.scope 为最新 scope 对象');

    if (failed) { console.error(failed + ' 项失败'); app.exit(1); }
    else { console.log('ALL PASSED'); app.exit(0); }
  } catch (e) {
    console.error('ERR', String(e && e.stack || e).slice(0, 1200));
    app.exit(1);
  }
});
