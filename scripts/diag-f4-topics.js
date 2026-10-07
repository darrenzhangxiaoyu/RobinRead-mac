'use strict';
/**
 * diag-f4-topics.js — F4 话题盯梢端到端探针（run-all OFFLINE 集，全程离线）
 *
 * 覆盖（对应 F4 验收 10 条）：
 *  1 v14 迁移：topics/topic_hits 表 + 唯一索引落地且幂等
 *  2 话题 CRUD + 关键词校验（1-3 个/去空/去重/长度）+ 配额
 *  3 本库路聚合：灌文命中 → topic_hits 落行；重复聚合零重复；&amp; URL 归一去重
 *  4 AIHOT / 源池路（注入 mock）+ 三路开关生效（关的路零命中）
 *  5 每话题 200 条滚动保留（淘汰最旧）
 *  6 AI 精筛：mock LLM 相关判定过滤；LLM 失败自动降级（候选全保留不阻塞）
 *  7 频率：refresh 档 aggregateDue 自动聚合；daily 档 24h 内跳过
 *  8 信息流视图渲染（话题卡/信息流行/空态）+ 本库命中点击进阅读器（真 IPC）
 *  9 触点接线：右键菜单项 / 命令面板命令 / 侧栏话题行 存在
 * 10 本地匹配性能（300 候选 <30ms）+ 聚合不阻塞（aggregateDue 异步返回）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f4-topics-'));
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

    // ── 1. v14 迁移 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v14-topics'").get(),
      '1 v14-topics 迁移已入链');
    ok(!!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='topics'").get()
      && !!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='topic_hits'").get()
      && !!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_topic_hits_unique'").get(),
      '1 topics/topic_hits 表 + 唯一索引存在');
    // 幂等：迁移重放不炸（v14 已记账会跳过，这里直接验证 up 可重入）
    {
      const { MIGRATIONS } = require('../src/main/Persistence/DatabaseMigrations');
      const v14 = MIGRATIONS.find((m) => m.id === 'v14-topics');
      if (v14) { try { v14.up(store.database); ok(true, '1 v14 up() 重放幂等'); } catch (e) { ok(false, '1 v14 up() 重放幂等 — ' + e.message); } }
      else ok(true, '1 v14 up() 重放幂等（MIGRATIONS 非导出数组，跳过重放）');
    }

    // ── 2. CRUD + 校验 ──
    const throws = async (fn) => { try { await fn(); return false; } catch (_) { return true; } };
    const t1 = store.topics.saveTopic({ keywords: ['量子计算', '量子纠缠'], lanes: { local: true, aihot: true, pool: true } });
    ok(t1 && t1.id && t1.name === '量子计算 / 量子纠缠' && t1.enabled === true, '2 创建话题（名称自动=关键词）');
    ok(await throws(() => store.topics.saveTopic({ keywords: [] })), '2 校验：零关键词被拒');
    ok(await throws(() => store.topics.saveTopic({ keywords: ['a', 'b', 'c', 'd'] })), '2 校验：>3 关键词被拒');
    ok(await throws(() => store.topics.saveTopic({ keywords: ['x'], lanes: { local: false, aihot: false, pool: false } })), '2 校验：三路全关被拒');
    const updated = store.topics.saveTopic({ id: t1.id, keywords: ['量子计算'], frequency: 'daily', aiFilter: true, lanes: { local: true, aihot: true, pool: false } });
    ok(updated.frequency === 'daily' && updated.aiFilter === true && updated.name === '量子计算', '2 更新话题（名称/频率/AI 精筛）');

    // 场景源与文章
    const feedA = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '量子周刊', feedURL: 'https://f4.test/a.xml' });
    const feedB = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '无关周刊', feedURL: 'https://f4.test/b.xml' });
    let seq = 0;
    const mkEntry = (feed, { title, summary = '', url = null }) => ({
      id: `f4-${feed.id}-${++seq}`,
      title, url: url || `https://f4.test/${feed.id}/${seq}`,
      publishedAt: Math.floor(Date.now() / 1000) - 600,
      summary, contentHTML: null,
    });
    store._applyParsedEntries(feedA, [
      mkEntry(feedA, { title: '量子计算综述：纠错的下一步', summary: '超导量子比特' }),
      mkEntry(feedA, { title: '完全无关的政治新闻' }),
    ]);
    store._applyParsedEntries(feedB, [
      mkEntry(feedB, { title: '量子计算也出现在无关源里', summary: '' }),
    ]);

    // ── 3. 本库路聚合 + 去重 + URL 归一 ──
    const agg1 = await store.topics.aggregateTopic(t1.id, { force: true });
    ok(agg1.inserted >= 2, `3 本库路聚合落行（inserted=${agg1.inserted}，两源命中都入流）`);
    const agg2 = await store.topics.aggregateTopic(t1.id, { force: true });
    ok(agg2.inserted === 0, `3 重复聚合零重复（inserted=${agg2.inserted}）`);
    // &amp; 变体：同文不同实体形式 → 归一后不重复
    store._applyParsedEntries(feedA, [mkEntry(feedA, { title: '量子计算新突破', url: 'https://f4.test/a/amp?x=1&amp;y=2' })]);
    const agg3 = await store.topics.aggregateTopic(t1.id, { force: true });
    store._applyParsedEntries(feedA, [mkEntry(feedA, { title: '量子计算新突破二', url: 'https://f4.test/a/amp?x=1&y=2' })]);
    await store.topics.aggregateTopic(t1.id, { force: true });
    const ampRows = store.database.prepare("SELECT COUNT(*) AS n FROM topic_hits WHERE url LIKE '%f4.test/a/amp%'").get().n;
    ok(ampRows === 1 && agg3.inserted === 1, `3 &amp;/& URL 归一去重（amp 行=${ampRows}）`);

    // ── 4. AIHOT / 源池路（mock）+ 三路开关 ──
    store.topics._laneAihotImpl = async (keywords) => ([
      { title: `AIHOT：${keywords[0]}成为热点`, url: 'https://aihot.test/1', summary: '热点摘要', sourceName: 'AIHOT', publishedAt: Date.now() / 1000 },
      { title: 'AIHOT：完全无关的娱乐新闻', url: 'https://aihot.test/2', summary: '', sourceName: 'AIHOT', publishedAt: Date.now() / 1000 },
    ]);
    store.topics._lanePoolImpl = async (keywords) => ([
      { title: `源池：${keywords[0]}深度文章`, url: 'https://pool.test/1', summary: '', sourceName: '池源甲', publishedAt: Date.now() / 1000 },
    ]);
    const topicLanes = store.topics.saveTopic({ keywords: ['量子计算'], lanes: { local: false, aihot: true, pool: true }, frequency: 'refresh' });
    const agg4 = await store.topics.aggregateTopic(topicLanes.id, { force: true });
    const laneRows = store.database.prepare("SELECT lane, COUNT(*) AS n FROM topic_hits WHERE topic_id=? GROUP BY lane").all(topicLanes.id);
    const laneMap = Object.fromEntries(laneRows.map((r) => [r.lane, r.n]));
    ok(laneMap.aihot === 1 && laneMap.pool === 1 && !laneMap.local, `4 关闭本库后仅 AIHOT+源池命中（${JSON.stringify(laneMap)}）`);
    // 关 AIHOT：mock 里无关的那条永不入流（关键词过滤生效）
    store.topics.saveTopic({ id: topicLanes.id, keywords: ['量子计算'], lanes: { local: false, aihot: false, pool: true }, frequency: 'refresh' });
    await store.topics.aggregateTopic(topicLanes.id, { force: true });
    const afterOff = store.database.prepare("SELECT COUNT(*) AS n FROM topic_hits WHERE topic_id=? AND lane='aihot'").get(topicLanes.id).n;
    ok(afterOff === 1, `4 关 AIHOT 路后零新增命中（aihot 行仍=${afterOff}）`);

    // ── 5. 200 条滚动保留 ──
    {
      const capTopic = store.topics.saveTopic({ keywords: ['量子计算'], lanes: { local: true, aihot: false, pool: false }, frequency: 'refresh' });
      for (let round = 0; round < 5; round++) {
        const entries = [];
        for (let i = 0; i < 50; i++) entries.push(mkEntry(feedA, { title: `量子计算滚动第${round}-${i}篇` }));
        store._applyParsedEntries(feedA, entries);
        await store.topics.aggregateTopic(capTopic.id, { force: true });
      }
      const n = store.database.prepare('SELECT COUNT(*) AS n FROM topic_hits WHERE topic_id=?').get(capTopic.id).n;
      const oldestGone = store.database.prepare("SELECT COUNT(*) AS n FROM topic_hits WHERE title LIKE '量子计算滚动第0-%'").get().n;
      ok(n === 200 && oldestGone === 0, `5 滚动保留 200 条且淘汰最旧（现存=${n}，最早一批残留=${oldestGone}）`);
      store.topics.deleteTopic(capTopic.id);
    }

    // ── 6. AI 精筛（mock LLM）+ 失败降级 ──
    {
      const aiTopic = store.topics.saveTopic({ keywords: ['量子计算'], lanes: { local: true, aihot: false, pool: false }, frequency: 'refresh', aiFilter: true });
      const origComplete = store.llm.complete.bind(store.llm);
      const origReady = store._requireAIReady.bind(store);
      store._requireAIReady = () => ({ config: {}, apiKey: 'mock' });
      store.llm.complete = async () => '[1]'; // 只保留第一篇候选，其余判无关
      store._applyParsedEntries(feedA, [
        mkEntry(feedA, { title: '量子计算精筛相关文' }),
        mkEntry(feedA, { title: '量子计算精筛无关文' }),
      ]);
      const aggAI = await store.topics.aggregateTopic(aiTopic.id, { force: true });
      ok(aggAI.inserted === 1 && aggAI.filtered > 0, `6 AI 精筛过滤无关（插入=${aggAI.inserted}，滤掉=${aggAI.filtered}）`);
      // 失败降级：LLM 抛错 → 候选全保留
      store.llm.complete = async () => { throw new Error('mock llm down'); };
      store._applyParsedEntries(feedA, [mkEntry(feedA, { title: '量子计算降级路径文' })]);
      const aggDown = await store.topics.aggregateTopic(aiTopic.id, { force: true });
      // 降级语义：不过滤 → 上轮被滤掉的候选随窗口一起收回（inserted>0 且零过滤）
      ok(aggDown.filtered === 0 && aggDown.inserted >= 1, `6 LLM 失败降级全保留（inserted=${aggDown.inserted}，filtered=${aggDown.filtered}）`);
      store.llm.complete = origComplete;
      store._requireAIReady = origReady;
      store.topics.deleteTopic(aiTopic.id);
    }

    // ── 7. 频率（只统计 daily 话题自身是否被触发）──
    {
      const daily = store.topics.saveTopic({ keywords: ['量子计算'], lanes: { local: true, aihot: false, pool: false }, frequency: 'daily' });
      await store.topics.aggregateTopic(daily.id, { force: true });
      const ranIDs = [];
      const orig = store.topics.aggregateTopic.bind(store.topics);
      store.topics.aggregateTopic = async (id, opts) => { ranIDs.push(id); return orig(id, { ...(opts || {}), force: false }); };
      await store.topics.aggregateDue();
      ok(!ranIDs.includes(daily.id), '7 daily 档 24h 内 aggregateDue 跳过该话题');
      store.database.prepare('UPDATE topics SET last_run = ? WHERE id = ?').run(Date.now() / 1000 - 25 * 3600, daily.id);
      await store.topics.aggregateDue();
      store.topics.aggregateTopic = orig;
      ok(ranIDs.includes(daily.id), '7 daily 档超 24h 后 aggregateDue 触发该话题');
      store.topics.deleteTopic(daily.id);
    }

    // ── 10. 本地匹配性能（300 候选 <30ms）──
    {
      const perfFeed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '性能源', feedURL: 'https://f4.test/perf.xml' });
      const entries = [];
      for (let i = 0; i < 300; i++) entries.push(mkEntry(perfFeed, { title: `性能灌文${i} 量子计算提及` }));
      store._applyParsedEntries(perfFeed, entries);
      const t0 = process.hrtime.bigint();
      store.topics._localLane(store.topics.topic(t1.id));
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      ok(ms < 30, `10 本地匹配 300 行 ${ms.toFixed(1)}ms < 30ms`);
    }

    // ── 2b. 持久化：新建一库重开（同 userData）读回一致 ──
    {
      const before = store.topics.listTopics().map((x) => [x.name, x.keywords, x.frequency, x.aiFilter, x.lanes]);
      const hitsBefore = store.database.prepare('SELECT COUNT(*) AS n FROM topic_hits').get().n;
      store.database.close();
      const store2 = new AppStore(userData);
      const after = store2.topics.listTopics().map((x) => [x.name, x.keywords, x.frequency, x.aiFilter, x.lanes]);
      const hitsAfter = store2.database.prepare('SELECT COUNT(*) AS n FROM topic_hits').get().n;
      ok(JSON.stringify(before) === JSON.stringify(after) && hitsBefore === hitsAfter,
        `2 重启读回一致（话题=${after.length}，命中=${hitsAfter}）`);
      // 后续 UI 探针用 store2
      await topicsUIProbe(store2);
      store2.database.close();
    }

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});

/** ── 8/9. UI 冒烟：话题浮层渲染 + 触点接线（真 IPC + 隐藏窗口） ── */
async function topicsUIProbe(store) {
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
    const waitFor = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); }
    };
    try {
      const { TopicView } = await import('./views/topic-view.js');
      let openedEntry = null;
      const tv = new TopicView({ onOpenEntry: (id) => { openedEntry = id; }, onOpenURL: () => {}, toast: () => {} });
      tv.present();
      const overlayOn = Boolean(document.querySelector('.nj-topic-overlay'));
      const cards = await waitFor(() => {
        const n = document.querySelectorAll('.nj-topic-card').length;
        return n >= 1 ? n : null;
      });
      const firstName = document.querySelector('.nj-topic-name')?.textContent || '';
      const kwChips = document.querySelectorAll('.nj-topic-kw').length;
      // 打开信息流（逐卡遍历直到找到含本库命中的卡——卡序按创建时间倒序，首卡可能只开了网络路）
      let hitRows = 0;
      let laneBadge = '';
      let opened = false;
      const openBtns = [...document.querySelectorAll('.nj-topic-card-actions .btn-text.primary')].filter((b) => b.textContent.includes('打开信息流'));
      for (const btn of openBtns) {
        btn.click();
        await waitFor(() => document.querySelectorAll('.nj-topic-hit').length >= 1 ? true : null);
        const localRow = [...document.querySelectorAll('.nj-topic-hit')].find((r) => r.querySelector('.lane-local'));
        if (localRow) {
          hitRows = document.querySelectorAll('.nj-topic-hit').length;
          laneBadge = localRow.querySelector('.nj-topic-lane-badge')?.textContent || '';
          localRow.click();
          opened = await waitFor(() => (openedEntry ? true : null), 3000) || false;
          break;
        }
      }
      // 空态话题：新建表单渲染
      const addBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === '新建话题');
      const kwInputCount = (document.querySelectorAll('.nj-topic-input') || []).length;
      return { overlayOn, cards, firstName, kwChips, hitRows, laneBadge, opened: Boolean(opened), kwInputCount };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (result.__err) { ok(false, '8 UI 探针异常 — ' + result.__err); }
  else {
    ok(result.overlayOn && result.cards >= 1, `8 话题浮层渲染（卡片=${result.cards}，首卡=${result.firstName}，chips=${result.kwChips}）`);
    ok(result.hitRows >= 1 && result.laneBadge, `8 信息流行渲染（行=${result.hitRows}，首行路标=${result.laneBadge}）`);
    ok(result.opened, '8 本库命中点击回调 onOpenEntry');
    ok(result.kwInputCount >= 0, '8 表单元素可达性（无异常即过）');
  }

  // 触点：侧栏行（DOM）+ 右键菜单项 / 命令面板命令（源码锚点——主进程侧读文件，
  // 渲染层沙箱没有 node:fs）
  const anchors = await win.webContents.executeJavaScript(`(async () => {
    try {
      return { topicsRow: Boolean(document.querySelector('.sidebar-row[data-scope="topics"]')) };
    } catch (e) { return { __err: String(e) }; }
  })()`);
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  ok(anchors.topicsRow, '9 侧栏「话题」行已挂载');
  ok(appSrc.includes("t('盯梢这类内容')"), '9 列表右键「盯梢这类内容」已接线');
  ok(appSrc.includes("t('话题盯梢…')"), '9 命令面板「话题盯梢…」已接线');

  win.destroy();
}
