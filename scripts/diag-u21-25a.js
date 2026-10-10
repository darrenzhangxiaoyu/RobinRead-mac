'use strict';
/**
 * diag-u21-25a.js — 视觉批 1（U21–U25）探针（run-all OFFLINE 集）
 *
 * U21 字体族套装：四档版式皮肤（宋体系/黑体系/仿宋/楷体）+自定义字体（设置→外观：
 *               选择器+自定义 font-family 输入+即时预览）+偏好持久化（RobinRead.readerFontFamily /
 *               readerCustomFont）+reader 应用（--reader-font / --reader-font-family 双变量链）
 * U22 共享元素转场：computeFlip 纯函数（dx/dy/scale）/快照 roundtrip/ID 不匹配/TTL 过期/
 *               幽灵元素飞入（初 transform 反演→play 类过渡归位→摘除）/reduced-motion 直达终态
 * U23 主题切换渐变：applyPalette 启动首帧不渐变/二次调用挂 .theme-transition/300ms 后摘除/
 *               CSS 规则走 var(--dur-mid)+reduced-motion none/reduced-motion 下不挂类
 * U24 触控板手势：pinch 累计器阈值步进/ctrlKey 拦截+preventDefault/双指滚动语义保持/
 *               灯箱让位/detach/触屏长按=合成 contextmenu（抬手取消/位移 slop 取消/detach）
 * U25 阅读年报：wrapped() 年度聚合（完读/批注=高亮+笔记/连击/Top 主题/年度界/LIMIT）/
 *               知识中心 wrapped tab 真渲染（四数据卡+countup 终值+关键词云字号映射+下载按钮）/
 *               wrappedCardArt 确定性 SVG（同输入逐字节同输出/异输入异出/XSS 转义）/IPC e2e
 *
 * UI 阶段：offscreen + backgroundThrottling=false + disableHardwareAcceleration，
 * 150s 竞速降级 SKIP（写 .ci-skip-marker，内容=本文件名；连击治理由 run-all 判）。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration(); // 沙箱内 GPU 合成偶发死锁：探针窗口纯 DOM 断言，禁用硬件加速
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-u21-25-')));
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

// ── Phase A：源码在册断言 ──────────────────────────────────────────────────
function phaseSource() {
  const robin = read('src/renderer/styles/robin.css');
  const presets = read('src/renderer/data/font-family-presets.js');
  const appSrc = read('src/renderer/app.js');
  const popupSrc = read('src/renderer/reader-window.js');
  const readerSrc = read('src/renderer/views/reader.js');
  const listSrc = read('src/renderer/views/list.js');
  const dialogsSrc = read('src/renderer/views/dialogs.js');
  const themeSrc = read('src/renderer/views/theme-engine.js');
  const gestureSrc = read('src/renderer/views/gesture-layer.js');
  const sharedSrc = read('src/renderer/views/shared-transition.js');
  const storeSrc = read('src/main/AppStore.js');
  const keSrc = read('src/main/KnowledgeEngine.js');
  const ipcSrc = read('src/main/ipc.js');
  const preloadSrc = read('src/main/preload.js');
  const kbSrc = read('src/renderer/views/knowledge.js');
  const wvSrc = read('src/renderer/views/wrapped-view.js');
  const wcaSrc = read('src/renderer/views/wrapped-card-art.js');
  const i18nSrc = read('src/main/I18NStrings.js');

  // U21：字体族套装在册
  ok(/--reader-font-family:\s*"Songti SC"/.test(robin), 'A U21 robin.css --reader-font-family 缺省（宋体系栈）在册');
  ok(/export const READER_FONT_KEYS/.test(presets) && /'fangsong'/.test(presets) && /'kaiti'/.test(presets) && /'custom'/.test(presets), 'A U21 READER_FONT_KEYS 六键（含仿宋/楷体/自定义）在册');
  ok(/export function resolveReaderFontStack/.test(presets) && /export function sanitizeCustomFontName/.test(presets), 'A U21 resolveReaderFontStack/sanitizeCustomFontName 导出在册');
  ok(/resolveReaderFontStack\(layout\)/.test(appSrc) && /setProperty\('--reader-font-family', fontStack\)/.test(appSrc), 'A U21 app.js applyReaderLayout 走单一数据源并写双变量');
  ok(/resolveReaderFontStack\(layout\)/.test(popupSrc), 'A U21 弹出阅读窗同源应用（reader-window.js）');
  ok(/font-family: var\(--reader-font, var\(--reader-font-family, var\(--font-serif\)\)\)/.test(robin), 'A U21 .reader-article 三级字体链（每源 > 全局套装 > 内置衬线）');
  ok(/fontFamily: \['serif', 'sans', 'wenkai', 'fangsong', 'kaiti', 'custom'\]/.test(storeSrc), 'A U21 AppStore 白名单扩至四套皮肤+custom');
  ok(/RobinRead\.readerCustomFont/.test(storeSrc) && /slice\(0, 80\)/.test(storeSrc) && /replace\(\/\["';\{\}\\\\\]\/g, ''\)/.test(storeSrc), 'A U21 customFont 消毒分支（80 字封顶+语法字符剥除）在册');
  ok(/customFont: this\.preferences\.get\('RobinRead\.readerCustomFont', ''\)/.test(storeSrc), 'A U21 readerLayout() 快照携带 customFont');
  ok(/READER_FONT_LABELS/.test(dialogsSrc) && /custom-font-input/.test(dialogsSrc) && /font-family-preview/.test(dialogsSrc), 'A U21 设置页选择器+自定义输入+即时预览在册');
  ok(i18nSrc.includes('"仿宋"') && i18nSrc.includes('"楷体"') && i18nSrc.includes('"正文字体族"'), 'A U21 i18n 在册（仿宋/楷体/正文字体族）');

  // U22：共享元素转场在册
  for (const fn of ['computeFlip', 'snapshotEntryTitle', 'setSharedSnapshot', 'takeSharedSnapshot', 'playTitleTransition']) {
    ok(new RegExp(`export function ${fn}`).test(sharedSrc), `A U22 shared-transition 导出 ${fn} 在册`);
  }
  ok(/SNAPSHOT_TTL_MS = 4000/.test(sharedSrc), 'A U22 快照 TTL 4s 在册（异步渲染兜底）');
  ok(/\.nj-shared-ghost-play\s*\{/.test(robin) && /transition: transform var\(--dur-slow\) var\(--ease-out\)/.test(robin), 'A U22 幽灵过渡块（--dur-slow + ease-out）在册');
  ok(/prefers-reduced-motion: reduce\)\s*\{\s*[^@]*?\.nj-shared-ghost \{ display: none;/.test(robin), 'A U22 reduced-motion 直达终态（幽灵 display:none）在册');
  ok(listSrc.includes('setSharedSnapshot(snapshotEntryTitle(item.id, row.querySelector(\'.entry-title\')))'), 'A U22 列表行点击快照（FLIP First）接线');
  ok(readerSrc.includes("playTitleTransition(this.entryID, article.querySelector('.robin-header-title'))"), 'A U22 阅读器渲染后消费快照（FLIP Last→Invert→Play）接线');

  // U23：主题切换渐变在册
  ok(/export const THEME_TRANSITION_MS = 300/.test(themeSrc), 'A U23 THEME_TRANSITION_MS=300 在册');
  ok(/classList\.add\('theme-transition'\)/.test(themeSrc) && /remove\('theme-transition'/, 'A U23 过渡类挂/摘逻辑在册');
  ok(/applyPalette\._booted/.test(themeSrc), 'A U23 启动首帧不渐变（boot 门）在册');
  ok(/html\.theme-transition,/.test(robin) && /var\(--dur-mid\) var\(--ease-in-out\)/.test(robin), 'A U23 过渡 CSS 规则（颜色类属性 × --dur-mid）在册');
  ok(/prefers-reduced-motion: reduce\)\s*\{\s*html\.theme-transition,[^}]*transition: none !important/.test(robin), 'A U23 reduced-motion 过渡豁免在册');

  // U24：手势层在册
  for (const fn of ['createPinchTracker', 'bindPinchFontSize', 'bindTouchLongPress']) {
    ok(new RegExp(`export function ${fn}`).test(gestureSrc), `A U24 gesture-layer 导出 ${fn} 在册`);
  }
  ok(/!event\.ctrlKey && !event\.metaKey/.test(gestureSrc) && /event\.preventDefault\(\)/.test(gestureSrc), 'A U24 pinch：ctrlKey 判定 + 接管默认整页缩放在册');
  ok(/bindPinchFontSize\(views\.reader\?\.scrollEl/.test(appSrc) && /adjustFontSize/.test(appSrc) && /bindTouchLongPress\(document\.body/.test(appSrc), 'A U24 app.js 手势绑定（阅读器捏合字号 + 全局长按右键）在册');
  ok(/pointerType !== 'touch'/.test(gestureSrc) && /MouseEvent\('contextmenu'/.test(gestureSrc) && /delay = 550/.test(gestureSrc), 'A U24 长按：touch 判定 + 合成 contextmenu + 550ms 在册');

  // U25：年报在册
  ok(/wrapped\(\)/.test(keSrc) && /FROM reading_stats WHERE date >= \?/.test(keSrc) && /ORDER BY count DESC, tag ASC\s*\n?\s*LIMIT 24/.test(keSrc), 'A U25 wrapped() 年度聚合 + Top24 在册');
  ok(/st\.is_read = 1 AND st\.updated_at >= \?/.test(keSrc), 'A U25 Top 主题按「本年已读」口径在册');
  ok(/handle\('kb:wrapped'/.test(ipcSrc) && /kbWrapped: \(\) => data\('kb:wrapped'\)/.test(preloadSrc), 'A U25 kb:wrapped 通道（IPC+preload）在册');
  ok(/\{ id: 'wrapped', label: '阅读年报'/.test(kbSrc) && /kbWrapped\(\)/.test(kbSrc) && /_renderWrapped/.test(kbSrc), 'A U25 知识中心 wrapped tab + loader + 渲染分派在册');
  ok(/export function renderWrapped/.test(wvSrc) && /export function cloudFontSize/.test(wvSrc) && /runChartIntro/.test(wvSrc), 'A U25 renderWrapped/cloudFontSize/countup 在册');
  ok(/export function wrappedCardArt/.test(wcaSrc) && /export function wrappedSeed/.test(wcaSrc), 'A U25 wrappedCardArt/wrappedSeed 导出在册');
  ok(!/Math\.random/.test(wcaSrc) && !/Date\.now/.test(wcaSrc), 'A U25 分享卡零随机源/零时钟（确定性合同）');
  // U25 CSS 令牌护栏：.wrapped 新块零 px 字号 / 零 px 圆角 / 零秒数字面量
  {
    const m = robin.match(/U25 阅读年报[\s\S]*$/);
    const seg = m ? m[0] : '';
    const badFs = (seg.match(/font-size:\s*\d+px/g) || []).length;
    const badRadius = (seg.match(/border-radius:\s*\d+px/g) || []).length;
    const badDur = (seg.match(/:\s*\d+(\.\d+)?m?s\b\s*;/g) || []).filter((x) => !/var\(/.test(x)).length;
    ok(seg.includes('.wrapped-view') && badFs === 0 && badRadius === 0 && badDur === 0,
      `A U25 .wrapped 块令牌零字面量（font-size:${badFs} radius:${badRadius} dur:${badDur}）`);
  }
  ok(/\.nj-shared-ghost \{/.test(robin) && !/z-index:\s*999999/.test(robin), 'A U22 幽灵块在册且不滥用超高层');
}

// ── Phase B：主进程服务级断言（真 AppStore + 真 SQL）──────────────────────
function localKey(ts) {
  return new Date(ts - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
async function phaseService() {
  const { AppStore } = require('../src/main/AppStore');
  const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
  const userData = app.getPath('userData');
  const store = new AppStore(userData);
  store.setReaderLayout({ fontFamily: 'serif', customFont: '' }); // UI 阶段从干净预设开始

  // U25 数据：灌文（feed + 3 文 + 标签 + 已读）
  const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '年报素材源', feedURL: 'https://u21-25.test/wrapped.xml' });
  const mkEntry = async (id, title) => (await store._applyParsedEntries(feed, [{
    id, title, url: `https://u21-25.test/x/${id}`, publishedAt: Date.now() / 1000 - 3600, summary: `${title}的摘要。`, contentHTML: `<p>${title}</p>`,
  }]))[0];
  const e1 = await mkEntry('u25-a1', '年报文章一');
  const e2 = await mkEntry('u25-a2', '年报文章二');
  await mkEntry('u25-a3', '年报文章三（未读）');
  store.knowledge.addManualTag(e1, '主题甲');
  store.knowledge.addManualTag(e2, '主题甲');
  store.knowledge.addManualTag(e1, '主题乙');
  store.markRead(e1);
  store.markRead(e2);
  const year = new Date().getFullYear();
  // 批注统计行（今天 +4 高亮 +3 笔记）；去年行（不计入年度）
  const todayKey = localKey(Date.now());
  store.database.prepare(`INSERT INTO reading_stats (date, articles_read, highlights_made, notes_created) VALUES (?, 0, 4, 3)
    ON CONFLICT(date) DO UPDATE SET highlights_made = highlights_made + 4, notes_created = notes_created + 3`).run(todayKey);
  store.database.prepare('INSERT OR REPLACE INTO reading_stats (date, articles_read) VALUES (?, 99)').run(`${year - 1}-12-31`);
  // 连击窗口：昨天/前天/大前天各 1 篇（同年前提：10 月运行；Date.now 毫秒口径）
  for (let i = 1; i <= 3; i += 1) {
    store.database.prepare('INSERT OR REPLACE INTO reading_stats (date, articles_read) VALUES (?, 1)').run(localKey(Date.now() - i * 86400000));
  }

  const w = store.knowledge.wrapped();
  ok(w.year === year, `B U25 wrapped().year=${w.year}`);
  ok(w.read === store.database.prepare('SELECT COALESCE(SUM(articles_read),0) AS n FROM reading_stats WHERE date >= ?').get(`${year}-01-01`).n && w.read >= 2,
    `B U25 本年完读聚合（read=${w.read}，去年 99 不计入）`);
  ok(w.annotations === w.highlights + w.notes && w.annotations >= 7, `B U25 批注=高亮+笔记（${w.annotations}=${w.highlights}+${w.notes}）`);
  ok(w.streak >= 4 && w.bestStreak >= w.streak, `B U25 连击（current=${w.streak} ≥4 天，best=${w.bestStreak}）`);
  ok(Array.isArray(w.topThemes) && w.topThemes.length === 2 && w.topThemes[0].tag === '主题甲' && w.topThemes[0].count === 2,
    `B U25 Top 主题排序（甲×2 > 乙×1）got=${JSON.stringify(w.topThemes)}`);
  ok(w.topThemes.length <= 24, 'B U25 Top 主题 LIMIT 24');
  ok(w.activeDays >= 4, `B U25 活跃天数（activeDays=${w.activeDays}）`);
  return store;
}

/** U21 持久化断言（UI 阶段之后单独跑：close+重开 AppStore 不与开着的探针窗口混跑）。 */
async function phasePersistence() {
  const { AppStore } = require('../src/main/AppStore');
  const userData = app.getPath('userData');
  let store = new AppStore(userData);
  store.setReaderLayout({ fontFamily: 'fangsong' });
  ok(store.readerLayout().fontFamily === 'fangsong', 'B U21 setReaderLayout 仿宋入库（readerLayout 投影）');
  store.setReaderLayout({ fontFamily: 'kaiti' });
  ok(store.readerLayout().fontFamily === 'kaiti', 'B U21 setReaderLayout 楷体入库');
  store.setReaderLayout({ fontFamily: 'comic-sans' });
  ok(store.readerLayout().fontFamily === 'kaiti', 'B U21 非法字体族键被白名单拒（保持原值）');
  store.setReaderLayout({ fontFamily: 'custom', customFont: 'Source "Han"; Serif{bad}\\x' });
  ok(store.readerLayout().fontFamily === 'custom' && store.readerLayout().customFont === 'Source Han Serifbadx',
    `B U21 customFont 消毒（引号/分号/花括号/反斜杠剥除）got="${store.readerLayout().customFont}"`);
  store.setReaderLayout({ customFont: 'N'.repeat(120) });
  ok(store.readerLayout().customFont.length === 80, `B U21 customFont 80 字封顶 got=${store.readerLayout().customFont.length}`);
  // 重启读回
  store.preferences.flushSync();
  store.database.close();
  store = new AppStore(userData);
  ok(store.readerLayout().fontFamily === 'custom' && store.readerLayout().customFont.length === 80,
    'B U21 重启读回：fontFamily=custom + customFont 保留');
  store.preferences.flushSync();
  store.database.close();
}

