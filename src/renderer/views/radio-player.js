'use strict';
/**
 * RadioPlayer — 简报电台迷你播放器（F19）
 *
 * 复用 PicksTTSPlayer 的链播模式（逐句合成 → 下一句预取 → onended 链播），
 * 电台语义扩展：
 * - 文稿来自 DigestRadioService（AI 改写或本地模板），逐句经 NeuralTTSService
 *   既有 tts:synthesize 通路合成（engine=local 回退 speechSynthesis）；
 * - 上一句 / 下一句 / 暂停 / 继续 / 停止；迷你胶囊显示句序（第 X/Y 句）；
 * - 播放位置记忆：每句开播前经主进程存 sessionKey+句序（偏好 JSON），重启后
 *   文稿 hash 未变 → 从上次句序续听；
 * - 合成缓存：同 sessionKey 文稿 hash 未变时逐句音频驻内存 Map，重播零重合成；
 * - 四方互斥（F3/F10 语义延伸）：开播前先停 媒体/阅读器朗读/精选播报；
 *   反向边由 MediaMiniPlayer 的 deps.tts、reader.toggleTTS、PicksTTSPlayer.play
 *   注入（app.js 把本组件状态并入全局 TTS 态）。
 *
 * 注入缝（探针离线化）：window.__robinRadioBridge = { radioScript, getPosition,
 * savePosition, ttsGetConfig, ttsSynthesize } 整体接管（默认回落 robin 通路）。
 */
import { t, tf } from '../i18n.js';

const RATES = [0.75, 1, 1.25, 1.5];

const SVG = {
  play: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M5 3.2v9.6l7.6-4.8z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M4.6 3h2.3v10H4.6zM9.1 3h2.3v10H9.1z"/></svg>',
  stop: '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.2"/></svg>',
  prev: '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><rect x="3.2" y="3.4" width="1.8" height="9.2" rx="0.6"/><path d="M13 3.4v9.2l-6-4.6z"/></svg>',
  next: '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M3 3.4v9.2l6-4.6z"/><rect x="11" y="3.4" width="1.8" height="9.2" rx="0.6"/></svg>',
};

/** 本地兜底分句（主进程 payload.sentences 缺失时用；同 DigestRadioService 策略）。 */
function splitSentencesLocal(text, max = 110) {
  const source = String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  if (!source) return [];
  const out = [];
  for (const raw of source.split(/(?<=[。！？!?；;\n])/)) {
    const piece = raw.replace(/\s*\n\s*/g, '').trim();
    if (!piece) continue;
    if (piece.length <= max) { out.push(piece); continue; }
    for (let i = 0; i < piece.length; i += max) out.push(piece.slice(i, i + max));
  }
  return out;
}

export class RadioPlayer {
  constructor(deps = {}) {
    this.deps = {
      toast: deps.toast || null,
      onState: deps.onState || null, // (state) => void — idle/playing/paused
      preferAI: deps.preferAI || null, // async () => boolean — AI 改写门（会员/额度，注入缝）
    };
    this._state = 'idle';
    this._gen = 0;
    this._chunks = [];
    this._index = 0;
    this._rateIndex = 1;
    this._audio = null;
    this._synth = null;
    this._pending = new Map();   // index -> Promise<base64> 下一句预取
    this._audioCache = new Map(); // `${hash}:${index}` -> base64 合成缓存（同 hash 不重合成）
    this._hash = '';
    this._sessionKey = '';
    this._source = 'template';
    this._cfg = null;
    this._loading = false;       // play() 取稿中标记（双击/连点防护）
    this._mount();
  }

  // MARK: - 状态

  get state() { return this._state; }
  get source() { return this._source; }

  _setState(state) {
    this._state = state;
    this._sync();
    try { this.deps.onState?.(state); } catch (_) { /* 回调异常不影响播放 */ }
  }

  _bridge() {
    return window.__robinRadioBridge || window.robin;
  }

  async _engineConfig() {
    if (this._cfg) return this._cfg;
    this._cfg = await this._bridge().ttsGetConfig?.().catch(() => null) || { engine: 'local' };
    return this._cfg;
  }

  // MARK: - 播放控制

