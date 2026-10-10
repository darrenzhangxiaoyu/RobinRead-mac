'use strict';
/**
 * diag-f36-clock.js — F36 阅读生物钟探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 v27 迁移：reading_clock（PK(day,hour) / hour CHECK 0-23 / count+total_ms）+ 老库重启无损
 *  2 小时桶累计：onRead 喂 count / pulse 喂 total_ms（15s 心跳口径）；越界钳制与噪声丢弃
 *  3 markRead 钩子：未读→已读计一次；重复已读不重复计；小时归属随注入时钟
 *  4 高峰判定：7 天窗口 / 加权（近一天权重高）/ Top2 小时 / 纯函数直测
 *  5 冷启动不判定：样本 < 20 → peak=null（不做无依据建议）
 *  6 窗口边界：8 天前样本不进窗；窗外旧行惰性清理（KEEP_DAYS）
 *  7 对齐动作 a：刷新调度建议（锚点偏峰→建议 HH:00 / 锚点在峰→不提示 / 无锚点→提示 / 无峰→静默）
 *  8 对齐动作 b：高峰专注提示（峰内 true / 峰外 false / 每天一次 / 开关关→false）
 *  9 对齐动作 c：简报生物钟行（UI：当日缓存简报顶部 .dg-clock + 高峰文案）
 * 10 设置开关持久化：clockConfig 三开关跨重启读回；快照 preferences.clock 投影
 * 11 热力条渲染（UI：24 桶 cell + 高峰 cell.peak + 样本注记 + 建议条）
 * 12 专注提示条（UI：浅色主题 + 峰内 → .nj-clock-prompt 出现；同日二次不再出）
 * 13 reader 脉冲接线（静态锚点：open/clear 落账 + clockPulse 通道）+ 注入时钟确定性
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f36-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const DAY = 86400;
// 注入时钟：固定在「今天 15:00」（本地时区确定性）
const T0 = (() => {
  const d = new Date();
  d.setHours(15, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
})();

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { ReadingClockService, CLOCK, peakHoursFrom, peakWindowLabel, sampleWeight, dayHourOf } = require('../src/main/ReadingClockService');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);
    const svc = store.clock;
    ok(svc instanceof ReadingClockService, '附 ReadingClockService 随 AppStore 构造（F36 接线）');
    svc._now = () => T0; // 注入时钟：全程确定性

    // ── UI 窗早开（f30 同款：进程年轻时 loadFile 健康）──
    const uiWin = await openUIWindow(store);
    setUIWin(uiWin);

    // ── 1. v27 迁移 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v27-reading-clock'").get(),
      '1 v27 迁移已入链');
    const clockSQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reading_clock'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/PRIMARY\s+KEY\s*\(\s*day\s*,\s*hour\s*\)/i.test(clockSQL), '1 reading_clock PK(day,hour) 在位（24 桶/天）');
    ok(/hour\s+INTEGER[^,]*CHECK\s*\(\s*hour\s+BETWEEN 0 AND 23\s*\)/i.test(clockSQL), '1 hour CHECK(0-23) 在位');
    ok(/count\s+INTEGER/i.test(clockSQL) && /total_ms\s+INTEGER/i.test(clockSQL), '1 count / total_ms 列在位');
    let hourErr = '';
    try { store.database.prepare("INSERT INTO reading_clock (day, hour, count, total_ms, updated_at) VALUES ('2026-01-01', 24, 1, 0, 1)").run(); }
    catch (e) { hourErr = String(e.message); }
    ok(/CHECK/i.test(hourErr), `1 hour=24 落库被 CHECK 拒（${hourErr.slice(0, 24)}…）`);

    // ── 2/3. 小时桶累计 + markRead 钩子 ──
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '生物钟素材源', feedURL: 'https://f36.test/clock.xml' });
    const mkEntry = async (id, title) => (await store._applyParsedEntries(feed, [{
      id, title, url: `https://f36.test/x/${id}`, publishedAt: T0 - 3600, summary: `${title}的摘要。`, contentHTML: `<p>${title}</p>`,
    }]))[0];
    const e1 = await mkEntry('f36-a1', '生物钟文章一');
    const e2 = await mkEntry('f36-a2', '生物钟文章二');
    const bucketAt = (day, hour) => store.database.prepare('SELECT count, total_ms FROM reading_clock WHERE day = ? AND hour = ?').get(day, hour);
    const today = dayHourOf(T0).day;
    const hourNow = dayHourOf(T0).hour;
    const before = bucketAt(today, hourNow)?.count || 0;
    store.markRead(e1); // 未读→已读：生物钟 +1
    ok((bucketAt(today, hourNow)?.count || 0) === before + 1, `3 markRead 喂桶（${before}→${bucketAt(today, hourNow).count}，hour=${hourNow}）`);
    store.markRead(e1); // 重复已读：不重复计
    ok((bucketAt(today, hourNow)?.count || 0) === before + 1, '3 重复已读不重复计（幂等）');
    store.markRead(e2);
    ok((bucketAt(today, hourNow)?.count || 0) === before + 2, '3 第二篇完读再 +1');

    // pulse：15s 心跳落账 + 钳制 + 噪声丢弃
    const msBefore = bucketAt(today, hourNow)?.total_ms || 0;
    svc.pulse(15000, { at: T0 });
    ok((bucketAt(today, hourNow)?.total_ms || 0) === msBefore + 15000, '2 pulse 15s 落账（total_ms +15000）');
    svc.pulse(CLOCK.PULSE_MAX_MS + 500000, { at: T0 });
    ok((bucketAt(today, hourNow)?.total_ms || 0) === msBefore + 15000 + CLOCK.PULSE_MAX_MS,
      `2 pulse 超限钳制到 ${CLOCK.PULSE_MAX_MS}ms（休眠不虚增）`);
    ok(svc.pulse(500, { at: T0 }).applied === false, `2 pulse < ${CLOCK.PULSE_MIN_MS}ms 噪声丢弃`);
    ok(svc.counters.pulsesClamped >= 1 && svc.counters.pulsesDropped >= 1, '2 钳制/丢弃计数器在账');

    // 注入时钟改小时：桶归属跟时钟走（确定性）
    svc.onRead({ at: T0 - 6 * 3600 }); // 今天 09:00
    const morningHour = dayHourOf(T0 - 6 * 3600).hour;
    ok((bucketAt(today, morningHour)?.count || 0) === 1, `3 注入时钟定桶：09:00 事件落 hour=${morningHour} 桶`);

    // ── 4/5/6. 高峰判定：窗口/加权/Top2/冷启动/边界 ──
    // 纯函数：近一天权重高
    ok(sampleWeight(0) > sampleWeight(1) && sampleWeight(1) > sampleWeight(6), '4 加权纯函数：近一天 > 昨天 > 6 天前');
    const pfTop = peakHoursFrom([
      { hour: 9, weight: 1 / 7, count: 30 },  // 6 天前 30 次 → 加权分 ≈ 4.3
      { hour: 22, weight: 1, count: 12 },     // 今天 12 次 → 加权分 12（Top1）
      { hour: 7, weight: 1, count: 6 },       // 今天 6 次 → 加权分 6（Top2，胜过 30 次旧样本）
    ]);
    ok(pfTop.includes(22) && pfTop.includes(7) && !pfTop.includes(9),
      `4 加权判定：今天 12 次（22 点）Top1、今天 6 次（7 点）胜 6 天前 30 次 → [${pfTop}]`);
    ok(peakWindowLabel([21, 22]) === '21:00-23:00' && peakWindowLabel([9, 22]).includes('09:00'), `4 相邻两小时合并窗口（21:00-23:00 / ${peakWindowLabel([9, 22])}）`);
    // 冷启动：新库无数据
    ok(svc.status({ now: T0 }).peak === null, '5 冷启动（0 样本）不判定高峰');
    // 窗口边界：8 天前灌 30 次 → 不进窗；今天 20/21 点灌 25+12 次 → 高峰确定性 [20,21]
    const day8 = dayHourOf(T0 - 8 * DAY).day;
    store.database.prepare('INSERT OR REPLACE INTO reading_clock (day, hour, count, total_ms, updated_at) VALUES (?, 20, 30, 0, ?)').run(day8, T0);
    store.database.prepare('INSERT OR REPLACE INTO reading_clock (day, hour, count, total_ms, updated_at) VALUES (?, 20, 25, 900000, ?)').run(today, T0);
    store.database.prepare('INSERT OR REPLACE INTO reading_clock (day, hour, count, total_ms, updated_at) VALUES (?, 21, 12, 300000, ?)').run(today, T0);
    const st1 = svc.status({ now: T0 });
    // 窗内样本 = hour20 25 + hour21 12 + hour15（markRead×2） + hour9（onRead×1） = 40
    ok(st1.samples === 40, `5/6 8 天前样本不进窗（samples=${st1.samples}，期望 40）`);
    ok(st1.peak.length === 2 && st1.peak[0] === 20 && st1.peak[1] === 21, `4 Top2 高峰确定性 [${st1.peak}]（期望 [20,21]）`);
    ok(st1.peakLabel === '20:00-22:00', `4 相邻高峰合并窗口（${st1.peakLabel}）`);
    ok(st1.buckets.length === 24 && st1.buckets[20] === 25, '6 24 桶投影（hour20=25）');
    ok(st1.isPeakNow === false, `8 注入时刻 15:00 不在高峰 → isPeakNow=false（峰=${st1.peak}）`);
    // 峰内判定：把注入时钟拨到 20:30
    const TPeak = T0 + (20 - 15) * 3600 + 1800;
    ok(svc.status({ now: TPeak }).isPeakNow === true, '8 峰内时刻（20:30）isPeakNow=true');

    // ── 7. 刷新调度建议 ──
    const advOff = svc.refreshAdvice({ anchorHour: 3, now: T0 });
    ok(advOff.suggest === true && advOff.hour === 20, `7 锚点 03:00 偏峰 → 建议 ${advOff.label}（hour=${advOff.hour}）`);
    const advAligned = svc.refreshAdvice({ anchorHour: 20, now: T0 });
    ok(advAligned.suggest === false && advAligned.reason === 'aligned', '7 锚点已在高峰 → 不提示');
    const advNoAnchor = svc.refreshAdvice({ anchorHour: null, now: T0 });
    ok(advNoAnchor.suggest === true && advNoAnchor.reason === 'no-anchor', '7 无刷新锚点 → 仍给高峰锚点建议');
    ok(svc.refreshAdvice({ anchorHour: 3, now: T0 - 40 * DAY }).suggest === false, '7 无峰（窗外空窗）→ 静默');

    // ── 8. 高峰专注提示（每天一次 / 开关）──
    ok(svc.shouldPromptFocus({ now: T0 }) === false, '8 非峰内时刻 → 不提示');
    ok(svc.shouldPromptFocus({ now: TPeak }) === true, '8 峰内时刻 + 开关默认开 → 提示');
    svc.markFocusPrompted({ now: TPeak });
    ok(svc.shouldPromptFocus({ now: TPeak }) === false, '8 同日第二次 → 不再提示（一次性/天）');
    svc.configure({ focusPrompt: false });
    ok(svc.shouldPromptFocus({ now: TPeak }) === false, '8 对齐开关关闭 → 不提示');
    svc.configure({ focusPrompt: true });

    // ── 10. 设置开关持久化（跨重启）──
    svc.configure({ alignRefresh: false, digestLine: false });
    store.preferences.flushSync();
    const store2 = new AppStore(userData);
    store2.clock._now = () => T0;
    const cfg2 = store2.clock.getConfig();
    ok(cfg2.alignRefresh === false && cfg2.focusPrompt === true && cfg2.digestLine === false,
      `10 三开关跨重启读回（align=${cfg2.alignRefresh} focus=${cfg2.focusPrompt} digest=${cfg2.digestLine}）`);
    const snapPrefs = store2.preferencesSnapshot();
    ok(snapPrefs.clock && snapPrefs.clock.alignRefresh === false, '10 快照 preferences.clock 投影（渲染层设置页数据面）');
    store2.clock.configure({ alignRefresh: true, digestLine: true });
    svc.configure({ alignRefresh: true, digestLine: true }); // 双实例偏好落盘：UI 侧用的还是第一个 store，同步翻开

    // ── 6b. 惰性清理：KEEP_DAYS 窗外旧行 ──
    const dayOld = dayHourOf(T0 - (CLOCK.KEEP_DAYS + 3) * DAY).day;
    store.database.prepare('INSERT OR REPLACE INTO reading_clock (day, hour, count, total_ms, updated_at) VALUES (?, 8, 5, 0, ?)').run(dayOld, T0);
    ok(!!store.database.prepare('SELECT 1 FROM reading_clock WHERE day = ?').get(dayOld), '6 窗外旧行先在位');
    svc.onRead({ at: T0 }); // 喂入顺手清理
    ok(!store.database.prepare('SELECT 1 FROM reading_clock WHERE day = ?').get(dayOld), `6 喂入惰性清理 ${CLOCK.KEEP_DAYS} 天外旧行`);

    // ── 13. 静态接线锚点（reader 脉冲 / IPC / preload / CSS / i18n）──
    const readerSrc = read('src/renderer/views/reader.js');
    ok(readerSrc.includes('window.robin?.clockPulse?.(elapsed)'), '13 reader 心跳 clockPulse 通道在位');
    ok(readerSrc.includes('_clockResume()') && readerSrc.includes('_clockPause()'), '13 reader open 起表 / clear 落账锚点在位');
    ok(read('src/main/preload.js').includes("clockPulse: (ms) => ipcRenderer.send('clock:pulse', ms)"), '13 preload clockPulse 在位');
    ok(read('src/main/ipc.js').includes("handle('clock:status'") && read('src/main/ipc.js').includes("ipcMain.on('clock:pulse'"), '13 IPC 状态/脉冲通道注册在位');
    const css = read('src/renderer/styles/robin.css');
    ok(css.includes('.nj-clock-heat-wrap') && css.includes('.nj-clock-cell.peak'), '11 热力条 CSS 在位');
    ok(!/border-radius: (?:4|6|7|8|10|12|14)px/.test(css.slice(css.indexOf('F35 语音指挥舱')))
      && !/font-size:\s*(?:[0-9]|1[0-9]\d?\.?\d*)px\s*[;}]/.test(css.slice(css.indexOf('F35 语音指挥舱')).replace(/var\(--fs-[^)]*\)/g, '')),
      '11/13 F35/F36 CSS 新块零 radius/字号字面量（护栏口径）');
    ok(read('src/main/I18NStrings.js').includes('你的高峰阅读时段，要进入专注模式吗？'), '13 I18N 锚点：专注提示文案双语表在位');

    // ── 9/11/12（UI 侧）：热力条 / 简报生物钟行 / 专注提示条 / 刷新建议条 ──
    await clockUIProbe(store, uiWin);

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});

/** ── UI 冒烟：设置生物钟组（热力条+建议）/ 简报生物钟行 / 专注提示条 ── */
async function clockUIProbe(store, win) {
  const { registerIPCHandlers } = require('../src/main/ipc');
  registerIPCHandlers(store, win);
  console.log('UI: loading renderer…');
  let loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt += 1) {
    try {
      await Promise.race([
        win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html')),
        new Promise((_, reject) => setTimeout(() => reject(new Error('loadFile timeout')), 25000)),
      ]);
      loaded = true;
    } catch (err) {
      console.error(`UI: load attempt ${attempt} failed — ${String(err && err.message || err)}`);
      if (attempt < 3) { try { await win.loadURL('about:blank'); } catch (_) { /* 原地再试 */ } }
    }
  }
  if (!loaded) { ok(false, 'UI 渲染层加载失败（3 次尝试均悬挂）'); win.destroy(); return; }
  console.log('UI: renderer loaded');
  await sleep(1200);

  // ── 11. 设置 → 通用：生物钟组（24 桶热力条 + 高峰标注 + 样本注记）──
  const heat = await execJS(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      // 侧栏底栏「设置」按钮（唯一入口，与侧栏 weekly/course 入口同排）
      const btn = [...document.querySelectorAll('.footer-nav-btn')].find((b) => (b.title || '').includes('设置'));
      if (!btn) return { open: false };
      btn.click();
      await sleep(700);
      if (!document.querySelector('.settings-modal')) return { open: false };
      const nav = [...document.querySelectorAll('.modal-nav-item')].find((el) => el.dataset.section === 'general');
      if (nav) nav.click();
      await sleep(900);
      const wrap = document.querySelector('[data-role="clock-heat"]');
      if (!wrap) return { open: true, wrap: false };
      const cells = wrap.querySelectorAll('.nj-clock-cell');
      const peakCells = wrap.querySelectorAll('.nj-clock-cell.peak');
      const note = wrap.querySelector('.nj-clock-heat-note')?.textContent || '';
      const alignRows = document.querySelectorAll('[data-role="clock-align"] .setting-row').length;
      return { open: true, wrap: true, cells: cells.length, peakCells: peakCells.length, note, alignRows };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (heat.__err) ok(false, '11 热力条探针异常 — ' + heat.__err);
  else if (!heat.open) ok(false, '11 设置窗未能打开（环境性）');
  else if (!heat.wrap) ok(false, '11 生物钟组未渲染（clock-heat 缺席）');
  else {
    ok(heat.cells === 24, `11 热力条 24 桶（实际 ${heat.cells}）`);
    ok(heat.peakCells === 2, `11 高峰小时标注（peak cell=${heat.peakCells}，峰 [20,21]）`);
    ok(String(heat.note).includes('20:00-22:00'), `11 样本注记含高峰窗口（${String(heat.note).slice(0, 40)}…）`);
    ok(heat.alignRows === 3, `11 对齐动作三开关在位（align rows=${heat.alignRows}）`);
  }
  // 关设置
  await execJS(`(() => { document.querySelector('.settings-modal')?.closest('.modal-overlay')?.remove(); return true; })()`);

  // ── 9. 简报生物钟行：当日缓存简报 + digest 打开 → .dg-clock 顶部行 ──
  store._saveTodayDigest('## 总览\n今日简报正文（F36 生物钟行载体）。', 3, [], 'brief');
  const digest = await execJS(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); } };
    try {
      window.__f36Errors = [];
      window.addEventListener('error', (e) => window.__f36Errors.push('err: ' + String(e && e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__f36Errors.push('rej: ' + String(e && e.reason)));
      const btn = document.querySelector('#digest-btn');
      if (!btn) return { __diag: 'no #digest-btn' };
      btn.click();
      const modal = await waitFor(() => document.querySelector('.digest-modal'));
      const bodyHtml = document.querySelector('.digest-modal .digest-body')?.innerHTML?.slice(0, 120) || '';
      const clock = await waitFor(() => document.querySelector('.digest-modal [data-role="digest-clock"]'));
      const text = clock?.querySelector('.dg-clock-text')?.textContent || '';
      const cfg = await window.robin.clockConfig?.();
      const st = await window.robin.clockStatus?.();
      document.querySelector('.digest-modal')?.closest('.modal-overlay')?.remove();
      return { found: Boolean(clock), text, modalOpened: Boolean(modal), bodyHtml, errors: window.__f36Errors, digestLine: cfg?.digestLine, peak: st?.peak };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (digest.__err || digest.__diag) ok(false, '9 简报生物钟行探针异常 — ' + String(digest.__err || digest.__diag));
  else if (!digest.modalOpened) ok(false, `9 简报浮层未打开（bodyHtml=${String(digest.bodyHtml).slice(0, 60)} errors=${(digest.errors || []).join('|')}）`);
  else {
    ok(digest.found, `9 简报顶部生物钟行浮出（.dg-clock；errors=${(digest.errors || []).join('|') || 'clean'} digestLine=${digest.digestLine} peak=${digest.peak}）`);
    ok(String(digest.text).includes('高峰') && /20:00/.test(String(digest.text)), `9 生物钟行文案含高峰窗口（${String(digest.text).slice(0, 42)}…）`);
  }

  // ── 9b. digestLine 开关关闭 → 行不渲染 ──
  store.clock.configure({ digestLine: false });
  const digestOff = await execJS(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 6000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); } };
    try {
      document.querySelector('#digest-btn')?.click();
      await waitFor(() => document.querySelector('.digest-modal .digest-body:not(.loading)'));
      await sleep(700); // 等 mountDigestClock 双 rAF
      const found = Boolean(document.querySelector('.digest-modal [data-role="digest-clock"]'));
      document.querySelector('.digest-modal')?.closest('.modal-overlay')?.remove();
      return { found };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (digestOff.__err) ok(false, '9b digestLine 关闭探针异常 — ' + digestOff.__err);
  else ok(digestOff.found === false, '9b 简报生物钟行开关关闭 → 行不渲染');
  store.clock.configure({ digestLine: true });

  // ── 12. 专注提示条：浅色主题 + 峰内时刻 + 每天一次 ──
  // 探针时钟拨回峰内（20:30）：UI 窗的 IPC 走的就是这个真 store
  store.clock._now = () => T0 + 5 * 3600 + 1800; // 20:30 峰内
  store.preferences.set('RobinRead.clock.focusPromptDay', '1999-01-01'); // 清「今天已提示」占位
  store.preferences.set('RobinRead.appTheme', 'light');
  const prompt = await execJS(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      await window.__robinRefreshState();
      const bar = await window.__robinClockPrompt?.();
      await sleep(300);
      const el = document.querySelector('[data-role="clock-focus-prompt"]');
      const text = el?.querySelector('.nj-clock-prompt-text')?.textContent || '';
      const goLabel = el?.querySelector('.nj-clock-prompt-go')?.textContent || '';
      el?.querySelector('.nj-clock-prompt-go')?.click();
      await sleep(400);
      const focusOpen = Boolean(document.querySelector('.nj-focus-overlay, .nj-focus-panel'));
      el?.remove();
      return { shown: Boolean(el), text, goLabel, focusOpen };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (prompt.__err) ok(false, '12 专注提示条探针异常 — ' + prompt.__err);
  else {
    ok(prompt.shown === true, '12 峰内 + 浅色主题 → 提示条浮出');
    ok(String(prompt.text).includes('高峰') && String(prompt.goLabel).length > 0, `12 提示文案与行动键（${String(prompt.text).slice(0, 28)}… / ${prompt.goLabel}）`);
    ok(prompt.focusOpen === true, '12 「进入专注模式」→ 专注面板打开');
  }
  // 同日第二次：不再出
  const prompt2 = await execJS(`(async () => {
    await window.__robinClockPrompt?.();
    await new Promise((r) => setTimeout(r, 300));
    return Boolean(document.querySelector('[data-role="clock-focus-prompt"]'));
  })()`);
  ok(prompt2 === false, '12 同日第二次不再提示（一次性/天）');

  // ── 7b. 刷新设置页建议条（锚点偏峰）──
  store.clock.configure({ alignRefresh: true });
  const refreshTip = await execJS(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      // 上一步已关设置窗：重新打开（侧栏底栏「设置」按钮）
      if (!document.querySelector('.settings-modal')) {
        const sbtn = [...document.querySelectorAll('.footer-nav-btn')].find((b) => (b.title || '').includes('设置'));
        if (!sbtn) return { nav: false };
        sbtn.click();
        await sleep(800);
      }
      const nav = [...document.querySelectorAll('.modal-nav-item')].find((el) => el.dataset.section === 'refresh');
      if (!nav) return { nav: false };
      nav.click();
      await sleep(900);
      const tip = document.querySelector('.settings-modal [data-role="clock-refresh-tip"]');
      const text = tip?.textContent || '';
      document.querySelector('.settings-modal')?.closest('.modal-overlay')?.remove();
      return { nav: true, found: Boolean(tip), text };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (refreshTip.__err) ok(false, '7b 刷新建议条探针异常 — ' + refreshTip.__err);
  else if (!refreshTip.nav) ok(false, '7b 设置窗已关（环境性，跳过）');
  else {
    ok(refreshTip.found, '7b 刷新设置页建议条浮出（锚点 03:00 偏峰）');
    ok(/20:00/.test(String(refreshTip.text)), `7b 建议条含「建议改到 20:00」语义（${String(refreshTip.text).slice(0, 40)}…）`);
  }

  win.destroy();
}

async function openUIWindow(store) {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: { contextIsolation: true, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
  win.webContents.on('render-process-gone', (_e, details) => console.error('UI RENDER GONE:', details && details.reason));
  win.webContents.on('did-fail-load', (_e, code, desc) => console.error('UI LOAD FAIL:', code, desc));
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer:${level}] ${String(message).slice(0, 240)} (${path.basename(String(sourceId))}:${line})`);
  });
  return win;
}

async function execJS(js, label = 'step', ms = 30000) {
  return Promise.race([
    uiWinRef().webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}

let _uiWin = null;
function setUIWin(win) { _uiWin = win; }
function uiWinRef() { return _uiWin; }
