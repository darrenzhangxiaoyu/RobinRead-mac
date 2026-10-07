'use strict';
/**
 * diag-f9-rag.js — F9 全库 RAG 问答端到端探针（run-all OFFLINE 集，全程离线）
 *
 * LLM 走受控 fake 流（store.llm.complete 替换），AIHOT 路注入。覆盖（对应 F9 验收 10 条）：
 *  1 v18 迁移：rag_sessions / rag_messages 表 + 幂等重放 + 老库升级无损
 *  2 gather：FTS 文章命中、高亮/笔记命中、正文缓存命中段（关键词在正文中段）、
 *    entryID+kind 去重、总量上限 30、AIHOT 路注入
 *  3 正文检索性能：灌 200 篇带缓存文章（10MB 级正文），gather <300ms；
 *    EXPLAIN QUERY PLAN 证明缓存查询走主键限集（无全表 SCAN）
 *  4 ask 流式：mock 分片依次推送、assistant 消息落库、sources_json 存素材、
 *    引用编号约束进 prompt（mock 捕获）
 *  5 多轮：同 session 二问上下文含首轮 Q/A；新 session 不含
 *  6 无 Key：明确报错；纯检索模式返回素材列表（不调 LLM）
 *  7 单飞锁 + 取消保留已流部分
 *  8 会话列表 / 重开 / 删除（级联 messages）/ 重命名
 *  9 UI：会话侧栏 / 消息流气泡 / [n] 芯片 / 素材浮层 / 输入框流式追加 / 取消按钮
 * 10 回归：旧「问知识库」入口（kb:ask）不破坏；knowledge tab 切换清理 rag 订阅
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f9-rag-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(userData);
    const { MIGRATIONS, runMigrations } = require('../src/main/Persistence/DatabaseMigrations');
    const { bodyCacheQuery, dedupeMaterials, MATERIAL_CAP } = require('../src/main/RAGService');

    // ── 1. v18 迁移 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v18-rag-sessions'").get(),
      '1 v18-rag-sessions 迁移已入链');
    ok(!!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rag_sessions'").get()
      && !!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rag_messages'").get()
      && !!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_rag_messages_session'").get()
      && !!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_rag_sessions_updated'").get(),
      '1 rag_sessions / rag_messages 表 + 索引存在');
    {
      const v18 = MIGRATIONS.find((m) => m.id === 'v18-rag-sessions');
      try { v18.up(store.database); ok(true, '1 v18 up() 重放幂等'); }
      catch (e) { ok(false, '1 v18 up() 重放幂等 — ' + e.message); }
    }
    // 老库升级无损：清掉 v18 记账 + DROP 表（模拟 v17 老库），重跑迁移链 → 表重建、其余数据原样
    {
      const feedOld = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '升级前已有源', feedURL: 'https://f9.test/old.xml' });
      store._applyParsedEntries(feedOld, [{
        id: 'f9-old-1', title: '升级前已有文章', url: 'https://f9.test/old/1',
        publishedAt: Math.floor(Date.now() / 1000) - 3600, summary: '老库数据', contentHTML: null,
      }]);
      const db = store.database;
      db.exec('DROP TABLE rag_messages');
      db.exec('DROP TABLE rag_sessions');
      db.prepare("DELETE FROM schema_migrations WHERE id = 'v18-rag-sessions'").run();
      runMigrations(db);
      const tableBack = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rag_messages'").get()
        && !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rag_sessions'").get();
      const articlesKept = db.prepare("SELECT COUNT(*) AS n FROM articles WHERE title = '升级前已有文章'").get().n;
      const feedsKept = db.prepare("SELECT 1 FROM feeds WHERE id = ?").get(feedOld.id);
      ok(tableBack && articlesKept === 1 && !!feedsKept,
        `1 老库升级无损（表重建=${tableBack}，文章保留=${articlesKept}，订阅保留=${!!feedsKept}）`);
      runMigrations(db);
      ok(!!db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v18-rag-sessions'").get(), '1 迁移链重放幂等');
    }

    // ── 场景灌文：FTS 文章路 + 知识库路 + 正文缓存路 + 无关源 ──
    store.rag._aihotItemsImpl = async () => ([]); // 默认安静注入（2 会单独开）
    const feedA = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '量子周刊', feedURL: 'https://f9.test/a.xml' });
    const feedB = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '无关周刊', feedURL: 'https://f9.test/b.xml' });
    let seq = 0;
    const mkEntry = (feed, { title, summary = '', url = null }) => ({
      id: `f9-${feed.id}-${++seq}`,
      title, url: url || `https://f9.test/${feed.id}/${seq}`,
      publishedAt: Math.floor(Date.now() / 1000) - 600,
      summary, contentHTML: null,
    });
    store._applyParsedEntries(feedA, [
      mkEntry(feedA, { title: '量子计算综述：纠错的下一步', summary: '超导量子比特与表面码阈值' }),
      mkEntry(feedA, { title: '量子计算硬件进展：比特数破千', summary: '超导与离子阱路线对比' }),
      mkEntry(feedA, { title: '量子计算软件栈观察', summary: '编译器与纠错中间件' }),
    ]);
    store._applyParsedEntries(feedB, [
      mkEntry(feedB, { title: '完全无关的政治新闻', summary: '' }),
    ]);
    // 正文缓存路样例：标题/摘要不含问题词，缓存正文中段含关键词（验 ±300 截窗）
    store._applyParsedEntries(feedA, [mkEntry(feedA, { title: '本周实验室札记第 41 期', summary: '例行记录' })]);
    {
      const bodyID = store.database.prepare("SELECT item_id FROM articles WHERE title = '本周实验室札记第 41 期'").get().item_id;
      const filler = '这是填充句，记录日常仪器状态与排班。'.repeat(40); // ~800 字前缀（>截窗半径 300）
      store.cachesRepo.saveCache({
        entryID: bodyID,
        text: filler + '中间段出现量子计算纠错阈值实验的新数据 marker99%，后续还在复测。',
      });
    }
    // 知识库路样例：高亮 + 笔记
    const hlEntry = store.database.prepare("SELECT item_id FROM articles WHERE title = '量子计算综述：纠错的下一步'").get().item_id;
    store.knowledge.addHighlight({ itemID: hlEntry, text: '量子计算值得长期跟踪的三个理由' });
    store.knowledge.addNote({ itemID: hlEntry, content: '笔记：量子计算的纠错路线值得深入阅读' });

    // ── 2. gather：四路命中 + 去重 + 上限 + AIHOT 注入 ──
    store.rag._aihotItemsImpl = async () => ([
      { title: 'AIHOT：量子计算成热点', summary: '热点摘要甲', source: 'AIHOT', originalURL: 'https://aihot.test/1' },
    ]);
    const QUESTION = '量子计算 相关进展如何';
    const g1 = await store.rag.gatherRAG(QUESTION);
    ok(g1.materials.some((m) => m.kind === 'article' && (m.title || '').includes('量子计算')),
      '2 FTS 文章路命中（kind=article）');
    ok(g1.materials.some((m) => m.kind === 'highlight') && g1.materials.some((m) => m.kind === 'note'),
      '2 知识库路命中（highlight + note，整句零命中退关键词）');
    const bodyMat = g1.materials.find((m) => m.kind === 'article' && m.snippet.includes('marker99'));
    ok(!!bodyMat && bodyMat.snippet.startsWith('…'),
      '2 正文缓存命中段（关键词在正文中段，±300 截窗生效）');
    ok(g1.materials.some((m) => m.kind === 'hot'), '2 AIHOT 路注入命中');
    {
      const keys = g1.materials.map((m) => (m.entryID ? `${m.kind}:${m.entryID}` : `${m.kind}:${m.title.toLowerCase().replace(/\s+/g, '')}`));
      ok(new Set(keys).size === keys.length, `2 entryID+kind 去重（键 ${keys.length} 唯一）`);
      ok(g1.materials.every((m) => ['article', 'highlight', 'note', 'hot'].includes(m.kind) && m.snippet.length <= 602),
        '2 素材形状统一（kind 白名单 + snippet ≤ ±300 截窗上限）');
    }
    // 上限 30：dedupeMaterials 直灌 40 条候选 → 30
    ok(MATERIAL_CAP === 30 && dedupeMaterials(Array.from({ length: 40 }, (_, i) => ({ kind: 'hot', title: `素材上限压测${i}` }))).length === 30,
      `2 总量上限 ${MATERIAL_CAP}（40 候选 → 30）`);

    // ── 3. 正文检索性能：200 篇 × ~50K 字缓存（10MB 级），gather <300ms + 限集证明 ──
    {
      const perfFeed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '性能压测源', feedURL: 'https://f9.test/perf.xml' });
      const chunk = '压测正文填充句子，讲述无关内容以撑起体积。'.repeat(1200); // ~25K 字
      const bulk = [];
      for (let i = 0; i < 200; i++) {
        bulk.push(mkEntry(perfFeed, { title: `压测文章第${i}篇`, summary: '压测摘要' }));
      }
      const ids = store._applyParsedEntries(perfFeed, bulk); // 返回真实 entryID（local:<feed>:<digest>）
      for (let i = 0; i < ids.length; i++) {
        store.cachesRepo.saveCache({ entryID: ids[i], text: `${chunk}（第${i}篇结尾）${chunk}` }); // ~50K 字/篇 ≈ 10MB 总量
      }
      await store.rag.gatherRAG(QUESTION); // 预热（首次 FTS 查询含页缓存装载）
      store.rag.counters.bodyWindows = 0;
      const t0 = Date.now();
      const gp = await store.rag.gatherRAG(QUESTION);
      const ms = Date.now() - t0;
      ok(ms < 300 && gp.materials.length > 0, `3 gather 耗时 ${ms}ms（<300ms，200 篇 × 10MB 级正文缓存在场）`);
      // EXPLAIN QUERY PLAN：正文缓存查询走主键限集，绝不全表 SCAN
      const { sql, params } = bodyCacheQuery(ids.slice(0, 12), ['量子计算']);
      const plan = JSON.stringify(store.database.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params));
      ok(plan.includes('SEARCH article_caches') && !plan.includes('SCAN article_caches'),
        '3 EXPLAIN 证明正文缓存查询按 entryID 限集（SEARCH 主键，无 SCAN 全表）');
      ok(store.rag.counters.bodyWindows > 0 && store.rag.counters.bodyWindows <= 6,
        `3 单次 gather 正文截窗受 6 段上限约束（本次=${store.rag.counters.bodyWindows}）`);
    }

    // ── mock LLM 基建（4-7、10 用）──
    const origComplete = store.llm.complete.bind(store.llm);
    const origReady = store._requireAIReady.bind(store);
    const calls = []; // { prompt, system, onDelta, signal }
    let llmCallCount = 0;
    let streamGate = null; // { promise, resolve } 挂起流式用
    let chunksOfRound = [];
    store.llm.complete = async ({ prompt, system, onDelta, signal }) => {
      llmCallCount += 1;
      calls.push({ prompt, system, onDelta, signal });
      for (const chunk of chunksOfRound) {
        if (signal && signal.aborted) throw new Error('cancelled');
        if (onDelta) await onDelta(chunk);
        await sleep(12);
      }
      if (signal && signal.aborted) throw new Error('cancelled');
      if (streamGate) await streamGate.promise;
      if (signal && signal.aborted) throw new Error('cancelled');
      return chunksOfRound.join('');
    };
    store._requireAIReady = () => ({ config: {}, apiKey: 'mock-key' });

    const ANSWER_1 = [
      '根据全库素材回答：',
      '- 纠错是当前主线 [1]。',
      '- 硬件规模持续扩张 [2]。',
      '素材中未找到的部分：商业落地时间表。',
    ].join('\n');

    // ── 4. ask 流式：分片推送 / 落库 / sources_json / 引用编号约束 ──
    calls.length = 0;
    const deltas = [];
    chunksOfRound = ANSWER_1.match(/[\s\S]{1,30}/g) || [];
    const res1 = await store.rag.ask(null, QUESTION, { onDelta: (d) => deltas.push(d) });
    ok(deltas.length === chunksOfRound.length && deltas.join('') === ANSWER_1,
      `4 onDelta 依次收到分片（片=${deltas.length}，拼接一致）`);
    ok(!!res1.sessionID && res1.content === ANSWER_1 && res1.cancelled === false, '4 ask 返回会话与完整回答');
    {
      const rows = store.database.prepare(
        'SELECT role, content, sources_json FROM rag_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC'
      ).all(res1.sessionID);
      ok(rows.length === 2 && rows[0].role === 'user' && rows[0].content === QUESTION && rows[1].role === 'assistant',
        '4 user + assistant 消息成对落库');
      ok(rows[1].content === ANSWER_1, '4 assistant 内容完整落库');
      const sources = JSON.parse(rows[1].sources_json);
      ok(sources.length === res1.materials.length && sources[0].title === res1.materials[0].title,
        `4 sources_json 与素材一致（${sources.length} 条）`);
      ok(calls[0].prompt.includes('只允许 [1]-[' + res1.materials.length + ']'),
        `4 引用编号约束进 prompt（只允许 [1]-[${res1.materials.length}]）`);
      ok(calls[0].prompt.includes(QUESTION) && calls[0].prompt.includes('量子计算综述'),
        '4 prompt 含问题与素材标题');
      ok(calls[0].prompt.includes('素材中未找到') && calls[0].prompt.includes('禁止编造'),
        '4 「素材中未找到」约束与反编造约束进 prompt');
    }

    // ── 5. 多轮：同 session 二问含首轮 Q/A；新 session 不含 ──
    {
      calls.length = 0;
      chunksOfRound = ['延续上一轮：纠错的工程含义如下。'];
      const res2 = await store.rag.ask(res1.sessionID, '纠错对工程意味着什么？');
      const p2 = calls[0].prompt;
      ok(p2.includes(QUESTION) && p2.includes('纠错是当前主线'),
        '5 同会话二问上下文含首轮 Q/A');
      ok(p2.includes('纠错对工程意味着什么'), '5 prompt 含本轮问题');
      calls.length = 0;
      chunksOfRound = ['新会话首答。'];
      const res3 = await store.rag.ask(null, '另一个话题的问题');
      ok(!calls[0].prompt.includes(QUESTION) && !calls[0].prompt.includes('纠错是当前主线'),
        '5 新 session 不含首轮 Q/A（会话隔离）');
      ok(!!res2.sessionID && !!res3.sessionID && res2.sessionID === res1.sessionID && res3.sessionID !== res1.sessionID,
        '5 会话归属正确（同会话复用 / 新会话新建）');
    }

    // ── 6. 无 Key：明确报错 + 纯检索不调 LLM ──
    {
      store._requireAIReady = origReady; // 临时目录无 Key
      const before = llmCallCount;
      let err = null;
      await store.rag.ask(null, '无 Key 也要能检索').catch((e) => { err = e; });
      ok(err !== null && String(err.message || '').includes('API Key'), `6 无 Key 抛明确错误（${err && err.message}）`);
      ok(llmCallCount === before, '6 无 Key 路不调 LLM');
      ok(store.rag.snapshot().running === false, '6 失败后锁不悬挂');
      const gNk = await store.rag.gatherRAG('量子计算');
      ok(gNk.materials.length >= 1, `6 纯检索模式返回素材列表（${gNk.materials.length} 条，不依赖 AI）`);
      // 无 Key 的 ask 不落任何消息
      const orphan = store.database.prepare('SELECT COUNT(*) AS n FROM rag_messages WHERE content LIKE ?').get('%无 Key 也要能检索%').n;
      ok(orphan === 0, '6 无 Key 失败不落消息');
      store._requireAIReady = () => ({ config: {}, apiKey: 'mock-key' }); // 装回 mock（7 用）
    }

    // ── 7. 单飞锁 + 取消保留已流部分 ──
    {
      let gateResolve = null;
      streamGate = { promise: new Promise((r) => { gateResolve = r; }) };
      chunksOfRound = ['取消前已生成的部分', '，这句不该完整。'];
      const p1 = store.rag.ask(null, '取消测试问题', {});
      await sleep(80); // 两个分片都已推送，挂在 gate 上
      ok(store.rag.cancelActive() === true, '7 cancelActive 命中在途问答');
      let secondErr = null;
      await store.rag.ask(null, '并发第二问', {}).catch((e) => { secondErr = e; return null; });
      ok(String(secondErr?.message || '').includes('已有一个问答正在进行'), '7 并发第二个问答被拒（全会话单飞锁）');
      gateResolve();
      const r1 = await p1;
      ok(r1.cancelled === true && r1.content === '取消前已生成的部分，这句不该完整。',
        '7 取消返回 cancelled + 已流部分');
      const row = store.database.prepare('SELECT content FROM rag_messages WHERE id = ?').get(r1.messageID);
      ok(row && row.content === '取消前已生成的部分，这句不该完整。', '7 已流部分照存 assistant 消息（未完成语义）');
      ok(store.rag.snapshot().running === false, '7 取消后锁释放');
      streamGate = null;
      chunksOfRound = ['恢复后的正常回答。'];
      const r2 = await store.rag.ask(r1.sessionID, '同一会话再问一次');
      ok(r2 && !r2.cancelled && r2.sessionID === r1.sessionID, '7 取消后同会话可继续提问');
    }

    // ── 8. 会话列表 / 重开 / 删除（级联）/ 重命名 ──
    {
      const list = store.rag.listSessions();
      ok(list.length >= 3 && list.every((s) => s.id && typeof s.title === 'string' && typeof s.updatedAt === 'number'),
        `8 会话列表（${list.length} 条，字段齐全）`);
      ok(list[0].updatedAt >= list[list.length - 1].updatedAt, '8 列表按更新时间倒序');
      const victim = list.find((s) => s.title === '另一个话题的问题');
      ok(!!victim, '8 新会话标题=首问前 40 字');
      const opened = store.rag.session(victim.id);
      ok(opened && opened.messages.length === 2 && opened.messages[0].role === 'user' && opened.messages[1].role === 'assistant',
        '8 重开取回消息流');
      ok(opened.messages[1].sources.length === JSON.parse(store.database.prepare('SELECT sources_json FROM rag_messages WHERE id = ?').get(opened.messages[1].id).sources_json).length,
        '8 assistant 消息 sources 解包一致');
      const renamed = store.rag.renameSession(victim.id, '重命名后的会话');
      ok(renamed.title === '重命名后的会话', '8 重命名生效');
      const msgCount = store.database.prepare('SELECT COUNT(*) AS n FROM rag_messages WHERE session_id = ?').get(victim.id).n;
      ok(store.rag.deleteSession(victim.id) === true
        && store.rag.session(victim.id) === null
        && store.database.prepare('SELECT COUNT(*) AS n FROM rag_messages WHERE session_id = ?').get(victim.id).n === 0,
        `8 删除级联 messages（删前消息=${msgCount}，删后=0）`);
      // rag:sources 通路
      const anyAssistant = store.database.prepare("SELECT id FROM rag_messages WHERE role = 'assistant' LIMIT 1").get();
      ok(Array.isArray(store.rag.sources(anyAssistant.id)) && store.rag.sources(anyAssistant.id).length > 0,
        '8 sources(messageID) 取回素材 JSON');
    }

    // ── 9/10. UI（真 IPC + 隐藏窗口）+ 回归 ──
    await ragUIProbe(store, origComplete, origReady);

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});

/** ── 9/10. UI 冒烟（真 IPC + 隐藏窗口；取消链路用受控 gate 两段驱动）── */
async function ragUIProbe(store, origComplete, origReady) {
  const { BrowserWindow } = require('electron');
  const { registerIPCHandlers } = require('../src/main/ipc');
  const CANCEL_Q = '取消链路测试问题';
  let uiGate = null;
  store.llm.complete = async ({ prompt, onDelta, signal }) => {
    if (prompt.includes(CANCEL_Q)) {
      if (onDelta) await onDelta('取消前已流的部分 [1]。');
      if (uiGate) await uiGate.promise;
      if (signal && signal.aborted) throw new Error('cancelled');
      return '取消前已流的部分 [1]。';
    }
    const chunks = ['根据全库素材回答：量子计算进展如下 [1][2]。\n- **纠错主线** [1]。\n- **硬件扩张** [2]。\n'];
    for (const c of chunks) { if (signal && signal.aborted) throw new Error('cancelled'); if (onDelta) await onDelta(c); }
    return chunks.join('');
  };
  store._requireAIReady = () => ({ config: {}, apiKey: 'mock-ui' });
  store.rag._aihotItemsImpl = async () => ([]);

  const win = new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
  });
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(900);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 8000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); }
    };
    try {
      const { KnowledgeCenter } = await import('./views/knowledge.js');
      let openedEntry = null; let openedURL = null;
      window.__f9kc = new KnowledgeCenter({
        onOpenArticle: (id) => { openedEntry = id; },
        onOpenURL: (u) => { openedURL = u; },
      });
      window.__f9kc.present('ask');
      const tabOn = Boolean(document.querySelector('.modal-overlay .modal'));
      const tabs = [...document.querySelectorAll('.modal-nav-item')].map((n) => n.textContent);
      const hasTab = tabs.some((x) => x.includes('全库问答'));
      const input = await waitFor(() => document.querySelector('.nj-rag-input'));
      // 布局断言在 _load 完成后取（present → 异步 load → _renderAsk）
      const sideOn = Boolean(document.querySelector('.nj-rag-side'));
      const newBtnOn = Boolean(document.querySelector('.nj-rag-new'));
      const bridgeOn = typeof window.robin.ragAsk === 'function' && typeof window.robin.onRagDelta === 'function';
      const goBtn = document.querySelector('.nj-rag-go');
      const cancelBtn = document.querySelector('.nj-rag-cancel');
      const cancelHiddenInitially = cancelBtn && cancelBtn.style.display === 'none';
      const emptyHintOn = Boolean(document.querySelector('.nj-rag-empty'));
      if (!input || !goBtn) return { __err: 'input/goBtn missing' };
      // 提问（真 IPC 全链路：gather → 流式 → 落库 → 重开素材还原）
      input.value = '量子计算';
      goBtn.click();
      const userBubble = await waitFor(() => document.querySelector('.nj-rag-msg.user'));
      const assistantBubble = await waitFor(() => document.querySelector('.nj-rag-msg.assistant'));
      const answered = await waitFor(() => {
        const b = document.querySelector('.nj-rag-msg.assistant');
        return b && b.textContent.includes('量子计算进展如下') ? true : null;
      });
      const chips = assistantBubble ? assistantBubble.querySelectorAll('.dg-ref') : [];
      const chipsN = chips.length;
      const cancelHiddenAfter = cancelBtn && cancelBtn.style.display === 'none';
      // 引用芯片 → 素材浮层 → 打开原文
      let popoverOn = false; let openBtnOn = false;
      if (chipsN > 0) {
        chips[0].click();
        const pop = await waitFor(() => document.querySelector('.nj-research-pop'));
        popoverOn = Boolean(pop);
        const openBtn = pop && [...pop.querySelectorAll('button')].find((b) => b.textContent.includes('打开原文'));
        if (openBtn) { openBtnOn = true; openBtn.click(); }
      }
      const entryOpened = await waitFor(() => (openedEntry ? true : null), 3000) || false;
      document.querySelectorAll('.nj-research-pop').forEach((n) => n.remove());
      // 会话侧栏出现新会话行（标题=首问前 40 字）→ 点行重开
      const sessionRow = await waitFor(() => document.querySelector('.nj-rag-session'));
      let reopenOn = false;
      if (sessionRow) {
        sessionRow.click();
        await sleep(300);
        reopenOn = document.querySelectorAll('.nj-rag-msg.assistant').length >= 1
          && document.querySelectorAll('.nj-rag-msg.user').length >= 1;
      }
      const titleEl = sessionRow && sessionRow.querySelector('.nj-rag-session-title');
      const autoTitleOn = Boolean(titleEl && titleEl.textContent.includes('量子计算'));
      return {
        tabOn, hasTab, sideOn, newBtnOn, bridgeOn, emptyHintOn, cancelHiddenInitially,
        userOn: Boolean(userBubble), assistantOn: Boolean(assistantBubble), answered: Boolean(answered),
        chipsN, popoverOn, openBtnOn, entryOpened,
        sessionOn: Boolean(sessionRow), reopenOn, autoTitleOn,
        cancelHiddenAfter,
      };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (result.__err) { ok(false, '9 UI 探针异常 — ' + result.__err); }
  else {
    ok(result.tabOn && result.hasTab, `9 知识中心「全库问答」tab 存在（tabs 命中=${result.hasTab}）`);
    ok(result.sideOn && result.newBtnOn && result.emptyHintOn, '9 会话侧栏（新建按钮 + 空态提示）');
    ok(result.bridgeOn, '9 preload 暴露 ragAsk / onRagDelta 桥');
    ok(result.userOn && result.answered, '9 消息流气泡（user + assistant 流式追加完成）');
    ok(result.chipsN >= 1, `9 [n] 引用编号渲染为芯片（chips=${result.chipsN}）`);
    ok(result.popoverOn && result.openBtnOn, '9 芯片点击弹素材浮层 + 打开原文按钮');
    ok(result.entryOpened, '9 本库素材「打开原文」回调 onOpenArticle');
    ok(result.sessionOn && result.autoTitleOn && result.reopenOn,
      `9 会话侧栏出现新会话（标题=首问前 40 字=${result.autoTitleOn}）+ 点行重开`);
    ok(result.cancelHiddenInitially && result.cancelHiddenAfter, '9 取消按钮待机/结束后隐藏');
  }

  // 9b. 取消链路（两段驱动：页面点取消 → Node 放行 gate → 页面等保留提示）
  {
    let gateResolve = null;
    uiGate = { promise: new Promise((r) => { gateResolve = r; }) };
    const phaseA = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, ms = 8000) => {
        const t0 = Date.now();
        for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); }
      };
      const input = document.querySelector('.nj-rag-input');
      const goBtn = document.querySelector('.nj-rag-go');
      if (!input || !goBtn) return { __err: 'input missing in phaseA' };
      input.value = ${JSON.stringify(CANCEL_Q)};
      const dbgSync = {
        cancel: (document.querySelector('.nj-rag-cancel') || {}).style ? document.querySelector('.nj-rag-cancel').style.display : 'NOEL',
        status: (document.querySelector('.nj-rag-status') || {}).style ? document.querySelector('.nj-rag-status').style.display : 'NOEL',
        overlays: document.querySelectorAll('.modal-overlay').length,
        statusKids: document.querySelector('.nj-rag-status') ? [...document.querySelector('.nj-rag-status').children].map((c) => c.className).join('|') : 'NOSTATUS',
        statusHTML: document.querySelector('.nj-rag-status') ? document.querySelector('.nj-rag-status').outerHTML.slice(0, 300) : 'NOSTATUS',
        goCount: document.querySelectorAll('.nj-rag-go').length,
      };
      goBtn.click();
      const dbgSync2 = {
        cancel: (document.querySelector('.nj-rag-cancel') || {}).style ? document.querySelector('.nj-rag-cancel').style.display : 'NOEL',
        userBubbles: document.querySelectorAll('.nj-rag-msg.user').length,
        assistantBubbles: document.querySelectorAll('.nj-rag-msg.assistant').length,
      };
      await sleep(500);
      const dbgLate = {
        cancel: (document.querySelector('.nj-rag-cancel') || {}).style ? document.querySelector('.nj-rag-cancel').style.display : 'NOEL',
        status: (document.querySelector('.nj-rag-status') || {}).style ? document.querySelector('.nj-rag-status').style.display : 'NOEL',
        userBubbles: document.querySelectorAll('.nj-rag-msg.user').length,
        errText: (document.querySelector('.nj-rag-msg-error') || {}).textContent ? document.querySelector('.nj-rag-msg-error').textContent.slice(0, 60) : '',
      };
      const shown = dbgLate.cancel !== 'none' && dbgLate.cancel !== 'NOEL';
      let clicked = false;
      if (shown) { document.querySelector('.nj-rag-cancel').click(); clicked = true; }
      const partial = await waitFor(() => {
        const b = document.querySelector('.nj-rag-msg.assistant:last-child');
        return b && b.textContent.includes('取消前已流的部分') ? true : null;
      }, 3000);
      return { shown: Boolean(shown), clicked, partialOn: Boolean(partial), dbgSync, dbgSync2, dbgLate };
    })()`);
    if (phaseA.__err) ok(false, '9 取消链路 phaseA 异常 — ' + phaseA.__err);
    else ok(phaseA.shown && phaseA.clicked && phaseA.partialOn,
      `9 取消按钮运行可见 + 已流部分实时上屏（shown=${phaseA.shown}，clicked=${phaseA.clicked}，partial=${phaseA.partialOn}，dbg=${JSON.stringify({ s1: phaseA.dbgSync, s2: phaseA.dbgSync2, late: phaseA.dbgLate })}）`);
    await sleep(120);
    gateResolve(); // 页面已点取消 → 放行 mock，主进程按 aborted 收尾
    const phaseB = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, ms = 8000) => {
        const t0 = Date.now();
        for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); }
      };
      const noteOn = await waitFor(() => document.querySelector('.nj-rag-cancel-note') ? true : null);
      const hiddenAgain = await waitFor(() => {
        const c = document.querySelector('.nj-rag-cancel');
        return c && c.style.display === 'none' ? true : null;
      });
      const keep = document.querySelector('.nj-rag-msg.assistant:last-child');
      return { noteOn: Boolean(noteOn), hiddenAgain: Boolean(hiddenAgain),
        keepOn: Boolean(keep && keep.textContent.includes('取消前已流的部分')) };
    })()`);
    ok(phaseB.noteOn && phaseB.hiddenAgain && phaseB.keepOn,
      '9 取消后已流部分保留在气泡 + 取消提示 + 按钮复位');
    // 新会话按钮：清空消息流回空态
    const newSession = await win.webContents.executeJavaScript(`(async () => {
      const btn = document.querySelector('.nj-rag-new');
      if (!btn) return { on: false };
      btn.click();
      await new Promise((r) => setTimeout(r, 200));
      return { on: Boolean(document.querySelector('.nj-rag-empty')) };
    })()`);
    ok(newSession.on, '9 新建会话按钮清空消息流回空态');
  }

  // 10. 回归：旧「问知识库」入口不破坏（主进程 knowledgeAsk 直调 + IPC/preload 锚点）
  {
    const kbAns = await store.knowledgeAsk('量子计算', {});
    ok(kbAns && typeof kbAns.content === 'string' && Array.isArray(kbAns.refs) && kbAns.refs.length >= 1,
      '10 旧 kb:ask（knowledgeAsk）仍可用（高亮材料 + 引用表）');
    const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8');
    const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
    ok(ipcSrc.includes("handle('kb:ask'") && preloadSrc.includes('kbAsk:'), '10 kb:ask IPC/preload 锚点保留');
  }
  // 10b. tab 切换清理 rag 流式订阅（_cleanupSession 扩展）
  {
    const switched = await win.webContents.executeJavaScript(`(async () => {
      const kc = window.__f9kc;
      if (!kc) return { __err: 'kc missing' };
      kc._rag.unsubscribe = () => {}; // 模拟在途订阅
      kc.tab = 'dashboard';
      kc._render();
      return { unsub: kc._rag.unsubscribe === null, notRunning: kc._rag.running === false };
    })()`);
    if (switched.__err) ok(false, '10 tab 切换清理探针异常 — ' + switched.__err);
    else ok(switched.unsub && switched.notRunning, '10 knowledge tab 切换清理 rag 流式订阅');
  }

  win.destroy();
}
