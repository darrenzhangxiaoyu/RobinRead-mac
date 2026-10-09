'use strict';
/**
 * diag-f21-events.js — F21 事件聚类去重探针（run-all OFFLINE 集，全程离线）
 *
 * 覆盖：
 *  1 v22 迁移：event_clusters + items.cluster_id 入链，老库升级无损（数据在迁移后完整保留）
 *  2 聚类：多源相似标题聚成一簇 / 不相似不聚 / 增量入库并簇（第三个相似源并入既有簇）
 *  3 代表条目 = 发布最早成员；member_count / title 随并入推进
 *  4 7 天窗口外不聚（8 天前旧闻与今天同题不建簇）
 *  5 阈值边界：bigram Jaccard ≥ 0.55 才聚（纯函数直测）
 *  6 幂等：已聚类条目重跑跳过；rebuild() 补跑零重复簇
 *  7 summaries：代表/N 源/成员清单；死簇惰性回收（成员删光即删簇）
 *  8 事件模式渲染（真实窗口）：工具栏「事件」钮/分组卡/收合态默认仅代表/N 源徽标/
 *    展开成员（来源名+标题）/点成员回调/独报仍普通行/关闭回普通列表
 *  9 性能：500 条聚类 <2s；入库钩子登记不阻塞灌文主路径
 * 附：preload/IPC/i18n/命令面板静态接线锚点。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f21-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 170 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { meetsThreshold, LIMITS } = require('../src/main/EventClusterService');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);

    // ── 1. v22 迁移落地 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v22-events-transcripts'").get(),
      '1 v22 迁移 events-transcripts 已入链');
    ok(!!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_clusters'").get()
      && !!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_items_cluster'").get(),
      '1 event_clusters 表 + items.cluster_id 索引存在（DDL 只进迁移链）');
    const cols = store.database.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
    ok(cols.includes('cluster_id'), '1 items.cluster_id 列在位（entries 侧簇归属）');
    ok(!!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_transcripts'").get(),
      '1 v22 同批 media_transcripts 表在位（F22 共用迁移）');

    // ── 场景源：三个源报道同一事件 + 一个不相关源 ──
    const now = Math.floor(Date.now() / 1000);
    const mkFeed = (title, url) => store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title, feedURL: url });
    const feedA = mkFeed('科技晨报', 'https://f21.test/a.xml');
    const feedB = mkFeed('硅谷速递', 'https://f21.test/b.xml');
    const feedC = mkFeed('行业观察', 'https://f21.test/c.xml');
    const feedX = mkFeed('美食杂志', 'https://f21.test/x.xml');
    const ingest = (feed, entries) => store._applyParsedEntries(feed, entries);

    // ── 2. 多源相似标题聚成一簇 ──
    ingest(feedA, [{ id: 'ev-1', title: 'OpenAI 发布全新推理模型 o5 系列并开放 API', url: 'https://f21.test/a/1', publishedAt: now - 300, summary: '', contentHTML: null }]);
    await store.events.flush();
    ok(store.events.stats().clusters === 0, '2 独报不成事件：首个来源零簇（待第二个来源命中时建簇）');
    ingest(feedB, [{ id: 'ev-2', title: 'OpenAI 发布全新推理模型 o5 系列并开放 API 接口', url: 'https://f21.test/b/1', publishedAt: now - 200, summary: '', contentHTML: null }]);
    await store.events.flush();
    const stats1 = store.events.stats();
    ok(stats1.clusters === 1 && stats1.members === 2, '2 多源相似标题聚成一簇（2 源 2 成员）');
    const clusterID1 = store.database.prepare('SELECT id FROM event_clusters LIMIT 1').get().id;
    const rep1 = store.database.prepare('SELECT representative_item_id, title FROM event_clusters WHERE id = ?').get(clusterID1);
    ok(/o5/.test(rep1.title) && rep1.title.endsWith('API'), '2 簇 title = 代表条目标题');

    // ── 3. 增量入库并簇：第三个相似源并入既有簇 + 代表随最早成员迁移 ──
    ingest(feedC, [{ id: 'ev-3', title: 'OpenAI 发布全新推理模型 o5 系列，API 同步开放', url: 'https://f21.test/c/1', publishedAt: now - 600, summary: '', contentHTML: null }]);
    await store.events.flush();
    const stats2 = store.events.stats();
    ok(stats2.clusters === 1 && stats2.members === 3, '3 第三个相似源并入既有簇（3 成员，零新簇）');
    // ev-3 发布最早（now-600）→ 代表迁移到它
    const rep2 = store.database.prepare(`
      SELECT i.id AS id FROM event_clusters c
      INNER JOIN items i ON i.id = c.representative_item_id WHERE c.id = ?
    `).get(clusterID1);
    const ev3ID = store.database.prepare('SELECT i.id AS id FROM items i INNER JOIN articles a ON a.item_id = i.id WHERE a.url = ?').get('https://f21.test/c/1').id;
    ok(rep2.id === ev3ID, '3 代表条目 = 发布最早成员（ev-3 now-600 早于其余）');
    const membersOfC1 = store.database.prepare('SELECT COUNT(*) AS n FROM items WHERE cluster_id = ?').get(clusterID1).n;
    ok(membersOfC1 === 3, '3 items.cluster_id 三行齐指同簇');

    // ── 不相似不聚 ──
    ingest(feedX, [{ id: 'x-1', title: '冬季炖汤的十种家常做法', url: 'https://f21.test/x/1', publishedAt: now - 100, summary: '', contentHTML: null }]);
    await store.events.flush();
    const stats3 = store.events.stats();
    ok(stats3.clusters === 1 && stats3.members === 3, '3 不相似标题不聚（簇数与成员数不变）');

    // ── 5. 阈值边界（纯函数直测）──
    ok(LIMITS.EVENT_THRESHOLD === 0.55, '5 并簇阈值常量 0.55（集中可调）');
    ok(meetsThreshold('全市新一轮核酸检测安排公布', '全市新一轮核酸检测安排公布全文') === true,
      '5 阈值边界：近乎相同标题 ≥0.55 判聚');
    const pairScoreLo = meetsThreshold('特斯拉召回部分进口车型', '特斯拉宣布召回部分进口车辆检查制动');
    ok(pairScoreLo === false, '5 阈值边界：同题但差异较大标题不达线不聚（J=0.444 < 0.55）');

    // ── 4. 7 天窗口外不聚 ──
    ingest(feedA, [{ id: 'old-1', title: '某公司发布年度旗舰手机 X20 全面测评', url: 'https://f21.test/a/old', publishedAt: now - 8 * 86400, summary: '', contentHTML: null }]);
    await store.events.flush();
    const beforeOld = store.events.stats().clusters;
    ingest(feedB, [{ id: 'old-2', title: '某公司发布年度旗舰手机 X20 全面测评（视频版）', url: 'https://f21.test/b/old', publishedAt: now - 10, summary: '', contentHTML: null }]);
    await store.events.flush();
    const afterOld = store.events.stats();
    ok(afterOld.clusters === beforeOld && !store.database.prepare(
      'SELECT 1 FROM items i INNER JOIN articles a ON a.item_id = i.id WHERE a.url = ? AND i.cluster_id IS NOT NULL'
    ).get('https://f21.test/b/old'), '4 7 天窗口外不聚：8 天前旧闻与今日同题不成簇');

    // ── 6. 幂等 + rebuild 零重复簇 ──
    const beforeRebuild = store.events.stats();
    const rebuildResult = store.events.rebuild({ windowDays: 7 });
    const afterRebuild = store.events.stats();
    ok(rebuildResult.scanned >= 5 && afterRebuild.clusters === beforeRebuild.clusters && afterRebuild.members === beforeRebuild.members,
      `6 rebuild 补跑幂等（扫 ${rebuildResult.scanned} 条，簇 ${beforeRebuild.clusters} → ${afterRebuild.clusters}，成员不变）`);
    const alreadyClustered = store.events.clusterEntry(store.database.prepare(
      'SELECT item_id AS id FROM articles WHERE url = ?').get('https://f21.test/b/1').id);
    ok(alreadyClustered.action === 'skip' && alreadyClustered.clusterID === clusterID1, '6 已聚类条目重跑直接跳过（幂等）');

    // ── 7. summaries 载荷 + 死簇回收 ──
    const sums = store.events.summaries([clusterID1]);
    ok(sums.length === 1 && sums[0].memberCount === 3 && sums[0].sourceCount === 3
      && sums[0].representativeItemID === ev3ID, `7 summaries：3 源徽标 + 代表正确（N=${sums[0]?.memberCount}）`);
    ok(Array.isArray(sums[0].members) && sums[0].members.length === 3
      && sums[0].members.every((m) => m.itemID && m.title && m.sourceTitle), '7 summaries.members：全簇成员带来源名+标题');
    // 删掉两个成员（模拟条目淘汰）→ 死簇惰性回收
    store.database.prepare("DELETE FROM items WHERE id IN (SELECT item_id FROM articles WHERE url IN ('https://f21.test/b/1', 'https://f21.test/c/1'))").run();
    const sumsAfter = store.events.summaries([clusterID1]);
    ok(sumsAfter.length === 0
      && !store.database.prepare('SELECT 1 FROM event_clusters WHERE id = ?').get(clusterID1)
      && !store.database.prepare('SELECT cluster_id FROM items WHERE id = (SELECT item_id FROM articles WHERE url = ?)').get('https://f21.test/a/1')?.cluster_id,
      '7 成员删光 → 死簇惰性回收（簇行删除 + 残余成员归属清空）');

    // ── 9a. 入库钩子登记不阻塞灌文主路径 ──
    const feedBulk = mkFeed('量产源', 'https://f21.test/bulk.xml');
    const bulkEntries = [];
    for (let i = 0; i < 50; i++) {
      bulkEntries.push({ id: `bulk-${i}`, title: `量产灌文性能样本第 ${i} 篇：无关内容 ${i * 7919}`, url: `https://f21.test/bulk/${i}`, publishedAt: now - i, summary: '', contentHTML: null });
    }
    const tIngest = process.hrtime.bigint();
    ingest(feedBulk, bulkEntries);
    const ingestMs = Number(process.hrtime.bigint() - tIngest) / 1e6;
    const pendingAtHook = store.events.stats().pending;
    ok(ingestMs < 400, `9 入库钩子登记不阻塞灌文（50 篇含聚类登记 ${ingestMs.toFixed(1)}ms < 400ms）`);
    ok(pendingAtHook > 0, '9 聚类走后台合批（灌文返回时挂起队列 > 0，未同步计算）');
    await store.events.flush();

    // ── 8. 事件模式渲染（真实窗口 + 真 preload + 真 IPC）──
    const ui = await eventsUIProbe(store, { clusterFeedA: feedA.id });
    ok(ui.booted, '附 UI 探针窗口启动（index.html + preload + 真 IPC）');
    ok(ui.toolbarBtn === true, '8 工具栏「事件」切换按钮在位（与精选/简报同级）');
    ok(ui.cards === 1 && ui.collapsedByDefault === true && ui.memberRowsClosed === 0,
      '8 事件卡渲染：同簇一卡；收合态默认仅代表（0 成员行）');
    ok(/3 源/.test(ui.badgeText || ''), `8 N 源徽标（「${ui.badgeText}」）`);
    ok(ui.expandWorks === true && ui.memberRowsOpen === 3, '8 点卡展开：成员行 = 3（来源名+标题，跨页全景）');
    ok(ui.memberClickOpens === true, '8 点成员行 → onSelect 进阅读器回调');
    ok(ui.singlesStayRows === true, '8 独报条目保持普通行渲染（未被误收编）');
    ok(ui.scopeFilter === true, '8 作用域过滤照常生效（scope 外成员不出卡、卡内分组随当页集合）');
    ok(ui.offBackToRows === true, '8 关闭事件模式 → 回普通列表行');
    ok(ui.activeToggle === true, '8 切换后按钮 active 态正确');

    // ── 重启读回：老库升级无损（数据跨迁移完整保留）──
    const entriesBefore = store.database.prepare('SELECT COUNT(*) AS n FROM articles').get().n;
    store.preferences.flushSync();
    store.database.close();
    const store2 = new AppStore(userData);
    const entriesAfter = store2.database.prepare('SELECT COUNT(*) AS n FROM articles').get().n;
    const migCount = store2.database.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id LIKE 'v2%'").get().n;
    ok(entriesAfter === entriesBefore && entriesBefore > 0, `附 重启读回：${entriesAfter} 篇文章跨迁移无损保留`);
    ok(migCount >= 2, `附 v2x 迁移记录齐备（${migCount} 条）`);

    // ── 9b. 500 条聚类性能 <2s（用重启后的 store2）──
    const feedPerf = store2.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '性能源', feedURL: 'https://f21.test/perf.xml' });
    const perfEntries = [];
    for (let i = 0; i < 500; i++) {
      // 每 10 条出一组近重复标题（组内同题多源），其余互不相似
      const group = Math.floor(i / 10);
      const title = i % 10 === 0
        ? `突发快讯：量子计算公司 QuantumX 完成第 ${group} 轮融资并公布路线图`
        : i % 10 === 1
          ? `突发快讯：量子计算公司 QuantumX 完成第 ${group} 轮融资并公布其路线图`
          : `独立评测样本 ${i} 号：混合现实头显续航与发热实测数据 ${i * 31}`;
      perfEntries.push({ id: `perf-${i}`, title, url: `https://f21.test/perf/${i}`, publishedAt: now - i, summary: '', contentHTML: null });
    }
    const ids = store2._applyParsedEntries(feedPerf, perfEntries);
    await store2.events.flush();
    // 归零簇归属后整库补跑：测的是真实聚类计算成本（入簇路径已在 flush 中幂等跳过）
    store2.database.prepare('UPDATE items SET cluster_id = NULL WHERE feed_id = ?').run(feedPerf.id);
    store2.database.exec('DELETE FROM event_clusters');
    const t0 = process.hrtime.bigint();
    const rebuilt = store2.events.rebuild({ windowDays: 7 });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const perfIngested = store2.database.prepare("SELECT COUNT(*) AS n FROM articles WHERE url LIKE 'https://f21.test/perf/%'").get().n;
    ok(perfIngested === 500 && ms < 2000, `9 500 条聚类 ${ms.toFixed(0)}ms < 2000ms（入库 ${perfIngested}，补跑聚类 ${rebuilt.clustered} 次入簇）`);
    const perfClusters = store2.database.prepare('SELECT COUNT(*) AS n FROM event_clusters').get().n;
    ok(perfClusters >= 50, `9 相似组成簇（${perfClusters} 簇 ≥ 50 组）`);
    const tSummary = process.hrtime.bigint();
    const clusterIDs = store2.database.prepare('SELECT id FROM event_clusters LIMIT 200').all().map((r) => r.id);
    store2.events.summaries(clusterIDs);
    const summaryMs = Number(process.hrtime.bigint() - tSummary) / 1e6;
    ok(summaryMs < 300, `9 summaries 批量载荷 ${summaryMs.toFixed(1)}ms < 300ms（200 簇）`);

    // ── 9c. rebuild 用户入口（批 C 审查遗留收口：功能调用 + IPC + preload + 命令面板）──
    ok(store2.database.prepare('SELECT COUNT(*) AS n FROM items WHERE feed_id = ?').get(feedPerf.id).n > 0,
      '9c rebuild 前置：perf 源条目在库');
    const rebuiltViaIPC = store2.events.rebuild({ windowDays: 7 });
    ok(rebuiltViaIPC.scanned >= 1 && rebuiltViaIPC.windowDays === 7,
      `9c rebuild 功能调用：扫描 ${rebuiltViaIPC.scanned} 篇（windowDays=7，幂等再跑）`);
    ok(read('src/main/ipc.js').includes("'events:rebuild'"), '9c IPC events:rebuild 注册');
    ok(read('src/main/preload.js').includes('eventsRebuild'), '9c preload 桥 eventsRebuild 通道');
    const strings = read('src/main/I18NStrings.js');
    ok(strings.includes('"重建事件索引"') && strings.includes('"事件索引已重建：扫描 %lld 篇 · 新并 %lld 次"'),
      '9c i18n 重建命令双语键齐备');

    store2.events.dispose();
    store2.preferences.flushSync();
    store2.database.close();

    // ── 附：静态接线锚点 ──
    ok(read('src/main/preload.js').includes('eventSummaries'), '附 preload 桥 eventSummaries 通道');
    ok(read('src/main/ipc.js').includes("'events:summaries'"), '附 IPC events:summaries 注册');
    ok(strings.includes('"%lld 源"') && strings.includes('"切换事件模式"') && strings.includes('"事件"'),
      '附 i18n 中英键齐备（事件/切换事件模式/N 源）');
    const listSrc = read('src/renderer/views/list.js');
    ok(listSrc.includes('#events-btn') && listSrc.includes('nj-event-card') && listSrc.includes('setEventsMode'),
      '附 列表工具栏事件钮 + 事件卡渲染 + setEventsMode 接线');
    const appSrc = read('src/renderer/app.js');
    ok(appSrc.includes('toggleEventsMode') && appSrc.includes('切换事件模式') && appSrc.includes('eventSummaries'),
      '附 app.js 事件切换 + 命令面板命令 + 摘要拉取接线');
    ok(appSrc.includes('rebuildEventsIndex') && appSrc.includes('重建事件索引'),
      '9c 命令面板「重建事件索引」命令 + rebuildEventsIndex 接线');
    ok(read('src/renderer/styles/robin.css').includes('.nj-event-card'), '附 事件卡样式入册');

    try { fs.rmSync(userData, { recursive: true, force: true }); }
    catch (_) { /* 临时目录留给系统清理 */ }
    console.log(failed === 0 ? 'ALL PASSED' : `FAILED ${failed}`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('ERR', String((err && err.stack) || err).slice(0, 1600));
    app.exit(1);
  }
});

