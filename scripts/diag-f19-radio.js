'use strict';
/**
 * diag-f19-radio.js — F19 简报电台端到端探针（run-all OFFLINE 集，全程离线）
 *
 * 覆盖（对应 F19 验收 9 条）：
 *  1 模板文稿降级：无 AI（无 Key + preferAI=false）→ Top10 本地拼装，含日期开场白与结尾语
 *  2 AI 文稿改写（mock LLM）：当日简报已缓存 + 有 Key + preferAI → AI 稿；改写抛错 → 静默降级模板
 *  3 分句合成链（UI）：mock TTS 逐句合成 + 下一句预取链播（无手动操作句序自增）
 *  4 上一句/下一句/暂停/停止：胶囊按钮语义与状态机
 *  5 位置记忆：听到第 3 句（index 2）→ 重建 AppStore → 读回续听第 3 句（hash 变化失效）
 *  6 四方互斥：开电台停 媒体/阅读器朗读/精选；反向 精选开播停电台、媒体 deps 停电台
 *  7 合成缓存：同 hash 文稿重播，已合成句不重合成（内存缓存命中）
 *  8 入口：简报浮层「电台播放」按钮 + 命令面板「播放今日电台」
 *  9 迷你胶囊句序：第 X/Y 句 显示与推进
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f19-radio-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const radio = require('../src/main/DigestRadioService');
    const store = new AppStore(userData);

    // ── 素材：一个源 + 今日 12 篇未读 ──
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '电台素材源', feedURL: 'https://f19.test/radio.xml' });
    const now = Math.floor(Date.now() / 1000);
    const entries = [];
    for (let i = 0; i < 12; i++) {
      entries.push(store._applyParsedEntries(feed, [{
        id: `f19-item-${i}`,
        title: `电台头条第${i + 1}号`,
        url: `https://f19.test/item/${i}`,
        publishedAt: now - i * 60,
        summary: `这是第${i + 1}条电台素材的摘要内容，用于模板拼装验证。`,
        contentHTML: null,
      }])[0]);
    }

    // ── 1. 模板文稿降级（无 AI）──
    {
      const result = await store.digestRadio.radioScript({ preferAI: false });
      ok(result.source === 'template', `1 降级路径：source=template（实际 ${result.source}）`);
      ok(result.script.includes('知更电台') && result.script.includes('共 10 条'), '1 开场白含「知更电台」与条数（Top 10）');
      ok(/\d+ 年 \d+ 月 \d+ 日/.test(result.script), '1 开场白含日期');
      const titles = result.script.match(/电台头条第\d+号/g) || [];
      ok(titles.length === radio.RADIO_TOP_N, `1 Top10 拼装（命中 ${titles.length}/${radio.RADIO_TOP_N} 条标题）`);
      ok(result.script.includes('祝你阅读愉快'), '1 结尾语在场');
      ok(result.sentences.length >= 10 && result.sentenceTotal === result.sentences.length, `1 分句（${result.sentences.length} 句）`);
      ok(result.sentences.every((s) => s.length <= radio.RADIO_SENTENCE_MAX), `1 单句 ≤ ${radio.RADIO_SENTENCE_MAX} 字`);
      ok(typeof result.hash === 'string' && result.hash.length >= 8, `1 文稿 hash（${result.hash.slice(0, 8)}…）`);
    }

    // ── 2. AI 文稿改写（mock LLM）+ 失败降级 ──
    {
      store.hasAIAPIKey = () => true; // mock：有 Key
      store._saveTodayDigest('## 总览\n今日 AI 简报正文（供电台改写）。', 3, [], 'brief');
      store.digestRadio._aiRewriteImpl = async () => '（电台 AI 稿）各位听众早上好，下面开始今日播报。';
      const ai = await store.digestRadio.radioScript({ preferAI: true });
      ok(ai.source === 'ai' && ai.script.includes('电台 AI 稿'), `2 AI 改写路径（source=${ai.source}）`);
      // 注入缝优先；清空注入走真 LLM 路径的无 Key 降级（hasAIAPIKey=false → 模板）
      store.hasAIAPIKey = () => false;
      const tpl = await store.digestRadio.radioScript({ preferAI: true });
      ok(tpl.source === 'template', '2 无 Key 时 preferAI 仍降级模板');
      // 改写抛错 → 静默降级
      store.hasAIAPIKey = () => true;
      store.digestRadio._aiRewriteImpl = async () => { throw new Error('mock LLM down'); };
      const fallback = await store.digestRadio.radioScript({ preferAI: true });
      ok(fallback.source === 'template', '2 AI 改写抛错 → 静默降级模板');
      store.digestRadio._aiRewriteImpl = null;
      delete store.hasAIAPIKey; // 还原原型链方法（own 属性只是影子）
      ok(typeof store.hasAIAPIKey === 'function', '2 hasAIAPIKey 还原');
    }

    // ── 5（主进程侧）. 位置记忆：保存 → 重建 → 读回；hash 变化失效 ──
    {
      const sessionKey = store.digestRadio.sessionKey();
      store.digestRadio.savePosition(sessionKey, 2, { total: 12, hash: 'hash-v1' });
      ok(store.digestRadio.getPosition(sessionKey).index === 2, '5 位置保存（index=2，即第 3 句）');
      ok(store.digestRadio.getPosition(sessionKey, { hash: 'hash-v1' }).index === 2, '5 hash 匹配读回');
      ok(store.digestRadio.getPosition(sessionKey, { hash: 'hash-v2' }) === null, '5 文稿 hash 变化 → 位置失效');
      store.preferences.flushSync();
      const store2 = new AppStore(userData); // 重启语义：重新读盘 preferences.json
      ok(store2.digestRadio.getPosition(sessionKey, { hash: 'hash-v1' })?.index === 2, '5 重建 AppStore 后位置读回（跨重启续听）');
      // ── 纯函数冒烟：分句 + 问候 ──
      const parts = radio.splitSentences('第一句。第二句！第三句：a very long sentence fragment\n第四句；', 110);
      ok(parts.length === 4, `5（附）分句纯函数（${parts.length} 段）`);
      ok(['夜深了', '早上好', '中午好', '下午好', '晚上好'].includes(radio.greetingFor(9)), '5（附）问候分时段');
    }

    // ── 3/4/6/7/8/9（UI 侧）：真 IPC + 隐藏窗口 + mock TTS ──
    await radioUIProbe(store);

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});

/** ── UI 冒烟：分句合成链 / 控制键 / 互斥 / 缓存 / 入口 / 句序胶囊 ── */
async function radioUIProbe(store) {
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
  await sleep(1100); // 等应用 bootstrap

  // 注入电台桥（探针离线化）：5 句文稿 + mock TTS（80ms/句，留出观测窗口）
  await execWithTimeout(`(() => {
    window.__f19Sentences = [
      '知更电台开场白，今天十月八日。',
      '第一条头条，量子计算再进一步。',
      '第二条头条，神经网络语音上手。',
      '第三条头条，阅读目标达成祝贺。',
      '以上就是本期电台，感谢收听。',
    ];
    window.__f19Payload = {
      script: window.__f19Sentences.join(''),
      sentences: window.__f19Sentences,
      sentenceTotal: window.__f19Sentences.length,
      source: 'template',
      hash: 'f19-hash-ui-v1',
      sessionKey: 'radio:2026-10-08',
      dateKey: '2026-10-08',
    };
    window.__f19Synth = [];
    window.__f19SaveLog = [];
    window.__f19Positions = {};
    window.__f19GetPositionReturnsNull = false;
    window.__f19ResumeAt = null; // 非 null 时 getPosition 直接返回该句序（续听注入缝）
    window.__robinRadioBridge = {
      radioScript: async () => window.__f19Payload,
      getPosition: async (k, h) => {
        if (window.__f19ResumeAt != null) return { index: window.__f19ResumeAt, total: 5, hash: h };
        if (window.__f19GetPositionReturnsNull) return null;
        const p = window.__f19Positions[k];
        return p && (!h || !p.hash || p.hash === h) ? p : null;
      },
      savePosition: (k, i, meta) => { window.__f19Positions[k] = { index: i, total: meta && meta.total, hash: meta && meta.hash }; window.__f19SaveLog.push(i); return true; },
      ttsGetConfig: async () => ({ engine: 'edge', neuralVoice: 'zh-CN-XiaoxiaoNeural' }),
      ttsSynthesize: async (p) => {
        window.__f19Synth.push(String(p && p.text || ''));
        await new Promise((r) => setTimeout(r, 80));
        return 'V'.repeat(1024);
      },
    };
    window.__f19Errors = [];
    window.addEventListener('error', (e) => { (window.__f19Errors = window.__f19Errors || []).push('err: ' + String(e && e.message)); });
    window.addEventListener('unhandledrejection', (e) => { (window.__f19Errors = window.__f19Errors || []).push('rej: ' + String(e && e.reason)); });
    return true;
  })()`, 'inject-bridge');

  // ── 8a. 简报浮层「电台播放」入口（当日简报已缓存 → 秒开路径显示按钮）──
  const digestEntry = await execWithTimeout(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 8000, step = 120) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); }
    };
    try {
      document.querySelector('#digest-btn').click();
      const radioBtn = await waitFor(() => {
        const b = document.querySelector('#digest-radio');
        return b && b.style.display !== 'none' && b.offsetParent !== null ? b : null;
      });
      const label = radioBtn ? radioBtn.textContent : '';
      // 点击「电台播放」→ 走 mock 桥开播；快轮询采样句序首帧（1/5 窗口 = 首句合成期 ≥80ms）
      if (radioBtn) radioBtn.click();
      const player = document.querySelector('.nj-radio-player');
      const progressText = () => (player.querySelector('.nj-rp-progress') || {}).textContent || '';
      const progressAtStart = await waitFor(() => (player.classList.contains('visible') && progressText().includes('1/5')) ? progressText() : null, 6000, 25);
      const playerVisible = await waitFor(() => player.classList.contains('visible') ? true : null, 3000, 25);
      return { hasBtn: Boolean(radioBtn), label, playerVisible: Boolean(playerVisible), progressAtStart: progressAtStart || progressText() };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (digestEntry.__err) ok(false, '8 简报浮层入口探针异常 — ' + digestEntry.__err);
  else {
    ok(digestEntry.hasBtn && digestEntry.playerVisible, `8 简报浮层「${digestEntry.label}」入口 → 开播（胶囊可见=${digestEntry.playerVisible}）`);
    if (!digestEntry.__err) ok(String(digestEntry.progressAtStart).includes('1/5'), `9 迷你胶囊句序首采（${digestEntry.progressAtStart}）`);
  }

  // 3 合成链：逐句合成 + 预取链播（不手动操作句序自增）
  const chain = await execWithTimeout(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 8000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); }
    };
    try {
      const grew = await waitFor(() => (window.__f19Synth.length >= 3 ? window.__f19Synth.length : null), 8000);
      return {
        synthCount: window.__f19Synth.length,
        synthFirst: window.__f19Synth[0] || '',
        grew,
        state: window.__robinRadio.state,
      };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (chain.__err) ok(false, '3 合成链探针异常 — ' + chain.__err);
  else {
    ok(chain.synthCount >= 3 && chain.grew >= 3, `3 分句合成链+链播推进（已合成 ${chain.grew} 句，无手动操作）`);
    ok(String(chain.synthFirst).includes('开场白'), '3 逐句合成从第 1 句开始（首句=开场白）');
  }

  // 4 控制键：下一句 / 上一句 / 暂停 / 继续 / 停止（从头开播保证句序确定性）
  const controls = await execWithTimeout(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(50); }
    };
    try {
      window.__robinRadio.stop();
      window.__f19Positions = {};
      window.__f19GetPositionReturnsNull = true;
      window.__f19Payload.hash = 'f19-hash-ui-v2'; // 换 hash：绕开上一轮缓存，保证句序可观测
      window.__f19Synth = [];
      window.__robinRadio.play();
      await waitFor(() => window.__robinRadio.state === 'playing' ? true : null);
      const player = document.querySelector('.nj-radio-player');
      const progressText = () => (player.querySelector('.nj-rp-progress') || {}).textContent || '';
      await waitFor(() => progressText().includes('1/5') ? true : null, 6000, 25);
      const before = progressText();
      window.__robinRadio.nextSentence();
      const afterNext = progressText(); // jump 同步置位句序（_speakFrom 先 _sync 再合成）
      window.__robinRadio.previousSentence();
      const afterPrev = progressText();
      await sleep(60);
      window.__robinRadio.toggle(); // 暂停
      const paused = window.__robinRadio.state;
      window.__robinRadio.toggle(); // 继续
      const resumed = window.__robinRadio.state;
      window.__robinRadio.stop();
      await sleep(50);
      return {
        before, afterNext, afterPrev, paused, resumed,
        stoppedState: window.__robinRadio.state,
        playerHidden: !player.classList.contains('visible'),
      };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (controls.__err) ok(false, '4 控制键探针异常 — ' + controls.__err);
  else {
    ok(controls.before.includes('1/5') && controls.afterNext.includes('2/5'), `4 下一句跳转（${controls.before} → ${controls.afterNext}）`);
    ok(controls.afterPrev.includes('1/5'), `4 上一句回退（${controls.afterNext} → ${controls.afterPrev}）`);
    ok(controls.paused === 'paused' && controls.resumed === 'playing', `4 暂停/继续（${controls.paused} → ${controls.resumed}）`);
    ok(controls.stoppedState === 'idle' && controls.playerHidden, '4 停止：状态 idle + 胶囊隐藏');
  }

  // 6 四方互斥：开电台停 媒体/朗读/精选（spy）；反向 精选开播停电台；媒体 deps 停电台
  const mutex = await execWithTimeout(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); }
    };
    try {
      let mediaPaused = false; let readerStopped = false; let picksStopped = false;
      const origMediaPause = window.__robinMedia.pauseForTTS.bind(window.__robinMedia);
      window.__robinMedia.pauseForTTS = () => { mediaPaused = true; return origMediaPause(); };
      const origReaderStop = window.__robinReader.stopTTS.bind(window.__robinReader);
      window.__robinReader.stopTTS = () => { readerStopped = true; return origReaderStop(); };
      const origPicksStop = window.__robinPicksTTS.stop.bind(window.__robinPicksTTS);
      window.__robinPicksTTS.stop = () => { picksStopped = true; return origPicksStop(); };
      window.__robinRadio.play();
      await waitFor(() => window.__robinRadio.state === 'playing' ? true : null);
      const forward = { mediaPaused, readerStopped, picksStopped };
      // 反向边 1/2：精选开播（mock picks 桥）→ 电台被停
      window.__robinPickTTSBridge = {
        ttsGetConfig: async () => ({ engine: 'local' }),
        ttsSynthesize: async () => 'W'.repeat(1024),
      };
      await window.__robinPicksTTS.play('精选播报互斥验证文本。');
      await sleep(120);
      const radioAfterPicks = window.__robinRadio.state;
      window.__robinPicksTTS.stop();
      // 反向边 2/2：媒体 deps.tts（app.js 注入）停电台
      window.__robinRadio.play();
      await waitFor(() => window.__robinRadio.state === 'playing' ? true : null);
      window.__robinMedia.deps.tts.stop();
      await sleep(80);
      const radioAfterMedia = window.__robinRadio.state;
      window.__robinRadio.stop();
      return { forward, radioAfterPicks, radioAfterMedia };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (mutex.__err) ok(false, '6 互斥探针异常 — ' + mutex.__err);
  else {
    ok(mutex.forward.mediaPaused && mutex.forward.readerStopped && mutex.forward.picksStopped,
      `6 开电台停其它（媒体=${mutex.forward.mediaPaused} 朗读=${mutex.forward.readerStopped} 精选=${mutex.forward.picksStopped}）`);
    ok(mutex.radioAfterPicks === 'idle', `6 精选开播 → 电台停止（${mutex.radioAfterPicks}）`);
    ok(mutex.radioAfterMedia === 'idle', `6 媒体 deps 停止 → 电台停止（${mutex.radioAfterMedia}）`);
  }

  // 7 合成缓存：同 hash 重播，第 1 句不重合成（无位置续听干扰）
  const cacheProbe = await execWithTimeout(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); }
    };
    try {
      window.__f19GetPositionReturnsNull = true; // 从头播，验证缓存而非续听
      window.__f19Payload.hash = 'f19-hash-ui-v3'; // 独立 hash：缓存观测不受前几轮干扰
      window.__f19Synth = [];
      window.__robinRadio.play();
      await waitFor(() => window.__f19Synth.length >= 2 ? true : null);
      window.__robinRadio.stop();
      const firstRun = window.__f19Synth.filter((t) => t === window.__f19Sentences[0]).length;
      await sleep(120);
      window.__f19Synth = [];
      window.__robinRadio.play(); // 同 payload 同 hash
      await waitFor(() => window.__robinRadio.state === 'playing' ? true : null);
      await sleep(200); // 缓存命中路径（零合成）也要给链播时间推进
      const secondRun = window.__f19Synth.filter((t) => t === window.__f19Sentences[0]).length;
      window.__robinRadio.stop();
      window.__f19GetPositionReturnsNull = false;
      return { firstRun, secondRun };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (cacheProbe.__err) ok(false, '7 合成缓存探针异常 — ' + cacheProbe.__err);
  else ok(cacheProbe.firstRun === 1 && cacheProbe.secondRun === 0,
    `7 同 hash 重播零重合成（首轮=${cacheProbe.firstRun} 次，重播=${cacheProbe.secondRun} 次）`);

  // 5（UI 侧）. 位置记忆续听：getPosition 返回 index=2 → 首个合成句 = 第 3 句
  const resume = await execWithTimeout(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(60); }
    };
    try {
      window.__f19Payload.hash = 'f19-hash-ui-v4'; // 与续听注入的 hash 配对（mock getPosition 原样回传）
      window.__f19ResumeAt = 2; // 听到第 3 句（index=2）
      window.__f19Synth = [];
      window.__robinRadio.play();
      await waitFor(() => window.__f19Synth.length >= 1 ? true : null);
      const firstSynth = window.__f19Synth[0] || '';
      window.__robinRadio.stop();
      window.__f19ResumeAt = null;
      return { firstSynth, expected: window.__f19Sentences[2] };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (resume.__err) ok(false, '5 续听探针异常 — ' + resume.__err);
  else ok(resume.firstSynth === resume.expected, `5 听到第 3 句 → 续听第 3 句（首合成句=${resume.firstSynth.slice(0, 12)}…）`);

  // 8b 命令面板「播放今日电台」入口
  const palette = await execWithTimeout(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 6000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(80); }
    };
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true }));
      const opened = await waitFor(() => document.querySelector('.nj-command-palette, .command-palette, [class*="palette"]') ? true : null);
      if (!opened) return { opened: false };
      const hit = [...document.querySelectorAll('button, .palette-item, [class*="item"]')]
        .some((el) => (el.textContent || '').includes('播放今日电台'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      return { opened: true, hit };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (palette.__err) ok(false, '8 命令面板探针异常 — ' + palette.__err);
  else ok(palette.opened && palette.hit, `8 命令面板入口「播放今日电台」（面板开=${palette.opened} 命中=${palette.hit}）`);

  const errors = await execWithTimeout(`(() => (window.__f19Errors || []).slice(0, 5))()`);
  ok((errors || []).length === 0, `UI 全程无渲染异常（${(errors || []).join(' | ') || 'clean'}）`);

  win.destroy();
}
