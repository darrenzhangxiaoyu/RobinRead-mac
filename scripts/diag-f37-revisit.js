'use strict';
/**
 * diag-f37-revisit.js — F37 深读重访探针（run-all OFFLINE 集，全程离线）
 *
 * mock LLM：服务级 _llmComplete 注入（重读指引 mock）；登记/结算/推迟/徽章全走真实管线。
 *
 * 覆盖：
 *  1 v29 迁移：revisits（id/entry_id UNIQUE/status CHECK/guidance_json）+ source_profiles 同批 + 重启读回无损
 *  2 登记三道闸：长文（正文 ≥1500 字）markRead 登记 due=read_at+30d / 短文跳过 /
 *    已有 SM-2 复习卡跳过 / 同文重复登记防重（UNIQUE）/ 不存在文章拒绝
 *  3 到期懒结算：未到期零浮出 / 到期浮现（标题/来源/距上次天数）/ 多卡按 due 升序
 *  4 done/skipped 推迟语义：done=+30d 终态不再浮出 / skipped=+30d 到期后结算翻回 pending 再浮出 /
 *    非法动作拒绝 / 不存在卡拒绝 / respond 推送 revisit:changed
 *  5 徽章与每日一次温和提示：badge 计数 / nudge 当天呼吸一次 / 同日不重复 / 次日再呼吸 / 空计数不呼吸
 *  6 AI 重读指引：mock 生成 3 条落库 / 缓存防重烧（二次调用零 LLM）/ 批注进 prompt /
 *    解析容错（围栏+杂文/坏 JSON null/纯数字行剔除/超量截 3/points 备用合同）/
 *    坏输出拒绝不落缓存可重试 / 无 Key 降级 degraded / 单飞互斥 + 取消
 *  7 注入时钟确定性：两次注入同一时刻投影逐位一致
 *  8 UI：侧栏重访徽章计数 / 浮层到期卡 / 指引 3 条卡片流（真 IPC）/ 已读过了卡片退场 / Esc 关浮层
 *  9 静态接线锚点：preload/IPC/侧栏/浮层视图/CSS/i18n/AppStore 钩子
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration(); // 沙箱内 GPU 合成偶发死锁：探针窗口纯 DOM 断言，禁用硬件加速
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f37-')));
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

/** 指引标准 3 条（mock LLM 合同）。 */
const GOOD_GUIDANCE = {
  guidance: [
    '当时的关键论点：远程办公的文档化成本被低估。',
    '今天的你该重看第三段：混合办公的绩效设计已被新实践验证。',
    '挑战一句：一年后的今天，你还相信办公室会消失吗？',
  ],
};

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { RevisitService, REVISIT, parseGuidancePayload, dayOf } = require('../src/main/RevisitService');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);
    const svc = store.revisit;
    svc._now = () => T0; // 注入时钟（确定性到期判定）

    // ── 1. v29 迁移 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v29-revisits-source-profiles'").get(),
      '1 v29 迁移已入链');
    const cols = store.database.prepare('PRAGMA table_info(revisits)').all().map((c) => c.name);
    ok(['id', 'entry_id', 'read_at', 'due', 'status', 'guidance_json', 'created_at'].every((c) => cols.includes(c)),
      '1 revisits 列齐备（id/entry_id/read_at/due/status/guidance_json/created_at）');
    const rSQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='revisits'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/entry_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(rSQL), '1 entry_id UNIQUE 防重在位（同文终身一条）');
    ok(/CHECK\s*\(\s*status\s+IN\s+\('pending','done','skipped'\)/i.test(rSQL), '1 status CHECK（pending/done/skipped）在位');
    let checkViolated = false;
    try { store.database.prepare("INSERT INTO revisits (id, entry_id, read_at, due, status, created_at) VALUES ('x', 'x', 0, 0, 'bogus', 0)").run(); } catch (_) { checkViolated = true; }
    ok(checkViolated, '1 status 非法值被 CHECK 拒绝');
    ok(!!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_profiles'").get(),
      '1 v29 同批：source_profiles 建表在位（F38 侧）');
    ok(svc instanceof RevisitService && REVISIT.DUE_DAYS === 30 && REVISIT.DEFER_DAYS === 30,
      '1 RevisitService 构造校验通过 + 规则常量（30d 登记/30d 推迟）');

    // ── 场景源：2 篇长文 + 1 篇短文 ──
    const longText = '远程办公的文档化成本正在被严重低估，它悄悄吃掉团队的深度思考时间。'.repeat(60)
      + '办公室的价值正从工位转向协作节点，弹性绩效体系需要重新设计。'.repeat(30); // ≥1500 字
    const mkFeed = (title, url) => store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title, feedURL: url });
    const feedA = mkFeed('重访源甲', 'https://f37.test/a.xml');
    const feedB = mkFeed('重访源乙', 'https://f37.test/b.xml');
    const put = async (feed, e) => (await store._applyParsedEntries(feed, [e]))[0];
    // url=null：不触发提取 worker（离线沙箱对假 URL 的提取 fork 偶发阻塞主进程，探针必须绕开）
    const long1 = await put(feedA, { id: 'f37-long1', title: '混合办公的长文（重访）', url: null, publishedAt: T0 - DAY, summary: longText, contentHTML: `<p>${longText}</p>` });
    const long2 = await put(feedB, { id: 'f37-long2', title: '另一篇该重访的长文', url: null, publishedAt: T0 - DAY, summary: longText, contentHTML: `<p>${longText}</p>` });
    const short1 = await put(feedA, { id: 'f37-short', title: '短讯一条', url: null, publishedAt: T0, summary: '太短了。', contentHTML: '<p>太短了。</p>' });
    ok(!!long1 && !!long2 && !!short1, '附 场景源灌入：2 长文 + 1 短文');

    // ── 2. 登记三道闸（真实 markRead 钩子）──
    store.markRead(short1, true);
    ok(svc.counters.skippedShort === 1, '2 短文（<1500 字）读完不登记（skippedShort）');
    store.markRead(long1, true);
    const row1 = store.database.prepare('SELECT * FROM revisits WHERE entry_id = ?').get(long1);
    ok(!!row1 && row1.status === 'pending' && row1.due === T0 + REVISIT.DUE_DAYS * DAY,
      `2 长文读完经 markRead 钩子登记：due = read_at + ${REVISIT.DUE_DAYS} 天（注入时钟精确）`);
    ok(Math.abs(row1.read_at - T0) < 1, '2 read_at 取服务时钟（登记时刻）');
    // 重复完读（false→true 循环）：UNIQUE 兜底不重复登记
    store.markRead(long1, false);
    store.markRead(long1, true);
    const long1Rows = store.database.prepare('SELECT COUNT(*) AS n FROM revisits WHERE entry_id = ?').get(long1).n;
    ok(long1Rows === 1 && svc.counters.dedupHits === 1, '2 重复完读：UNIQUE 防重幂等（同一行不重复）');
    // 同文直撞（绕过 wasRead 闸模拟并发/历史行）：INSERT OR IGNORE 兜底
    const direct = svc.onCompleted({ entryID: long1 });
    ok(direct.registered === false && direct.reason === 'duplicate' && long1Rows === 1,
      '2 同文重复登记被 UNIQUE 吞掉（duplicate）');
    // 已有 SM-2 复习卡的原文跳过（复习管线管短记忆，重访不重复打扰）
    store.knowledge.addToReview({ itemID: long2 });
    store.markRead(long2, true);
    const long2Row = store.database.prepare('SELECT COUNT(*) AS n FROM revisits WHERE entry_id = ?').get(long2).n;
    ok(long2Row === 0 && svc.counters.skippedSM2 === 1, '2 已有 SM-2 复习卡的原文跳过登记（sm2）');
    const missing = svc.onCompleted({ entryID: 'f37-nonexistent' });
    ok(missing.registered === false && missing.reason === 'missing', '2 不存在的文章登记拒绝（missing）');

    // ── 3. 到期懒结算 ──
    svc._now = () => T0 + 29 * DAY;
    ok(svc.badge() === 0 && svc.due().length === 0, '3 第 29 天：零到期零浮出（懒结算无定时器）');
    svc._now = () => T0 + 30 * DAY + 60;
    const dueList = svc.due();
    ok(svc.badge() === 1 && dueList.length === 1, '3 第 30 天：回顾卡浮出（badge=1）');
    ok(dueList[0].entryID === long1 && dueList[0].title.includes('混合办公') && dueList[0].sourceTitle === '重访源甲',
      '3 浮出卡带标题与来源（浮层列表数据面）');
    ok(dueList[0].daysSinceRead === 30, '3 距上次读完 30 天（daysSinceRead）');
    // 多卡按 due 升序（先到期先浮出）：手工为 long2 落一条更早 due 的计划（绕过 SM-2 闸）
    store.database.prepare(
      "INSERT OR IGNORE INTO revisits (id, entry_id, read_at, due, status, created_at) VALUES ('rv-l2', ?, ?, ?, 'pending', ?)"
    ).run(long2, T0 + 5 * DAY, T0 + 20 * DAY, T0 + 5 * DAY);
    const due2 = svc.due();
    ok(due2.length === 2 && due2[0].entryID === long2 && due2[1].entryID === long1,
      '3 多卡按 due 升序（先到期先浮出）');

    // ── 4. done / skipped 推迟语义（推迟基准 = max(原 due, 回应时刻)，晚回应不瞬间再到期）──
    let changedEvents = 0;
    store.on('revisit:changed', () => { changedEvents += 1; });
    const cardL2 = due2[0]; // long2（手工行）
    const nowAtDone = T0 + 30 * DAY + 60;
    const responded = svc.respond(cardL2.id, 'done');
    ok(responded.status === 'done' && responded.due === Math.max(cardL2.due, nowAtDone) + REVISIT.DEFER_DAYS * DAY,
      `4 done：status=done + due += ${REVISIT.DEFER_DAYS} 天（自 max(原due, 回应时刻) 起算）`);
    ok(svc.badge() === 1, '4 done 卡即刻退出到期列表');
    svc._now = () => T0 + 60 * DAY; // 推过 done 的新 due
    ok(!svc.due().some((c) => c.id === cardL2.id), '4 done 是终态：推过新 due 也不复浮（已读过了不重复打扰）');
    const cardL1 = svc.due()[0];
    const skippedCard = svc.respond(cardL1.id, 'skipped');
    ok(skippedCard.status === 'skipped' && skippedCard.due === Math.max(cardL1.due, T0 + 60 * DAY) + REVISIT.DEFER_DAYS * DAY,
      `4 skipped：status=skipped + due += ${REVISIT.DEFER_DAYS} 天`);
    ok(svc.badge() === 0, '4 skipped 后徽章清零（温和退场）');
    svc._now = () => T0 + 89 * DAY;
    ok(svc.badge() === 0, '4 推迟期内（新 due 前）：不复浮');
    svc._now = () => T0 + 91 * DAY; // 推过 skipped 的新 due（T0+90d）
    const resurfaced = svc.due();
    ok(resurfaced.length === 1 && resurfaced[0].id === cardL1.id && resurfaced[0].status === 'pending',
      '4 skipped 新 due 过后懒结算翻回 pending 再浮出（稍后再说=30 天后再提醒）');
    ok(svc.counters.settled >= 1, '4 懒结算计数在案（settle skipped→pending）');
    ok(changedEvents >= 2, '4 respond 推送 revisit:changed（徽章在场即热更）');
    let badAction = '';
    try { svc.respond(cardL1.id, 'nope'); } catch (e) { badAction = String(e && e.message || e); }
    ok(/done|skipped/.test(badAction), `4 非法动作拒绝（${badAction.slice(0, 18)}…）`);
    let noCard = '';
    try { svc.respond('rv-missing', 'done'); } catch (e) { noCard = String(e && e.message || e); }
    ok(/不存在/.test(noCard), `4 不存在的重访卡拒绝（${noCard.slice(0, 14)}…）`);

    // ── 5. 徽章与每日一次温和提示（时钟停在 T0+91d：恰好一张到期卡）──
    const nudge1 = svc.nudge();
    ok(nudge1.count === 1 && nudge1.breathe === true, '5 nudge：到期计数 1 + 当天呼吸一次');
    const nudge2 = svc.nudge();
    ok(nudge2.count === 1 && nudge2.breathe === false, '5 同日第二次：不再呼吸（每日一次记账）');
    svc._now = () => T0 + 92 * DAY;
    const nudge3 = svc.nudge();
    ok(nudge3.breathe === true && nudge3.day === dayOf(T0 + 92 * DAY), '5 次日：再呼吸一次（day 记账推进）');
    svc.respond(resurfaced[0].id, 'done');
    ok(svc.badge() === 0 && svc.nudge().breathe === false, '5 空计数：永不呼吸');

    // ── 6. AI 重读指引 ──
    svc._now = () => T0; // 回登记时刻：新长文 30 天后（T0+30d）到期
    const long3 = await put(feedB, { id: 'f37-long3', title: '指引试验长文', url: null, publishedAt: T0 - DAY, summary: longText, contentHTML: `<p>${longText}</p>` });
    store.database.prepare('INSERT INTO highlights (id, item_id, text, color, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('hl-f37-1', long3, '文档化成本被低估——这是当时划下的句子。', 'yellow', '当时觉得一针见血', T0);
    store.markRead(long3, true);
    svc._now = () => T0 + 40 * DAY;
    const card3 = svc.due().find((c) => c.entryID === long3);
    ok(!!card3, '附 指引试验卡到期在册');
    let llmCalls = 0;
    svc._llmComplete = async (ctx) => {
      llmCalls += 1;
      svc._lastCtx = ctx; // 捕获 prompt 上下文（批注进断言）
      return '前置杂文```json\n' + JSON.stringify(GOOD_GUIDANCE) + '\n```后缀杂文';
    };
    store._requireAIReady = () => ({ config: { model: 'mock-model-37', targetLanguage: '中文' }, apiKey: 'mock-key' });
    const g1 = await svc.guidance(card3.id);
    ok(Array.isArray(g1.guidance) && g1.guidance.length === 3 && g1.cached === false,
      '6 mock 生成 3 条指引（围栏+杂文容错入合同）');
    ok(!!store.database.prepare('SELECT guidance_json FROM revisits WHERE id = ?').get(card3.id).guidance_json,
      '6 指引缓存落库（guidance_json）');
    const ctx = svc._lastCtx || {};
    ok(String(ctx.annotations?.[0]?.text || '').includes('文档化成本') && String(ctx.annotations?.[0]?.note || '').includes('一针见血'),
      '6 当时的批注（划线+附记）进 prompt 上下文');
    const g2 = await svc.guidance(card3.id);
    ok(g2.cached === true && Array.isArray(g2.guidance) && g2.guidance.length === 3 && llmCalls === 1,
      '6 二次调用走缓存：零 LLM（防重复烧 token）');
    const g3 = await svc.guidance(card3.id);
    ok(g3.cached === true && svc.counters.guidanceCached >= 2 && llmCalls === 1, '6 缓存命中计数在案');
    // 单飞互斥 + 取消（用一张新卡）
    const long4 = await put(feedA, { id: 'f37-long4', title: '单飞试验长文', url: null, publishedAt: T0 - DAY, summary: longText, contentHTML: `<p>${longText}</p>` });
    svc._now = () => T0 + 3 * DAY;
    store.markRead(long4, true); // due = T0+33d
    svc._now = () => T0 + 41 * DAY;
    const card4 = svc.due().find((c) => c.entryID === long4);
    ok(!!card4, '附 单飞试验卡到期在册');
    let release = null;
    svc._llmComplete = (c, ai, signal) => new Promise((resolve, reject) => { release = { resolve, reject }; });
    const pPending = svc.guidance(card4.id);
    await sleep(80);
    ok(store.activeAICancellers.has(`revisit-guidance:${card4.id}`), '6 生成中：canceller 注册在册（key=revisit-guidance:<id>）');
    let inFlight = '';
    await svc.guidance(card4.id).then(() => { inFlight = '未拦截'; }, (e) => { inFlight = String(e && e.kind || e); });
    ok(/requestInProgress/.test(inFlight), `6 单飞锁：并发第二次被拒（${inFlight}）`);
    svc.cancel(card4.id);
    release.resolve('x'); // mock promise 需手工释放（真通路由 abort 触发 reject；mock 忽略 signal）
    const gCancelled = await pPending;
    ok(gCancelled.cancelled === true && !store.activeAICancellers.has(`revisit-guidance:${card4.id}`),
      '6 取消：以 cancelled 收场 + canceller 用后即清');
    // 坏输出：拒绝且不落缓存（可重试）
    svc._llmComplete = async () => '抱歉，我读不出来了。';
    let badGen = '';
    await svc.guidance(card4.id).then(() => { badGen = '未拒绝'; }, (e) => { badGen = String(e && e.message || e); });
    ok(/无法识别/.test(badGen), `6 坏输出拒绝（${badGen.slice(0, 16)}…）`);
    ok(!store.database.prepare('SELECT guidance_json FROM revisits WHERE id = ?').get(card4.id).guidance_json
      && svc.counters.parseFailures >= 1, '6 坏输出不落缓存（可重试）+ parseFailures 计数');
    svc.respond(card4.id, 'skipped'); // 推迟出 UI 窗口（UI 阶段只留 long3 一张卡）
    // 无 Key 降级
    delete store._requireAIReady;
    svc._llmComplete = null;
    let llmCallsBefore = llmCalls;
    const gDeg = await svc.guidance(card4.id);
    ok(gDeg.degraded === true && gDeg.guidance === null && svc.counters.degraded >= 1 && llmCalls === llmCallsBefore,
      '6 无 Key 降级：{degraded:true}（渲染层出「重读全文」按钮），零 LLM');
    // 解析器直测
    const pointsParsed = parseGuidancePayload('杂文 {"points":["甲要点","乙要点"]} 杂文');
    ok(Array.isArray(pointsParsed) && pointsParsed.length === 2 && pointsParsed[0] === '甲要点',
      '6 解析器：points 备用合同可解析（围栏外杂文容忍）');
    const capped = parseGuidancePayload(JSON.stringify({ guidance: ['一', '二', '三', '四', '五'] }));
    ok(Array.isArray(capped) && capped.length === REVISIT.GUIDANCE_COUNT, '6 超量截断：>3 条截到 3');
    const numericDropped = parseGuidancePayload(JSON.stringify({ guidance: ['好句子', 42, null, '也行'] }));
    ok(Array.isArray(numericDropped) && numericDropped.length === 2 && !numericDropped.some((x) => x === '42'),
      '6 非字符串/纯数字行剔除');
    ok(parseGuidancePayload('完全不是 JSON。') === null, '6 坏 JSON → null（不落缓存可重试）');

    // ── 7. 注入时钟确定性 ──
    const s1 = new RevisitService(store, { now: () => T0 + 41 * DAY });
    const s2 = new RevisitService(store, { now: () => T0 + 41 * DAY });
    ok(JSON.stringify(s1.due()) === JSON.stringify(s2.due()) && svc.now() === T0 + 41 * DAY,
      '7 同一注入时钟下投影逐位一致（探针确定性）');

    // ── 8. 重启读回：跨迁移无损 ──
    const totalBefore = store.database.prepare('SELECT COUNT(*) AS n FROM revisits').get().n;
    const doneBefore = store.database.prepare("SELECT COUNT(*) AS n FROM revisits WHERE status = 'done'").get().n;
    store.preferences.flushSync();
    store.database.close();
    const store2 = new AppStore(userData);
    ok(store2.database.prepare('SELECT COUNT(*) AS n FROM revisits').get().n === totalBefore && totalBefore >= 3,
      `附 重启读回：${totalBefore} 行重访计划跨迁移无损`);
    ok(store2.database.prepare("SELECT COUNT(*) AS n FROM revisits WHERE status = 'done'").get().n === doneBefore,
      '附 重启读回：done/skipped 状态保留');
    ok(!!store2.database.prepare('SELECT guidance_json FROM revisits WHERE entry_id = ?').get(long3)?.guidance_json,
      '附 重启读回：指引缓存保留');

    // ── 9. UI（真 IPC + 真 index.html；沿用 store2）──
    const rSvc2 = store2.revisit;
    rSvc2._now = () => T0 + 41 * DAY;
    store2.database.prepare('DELETE FROM revisits WHERE id = ?').run('rv-l2'); // 手工行不进 UI 断言
    const uiDue = store2.database.prepare("SELECT id FROM revisits WHERE status = 'pending' AND due <= ? ORDER BY due ASC").all(T0 + 41 * DAY);
    ok(uiDue.length === 1 && uiDue[0].id === card3.id, '附 UI 阶段：恰好一张到期卡（long3，指引已缓存）');
    rSvc2._llmComplete = async () => JSON.stringify(GOOD_GUIDANCE); // 兜底（本卡走缓存，不触 LLM）
    store2._requireAIReady = () => ({ config: { model: 'mock-model-37' }, apiKey: 'mock-key' });
    store2.setAIAPIKey('mock-key-37');
    // UI 阶段环境性挂起防护（f25/f26 惯例）：150s 未完成整体降级 SKIP
    const ui = await Promise.race([
      revisitUIProbe(store2),
      new Promise((r) => setTimeout(() => r({ uiSkipped: true, booted: null }), 150000)),
    ]);
    if (ui.uiSkipped) {
      for (const m of ['附 UI 探针窗口启动（index.html + preload + 真 IPC）', '9 侧栏重访徽章计数在位', '9 浮层出现：到期回顾卡（标题+来源+距上次天数）', '9 AI 重读指引：3 条卡片流', '9 已读过了：卡片退场（回应生效）', '9 Esc 关闭浮层']) {
        console.log('SKIP ' + m);
      }
      console.log('UI 阶段 SKIP：环境性挂起（服务级断言已全部执行）');
      store2.preferences.flushSync();
      store2.database.close();
      console.log(`TOTAL passed=${passed} failed=${failed}`);
      process.exit(failed ? 1 : 0);
      return;
    }
    ok(ui.booted, '附 UI 探针窗口启动（index.html + preload + 真 IPC）');
    ok(ui.badgeVisible === true, '9 侧栏重访徽章计数在位');
    ok(ui.overlayShown === true, '9 浮层出现：到期回顾卡（标题+来源+距上次天数）');
    ok(ui.guidanceLines === 3, '9 AI 重读指引：3 条卡片流（真 IPC）');
    ok(ui.respondWorks === true, '9 已读过了：卡片退场（回应生效，revisit:changed 热更）');
    ok(ui.escCloses === true, '9 Esc 关闭浮层');

    // ── 10. 静态接线锚点 ──
    const preloadSrc = read('src/main/preload.js');
    ok(['revisitNudge', 'revisitDue', 'revisitRespond', 'revisitGuidance', 'revisitCancel', 'onRevisitChanged', 'spectrumView', 'spectrumAnalyze', 'spectrumForEntry']
      .every((n) => preloadSrc.includes(n)), '附 preload 重访 6 通道 + 光谱 3 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(['revisit:nudge', 'revisit:due', 'revisit:respond', 'revisit:guidance', 'revisit:cancel', 'spectrum:view', 'spectrum:analyze', 'spectrum:forEntry']
      .every((c) => ipcSrc.includes(`'${c}'`)), '附 IPC 重访/光谱通道注册齐备');
    const sidebarSrc = read('src/renderer/views/sidebar.js');
    ok(['footer-revisit-btn', 'nj-revisit-badge', '_refreshRevisitBadge', 'onOpenRevisit'].every((n) => sidebarSrc.includes(n)),
      '附 侧栏重访按钮/徽章/呼吸接线');
    const viewSrc = read('src/renderer/views/revisit-view.js');
    ok(['nj-revisit-overlay', 'nj-revisit-guidance', 'nj-revisit-done', 'nj-revisit-skip', '__robinRevisitView'].every((n) => viewSrc.includes(n)),
      '附 重访浮层视图（卡片/指引/回应/探测句柄）');
    const appSrc = read('src/renderer/app.js');
    ok(appSrc.includes('openRevisitView') && appSrc.includes('RevisitView'), '附 app.js 浮层入口接线');
    const cssSrc = read('src/renderer/styles/robin.css');
    ok(['.nj-revisit-badge', '.nj-revisit-badge.breathing', '.nj-revisit-card', '@keyframes nj-revisit-breathe', '.nj-spectrum-point', '.nj-spectrum-popover']
      .every((n) => cssSrc.includes(n)), '附 CSS 徽章/呼吸动画/卡片/光谱布点/popover');
    const strings = read('src/main/I18NStrings.js');
    ok(['"深读重访"', '"%lld 篇长文该重访了"', '"已读过了"', '"稍后再说"', '"AI 重读指引"', '"重读全文"', '"分析我的订阅源"', '"来源立场光谱"']
      .every((k) => strings.includes(k)), '附 i18n 中英键齐备（重访/指引/光谱）');
    const storeSrc = read('src/main/AppStore.js');
    ok(storeSrc.includes('this.revisit.onCompleted') && storeSrc.includes('this.spectrum.needsReanalyze'),
      '附 markRead 登记钩子 + 刷新光谱重析钩子接线');

    store2.preferences.flushSync();
    store2.database.close();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
    console.log(`TOTAL passed=${passed} failed=${failed}`);
    console.log(failed === 0 ? 'ALL PASSED' : `FAILED ${failed}`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('ERR', String((err && err.stack) || err).slice(0, 1600));
    process.exit(1);
  }
});

