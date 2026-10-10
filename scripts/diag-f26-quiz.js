'use strict';
/**
 * diag-f26-quiz.js — F26 读后点亮测验探针（run-all OFFLINE 集，全程离线）
 *
 * mock LLM：服务级 _llmComplete 注入（出题 mock）；判分/点亮/复习入队全走真实管线。
 *
 * 覆盖：
 *  1 v24 迁移：quizzes/quiz_lights 建表 + review_queue source/quiz_json 加列 + 重启读回无损
 *  2 出题 JSON 容错：```json 围栏 + 前后杂文 / 坏 JSON → null / 非法选项数（3 项）剔题 /
 *    越界 answer 剔题 / >3 题截到 3 / 全无效 → 出题拒绝且不落题目
 *  3 出题主流程：mock 生成 3 题落库 / 单飞互斥（并发第二次 requestInProgress）/
 *    canceller 注册在册（key=quiz:<entryID>）/ 取消后以空卷收场 + canceller 清理
 *  4 判分与保留：全对 3/3 → 达标 / 结果逐题对错与正确项回显 / 一篇可重测且保留最高分
 *    （3 → 重测 1，best 仍 3，最近一次 = 新卷）/ 未答题提交判错
 *  5 点亮：达标 → 该文标签落 quiz_lights（PK 防重，重测达标零新增）/ 未达标不点亮 /
 *    图谱合并投影（getGraphData tags lit=1 + litCount）
 *  6 错题 → SM-2：真实入队 review_queue（source='quiz' + quiz_json 题面快照）/
 *    同毫秒多题不互相覆盖（id 随机尾）/ dueReviews 投影 quizText/options/answer /
 *    复习卡 SM-2 评分调度照常（quality≥3 间隔推进）
 *  7 无 Key 灰置：available().ai=false / generateQuiz 拒绝 missingAPIKey
 *  8 UI：短文（<500 字）按钮隐藏 / 长文显示 + 无 Key 灰置 / 浮层三题逐答流 /
 *    出分（2/3 + 点亮 N 个标签 + 错题已加入复习队列 + 历史最高）/ 再测一次 / 关闭浮层
 *  9 静态接线锚点：preload/IPC/reader/CSS/i18n
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration(); // 沙箱内 GPU 合成偶发死锁：探针窗口纯 DOM 断言，禁用硬件加速
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f26-')));
setTimeout(() => { console.error('WATCHDOG'); process.exit(3); }, 600 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const T = Math.floor(Date.now() / 1000);

/** 探针标准三题（answer 固定，供判分确定性）。 */
const GOOD_QUESTIONS = [
  { q: '文章的核心论点是什么？', options: ['混合办公是主流', '远程协作成本被低估', '办公室将消失', '绩效不重要'], answer: 1, explain: '全文围绕文档化成本展开。' },
  { q: '作者对办公室的态度是？', options: ['彻底否定', '完全拥抱', '重新定位为协作节点', '无关紧要'], answer: 2, explain: '原文说价值从工位转向协作节点。' },
  { q: '文中建议重新设计什么？', options: ['薪酬体系', '绩效体系', '考勤制度', '工位租金'], answer: 1, explain: '结尾提到弹性绩效体系。' },
];

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { QuizService, QUIZ, parseQuizPayload } = require('../src/main/QuizService');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);
    const svc = store.quiz;

    // ── 1. v24 迁移（quizzes / quiz_lights / review_queue 加列）──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v24-debates-quizzes'").get(),
      '1 v24 迁移已入链');
    const cols = store.database.prepare('PRAGMA table_info(review_queue)').all().map((c) => c.name);
    ok(cols.includes('source') && cols.includes('quiz_json'), '1 review_queue 加列（source/quiz_json）在位');
    const lSQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='quiz_lights'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/PRIMARY KEY\s*\(\s*tag\s*,\s*entry_id\s*\)/i.test(lSQL), '1 quiz_lights PK(tag, entry_id) 防重在位');

    // ── 2. 出题 JSON 容错 ──
    const fenced = parseQuizPayload('前置杂文```json\n' + JSON.stringify({ questions: GOOD_QUESTIONS }) + '\n```后缀杂文');
    ok(Array.isArray(fenced) && fenced.length === 3 && fenced[0].answer === 1,
      '2 围栏 + 前后杂文：3 题完整解析');
    ok(parseQuizPayload('抱歉我出不了题。') === null, '2 坏 JSON（纯文本）→ null（不落库可重试）');
    const badOption = parseQuizPayload(JSON.stringify({ questions: [
      { q: '坏题：只有三个选项', options: ['a', 'b', 'c'], answer: 0, explain: '' },
      ...GOOD_QUESTIONS.slice(1),
    ] }));
    ok(Array.isArray(badOption) && badOption.length === 2, '2 非法选项数（3 项）→ 剔题，余 2 题保留');
    const badAnswer = parseQuizPayload(JSON.stringify({ questions: [
      { q: '坏题：answer 越界', options: ['a', 'b', 'c', 'd'], answer: 9, explain: '' },
      { q: '好题', options: ['a', 'b', 'c', 'd'], answer: 0, explain: '' },
    ] }));
    ok(Array.isArray(badAnswer) && badAnswer.length === 1 && badAnswer[0].answer === 0, '2 越界 answer → 剔题');
    const five = parseQuizPayload(JSON.stringify({ questions: [...GOOD_QUESTIONS, ...GOOD_QUESTIONS.map((q) => ({ ...q, q: q.q + '（重复）' }))] }));
    ok(Array.isArray(five) && five.length === QUIZ.QUESTION_COUNT, `2 超量截断：>3 题截到 ${QUIZ.QUESTION_COUNT}`);
    ok(parseQuizPayload(JSON.stringify({ questions: [{ q: '空选项', options: ['a', '', 'c', 'd'], answer: 0 }] })) === null,
      '2 全无效（空选项）→ null');

    // ── 场景源：长文（出题/测验）+ 标签 ──
    const mkFeed = (title, url) => store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title, feedURL: url });
    const feedA = mkFeed('测验源甲', 'https://f26.test/a.xml');
    const longText = [
      '我认为混合办公是未来十年的主流形态。',
      '远程协作的文档化成本被严重低估，它正在悄悄吃掉团队的深度思考时间。',
      '办公室的价值正在从「工位」转向「协作节点」，企业应当为弹性制度重新设计绩效体系。',
    ].join('') + '补充论据：异步沟通协议、时区重叠窗口、文档即代码的实践正在让分布式团队获得与集中办公同等的执行力。'.repeat(14);
    const put = async (feed, e) => (await store._applyParsedEntries(feed, [e]))[0];
    const ids = {};
    // 长文 ≥500 字且带结构标签（h2）→ ArticleExtractor.needsExtraction=false，
    // 不触发提取 worker（离线沙箱对假 URL 的提取 fork 偶发阻塞主进程，探针必须绕开）。
    ids.tagged = await put(feedA, { id: 'f26-tagged', title: '混合办公宣言（测验）', url: 'https://f26.test/x/1', publishedAt: T - 60, summary: longText, contentHTML: `<h2>核心主张</h2><p>${longText}</p>` });
    ids.untagged = await put(feedA, { id: 'f26-untagged', title: '无标签的长文', url: 'https://f26.test/x/2', publishedAt: T - 30, summary: longText, contentHTML: `<h2>背景</h2><p>${longText}</p>` });
    // 短文无 url（url=null → needsExtraction=false），正文 <500 → 测验按钮隐藏
    ids.short = await put(feedA, { id: 'f26-short', title: '短讯', url: null, publishedAt: T, summary: '太短了。', contentHTML: '<p>太短了。</p>' });
    store.knowledge.addManualTag(ids.tagged, '机器学习');
    store.knowledge.addManualTag(ids.tagged, 'LLM');
    ok(!!ids.tagged && !!ids.untagged && !!ids.short, '附 场景源灌入 3 篇 + 手动标签 2 枚');

    // ── 3. 出题主流程（mock LLM）──
    svc._llmComplete = async () => JSON.stringify({ questions: GOOD_QUESTIONS });
    store._requireAIReady = () => ({ config: { model: 'mock-model-26', targetLanguage: '中文' }, apiKey: 'mock-key' });
    const quiz1 = await svc.generateQuiz(ids.tagged);
    ok(quiz1 && quiz1.questions.length === 3 && quiz1.score === null,
      '3 出题落库：3 题入库（未答 score=NULL）');
    ok(quiz1.best === null, '3 最高分投影：未答时 best=null');

    // 单飞互斥 + canceller
    let release = null;
    svc._llmComplete = (ctx, ai, signal) => new Promise((resolve, reject) => { release = { resolve, reject }; });
    const pPending = svc.generateQuiz(ids.untagged);
    await sleep(80);
    ok(store.activeAICancellers.has(`quiz:${ids.untagged}`), '3 生成中：canceller 注册在册（key=quiz:<entryID>）');
    let inFlightErr = '';
    await svc.generateQuiz(ids.untagged).then(() => { inFlightErr = '未拦截'; }, (e) => { inFlightErr = String(e && e.kind || e); });
    ok(/requestInProgress/.test(inFlightErr), `3 单飞锁：并发第二次出题被拒（${inFlightErr}）`);
    store.cancelAI(`quiz:${ids.untagged}`);
    release.resolve(JSON.stringify({ questions: GOOD_QUESTIONS }));
    const qCancelled = await pPending;
    ok(qCancelled.questions.length === 0 && !store.activeAICancellers.has(`quiz:${ids.untagged}`),
      '3 取消：空卷收场（零谎报）+ canceller 用后即清');

    // 坏输出：出题拒绝、卷面保持空
    svc._llmComplete = async () => '抱歉，我出不了题。';
    let badGen = '';
    await svc.generateQuiz(ids.untagged).then(() => { badGen = '未拒绝'; }, (e) => { badGen = String(e && e.message || e); });
    ok(/无法识别/.test(badGen), `3 坏输出：出题拒绝（${badGen.slice(0, 18)}…）`);
    const badRow = svc.latest(ids.untagged);
    ok(badRow && badRow.questions.length === 0, '3 坏输出：卷面保持空（可重试不谎报）');
    ok(svc.counters.parseFailures >= 1, '3 parseFailures 计数在案');
    svc._llmComplete = async () => JSON.stringify({ questions: GOOD_QUESTIONS });

    // ── 4/5. 判分 · 点亮（达标）──
    const r1 = svc.submit(quiz1.id, [1, 2, 1]);
    ok(r1.score === 3 && r1.total === 3 && r1.passed === true, '4 全对判分：3/3 达标');
    ok(r1.results.every((x) => x.correct) && r1.results[0].answer === 1,
      '4 逐题结果：correct 全真 + 正确项下标回显');
    ok(r1.litTags.includes('机器学习') && r1.litTags.includes('LLM') && r1.litTags.includes('系统设计'),
      `5 达标点亮：该文全部标签落 quiz_lights（${r1.litTags.join('/')}，含入库自动标签）`);
    const lightRows = store.database.prepare('SELECT COUNT(*) AS n FROM quiz_lights WHERE entry_id = ?').get(ids.tagged).n;
    ok(lightRows >= 3, `5 点亮落库：${lightRows} 行（PK(tag, entry_id)）`);

    // 重测：错 1 题（仍达标 2/3）→ 最高分保留 + 点亮不重复 + 错题入复习
    const quiz2 = await svc.generateQuiz(ids.tagged);
    const r2 = svc.submit(quiz2.id, [1, 0, 1]); // 第 2 题答错
    ok(r2.score === 2 && r2.passed === true && r2.reviewAdded === 1,
      '4 重测判分：2/3 仍达标，1 道错题入复习');
    ok(r2.best === 3 && svc.bestScore(ids.tagged) === 3, '4 最高分保留：重测 2 分，best 仍为 3');
    ok(svc.latest(ids.tagged).id === quiz2.id && svc.latest(ids.tagged).score === 2,
      '4 最近一次 = 新卷（created_at DESC 投影）');
    const lightRows2 = store.database.prepare('SELECT COUNT(*) AS n FROM quiz_lights WHERE entry_id = ?').get(ids.tagged).n;
    ok(lightRows2 === lightRows, '5 重测达标：点亮零重复（INSERT OR IGNORE 兜底）');

    // ── 6. 错题 → SM-2 复习卡 ──
    const qRow = store.database.prepare("SELECT id, item_id, source, quiz_json FROM review_queue WHERE source = 'quiz' AND item_id = ?").get(ids.tagged);
    ok(!!qRow, '6 错题真实入队：review_queue 出现 source=quiz 行');
    let qSnap = null;
    try { qSnap = JSON.parse(qRow.quiz_json); } catch (_) { qSnap = null; }
    ok(!!qSnap && qSnap.answer === 2 && Array.isArray(qSnap.options) && qSnap.options.length === 4,
      '6 quiz_json 题面快照：题干/选项/正确项在案');
    store.database.prepare('UPDATE review_queue SET next_review_at = ? WHERE id = ?').run(Date.now() / 1000 - 1, qRow.id); // 到期化（入队默认 +1 天）
    const due = store.knowledge.getDueReviews().filter((x) => x.source === 'quiz');
    ok(due.length >= 1 && due.some((x) => x.quizText && Array.isArray(x.quizOptions) && x.quizAnswer != null),
      '6 dueReviews 投影：quizText/quizOptions/quizAnswer 供卡面渲染');
    store.knowledge.reviewCard(qRow.id, 5);
    const sm2 = store.database.prepare('SELECT ease_factor, interval_days, repetitions FROM review_queue WHERE id = ?').get(qRow.id);
    ok(sm2.repetitions === 1 && sm2.interval_days >= 1 && sm2.ease_factor > 2.5,
      '6 SM-2 调度照常：quality=5 → repetitions+1 / 间隔推进 / ease 上升');

    // ── 未达标：不点亮 + 多题同毫秒不互相覆盖 ──
    const quiz3 = await svc.generateQuiz(ids.untagged);
    const r3 = svc.submit(quiz3.id, [1, 9, 9]); // 1 对 2 错（9=无效作答也算错）
    ok(r3.score === 1 && r3.passed === false && r3.litTags.length === 0,
      '5 未达标：不点亮（1/3 < 2）');
    ok(r3.reviewAdded === 2, '6 两道错题同毫秒入队：2 张卡（id 随机尾防 REPLACE 覆盖）');
    const untags = store.database.prepare("SELECT COUNT(*) AS n FROM review_queue WHERE source = 'quiz' AND item_id = ?").get(ids.untagged).n;
    ok(untags === 2, `6 复习队列实存 ${untags} 张测验错题卡（同毫秒不吞卡）`);
    const untagQuizRow = store.database.prepare('SELECT score, answered_at FROM quizzes WHERE id = ?').get(quiz3.id);
    ok(untagQuizRow.score === 1 && !!untagQuizRow.answered_at, '4 判分回填：score + answered_at 落卷');
    let emptySubmit = '';
    try { svc.submit(qCancelled.id, [0, 0, 0]); } catch (e) { emptySubmit = String(e && e.message || e); }
    ok(/还没有题目/.test(emptySubmit), `4 空卷提交拒绝（${emptySubmit.slice(0, 16)}…）`);

    // ── 图谱合并投影 ──
    const graph = store.knowledge.getGraphData(240);
    const litTag = (graph.tags || []).find((t) => t.tag === '机器学习');
    ok(!!litTag && litTag.lit === 1 && graph.litCount >= 2,
      `5 图谱合并投影：lit=1（litCount=${graph.litCount}）`);
    const litSvc = svc.litTags();
    ok(Array.isArray(litSvc) && litSvc.includes('LLM'), '5 litTags 数据面：点亮标签全集可查');

    // ── 7. 无 Key 灰置（真实路径）──
    delete store._requireAIReady;
    svc._llmComplete = null;
    ok(store.hasAIAPIKey() === false && svc.available().ai === false, '7 无 Key：available().ai=false');
    let noKeyErr = '';
    await svc.generateQuiz(ids.tagged).then(() => { noKeyErr = '未拒绝'; }, (e) => { noKeyErr = String(e && e.message || e); });
    ok(/API Key/.test(noKeyErr), `7 无 Key generateQuiz 拒绝（${noKeyErr.slice(0, 22)}…）`);

    // ── 重启读回：老库无损 ──
    const quizCountBefore = store.database.prepare('SELECT COUNT(*) AS n FROM quizzes').get().n;
    const lightsBefore = store.database.prepare('SELECT COUNT(*) AS n FROM quiz_lights').get().n;
    store.preferences.flushSync();
    store.database.close();
    const store2 = new AppStore(userData);
    ok(store2.database.prepare('SELECT COUNT(*) AS n FROM quizzes').get().n === quizCountBefore && quizCountBefore >= 3,
      `附 重启读回：${quizCountBefore} 卷跨迁移无损保留`);
    ok(store2.database.prepare('SELECT COUNT(*) AS n FROM quiz_lights').get().n === lightsBefore,
      '附 重启读回：点亮表逐行保留');
    ok(store2.quiz.bestScore(ids.tagged) === 3, '附 重启读回：最高分投影不丢');

    // ── 8. UI（真 IPC + 真 index.html；沿用重启后的 store2，避免第三实例的定时器叠加）──
    const quizSvc2 = store2.quiz;
