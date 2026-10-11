'use strict';
/**
 * diag-f30-course.js — F30 自学课程引擎探针（run-all OFFLINE 集，全程离线、mock LLM）
 *
 * 覆盖：
 *  1 v26 迁移：courses（status CHECK/days_total）+ course_days（PK(course_id,day) 即 UNIQUE）+ 老库无损
 *  2 无 Key 拒绝：createCourse → missingAPIKey 明确报错 + available().ai=false（不做纯检索降级）
 *  3 候选召回：关键词扩展 / FTS 命中合并去重 / 180 天窗外剔除 / 封顶 40 / 召回为空明确报错
 *  4 大纲生成（mock LLM）：JSON 容错（围栏+杂文）/ 编造文章 ID 剔除 / 天数越界钳制（20 天 → 14）/
 *    缺天回填 / 真实文章引用（全部 entryIDs 在库）
 *  5 今日课推进：day1 起步 / 跳天拒绝（先完成前面的天）/ 未读完拒绝 / 全读后打卡 /
 *    重复打卡幂等 / 解锁下一天 / 进度条 N/total
 *  6 放弃与重建：abandon 后打卡拒绝 / todayCourse finished / 重建 = 新行共存
 *  7 毕业：7 天课逐日读完打卡 → status=done + todayCourse finished（惰性毕业）
 *  8 静态接线锚点：preload/IPC/侧栏/app.js(浮层+命令面板)/视图/CSS(令牌)/i18n
 *  9 UI（真 IPC + index.html）：侧栏入口 → 课程卡（目标+进度条）→ 今日课面板（要点+文章行+勾选）
 *    → 完成打卡进度推进 → 无 Key 时新目标表单灰置
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f30-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const DAY = 86400;
const T0 = Math.floor(Date.now() / 1000);

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { CourseService, COURSE, clampDays, parseOutlineRaw } = require('../src/main/CourseService');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);
    const svc = store.course;
    ok(svc instanceof CourseService, '附 CourseService 随 AppStore 构造（F30 接线）');

    // ── UI 窗早开（进程年轻时原生导航健康；高载下年老进程的 loadFile 曾同步卡死桌面堆）──
    // 真 IPC + index.html 早加载，DOM 断言放在探针末段（此时课程数据已就位）
    const uiWin = await openUIWindow(store);

    // ── 1. v26 迁移 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v26-weeklies-courses'").get(),
      '1 v26 迁移已入链');
    const courseSQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='courses'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/status\b[^,]*CHECK\s*\(\s*status\s+IN\s+\('active'\s*,\s*'done'\s*,\s*'abandoned'\)/i.test(courseSQL), '1 courses status CHECK（active|done|abandoned）在位');
    ok(/days_total\s+INTEGER NOT NULL DEFAULT 14/i.test(courseSQL), '1 courses days_total 默认 14 在位');
    const daySQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='course_days'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/PRIMARY\s+KEY\s*\(\s*course_id\s*,\s*day\s*\)/i.test(daySQL), '1 course_days UNIQUE(course_id,day)（PK 形式）在位');
    ok(/completed_at/i.test(daySQL), '1 course_days completed_at 列在位（打卡/解锁判定列）');
    let dupDayErr = '';
    try {
      store.database.transaction(() => {
        store.database.prepare("INSERT INTO courses (id, goal, days_total, created_at, updated_at) VALUES ('f30-dup', 'g', 7, 1, 1)").run();
        store.database.prepare("INSERT INTO course_days (course_id, day, entry_ids_json) VALUES ('f30-dup', 1, '[]')").run();
        store.database.prepare("INSERT INTO course_days (course_id, day, entry_ids_json) VALUES ('f30-dup', 1, '[]')").run();
      });
    } catch (e) { dupDayErr = String(e.message); }
    ok(/UNIQUE/i.test(dupDayErr), `1 同课同天重复落库被 UNIQUE 拒（${dupDayErr.slice(0, 22)}…）`);
    store.database.prepare("DELETE FROM courses WHERE id = 'f30-dup'").run();

    // ── 场景源：机器学习主题订阅库 ──
    const mkFeed = (title, url) => store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title, feedURL: url });
    const feed = mkFeed('机器学习日报', 'https://f30.test/ml.xml');
    const feed2 = mkFeed('深度学习周刊', 'https://f30.test/dl.xml');
    const put = async (f, e) => (await store._applyParsedEntries(f, [e]))[0];
    const mk = (id, title, summary, ageDays) => ({ id, title, url: `https://f30.test/x/${id}`, publishedAt: T0 - ageDays * DAY, summary, contentHTML: `<h2>${title}</h2><p>${summary}</p>` });
    const mlEntries = [];
    for (let i = 1; i <= 10; i += 1) {
      mlEntries.push(await put(feed, mk(`f30-ml${i}`, `机器学习入门第 ${i} 讲：梯度下降与损失函数`, `机器学习第 ${i} 讲摘要：梯度下降是机器学习的核心优化算法。`, i)));
    }
    for (let i = 1; i <= 6; i += 1) {
      mlEntries.push(await put(feed2, mk(`f30-dl${i}`, `深度学习笔记 ${i}：神经网络与反向传播`, `深度学习笔记 ${i}：神经网络由多层机器学习单元堆叠而成。`, i)));
    }
    // 200 天旧文不走 _applyParsedEntries（90 天灌文窗会拒收）——走仓储直插，只当召回窗的反例
    store.articlesRepo.upsertEntry({
      id: `local:${feed.id}:${'f30-stale'}`,
      accountID: LOCAL_ACCOUNT_ID, externalID: `local:${feed.id}:${'f30-stale'}`, feedID: feed.id,
      title: '机器学习旧文（200 天前）', author: null, url: 'https://f30.test/x/f30-stale',
      publishedAt: T0 - 200 * DAY, summary: '这篇在 180 天窗外。', contentHTML: '<p>旧文</p>',
      dateArrived: T0 - 200 * DAY,
    });
    const entryStale = `local:${feed.id}:${'f30-stale'}`;
    ok(mlEntries.length === 16 && !!store.articlesRepo.entry(entryStale), '附 场景源灌入 16+1 篇（机器学习主题）');

    // ── 2. 无 Key 拒绝 ──
    ok(svc.available().ai === false, '2 无 Key：available().ai=false（渲染层灰置数据面）');
    let noKeyErr = '';
    try { await svc.createCourse('学会机器学习基础', { days: 14 }); } catch (e) { noKeyErr = String(e.message); }
    ok(/尚未设置 API Key|API Key/.test(noKeyErr), `2 无 Key 创建拒绝（${noKeyErr.slice(0, 20)}…）`);
    ok(store.database.prepare('SELECT COUNT(*) AS n FROM courses').get().n === 0, '2 无 Key：零残留（无课程行）');

    // ── 3. 候选召回 ──
    const kws = svc.expandKeywords('三个月学会机器学习基础');
    ok(Array.isArray(kws) && kws.length >= 1 && kws.length <= COURSE.KEYWORD_MAX + 2, `3 关键词扩展（${kws.join('/')}）`);
    const cands = svc.recallCandidates('三个月学会机器学习基础');
    ok(cands.length >= 5 && cands.length <= COURSE.CANDIDATE_CAP, `3 候选召回 ${cands.length} 篇（多关键词合并）`);
    ok(cands.every((c) => !c.id.includes('f30-stale')), '3 180 天窗外文章不进候选');
    ok(new Set(cands.map((c) => c.id)).size === cands.length, '3 候选去重（多关键词合并无重复）');
    ok(cands.every((c) => c.title && c.id), '3 候选带标题+真实 ID');
    // 封顶：再灌 40+ 篇，候选不超 40
    const feedBulk = mkFeed('Bulk 源', 'https://f30.test/bulk.xml');
    for (let i = 1; i <= 45; i += 1) {
      await put(feedBulk, mk(`f30-bulk${i}`, `机器学习.bulk${i}`, `机器学习 bulk 摘要 ${i}。`, 5));
    }
    const capped = svc.recallCandidates('机器学习');
    ok(capped.length === COURSE.CANDIDATE_CAP, `3 候选封顶 ${COURSE.CANDIDATE_CAP} 篇（实际 ${capped.length}）`);
    // 召回为空 → 明确报错
    let emptyErr = '';
    store._requireAIReady = () => ({ config: {}, apiKey: 'probe-key' }); // 从这里起 stub Key
    try { await svc.createCourse('量子色动力学导论', { days: 7 }); } catch (e) { emptyErr = String(e.message); }
    ok(/没有与目标相关的文章/.test(emptyErr), `3 召回为空明确报错（${emptyErr.slice(0, 22)}…）`);
    ok(store.database.prepare('SELECT COUNT(*) AS n FROM courses').get().n === 0, '3 召回为空：零残留');

    // ── 4. 大纲生成（mock LLM：容错 + 编造剔除 + 越界钳制 + 缺天回填）──
    const candIDs = cands.map((c) => c.id);
    // mock：返回 20 天（越界）、含编造 ID、含围栏与杂文；缺的天由回填逻辑补齐
    const outlineDays = [];
    for (let d = 1; d <= 20; d += 1) {
      outlineDays.push({
        point: `第 ${d} 天要点：梯度下降与损失函数（${d}）`,
        entryIDs: [candIDs[(d - 1) % candIDs.length], 'local:feed:fabricated-id', candIDs[d % candIDs.length]],
      });
    }
    svc._llmComplete = async () => `好的，这是课程大纲：\n\`\`\`json\n${JSON.stringify({ days: outlineDays })}\n\`\`\`\n以上。`;
    const course = await svc.createCourse('三个月学会机器学习基础', { days: 14 });
    ok(course && course.id && course.status === 'active', '4 课程创建落库（status=active）');
    ok(course.daysTotal === 14, '4 days_total=14 落库');
    ok(course.days.length === 14 && course.days.every((d, i) => d.day === i + 1), '4 天数越界钳制：LLM 20 天 → 14 天且 day 连续 1..14');
    const allEntryIDs = course.days.flatMap((d) => d.entryIDs);
    const dbIDs = new Set(store.database.prepare('SELECT id FROM items').all().map((r) => r.id));
    ok(allEntryIDs.every((id) => dbIDs.has(id)), '4 全部文章 ID 真实存在（LLM 编造 ID 全被剔除）');
    ok(svc.snapshot().fabricatedDropped >= 14, `4 编造 ID 剔除计数在案（${svc.snapshot().fabricatedDropped} 次）`);
    ok(course.days.every((d) => d.entryIDs.length >= 1 && d.entryIDs.length <= COURSE.ENTRIES_PER_DAY_MAX), '4 每天文章数 1..3（回填后）');
    ok(new Set(allEntryIDs).size === allEntryIDs.length, '4 同篇文章不重复排课');
    ok(course.days.every((d) => typeof d.point === 'string' && d.point.length > 0 && d.point.length <= COURSE.POINT_SLICE), '4 每天学习要点一句话在位');
    ok(store.database.prepare('SELECT COUNT(*) AS n FROM course_days WHERE course_id = ?').get(course.id).n === 14, '4 course_days 14 行落库');
    // 7 天档
    const course7 = await svc.createCourse('深度学习速成', { days: 7 });
    ok(course7.daysTotal === 7 && course7.days.length === 7, '4 7 天档创建（7 天课）');
    ok(clampDays(0) === 14 && clampDays(99) === 14 && clampDays(3) === 7 && clampDays(7) === 7 && clampDays('14') === 14, '4 clampDays 越界钳制（0→14 / 99→14 / 3→7）');
    // 坏 JSON：零残留可重试（目标须能召回候选，才会真走到 LLM 解析段）
    svc._llmComplete = async () => '抱歉我无法输出 JSON。';
    let badErr = '';
    try { await svc.createCourse('学坏机器学习', { days: 14 }); } catch (e) { badErr = String(e.message); }
    ok(/无法识别/.test(badErr), `4 坏输出 → invalidResponse（${badErr.slice(0, 16)}…）`);
    ok(store.database.prepare('SELECT COUNT(*) AS n FROM courses WHERE goal = ?').get('学坏机器学习').n === 0, '4 坏输出零残留（可重试）');
    ok(svc.snapshot().parseFailures === 1, '4 解析失败计数在案');
    ok(parseOutlineRaw('```json\n{"days":[{"point":"p","entryIDs":[]}]}\n```') !== null && parseOutlineRaw('完全不是 JSON') === null,
      '4 parseOutlineRaw：围栏剥离 + 非法输入 null');

    // ── 5. 今日课推进（跳天拒绝 / 未读完拒绝 / 打卡 / 解锁）──
    const day1 = course.days.find((d) => d.day === 1);
    const today1 = svc.todayCourse(course.id);
    ok(today1.finished === false && today1.today.day === 1, '5 今日课 = 第 1 天（创建后起步）');
    ok(today1.today.entries.length === day1.entryIDs.length && today1.today.entries.every((e) => e.isRead === false), '5 今日课文章行带已读态（初始未读）');
    ok(typeof today1.today.point === 'string' && today1.today.point.length > 0, '5 当日学习要点在面板数据面');
    let skipErr = '';
    try { svc.completeDay(course.id, 3); } catch (e) { skipErr = String(e.message); }
    ok(/先完成前面的天/.test(skipErr), `5 跳天打卡拒绝（${skipErr.slice(0, 16)}…）`);
    let unreadErr = '';
    try { svc.completeDay(course.id, 1); } catch (e) { unreadErr = String(e.message); }
    ok(/没读完/.test(unreadErr) && /\d+/.test(unreadErr), `5 未读完打卡拒绝（${unreadErr}）`);
    for (const e of day1.entryIDs) store.markRead(e, true);
    const done1 = svc.completeDay(course.id, 1);
    ok(done1.completed === true && done1.progress.completed === 1 && done1.progress.total === 14, '5 完成本日：打卡落库 + 进度 1/14');
    const again1 = svc.completeDay(course.id, 1);
    ok(again1.alreadyDone === true && again1.completed === true, '5 重复打卡幂等（alreadyDone）');
    const today2 = svc.todayCourse(course.id);
    ok(today2.today.day === 2, '5 打卡后解锁下一天（今日课=第 2 天）');
    ok(svc.todayCourse(course.id).today.entries.every((e) => e.isRead === false), '5 新一天文章恢复未读态（读完回来自动勾选=读后 isRead 投影）');
    const day2 = course.days.find((d) => d.day === 2);
    // 读完一半拒绝，读完全部通过
    store.markRead(day2.entryIDs[0], true);
    let halfErr = '';
    try { svc.completeDay(course.id, 2); } catch (e) { halfErr = String(e.message); }
    ok(/没读完/.test(halfErr), '5 部分读完仍拒绝（解锁闸严格）');
    for (const e of day2.entryIDs) store.markRead(e, true);
    const done2 = svc.completeDay(course.id, 2);
    ok(done2.completed === true && done2.progress.completed === 2 && typeof done2.quizHook === 'string', '5 第 2 天打卡（quizHook=当日首篇，理解题联动预留接口）');

    // ── 6. 放弃与重建 ──
    const abandoned = svc.abandon(course7.id);
    ok(abandoned.status === 'abandoned', '6 放弃课程：status=abandoned');
    let abandonDoneErr = '';
    try { svc.completeDay(course7.id, 1); } catch (e) { abandonDoneErr = String(e.message); }
    ok(/放弃/.test(abandonDoneErr), `6 已放弃课程打卡拒绝（${abandonDoneErr.slice(0, 14)}…）`);
    const todayAbandoned = svc.todayCourse(course7.id);
    ok(todayAbandoned.finished === true && todayAbandoned.abandoned === true, '6 已放弃课程今日课 finished+abandoned');
    let abandonTwice = '';
    try { svc.abandon(course7.id); } catch (e) { abandonTwice = String(e.message); }
    ok(/进行中/.test(abandonTwice), '6 重复放弃拒绝（只有 active 可弃）');
    // 重建 = 再 createCourse（新行，与放弃行共存）
    svc._llmComplete = async () => JSON.stringify({ days: [{ point: '重建第 1 天', entryIDs: [candIDs[0]] }, { point: '重建第 2 天', entryIDs: [candIDs[1]] }, { point: '重建第 3 天', entryIDs: [candIDs[2]] }, { point: '重建第 4 天', entryIDs: [candIDs[3]] }, { point: '重建第 5 天', entryIDs: [candIDs[4]] }, { point: '重建第 6 天', entryIDs: [candIDs[5]] }, { point: '重建第 7 天', entryIDs: [candIDs[6]] }] });
    const course7b = await svc.createCourse('深度学习速成（重建）', { days: 7 });
    ok(course7b.id !== course7.id && course7b.status === 'active' && course7b.daysTotal === 7, '6 重建课程 = 新行（与放弃行共存）');
    ok(store.database.prepare('SELECT COUNT(*) AS n FROM courses').get().n >= 3, '6 课程表多行共存（active/abandoned）');
    const list1 = svc.list();
    ok(list1[0].status === 'active' && list1.some((c) => c.status === 'abandoned'), '6 课程列表：active 在前，历史留档');

    // ── 7. 毕业（7 天课逐日读完打卡 → done）──
    for (let d = 1; d <= 7; d += 1) {
      const day = course7b.days.find((x) => x.day === d);
      for (const e of day.entryIDs) store.markRead(e, true);
      const r = svc.completeDay(course7b.id, d);
      if (d < 7) ok(r.courseDone === false && r.progress.completed === d, `7 第 ${d} 天打卡（进度 ${d}/7，未毕业）`);
      else ok(r.courseDone === true, '7 第 7 天打卡 → 课程毕业（courseDone）');
    }
    ok(store.database.prepare("SELECT status FROM courses WHERE id = ?").get(course7b.id).status === 'done', '7 毕业落库：status=done');
    const todayFinished = svc.todayCourse(course7b.id);
    ok(todayFinished.finished === true && todayFinished.today === undefined, '7 毕业后今日课 finished（无未完成天）');

    // ── 8. 静态接线锚点 ──
    const preloadSrc = read('src/main/preload.js');
    ok(['courseAvailable', 'courseCreate', 'courseList', 'courseGet', 'courseToday', 'courseCompleteDay', 'courseAbandon', 'courseCancel']
      .every((n) => preloadSrc.includes(n)), '8 preload 课程 8 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(['course:available', 'course:create', 'course:list', 'course:get', 'course:today', 'course:completeDay', 'course:abandon', 'course:cancel']
      .every((c) => ipcSrc.includes(`'${c}'`)), '8 IPC 课程通道注册齐备');
    const sidebarSrc = read('src/renderer/views/sidebar.js');
    ok(['footer-course-btn', 'onOpenCourse', "t('自学课程')"].every((n) => sidebarSrc.includes(n)), '8 侧栏课程入口接线（与周刊同级）');
    const viewSrc = read('src/renderer/views/course-view.js');
    ok(['nj-course-card', 'nj-course-progress-fill', 'nj-course-today', 'nj-course-entry', 'nj-course-done', 'nj-course-form', 'nj-course-goal-input', '__robinCourseView']
      .every((n) => viewSrc.includes(n)), '8 课程视图课程卡/进度条/今日课/表单渲染锚点齐备');
    const appSrc = read('src/renderer/app.js');
    ok(['openCourseView', 'CourseView', "t('自学课程…')"].every((n) => appSrc.includes(n)), '8 app.js 课程浮层入口 + 命令面板命令接线');
    const cssSrc = read('src/renderer/styles/robin.css');
    const courseCss = cssSrc.slice(cssSrc.indexOf('F30 自学课程'));
    ok(courseCss.includes('.nj-course-progress-bar') && courseCss.includes('.nj-course-today')
      && !/border-radius: (?:4|6|7|8|10|12|14)px/.test(courseCss)
      && !/font-size:\s*(?:[0-9]|11\.\d)px/.test(courseCss.replace(/var\(--fs-[^)]*\)/g, '')),
      '8 CSS 课程面板在位且新块零 radius/字号字面量（护栏口径）');
    const strings = read('src/main/I18NStrings.js');
    ok(['"自学课程"', '"今日课"', '"完成本日"', '"课程引擎需要 AI Key"', '"课程毕业！全部课程读完，恭喜。"']
      .every((k) => strings.includes(k)), '8 i18n 课程键齐备（双语表）');

    // ── 9. UI（真 IPC + index.html；窗口已开场加载，此刻课程数据全部就位；无 Key 环境 → 创建灰置）──
    const ui = await courseUIProbe(uiWin, course);
    ok(ui.booted, '附 UI 探针页面就绪（index.html + preload + 真 IPC）');
    ok(ui.opened === true, '9 侧栏「课程」点击 → 课程浮层');
    ok(ui.goalShown === true && ui.goalText.includes('机器学习'), `9 进行中课程卡：目标（${ui.goalText.slice(0, 18)}…）`);
    ok(ui.progressShown === true && /2 \/ 14 天/.test(ui.progressText), `9 进度条 N/total（${ui.progressText}）`);
    ok(ui.todayPanel === true && ui.todayHead.includes('第 3 天'), `9 今日课面板：当前应学天（${ui.todayHead}）`);
    ok(ui.entryRows >= 1 && ui.unreadRows >= 1, `9 今日课文章行渲染（${ui.entryRows} 行，含未读「去读」态）`);
    ok(ui.checkedAfterRead === true, '9 读完回来自动勾选（isRead 投影 → 已读态行）');
    ok(ui.completedAdvanced === true && ui.progressAfter.includes('3 / 14'), `9 完成本日 → 进度推进（${ui.progressAfter}）`);
    ok(ui.formGrayed === true, '9 无 Key：创建提交键灰置（课程引擎需要 AI Key）');
    ok(ui.warnShown === true, '9 表单内无 Key 明确文案（不做纯检索降级）');
    ok(ui.escCloses === true, '9 Esc 关浮层（卫生）');

    // ── 10. 重启读回（UI 窗已关，连接安全交接）──
    const courseCount = store.database.prepare('SELECT COUNT(*) AS n FROM courses').get().n;
    const dayCount = store.database.prepare('SELECT COUNT(*) AS n FROM course_days').get().n;
    store.preferences.flushSync();
    store.database.close();
    const store2 = new AppStore(userData);
    ok(store2.database.prepare('SELECT COUNT(*) AS n FROM courses').get().n === courseCount && courseCount >= 3,
      `10 重启读回：${courseCount} 门课程跨迁移无损`);
    ok(store2.database.prepare('SELECT COUNT(*) AS n FROM course_days').get().n === dayCount && dayCount >= 14 + 7,
      `10 重启读回：${dayCount} 个 course_days 无损`);
    ok(store2.course.get(course.id).progress.completed === 3 && store2.course.get(course.id).status === 'active',
      '10 重启读回：进度与状态保留（3/14 active）');
    ok(store2.course.todayCourse(course.id).today.day === 4, '10 重启读回：今日课推进位置保留（第 4 天）');

    store2.preferences.flushSync();
    store2.database.close();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
    console.log(failed === 0 ? 'ALL PASSED' : `FAILED ${failed}`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('ERR', String((err && err.stack) || err).slice(0, 1600));
    app.exit(1);
  }
});

/**
 * UI 窗早开（进程年轻时原生导航健康）：真 IPC + index.html。
 * 高载下年老进程的 loadFile 曾同步卡死桌面堆——窗口与页面加载放在探针开场，
 * DOM 断言由 courseUIProbe 在末段执行（此刻课程数据已全部就位）。
 */
