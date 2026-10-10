'use strict';
/**
 * gesture-layer.js — 触控板/触屏手势层（U24）
 *
 * - 捏合缩放字号：触控板 pinch 在 Chromium 合成为 ctrlKey wheel 事件——
 *   阅读器滚动容器上 accumulate deltaY（阈值归一），跨过阈值步进字号 ±1；
 *   双指普通滚动（无 ctrlKey）不拦截，现有滚动语义保持。
 * - 触屏长按 = 右键：pointerdown(pointerType='touch') 起定时器，超阈值位移/抬手取消，
 *   触发即在原点派发合成 contextmenu（既有 context-menu 管线照常接管）。
 * - 纯函数与绑定分离：探针用合成事件验证处理函数逻辑（真机手势不在 CI 范围）。
 */

/** 捏合累计器：deltaY 累积跨阈值出步（+1 放大 / -1 缩小），防一次手势连跳多档的雪崩由阈值吸收。 */
export function createPinchTracker({ threshold = 90 } = {}) {
  const th = Math.max(10, Number(threshold) || 90);
  let acc = 0;
  return {
    feed(deltaY) {
      acc += Number(deltaY) || 0;
      let steps = 0;
      while (acc <= -th) { steps += 1; acc += th; }
      while (acc >= th) { steps -= 1; acc -= th; }
      return steps;
    },
    reset() { acc = 0; },
    get accumulated() { return acc; },
  };
}

/**
 * 绑定捏合→字号步进。返回 detach。
 * @param {Element} el 事件容器（阅读器滚动容器）
 * @param {{onStep?:(dir:number)=>void, threshold?:number, ignoreSelector?:string}} opts
 */
export function bindPinchFontSize(el, { onStep, threshold = 90, ignoreSelector = '.nj-lightbox, .er-stage, .nj-media-player, .rc-overlay' } = {}) {
  if (!el) return () => {};
  const tracker = createPinchTracker({ threshold });
  const onWheel = (event) => {
    if (!event.ctrlKey && !event.metaKey) return; // 双指滚动语义保持（不拦截不 preventDefault）
    if (ignoreSelector && event.target?.closest?.(ignoreSelector)) return; // 灯箱等自带滚轮缩放的区域让位
    event.preventDefault(); // 接管：挡掉 Chromium 默认整页 zoom，改为字号步进
    const steps = tracker.feed(event.deltaY);
    for (let i = 0; i < Math.abs(steps); i += 1) {
      try { onStep?.(Math.sign(steps)); } catch (_) { /* 步进回调失败不积累 */ }
    }
  };
  el.addEventListener('wheel', onWheel, { passive: false });
  return () => el.removeEventListener('wheel', onWheel);
}

/**
 * 绑定触屏长按 → 合成 contextmenu。返回 detach。
 * @param {EventTarget} root 监听根（window/document.body）
 * @param {{delay?:number, slop?:number, onContext?:(event:MouseEvent)=>void}} opts
 */
export function bindTouchLongPress(root, { delay = 550, slop = 12, onContext } = {}) {
  if (!root) return () => {};
  const ms = Math.max(200, Number(delay) || 550);
  const px = Math.max(4, Number(slop) || 12);
  let timer = null;
  let startX = 0; let startY = 0;
  let pressTarget = null;
  let fired = false;

  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };

  const onDown = (event) => {
    if (event.pointerType !== 'touch' || event.isPrimary === false) return;
    cancel(); // 上一次按压未结算：先掐掉（防计时器堆叠误触发）
    fired = false;
    pressTarget = event.target;
    startX = event.clientX; startY = event.clientY;
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      const ev = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: startX, clientY: startY,
      });
      Object.defineProperty(ev, 'pointerType', { value: 'touch' }); // 既有管线可溯源（合成标记）
      try { pressTarget?.dispatchEvent(ev); } catch (_) { /* 目标已离场 */ }
      onContext?.(ev);
    }, ms);
  };
  const onMove = (event) => {
    if (!timer || event.pointerType !== 'touch') return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > px) cancel(); // 位移超 slop：是滑动不是长按
  };
  const onUp = () => cancel(); // 抬手/打断：未到时长即取消

  // capture：滚动手势开始就要掐表，不依赖目标可冒泡
  root.addEventListener('pointerdown', onDown, true);
  root.addEventListener('pointermove', onMove, true);
  root.addEventListener('pointerup', onUp, true);
  root.addEventListener('pointercancel', onUp, true);
  return () => {
    cancel();
    root.removeEventListener('pointerdown', onDown, true);
    root.removeEventListener('pointermove', onMove, true);
    root.removeEventListener('pointerup', onUp, true);
    root.removeEventListener('pointercancel', onUp, true);
  };
}
