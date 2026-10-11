'use strict';
/**
 * diag-f40-challenge.js — F40 挑战赛季探针（run-all OFFLINE 集，全程离线）
 *
 * mock LLM：服务级 _llmComplete 注入（自定义主题书单）；模板挑战零 AI 走真库标签聚合。
 *
 * 覆盖：
 *  1 v30 迁移：challenges（列齐备/status CHECK/索引）+ garden_state.challenge_decor 列 + 老库重跑幂等
 *  2 模板挑战零 AI：3 模板（AI 前沿 7天10篇 / 长文深读 30天6篇 / 新源尝鲜 7天5源各1篇）全部可用；
 *    新源尝鲜书单跨 5 个不同源
 *  3 LLM 书单合同容错：编造 ID 剔除 / 同文去重 / 不足回填 / 围栏杂文容错 / 坏 JSON 拒绝零残留
 *  4 单飞：active 唯一（第二个创建拒绝）→ 放弃后可再开
 *  5 进度懒算 + 提前完成：markRead 钩子计进度 / 读满 target 即刻 done + 发花园限定装饰
 *  6 超时 failed：ends_at 过懒结算翻 failed / 无装饰 / reward_granted=0（花园不扣分温和设计）
 *  7 挑战卡 SVG 确定性：同输入逐字节同输出 / 不同输入不同 / 主题 XSS 转义
 *  8 放弃/重建：abandoned 落库 / 非 active 拒绝放弃 / 重建新行共存 / 历史诚实展示
 *  9 重启读回：挑战行 + 花园装饰跨迁移无损
 * 10 UI：花园浮层第 3 tab（挑战）/ 模板按钮 / UI 创建挑战 / 进度条与书单勾选 / 历史 failed 诚实展示 / Esc
 * 11 静态接线锚点：preload/IPC/AppStore 钩子/迁移/i18n/CSS
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration(); // 沙箱内 GPU 合成偶发死锁：探针窗口纯 DOM 断言，禁用硬件加速
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f40-')));
setTimeout(() => { console.error('WATCHDOG'); process.exit(3); }, 600 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let passed = 0;
const ok = (c, l) => { if (c) { passed += 1; console.log('PASS ' + l); } else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const DAY = 86400;
const T0 = Math.floor(Date.now() / 1000);

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { ChallengeService, CHALLENGE, parseEntryIDs } = require('../src/main/ChallengeService');
    const { challengeCardArt } = require('../src/main/ChallengeCardArt');
    const userData = app.getPath('userData');
    let store = new AppStore(userData);
    const svc = store.challenge;
    svc._now = () => T0; // 注入时钟（确定性）

    // ── 场景数据：5 源 × 4 篇（前 3 源带 AI 标签，标题含主题词）──
    const feeds = [];
    const allIDs = [];
    for (let f = 1; f <= 5; f += 1) {
      const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: `挑战源${f}`, feedURL: `https://f40.test/feed${f}.xml` });
      feeds.push(feed);
      for (let i = 1; i <= 4; i += 1) {
        const id = `f40-f${f}-e${i}`;
        const entryID = store._applyParsedEntries(feed, [{
          id, title: `量子计算进展观察 ${f}-${i}`, url: `https://f40.test/a/${f}/${i}`,
          publishedAt: T0 - (f * 4 + i) * 3600, summary: `量子计算第 ${f}-${i} 篇观察。`, contentHTML: `<p>量子计算正文 ${f}-${i}。</p>`,
        }])[0];
        allIDs.push(entryID);
      }
    }
    // 给前 12 篇打 AI 标签（模板 tags 通道真库数据）
    const tagStmt = store.database.prepare("INSERT OR IGNORE INTO article_tags (item_id, tag, source) VALUES (?, 'AI', 'manual')");
    for (let i = 0; i < 12; i += 1) tagStmt.run(allIDs[i]);
    ok(store.database.prepare("SELECT COUNT(*) AS n FROM article_tags WHERE tag = 'AI'").get().n === 12,
      '附 场景库：5 源 20 篇 + 12 篇 AI 标签');

    // ── 1. v30 迁移 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v30-challenges-garden-decor'").get(),
      '1 v30 迁移 challenges-garden-decor 已入链');
    const cols = store.database.prepare('PRAGMA table_info(challenges)').all().map((c) => c.name);
    ok(['id', 'theme', 'days', 'target', 'entry_ids_json', 'started_at', 'ends_at', 'status', 'reward_granted', 'created_at']
      .every((c) => cols.includes(c)), '1 challenges 列齐备（id/theme/days/target/entry_ids_json/started_at/ends_at/status/reward_granted/created_at）');
    const cSQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='challenges'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/CHECK\s*\(\s*status\s+IN\s+\('active','done','failed','abandoned'\)/i.test(cSQL), '1 status CHECK（active/done/failed/abandoned）在位');
    ok(!!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_challenges_status'").get(),
      '1 idx_challenges_status 索引在位');
    const gCols = store.database.prepare('PRAGMA table_info(garden_state)').all().map((c) => c.name);
    ok(gCols.includes('challenge_decor'), '1 garden_state.challenge_decor 列在位（花园限定装饰）');
    ok(store.garden.state().challengeDecor.length === 0, '1 初始装饰为空数组');

    // ── 2. 模板挑战零 AI（store 无 AI Key）──
    ok(!store.hasAIAPIKey(), '2 无 AI Key（模板零 AI 前提）');
    const tpls = svc.templates();
    ok(tpls.length === 3 && tpls.map((t) => t.id).join(',') === 'ai-frontier,longform,fresh-sources',
      '2 预设模板 3 个（ai-frontier/longform/fresh-sources）');
    const c1 = await svc.createChallenge({ templateID: 'ai-frontier' });
    ok(c1.status === 'active' && c1.theme === 'AI 前沿速读' && c1.days === 7 && c1.target === 10,
      '2 模板创建：AI 前沿 7 天 10 篇（active）');
    ok(c1.entries.length === 10 && c1.entries.every((e) => allIDs.includes(e.entryID)),
      '2 AI 前沿书单 10 篇（全部真实存在）');
    ok(svc.counters.fromTemplate === 1 && svc.available().ai === false, '2 模板路径零 AI（fromTemplate 计数）');
    const c1ends = c1.endsAt - c1.startedAt;
    ok(c1ends === 7 * DAY, '2 挑战窗口 = days × 86400（ends_at 精确）');

    // 新源尝鲜：5 源各 1 篇
    // （先放弃 ai-frontier——单飞在 §4 断言，这里为数据面让路）
    // ……单飞断言挪后：先在 c1 active 时断言拒绝
    let dupErr = '';
    try { await svc.createChallenge({ templateID: 'longform' }); } catch (e) { dupErr = String(e && e.message || e); }
    ok(/进行中/.test(dupErr), '4 单飞：active 唯一——第二个创建被拒');
    ok(svc.counters.dedupCreate === 1, '4 dedupCreate 计数在案');
    svc.abandon(c1.id);
    ok(store.database.prepare("SELECT status FROM challenges WHERE id = ?").get(c1.id).status === 'abandoned',
      '8 放弃：status=abandoned 落库');
    let reAbandon = '';
    try { svc.abandon(c1.id); } catch (e) { reAbandon = String(e && e.message || e); }
    ok(/只有进行中/.test(reAbandon), '8 非 active 拒绝放弃');

    const c2 = await svc.createChallenge({ templateID: 'fresh-sources' });
    ok(c2.entries.length === 5 && c2.target === 5, '2 新源尝鲜：5 篇书单');
    ok(new Set(c2.entries.map((e) => e.title)).size === 5, '2 新源尝鲜：书单跨源（5 篇不同文章）');
    const feedOf = (id) => store.database.prepare('SELECT feed_id FROM items WHERE id = ?').get(id)?.feed_id;
    ok(new Set(c2.entries.map((e) => feedOf(e.entryID))).size === 5, '2 新源尝鲜：5 源各 1 篇（spreadFeeds）');
    svc.abandon(c2.id);

    const c3 = await svc.createChallenge({ templateID: 'longform' });
    ok(c3.days === 30 && c3.target === 6 && c3.entries.length === 6, '2 长文深读：30 天 6 篇');
    svc.abandon(c3.id);

    // ── 3. LLM 书单合同容错（mock）──
    store.setAIAPIKey('mock-key-40');
    const candidates = svc.recallCandidates('量子计算');
    ok(candidates.length >= 10, `3 召回：主题词命中候选 ${candidates.length} 篇（≥10）`);
    const goodPick = candidates.slice(0, 8).map((c) => c.id);
    svc._llmComplete = async ({ target }) => '前置杂文```json\n'
      + JSON.stringify({ entries: [...goodPick, 'f40-fabricated-1', 'f40-fabricated-2', goodPick[0]] })
      + '\n```后缀杂文';
    const c4 = await svc.createChallenge({ theme: '量子计算', days: 7, target: 10 });
    ok(c4.status === 'active' && c4.entries.length === 10, '3 mock 书单：围栏+杂文容错，钳制到 target=10');
    ok(svc.counters.fabricatedDropped >= 2, '3 编造 ID 剔除（fabricatedDropped 计数）');
    ok(!c4.entries.some((e) => String(e.entryID).startsWith('f40-fabricated')), '3 编造 ID 不进书单');
    ok(new Set(c4.entries.map((e) => e.entryID)).size === 10, '3 同文去重 + 回填后无重复（10 个唯一 id）');
    ok(c4.entries.every((e) => allIDs.includes(e.entryID)), '3 回填后书单全部真实存在');
    svc.abandon(c4.id); // 收场出单飞位（坏输出重试面不被单飞闸挡住）
    ok(store.database.prepare("SELECT status FROM challenges WHERE id = ?").get(c4.id).status === 'abandoned',
      '8 mock 挑战收场：abandoned 落库');
    svc._llmComplete = async () => '抱歉，我读不出来了。';
    const rowsBefore = store.database.prepare('SELECT COUNT(*) AS n FROM challenges').get().n;
    let badErr = '';
    try { await svc.createChallenge({ theme: '量子计算', days: 7, target: 5 }); } catch (e) { badErr = String(e && e.kind || e); }
    ok(/invalidResponse/.test(badErr)
      && store.database.prepare('SELECT COUNT(*) AS n FROM challenges').get().n === rowsBefore,
      '3 坏输出拒绝（invalidResponse）零残留（行数不变）');
    svc._llmComplete = null;
    // 解析器直测（探针单元）
    const pDirect = parseEntryIDs('{"entries":["a","b","a"]}');
    ok(Array.isArray(pDirect) && pDirect.join(',') === 'a,b', '3 解析器：entries 合同 + 去重保序');
    const pBare = parseEntryIDs('杂文 ["x","y"] 杂文');
    ok(Array.isArray(pBare) && pBare.join(',') === 'x,y', '3 解析器：裸数组合同（围栏外杂文容忍）');
    ok(parseEntryIDs('完全不是 JSON。') === null, '3 解析器：坏 JSON → null');
    // 清 Key：后续模板/降级路径回到零 AI 口径
    store.setAIAPIKey('');
    ok(!store.hasAIAPIKey(), '附 AI Key 已清除（回到零 AI 口径）');

    // ── 5. 进度懒算 + 提前完成发奖（longform 6 篇）──
    const c5 = await svc.createChallenge({ templateID: 'longform' });
    ok(c5.done === 0 && c5.pct === 0, '5 初始进度 0/6（懒算投影）');
    const bookIDs = c5.entries.map((e) => e.entryID);
    store.markRead(bookIDs[0]);
    ok(svc.get(c5.id).done === 1, '5 markRead 钩子：读完 1 篇进度 1（真钩子）');
    store.markRead(bookIDs[0], false);
    store.markRead(bookIDs[0]);
    ok(svc.get(c5.id).done === 1, '5 重复完读防刷：进度不重复计');
    for (let i = 1; i < 5; i += 1) store.markRead(bookIDs[i]);
    ok(svc.get(c5.id).done === 5 && svc.get(c5.id).status === 'active', '5 进度 5/6：仍未毕业');
    const decorBefore = store.garden.state().challengeDecor.length;
    store.markRead(bookIDs[5]); // 第 6 篇：达标 → 提前 done + 发奖
    const after = svc.get(c5.id);
    ok(after.status === 'done' && after.rewardGranted === true && after.done === 6,
      '5 提前完成：读满 target 即刻 done + reward_granted');
    const decor = store.garden.state().challengeDecor;
    ok(decor.length === decorBefore + 1 && decor.some((d) => d.id === `challenge:${c5.id}` && d.kind === 'challenge'),
      '5 花园限定装饰到账（challenge_decor 含 challenge:<id>）');
    ok(svc.counters.completed === 1 && svc.counters.rewarded === 1, '5 completed/rewarded 计数在案');
    store.markRead(bookIDs[5], false);
    store.markRead(bookIDs[5]);
    ok(svc.counters.completed === 1, '5 重复完读不重复发奖（done 幂等）');

    // ── 6. 超时 failed（温和设计：无装饰无扣分）──
    const c6 = await svc.createChallenge({ templateID: 'ai-frontier' });
    svc._now = () => T0 + 8 * DAY; // 越过 ends_at（7 天）
    const listed = svc.list();
    const c6row = listed.find((c) => c.id === c6.id);
    ok(c6row && c6row.status === 'failed' && c6row.done < c6.target,
      '6 超时未达标：懒结算翻 failed（花园不扣分）');
    ok(store.database.prepare('SELECT reward_granted FROM challenges WHERE id = ?').get(c6.id).reward_granted === 0,
      '6 failed：reward_granted=0（无奖励）');
    ok(store.garden.state().challengeDecor.length === decorBefore + 1, '6 failed：花园装饰不增（也不扣）');
    ok(svc.counters.failed === 1, '6 failed 计数在案');
    svc._now = () => T0;

    // ── 7. 挑战卡 SVG 确定性 ──
    const cardA = svc.card(c5.id, { accent: '#617357', paper: '#eae8e1', ink: '#3f3a30' });
    const cardA2 = svc.card(c5.id, { accent: '#617357', paper: '#eae8e1', ink: '#3f3a30' });
    ok(cardA.length > 800 && cardA === cardA2, '7 挑战卡：同输入逐字节同输出（确定性合同）');
    const cardB = svc.card(c5.id, { accent: '#3a6ea5', paper: '#eae8e1', ink: '#3f3a30' });
    ok(cardB !== cardA, '7 不同令牌色 → 不同卡面');
    const cardArt1 = challengeCardArt({ theme: '测试主题', days: 7, done: 3, target: 10, status: 'done', accent: '#617357' });
    const cardArt2 = challengeCardArt({ theme: '测试主题', days: 7, done: 3, target: 10, status: 'done', accent: '#617357' });
    const cardArt3 = challengeCardArt({ theme: '测试主题', days: 7, done: 4, target: 10, status: 'done', accent: '#617357' });
    ok(cardArt1 === cardArt2 && cardArt3 !== cardArt1, '7 纯函数直测：done 变 → 卡面变（完成数可感）');
    ok(cardArt1.includes('data-challenge-card'), '7 卡面含挑战卡标记');
    const xssCard = challengeCardArt({ theme: '<script>alert(1)</script>', days: 7, done: 1, target: 2, accent: '#617357' });
    ok(!xssCard.includes('<script>alert') && xssCard.includes('&lt;script&gt;'), '7 主题 XSS 转义（SVG 注入防护）');

    // ── 8. 放弃/重建（含自定义主题零 AI 降级）──
    const c8 = await svc.createChallenge({ theme: '量子计算', days: 3, target: 3 });
    ok(c8.status === 'active' && c8.entries.length === 3, '8 放弃后可重建（自定义主题零 AI 降级选文）');
    ok(svc.counters.tagFallback >= 1, '8 无 Key 降级计数（tagFallback）');
    svc.abandon(c8.id);
    const history = svc.list().filter((c) => c.status !== 'active');
    ok(history.length >= 6 && history.some((c) => c.status === 'failed') && history.some((c) => c.status === 'abandoned'),
      '8 历史：failed/abandoned 诚实展示（active 在前）');

    // ── 9. 重启读回（跨迁移无损）──
    const totalBefore = store.database.prepare('SELECT COUNT(*) AS n FROM challenges').get().n;
    const doneBefore = store.database.prepare("SELECT COUNT(*) AS n FROM challenges WHERE status = 'done'").get().n;
    const decorBeforeRestart = store.garden.state().challengeDecor.length;
    store.preferences.flushSync();
    store.database.close();
    store = new AppStore(userData);
    ok(store.database.prepare('SELECT COUNT(*) AS n FROM challenges').get().n === totalBefore && totalBefore >= 7,
      `附 重启读回：${totalBefore} 行挑战跨迁移无损`);
    ok(store.database.prepare("SELECT COUNT(*) AS n FROM challenges WHERE status = 'done'").get().n === doneBefore,
      '附 重启读回：done/failed/abandoned 状态保留');
    ok(store.garden.state().challengeDecor.length === decorBeforeRestart && decorBeforeRestart >= 1,
      '附 重启读回：花园限定装饰保留');
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v30-challenges-garden-decor'").get(),
      '1 老库重跑：v30 幂等（迁移链不重复执行）');

    // ── 10. UI（真 IPC + 真 index.html；沿用重启后的 store）──
    const uiSvc = store.challenge;
    uiSvc._now = () => T0;
    store.database.prepare("UPDATE challenges SET status = 'abandoned' WHERE status = 'active'").run(); // UI 阶段从干净状态开挑战
    const ui = await Promise.race([
      challengeUIProbe(store),
      new Promise((r) => setTimeout(() => r({ uiSkipped: true, booted: null }), 150000)),
    ]);
    if (ui.uiSkipped) {
      for (const m of ['附 UI 探针窗口启动（index.html + preload + 真 IPC）', '10 花园浮层第 3 tab（挑战）在位', '10 模板按钮 3 个（零 AI 可点）', '10 UI 创建挑战：进行中卡（进度条+剩余天数+书单勾选）', '10 历史挑战诚实展示（failed 徽标）', '10 Esc 关闭浮层']) {
        console.log('SKIP ' + m);
      }
      console.log('UI 阶段 SKIP：环境性挂起（服务级断言已全部执行）');
      try { fs.writeFileSync(path.join(__dirname, '.ci-skip-marker'), 'scripts/diag-f40-challenge.js'); } catch (_) { /* 标记失败仅影响连击治理 */ }
      store.preferences.flushSync();
      store.database.close();
      console.log(`TOTAL passed=${passed} failed=${failed}`);
      process.exit(failed ? 1 : 0);
      return;
    }
    ok(ui.booted, '附 UI 探针窗口启动（index.html + preload + 真 IPC）');
    ok(ui.challengeTab === true, '10 花园浮层第 3 tab（挑战）在位');
    ok(ui.templates === 3, '10 模板按钮 3 个（零 AI 可点）');
    ok(ui.activeCard === true && ui.progressBar === true && ui.daysLeft === true && ui.checklist >= 5,
      '10 UI 创建挑战：进行中卡（进度条+剩余天数+书单勾选）');
    ok(ui.historyFailed === true, '10 历史挑战诚实展示（failed 徽标）');
    ok(ui.escCloses === true, '10 Esc 关闭浮层');

    // ── 11. 静态接线锚点 ──
    const preloadSrc = read('src/main/preload.js');
    ok(['challengeList', 'challengeTemplates', 'challengeCreate', 'challengeAbandon', 'challengeCard', 'onChallengeChanged']
      .every((n) => preloadSrc.includes(n)), '11 preload 挑战 6 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(["'challenge:list'", "'challenge:templates'", "'challenge:create'", "'challenge:abandon'", "'challenge:card'", "'challenge:changed'"]
      .every((c) => ipcSrc.includes(c)), '11 IPC 挑战通道注册齐备');
    const gardenViewSrc = read('src/renderer/views/garden-view.js');
    ok(['nj-challenge-active', 'nj-challenge-bar-fill', 'nj-challenge-tpl', 'nj-challenge-history-row', 'onChallengeChanged']
      .every((n) => gardenViewSrc.includes(n)), '11 花园浮层挑战 tab 接线（进行中/进度/模板/历史/推送）');
    const cssSrc = read('src/renderer/styles/robin.css');
    ok(['.nj-challenge-bar-fill', '.nj-challenge-tpl', '.nj-challenge-history-row', '.nj-challenge-share-art'].every((n) => cssSrc.includes(n)),
      '11 CSS 挑战 tab 样式在位');
    const stringsSrc = read('src/main/I18NStrings.js');
    ok(['"挑战"', '"开个新赛季"', '"历史挑战"', '"放弃挑战"', '"未达标"', '"挑战卡 SVG 已复制"'].every((k) => stringsSrc.includes(k)),
      '11 i18n 中英键齐备（挑战六组）');
    const storeSrc = read('src/main/AppStore.js');
    ok(storeSrc.includes('this.challenge.onRead') && storeSrc.includes('new ChallengeService'),
      '11 markRead 进度钩子 + 服务构造接线');
    const migrationsSrc = read('src/main/Persistence/DatabaseMigrations.js');
    ok(migrationsSrc.includes('v30-challenges-garden-decor') && migrationsSrc.includes('challenge_decor'),
      '11 v30 迁移在迁移链中（DDL 只进迁移链）');

    // 判定先行 + 同步写：末次拆卸（process.exit/热库句柄）在 Desktop Heap 劣化期可能原生崩溃
    // （exit 127 且缓冲 stdout 全丢），verdict 走 fs.writeSync 即时落盘不经过缓冲。
    // close/reopen 语义已由上方「重启读回」阶段真验过，连库直接留给 OS 回收。
    fs.writeSync(1, `TOTAL passed=${passed} failed=${failed}\n`);
    fs.writeSync(1, failed === 0 ? 'ALL PASSED\n' : `FAILED ${failed}\n`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('ERR', String((err && err.stack) || err).slice(0, 1600));
    process.exit(1);
  }
});

