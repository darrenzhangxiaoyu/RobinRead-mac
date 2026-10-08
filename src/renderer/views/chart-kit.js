'use strict';
/**
 * chart-kit.js — U16 图表视觉升级统一绘制套件
 *
 * 知识看板 / 进化引擎图表共用的一层薄绘制契约：
 *  - 色彩全部经 CSS 令牌解析（主题/暗色/纸感四态自动跟随），禁硬编码色值；
 *  - 画布统一走 devicePixelRatio 清晰化（setupCanvas）；
 *  - 入场动画统一由 requestAnimationFrame 单驱动（runChartIntro），
 *    prefers-reduced-motion 时跳过动画直接落到终态（单帧 progress=1）；
 *  - 折线生长 / 柱条升起 / 环形扫入共用同一缓动（easeOutCubic）与进度裁剪。
 *
 * 零业务依赖、零外部资源。
 */

/** 图表入场动画时长（ms）——与 --dur-slow 同量纲的独立常量（rAF 帧驱动不走 CSS 令牌）。 */
export const CHART_INTRO_MS = 520;

/** 通用出缓动（ease-out cubic）：t∈[0,1] → 平滑收敛到 1。 */
export function easeOutCubic(t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0));
  return 1 - Math.pow(1 - x, 3);
}

/** prefers-reduced-motion 生效判定（图表 JS 动画的降级开关）。 */
export function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch (_) { return false; }
}

/**
 * 从宿主元素解析 CSS 令牌颜色（canvas 取不到 CSS 变量，统一在此换算）。
 * @param {Element} host 参照元素（继承 body.dark / 纸感四态类）
 * @param {string} name  令牌名（如 '--accent'）
 * @param {string} fallback 解析失败回退色
 */
export function chartToken(host, name, fallback) {
  try {
    const v = getComputedStyle(host || document.body).getPropertyValue(name);
    return (v || '').trim() || fallback;
  } catch (_) { return fallback; }
}

/**
 * 画布 dpr 清晰化：按 devicePixelRatio 放大物理像素、CSS 尺寸保持逻辑值、ctx 预缩放。
 * 返回已 scale 的 2d ctx；调用方只按逻辑坐标绘制。
 * @returns {CanvasRenderingContext2D}
 */
export function setupCanvas(canvas, width, height) {
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  return ctx;
}

/**
 * 入场动画单驱动：rAF 逐帧回调 progress∈[0,1]（已缓动）。
 * prefers-reduced-motion 时零动画直达终态（单帧 progress=1）。
 * @param {{ duration?: number, onFrame: (p: number) => void, onDone?: () => void }} opts
 * @returns {{ cancel: () => void }} 句柄（视图销毁时可中断）
 */
export function runChartIntro({ duration = CHART_INTRO_MS, onFrame, onDone } = {}) {
  if (typeof onFrame !== 'function') return { cancel: () => {} };
  // reduced-motion：直达终态——只回调一次 progress=1，不启动 rAF 循环
  if (prefersReducedMotion()) {
    onFrame(1);
    onDone?.();
    return { cancel: () => {} };
  }
  const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let raf = 0;
  let done = false;
  const tick = (now) => {
    if (done) return;
    const t = Math.min(1, ((now || Date.now()) - start) / Math.max(1, duration));
    onFrame(easeOutCubic(t));
    if (t >= 1) { done = true; onDone?.(); return; }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return { cancel: () => { done = true; if (raf) cancelAnimationFrame(raf); } };
}

/**
 * 折线生长进度裁剪：按进度截取应绘制的点列（入场时折线自左向右生长）。
 * @param {Array<{x:number,y:number}>} points 完整点列
 * @param {number} progress ∈[0,1]
 * @returns {Array<{x:number,y:number}>} 截取后的点列（含末点插值，保证生长前沿平滑）
 */
export function clipSeriesByProgress(points, progress) {
  const pts = Array.isArray(points) ? points : [];
  const p = Math.min(1, Math.max(0, Number(progress) || 0));
  if (!pts.length || p >= 1) return pts;
  if (p <= 0) return [];
  const cursor = p * (pts.length - 1);
  const whole = Math.floor(cursor);
  const frac = cursor - whole;
  const out = pts.slice(0, whole + 1);
  if (whole + 1 < pts.length && frac > 0) {
    const a = pts[whole];
    const b = pts[whole + 1];
    out.push({ x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac });
  }
  return out;
}

/**
 * 统一折线序列绘制：描边 + 同色低透明填充（面积感）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number}[]} points
 * @param {{ color: string, width?: number, baselineY: number, fillAlpha?: number, close?: boolean }} style
 */
export function strokeSeries(ctx, points, { color, width = 1.8, baselineY, fillAlpha = 0.10 } = {}) {
  if (!ctx || !Array.isArray(points) || points.length < 2) return;
  ctx.save();
  ctx.beginPath();
  points.forEach((pt, i) => { if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y); });
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  if (typeof baselineY === 'number') {
    ctx.lineTo(points[points.length - 1].x, baselineY);
    ctx.lineTo(points[0].x, baselineY);
    ctx.closePath();
    ctx.globalAlpha = fillAlpha;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

/**
 * 统一网格基线：发丝线（1px）+ 令牌色，供折线/柱条图表共用。
 */
export function drawBaseline(ctx, x0, x1, y, color) {
  if (!ctx) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
  ctx.restore();
}

/**
 * 统一环形进度绘制（进度环 / 目标环共用）：底环 + 进度弧扫入。
 * @param {{ progress: number, x: number, y: number, r: number, width: number, track: string, color: string, startAngle?: number }} o
 */
export function drawRing(ctx, { progress, x, y, r, width, track, color, startAngle = -Math.PI / 2 }) {
  if (!ctx) return;
  const p = Math.min(1, Math.max(0, Number(progress) || 0));
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = width;
  ctx.strokeStyle = track;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  if (p > 0) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, startAngle, startAngle + Math.PI * 2 * p);
    ctx.stroke();
  }
  ctx.restore();
}
