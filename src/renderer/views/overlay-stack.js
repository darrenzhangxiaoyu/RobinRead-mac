'use strict';
/**
 * R55 浮层秩序——全局浮层栈（Esc 逐层裁决 + 模态焦点归还）
 *
 * 裁决模型（一次 Esc 只关一层，顶层先关）：
 *  - 每个浮层在打开时 registerEscapeLayer 入栈、关闭时释放出栈；
 *  - 各浮层自己的 Esc 监听保留在原视图（生命周期不迁移），只在关窗前问一句
 *    isTopEscapeLayer(me)：栈顶还活着且不是自己 → 让位不动；
 *  - 消费了 Esc 的一律 preventDefault——「polite 约定」（event.defaultPrevented 让位）
 *    从此是全库统一口径，右键菜单 → popover → 模态 → 仪式逐层退场。
 *
 * 未挂账的次级浮层（登录窗/新手引导/行内小面板等自洽流）后续批次按需接入；
 * 接入方式：present 里 registerEscapeLayer，dismiss 里 releaseEscapeLayer。
 */

const layers = [];

/**
 * 浮层入栈。`isAlive` 用于跳过已从其它途径关闭的僵尸层（如点击遮罩直接 remove）。
 * 返回层句柄（含 release()，幂等）——同一句柄既用于 isTopEscapeLayer 身份比对，也用于出栈。
 */
export function registerEscapeLayer({ id = 'overlay', isAlive = null } = {}) {
  const entry = { id, isAlive, released: false };
  entry.release = () => {
    if (entry.released) return;
    entry.released = true;
    const i = layers.indexOf(entry);
    if (i >= 0) layers.splice(i, 1);
  };
  layers.push(entry);
  return entry;
}

/** 该层现在是不是栈顶活层（顶层先关：不是就别动）。 */
export function isTopEscapeLayer(entry) {
  if (!entry) return false;
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    let alive = true;
    try { alive = layers[i].isAlive ? layers[i].isAlive() !== false : true; } catch (_) { alive = true; }
    if (alive) return layers[i] === entry;
  }
  return false;
}

/** 兼容语义：释放（dismiss 里调用一次；幂等）。 */
export function releaseEscapeLayer(entry) {
  if (entry && typeof entry.release === 'function') entry.release();
}

/**
 * R55 模态焦点归还：打开时调用记下 activeElement，关闭时调用 restore()。
 * 注意 dismiss 里先 overlay.remove() 再 restore()——模态在场上时焦点仍在浮层内，
 * 移除后焦点自然回落 body，此时才归还（用户已点去别处则不打扰）。
 */
export function captureFocusReturn() {
  const previous = document.activeElement;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (previous instanceof HTMLElement && previous.isConnected
      && (document.activeElement === document.body || document.activeElement == null)) {
      try { previous.focus({ preventScroll: true }); } catch (_) { /* 不可聚焦元素静默 */ }
    }
  };
}
