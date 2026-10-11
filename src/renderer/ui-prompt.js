'use strict';
/**
 * RobinRead Windows — 轻量输入/确认对话框
 *
 * Electron 无边框窗口里 window.prompt / window.confirm 默认被禁用，
 * 这里用 DOM 实现等价物，统一替代。
 */
import { t } from './i18n.js';
import { icon } from './icons.js';
import { registerEscapeLayer, isTopEscapeLayer, releaseEscapeLayer } from './views/overlay-stack.js'; /* R55批1审查P1-3：确认/输入框挂账浮层栈，Esc 一次只关最上层 */

function escapeHTML(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function attr(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

function overlayBase(onEscape) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'modal small';
  modal.innerHTML = `
    <div class="modal-main">
      <div class="modal-header"><h3></h3></div>
      <div class="sheet-body"></div>
      <div class="modal-footer"></div>
    </div>`;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  const layer = registerEscapeLayer({ id: 'ui-prompt', isAlive: () => overlay.isConnected });
  // ESC = 取消：必须 resolve，否则 await 调用方永久挂起。
  // polite 口径：defaultPrevented 让位；不是栈顶（如其上还有浮层）也让位——一次 Esc 只关一层。
  const esc = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (!isTopEscapeLayer(layer)) return;
    e.preventDefault();
    close();
    if (onEscape) onEscape();
  };
  document.addEventListener('keydown', esc);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', esc); releaseEscapeLayer(layer); };
  return { overlay, modal, close };
}

/** 提示输入框，返回 Promise<string|null>。 */
export function promptBox(title, { placeholder = '', initial = '', multiline = false } = {}) {
  return new Promise((resolve) => {
    const { overlay, modal, close } = overlayBase(() => resolve(null));
    modal.querySelector('h3').textContent = title;
    const body = modal.querySelector('.sheet-body');
    const field = document.createElement('div');
    field.className = 'sheet-field';
    if (multiline) {
      field.innerHTML = `<textarea class="control wide" rows="3" placeholder="${attr(placeholder)}"></textarea>`;
    } else {
      field.innerHTML = `<input class="control wide" placeholder="${attr(placeholder)}"/>`;
    }
    const input = field.querySelector('input, textarea');
    input.value = initial;
    field.appendChild(input);
    body.appendChild(field);

    const footer = modal.querySelector('.modal-footer');
    const cancel = document.createElement('button');
    cancel.className = 'btn-text';
    cancel.textContent = t('取消');
    const ok = document.createElement('button');
    ok.className = 'btn-text primary';
    ok.textContent = t('确定');
    footer.append(cancel, ok);

    const done = (val) => { close(); resolve(val); };
    cancel.addEventListener('click', () => done(null));
    ok.addEventListener('click', () => done(input.value.trim() || null));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) done(input.value.trim() || null); });
    setTimeout(() => input.focus(), 50);
  });
}

/** 确认框，返回 Promise<boolean>。 */
export function confirmBox(title, { message = '', okLabel = t('确定'), danger = false } = {}) {
  return new Promise((resolve) => {
    const { overlay, modal, close } = overlayBase(() => resolve(false));
    modal.querySelector('h3').textContent = title;
    const body = modal.querySelector('.sheet-body');
    body.innerHTML = `<p class="sheet-hint" style="line-height:1.6;color:var(--text-secondary)">${escapeHTML(message)}</p>`;
    const footer = modal.querySelector('.modal-footer');
    const cancel = document.createElement('button');
    cancel.className = 'btn-text';
    cancel.textContent = t('取消');
    const ok = document.createElement('button');
    ok.className = `btn-text ${danger ? 'danger' : 'primary'}`;
    ok.textContent = okLabel;
    footer.append(cancel, ok);
    const done = (val) => { close(); resolve(val); };
    cancel.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    setTimeout(() => ok.focus(), 50);
  });
}

/** 消息提示框（非阻塞），用于替代 window.alert。 */
export function alertBox(title, message) {
  return new Promise((resolve) => {
    const { overlay, modal, close } = overlayBase(() => resolve());
    modal.querySelector('h3').textContent = title;
    const body = modal.querySelector('.sheet-body');
    body.innerHTML = `<p class="sheet-hint" style="line-height:1.6;color:var(--text-secondary);white-space:pre-wrap">${escapeHTML(message)}</p>`;
    const footer = modal.querySelector('.modal-footer');
    const ok = document.createElement('button');
    ok.className = 'btn-text primary';
    ok.textContent = t('知道了');
    footer.append(ok);
    const done = () => { close(); resolve(); };
    ok.addEventListener('click', done);
    setTimeout(() => ok.focus(), 50);
  });
}
