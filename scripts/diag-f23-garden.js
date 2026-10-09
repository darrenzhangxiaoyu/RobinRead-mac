'use strict';
/**
 * diag-f23-garden.js — F23 知识花园 · 知更养成探针（run-all OFFLINE 集，全程离线）
 *
 * 覆盖：
 *  1 v23 迁移：garden_state 单行 / garden_events UNIQUE(kind,ref) / perspectives；
 *    老库无损升级（删 v23 行 + DROP 表 → 重开迁移链重建，业务数据原样）
 *  2 数值模型：完读浇水 / 防刷单次（重复完读零增量）/ 批注种子（<N 字不算）
 *  3 防刷与日切换：断读枯萎一级（不掉回零）/ 单次断读至多枯两级 / 回读复活 /
 *    连击断档重计 / 同日多次活动幂等
 *  4 五阶段跃迁：纯函数单调性 + 服务级 seed→sprout→bud 跃迁与 stage 事件流水
 *  5 知更羽毛：纯函数五档 + 累计完读 10 篇升级 + feather 事件
 *  6 开花报告：7 天窗口统计 / 阶段跃迁清单 / 新开花（to>=3）投影
 *  7 接线：AppStore.markRead 未读→已读浇水（重复已读不浇）/
 *    KnowledgeEngine.addNote / addHighlight(note) 种子钩子
 *  8 SVG 确定性：同状态逐字节同输出 / 不同状态输出不同 / 浮层渲染（花园+报告
 *    双 tab）/ 阶段跃迁入场动画类 / reduced-motion CSS 豁免锚点 / Esc 关浮层 /
 *    侧栏花园徽章
 * 附：静态接线锚点（preload/IPC/迁移/i18n/CSS）。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f23-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 190 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

// 固定「今天正午」：本地日界确定性（day0 = 2026-10-09）
const T0 = new Date(2026, 9, 9, 12, 0, 0).getTime() / 1000;
const DAY = 86400;

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { stageFromProgress, featherStage, dayDiff, GARDEN } = require('../src/main/GardenService');
    const userData = app.getPath('userData');
    let store = new AppStore(userData);
    const garden = store.garden;

    // ── 1. v23 迁移 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v23-garden-perspectives'").get(),
      '1 v23 迁移 garden-perspectives 已入链');
    const gsSQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='garden_state'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/CHECK\s*\(id\s*=\s*1\)/i.test(gsSQL), '1 garden_state 单行语义（CHECK id=1）');
    const geSQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='garden_events'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/UNIQUE\s*\(\s*kind\s*,\s*ref\s*\)/i.test(geSQL) && /'water'\s*,\s*'seed'\s*,\s*'wilt'\s*,\s*'revive'\s*,\s*'stage'\s*,\s*'feather'/i.test(geSQL),
      '1 garden_events UNIQUE(kind,ref) + 六类 kind CHECK（防刷地基）');
    const pSQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='perspectives'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/PRIMARY KEY\s*\(entry_id\s*,\s*related_entry_id\)/i.test(pSQL) && /'contradict'\s*,\s*'complement'\s*,\s*'echo'/i.test(pSQL),
      '1 perspectives 唯一约束防重 + relation CHECK 三类判定在位');
    ok(!!store.database.prepare('SELECT 1 FROM garden_state WHERE id = 1').get(), '1 花园单行状态已播种');

    // 场景源：12 篇可完读文章
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F23 花园苗圃', feedURL: 'https://f23.test/garden.xml' });
    const entries = [];
    for (let i = 1; i <= 12; i += 1) {
      entries.push({
        id: `f23-e${i}`, title: `花园文章 ${i}`, url: `https://f23.test/garden/${i}`,
        publishedAt: Math.floor(T0) - i * 3600, summary: `第 ${i} 篇花园观察笔记。`, contentHTML: `<p>第 ${i} 篇正文。</p>`,
      });
    }
    const ids = store._applyParsedEntries(feed, entries);
    ok(ids.length === 12, '附 场景源灌入 12 篇文章');

    // ── 老库无损升级：删 v23 行 + DROP 三表 → 重开 → 迁移重建、业务数据原样 ──
    store.database.prepare("DELETE FROM schema_migrations WHERE id = 'v23-garden-perspectives'").run();
    store.database.exec('DROP TABLE IF EXISTS perspectives; DROP TABLE IF EXISTS garden_events; DROP TABLE IF EXISTS garden_state;');
    store.database.close();
    store = new AppStore(userData);
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v23-garden-perspectives'").get()
      && !!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='garden_events'").get(),
      '1 老库升级：v23 重建（幂等重跑）');
    ok(store.database.prepare('SELECT COUNT(*) AS n FROM items').get().n === 12
      && store.feedsRepo.allFeeds().some((f) => f.id === feed.id),
      '1 老库升级：业务数据零丢失（12 篇文章 + 订阅源原样）');

    // ── 2/3/4/5. 数值模型（时间注入：固定今天正午起步）──
    const garden2 = store.garden;
    garden2._now = () => T0;
    let state = garden2.state();
    ok(state.stage === 0 && state.stageKey === 'seed' && state.sunStreak === 0 && state.waterTotal === 0,
      '2 初始态：种子阶段（stage0/阳光0/水滴0）');

    // 完读浇水 + 防刷单次
    garden2.onComplete({ entryID: 'f23-e1' });
    state = garden2.state();
    ok(state.waterTotal === 1 && state.waterToday === 1 && state.sunStreak === 1,
      '2 完读浇水：水滴 1 / 今日水滴 1 / 阳光 1');
    garden2.onComplete({ entryID: 'f23-e1' });
    state = garden2.state();
    ok(state.waterTotal === 1 && garden2.counters.dedupHits === 1,
      '2 防刷：同一篇重复完读零增量（UNIQUE(kind,ref) 吞掉）');

    // 批注种子（<N 字不算）
    garden2.onSeed({ ref: 'seed-short', chars: GARDEN.NOTE_MIN_CHARS - 1 });
    ok(garden2.state().seedTotal === 0, `2 批注 ${GARDEN.NOTE_MIN_CHARS - 1} 字不结种（防刷）`);
    garden2.onSeed({ ref: 'seed-ok', chars: GARDEN.NOTE_MIN_CHARS + 2 });
    state = garden2.state();
    ok(state.seedTotal === 1, `2 批注 ${GARDEN.NOTE_MIN_CHARS + 2} 字结种`);
    garden2.onSeed({ ref: 'seed-ok', chars: GARDEN.NOTE_MIN_CHARS + 2 });
    ok(garden2.state().seedTotal === 1, '2 防刷：同一条批注重复上报零增量');

    // 五阶段纯函数：单调性 + 边界
    ok(stageFromProgress(0, 0, 0) === 0 && stageFromProgress(1, 1, 1) === 1
      && stageFromProgress(2, 4, 2) === 2 && stageFromProgress(4, 10, 4) === 3
      && stageFromProgress(7, 20, 8) === 4,
      '4 五阶段规则：阈值边界精确（seed/sprout/bud/bloom/full）');
    ok(stageFromProgress(1, 1, 0) === 0 && stageFromProgress(6, 19, 8) === 3,
      '4 五阶段规则：缺任一维度不跃迁（单调不越级）');
    ok(featherStage(0) === 0 && featherStage(9) === 0 && featherStage(10) === 1
      && featherStage(30) === 2 && featherStage(80) === 3 && featherStage(200) === 4 && featherStage(500) === 4,
      '5 知更羽毛五档：阈值 0/10/30/80/200 精确');
    ok(dayDiff('2026-10-09', '2026-10-10') === 1 && dayDiff('2026-09-30', '2026-10-02') === 2,
      '附 日期差纯函数跨月正确');

    // 阶段跃迁：seed → sprout（此刻 sun1/water1/seed1）
    state = garden2.state();
    ok(state.stage === 1 && state.stageKey === 'sprout',
      '4 浇水+种子 → 幼苗（stage 1，可感跃迁）');
    const stageEvents = store.database.prepare("SELECT COUNT(*) AS n FROM garden_events WHERE kind = 'stage'").get().n;
    ok(stageEvents === 1, '4 stage 事件流水在册（stage 事件 1 条）');
    const countKind = (kind) => store.database.prepare("SELECT COUNT(*) AS n FROM garden_events WHERE kind = ?").get(kind).n;

    // 次日连击 + 推进到花蕾
    garden2._now = () => T0 + DAY;
    garden2.onComplete({ entryID: 'f23-e2' });
    state = garden2.state();
    ok(state.sunStreak === 2 && state.stage === 1, '3 次日完读：连击 2（花蕾还差水/养分）');
    garden2.onComplete({ entryID: 'f23-e3' });
    garden2.onComplete({ entryID: 'f23-e4' });
    garden2.onSeed({ ref: 'seed-2', chars: 30 });
    state = garden2.state();
    ok(state.stage === 2 && state.stageKey === 'bud' && state.waterTotal === 4 && state.seedTotal === 2,
      '4 连击+浇水 4+种子 2 → 花蕾（stage 2）');

    // 断读枯萎（一级，不掉回零）
    garden2._now = () => T0 + 3 * DAY; // lastActive=day1 → 缺勤 1 天
    garden2.onComplete({ entryID: 'f23-e5' });
    state = garden2.state();
    ok(state.stage === 1 && state.wiltLevel === 1,
      '3 断读枯萎一级（stage 2→1 幼苗，不掉回零）');
    ok(countKind('wilt') === 1, '3 wilt 事件流水在册');
    ok(state.sunStreak === 1, '3 断读后连击重计（=1）');
    ok(countKind('revive') === 0, '3 复活尚未发生（枯萎档在册，等阶段回升）');

    // 回读复活（次日连击 → 花蕾回升）
    garden2._now = () => T0 + 4 * DAY;
    garden2.onComplete({ entryID: 'f23-e6' });
    state = garden2.state();
    ok(state.stage === 2 && state.wiltLevel === 0,
      '3 回读复活：花蕾回升（stage 2 / 枯萎档清零）');
    ok(countKind('revive') === 1, '3 revive 事件在册（枯萎后阶段回升即复活）');

    // 长假封顶：单次断读至多枯两级（不毁园）
    garden2._now = () => T0 + 12 * DAY; // lastActive=day4 → 缺勤 7 天 → drop=min(7,2,2)=2
    garden2.onComplete({ entryID: 'f23-e7' });
    state = garden2.state();
    ok(state.stage === 1,
      '3 长假断读封顶两级（花蕾→种子后当日回芽 stage 1，不毁园）');
    const wiltRows = store.database.prepare("SELECT payload_json FROM garden_events WHERE kind = 'wilt' ORDER BY created_at ASC").all();
    ok(wiltRows.length === 2 && JSON.parse(wiltRows[1].payload_json || '{}').drop === 2,
      '3 第二次枯萎封顶 drop=2（WILT_MAX_DROP_PER_GAP 生效）');
    ok(countKind('revive') === 2, '3 长假后回读同样复活（revive 2 条）');

    // 同日多次活动：日切换只结一次
    garden2.onComplete({ entryID: 'f23-e8' });
    ok(countKind('wilt') === 2 && garden2.state().sunStreak === 1,
      '3 同日多次活动：日切换不重复结（wilt 仍 2 条 / 连击不变）');

    // 累计完读 → 羽毛升级（water 10：e9/e10 补齐）
    for (let i = 9; i <= 10; i += 1) garden2.onComplete({ entryID: `f23-e${i}` });
    state = garden2.state();
    ok(state.waterTotal === 10 && state.birdStage === 1,
      '5 累计完读 10 篇 → 知更羽毛升级（birdStage 1）');
    ok(countKind('feather') === 1, '5 feather 事件流水在册（每档至多一次）');

    // ── 6. 开花报告 ──
    // 注入一条「盛开」跃迁进本周窗口（报告是读模型，投影 to>=3）
    const todayStr = state.day;
    store.database.prepare(`
      INSERT OR IGNORE INTO garden_events (id, kind, ref, day, points, payload_json, created_at)
      VALUES ('probe-bloom', 'stage', '3@probe', ?, 1, '{"from":2,"to":3}', ?)
    `).run(todayStr, T0);
    const report = garden2.weeklyReport();
    ok(report.days.length === GARDEN.WEEK_REPORT_DAYS && report.days[report.days.length - 1].day === todayStr,
      '6 开花报告：7 天窗口逐日在册（末日=今天）');
    ok(report.waters === 4 && report.seeds === 0,
      `6 开花报告：窗口内浇水统计正确（4 = ${report.waters}）`);
    ok(report.stageUps.length >= 1 && report.newBlooms.length >= 1
      && report.newBlooms.every((b) => (b.to || 0) >= 3),
      '6 开花报告：阶段跃迁清单 + 新开花（to≥3）投影正确');
    ok(report.birdStage === 1 && report.sunStreak === state.sunStreak,
      '6 开花报告：羽毛档/连击与当前状态一致');

    // ── 7. 接线：AppStore.markRead / KnowledgeEngine 钩子 ──
    garden2._now = () => T0 + 13 * DAY; // 新的一天（明日再浇）
    const beforeHook = garden2.state().waterTotal;
    store.markRead(ids[11]); // 未读 → 已读（f23-e12 灌入时未读）
    ok(garden2.state().waterTotal === beforeHook + 1, '7 markRead 未读→已读：花园浇水（AppStore 钩子）');
    store.markRead(ids[11], true); // 已读再读：防刷
    ok(garden2.state().waterTotal === beforeHook + 1, '7 已读重复 markRead：零增量（防刷）');
    const seedsBefore = garden2.state().seedTotal;
    store.knowledge.addNote({ itemID: ids[11], content: '这是一条足够长的文章笔记，够十几个字。' });
    ok(garden2.state().seedTotal === seedsBefore + 1, '7 addNote ≥N 字：花园种子钩子生效');
    store.knowledge.addHighlight({ itemID: ids[11], text: '划线原文', note: '短' });
    ok(garden2.state().seedTotal === seedsBefore + 1, '7 纯划线（无批注/过短）：不结种');
    store.knowledge.addHighlight({ itemID: ids[11], text: '划线原文', note: '这是一段足够长的批注文字。' });
    ok(garden2.state().seedTotal === seedsBefore + 2, '7 带批注的高亮（≥N 字）：结种');

    // ── 8. SVG 确定性 + 浮层 UI（真 IPC）──
    const ui = await gardenUIProbe(store);
    ok(ui.booted, '附 UI 探针窗口启动（index.html + preload + 真 IPC）');
    ok(ui.svgDeterministic === true, '8 gardenArt 同状态逐字节同输出（确定性合同）');
    ok(ui.svgDiffersByStage === true, '8 不同状态 → 不同 SVG（阶段可感差异）');
    ok(ui.svgHasBird === true && ui.svgHasFlower === true, '8 SVG 含知更鸟与花株要素');
    ok(ui.badge === true && ui.badgeDot === true, '8 侧栏底部花园徽章在位（含阶段点）');
    ok(ui.overlayOpens === true && ui.sceneSvg === true, '8 点击徽章开花园浮层（内联 SVG 场景）');
    ok(ui.stageName === true && ui.stats === true, '8 浮层阶段铭牌 + 阳光/水滴/种子三计');
    ok(ui.stageUpClass === true, '8 阶段跃迁入场动画类（nj-garden-stageup）');
    ok(ui.reportTab === true && ui.reportTotals === true && ui.reportBlooms === true,
      '8 开花报告 tab：总量四计 + 新开花清单');
    ok(ui.escCloses === true, '8 Esc 关闭花园浮层');
    ok(ui.reduceMotionCSS === true, '8 reduced-motion 豁免锚点在 CSS（直达终态）');

    // ── 附：静态接线锚点 ──
    const preloadSrc = read('src/main/preload.js');
    ok(['gardenState', 'gardenReport', 'onGardenChanged', 'perspectivesAvailable',
      'perspectivesMirror', 'perspectivesCancel', 'perspectivesGroups'].every((n) => preloadSrc.includes(n)),
      '附 preload 桥花园/对照镜通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(['garden:state', 'garden:report', 'garden:changed', 'perspectives:available',
      'perspectives:mirror', 'perspectives:cancel', 'perspectives:groups'].every((c) => ipcSrc.includes(`'${c}'`)),
      '附 IPC 花园/对照镜通道注册齐备');
    const migrationsSrc = read('src/main/Persistence/DatabaseMigrations.js');
    ok(migrationsSrc.includes('v23-garden-perspectives') && migrationsSrc.includes('garden_events'),
      '附 v23 迁移在迁移链中（DDL 只进迁移链）');
    const stringsSrc = read('src/main/I18NStrings.js');
    ok(['"知识花园"', '"开花报告"', '"唱反调"', '"相辅相成"', '"遥相呼应"', '"观点对照镜"']
      .every((k) => stringsSrc.includes(k)),
      '附 i18n 中英键齐备（花园/开花报告/对照镜三组）');

    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
    console.log(failed === 0 ? 'ALL PASSED' : `FAILED ${failed}`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('ERR', String((err && err.stack) || err).slice(0, 1600));
    app.exit(1);
  }
});

/**
 * 花园 UI 探针：真 IPC 链路。徽章/浮层/双 tab/确定性全部走真实渲染。
 */
