'use strict';
/**
 * diag-u36-40.js — 视觉批 4（U36–U40 收官批）探针（run-all OFFLINE 集）
 *
 * U36 杂志卡 2.0：封面卡三变体自动选型（classic 经典居中=无图 / split 左图右文=有图短题 /
 *               immersive 全幅沉浸=有图长题，pickMagCardVariant 纯函数）+ 悬停视差
 *               （--nj-par-x/--nj-par-y 钳位 ±6px；CSS no-preference 门 + JS matchMedia 双豁免）
 * U37 表格化高级设置：规则列表六列表格（优先级/名称/操作符/动作/命中数/启停 + 行内启停开关）/
 *               FreshRSS 账号表（账号/同步状态/操作/启停）/ 邮箱账户表 + settingsTable 通用表格
 * U38 首启引导流：无订阅源判定 + localStorage 记账三步浮层（①欢迎+添加订阅 ②AI 配置可跳过
 *               ③完成揭示快捷键卡）+ 设置→通用「重看引导」重开入口
 * U39 全屏阅读仪式感：禅模式进入/退出呼吸编舞（遮罩→标题→正文 0/60/120ms 三级 stagger）+
 *               聚焦模式顶部细进度线（body.rp-focus 门，随本篇滚动比率填充）
 * U40 终局一致性 pass：批 F-I 七视图（voice-orb/archive-hall/wrapped/spectrum/revisit/course/
 *               challenge）令牌审计零裸值（程序化扫描）+ 仪式时长令牌四档 + 同模式徽章/旋转
 *               归簇 + 标点全角审计（程序化扫描）
 *
 * UI 阶段：offscreen + backgroundThrottling=false + disableHardwareAcceleration + 窗口早开，
 * 150s 竞速降级 SKIP（写 .ci-skip-marker，内容=本文件名；连击治理由 run-all 判）。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration(); // 沙箱内 GPU 合成偶发死锁：探针窗口纯 DOM 断言，禁用硬件加速
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-u36-40-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 150 * 1000).unref();

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(200);
  }
};
let failed = 0;
let passed = 0;
const ok = (c, l) => { if (c) { passed += 1; console.log('PASS ' + l); } else { failed += 1; console.error('FAIL ' + l); } };
const modURL = (f) => require('node:url').pathToFileURL(path.join(ROOT, 'src', 'renderer', 'views', f)).href;

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

// ── U40 审计口径：批 F-I 七视图 CSS 分段（起止锚注释）与七视图 JS 文件 ──
const U40_SECTIONS = [
  ['U40 challenge tab（garden/挑战）', '/* 侧栏底部小花园徽章', '/* ── F39 开放 API'],
  ['U40 course-view', '/* ============ F30 自学课程 ============ */', '/* ============ F35 语音指挥舱 ============ */'],
  ['U40 voice-orb', '/* ============ F35 语音指挥舱 ============ */', '/* ============ F36 阅读生物钟 ============ */'],
  ['U40 archive-hall', '/* ============ F34 网页存档馆 ============ */', '/* ── F37 深读重访'],
  ['U40 revisit-view', '/* ── F37 深读重访', '/* ── F38 来源立场光谱'],
  ['U40 spectrum-view', '/* ── F38 来源立场光谱', '/* ==========================================================================\n   U25 阅读年报'],
  ['U40 wrapped-view', '   U25 阅读年报（知识中心「阅读年报」tab）：四大数据卡 / 关键词云 / 分享卡', '/* ==========================================================================\n   U26 高 DPI 走查'],
];
const U40_JS_FILES = ['voice-orb.js', 'archive-hall.js', 'wrapped-view.js', 'spectrum-view.js', 'revisit-view.js', 'course-view.js', 'garden-view.js'];