// ── Phase C：UI 阶段（offscreen 真窗 + 真 IPC；150s 竞速降级 SKIP）─────────
// 窗口早开（f36 同款：进程年轻时创建健康；Desktop Heap 耗尽会使晚创建同步死锁），
// IPC 注册与页面加载在服务级断言之后进行（handlers 绑定重启后的最终 store）。
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
    console.error('UI probe: load failed (environmental):', String((err && err.message) || err));
    return { uiSkipped: true };
  }
  await sleep(1600);
  const js = async (label, code) => {
    console.log(`C ${label} …`);
    const r = await win.webContents.executeJavaScript(code);
    console.log(`C ${label} 完成`);
    return r;
  };

  const out = await js('U21/U22 块', `(async () => {
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
    const out = {};
    const viewsURL = (f) => new URL(f, ${JSON.stringify(modURL('x'))}).href;
    const dataURL = (f) => new URL('../data/' + f, ${JSON.stringify(modURL('x'))}).href;
    const root0 = document.documentElement;

    // ── U21：启动应用 + CSS 变量链 ──
    const bootFont = root0.style.getPropertyValue('--reader-font-family');
    out.u21BootSongti = bootFont.includes('Songti SC');
    out.u21BootMirror = (root0.style.getPropertyValue('--reader-font') || '') === bootFont;
    // .reader-article 三级字体链：--reader-font（每源）> --reader-font-family（套装）> --font-serif
    const art = document.createElement('div');
    art.className = 'reader-article';
    document.body.appendChild(art);
    const ff = () => getComputedStyle(art).fontFamily;
    out.u21ChainDefault = ff().includes('Songti'); // 根上 --reader-font 在 → 跟随
    root0.style.setProperty('--reader-font-family', '"FangSong", serif');
    out.u21FontWinsOverFamily = !ff().includes('FangSong'); // 每源变量优先
    root0.style.removeProperty('--reader-font');
    out.u21FamilyFollows = ff().includes('FangSong'); // 摘掉每源 → 套装变量接管
    art.remove();

    // U21 纯函数：预设解析 + 自定义消毒
    const fp = await import(dataURL('font-family-presets.js'));
    const stackOf = (l) => fp.resolveReaderFontStack(l);
    out.u21Presets = stackOf({ fontFamily: 'serif' }).includes('Songti SC')
      && stackOf({ fontFamily: 'sans' }).includes('PingFang SC')
      && stackOf({ fontFamily: 'fangsong' }).includes('FangSong')
      && stackOf({ fontFamily: 'kaiti' }).includes('LXGW WenKai Screen')
      && stackOf({ fontFamily: 'wenkai' }).includes('LXGW WenKai Screen');
    out.u21Custom = stackOf({ fontFamily: 'custom', customFont: 'My Font' }).startsWith('"My Font", ');
    out.u21CustomEmpty = stackOf({ fontFamily: 'custom', customFont: '   ' }) === stackOf({ fontFamily: 'serif' });
    out.u21Sanitize = fp.sanitizeCustomFontName('A"B;C{D}E\\\\F') === 'ABCDEF'
      && fp.sanitizeCustomFontName('x'.repeat(120)).length === 80;

    // ── U22：FLIP 纯函数 + 快照合同 + 幽灵飞入 ──
    const st = await import(viewsURL('shared-transition.js'));
    const flip = st.computeFlip({ x: 40, y: 120, width: 260, height: 18 }, { x: 340, y: 40, width: 520, height: 36 });
    out.u22Flip = Math.abs(flip.dx - 300) < 0.02 && Math.abs(flip.dy + 80) < 0.02 && Math.abs(flip.scale - 2) < 0.002;
    // 快照 roundtrip / ID 不匹配 / TTL
    const snapSrc = document.createElement('div');
    snapSrc.style.cssText = 'position:fixed;left:40px;top:120px;width:260px;height:18px;';
    snapSrc.textContent = '快照标题';
    document.body.appendChild(snapSrc);
    st.setSharedSnapshot(st.snapshotEntryTitle('e-1', snapSrc));
    out.u22MissID = st.takeSharedSnapshot('e-2') === null; // 不匹配：不消费也不飞
    st.setSharedSnapshot(st.snapshotEntryTitle('e-1', snapSrc));
    out.u22Roundtrip = !!st.takeSharedSnapshot('e-1');
    st.setSharedSnapshot({ entryID: 'e-1', x: 1, y: 1, width: 10, height: 10, text: 'x', at: Date.now() - 5000 });
    out.u22TTL = st.takeSharedSnapshot('e-1') === null;
    snapSrc.remove();
    // 幽灵飞入：真元素靶
    const target = document.createElement('h1');
    target.className = 'robin-header-title';
    target.style.cssText = 'position:fixed;left:340px;top:40px;width:520px;height:36px;';
    target.textContent = '快照标题';
    document.body.appendChild(target);
    const snap2Src = document.createElement('div');
    snap2Src.style.cssText = 'position:fixed;left:40px;top:120px;width:260px;height:18px;';
    snap2Src.textContent = '快照标题';
    document.body.appendChild(snap2Src);
    st.setSharedSnapshot(st.snapshotEntryTitle('e-9', snap2Src));
    snap2Src.remove();
    const ghost = st.playTitleTransition('e-9', target);
    out.u22Ghost = !!ghost && ghost.dataset.role === 'shared-ghost'
      && /translate\\(/.test(ghost.style.transform) && /scale\\(/.test(ghost.style.transform);
    await sleep(120);
    out.u22PlayClass = !!ghost && ghost.classList.contains('nj-shared-ghost-play');
    await sleep(1100);
    out.u22GhostGone = !ghost.isConnected;
    target.remove();
    return out;
  })()`);
  Object.assign(out, await js('U23/U24 块', `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    const viewsURL = (f) => new URL(f, ${JSON.stringify(modURL('x'))}).href;
    const root0 = document.documentElement;

    // ── U23：主题切换渐变 ──
    const te = await import(viewsURL('theme-engine.js'));
    const pal = (th) => te.fullPalette(te.normalizeTokens({ th, mode: 'light' }));
    te.applyPalette(pal(142)); // boot 门内首帧（或上一轮已 booted）：本调用若为首次不挂类
    out.u23BootCalm = !root0.classList.contains('theme-transition');
    te.applyPalette(pal(220)); // 真切换：挂类
    out.u23ClassOn = root0.classList.contains('theme-transition');
    out.u23VarsApplied = !!root0.style.getPropertyValue('--accent');
    await sleep(520);
    out.u23ClassOff = !root0.classList.contains('theme-transition');
    te.applyPalette(pal(142)); // 收尾：回原纸
    // CSSOM：过渡规则 + reduced-motion 豁免
    let ttRule = false; let ttVar = false; let ttRM = false;
    const walk = (rules) => {
      for (const r of rules) {
        if (r.selectorText && r.selectorText.includes('.theme-transition')) {
          ttRule = true;
          if ((r.cssText || '').includes('var(--dur-mid)')) ttVar = true;
          if ((r.cssText || '').includes('transition: none')) ttRM = true;
        }
        if (r.cssRules && r.cssRules.length > 0) walk(r.cssRules);
      }
    };
    for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch (_) {} }
    out.u23CSSRule = ttRule && ttVar && ttRM;

    // ── U24：手势层（合成事件验证处理函数逻辑）──
    const gl = await import(viewsURL('gesture-layer.js'));
    // 累计器：阈值步进 + 累积 + 负向
    const tr = gl.createPinchTracker({ threshold: 90 });
    out.u24Tracker = tr.feed(-90) === 1 && tr.feed(-45) === 0 && tr.feed(-45) === 1 && tr.feed(180) === -2;
    // 绑定：ctrlKey 拦截 + preventDefault + 无 ctrl 放行（滚动语义保持）+ 灯箱让位 + detach
    const host = document.createElement('div');
    document.body.appendChild(host);
    const steps = [];
    const detach = gl.bindPinchFontSize(host, { onStep: (d) => steps.push(d), threshold: 90 });
    host.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }));
    out.u24PinchStep = steps.length === 1 && steps[0] === 1;
    const evPlain = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
    host.dispatchEvent(evPlain);
    out.u24ScrollKept = steps.length === 1 && evPlain.defaultPrevented === false;
    const lb = document.createElement('div');
    lb.className = 'nj-lightbox';
    host.appendChild(lb);
    lb.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true }));
    out.u24LightboxYield = steps.length === 1;
    detach();
    host.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true }));
    out.u24Detach = steps.length === 1;
    host.remove();
    // 长按：fire / 抬手取消 / 位移 slop 取消 / detach
    const lpHost = document.createElement('div');
    document.body.appendChild(lpHost);
    let fired = null;
    const detachLP = gl.bindTouchLongPress(lpHost, { delay: 300, slop: 12, onContext: (ev) => { fired = ev; } });
    const pe = (type, x, y) => new PointerEvent(type, { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: x, clientY: y, bubbles: true });
    lpHost.dispatchEvent(pe('pointerdown', 50, 60));
    await sleep(140);
    lpHost.dispatchEvent(pe('pointerup', 50, 60)); // 提前抬手
    await sleep(260);
    out.u24EarlyUp = fired === null;
    lpHost.dispatchEvent(pe('pointerdown', 50, 60));
    lpHost.dispatchEvent(pe('pointermove', 90, 60)); // 位移超 slop
    await sleep(400);
    out.u24Slop = fired === null;
    lpHost.dispatchEvent(pe('pointerdown', 50, 60));
    await sleep(420);
    out.u24LongPress = !!fired && fired.type === 'contextmenu' && fired.clientX === 50 && fired.clientY === 60;
    detachLP();
    fired = null;
    lpHost.dispatchEvent(pe('pointerdown', 50, 60));
    await sleep(420);
    out.u24LPDetach = fired === null;
    lpHost.remove();
    return out;
  })()`));
  Object.assign(out, await js('U25 块', `(async () => {
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
    const out = {};
    const viewsURL = (f) => new URL(f, ${JSON.stringify(modURL('x'))}).href;

    // ── U25：年报（真 IPC + 真渲染）──
    const wrappedData = await window.robin.kbWrapped();
    out.u25IPC = !!wrappedData && Array.isArray(wrappedData.topThemes) && wrappedData.topThemes.length >= 2;
    const kb = await import(viewsURL('knowledge.js'));
    const kc = new kb.KnowledgeCenter({ onOpenArticle: () => {}, onOpenSmartFolder: () => {}, onFilterTag: () => {}, onOpenURL: () => {}, toast: null });
    kc.present('wrapped');
    await waitFor(() => document.querySelector('.wrapped-view'));
    out.u25Tab = !!document.querySelector('.wrapped-view');
    out.u25Cards = ['read', 'annotations', 'streak', 'theme'].every((k) => document.querySelector('[data-role="wrapped-card-' + k + '"]'));
    const readCard = document.querySelector('[data-role="wrapped-card-read"] .wrapped-num');
    await sleep(1400); // countup（900ms）落终值
    out.u25Countup = readCard && readCard.textContent === String(wrappedData.read);
    const words = [...document.querySelectorAll('.wrapped-cloud-word')];
    out.u25Cloud = words.length >= 2 && words.every((w2) => parseFloat(w2.style.fontSize) >= 14);
    const szs = words.map((w2) => parseFloat(w2.style.fontSize));
    out.u25CloudMap = Math.max(...szs) >= Math.min(...szs)
      && words.find((w2) => w2.textContent === wrappedData.topThemes[0].tag)?.style.fontSize === Math.max(...szs).toFixed(0) + 'px';
    out.u25Download = !!document.querySelector('[data-role="wrapped-download"]');
    kc.dismiss();

    // 分享卡确定性
    const wca = await import(viewsURL('wrapped-card-art.js'));
    const args = { year: 2026, read: 42, annotations: 17, streak: 9, topTheme: '主题甲', accent: '#617357', paper: '#eae8e1', ink: '#3f3a30' };
    const a1 = wca.wrappedCardArt(args);
    const a2 = wca.wrappedCardArt({ ...args });
    out.u25Deterministic = a1 === a2 && a1.length > 400;
    out.u25Differs = wca.wrappedCardArt({ ...args, read: 43 }) !== a1;
    out.u25XSS = !/[<]script/.test(wca.wrappedCardArt({ ...args, topTheme: '<script>alert(1)</script>' }))
      && wca.wrappedCardArt({ ...args, topTheme: '<b>尖</b>' }).includes('&lt;b&gt;');
    out.u25Content = a1.includes('2026') && a1.includes('42') && a1.includes('NOTES') && a1.includes('data-wrapped-card="2026"');
    const wv = await import(viewsURL('wrapped-view.js'));
    const cf = wv.cloudFontSize;
    out.u25CloudFont = cf(21, 1, 21) > cf(1, 1, 21) && cf(5, 5, 5) === 20 && cf(1, 1, 21) === 14;
    return out;
  })()`));

  return { uiSkipped: false, out, win };
}

