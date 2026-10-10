'use strict';
/**
 * VoiceOrb — 语音指挥舱浮球（F35 · 渲染层）
 *
 * 朗读 / 电台播放中的 hands-free 闭环：
 * - 浮球：TTS/电台 active 且设置开关开启时浮出（半透明；识别中呼吸光环，
 *   prefers-reduced-motion 豁免）。
 * - 识别：webkitSpeechRecognition（Electron 37 渲染层探测；语言=界面语言）。
 *   连续识别 + 最终结果 → 主进程 voice:match（口令表模糊匹配单一事实源）→ dispatch。
 * - 降级链：
 *     ① 探测不到 SpeechRecognition → 「口令按钮环」（同样动作集的真实按钮），
 *        按钮环探针可直点——不是摆设，是正式降级方案；
 *     ② 麦克风权限拒绝（not-allowed）→ 说明一次后不再重试（本次会话内）；
 *     ③ 无 AI Key 时「讲重点」由 app.js 注入的 summarize 降级为跳下一篇。
 * - 口令表：浮球悬停 / 长按展示（主进程 voice:commands 下发）。
 * - 互斥照旧：本组件只读「谁在播」状态（radio/reader），不改变四方互斥体系；
 *   识别只在 active 时挂（非朗读态不创建/自动停止识别实例）。
 *
 * 注入缝（探针离线化）：window.__robinVoiceBridge = { recognitionAvailable }
 * 整体接管能力探测；识别实例经 window.__robinVoiceTesthooks 观测。
 */
import { t, currentLanguage } from '../i18n.js';

const MIC_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="6" y="1.6" width="4" height="8" rx="2"/><path d="M3.6 7.6a4.4 4.4 0 0 0 8.8 0"/><path d="M8 12v2.4"/></svg>';