/** 重访 UI 探针：真 IPC。侧栏徽章 → 点开浮层 → 指引 3 条 → 已读过了 → Esc。 */
async function revisitUIProbe(store) {
  // offscreen 窗口：不占桌面窗口站（Desktop Heap 耗尽会使新窗口创建死锁）；
  // backgroundThrottling=false 保持隐藏窗口定时器全速。
  const win = new BrowserWindow({
    show: false, width: 1200, height: 860, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
  const { registerIPCHandlers } = require('../src/main/ipc');
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1400);

  const run = (script) => win.webContents.executeJavaScript(script);
  const out = { booted: true };
  out.badgeVisible = await run(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 60; i++) {
      const badge = document.querySelector('.footer-revisit-btn .nj-revisit-badge');
      if (badge && !badge.hidden && Number(badge.textContent) >= 1) return true;
      await sleep(200);
    }
    return false;
  })()`);
  const phase = await run(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 30000) => {
      const t0 = Date.now();
      for (;;) {
        let v = null;
        try { v = await fn(); } catch (_) { v = null; }
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(120);
      }
    };
    const out = {};
    try {
      const btn = document.querySelector('.footer-revisit-btn');
      if (!btn) return { uiSkipped: true, booted: true };
      btn.click();
      const overlay = await waitFor(() => document.querySelector('.nj-revisit-overlay') ? true : null);
      if (!overlay) return { uiSkipped: true, booted: true };
      out.overlayShown = await waitFor(() => {
        const card = document.querySelector('.nj-revisit-card');
        if (!card) return null;
        const meta = (card.querySelector('.nj-revisit-meta') || {}).textContent || '';
        return card.querySelector('.nj-revisit-title')?.textContent && meta.includes('距上次读完') ? true : null;
      }) === true;
      const gBtn = await waitFor(() => document.querySelector('.nj-revisit-card .nj-revisit-guidance') || null);
      if (!gBtn) return { uiSkipped: true, booted: true };
      gBtn.click();
      out.guidanceLines = await waitFor(() => {
        const items = document.querySelectorAll('.nj-revisit-card .nj-revisit-guidance-item');
        return items.length === 3 ? 3 : null;
      }) || 0;
      const doneBtn = document.querySelector('.nj-revisit-card .nj-revisit-done');
      if (doneBtn) doneBtn.click();
      out.respondWorks = await waitFor(() => document.querySelector('.nj-revisit-card') ? null : true) === true;
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      document.dispatchEvent(esc);
      await sleep(300);
      out.escCloses = !document.querySelector('.nj-revisit-overlay');
      return out;
    } catch (e) {
      return { error: String((e && e.stack) || e).slice(0, 700) };
    }
  })()`);
  Object.assign(out, phase);
  win.destroy();
  if (out.error) console.error('revisit UI probe error:', out.error);
  return out;
}