  /** 开播：取文稿 → 断点续听 → 逐句链播。非 idle 或装载中调用 = 忽略（幂等）。 */
  async play() {
    if (this._state !== 'idle' || this._loading) return;
    this._loading = true; // 双击/连点防护：AI 改写取稿可达数秒，期间忽略再次开播
    try {
      this.stop(); // 幂等清场（gen++ 使旧回调全部失效）
      const gen = this._gen;
      let payload = null;
      try {
        const preferAI = this.deps.preferAI ? await this.deps.preferAI() : false;
        payload = await this._bridge().radioScript({ preferAI: preferAI === true });
      } catch (_) {
        payload = null;
      }
      if (gen !== this._gen) return; // 取稿期间已被 stop()/重播清场：过期载荷丢弃
      if (!payload || !payload.script) {
        this.deps.toast?.(t('今天还没有可播报的电台内容。'));
        return;
      }
      // 全局互斥（F3/F10 语义）：电台开播先停 媒体 / 阅读器朗读 / 精选播报
      try { window.__robinMedia?.pauseForTTS?.(); } catch (_) { /* 媒体未挂载 */ }
      try { window.__robinReader?.stopTTS?.(); } catch (_) { /* 阅读器未挂载 */ }
      try { window.__robinPicksTTS?.stop?.(); } catch (_) { /* 精选未挂载 */ }

      const sentences = Array.isArray(payload.sentences) && payload.sentences.length
        ? payload.sentences.map((s) => String(s))
        : splitSentencesLocal(payload.script);
      if (!sentences.length) {
        this.deps.toast?.(t('今天还没有可播报的电台内容。'));
        return;
      }
      const hash = String(payload.hash || '');
      if (hash !== this._hash) {
        // 文稿已更新：旧音频缓存全部失效（同 hash 才免重合成）
        this._audioCache.clear();
        this._hash = hash;
      }
      this._sessionKey = String(payload.sessionKey || '');
      this._source = payload.source === 'ai' ? 'ai' : 'template';
      this._chunks = sentences;
      this._pending.clear();

      // 断点续听：位置记忆 hash 匹配且未播完 → 从上次句序继续
      let startIndex = 0;
      try {
        const saved = await (this._bridge().radioGetPosition || this._bridge().getPosition)?.(this._sessionKey, this._hash);
        if (gen !== this._gen) return; // 期间已清场
        const idx = Number(saved?.index) || 0;
        if (idx > 0 && idx < sentences.length) {
          startIndex = idx;
          this.deps.toast?.(tf('续听上次的电台（第 %lld/%lld 句）', idx + 1, sentences.length));
        }
      } catch (_) { /* 位置读取失败从头播 */ }

      this._setState('playing');
      this._show();
      await this._speakFrom(startIndex);
    } finally {
      this._loading = false;
    }
  }

  /** 播放/暂停切换。 */
  toggle() {
    if (this._state === 'idle') return;
    if (this._state === 'playing') {
      if (this._audio) { try { this._audio.pause(); } catch (_) { /* 忽略 */ } }
      if (this._synth) { try { this._synth.pause(); } catch (_) { /* 引擎不支持暂停 */ } }
      this._setState('paused');
      return;
    }
    if (this._audio) {
      try {
        const playing = this._audio.play();
        if (playing && typeof playing.catch === 'function') playing.catch(() => { /* 无效源/自动播放被拦 */ });
      } catch (_) { /* 忽略 */ }
    }
    if (this._synth) { try { this._synth.resume(); } catch (_) { /* 引擎不支持暂停 */ } }
    this._setState('playing');
  }

  /** 上一句 / 下一句：取消当前句，跳到目标句序重播（paused 中跳转自动恢复播放）。 */
  jump(delta) {
    if (this._state === 'idle' || !this._chunks.length) return;
    const next = Math.max(0, Math.min(this._chunks.length - 1, this._index + delta));
    this._gen += 1; // 作废在播句的回调
    if (this._audio) {
      try { this._audio.pause(); } catch (_) { /* 忽略 */ }
      this._audio.onended = null;
      this._audio.onerror = null;
      this._audio = null;
    }
    if (this._synth) { try { this._synth.cancel(); } catch (_) { /* 忽略 */ } }
    this._setState('playing');
    this._speakFrom(next);
  }

  previousSentence() { this.jump(-1); }
  nextSentence() { this.jump(1); }

