'use strict';
/**
 * diag-f8-research.js — F8 AI 深度研究端到端探针（run-all OFFLINE 集，全程离线）
 *
 * LLM 走受控 fake 流（store.llm.complete 替换），AIHOT 路注入。覆盖（对应 F8 验收 12 条）：
 *  1 v17 迁移：research_reports 表 + 幂等重放 + 老库升级无损
 *  2 gather：本地路命中（预灌 5 篇）、FTS 相关度排序（标题命中排正文命中前）、
 *    AIHOT 路注入、标题归一去重、总量上限 40、素材形状（snippet≤300/lane）
 *  3 AIHOT 失败降级（注入抛错 → 本地路照常出素材）
 *  4 报告生成：mock 流式 onDelta 依次收到分片、report_md 完整落库、sources_json 与素材一致
 *  5 引用编号约束：素材 3 条时提示词含「只允许 [1]-[3]」（mock 捕获 prompt）
 *  6 取消：生成中 abort → 已收到部分保留 + 未完成标记；再次生成覆盖
 *  7 追问：mock 第二轮 → 问答对追加进 report_md 的「### 追问」区段；上下文含原报告
 *  8 历史列表 / 重开 / 删除
 *  9 单飞锁：并发两次 generate，第二次被拒
 * 10 无 Key 降级：_requireAIReady 抛错 → 明确错误不崩
 * 11/12 UI：知识中心「AI 研究」tab、命令面板入口、引用芯片渲染、追问、无 Key 仍可达
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f8-research-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();

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
    const { MATERIAL_CAP } = require('../src/main/ResearchService');

    // ── 1. v17 迁移 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v17-research-reports'").get(),
      '1 v17-research-reports 迁移已入链');
    ok(!!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_reports'").get()
      && !!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_research_reports_updated'").get(),
      '1 research_reports 表 + 索引存在');
    {
      const v17 = MIGRATIONS.find((m) => m.id === 'v17-research-reports');
      try { v17.up(store.database); ok(true, '1 v17 up() 重放幂等'); }
      catch (e) { ok(false, '1 v17 up() 重放幂等 — ' + e.message); }
    }
    // 老库升级无损：清掉 v17 记账 + DROP 表（模拟 v16 老库），重跑迁移链 → 表重建、其余数据原样
    {
      const feedOld = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '升级前已有源', feedURL: 'https://f8.test/old.xml' });
      store._applyParsedEntries(feedOld, [{
        id: 'f8-old-1', title: '升级前已有文章', url: 'https://f8.test/old/1',
        publishedAt: Math.floor(Date.now() / 1000) - 3600, summary: '老库数据', contentHTML: null,
      }]);
      const db = store.database;
      db.exec('DROP TABLE research_reports');
      db.prepare("DELETE FROM schema_migrations WHERE id = 'v17-research-reports'").run();
      runMigrations(db);
      const tableBack = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_reports'").get();
      const articlesKept = db.prepare("SELECT COUNT(*) AS n FROM articles WHERE title = '升级前已有文章'").get().n;
      const feedsKept = db.prepare("SELECT 1 FROM feeds WHERE id = ?").get(feedOld.id);
      ok(tableBack && articlesKept === 1 && !!feedsKept,
        `1 老库升级无损（表重建=${tableBack}，文章保留=${articlesKept}，订阅保留=${!!feedsKept}）`);
      // 幂等：同一迁移链在新库上再跑一遍不炸不改账
      runMigrations(db);
      ok(!!db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v17-research-reports'").get(), '1 迁移链重放幂等');
    }

    // ── 场景灌文：5 篇相关 + 无关源 ──
    const feedA = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '量子周刊', feedURL: 'https://f8.test/a.xml' });
    const feedB = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '无关周刊', feedURL: 'https://f8.test/b.xml' });
    let seq = 0;
    const mkEntry = (feed, { title, summary = '', url = null }) => ({
      id: `f8-${feed.id}-${++seq}`,
      title, url: url || `https://f8.test/${feed.id}/${seq}`,
      publishedAt: Math.floor(Date.now() / 1000) - 600,
      summary, contentHTML: null,
    });
    store._applyParsedEntries(feedA, [
      mkEntry(feedA, { title: '量子计算综述：纠错的下一步', summary: '超导量子比特与表面码阈值' }),
      mkEntry(feedA, { title: '量子计算硬件进展：比特数破千', summary: '超导与离子阱路线对比' }),
      mkEntry(feedA, { title: '量子计算软件栈观察', summary: '编译器与纠错中间件' }),
      mkEntry(feedA, { title: '量子计算产业落地盘点', summary: '金融与制药场景' }),
      mkEntry(feedA, { title: '量子计算融资升温', summary: '三家初创公司新融资' }),
      mkEntry(feedA, { title: '完全无关的政治新闻' }),
    ]);
    store._applyParsedEntries(feedB, [
      mkEntry(feedB, { title: '量子计算也出现在无关源里', summary: '' }),
    ]);

    // ── 2. gather：本地路 + AIHOT 注入 + 去重 + 上限 + 形状 ──
    store.research._aihotItemsImpl = async (q) => ([
      { title: 'AIHOT：量子计算成为热点', summary: '热点摘要甲', source: 'AIHOT', originalURL: 'https://aihot.test/1', publishedAt: new Date().toISOString() },
      // 标题归一去重样例：与本地第一条同题（大小写 + 空白差异）
      { title: '量子计算综述：  纠错的下一步', summary: 'AIHOT 同题报道', source: 'AIHOT', originalURL: 'https://aihot.test/2' },
    ]);
    const g1 = await store.research.gather('量子计算');
    ok(g1.materials.length >= 5, `2 本地路命中（素材=${g1.materials.length}，预灌相关 5 篇 + 无关源 1 篇 + AIHOT 2 条去重后）`);
    ok(g1.materials.every((m) => ['local', 'knowledge', 'aihot'].includes(m.lane) && typeof m.snippet === 'string' && m.snippet.length <= 300),
      '2 素材形状统一（lane 白名单 + snippet ≤300）');
    ok(g1.materials.some((m) => m.lane === 'aihot'), '2 AIHOT 路注入命中');
    const dupKeys = new Set(g1.materials.map((m) => m.title.toLowerCase().replace(/\s+/g, '')));
    ok(dupKeys.size === g1.materials.length, `2 标题归一去重（归一键 ${dupKeys.size} = 素材 ${g1.materials.length}）`);
    // FTS 相关度排序：标题命中行排前（标题列权重 8x），正文高频重复行排最后
    store._applyParsedEntries(feedA, [
      mkEntry(feedA, { title: '本周科技速览第九十期', summary: '本期头条：量子计算在纠错路线上又进一步，正文提到量子计算多次，量子计算量子计算' }),
    ]);
    const gRank = await store.research.gather('量子计算');
    const rankTitles = gRank.materials.filter((m) => m.lane === 'local').map((m) => m.title);
    ok(rankTitles[0] !== '本周科技速览第九十期'
      && rankTitles[rankTitles.length - 1] === '本周科技速览第九十期',
      `2 FTS 相关度排序（首条=${rankTitles[0]}，正文高频行垫底=${rankTitles[rankTitles.length - 1] === '本周科技速览第九十期'}）`);
    // 总量上限 40：灌 45 篇相关 → materials ≤ 40
    {
      const bulk = [];
      for (let i = 0; i < 45; i++) bulk.push(mkEntry(feedA, { title: `量子计算上限压测第${i}篇` }));
      store._applyParsedEntries(feedA, bulk);
      const gCap = await store.research.gather('量子计算');
      ok(gCap.materials.length <= MATERIAL_CAP, `2 总量上限 ${MATERIAL_CAP}（实际=${gCap.materials.length}）`);
    }

    // ── 3. AIHOT 失败降级 ──
    store.research._aihotItemsImpl = async () => { throw new Error('mock aihot down'); };
    const g2 = await store.research.gather('量子计算');
    ok(g2.materials.length >= 5 && g2.materials.every((m) => m.lane !== 'aihot'),
      `3 AIHOT 失败降级（素材=${g2.materials.length}，全本地）`);
    ok(store.research.snapshot().aihotFailures >= 1, '3 降级被计数（aihotFailures）');

    // ── mock LLM 基建（4-9 用）──
    const origComplete = store.llm.complete.bind(store.llm);
    const origReady = store._requireAIReady.bind(store);
    const calls = []; // { prompt, system, onDelta, signal }
    let streamGate = null; // { promise, resolve } 挂起流式用
    let chunksOfRound = [];
    store.llm.complete = async ({ prompt, system, onDelta, signal }) => {
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

    const REPORT_MD = [
      '## 背景',
      '量子计算正从实验室走向工程化 [1]。',
      '## 核心发现',
      '- **纠错突破**：表面码阈值显著提升 [2]。',
      '- **硬件规模**：物理比特数破千 [1][3]。',
      '## 分歧与争议',
      '超导与离子阱路线之争仍在继续 [2][3]。',
      '## 结论',
      '工程化仍处早期 [3]。',
      '## 延伸阅读',
      '- 推荐 [2]：综述最全。',
    ].join('\n');

    // ── 4. 报告生成：流式分片 + 落库 + 素材一致 ──
    store.research._aihotItemsImpl = async () => ([]); // 恢复为安静的注入（后续用例不受 aihot down 影响）
    const deltas = [];
    chunksOfRound = REPORT_MD.match(/[\s\S]{1,40}/g) || [];
    const gen1 = await store.research.generate('量子计算', { onDelta: (d) => deltas.push(d) });
    ok(!gen1.cancelled && gen1.report.isComplete, '4 生成完成（isComplete）');
    ok(deltas.length === chunksOfRound.length && deltas.join('') === REPORT_MD,
      `4 onDelta 依次收到分片（片=${deltas.length}，拼接一致）`);
    ok(gen1.report.reportMd === REPORT_MD, '4 report_md 完整落库');
    {
      const g = await store.research.gather('量子计算');
      const row = store.database.prepare('SELECT sources_json FROM research_reports WHERE id = ?').get(gen1.report.id);
      const sources = JSON.parse(row.sources_json);
      ok(sources.length === g.materials.length && sources[0].title === g.materials[0].title,
        `4 sources_json 与素材一致（${sources.length} 条）`);
    }

    // ── 5. 引用编号约束：3 条素材 → 「只允许 [1]-[3]」 ──
    {
      const feedC = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '纠错专刊', feedURL: 'https://f8.test/c.xml' });
      store._applyParsedEntries(feedC, [
        mkEntry(feedC, { title: '量子纠错码新方案', summary: '表面码变体' }),
        mkEntry(feedC, { title: '量子纠错阈值实验', summary: '逻辑量子比特' }),
        mkEntry(feedC, { title: '量子纠错路线图', summary: '未来五年' }),
      ]);
      calls.length = 0;
      chunksOfRound = ['## 背景\n简短报告 [1]。'];
      await store.research.generate('量子纠错', {});
      ok(calls.length === 1 && calls[0].prompt.includes('只允许 [1]-[3]'),
        '5 素材 3 条时提示词含「只允许 [1]-[3]」');
      ok(calls[0].prompt.includes('## 核心发现') && calls[0].prompt.includes('## 分歧与争议'),
        '5 提示词含结构化 Markdown 要求');
    }

    // ── 6. 取消：部分保留 + 未完成标记；再次生成覆盖 ──
    {
      let gateResolve = null;
      streamGate = { promise: new Promise((r) => { gateResolve = r; }) };
      chunksOfRound = ['## 背景\n取消前已生成的部分', '，这句不该完整。'];
      const p = store.research.generate('取消测试主题', {});
      await sleep(80); // 两个分片都已推送，挂在 gate 上
      ok(store.research.cancelActive() === true, '6 cancelActive 命中在途研究');
      gateResolve();
      const res = await p;
      ok(res.cancelled === true && res.report.isComplete === false, '6 取消返回草稿（cancelled + 未完成标记）');
      ok(res.report.reportMd === '## 背景\n取消前已生成的部分，这句不该完整。',
        `6 已收到部分保留（md=${JSON.stringify(res.report.reportMd.slice(0, 30))}…）`);
      // 锁已释放 + 再次生成覆盖同主题草稿
      streamGate = null;
      chunksOfRound = ['## 背景\n重新生成后的完整报告 [1]。'];
      const res2 = await store.research.generate('取消测试主题', {});
      ok(res2.cancelled === false && res2.report.isComplete === true, '6 再次生成成功');
      const drafts = store.database.prepare("SELECT COUNT(*) AS n FROM research_reports WHERE topic = '取消测试主题' AND is_complete = 0").get().n;
      const dones = store.database.prepare("SELECT COUNT(*) AS n FROM research_reports WHERE topic = '取消测试主题' AND is_complete = 1").get().n;
      ok(drafts === 0 && dones === 1, `6 同主题旧草稿被覆盖（草稿=${drafts}，完整=${dones}）`);
    }

    // ── 7. 追问：上下文含原报告 + 「### 追问」区段追加 ──
    {
      calls.length = 0;
      chunksOfRound = ['基于报告第 2 条发现展开：纠错的工程含义如下。'];
      const res = await store.research.followUp(gen1.report.id, '纠错突破对工程意味着什么？', {});
      ok(!res.cancelled, '7 追问完成');
      const prompt = calls[0]?.prompt || '';
      ok(prompt.includes('## 核心发现') && prompt.includes('纠错突破'), '7 上下文含原报告');
      ok(prompt.includes('量子纠错') === false && prompt.includes('纠错突破对工程意味着什么'), '7 上下文含追问');
      ok(res.report.reportMd.includes('### 追问') && res.report.reportMd.includes('**问：纠错突破对工程意味着什么？**')
        && res.report.reportMd.includes('纠错的工程含义'),
        '7 问答对追加进「### 追问」区段');
      const row = store.database.prepare('SELECT report_md FROM research_reports WHERE id = ?').get(gen1.report.id);
      ok(row.report_md === res.report.reportMd, '7 追问后 report_md 落库一致');
    }

    // ── 8. 历史列表 / 重开 / 删除 ──
    {
      const list = store.research.listReports();
      ok(list.length >= 3 && list.every((r) => r.id && r.topic && typeof r.sourceCount === 'number' && typeof r.updatedAt === 'number'),
        `8 历史列表（${list.length} 条，字段齐全）`);
      ok(list[0].updatedAt >= list[list.length - 1].updatedAt, '8 列表按更新时间倒序');
      const reopened = store.research.report(list[0].id);
      ok(reopened && typeof reopened.reportMd === 'string' && Array.isArray(reopened.sources), '8 重开取回完整报告');
      const victim = list.find((r) => r.topic === '量子纠错');
      const del = store.research.deleteReport(victim.id);
      ok(del === true && store.research.report(victim.id) === null
        && !store.research.listReports().some((r) => r.id === victim.id), '8 删除生效');
    }

    // ── 9. 单飞锁 ──
    {
      let gateResolve = null;
      streamGate = { promise: new Promise((r) => { gateResolve = r; }) };
      chunksOfRound = ['并发第一轮。'];
      const p1 = store.research.generate('单飞锁主题甲', {});
      await sleep(60);
      let secondErr = null;
      const p2 = await store.research.generate('单飞锁主题乙', {}).catch((e) => { secondErr = e; return null; });
      ok(p2 === null && String(secondErr?.message || '').includes('已有一项研究正在进行'), '9 并发第二个研究被拒');
      gateResolve();
      const r1 = await p1;
      ok(r1 && !r1.cancelled && store.research.snapshot().running === false, '9 完成后锁释放');
      streamGate = null;
      const p3 = await store.research.generate('单飞锁主题乙', {});
      ok(p3 && !p3.cancelled, '9 拒绝后可再次发起');
    }

    // ── 10. 无 Key 降级（恢复真实 _requireAIReady，临时目录无 Key）──
    {
      store.llm.complete = origComplete;
      store._requireAIReady = origReady;
      let err = null;
      await store.research.generate('无 Key 主题', {}).catch((e) => { err = e; });
      ok(err !== null && String(err.message || '').includes('API Key'), `10 无 Key 抛明确错误（${err && err.message}）`);
      ok(store.research.snapshot().running === false, '10 失败后锁不悬挂');
    }

    // ── 11/12. UI：知识中心 tab / 命令面板 / 引用芯片 / 追问 / 无 Key 可达 ──
    await researchUIProbe(store, origComplete, origReady);

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});

/** ── 11/12. UI 冒烟（真 IPC + 隐藏窗口）── */
async function researchUIProbe(store, origComplete, origReady) {
  const { BrowserWindow } = require('electron');
  const { registerIPCHandlers } = require('../src/main/ipc');
  // UI 生成链路需要 mock（UI 阶段临时装回；无 Key 用例在最后恢复原始）
  const callsUI = [];
  store.llm.complete = async ({ prompt, onDelta, signal }) => {
    callsUI.push({ prompt });
    const chunks = ['## 背景\n带引用的 UI 报告 [1][2]。\n## 核心发现\n- **发现甲** [1]。\n- **发现乙** [2]。\n'];
    for (const c of chunks) { if (signal && signal.aborted) throw new Error('cancelled'); if (onDelta) await onDelta(c); }
    return chunks.join('');
  };
  store._requireAIReady = () => ({ config: {}, apiKey: 'mock-ui' });

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
      const kc = new KnowledgeCenter({
        onOpenArticle: (id) => { openedEntry = id; },
        onOpenURL: (u) => { openedURL = u; },
      });
      kc.present('research');
      const tabOn = Boolean(document.querySelector('.modal-overlay .modal'));
      const tabs = [...document.querySelectorAll('.modal-nav-item')].map((n) => n.textContent);
      const hasTab = tabs.some((x) => x.includes('AI 研究'));
      const input = await waitFor(() => document.querySelector('.nj-research-input'));
      const goBtn = document.querySelector('.nj-research-go');
      const inputOn = Boolean(input && goBtn);
      // 生成（真 IPC 全链路；主题选预灌内容，保证 gather 出素材 → 引用芯片可渲染）
      input.value = '量子计算';
      goBtn.click();
      const report = await waitFor(() => document.querySelector('.nj-research-report'));
      const chips = report ? report.querySelectorAll('.dg-ref') : [];
      const chipsN = chips.length;
      // 引用芯片 → 素材浮层
      let popoverOn = false; let openBtnOn = false;
      if (chipsN > 0) {
        chips[0].click();
        const pop = await waitFor(() => document.querySelector('.nj-research-pop'));
        popoverOn = Boolean(pop);
        const openBtn = pop && [...pop.querySelectorAll('button')].find((b) => b.textContent.includes('打开原文'));
        if (openBtn) { openBtnOn = true; openBtn.click(); }
      }
      const entryOpened = await waitFor(() => (openedEntry ? true : null), 3000) || false;
      // 关掉可能残留的浮层
      document.querySelectorAll('.nj-research-pop').forEach((n) => n.remove());
      // 追问
      const followInput = document.querySelector('.nj-research-follow-input');
      const followBtn = document.querySelector('.nj-research-follow-btn');
      let followOn = false;
      if (followInput && followBtn) {
        followInput.value = '这条报告的结论依据是什么？';
        followBtn.click();
        followOn = await waitFor(() => {
          const body = document.querySelector('.nj-research-report');
          // renderMarkdown 把「### 追问」渲染成 h3，字面 ### 不在 textContent 里
          return body && body.textContent.includes('追问') && body.textContent.includes('这条报告的结论依据是什么') ? true : null;
        }) || false;
      }
      // 历史：返回列表 → 行点击重开
      const back = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('返回列表'));
      let historyOn = false; let reopenOn = false; let delBtnOn = false;
      if (back) {
        back.click();
        historyOn = await waitFor(() => document.querySelector('.nj-research-item') ? true : null) || false;
        if (historyOn) {
          delBtnOn = Boolean(document.querySelector('.nj-research-item .btn.icon-only'));
          document.querySelector('.nj-research-item').click();
          reopenOn = await waitFor(() => document.querySelector('.nj-research-report') ? true : null) || false;
        }
      }
      return { tabOn, hasTab, inputOn, reportOn: Boolean(report), chipsN, popoverOn, openBtnOn, entryOpened, followOn, historyOn, reopenOn, delBtnOn };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (result.__err) { ok(false, '11 UI 探针异常 — ' + result.__err); }
  else {
    ok(result.tabOn && result.hasTab, `11 知识中心「AI 研究」tab 存在（tabs 命中=${result.hasTab}）`);
    ok(result.inputOn && result.reportOn, `11 主题输入 + 生成走通（报告渲染=${result.reportOn}）`);
    ok(result.chipsN >= 2, `11 引用编号渲染为芯片（chips=${result.chipsN}）`);
    ok(result.popoverOn && result.openBtnOn, '11 芯片点击弹素材浮层 + 打开原文按钮');
    ok(result.entryOpened, '11 本库素材「打开原文」回调 onOpenArticle');
    ok(result.followOn, '12 追问流式落库并重渲染（### 追问 区段可见）');
    ok(result.historyOn && result.reopenOn && result.delBtnOn, `12 历史列表/重开/删除按钮（列表=${result.historyOn}，重开=${result.reopenOn}）`);
  }
  // 命令面板入口（源码锚点——渲染层沙箱没有 node:fs）
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  ok(appSrc.includes("t('AI 深度研究…')"), '11 命令面板「AI 深度研究…」已接线');
  ok(appSrc.includes("kc.present('research')"), '11 面板入口直达「AI 研究」标签页');

  // 12. 无 Key 时 UI 仍可达：输入框在、按钮点出降级提示
  store.llm.complete = origComplete;
  store._requireAIReady = origReady;
  const noKey = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 8000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); }
    };
    try {
      // 回到列表页（当前可能停在报告详情）
      const back = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('返回列表'));
      if (back) back.click();
      const input = await waitFor(() => document.querySelector('.nj-research-input'));
      const goBtn = document.querySelector('.nj-research-go');
      if (!input || !goBtn) return { reachable: false };
      input.value = '无 Key 也要给提示';
      goBtn.click();
      const err = await waitFor(() => {
        const n = document.querySelector('.nj-research-error');
        return n && n.style.display !== 'none' && n.textContent ? n.textContent : null;
      });
      const inputStillThere = Boolean(document.querySelector('.nj-research-input'));
      return { reachable: true, err, inputStillThere };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (noKey.__err) ok(false, '12 无 Key UI 探针异常 — ' + noKey.__err);
  else ok(noKey.reachable && noKey.inputStillThere && String(noKey.err || '').includes('API Key'),
    `12 无 Key：输入框在 + 降级提示（err=${String(noKey.err || '').slice(0, 40)}…）`);

  win.destroy();
}
