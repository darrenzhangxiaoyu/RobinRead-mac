'use strict';
/**
 * diag-f29-weekly.js — F29 AI 周刊编辑部探针（run-all OFFLINE 集，全程离线、mock LLM）
 *
 * 覆盖：
 *  1 v26 迁移：weeklies 建表（status CHECK + week_start UNIQUE 防重）+ 索引；courses/course_days 留待 f30
 *  2 聚合窗口：周一起止（本地时区）——窗外（更早/更晚）文章不进版面，窗口内标题/来源/标签/批注齐全
 *  3 无 Key 模板降级真实渲染：template=true / 无 AI 导语 / 按标签聚合 + 完读排行 / 批注金句
 *  4 mock LLM 生成：导语/板块/金句合同 + 容错解析（编造文章 ID 板块整块丢弃 / 编造金句逐字校验出局）
 *  5 week_start 唯一防重：重复生成幂等返回（alreadyReady）/ 原生 INSERT 冲突拒绝
 *  6 生成中取消 + 失败重试：canceller 注册与清理 / status=failed + error / 重试翻 ready
 *  7 自动触发钩子：周一触发上周刊 / 周内一次节流 / 非 Monday 跳过 / AppStore 刷新钩子接线
 *  8 EPUB 导出结构：ZIP 魔数 / mimetype / OPF 书名=知更周刊第 N 期 / 板块分章 / 金句末章
 *  9 重启读回：周刊跨迁移无损 / 期号升序稳定 / 列表倒序
 * 10 UI（真 IPC + index.html）：侧栏入口 → 报头（刊名/期号/日期范围）/ 板块卡 / 金句卡 / 历史列表 / 模板标注
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f29-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const DAY = 86400;
// 探针基准：本周周一正午（本地时区，DST 安全）
const T0 = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return Math.floor(d.getTime() / 1000); })();
const WEEK1 = `${new Date(T0 * 1000).getFullYear()}-${String(new Date(T0 * 1000).getMonth() + 1).padStart(2, '0')}-${String(new Date(T0 * 1000).getDate()).padStart(2, '0')}`;
const WEEK0 = (() => { const d = new Date((T0 - 7 * DAY) * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const WEEK_M1 = (() => { const d = new Date((T0 - 14 * DAY) * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

const QUOTE_SENTENCE = '阅读是把别人的百年换成自己的片刻，慢下来才能真的看见。';
const BODY = `<h2>慢阅读</h2><p>${QUOTE_SENTENCE}因此本周值得重读一遍。</p>`;

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { WeeklyService, WEEKLY, localDayStart, mondayOf, lastWeekStart, isMondayKey, parseWeeklyRaw } = require('../src/main/WeeklyService');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);
    const svc = store.weekly;
    ok(svc instanceof WeeklyService, '附 WeeklyService 随 AppStore 构造（F29 接线）');

    // ── UI 窗提前开（进程年轻时原生导航健康；高载下年老进程的 loadFile 曾同步卡死桌面堆）──
    // 真 IPC + index.html 早加载，DOM 断言放在探针末段（此时周刊数据已就位）
    const uiWin = await openUIWindow(store);

    // ── 1. v26 迁移 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v26-weeklies-courses'").get(),
      '1 v26 迁移已入链');
    const wkSQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='weeklies'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/status\b[^,]*CHECK\s*\(\s*status\s+IN\s+\('generating'\s*,\s*'ready'\s*,\s*'failed'\)/i.test(wkSQL), '1 weeklies status CHECK（generating|ready|failed）在位');
    const uniqIdx = store.database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_weeklies_week'").get()?.sql || '';
    ok(/UNIQUE/i.test(uniqIdx) && /week_start/i.test(uniqIdx), '1 week_start UNIQUE 索引在位（防重地基）');
    const daySQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='course_days'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/PRIMARY\s+KEY\s*\(\s*course_id\s*,\s*day\s*\)/i.test(daySQL), '1 course_days PK(course_id,day) 即 UNIQUE（F30 共用 v26）');
    ok(!!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='courses'").get(), '1 courses 表在位（F30 共用 v26）');

    // ── 场景源：本周 3 篇 + 窗外 2 篇 + 标签 + 批注 ──
    const mkFeed = (title, url) => store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title, feedURL: url });
    const feed = mkFeed('慢读周刊源', 'https://f29.test/a.xml');
    const feed2 = mkFeed('机器学习源', 'https://f29.test/b.xml');
    const put = async (f, e) => (await store._applyParsedEntries(f, [e]))[0];
    const mk = (id, title, summary) => ({ id, title, url: `https://f29.test/x/${id}`, publishedAt: T0 - 2 * DAY, summary, contentHTML: BODY });
    const entryW1 = await put(feed, mk('f29-w1', '慢阅读宣言（甲）', `${QUOTE_SENTENCE}这是甲的摘要。`));
    const entryW2 = await put(feed, mk('f29-w2', '深水区读书法（乙）', '深水区的阅读需要整块时间。'));
    const entryW3 = await put(feed2, mk('f29-w3', '梯度下降直觉（丙）', '梯度下降像蒙眼下山。'));
    const entryOld = await put(feed, mk('f29-old', '窗口之前的文章', '在周刊窗口开始前读完。'));
    const entryFuture = await put(feed, mk('f29-future', '窗口之后的文章', '在周刊窗口结束后才读。'));
    ok(!!entryW1 && !!entryW2 && !!entryW3 && !!entryOld && !!entryFuture, '附 场景源灌入 5 篇');
    const readAt = async (entryID, at) => { store.markRead(entryID, true); store.database.prepare('UPDATE article_states SET updated_at = ? WHERE item_id = ?').run(at, entryID); };
    await readAt(entryW1, T0 + 1 * DAY);
    await readAt(entryW2, T0 + 2 * DAY);
    await readAt(entryW3, T0 + 3 * DAY);
    await readAt(entryOld, T0 - 2 * DAY);   // 窗口前（上周更早）
    await readAt(entryFuture, T0 + 8 * DAY); // 窗口后（本周）
    store.knowledge.addManualTag(entryW1, '慢读');
    store.knowledge.addManualTag(entryW2, '慢读');
    store.knowledge.addManualTag(entryW3, '机器学习');
    const hl = store.knowledge.addHighlight({ itemID: entryW1, text: QUOTE_SENTENCE, color: 'yellow', note: '本周最触动的一句。', createdAt: undefined });
    store.database.prepare('UPDATE highlights SET created_at = ? WHERE id = ?').run(T0 + 2 * DAY, hl.id);
    ok(!!hl?.id, '附 窗口内批注落库（created_at 拨进窗口）');

    // ── 2. 聚合窗口（周一起止）──
    ok(mondayOf(T0) === WEEK1 && mondayOf(T0 + 6 * DAY) === WEEK1 && mondayOf(T0 + 7 * DAY) !== WEEK1,
      '2 mondayOf：周一~周日同周，下周一起换周');
    ok(isMondayKey(WEEK1) && !isMondayKey(WEEK0.slice(0, 8) + '9'), '2 isMondayKey：周一判定');
    const data = svc.weekData(WEEK1);
    const ids = data.reads.map((r) => r.entryID);
    ok(localDayStart(WEEK1) === T0 - 12 * 3600 && data.start === T0 - 12 * 3600 && data.end === data.start + 7 * DAY,
      '2 窗口=[周一 00:00, +7天)（本地时区秒级）');
    ok(ids.includes(entryW1) && ids.includes(entryW2) && ids.includes(entryW3), '2 窗口内 3 篇全收');
    ok(!ids.includes(entryOld) && !ids.includes(entryFuture), '2 窗外文章不进版面（读时窗=article_states.updated_at）');
    ok(data.reads.every((r) => r.title && r.sourceTitle), '2 完读文章带标题+来源');
    const w1row = data.reads.find((r) => r.entryID === entryW1);
    ok(Array.isArray(w1row.tags) && w1row.tags.includes('慢读'), '2 聚合带标签（article_tags 投影）');
    ok(data.annotations.length === 1 && data.annotations[0].text.includes('百年换成自己的片刻'), '2 批注摘选进聚合（金句候选）');

    // ── 3. 无 Key 模板降级（真实渲染：新库无 Key）──
    ok(svc.available().ai === false, '3 无 Key：available().ai=false');
    let tpl = null;
    let emptyErr = '';
    try { tpl = await svc.generateWeek(WEEK_M1, { origin: 'manual' }); } catch (e) { emptyErr = String(e.message); }
    ok(/没有阅读记录/.test(emptyErr), '3 空窗口 → 明确报错（模板也不做无米之炊）');
    tpl = svc.getByWeek(WEEK_M1);
    ok(tpl.status === 'failed' && /没有阅读记录/.test(tpl.error), '3 空窗口落 failed 行（可重试）');
    const entryM1 = await put(feed, mk('f29-m1', '上上周的文章（丁）', '上上周读完，走模板版面。'));
    await readAt(entryM1, T0 - 14 * DAY + 3 * DAY);
    const tpl2 = await svc.generateWeek(WEEK_M1, { origin: 'manual' });
    ok(tpl2.status === 'ready' && tpl2.content && tpl2.content.template === true, '3 无 Key 降级：模板版面（template=true）');
    ok(tpl2.content.intro === null, '3 模板版无 AI 导语（不伪造 AI 口吻）');
    ok(tpl2.content.sections.length >= 1 && tpl2.content.sections.some((s) => s.title === '完读排行'), '3 模板版含「完读排行」板块');
    ok(tpl2.content.sections.some((s) => s.entries.some((e) => e.entryID === entryM1)), '3 模板版面收录窗口内文章');
    ok(Array.isArray(tpl2.content.quotes), '3 模板版金句数组在位（本周无批注可为空）');

    // ── 4. mock LLM 生成（合同 + 容错解析）──
    const fakeJSON = JSON.stringify({
      intro: '这一周你把阅读放慢了一档：慢读的两篇讲的是同一件事——给注意力留出整块时间。'.repeat(1),
      sections: [
        { title: '慢读专题', summary: '两篇慢读文章互为注脚：一篇讲宣言，一篇讲方法。', entryIDs: [entryW1, entryW2] },
        { title: '编造板块', summary: '这一块引用了不存在的文章。', entryIDs: ['local:feed:fake-1', 'local:feed:fake-2'] },
        { title: '混合板块', summary: '一篇真文 + 一篇编造，剔编造后保留真文。', entryIDs: [entryW3, 'local:feed:fake-3'] },
      ],
      quotes: [
        { text: QUOTE_SENTENCE, entryID: entryW1 },
        { text: '这句话在任何文章里都找不到，是模型编造的。', entryID: entryW1 },
      ],
    });
    store._requireAIReady = () => ({ config: {}, apiKey: 'probe-key' }); // stub Key（探针离线）
    svc._llmComplete = async () => fakeJSON;
    const ai = await svc.generateWeek(WEEK1, { origin: 'manual' });
    ok(ai.status === 'ready' && ai.content && ai.content.template === false, '4 AI 版面生成落库（status=ready，template=false）');
    ok(typeof ai.content.intro === 'string' && ai.content.intro.length <= WEEKLY.INTRO_MAX && ai.content.intro.includes('慢'), '4 导语合同：≤200 字进版面');
    ok(ai.content.sections.length === 2, '4 编造 ID 板块整块丢弃（3 板块 → 2）');
    const mixed = ai.content.sections.find((s) => s.title === '混合板块');
    ok(mixed && mixed.entries.length === 1 && mixed.entries[0].entryID === entryW3, '4 混合板块：编造 ID 剔除，真文保留');
    ok(ai.content.quotes.length === 1 && ai.content.quotes[0].text === QUOTE_SENTENCE && ai.content.quotes[0].entryID === entryW1,
      '4 金句逐字校验：真句带出处收录，编造金句出局');
    ok(typeof ai.issue === 'number' && ai.issue >= 1, `4 期号在案（第 ${ai.issue} 期）`);
    ok(svc.snapshot().generated === 1 && svc.snapshot().parseFailures === 0, '4 生成计数在案（解析零失败）');
    // 坏输出：无法解析 → failed 可重试
    svc._llmComplete = async () => '这是模型的一堆废话，没有 JSON。';
    let badErr = '';
    try { await svc.generateWeek(WEEK0, { origin: 'manual' }); } catch (e) { badErr = String(e.message); }
    const badRow = svc.getByWeek(WEEK0);
    ok(/无法识别/.test(badErr) && badRow.status === 'failed' && /无法解析/.test(badRow.error), '4 坏输出 → invalidResponse + failed 行保留可重试');
    ok(svc.snapshot().parseFailures === 1, '4 解析失败计数在案');

    // ── 5. week_start 唯一防重 ──
    svc._llmComplete = async () => fakeJSON;
    const again = await svc.generateWeek(WEEK1, { origin: 'manual' });
    ok(again.alreadyReady === true && again.id === ai.id, '5 ready 期重复生成：幂等返回（alreadyReady）');
    ok(store.database.prepare('SELECT COUNT(*) AS n FROM weeklies WHERE week_start = ?').get(WEEK1).n === 1, '5 同周仍只一行（UNIQUE 防重）');
    let dupErr = '';
    try {
      store.database.prepare("INSERT INTO weeklies (id, week_start, status, created_at, updated_at) VALUES ('f29-dup', ?, 'ready', 1, 1)").run(WEEK1);
    } catch (e) { dupErr = String(e.message); }
    ok(/UNIQUE/i.test(dupErr), `5 原生 INSERT 撞 UNIQUE 被拒（${dupErr.slice(0, 24)}…）`);

    // ── 6. 生成中取消 + 失败重试 ──
    ok([...store.activeAICancellers.keys()].filter((k) => k.startsWith('weekly:')).length === 0, '6 静默期无在途 canceller');
    let resolveHang;
    svc._llmComplete = (data, ai, signal) => new Promise((resolve, reject) => {
      resolveHang = { resolve, reject };
      signal?.addEventListener('abort', () => reject(new Error('cancelled'))); // mock 响应取消
    });
    const hangPromise = svc.generateWeek(WEEK0, { origin: 'manual' }); // 上次 failed → 重试进 generating
    await sleep(60);
    const runningKeys = [...store.activeAICancellers.keys()].filter((k) => k.startsWith('weekly:'));
    ok(runningKeys.length === 1 && runningKeys[0] === `weekly:${WEEK0}`, '6 生成中 canceller 注册（key=weekly:<weekStart>）');
    store.cancelAI(`weekly:${WEEK0}`);
    const cancelled = await hangPromise;
    ok(cancelled.status === 'failed' && /取消/.test(cancelled.error || ''), '6 取消后：status=failed + 可重试文案');
    ok([...store.activeAICancellers.keys()].filter((k) => k.startsWith('weekly:')).length === 0, '6 canceller 已清理（finally）');
    // 按周感知 mock：WEEK1 用固定合同，其余周按窗口实况生成（文章/金句都来自真窗口）
    svc._llmComplete = async (data) => {
      if (data.weekStart === WEEK1) return fakeJSON;
      const r = data.reads[0];
      return JSON.stringify({
        intro: '按窗口实况排的一期。',
        sections: [{ title: '窗口实况', summary: '本期只此一篇。', entryIDs: data.reads.map((x) => x.entryID) }],
        quotes: [{ text: r.summary.split('。')[0] + '。', entryID: r.entryID }],
      });
    };
    const retried = await svc.generateWeek(WEEK0, { origin: 'manual' });
    ok(retried.status === 'ready' && retried.content.template === false, '6 失败期重试翻 ready（AI 版面）');

    // ── 7. 自动触发钩子（周一 + 周内一次节流）──
    svc._now = () => T0; // 注入时钟：T0 是周一
    store.database.prepare("UPDATE weeklies SET status = 'failed' WHERE week_start = ?").run(WEEK0); // 失败期可被自动触发重试
    store.preferences.remove(`RobinRead.weekly.autoAttempt.${WEEK0}`);
    const kick = svc.autoCheck();
    ok(kick.triggered === true && kick.weekStart === WEEK0 && typeof kick.promise?.then === 'function', '7 周一 autoCheck：触发上周刊后台生成');
    const kicked = await kick.promise;
    ok(kicked && kicked.status === 'ready' && kicked.content && kicked.content.weekStart === WEEK0, '7 自动生成完成（ready + 事件数据面）');
    const skip = svc.autoCheck();
    ok(skip.triggered === false && skip.reason === 'alreadyAttempted', '7 周内一次节流：第二次 autoCheck 跳过');
    svc._now = () => T0 + 8 * DAY; // 下周二
    const notMonday = svc.autoCheck();
    ok(notMonday.triggered === false && notMonday.reason === 'notMonday', '7 非 Monday：notMonday 跳过');
    svc._now = () => T0; // 拨回（后续探针窗口仍以 T0 计）
    const appSrc = read('src/main/AppStore.js');
    ok(/this\.weekly\.autoCheck\(\)/.test(appSrc) && /周刊生成失败静默/.test(appSrc), '7 AppStore 刷新完成钩子接线（autoCheck + 静默容错）');

    // ── 8. EPUB 导出结构 ──
    const weeklyForEpub = svc.getByWeek(WEEK1);
    const epub = svc.buildEpub(weeklyForEpub.id);
    ok(Buffer.isBuffer(epub) && epub.length > 1000, '8 buildEpub 返回非空 Buffer');
    ok(epub.subarray(0, 2).toString('latin1') === 'PK', '8 ZIP 魔数（PK）在位');
    ok(epub.toString('latin1').includes('application/epub+zip'), '8 mimetype 条目在位（EPUB 合同）');
    const utf8 = epub.toString('utf8');
    ok(new RegExp(`<dc:title>[^<]*知更周刊 第 ${weeklyForEpub.issue} 期`).test(utf8.replace(/\s+/g, ' ')), `8 OPF 书名=知更周刊第 ${weeklyForEpub.issue} 期（buildBookEpub 通路）`);
    ok(utf8.includes('慢读专题') && utf8.includes('金句摘录'), '8 板块分章 + 金句末章进 EPUB');
    ok(utf8.includes(QUOTE_SENTENCE.slice(0, 12)), '8 金句原句进 EPUB 正文');
    let noEpub = '';
    try { svc.buildEpub('f29-not-exist'); } catch (e) { noEpub = String(e.message); }
    ok(/尚未生成完成/.test(noEpub), `8 非 ready 期导出拒绝（${noEpub.slice(0, 18)}…）`);

    // ── 9. 静态接线锚点 ──
    const preloadSrc = read('src/main/preload.js');
    ok(['weeklyAvailable', 'weeklyGenerate', 'weeklyCancel', 'weeklyList', 'weeklyGet', 'weeklyExport', 'onWeeklyChanged']
      .every((n) => preloadSrc.includes(n)), '9 preload 周刊 7 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(['weekly:available', 'weekly:generate', 'weekly:cancel', 'weekly:list', 'weekly:get', 'weekly:export', "store.on('weekly:changed'"]
      .every((c) => ipcSrc.includes(c)), '9 IPC 周刊通道 + 完成推送注册齐备');
    const sidebarSrc = read('src/renderer/views/sidebar.js');
    ok(['footer-weekly-btn', 'onOpenWeekly', 'footer-course-btn', 'onOpenCourse'].every((n) => sidebarSrc.includes(n)),
      '9 侧栏周刊/课程入口接线（F29+F30 同块）');
    const viewSrc = read('src/renderer/views/weekly-view.js');
    ok(['nj-weekly-masthead', 'nj-weekly-name', 'nj-weekly-issue', 'nj-weekly-range', 'nj-weekly-section', 'nj-weekly-quote', 'nj-weekly-history-row', '__robinWeeklyView']
      .every((n) => viewSrc.includes(n)), '9 周刊视图报头/板块/金句/历史渲染锚点齐备');
    const appSrc2 = read('src/renderer/app.js');
    ok(['openWeeklyView', 'WeeklyView', 'onWeeklyChanged', "t('本周刊已排好版，来看看吧。')"].every((n) => appSrc2.includes(n)),
      '9 app.js 周刊浮层入口 + 后台生成 toast 接线');
    const cssSrc = read('src/renderer/styles/robin.css');
    ok(cssSrc.includes('.nj-weekly-masthead') && cssSrc.includes('.nj-weekly-quote') && !/border-radius: (?:4|6|7|8|10|12|14)px/.test(cssSrc.slice(cssSrc.indexOf('F29 知更周刊'))),
      '9 CSS 周刊版面在位且新块零 radius 字面量');
    const strings = read('src/main/I18NStrings.js');
    ok(['"知更周刊"', '"生成上周周刊"', '"金句摘录"', '"历史期刊"', '"本周刊已排好版，来看看吧。"']
      .every((k) => strings.includes(k)), '9 i18n 周刊键齐备（双语表）');

    // ── 10. UI（真 IPC + index.html；窗口已开场加载，此刻周刊数据全部就位）──
    const ui = await weeklyUIProbe(uiWin);
    ok(ui.booted, '附 UI 探针页面就绪（index.html + preload + 真 IPC）');
    ok(ui.opened === true, '10 侧栏「周刊」点击 → 周刊浮层');
    ok(ui.masthead === true && ui.mastheadName.includes('知更周刊'), '10 报头：刊名《知更周刊》衬线大字');
    ok(ui.issueShown === true && /第 \d+ 期/.test(ui.issueText), `10 报头：期号（${ui.issueText}）`);
    ok(ui.rangeShown === true && /\d{4}-\d{2}-\d{2}/.test(ui.rangeText), `10 报头：日期范围（${ui.rangeText}）`);
    ok(ui.sectionCount >= 1 && ui.sectionTexts.join(' ').length > 0, `10 板块卡渲染（${ui.sectionCount} 块：${ui.sectionTexts.join(' / ').slice(0, 30)}…）`);
    ok(ui.quoteCount >= 1 && ui.quoteTexts.join('').length > 0, `10 金句卡渲染（${ui.quoteCount} 条；历史导航=${!!ui.historyNav}）`);
    ok(ui.historyNav === true && ui.quoteTexts.join('').includes('百年换成自己的片刻'), '10 历史导航到 AI 版期：逐字原句金句卡在位');
    ok(ui.historyCount >= 1, `10 历史期刊列表渲染（${ui.historyCount} 行，期号倒序）`);
    ok(ui.entryRows >= 1, '10 板块入选文章行渲染（点击直达阅读）');
    ok(ui.escCloses === true, '10 Esc 关浮层（卫生）');

    // ── 11. 重启读回（老库无损；UI 窗已关，连接安全交接）──
    const weeklyCount = store.database.prepare('SELECT COUNT(*) AS n FROM weeklies').get().n;
    const readyCount = store.database.prepare("SELECT COUNT(*) AS n FROM weeklies WHERE status='ready'").get().n;
    store.preferences.flushSync();
    store.database.close();
    const store2 = new AppStore(userData);
    ok(store2.database.prepare('SELECT COUNT(*) AS n FROM weeklies').get().n === weeklyCount && weeklyCount >= 3,
      `11 重启读回：${weeklyCount} 期周刊跨迁移无损`);
    ok(store2.database.prepare("SELECT COUNT(*) AS n FROM weeklies WHERE status='ready'").get().n === readyCount, '11 重启读回：ready 期数不变');
    const list = store2.weekly.list();
    ok(list.length === weeklyCount && list[0].createdAt >= list[list.length - 1].createdAt, '11 历史列表：期号倒序（新→旧）');
    const issues = list.map((w) => w.issue).sort((a, b) => a - b);
    ok(issues.every((n, i) => n === i + 1), `11 期号升序连续 1..N（${issues.join(',')}）`);
    ok(list.every((w) => !w.content || typeof w.content === 'object'), '11 content_json 反序列化健全');
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
 * DOM 断言由 weeklyUIProbe 在末段执行（此刻周刊数据已全部就位）。
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

/** 周刊 UI DOM 探针：侧栏入口 → 报头/板块/金句/历史渲染断言（窗口由 openUIWindow 预建）。 */
async function weeklyUIProbe(win) {
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
      // 侧栏「周刊」入口 → 浮层
      const btn = await waitFor(() => document.querySelector('.footer-weekly-btn'));
      out.btnFound = !!btn;
      btn.click();
      const modal = await waitFor(() => document.querySelector('.nj-weekly-modal'));
      out.opened = !!modal;
      // 报头（刊名/期号/日期范围）
      const head = await waitFor(() => document.querySelector('.nj-weekly-masthead'));
      out.masthead = !!head;
      out.mastheadName = (document.querySelector('.nj-weekly-name') || {}).textContent || '';
      out.issueText = (document.querySelector('.nj-weekly-issue') || {}).textContent || '';
      out.rangeText = (document.querySelector('.nj-weekly-range') || {}).textContent || '';
      out.issueShown = out.issueText.includes('期');
      out.rangeShown = out.rangeText.includes('—');
      // 板块卡与入选文章行
      out.sectionCount = document.querySelectorAll('.nj-weekly-section').length;
      out.sectionTexts = [...document.querySelectorAll('.nj-weekly-section-title')].map((n) => n.textContent);
      out.entryRows = document.querySelectorAll('.nj-weekly-entry').length;
      // 金句卡（最新一期 + 历史导航到 AI 版那期）
      out.quoteCount = document.querySelectorAll('.nj-weekly-quote').length;
      out.quoteTexts = [...document.querySelectorAll('.nj-weekly-quote-text')].map((n) => n.textContent);
      // 历史期刊：点开含 ${JSON.stringify(WEEK1)} 的那期（AI 版），金句应含「百年换成自己的片刻」
      const row = [...document.querySelectorAll('.nj-weekly-history-row')].find((n) => n.textContent.includes(${JSON.stringify(WEEK1)}));
      if (row) {
        row.click();
        await waitFor(() => [...document.querySelectorAll('.nj-weekly-quote-text')].some((n) => n.textContent.includes('百年换成自己的片刻')));
        out.quoteTexts = [...document.querySelectorAll('.nj-weekly-quote-text')].map((n) => n.textContent);
        out.historyNav = true;
      }
      // 历史期刊
      out.historyCount = document.querySelectorAll('.nj-weekly-history-row').length;
      // Esc 关浮层（卫生）
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await sleep(200);
      out.escCloses = !document.querySelector('.nj-weekly-modal');
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
  if (out.error) console.error('weekly UI probe error:', out.error);
  return out;
}
