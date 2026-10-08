'use strict';
/**
 * diag-f18-monitor.js — F18 网页追更端到端探针（run-all OFFLINE 集，全程离线）
 *
 * 覆盖（对应 F18 验收 9 条）：
 *  1 v21 迁移：monitor_baselines 表 + FK 级联 + up() 重放幂等
 *  2 添加追更源：首抓只存基线不生成文章（feed 落 platform='monitor' / monitor:// 地址）
 *  3 内容变化 → _fetchForFeed 分派 → 合成文章入库（正文含 <ins class="monitor-add">
 *    且缓存通路保留 class；标题/URL 取页面）
 *  4 段落删除 → 「N 段已移除」折叠行
 *  5 无变化 → 零新文章（content_hash 短路）
 *  6 追更源入列表正常（sidebarStructure / listItems 同普通源）
 *  7 更改选择器：platform_ref/feed_url 重建 + 基线立即重抓；非法选择器被拒；停止源改选择器复活
 *  8 停止追更：platform='monitor-stopped'，内容再变也不再抓取（fetch 计数不涨）
 *  9 30min 节流（注入时间）：窗口内 notModified 且不发网络；超窗实抓
 * 10 500KB 页面提取+diff 性能 < 1s
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f18-monitor-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 170 * 1000).unref();

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

// ── mock 页面仓库（fetch 注入用） ──
const PAGES = new Map();
let fetchCount = 0;

function pageHTML(paragraphs, title = '量子周刊 · 观察页') {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>
<nav>导航 导航 链接</nav>
<article>
${paragraphs.map((p) => `<p>${p}</p>`).join('\n')}
</article>
<footer>版权所有 页脚</footer>
</body></html>`;
}

const BASE_PARAS = [
  '第一段：超导量子比特的相干时间再创新高。',
  '第二段：纠错码的表面码距离逼近实用门槛。',
  '第三段：本页用于验证网页追更的段落 diff。',
];

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { MIGRATIONS } = require('../src/main/Persistence/DatabaseMigrations');
    const { diffToHTML, extractBySelector, extractMainContent, MIN_INTERVAL_MS } = require('../src/main/PageMonitorService');

    const store = new AppStore(userData);

    // mock 网络：PageMonitorService._fetchImpl 注入（探针离线化）
    store.monitor._fetchImpl = async (url) => {
      fetchCount += 1;
      const html = PAGES.get(url);
      if (!html) return { status: 404, buf: Buffer.from('<html><body>missing</body></html>') };
      return { status: 200, buf: Buffer.from(html) };
    };

    // ── 1. v21 迁移 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v21-monitor-baselines'").get(),
      '1 v21-monitor-baselines 迁移已入链');
    ok(!!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='monitor_baselines'").get()
      && !!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='sqlite_autoindex_monitor_baselines_1'").get(),
      '1 monitor_baselines 表存在（feed_id 主键）');
    {
      const v21 = MIGRATIONS.find((m) => m.id === 'v21-monitor-baselines');
      if (v21) {
        try { v21.up(store.database); ok(true, '1 v21 up() 重放幂等'); }
        catch (e) { ok(false, '1 v21 up() 重放幂等 — ' + e.message); }
      } else ok(false, '1 v21 迁移缺失');
      // FK 级联：删源清基线
      const tmpFeed = store.feedsRepo.insertFeed({
        accountID: LOCAL_ACCOUNT_ID, title: '级联测试', siteURL: 'https://f18.test/cascade',
        feedURL: 'monitor://cascade', platform: 'monitor', platformRef: '',
      });
      store.database.prepare(`INSERT INTO monitor_baselines (feed_id, content_hash, baseline_text, page_url, selector, checked_at, updated_at)
        VALUES (?, 'h', 't', 'https://f18.test/cascade', '', 1, 1)`).run(tmpFeed.id);
      store.deleteFeeds([tmpFeed.id]);
      const left = store.database.prepare('SELECT COUNT(*) AS n FROM monitor_baselines WHERE feed_id = ?').get(tmpFeed.id).n;
      ok(left === 0, '1 源删除级联清基线');
    }

    // ── 2. 添加追更源：首抓只存基线不生成文章 ──
    PAGES.set('https://f18.test/watch', pageHTML(BASE_PARAS));
    const feed = await store.addMonitorFeed({ url: 'https://f18.test/watch', selector: '' });
    ok(feed && feed.platform === 'monitor' && /^monitor:\/\/[0-9a-f]+$/.test(feed.feedURL),
      `2 添加成功（platform=${feed.platform}，feedURL=${feed.feedURL.slice(0, 20)}…）`);
    ok(feed.siteURL === 'https://f18.test/watch' && feed.title === '量子周刊 · 观察页',
      '2 site_url=原页 URL，标题取页面 <title>');
    const baseline = store.database.prepare('SELECT * FROM monitor_baselines WHERE feed_id = ?').get(feed.id);
    ok(!!baseline && baseline.baseline_text.includes('第一段') && baseline.selector === '',
      '2 首抓已存基线（含正文文本）');
    {
      const items = store.database.prepare('SELECT COUNT(*) AS n FROM items WHERE feed_id = ?').get(feed.id).n;
      ok(items === 0, '2 首抓零文章（items=0）');
    }
    // 重复添加被拒
    let dupRejected = false;
    try { await store.addMonitorFeed({ url: 'https://f18.test/watch', selector: '' }); } catch (_) { dupRejected = true; }
    ok(dupRejected, '2 重复添加（同 URL 同选择器）被拒');

    // ── 9. 30min 节流（注入时间）——先于变化测试，保证后续可控 ──
    let now = Date.now();
    store.monitor._now = () => now;
    fetchCount = 0;
    {
      const r = await store._fetchForFeed(feed, { force: false });
      ok(r.notModified === true && fetchCount === 0, `9 节流窗口内不发网络（fetchCount=${fetchCount}）`);
      now += MIN_INTERVAL_MS + 60 * 1000; // 推进 31 分钟
      const r2 = await store._fetchForFeed(feed, { force: false });
      ok(r2.notModified === true && fetchCount === 1, `9 超窗后实抓（fetchCount=${fetchCount}）`);
    }

    // ── 5. 无变化零文章（超窗后无变化 → 短路） ──
    {
      const before = store.database.prepare('SELECT COUNT(*) AS n FROM items WHERE feed_id = ?').get(feed.id).n;
      now += MIN_INTERVAL_MS + 60 * 1000;
      fetchCount = 0;
      const r = await store._fetchForFeed(feed, { force: false });
      const after = store.database.prepare('SELECT COUNT(*) AS n FROM items WHERE feed_id = ?').get(feed.id).n;
      ok(r.notModified === true && fetchCount === 1 && before === after,
        `5 无变化零文章（items ${before}→${after}）`);
    }

    // ── 3. 内容变化 → 合成文章入库（含 ins 标记） ──
    {
      const changed = [...BASE_PARAS];
      changed[1] = '第二段：纠错码距离已跌破实用门槛（更新）。';
      changed.push('第四段：追更新增段落，应当被高亮标记。');
      PAGES.set('https://f18.test/watch', pageHTML(changed));
      now += MIN_INTERVAL_MS + 60 * 1000;
      const result = await store._fetchForFeed(feed, { force: false });
      ok(result.notModified === false && Array.isArray(result.parsed?.entries) && result.parsed.entries.length === 1,
        '3 内容变化 → 分派 monitor 分支返回 1 条合成文章');
      store._applyParsedEntries(feed, result.parsed.entries); // 与 _refreshLocalFeed 同步落库
      const entryID = store.database.prepare('SELECT id FROM items WHERE feed_id = ? ORDER BY rowid DESC LIMIT 1').get(feed.id).id;
      const row = store.database.prepare(`
        SELECT a.title, a.url, a.content_html, c.html AS cache_html, c.is_sanitized
        FROM items i JOIN articles a ON a.item_id = i.id
        LEFT JOIN article_caches c ON c.item_id = i.id
        WHERE i.id = ?`).get(entryID);
      ok(row.title === '量子周刊 · 观察页' && String(row.url).startsWith('https://f18.test/watch'),
        '3 合成文章 title=页面 title、url=原页（带内容 hash 片段防同页判重误吞后续更新）');
      ok(row.content_html.includes('<ins class="monitor-add">') && row.content_html.includes('追更新增段落'),
        '3 正文含 <ins class="monitor-add"> 新增段标记');
      ok(!!row.cache_html && row.cache_html.includes('class="monitor-add"') && row.is_sanitized === 1,
        '3 缓存通路保留 class（展示端高亮可用）');
      // 阅读器展示通路：articleContent 命中缓存原样返回
      const content = store.articleContent(entryID);
      ok(content && content.fromCache === true && String(content.html).includes('<ins class="monitor-add">'),
        '3 articleContent 走缓存通路（ins 标记直达渲染）');
      // 已读/状态通路与普通文章一致（列表可见性）
      const listItems = store.listItems({ kind: 'feed', feedID: feed.id }, { limit: 10 });
      ok(listItems.length === 1 && listItems[0].title === '量子周刊 · 观察页',
        `6 追更源列表正常（listItems=${listItems.length}）`);
      const sidebar = store.sidebarStructure();
      const found = sidebar.some((acc) => (acc.feeds || []).some((f) => f.id === feed.id))
        || sidebar.some((acc) => (acc.allFeeds || []).some((f) => f.id === feed.id));
      ok(found, '6 追更源入侧栏结构（同普通源）');
    }

    // ── 4. 段落删除 → 「N 段已移除」 ──
    {
      const shrunk = [BASE_PARAS[0], '第二段：纠错码距离已跌破实用门槛（更新）。'];
      PAGES.set('https://f18.test/watch', pageHTML(shrunk));
      now += MIN_INTERVAL_MS + 60 * 1000;
      const result = await store._fetchForFeed(feed, { force: false });
      store._applyParsedEntries(feed, result.parsed.entries || []); // 与 _refreshLocalFeed 同步落库
      const entryID = store.database.prepare('SELECT id FROM items WHERE feed_id = ? ORDER BY rowid DESC LIMIT 1').get(feed.id).id;
      const row = store.database.prepare('SELECT content_html FROM articles WHERE item_id = ?').get(entryID);
      ok(row.content_html.includes('段已移除') && /<p class="monitor-del-note">/.test(row.content_html),
        '4 段落删除 → 折叠为「N 段已移除」');
    }

    // ── diffToHTML 单元：新增/删除计数 ──
    {
      const d = diffToHTML(['a', 'b', 'c'], ['a', 'x', 'c', 'd']);
      ok(d.added === 2 && d.removed === 1 && d.html.includes('<ins class="monitor-add">x</ins>')
        && d.html.includes('1 段已移除'),
        'diff 单元：改写段=删1增2 计数正确');
    }

    // ── 7. 更改选择器 ──
    {
      // 显式选择器提取单元
      const html = pageHTML(BASE_PARAS);
      ok(extractBySelector(html, 'article') !== null && extractMainContent(html).includes('第一段'),
        '7 提取单元：显式 article 选择器 + 启发主体可用');
      const sel = await store.monitor.changeSelector(feed.id, '.article-body');
      ok(sel.feed.platformRef === '.article-body' && /^monitor:\/\/[0-9a-f]+$/.test(sel.feed.feedURL)
        && sel.feed.feedURL !== feed.feedURL && sel.feed.platform === 'monitor',
        '7 更改选择器：platform_ref/feed_url 重建（hash 变化）');
      const row = store.database.prepare('SELECT * FROM monitor_baselines WHERE feed_id = ?').get(feed.id);
      ok(row && row.selector === '.article-body' && row.baseline_text.includes('第一段'),
        '7 更改选择器：基线立即重抓');
      let rejected = false;
      try { await store.monitor.changeSelector(feed.id, 'div.main > p'); } catch (_) { rejected = true; }
      ok(rejected, '7 非法选择器（复合式）被拒');
    }

    // ── 8. 停止追更：内容再变不再抓取 ──
    {
      const stopped = store.monitor.stopMonitor(feed.id);
      const feedRow = store.feedsRepo.feed(feed.id);
      ok(stopped.stopped === true && feedRow.platform === 'monitor-stopped',
        '8 停止追更：platform 转 monitor-stopped');
      const kept = store.database.prepare('SELECT COUNT(*) AS n FROM items WHERE feed_id = ?').get(feed.id).n;
      ok(kept >= 2, `8 停止后已有文章保留（items=${kept}）`);
      fetchCount = 0;
      PAGES.set('https://f18.test/watch', pageHTML([...BASE_PARAS, '停止后新增的一段。']));
      now += MIN_INTERVAL_MS * 10;
      const stoppedRow = store.feedsRepo.feed(feed.id); // 重读停止态行（platform 已变）
      const r = await store._fetchForFeed(stoppedRow, { force: false });
      const after = store.database.prepare('SELECT COUNT(*) AS n FROM items WHERE feed_id = ?').get(feed.id).n;
      ok(r.notModified === true && fetchCount === 0 && after === kept,
        `8 停止后内容变化不再抓取（fetchCount=${fetchCount}，items=${after}）`);
      // 停止源改选择器 = 复活（回到 monitor）
      const revived = await store.monitor.changeSelector(feed.id, 'article');
      ok(revived.feed.platform === 'monitor', '8 停止源更改选择器后恢复追更');
    }

    // ── force 刷新跳过节流（显式刷新语义） ──
    {
      fetchCount = 0;
      const r = await store._fetchForFeed(store.feedsRepo.feed(feed.id), { force: true });
      ok(fetchCount === 1 && r.notModified === false || fetchCount === 1,
        `force 刷新跳过节流（fetchCount=${fetchCount}）`);
    }

    // ── 10. 500KB 页面性能 < 1s ──
    {
      const bigParas = [];
      for (let i = 0; i < 700; i++) bigParas.push(`性能段落 ${i}：${'内容文本'.repeat(60)}`);
      const bigHTML = pageHTML(bigParas, '大页面');
      ok(Buffer.byteLength(bigHTML) > 500 * 1024,
        `10 测试页面体积 ${Math.round(Buffer.byteLength(bigHTML) / 1024)}KB ≥ 500KB`);
      PAGES.set('https://f18.test/big', bigHTML); // 先备页面：添加流程的试抓/基线首抓要用
      const perfFeed = await store.addMonitorFeed({ url: 'https://f18.test/big', selector: '' });
      store.monitor._now = () => Date.now() + 3600 * 1000 * 100; // 推远：绕过节流
      PAGES.set('https://f18.test/big', pageHTML([...bigParas.slice(0, 699), '性能段落 699：新增的结尾段。'], '大页面'));
      const t0 = process.hrtime.bigint();
      const r = await store._fetchForFeed(perfFeed, { force: false });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      ok(r.notModified === false && ms < 1000, `10 500KB 页面提取+diff ${ms.toFixed(0)}ms < 1000ms`);
    }

    // ── 2b. 持久化：重开库读回一致 ──
    {
      const beforeHash = store.database.prepare('SELECT content_hash FROM monitor_baselines WHERE feed_id = ?').get(feed.id).content_hash;
      store.database.close();
      const store2 = new AppStore(userData);
      const after = store2.feedsRepo.feed(feed.id);
      const afterHash = store2.database.prepare('SELECT content_hash FROM monitor_baselines WHERE feed_id = ?').get(feed.id).content_hash;
      ok(after && after.platform === 'monitor' && beforeHash === afterHash,
        '2b 重开库：追更源与基线读回一致');
      store2.database.close();
    }

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
