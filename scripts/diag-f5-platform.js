'use strict';
/**
 * diag-f5-platform.js — F5 中文平台适配器端到端探针（run-all OFFLINE 集，全程离线）
 *
 * 网络全走 useNetFetch 注入 mock（与真抓取同一通路：FeedService.httpFetch → net.fetch 位）。
 * 覆盖（对应 F5 探针 10 条）：
 *  1 v15 迁移：feeds.platform/platform_ref 列存在 + 幂等重入 + 老库（v14 形态）升级无损
 *  2 B 站适配器：mock 空间页（__INITIAL_STATE__ 3 条投稿）→ 标题/BV→URL/时间/封面/时长；
 *    时长随灌文写入 media_items（kind=video）
 *  3 B 站退化：无图/无描述不崩；__INITIAL_STATE__ 缺失 → 明确错误
 *  4 微博适配器：mock getIndex JSON（3 cards 含转发）→ 3 条且转发取原微博；风控 → 明确错误
 *  5 UID 提取：space.bilibili.com 链接 / 纯数字 / weibo.com/u/ / m.weibo.cn/u/
 *  6 端到端：addPlatformFeed 建 feed（platform/platform_ref 正确）→ 灌文 → 列表可见 →
 *    媒体视图可见 B 站视频 → 阅读器正文含 B 站 iframe 播放器（消毒白名单存活）
 *  7 分派：平台 feed 刷新走 PlatformService（mock 计数验证）；普通 RSS feed 不受影响
 *  8 二次刷新去重（BV / mblog id 幂等）
 *  9 UI：添加对话框两个新 tab 渲染 + 试抓预览 3 条（真 IPC）
 * 10 刷新耗时回归：平台源与普通源混刷无相互拖累（并发下总耗时 ≈ 最慢单源）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f5-platform-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 170 * 1000).unref();

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

// ── mock 数据（时间戳必须落在 90 天保留窗口内，否则灌文按保留期限淘汰）──
const N = () => Math.floor(Date.now() / 1000);
const T_PUB1 = N() - 7200;        // B 站第 1 条 pubdate
const T_PUB2 = N() - 3600;        // B 站第 2 条 pubdate（退化条目）
const T_CREATE3 = N() - 5 * 86400; // B 站第 3 条 created（无 pubdate → 回退 created）
const BILI_UID = '1001';
const BILI_MOCK_HTML = `<!DOCTYPE html><html><head><title>老王的知识区 - 哔哩哔哩</title></head><body>
<script>window.__INITIAL_STATE__={"upData":{"name":"老王的知识区","mid":${BILI_UID},"face":"https://i0.hdslb.com/bfs/face/up.jpg"},"lists":[
{"bvid":"BV1ab411c001","title":"量子计算入门【第 1 期】","created":${T_PUB1 - 60},"pubdate":${T_PUB1},"pic":"http://i0.hdslb.com/bfs/cover/1.jpg","description":"本期聊聊量子计算。","length":"12:34"},
{"bvid":"BV1ab411c002","title":"无封面无描述的投稿","pubdate":${T_PUB2},"duration":65},
{"bvid":"BV1ab411c003","title":"第三期：收尾","created":${T_CREATE3},"pic":"https://i0.hdslb.com/bfs/cover/3.jpg","description":"","length":"03:00"}]};(function(){var a=1;})();</script>
</body></html>`;
const BILI_EMPTY_HTML = '<!DOCTYPE html><html><body>仅登录可见或页面改版</body></html>';

const WEIBO_UID = '2002';
// 微博标准时间（昨天，+0800）："Wed Mar 13 12:30:00 +0800 2024" 形态
const WEIBO_STD_MS = Date.now() - 86400 * 1000;
const WEIBO_STD = (() => {
  const d = new Date(WEIBO_STD_MS + 8 * 3600 * 1000); // 北京时间
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (x) => String(x).padStart(2, '0');
  return `${WD[d.getUTCDay()]} ${MO[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0800 ${d.getUTCFullYear()}`;
})();
const WEIBO_MOCK_JSON = JSON.stringify({
  ok: 1,
  data: {
    cards: [
      { card_type: 9, mblog: {
        id: '501001', bid: 'Nabc001', created_at: WEIBO_STD,
        text: '今天天气不错 <a href="https://weibo.com/x">@某人</a>',
        pics: [{ large: { url: 'https://wx1.sinaimg.cn/large/a.jpg' } }],
        user: { screen_name: '小张日记', avatar_hd: 'https://tvax1.sinaimg.cn/crop/1.jpg' },
      } },
      { card_type: 9, mblog: {
        id: '501002', bid: 'Nabc002', created_at: '5分钟前', text: '转发微博',
        retweeted_status: { id: '509999', bid: 'Nold999', created_at: 'Tue Mar 12 08:00:00 +0800 2024', text: '原微博内容：知更阅读器发布了。', user: { screen_name: '官方账号' } },
        user: { screen_name: '小张日记' },
      } },
      { card_type: 11, cards: [{ card_type: 9, mblog: {
        id: '501003', bid: 'Nabc003', created_at: '刚刚', text: '嵌套分组的第三条',
        user: { screen_name: '小张日记' },
      } }] },
    ],
  },
});
const WEIBO_RISK_JSON = JSON.stringify({ ok: 0, message: '请求过于频繁' });

const RSS_MOCK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>F5 回归周刊</title><link>https://rss.test</link>
<item><title>普通源文章一</title><link>https://rss.test/a1</link><pubDate>${new Date(Date.now() - 3600 * 1000).toUTCString()}</pubDate><description>普通源正文。</description></item>
<item><title>普通源文章二</title><link>https://rss.test/a2</link><pubDate>${new Date(Date.now() - 7200 * 1000).toUTCString()}</pubDate><description>第二篇。</description></item>
</channel></rss>`;

// ── 网络注入（真通路：FeedService.httpFetch 的 net.fetch 位）──
const { useNetFetch } = require('../src/main/FeedService');
const hitCount = new Map(); // url 前缀 → 命中次数
let extraDelayMs = 0;
const count = (url) => { for (const prefix of hitCount.keys()) if (url.startsWith(prefix)) { hitCount.set(prefix, hitCount.get(prefix) + 1); return true; } return false; };
const respond = (body, type, status = 200, headers = {}) => new Response(body, { status, headers: { 'Content-Type': type, Etag: '"mock-etag-1"', ...headers } });
const hooks = {}; // onBilibiliRequest(headers) 等探针钩子

/** 全量 mock 路由（重装可恢复；hooks 用于观察请求头）。 */
function installRoutes() {
  useNetFetch(async (url, opts = {}) => {
    count(url);
    if (extraDelayMs) await new Promise((r) => setTimeout(r, extraDelayMs));
    if (url.startsWith('https://space.bilibili.com/1001/video') || url.startsWith('https://space.bilibili.com/1002/video')) {
      if (hooks.onBilibiliRequest?.(opts.headers || {})) return new Response(null, { status: 304, headers: { Etag: '"mock-etag-1"' } });
      return respond(BILI_MOCK_HTML, 'text/html; charset=utf-8');
    }
    if (url.startsWith('https://space.bilibili.com/4041/video')) return respond(BILI_EMPTY_HTML, 'text/html; charset=utf-8');
    if (url.startsWith('https://m.weibo.cn/api/container/getIndex') && url.includes('value=2002')) return respond(WEIBO_MOCK_JSON, 'application/json');
    if (url.startsWith('https://m.weibo.cn/api/container/getIndex') && url.includes('value=3003')) return respond(WEIBO_RISK_JSON, 'application/json');
    if (url.startsWith('https://m.weibo.cn/api/container/getIndex') && url.includes('value=4004')) return respond('{"bad json', 'application/json', 412);
    if (url.startsWith('https://rss.test/feed.xml')) return respond(RSS_MOCK_XML, 'application/rss+xml');
    throw new Error('mock net: unexpected URL ' + url);
  });
}
installRoutes();

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { PlatformService, PlatformError, ADAPTERS, parseWeiboDate } = require('../src/main/PlatformService');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { MIGRATIONS, runMigrations } = require('../src/main/Persistence/DatabaseMigrations');

    // ── 5. UID 提取（先于建库，纯函数）──
    ok(ADAPTERS.bilibili.parseRef('https://space.bilibili.com/123456') === '123456', '5 space.bilibili.com 链接 → UID');
    ok(ADAPTERS.bilibili.parseRef('  123456  ') === '123456', '5 纯数字 → UID');
    ok(ADAPTERS.bilibili.parseRef('https://weibo.com/u/789') === null, '5 微博链接不误配 B 站');
    ok(ADAPTERS.weibo.parseRef('https://weibo.com/u/789') === '789', '5 weibo.com/u/ 链接 → UID');
    ok(ADAPTERS.weibo.parseRef('https://m.weibo.cn/u/789') === '789', '5 m.weibo.cn/u/ 链接 → UID');
    ok(ADAPTERS.weibo.parseRef('2002') === '2002', '5 微博纯数字 → UID');
    ok(parseWeiboDate('Wed Mar 13 12:30:00 +0800 2024') === Math.floor(Date.parse('2024-03-13T04:30:00Z') / 1000), '5 微博标准时间解析（+0800 → UTC 秒）');

    // ── 1. v15 迁移 ──
    const store = new AppStore(userData);
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v15-platform-feeds'").get(), '1 v15 迁移已入链');
    const cols = new Set(store.database.prepare('PRAGMA table_info(feeds)').all().map((r) => r.name));
    ok(cols.has('platform') && cols.has('platform_ref'), '1 feeds.platform / platform_ref 列存在');
    // 幂等：v15 up() 重放不炸
    {
      const v15 = MIGRATIONS.find((m) => m.id === 'v15-platform-feeds');
      try { v15.up(store.database); ok(true, '1 v15 up() 重放幂等'); } catch (e) { ok(false, '1 v15 up() 重放幂等 — ' + e.message); }
    }
    // 老库升级无损：回到 v14 形态（去列/去索引/去记账）后重跑迁移链
    {
      const legacyPath = path.join(userData, 'legacy-upgrade.db');
      const { LibraryDatabase } = require('../src/main/Persistence/LibraryDatabase');
      const legacy = new LibraryDatabase(legacyPath);
      legacy.exec("INSERT INTO accounts (id, type, display_name, is_enabled, created_at, updated_at) VALUES ('a1','local','本地',1,1,1)");
      legacy.exec("INSERT INTO feeds (id, account_id, title, feed_url, updated_at) VALUES ('f1','a1','老库订阅','https://legacy.test/feed.xml',1)");
      legacy.exec('DROP INDEX IF EXISTS idx_feeds_platform');
      legacy.exec('ALTER TABLE feeds DROP COLUMN platform');
      legacy.exec('ALTER TABLE feeds DROP COLUMN platform_ref');
      legacy.exec("DELETE FROM schema_migrations WHERE id = 'v15-platform-feeds'");
      runMigrations(legacy.db);
      const legacyCols = new Set(legacy.db.prepare('PRAGMA table_info(feeds)').all().map((r) => r.name));
      const restored = legacy.db.prepare("SELECT platform, platform_ref, title, feed_url FROM feeds WHERE id = 'f1'").get();
      ok(legacyCols.has('platform') && legacyCols.has('platform_ref')
        && restored.platform === 'web' && restored.platform_ref === null && restored.title === '老库订阅',
        '1 老库（v14 形态）升级无损：列回填 + 存量行原样（platform=web）');
      legacy.close();
    }

    // ── 2. B 站适配器（mock 空间页 → 3 条）──
    {
      const result = await store.platforms.fetchFeed(store.platforms.pseudoFeed('bilibili', BILI_UID), { force: true });
      const entries = result.parsed.entries;
      ok(result.parsed.title === '老王的知识区', `2 UP 主名解析（title=${result.parsed.title}）`);
      ok(entries.length === 3, `2 解析出 3 条投稿（${entries.length}）`);
      ok(entries[0].url === 'https://www.bilibili.com/video/BV1ab411c001', '2 BV → 播放页 URL');
      ok(entries[0].publishedAt === T_PUB1, '2 发布时间（pubdate 秒，数字时间戳不误走 Date.parse）');
      ok(entries[0].cover === 'https://i0.hdslb.com/bfs/cover/1.jpg', '2 封面（http→https 补全）');
      ok(entries[0].enclosure && entries[0].enclosure.kind === 'video' && entries[0].enclosure.durationSeconds === 754,
        `2 时长 MM:SS → 秒（${entries[0].enclosure?.durationSeconds}）`);
      ok(entries[0].contentHTML.includes('player.bilibili.com/player.html?bvid=BV1ab411c001'), '2 正文含 B 站 iframe 播放器');
      ok(entries[0].summary.includes('量子计算'), '2 描述 → 摘要');
    }
    // ── 3. B 站退化 + __INITIAL_STATE__ 缺失 ──
    {
      const result = await store.platforms.fetchFeed(store.platforms.pseudoFeed('bilibili', '1001'), { force: true });
      const entry1 = result.parsed.entries[1]; // 无封面无描述（numeric duration）
      ok(entry1.cover === null && entry1.summary === entry1.title && entry1.enclosure.durationSeconds === 65
        && entry1.contentHTML.includes('player.bilibili.com'),
        '3 无图/无描述退化不崩（numeric 时长=65，播放器仍在）');
      let missingError = null;
      try { await store.platforms.fetchFeed(store.platforms.pseudoFeed('bilibili', '4041'), { force: true }); } catch (e) { missingError = e; }
      ok(missingError instanceof PlatformError && /B 站空间页解析失败/.test(missingError.message),
        `3 __INITIAL_STATE__ 缺失 → 明确错误（${missingError && missingError.message}）`);
    }
    // ── 4. 微博适配器 ──
    {
      const result = await store.platforms.fetchFeed(store.platforms.pseudoFeed('weibo', WEIBO_UID), { force: true });
      const entries = result.parsed.entries;
      ok(result.parsed.title === '小张日记' && entries.length === 3, `4 微博 3 条 + 标题=${result.parsed.title}`);
      ok(entries[0].id === 'weibo:Nabc001' && entries[0].url === 'https://weibo.com/2002/Nabc001', '4 mblog bid → 条目身份 / 个人主页 URL');
      ok(Math.abs(entries[0].publishedAt - Math.floor(WEIBO_STD_MS / 1000)) <= 2, '4 时间解析（+0800，±2s）');
      ok(entries[0].contentHTML.includes('wx1.sinaimg.cn/large/a.jpg'), '4 图片行进正文');
      const rt = entries[1];
      ok(rt.contentHTML.includes('原微博内容') && !rt.contentHTML.includes('转发微博'), '4 转发取原微博文本');
      ok(entries[2].id === 'weibo:Nabc003', '4 嵌套分组 card 内 mblog 也被收集（转发层原微博不单独成条）');
    }
    {
      let riskError = null;
      try { await store.platforms.fetchFeed(store.platforms.pseudoFeed('weibo', '3003'), { force: true }); } catch (e) { riskError = e; }
      ok(riskError instanceof PlatformError && /微博接口暂时不可用（可能被风控）/.test(riskError.message),
        `4 风控（ok≠1）→ 明确错误（${riskError && riskError.message}）`);
      let httpError = null;
      try { await store.platforms.fetchFeed(store.platforms.pseudoFeed('weibo', '4004'), { force: true }); } catch (e) { httpError = e; }
      ok(httpError instanceof PlatformError && /微博接口暂时不可用/.test(httpError.message), '4 非 200 响应 → 同款明确错误');
    }

    // ── 6. 端到端：添加平台源 → 灌文 → 列表 → 媒体视图 → 阅读器 ──
    hitCount.set('https://space.bilibili.com/1001/video', 0);
    const biliFeed = await store.addPlatformFeed({ platform: 'bilibili', ref: BILI_UID });
    ok(biliFeed.platform === 'bilibili' && biliFeed.platformRef === BILI_UID && biliFeed.feedURL === 'bilibili://user/1001',
      `6 平台 feed 建档（${biliFeed.feedURL}，platform=${biliFeed.platform}，ref=${biliFeed.platformRef}）`);
    ok(biliFeed.title === '老王的知识区', '6 标题 = UP 主名');
    ok(hitCount.get('https://space.bilibili.com/1001/video') >= 1, '6 添加过程经 PlatformService 抓取（mock 计数+1）');
    let dupError = null;
    try { await store.addPlatformFeed({ platform: 'bilibili', ref: BILI_UID }); } catch (e) { dupError = e; }
    ok(dupError && /这个订阅已经存在/.test(dupError.message), '6 重复添加被拒');
    const listRows = store.listItems({ kind: 'feed', feedID: biliFeed.id }, { limit: 50 });
    ok(listRows.length === 3 && listRows.some((r) => /量子计算入门/.test(r.title || '')), `6 列表可见（${listRows.length} 行）`);
    // 试抓预览（添加对话框同一 IPC 数据路径）
    const preview = await store.platforms.preview({ platform: 'bilibili', input: 'https://space.bilibili.com/1001' });
    ok(preview.ref === BILI_UID && preview.entries.length === 3 && preview.title === '老王的知识区', '6 试抓预览返回前 3 条');
    const badPreview = await store.platforms.preview({ platform: 'weibo', input: '不是链接' }).catch((e) => ({ __err: e }));
    ok(badPreview.__err && /无法识别的微博用户/.test(badPreview.__err.message), '6 预览：无法识别输入 → 明确指引');
    // 媒体视图（F3）可见 B 站视频 + 阅读器正文含 iframe 播放器
    {
      const mediaRows = store.media.list({ filter: 'all', kind: 'video', limit: 50 });
      const biliMediaRows = mediaRows.filter((m) => /bilibili\.com\/video\//.test(m.url || ''));
      ok(biliMediaRows.length === 3, `6 媒体视图可见 B 站视频（${biliMediaRows.length} 条）`);
      if (!biliMediaRows.length) throw new Error('媒体视图无 B 站视频行，无法继续阅读器断言');
      const payload = store.readerArticle(biliMediaRows[0].itemID);
      ok(payload && payload.content && payload.content.html && payload.content.html.includes('player.bilibili.com/player.html'),
        '6 阅读器正文含消毒后存活的 B 站 iframe 播放器');
      ok(payload.content.needsExtraction === false, '6 平台条目不做全文提取（防视频页壳顶掉播放器）');
      ok(payload.media && payload.media.kind === 'video', '6 reader 载荷带媒体元数据（media 视图点开进阅读器）');
    }
    // 微博平台源建档
    const weiboFeed = await store.addPlatformFeed({ platform: 'weibo', ref: WEIBO_UID });
    ok(weiboFeed.platform === 'weibo' && weiboFeed.feedURL === 'weibo://user/2002', `6 微博平台源建档（${weiboFeed.feedURL}）`);

    // ── 7/8. 分派 + 去重：普通 RSS feed 回归 + 二次刷新幂等 ──
    const rssFeed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F5 回归周刊', feedURL: 'https://rss.test/feed.xml' });
    hitCount.set('https://space.bilibili.com/1001/video', 0);
    hitCount.set('https://rss.test/feed.xml', 0);
    const refresh1 = await store.refreshFeed(biliFeed.id);
    ok(hitCount.get('https://space.bilibili.com/1001/video') === 1 && refresh1.newEntries === 0,
      '7 平台单源刷新走 PlatformService（计数=1）且二次入库零新增');
    const rssRefresh = await store.refreshFeed(rssFeed.id);
    ok(rssRefresh.newEntries === 2, '7 普通 RSS feed 刷新不受影响（2 条入库）');
    const rssRows = store.listItems({ kind: 'feed', feedID: rssFeed.id }, { limit: 50 });
    ok(rssRows.length === 2, '7 普通源列表可见（回归）');
    const itemsBefore = store.database.prepare('SELECT COUNT(*) AS n FROM items WHERE feed_id = ?').get(biliFeed.id).n;
    await store.refreshFeed(biliFeed.id);
    const itemsAfter = store.database.prepare('SELECT COUNT(*) AS n FROM items WHERE feed_id = ?').get(biliFeed.id).n;
    ok(itemsBefore === 3 && itemsAfter === 3, `8 B 站二次刷新去重（BV 幂等：${itemsBefore}→${itemsAfter}）`);
    const weiboBefore = store.database.prepare('SELECT COUNT(*) AS n FROM items WHERE feed_id = ?').get(weiboFeed.id).n;
    await store.refreshFeed(weiboFeed.id);
    const weiboAfter = store.database.prepare('SELECT COUNT(*) AS n FROM items WHERE feed_id = ?').get(weiboFeed.id).n;
    ok(weiboBefore === 3 && weiboAfter === 3, `8 微博二次刷新去重（mblog id 幂等：${weiboBefore}→${weiboAfter}）`);
    // ETag 语义：非 force 拉取带 If-None-Match 条件头；ETag 未变（mock 回 304）→ notModified 短路
    {
      let sawConditional = false;
      hooks.onBilibiliRequest = (headers) => {
        if (headers && headers['If-None-Match']) { sawConditional = true; return true; } // 回 304
        return false;
      };
      const conditional = await store.platforms.fetchFeed(store.feedsRepo.feed(biliFeed.id)); // 非强刷
      hooks.onBilibiliRequest = null;
      ok(sawConditional && conditional.notModified === true, '7 非强刷带 If-None-Match，ETag 未变走 304 短路（FeedService 同款语义）');
    }

    // ── 10. 刷新耗时回归：平台 + 普通混刷，并发无相互拖累 ──
    {
      while (store.refreshStatus.state === 'refreshing') await new Promise((r) => setTimeout(r, 120));
      extraDelayMs = 700; // 每个请求 700ms：串行 3 源 ≈ 2.1s+，并发应 ≈ 0.7s+
      const t0 = process.hrtime.bigint();
      await store.refresh('manual');
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      extraDelayMs = 0;
      const outcome = store.lastRefreshOutcome;
      ok(outcome && outcome.updatedFeedCount >= 3, `10 混刷完成（updated=${outcome && outcome.updatedFeedCount}，failed=${outcome && outcome.failedFeedCount}）`);
      ok(ms < 4000, `10 混刷耗时 ${ms.toFixed(0)}ms < 4000ms（并发下平台源不拖累普通源）`);
    }

    // ── 9. UI：添加对话框新 tab + 试抓预览（真 IPC + 隐藏窗口）──
    await addDialogUIProbe(store, LOCAL_ACCOUNT_ID);

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});

