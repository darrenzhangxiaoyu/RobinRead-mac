'use strict';
/**
 * diag-f1-fulltext.js — F1 全文抓取引擎端到端探针（run-all OFFLINE 集）
 *
 * 全程离线：注入 fake netFetch 同时接管 FeedService 抓取（返回 mock RSS XML）与
 * ArticleExtractor 主进程预抓（返回 mock 文章 HTML），不触真实网络。
 *
 * 覆盖（对应 F1 验收 8 条）：
 *  1 三态偏好持久化（设置 → 落盘 → 新 PreferenceStore 重读一致；off 删键）
 *  2 启用源刷新后摘要型新文章入队并被提取入库（article_caches 可查、FTS 搜到正文词）
 *  3 已有缓存的文章不重复提取（二次刷新提取计数与抓取调用数不增）
 *  4 未启用源不提取（无缓存、无抓取调用）
 *  5 并发 ≤2（服务在途峰值 snapshot().maxInFlight ≤2 且真并发到 2；网络层峰值 ≤2）
 *  6 手动刷新触发存量补抓（启用前入库的存量无缓存篇目全部回补 + 指标入账）
 *  7 列表徽标渲染（启用且未抓取 → 显示「全文」；hasBodyCache=true 补丁后消失；未启用源无徽标）
 *  8 「仅新文章」语义（手动刷新只补新文章，存量不回补、零抓取）
 * 附：单篇失败重试恰好 1 次后静默放弃（不入死循环，队列正常排空）。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f1-fulltext-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 170 * 1000).unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

// ── mock 网络：feed URL → RSS XML；文章 URL → HTML 页；broken → 不可提取短页 ──
const routes = new Map();      // url → { body, contentType }
const fetchCalls = new Map();  // url → 次数
let netInFlight = 0;
let netMaxInFlight = 0;        // 全部请求（含 feed 刷新本身）峰值
let articleNetInFlight = 0;
let articleNetMaxInFlight = 0; // 仅文章正文请求（全文队列实际发起）峰值
const FEED_URLS = new Set();   // feed XML 地址（其并发属刷新主路径，不计入队列并发）
const FETCH_DELAY_MS = 90; // 拉长在途窗口，并发可观测

const fakeNetFetch = async (url) => {
  const key = String(url);
  const isArticle = !FEED_URLS.has(key);
  fetchCalls.set(key, (fetchCalls.get(key) || 0) + 1);
  netInFlight += 1;
  netMaxInFlight = Math.max(netMaxInFlight, netInFlight);
  if (isArticle) {
    articleNetInFlight += 1;
    articleNetMaxInFlight = Math.max(articleNetMaxInFlight, articleNetInFlight);
  }
  try {
    await sleep(FETCH_DELAY_MS);
    const route = routes.get(key);
    if (!route) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0), url: key };
    const buf = Buffer.from(route.body, 'utf8');
    return {
      ok: true, status: 200, url: key,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? route.contentType : null) },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  } finally {
    netInFlight -= 1;
    if (isArticle) articleNetInFlight -= 1;
  }
};

/** mock 文章页：<article> 内多段长文本（Readability / 容器启发式均可提取），正文埋唯一 marker。 */
const articlePage = (title, marker) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><nav><a href="/">首页</a><a href="/about">关于</a></nav>
<article><h1>${title}</h1>
<p>${marker} 这是一段足够长的正文段落，用于全文抓取引擎探针的正文提取与全文索引验证，重复铺陈以保证双引擎都能命中容器。${'补齐篇幅的填充语句，讲述知更阅读器如何把摘要型源补全为可检索的全文。'.repeat(3)}</p>
<p>第二段：${marker} 全文入库后列表、搜索与期刊读端零改动即可直接消费正文缓存。${'本段继续铺陈篇幅，确保提取文本长度远超一百二十字符的下限。'.repeat(3)}</p>
<p>第三段：后台队列以有界并发抓取，不打断任何界面交互。${'再次铺陈，保证三段结构稳定可提取。'.repeat(3)}</p>
</article><footer>页脚噪音</footer></body></html>`;

/** 不可提取页（<120 字符）→ noReadableContent，用于失败重试路径。 */
const brokenPage = '<html><body><p>短</p></body></html>';

const rssXML = (title, items) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${title}</title><link>https://mock.test/</link>
${items.map((it) => `<item><guid>${it.guid}</guid><title>${it.title}</title><link>${it.url}</link>
<pubDate>${new Date(Date.now() - it.ageMinutes * 60000).toUTCString()}</pubDate>
<description>${it.summary}</description></item>`).join('\n')}
</channel></rss>`;

