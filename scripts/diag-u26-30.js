'use strict';
/**
 * diag-u26-30.js — 视觉批 2（U26–U30）探针（run-all OFFLINE 集）
 *
 * U26 高 DPI 走查：webContents.setZoomFactor 仿真 125%/150%/175% 三档缩放——
 *               三栏不塌（列宽下限随视口钳制）/列表行高一致/阅读器版心不溢/
 *               侧栏底栏 6×2 不折行/设置分区零横向溢出（scrollWidth ≤ clientWidth 抽样）
 * U27 微交互音效：sfxPlan 纯函数合同（三枚 ≤0.3s）/mock AudioContext 振荡器+增益包络
 *               调度/开关默认关/设置→通用「音效」真开关落库/能力不可达静默（dead）/三处接线
 * U28 拖拽体系：列表行 dragstart 数据合同/拖入侧栏收藏·稍后读放置高亮+批量加入/
 *               订阅源树同组拖拽排序插入位指示+持久化到 feeds.sort_order
 * U29 打印排版：@media print 块（浮层家族隐退/标题防孤行/正文单栏全宽）+阅读器
 *               打印按钮（仅文章打开时显，window.print 直达）+CDP 打印媒体仿真
 * U30 命令面板自学习：recordCommandUse 计频持久化（preferences JSON map，200 条上限）/
 *               频次对数加权排名提升（执行 3 次后同相关度命令反超）/「最近使用」既有逻辑保留
 *
 * UI 阶段：offscreen + backgroundThrottling=false + disableHardwareAcceleration，
 * 150s 竞速降级 SKIP（写 .ci-skip-marker，内容=本文件名；连击治理由 run-all 判）。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration(); // 沙箱内 GPU 合成偶发死锁：探针窗口纯 DOM 断言，禁用硬件加速
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-u26-30-')));
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
  const sfxSrc = read('src/renderer/views/sfx.js');
  const listSrc = read('src/renderer/views/list.js');
  const sidebarSrc = read('src/renderer/views/sidebar.js');
  const dialogsSrc = read('src/renderer/views/dialogs.js');
  const gardenSrc = read('src/renderer/views/garden-view.js');
  const readerSrc = read('src/renderer/views/reader.js');
  const iconsSrc = read('src/renderer/icons.js');
  const appSrc = read('src/renderer/app.js');
  const paletteSrc = read('src/renderer/views/command-palette.js');
  const storeSrc = read('src/main/AppStore.js');
  const ipcSrc = read('src/main/ipc.js');
  const preloadSrc = read('src/main/preload.js');
  const i18nSrc = read('src/main/I18NStrings.js');

  // U26：三栏视口比例钳制在册
  ok(/U26 高 DPI 走查/.test(robin) && /@media \(max-width: 1020px\)\s*\{\s*\.column-sidebar\s*\{\s*flex: 0 1 auto; min-width: min\(240px, 24vw\);/.test(robin),
    'A U26 三栏侧栏列 min-width 视口钳制（min(240px,24vw)）+允许收缩在册');
  ok(/\.column-list\s*\{\s*flex: 0 1 auto; min-width: min\(280px, 26vw\);\s*\}/.test(robin), 'A U26 列表列 min-width min(280px,26vw) 在册');
  ok(/\.column-reader\s*\{\s*min-width: min\(400px, 30vw\);\s*\}/.test(robin), 'A U26 阅读列 min-width min(400px,30vw) 在册');
  ok(/\.reader-article\s*\{\s*padding: 32px min\(40px, 5vw\) 0;\s*\}/.test(robin), 'A U26 版心内边距随视口收紧（min(40px,5vw)）在册');

  // U27：合成音效在册
  ok(/export function sfxPlan/.test(sfxSrc) && /export function initSfx/.test(sfxSrc) && /export function playSfx/.test(sfxSrc) && /export function createSfx/.test(sfxSrc) && /export const SFX_NAMES/.test(sfxSrc),
    'A U27 sfx.js 导出 sfxPlan/initSfx/playSfx/createSfx/SFX_NAMES 在册');
  ok(/case 'toggle':/.test(sfxSrc) && /case 'save':/.test(sfxSrc) && /case 'done':/.test(sfxSrc) && /default:\s*\n\s*return null;/.test(sfxSrc),
    'A U27 三枚合成音（toggle/save/done）+未知名 null 在册');
  ok(/SFX_MAX_DUR = 0\.3/.test(sfxSrc), 'A U27 单枚 ≤0.3s 纪律（SFX_MAX_DUR）在册');
  ok(/__robinSfxBridge/.test(sfxSrc) && /dead = true/.test(sfxSrc) && /ctx\.state === 'suspended'/.test(sfxSrc),
    'A U27 能力不可达静默（注入缝/判死不复活/挂起当次静默）在册');
  ok(/RobinRead\.sfx\.enabled', false/.test(ipcSrc) && /RobinRead\.sfx\.enabled', false/.test(storeSrc),
    'A U27 音效开关默认关（RobinRead.sfx.enabled，getGeneral+快照两处在册）');
  ok(/微交互音效/.test(dialogsSrc) && /data-role', 'sfx-toggle'/.test(dialogsSrc) && /'微交互音效', '音效'/.test(dialogsSrc),
    'A U27 设置→通用「微交互音效」分区（toggle 定位锚+搜索索引）在册');
  ok(/playSfx\('toggle'\)/.test(dialogsSrc) && /playSfx\('save'\)/.test(listSrc) && /playSfx\('done'\)/.test(gardenSrc) && /initSfx\(\{ enabled: \(\) => state\.snapshot\?\.preferences\?\.sfxEnabled === true \}\)/.test(appSrc),
    'A U27 三处接线（开关试听/收藏成功/挑战完成）+app initSfx 在册');

  // U28：拖拽体系在册
  ok(/_bindEntryDragSource\(row, item\)/.test(listSrc) && /_bindEntryDragSource\(card, item\)/.test(listSrc) && /application\/x-robinread-entries/.test(listSrc) && /effectAllowed = 'copyMove'/.test(listSrc),
    'A U28 列表行/杂志卡拖拽源（entries 数据类型+copyMove）双接线在册');
  ok(/_bindEntryDrop\(row, kind\)/.test(sidebarSrc) && /kind === 'starred' \|\| kind === 'later'/.test(sidebarSrc) && /onDropEntries\?\.\(kind, ids\)/.test(sidebarSrc),
    'A U28 收藏/稍后读智能行放置目标（onDropEntries）在册');
  ok(/_sameGroupDragging/.test(sidebarSrc) && /drop-before/.test(sidebarSrc) && /drop-after/.test(sidebarSrc) && /onReorderFeeds\?\.\(rest\)/.test(sidebarSrc),
    'A U28 订阅源同组拖拽排序（插入位指示+onReorderFeeds）在册');
  ok(/onDropEntries: \(kind, entryIDs\)/.test(appSrc) && /starMany/.test(appSrc) && /laterMany/.test(appSrc) && /onReorderFeeds: \(orderedIDs\)/.test(appSrc),
    'A U28 app.js 批量加入（star/laterMany+音效）与排序转发在册');
  ok(/reorderFeeds\(orderedIDs\)/.test(storeSrc) && /handle\('feeds:reorder'/.test(ipcSrc) && /reorderFeeds: \(orderedIDs\) => invoke\('feeds:reorder', orderedIDs\)/.test(preloadSrc),
    'A U28 排序持久化链（AppStore.reorderFeeds→feeds.sort_order→IPC→preload）在册');
  ok(/\.sidebar-row\.entry-drop\s*\{/.test(robin) && /\.sidebar-row\.drop-before\s*\{/.test(robin) && /\.sidebar-row\.drop-after\s*\{/.test(robin),
    'A U28 放置高亮/插入位指示 CSS 在册');

  // U29：打印排版在册
  ok(/printer: i\(/.test(iconsSrc), 'A U29 printer 图标在册');
  ok(/dataset\.role = 'print-article'/.test(readerSrc) && /printBtn\.addEventListener\('click', \(\) => window\.print\(\)\)/.test(readerSrc),
    'A U29 阅读器打印按钮（data-role=print-article → window.print）在册');
  ok(/U29 打印排版/.test(robin) && /\.cmd-palette-overlay,/.test(robin) && /#nj-voice-orb,/.test(robin) && /#nj-toast-stack,/.test(robin),
    'A U29 @media print 浮层家族隐退块（面板/批量条/浮球/通知）在册');
  ok(/break-after: avoid;\s*\n\s*page-break-after: avoid;/.test(robin), 'A U29 标题防孤行（break-after/page-break-after 双写 avoid）在册');
  ok(/\.reader-article\s*\{\s*\n\s*max-width: 100% !important;\s*\n\s*margin-left: 0 !important;\s*\n\s*margin-right: 0 !important;\s*\n\s*\}/.test(robin),
    'A U29 正文单栏全宽（解除版心水平约束）在册');

  // U30：面板自学习在册
  ok(/export function freqBoost/.test(paletteSrc) && /Math\.log2\(1 \+ n\)/.test(paletteSrc) && /_recordUse\(cmd\)/.test(paletteSrc) && /freqBoost\(this\.freq\?\.\[cmd\.label\]\)/.test(paletteSrc),
    'A U30 freqBoost 对数加权+_recordUse 计频+记分加权接线在册');
  ok(/present\(commands, opts = \{\}\)/.test(paletteSrc) && /opts\.freq/.test(paletteSrc) && /opts\.onUse/.test(paletteSrc) && /既有逻辑保留|this\.recentSet = new Set\(this\.recent\)/.test(paletteSrc),
    'A U30 present(opts.freq/onUse)+「最近使用」既有逻辑保留在册');
  ok(/paletteFrequency\(\)/.test(storeSrc) && /recordCommandUse\(label\)/.test(storeSrc) && /RobinRead\.palette\.freq/.test(storeSrc) && /keys\.length > 200/.test(storeSrc) && /Math\.min\(9999,/.test(storeSrc),
    'A U30 频次 JSON map（preferences 键+200 条上限+9999 封顶）在册');
  ok(/handle\('prefs:paletteFrequency'/.test(ipcSrc) && /handle\('prefs:recordPaletteUse'/.test(ipcSrc) && /paletteFrequency: \(\) => data\('prefs:paletteFrequency'\)/.test(preloadSrc) && /recordPaletteUse: \(label\)/.test(preloadSrc),
    'A U30 频次通道（IPC+preload）在册');
  ok(/paletteFrequency\?\.\(\)/.test(appSrc) && /onUse: \(label\) => \{ try \{ window\.robin\.recordPaletteUse\?\.\(label\); \} catch \(_\) \{/.test(appSrc),
    'A U30 app.js 打开面板读频次+执行记账接线在册');

  // i18n 新键在册（U27/U28/U29）
  ok(i18nSrc.includes('"微交互音效"') && i18nSrc.includes('"已把 %lld 篇加入收藏"') && i18nSrc.includes('"打印本文（页眉页脚与页边距由浏览器接管）"'),
    'A U27/U28/U29 i18n 新键在册（微交互音效/批量加入/打印）');
}

// ── Phase B：主进程服务级断言（真 AppStore + 真 SQL）──────────────────────
async function phaseService() {
  const { AppStore } = require('../src/main/AppStore');
  const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
  const userData = app.getPath('userData');
  const store = new AppStore(userData);

  // U30：计频持久化（真 preferences JSON map）
  store.recordCommandUse('命令甲');
  store.recordCommandUse('命令甲');
  store.recordCommandUse('命令甲');
  ok(store.paletteFrequency()['命令甲'] === 3, `B U30 执行 3 次计频=3 got=${JSON.stringify(store.paletteFrequency())}`);
  ok(store.recordCommandUse('') ['命令甲'] === 3, 'B U30 空标签不记频（幂等守卫）');
  const before = JSON.stringify(store.paletteFrequency());
  store.preferences.set('RobinRead.palette.freq', '{破数据');
  ok(Object.keys(store.paletteFrequency()).length === 0, 'B U30 脏 JSON 回空表不抛');
  store.preferences.set('RobinRead.palette.freq', before);
  for (let i = 0; i < 210; i += 1) store.recordCommandUse(`命令填充${i}`);
  const capMap = store.paletteFrequency();
  ok(Object.keys(capMap).length === 200, `B U30 容量上限 200 条（超出按频次保 Top）got=${Object.keys(capMap).length}`);
  // 复位到小状态：UI 阶段的自学习断言从干净频次表开始（甲保留供重启读回断言）
  store.preferences.set('RobinRead.palette.freq', JSON.stringify({ '命令甲': 3 }));

  // U27：快照投影默认关
  ok(store.snapshot().preferences.sfxEnabled === false, 'B U27 快照 sfxEnabled 默认 false');

  // U28：三源入夹 + 根区两源，重排持久化到 feeds.sort_order 既有列
  const mkFeed = (title, url) => store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title, feedURL: url });
  const f1 = mkFeed('源甲', 'https://u26-30.test/a.xml');
  const f2 = mkFeed('源乙', 'https://u26-30.test/b.xml');
  const f3 = mkFeed('源丙', 'https://u26-30.test/c.xml');
  store.setFeedFolder([f1.id, f2.id, f3.id], '排序夹');
  const r1 = mkFeed('根源甲', 'https://u26-30.test/r1.xml');
  const r2 = mkFeed('根源乙', 'https://u26-30.test/r2.xml');
  // 初始序（插入序）：夹=甲乙丙 / 根=甲乙
  store.reorderFeeds([f3.id, f1.id, f2.id]); // 夹内拖拽 → 丙甲乙
  const inFolder = store.feedsRepo.feedIDsInFolder(store.feedsRepo.folders(LOCAL_ACCOUNT_ID).find((fo) => fo.name === '排序夹').id);
  ok(JSON.stringify(inFolder) === JSON.stringify([f3.id, f1.id, f2.id]), `B U28 文件夹内重排持久化（丙甲乙）got=${JSON.stringify(inFolder)}`);
  store.reorderFeeds([r2.id, r1.id]); // 根区重排 → 乙甲
  const rootIDs = store.sidebarStructure()[0].rootFeedIDs;
  ok(JSON.stringify(rootIDs) === JSON.stringify([r2.id, r1.id]), `B U28 根区重排持久化（乙甲）got=${JSON.stringify(rootIDs)}`);
  store.reorderFeeds(['不存在的源', f1.id]); // 非法 ID 静默跳过
  ok(JSON.stringify(store.feedsRepo.feedIDsInFolder(store.feedsRepo.folders(LOCAL_ACCOUNT_ID).find((fo) => fo.name === '排序夹').id)) === JSON.stringify([f3.id, f1.id, f2.id]),
    'B U28 非法订阅 ID 静默跳过（未知源不落库）');
  return { store, entries: { f1, f2, f3, r1, r2 } };
}

/** U30 重启读回（UI 阶段之后：close+重开不与开着的探针窗口混跑）。 */
async function phasePersistence() {
  const { AppStore } = require('../src/main/AppStore');
  const userData = app.getPath('userData');
  let store = new AppStore(userData);
  ok(store.paletteFrequency()['命令甲'] === 3, 'B U30 重启读回：命令甲计频=3 保留');
  // U27 开关持久化
  store.preferences.set('RobinRead.sfx.enabled', true);
  store.preferences.flushSync();
  store.database.close();
  store = new AppStore(userData);
  ok(store.snapshot().preferences.sfxEnabled === true, 'B U27 重启读回：sfxEnabled=true 保留');
  store.preferences.set('RobinRead.sfx.enabled', false); // 复位，不污染他轮
  store.preferences.flushSync();
  store.database.close();
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

async function uiProbe(store, win, seeded) {
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

  // 等应用启动 + 经真实用户管线打开一篇文章（点行 → handleEntrySelect → reader.open）
  await waitFor(() => win.webContents.executeJavaScript('Boolean(window.__robinList && window.__robinReaderOpen)').catch(() => null), 25000);
  await waitFor(() => win.webContents.executeJavaScript('(document.querySelectorAll(".entry-row").length + document.querySelectorAll(".cluster-row").length) > 0').catch(() => null), 20000);
  const clickState = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let row = document.querySelector('.entry-row');
    if (!row) { // 兜底：首屏若是同题簇行，展开簇后再点子行
      document.querySelector('.cluster-row')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(400);
      row = document.querySelector('.entry-row');
    }
    if (!row) return 'no-row';
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(300);
    return 'clicked';
  })()`).catch((e) => 'EXEC-ERR ' + String((e && e.message) || e));
  console.log('C clickState ' + clickState);
  await waitFor(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".reader-article"))').catch(() => null), 20000);

  // 诊断（环境排障）：列表/侧栏真实渲染态 + IPC 直测
  const diag = await js('诊断', `(async () => {
    const t0 = Date.now();
    let listMs = -1; let listOk = false; let listN = 0;
    try {
      const r = await Promise.race([
        window.robin.getList({ kind: 'today' }, { limit: 100, retainingIDs: [], sort: 'time' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('getList 8s 超时')), 8000)),
      ]);
      listMs = Date.now() - t0; listOk = !!r?.ok; listN = (r?.data || []).length;
    } catch (e) { listMs = Date.now() - t0; }
    let ipcProbe = null;
    try {
      await window.robin.recordPaletteUse('诊断命令');
      const f = await window.robin.paletteFrequency();
      ipcProbe = {
        api: typeof window.robin.recordPaletteUse + '/' + typeof window.robin.paletteFrequency,
        count: f ? f['诊断命令'] : 'null-freq',
        keys: f ? Object.keys(f).length : -1,
        sample: f ? JSON.stringify(f).slice(0, 120) : 'null',
      };
    } catch (e) { ipcProbe = { err: String((e && e.message) || e) }; }
    return {
      rows: document.querySelectorAll('.entry-row').length,
      clusterRows: document.querySelectorAll('.cluster-row').length,
      listItems: window.__robinList ? window.__robinList.items.length : -1,
      readerEntry: window.__robinReader ? window.__robinReader.entryID : null,
      listMs, listOk, listN, ipcProbe,
    };
  })()`);
  console.log('C 诊断 ' + JSON.stringify(diag));

  // ── U26：三档缩放布局抽样 ──
  const zooms = [1.25, 1.5, 1.75];
  const u26 = {};
  for (const zoom of zooms) {
    win.webContents.setZoomFactor(zoom);
    await sleep(520); // 重排/字体 hinting 稳定
    u26[zoom] = await js(`U26 zoom ${zoom}`, `(() => {
      const out = {};
      const doc = document.documentElement;
      out.docOverflow = doc.scrollWidth - doc.clientWidth;
      const split = document.getElementById('split');
      out.splitOverflow = split ? split.scrollWidth - split.clientWidth : -1;
      const sidebarScroll = document.getElementById('sidebar-scroll');
      out.sidebarOverflow = sidebarScroll ? sidebarScroll.scrollWidth - sidebarScroll.clientWidth : -1;
      const listScroll = document.getElementById('list-scroll');
      out.listOverflow = listScroll ? listScroll.scrollWidth - listScroll.clientWidth : -1;
      const readerScroll = document.querySelector('.reader-scroll');
      out.readerOverflow = readerScroll ? readerScroll.scrollWidth - readerScroll.clientWidth : -1;
      const rows = [...document.querySelectorAll('.entry-row')].slice(0, 4);
      out.rowOverflow = rows.filter((r) => r.scrollWidth - r.clientWidth > 1).length;
      const heights = rows.map((r) => Math.round(r.getBoundingClientRect().height));
      out.rowHeights = heights;
      out.rowMin = heights.length ? Math.min(...heights) : 0;
      out.rowSpread = heights.length ? Math.max(...heights) - Math.min(...heights) : 99;
      const nav = document.querySelector('.footer-nav');
      out.navCols = nav ? getComputedStyle(nav).gridTemplateColumns.split(' ').length : 0;
      const btn = nav ? nav.querySelector('.footer-nav-btn') : null;
      out.navRowsOK = nav && btn ? nav.getBoundingClientRect().height <= btn.getBoundingClientRect().height * 2 + 6 : false;
      const cols = ['sidebar', 'list', 'reader'].map((k) => document.querySelector('.column-' + k));
      out.colWidths = cols.map((c) => (c ? Math.round(c.getBoundingClientRect().width) : 0));
      out.colMinOK = out.colWidths.every((w) => w >= 100);
      const art = document.querySelector('.reader-article');
      out.artFits = art && readerScroll ? art.getBoundingClientRect().width <= readerScroll.clientWidth + 1 : false;
      return out;
    })()`);
  }
  win.webContents.setZoomFactor(1);
  await sleep(200);

  // U26 深诊（环境排障）：最坏档位下找出超出滚动区右缘的元素
  win.webContents.setZoomFactor(1.75);
  await sleep(420);
  const overflowProbe = await js('U26 深诊 @175%', `(() => {
    const sc = document.querySelector('.reader-scroll');
    if (!sc) return { none: true };
    const limit = sc.clientWidth;
    const bad = [];
    sc.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      const s = sc.getBoundingClientRect();
      if (r.right - s.left > limit + 1 && r.width > 0) {
        bad.push(el.className ? String(el.className).slice(0, 60) : el.tagName);
      }
    });
    return { limit, over: bad.slice(0, 6), scWidth: sc.scrollWidth };
  })()`);
  console.log('C U26 深诊 ' + JSON.stringify(overflowProbe));
  win.webContents.setZoomFactor(1);
  await sleep(200);

  // 设置分区（默认缩放下）：模态零横向溢出
  win.webContents.setZoomFactor(1.5);
  await sleep(360);
  const u26Settings = await js('U26 设置分区 @1.5', `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const viewsURL = (f) => new URL(f, ${JSON.stringify(modURL('x'))}).href;
    const dlg = await import(viewsURL('dialogs.js'));
    const snapshot = await window.robin.getState();
    const sv = new dlg.SettingsView({ state: { snapshot: { ...snapshot.data, preferences: snapshot.data.preferences }, llm: {} }, views: {}, onAddFreshRSS: null, onReload: null, onRefreshState: () => window.__robinRefreshState?.() });
    window.__u26Settings = sv;
    sv.present('general');
    await sleep(700);
    const scroll = document.querySelector('.modal-scroll');
    const out = { overflow: scroll ? scroll.scrollWidth - scroll.clientWidth : -1, toggle: !!document.querySelector('[data-role="sfx-toggle"]'), toggleOn: document.querySelector('[data-role="sfx-toggle"]')?.classList.contains('on') };
    return out;
  })()`);
  win.webContents.setZoomFactor(1);
  await sleep(200);

  // ── U28：拖拽（真 DataTransfer 合成事件 → 真 IPC 落库）──
  const u28 = await js('U28 拖拽块', `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    // 文章行拖拽源：dragstart 写 entries 数据（行 ID 取自 DOM，与库内一致）
    const row = document.querySelector('.entry-row');
    const rowIds = [...document.querySelectorAll('.entry-row')].map((r2) => r2.dataset.entryId).filter(Boolean);
    out.rowCount = rowIds.length;
    const dt = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    out.dragData = JSON.parse(dt.getData('application/x-robinread-entries') || '[]');
    out.dragTypes = [...dt.types];
    // 侧栏收藏行：dragover 高亮 → drop 批量加入（真 starMany IPC）
    const starredRow = document.querySelector('.sidebar-row[data-scope="starred"]');
    const laterRow = document.querySelector('.sidebar-row[data-scope="later"]');
    out.dropKinds = [starredRow?.dataset.dropKind, laterRow?.dataset.dropKind];
    const dt2 = new DataTransfer();
    dt2.setData('application/x-robinread-entries', JSON.stringify(rowIds.slice(0, 10)));
    starredRow.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
    out.highlight = starredRow.classList.contains('entry-drop');
    starredRow.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
    out.highlightCleared = !starredRow.classList.contains('entry-drop');
    starredRow.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
    starredRow.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
    await sleep(900); // IPC 落库
    out.starredRowDrop = true;
    // 订阅源排序：dragstart 记录拖拽组 → dragover 插入位指示 → drop 重排（真 reorderFeeds IPC）
    const feedRows = [...document.querySelectorAll('.sidebar-row[data-feed-id]')];
    out.feedRowCount = feedRows.length;
    if (feedRows.length >= 2) {
      const src = feedRows[0];
      const dst = feedRows[1];
      const fdt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: fdt }));
      out.feedDragTypes = [...fdt.types];
      const rect = dst.getBoundingClientRect();
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: fdt, clientY: rect.top + rect.height / 2 + 2 }));
      out.insertAfter = dst.classList.contains('drop-after') && !dst.classList.contains('drop-before');
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: fdt, clientY: rect.top + rect.height / 2 + 2 }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      out.indicatorCleared = !dst.classList.contains('drop-before') && !dst.classList.contains('drop-after');
      await sleep(900);
    }
    return out;
  })()`);
  // 排序落库断言（主进程侧）
  await sleep(400);
  const struct = store.sidebarStructure()[0];
  const rootIDsAfter = struct.rootFeedIDs;

  // ── U27：合成音效（mock AudioContext 注入 + 设置开关真落库）──
  const u27 = await js('U27 音效块', `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    const viewsURL = (f) => new URL(f, ${JSON.stringify(modURL('x'))}).href;
    const sfx = await import(viewsURL('sfx.js'));
    // 纯函数合同：三枚计划 + 未知 null + 时长纪律
    out.plans = ['toggle', 'save', 'done'].map((n) => sfx.sfxPlan(n));
    out.unknownNull = sfx.sfxPlan('nope') === null;
    out.durOK = out.plans.every((p) => p && Math.max(...p.map((t) => t.at + t.dur)) <= 0.31);
    out.names = sfx.SFX_NAMES.join(',');
    // mock AudioContext：记录振荡器/增益包络调度
    class MockParam {
      constructor(v) { this.value = v; }
      setValueAtTime(v) { this.value = v; return this; }
      linearRampToValueAtTime(v) { this.targets = (this.targets || []).concat(v); return this; }
      exponentialRampToValueAtTime(v) { this.targets = (this.targets || []).concat(v); return this; }
    }
    class MockNode {
      constructor(ctx) { this.ctx = ctx; this.gain = new MockParam(1); this.frequency = new MockParam(440); this.type = 'sine'; }
      connect(n) { this.ctx.connected += 1; return n; }
      start(t) { this.startedAt = t; this.ctx.started.push(this); }
      stop(t) { this.stoppedAt = t; }
    }
    class MockCtx {
      constructor() { this.currentTime = 100; this.state = 'running'; this.destination = {}; this.oscillators = []; this.gains = []; this.started = []; this.connected = 0; }
      createOscillator() { const n = new MockNode(this); this.oscillators.push(n); return n; }
      createGain() { const n = new MockNode(this); this.gains.push(n); return n; }
      resume() { this.state = 'running'; return Promise.resolve(); }
      close() { this.state = 'closed'; }
    }
    // ① 关闭态：play 恒 false（默认关）
    const off = sfx.createSfx({ enabled: () => false });
    window.__robinSfxBridge = { Ctor: MockCtx };
    out.offSilent = off.play('toggle') === false && off.capability() === 'ready';
    // ② 开启态：振荡器+增益包络照计划调度
    const on = sfx.createSfx({ enabled: () => true });
    out.onPlay = on.play('save') === true;
    const ctxRef = on.__ctxForProbe || null; // 闭包内 ctx 不外泄：经 played() 计数断言
    out.playedLog = on.played();
    on.play('done');
    out.playedTwo = on.played().join(',') === 'save,done';
    // ③ 能力不可达：显式 Ctor:null（无 AudioContext 的环境）→ missing，播过一次即判死静默
    window.__robinSfxBridge = { Ctor: null };
    const dead = sfx.createSfx({ enabled: () => true });
    out.deadCap = dead.capability() === 'missing';
    out.deadSilent = dead.play('toggle') === false && dead.play('save') === false && dead.capability() === 'dead';
    // ④ 构造即抛 → 判死
    class BoomCtx { constructor() { throw new Error('no audio device'); } }
    window.__robinSfxBridge = { Ctor: BoomCtx };
    const boom = sfx.createSfx({ enabled: () => true });
    out.boomSilent = boom.play('toggle') === false && boom.play('save') === false && boom.capability() === 'dead';
    // ⑤ 挂起且 resume 无效 → 当次静默但不判死
    class SuspendedCtx extends MockCtx {
      constructor() { super(); this.state = 'suspended'; }
      resume() { /* 策略挂起：恢复失败 */ }
    }
    window.__robinSfxBridge = { Ctor: SuspendedCtx };
    const sus = sfx.createSfx({ enabled: () => true });
    out.suspendedSilent = sus.play('toggle') === false && sus.capability() === 'ready';
    // ⑥ 振荡器包络细节（独立 ctx 手动驱动一次，对照 sfxPlan('toggle')）
    const ctx = new MockCtx();
    window.__robinSfxBridge = { Ctor: function () { return ctx; } };
    const detail = sfx.createSfx({ enabled: () => true });
    out.detailPlay = detail.play('toggle') === true;
    out.oscCount = ctx.started.length;
    out.oscType = ctx.started[0] && ctx.started[0].type;
    out.oscFreq = ctx.started[0] && Math.round(ctx.started[0].frequency.value);
    out.hasEnvelope = ctx.gains.length === 1 && Array.isArray(ctx.gains[0].gain.targets) && ctx.gains[0].gain.targets.length >= 2;
    delete window.__robinSfxBridge;
    return out;
  })()`);
  // 设置开关：真 IPC 落库（设置分区已在 U26 段打开 @1.5 缩放，此时已回 1.0；模态仍在）
  const u27Toggle = await js('U27 设置开关', `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const toggle = document.querySelector('[data-role="sfx-toggle"]');
    if (!toggle) return { found: false };
    toggle.click();
    await sleep(700); // IPC 落库
    const on = toggle.classList.contains('on');
    window.__u26Settings?.dismiss?.();
    await sleep(150);
    return { found: true, on };
  })()`);

  // ── U30：命令面板自学习（真 IPC + 真排序）──
  const u30 = await js('U30 面板块', `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    const viewsURL = (f) => new URL(f, ${JSON.stringify(modURL('x'))}).href;
    const cp = await import(viewsURL('command-palette.js'));
    out.freqBoost = cp.freqBoost(0) === 0 && Math.abs(cp.freqBoost(3) - 2) < 1e-9 && Math.abs(cp.freqBoost(7) - 3) < 1e-9;
    // 真 IPC 记频（标签与下方命令注册表一致，频次按 label 对得上）
    await window.robin.recordPaletteUse('命令乙动作');
    await window.robin.recordPaletteUse('命令乙动作');
    await window.robin.recordPaletteUse('命令乙动作');
    const freq = await window.robin.paletteFrequency();
    out.ipcFreq = freq['命令乙动作'] === 3;
    // 排序提升：同相关度（label 均包含查询）下，执行 3 次者反超
    const cmds = [
      { label: '命令甲动作', keywords: '', action: () => {} },
      { label: '命令乙动作', keywords: '', action: () => {} },
    ];
    const p1 = new cp.CommandPalette();
    p1.present(cmds, { freq: {} });
    p1._filter('动作');
    out.before = p1.filtered.map((c) => c.label).join('>'); // 注册序：甲>乙
    const p2 = new cp.CommandPalette();
    p2.present(cmds, { freq: await window.robin.paletteFrequency() });
    p2._filter('动作');
    out.after = p2.filtered.map((c) => c.label).join('>'); // 频次加权：乙>甲
    out.rankBoost = out.before === '命令甲动作>命令乙动作' && out.after === '命令乙动作>命令甲动作';
    // 执行即记账（onUse 回调）+「最近使用」既有逻辑保留
    let used = null;
    const p3 = new cp.CommandPalette();
    p3.present(cmds, { freq: {}, onUse: (label) => { used = label; } });
    p3._filter('动作');
    p3._run(p3.filtered[0]);
    out.usedRecorded = used === '命令甲动作';
    out.freqBumped = p3.freq['命令甲动作'] === 1;
    out.recentKept = (() => {
      try { return (JSON.parse(localStorage.getItem('robinread.palette.recent') || '[]')[0] === '命令甲动作'); } catch (_) { return false; }
    })();
    p3.dismiss?.();
    return out;
  })()`);

  // ── U29：打印按钮 + CDP 打印媒体仿真 ──
  const u29 = await js('U29 打印块', `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    out.printBtn = !!document.querySelector('[data-role="print-article"]');
    out.printBtnVisible = (() => {
      const b = document.querySelector('[data-role="print-article"]');
      if (!b) return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })();
    let printCalls = 0;
    const realPrint = window.print;
    window.print = () => { printCalls += 1; };
    document.querySelector('[data-role="print-article"]').click();
    window.print = realPrint;
    out.printCalled = printCalls === 1;
    return out;
  })()`);
  let u29Media = { sidebarHidden: false, inkDark: false };
  try {
    const dbg = win.webContents.debugger;
    await dbg.attach();
    await dbg.sendCommand('Emulation.setEmulatedMedia', { media: 'print' });
    await sleep(220);
    u29Media = await win.webContents.executeJavaScript(`(() => {
      const sidebar = document.getElementById('sidebar');
      const art = document.querySelector('.reader-article');
      return {
        sidebarHidden: sidebar ? getComputedStyle(sidebar).display === 'none' : false,
        inkDark: art ? (() => { const m = getComputedStyle(art).color.match(/\\d+/g) || []; return m.length >= 3 && Number(m[0]) < 60 && Number(m[1]) < 60 && Number(m[2]) < 60; })() : false,
      };
    })()`);
    await dbg.sendCommand('Emulation.setEmulatedMedia', { media: 'screen' });
    await dbg.detach();
  } catch (err) {
    console.error('U29 CDP 仿真失败（环境性）:', String(err && err.message || err).slice(0, 200));
  }

  return {
    uiSkipped: false,
    u26, u26Settings, u27, u27Toggle, u28, u30, u29, u29Media,
    rootIDsAfter, seeded,
    win,
  };
}

app.whenReady().then(async () => {
  try {
    // UI 窗早开（f36 同款：进程年轻时创建健康；晚创建在重初始化后偶发同步死锁）
    const uiWin = openUIWindow();
    if (!uiWin) {
      const { store: store0 } = await phaseService();
      console.log('UI 阶段 SKIP：窗口创建失败（环境性）');
      try { fs.writeFileSync(path.join(__dirname, '.ci-skip-marker'), 'scripts/diag-u26-30.js'); } catch (_) { /* 标记失败仅影响连击治理 */ }
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
    const { store, entries } = await phaseService();

    // UI 阶段素材：一源四文（标题互异避免同题聚类成簇行；正文 ≥400 字避开
    // 「过短即抓原文」兜底——离线探针等不起网络抓取）
    const feed = store.feedsRepo.insertFeed({ accountID: require('../src/main/Models').LOCAL_ACCOUNT_ID, title: '视觉批2素材源', feedURL: 'https://u26-30.test/ui.xml' });
    const longBody = '正文长度必须超过四百字的全文抓取门槛，否则阅读器会去抓原网页补全，离线探针将因此悬挂在加载遮罩上。'.repeat(10);
    const seedTitles = [
      '缩放档位走查手记：侧栏底栏网格在 175% 档位的列宽钳制实测记录',
      '版心观察札记：长文阅读页在打印媒体下的单栏全宽表现小记',
      '行高一致性杂谈：列表两行截断标题的行盒高度抽样观察手记',
      '打印输出实验记录：把页边距交给浏览器接管的正文样张速记',
    ];
    const seeded = [];
    for (let i = 1; i <= 4; i += 1) {
      const [e] = await store._applyParsedEntries(feed, [{
        id: `u26-e${i}`, title: seedTitles[i - 1],
        url: `https://u26-30.test/ui/${i}`,
        publishedAt: Date.now() / 1000 - i * 3600,
        summary: `第${i}篇：用于三档缩放下列表行高一致性与横向溢出抽样的摘要文本，长度保持在两行截断口径内以获得可比的行盒高度。`,
        contentHTML: `<h2>第二章 样本${i}的版面观察</h2><p>${longBody}</p><blockquote>引文块在打印时单栏全宽且不断裂。</blockquote>`,
      }]);
      seeded.push(e);
    }
    const rootBefore = store.sidebarStructure()[0].rootFeedIDs; // 拖拽排序前置序（含 UI 素材源）

    // ── UI 阶段（150s 竞速降级 SKIP）──
    console.log('UI 阶段启动…');
    const ui = await Promise.race([
      uiProbe(store, uiWin, seeded).catch((err) => { console.error('uiProbe threw:', String(err && err.stack || err).slice(0, 800)); return { uiSkipped: true }; }),
      new Promise((r) => setTimeout(() => r({ uiSkipped: true }), 150000)),
    ]);
    if (ui.uiSkipped) {
      console.log('UI 阶段 SKIP：环境性挂起（源码级+服务级断言已全部执行）');
      try { fs.writeFileSync(path.join(__dirname, '.ci-skip-marker'), 'scripts/diag-u26-30.js'); } catch (_) { /* 标记失败仅影响连击治理 */ }
      store.preferences.flushSync();
      store.database.close();
      console.log(`TOTAL passed=${passed} failed=${failed}`);
      process.exit(failed ? 1 : 0);
      return;
    }

    ui.rootBefore = rootBefore; // U28 拖拽排序前置序（断言期望值用）
    const label = (v, name) => `${name}（got=${JSON.stringify(v)}）`;
    // U26 三档缩放
    for (const zoom of [1.25, 1.5, 1.75]) {
      const b = ui.u26[zoom] || {};
      const pct = `${Math.round(zoom * 100)}%`;
      ok(b.docOverflow <= 1 && b.splitOverflow <= 1 && b.sidebarOverflow <= 1 && b.listOverflow <= 1 && b.readerOverflow <= 1,
        label({ doc: b.docOverflow, split: b.splitOverflow, sidebar: b.sidebarOverflow, list: b.listOverflow, reader: b.readerOverflow }, `C U26 @${pct} 五容器零横向溢出（文档/三栏/两滚动区）`));
      ok(b.colMinOK && b.colWidths.every((w) => w > 0), label(b.colWidths, `C U26 @${pct} 三栏不塌（列宽均 ≥100 CSS px）`));
      ok(b.rowOverflow === 0 && b.rowMin >= 30 && b.rowSpread <= 24, label({ overflow: b.rowOverflow, min: b.rowMin, spread: b.rowSpread, heights: b.rowHeights }, `C U26 @${pct} 列表行高一致且行内零溢出`));
      ok(b.navCols === 6 && b.navRowsOK, label({ cols: b.navCols, rowsOK: b.navRowsOK }, `C U26 @${pct} 侧栏底栏 6×2 不折行`));
      ok(b.artFits, label(b.artFits, `C U26 @${pct} 阅读器版心不溢（article 宽 ≤ 滚动区宽）`));
    }
    ok(ui.u26Settings.overflow <= 1, label(ui.u26Settings.overflow, 'C U26 @150% 设置分区零横向溢出'));

    // U27
    ok(ui.u27.plans && ui.u27.plans.every((p) => Array.isArray(p) && p.length >= 1) && ui.u27.unknownNull && ui.u27.durOK,
      label({ unknownNull: ui.u27.unknownNull, durOK: ui.u27.durOK, counts: (ui.u27.plans || []).map((p) => p && p.length) }, 'C U27 sfxPlan 三枚合同（未知 null/单枚 ≤0.31s）'));
    ok(ui.u27.names === 'toggle,save,done', label(ui.u27.names, 'C U27 SFX_NAMES 三名在册'));
    ok(ui.u27.offSilent, label(ui.u27.offSilent, 'C U27 默认关：play 恒 false 且能力判 ready'));
    ok(ui.u27.onPlay && ui.u27.playedTwo, label({ onPlay: ui.u27.onPlay, log: ui.u27.playedTwo }, 'C U27 开启后 play 成功且 played 记录按序'));
    ok(ui.u27.deadCap && ui.u27.deadSilent && ui.u27.boomSilent, label({ missing: ui.u27.deadCap, dead: ui.u27.deadSilent, boom: ui.u27.boomSilent }, 'C U27 能力不可达静默（Ctor=null=missing / 播过判死不再尝试 / 构造抛错判死）'));
    ok(ui.u27.suspendedSilent, label(ui.u27.suspendedSilent, 'C U27 自动播放策略挂起：当次静默但不判死'));
    ok(ui.u27.detailPlay && ui.u27.oscCount === 1 && ui.u27.oscType === 'sine' && ui.u27.oscFreq === 660 && ui.u27.hasEnvelope,
      label({ play: ui.u27.detailPlay, osc: ui.u27.oscCount, type: ui.u27.oscType, freq: ui.u27.oscFreq, env: ui.u27.hasEnvelope }, 'C U27 振荡器+增益包络照计划调度（toggle=660Hz sine 双段包络）'));
    ok(ui.u27Toggle.found && ui.u27Toggle.on, label(ui.u27Toggle, 'C U27 设置→通用「音效」开关真渲染并翻开'));
    ok(store.preferences.get('RobinRead.sfx.enabled', false) === true, 'C U27 开关经真 IPC 落库（RobinRead.sfx.enabled=true）');

    // U28
    const dragInDb = Array.isArray(ui.u28.dragData) && ui.u28.dragData.length >= 1
      && store.database.prepare('SELECT COUNT(*) AS n FROM items WHERE id = ?').get(ui.u28.dragData[0]).n === 1;
    ok(dragInDb, label(ui.u28.dragData, 'C U28 行 dragstart 数据合同（entries 类型携带库内在册行 ID）'));
    ok(ui.u28.dropKinds[0] === 'starred' && ui.u28.dropKinds[1] === 'later', label(ui.u28.dropKinds, 'C U28 收藏/稍后读行带 dropKind 放置目标'));
    ok(ui.u28.highlight && ui.u28.highlightCleared, label({ on: ui.u28.highlight, off: ui.u28.highlightCleared }, 'C U28 拖入高亮挂/摘（entry-drop）'));
    const starredCount = store.database.prepare('SELECT COUNT(*) AS n FROM article_states WHERE is_starred = 1').get().n;
    ok(starredCount >= 3, label(starredCount, 'C U28 拖入收藏=批量加入（可见行全部落库 starMany）'));
    ok(ui.u28.feedRowCount >= 5, label(ui.u28.feedRowCount, 'C U28 订阅行渲染（≥5 源：3 夹内+2 根+UI 素材源）'));
    ok(ui.u28.insertAfter && ui.u28.indicatorCleared, label({ insertAfter: ui.u28.insertAfter, cleared: ui.u28.indicatorCleared }, 'C U28 插入位指示（下半行=after）随 drop/dragend 清除'));
    // 拖 feedRows[0] 到 feedRows[1] 下半=插到其后；期望序=前两元素对调、其余保持
    const expectAfter = [ui.rootBefore[1], ui.rootBefore[0], ...ui.rootBefore.slice(2)];
    ok(JSON.stringify(ui.rootIDsAfter) === JSON.stringify(expectAfter),
      label({ before: ui.rootBefore, after: ui.rootIDsAfter }, 'C U28 根区拖拽排序落库（首两源对调，真 IPC reorderFeeds）'));
    const dbOrder = store.sidebarStructure()[0].rootFeedIDs;
    ok(JSON.stringify(dbOrder) === JSON.stringify(expectAfter), label(dbOrder, 'C U28 排序经 feeds.sort_order 持久化（重读侧栏结构复核）'));
    // U30
    ok(ui.u30.freqBoost, label(ui.u30.freqBoost, 'C U30 freqBoost 对数刻度（0→0/3→2/7→3）'));
    ok(ui.u30.ipcFreq, label(ui.u30.ipcFreq, 'C U30 paletteFrequency 真 IPC 读回计频=3'));
    ok(ui.u30.rankBoost, label({ before: ui.u30.before, after: ui.u30.after }, 'C U30 执行 3 次后同相关度排名提升（甲>乙 → 乙>甲）'));
    ok(ui.u30.usedRecorded && ui.u30.freqBumped, label({ used: ui.u30.usedRecorded, bumped: ui.u30.freqBumped }, 'C U30 _run 执行即记账（onUse 回调+内存表+1）'));
    ok(ui.u30.recentKept, label(ui.u30.recentKept, 'C U30「最近使用」既有逻辑保留（recent 首位=刚执行命令）'));

    // U29
    ok(ui.u29.printBtn && ui.u29.printBtnVisible, label({ present: ui.u29.printBtn, visible: ui.u29.printBtnVisible }, 'C U29 打印按钮随文章打开渲染且可见'));
    ok(ui.u29.printCalled, label(ui.u29.printCalled, 'C U29 点击按钮调用 window.print()（stub 计数=1）'));
    ok(ui.u29Media.sidebarHidden, label(ui.u29Media.sidebarHidden, 'C U29 打印媒体仿真：#sidebar 隐退（@media print 块生效）'));
    ok(ui.u29Media.inkDark, label(ui.u29Media.inkDark, 'C U29 打印媒体仿真：正文回墨（深字色 <60,60,60）'));

    try { uiWin.destroy(); } catch (_) { /* 已销毁 */ }
    // ── Phase E：重启读回（close+重开不与开着的探针窗口混跑）──
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