  /** 停止：销毁音频、作废回调、保存位置、隐藏胶囊。幂等。 */
  stop() {
    this._gen += 1;
    if (this._audio) {
      try { this._audio.pause(); } catch (_) { /* 忽略 */ }
      this._audio.onended = null;
      this._audio.onerror = null;
      this._audio.src = '';
      this._audio = null;
    }
    if (this._synth) { try { this._synth.cancel(); } catch (_) { /* 忽略 */ } }
    this._synth = null;
    this._pending.clear();
    // 位置记忆：仅在真会话在场时落盘（play() 开头的幂等清场不得清零已存位置，
    // 否则同日续听永远失效）；播完（索引出界）归零从头
    if (this._sessionKey && this._chunks.length) {
      const finished = this._index >= this._chunks.length;
      const at = finished ? 0 : this._index;
      try {
        (this._bridge().radioSavePosition || this._bridge().savePosition)?.(this._sessionKey, at, { total: this._chunks.length, hash: this._hash });
      } catch (_) { /* 位置保存失败不阻塞停止 */ }
    }
    this._chunks = [];
    this._index = 0;
    this._setState('idle');
    this._el?.classList.remove('visible');
  }

  cycleRate() {
    this._rateIndex = (this._rateIndex + 1) % RATES.length;
    if (this._audio) { try { this._audio.playbackRate = this.rate; } catch (_) { /* 忽略 */ } }
    this._sync();
  }

  get rate() { return RATES[this._rateIndex]; }

  // MARK: - 合成与链播

  /** 缓存优先的逐句合成：命中（同 hash 同句序）零 IPC；未命中合成后驻内存。 */
  _synthSentence(index, cfg) {
    const key = `${this._hash}:${index}`;
    const cached = this._audioCache.get(key);
    if (cached) return Promise.resolve(cached);
    const promise = this._bridge().ttsSynthesize({
      engine: cfg.engine === 'custom' ? 'custom' : 'edge',
      text: this._chunks[index],
      voice: cfg.neuralVoice || 'zh-CN-XiaoxiaoNeural',
      rate: this.rate,
    });
    promise.then((b64) => {
      if (typeof b64 === 'string' && b64.length >= 512) {
        // 缓存护栏：按句驻留，上限 400 句（一期电台文稿规模），超限整表清空
        if (this._audioCache.size > 400) this._audioCache.clear();
        this._audioCache.set(key, b64);
      }
    }).catch(() => { /* 失败不入缓存 */ });
    return promise;
  }

  async _speakFrom(index) {
    const gen = this._gen;
    if (index >= this._chunks.length) {
      this._index = index;
      this.stop(); // 播完：stop 内把位置归零
      this.deps.toast?.(t('本期电台播报结束'));
      return;
    }
    this._index = index;
    this._sync();
    // 位置记忆：每句开播前落一次（偏好 JSON 防抖落盘，IPC 量 = 句频，量小）
    try {
      (this._bridge().radioSavePosition || this._bridge().savePosition)?.(this._sessionKey, index, { total: this._chunks.length, hash: this._hash });
    } catch (_) { /* 位置保存失败不阻塞播放 */ }
    const cfg = await this._engineConfig();
    if (gen !== this._gen) return; // 期间已停止/跳句
    if ((cfg.engine === 'edge' || cfg.engine === 'custom') && this._bridge().ttsSynthesize) {
      await this._speakNeural(gen, index, cfg);
      return;
    }
    this._speakLocal(gen, index);
  }

  /** 神经语音：逐句合成 mp3 → Audio 链播，下一句预取。失败给出可读原因并停播。 */
  async _speakNeural(gen, index, cfg) {
    let b64 = this._pending.get(index) || null;
    this._pending.delete(index);
    try {
      if (b64 === null) {
        b64 = await this._synthSentence(index, cfg);
      } else {
        b64 = await b64;
      }
      if (typeof b64 !== 'string' || b64.length < 512) throw new Error(t('合成服务无响应（检查网络后重试）'));
    } catch (error) {
      if (gen !== this._gen) return;
      this.stop();
      this.deps.toast?.(`${t('神经语音暂时不可用，已停止播报')}：${String(error?.message || error || '').slice(0, 80)}`, { tone: 'error' });
      return;
    }
    if (gen !== this._gen) return;
    this._prefetchNeural(gen, index + 1, cfg);
    const audio = new Audio(`data:audio/mpeg;base64,${b64}`);
    audio.playbackRate = this.rate;
    this._audio = audio;
    // 单推进守卫（与 PicksTTSPlayer 同款）：ended/error/play-reject 可能同帧先后触发
    let advanced = false;
    const advance = () => { if (!advanced && gen === this._gen) { advanced = true; this._speakFrom(index + 1); } };
    audio.onended = () => advance();
    audio.onerror = () => advance();
    try {
      await audio.play();
    } catch (_) {
      advance(); // 自动播放被拦：跳过本句继续
    }
  }