const FEED_ON = 'https://mock.test/feed-on.xml';
const FEED_NEW = 'https://mock.test/feed-newonly.xml';
const FEED_OFF = 'https://mock.test/feed-off.xml';
FEED_URLS.add(FEED_ON); FEED_URLS.add(FEED_NEW); FEED_URLS.add(FEED_OFF);

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const FeedService = require('../src/main/FeedService');
    const ArticleExtractor = require('../src/main/ArticleExtractor');
    FeedService.useNetFetch(fakeNetFetch);
    ArticleExtractor.setNetFetch(fakeNetFetch);

    const { AppStore } = require('../src/main/AppStore');
    const { PreferenceStore } = require('../src/main/Persistence/LibraryDatabase');
    const store = new AppStore(userData);

    // ── 三个源：on（开）/ newOnly（仅新文章）/ off（默认）──
    const feedOn = store.feedsRepo.insertFeed({ accountID: 'local-default', title: '全文开启周刊', feedURL: FEED_ON });
    const feedNew = store.feedsRepo.insertFeed({ accountID: 'local-default', title: '仅新文章周刊', feedURL: FEED_NEW });
    const feedOff = store.feedsRepo.insertFeed({ accountID: 'local-default', title: '未启用周刊', feedURL: FEED_OFF });

    // 存量（启用前入库的摘要型文章）：on 源 3 篇（含 1 篇 broken），newOnly 源 2 篇
    const stockFor = (feed, n) => ({
      id: `local:${feed.id}:stock-${n}`,
      accountID: 'local-default', externalID: `local:${feed.id}:stock-${n}`, feedID: feed.id,
      title: `存量摘要文章 ${n}`, author: null,
      url: `https://mock.test/${feed.id}/stock/${n}`,
      publishedAt: Math.floor(Date.now() / 1000) - 3600 * (24 + n),
      summary: `存量第 ${n} 篇的短摘要。`, contentHTML: `<p>存量第 ${n} 篇的短摘要正文。</p>`,
      dateArrived: Math.floor(Date.now() / 1000) - 3600 * (24 + n),
    });
    store._applyParsedEntries(feedOn, [1, 2].map((n) => stockFor(feedOn, n)));
    store._applyParsedEntries(feedOn, [{
      ...stockFor(feedOn, 9), id: `local:${feedOn.id}:stock-broken`,
      externalID: `local:${feedOn.id}:stock-broken`, url: 'https://mock.test/broken/stock-broken',
    }]);
    store._applyParsedEntries(feedNew, [1, 2].map((n) => stockFor(feedNew, n)));
    routes.set('https://mock.test/broken/stock-broken', { body: brokenPage, contentType: 'text/html; charset=utf-8' });

    // 刷新用的 RSS（mock 内容可随轮次追加条目）
    const rssItems = { on: [], newOnly: [], off: [] };
    const addArticle = (feed, key, marker) => {
      const url = `https://mock.test/${feed.id}/${key}`;
      routes.set(url, { body: articlePage(`新文章 ${key}`, marker), contentType: 'text/html; charset=utf-8' });
      rssItems[feed === feedOn ? 'on' : feed === feedNew ? 'newOnly' : 'off'].push({
        guid: key, title: `新文章 ${key}`, url, ageMinutes: 5, summary: `${key} 的摘要级简短描述。`,
      });
      return url;
    };
    const syncRSS = () => {
      routes.set(FEED_ON, { body: rssXML('全文开启周刊', rssItems.on), contentType: 'application/rss+xml; charset=utf-8' });
      routes.set(FEED_NEW, { body: rssXML('仅新文章周刊', rssItems.newOnly), contentType: 'application/rss+xml; charset=utf-8' });
      routes.set(FEED_OFF, { body: rssXML('未启用周刊', rssItems.off), contentType: 'application/rss+xml; charset=utf-8' });
    };
    const stockURL = (feed, n) => `https://mock.test/${feed.id}/stock/${n}`;
    for (const n of [1, 2]) {
      routes.set(stockURL(feedOn, n), { body: articlePage(`存量 ${n}`, `qfmarkerstockon${n}`), contentType: 'text/html; charset=utf-8' });
      routes.set(stockURL(feedNew, n), { body: articlePage(`存量 ${n}`, `qfmarkerstocknew${n}`), contentType: 'text/html; charset=utf-8' });
    }
    addArticle(feedOn, 'on-n1', 'qfmarkeronn1');
    addArticle(feedOn, 'on-n2', 'qfmarkeronn2');
    addArticle(feedNew, 'new-m1', 'qfmarkernewm1');
    addArticle(feedNew, 'new-m2', 'qfmarkernewm2');
    addArticle(feedOff, 'off-x1', 'qfmarkeroffx1');
    addArticle(feedOff, 'off-x2', 'qfmarkeroffx2');
    syncRSS();

    // ── 1. 三态偏好持久化 ──
    store.setFulltextFeedMode(feedOn.id, 'on');
    store.setFulltextFeedMode(feedNew.id, 'newOnly');
    store.setFulltextFeedMode(feedOff.id, 'on');
    store.setFulltextFeedMode(feedOff.id, 'off'); // off = 删键回默认
    store.preferences.flushSync();
    const reloaded = new PreferenceStore();
    const reloadedModes = JSON.parse(reloaded.get('RobinRead.fulltext.feedModes', '{}') || '{}');
    ok(reloadedModes[feedOn.id] === 'on' && reloadedModes[feedNew.id] === 'newOnly' && reloadedModes[feedOff.id] === undefined,
      '1 三态偏好持久化（on/newOnly 落盘一致，off 删键）');
    ok(store.fulltext.modeFor(feedOff.id) === 'off' && store.fulltext.modeFor(feedOn.id) === 'on',
      '1 modeFor 三态读取正确');
    let badMode = false;
    try { store.setFulltextFeedMode(feedOn.id, 'sometimes'); } catch (_) { badMode = true; }
    ok(badMode, '1 非法模式被拒绝');

    // ── 2/4/5. 全局刷新 → 启用源新文章入队提取，未启用源不动，并发 ≤2 ──
    await store.refresh('manual');
    const snap1 = await waitDrain(store, 40000);
    const onItems = store.articlesRepo.entriesForFeed(feedOn.id);
    const newItems = store.articlesRepo.entriesForFeed(feedNew.id);
    const offItems = store.articlesRepo.entriesForFeed(feedOff.id);
    const rssEntry = (list, url) => list.find((e) => e.url === url);
    const eOn1 = rssEntry(onItems, 'https://mock.test/' + feedOn.id + '/on-n1');
    const eOn2 = rssEntry(onItems, 'https://mock.test/' + feedOn.id + '/on-n2');
    const eM1 = rssEntry(newItems, 'https://mock.test/' + feedNew.id + '/new-m1');
    const eOff1 = rssEntry(offItems, 'https://mock.test/' + feedOff.id + '/off-x1');
    ok(!!eOn1 && !!eOn2 && !!eM1 && !!eOff1, '2 刷新灌文：三个源的新文章全部入库');
    ok(!!store.cachesRepo.cache(eOn1.id) && !!store.cachesRepo.cache(eOn2.id) && !!store.cachesRepo.cache(eM1.id),
      '2 启用源（on/newOnly）新文章正文缓存已入库');
    const ftsHit = store.fullTextSearch('qfmarkeronn1');
    ok(ftsHit.some((r) => r.id === eOn1.id), '2 FTS 能搜到补抓正文词 qfmarkeronn1');
    ok(store.cachesRepo.cache(eOff1.id) == null && (fetchCalls.get('https://mock.test/' + feedOff.id + '/off-x1') || 0) === 0,
      '4 未启用源不提取（无缓存、零抓取）');
    ok(snap1.maxInFlight <= 2, `5 服务在途并发峰值 ≤2（实测 ${snap1.maxInFlight}）`);
    ok(snap1.maxInFlight === 2, `5 队列真并发（峰值恰为 2，实测 ${snap1.maxInFlight}）`);
    ok(articleNetMaxInFlight <= 2, `5 全文抓取网络层同时在途 ≤2（实测峰值 ${articleNetMaxInFlight}）`);

    // ── 3. 已有缓存不重复提取（比对文章正文请求；feed XML 每轮刷新本身必抓）──
    const extractedBefore = store.fulltext.snapshot().extracted;
    const callsBefore = new Map([...fetchCalls].filter(([u]) => !FEED_URLS.has(u)));
    await store.refresh('manual'); // 同一批 guid：无新文章
    const snap2 = await waitDrain(store, 20000);
    const callsUnchanged = [...callsBefore.keys()].every((u) => (fetchCalls.get(u) || 0) === callsBefore.get(u));
    ok(snap2.extracted === extractedBefore && callsUnchanged,
      `3 二次刷新不重复提取（extracted ${extractedBefore}→${snap2.extracted}，正文抓取调用数不变）`);
    ok(store.fulltext.snapshot().queued === 0, '3 队列排空（无残留）');

    // ── 6. 手动刷新 = 强制全量补抓存量（含失败重试恰好一次）──
    addArticle(feedOn, 'on-n3', 'qfmarkeronn3');
    syncRSS();
    await store.refreshFeed(feedOn.id);
    const snap3 = await waitDrain(store, 40000);
    const stock1 = onItems.find((e) => e.url === stockURL(feedOn, 1));
    const stock2 = onItems.find((e) => e.url === stockURL(feedOn, 2));
    const eOn3 = rssEntry(store.articlesRepo.entriesForFeed(feedOn.id), 'https://mock.test/' + feedOn.id + '/on-n3');
    ok(!!store.cachesRepo.cache(stock1.id) && !!store.cachesRepo.cache(stock2.id),
      '6 手动刷新回补存量（stock1/stock2 已有缓存）');
    ok(!!eOn3 && !!store.cachesRepo.cache(eOn3.id), '6 手动刷新同时补抓本轮新文章 on-n3');
    const ftsStock = store.fullTextSearch('qfmarkerstockon1');
    ok(ftsStock.some((r) => r.id === stock1.id), '6 存量补抓正文进 FTS（qfmarkerstockon1 可搜）');
    const stats = store.fulltext.feedStats();
    ok(stats[feedOn.id] && stats[feedOn.id].fetched >= 5, `6 指标入账 feed_fulltext_stats（fetched=${stats[feedOn.id]?.fetched}）`);
    ok(snap3.retried >= 1 && snap3.failed >= 1, `附 失败单篇重试 1 次后放弃（retried=${snap3.retried} failed=${snap3.failed}）`);
    ok(store.fulltext.snapshot().queued === 0 && store.fulltext.snapshot().inFlight === 0, '附 失败不入死循环（队列正常排空）');

    // ── 8. 「仅新文章」：手动刷新只补新，存量不回补 ──
    const newOnlyStockCallsBefore = [1, 2].map((n) => fetchCalls.get(stockURL(feedNew, n)) || 0);
    addArticle(feedNew, 'new-m3', 'qfmarkernewm3');
    syncRSS();
    await store.refreshFeed(feedNew.id);
    await waitDrain(store, 40000);
    const newItems2 = store.articlesRepo.entriesForFeed(feedNew.id);
    const eM3 = rssEntry(newItems2, 'https://mock.test/' + feedNew.id + '/new-m3');
    const nStock1 = newItems2.find((e) => e.url === stockURL(feedNew, 1));
    const nStock2 = newItems2.find((e) => e.url === stockURL(feedNew, 2));
    const newOnlyStockCallsAfter = [1, 2].map((n) => fetchCalls.get(stockURL(feedNew, n)) || 0);
    ok(!!eM3 && !!store.cachesRepo.cache(eM3.id), '8 仅新文章：本轮新文章 new-m3 正常补抓');
    ok(store.cachesRepo.cache(nStock1.id) == null && store.cachesRepo.cache(nStock2.id) == null
      && newOnlyStockCallsAfter[0] === newOnlyStockCallsBefore[0] && newOnlyStockCallsAfter[1] === newOnlyStockCallsBefore[1],
      '8 仅新文章：存量不回补（无缓存且零抓取调用）');

    // ── 7. 列表徽标渲染（真 renderer 模块，隐藏窗口）──
    const badge = await badgeProbe();
    ok(badge.enabledVisible, `7 徽标渲染：启用且未抓取 → 显示（${badge.enabledCount} 枚）`);
    ok(badge.afterCache === 0, '7 抓取完成（hasBodyCache=true 补丁）→ 徽标消失');
    ok(badge.offCount === 0, '7 未启用源文章无徽标');

    store.fulltext.dispose();
    store.preferences.flushSync();
    store.database.close();
    try { fs.rmSync(userData, { recursive: true, force: true }); }
    catch (_) { /* 窗口拼写词典等文件可能仍被占用：临时目录留给系统清理 */ }
    console.log(failed === 0 ? 'ALL PASSED' : `FAILED ${failed}`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('ERR', String((err && err.stack) || err).slice(0, 1200));
    app.exit(1);
  }
});

