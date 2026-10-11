'use strict';
/**
 * onboarding.js — U38 首启引导流
 *
 * 新用户首次启动（无订阅源判定）三步引导浮层：
 *   ① 欢迎 + 添加订阅（按钮直达添加订阅对话框）
 *   ② AI 配置（跳设置 → AI 功能分区，可跳过）
 *   ③ 完成（揭示快捷键卡）
 *
 * 记账：localStorage `robinread.onboardingSeen`，看过即不再自动弹；
 * 设置 → 通用「重看新手引导」可随时重开（resetOnboarding + presentOnboarding）。
 * 本模块零业务逻辑：动作全部经 deps 回调注入（onAddFeed / onOpenAI / onDone），
 * 避免 dialogs.js ⇄ onboarding.js 循环导入。
 */
import { t } from '../i18n.js';
import { icon } from '../icons.js';

export const ONBOARDING_SEEN_KEY = 'robinread.onboardingSeen';
export const ONBOARDING_STEP_COUNT = 3;

export function onboardingSeen() {
  try { return localStorage.getItem(ONBOARDING_SEEN_KEY) === '1'; } catch (_) { return false; }
}

export function markOnboardingSeen() {
  try { localStorage.setItem(ONBOARDING_SEEN_KEY, '1'); } catch (_) { /* 隐私模式等：记账失败按未记账处理 */ }
}

export function resetOnboarding() {
  try { localStorage.removeItem(ONBOARDING_SEEN_KEY); } catch (_) { /* 静默 */ }
}

/** 首启判定（纯函数，探针可直测）：从未看过引导且订阅源为空 → 需要引导。 */
export function onboardingShouldRun(feedCount, seen = onboardingSeen()) {
  return !seen && (Number(feedCount) || 0) === 0;
}

/** U38 快捷键卡数据（第③步揭示；与 shortcuts.js 帮助面板口径一致，取最常用六键）。 */
export function onboardingShortcuts() {
  const ctrl = window.navigator.platform.includes('Win') ? 'Ctrl' : '⌘';
  return [
    { keys: ['Space'], label: t('向下阅读') },
    { keys: ['B'], label: t('查看上一篇') },
    { keys: ['N'], label: t('查看下一篇') },
    { keys: ['M'], label: t('切换收藏') },
    { keys: ['F'], label: t('聚焦模式') },
    { keys: [ctrl, '/'], label: t('打开快捷键帮助') },
  ];
}

/**
 * 呈现三步引导浮层。deps:
 *   onAddFeed() — 第①步「添加订阅」直达添加订阅对话框
 *   onOpenAI()  — 第②步「打开 AI 设置」跳设置 → AI 功能
 *   onDone()    — 引导完成/跳过后的收尾回调（可选）
 * 返回 { overlay, goTo, step } 供探针驱动。
 */
