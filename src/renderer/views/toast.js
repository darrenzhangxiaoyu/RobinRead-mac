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

const live = new Set(); // 在场 toast 记录（用于栈容量与 dismiss）

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

/** 容量护栏：超限先请最旧的普通条走（无动画直落，避免栈爆）；进度条豁免淘汰（审查 P3：
 *  长任务进行中连打普通 toast 不得挤掉进度条——挤掉后 done/fail 将静默失效）。 */
function evictOldestNormal() {
  for (const e of live) {
    if (!e.progress) {
      live.delete(e);
      e.el.remove();
      return;
    }
  }
  const oldest = live.values().next().value; // 全是进度条时退回最旧（不致栈爆）
  if (oldest) { live.delete(oldest); oldest.el.remove(); }
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
  // 带动作的提示保底 ≥4.2s（审查 P1：动作按钮需要阅读+点击时间，默认 1.8s 基本点不到）
  const effDuration = action?.label ? Math.max(duration, 4200) : duration;
  const stack = ensureStack();
  while (live.size >= CAP) evictOldestNormal();

  const el = document.createElement('div');
  el.className = `toast-capsule ${tone}`;
  el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span class="toast-ic">${TONE_ICON[tone] || TONE_ICON.success}</span><span class="toast-msg"></span>`;
  el.querySelector('.toast-msg').textContent = message;

  const entry = { el, duration: effDuration, timer: 0, startedAt: Date.now(), remaining: effDuration };
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
  if (effDuration > 0) {
    entry.timer = setTimeout(() => leave(entry), effDuration);
    wireHoverPause(entry);
  }
  return el;
}

/** 旧 dismissToast 语义：请走最早一条（审查 P3：导航确认等清理场景针对的是先前的旧提示，
 *  删「最新」会在多 toast 并存时误杀无关新提示而留旧的）。 */
export function dismissTop() {
  const oldest = live.values().next().value;
  if (oldest) leave(oldest);
}

/**
 * U32 统一进度语言：.nj-progress 元素工厂（令牌组件双形态）。
 * - percent == null → 不确定式呼吸点形态（.nj-progress--indeterminate + .nj-progress-dot）；
 * - percent 数字 → 确定式进度条形态（.nj-progress + .nj-progress-fill + .nj-progress-pct）。
 * 返回 { el, setPercent(p), setNote(text) }；setPercent(null) 可回退呼吸形态。
 * 供阅读器译文浮标 / 媒体转写行内状态等内联场景复用（Toast.progress 为 toast 栈宿主）。
 */
export function progressElement({ percent = null, note = '' } = {}) {
  const el = document.createElement('div');
  el.className = 'nj-progress-row';
  const bar = document.createElement('div');
  bar.className = 'nj-progress';
  const fill = document.createElement('i');
  fill.className = 'nj-progress-fill';
  const dot = document.createElement('span');
  dot.className = 'nj-progress-dot';
  const pct = document.createElement('span');
  pct.className = 'nj-progress-pct';
  const noteEl = document.createElement('span');
  noteEl.className = 'nj-progress-note';
  noteEl.textContent = String(note || '');
  bar.append(fill, dot);
  el.append(bar, pct, noteEl);

  const api = {
    el,
    /** 推进：数字=确定式（条+百分比）；null=回退不确定式（呼吸点）。 */
    setPercent(p) {
      if (p == null || !Number.isFinite(Number(p))) {
        bar.classList.add('nj-progress--indeterminate');
        bar.removeAttribute('aria-valuenow');
        pct.textContent = '';
      } else {
        const v = Math.max(0, Math.min(100, Math.round(Number(p))));
        bar.classList.remove('nj-progress--indeterminate');
        fill.style.width = `${v}%`;
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(v));
        pct.textContent = `${v}%`;
      }
      return api;
    },
    setNote(text) { noteEl.textContent = String(text ?? ''); return api; },
  };
  api.setPercent(percent);
  return api;
}

/**
 * 进度通知（长任务：刷新/导出/成书/清理等）。
 * 返回句柄：set(pct, note?) / done(message?) / fail(message?) / close()。
 * 活跃期不自动消退；done/fail 落三态图标后按各自时长收口。
 * U32：mode='breathe' 时以不确定式呼吸点形态呈现（无百分比的长任务：同步/连接探测等）；
 * 呼吸期间 set(pct) 原地升级为确定式进度条（同一枚组件双形态切换）。
 */
export function showProgress(title, { note = '', total = 100, mode = 'determinate' } = {}) {
  const stack = ensureStack();
  while (live.size >= CAP) evictOldestNormal();
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

  // U32：不确定式长任务（mode='breathe'）以 .nj-progress 呼吸点替换既有转圈细条，
  // 确定式保留 .toast-bar（F13 合同不变，diag-u11-u15 依赖该选择器）。
  if (mode === 'breathe') {
    const inlineProgress = progressElement({ percent: null });
    el.querySelector('.toast-bar').replaceWith(inlineProgress.el.querySelector('.nj-progress'));
  }

  const entry = { el, duration: 0, timer: 0, startedAt: 0, remaining: 0, progress: true };
  stack.appendChild(el);
  live.add(entry);
  wireHoverPause(entry); // 创建即挂监听（duration=0 时处理器空转）；done/fail 换态后直接生效

  const barFill = el.querySelector('.toast-bar > i');
  let lastPct = 0;
  /** 当前进度宿主（确定式 .toast-bar / 不确定式或升级后的 .nj-progress）。 */
  const progressHost = () => el.querySelector('.toast-bar, .nj-progress');
  /** 收口后若指针已悬停在条上（无新 mouseenter 事件），就地进入暂停态（审查 P3）。 */
  const settleTone = (toneClass, toneIcon, ms, message) => {
    el.classList.remove('progress');
    el.classList.add(toneClass);
    el.querySelector('.toast-ic').innerHTML = toneIcon;
    if (message) el.querySelector('.toast-title').textContent = message;
    noteEl.remove();
    progressHost()?.remove();
    entry.duration = ms;
    entry.remaining = ms;
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => leave(entry), ms);
    if (el.matches(':hover')) {
      clearTimeout(entry.timer);
      el.classList.add('hold');
    }
  };
  const handle = {
    /** 推进进度：pct ∈ [0,100]（或按 total 归一），note 更新右侧小字。 */
    set(pct, noteText) {
      lastPct = Math.max(0, Math.min(100, (Number(pct) / (total || 100)) * 100));
      const host = progressHost();
      if (host && host.classList.contains('nj-progress')) {
        // 呼吸形态收到首个确定值：原地升级为确定式进度条+百分比（双形态切换）
        const det = progressElement({ percent: lastPct });
        host.replaceWith(det.el.querySelector('.nj-progress'));
      } else if (barFill) {
        barFill.style.width = `${lastPct}%`;
      }
      if (noteText !== undefined) noteEl.textContent = String(noteText);
      return handle;
    },
    /** 完成：换成功态 + 收口提示，短暂停留后自动离场。 */
    done(message) {
      if (!live.has(entry)) return handle;
      settleTone('success', TONE_ICON.success, 1600, message);
      return handle;
    },
    /** 失败：换错误态，停留更久供阅读。 */
    fail(message) {
      if (!live.has(entry)) return handle;
      settleTone('error', TONE_ICON.error, 3200, message);
      return handle;
    },
    close() { leave(entry); return handle; },
  };
  return handle;
}

/** 探针/单测辅助：当前在场（未进入离场动画）条数。 */
export function liveCount() { return live.size; }

export const Toast = {
  show: showToast,
  dismissTop,
  progress: showProgress,
  /** U32 不确定式长任务（同步/探测等无百分比任务）统一呼吸点形态。 */
  breathe: (title, opts = {}) => showProgress(title, { ...opts, mode: 'breathe' }),
  liveCount,
};