/** 等待全文队列排空（queued/inFlight/pending 全零），返回最终 snapshot。 */
async function waitDrain(store, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const s = store.fulltext.snapshot();
    if (s.queued === 0 && s.inFlight === 0 && s.pendingFeeds === 0) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error('fulltext queue drain timeout: ' + JSON.stringify(s));
    await sleep(120);
  }
}

/** 渲染层徽标探针：加载 index.html 后实例化 ListView，验证徽标渲染与补丁消失。 */
async function badgeProbe() {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 800,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(800);
  const result = await win.webContents.executeJavaScript(`(async () => {
    try {
      const { ListView } = await import('./views/list.js');
      window.__robinFulltextModes = { 'feed-ft-on': 'on' };
      const scroll = document.createElement('div');
      scroll.className = 'list-scroll';
      scroll.style.cssText = 'position:fixed;top:0;left:0;width:340px;height:600px;overflow:auto;';
      document.body.appendChild(scroll);
      const mk = (id, feedID, hasBodyCache) => ({
        id, feedID, accountID: 'local-default', accountType: 'local',
        // 标题刻意互不相似：避开同题聚类（clusterRow 折叠态不生成行 DOM）
        title: ({ b1: '量子纠错码的新突破', b2: '古镇美食地图手记', b3: '火星探测任务纪实' })[id] || id,
        url: null,
        summaryPreview: '摘要预览，避免与标题冗余的长度文本占位。',
        readMinutes: 2, sourceTitle: '来源', publishedAt: Math.floor(Date.now() / 1000),
        isRead: false, isStarred: false, isLater: false, feedIconURL: null, hasBodyCache,
      });
      const items = [mk('b1', 'feed-ft-on', false), mk('b2', 'feed-ft-on', false), mk('b3', 'feed-ft-off', false)];
      const list = new ListView(scroll, {});
      list.render(items, { kind: 'all' }, null, true);
      const badgeSel = '.entry-row .entry-fulltext-badge';
      const enabledCount = scroll.querySelectorAll(badgeSel).length;
      // 补抓完成：hasBodyCache=true → updateItems 静默补丁，徽标消失
      list.updateItems(items.map((it) => ({ ...it, hasBodyCache: true })), null);
      const afterCache = scroll.querySelectorAll(badgeSel).length;
      // 切回未抓取 + 未启用源对照
      list.updateItems(items, null);
      const offRows = [...scroll.querySelectorAll('.entry-row')].filter((r) => r.dataset.entryId === 'b3');
      const offCount = offRows.filter((r) => r.querySelector('.entry-fulltext-badge')).length;
      return { enabledCount, enabledVisible: enabledCount === 2, afterCache, offCount };
    } catch (e) { return { error: String((e && e.stack) || e).slice(0, 400) }; }
  })()`);
  win.destroy();
  if (!result || result.error) console.error('badge probe error:', result && result.error);
  return result || { enabledVisible: false, afterCache: -1, offCount: -1 };
}
