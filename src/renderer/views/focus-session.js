'use strict';
/**
 * FocusSessionPanel — 阅读目标与专注会话（F20 · 渲染层）
 *
 * 阅读器工具栏「专注」按钮（禅模式旁）→ 专注面板浮层：
 * - 设定时长（15 / 25 / 45 分钟）+ 开始 → 倒计时环（SVG stroke-dasharray，
 *   OKLCH accent 令牌；setInterval 每秒 UI 更新，rAF 不必要）；
 * - 会话期间计数：打开文章篇数（app.js handleEntrySelect 钩子调 countRead）
 *   + 批注数（reader 高亮/笔记保存时派发 robinread:annotation-created）；
 * - 结束（自然到点 / 中途确认退出）→ 小结：本会话读了几篇 / 时长 / 批注数，
 *   可「复制小结」到剪贴板；
 * - 中途退出有确认（confirmBox，frameless 禁 window.confirm）；
 * - 会话不持久化（纯内存对象）；时间注入缝 _nowImpl + _intervalMs（探针加速）。
 */
import { t, tf } from '../i18n.js';
import { confirmBox } from '../ui-prompt.js';

const DURATIONS = [15, 25, 45];

export class FocusSessionPanel {
  constructor(deps = {}) {
    this.deps = {
      toast: deps.toast || null,
    };
    this.durationMin = 25;
    this.state = 'idle'; // idle | running | ended
    // 注入缝：探针把 _nowImpl 拨快 / _intervalMs 调小即得时间加速
    this._nowImpl = deps._nowImpl || (() => Date.now());
    this._intervalMs = deps._intervalMs || 1000;
    this.readCount = 0;
    this.annotationCount = 0;
    this.startedAt = 0;
    this.endsAt = 0;
    this._timer = null;
    this._overlay = null;
    // 批注计数：reader 保存高亮/笔记时派发 DOM 事件（会话外静默忽略）
    this._onAnnotation = () => {
      if (this.state === 'running') {
        this.annotationCount += 1;
        this._sync();
      }
    };
    document.addEventListener('robinread:annotation-created', this._onAnnotation);
  }

  // MARK: - 会话钩子（app.js handleEntrySelect 调用）

  countRead() {
    if (this.state !== 'running') return;
    this.readCount += 1;
    this._sync();
  }

  get running() { return this.state === 'running'; }

  // MARK: - 面板生命周期

