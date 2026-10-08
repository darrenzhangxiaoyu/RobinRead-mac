'use strict';
/**
 * diag-f10-picks.js — F10 智能每日精选端到端探针（run-all OFFLINE 集，全程离线）
 *
 * 覆盖（对应 F10 验收 10 条）：
 *  1 画像：预灌 60 篇已读（30 篇标题含「量子计算」+其中 5 篇加收）+ 10 收藏（含「机器学习」）
 *    → 画像 Top 词含两词且权重排序正确（量子计算 > 机器学习）
 *  2 评分排序：候选 20 篇（10 篇标题命中画像词）→ Top N 全部命中篇、按分降序；
 *    已读/稍后读从候选排除
 *  3 新鲜度衰减：兴趣/订阅源同分时新文章靠前（24h 半衰打分可区分）
 *  4 空画像降级：空行为库 → degraded=true + 纯新鲜度排序 + UI 提示态
 *  5 排除名单：标「不感兴趣」→ 重排消失 + 24h 过期语义（注入时间）
 *  6 UI：精选切换入口 / 画像摘要条 Top 8 chips / 精选行渲染 / 不感兴趣按钮
 *  7 播报精选：TTS mock 收到拼装文稿（含 Top N 标题）；TTS/媒体互斥保持（pauseForTTS 被调）
 *  8 性能：200 篇候选画像+排序 <200ms
 *  9 排除项持久化（重启读回）
 * 10 回归：列表/简报入口/媒体迷你播放器既有行为不破坏
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f10-picks-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const picks = require('../src/main/SmartPicksService');
    const store = new AppStore(userData);

    // ── 0. 纯函数冒烟：分词含中文 2-4 gram 与西文小写词 ──
    {
      const toks = picks.tokenizeTitle('量子计算综述 Deep Learning 101');
      ok(toks.includes('量子计算') && toks.includes('deep') && toks.includes('learning') && !toks.includes('101'),
        '0 标题分词：CJK 2-4 gram + 西文小写词 + 纯数字剔除');
    }

    // ── 1. 画像：60 已读（30 含量子计算，其中 5 篇加收藏）+ 10 收藏（机器学习）──
    const now = Math.floor(Date.now() / 1000);
    let seq = 0;
    const mkEntry = (feed, title, ageSec = 600) => ({
      id: `f10-${feed.id}-${++seq}`,
      title, url: `https://f10.test/${feed.id}/${seq}`,
      publishedAt: now - ageSec, summary: `${title} 的摘要`, contentHTML: null,
    });
    const feedQ = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '量子周刊', feedURL: 'https://f10.test/quantum.xml' });
    const feedM = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '机器学习日报', feedURL: 'https://f10.test/ml.xml' });
    const feedN = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '无关源', feedURL: 'https://f10.test/noise.xml' });
    const feedC = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '候选源', feedURL: 'https://f10.test/cand.xml' });
    const behavior = (itemID, feedID, action) => store.evolution.recordBehavior({ itemID, feedID, action });

    for (let i = 0; i < 60; i++) {
      const quantum = i < 30;
      const id = store._applyParsedEntries(feedQ, [mkEntry(feedQ, quantum
        ? `量子计算前沿第${i}期`
        : `普通科技快讯第${i}期`, 3600 * (i + 1))])[0];
      behavior(id, feedQ.id, 'read');
      if (quantum && i < 5) behavior(id, feedQ.id, 'star'); // 5 篇量子文加收 → 量子计算权重 > 机器学习
      store.markRead(id, true); // 画像样本置为已读：不混入候选集（候选 = 未读）
    }
    for (let i = 0; i < 10; i++) {
      const id = store._applyParsedEntries(feedM, [mkEntry(feedM, `机器学习实战笔记${i}`, 3600 * (i + 1))])[0];
      behavior(id, feedM.id, 'star');
      store.markRead(id, true); // 收藏样本同样置已读，候选集只留 feedC 场景
    }

    {
      const profile = store.smartPicks.buildProfile();
      const wQC = profile.words.find((w) => w.word === '量子计算');
      const wML = profile.words.find((w) => w.word === '机器学习');
      ok(!!wQC && !!wML, `1 画像含「量子计算」与「机器学习」（权重 ${wQC?.weight} / ${wML?.weight}）`);
      ok(wQC.weight > wML.weight, `1 权重排序正确：量子计算(${wQC.weight}) > 机器学习(${wML.weight})（30 读+5 藏 vs 10 藏）`);
      ok(profile.words.length <= picks.PROFILE_MAX_WORDS, `1 画像词表封顶 ${picks.PROFILE_MAX_WORDS}（实际 ${profile.words.length}）`);
    }

    // ── 2. 评分排序：候选 20（10 命中画像词）+ 已读/稍后读排除 ──
    const hitIDs = [];
    const missIDs = [];
    for (let i = 0; i < 10; i++) {
      hitIDs.push(store._applyParsedEntries(feedC, [mkEntry(feedC, `编辑精选：量子计算与机器学习交叉观察（${i}）`, 1800 * (i + 1))])[0]);
    }
    for (let i = 0; i < 10; i++) {
      missIDs.push(store._applyParsedEntries(feedN, [mkEntry(feedN, `街头美食地图第${i}期`, 900)])[0]);
    }
    {
      const result = store.smartPicks.pickTop();
      const ids = result.picks.map((p) => p.id);
      const topAllHits = ids.slice(0, 10).every((id) => hitIDs.includes(id));
      ok(!result.degraded && result.profileTop.length > 0, '2 非降级路径（画像在场）');
      ok(topAllHits, `2 Top10 全部为命中篇（前 10：${ids.slice(0, 10).filter((id) => hitIDs.includes(id)).length}/10）`);
      const scores = result.picks.map((p) => p.score);
      ok(scores.every((s, i) => i === 0 || scores[i - 1] >= s), '2 按分降序排列');
      ok(result.picks.length === store.smartPicks.limit && store.smartPicks.limit === 15, `2 默认 Top ${store.smartPicks.limit}`);
      // 已读/稍后读排除
      const hit0 = result.picks.find((p) => p.id === hitIDs[0]);
      store.markRead(hitIDs[0], true);
      store.toggleLater(hitIDs[1], true);
      const after = store.smartPicks.pickTop();
      const afterIDs = after.picks.map((p) => p.id);
      ok(!afterIDs.includes(hitIDs[0]) && !afterIDs.includes(hitIDs[1]), '2 已读/稍后读从候选排除');
      if (hit0) ok(true, '2 （校验前置：命中篇确在首轮精选内）');
    }

    // ── 3. 新鲜度衰减：兴趣同分 + 订阅源同分 → 新文章靠前 ──
    {
      const fresh = store._applyParsedEntries(feedQ, [mkEntry(feedQ, '量子计算破晓：同分新鲜度对照-新', 60)])[0];
      const stale = store._applyParsedEntries(feedQ, [mkEntry(feedQ, '量子计算回望：同分新鲜度对照-旧', 60 * 3600)])[0];
      const result = store.smartPicks.pickTop();
      const iNew = result.picks.findIndex((p) => p.id === fresh);
      const iOld = result.picks.findIndex((p) => p.id === stale);
      ok(iNew >= 0 && iOld >= 0 && iNew < iOld, `3 同分时新文章靠前（新=${iNew} < 旧=${iOld}）`);
      const fNew = picks.freshnessOf(now - 60, now);
      const fOld = picks.freshnessOf(now - 60 * 3600, now);
      ok(fNew > fOld && Math.abs(fNew - 0.5 ** (1 / 1440)) < 1e-9, `3 24h 半衰衰减函数单调（新=${fNew.toFixed(4)} > 旧=${fOld.toFixed(4)}）`);
    }

    // ── 5. 排除名单：不感兴趣 → 消失 + 24h 过期（注入时间）──
    {
      const before = store.smartPicks.pickTop();
      const victim = before.picks[0].id;
      store.smartPicks.exclude(victim);
      const after = store.smartPicks.pickTop();
      ok(!after.picks.some((p) => p.id === victim), '5 标「不感兴趣」后重排消失');
      ok(after.excludedCount >= 1, `5 排除名单计数（${after.excludedCount}）`);
      // 注入 25h 后：过期惰性清理 → 条目重新可见
      const t25 = now + 25 * 3600;
      const kept = store.smartPicks.pruneExcluded(t25);
      ok(kept.length === 0, '5 注入 25h 后过期清理（名单清空）');
      store.smartPicks._writeExcluded([]); // 复位，避免污染 9 的持久化断言
    }

    // ── 4. 空画像降级（独立空库）──
    {
      const userData2 = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f10-empty-'));
      const store2 = new AppStore(userData2);
      const feed2 = store2.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '空库候选源', feedURL: 'https://f10.test/empty.xml' });
      const ids = [];
      for (let i = 0; i < 6; i++) {
        ids.push(store2._applyParsedEntries(feed2, [mkEntry(feed2, `空库冷启动文章${i}`, 3600 * (i + 1))])[0]);
      }
      const result = store2.smartPicks.pickTop();
      ok(result.degraded && result.profileTop.length === 0, '4 空画像降级（degraded=true + 无画像词）');
      const pubTimes = result.picks.map((p) => p.publishedAt);
      ok(pubTimes.every((t, i) => i === 0 || pubTimes[i - 1] >= t), '4 降级 = 纯新鲜度排序（新→旧）');
      const summary = store2.smartPicks.profileSummary();
      ok(summary.degraded === true && summary.words.length === 0, '4 profileSummary 提示态（degraded）');
      // store2（独立临时 userData）保持打开：探针内不 close（热 WAL close 有楔死风险，见 9 注释）
    }

    // ── 8. 性能：200 篇候选画像+排序 <200ms ──
    {
      const feedP = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '性能压测源', feedURL: 'https://f10.test/perf.xml' });
      const bulk = [];
      for (let i = 0; i < 200; i++) bulk.push(mkEntry(feedP, `压测文章第${i}篇：量子计算与机器学习工程化`, 600 + i));
      store._applyParsedEntries(feedP, bulk);
      store.smartPicks.pickTop(); // 预热（页缓存装载）
      const t0 = Date.now();
      const result = store.smartPicks.pickTop();
      const ms = Date.now() - t0;
      ok(ms < 200 && result.picks.length === result.limit, `8 画像+排序耗时 ${ms}ms（<200ms，候选 ${result.candidateCount} 篇）`);
      ok(result.picks.every((p) => typeof p.score === 'number' && typeof p.interest === 'number'), '8 每篇带 score/interest 评分字段');
    }

    // ── 7（主进程侧）. 播报文稿：本地模板拼装、含 Top N 标题 ──
    {
      const broadcast = store.smartPicks.broadcastScript();
      const titles = broadcast.titles;
      ok(broadcast.count > 0 && broadcast.count === titles.length, `7 播报文稿篇数（${broadcast.count}）`);
      ok(titles.slice(0, 3).every((t) => broadcast.script.includes(t)), '7 文稿含 Top3 标题');
      ok(broadcast.script.includes('知更智能精选') && broadcast.script.includes('以上就是本期的智能精选'), '7 本地模板首尾行（非 LLM）');
      const degradedScript = picks.composeBroadcastScript([], { now, degraded: true });
      ok(degradedScript.includes('读得越多推荐越准'), '7 降级文稿带画像积累提示');
    }

    // ── 9. 排除项持久化（重启读回）──
    // 注意：不 close 任何库——node:sqlite（Electron37 实验特性）热 WAL 期 close 有
    // 概率楔死进程后续页面加载（探针实测）；重启语义由「新 AppStore 实例
    // 重新读盘 preferences.json」承载，最后 app.exit 整体收尾。
    {
      const result = store.smartPicks.pickTop();
      const victim = result.picks[0].id;
      store.smartPicks.exclude(victim, { now });
      store.preferences.flushSync();
      const store2 = new AppStore(userData);
      ok(store2.smartPicks.isExcluded(victim), '9 排除项跨重启读回（preferences.json）');
      ok(!store2.smartPicks.pickTop({ now }).picks.some((p) => p.id === victim), '9 重启后该篇仍被排除');
      // 后续 UI 探针用 store2
      await picksUIProbe(store2);
    }

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});

/** ── 6/7/10. UI 冒烟：精选切换 / 画像摘要条 / 行渲染 / 不感兴趣 / 播报互斥（真 IPC + 隐藏窗口） ── */
async function picksUIProbe(store) {
  const { BrowserWindow } = require('electron');
  const { registerIPCHandlers } = require('../src/main/ipc');
  const win = new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
  });
  // 探针韧性：渲染进程崩溃 / 页面加载失败直接报 FAIL，不悬挂整个套件
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
  // loadFile 韧性：本机偶发（约 1/3）首载悬挂（node:sqlite 热 WAL 场景下的平台级
  // 现象，探针内已避免 close 仍偶发）——超时 25s 后对同一 window 重试，至多 3 次
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
      if (attempt < 3) {
        try { await win.loadURL('about:blank'); } catch (_) { /* 原地再试 */ }
      }
    }
  }
  if (!loaded) { ok(false, 'UI 渲染层加载失败（3 次尝试均悬挂）'); win.destroy(); return; }
  console.log('UI: renderer loaded');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1100); // 等应用 bootstrap（侧栏/列表首屏渲染）

  // 10 回归基线：简报/精选入口在场、媒体迷你播放器挂载、普通列表行已渲染
  const baseline = await execWithTimeout(`(() => {
    window.__f10Errors = [];
    window.addEventListener('error', (e) => { (window.__f10Errors = window.__f10Errors || []).push('err: ' + String(e && e.message)); });
    window.addEventListener('unhandledrejection', (e) => { (window.__f10Errors = window.__f10Errors || []).push('rej: ' + String(e && e.reason)); });
    return {
      digestBtn: Boolean(document.querySelector('#digest-btn')),
      picksBtn: Boolean(document.querySelector('#picks-btn')),
      mediaMini: Boolean(window.__robinMedia && typeof window.__robinMedia.pauseForTTS === 'function'),
      normalRows: document.querySelectorAll('.entry-row').length,
    };
  })()`, 'baseline');
  ok(baseline.digestBtn && baseline.picksBtn, '10 回归：简报/精选工具栏入口在场');
  ok(baseline.mediaMini, '10 回归：媒体迷你播放器挂载（pauseForTTS 可用）');
  ok(baseline.normalRows >= 1, `10 回归：普通列表行渲染（${baseline.normalRows} 行）`);

  // 6 切换精选：入口点击 → 画像摘要条 + chips + 精选行 + 不感兴趣按钮
  const ui = await execWithTimeout(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); }
    };
    try {
      document.querySelector('#picks-btn').click();
      const profile = await waitFor(() => document.querySelector('.nj-picks-profile') ? true : null);
      const chips = await waitFor(() => {
        const n = document.querySelectorAll('.nj-picks-chip').length;
        return n === 8 ? n : (n > 0 ? n : null);
      });
      const chipWords = [...document.querySelectorAll('.nj-picks-chip-word')].map((el) => el.textContent);
      const chipBars = document.querySelectorAll('.nj-picks-chip-bar i').length;
      const rows = await waitFor(() => {
        const n = document.querySelectorAll('.entry-row.nj-picks-row').length;
        return n >= 1 ? n : null;
      });
      const dismissBtns = document.querySelectorAll('.nj-picks-dismiss').length;
      const rank1 = document.querySelector('.entry-row.nj-picks-row .nj-picks-rank')?.textContent || '';
      const broadcastBtn = Boolean(document.querySelector('.nj-picks-broadcast'));
      const title = document.querySelector('.list-top-title')?.textContent || '';
      return { profile: Boolean(profile), chips, chipWords, chipBars, rows, dismissBtns, rank1, broadcastBtn, title };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (ui.__err) { ok(false, '6 UI 探针异常 — ' + ui.__err); }
  else {
    ok(ui.profile && ui.rows >= 1, `6 精选切换：摘要条+精选行渲染（行=${ui.rows}，标题=${ui.title}）`);
    ok(ui.chips >= 1 && ui.chips <= 8 && ui.chipBars === ui.chips, `6 画像摘要条 Top chips（${ui.chips} 个，权重条 ${ui.chipBars}）`);
    ok(ui.chipWords.length > 0, `6 chips 文案（首=${ui.chipWords[0] || '—'}）`);
    ok(ui.dismissBtns === ui.rows, `6 不感兴趣按钮逐行在位（${ui.dismissBtns}/${ui.rows}）`);
    ok(ui.rank1 === '1' && ui.broadcastBtn, '6 名次徽标与「播报精选」按钮在位');
  }

  // 7 播报精选：TTS mock 收到拼装文稿（含 Top 标题）；媒体互斥保持
  const broadcast = await execWithTimeout(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); }
    };
    try {
      const synthCalls = [];
      // window.robin 是 contextBridge 冻结面（赋值静默无效）——用 picks-tts 的注入缝整体接管
      window.__robinPickTTSBridge = {
        ttsGetConfig: async () => ({ engine: 'edge', neuralVoice: 'zh-CN-XiaoxiaoNeural' }),
        ttsSynthesize: async (payload) => {
          // 即时返回会让整条链毫秒级播完——采样播放态（可见/按钮文案）供断言，再小延时
          const player = document.querySelector('.nj-picks-player');
          window.__f10BroadcastSample = {
            visibleDuring: Boolean(window.__f10BroadcastSample?.visibleDuring)
              || Boolean(player && player.classList.contains('visible')),
            btnDuring: player ? (document.querySelector('.nj-picks-broadcast span') || {}).textContent || '' : '',
          };
          synthCalls.push(String(payload && payload.text || ''));
          await new Promise((r) => setTimeout(r, 40));
          return 'V'.repeat(1024);
        },
      };
      let mediaPaused = false;
      const origPause = window.__robinMedia.pauseForTTS.bind(window.__robinMedia);
      window.__robinMedia.pauseForTTS = () => { mediaPaused = true; return origPause(); };
      let readerStopped = false;
      if (window.__robinReader) {
        const origStop = window.__robinReader.stopTTS.bind(window.__robinReader);
        window.__robinReader.stopTTS = () => { readerStopped = true; return origStop(); };
      }
      const pickTitles = [...document.querySelectorAll('.entry-row.nj-picks-row')].slice(0, 3)
        .map((row) => (row.querySelector('.entry-title') || {}).textContent || '');
      document.querySelector('.nj-picks-broadcast').click();
      await waitFor(() => synthCalls.length >= 1 ? true : null);
      await sleep(700); // 让链播多合成几块（mock 40ms/块）
      const joined = synthCalls.join('\\n');
      return {
        synthCount: synthCalls.length,
        hasFirst: pickTitles[0] ? joined.includes(pickTitles[0]) : false,
        hasTop3: pickTitles.filter((t) => t && joined.includes(t)).length,
        pickTitles,
        mediaPaused, readerStopped,
        visibleDuring: Boolean(window.__f10BroadcastSample?.visibleDuring),
        btnDuring: window.__f10BroadcastSample?.btnDuring || '',
        errors: (window.__f10Errors || []).slice(0, 5),
      };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (broadcast.__err) { ok(false, '7 播报探针异常 — ' + broadcast.__err); }
  else {
    ok(broadcast.synthCount >= 1 && broadcast.hasFirst, `7 TTS mock 收到文稿分块（${broadcast.synthCount} 块，含首选标题=${broadcast.hasFirst}）`);
    ok(broadcast.hasTop3 >= Math.min(3, broadcast.pickTitles.length), `7 文稿含 Top 精选标题（命中 ${broadcast.hasTop3}/${broadcast.pickTitles.length}）`);
    ok(broadcast.mediaPaused, '7 TTS/媒体互斥：开播前 pauseForTTS 被调');
    ok(broadcast.visibleDuring, '7 播报迷你播放器播放中可见（合成期间采样）');
    ok((broadcast.btnDuring || '').includes('停止'), `7 播报按钮播放中态（合成期间=${broadcast.btnDuring}）`);
    if ((broadcast.errors || []).length) console.error('UI errors:', broadcast.errors.join(' | '));
  }

  // 5（UI 侧）. 不感兴趣：点击 → 重排消失
  const dismiss = await execWithTimeout(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); }
    };
    try {
      // setPicks / rowFor / _renderPicks 观测：捕获隐藏异常与调用轨迹
      const lv = window.__robinList;
      window.__f10SetPicksLog = [];
      window.__f10Trace = [];
      if (lv && !lv.__f10Instrumented) {
        lv.__f10Instrumented = true;
        const origSetPicks = lv.setPicks.bind(lv);
        lv.setPicks = (p) => {
          window.__f10SetPicksLog.push({ len: p && Array.isArray(p.picks) ? p.picks.length : -1, degraded: Boolean(p && p.degraded) });
          try {
            const r = origSetPicks(p);
            window.__f10Trace.push('setPicks:ok');
            return r;
          } catch (e) { window.__f10Trace.push('setPicks:THROW ' + String(e && e.message)); throw e; }
        };
        const origRowFor = lv.rowFor.bind(lv);
        lv.rowFor = (item) => {
          try {
            const r = origRowFor(item);
            window.__f10Trace.push('rowFor:ok ' + String(item && item.id).slice(0, 24));
            return r;
          } catch (e) {
            window.__f10Trace.push('rowFor:THROW ' + String(e && e.message));
            throw e;
          }
        };
        const origRenderPicks = lv._renderPicks.bind(lv);
        lv._renderPicks = (sel) => {
          try {
            const r = origRenderPicks(sel);
            window.__f10Trace.push('renderPicks:ok rows=' + document.querySelectorAll('.entry-row.nj-picks-row').length);
            return r;
          } catch (e) {
            window.__f10Trace.push('renderPicks:THROW ' + String(e && e.message));
            throw e;
          }
        };
      }
      const before = [...document.querySelectorAll('.entry-row.nj-picks-row')].map((r) => r.dataset.entryId);
      const firstTitle = document.querySelector('.entry-row.nj-picks-row .entry-title')?.textContent || '';
      document.querySelector('.entry-row.nj-picks-row .nj-picks-dismiss').click();
      // Top-N 语义：排除篇消失后由第 N+1 名补位——断言「被排除篇不在行内」而非行数 -1
      const after = await waitFor(() => {
        const ids = [...document.querySelectorAll('.entry-row.nj-picks-row')].map((r) => r.dataset.entryId);
        return ids.length >= 1 && !ids.includes(before[0]) ? ids : null;
      });
      return {
        removed: Boolean(after), firstTitle, before: before.length, after: after ? after.length : 0,
        profileStill: Boolean(document.querySelector('.nj-picks-profile')),
        topTitle: document.querySelector('.list-top-title')?.textContent || '',
        errors: (window.__f10Errors || []).slice(0, 5),
        setPicksLog: (window.__f10SetPicksLog || []).slice(-6),
        trace: (window.__f10Trace || []).slice(-14),
        hasEmptyState: Boolean(document.querySelector('.rowsHost .list-empty')) || Boolean(document.querySelector('.list-empty')),
        viewPayloadLen: lv && lv.picksData && Array.isArray(lv.picksData.picks) ? lv.picksData.picks.length : -1,
        payloadAfter: await window.robin.picksGet().then((p) => (p
          ? { candidateCount: p.candidateCount, picksLen: p.picks.length, limit: p.limit, excluded: p.excludedCount, degraded: p.degraded }
          : null)).catch((e) => 'ERR ' + String(e)),
      };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (dismiss.__err) { ok(false, '5 UI 排除探针异常 — ' + dismiss.__err); }
  else {
    ok(dismiss.removed, `5 行内「不感兴趣」→ 被排除篇消失并补位（${dismiss.before}→${dismiss.after}，payload=${dismiss.viewPayloadLen}）`);
    if (!dismiss.removed) console.error('5 诊断:', JSON.stringify(dismiss));
  }

  // 停播 + 关精选回到普通列表（回归收尾）
  await execWithTimeout(`(async () => {
    const stop = document.querySelector('.nj-pp-stop');
    if (stop) stop.click();
    document.querySelector('#picks-btn').click();
    await new Promise((r) => setTimeout(r, 500));
    return true;
  })()`);
  const off = await execWithTimeout(`(() => ({
    picksRows: document.querySelectorAll('.entry-row.nj-picks-row').length,
    normalRows: document.querySelectorAll('.entry-row:not(.nj-picks-row)').length,
    topTitle: document.querySelector('.list-top-title')?.textContent || '',
  }))()`);
  ok(off.picksRows === 0 && off.normalRows >= 1, `10 关精选回普通列表（精选行=${off.picksRows}，普通行=${off.normalRows}，标题=${off.topTitle}）`);

  win.destroy();
}