async function gardenUIProbe(store) {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: { contextIsolation: true, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
  const { registerIPCHandlers } = require('../src/main/ipc');
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1200);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 8000) => {
      const t0 = Date.now();
      for (;;) {
        let v = null;
        try { v = await fn(); } catch (_) { v = null; }
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(100);
      }
    };
    const out = { booted: true };
    try {
      // ── SVG 确定性（渲染层模块直测）──
      const { gardenArt } = await import('./views/garden-art.js');
      const tokens = { accent: '#617357', paper: '#eae8e1', ink: '#3f3a30' };
      const base = { stage: 2, birdStage: 1, wiltLevel: 0, sunStreak: 3, waterTotal: 7, seedTotal: 2, day: '2026-10-09', ...tokens };
      const a1 = gardenArt(base);
      await sleep(30);
      const a2 = gardenArt(base);
      out.svgDeterministic = a1 === a2 && a1.length > 500;
      out.svgDiffersByStage = gardenArt({ ...base, stage: 3 }) !== a1
        && gardenArt({ ...base, wiltLevel: 1 }) !== a1
        && gardenArt({ ...base, birdStage: 3 }) !== a1;
      out.svgHasBird = a1.includes('data-garden-art');
      out.svgHasFlower = a1.includes('<ellipse') && a1.includes('<circle');

      // ── 侧栏徽章 ──
      const badge = await waitFor(() => document.querySelector('.footer-garden-btn') ? true : null);
      out.badge = !!badge;
      out.badgeDot = !!document.querySelector('.footer-garden-btn .nj-garden-dot');

      // ── 浮层：点击徽章打开 ──
      document.querySelector('.footer-garden-btn').click();
      await sleep(400);
      out.debugInstant = !!document.querySelector('.nj-garden-overlay');
      out.debugHandle = typeof window.__robinGardenView;
      const overlay = await waitFor(() => document.querySelector('.nj-garden-overlay') ? true : null);
      out.overlayOpens = !!overlay;
      const scene = document.querySelector('.nj-garden-scene svg');
      out.sceneSvg = !!scene && scene.getAttribute('viewBox') === '0 0 320 200';
      const lastStage = Number(localStorage.getItem('robinread.garden.lastStage') || '0');
      out.stageName = (document.querySelector('.nj-garden-stage')?.textContent || '').length > 0;
      out.stats = document.querySelectorAll('.nj-garden-stat').length === 3
        && (document.querySelector('.nj-garden-stat i')?.textContent || '').length > 0;
      // 阶段跃迁动画类：当前 stage(来自 store, ≥1) > 记忆的 lastStage → 入场动画类
      // （浮层打开时已把 lastStage 写成当前值；重开一次并人为调低记忆即可复现跃迁）
      localStorage.setItem('robinread.garden.lastStage', '0');
      document.querySelector('.nj-garden-tab').click(); // 回花园 tab 重渲染
      await sleep(150);
      const scene2 = document.querySelector('.nj-garden-scene');
      out.stageUpClass = !!scene2 && scene2.className.includes('nj-garden-stageup');

      // ── 开花报告 tab ──
      const tabs = document.querySelectorAll('.nj-garden-tab');
      tabs[1].click();
      await sleep(120);
      out.reportTab = !!document.querySelector('.nj-garden-report');
      out.reportTotals = document.querySelectorAll('.nj-garden-report-totals span').length === 4;
      out.reportBlooms = document.querySelectorAll('.nj-garden-bloom-row').length >= 1;

      // ── Esc 关浮层 ──
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(120);
      out.escCloses = !document.querySelector('.nj-garden-overlay');
      return out;
    } catch (e) {
      return { booted: true, error: String((e && e.stack) || e).slice(0, 700) };
    }
  })()`);
  const css = read('src/renderer/styles/robin.css');
  if (result && !result.reduceMotionCSS) {
    result.reduceMotionCSS = css.includes('.nj-garden-stageup svg { animation: none; }');
  }
  win.destroy();
  if (!result || result.error) console.error('garden UI probe error:', result && (result.error || result));
  return result || {};
}