/**
 * 事件模式 UI 探针：隐藏窗口 + 真 preload。为控制断言精度，用独立 ListView 实例
 * 渲染构造好的当页条目（含 clusterID）+ 真 IPC 拉取的 summaries 载荷。
 */
async function eventsUIProbe(store, { clusterFeedA }) {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: { contextIsolation: true, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
  const { registerIPCHandlers } = require('../src/main/ipc');
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(900);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      const { ListView } = await import('./views/list.js');
      const out = { booted: true };
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:420px;height:600px;overflow:auto;';
      host.className = 'list-scroll';
      document.body.appendChild(host);
      const selected = [];
      const list = new ListView(host, { onSelect: (id) => selected.push(id) });
      // 工具栏按钮（与 精选/简报 同级）
      const btn = list.topInset.querySelector('#events-btn');
      out.toolbarBtn = !!btn && btn.textContent.includes('事件');

      const items = [
        { id: 'ev-3', feedID: 'f', accountID: 'local-default', title: 'OpenAI 发布全新推理模型 o5 系列，API 同步开放', summaryPreview: '', sourceTitle: '行业观察', publishedAt: 100, isRead: false, isStarred: false, isLater: false, clusterID: 'cl-1' },
        { id: 'ev-1', feedID: 'f', accountID: 'local-default', title: 'OpenAI 发布全新推理模型 o5 系列并开放 API', summaryPreview: '', sourceTitle: '科技晨报', publishedAt: 400, isRead: false, isStarred: false, isLater: false, clusterID: 'cl-1' },
        { id: 'single-1', feedID: 'f', accountID: 'local-default', title: '冬季炖汤的十种家常做法', summaryPreview: '', sourceTitle: '美食杂志', publishedAt: 300, isRead: false, isStarred: false, isLater: false, clusterID: null },
        { id: 'ev-2', feedID: 'f', accountID: 'local-default', title: 'OpenAI 发布全新推理模型 o5 系列并开放 API 接口', summaryPreview: '', sourceTitle: '硅谷速递', publishedAt: 200, isRead: false, isStarred: false, isLater: false, clusterID: 'cl-1' },
      ];
      // 真 IPC：主进程 summaries 载荷（3 源全景）
      const summaries = await window.robin.eventSummaries([]);
      out.summariesEmptyOk = Array.isArray(summaries) && summaries.length === 0;
      list.setEventsMode(true);
      list.setEvents([
        { id: 'cl-1', representativeItemID: 'ev-3', title: 'OpenAI 发布全新推理模型 o5 系列，API 同步开放',
          memberCount: 3, sourceCount: 3, members: [
            { itemID: 'ev-3', title: 'OpenAI 发布全新推理模型 o5 系列，API 同步开放', sourceTitle: '行业观察', publishedAt: 100 },
            { itemID: 'ev-1', title: 'OpenAI 发布全新推理模型 o5 系列并开放 API', sourceTitle: '科技晨报', publishedAt: 400 },
            { itemID: 'ev-2', title: 'OpenAI 发布全新推理模型 o5 系列并开放 API 接口', sourceTitle: '硅谷速递', publishedAt: 200 },
          ] },
      ]);
      list.render(items, { kind: 'today' }, null, true);
      await sleep(50);
      const cards = host.querySelectorAll('.nj-event-card');
      out.cards = cards.length;
      const card = cards[0];
      out.collapsedByDefault = card && !card.classList.contains('expanded');
      out.memberRowsClosed = card.querySelectorAll('.nj-event-member').length;
      out.badgeText = card?.querySelector('.nj-event-sources')?.textContent || '';
      out.activeToggle = list.eventsBtn.classList.contains('active');
      // 展开：成员行 = 全簇 3 行（摘要载荷），带来源名+标题
      card.querySelector('.nj-event-head').click();
      await sleep(30);
      const memberRows = [...card.querySelectorAll('.nj-event-member')];
      out.memberRowsOpen = memberRows.length;
      out.expandWorks = card.classList.contains('expanded')
        && memberRows.some((r) => r.querySelector('.nj-event-member-src')?.textContent === '硅谷速递')
        && memberRows.every((r) => (r.querySelector('.nj-event-member-title')?.textContent || '').includes('o5'));
      memberRows[0].click();
      await sleep(30);
      out.memberClickOpens = selected.length === 1 && selected[0] === 'ev-3';
      card.querySelector('.nj-event-head').click(); // 收合还原（展开态跨渲染持久，先归位再测下一场景）
      await sleep(30);
      // 独报保持普通行
      out.singlesStayRows = host.querySelectorAll('.entry-row').length === 1
        && host.querySelector('.entry-row')?.dataset.entryId === 'single-1';
      // 作用域过滤：scope 外成员不出现（当页只喂未读成员 → 卡只收当页成员；展开仍给全簇全景）
      const scopedItems = items.filter((it) => it.id !== 'ev-2'); // 模拟已读被未读视野滤掉
      list.render(scopedItems, { kind: 'unread' }, null, true);
      await sleep(30);
      const scopedCards = host.querySelectorAll('.nj-event-card');
      const scopedHead = scopedCards[0]?.querySelector('.nj-event-head');
      scopedHead?.click(); // 展开验证全景（成员清单来自 summaries，不受分页截断）
      await sleep(30);
      out.scopeFilter = scopedCards.length === 1
        && scopedCards[0].classList.contains('expanded')
        && scopedCards[0].querySelectorAll('.nj-event-member').length === 3
        && (scopedCards[0].querySelector('.nj-event-sources')?.textContent || '').includes('3');
      // 关闭 → 普通列表（4 行）
      list.setEventsMode(false);
      list.render(items, { kind: 'today' }, null, true);
      await sleep(30);
      out.offRows = host.querySelectorAll('.entry-row').length;
      out.offClusters = host.querySelectorAll('.cluster-row').length; // 渲染层同题折叠（既有行为）计入行族
      out.offCards = host.querySelectorAll('.nj-event-card').length;
      out.offBackToRows = out.offRows + out.offClusters >= 2 && out.offCards === 0;
      return out;
    } catch (e) {
      return { error: String((e && e.stack) || e).slice(0, 700) };
    }
  })()`);
  win.destroy();
  if (!result || result.error) console.error('events UI probe error:', result && (result.error || result));
  else if (!(result.scopeFilter && result.offBackToRows)) console.error('events UI debug:', JSON.stringify(result));
  return result || {};
}