export function presentOnboarding(deps = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'nj-onboarding-overlay';
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) finish(); // 点遮罩 = 跳过（同样记账）
  });

  const card = document.createElement('div');
  card.className = 'nj-onboarding-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', t('新手引导'));
  overlay.appendChild(card);

  let step = 1;
  let settled = false;

  const finish = () => {
    if (settled) return;
    settled = true;
    markOnboardingSeen();
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    deps.onDone?.();
  };

  const onKey = (event) => {
    if (event.key === 'Escape') finish();
  };
  document.addEventListener('keydown', onKey);

  const skipBtn = document.createElement('button');
  skipBtn.className = 'nj-onboarding-skip';
  skipBtn.dataset.role = 'onboarding-skip';
  skipBtn.textContent = t('跳过引导');
  skipBtn.addEventListener('click', finish);

  const dots = document.createElement('div');
  dots.className = 'nj-onboarding-dots';
  const dotEls = [];
  for (let i = 0; i < ONBOARDING_STEP_COUNT; i += 1) {
    const dot = document.createElement('span');
    dot.className = 'nj-onboarding-dot';
    dots.appendChild(dot);
    dotEls.push(dot);
  }

  const stage = document.createElement('div');
  stage.className = 'nj-onboarding-stage';

  const footer = document.createElement('div');
  footer.className = 'nj-onboarding-footer';
  const backBtn = document.createElement('button');
  backBtn.className = 'btn-text';
  backBtn.dataset.role = 'onboarding-back';
  backBtn.textContent = t('上一步');
  backBtn.addEventListener('click', () => goTo(step - 1));
  const nextBtn = document.createElement('button');
  nextBtn.className = 'btn-text primary';
  nextBtn.dataset.role = 'onboarding-next';
  nextBtn.addEventListener('click', () => (step >= ONBOARDING_STEP_COUNT ? finish() : goTo(step + 1)));
  footer.append(backBtn, nextBtn);

  const head = document.createElement('div');
  head.className = 'nj-onboarding-head';
  const badge = document.createElement('span');
  badge.className = 'nj-onboarding-badge';
  badge.innerHTML = icon('newspaper');
  const title = document.createElement('h3');
  title.className = 'nj-onboarding-title';
  head.append(badge, title);

  const desc = document.createElement('p');
  desc.className = 'nj-onboarding-desc';
  const actionHost = document.createElement('div');
  actionHost.className = 'nj-onboarding-actions';

  card.append(skipBtn, head, desc, actionHost, dots, footer);

  const shortcutCard = () => {
    const grid = document.createElement('div');
    grid.className = 'nj-onboarding-keys';
    for (const item of onboardingShortcuts()) {
      const row = document.createElement('div');
      row.className = 'nj-onboarding-key-row';
      const keys = document.createElement('span');
      keys.className = 'nj-onboarding-key-chips';
      for (const k of item.keys) {
        const kbd = document.createElement('kbd');
        kbd.textContent = k;
        keys.appendChild(kbd);
      }
      const label = document.createElement('span');
      label.textContent = item.label;
      row.append(keys, label);
      grid.appendChild(row);
    }
    return grid;
  };

  const actionBtn = (label, onClick, primary = false) => {
    const btn = document.createElement('button');
    btn.className = `btn-text${primary ? ' primary' : ' bordered'}`;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  };

  function render() {
    dotEls.forEach((d, i) => d.classList.toggle('active', i < step));
    backBtn.style.visibility = step > 1 ? '' : 'hidden';
    nextBtn.textContent = step >= ONBOARDING_STEP_COUNT ? t('开始使用') : t('下一步');
    actionHost.innerHTML = '';
    card.classList.toggle('step-keys', step >= ONBOARDING_STEP_COUNT);
    // 先收引导再派发动作（批 4 审查 P1 双保险：z-index 已降，浮层在场仍会遮罩变暗模态）
    const go = (fn) => { finish(); fn?.(); };
    if (step === 1) {
      title.textContent = t('欢迎来到知更');
      desc.textContent = t('三步把阅读台搭起来：先添加你的第一个订阅源。');
      actionHost.append(actionBtn(t('添加订阅'), () => go(deps.onAddFeed), true));
    } else if (step === 2) {
      title.textContent = t('配置 AI（可跳过）');
      desc.textContent = t('配上 AI 服务商即可解锁摘要、深读与逐段翻译；不配置也不影响阅读。');
      actionHost.append(actionBtn(t('打开 AI 设置'), () => go(deps.onOpenAI)));
    } else {
      title.textContent = t('一切就绪');
      desc.textContent = t('先记几枚最常用的键——其余随时按 Ctrl+/ 查看。');
      actionHost.appendChild(shortcutCard());
    }
  }

  function goTo(next) {
    const clamped = Math.max(1, Math.min(ONBOARDING_STEP_COUNT, Number(next) || 1));
    step = clamped;
    render();
  }

  document.body.appendChild(overlay);
  render();
  return { overlay, goTo: (n) => goTo(n), get step() { return step; }, finish };
}
