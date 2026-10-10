'use strict';
/**
 * shared-transition.js — 共享元素转场（U22）
 *
 * 列表行点击 → 阅读器标题「飞入」：FLIP 手法——
 * 1) First：列表行点击瞬间快照 .entry-title 的视口矩形与文本（setSharedSnapshot）；
 * 2) Last：阅读器渲染出 .robin-header-title 后取其矩形（playTitleTransition）；
 * 3) Invert：幽灵元素钉在旧位，transform 反演到新位（computeFlip 纯函数）；
 * 4) Play：transition（var(--dur-slow)）回到单位变换，结束摘除幽灵。
 * reduced-motion：不建幽灵、直达终态（返回 null）。单向（列表→阅读器）；
 * 退回列表的反向过渡需要列表侧锚点时序配合，本轮不做（任务允许单向）。
 */

const SNAPSHOT_TTL_MS = 4000; // 快照过期：阅读器异步渲染期间兜底，超时不飞（防旧文误飞）

let pendingSnapshot = null;

/**
 * 纯函数：由旧/新两矩形求 FLIP 反演 transform。
 * @returns {{dx:number, dy:number, scale:number}}
 */
export function computeFlip(fromRect, toRect) {
  const from = normRect(fromRect);
  const to = normRect(toRect);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const scale = from.height > 0 ? Math.max(0.05, to.height / from.height) : 1;
  return { dx: Math.round(dx * 100) / 100, dy: Math.round(dy * 100) / 100, scale: Math.round(scale * 1000) / 1000 };
}

/** 快照列表行标题（点击瞬间调用；entryID + 视口矩形 + 文本）。 */
export function snapshotEntryTitle(entryID, titleEl) {
  if (!entryID || !titleEl || !titleEl.isConnected) return null;
  const rect = titleEl.getBoundingClientRect();
  if (!rect || rect.width <= 0) return null;
  return {
    entryID: String(entryID),
    x: rect.left, y: rect.top, width: rect.width, height: rect.height,
    text: String(titleEl.textContent || '').trim().slice(0, 120),
    at: Date.now(),
  };
}

/** 记录快照（列表行点击处调用；同 ID 覆盖，换文自然失效）。 */
export function setSharedSnapshot(snapshot) {
  pendingSnapshot = snapshot && snapshot.entryID ? snapshot : null;
}

/** 取走快照（阅读器渲染处调用；ID 不匹配/过期/缺失 → null，不飞）。 */
export function takeSharedSnapshot(entryID) {
  const snap = pendingSnapshot;
  pendingSnapshot = null;
  if (!snap || !entryID) return null;
  if (snap.entryID !== String(entryID)) return null;
  if (Date.now() - snap.at > SNAPSHOT_TTL_MS) return null;
  return snap;
}

/**
 * 播放列表 → 阅读器标题的飞入过渡。
 * @param {string} entryID 当前阅读器文章 ID
 * @param {Element|null} titleEl 阅读器标题元素（.robin-header-title）
 * @returns {Element|null} 幽灵元素（断言用）；未播放返回 null
 */
export function playTitleTransition(entryID, titleEl) {
  try {
    if (!titleEl || !titleEl.isConnected) return null;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null; // 直达终态
    const snap = takeSharedSnapshot(entryID);
    if (!snap) return null;
    const to = titleEl.getBoundingClientRect();
    if (!to || to.width <= 0) return null;
    const flip = computeFlip(snap, to);
    const ghost = document.createElement('div');
    ghost.className = 'nj-shared-ghost';
    ghost.dataset.role = 'shared-ghost';
    ghost.dataset.entryId = snap.entryID;
    ghost.textContent = snap.text;
    // First：钉在列表行标题旧位；Invert：反演到阅读器标题新位
    ghost.style.left = `${snap.x}px`;
    ghost.style.top = `${snap.y}px`;
    ghost.style.width = `${snap.width}px`;
    ghost.style.height = `${snap.height}px`;
    ghost.style.transform = `translate(${flip.dx}px, ${flip.dy}px) scale(${flip.scale})`;
    document.body.appendChild(ghost);
    // Play：下一帧过渡回单位变换（transition 写在 CSS：transform var(--dur-slow)）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => ghost.classList.add('nj-shared-ghost-play'));
    });
    const cleanup = () => ghost.remove();
    ghost.addEventListener('transitionend', cleanup, { once: true });
    setTimeout(cleanup, 900); // 兜底（transitionend 可能因标签页隐藏不派发）
    return ghost;
  } catch (_) {
    return null; // 转场失败不影响打开文章
  }
}

function normRect(r) {
  return {
    x: Number(r?.x ?? r?.left ?? 0) || 0,
    y: Number(r?.y ?? r?.top ?? 0) || 0,
    width: Number(r?.width ?? 0) || 0,
    height: Number(r?.height ?? 0) || 1,
  };
}
