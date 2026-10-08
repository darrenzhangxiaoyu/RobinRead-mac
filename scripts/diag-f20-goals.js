'use strict';
/**
 * diag-f20-goals.js — F20 阅读目标与专注会话端到端探针（run-all OFFLINE 集，全程离线）
 *
 * 覆盖（对应 F20 验收 8 条）：
 *  1 目标设置持久化：dailyGoal/weeklyGoal 跨重启读回；0=关合法；越界钳制
 *  2 进度环渲染：预灌今日 3 篇已读 / 目标 5 → 60%（goalProgress 聚合 + 看板环 3/5）
 *  3 达标恭喜一次性：未达标 false → 达标 true → 同日再查 false → 跨重启仍 false
 *  4 周进度条：昨日 2 + 今日 3 = 周 5 / 目标 10 → 看板周条 50%
 *  5 专注面板倒计时：注入时间加速（_nowImpl 拨过终点 + _intervalMs 加速 tick）→ 自然结束
 *  6 会话小结计数与复制：handleEntrySelect 钩子计数 ×2 + 批注事件 ×1 → 小结 + 剪贴板
 *  7 中途退出确认：运行中 requestClose → confirmBox → 确认后生成本次小结
 *  8 目标关闭（0）时进度环隐藏：知识看板无环 + 简报浮层无目标卡
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f20-goals-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

function localDateKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(userData);

    // ── 素材：源 + 文章（标记已读供 UI 观测）+ 阅读统计 ──
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '目标素材源', feedURL: 'https://f20.test/goals.xml' });
    const now = Math.floor(Date.now() / 1000);
    const ids = [];
    for (let i = 0; i < 6; i++) {
      ids.push(store._applyParsedEntries(feed, [{
        id: `f20-item-${i}`,
        title: `目标验证文章${i + 1}`,
        url: `https://f20.test/item/${i}`,
        publishedAt: now - i * 3600,
        summary: `第${i + 1}篇目标验证文章摘要。`,
        contentHTML: null,
      }])[0]);
    }
    // 预灌：今日 3 篇已读（markRead 走 recordBehavior read 通路）
    for (let i = 0; i < 3; i++) store.markRead(ids[i], true);
    // 昨日 2 篇（reading_stats 直灌，供周进度求和）
    const yesterday = localDateKey(Date.now() - 86400000);
    store.database.prepare(`
      INSERT INTO reading_stats (date, articles_read) VALUES (?, 2)
      ON CONFLICT(date) DO UPDATE SET articles_read = articles_read + 2
    `).run(yesterday);
    // 简报当日缓存（简报浮层走秒开路径 → 目标卡与电台按钮可渲染）
    store._saveTodayDigest('## 总览\n今日简报（F20 探针预灌）。', 3, [], 'brief');

    // ── 1. 目标设置持久化 ──
    {
      ok(store.dailyGoal() === 5 && store.weeklyGoal() === 0, `1 默认目标（日=${store.dailyGoal()}，周=${store.weeklyGoal()}）`);
      store.setDailyGoal(7);
      store.setWeeklyGoal(10);
      store.preferences.flushSync();
      const store2 = new AppStore(userData);
      ok(store2.dailyGoal() === 7 && store2.weeklyGoal() === 10, `1 跨重启读回（日=${store2.dailyGoal()} 周=${store2.weeklyGoal()}）`);
      ok(store2.setDailyGoal(0) === 0, '1 每日目标 0 = 关（合法）');
      ok(store2.setDailyGoal(-3) === 0 && store2.setDailyGoal(150) === 99, '1 越界钳制（负→0，超大→99）');
      ok(store2.setWeeklyGoal(-1) === 0 && store2.setWeeklyGoal(120) === 99, '1 周目标越界钳制');
      // UI 观测基线：日 5 / 周 0（周关闭 → 看板无周条，8 先行验证）
      store2.setDailyGoal(5);
      store2.setWeeklyGoal(0);
      store2.preferences.flushSync();

      // ── 2/4（主进程侧）. 进度聚合 ──
      const p = store2.readingGoalsProgress();
      ok(p.daily.enabled && p.daily.read === 3 && p.daily.goal === 5, `2 进度聚合（今日 ${p.daily.read}/${p.daily.goal}）`);
      ok(Math.abs(p.daily.pct - 0.6) < 1e-9 && !p.daily.done, `2 进度 60%（pct=${p.daily.pct}，done=${p.daily.done}）`);
      ok(p.weekly.enabled === false && p.weekly.goal === 0, '4 周目标关闭 → enabled=false');
      store2.setWeeklyGoal(10);
      const p2 = store2.readingGoalsProgress();
      ok(p2.weekly.enabled && p2.weekly.read === 5 && Math.abs(p2.weekly.pct - 0.5) < 1e-9,
        `4 周进度聚合（近7天 ${p2.weekly.read}/${p2.weekly.goal}，pct=${p2.weekly.pct}）`);
      store2.preferences.flushSync();
      await f20UIProbe(store2);
    }

    // ── 3. 达标恭喜一次性（同日不重复 + 跨重启不重复）──
    {
      const store3 = new AppStore(userData);
      const notYet = store3.celebrateDailyGoalIfDue();
      ok(notYet.celebrated === false && notYet.progress.daily.read === 3, '3 未达标 → 不庆祝');
      store3.knowledge.bumpRead();
      store3.knowledge.bumpRead(); // 今日 3 → 5（达标）
      const first = store3.celebrateDailyGoalIfDue();
      ok(first.celebrated === true && first.progress.daily.done, '3 达标 → 庆祝一次');
      const second = store3.celebrateDailyGoalIfDue();
      ok(second.celebrated === false, '3 同日再查 → 不重复庆祝');
      store3.preferences.flushSync();
      const store4 = new AppStore(userData);
      const acrossRestart = store4.celebrateDailyGoalIfDue();
      ok(acrossRestart.celebrated === false, '3 跨重启仍不重复（lastCelebrateDate 持久化）');
      // 目标关闭 → 不庆祝
      store4.setDailyGoal(0);
      ok(store4.celebrateDailyGoalIfDue().celebrated === false, '3 目标关闭（0）→ 不庆祝');
    }

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});

/** ── UI 冒烟（单窗口单注册）：知识看板环/周条 + 隐藏 + 简报目标卡 + 专注面板 ── */
async function f20UIProbe(store) {
  const { BrowserWindow } = require('electron');
  const { registerIPCHandlers } = require('../src/main/ipc');
  const win = new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
  });
  win.webContents.on('render-process-gone', (_e, details) => console.error('UI RENDER GONE:', details && details.reason));
  win.webContents.on('did-fail-load', (_e, code, desc) => console.error('UI LOAD FAIL:', code, desc));
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer:${level}] ${String(message).slice(0, 260)} (${path.basename(String(sourceId))}:${line})`);
  });
  const execWithTimeout = (js, label = 'step', ms = 30000) => Promise.race([
    win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
  registerIPCHandlers(store, win);
  console.log('UI: loading renderer…');
  let loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt += 1) {
    try {
      await Promise.race([
        win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html')),
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1100);

  await execWithTimeout(`(() => {
    window.__f20Errors = [];
    window.addEventListener('error', (e) => { (window.__f20Errors = window.__f20Errors || []).push('err: ' + String(e && e.message)); });
    window.addEventListener('unhandledrejection', (e) => { (window.__f20Errors = window.__f20Errors || []).push('rej: ' + String(e && e.reason)); });
    return true;
  })()`, 'inject-errors');

  const waitForJS = `async (fn, ms = 8000) => {
    const t0 = Date.now();
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 120)); }
  }`;
  const KNOWLEDGE_BTN = `[...document.querySelectorAll('.footer-nav-btn')].find((b) => (b.title || '').includes('知识'))`;
  const DASH_TAB = `[...document.querySelectorAll('.modal-nav-item')].find((el) => (el.textContent || '').includes('看板'))`;

  // 8 目标关闭（当前 周关/日 5？——日目标此刻为 5，先把日也关掉再验隐藏）
  const hidden = await execWithTimeout(`(async () => {
    const waitFor = ${waitForJS};
    try {
      await window.robin.statsSetGoal(0);
      await window.robin.setWeeklyGoal(0);
      // 打开知识中心 → 切到看板 tab（中心默认打开高亮 tab）
      ${KNOWLEDGE_BTN}.click();
      const tab = await waitFor(async () => ${DASH_TAB} || null);
      if (!tab) return { __err: '看板 tab 未找到' };
      tab.click();
      const dash = await waitFor(async () => document.querySelector('.kb-stats') ? true : null);
      const ringGone = await waitFor(async () => !document.querySelector('.kb-goal-ring') ? true : null);
      // 简报浮层（当日缓存秒开路径）
      document.querySelector('#digest-btn').click();
      const digestOpen = await waitFor(async () => document.querySelector('.digest-modal') ? true : null);
      await new Promise((r) => setTimeout(r, 900)); // mountDigestGoal 双 rAF + goalProgress 往返
      const digestGoalGone = !document.querySelector('.dg-goal');
      document.querySelector('#digest-close').click();
      // 关闭知识中心（Esc）
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return { dash: Boolean(dash), ringGone: Boolean(ringGone), digestOpen: Boolean(digestOpen), digestGoalGone };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (hidden.__err) ok(false, '8 目标隐藏探针异常 — ' + hidden.__err);
  else ok(hidden.dash && hidden.ringGone && hidden.digestOpen && hidden.digestGoalGone,
    `8 目标全关：看板环隐藏=${hidden.ringGone}，简报目标卡隐藏=${hidden.digestGoalGone}`);

  // 2/4 目标开启：日 5 / 周 10 → 看板环 3/5（60%）+ 周条 5/10（50%）
  const ring = await execWithTimeout(`(async () => {
    const waitFor = ${waitForJS};
    try {
      await window.robin.statsSetGoal(5);
      await window.robin.setWeeklyGoal(10);
      // 重开知识中心看板（Esc 已关）
      ${KNOWLEDGE_BTN}.click();
      const tab = await waitFor(async () => ${DASH_TAB} || null);
      tab.click();
      const ringEl = await waitFor(async () => document.querySelector('.kb-goal-ring .kb-goal-center') ? document.querySelector('.kb-goal-ring') : null);
      if (!ringEl) return { ring: false };
      const num = ringEl.querySelector('.kb-goal-center b').textContent;
      const denom = ringEl.querySelector('.kb-goal-center span').textContent;
      const weekBar = ringEl.querySelector('[data-role="weekly-bar"]');
      const weekNum = weekBar ? weekBar.querySelector('.kb-goal-week-num').textContent : '';
      const weekWidth = weekBar ? weekBar.querySelector('.kb-goal-week-bar i').getAttribute('style') || '' : '';
      const ringOffset = ringEl.querySelector('.kb-goal-fill').getAttribute('stroke-dashoffset') || '';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return { ring: true, num, denom, weekBar: Boolean(weekBar), weekNum, weekWidth, ringOffset };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (ring.__err) ok(false, '2 进度环探针异常 — ' + ring.__err);
  else if (!ring.ring) ok(false, '2 看板进度环未渲染');
  else {
    ok(ring.num === '3' && ring.denom.includes('5'), `2 进度环 3/5（实际 ${ring.num}${ring.denom}）`);
    ok(ring.weekBar && ring.weekNum.replace(/\s/g, '') === '5/10', `4 周进度条 5/10（实际 ${ring.weekNum}）`);
    ok(ring.weekWidth.includes('50%'), `4 周条宽度 50%（实际 ${ring.weekWidth}）`);
    ok(ring.ringOffset !== '', '2 SVG 环 stroke-dashoffset 在场（60% 弧长）');
  }

  // （回归）简报浮层目标卡随目标开启出现
  const digestGoal = await execWithTimeout(`(async () => {
    const waitFor = ${waitForJS};
    try {
      document.querySelector('#digest-btn').click();
      await waitFor(async () => document.querySelector('.digest-modal') ? true : null);
      const goal = await waitFor(async () => document.querySelector('.dg-goal') ? document.querySelector('.dg-goal') : null);
      const ringNum = goal ? (goal.querySelector('.dg-goal-num b') || {}).textContent || '' : '';
      const radioBtn = Boolean(document.querySelector('#digest-radio'));
      document.querySelector('#digest-close').click();
      return { present: Boolean(goal), ringNum, radioBtn };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (digestGoal.__err) ok(false, '简报目标卡探针异常 — ' + digestGoal.__err);
  else ok(digestGoal.present && digestGoal.ringNum === '3' && digestGoal.radioBtn,
    `简报浮层目标卡（今日 ${digestGoal.ringNum}/5）+ 电台按钮在场=${digestGoal.radioBtn}`);

  // 设置 →「目标」分区：每日/每周档位 + 当前进度行（随 IPC 即时刷新）
  const settingsGoals = await execWithTimeout(`(async () => {
    const waitFor = ${waitForJS};
    try {
      document.querySelector('#btn-add').click(); // 打开任意菜单无碍；设置经侧栏入口
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // 设置入口：侧栏底部「设置」（title 含「设置」）或命令面板；此处走侧栏齿轮按钮
      const gear = [...document.querySelectorAll('.footer-nav-btn, .sidebar-footer button')]
        .find((b) => (b.title || '').includes('设置'));
      if (!gear) return { __err: '设置入口未找到' };
      gear.click();
      const nav = await waitFor(async () => [...document.querySelectorAll('.modal .modal-nav-item')]
        .find((el) => (el.textContent || '').trim() === '目标') || null);
      if (!nav) return { __err: '「目标」分区未找到' };
      nav.click();
      const dailyRow = await waitFor(async () => [...document.querySelectorAll('.nj-goal-line')].length >= 2 ? true : null);
      const segs = [...document.querySelectorAll('.modal .settings-group .segmented')].map((s) => s.querySelectorAll('button').length);
      const goalLines = [...document.querySelectorAll('.nj-goal-line')].map((r) => (r.textContent || '').trim());
      const closeBtn = document.querySelector('.modal .modal-header .btn.icon-only');
      if (closeBtn) closeBtn.click();
      return { ok: Boolean(dailyRow), segs, goalLines };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (settingsGoals.__err) ok(false, '设置目标分区探针异常 — ' + settingsGoals.__err);
  else ok(settingsGoals.ok && settingsGoals.segs.length >= 2 && settingsGoals.goalLines.length >= 2,
    `设置「目标」分区：档位组=${settingsGoals.segs.length}，进度行=${JSON.stringify(settingsGoals.goalLines)}`);

  // ── 专注面板阶段（共用同一窗口/注册）──
  await focusPhase(win, execWithTimeout);

  const errors = await execWithTimeout(`(() => (window.__f20Errors || []).slice(0, 5))()`);
  ok((errors || []).length === 0, `UI 全程无渲染异常（${(errors || []).join(' | ') || 'clean'}）`);
  win.destroy();
}

/** ── UI 冒烟（专注阶段，复用既有窗口）：倒计时加速 / 小结计数复制 / 中途退出确认 ── */
async function focusPhase(win, execWithTimeout) {
  const { clipboard } = require('electron');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 入场：工具栏「专注」按钮（禅模式旁）→ 面板 idle 态
  const open = await execWithTimeout(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(80); }
    };
    try {
      const btn = document.querySelector('#cap-focus-session');
      if (!btn) return { __err: 'cap-focus-session 按钮缺失' };
      btn.click();
      const panel = await waitFor(() => document.querySelector('[data-role="focus-panel"]'));
      if (!panel) return { __err: '专注面板未出现' };
      const segBtns = [...panel.querySelectorAll('.nj-fp-seg-btn')].map((b) => b.textContent);
      const startBtn = Boolean(panel.querySelector('.nj-fp-start'));
      return { segBtns, startBtn };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (open.__err) ok(false, '专注面板入场异常 — ' + open.__err);
  else ok(Array.isArray(open.segBtns) && open.segBtns.length === 3 && open.startBtn,
    `专注面板入场：时长三档（${(open.segBtns || []).join('/')}），开始按钮=${open.startBtn}`);

  // 6 会话计数：选 15 分钟 → 开始 → 钩子计数 ×2 + 批注事件 ×1
  const session = await execWithTimeout(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); }
    };
    try {
      const panel = document.querySelector('[data-role="focus-panel"]');
      const seg15 = [...panel.querySelectorAll('.nj-fp-seg-btn')].find((b) => b.textContent.includes('15'));
      seg15.click();
      panel.querySelector('.nj-fp-start').click();
      const running = await waitFor(() => window.__robinFocus.state === 'running' ? true : null);
      if (!running) return { __err: '会话未进入 running' };
      await sleep(300); // 等首帧 tick
      const clock = (panel.querySelector('.nj-fp-clock') || {}).textContent || '';
      const fillSet = (panel.querySelector('.nj-fp-fill') || {}).style ? panel.querySelector('.nj-fp-fill').style.strokeDasharray : '';
      // 计数钩子：handleEntrySelect 同款入口 ×2；批注事件 ×1
      window.__robinFocus.countRead();
      window.__robinFocus.countRead();
      document.dispatchEvent(new CustomEvent('robinread:annotation-created', { detail: { kind: 'note' } }));
      await sleep(120);
      const readCount = (panel.querySelector('.nj-fp-read') || {}).textContent || '';
      const annoCount = (panel.querySelector('.nj-fp-anno') || {}).textContent || '';
      return { clock, fillSet: Boolean(fillSet), readCount, annoCount };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (session.__err) ok(false, '6 会话计数探针异常 — ' + session.__err);
  else {
    ok(/^\d{2}:\d{2}$/.test(session.clock), `5 倒计时运行（时钟=${session.clock}）`);
    ok(session.fillSet, '5 倒计时环 stroke-dasharray 在场');
    ok(session.readCount === '2' && session.annoCount === '1', `6 会话计数（已读=${session.readCount} 批注=${session.annoCount}）`);
  }

  // 7 中途退出确认：requestClose → confirmBox → 确认 → 小结
  const early = await execWithTimeout(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(80); }
    };
    try {
      window.__robinFocus.requestClose(); // 运行中 → 确认框
      const confirmTitle = await waitFor(() => {
        const h = document.querySelector('.modal.small h3');
        return h && h.textContent.includes('专注') ? h.textContent : null;
      });
      if (!confirmTitle) return { __err: '中途退出确认框未出现' };
      const confirmBtn = [...document.querySelectorAll('.modal.small .modal-footer button')]
        .find((b) => b.textContent.includes('小结'));
      confirmBtn.click();
      const ended = await waitFor(() => window.__robinFocus.state === 'ended' ? true : null);
      await sleep(150);
      const panel = document.querySelector('[data-role="focus-panel"]');
      const summaryLines = [...(panel ? panel.querySelectorAll('.nj-fp-summary-line') : [])].map((el) => el.textContent);
      const earlyMark = Boolean(panel && panel.querySelector('.nj-fp-early'));
      return { confirmTitle, ended: Boolean(ended), summaryLines, earlyMark };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (early.__err) ok(false, '7 中途退出探针异常 — ' + early.__err);
  else {
    ok(Boolean(early.ended) && early.earlyMark, '7 中途退出确认 → 立即小结（提前结束标记在场）');
    ok(early.summaryLines.some((l) => l.includes('2 篇文章')) && early.summaryLines.some((l) => l.includes('批注 1 条')),
      `6 小结行（${early.summaryLines.join(' | ')}）`);
  }

  // 6 复制小结 → 主进程剪贴板
  let copied = false;
  try {
    clipboard.clear();
    await execWithTimeout(`(async () => {
      const btn = [...document.querySelectorAll('[data-role="focus-panel"] button')].find((b) => b.textContent.includes('复制'));
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 400));
      return true;
    })()`, 'copy-summary');
    const text = clipboard.readText('clipboard');
    copied = text.includes('专注小结') && text.includes('2 篇') && text.includes('批注 1 条');
  } catch (e) {
    console.error('copy step error:', e);
  }
  ok(copied, `6 复制小结到剪贴板（主进程读回=${copied}）`);

  // 5 自然结束（注入时间加速）：重开 → 15 分钟 → _nowImpl 拨过终点 + tick 加速
  const natural = await execWithTimeout(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 8000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); }
    };
    try {
      window.__robinFocus.close();
      window.__robinFocus.open();
      const panel = document.querySelector('[data-role="focus-panel"]');
      // tick 加速先设（间隔独立于时钟）；时钟在 start 之后拨——endsAt 由注入时钟推导，
      // 提前拨会连 endsAt 一起后移（加速失效）
      window.__robinFocus._intervalMs = 40;
      panel.querySelector('.nj-fp-start').click();
      const running = await waitFor(() => window.__robinFocus.state === 'running' ? true : null, 4000);
      if (!running) return { __err: '会话未进入 running' };
      window.__robinFocus._nowImpl = () => Date.now() + 25 * 60 * 1000;
      const ended = await waitFor(() => window.__robinFocus.state === 'ended' ? true : null, 6000);
      await sleep(120);
      const summaryShown = Boolean(document.querySelector('[data-role="focus-panel"] .nj-fp-summary'));
      const earlyGone = !document.querySelector('[data-role="focus-panel"] .nj-fp-early');
      return { ended: Boolean(ended), summaryShown, earlyGone };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (natural.__err) ok(false, '5 倒计时加速探针异常 — ' + natural.__err);
  else ok(natural.ended && natural.summaryShown && natural.earlyGone,
    `5 注入时间加速 → 自然到点结束（ended=${natural.ended} 小结=${natural.summaryShown} 无提前标记=${natural.earlyGone}）`);
}
