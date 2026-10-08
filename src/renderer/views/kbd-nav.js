'use strict';
/**
 * kbd-nav.js — U18 键盘焦点体系：列表/导航箭头移动公共助手
 *
 * 审计结论（U18）：列表视图（J/K）、命令面板（↑↓）、期刊滑轨、搜索历史均已覆盖；
 * 缺口在「模态侧栏导航」——设置中心与自进化/知识类模态的 nav 项可 Tab/Enter，
 * 但 ↑↓ 不能在分区之间移动焦点。本助手统一补齐，不引入焦点陷阱（到边缘即环绕，
 * Tab 语义不受影响）。
 */

/**
 * 在容器内按 ↑/↓ 移动焦点到相邻（可见）项；支持环绕。
 * @param {Element} container 项的共同父容器
 * @param {KeyboardEvent} event 原生键盘事件（ArrowDown/ArrowUp 时 preventDefault）
 * @param {string} selector 项选择器（如 '.modal-nav-item'）
 * @returns {boolean} 是否消费了该按键
 */
export function focusArrowSiblings(container, event, selector) {
  const key = event?.key;
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return false;
  const items = Array.from(container.querySelectorAll(selector))
    // 可达过滤（审查 P3 补口径）：.hidden 类 / disabled 属性 / 无布局盒（display:none）/
    // visibility:hidden（仍有布局盒，需显式排除）；aria-disabled 语义等同 disabled
    .filter((el) => !el.classList.contains('hidden')
      && !el.hasAttribute('disabled')
      && el.getAttribute('aria-disabled') !== 'true'
      && el.getClientRects().length > 0
      && getComputedStyle(el).visibility !== 'hidden');
  if (!items.length) return false;
  const current = items.indexOf(document.activeElement);
  const delta = key === 'ArrowDown' ? 1 : -1;
  const next = current < 0
    ? (delta > 0 ? 0 : items.length - 1) // 焦点尚不在项上：↓ 到首项 / ↑ 到末项
    : (current + delta + items.length) % items.length;
  items[next].focus();
  if (typeof event.preventDefault === 'function') event.preventDefault();
  return true;
}
