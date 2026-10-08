'use strict';
/**
 * PicksTTSPlayer — 智能精选「播报精选」迷你播放器（F10）
 *
 * 复用 NeuralTTSService 既有合成通路（渲染层 window.robin.ttsSynthesize → 主进程
 * tts:synthesize → edge/custom 神经语音），engine=local 时回退 speechSynthesis——
 * 与阅读器朗读（reader.js TTS）同一套引擎分派语义。文稿来自 SmartPicksService
 * 本地模板拼装（非 LLM），按 ≤120 字句块切分逐块合成、下一块预取、onended 链播。
 *
 * 互斥（F3 语义延伸）：
 * - 开播前先暂停媒体迷你播放器（window.__robinMedia.pauseForTTS）+ 停阅读器朗读
 *   （window.__robinReader.stopTTS）；
 * - 反向互斥由 MediaMiniPlayer 的 deps.tts 提供（app.js 把本组件状态并入全局 TTS 态：
 *   开媒体先停本组件）。
 * 不入 media_items：TTS 节目走本胶囊播放器，避免与播客/视频队列语义混淆。
 */
import { t } from '../i18n.js';

const CHUNK_MAX = 120;
const RATES = [0.75, 1, 1.25, 1.5];

const SVG = {
  play: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M5 3.2v9.6l7.6-4.8z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M4.6 3h2.3v10H4.6zM9.1 3h2.3v10H9.1z"/></svg>',
  stop: '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.2"/></svg>',
};

/** 句块切分（与 reader.js ttsSplitChunks 同策略）：按句读边界聚到 ≤max 字。 */
function splitChunks(text, max = CHUNK_MAX) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return [];
  const sentences = source.split(/(?<=[。！？!?；;\n])/u).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let buffer = '';
  const flush = () => {
    if (buffer.trim()) chunks.push(buffer.trim());
    buffer = '';
  };
  for (const sentence of sentences) {
    if (sentence.length > max) {
      flush();
      for (let i = 0; i < sentence.length; i += max) chunks.push(sentence.slice(i, i + max));
      continue;
    }
    if ((buffer + sentence).length > max) flush();
    buffer += sentence;
  }
  flush();
  return chunks;
}

export class PicksTTSPlayer {
  constructor(deps = {}) {
    this.deps = {
      toast: deps.toast || null,
      onState: deps.onState || null, // (state) => void — idle/playing/paused
    };
    this._state = 'idle';
    this._gen = 0;
    this._chunks = [];
    this._index = 0;
    this._rateIndex = 1;
    this._audio = null;
    this._pending = new Map(); // index -> Promise<base64> 预取
    this._cfg = null;
    this._mount();
  }

  // MARK: - 状态

  get state() { return this._state; }

  _setState(state) {
    this._state = state;
    this._sync();
    try { this.deps.onState?.(state); } catch (_) { /* 回调异常不影响播放 */ }
  }

  // MARK: - 播放控制

  /** 播报一份文稿（SmartPicksService.broadcastScript 的 script）。重复调用 = 换稿重播。 */
  async play(scriptText) {
    const chunks = splitChunks(scriptText);
    if (!chunks.length) {
      this.deps.toast?.(t('还没有可播报的精选。'));
      return;
    }
    this.stop(); // 幂等清场（gen++ 使旧回调全部失效）
    // 全局互斥（F3 语义）：媒体先暂停、阅读器朗读先停
    try { window.__robinMedia?.pauseForTTS?.(); } catch (_) { /* 媒体未挂载 */ }
    try { window.__robinReader?.stopTTS?.(); } catch (_) { /* 阅读器未挂载 */ }
    this._chunks = chunks;
    this._index = 0;
    this._pending.clear();
    this._setState('playing');
    this._show();
    await this._speakFrom(0);
  }

  /** 播放/暂停切换（暂停中再点继续）。 */
  toggle() {
    if (this._state === 'idle') return;
    if (this._state === 'playing') {
      if (this._audio) { try { this._audio.pause(); } catch (_) { /* 忽略 */ } }
      if (this._synth) { try { this._synth.pause(); } catch (_) { /* 引擎不支持暂停 */ } }
      this._setState('paused');
      return;
    }
    if (this._audio) { try { this._audio.play(); } catch (_) { /* 忽略 */ } }
    if (this._synth) { try { this._synth.resume(); } catch (_) { /* 忽略 */ } }
    this._setState('playing');
  }

  /** 停止：销毁音频、作废回调、隐藏胶囊。幂等。 */
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

  /**
   * TTS 通路（可注入）：window.robin 是 contextBridge 冻结面，探针/E2E 无法直接
   * 替换其方法——设 window.__robinPickTTSBridge = { ttsGetConfig, ttsSynthesize }
   * 即整体接管（默认回落 robin 既有 tts:* 通路，行为不变）。
   */
  _bridge() {
    return window.__robinPickTTSBridge || window.robin;
  }

  async _engineConfig() {
    if (this._cfg) return this._cfg;
    this._cfg = await this._bridge().ttsGetConfig?.().catch(() => null) || { engine: 'local' };
    return this._cfg;
  }