  _prefetchNeural(gen, index, cfg) {
    if (gen !== this._gen || index >= this._chunks.length || this._pending.has(index)) return;
    const promise = this._synthSentence(index, cfg);
    this._pending.set(index, promise);
    promise.catch(() => { this._pending.delete(index); });
  }

  /** 本地语音兜底（engine=local）：speechSynthesis 逐句 utterance 链播。 */
  _speakLocal(gen, index) {
    const synth = window.speechSynthesis;
    if (!synth || typeof synth.speak !== 'function') {
      this.stop();
      this.deps.toast?.(t('当前环境不支持语音朗读（speechSynthesis 不可用）'), { tone: 'warn' });
      return;
    }
    this._synth = synth;
    const voices = (() => { try { return synth.getVoices() || []; } catch (_) { return []; } })();
    let utter;
    try {
      utter = new SpeechSynthesisUtterance(this._chunks[index]);
    } catch (_) {
      this.stop();
      return;
    }
    const voice = voices.find((v) => (v.lang || '').toLowerCase().startsWith('zh')) || voices[0];
    if (voice) { try { utter.voice = voice; } catch (_) { /* mock/plain object */ } }
    utter.lang = voice?.lang || 'zh-CN';
    utter.rate = this.rate;
    utter.onend = () => { if (gen === this._gen) this._speakFrom(index + 1); };
    utter.onerror = () => { if (gen === this._gen && this._state !== 'idle') this._speakFrom(index + 1); };
    try { synth.speak(utter); } catch (_) { if (gen === this._gen) this.stop(); }
  }

  // MARK: - 胶囊 UI

  _mount() {
    if (document.getElementById('nj-radio-player')) return;
    const player = document.createElement('div');
    player.className = 'nj-radio-player';
    player.id = 'nj-radio-player';
    player.dataset.role = 'radio-player';
    player.innerHTML = `
      <span class="nj-rp-label"></span>
      <button type="button" class="nj-rp-btn nj-rp-prev" title="${t('上一句')}">${SVG.prev}</button>
      <button type="button" class="nj-rp-btn nj-rp-toggle" title="${t('暂停 / 继续电台')}"></button>
      <button type="button" class="nj-rp-btn nj-rp-next" title="${t('下一句')}">${SVG.next}</button>
      <button type="button" class="nj-rp-btn nj-rp-stop" title="${t('停止电台')}">${SVG.stop}</button>
      <span class="nj-rp-progress" title="${t('电台播报句序')}"></span>
      <button type="button" class="nj-rp-btn nj-rp-rate" title="${t('点击切换语速（0.75 / 1 / 1.25 / 1.5）')}"></button>`;
    document.body.appendChild(player);
    this._el = player;
    player.querySelector('.nj-rp-prev').addEventListener('click', () => this.previousSentence());
    player.querySelector('.nj-rp-toggle').addEventListener('click', () => this.toggle());
    player.querySelector('.nj-rp-next').addEventListener('click', () => this.nextSentence());
    player.querySelector('.nj-rp-stop').addEventListener('click', () => this.stop());
    player.querySelector('.nj-rp-rate').addEventListener('click', () => this.cycleRate());
    this._sync();
  }

  _show() { this._el?.classList.add('visible'); }

  _sync() {
    const player = this._el;
    if (!player) return;
    const label = player.querySelector('.nj-rp-label');
    if (label) label.textContent = t('知更电台');
    const toggle = player.querySelector('.nj-rp-toggle');
    if (toggle) {
      toggle.innerHTML = this._state === 'playing' ? SVG.pause : SVG.play;
      toggle.title = this._state === 'playing' ? t('暂停电台') : t('继续电台');
    }
    const progress = player.querySelector('.nj-rp-progress');
    if (progress) {
      // 句序显示（F19 验收）：第 X/Y 句
      progress.textContent = this._chunks.length
        ? tf('第 %lld/%lld 句', Math.min(this._index + 1, this._chunks.length), this._chunks.length)
        : '';
    }
    const rate = player.querySelector('.nj-rp-rate');
    if (rate) rate.textContent = `${this.rate}×`;
    player.classList.toggle('is-live', this._state === 'playing');
  }
}
