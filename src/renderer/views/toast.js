'use strict';
/**
 * toast.js — U13 自绘通知 Toast 栈
 *
 * 能力：可堆叠（上限 4，超出即弃最旧）/ 成功·警告·错误三态图标 / 进出动画 /
 *       hover 暂停自动消退（离场剩余时间续走）/ 进度通知（长任务：刷新/导出等，
 *       set 百分比 → done/fail 收口）/ 动作按钮（兼容旧 showToast 第三参）。
 *
 * 兼容合同：app.js 与 dialogs.js 的旧 showToast(message, duration?, action?) 签名
 * 委托到 Toast.show，全部既有调用点零改动。reduced-motion 由 robin.css 全局收敛块兜底。
 */
import { icon } from '../icons.js';

const STACK_ID = 'nj-toast-stack';
const CAP = 4;
const LEAVE_MS = 250; // 与 .toast-capsule.leaving 过渡（--dur-mid）对齐

/** 三态图标（内联 1.75 描边，与 icons.js 同语言）。 */
const TONE_ICON = {
  success: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.25"/><path d="M5.2 8.2l1.9 1.9 3.7-4"/></svg>',
  warn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.4L14.4 13.3H1.6L8 2.4z"/><path d="M8 6.6v3"/><circle cx="8" cy="11.6" r="0.1"/></svg>',
  error: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.25"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/></svg>',
  progress: '<svg class="toast-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="8" cy="8" r="6.25" opacity="0.25"/><path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25"/></svg>',
};

const live = new Set(); // 在场 toast 记录（用于栈容量与 dismissTop）

function ensureStack() {
  let stack = document.getElementById(STACK_ID);
  if (!stack) {
    stack = document.createElement('div');
    stack.id = STACK_ID;
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  return stack;
}

/** 离场：挂 .leaving（CSS 过渡 --dur-mid）后移除；进度条已停表。 */
function leave(entry) {
  if (!live.has(entry)) return;
  live.delete(entry);
  clearTimeout(entry.timer);
  const { el } = entry;
  el.classList.add('leaving');
  setTimeout(() => el.remove(), LEAVE_MS);
}

/** hover 暂停：进悬停清表记剩余，离悬停按剩余续走（呼吸的倒计时条同步暂停）。 */
function wireHoverPause(entry) {
  entry.el.addEventListener('mouseenter', () => {
    if (!entry.duration) return;
    clearTimeout(entry.timer);
    entry.remaining -= Date.now() - entry.startedAt;
    entry.el.classList.add('hold');
  });
  entry.el.addEventListener('mouseleave', () => {
    if (!entry.duration) return;
    entry.el.classList.remove('hold');
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => leave(entry), Math.max(0, entry.remaining));
  });
}

/**
 * 压入一条 toast。
 * @param {string} message 文案
 * @param {{duration?:number, tone?:'success'|'warn'|'error', action?:{label:string, onClick:Function}}} [opts]
 * @returns {HTMLElement} toast 元素
 */
export function showToast(message, opts = {}) {
  const {
    duration = 1800,
    tone = 'success',
    action = null,
  } = opts;
  const stack = ensureStack();
  // 容量护栏：超限先请最旧的走（无动画直落，避免栈爆）
  while (live.size >= CAP) {
    const oldest = live.values().next().value;
    live.delete(oldest);
    oldest.el.remove();
  }

  const el = document.createElement('div');
  el.className = `toast-capsule ${tone}`;
  el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span class="toast-ic">${TONE_ICON[tone] || TONE_ICON.success}</span><span class="toast-msg"></span>`;
  el.querySelector('.toast-msg').textContent = message;

  const entry = { el, duration, timer: 0, startedAt: Date.now(), remaining: duration };
  if (action?.label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      leave(entry);
      action.onClick?.();
    });
    el.appendChild(btn);
  }
  stack.appendChild(el);
  live.add(entry);
  if (duration > 0) {
    entry.timer = setTimeout(() => leave(entry), duration);
    wireHoverPause(entry);
  }
  return el;
}

/** 旧 dismissToast 语义：请走最顶端（最新）一条。 */
export function dismissTop() {
  if (!live.size) return;
  const last = [...live].pop();
  leave(last);
}

/**
 * 进度通知（长任务：刷新/导出/成书/清理等）。
 * 返回句柄：set(pct, note?) / done(message?) / fail(message?) / close()。
 * 活跃期不自动消退；done/fail 落三态图标后按各自时长收口。
 */
export function showProgress(title, { note = '', total = 100 } = {}) {
  const stack = ensureStack();
  while (live.size >= CAP) {
    const oldest = live.values().next().value;
    live.delete(oldest);
    oldest.el.remove();
  }
  const el = document.createElement('div');
  el.className = 'toast-capsule progress';
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <span class="toast-ic">${TONE_ICON.progress}</span>
    <span class="toast-body">
      <span class="toast-title"></span>
      <span class="toast-bar"><i></i></span>
    </span>`;
  el.querySelector('.toast-title').textContent = title;
  const noteEl = document.createElement('span');
  noteEl.className = 'toast-note';
  noteEl.textContent = note;
  el.querySelector('.toast-body').appendChild(noteEl);

  const entry = { el, duration: 0, timer: 0, startedAt: 0, remaining: 0 };
  stack.appendChild(el);
  live.add(entry);

  const barFill = el.querySelector('.toast-bar > i');
  let lastPct = 0;
  const handle = {
    /** 推进进度：pct ∈ [0,100]（或按 total 归一），note 更新右侧小字。 */
    set(pct, noteText) {
      lastPct = Math.max(0, Math.min(100, (Number(pct) / (total || 100)) * 100));
      barFill.style.width = `${lastPct}%`;
      if (noteText !== undefined) noteEl.textContent = String(noteText);
      return handle;
    },
    /** 完成：换成功态 + 收口提示，短暂停留后自动离场。 */
    done(message) {
      if (!live.has(entry)) return handle;
      el.classList.remove('progress');
      el.classList.add('success');
      el.querySelector('.toast-ic').innerHTML = TONE_ICON.success;
      if (message) el.querySelector('.toast-title').textContent = message;
      noteEl.remove();
      el.querySelector('.toast-bar').remove();
      entry.duration = 1600;
      entry.remaining = 1600;
      entry.startedAt = Date.now();
      entry.timer = setTimeout(() => leave(entry), 1600);
      wireHoverPause(entry);
      return handle;
    },
    /** 失败：换错误态，停留更久供阅读。 */
    fail(message) {
      if (!live.has(entry)) return handle;
      el.classList.remove('progress');
      el.classList.add('error');
      el.querySelector('.toast-ic').innerHTML = TONE_ICON.error;
      if (message) el.querySelector('.toast-title').textContent = message;
      noteEl.remove();
      el.querySelector('.toast-bar').remove();
      entry.duration = 3200;
      entry.remaining = 3200;
      entry.startedAt = Date.now();
      entry.timer = setTimeout(() => leave(entry), 3200);
      wireHoverPause(entry);
      return handle;
    },
    close() { leave(entry); return handle; },
  };
  return handle;
}

/** 探针/单测辅助：当前在场（未进入离场动画）条数。 */
export function liveCount() { return live.size; }

export const Toast = { show: showToast, dismissTop, progress: showProgress, liveCount };