  async _speakFrom(index) {
    const gen = this._gen;
    if (index >= this._chunks.length) {
      this.stop();
      this.deps.toast?.(t('播报结束'));
      return;
    }
    this._index = index;
    this._sync();
    const cfg = await this._engineConfig();
    if (gen !== this._gen) return; // 期间已停止/换稿
    if ((cfg.engine === 'edge' || cfg.engine === 'custom') && this._bridge().ttsSynthesize) {
      await this._speakNeural(gen, index, cfg);
      return;
    }
    this._speakLocal(gen, index);
  }

  /** 神经语音：逐块合成 mp3 → Audio 链播，下一块预取。失败给出可读原因并停播。 */
  async _speakNeural(gen, index, cfg) {
    let b64 = this._pending.get(index) || null;
    this._pending.delete(index);
    try {
      if (b64 === null) {
        b64 = await this._bridge().ttsSynthesize({
          engine: cfg.engine === 'custom' ? 'custom' : 'edge',
          text: this._chunks[index],
          voice: cfg.neuralVoice || 'zh-CN-XiaoxiaoNeural',
          rate: this.rate,
        });
      } else {
        b64 = await b64;
      }
      if (typeof b64 !== 'string' || b64.length < 512) throw new Error(t('合成服务无响应（检查网络后重试）'));
    } catch (error) {
      if (gen !== this._gen) return;
      this.stop();
      this.deps.toast?.(`${t('神经语音暂时不可用，已停止播报')}：${String(error?.message || error || '').slice(0, 80)}`);
      return;
    }
    if (gen !== this._gen) return;
    this._prefetchNeural(gen, index + 1, cfg);
    const audio = new Audio(`data:audio/mpeg;base64,${b64}`);
    audio.playbackRate = this.rate;
    this._audio = audio;
    // 单推进守卫：ended/error/play-reject 可能同帧先后触发（mock/无声源尤甚），
    // 不去重会沿链分叉出指数级重复合成
    let advanced = false;
    const advance = () => { if (!advanced && gen === this._gen) { advanced = true; this._speakFrom(index + 1); } };
    audio.onended = () => advance();
    audio.onerror = () => advance();
    try {
      await audio.play();
    } catch (_) {
      advance(); // 自动播放被拦：跳过本块继续
    }
  }

  _prefetchNeural(gen, index, cfg) {
    if (gen !== this._gen || index >= this._chunks.length || this._pending.has(index)) return;
    const promise = this._bridge().ttsSynthesize({
      engine: cfg.engine === 'custom' ? 'custom' : 'edge',
      text: this._chunks[index],
      voice: cfg.neuralVoice || 'zh-CN-XiaoxiaoNeural',
      rate: this.rate,
    });
    this._pending.set(index, promise);
    promise.catch(() => { this._pending.delete(index); });
  }

  /** 本地语音兜底（engine=local）：speechSynthesis 逐块 utterance 链播。 */
  _speakLocal(gen, index) {
    const synth = window.speechSynthesis;
    if (!synth || typeof synth.speak !== 'function') {
      this.stop();
      this.deps.toast?.(t('当前环境不支持语音朗读（speechSynthesis 不可用）'));
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
    if (document.getElementById('nj-picks-player')) return;
    const player = document.createElement('div');
    player.className = 'nj-picks-player';
    player.id = 'nj-picks-player';
    player.dataset.role = 'picks-player';
    player.innerHTML = `
      <span class="nj-pp-label"></span>
      <button type="button" class="nj-pp-btn nj-pp-toggle" title="${t('暂停 / 继续播报')}"></button>
      <button type="button" class="nj-pp-btn nj-pp-stop" title="${t('停止播报（精选）')}">${SVG.stop}</button>
      <span class="nj-pp-progress" title="${t('播报进度')}"></span>
      <button type="button" class="nj-pp-btn nj-pp-rate" title="${t('点击切换语速（0.75 / 1 / 1.25 / 1.5）')}"></button>`;
    document.body.appendChild(player);
    this._el = player;
    player.querySelector('.nj-pp-toggle').addEventListener('click', () => this.toggle());
    player.querySelector('.nj-pp-stop').addEventListener('click', () => this.stop());
    player.querySelector('.nj-pp-rate').addEventListener('click', () => this.cycleRate());
    this._sync();
  }

  _show() { this._el?.classList.add('visible'); }

  _sync() {
    const player = this._el;
    if (!player) return;
    const label = player.querySelector('.nj-pp-label');
    if (label) label.textContent = t('精选播报');
    const toggle = player.querySelector('.nj-pp-toggle');
    if (toggle) {
      toggle.innerHTML = this._state === 'playing' ? SVG.pause : SVG.play;
      toggle.title = this._state === 'playing' ? t('暂停播报') : t('继续播报');
    }
    const progress = player.querySelector('.nj-pp-progress');
    if (progress) {
      progress.textContent = this._chunks.length
        ? `${Math.min(100, Math.round(((this._index + 1) / this._chunks.length) * 100))}%`
        : '';
    }
    const rate = player.querySelector('.nj-pp-rate');
    if (rate) rate.textContent = `${this.rate}×`;
    player.classList.toggle('is-live', this._state === 'playing');
  }
}