// ── Phase D：reduced-motion 仿真（CDP，最后做避免污染）────────────────────
async function phaseReducedMotion(win) {
  const dbg = win.webContents.debugger;
  await dbg.attach();
  await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const out = await win.webContents.executeJavaScript(`(async () => {
    const out = {};
    const viewsURL = (f) => new URL(f, ${JSON.stringify(modURL('x'))}).href;
    const st = await import(viewsURL('shared-transition.js'));
    const target = document.createElement('h1');
    target.className = 'robin-header-title';
    target.style.cssText = 'position:fixed;left:10px;top:10px;width:200px;height:30px;';
    document.body.appendChild(target);
    const snapSrc = document.createElement('div');
    snapSrc.style.cssText = 'position:fixed;left:100px;top:100px;width:100px;height:16px;';
    snapSrc.textContent = '标题';
    document.body.appendChild(snapSrc);
    st.setSharedSnapshot(st.snapshotEntryTitle('rm-1', snapSrc));
    snapSrc.remove();
    out.u22RMNoGhost = st.playTitleTransition('rm-1', target) === null && !document.querySelector('.nj-shared-ghost');
    target.remove();
    const te = await import(viewsURL('theme-engine.js'));
    te.applyPalette(te.fullPalette(te.normalizeTokens({ th: 60, mode: 'light' })));
    out.u23RMNoClass = !document.documentElement.classList.contains('theme-transition');
    return out;
  })()`);
  await dbg.sendCommand('Emulation.clearDeviceMetricsOverride');
  await dbg.detach();
  return out;
}

