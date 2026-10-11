'use strict';
/**
 * RobinRead（知更）— 网页存档馆浮层（F34 网页存档馆）
 *
 * 永久本地快照馆：列表（标题/来源/存档时间/大小）+ 关键词搜索（标题/来源）
 * + 行动作（打开原文 / 导出 MHTML（主进程保存对话框落盘）/ 取消存档）。
 * 头部统计行：存档篇数 + 总体积（全局配额统计）。
 */
import { t, tf } from '../i18n.js';
import { icon } from '../icons.js';
import { formatFullDate } from './list.js';
import { registerEscapeLayer, isTopEscapeLayer, releaseEscapeLayer } from './overlay-stack.js'; // R55 浮层秩序

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

export class ArchiveHallView {
  constructor(deps = {}) {
    this.deps = { toast: deps.toast || null, onOpenArticle: deps.onOpenArticle || null };
    this.overlay = null;
    this.query = '';
    this._searchTimer = null;
  }

  present() {
    if (this.overlay) return;
    const overlay = el('div', 'modal-overlay nj-archive-overlay');
    const modal = el('div', 'modal nj-archive-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', t('网页存档馆'));
    const head = el('div', 'modal-header nj-archive-head');
    const title = el('h3', null, t('网页存档馆'));
    head.appendChild(title);
    const search = el('input', 'nj-archive-search');
    search.type = 'search';
    search.placeholder = t('搜索存档（标题/来源）');
    search.addEventListener('input', () => {
      this.query = search.value || '';
      if (this._searchTimer) clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this._load(), 240);
    });
    head.appendChild(search);
    const close = el('button', 'btn icon-only nj-archive-close');
    close.type = 'button';
    close.innerHTML = icon('close');
    close.title = t('关闭');
    close.addEventListener('click', () => this.dismiss());
    head.appendChild(close);
    modal.appendChild(head);

    this.statsEl = el('div', 'nj-archive-stats');
    modal.appendChild(this.statsEl);
    this.bodyEl = el('div', 'nj-archive-body');
    modal.appendChild(this.bodyEl);
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) this.dismiss(); });
    document.body.appendChild(overlay);
    this.overlay = overlay;
    window.__robinArchiveHall = this; // E2E 探测句柄

    this._esc = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!isTopEscapeLayer(this._escLayer)) return; // R55：顶层先关（一次 Esc 只关一层）
      event.preventDefault();
      this.dismiss();
    };
    document.addEventListener('keydown', this._esc);
    this._escLayer = registerEscapeLayer({ id: 'archive-overlay', isAlive: () => Boolean(this.overlay) }); // R55 浮层栈挂账
    this._load();
  }

  dismiss() {
    if (!this.overlay) return;
    document.removeEventListener('keydown', this._esc);
    releaseEscapeLayer(this._escLayer);
    this._escLayer = null;
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
    this.overlay.remove();
    this.overlay = null;
    if (window.__robinArchiveHall === this) window.__robinArchiveHall = null;
  }

  async _load() {
    if (!this.overlay) return;
    let list = [];
    let stats = { count: 0, bytes: 0 };
    try {
      list = (await window.robin.archiveList({ query: this.query })) || [];
      stats = (await window.robin.archiveStats()) || stats;
    } catch (_) { /* 拉取失败按空态渲染 */ }
    this._renderStats(stats);
    this._render(list);
  }

  _renderStats(stats) {
    if (!this.statsEl) return;
    this.statsEl.textContent = stats.count > 0
      ? tf('存档 %lld 篇 · 共 %@', stats.count, fmtBytes(stats.bytes))
      : '';
  }

  _render(list) {
    if (!this.bodyEl) return;
    this.bodyEl.innerHTML = '';
    if (!list.length) {
      const empty = el('div', 'nj-archive-empty');
      empty.innerHTML = `<span class="nj-archive-empty-icon">${icon('docText')}</span><h3></h3><p></p>`;
      empty.querySelector('h3').textContent = t('还没有任何存档');
      empty.querySelector('p').textContent = t('还没有任何存档。右键文章选「存档此文」，或为追更源开启自动存档。');
      this.bodyEl.appendChild(empty);
      return;
    }
    for (const item of list) this.bodyEl.appendChild(this._row(item));
  }

  _row(item) {
    const row = el('div', 'nj-archive-row');
    row.dataset.entryId = item.entryID || '';
    const main = el('button', 'nj-archive-main');
    main.type = 'button';
    const title = el('span', 'nj-archive-title', item.title || item.entryID);
    const meta = el('span', 'nj-archive-meta');
    meta.textContent = [item.sourceTitle, formatFullDate(item.capturedAt), fmtBytes(item.htmlSize)]
      .filter(Boolean).join(' · ');
    main.append(title, meta);
    main.title = t('打开这篇文章');
    main.addEventListener('click', () => {
      if (this.deps.onOpenArticle && item.entryID) {
        this.dismiss();
        this.deps.onOpenArticle(item.entryID);
      }
    });
    row.appendChild(main);

    const exportBtn = el('button', 'btn-text bordered nj-archive-export');
    exportBtn.type = 'button';
    exportBtn.innerHTML = `${icon('export')}<span></span>`;
    exportBtn.querySelector('span').textContent = t('导出 MHTML');
    exportBtn.addEventListener('click', () => this._export(item));
    row.appendChild(exportBtn);

    const removeBtn = el('button', 'btn-text bordered nj-archive-remove');
    removeBtn.type = 'button';
    removeBtn.innerHTML = `${icon('trash')}<span></span>`;
    removeBtn.querySelector('span').textContent = t('取消存档');
    removeBtn.addEventListener('click', async () => {
      const result = await window.robin.archiveRemove(item.entryID).catch(() => null);
      if (result?.ok) {
        this.deps.toast?.(t('已取消存档'));
        this._load();
      }
    });
    row.appendChild(removeBtn);
    return row;
  }

  async _export(item) {
    try {
      const result = await window.robin.archiveExport(item.entryID);
      if (result?.ok === false) throw new Error(String(result.error || 'failed'));
      if (result?.data) this.deps.toast?.(t('MHTML 已导出')); // data=null=取消保存对话框，不提示
    } catch (err) {
      this.deps.toast?.(String(err.message || err).slice(0, 120));
    }
  }
}
