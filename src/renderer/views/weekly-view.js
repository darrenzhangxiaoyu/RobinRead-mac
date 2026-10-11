'use strict';
/**
 * RobinRead（知更）— 知更周刊浮层（F29 AI 周刊编辑部）
 *
 * 报纸版面：报头（刊名 + 期号 + 日期范围）→ AI 导语 → 主题板块卡 → 金句卡流
 * → 历史期刊列表（期号倒序，失败期可重试）。导出 EPUB 走主进程保存对话框。
 * 生成中可取消（自动/手动同一通路）；无 Key 生成自动落模板版面（template=true
 * 显式标注「模板版」；AI 版面导语区展示，模板版隐去）。
 */
import { t, tf } from '../i18n.js';
import { icon } from '../icons.js';
import { staggerEmptyHTML } from './empty-art.js'; // U31 空态二期：插画空态统一壳
import { registerEscapeLayer, isTopEscapeLayer, releaseEscapeLayer, captureFocusReturn } from './overlay-stack.js'; // R55 浮层秩序

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class WeeklyView {
  constructor(deps = {}) {
    this.deps = { toast: deps.toast || null, onOpenArticle: deps.onOpenArticle || null };
    this.overlay = null;
    this.current = null;   // 当前展示的周刊（shaped）
    this.list = [];
    this.generating = null; // 在途生成的 weekStart
  }

  present() {
    if (this.overlay) return;
    const overlay = el('div', 'modal-overlay nj-weekly-overlay');
    const modal = el('div', 'modal nj-weekly-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', t('知更周刊'));
    const head = el('div', 'modal-header nj-weekly-head');
    const title = el('h3', null, t('知更周刊'));
    head.appendChild(title);
    const genBtn = el('button', 'btn-text bordered nj-weekly-gen');
    genBtn.type = 'button';
    genBtn.innerHTML = `${icon('spark')}<span></span>`;
    genBtn.querySelector('span').textContent = t('生成上周周刊');
    genBtn.addEventListener('click', () => this._generate());
    head.appendChild(genBtn);
    const exportBtn = el('button', 'btn-text bordered nj-weekly-export');
    exportBtn.type = 'button';
    exportBtn.innerHTML = `${icon('export')}<span></span>`;
    exportBtn.querySelector('span').textContent = t('导出 EPUB');
    exportBtn.addEventListener('click', () => this._export());
    exportBtn.disabled = true;
    head.appendChild(exportBtn);
    const close = el('button', 'btn icon-only nj-weekly-close');
    close.type = 'button';
    close.innerHTML = icon('close');
    close.title = t('关闭');
    close.addEventListener('click', () => this.dismiss());
    head.appendChild(close);
    modal.appendChild(head);

    this.bodyEl = el('div', 'nj-weekly-body');
    modal.appendChild(this.bodyEl);
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) this.dismiss(); });
    document.body.appendChild(overlay);
    this.overlay = overlay;
    window.__robinWeeklyView = this; // E2E 探测句柄

    this._esc = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!isTopEscapeLayer(this._escLayer)) return; // R55：顶层先关（一次 Esc 只关一层）
      event.preventDefault();
      this.dismiss();
    };
    document.addEventListener('keydown', this._esc);
    this._escLayer = registerEscapeLayer({ id: 'weekly-overlay', isAlive: () => Boolean(this.overlay) }); // R55 浮层栈挂账
    this._restoreFocus = captureFocusReturn(); // R55：关闭时焦点归还打开者
    this._unsubscribe = window.robin.onWeeklyChanged?.(() => {
      if (this.generating) {
        this.generating = null;
        this._syncButtons();
        this.deps.toast?.(t('本周刊已排好版，来看看吧。'));
      }
      this._load(true);
    });

    this._load();
  }

  dismiss() {
    if (!this.overlay) return;
    document.removeEventListener('keydown', this._esc);
    releaseEscapeLayer(this._escLayer);
    this._escLayer = null;
    if (this._unsubscribe) { try { this._unsubscribe(); } catch (_) { /* 已退订 */ } this._unsubscribe = null; }
    this.overlay.remove();
    this.overlay = null;
    this._restoreFocus?.(); // R55：浮层退场后焦点归还打开者
    this._restoreFocus = null;
    if (window.__robinWeeklyView === this) window.__robinWeeklyView = null;
  }

  async _load(silent = true) {
    try {
      const { weeklies } = (await window.robin.weeklyList()) || {};
      this.list = Array.isArray(weeklies) ? weeklies : [];
      const ready = this.list.find((w) => w.status === 'ready') || this.list[0] || null;
      if (ready) this.current = await window.robin.weeklyGet(ready.id);
      else this.current = null;
      this._render();
    } catch (_) {
      if (!silent) this.deps.toast?.(t('周刊暂时打不开，稍后再试试。'), { tone: 'error' });
      this._render();
    }
  }

  async _generate() {
    if (this.generating) return;
    this.generating = 'pending';
    this._syncButtons();
    this._renderGenerating();
    try {
      const result = await window.robin.weeklyGenerate(null);
      if (!result?.ok) throw new Error(String(result?.error || t('生成失败')));
      this.generating = null;
      this.deps.toast?.(t('本周刊已排好版，来看看吧。'));
      await this._load();
    } catch (err) {
      this.generating = null;
      this._syncButtons();
      this.deps.toast?.(String(err.message || err).slice(0, 120), { tone: 'error' });
      await this._load();
    }
  }

  async _retry(weekStart) {
    if (this.generating) return;
    this.generating = String(weekStart);
    this._syncButtons();
    try {
      const result = await window.robin.weeklyGenerate(weekStart);
      if (!result?.ok) throw new Error(String(result?.error || t('生成失败')));
      this.generating = null;
      await this._load();
    } catch (err) {
      this.generating = null;
      this.deps.toast?.(String(err.message || err).slice(0, 120), { tone: 'error' });
      await this._load();
    }
  }

  async _export() {
    if (!this.current || this.current.status !== 'ready') return;
    try {
      const result = await window.robin.weeklyExport(this.current.id);
      if (result?.ok === false) throw new Error(String(result.error || t('导出失败')));
      if (result?.data) this.deps.toast?.(t('EPUB 已导出')); // data=null=取消保存对话框，不提示（批 E 审查 P2）
    } catch (err) {
      this.deps.toast?.(String(err.message || err).slice(0, 120), { tone: 'error' });
    }
  }

  _cancel() {
    try { window.robin.weeklyCancel(this.current?.weekStart || null); } catch (_) { /* 忽略 */ }
  }

  _syncButtons() {
    if (!this.overlay) return;
    const genBtn = this.overlay.querySelector('.nj-weekly-gen');
    const exportBtn = this.overlay.querySelector('.nj-weekly-export');
    if (genBtn) {
      genBtn.disabled = !!this.generating;
      // R60 动作按钮 loading 态：生成中 inline spinner（.btn-text.spinning 家族）+ 禁用原因 title
      genBtn.classList.toggle('spinning', !!this.generating);
      genBtn.title = this.generating ? t('主编正在排版这一周的阅读，完成后会通知你') : t('把上周阅读编成一期周刊：AI 导语 + 主题归纳 + 金句摘录');
      const label = genBtn.querySelector('span');
      if (label) label.textContent = this.generating ? t('排版中…') : t('生成上周周刊');
    }
    if (exportBtn) exportBtn.disabled = !this.current || this.current.status !== 'ready';
  }

  _renderGenerating() {
    if (!this.bodyEl) return;
    this.bodyEl.innerHTML = `
      <div class="nj-weekly-loading">
        <span class="nj-weekly-loading-icon">${icon('spark')}</span>
        <p></p>
        <button type="button" class="btn-text nj-weekly-cancel"></button>
      </div>`;
    this.bodyEl.querySelector('p').textContent = t('主编正在整理这一周的阅读…');
    const cancel = this.bodyEl.querySelector('.nj-weekly-cancel');
    cancel.textContent = t('取消生成');
    cancel.addEventListener('click', () => this._cancel());
  }

  _render() {
    if (!this.bodyEl) return;
    this._syncButtons();
    this.bodyEl.innerHTML = '';
    if (this.generating) { this._renderGenerating(); return; }
    if (!this.current || this.current.status !== 'ready') {
      const failed = this.list.find((w) => w.status === 'failed');
      this.bodyEl.innerHTML = `
        <div class="nj-weekly-empty list-empty stagger">
          ${staggerEmptyHTML('newspaper')}
          <button type="button" class="btn-text primary nj-weekly-empty-gen"></button>
        </div>`; // U31 空态二期：报刊插画 + 错峰入场
      this.bodyEl.querySelector('h3').textContent = t('还没有周刊');
      this.bodyEl.querySelector('p').textContent = t('每周一自动把上周阅读编成一期：AI 导语 + 主题归纳 + 金句摘录。');
      const gen = this.bodyEl.querySelector('.nj-weekly-empty-gen');
      gen.textContent = t('生成上周周刊');
      gen.addEventListener('click', () => this._generate());
      if (failed) this.bodyEl.appendChild(this._failedRow(failed));
      return;
    }
    this.bodyEl.appendChild(this._masthead(this.current));
    const c = this.current.content || {};
    if (c.intro) {
      const intro = el('div', 'nj-weekly-intro');
      intro.appendChild(el('span', 'nj-weekly-intro-kicker', t('本周导语')));
      intro.appendChild(el('p', null, c.intro));
      this.bodyEl.appendChild(intro);
    } else if (c.template) {
      const tag = el('div', 'nj-weekly-template-tag', t('模板版面（未配置 AI，按标签聚合）'));
      this.bodyEl.appendChild(tag);
    }
    for (const sec of (c.sections || [])) this.bodyEl.appendChild(this._section(sec));
    if ((c.quotes || []).length) this.bodyEl.appendChild(this._quotes(c.quotes));
    const history = this.list.filter((w) => w.id !== this.current.id);
    if (history.length || this.list.some((w) => w.status === 'failed')) {
      this.bodyEl.appendChild(this._history(history));
    }
  }

  /** 报头：刊名 + 期号 + 日期范围（衬线大字 + 双细线，报纸版面走令牌）。 */
  _masthead(weekly) {
    const head = el('div', 'nj-weekly-masthead');
    const name = el('div', 'nj-weekly-name', t('知更周刊'));
    const issue = el('div', 'nj-weekly-issue');
    issue.textContent = weekly.issue ? tf('第 %lld 期', weekly.issue) : t('待排期');
    const range = el('div', 'nj-weekly-range');
    const start = String(weekly.weekStart || '');
    const endDate = new Date((Date.parse(`${start}T00:00:00`) || Date.now()) + 6 * 86400000);
    const endKey = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
    range.textContent = `${start} — ${endKey}`;
    head.append(name, issue, range);
    return head;
  }

  /** 板块卡：板块题 + 编者归纳 + 入选文章行（点击直达阅读）。 */
  _section(sec) {
    const card = el('section', 'nj-weekly-section');
    const title = el('h4', 'nj-weekly-section-title', sec.title || '');
    const summary = el('p', 'nj-weekly-section-summary', sec.summary || '');
    card.append(title, summary);
    for (const entry of (sec.entries || [])) {
      const row = el('button', 'nj-weekly-entry');
      row.type = 'button';
      row.innerHTML = `<span class="nj-weekly-entry-title"></span><span class="nj-weekly-entry-src"></span>`;
      const entryTitle = entry.title || entry.entryID;
      row.querySelector('.nj-weekly-entry-title').textContent = entryTitle;
      // R58 悬停全文（批1审查P1-1 收口）：title 落在真正截断的标题 span 上；
      // 行级 title 保留动作提示（此前行级两连写互相覆盖成死代码）
      row.querySelector('.nj-weekly-entry-title').title = entryTitle;
      row.querySelector('.nj-weekly-entry-src').textContent = entry.sourceTitle || '';
      row.title = t('打开这篇文章');
      row.addEventListener('click', () => {
        if (this.deps.onOpenArticle && entry.entryID) this.deps.onOpenArticle(entry.entryID);
      });
      card.appendChild(row);
    }
    return card;
  }

  /** 金句卡流：逐字摘录 + 出处（衬线引文版式）。 */
  _quotes(quotes) {
    const wrap = el('section', 'nj-weekly-quotes');
    wrap.appendChild(el('h4', 'nj-weekly-section-title', t('金句摘录')));
    for (const q of quotes) {
      const card = el('blockquote', 'nj-weekly-quote');
      const text = el('p', 'nj-weekly-quote-text', `「${q.text}」`);
      const meta = el('cite', 'nj-weekly-quote-src');
      meta.textContent = q.title ? `——《${q.title}》${q.sourceTitle ? ` · ${q.sourceTitle}` : ''}` : '';
      card.append(text, meta);
      if (q.entryID && this.deps.onOpenArticle) {
        card.addEventListener('click', () => this.deps.onOpenArticle(q.entryID));
        card.classList.add('clickable');
      }
      wrap.appendChild(card);
    }
    return wrap;
  }

  _failedRow(weekly) {
    const row = el('div', 'nj-weekly-history-row is-failed');
    const label = el('span', 'nj-weekly-history-week', `${weekly.weekStart} · ${t('生成失败')}`);
    const retry = el('button', 'btn-text nj-weekly-retry', t('重试'));
    retry.type = 'button';
    retry.addEventListener('click', () => this._retry(weekly.weekStart));
    row.append(label, retry);
    return row;
  }

  /** 历史期刊（期号倒序；失败期给重试按钮）。 */
  _history(history) {
    const wrap = el('section', 'nj-weekly-history');
    wrap.appendChild(el('h4', 'nj-weekly-section-title', t('历史期刊')));
    for (const w of history) {
      const row = el('button', 'nj-weekly-history-row');
      row.type = 'button';
      const label = el('span', 'nj-weekly-history-week');
      label.textContent = w.issue ? `${tf('第 %lld 期', w.issue)} · ${w.weekStart}` : `${w.weekStart} · ${t('排版中')}`;
      row.appendChild(label);
      if (w.status === 'failed') {
        row.classList.add('is-failed');
        row.appendChild(el('span', 'nj-weekly-history-state', t('生成失败 · 可重试')));
      }
      row.addEventListener('click', async () => {
        this.current = await window.robin.weeklyGet(w.id);
        this._render();
      });
      wrap.appendChild(row);
    }
    return wrap;
  }
}
