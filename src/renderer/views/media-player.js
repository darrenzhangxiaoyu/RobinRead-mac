'use strict';
/**
 * RobinRead（知更）— 底部迷你播放器（F3 媒体中心）
 *
 * 复用 TTS 迷你播放器的交互语言（胶囊浮层 / 按钮家族 / 倍速循环）但为独立组件：
 * - HTMLAudioElement 流式播放（远程 URL 或离线 file://，Electron 媒体无 CORS 限制）；
 *   视频条目同样走音频轨收听，画面播放走阅读器内嵌 <video controls>；
 * - UI 由 timeupdate 事件驱动（无 rAF 轮询）；
 * - 进度持久化：5s 节流 IPC + 暂停/关闭/播完 flush；重开续播（>95% 由主进程归零）；
 * - 播放队列：主进程持有（偏好持久化），ended 自动连播，可手动跳下一首；
 * - 全局单实例：类内仅一个 <audio>，切换条目先 flush 旧进度再换源；
 *   与 TTS 互斥：open 前若 TTS 在播 → 先停 TTS（deps.tts 注入，探针可 mock）。
 */
import { t } from '../i18n.js';

const RATES = [0.75, 1, 1.25, 1.5, 2];
const SAVE_INTERVAL_MS = 5000; // 进度节流（渲染层）
const SVG = {
  play: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M5 3.2v9.6l7.6-4.8z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4.6 3h2.3v10H4.6zM9.1 3h2.3v10H9.1z"/></svg>',
  back15: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M3.2 6.4A5.4 5.4 0 1 1 2.6 9.6"/><path d="M2.4 3.4v3h3"/><text x="8" y="11" font-size="6" fill="currentColor" stroke="none" text-anchor="middle" font-family="sans-serif">15</text></svg>',
  fwd15: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M12.8 6.4a5.4 5.4 0 1 0 .6 3.2"/><path d="M13.6 3.4v3h-3"/><text x="8" y="11" font-size="6" fill="currentColor" stroke="none" text-anchor="middle" font-family="sans-serif">15</text></svg>',
  next: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M3 3.4v9.2l6-4.6z"/><rect x="10.6" y="3.4" width="1.8" height="9.2" rx="0.6"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8"/></svg>',
  queue: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M2.4 4.4h11.2M2.4 8h11.2M2.4 11.6h6.4"/></svg>',
  trash: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M2.6 4.2h10.8M6.4 4.2V3c0-.5.4-.9.9-.9h1.4c.5 0 .9.4.9.9v1.2M4 4.2l.5 8.4c0 .7.6 1.3 1.3 1.3h4.4c.7 0 1.3-.6 1.3-1.3l.5-8.4"/></svg>',
};

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return h ? `${h}:${mm}:${String(sec).padStart(2, '0')}` : `${mm}:${String(sec).padStart(2, '0')}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class MediaMiniPlayer {
  /**
   * @param deps.tts { state(): 'idle'|'playing'|'paused', stop() } TTS 互斥缝（探针可 mock）
   * @param deps.toast?(message) 轻提示
   */
  constructor(deps = {}) {
    this.deps = {
      tts: deps.tts || { state: () => 'idle', stop: () => {} },
      toast: deps.toast || null,
    };
    this.audio = null;          // 全局唯一 <audio>（单实例）
    this.current = null;        // mediaSource 载荷 { itemID, kind, url, position, ... }
    this._rateIndex = 1;        // 1x
    this._seeking = false;
    this._lastSaveAt = 0;
    this._endedFired = false;
    this._queueOpen = false;
    this._openGen = 0;          // open 代号：快速连点/连播切换时，过期 open 中止（防旧源覆盖新源）
    this._mount();
    window.__robinMedia = this; // E2E / TTS 互斥反向缝（reader 停媒体用）
  }

  // MARK: - 状态查询

  get itemID() { return this.current ? this.current.itemID : null; }

  get state() {
    if (!this.audio || !this.current) return 'idle';
    return this.audio.paused ? 'paused' : 'playing';
  }

  /** 是否持有已加载条目（媒体视图空格键判断用）。 */
  hasCurrent() { return Boolean(this.current); }

  // MARK: - 打开 / 播放

  /** 打开条目：同条目再次调用 = 播放/暂停切换；与 TTS 互斥在此裁决。 */
  async open(itemID) {
    if (!itemID) return false;
    const gen = ++this._openGen; // 过期 open 守卫：连续切换时只有最新一次生效
    // 全局互斥 1/2：TTS 在播 → 先停 TTS（渲染层 TTS 状态机由 reader 持有）
    if (this.deps.tts && this.deps.tts.state() !== 'idle') {
      try { this.deps.tts.stop(); } catch (_) { /* TTS 停止失败不阻塞媒体 */ }
    }
    if (this.current && this.current.itemID === itemID) {
      this.toggle();
      return true;
    }
    // 换源：旧进度先落库
    this._flushProgress();
    let source = null;
    try { source = await window.robin.mediaSource(itemID); } catch (_) { source = null; }
    if (gen !== this._openGen) return false; // 期间已有更新的打开请求：本次作废
    if (!source || !source.url) {
      this.deps.toast?.(t('媒体不可用（可能已被删除）。'));
      return false;
    }
    this._ensureAudio();
    this._endedFired = false;
    this.current = source;
    this.audio.src = source.url; // 本地离线时主进程已解析为 file://
    this._applyRate();
    this._renderMeta();
    this._show();
    // 续播：loadedmetadata 后跳到持久化位置（主进程已把 >95% 归零）
    const resumeAt = Number(source.position) || 0;
    if (resumeAt > 0.5) {
      const seek = () => {
        if (gen !== this._openGen || !this.current || this.current.itemID !== itemID) return;
        try { this.audio.currentTime = Math.min(resumeAt, Math.max(0, (this.audio.duration || resumeAt) - 0.2)); } catch (_) { /* 时长未知时忽略 */ }
      };
      if (this.audio.readyState >= 1) seek();
      else this.audio.addEventListener('loadedmetadata', seek, { once: true });
    }
    try { await this.audio.play(); } catch (_) { /* 自动播放被拦：用户点播放键即可 */ }
    if (gen !== this._openGen) return false; // 播放等待期间被更新的请求取代
    this._updatePlayButton();
    return true;
  }

  toggle() {
    if (!this.audio || !this.current) return;
    if (this.audio.paused) {
      if (this.deps.tts && this.deps.tts.state() !== 'idle') {
        try { this.deps.tts.stop(); } catch (_) { /* 忽略 */ }
      }
      this.audio.play().catch(() => {});
    } else {
      this.audio.pause(); // pause 事件内 flush 进度
    }
    this._updatePlayButton();
  }

  /** TTS 开播时的反向互斥：暂停媒体（播放器保持可见，可一键续播）。 */
  pauseForTTS() {
    if (this.audio && this.current && !this.audio.paused) {
      this.audio.pause();
      this._flushProgress();
    }
  }

  /** 关闭播放器（flush 后清源、隐藏）。 */
  close() {
    this._openGen += 1; // 在途 open 全部作废
    this._flushProgress();
    if (this.audio) {
      try { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); } catch (_) { /* 已释放 */ }
    }
    this.current = null;
    this._queueOpen = false;
    this._hide();
  }

  // MARK: - 队列

  /** 手动跳下一首（队列空 → 提示）。 */
  async playNext() {
    const next = await window.robin.mediaQueueNext(this.current ? this.current.itemID : null);
    if (!next || !next.itemID) {
      this.deps.toast?.(t('队列已空'));
      return false;
    }
    return this.open(next.itemID);
  }

  async _onEnded() {
    this._endedFired = true;
    this._saveProgress({ finished: true }); // 播完 flush（主进程归零 = 已播完）
    this._updatePlayButton();
    try {
      const next = await window.robin.mediaQueueNext(this.current ? this.current.itemID : null);
      if (next && next.itemID) {
        await this.open(next.itemID); // 自动连播
      } else {
        this.close(); // 队列空：收起播放器
      }
    } catch (_) {
      // P2：连播 IPC 拒绝不得成为未处理 rejection——停在结束态并提示
      this.deps.toast?.(t('自动连播失败，已停止播放。'));
    }
  }

  // MARK: - 进度持久化（5s 节流 + 关键点 flush）

  _saveProgress({ finished = false } = {}) {
    if (!this.current || !this.audio) return;
    const position = Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
    window.robin.mediaProgress(this.current.itemID, position, finished).catch(() => {});
    this._lastSaveAt = Date.now();
  }

  _flushProgress() {
    if (!this.current || !this.audio) return;
    if (this._endedFired) return; // ended 已按播完落库
    this._saveProgress({});
  }

  // MARK: - UI

  _mount() {
    if (document.getElementById('nj-media-player')) return;
    const player = el('div', 'nj-media-player');
    player.id = 'nj-media-player';
    player.dataset.role = 'media-player';
    player.innerHTML = `
      <button type="button" class="nj-mp-btn nj-mp-toggle" title="${t('播放 / 暂停')}"></button>
      <button type="button" class="nj-mp-btn nj-mp-back" title="${t('快退 15 秒')}">${SVG.back15}</button>
      <button type="button" class="nj-mp-btn nj-mp-fwd" title="${t('快进 15 秒')}">${SVG.fwd15}</button>
      <span class="nj-mp-time nj-mp-cur">0:00</span>
      <input class="nj-mp-slider" type="range" min="0" max="1000" value="0" step="1" title="${t('播放进度')}"/>
      <span class="nj-mp-time nj-mp-dur">0:00</span>
      <button type="button" class="nj-mp-btn nj-mp-rate" title="${t('倍速（0.75 / 1 / 1.25 / 1.5 / 2）')}">1×</button>
      <button type="button" class="nj-mp-btn nj-mp-queue" title="${t('播放队列')}">${SVG.queue}</button>
      <button type="button" class="nj-mp-btn nj-mp-next" title="${t('下一首')}">${SVG.next}</button>
      <button type="button" class="nj-mp-btn nj-mp-close" title="${t('关闭播放器')}">${SVG.close}</button>
      <div class="nj-mp-queue-pop" hidden></div>
      <div class="nj-mp-meta"><span class="nj-mp-title"></span><span class="nj-mp-source"></span></div>`;
    document.body.appendChild(player);
    this._el = player;

    player.querySelector('.nj-mp-toggle').addEventListener('click', () => this.toggle());
    player.querySelector('.nj-mp-back').addEventListener('click', () => this.seekBy(-15));
    player.querySelector('.nj-mp-fwd').addEventListener('click', () => this.seekBy(15));
    player.querySelector('.nj-mp-next').addEventListener('click', () => { this.playNext(); });
    player.querySelector('.nj-mp-close').addEventListener('click', () => this.close());
    player.querySelector('.nj-mp-rate').addEventListener('click', () => this.cycleRate());
    player.querySelector('.nj-mp-queue').addEventListener('click', () => this._toggleQueuePopover());

    const slider = player.querySelector('.nj-mp-slider');
    slider.addEventListener('input', () => { this._seeking = true; });
    slider.addEventListener('change', () => {
      if (this.audio && this.current && Number.isFinite(this.audio.duration)) {
        const ratio = Number(slider.value) / 1000;
        try { this.audio.currentTime = ratio * this.audio.duration; } catch (_) { /* 忽略 */ }
      }
      this._seeking = false;
    });
  }

  _ensureAudio() {
    if (this.audio) return;
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.addEventListener('timeupdate', () => this._onTimeUpdate());
    audio.addEventListener('loadedmetadata', () => {
      const dur = this._el?.querySelector('.nj-mp-dur');
      if (dur) dur.textContent = fmtTime(audio.duration);
    });
    audio.addEventListener('pause', () => { this._flushProgress(); this._updatePlayButton(); });
    audio.addEventListener('play', () => this._updatePlayButton());
    audio.addEventListener('ended', () => { this._onEnded(); });
    this.audio = audio;
  }

  _onTimeUpdate() {
    if (!this.audio || !this.current) return;
    const duration = Number.isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : 0;
    const position = this.audio.currentTime || 0;
    const slider = this._el.querySelector('.nj-mp-slider');
    if (!this._seeking && slider) slider.value = duration ? String(Math.round((position / duration) * 1000)) : '0';
    const cur = this._el.querySelector('.nj-mp-cur');
    if (cur) cur.textContent = fmtTime(position);
    // 5s 节流持久化（暂停/关闭/播完另有 flush 兜底）
    if (Date.now() - this._lastSaveAt >= SAVE_INTERVAL_MS) this._saveProgress({});
  }

  seekBy(delta) {
    if (!this.audio || !this.current) return;
    const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : Infinity;
    try {
      this.audio.currentTime = Math.max(0, Math.min(duration - 0.2, this.audio.currentTime + delta));
    } catch (_) { /* 忽略 */ }
    this._saveProgress({});
  }

  cycleRate() {
    this._rateIndex = (this._rateIndex + 1) % RATES.length;
    this._applyRate();
  }

  setRate(rate) {
    const index = RATES.indexOf(Number(rate));
    if (index >= 0) this._rateIndex = index;
    this._applyRate();
  }

  _applyRate() {
    const rate = RATES[this._rateIndex];
    if (this.audio) {
      try { this.audio.playbackRate = rate; audioPreservesPitch(this.audio); } catch (_) { /* 忽略 */ }
    }
    const btn = this._el?.querySelector('.nj-mp-rate');
    if (btn) btn.textContent = `${rate}×`;
  }

  _renderMeta() {
    const title = this._el.querySelector('.nj-mp-title');
    const source = this._el.querySelector('.nj-mp-source');
    const media = this.current;
    if (title) title.textContent = media.title || t('未命名文章');
    if (source) source.textContent = media.sourceTitle || '';
  }

  _updatePlayButton() {
    const btn = this._el?.querySelector('.nj-mp-toggle');
    if (!btn) return;
    const playing = this.audio && this.current && !this.audio.paused;
    btn.innerHTML = playing ? SVG.pause : SVG.play;
    btn.title = playing ? t('暂停') : t('播放');
  }

  _show() { this._el.classList.add('visible'); this._positionQueuePopover(); }
  _hide() { this._el.classList.remove('visible'); if (this._el) this._el.querySelector('.nj-mp-queue-pop').hidden = true; }

  async _toggleQueuePopover() {
    const pop = this._el.querySelector('.nj-mp-queue-pop');
    this._queueOpen = !this._queueOpen;
    if (!this._queueOpen) { pop.hidden = true; return; }
    pop.hidden = false;
    pop.innerHTML = '';
    const head = el('div', 'nj-mp-queue-head');
    head.appendChild(el('span', null, t('播放队列')));
    const clearBtn = el('button', 'nj-mp-queue-clear', t('清空'));
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', async () => {
      await window.robin.mediaQueueClear();
      await this._renderQueueItems(pop);
    });
    head.appendChild(clearBtn);
    pop.appendChild(head);
    await this._renderQueueItems(pop);
    this._positionQueuePopover();
  }

  async _renderQueueItems(pop) {
    [...pop.querySelectorAll('.nj-mp-queue-item, .nj-mp-queue-empty')].forEach((n) => n.remove());
    const queue = await window.robin.mediaQueueList();
    if (!queue || !queue.length) {
      pop.appendChild(el('div', 'nj-mp-queue-empty', t('队列已空，在媒体视图把条目加入队列')));
      return;
    }
    for (const item of queue) {
      const row = el('div', 'nj-mp-queue-item' + (item.itemID === this.itemID ? ' current' : ''));
      const label = el('button', 'nj-mp-queue-label');
      label.type = 'button';
      label.textContent = item.title || t('未命名文章');
      label.title = item.title || '';
      label.addEventListener('click', () => { this.open(item.itemID); });
      const remove = el('button', 'nj-mp-queue-remove');
      remove.type = 'button';
      remove.innerHTML = SVG.trash;
      remove.title = t('移出队列');
      remove.addEventListener('click', async () => {
        await window.robin.mediaQueueRemove(item.itemID);
        await this._renderQueueItems(pop);
      });
      row.append(label, remove);
      pop.appendChild(row);
    }
  }

  _positionQueuePopover() {
    const pop = this._el?.querySelector('.nj-mp-queue-pop');
    if (pop) pop.hidden = !this._queueOpen;
  }
}

/** 倍速不变调（语速 2x 内保持音高，播客听感关键）。 */
function audioPreservesPitch(audio) {
  try { audio.preservesPitch = true; audio.mozPreservesPitch = true; } catch (_) { /* 老内核忽略 */ }
}