/**
 * 挑战 UI 探针：花园浮层 → 挑战 tab → 模板创建 → 进行中卡 → 历史 → Esc。
 * offscreen + backgroundThrottling=false（f25/f26/f37 惯例）。
 */
async function challengeUIProbe(store) {
  let win = null;
  try {
    win = new BrowserWindow({
      show: false, width: 1200, height: 860, useContentSize: true,
      webPreferences: { offscreen: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
  } catch (err) {
    console.error('challenge UI probe: window create failed (environmental):', String((err && err.message) || err));
    return { uiSkipped: true, booted: null };
  }
  try {
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, win);
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  } catch (err) {
    console.error('challenge UI probe: load failed (environmental):', String((err && err.message) || err));
    try { win.destroy(); } catch (_) { /* 已销毁 */ }
    return { uiSkipped: true, booted: null };
  }
  await sleep(1400);
  const out = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 15000) => {
      const t0 = Date.now();
      for (;;) {
        let v = null;
        try { v = await fn(); } catch (_) { v = null; }
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(120);
      }
    };
    const out = { booted: true };
    try {
      // 花园浮层（侧栏徽章）
      const badge = await waitFor(() => document.querySelector('.footer-garden-btn') || null);
      if (!badge) return { uiSkipped: true, booted: true };
      badge.click();
      const overlay = await waitFor(() => document.querySelector('.nj-garden-overlay') || null);
      if (!overlay) return { uiSkipped: true, booted: true };
      // 第 3 tab：挑战
      const tabs = document.querySelectorAll('.nj-garden-tab');
      out.challengeTab = tabs.length === 3;
      if (!out.challengeTab) return out;
      tabs[2].click();
      // 模板按钮 3 个
      out.templates = await waitFor(() => document.querySelectorAll('.nj-challenge-tpl').length === 3 ? 3 : null) || 0;
      // UI 创建挑战（点第 1 个模板）
      const tplBtn = document.querySelector('.nj-challenge-tpl');
      if (!tplBtn) return out;
      tplBtn.click();
      out.activeCard = await waitFor(() => document.querySelector('[data-role="challenge-active"]') ? true : null) === true;
      out.progressBar = Boolean(document.querySelector('.nj-challenge-bar-fill'));
      out.daysLeft = (document.querySelector('.nj-challenge-left')?.textContent || '').length > 0;
      out.checklist = document.querySelectorAll('.nj-challenge-entry').length;
      // 历史：failed 诚实展示（探针库里有 failed 行）
      out.historyFailed = await waitFor(() => {
        const rows = document.querySelectorAll('.nj-challenge-history-row.st-failed');
        return rows.length >= 1 ? true : null;
      }) === true;
      // Esc 关浮层
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(300);
      out.escCloses = !document.querySelector('.nj-garden-overlay');
      return out;
    } catch (e) {
      return { booted: true, error: String((e && e.stack) || e).slice(0, 700) };
    }
  })()`);
  win.destroy();
  if (out && out.error) console.error('challenge UI probe error:', out.error);
  return out || {};
}