/** 能力探测（注入缝优先：探针 mock 不可用路径）。 */
function speechRecognitionAvailable() {
  const bridge = typeof window !== 'undefined' ? window.__robinVoiceBridge : null;
  if (bridge && typeof bridge.recognitionAvailable === 'boolean') return bridge.recognitionAvailable;
  if (typeof window === 'undefined') return false;
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export class VoiceOrb {
  constructor(deps = {}) {
    this.deps = {
      toast: deps.toast || null,
      // () => boolean — 设置开关（voiceEnabled，app.js 从快照读）
      enabled: deps.enabled || (() => false),
      // () => 'radio' | 'reader' | null — 谁在播（互斥体系只读视图）
      isActive: deps.isActive || (() => null),
      // () => 'zh' | 'en'
      lang: deps.lang || (() => (currentLanguage() === 'en' ? 'en' : 'zh')),
      // 动作集（app.js 注入；与口令环/识别共用同一 dispatch）
      actions: deps.actions || {},
    };
    this._capability = speechRecognitionAvailable();
    this._denied = false;       // 权限被拒：本会话不再重试
    this._recognition = null;
    this._listening = false;
    this._captionTimer = null;
    this._commandsCache = null;
    this._el = null;
    this._ringEl = null;
    this._mounted = false;
    this._poll = null;
  }

  mount() {
    if (this._mounted || typeof document === 'undefined') return;
    this._mounted = true;
    this._mountOrb();
    if (!this._capability) this._mountRing(); // 口令按钮环降级方案
    // 状态轮询（900ms）：互斥态只在 active 时挂识别——非朗读态绝不创建识别实例
    this._poll = setInterval(() => this._sync(), 900);
    this._sync();
  }

  dispose() {
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
    this._stopRecognition();
    this._el?.remove();
    this._ringEl?.remove();
    this._mounted = false;
  }

  // MARK: - 能力与状态

  /** 能力态（设置页探测说明用）：available | ring | denied */
  capabilityState() {
    if (!this._capability) return 'ring';
    if (this._denied) return 'denied';
    return 'available';
  }

  _sync() {
    if (!this._denied && !this._runtimeDead) this._capability = speechRecognitionAvailable(); // 每拍重探；运行期死亡判定不复活（审查 P1）
    const active = this.deps.isActive();
    const show = Boolean(active && this.deps.enabled());
    if (this._el) this._el.classList.toggle('visible', show && this._capability);
    if (this._ringEl) this._ringEl.classList.toggle('visible', show && !this._capability);
    if (!this._capability && show) this._ensureRing(); // 口令按钮环降级方案补挂
    if (show && this._capability && !this._denied) this._ensureRecognition();
    else this._stopRecognition();
    if (this._el) this._el.classList.toggle('listening', Boolean(this._listening && show));
  }

  /** 口令环惰性挂载（幂等；按钮文案异步回填）。 */
  _ensureRing() {
    if (this._ringEl) return;
    this._mountRing();
  }

  // MARK: - 识别生命周期

  _ensureRecognition() {
    if (this._recognition || this._denied || !this._capability) return;
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) { this._capability = false; this._mountRing(); this._sync(); return; }
    let recognition;
    try {
      recognition = new Ctor();
    } catch (_) {
      this._capability = false; // 构造即抛（无麦克风/引擎缺失）：转入口令环
      this._mountRing();
      this._sync();
      return;
    }
    recognition.lang = this.deps.lang() === 'en' ? 'en-US' : 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const result = event.results && event.results[event.results.length - 1];
      const transcript = result && result[0] ? String(result[0].transcript || '') : '';
      if (transcript.trim()) this._handleTranscript(transcript);
    };
    recognition.onerror = (event) => {
      const code = String(event && event.error || '');
      if (code === 'not-allowed') {
        // 用户拒权：明确提示一次，本会话不再重试
        this._denied = true;
        this._stopRecognition();
        this._showCaption(t('麦克风权限被拒绝，语音指挥已停用'), 'denied');
        this.deps.toast?.(t('麦克风权限被拒绝：可在系统设置中授权后重启应用再试。'));
        return;
      }
      if (code === 'service-not-allowed' || code === 'language-not-supported') {
        // 引擎服务被禁/语言不支持（批 F 审查 P1：真实 Electron 常态路径）→ 引擎不可用，落口令环
        this._runtimeDead = true;
        this._capability = false;
        this._stopRecognition();
        this._sync();
        return;
      }
      if (code === 'network' || code === 'audio-capture') {
        // 引擎在但服务/设备不可用：连续 3 次失败判引擎不可用（审查 P1：否则无限 error→end→start 循环）
        this._errRun = (this._errRun || 0) + 1;
        if (this._errRun >= 3) {
          this._runtimeDead = true;
          this._capability = false;
          this._stopRecognition();
          this._sync();
        }
        return;
      }
      // no-speech / aborted：静默——连续识别的常规噪声
    };
    recognition.onend = () => {
      this._listening = false;
      // continuous 被引擎打断（静音超时等）：仍处 active 且未拒绝且能力可用 → 自动续挂
      if (this.deps.isActive() && this.deps.enabled() && !this._denied && this._capability !== false) {
        try { recognition.start(); this._listening = true; } catch (_) { /* 竞态：置空交下轮 _sync 重建（审查 P2） */ this._recognition = null; }
      }
      this._sync();
    };
    this._recognition = recognition;
    try {
      recognition.start();
      this._listening = true;
    } catch (_) { /* 已在运行：下轮 _sync 兜底 */ }
  }

  _stopRecognition() {
    const recognition = this._recognition;
    this._recognition = null;
    this._listening = false;
    if (!recognition) return;
    try {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.stop();
    } catch (_) { /* 尽力而为 */ }
  }

  async _handleTranscript(text) {
    this._lastTranscript = String(text || '').trim();
    let matched = null;
    try {
      matched = await window.robin?.voiceMatch?.(this._lastTranscript, this.deps.lang());
    } catch (_) { matched = null; }
    if (!matched || !matched.action) {
      this._showCaption(this._lastTranscript, null); // 未知口令：展示但不动作
      return;
    }
    await this.dispatch(matched.action, { matched });
  }

  // MARK: - 动作分发（识别与口令环共用）

  async dispatch(action, { matched = null } = {}) {
    const handler = this.deps.actions?.[action];
    let ok = false;
    try {
      if (typeof handler === 'function') { await handler(); ok = true; }
    } catch (err) {
      this.deps.toast?.(`${t('语音指令执行失败')}：${String(err && err.message || err).slice(0, 60)}`);
    }
    const label = matched ? t(matched.label) : this._actionLabel(action);
    this._showCaption(matched ? `${this._lastTranscript || ''}`.trim() : '', ok ? action : null, label);
    return ok;
  }

  _actionLabel(action) {
    const table = this._commandsCache;
    const entry = Array.isArray(table) ? table.find((c) => c.action === action) : null;
    return entry ? t(entry.label) : '';
  }

  // MARK: - UI

  _mountOrb() {
    if (document.getElementById('nj-voice-orb')) return;
    const orb = document.createElement('button');
    orb.type = 'button';
    orb.className = 'nj-voice-orb';
    orb.id = 'nj-voice-orb';
    orb.dataset.role = 'voice-orb';
    orb.title = t('语音指挥');
    orb.setAttribute('aria-label', t('语音指挥'));
    orb.innerHTML = `<span class="nj-vo-ic">${MIC_SVG}</span><span class="nj-vo-caption" hidden></span><span class="nj-vo-panel" hidden></span>`;
    document.body.appendChild(orb);
    this._el = orb;
    orb.addEventListener('click', () => this._togglePanel());
    orb.addEventListener('mouseenter', () => this._showPanel());
    orb.addEventListener('mouseleave', () => this._hidePanel());
  }

  /** 口令按钮环降级方案：探测不到识别引擎时的正式动作面（与识别同一 dispatch）。 */
  _mountRing() {
    if (this._ringEl || typeof document === 'undefined') return;
    const ring = document.createElement('div');
    ring.className = 'nj-voice-ring';
    ring.id = 'nj-voice-ring';
    ring.dataset.role = 'voice-ring';
    ring.innerHTML = '<span class="nj-vo-ring-label"></span><span class="nj-vo-ring-btns"></span>';
    document.body.appendChild(ring);
    this._ringEl = ring;
    this._renderRingButtons();
  }

  async _renderRingButtons() {
    if (!this._ringEl) return;
    const host = this._ringEl.querySelector('.nj-vo-ring-btns');
    const label = this._ringEl.querySelector('.nj-vo-ring-label');
    if (label) label.textContent = t('口令环');
    const commands = await this._commands();
    if (!host) return;
    host.innerHTML = '';
    for (const cmd of commands) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nj-vo-ring-btn';
      btn.dataset.action = cmd.action;
      btn.textContent = t(cmd.label);
      btn.title = t(cmd.label);
      btn.addEventListener('click', () => this.dispatch(cmd.action, { matched: { label: t(cmd.label) } }));
      host.appendChild(btn);
    }
  }

  async _commands() {
    if (this._commandsCache) return this._commandsCache;
    let payload = null;
    try { payload = await window.robin?.voiceCommands?.(this.deps.lang()); } catch (_) { payload = null; }
    this._commandsCache = Array.isArray(payload?.commands) && payload.commands.length
      ? payload.commands
      : [ // 兜底补 phrases 字段（审查 P2：缺 phrases 使 _showPanel 的 c.phrases[0] 抛 TypeError，面板打不开）
        { action: 'toggle', label: t('暂停 / 继续'), phrases: ['暂停', '继续', '停止'] },
        { action: 'next', label: t('下一篇'), phrases: ['下一篇', '下一条'] },
        { action: 'star', label: t('收藏'), phrases: ['收藏'] },
      ];
    return this._commandsCache;
  }

  _togglePanel() { this._panelHidden === false ? this._hidePanel() : this._showPanel(); }

  async _showPanel() {
    const panel = this._el?.querySelector('.nj-vo-panel');
    if (!panel) return;
    const commands = await this._commands();
    const lines = commands.map((c) => `${t(c.label)}：「${c.phrases[0]}」`).join('\n');
    const hint = this._capability
      ? t('说出口令即可执行；识别语言跟随界面语言。')
      : t('当前环境不支持语音识别，已切换为口令按钮环。');
    panel.innerHTML = '';
    const title = document.createElement('b');
    title.textContent = t('语音指挥口令表');
    const list = document.createElement('span');
    list.className = 'nj-vo-panel-list';
    list.textContent = lines;
    const note = document.createElement('i');
    note.textContent = hint;
    panel.append(title, list, note);
    panel.hidden = false;
    this._panelHidden = false;
  }

  _hidePanel() {
    const panel = this._el?.querySelector('.nj-vo-panel');
    if (panel) panel.hidden = true;
    this._panelHidden = true;
  }

  /** 识别文本 + 执行动作展示（2.6s 自动消退）。 */
  _showCaption(text, action, actionLabel = '') {
    const caption = this._el?.querySelector('.nj-vo-caption');
    if (!caption) return;
    const actionText = actionLabel || this._actionLabel(action) || (action === 'denied' ? '' : '');
    const parts = [];
    if (text) parts.push(`「${text.slice(0, 24)}」`);
    if (actionText) parts.push(actionText);
    if (!parts.length) return;
    caption.textContent = parts.join(' · ');
    caption.hidden = false;
    if (this._captionTimer) clearTimeout(this._captionTimer);
    this._captionTimer = setTimeout(() => { caption.hidden = true; }, 2600);
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return {
      capability: this.capabilityState(),
      listening: this._listening,
      attached: Boolean(this._recognition),
      ringRendered: Boolean(this._ringEl),
      ringButtons: this._ringEl ? this._ringEl.querySelectorAll('.nj-vo-ring-btn').length : 0,
      orbVisible: Boolean(this._el?.classList.contains('visible')),
      captionText: this._el?.querySelector('.nj-vo-caption')?.textContent || '',
      captionVisible: !(this._el?.querySelector('.nj-vo-caption')?.hidden ?? true),
      lang: this.deps.lang(),
    };
  }
}