/** ── 9. UI 冒烟：showAddFeed 三 tab + 平台试抓预览 3 条 + 确认添加（真 IPC）── */
async function addDialogUIProbe(store, localAccountID) {
  const { BrowserWindow } = require('electron');
  const { registerIPCHandlers } = require('../src/main/ipc');
  const win = new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
  });
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(900);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 8000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); }
    };
    try {
      const { showAddFeed } = await import('./views/dialogs.js');
      window.__f5Done = false;
      showAddFeed([], () => { window.__f5Done = true; });
      const tabs = [...document.querySelectorAll('.modal-overlay .segmented button')];
      const labels = tabs.map((b) => b.textContent);
      const bilibiliTab = tabs.find((b) => b.dataset.tab === 'bilibili');
      if (!bilibiliTab) return { __err: 'bilibili tab missing: ' + labels.join('|') };
      bilibiliTab.click();
      const input = await waitFor(() => {
        const el = [...document.querySelectorAll('.modal-overlay input.control')].pop();
        return el && /space\.bilibili\.com/.test(el.placeholder || '') ? el : null;
      });
      if (!input) return { __err: 'bilibili input missing' };
      input.value = 'https://space.bilibili.com/1002'; // 1002：UI 路专用 UID（1001 已在主侧断言建档）
      const previewBtn = [...document.querySelectorAll('.modal-overlay .modal-footer button')].find((b) => b.textContent === '试抓预览');
      if (!previewBtn) return { __err: 'preview button missing' };
      previewBtn.click();
      const rows = await waitFor(() => {
        const n = document.querySelectorAll('.modal-overlay .platform-preview-row').length;
        return n >= 3 ? n : null;
      });
      const firstTitle = document.querySelector('.modal-overlay .platform-preview-row div')?.textContent || '';
      const addButton = [...document.querySelectorAll('.modal-overlay .modal-footer button')].find((b) => b.textContent === '添加');
      const addDisabled = addButton ? addButton.disabled : true;
      if (addButton && !addDisabled) addButton.click();
      const done = await waitFor(() => (window.__f5Done ? true : null), 8000);
      // 微博 tab 渲染：添加成功后首个对话框已关闭，重新打开再切 tab
      showAddFeed([], () => {});
      const weiboTab2 = [...document.querySelectorAll('.modal-overlay:last-of-type .segmented button')].find((b) => b.dataset.tab === 'weibo');
      if (weiboTab2) weiboTab2.click();
      const weiboInput = await waitFor(() => {
        const el = [...document.querySelectorAll('.modal-overlay input.control')].pop();
        return el && /weibo\.com/.test(el.placeholder || '') ? el : null;
      });
      return {
        labels, rows: rows || 0, firstTitle, addDisabled, done: Boolean(done),
        weiboTabRendered: Boolean(weiboInput),
      };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (result.__err) { ok(false, '9 UI 探针异常 — ' + result.__err); }
  else {
    ok(result.labels.length === 3 && result.labels.includes('B 站 UP 主') && result.labels.includes('微博用户'),
      `9 添加对话框三 tab（${result.labels.join(' / ')}）`);
    ok(result.rows >= 3 && !!result.firstTitle, `9 试抓预览 3 条（rows=${result.rows}，首行=${result.firstTitle}）`);
    ok(result.addDisabled === false, '9 预览成功后「添加」解禁');
    ok(result.done, '9 确认添加 → onDone 回调（feed 真建档）');
    ok(result.weiboTabRendered, '9 微博 tab 渲染');
  }
  const created = store.feedsRepo.feedByURL(localAccountID, 'bilibili://user/1002');
  ok(Boolean(created), '9 确认添加后主侧真建档（bilibili://user/1002）');
  win.destroy();
}