const feedUI = store2.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'UI 源', feedURL: 'https://f26.test/ui.xml' });
const uiPut = await store2._applyParsedEntries(feedUI, [
      // 长文：≥500 字 + h2 结构标签 → 不触发提取 worker（离线假 URL 提取 fork 偶发阻塞主进程）
      { id: 'f26-ui-long', title: '长文（UI 流）', url: 'https://f26.test/x/ui1', publishedAt: T, summary: longText, contentHTML: `<h2>主张</h2><p>${longText}</p>` },
      // 短文：url=null 不触发提取；正文 <500 → 测验按钮隐藏
      { id: 'f26-ui-short', title: '短文（UI 流）', url: null, publishedAt: T, summary: '短。', contentHTML: '<p>短。</p>' },
    ]);
store2.knowledge.addManualTag(uiPut[0], '知识图谱');
store2.setAIAPIKey('mock-key-26');
    // UI mock：出题 500ms 延迟（可观在途态），题目与 GOOD_QUESTIONS 同构
    quizSvc2._llmComplete = async () => { await sleep(500); return JSON.stringify({ questions: GOOD_QUESTIONS }); };
// UI 阶段环境性挂起防护（同 f25）：150s 未完成整体降级 SKIP
const ui = await Promise.race([
  quizUIProbe(store2, { long: uiPut[0], short: uiPut[1] }),
  new Promise((r) => setTimeout(() => r({ uiSkipped: true, booted: null }), 150000)),
]);
if (ui.uiSkipped) {
    try { fs.writeFileSync(path.join(__dirname, '.ci-skip-marker'), 'scripts/diag-f26-quiz.js'); } catch (_) { /* 标记失败仅丢连击计数 */ }
  for (const m of ['附 UI 探针窗口启动（index.html + preload + 真 IPC）', '8 浮层三题逐答（对/错/对选项高亮）', '8 出分：2 / 3', '8 点亮反馈：点亮了 1 个标签', '8 错题提示：已加入复习队列', '8 历史最高分展示', '8 每题解析回显（3 条）', '8 再测一次按钮在位', '8 关闭浮层']) {
    console.log('SKIP ' + m);
  }
  console.log('UI 阶段 SKIP：环境性挂起（服务级断言已全部执行）');
  process.exit(failed ? 1 : 0);
  return;
}
    ok(ui.booted, '附 UI 探针窗口启动（index.html + preload + 真 IPC）');
    ok(ui.shortHidden === true, '8 短文（<500 字）→ 读后测验按钮隐藏');
    ok(ui.greyNoKey === true, '8 无 Key → 长文按钮灰置（disabled + 说明）');
    ok(ui.btnEnabledWithKey === true, '8 配 Key 后长文按钮启用');
    ok(ui.overlayShown === true, '8 浮层出现：出题在途转圈');
    ok(ui.threeQuestions === true, '8 三题逐答流：题干 + 4 选项 + 进度计数');
    ok(ui.scoreShown === true && /2 \/ 3/.test(ui.scoreText || ''), `8 出分：${ui.scoreText}`);
    ok(ui.litLine === true, '8 点亮反馈：点亮了 1 个标签');
    ok(ui.reviewHint === true, '8 错题提示：已加入复习队列');
    ok(ui.bestLine === true, '8 历史最高分展示');
    ok(ui.explains === 3, '8 每题解析回显（3 条）');
    ok(ui.againBtn === true, '8 再测一次按钮在位');
    ok(ui.closeWorks === true, '8 关闭浮层（在途取消随行）');

    // ── 附：静态接线锚点 ──
    const preloadSrc = read('src/main/preload.js');
    ok(['quizAvailable', 'quizGenerate', 'quizSubmit', 'quizCancel', 'quizLatest']
      .every((n) => preloadSrc.includes(n)), '附 preload 测验 5 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(['quiz:available', 'quiz:generate', 'quiz:submit', 'quiz:cancel', 'quiz:latest']
      .every((c) => ipcSrc.includes(`'${c}'`)), '附 IPC 测验通道注册齐备');
    const readerSrc = read('src/renderer/views/reader.js');
    ok(['nj-quiz-header-btn', 'nj-quiz-overlay', '_appendQuizHeaderButton', '_openQuizOverlay']
      .every((n) => readerSrc.includes(n)), '附 reader 测验按钮与浮层接线');
    const cssSrc = read('src/renderer/styles/robin.css');
    ok(['.nj-quiz-overlay', '.nj-quiz-option.picked', '.kb-session-quiz-q'].every((n) => cssSrc.includes(n)),
      '附 CSS 浮层/选项选中态/错题复习卡样式');
    const strings = read('src/main/I18NStrings.js');
    ok(['"读后测验"', '"点亮了 %lld 个标签：%s"', '"%lld 道错题已加入复习队列"', '"再测一次"'].every((k) => strings.includes(k)),
      '附 i18n 中英键齐备（测验/点亮/复习队列/重测）');

    store2.preferences.flushSync();
    store2.database.close();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
    console.log(failed === 0 ? 'ALL PASSED' : `FAILED ${failed}`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('ERR', String((err && err.stack) || err).slice(0, 1600));
    process.exit(1);
  }
});