async function openUIWindow(store) {
  const win = new BrowserWindow({
    show: false, width: 1200, height: 860, useContentSize: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
  const { registerIPCHandlers } = require('../src/main/ipc');
  registerIPCHandlers(store, win);
  await Promise.race([
    win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html')).catch(() => {}),
    sleep(8000),
  ]);
  await sleep(1600); // bootstrap 余量
  return win;
}

/** 课程 UI DOM 探针：侧栏入口 → 课程卡 → 今日课 → 读文勾选 → 完成打卡 → 表单灰置。 */
async function courseUIProbe(win, course) {
  const out = { booted: false };
  try {
    const phase = await win.webContents.executeJavaScript(`(async () => {
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
    const out = { booted: !!window.robin };
    try {
      // 侧栏「课程」入口 → 浮层（活动课程展开为课程卡 + 今日课面板；课程在「更多」第二行，先保开展开）
      const btn = await waitFor(() => document.querySelector('.footer-course-btn'));
      const moreWrap = document.querySelector('.footer-more-wrap');
      if (moreWrap && !moreWrap.classList.contains('open')) document.querySelector('.footer-more-btn')?.click();
      out.btnFound = !!btn;
      btn.click();
      out.opened = await waitFor(() => document.querySelector('.nj-course-modal')) != null;
      const goal = await waitFor(() => document.querySelector('.nj-course-card .nj-course-goal'));
      out.goalShown = !!goal;
      out.goalText = (goal || {}).textContent || '';
      out.progressShown = await waitFor(() => /2 \\/ 14 天/.test((document.querySelector('.nj-course-progress-nums') || {}).textContent || '')) != null;
      out.progressText = (document.querySelector('.nj-course-progress-nums') || {}).textContent || '';
      // 今日课面板
      const today = await waitFor(() => document.querySelector('.nj-course-today'));
      out.todayPanel = !!today;
      out.todayHead = (document.querySelector('.nj-course-today-head b') || {}).textContent || '';
      out.entryRows = document.querySelectorAll('.nj-course-entry').length;
      out.unreadRows = document.querySelectorAll('.nj-course-entry:not(.is-read)').length;
      // 完成本日前的第 3 天文章：先全部读完（真 IPC markRead → isRead 投影）
      const day3 = ${JSON.stringify(course.days.find((d) => d.day === 3).entryIDs)};
      for (const id of day3) await window.robin.markRead(id, true);
      await window.robin.courseToday(${JSON.stringify(course.id)}); // 热身：真 IPC 读回已读态
      // 重开浮层（视图刷新 → 勾选投影）
      document.querySelector('.nj-course-close').click();
      await sleep(200);
      document.querySelector('.footer-course-btn').click();
      await waitFor(() => document.querySelector('.nj-course-modal'));
      await waitFor(() => document.querySelectorAll('.nj-course-entry.is-read').length > 0);
      out.checkedAfterRead = document.querySelectorAll('.nj-course-entry.is-read').length === day3.length;
      // 完成本日
      const doneBtn = document.querySelector('.nj-course-done');
      doneBtn.click();
      await waitFor(() => /3 \\/ 14 天/.test((document.querySelector('.nj-course-progress-nums') || {}).textContent || ''));
      out.completedAdvanced = true;
      out.progressAfter = (document.querySelector('.nj-course-progress-nums') || {}).textContent || '';
      // + 新目标：表单可开（入口不灰置），创建提交键灰置 + 无 Key 明确文案
      const newBtn = document.querySelector('.nj-course-new');
      newBtn.click();
      await sleep(200);
      const createBtn = document.querySelector('.nj-course-create');
      out.formGrayed = !!createBtn && createBtn.disabled === true;
      out.warnShown = /AI Key/.test((document.querySelector('.nj-course-warn') || {}).textContent || '');
      // Esc 关浮层（卫生）
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await sleep(200);
      out.escCloses = !document.querySelector('.nj-course-modal');
      return out;
    } catch (e) {
      return { ...out, error: String((e && e.stack) || e).slice(0, 700) };
    }
  })()`);
    Object.assign(out, phase);
  } catch (e) {
    out.error = String((e && e.stack) || e).slice(0, 400);
  }
  win.destroy();
  if (out.error) console.error('course UI probe error:', out.error);
  return out;
}
