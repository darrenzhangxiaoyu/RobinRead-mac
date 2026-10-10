'use strict';
/**
 * RobinRead（知更）— 深读重访浮层（F37 深读重访）
 *
 * 到期长文回顾卡列表（标题/来源/距上次 N 天）+ 逐卡动作：
 * - AI 重读指引：LLM 依正文与当时的批注输出 3 条指引（卡片流）；
 *   无 Key 降级为「重读全文」按钮（不做降级假装）；
 * - 已读过了（done，终态）/ 稍后再说（skipped，+30 天再浮出）。
 * 温和设计：不倒计时、不红点轰炸——回访由你发起。
 */
import { t, tf } from '../i18n.js';
import { icon } from '../icons.js';
import { staggerEmptyHTML } from './empty-art.js'; // U31 空态二期：插画空态统一壳

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class RevisitView {
  constructor(deps = {}) {
    this.deps = { toast: deps.toast || null, onOpenArticle: deps.onOpenArticle || null };
    this.overlay = null;
  }

  present() {
    if (this.overlay) return;
    const overlay = el('div', 'modal-overlay nj-revisit-overlay');
    const modal = el('div', 'modal nj-revisit-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', t('深读重访'));
    const head = el('div', 'modal-header nj-revisit-head');
    const title = el('h3', null, t('深读重访'));
    head.appendChild(title);
    this.subEl = el('span', 'nj-revisit-sub');
    head.appendChild(this.subEl);
    const close = el('button', 'btn icon-only nj-revisit-close');
    close.type = 'button';
    close.innerHTML = icon('close');
    close.title = t('关闭');
    close.addEventListener('click', () => this.dismiss());
    head.appendChild(close);
    modal.appendChild(head);

    this.bodyEl = el('div', 'nj-revisit-body');
    this.bodyEl.innerHTML = `<div class="nj-revisit-loading">${t('正在翻你的长文书架…')}</div>`;
    modal.appendChild(this.bodyEl);
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) this.dismiss(); });
    document.body.appendChild(overlay);
    this.overlay = overlay;
    window.__robinRevisitView = this; // 探针探测句柄

    this._esc = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      this.dismiss();
    };
    document.addEventListener('keydown', this._esc);
    // revisit:changed（回应后徽章变化）在场即热更列表
    if (!this._subscribed && window.robin.onRevisitChanged) {
      this._subscribed = true;
      window.robin.onRevisitChanged(() => { if (this.overlay) this._load(); });
    }
    this._load();
  }

  dismiss() {
    if (!this.overlay) return;
    document.removeEventListener('keydown', this._esc);
    this.overlay.remove();
    this.overlay = null;
    if (window.__robinRevisitView === this) window.__robinRevisitView = null;
  }

  async _load() {
    if (!this.overlay) return;
    let due = [];
    try {
      due = (await window.robin.revisitDue?.()) || [];
    } catch (_) { /* 拉取失败按空态渲染 */ }
    if (!this.overlay) return;
    if (this.subEl) {
      this.subEl.textContent = due.length > 0 ? tf('%lld 篇长文到了温和重访的时候', due.length) : '';
    }
    this._render(due);
  }

  _render(due) {
    if (!this.bodyEl) return;
    this.bodyEl.innerHTML = '';
    if (!due.length) {
      const empty = el('div', 'nj-revisit-empty list-empty stagger'); // U31 空态二期：插画 + 错峰入场
      empty.innerHTML = staggerEmptyHTML('clock');
      empty.querySelector('h3').textContent = t('现在没有到期的重访');
      empty.querySelector('p').textContent = t('读完的长文会在 30 天后回到这里，温和地提醒你重访它。');
      this.bodyEl.appendChild(empty);
      return;
    }
    for (const item of due) this.bodyEl.appendChild(this._card(item));
  }

  _card(item) {
    const card = el('div', 'nj-revisit-card');
    card.dataset.revisitId = item.id || '';
    card.dataset.entryId = item.entryID || '';

    const main = el('div', 'nj-revisit-card-main');
    const title = el('button', 'nj-revisit-title');
    title.type = 'button';
    title.textContent = item.title || item.entryID;
    title.title = t('打开这篇文章');
    title.addEventListener('click', () => this._open(item));
    main.appendChild(title);
    const meta = el('span', 'nj-revisit-meta');
    meta.textContent = [item.sourceTitle, tf('距上次读完 %lld 天', item.daysSinceRead || 0)].filter(Boolean).join(' · ');
    main.appendChild(meta);
    card.appendChild(main);

    const actions = el('div', 'nj-revisit-actions');
    const guidanceBtn = el('button', 'btn-text bordered nj-revisit-guidance');
    guidanceBtn.type = 'button';
    guidanceBtn.innerHTML = `${icon('spark')}<span></span>`;
    guidanceBtn.querySelector('span').textContent = item.hasGuidance ? t('看重读指引') : t('AI 重读指引');
    guidanceBtn.addEventListener('click', () => this._guidance(card, item, guidanceBtn));
    actions.appendChild(guidanceBtn);

    const doneBtn = el('button', 'btn-text bordered nj-revisit-done');
    doneBtn.type = 'button';
    doneBtn.textContent = t('已读过了');
    doneBtn.addEventListener('click', () => this._respond(item, 'done'));
    actions.appendChild(doneBtn);

    const skipBtn = el('button', 'btn-text bordered nj-revisit-skip');
    skipBtn.type = 'button';
    skipBtn.textContent = t('稍后再说');
    skipBtn.addEventListener('click', () => this._respond(item, 'skipped'));
    actions.appendChild(skipBtn);
    card.appendChild(actions);

    const guidanceHost = el('div', 'nj-revisit-guidance-host');
    card.appendChild(guidanceHost);
    return card;
  }

  _open(item) {
    if (this.deps.onOpenArticle && item.entryID) {
      this.dismiss();
      this.deps.onOpenArticle(item.entryID);
    }
  }

  async _respond(item, action) {
    let envelope = null;
    try {
      envelope = await window.robin.revisitRespond?.(item.id, action); // invoke 信封 {ok, data}
    } catch (_) { envelope = null; }
    if (!envelope || !envelope.ok) return;
    this.deps.toast?.(action === 'done' ? t('记下了：这篇你重访过了') : t('好，30 天后再提醒你'));
  }

  /** AI 重读指引：加载态 → 3 条卡片流 / 降级（重读全文按钮）/ 失败重试。 */
  async _guidance(card, item, btn) {
    const host = card.querySelector('.nj-revisit-guidance-host');
    if (!host) return;
    if (host.dataset.state === 'loading') return;
    host.innerHTML = '';
    host.dataset.state = 'loading';
    btn.disabled = true;
    const loading = el('div', 'nj-revisit-guidance-loading');
    loading.innerHTML = `<span class="nj-revisit-spinner"></span><span></span>`;
    loading.querySelector('span:last-child').textContent = t('正在为今天的你重读这篇长文…');
    host.appendChild(loading);
    let res = null;
    try {
      const envelope = await window.robin.revisitGuidance?.(item.id); // invoke 信封 {ok, data}
      res = envelope && envelope.ok ? envelope.data : { error: String((envelope && envelope.error) || 'failed') };
    } catch (err) {
      res = { error: String((err && err.message) || err) };
    }
    btn.disabled = false;
    if (!this.overlay || !host.isConnected) return;
    host.innerHTML = '';
    host.dataset.state = 'done';
    if (!res || res.error || res.cancelled) {
      const fail = el('div', 'nj-revisit-guidance-fail');
      fail.textContent = res && res.cancelled ? t('已取消。') : t('这次没读成，稍后再试试。');
      host.appendChild(fail);
      return;
    }
    if (res.degraded) {
      // 无 Key 降级：明示 + 「重读全文」按钮（不做降级假装）
      const degraded = el('div', 'nj-revisit-guidance-degraded');
      const note = el('span', null, t('未配置 AI Key，无法生成重读指引。'));
      degraded.appendChild(note);
      const open = el('button', 'btn-text bordered nj-revisit-reread');
      open.type = 'button';
      open.innerHTML = `${icon('bookOpen')}<span></span>`;
      open.querySelector('span').textContent = t('重读全文');
      open.addEventListener('click', () => this._open(item));
      degraded.appendChild(open);
      host.appendChild(degraded);
      return;
    }
    const list = Array.isArray(res.guidance) ? res.guidance : [];
    const wrap = el('div', 'nj-revisit-guidance-list');
    if (res.cached) {
      const cacheTag = el('span', 'nj-revisit-guidance-cache', t('已生成的指引'));
      wrap.appendChild(cacheTag);
    }
    list.forEach((line, i) => {
      const row = el('div', 'nj-revisit-guidance-item');
      row.innerHTML = `<span class="nj-revisit-guidance-no"></span><span class="nj-revisit-guidance-text"></span>`;
      row.querySelector('.nj-revisit-guidance-no').textContent = String(i + 1);
      row.querySelector('.nj-revisit-guidance-text').textContent = line;
      wrap.appendChild(row);
    });
    host.appendChild(wrap);
    if (this.deps.toast && !res.cached) this.deps.toast(t('重读指引已生成'));
  }
}