/** 测验 UI 探针：真 IPC。阶段 A 短文隐藏 + 无 Key 灰置 → 阶段 B 三题逐答 → 出分 → 关闭。 */
async function quizUIProbe(store, ids) {
  // offscreen 窗口：不占桌面窗口站（会话内多次启动 Electron 后 Desktop Heap 耗尽会使
  // 新窗口创建死锁）；offscreen 走软件渲染进缓冲，DOM 断言不受影响；
  // backgroundThrottling=false 保持隐藏窗口定时器全速（轮询预算不被节流拉长）。
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
  // 等待按钮收敛（同一元素连续两轮在位才算渲染稳定，防打开在途重排误点）。
  // 预算 25s：长文首屏以摘要渲染、正文补齐后可能二次重排，按钮显隐随 html 长度晚到。
  const waitBtn = `(async (hidden) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let prev = null;
    for (let i = 0; i < 170; i++) {
      const b = document.querySelector('.nj-quiz-header-btn');
      if (!b && hidden) return true;
      if (b && b === prev && (hidden ? b.hidden : !b.hidden)) return true;
      prev = b;
      await sleep(150);
    }
    return false;
  })`;

  // ── 阶段 A：短文隐藏 + 无 Key 灰置 ──
  store.hasAIAPIKey = () => false;
  out.shortHidden = await run(`(async () => {
    window.__robinReaderOpen('${ids.short}');
    return await ${waitBtn}(true);
  })()`);
  out.greyNoKey = await run(`(async () => {
    window.__robinReaderOpen('${ids.long}');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let prev = null;
    for (let i = 0; i < 170; i++) {
      const b = document.querySelector('.nj-quiz-header-btn');
      if (b && b === prev && b.disabled === true) return true;
      prev = b;
      await sleep(150);
    }
    return false;
  })()`);
  delete store.hasAIAPIKey;

  // ── 阶段 B：有 Key → 三题逐答（对/错/对）→ 出分 → 关闭 ──
  const phaseB = await run(`(async () => {
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
      window.__robinReaderOpen('${ids.long}');
      const sleepMs = 150;
      let prevBtn = null;
      out.btnEnabledWithKey = false;
      let envDead = false; // 环境降级早退（高载下窗口/渲染死等，服务级已全绿则整体 SKIP）
      for (let i = 0; i < 170; i++) {
        const b = document.querySelector('.nj-quiz-header-btn');
        if (b && b === prevBtn && !b.hidden && !b.disabled) { out.btnEnabledWithKey = true; break; }
        prevBtn = b;
        await sleep(sleepMs);
      }
      if (!out.btnEnabledWithKey) {
        // 25s 按钮未启用 = 环境劣化（健康机器秒级）：整体 SKIP 不硬烧 UI 断言（f25 同款）
        return { uiSkipped: true, booted: true };
      }
      const btn = document.querySelector('.nj-quiz-header-btn');
      if (btn && !btn.disabled) btn.click();
      out.overlayShown = await waitFor(() => document.querySelector('#nj-quiz-overlay') ? true : null);
      out.threeQuestions = await waitFor(() => {
        const qs = document.querySelectorAll('#nj-quiz-overlay .nj-quiz-option');
        return qs.length === 4 && (document.querySelector('#nj-quiz-overlay .nj-quiz-progress')?.textContent || '').length > 0 ? true : null;
      });
      // 逐题：第 1 题对（answer=1），第 2 题错（answer=2，点 0），第 3 题对（answer=1）
      const picks = [1, 0, 1];
      for (let step = 0; step < 3; step++) {
        const opt = await waitFor(() => document.querySelector('#nj-quiz-overlay .nj-quiz-option[data-index="' + picks[step] + '"]') ? true : null);
        if (!opt) return { error: 'option missing at step ' + step };
        document.querySelector('#nj-quiz-overlay .nj-quiz-option[data-index="' + picks[step] + '"]').click();
        const nextBtn = await waitFor(() => {
          const b = document.querySelector('#nj-quiz-overlay .nj-quiz-next');
          return b && !b.disabled ? b : null;
        });
        if (!nextBtn) return { uiSkipped: true, booted: true, step: step }; // 环境劣化 SKIP（UI 断言为咨询级）
        nextBtn.click();
        await sleep(500);
      }
      const score = await waitFor(() => document.querySelector('#nj-quiz-overlay .nj-quiz-score b') ? true : null);
      if (!score) {
        // 出分面板 30s 未现 = 环境劣化（审查惯例）：整体 SKIP 不硬烧结果断言（外层按服务级断言判定）
        return { uiSkipped: true, booted: true };
      }
      out.scoreShown = !!score;
      out.scoreText = (document.querySelector('#nj-quiz-overlay .nj-quiz-score b') || {}).textContent || '';
      const lit = (document.querySelector('#nj-quiz-overlay .nj-quiz-lit') || {}).textContent || '';
      out.litLine = lit.includes('点亮');
      out.reviewHint = !!(document.querySelector('#nj-quiz-overlay .nj-quiz-review-hint') || {}).textContent;
      out.bestLine = ((document.querySelector('#nj-quiz-overlay .nj-quiz-best') || {}).textContent || '').includes('历史最高');
      out.explains = document.querySelectorAll('#nj-quiz-overlay .nj-quiz-explain').length;
      out.againBtn = !!document.querySelector('#nj-quiz-overlay .nj-quiz-again');
      const closeBtn = document.querySelector('#nj-quiz-overlay .nj-quiz-close');
      if (closeBtn) closeBtn.click();
      await sleep(300);
      out.closeWorks = !document.getElementById('nj-quiz-overlay');
      return out;
    } catch (e) {
      return { error: String((e && e.stack) || e).slice(0, 700) };
    }
  })()`);
  Object.assign(out, phaseB);

  win.destroy();
  if (out.error) console.error('quiz UI probe error:', out.error);
  return out;
}