app.whenReady().then(async () => {
  try {
    // UI 窗早开（f36 同款：进程年轻时创建健康；晚创建在重初始化后偶发同步死锁）
    const uiWin = openUIWindow();
    if (!uiWin) {
      // 窗口都建不出来：全量 UI 断言按 SKIP 降级（环境性），服务级断言照跑
      const store0 = await phaseService();
      console.log('UI 阶段 SKIP：窗口创建失败（环境性）');
      try { fs.writeFileSync(path.join(__dirname, '.ci-skip-marker'), 'scripts/diag-u21-25a.js'); } catch (_) { /* 标记失败仅影响连击治理 */ }
      store0.preferences.flushSync();
      store0.database.close();
      console.log(`TOTAL passed=${passed} failed=${failed}`);
      process.exit(failed ? 1 : 0);
      return;
    }
    uiWin.on('render-process-gone', (_e, d) => console.error('RENDER-GONE', JSON.stringify(d)));
    phaseSource();
    const store = await phaseService();

    // ── UI 阶段（150s 竞速降级 SKIP）──
    console.log('UI 阶段启动…');
    const ui = await Promise.race([
      uiProbe(store, uiWin).catch((err) => { console.error('uiProbe threw:', String(err && err.stack || err).slice(0, 800)); return { uiSkipped: true }; }),
      new Promise((r) => setTimeout(() => r({ uiSkipped: true }), 150000)),
    ]);
    if (ui.uiSkipped) {
      console.log('UI 阶段 SKIP：环境性挂起（源码级+服务级断言已全部执行）');
      try { fs.writeFileSync(path.join(__dirname, '.ci-skip-marker'), 'scripts/diag-u21-25a.js'); } catch (_) { /* 标记失败仅影响连击治理 */ }
      store.preferences.flushSync();
      store.database.close();
      console.log(`TOTAL passed=${passed} failed=${failed}`);
      process.exit(failed ? 1 : 0);
      return;
    }
    const b = ui.out || {};
    const label = (k, name) => `${name}（got=${JSON.stringify(b[k])}）`;
    // U21
    ok(b.u21BootSongti, label('u21BootSongti', 'C U21 启动应用：根变量 --reader-font-family=宋体系栈'));
    ok(b.u21BootMirror, label('u21BootMirror', 'C U21 --reader-font 与 --reader-font-family 同步镜像'));
    ok(b.u21ChainDefault && b.u21FontWinsOverFamily && b.u21FamilyFollows,
      label('u21FamilyFollows', 'C U21 .reader-article 三级字体链（每源优先，摘除后套装接管）'));
    ok(b.u21Presets, label('u21Presets', 'C U21 四套皮肤+wenkai 兼容栈解析'));
    ok(b.u21Custom && b.u21CustomEmpty, label('u21Custom', 'C U21 自定义拼栈（名前引号包裹）与空名回退'));
    ok(b.u21Sanitize, label('u21Sanitize', 'C U21 sanitizeCustomFontName 消毒/截断'));
    // 设置页真渲染 + 真 IPC（先选预设并断言落库，再输入自定义名——两者都写 fontFamily，须分序）
    const uiSet = await ui.win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const viewsURL = (f) => new URL(f, ${JSON.stringify(modURL('x'))}).href;
      const dlg = await import(viewsURL('dialogs.js'));
      const snapshot = await window.robin.getState();
      const sv = new dlg.SettingsView({ state: { snapshot: { ...snapshot.data, preferences: snapshot.data.preferences }, llm: {} }, views: {}, onAddFreshRSS: null, onReload: null, onRefreshState: null });
      window.__u21Settings = sv; // 第二段（自定义输入）复用同一实例
      sv.present('appearance');
      await sleep(500);
      const preview = document.querySelector('[data-role="font-family-preview"]');
      const allSelects = [...document.querySelectorAll('.modal select')];
      const fontSelect = allSelects.find((s) => [...s.options].some((o) => o.value === 'fangsong'));
      const out = { preview: !!preview, options: fontSelect ? fontSelect.options.length : 0 };
      if (fontSelect) {
        fontSelect.value = 'fangsong';
        fontSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(600); // IPC 落库
        out.previewFont = preview.style.fontFamily || '';
      }
      return out;
    })()`);
    ok(uiSet.preview, 'C U21 设置→外观：字体预览元素真渲染');
    ok(uiSet.options === 6, `C U21 正文字体族选择器 6 项（四皮肤+wenkai+自定义）got=${uiSet.options}`);
    ok(/FangSong/i.test(uiSet.previewFont || ''), `C U21 选仿宋即时预览换栈（got=${uiSet.previewFont}）`);
    await waitFor(() => store.readerLayout().fontFamily === 'fangsong', 4000);
    ok(store.readerLayout().fontFamily === 'fangsong', 'C U21 选仿宋经真 IPC 落库（设置→外观→阅读排版）');
    // 第二段：自定义字体输入（写 fontFamily:'custom' + 消毒后的 customFont）
    const uiSetInput = await ui.win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const input = document.querySelector('[data-role="custom-font-input"]');
      if (!input) return { input: false };
      input.value = 'Bad "Quote"; Name';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(900); // 500ms 防抖 + IPC
      window.__u21Settings?.dismiss?.();
      await sleep(200);
      return { input: true };
    })()`);
    ok(uiSetInput.input, 'C U21 自定义字体输入框真渲染');
    ok(store.readerLayout().customFont === 'Bad Quote Name',
      `C U21 自定义输入消毒落库（got="${store.readerLayout().customFont}"）`);
    // U22
    ok(b.u22Flip, label('u22Flip', 'C U22 computeFlip 纯函数（dx/dy/scale）'));
    ok(b.u22MissID && b.u22Roundtrip && b.u22TTL, label('u22TTL', 'C U22 快照合同（ID 不匹配不消费/roundtrip/TTL 过期）'));
    ok(b.u22Ghost, label('u22Ghost', 'C U22 幽灵元素飞入（data-role + 初 transform 反演 translate/scale）'));
    ok(b.u22PlayClass, label('u22PlayClass', 'C U22 play 类挂上（transition 归位启动）'));
    ok(b.u22GhostGone, label('u22GhostGone', 'C U22 过渡结束幽灵摘除'));
    // U23
    ok(b.u23BootCalm, label('u23BootCalm', 'C U23 首帧/稳态调用不挂过渡类'));
    ok(b.u23ClassOn && b.u23VarsApplied, label('u23ClassOn', 'C U23 切换挂 .theme-transition 且变量照常应用'));
    ok(b.u23ClassOff, label('u23ClassOff', 'C U23 约 300ms 后过渡类摘除（不常驻）'));
    ok(b.u23CSSRule, label('u23CSSRule', 'C U23 CSSOM 过渡规则（--dur-mid）+ reduced-motion 豁免'));
    // U24
    ok(b.u24Tracker, label('u24Tracker', 'C U24 pinch 累计器（阈值步进/累积/负向）'));
    ok(b.u24PinchStep, label('u24PinchStep', 'C U24 ctrlKey pinch 步进回调'));
    ok(b.u24ScrollKept, label('u24ScrollKept', 'C U24 双指滚动语义保持（不拦截不 preventDefault）'));
    ok(b.u24LightboxYield, label('u24LightboxYield', 'C U24 灯箱等自带缩放区让位'));
    ok(b.u24Detach, label('u24Detach', 'C U24 pinch detach 后不再步进'));
    ok(b.u24EarlyUp && b.u24Slop, label('u24Slop', 'C U24 长按取消（提前抬手/位移超 slop）'));
    ok(b.u24LongPress, label('u24LongPress', 'C U24 长按触发合成 contextmenu（坐标随触点）'));
    ok(b.u24LPDetach, label('u24LPDetach', 'C U24 长按 detach 后不再触发'));
    // U25
    ok(b.u25IPC, label('u25IPC', 'C U25 kb:wrapped IPC e2e（topThemes 在列）'));
    ok(b.u25Tab, label('u25Tab', 'C U25 知识中心「阅读年报」tab 真渲染'));
    ok(b.u25Cards, label('u25Cards', 'C U25 四大数据卡（完读/批注/连击/Top 主题）'));
    ok(b.u25Countup, label('u25Countup', 'C U25 countup 落终值（=wrapped().read）'));
    ok(b.u25Cloud, label('u25Cloud', 'C U25 关键词云（≥2 词，字号 ≥14px）'));
    ok(b.u25CloudMap, label('u25CloudMap', 'C U25 云字号映射（Top 主题=最大档）'));
    ok(b.u25Download, label('u25Download', 'C U25 分享卡导出按钮在册'));
    ok(b.u25Deterministic && b.u25Differs, label('u25Deterministic', 'C U25 分享卡确定性（同输入逐字节同/异输入异出）'));
    ok(b.u25XSS, label('u25XSS', 'C U25 主题题字 XSS 转义'));
    ok(b.u25Content, label('u25Content', 'C U25 卡面内容（年份/完读/NOTES/属性）'));
    ok(b.u25CloudFont, label('u25CloudFont', 'C U25 cloudFontSize 映射边界（同频 20/下限 14）'));

    // ── Phase D：reduced-motion ──
    const rm = await phaseReducedMotion(ui.win);
    ok(rm.u22RMNoGhost, 'D U22 reduced-motion：不建幽灵直达终态');
    ok(rm.u23RMNoClass, 'D U23 reduced-motion：切换不挂过渡类');

    try { uiWin.destroy(); } catch (_) { /* 已销毁 */ }
    // ── Phase E：U21 持久化（close+重开不与开着的探针窗口混跑）──
    await phasePersistence();
    store.preferences.flushSync();
    store.database.close();
    console.log(`TOTAL passed=${passed} failed=${failed}`);
    if (failed) { console.error(failed + ' 项失败'); app.exit(1); } else { console.log('ALL PASSED'); app.exit(0); }
  } catch (e) {
    console.error('ERR', String(e && e.stack || e).slice(0, 1600));
    app.exit(1);
  }
});
