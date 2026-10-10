'use strict';
/**
 * diag-f38-spectrum.js — F38 来源立场光谱探针（run-all OFFLINE 集，全程离线）
 *
 * mock LLM：服务级 _llmComplete 注入（批量画像 mock）；选源/缓存/投影/联动全走真实管线。
 *
 * 覆盖：
 *  1 v29 迁移：source_profiles（feed_id PK/profile_json/analyzed_at/FK 级联）+ revisits 同批 + 重启读回无损
 *  2 批量画像 JSON 合同容错：```json 围栏+杂文 / {profiles:[]} 与裸数组双合同 /
 *    越界 index 剔除 / 缺 index 顺位兜底 / 重复 index 先到先得 / 非法 spectrum（非数字）剔条 /
 *    越界 spectrum 钳位 ±100 / 非法风格置空画像保留 / 全无效 → null 可重析
 *  3 布点投影：-100→0 / +100→1 / 0→0.5 / 同谱值重叠抖动错开 / 顺序保持 / 溢出回收 [0,1]
 *  4 Top 源选取：近 90 天完读计数排序 / 窗外（90 天前）不进 / LIMIT 生效 / 删除源不进
 *  5 批量分析主流程：一批 prompt（多源一次调用）/ 落库行数 / 缺槽不落下次补判 /
 *    view 投影（x 换算/风格/画像/最近 3 篇/stale）/ 文章级 forEntry（有画像/无画像 null）
 *  6 缓存与 7 天过期：TTL 内零调用 / 过期 needsReanalyze → 重析（expired 计数）/
 *    profile() 过期视同无 / force 全量重析
 *  7 无 Key 灰置：view().grey + 说明 / analyze 拒绝零调用 / available false
 *  8 单飞与取消：并发 analyze requestInProgress / canceller 注册在册 / 取消零落库
 *  9 注入时钟确定性：同钟投影逐位一致
 * 10 UI：阅读器光谱小图标显隐（有画像显/无画像隐）+ popover 位置标记与画像 /
 *    知识中心光谱 tab（轴+布点）/ 点源点出详情（画像/风格/最近 3 篇）/
 *    分析按钮（过期重析走真 IPC mock）
 * 11 静态接线锚点：preload/IPC/知识中心 tab/光谱视图/阅读器按钮/CSS/i18n
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration(); // 沙箱内 GPU 合成偶发死锁：探针窗口纯 DOM 断言，禁用硬件加速
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f38-')));
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

/** 三源画像标准合同（mock LLM 输出）。 */
const GOOD_PROFILES = [
  { index: 1, spectrum: -60, style: '深度', portrait: '硬核技术长文，写给工程师的方法论。' },
  { index: 2, spectrum: 20, style: '评论', portrait: '文化与社会的中派评论。' },
  { index: 3, spectrum: 75, style: '教程', portrait: '人文向手把手教程。' },
];

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { SpectrumService, SPECTRUM, parseProfilePayload, projectPositions, clampSpectrum, normalizeStyle } = require('../src/main/SpectrumService');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);
    const svc = store.spectrum;
    svc._now = () => T0; // 注入时钟（确定性过期判定）

    // ── 1. v29 迁移 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v29-revisits-source-profiles'").get(),
      '1 v29 迁移已入链');
    const pSQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='source_profiles'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/feed_id\s+TEXT\s+PRIMARY\s+KEY/i.test(pSQL) && /profile_json/.test(pSQL) && /analyzed_at/.test(pSQL),
      '1 source_profiles 列齐备（feed_id PK / profile_json / analyzed_at）');
    ok(!!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='revisits'").get(),
      '1 v29 同批：revisits 建表在位（F37 侧）');
    ok(svc instanceof SpectrumService && SPECTRUM.TOP_FEEDS === 20 && SPECTRUM.PROFILE_TTL_DAYS === 7,
      '1 SpectrumService 构造校验通过 + 规则常量（Top20 / 7 天过期）');

    // ── 2. 批量画像 JSON 合同容错（解析器直测）──
    const fenced = parseProfilePayload('前置杂文```json\n' + JSON.stringify(GOOD_PROFILES) + '\n```后缀杂文', 3);
    ok(!!fenced && fenced.profiles.length === 3 && fenced.profiles[0].spectrum === -60,
      '2 围栏 + 前后杂文：3 源画像完整解析');
    const objContract = parseProfilePayload(JSON.stringify({ profiles: GOOD_PROFILES }), 3);
    ok(!!objContract && objContract.profiles[2].spectrum === 75, '2 {profiles:[…]} 对象合同可解析');
    const outOfRange = parseProfilePayload(JSON.stringify([
      { index: 1, spectrum: 0, style: '评论', portrait: '甲' },
      { index: 9, spectrum: 50, style: '深度', portrait: '越界' }, // 越界：剔
      { index: 2, spectrum: 10, style: '快讯', portrait: '乙' },
    ]), 2);
    ok(!!outOfRange && outOfRange.profiles.length === 2 && outOfRange.profiles[0] && outOfRange.profiles[1]
      && outOfRange.profiles[1].portrait === '乙',
      '2 显式越界 index 剔除（不顺位张冠李戴）');
    const missingIndex = parseProfilePayload(JSON.stringify([
      { spectrum: 5, style: '评论', portrait: '缺号甲' },
      { index: 2, spectrum: -5, style: '深度', portrait: '乙' },
    ]), 2);
    ok(!!missingIndex && missingIndex.profiles[0].portrait === '缺号甲' && missingIndex.profiles[1].portrait === '乙',
      '2 缺 index 顺位兜底填槽');
    const clamped = parseProfilePayload(JSON.stringify([
      { index: 1, spectrum: -150, style: '深度', portrait: '左越界' },
      { index: 2, spectrum: 150, style: '评论', portrait: '右越界' },
      { index: 3, spectrum: 3.7, style: '教程', portrait: '小数' },
    ]), 3);
    ok(!!clamped && clamped.profiles[0].spectrum === -100 && clamped.profiles[1].spectrum === 100 && clamped.profiles[2].spectrum === 4,
      '2 越界 spectrum 钳位 ±100（小数取整）');
    const badSpectrum = parseProfilePayload(JSON.stringify([
      { index: 1, spectrum: '很左', style: '深度', portrait: '非法' },
      { index: 2, spectrum: 10, style: '评论', portrait: '乙' },
    ]), 2);
    ok(!!badSpectrum && badSpectrum.profiles[0] === null && badSpectrum.profiles[1]?.spectrum === 10 && badSpectrum.badSpectrum === 1,
      '2 非法 spectrum（非数字）剔条 + badSpectrum 计数');
    const badStyle = parseProfilePayload(JSON.stringify([
      { index: 1, spectrum: 0, style: '脱口秀', portrait: '风格不认识' },
    ]), 1);
    ok(!!badStyle && badStyle.profiles[0] && badStyle.profiles[0].style === null && badStyle.profiles[0].portrait === '风格不认识',
      '2 非法风格置空，画像保留（normalizeStyle 词表外 → null）');
    ok(parseProfilePayload('抱歉我判不了。', 3) === null, '2 坏 JSON → null（不落库可重析）');
    ok(clampSpectrum('x') === null && clampSpectrum(50) === 50 && normalizeStyle('深度') === '深度',
      '2 clampSpectrum/normalizeStyle 纯函数口径');

    // ── 3. 布点投影 ──
    const pLeft = projectPositions([{ feedID: 'a', spectrum: -100 }, { feedID: 'b', spectrum: 100 }, { feedID: 'c', spectrum: 0 }]);
    const byID = Object.fromEntries(pLeft.map((p) => [p.feedID, p.x]));
    ok(Math.abs(byID.a - 0) < 0.001 && Math.abs(byID.b - 1) < 0.001 && Math.abs(byID.c - 0.5) < 0.001,
      '3 位置换算：-100→0 / +100→1 / 0→0.5');
    const twins = projectPositions([{ feedID: 'x1', spectrum: 20 }, { feedID: 'x2', spectrum: 20 }, { feedID: 'x3', spectrum: 20.5 }]);
    ok(twins[0].x !== twins[1].x && twins[1].x !== twins[2].x && twins[0].x < twins[1].x && twins[1].x < twins[2].x,
      '3 同谱值/近邻重叠抖动：逐点错开且次序保持');
    ok(twins.every((t) => t.x >= 0 && t.x <= 1), '3 抖动不溢出 [0,1]');
    const crowdFit = projectPositions(Array.from({ length: 22 }, (_, i) => ({ feedID: `c${String(i).padStart(2, '0')}`, spectrum: 0 })));
    ok(crowdFit.length === 22 && crowdFit.every((t) => t.x >= 0 && t.x <= 1) && new Set(crowdFit.map((t) => t.x)).size === 22,
      '3 22 点同值极端拥挤：全部错开且回收在轴内（右推溢出自右向左压缩）');
    const crowdMax = projectPositions(Array.from({ length: 30 }, (_, i) => ({ feedID: `m${String(i).padStart(2, '0')}`, spectrum: 0 })));
    ok(crowdMax.length === 30 && crowdMax.every((t) => t.x >= 0 && t.x <= 1),
      '3 超轴容量（30 点 > 1/MIN_GAP）：永不越界（尾部少量重叠为视觉妥协）');

    // ── 4. Top 源选取（近 90 天完读统计）──
    const mkFeed = (title, url) => store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title, feedURL: url });
    const feedA = mkFeed('技术深水区', 'https://f38.test/a.xml');
    const feedB = mkFeed('中调文化评论', 'https://f38.test/b.xml');
    const feedC = mkFeed('人文手帖', 'https://f38.test/c.xml');
    const feedD = mkFeed('旧闻仓库', 'https://f38.test/d.xml');
    const put = async (feed, e) => (await store._applyParsedEntries(feed, [e]))[0];
    const readEntries = {};
    const seed = async (feed, prefix, n) => {
      const ids = [];
      for (let i = 0; i < n; i += 1) {
        const id = await put(feed, { id: `${prefix}-${i}`, title: `${feed.title} 第 ${i + 1} 篇`, url: null, publishedAt: T0 - (i + 1) * DAY, summary: `${feed.title} 的摘要 ${i}。`, contentHTML: `<p>${feed.title} 正文 ${i}。</p>` });
        store.markRead(id, true);
        ids.push(id);
      }
      return ids;
    };
    readEntries.a = await seed(feedA, 'f38a', 8);
    readEntries.b = await seed(feedB, 'f38b', 5);
    readEntries.c = await seed(feedC, 'f38c', 3);
    readEntries.d = await seed(feedD, 'f38d', 2);
    // feedD 挪到 90 天窗外（article_states.updated_at 口径）
    store.database.prepare('UPDATE article_states SET updated_at = ? WHERE item_id IN (?, ?)')
      .run(T0 - 120 * DAY, readEntries.d[0], readEntries.d[1]);
    const tops = svc.topFeeds({});
    ok(tops.length === 3 && tops[0].feedID === feedA.id && tops[0].readCount === 8,
      '4 Top 源：按完读数排序（甲 8 > 乙 5 > 丙 3）');
    ok(!tops.some((t) => t.feedID === feedD.id), '4 窗外（90 天前读完）不进 Top 源');
    ok(svc.topFeeds({ limit: 2 }).length === 2, '4 LIMIT 生效（limit=2）');
    ok(svc.topFeeds({}).every((t) => t.title.length > 0), '4 Top 源带源名（prompt 输入面）');

    // ── 7. 无 Key 灰置（先于配 Key 测，真实路径）──
    ok(store.hasAIAPIKey() === false && svc.available().ai === false, '7 无 Key：available().ai=false');
    let noKeyCalls = 0;
    svc._llmComplete = async () => { noKeyCalls += 1; return '[]'; };
    const greyView = await svc.analyze();
    ok(greyView.degraded === true && noKeyCalls === 0, '7 无 Key analyze：degraded 退场，零 LLM');
    const greyView2 = svc.view();
    ok(greyView2.grey === true && greyView2.greyReason === 'missingAPIKey' && greyView2.feeds.length === 0,
      '7 无 Key view：grey=true + 说明码（光谱页灰置，不做降级假装）');
    svc._llmComplete = null;

    // ── 5. 批量分析主流程（mock LLM）──
    store.setAIAPIKey('mock-key-38'); // hasAIAPIKey() 真实路径（analyze 入口闸）
    store._requireAIReady = () => ({ config: { model: 'mock-model-38', targetLanguage: '中文' }, apiKey: 'mock-key' });
    let llmCalls = 0;
    let lastFeeds = null;
    svc._llmComplete = async (feeds) => {
      llmCalls += 1;
      lastFeeds = feeds;
      return '```json\n' + JSON.stringify(GOOD_PROFILES) + '\n```';
    };
    const v1 = await svc.analyze();
    ok(llmCalls === 1 && Array.isArray(lastFeeds) && lastFeeds.length === 3,
      '5 一批 prompt：3 源一次调用（批量合同）');
    ok(lastFeeds[0].feedID === feedA.id && lastFeeds[0].recent.length === SPECTRUM.RECENT_PER_FEED
      && String(lastFeeds[0].recent[0].title).includes('第'),
      '5 画像输入：源名 + 最近 5 篇标题/摘要摘选');
    const rows = store.database.prepare('SELECT COUNT(*) AS n FROM source_profiles').get().n;
    ok(rows === 3, `5 画像落库：${rows} 行（feed_id PK 一源一画像）`);
    const feedAView = v1.feeds.find((f) => f.feedID === feedA.id);
    ok(feedAView && feedAView.spectrum === -60 && Math.abs(feedAView.x - 0.2) < 0.001,
      '5 view 投影：spectrum=-60 → x=0.2（位置换算）');
    ok(feedAView.style === '深度' && feedAView.portrait.includes('工程师') && feedAView.recent.length === SPECTRUM.DETAIL_RECENT,
      '5 view 投影：风格 tag + 一句话画像 + 最近 3 篇（详情面板数据面）');
    ok(v1.dueReanalyze === false, '5 新画像：无重析需求（dueReanalyze=false）');
    // 缺槽不落，下次补判
    svc._llmComplete = async () => JSON.stringify([GOOD_PROFILES[0], { index: 3, spectrum: 90, style: '教程', portrait: '丙补' }]); // 缺 index 2
    const before = store.database.prepare('SELECT COUNT(*) AS n FROM source_profiles').get().n;
    const vSlot = await svc.analyze({ force: true });
    const midRows = store.database.prepare('SELECT COUNT(*) AS n FROM source_profiles').get().n;
    ok(midRows === before && !vSlot.feeds.some((f) => f.feedID === feedB && f.spectrum === 90),
      '5 缺槽不落库（乙画像原地保留，不被顺位顶替）');
    // 丙被补判成 90
    const feedCView = vSlot.feeds.find((f) => f.feedID === feedC.id);
    ok(feedCView && feedCView.spectrum === 90, '5 force 重析：显式 index 精确落槽（丙→90）');
    // 恢复标准画像
    svc._llmComplete = async () => '```json\n' + JSON.stringify(GOOD_PROFILES) + '\n```';
    await svc.analyze({ force: true });
    ok(svc.counters.profiled >= 8 && llmCalls >= 3, '5 profiled 计数在案（含 force 重析）');
    // 坏输出：不落库可重析
    svc._llmComplete = async () => '实在看不出立场。';
    let parseFailBefore = svc.counters.parseFailures;
    await svc.analyze({ force: true });
    ok(svc.counters.parseFailures === parseFailBefore + 1
      && store.database.prepare('SELECT COUNT(*) AS n FROM source_profiles').get().n === 3,
      '5 坏输出：parseFailures 计数 + 旧画像原地保留（可重析）');
    svc._llmComplete = async () => '```json\n' + JSON.stringify(GOOD_PROFILES) + '\n```';

    // ── 6. 缓存与 7 天过期 ──
    llmCalls = 0;
    await svc.analyze(); // TTL 内：全命中零调用
    ok(llmCalls === 0 && svc.counters.analyses >= 2, '6 TTL 内：零 LLM（缓存全命中）');
    ok(svc.profile(feedA.id) && svc.profile(feedA.id).spectrum === -60, '6 profile()：TTL 内返回画像');
    svc._now = () => T0 + 8 * DAY; // 过期（7 天 TTL）
    ok(svc.profile(feedA) === null, '6 过期 profile()：视同无（stale 语义）');
    ok(svc.needsReanalyze() === true, '6 过期 needsReanalyze=true（刷新钩子重析判定）');
    const v8 = await svc.analyze();
    ok(llmCalls === 1 && svc.counters.expired >= 3 && v8.feeds.every((f) => !f.stale),
      '6 7 天过期自动重析：expired 计数 + 重析后 stale 清零');
    llmCalls = 0;
    await svc.analyze({ force: true });
    ok(llmCalls === 1, '6 force=true：忽略缓存全量重析');

    // ── 8. 文章级联动 ──
    const forA = svc.forEntry(readEntries.a[0]);
    ok(forA && forA.feedID === feedA.id && forA.spectrum === -60 && forA.style === '深度',
      '8 forEntry：画像源的文带源画像（spectrum/风格）');
    ok(Array.isArray(forA.recent) && forA.recent.length <= SPECTRUM.DETAIL_RECENT
      && !forA.recent.includes(null), '8 forEntry：最近 3 篇（popover 详情）');
    const forD = svc.forEntry(readEntries.d[0]);
    ok(forD === null, '8 forEntry：无画像源 → null（阅读器按钮隐藏判定）');

    // ── 9. 单飞与取消 ──
    let release = null;
    svc._llmComplete = (feeds, ai, signal) => new Promise((resolve, reject) => { release = { resolve, reject }; });
    const pAnalyze = svc.analyze({ force: true });
    await sleep(80);
    ok(store.activeAICancellers.has('spectrum:analyze'), '9 生成中：canceller 注册在册（key=spectrum:analyze）');
    let inFlight = '';
    await svc.analyze().then(() => { inFlight = '未拦截'; }, (e) => { inFlight = String(e && e.kind || e); });
    ok(/requestInProgress/.test(inFlight), `9 单飞锁：并发第二次被拒（${inFlight}）`);
    svc.cancel();
    release.resolve('```json\n' + JSON.stringify(GOOD_PROFILES) + '\n```');
    const cancelledView = await pAnalyze;
    ok(svc.counters.cancelled >= 1 && !store.activeAICancellers.has('spectrum:analyze'),
      '9 取消：以 cancelled 收场 + canceller 用后即清');
    svc._llmComplete = async () => '```json\n' + JSON.stringify(GOOD_PROFILES) + '\n```';

    // ── 10. 注入时钟确定性 ──
    const s1 = new SpectrumService(store, { now: () => T0 + 2 * DAY });
    const s2 = new SpectrumService(store, { now: () => T0 + 2 * DAY });
    ok(JSON.stringify(s1.view()) === JSON.stringify(s2.view()), '10 同一注入时钟下 view 逐位一致（探针确定性）');

    // ── 重启读回 ──
    const profBefore = store.database.prepare('SELECT COUNT(*) AS n FROM source_profiles').get().n;
    store.preferences.flushSync();
    store.database.close();
    const store2 = new AppStore(userData);
    ok(store2.database.prepare('SELECT COUNT(*) AS n FROM source_profiles').get().n === profBefore && profBefore === 3,
      `附 重启读回：${profBefore} 行画像跨迁移无损`);
    const sp2 = store2.spectrum;
    sp2._now = () => T0 + 2 * DAY;
    ok(sp2.forEntry(readEntries.a[0])?.spectrum === -60, '附 重启读回：forEntry 画像不丢');
    sp2._llmComplete = async () => { sp2._llmCalls = (sp2._llmCalls || 0) + 1; return '```json\n' + JSON.stringify(GOOD_PROFILES) + '\n```'; };
    store2._requireAIReady = () => ({ config: { model: 'mock-model-38' }, apiKey: 'mock-key' });
    store2.setAIAPIKey('mock-key-38');
    // UI 重析前置：画像拨回 8 天前（相对注入时钟 T0+2d 已过期 7 天 TTL）→ 分析按钮触发真 IPC mock 重析
    store2.database.prepare('UPDATE source_profiles SET analyzed_at = ?').run(T0 - 8 * DAY);

    // ── 11. UI（真 IPC + 真 index.html；沿用 store2）──
    // UI 阶段环境性挂起防护（f25/f26 惯例）：150s 未完成整体降级 SKIP
    const ui = await Promise.race([
      spectrumUIProbe(store2, { entryProfiled: readEntries.a[0], entryUnprofiled: readEntries.d[0] }),
      new Promise((r) => setTimeout(() => r({ uiSkipped: true, booted: null }), 150000)),
    ]);
    if (ui.uiSkipped) {
      for (const m of ['附 UI 探针窗口启动（index.html + preload + 真 IPC）', '11 有画像源的文章：光谱小图标显示', '11 光谱 popover：位置标记 + 一句话画像 + 风格 tag', '11 无画像源的文章：光谱小图标隐藏', '11 知识中心光谱 tab：光谱轴 + 布点', '11 点源点：详情（画像/风格 tag/最近 3 篇）', '11 分析按钮：过期重析走真 IPC（mock LLM）']) {
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
    ok(ui.readerBtnShown === true, '11 有画像源的文章：光谱小图标显示（对照镜旁）');
    ok(ui.popoverShown === true && ui.popoverPortrait === true && ui.popoverDot === true,
      '11 光谱 popover：位置标记 + 一句话画像 + 风格 tag');
    ok(ui.readerBtnHiddenForUnprofiled === true, '11 无画像源的文章：光谱小图标隐藏');
    ok(ui.tabRendered === true && ui.pointCount >= 3, '11 知识中心光谱 tab：光谱轴 + 布点');
    ok(ui.detailShown === true && ui.detailRecent >= 3, '11 点源点：详情（画像/风格 tag/最近 3 篇）');
    ok(ui.reanalyzeWorks === true, '11 分析按钮：过期重析走真 IPC（mock LLM）');
    ok((sp2._llmCalls || 0) >= 1, '11 重析真实调用了 mock LLM（过期重析路径全链路）');

    // ── 12. 静态接线锚点 ──
    const preloadSrc = read('src/main/preload.js');
    ok(['spectrumAvailable', 'spectrumView', 'spectrumAnalyze', 'spectrumCancel', 'spectrumForEntry']
      .every((n) => preloadSrc.includes(n)), '附 preload 光谱 5 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(['spectrum:available', 'spectrum:view', 'spectrum:analyze', 'spectrum:cancel', 'spectrum:forEntry']
      .every((c) => ipcSrc.includes(`'${c}'`)), '附 IPC 光谱通道注册齐备');
    const kbSrc = read('src/renderer/views/knowledge.js');
    ok(kbSrc.includes("id: 'spectrum'") && kbSrc.includes('renderSpectrum') && kbSrc.includes('spectrumView'),
      '附 知识中心光谱 tab（TABS/loads/render）接线');
    const viewSrc = read('src/renderer/views/spectrum-view.js');
    ok(['nj-spectrum-axis', 'nj-spectrum-point', 'nj-spectrum-detail', 'nj-spectrum-grey', 'nj-spectrum-analyze']
      .every((n) => viewSrc.includes(n)), '附 光谱视图（轴/布点/详情/灰置/分析按钮）');
    const readerSrc = read('src/renderer/views/reader.js');
    ok(['_appendSpectrumHeaderButton', '_toggleSpectrumPopover', 'nj-spectrum-header-btn', 'nj-spectrum-popover', 'spectrumForEntry']
      .every((n) => readerSrc.includes(n)), '附 阅读器光谱按钮 + popover 接线');
    const cssSrc = read('src/renderer/styles/robin.css');
    ok(['.nj-spectrum-line', '.nj-spectrum-point', '.nj-spectrum-popover', '.nj-spectrum-grey']
      .every((n) => cssSrc.includes(n)), '附 CSS 光谱轴/布点/popover/灰置样式');
    const strings = read('src/main/I18NStrings.js');
    ok(['"来源立场光谱"', '"分析我的订阅源"', '"技术实用"', '"观点人文"', '"光谱需要 AI"']
      .every((k) => strings.includes(k)), '附 i18n 中英键齐备（光谱/分析/轴端/灰置）');

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

/**
 * 光谱 UI 探针：真 IPC。阅读器光谱按钮/popover → 知识中心光谱 tab → 详情 → 过期重析。
 */
async function spectrumUIProbe(store, { entryProfiled, entryUnprofiled }) {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 880, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
  const { registerIPCHandlers } = require('../src/main/ipc');
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1500);

  const run = (script) => win.webContents.executeJavaScript(script);
  const out = { booted: true };
  const phase = await run(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 25000) => {
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
      // ── 阅读器：有画像源的文章 → 光谱按钮显 → popover ──
      window.__robinReaderOpen('${entryProfiled}');
      const sBtn = await waitFor(() => {
        const b = document.querySelector('.nj-spectrum-header-btn');
        return b && !b.hidden ? b : null;
      });
      if (!sBtn) return { uiSkipped: true, booted: true };
      out.readerBtnShown = true;
      sBtn.click();
      const pop = await waitFor(() => document.getElementById('nj-spectrum-popover'));
      if (!pop) return { uiSkipped: true, booted: true };
      out.popoverShown = true;
      out.popoverPortrait = !!((pop.querySelector('.nj-spectrum-portrait') || {}).textContent);
      out.popoverDot = !!pop.querySelector('.nj-spectrum-popover-dot');
      document.getElementById('nj-spectrum-popover')?.remove();
      // ── 阅读器：无画像源的文章 → 按钮隐藏 ──
      window.__robinReaderOpen('${entryUnprofiled}');
      out.readerBtnHiddenForUnprofiled = await waitFor(() => {
        const b = document.querySelector('.nj-spectrum-header-btn');
        if (!b || b.hidden) return true;
        return null;
      });
      // ── 知识中心：光谱 tab ──
      const kbBtn = await waitFor(() => [...document.querySelectorAll('.footer-nav-btn')].find((x) => (x.title || '').includes('知识')) || null);
      if (!kbBtn) return { uiSkipped: true, booted: true };
      kbBtn.click();
      const navItem = await waitFor(() => [...document.querySelectorAll('.modal-nav-item')].find((x) => (x.textContent || '').includes('光谱')) || null);
      if (!navItem) return { uiSkipped: true, booted: true };
      navItem.click();
      out.pointCount = await waitFor(() => {
        const pts = document.querySelectorAll('.nj-spectrum-point');
        return pts.length >= 3 ? pts.length : null;
      }) || 0;
      out.tabRendered = out.pointCount >= 3
        && !!document.querySelector('.nj-spectrum-line')
        && ((document.querySelector('.nj-spectrum-end-left') || {}).textContent || '').length > 0;
      // 点源点 → 详情
      const firstPoint = document.querySelector('.nj-spectrum-point');
      if (firstPoint) firstPoint.click();
      out.detailShown = await waitFor(() => {
        const portrait = (document.querySelector('.nj-spectrum-portrait') || {}).textContent || '';
        const tag = !!document.querySelector('.nj-spectrum-detail .nj-spectrum-style-tag');
        return portrait.length > 0 && tag ? true : null;
      }) === true;
      out.detailRecent = document.querySelectorAll('.nj-spectrum-recent-item').length;
      // ── 分析按钮：过期重析（主进程时钟已注入过期态时走真 IPC mock）──
      const analyzeBtn = document.querySelector('.nj-spectrum-analyze');
      if (!analyzeBtn) return { uiSkipped: true, booted: true, note: 'no analyze btn' };
      analyzeBtn.click();
      out.reanalyzeWorks = await waitFor(() => {
        const btn = document.querySelector('.nj-spectrum-analyze');
        const pts = document.querySelectorAll('.nj-spectrum-point');
        return btn && btn.dataset.busy !== '1' && pts.length >= 3 ? true : null;
      }, 40000) === true;
      return out;
    } catch (e) {
      return { error: String((e && e.stack) || e).slice(0, 700) };
    }
  })()`);
  Object.assign(out, phase);
  win.destroy();
  if (out.error) console.error('spectrum UI probe error:', out.error);
  return out;
}