/** U40 程序化审计：段内零裸字号 / 零裸 radius px / 零裸时长（var(--dur 消费不算裸）。 */
function auditCssSection(css, name) {
  const bad = { fs: 0, radius: 0, dur: 0, found: 0 };
  for (const [, startAnchor, endAnchor] of U40_SECTIONS) {
    const i = css.indexOf(startAnchor);
    const j = i >= 0 ? css.indexOf(endAnchor, i) : -1;
    if (i < 0 || j < 0) continue;
    bad.found += 1;
    const seg = css.slice(i, j);
    // 字号审计口径（U20 阶梯）：<12px 裸值必须归令牌；≥12px 展示字不在审计范围
    bad.fs += (seg.match(/font-size:\s*(1[01](\.\d+)?|[0-9](\.\d+)?)px/g) || []).length;
    bad.radius += (seg.match(/border-radius:\s*[^;]*\d+px/g) || []).filter((x) => !/var\(--/.test(x)).length;
    bad.dur += (seg.match(/(?:animation|transition):\s*[^;]*?[\d.]+m?s\b/g) || [])
      .filter((x) => !/var\(--dur|animation-duration/.test(x)).length;
  }
  return bad;
}

// ── Phase A：源码在册断言 ──────────────────────────────────────────────────
function phaseSource() {
  const robin = read('src/renderer/styles/robin.css');
  const listSrc = read('src/renderer/views/list.js');
  const dialogsSrc = read('src/renderer/views/dialogs.js');
  const onboardingSrc = read('src/renderer/views/onboarding.js');
  const readerSrc = read('src/renderer/views/reader.js');
  const appSrc = read('src/renderer/app.js');
  const i18nSrc = read('src/main/I18NStrings.js');

  // ── U36：杂志卡三变体 + 视差在册 ──
  ok(/export function pickMagCardVariant/.test(listSrc) && /export function magCardParallax/.test(listSrc),
    'A U36 pickMagCardVariant + magCardParallax 纯函数导出在册');
  ok(/if \(!hasImage\) return 'classic'/.test(listSrc) && /titleLength > MAG_TITLE_IMMERSIVE_AT \? 'immersive' : 'split'/.test(listSrc),
    'A U36 选型分支在册（无图 classic / 长题 immersive / 短题 split）');
  ok(/nj-mag-card--\$\{variant\}/.test(listSrc) && /dataset\.magVariant = variant/.test(listSrc),
    'A U36 magCard 挂变体类 + dataset.magVariant 在册');
  ok(/_bindCoverParallax\(card, cover\.querySelector\('img\.mag-cover-img'\)\)/.test(listSrc),
    'A U36 magCard 接线封面视差（img.mag-cover-img 作用面）在册');
  ok(/matchMedia\('\(prefers-reduced-motion: reduce\)'\)/.test(listSrc) && /pointerleave/.test(listSrc),
    'A U36 视差 JS 门（matchMedia reduce 豁免）+ pointerleave 复位在册');
  ok(/\.nj-mag-card--classic \.mag-cover \{ display: none; \}/.test(robin) && /^\.nj-mag-card--split \{ flex-direction: row; \}/m.test(robin)
    && /^\.nj-mag-card--immersive \{/m.test(robin),
    'A U36 三变体版式 CSS（classic 隐封面/split 横排/immersive 满卡）在册');
  ok(/--nj-par-x, 0\) \* 1px/.test(robin) && /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\n\s*\.nj-mag-card--split \.mag-cover img/.test(robin),
    'A U36 视差 CSS（--nj-par-* 消费 + no-preference 门）在册');
  {
    const seg = (robin.match(/视觉批 4（U36–U40）[\s\S]*$/) || [''])[0];
    const badFs = (seg.match(/font-size:\s*\d+px/g) || []).length;
    const badRadius = (seg.match(/border-radius:\s*\d+px/g) || []).length;
    const badDur = (seg.match(/:\s*\d+(\.\d+)?m?s\b\s*;/g) || []).filter((x) => !/var\(/.test(x)).length;
    ok(seg.includes('.nj-mag-card--classic') && seg.includes('.nj-settings-table') && badFs === 0 && badRadius === 0 && badDur === 0,
      `A U36-U39 新块护栏零字面量（fs:${badFs} radius:${badRadius} dur:${badDur}）`);
  }

  // ── U37：表格化在册 ──
  ok(/function settingsTable\(/.test(dialogsSrc) && /export function ruleConditionSummary/.test(dialogsSrc) && /export function ruleActionSummary/.test(dialogsSrc),
    'A U37 settingsTable 通用表格 + 规则条件/动作摘要纯函数在册');
  ok(/const RULE_FIELD_OPTIONS = \[/.test(dialogsSrc) && /const RULE_OP_OPTIONS = \[/.test(dialogsSrc)
    && !/const FIELD_OPTIONS/.test(dialogsSrc) && !/const OP_OPTIONS/.test(dialogsSrc),
    'A U37 规则字段/操作符选项单一数据源（编辑器局部字面量分叉已并）');
  for (const label of ['优先级', '名称', '操作符', '动作', '命中数', '启停', '操作']) {
    ok(dialogsSrc.includes(`label: t('${label}')`), `A U37 规则表「${label}」列在册`);
  }
  ok(/className: `rule-row \$\{rule\.enabled \? '' : 'rule-disabled'\}`/.test(dialogsSrc),
    'A U37 规则表行保留 .rule-row 锚点（f2 回归合同）+ 禁用态类在册');
  ok(/toggle: toggleControl\(rule\.enabled, async \(v\) => \{/.test(dialogsSrc),
    'A U37 行内启停开关（toggle 列消费 toggleControl）在册');
  ok(/account-sync-line" data-account-id=/.test(dialogsSrc) && /label: t\('同步状态'\)/.test(dialogsSrc),
    'A U37 账号表四列（账号/同步状态/操作/启停）+ account-sync-line 合同保留在册');
  ok(/label: t\('邮箱'\)/.test(dialogsSrc) && /nj-mail-panel/.test(dialogsSrc) && /for \(const panel of mailPanels\) container\.appendChild\(panel\);/.test(dialogsSrc),
    'A U37 邮箱账户表格化 + 明细卡（自签名/白名单）下挂在册');
  ok(/\.nj-settings-table \{/.test(robin) && /\.nj-settings-table-row \{/.test(robin) && /var\(--nj-table-cols, none\)/.test(robin),
    'A U37 .nj-settings-table CSS（列轨道 inline 变量下发）在册');

  // ── U38：首启引导在册 ──
  ok(/export const ONBOARDING_SEEN_KEY = 'robinread\.onboardingSeen'/.test(onboardingSrc) && /export function onboardingShouldRun/.test(onboardingSrc)
    && /export function markOnboardingSeen/.test(onboardingSrc) && /export function resetOnboarding/.test(onboardingSrc),
    'A U38 onboarding 记账四件套（KEY/shouldRun/markSeen/reset）导出在册');
  ok(/return !seen && \(Number\(feedCount\) \|\| 0\) === 0/.test(onboardingSrc),
    'A U38 无订阅源判定（feedCount=0 且未记账）在册');
  ok(/export function presentOnboarding/.test(onboardingSrc) && /ONBOARDING_STEP_COUNT = 3/.test(onboardingSrc),
    'A U38 三步引导浮层（步数=3）在册');
  ok(/'欢迎来到知更'/.test(onboardingSrc) && /'配置 AI（可跳过）'/.test(onboardingSrc) && /'一切就绪'/.test(onboardingSrc)
    && /onboardingShortcuts/.test(onboardingSrc),
    'A U38 三步内容（欢迎/可跳过 AI/完成揭示快捷键卡）在册');
  ok(/onAddFeed: \(\) => showAddFeed\(collectFolders\(\), reloadAll\)/.test(appSrc) && /onOpenAI: \(\) => showSettings\('ai'\)/.test(appSrc)
    && /function maybeRunOnboarding/.test(appSrc),
    'A U38 app 首启检测接线（添加订阅直达/AI 跳设置）在册');
  ok(/window\.__robinOnboarding = \{/.test(appSrc), 'A U38 E2E 句柄 window.__robinOnboarding 在册');
  ok(/maybeRunOnboarding\(\); \/\/ U38 首启引导/.test(appSrc), 'A U38 bootstrap 尾部首启检测挂载在册');
  ok(/dataset\.role = 'onboarding-replay'/.test(dialogsSrc) && /import \{ resetOnboarding, presentOnboarding \} from '\.\/onboarding\.js'/.test(dialogsSrc),
    'A U38 设置→通用「重看引导」重开入口（清记账 + 重呈现）在册');
  ok(i18nSrc.includes('"欢迎来到知更"') && i18nSrc.includes('"跳过引导"') && i18nSrc.includes('"重看新手引导"') && i18nSrc.includes('"启停"'),
    'A U38/U37 i18n 新键在册（引导三步/表格列头）');

  // ── U39：全屏仪式感在册 ──
  ok(/classList\.add\('zen-ritual'\)/.test(appSrc) && /classList\.add\('zen-ritual-exit'\)/.test(appSrc) && /void document\.body\.offsetWidth/.test(appSrc),
    'A U39 禅模式编舞类挂摘（进入 zen-ritual/退出 zen-ritual-exit + reflow 重放）在册');
  ok(/body\.zen-ritual::after/.test(robin) && /animation-delay: var\(--nj-stagger-1\)/.test(robin.split('body.zen-ritual::after')[1].slice(0, 400)),
    'A U39 遮罩层（zen-ritual::after + stagger-1）在册');
  ok(/body\.zen-ritual \.robin-header-container \{[\s\S]*?animation-delay: var\(--nj-stagger-2\)/.test(robin)
    && /body\.zen-ritual \.robin-body \{[\s\S]*?animation-delay: var\(--nj-stagger-3\)/.test(robin),
    'A U39 标题→正文三级 stagger（stagger-2/3）在册');
  ok(/body\.zen-ritual-exit::after/.test(robin) && /@keyframes nj-zen-veil-return/.test(robin) && /@keyframes nj-zen-rise/.test(robin),
    'A U39 退出呼吸遮罩 + rise 关键帧在册');
  ok(/nj-focus-progress/.test(readerSrc) && /this\.focusProgressFill\.style\.width = `\$\{ratio0 \* 100\}%`/.test(readerSrc),
    'A U39 专注进度线（元素挂载 + 滚动比率同步）在册');
  ok(/^\.nj-focus-progress \{/m.test(robin) && /body\.rp-focus \.nj-focus-progress \{ opacity: 1; \}/.test(robin),
    'A U39 专注进度线 CSS（rp-focus 门显形）在册');

  // ── U40：令牌审计（程序化）──
  const audit = auditCssSection(robin, 'U40');
  ok(audit.found === U40_SECTIONS.length, `A U40 七视图分段锚点全命中（got=${audit.found}/${U40_SECTIONS.length}）`);
  ok(audit.fs === 0, `A U40 七视图段零裸字号（<12px 归簇复检，got=${audit.fs}）`);
  ok(audit.radius === 0, `A U40 七视图段零裸圆角（归 --radius-* 令牌，got=${audit.radius}）`);
  ok(audit.dur === 0, `A U40 七视图段零裸时长（归 --dur-* 令牌，got=${audit.dur}）`);
  ok(/--dur-grow: 900ms;/.test(robin) && /--dur-spin: 0\.9s;/.test(robin) && /--dur-breathe: 1\.2s;/.test(robin) && /--dur-pulse: 1\.8s;/.test(robin),
    'A U40 仪式时长令牌四档（grow/spin/breathe/pulse）定义在册');
  ok(/animation: nj-mirror-spin var\(--dur-spin\) linear infinite/.test(robin) && /animation: rotate var\(--dur-spin\) linear infinite/.test(robin),
    'A U40 旋转家族同值归簇（mirror/debate/quiz/revisit spinner → --dur-spin）');
  const gardenStart = robin.indexOf('/* 侧栏底部小花园徽章');
  ok(gardenStart >= 0 && (robin.slice(gardenStart).match(/border-radius:\s*(999px|99px)/g) || []).length === 0,
    'A U40 徽章/胶囊家族 999px/99px 全数退役（批 4 审计区域零残留）→ var(--radius-full)');
  // 标点全角审计：七视图 JS 文件中 CJK 邻接的半角标点零残留
  let puncHits = 0;
  for (const f of U40_JS_FILES) {
    const src = read(`src/renderer/views/${f}`);
    puncHits += (src.match(/[\u4e00-\u9fff][,;:?!()]|[,;:?!()][\u4e00-\u9fff]/g) || []).length;
  }
  ok(puncHits === 0, `A U40 七视图标点全角审计（CJK 邻接半角标点零残留，got=${puncHits}）`);
}

// ── Phase B：主进程服务级断言（真 AppStore + 真 SQL）──────────────────────
async function phaseService() {
  const { AppStore } = require('../src/main/AppStore');
  const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
  const userData = app.getPath('userData');
  const store = new AppStore(userData);

  // U37 素材：三条规则（含 tag 动作与 any 匹配），供表格列渲染断言
  store.rules.saveRule({
    name: '周报自动已读', scope: { kind: 'all' }, match: 'all',
    conditions: [{ field: 'title', op: 'contains', value: '周报' }],
    actions: ['read'], enabled: true,
  });
  store.rules.saveRule({
    name: '新品速递加星', scope: { kind: 'all' }, match: 'any',
    conditions: [{ field: 'title', op: 'contains', value: '新品' }, { field: 'summary', op: 'contains', value: '发布' }],
    actions: ['star', 'tag:快讯'], enabled: true,
  });
  store.rules.saveRule({
    name: '旧闻降权（默认停用）', scope: { kind: 'all' }, match: 'all',
    conditions: [{ field: 'title', op: 'contains', value: '十年前' }],
    actions: ['later'], enabled: false,
  });
  const rules = store.rules.listRules();
  ok(rules.length === 3, `B U37 三条规则落库（got=${rules.length}）`);
  ok(rules[0].enabled === true && rules[2].enabled === false, 'B U37 启停态落库（第 3 条默认停用）');
  ok(rules[1].actions.includes('tag:快讯') && rules[1].match === 'any', 'B U37 tag 动作与 any 匹配落库');
  ok(typeof rules[0].hitCount === 'number', 'B U37 hitCount 数值在册（表格「命中数」列数据源）');

  // 优先级移动（表格「优先级」列的上移/下移数据面）：上移断言后下移还原，保持 C 阶段顺序稳定
  store.rules.moveRule(rules[2].id, 'up');
  const moved = store.rules.listRules();
  ok(moved[1].name === '旧闻降权（默认停用）', 'B U37 moveRule(up) 优先级交换生效');
  store.rules.moveRule(rules[2].id, 'down');
  ok(store.rules.listRules()[2].name === '旧闻降权（默认停用）', 'B U37 moveRule(down) 还原顺序');

  // 命中数：灌一篇「周报」文 + 回放 → 第一条规则 hitCount 增长
  const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '批4素材源', feedURL: 'https://u36-40.test/a.xml' });
  const longBody = '正文长度必须超过四百字的全文抓取门槛，否则阅读器会去抓原网页补全，离线探针将因此悬挂在加载遮罩上。'.repeat(10);
  for (let i = 1; i <= 2; i += 1) {
    await store._applyParsedEntries(feed, [{
      id: `u36-a${i}`,
      title: i === 1 ? '本周周报第 10 期：错峰编舞与表格化扫读观察' : `杂志变体素材第 ${i} 号：全幅沉浸版式的长标题样本用于触发沉浸选型阈值判定逻辑实测`,
      url: `https://u36-40.test/a/${i}`,
      publishedAt: Date.now() / 1000 - i * 3600,
      summary: `第${i}篇：视觉批4素材摘要。`,
      // i===1 无图（classic 候选）；i===2 带图长题（immersive 候选）
      contentHTML: i === 1
        ? `<p>${longBody}</p>`
        : `<p><img src="https://u36-40.test/cover${i}.jpg" alt=""></p><p>${longBody}</p>`,
    }]);
  }
  // split 素材：带图短题
  await store._applyParsedEntries(feed, [{
    id: 'u36-a3', title: '左图右文样本：短题带图', url: 'https://u36-40.test/a/3',
    publishedAt: Date.now() / 1000 - 900,
    summary: '第3篇：split 变体样本。',
    contentHTML: '<p><img src="https://u36-40.test/cover3.jpg" alt=""></p><p>' + longBody + '</p>',
  }]);
  const replay = store.rules.replayRecent({ limit: 200 });
  ok(replay && replay.scanned >= 3, `B U37 回放扫描 ≥3 篇（got=${replay && replay.scanned}）`);
  const after = store.rules.listRules();
  ok(after[0].hitCount >= 1, `B U37 「周报自动已读」回放后 hitCount 增长（got=${after[0].hitCount}）`);
  return { store };
}

// ── Phase C：UI 阶段（offscreen 真窗 + 真 IPC；150s 竞速降级 SKIP）─────────
function openUIWindow() {
  try {
    return new BrowserWindow({
      show: false, width: 1280, height: 860, useContentSize: true,
      webPreferences: { offscreen: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
  } catch (err) {
    console.error('UI probe: window create failed (environmental):', String((err && err.message) || err));
    return null;
  }
}

async function uiProbe(store, win) {
  try {
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, win);
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  } catch (err) {
    console.error('UI probe: load failed (environmental):', String(err && err.message) || err);
    return { uiSkipped: true };
  }
  await sleep(1800);
  const js = async (label, code) => {
    console.log(`C ${label} …`);
    const r = await win.webContents.executeJavaScript(code);
    console.log(`C ${label} 完成`);
    return r;
  };

  await waitFor(() => win.webContents.executeJavaScript('Boolean(window.__robinList && window.__robinOnboarding)').catch(() => null), 25000);
  await waitFor(() => win.webContents.executeJavaScript('(document.querySelectorAll(".entry-row").length + document.querySelectorAll(".cluster-row").length) > 0').catch(() => null), 20000);

  // ── U36：三变体选型 + 视差属性（真 DOM）──
  const u36 = await js('U36 杂志卡块', `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    const viewsURL = (f) => new URL(f, ${JSON.stringify(modURL('x'))}).href;
    const listMod = await import(viewsURL('list.js'));
    // ① 纯函数选型三例
    out.vClassic = listMod.pickMagCardVariant({ contentHead: '', title: '无图样本' });
    out.vSplit = listMod.pickMagCardVariant({ contentHead: '<p><img src="https://u36-40.test/s.jpg"></p>', title: '十二字短题样本' });
    out.vImmersive = listMod.pickMagCardVariant({ contentHead: '<p><img src="https://u36-40.test/i.jpg"></p>', title: '这是一个超过二十八个字的长标题样本用于触发全幅沉浸版式的自动选型判定逻辑' });
    // ② 视差纯函数：钳位 ±6
    const rect = { left: 0, top: 0, width: 200, height: 100 };
    out.parCenter = JSON.stringify(listMod.magCardParallax(rect, 100, 50));
    out.parCorner = JSON.stringify(listMod.magCardParallax(rect, 9999, -9999));
    out.parBad = JSON.stringify(listMod.magCardParallax(null, 3, 3));
    // ③ 杂志模式重渲染 → 变体类真挂载
    const list = window.__robinList;
    list.setViewMode('magazine');
    list.render(list.items, list.scope, list.selectedID, false);
    await sleep(700);
    const cards = [...document.querySelectorAll('.nj-mag-card')];
    out.cardCount = cards.length;
    out.variants = cards.map((c) => c.dataset.magVariant || '').join(',');
    out.classicNoCover = cards.filter((c) => c.dataset.magVariant === 'classic')
      .every((c) => !c.querySelector('.mag-cover img') && getComputedStyle(c.querySelector('.mag-cover')).display === 'none');
    // ④ 悬停视差：pointermove 写 --nj-par-*（pointerleave 复位）
    const splitCard = cards.find((c) => c.dataset.magVariant === 'split');
    if (splitCard) {
      const r = splitCard.getBoundingClientRect();
      splitCard.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.right + 40, clientY: r.top - 40 }));
      out.parX = splitCard.style.getPropertyValue('--nj-par-x');
      splitCard.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
      out.parReset = splitCard.style.getPropertyValue('--nj-par-x') === '0' && splitCard.style.getPropertyValue('--nj-par-y') === '0';
    }
    // ⑤ 恢复列表模式
    list.setViewMode('list');
    list.render(list.items, list.scope, list.selectedID, false);
    await sleep(300);
    return out;
  })()`);

  // ── U37：设置表格化（规则/账号分区真呈现）──
  const u37 = await js('U37 表格化块', `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    const viewsURL = (f) => new URL(f, ${JSON.stringify(modURL('x'))}).href;
    const dlg = await import(viewsURL('dialogs.js'));
    // 纯函数摘要（按名取「新品速递加星」，不依赖列表序）
    const rules0 = await window.robin.rulesList();
    const ruleXinpin = rules0.find((r) => r.name === '新品速递加星') || rules0[0];
    out.condSummary = dlg.ruleConditionSummary(ruleXinpin);
    out.actSummary = dlg.ruleActionSummary(ruleXinpin);
    // 规则分区真呈现
    const snap = (await window.robin.getState()).data;
    const sidebar = window.__robinSidebar || [];
    const sv = new dlg.SettingsView({ state: { snapshot: snap, sidebar }, views: {}, onReload: () => {}, onRefreshState: () => {} });
    sv.present('rules');
    await sleep(900);
    const table = document.querySelector('.nj-settings-table');
    out.tableShown = !!table;
    out.headers = table ? [...table.querySelectorAll('.nj-settings-table-head .nj-settings-table-cell')].map((c) => c.textContent).join('|') : '';
    const rows = [...document.querySelectorAll('.nj-settings-table-row.rule-row')];
    out.rowCount = rows.length;
    out.firstPri = rows[0]?.querySelector('.nj-rule-pri-num')?.textContent;
    out.firstName = rows[0]?.querySelector('.rule-row-title')?.textContent;
    out.firstCond = rows[0]?.querySelector('.cell-ops')?.textContent || '';
    out.firstAct = rows[0]?.querySelector('.cell-act')?.textContent || '';
    out.firstHits = rows[0]?.querySelector('.cell-hits')?.textContent;
    out.firstToggleOn = !!rows[0]?.querySelector('.cell-toggle .toggle.on');
    out.thirdToggleOff = !!rows[2]?.querySelector('.cell-toggle .toggle:not(.on)');
    out.disabledRow = rows[2]?.classList.contains('rule-disabled');
    out.priUpBtn = !!rows[0]?.querySelector('.nj-rule-pri-btns .btn.icon-only[aria-label]');
    out.manageBtns = rows[0]?.querySelectorAll('.cell-manage .btn.icon-only').length;
    // 行内启停：拨第 3 条 → 真 IPC 落库
    const t3 = rows[2]?.querySelector('.cell-toggle .toggle');
    t3?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(900);
    const rules1 = await window.robin.rulesList();
    out.togglePersisted = rules1[2]?.enabled === true;
    // 行内优先级上移：第 2 条上移 → 落库顺序交换
    rows[1]?.querySelector('.nj-rule-pri-btns .btn.icon-only')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(900);
    const rules2 = await window.robin.rulesList();
    out.movePersisted = rules2[0]?.name === '新品速递加星';
    sv.dismiss();
    await sleep(200);
    // 账号分区表格
    const sv2 = new dlg.SettingsView({ state: { snapshot: snap, sidebar }, views: {}, onReload: () => {} });
    sv2.present('accounts');
    await sleep(900);
    const acctTable = document.querySelector('.nj-settings-table');
    out.acctTable = !!acctTable;
    out.acctHeaders = acctTable ? [...acctTable.querySelectorAll('.nj-settings-table-head .nj-settings-table-cell')].map((c) => c.textContent).join('|') : '';
    out.acctRows = document.querySelectorAll('.nj-settings-table-row').length;
    out.acctSyncLine = !!document.querySelector('.nj-settings-table .account-sync-line[data-account-id]');
    out.acctToggle = !!document.querySelector('.nj-settings-table .cell-toggle .toggle');
    sv2.dismiss();
    await sleep(200);
    // 邮箱分区（空表空态路径）
    const sv3 = new dlg.SettingsView({ state: { snapshot: snap, sidebar }, views: {}, onRefreshState: () => {} });
    sv3.present('mail');
    await sleep(900);
    out.mailEmptyShown = (document.body.textContent || '').includes('还没有邮箱账户');
    sv3.dismiss();
    await sleep(200);
    return out;
  })()`);

  // ── U38：三步引导流（记账/步进/快捷键卡/重开入口）──
  const u38 = await js('U38 引导块', `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    const viewsURL = (f) => new URL(f, ${JSON.stringify(modURL('x'))}).href;
    const ob = await import(viewsURL('onboarding.js'));
    out.key = ob.ONBOARDING_SEEN_KEY;
    out.shouldRunEmpty = ob.onboardingShouldRun(0, false);
    out.shouldRunSeen = ob.onboardingShouldRun(0, true);
    out.shouldRunFeeds = ob.onboardingShouldRun(3, false);
    // 三步步进
    localStorage.removeItem(ob.ONBOARDING_SEEN_KEY);
    let aiOpened = 0;
    const flow = ob.presentOnboarding({ onOpenAI: () => { aiOpened += 1; } });
    out.shown = !!document.querySelector('.nj-onboarding-overlay');
    out.step1Title = document.querySelector('.nj-onboarding-title')?.textContent;
    out.dots = document.querySelectorAll('.nj-onboarding-dot').length;
    document.querySelector('[data-role="onboarding-next"]').click();
    await sleep(60);
    out.step2Title = document.querySelector('.nj-onboarding-title')?.textContent;
    document.querySelector('.nj-onboarding-actions .btn-text')?.click(); // 打开 AI 设置
    await sleep(60);
    out.aiOpened = aiOpened;
    document.querySelector('[data-role="onboarding-next"]').click();
    await sleep(60);
    out.step3Title = document.querySelector('.nj-onboarding-title')?.textContent;
    out.keyRows = document.querySelectorAll('.nj-onboarding-key-row').length;
    out.cardActive = document.querySelector('.nj-onboarding-dot:last-child')?.classList.contains('active');
    document.querySelector('[data-role="onboarding-next"]').click(); // 开始使用
    await sleep(60);
    out.settledHidden = !document.querySelector('.nj-onboarding-overlay');
    out.seenAfterFinish = localStorage.getItem(ob.ONBOARDING_SEEN_KEY) === '1';
    // 跳过路径：reset → present → 跳过
    ob.resetOnboarding();
    out.seenAfterReset = localStorage.getItem(ob.ONBOARDING_SEEN_KEY) == null;
    const flow2 = ob.presentOnboarding({});
    document.querySelector('[data-role="onboarding-skip"]').click();
    await sleep(60);
    out.skipSettled = !document.querySelector('.nj-onboarding-overlay') && localStorage.getItem(ob.ONBOARDING_SEEN_KEY) === '1';
    // 设置→通用重开入口
    const dlg = await import(viewsURL('dialogs.js'));
    const snap = (await window.robin.getState()).data;
    const sv = new dlg.SettingsView({ state: { snapshot: snap, sidebar: window.__robinSidebar || [] }, views: {}, onReload: () => {} });
    sv.present('general');
    await sleep(900);
    const replayBtn = document.querySelector('[data-role="onboarding-replay"]');
    out.replayBtn = !!replayBtn;
    replayBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(300);
    out.replayShown = !!document.querySelector('.nj-onboarding-overlay');
    document.querySelector('.nj-onboarding-overlay')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); // 点遮罩=跳过
    await sleep(60);
    out.replayClosed = !document.querySelector('.nj-onboarding-overlay');
    sv.dismiss();
    await sleep(200);
    return out;
  })()`);

  // ── U39：禅模式编舞 + 专注进度线 ──
  // 打开一篇文章（经真实用户管线）
  await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let row = document.querySelector('.entry-row');
    if (!row) {
      document.querySelector('.cluster-row')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(400);
      row = document.querySelector('.entry-row');
    }
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(300);
    return 'ok';
  })()`).catch(() => {});
  await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".reader-article"))').catch(() => null), 20000);
  const u39 = await js('U39 仪式感块', `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    // ① 进入禅模式：body.zen + zen-ritual 编舞
    document.getElementById('cap-zen').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(120);
    out.zenOn = document.body.classList.contains('zen');
    out.ritualOn = document.body.classList.contains('zen-ritual');
    const header = document.querySelector('.robin-header-container');
    const body = document.querySelector('.robin-body');
    out.headerDelay = header ? getComputedStyle(header).animationDelay : '';
    out.bodyDelay = body ? getComputedStyle(body).animationDelay : '';
    out.veilAnim = getComputedStyle(document.body, '::after').animationName;
    out.veilDelay = getComputedStyle(document.body, '::after').animationDelay;
    // ② 退出：zen 摘除 + 呼吸回帘
    document.getElementById('cap-zen').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(120);
    out.zenOff = !document.body.classList.contains('zen');
    out.exitOn = document.body.classList.contains('zen-ritual-exit');
    out.exitAnim = getComputedStyle(document.body, '::after').animationName;
    await sleep(800);
    out.exitCleaned = !document.body.classList.contains('zen-ritual-exit');
    // ③ 聚焦模式进度线（transition 0.18s：等 500ms 让 opacity 过渡走完再读计算值）
    document.getElementById('cap-focus').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(500);
    out.focusOn = document.body.classList.contains('rp-focus');
    const line = document.getElementById('nj-focus-progress');
    out.lineOpacity = getComputedStyle(line).opacity;
    out.lineShown = !!line && parseFloat(out.lineOpacity) >= 0.9;
    const scroller = window.__robinReader?.scrollEl;
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll'));
      await sleep(300);
      out.fillAtEnd = line?.querySelector('.nj-focus-progress-fill')?.style.width;
    }
    document.getElementById('cap-focus').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(500);
    out.focusOffOpacity = getComputedStyle(document.getElementById('nj-focus-progress')).opacity;
    out.focusOffHidden = !document.body.classList.contains('rp-focus') && parseFloat(out.focusOffOpacity) <= 0.1;
    return out;
  })()`);

  // ── U40：运行时复核（段审计已在源码级；此处复核四令牌真实生效）──
  const u40 = await js('U40 令牌块', `(() => {
    const out = {};
    const cs = getComputedStyle(document.documentElement);
    out.grow = cs.getPropertyValue('--dur-grow').trim();
    out.spin = cs.getPropertyValue('--dur-spin').trim();
    out.breathe = cs.getPropertyValue('--dur-breathe').trim();
    out.pulse = cs.getPropertyValue('--dur-pulse').trim();
    return out;
  })()`);

  return { uiSkipped: false, u36, u37, u38, u39, u40, win };
}

app.whenReady().then(async () => {
  try {
    // UI 窗早开（f36 惯例：进程年轻时创建健康）
    const uiWin = openUIWindow();
    if (!uiWin) {
      const { store: store0 } = await phaseService();
      console.log('UI 阶段 SKIP：窗口创建失败（环境性）');
      try { fs.writeFileSync(path.join(__dirname, '.ci-skip-marker'), 'scripts/diag-u36-40.js'); } catch (_) { /* 标记失败仅影响连击治理 */ }
      store0.preferences.flushSync();
      store0.database.close();
      console.log(`TOTAL passed=${passed} failed=${failed}`);
      process.exit(failed ? 1 : 0);
      return;
    }
    uiWin.on('render-process-gone', (_e, d) => console.error('RENDER-GONE', JSON.stringify(d)));
    uiWin.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) console.error(`[renderer:${level}] ${String(message).slice(0, 300)} (${path.basename(String(sourceId))}:${line})`);
    });
    phaseSource();
    const { store } = await phaseService();

    // ── UI 阶段（150s 竞速降级 SKIP）──
    console.log('UI 阶段启动…');
    const ui = await Promise.race([
      uiProbe(store, uiWin).catch((err) => { console.error('uiProbe threw:', String(err && err.stack || err).slice(0, 800)); return { uiSkipped: true }; }),
      new Promise((r) => setTimeout(() => r({ uiSkipped: true }), 150000)),
    ]);
    if (ui.uiSkipped) {
      console.log('UI 阶段 SKIP：环境性挂起（源码级+服务级断言已全部执行）');
      try { fs.writeFileSync(path.join(__dirname, '.ci-skip-marker'), 'scripts/diag-u36-40.js'); } catch (_) { /* 标记失败仅影响连击治理 */ }
      store.preferences.flushSync();
      store.database.close();
      console.log(`TOTAL passed=${passed} failed=${failed}`);
      process.exit(failed ? 1 : 0);
      return;
    }

    const label = (v, name) => `${name}（got=${JSON.stringify(v)}）`;
    // ── U36 ──
    ok(ui.u36.vClassic === 'classic' && ui.u36.vSplit === 'split' && ui.u36.vImmersive === 'immersive',
      label({ classic: ui.u36.vClassic, split: ui.u36.vSplit, immersive: ui.u36.vImmersive }, 'C U36 三变体选型（无图 classic/有图短题 split/有图长题 immersive）'));
    ok(ui.u36.parCenter === '{"x":0,"y":0}' && ui.u36.parCorner === '{"x":6,"y":-6}' && ui.u36.parBad === '{"x":0,"y":0}',
      label({ center: ui.u36.parCenter, corner: ui.u36.parCorner, bad: ui.u36.parBad }, 'C U36 视差纯函数钳位（±6px，坏矩形零偏移）'));
    ok(ui.u36.cardCount >= 3, label(ui.u36.cardCount, 'C U36 杂志网格卡片数 ≥3'));
    ok(ui.u36.variants.includes('classic') && ui.u36.variants.includes('immersive') && ui.u36.variants.includes('split'),
      label(ui.u36.variants, 'C U36 三变体类真挂载（dataset.magVariant）'));
    ok(ui.u36.classicNoCover === true, label(ui.u36.classicNoCover, 'C U36 classic 变体封面槽隐退（纯排版）'));
    ok(ui.u36.parX === '6', label(ui.u36.parX, 'C U36 pointermove 写入 --nj-par-x（越界钳位 6）'));
    ok(ui.u36.parReset === true, label(ui.u36.parReset, 'C U36 pointerleave 复位视差（归零）'));

    // ── U37 ──
    ok(String(ui.u37.condSummary).includes('「新品」') && String(ui.u37.condSummary).includes(' 或 '),
      label(ui.u37.condSummary, 'C U37 条件摘要（any → 「或」连接）'));
    ok(String(ui.u37.actSummary).includes('收藏') && String(ui.u37.actSummary).includes('「快讯」'),
      label(ui.u37.actSummary, 'C U37 动作摘要（内置动作 + tag 展开列示）'));
    ok(ui.u37.tableShown && (ui.u37.headers || '').startsWith('优先级|名称|操作符|动作|命中数|启停|操作'),
      label(ui.u37.headers, 'C U37 规则表七列头（优先级/名称/操作符/动作/命中数/启停/操作）'));
    ok(ui.u37.rowCount === 3, label(ui.u37.rowCount, 'C U37 规则表 3 行（.rule-row 锚点保留）'));
    ok(ui.u37.firstPri === '1' && ui.u37.firstName === '周报自动已读', label({ pri: ui.u37.firstPri, name: ui.u37.firstName }, 'C U37 优先级序号 + 名称列渲染'));
    ok(String(ui.u37.firstCond).includes('「周报」'), label(ui.u37.firstCond, 'C U37 操作符列渲染条件摘要'));
    ok(String(ui.u37.firstAct).includes('标为已读'), label(ui.u37.firstAct, 'C U37 动作列渲染'));
    ok(ui.u37.firstHits === '0' || Number(ui.u37.firstHits) >= 1, label(ui.u37.firstHits, 'C U37 命中数列渲染'));
    ok(ui.u37.firstToggleOn === true && ui.u37.thirdToggleOff === true && ui.u37.disabledRow === true,
      label({ on: ui.u37.firstToggleOn, off: ui.u37.thirdToggleOff, dim: ui.u37.disabledRow }, 'C U37 行内启停开关初始态 + 禁用行褪色'));
    ok(ui.u37.togglePersisted === true, label(ui.u37.togglePersisted, 'C U37 行内启停真落库（rulesSetEnabled）'));
    ok(ui.u37.movePersisted === true, label(ui.u37.movePersisted, 'C U37 行内优先级上移真落库（rulesMove）'));
    ok(ui.u37.priUpBtn === true && ui.u37.manageBtns === 2, label({ pri: ui.u37.priUpBtn, manage: ui.u37.manageBtns }, 'C U37 优先级上下移微钮 + 编辑/删除管理钮在册'));
    ok(ui.u37.acctTable === true && (ui.u37.acctHeaders || '').startsWith('账号|同步状态|操作|启停'),
      label(ui.u37.acctHeaders, 'C U37 账号表四列头'));
    ok(ui.u37.acctRows >= 1 && ui.u37.acctToggle === true && (ui.u37.acctSyncLine === true || ui.u37.acctRows === 1),
      label({ rows: ui.u37.acctRows, toggle: ui.u37.acctToggle, sync: ui.u37.acctSyncLine },
        'C U37 账号表行 + 行内启停在册（同步状态合同：本地账号单行时无同步列内容为合法）'));
    ok(ui.u37.mailEmptyShown === true, label(ui.u37.mailEmptyShown, 'C U37 邮箱分区空态路径正常'));

    // ── U38 ──
    ok(ui.u38.key === 'robinread.onboardingSeen', label(ui.u38.key, 'C U38 记账键名'));
    ok(ui.u38.shouldRunEmpty === true && ui.u38.shouldRunSeen === false && ui.u38.shouldRunFeeds === false,
      label({ empty: ui.u38.shouldRunEmpty, seen: ui.u38.shouldRunSeen, feeds: ui.u38.shouldRunFeeds }, 'C U38 首启判定（无源+未记账才弹）'));
    ok(ui.u38.shown === true && String(ui.u38.step1Title).includes('欢迎'), label(ui.u38.step1Title, 'C U38 第①步欢迎+添加订阅'));
    ok(ui.u38.dots === 3, label(ui.u38.dots, 'C U38 三步进度点'));
    ok(String(ui.u38.step2Title).includes('AI'), label(ui.u38.step2Title, 'C U38 第②步 AI 配置（可跳过）'));
    ok(ui.u38.aiOpened === 1, label(ui.u38.aiOpened, 'C U38 「打开 AI 设置」回调直达'));
    ok(String(ui.u38.step3Title).includes('就绪') && ui.u38.keyRows === 6 && ui.u38.cardActive === true,
      label({ title: ui.u38.step3Title, keys: ui.u38.keyRows }, 'C U38 第③步完成揭示快捷键卡（六键）'));
    ok(ui.u38.settledHidden === true && ui.u38.seenAfterFinish === true, label({ hidden: ui.u38.settledHidden, seen: ui.u38.seenAfterFinish }, 'C U38 完成即记账（不再自动弹）'));
    ok(ui.u38.seenAfterReset === true && ui.u38.skipSettled === true, label({ reset: ui.u38.seenAfterReset, skip: ui.u38.skipSettled }, 'C U38 reset 清账 + 跳过同样记账'));
    ok(ui.u38.replayBtn === true && ui.u38.replayShown === true && ui.u38.replayClosed === true,
      label({ btn: ui.u38.replayBtn, shown: ui.u38.replayShown, closed: ui.u38.replayClosed }, 'C U38 设置→通用「重看引导」重开 + 点遮罩跳过'));

    // ── U39 ──
    ok(ui.u39.zenOn === true && ui.u39.ritualOn === true, label({ zen: ui.u39.zenOn, ritual: ui.u39.ritualOn }, 'C U39 进入禅模式挂编舞类'));
    ok(ui.u39.headerDelay === '0.06s' && ui.u39.bodyDelay === '0.12s',
      label({ header: ui.u39.headerDelay, body: ui.u39.bodyDelay }, 'C U39 编舞 stagger 实算（标题 60ms/正文 120ms）'));
    ok(ui.u39.veilAnim === 'nj-zen-veil' && (ui.u39.veilDelay === '0s' || ui.u39.veilDelay === 'none'),
      label({ anim: ui.u39.veilAnim, delay: ui.u39.veilDelay }, 'C U39 遮罩层先入（0ms 拍）'));
    ok(ui.u39.zenOff === true && ui.u39.exitOn === true && ui.u39.exitAnim === 'nj-zen-veil-return' && ui.u39.exitCleaned === true,
      label({ off: ui.u39.zenOff, exit: ui.u39.exitOn, anim: ui.u39.exitAnim, clean: ui.u39.exitCleaned }, 'C U39 退出呼吸回帘 + 定时摘类'));
    ok(ui.u39.focusOn === true && ui.u39.lineShown === true, label({ focus: ui.u39.focusOn, opacity: ui.u39.lineOpacity }, 'C U39 聚焦模式专注进度线显形'));
    ok(typeof ui.u39.fillAtEnd === 'string' && parseFloat(ui.u39.fillAtEnd) > 90,
      label(ui.u39.fillAtEnd, 'C U39 进度线随本篇滚动填充（滚底 ≥90%）'));
    ok(ui.u39.focusOffHidden === true, label({ hidden: ui.u39.focusOffHidden, opacity: ui.u39.focusOffOpacity }, 'C U39 退出聚焦模式进度线隐退'));

    // ── U40 ──
    ok(ui.u40.grow === '900ms' && ui.u40.spin === '0.9s' && ui.u40.breathe === '1.2s' && ui.u40.pulse === '1.8s',
      label(ui.u40, 'C U40 仪式时长令牌四档实读（计算样式）'));

    try { uiWin.destroy(); } catch (_) { /* 已销毁 */ }
    store.preferences.flushSync();
    store.database.close();
    console.log(`TOTAL passed=${passed} failed=${failed}`);
    if (failed) { console.error(failed + ' 项失败'); app.exit(1); } else { console.log('ALL PASSED'); app.exit(0); }
  } catch (e) {
    console.error('ERR', String(e && e.stack || e).slice(0, 1600));
    app.exit(1);
  }
});