  open() {
    if (this._overlay) return;
    const overlay = document.createElement('div');
    overlay.className = 'nj-focus-overlay';
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) this.requestClose();
    });
    const panel = document.createElement('div');
    panel.className = 'nj-focus-panel';
    panel.dataset.role = 'focus-panel';
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    this._overlay = overlay;
    this._esc = (e) => { if (e.key === 'Escape') this.requestClose(); };
    document.addEventListener('keydown', this._esc);
    this._renderIdle();
  }

  /** 关闭入口：会话进行中先确认（中途退出有确认），确认后留面板展示小结。 */
  async requestClose() {
    if (this.state === 'running') {
      const ok = await confirmBox(t('结束专注会话'), {
        message: t('专注会话尚未结束，退出将立即生成本次小结。'),
        okLabel: t('结束并小结'),
      });
      if (!ok) return;
      this.finish({ early: true });
      return; // 小结留在面板中（含复制小结），由用户点「完成」或 Esc 关闭
    }
    this.close();
  }

  close() {
    this._stopTimer();
    document.removeEventListener('keydown', this._esc);
    this._overlay?.remove();
    this._overlay = null;
  }

  /** 彻底释放（应用层重载组件时调用）：移除 DOM 事件监听。 */
  dispose() {
    this._stopTimer();
    document.removeEventListener('robinread:annotation-created', this._onAnnotation);
    this.close();
  }

  // MARK: - 会话控制

  start() {
    if (this.state === 'running') return;
    this.readCount = 0;
    this.annotationCount = 0;
    this.startedAt = this._nowImpl();
    this.endsAt = this.startedAt + this.durationMin * 60 * 1000;
    this.state = 'running';
    this._renderRunning();
    this._stopTimer();
    this._timer = setInterval(() => {
      if (this._nowImpl() >= this.endsAt) {
        this.finish({ early: false });
        return;
      }
      this._sync();
    }, this._intervalMs);
    this.deps.toast?.(tf('专注会话开始：%lld 分钟', this.durationMin));
  }

  finish({ early = false } = {}) {
    this._stopTimer();
    this._early = early;
    this.state = 'ended';
    this._renderEnded();
  }

  summaryText() {
    const minutes = Math.max(0, Math.round(((this.state === 'running' ? this._nowImpl() : this.endsAt) - this.startedAt) / 60000));
    return tf('专注小结：阅读 %lld 篇 · 专注 %lld 分钟 · 批注 %lld 条', this.readCount, minutes, this.annotationCount);
  }

  _stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // MARK: - 渲染

  _panel() { return this._overlay?.querySelector('.nj-focus-panel') || null; }

  _renderIdle() {
    const panel = this._panel();
    if (!panel) return;
    panel.innerHTML = `
      <div class="nj-fp-head"><span class="nj-fp-title"></span>
        <button type="button" class="nj-rp-btn nj-fp-close"></button></div>
      <div class="nj-fp-desc"></div>
      <div class="nj-fp-seg" role="tablist"></div>
      <button type="button" class="btn-text primary nj-fp-start"></button>`;
    panel.querySelector('.nj-fp-title').textContent = t('专注会话');
    panel.querySelector('.nj-fp-desc').textContent = t('设定一段不被打扰的阅读时间，结束时给出小结。');
    panel.querySelector('.nj-fp-close').textContent = '×';
    panel.querySelector('.nj-fp-close').addEventListener('click', () => this.requestClose());
    panel.querySelector('.nj-fp-start').textContent = t('开始专注');
    panel.querySelector('.nj-fp-start').addEventListener('click', () => this.start());
    const seg = panel.querySelector('.nj-fp-seg');
    for (const min of DURATIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `nj-fp-seg-btn ${min === this.durationMin ? 'active' : ''}`;
      btn.textContent = tf('%lld 分钟', min);
      btn.addEventListener('click', () => {
        this.durationMin = min;
        seg.querySelectorAll('.nj-fp-seg-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
      seg.appendChild(btn);
    }
  }

  _renderRunning() {
    const panel = this._panel();
    if (!panel) return;
    panel.innerHTML = `
      <div class="nj-fp-head"><span class="nj-fp-title"></span>
        <button type="button" class="nj-rp-btn nj-fp-close"></button></div>
      <div class="nj-fp-ringwrap">
        <svg class="nj-fp-svg" viewBox="0 0 88 88" role="img">
          <circle class="nj-fp-track" cx="44" cy="44" r="38"/>
          <circle class="nj-fp-fill" cx="44" cy="44" r="38"/>
        </svg>
        <div class="nj-fp-center"><b class="nj-fp-clock"></b><span class="nj-fp-sub"></span></div>
      </div>
      <div class="nj-fp-stats">
        <span class="nj-fp-stat"><b class="nj-fp-read">0</b><i></i></span>
        <span class="nj-fp-stat"><b class="nj-fp-anno">0</b><i></i></span>
      </div>
      <button type="button" class="btn-text nj-fp-stop"></button>`;
    panel.querySelector('.nj-fp-title').textContent = t('专注进行中');
    panel.querySelector('.nj-fp-close').textContent = '×';
    panel.querySelector('.nj-fp-close').addEventListener('click', () => this.requestClose());
    panel.querySelector('.nj-fp-sub').textContent = t('剩余');
    panel.querySelector('.nj-fp-read').nextElementSibling.textContent = t('已读篇');
    panel.querySelector('.nj-fp-anno').nextElementSibling.textContent = t('批注');
    panel.querySelector('.nj-fp-stop').textContent = t('结束会话');
    panel.querySelector('.nj-fp-stop').addEventListener('click', () => this.requestClose());
    const R = 38;
    const C = 2 * Math.PI * R;
    const fill = panel.querySelector('.nj-fp-fill');
    fill.style.strokeDasharray = C.toFixed(1);
    this._sync();
  }

  _renderEnded() {
    const panel = this._panel();
    if (!panel) return;
    panel.innerHTML = `
      <div class="nj-fp-head"><span class="nj-fp-title"></span>
        <button type="button" class="nj-rp-btn nj-fp-close"></button></div>
      <div class="nj-fp-summary"></div>
      <div class="nj-fp-actions">
        <button type="button" class="btn-text nj-fp-copy"></button>
        <button type="button" class="btn-text primary nj-fp-done"></button>
      </div>`;
    panel.querySelector('.nj-fp-title').textContent = t('专注小结');
    panel.querySelector('.nj-fp-close').textContent = '×';
    panel.querySelector('.nj-fp-close').addEventListener('click', () => this.close());
    const minutes = Math.max(0, Math.round((this.endsAt - this.startedAt) / 60000));
    const lines = [
      tf('本会话阅读 %lld 篇文章', this.readCount),
      tf('专注时长约 %lld 分钟', minutes),
      tf('批注 %lld 条', this.annotationCount),
    ];
    const summary = panel.querySelector('.nj-fp-summary');
    summary.innerHTML = '';
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = 'nj-fp-summary-line';
      row.textContent = line;
      summary.appendChild(row);
    }
    if (this._early) {
      const early = document.createElement('div');
      early.className = 'nj-fp-early';
      early.textContent = t('本次会话提前结束');
      summary.appendChild(early);
    }
    panel.querySelector('.nj-fp-copy').textContent = t('复制小结');
    panel.querySelector('.nj-fp-copy').addEventListener('click', async () => {
      const text = this.summaryText();
      const ok = await window.robin.copyText(text);
      this.deps.toast?.(ok ? t('已复制专注小结') : t('复制失败'));
    });
    panel.querySelector('.nj-fp-done').textContent = t('完成');
    panel.querySelector('.nj-fp-done').addEventListener('click', () => this.close());
  }

  /** 每秒 UI 更新：倒计时环 + 时钟 + 计数（仅 running 态 DOM 在场）。 */
  _sync() {
    const panel = this._panel();
    if (!panel || this.state !== 'running') return;
    const totalMs = Math.max(1, this.endsAt - this.startedAt);
    const remainMs = Math.max(0, this.endsAt - this._nowImpl());
    const remainSec = Math.ceil(remainMs / 1000);
    const mm = Math.floor(remainSec / 60);
    const ss = remainSec % 60;
    const clock = panel.querySelector('.nj-fp-clock');
    if (clock) clock.textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    const fill = panel.querySelector('.nj-fp-fill');
    if (fill) {
      const C = 2 * Math.PI * 38;
      fill.style.strokeDashoffset = (C * (1 - remainMs / totalMs)).toFixed(1);
    }
    const read = panel.querySelector('.nj-fp-read');
    if (read) read.textContent = String(this.readCount);
    const anno = panel.querySelector('.nj-fp-anno');
    if (anno) anno.textContent = String(this.annotationCount);
  }
}
