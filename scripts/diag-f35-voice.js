'use strict';
/**
 * diag-f35-voice.js — F35 语音指挥舱探针（run-all OFFLINE 集，全程离线、mock 识别引擎）
 *
 * 覆盖：
 *  1 口令表模糊匹配单测（zh）：暂停/继续/停止 → toggle；下一篇/下一条 → next；
 *    上一篇 → prev；收藏（含「收藏这篇」长短语优先）→ star；讲重点/总结一下 → summarize；
 *    关闭浮层 → close；口语噪声「帮我暂停一下」→ toggle
 *  2 口令表模糊匹配单测（en）：pause/next article/star this/key points/close overlay
 *  3 未知口令忽略：无关语句 / 空串 / 纯标点 → null（零误动作）
 *  4 归一化：空格/标点夹杂（「暂 停！」）照常命中
 *  5 服务配置：开关默认关 / setEnabled / 语言跟随界面语言 / 跨重启持久化（flushSync+重建）
 *  6 能力探测降级：mock webkitSpeechRecognition 不可用 → 口令按钮环（6 键）真实可用，
 *    浮球隐藏（环替球）；按钮点击与识别同一 dispatch
 *  7 互斥（非朗读态不挂识别）：开关关 → 播放中也不挂；开关开但 idle → 不挂；
 *    播放中 → 挂（mock SR 实例创建）；停止 → 摘除
 *  8 浮球 UI 与识别文本展示：识别文本 + 动作标签入气泡；暂停口令真停电台（toggle 语义）
 *  9 未知口令路径：识别展示但不动作（电台状态不变）
 * 10 权限拒绝路径：not-allowed → capability=denied、识别摘除不再重试、提示文案在
 * 11 收藏口令：reader 开篇 → 真实 IPC 落库（article_states.is_starred 翻转）
 * 12 「讲重点」无 Key 降级：跳到下一篇（口令闭环不断）
 * 13 设置「语音指挥」分区：开关行 / 能力徽章（口令环模式）/ 口令表 6 行 chips
 * 14 静态接线：preload/ipc/icons/CSS（零字面量）/i18n/口令环降级说明文案
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f35-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { VoiceCommandService, VOICE_COMMANDS, matchCommand, normalizeUtterance } = require('../src/main/VoiceCommandService');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);
    const svc = store.voice;
    ok(svc instanceof VoiceCommandService, '附 VoiceCommandService 随 AppStore 构造（F35 接线）');

    // ── 1/2/3/4. 口令表模糊匹配单测（纯函数直测）──
    ok(matchCommand('暂停').action === 'toggle', '1 「暂停」→ toggle');
    ok(matchCommand('继续').action === 'toggle' && matchCommand('停止').action === 'toggle', '1 「继续/停止」→ toggle（同词族）');
    ok(matchCommand('下一篇').action === 'next' && matchCommand('下一条').action === 'next', '1 「下一篇/下一条」→ next');
    ok(matchCommand('上一篇').action === 'prev', '1 「上一篇」→ prev');
    ok(matchCommand('收藏这篇').action === 'star' && matchCommand('收藏').action === 'star', '1 「收藏/收藏这篇」→ star');
    ok(matchCommand('讲重点').action === 'summarize' && matchCommand('总结一下').action === 'summarize', '1 「讲重点/总结一下」→ summarize');
    ok(matchCommand('关闭浮层').action === 'close' && matchCommand('收起浮层').action === 'close', '1 「关闭浮层/收起浮层」→ close');
    ok(matchCommand('请帮我暂停一下吧').action === 'toggle', '1 口语噪声「请帮我暂停一下吧」模糊命中 toggle');
    ok(matchCommand('给我讲讲重点内容').action === 'summarize', '1 「讲讲重点内容」模糊命中 summarize');
    ok(matchCommand('next article', 'en').action === 'next' && matchCommand('pause', 'en').action === 'toggle', '2 en：pause/next article');
    ok(matchCommand('star this', 'en').action === 'star' && matchCommand('key points', 'en').action === 'summarize', '2 en：star this/key points');
    ok(matchCommand('close the overlay', 'en').action === 'close', '2 en：close the overlay');
    ok(matchCommand('previous one', 'en').action === 'prev', '2 en：previous one');
    ok(matchCommand('今天天气怎么样怎么样') === null, '3 未知口令 → null（忽略不动作）');
    ok(matchCommand('') === null && matchCommand('。，！') === null, '3 空串/纯标点 → null');
    ok(matchCommand('播放音乐吧', 'en') === null || matchCommand('播放音乐吧', 'en')?.action === 'toggle', '3 en 未知语句边界（「播放」词族命中即 toggle，可接受）');
    ok(matchCommand('暂 停！', 'zh').action === 'toggle', '4 归一化：「暂 停！」（空格+标点）命中 toggle');
    ok(normalizeUtterance('Pause, Please!').includes('pause'), '4 归一化：英文大小写+标点剥离');
    ok(VOICE_COMMANDS.zh.length === 6 && VOICE_COMMANDS.en.length === 6, '1/2 口令表 6 动作 × 双语');

    // ── 5. 服务配置与持久化 ──
    ok(svc.getConfig().enabled === false, '5 开关默认关（麦克风是显式授权型功能）');
    svc.setEnabled(true);
    ok(svc.getConfig().enabled === true, '5 setEnabled(true) 读回');
    ok(svc.getConfig().lang === 'zh' && svc.commands().length === 6, '5 语言跟随界面语言（默认 zh，6 动作表）');
    ok(svc.match('帮我暂停一下').action === 'toggle' && svc.match('next article', 'en').action === 'next', '5 服务级 match（缺省 lang / 显式 lang）');
    store.preferences.flushSync();
    const store2 = new AppStore(userData);
    ok(store2.voice.getConfig().enabled === true, '5 重建 AppStore 读回（跨重启持久化）');
    ok(store2.preferencesSnapshot().voiceEnabled === true, '5 快照 preferences.voiceEnabled 投影（渲染层浮球数据面）');

    // ── 场景素材：一个源 4 篇未读（收藏口令/讲重点降级用）──
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: '语音素材源', feedURL: 'https://f35.test/voice.xml' });
    // publishedAt 严格降序（v1 最新 → v3 最旧）：「下一篇」= 时间倒序的更旧一篇，跨秒稳定
    const NOW = Math.floor(Date.now() / 1000);
    const put = async (id, title, ageSec) => (await store._applyParsedEntries(feed, [{
      id, title, url: `https://f35.test/x/${id}`, publishedAt: NOW - ageSec, summary: `${title}的摘要。`, contentHTML: `<p>${title}</p>`,
    }]))[0];
    const v1 = await put('f35-v1', '语音指挥文章一', 60);
    const v2 = await put('f35-v2', '语音指挥文章二', 120);
    const v3 = await put('f35-v3', '语音指挥文章三', 180);
    ok(!!store.articlesRepo.entry(v1) && !!store.articlesRepo.entry(v2) && !!store.articlesRepo.entry(v3), '附 场景素材 3 篇在库');

    // ── 6-13（UI 侧）：真 IPC + 隐藏窗口 + mock SR / mock 电台桥 ──
    await voiceUIProbe(store, svc, { v1, v2, v3 });

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});

async function voiceUIProbe(store, svc, { v1, v2, v3 }) {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: { contextIsolation: true, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
  win.webContents.on('render-process-gone', (_e, details) => console.error('UI RENDER GONE:', details && details.reason));
  win.webContents.on('did-fail-load', (_e, code, desc) => console.error('UI LOAD FAIL:', code, desc));
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer:${level}] ${String(message).slice(0, 240)} (${path.basename(String(sourceId))}:${line})`);
  });
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
  const exec = (js, label = 'step') => Promise.race([
    win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), 30000)),
  ]);

  // 注入：能力探测降级（识别不可用）+ 电台桥（mock TTS）+ 渲染异常捕获
  await exec(`(() => {
    window.__robinVoiceBridge = { recognitionAvailable: false }; // 能力探测降级开关
    window.__f35Sentences = ['知更电台开场白。', '第一条头条。', '第二条头条。', '第三条头条。', '以上就是本期电台。'];
    window.__f35Payload = { script: window.__f35Sentences.join(''), sentences: window.__f35Sentences, sentenceTotal: 5, source: 'template', hash: 'f35-hash-v1', sessionKey: 'radio:f35' };
    window.__f35Synth = 0;
    window.__f35Errors = [];
    window.addEventListener('error', (e) => window.__f35Errors.push('err: ' + String(e && e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__f35Errors.push('rej: ' + String(e && e.reason)));
    window.__robinRadioBridge = {
      radioScript: async () => window.__f35Payload,
      getPosition: async () => null,
      savePosition: () => true,
      ttsGetConfig: async () => ({ engine: 'edge', neuralVoice: 'zh-CN-XiaoxiaoNeural' }),
      // 合成永不返回：电台停在「第 1 句合成中」→ state 恒为 playing，供长序列断言
      ttsSynthesize: async () => { window.__f35Synth += 1; await new Promise(() => {}); },
    };
    // 重播助手：合成 pending 会让 play() 的 _loading 停在 true（生产中合成总会落定）——探针复位
    window.__f35RadioReplay = () => { const r = window.__robinRadio; r._loading = false; r.play(); return true; };
    return true;
  })()`, 'inject-bridge');

  // ── 7a. 互斥（开关关）：电台播放中也不挂识别/不浮出 ──
  await exec(`(() => { window.__robinRadio.play(); return true; })()`, 'radio-play');
  await sleep(500);
  const mutexOff = await exec(`(() => {
    const orb = document.getElementById('nj-voice-orb');
    const ring = document.getElementById('nj-voice-ring');
    return { orbVisible: orb?.classList.contains('visible') === true, ringVisible: ring?.classList.contains('visible') === true, radioState: window.__robinRadio.state };
  })()`, 'mutex-off');
  ok(mutexOff.radioState === 'playing' && !mutexOff.orbVisible && !mutexOff.ringVisible,
    `7 开关关：播放中也不浮出（radio=${mutexOff.radioState} orb=${mutexOff.orbVisible} ring=${mutexOff.ringVisible}）`);

  // ── 6. 能力探测降级 → 口令按钮环（开开关后浮出环）──
  await exec(`(async () => { await window.robin.voiceSetEnabled(true); await window.__robinRefreshState(); })()`, 'enable-voice');
  await sleep(1200); // 等 900ms 轮询
  const ringOn = await exec(`(() => {
    const orb = document.getElementById('nj-voice-orb');
    const ring = document.getElementById('nj-voice-ring');
    return {
      orbVisible: orb?.classList.contains('visible') === true,
      ringVisible: ring?.classList.contains('visible') === true,
      ringButtons: ring ? ring.querySelectorAll('.nj-vo-ring-btn').length : 0,
      cap: window.__robinVoice.capabilityState(),
    };
  })()`, 'ring-on');
  ok(ringOn.cap === 'ring' && !ringOn.orbVisible && ringOn.ringVisible, `6 识别不可用 → 口令环替浮球（cap=${ringOn.cap} orb=${ringOn.orbVisible} ring=${ringOn.ringVisible}）`);
  ok(ringOn.ringButtons === 6, `6 口令环 6 动作键（实际 ${ringOn.ringButtons}）`);

  // ── 6b. 口令环真实可用：下一句 / 收藏（真 IPC 落库）──
  const radioBefore = await exec(`(() => {
    const progress = document.querySelector('.nj-radio-player .nj-rp-progress')?.textContent || '';
    return { progress };
  })()`, 'radio-progress-before');
  await exec(`(() => { document.querySelector('.nj-vo-ring-btn[data-action="next"]')?.click(); return true; })()`, 'ring-next');
  await sleep(250);
  const radioAfter = await exec(`(() => ({ progress: document.querySelector('.nj-radio-player .nj-rp-progress')?.textContent || '' }))()`, 'radio-progress-after');
  ok(String(radioBefore.progress).includes('1/5') && String(radioAfter.progress).includes('2/5'),
    `6b 环「下一篇」→ 电台下一句（${radioBefore.progress} → ${radioAfter.progress}）`);
  await exec(`window.__robinReaderOpen('${v1}')`, 'open-entry');
  await sleep(900);
  await exec(`(() => { document.querySelector('.nj-vo-ring-btn[data-action="star"]')?.click(); return true; })()`, 'ring-star');
  await sleep(600);
  ok(store.articlesRepo.entry(v1).isStarred === true, '6b 环「收藏」→ 真实 IPC 落库（is_starred=true）');

  // ── 8. 环「暂停」→ 电台暂停（toggle 语义）──
  await exec(`(() => { document.querySelector('.nj-vo-ring-btn[data-action="toggle"]')?.click(); return true; })()`, 'ring-toggle');
  await sleep(250);
  const afterToggle = await exec(`(() => ({ state: window.__robinRadio.state }))()`, 'radio-toggle-state');
  ok(afterToggle.state === 'paused', `8 环「暂停」→ 电台 paused（state=${afterToggle.state}）`);
  await exec(`window.__robinRadio.toggle()`, 'radio-resume'); // 恢复播放供后续识别路径使用

  // ── 7b. 能力恢复（mock SR 可用）→ 浮球替环，播放中挂识别 ──
  await exec(`(() => {
    window.__f35SRLast = null;
    window.__f35SRDeny = '';
    class MockSR {
      constructor() { this.continuous = false; this.lang = ''; window.__f35SRLast = this; }
      start() { if (window.__f35SRDeny) { const err = window.__f35SRDeny; setTimeout(() => this.onerror && this.onerror({ error: err }), 20); return; } this.__started = true; }
      stop() { this.__stopped = true; }
      abort() { this.__stopped = true; }
      fire(text) { this.onresult && this.onresult({ results: [[{ transcript: text }]] }); }
    }
    window.SpeechRecognition = MockSR;
    window.__robinVoiceBridge = { recognitionAvailable: true };
    window.__robinVoice._sync();
    return true;
  })()`, 'mock-sr-on');
  await sleep(400);
  const attach = await exec(`(() => {
    const orb = document.getElementById('nj-voice-orb');
    const ring = document.getElementById('nj-voice-ring');
    return {
      cap: window.__robinVoice.capabilityState(),
      orbVisible: orb?.classList.contains('visible') === true,
      ringVisible: ring?.classList.contains('visible') === true,
      attached: window.__robinVoice.snapshot().attached,
      srLang: window.__f35SRLast?.lang || '',
      srContinuous: window.__f35SRLast?.continuous === true,
    };
  })()`, 'attach');
  ok(attach.cap === 'available' && attach.orbVisible && !attach.ringVisible,
    `7b 能力恢复 → 浮球替环（cap=${attach.cap} orb=${attach.orbVisible} ring=${attach.ringVisible}）`);
  ok(attach.attached === true && attach.srLang === 'zh-CN' && attach.srContinuous === true,
    `7 播放中挂识别（attached=${attach.attached} lang=${attach.srLang} continuous=${attach.srContinuous}）`);

  // ── 7c. 电台停止 → 识别摘除（互斥：非朗读态不挂识别）──
  await exec(`window.__robinRadio.stop()`, 'radio-stop');
  await sleep(1100); // 等 900ms 轮询
  const detach = await exec(`(() => ({
    orbVisible: document.getElementById('nj-voice-orb')?.classList.contains('visible') === true,
    attached: window.__robinVoice.snapshot().attached,
  }))()`, 'detach');
  ok(!detach.orbVisible && detach.attached === false, `7c 停止 → 浮球收起 + 识别摘除（orb=${detach.orbVisible} attached=${detach.attached}）`);
  await exec(`(() => { window.__f35RadioReplay(); return true; })()`, 'radio-replay');
  await sleep(1100);

  // ── 8b. 识别文本展示 + 暂停口令真停 ──
  const transcript = await exec(`(async () => {
    window.__f35SRLast.fire('请帮我暂停一下');
    await new Promise((r) => setTimeout(r, 600));
    const caption = document.querySelector('#nj-voice-orb .nj-vo-caption');
    return {
      captionVisible: caption && caption.hidden === false,
      captionText: caption?.textContent || '',
      radioState: window.__robinRadio.state,
    };
  })()`, 'transcript-pause');
  ok(transcript.captionVisible && String(transcript.captionText).includes('请帮我暂停一下') && String(transcript.captionText).includes('暂停'),
    `8 识别文本+动作标签入气泡（「${String(transcript.captionText).slice(0, 30)}」）`);
  ok(transcript.radioState === 'paused', `8 「请帮我暂停一下」→ 电台 paused（${transcript.radioState}）`);

  // ── 9. 未知口令：展示但不动作 ──
  await exec(`window.__robinRadio.toggle()`, 'radio-resume2'); // 恢复
  await sleep(150);
  const unknown = await exec(`(async () => {
    window.__f35SRLast.fire('今天天气真不错呀');
    await new Promise((r) => setTimeout(r, 500));
    const caption = document.querySelector('#nj-voice-orb .nj-vo-caption');
    return { captionText: caption?.textContent || '', radioState: window.__robinRadio.state };
  })()`, 'unknown-command');
  ok(unknown.radioState === 'playing' && String(unknown.captionText).includes('今天天气真不错呀'),
    `9 未知口令只展示不动作（radio=${unknown.radioState}）`);

  // ── 10. 权限拒绝路径：不再重试 ──
  await exec(`window.__robinRadio.stop()`, 'radio-stop2');
  await exec(`(() => { window.__f35SRDeny = 'not-allowed'; window.__robinVoice._stopRecognition(); window.__robinVoice._sync(); return true; })()`, 'deny-setup');
  await exec(`(() => { window.__f35RadioReplay(); return true; })()`, 'radio-replay2');
  await sleep(700);
  const denied = await exec(`(() => ({
    cap: window.__robinVoice.capabilityState(),
    attached: window.__robinVoice.snapshot().attached,
    captionText: document.querySelector('#nj-voice-orb .nj-vo-caption')?.textContent || '',
  }))()`, 'denied-check');
  ok(denied.cap === 'denied' && denied.attached === false,
    `10 权限拒绝 → capability=denied + 识别摘除（cap=${denied.cap} attached=${denied.attached}）`);
  ok(String(denied.captionText).includes('权限'), `10 拒绝提示入气泡（${String(denied.captionText).slice(0, 24)}…）`);
  // 停止→重播：仍不重挂（本会话不重试）
  await exec(`window.__robinRadio.stop()`, 'radio-stop3');
  await sleep(1000);
  await exec(`(() => { window.__f35RadioReplay(); return true; })()`, 'radio-replay3');
  await sleep(1100);
  const retry = await exec(`(() => ({ attached: window.__robinVoice.snapshot().attached, cap: window.__robinVoice.capabilityState() }))()`, 'no-retry');
  ok(retry.cap === 'denied' && retry.attached === false, `10 重播后仍不重试（cap=${retry.cap} attached=${retry.attached}）`);
  await exec(`window.__robinRadio.stop()`, 'radio-stop4');

  // ── 12. 「讲重点」无 Key 降级：跳下一篇 ──
  await exec(`window.__robinReaderOpen('${v2}')`, 'open-entry2');
  await sleep(900);
  const beforeID = await exec(`(() => window.__robinReader.entryID)()`, 'entry-before');
  const sum = await exec(`(async () => {
    const adjEnv = await window.robin.getAdjacent({ kind: 'today' }, '${v2}', 'next');
    await window.__robinVoice.dispatch('summarize');
    await new Promise((r) => setTimeout(r, 1500));
    return { adjacent: adjEnv && adjEnv.ok ? adjEnv.data && adjEnv.data.id : null, selected: window.robin ? undefined : undefined };
  })()`, 'summarize-nokey');
  const afterID = await exec(`(() => window.__robinReader.entryID)()`, 'entry-after');
  ok(beforeID === v2 && afterID && afterID !== v2, `12 无 Key「讲重点」→ 跳下一篇（${String(beforeID).slice(-8)} → ${String(afterID).slice(-8)}；adjacent=${sum.adjacent ? String(sum.adjacent).slice(-8) : String(sum.adjacent)}）`);

  // ── 11b. close 口令：关简报浮层 ──
  store._saveTodayDigest('## 总览\n语音关闭浮层验证。', 1, [], 'brief');
  const closed = await exec(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#digest-btn')?.click();
    await sleep(800);
    const opened = Boolean(document.querySelector('.digest-modal'));
    await window.__robinVoice.dispatch('close');
    await sleep(200);
    return { opened, closed: !document.querySelector('.digest-modal') };
  })()`, 'close-overlay');
  ok(closed.opened && closed.closed, '11b 「关闭浮层」→ 简报浮层关闭');

  // ── 13. 设置「语音指挥」分区 ──
  const voiceSettings = await exec(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      const sbtn = [...document.querySelectorAll('.footer-nav-btn')].find((b) => (b.title || '').includes('设置'));
      if (!sbtn) return { open: false };
      sbtn.click();
      await sleep(800);
      const nav = [...document.querySelectorAll('.modal-nav-item')].find((el) => el.dataset.section === 'voice');
      if (!nav) return { open: true, nav: false };
      nav.click();
      await sleep(900);
      const badge = document.querySelector('[data-role="voice-capability"]');
      const chips = document.querySelectorAll('.nj-voice-chips').length;
      const toggleRow = [...document.querySelectorAll('.settings-modal .setting-row')].some((r) => (r.textContent || '').includes('开启语音指挥'));
      const privacy = [...document.querySelectorAll('.settings-modal .setting-row .title, .settings-modal .setting-row .desc')].some((el) => (el.textContent || '').includes('Web Speech') || (el.textContent || '').includes('音频去向'));
      document.querySelector('.settings-modal')?.closest('.modal-overlay')?.remove();
      return { open: true, nav: true, badge: badge?.textContent || '', badgeRole: badge?.className || '', chips, toggleRow, privacy };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`, 'voice-settings');
  if (voiceSettings.__err) ok(false, '13 语音设置分区探针异常 — ' + voiceSettings.__err);
  else if (!voiceSettings.open || !voiceSettings.nav) ok(false, '13 设置「语音指挥」分区未打开（环境性）');
  else {
    ok(voiceSettings.toggleRow === true, '13 开关行「开启语音指挥」在位');
    ok(String(voiceSettings.badge).length > 0 && /nj-voice-cap/.test(String(voiceSettings.badgeRole)), `13 能力徽章在位（${voiceSettings.badge}）`);
    ok(voiceSettings.chips === 6, `13 口令表 6 行 chips（实际 ${voiceSettings.chips}）`);
    ok(voiceSettings.privacy === true, '13 隐私说明（Web Speech 音频去向）在位');
  }

  // ── 14. 静态接线锚点 ──
  ok(read('src/main/preload.js').includes("voiceMatch: (text, lang) => data('voice:match', text, lang)"), '14 preload voiceMatch 在位');
  ok(read('src/main/ipc.js').includes("handle('voice:match'") && read('src/main/ipc.js').includes("handle('voice:setEnabled'"), '14 IPC 语音通道注册在位');
  ok(read('src/renderer/icons.js').includes('mic:'), '14 mic 图标在位');
  const css = read('src/renderer/styles/robin.css');
  ok(css.includes('.nj-voice-orb') && css.includes('.nj-voice-ring') && css.includes('njVoiceBreath'), '14 浮球/口令环/呼吸光环 CSS 在位');
  const cssVoice = css.slice(css.indexOf('F35 语音指挥舱'), css.indexOf('F36 阅读生物钟'));
  ok(!/border-radius:\s*\d+px/.test(cssVoice) && !/font-size:\s*\d+(\.\d+)?px/.test(cssVoice.replace(/var\(--fs-[^)]*\)/g, '')),
    '14 语音 CSS 新块零 radius/字号字面量（护栏口径）');
  ok(read('src/main/I18NStrings.js').includes('麦克风权限被拒绝：可在系统设置中授权后重启应用再试。'), '14 I18N 锚点：权限拒绝双语文案在位');
  ok(read('src/renderer/views/dialogs.js').includes("case 'voice': this._voice(scroll); break;"), '14 设置分区 case 在位');

  const errors = await exec(`(() => (window.__f35Errors || []).slice(0, 5))()`, 'errors');
  ok((errors || []).length === 0, `UI 全程无渲染异常（${(errors || []).join(' | ') || 'clean'}）`);

  win.destroy();
}
