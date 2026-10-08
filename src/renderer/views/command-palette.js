'use strict';
/**
 * command-palette.js — 命令面板（方向 22；U17 命令面板 2.0）
 *
 * Ctrl/Cmd+Shift+P 唤起；命令 = { label, keywords?, icon?, hint?, desc?, group?, action }。
 * U17 升级：模糊匹配命中字符高亮（<mark>）、图标行（缺省图标回退）、
 * 预览窗格（右侧：说明 / 快捷键 / 影响范围 / 关键词）。既有命令注册数据结构只扩不破
 * （新增可选 desc；label/keywords/icon/hint/group/action 语义不变）。
 * 子串过滤（标签+关键词，大小写不敏感），↑↓ 选择、Enter 执行、Esc 关闭，鼠标点选可用。
 * 零业务依赖：命令注册表由 app 层注入。
 */
import { icon } from '../icons.js';
import { t } from '../i18n.js';

const RECENT_KEY = 'robinread.palette.recent';
/** 图标缺省回退（U17 图标行：每条命令都有图标，无注册图标时用通用形）。 */
const FALLBACK_ICON = 'general';

/**
 * U17 模糊命中标记：在 label 中定位 query 命中的字符下标（升序）。
 * 匹配策略：① 连续子串（首选，位置即子串区间）；② 子序列（按序散点命中，奖励连续段）。
 * @param {string} query 查询词
 * @param {string} label 命令标签
 * @returns {number[]|null} 命中字符下标数组；未命中返回 null
 */
export function fuzzyMark(query, label) {
  const q = String(query ?? '');
  const text = String(label ?? '');
  if (!q) return null;
  const lowerText = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  // ① 连续子串
  const at = lowerText.indexOf(lowerQ);
  if (at >= 0) return Array.from({ length: q.length }, (_, i) => at + i);
  // ② 子序列（贪心左→右；每字符必须在 query 位置之后出现）
  const positions = [];
  let cursor = 0;
  for (const ch of lowerQ) {
    const found = lowerText.indexOf(ch, cursor);
    if (found < 0) return null;
    positions.push(found);
    cursor = found + 1;
  }
  return positions;
}

export class CommandPalette {
  constructor() {
    this.items = [];
    this.filtered = [];
    this.activeIndex = 0;
    this.overlay = null;
  }

  present(commands) {
    if (this.overlay) this.dismiss();
    this.items = commands || [];
    this.filtered = this.items;
    this.activeIndex = 0;
    try { this.recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (_) { this.recent = []; }

    const overlay = document.createElement('div');
    overlay.className = 'cmd-palette-overlay';
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) this.dismiss(); });

    const palette = document.createElement('div');
    palette.className = 'cmd-palette';
    // U17：主列（输入+列表+脚注）+ 右侧预览窗格
    palette.innerHTML = `
      <div class="cmd-palette-main">
        <input type="text" placeholder="${t('输入命令或搜索…')}" />
        <div class="cmd-palette-list"></div>
        <div class="cmd-palette-foot">
          <span>↑↓ ${t('选择')}</span><span>Enter ${t('执行')}</span><span>Esc ${t('关闭')}</span>
        </div>
      </div>
      <aside class="cmd-preview" aria-live="polite"></aside>`;
    this.input = palette.querySelector('input');
    this.listHost = palette.querySelector('.cmd-palette-list');
    this.previewHost = palette.querySelector('.cmd-preview');

    this.input.addEventListener('input', () => this._filter(this.input.value));
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); this._move(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); this._move(-1); }
      else if (event.key === 'Enter') { event.preventDefault(); this._run(this.filtered[this.activeIndex]); }
      else if (event.key === 'Escape') { event.preventDefault(); this.dismiss(); }
    });
    this._escHandler = (event) => { if (event.key === 'Escape') this.dismiss(); };
    document.addEventListener('keydown', this._escHandler);

    overlay.appendChild(palette);
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this._render();
    this.input.focus();
  }

  /** 列表可视高度取整行数倍（R21）：面板 62vh 截断整行导致末行切半。 */
  _fitListHeight() {
    if (!this.overlay) return;
    const list = this.listHost;
    const items = [...list.querySelectorAll('.cmd-item')];
    if (!items.length) return;
    const rowH = items[0].getBoundingClientRect().height;
    if (!(rowH > 4)) return;
    const headHs = [...list.querySelectorAll('.cmd-group-head')].map((h) => h.getBoundingClientRect().height + 9);
    const avail = Math.max(120, Math.floor(window.innerHeight * 0.62) - list.getBoundingClientRect().top - 34);
    let budget = avail - 12;
    let lastGroup = null;
    let hi = 0;
    let used = 0;
    let rows = 0;
    for (const cmd of this.filtered) {
      const g = cmd.group || null;
      let cost = rowH;
      if (g && g !== lastGroup) { cost += headHs[hi] || 0; hi += 1; }
      lastGroup = g;
      if (rows > 0 && budget - cost < 0) break;
      budget -= cost;
      used += cost;
      rows += 1;
    }
    if (rows > 0) list.style.maxHeight = `${Math.round(used + 12)}px`;
    list.style.overflowY = 'auto';
  }

  dismiss() {
    if (!this.overlay) return;
    document.removeEventListener('keydown', this._escHandler);
    this.overlay.remove();
    this.overlay = null;
    this.previewHost = null;
  }

  _filter(query) {
    this.query = query; // R53：空态出路按钮据此判断「有无搜索词」
    const q = String(query || '').trim().toLowerCase();
    if (!q) {
      // 空查询：最近使用置顶，其余保持注册序
      this.recentSet = new Set(this.recent); // R53：挂实例供 _render 打「最近」徽标
      this.filtered = [...this.items.filter((c) => this.recentSet.has(c.label)), ...this.items.filter((c) => !this.recentSet.has(c.label))];
      this.activeIndex = 0;
      this._render();
      return;
    }
    // 记分：前缀命中(3) > 标签包含(2) > 关键词包含(1) > 组名包含(0.5)；同分保持注册序
    const scored = [];
    this.items.forEach((cmd, order) => {
      const label = cmd.label.toLowerCase();
      const keywords = String(cmd.keywords || '').toLowerCase();
      const group = String(cmd.group || '').toLowerCase();
      let score = 0;
      if (label.startsWith(q)) score = 3;
      else if (label.includes(q)) score = 2;
      else if (keywords.includes(q)) score = 1;
      else if (group && group.includes(q)) score = 0.5;
      // 搜组名意为整组导航（R21 验收附注）：label 顺带含组名的命令降权到组名命中之后，
      // 避免「退出期刊」这类敏感命令在输入「期刊」时被默认聚焦
      if (score === 2 && group && group.includes(q)) score = 0.4;
      if (score > 0) scored.push({ cmd, score, order });
    });
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    this.filtered = scored.map((x) => x.cmd);
    this.activeIndex = 0;
    this._render();
  }

  /** 命令执行后记录最近使用（去重、上限 5）。 */
  _rememberRecent(cmd) {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => x !== cmd.label);
      list.unshift(cmd.label);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5)));
    } catch (_) { /* 隐私模式：放弃 */ }
  }

  _move(delta) {
    if (!this.filtered.length) return;
    const next = (this.activeIndex + delta + this.filtered.length) % this.filtered.length;
    if (next === this.activeIndex) return;
    // R32 零重建：方向键只翻 active 类 + 同步预览窗格，不再整表 innerHTML 重建（千次导航零 DOM churn）
    const items = this.listHost.querySelectorAll('.cmd-item');
    const el = items[next];
    if (!el) { this.activeIndex = next; this._render(); return; }
    items[this.activeIndex]?.classList.remove('active');
    el.classList.add('active');
    this.activeIndex = next;
    el.scrollIntoView({ block: 'nearest' });
    this._renderPreview(this.filtered[next]); // U17：预览随选中项联动（列表本体零重建）
  }

  _run(cmd) {
    if (!cmd) return;
    this._rememberRecent(cmd);
    this.dismiss();
    try { cmd.action?.(); } catch (_) { /* 单条命令失败不破坏面板生命周期 */ }
  }

  /** U17：命中字符高亮——label 按模糊命中下标切片，命中段包 <mark>（HTML 转义安全）。 */
  _labelHTML(cmd) {
    const positions = fuzzyMark(this.query || '', cmd.label);
    if (!positions || !positions.length) return this._escapeHTML(cmd.label);
    const hit = new Set(positions);
    let html = '';
    let markOpen = false;
    for (let i = 0; i < cmd.label.length; i += 1) {
      const ch = this._escapeHTML(cmd.label[i]);
      if (hit.has(i) && !markOpen) { html += '<mark>'; markOpen = true; }
      else if (!hit.has(i) && markOpen) { html += '</mark>'; markOpen = false; }
      html += ch;
    }
    if (markOpen) html += '</mark>';
    return html;
  }

  _escapeHTML(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  /** U17：预览窗格——选中命令的说明 / 快捷键 / 影响范围 / 关键词。 */
  _renderPreview(cmd) {
    if (!this.previewHost) return;
    this.previewHost.innerHTML = '';
    if (!cmd) {
      const none = document.createElement('div');
      none.className = 'cmd-preview-empty';
      none.textContent = t('没有匹配的命令');
      this.previewHost.appendChild(none);
      return;
    }
    const head = document.createElement('div');
    head.className = 'cmd-preview-head';
    const ic = document.createElement('span');
    ic.className = 'cmd-preview-icon';
    ic.innerHTML = icon(cmd.icon || FALLBACK_ICON);
    const title = document.createElement('div');
    title.className = 'cmd-preview-title';
    title.textContent = cmd.label;
    head.append(ic, title);
    this.previewHost.appendChild(head);

    const rows = [];
    if (cmd.group) rows.push([t('影响范围'), cmd.group]);
    if (cmd.hint) rows.push([t('快捷键'), cmd.hint]);
    if (cmd.desc) rows.push([t('说明'), cmd.desc]);
    if (rows.length) {
      const dl = document.createElement('div');
      dl.className = 'cmd-preview-meta';
      for (const [k, v] of rows) {
        const dt = document.createElement('span');
        dt.className = 'cmd-preview-k';
        dt.textContent = k;
        const dd = document.createElement('span');
        dd.className = 'cmd-preview-v';
        dd.textContent = v;
        dl.append(dt, dd);
      }
      this.previewHost.appendChild(dl);
    }
    const keywords = String(cmd.keywords || '').trim();
    if (keywords) {
      const kwLabel = document.createElement('div');
      kwLabel.className = 'cmd-preview-kw-label';
      kwLabel.textContent = t('关键词');
      const chips = document.createElement('div');
      chips.className = 'cmd-preview-kw';
      for (const kw of keywords.split(/\s+/).filter(Boolean).slice(0, 8)) {
        const chip = document.createElement('span');
        chip.className = 'cmd-preview-chip';
        chip.textContent = kw;
        chips.appendChild(chip);
      }
      this.previewHost.append(kwLabel, chips);
    }
  }

  _render() {
    this.listHost.innerHTML = '';
    this.overlay?.querySelector('.cmd-palette')?.classList.add('has-preview');
    if (!this.filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'cmd-empty';
      empty.textContent = t('没有匹配的命令');
      this.listHost.appendChild(empty);
      this._renderPreview(null);
      // R53：空态给一条出路——清空输入回到全量命令（而非让用户自己发现要手动删字）
      if (String(this.query || '').trim()) {
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'cmd-empty-reset';
        reset.textContent = t('清空搜索，显示全部命令');
        reset.addEventListener('click', () => {
          this.query = '';
          if (this.input) this.input.value = ''; // P2-1：实例字段是 this.input（原 this.inputEl 不存在，清空失效）
          this.activeIndex = 0;
          this._filter('');
          this.input?.focus(); // 清空后焦点回输入框，可直接继续键入
        });
        this.listHost.appendChild(reset);
      }
      return;
    }
    // 分组小节头（R21）：相邻同组命令前插入组名行；键盘导航越过组头行
    let lastGroup = null;
    this.filtered.forEach((cmd, index) => {
      const group = cmd.group || null;
      if (group && group !== lastGroup) {
        const head = document.createElement('div');
        head.className = 'cmd-group-head';
        head.textContent = group;
        this.listHost.appendChild(head);
      }
      lastGroup = group;
      const item = document.createElement('div');
      item.className = `cmd-item ${index === this.activeIndex ? 'active' : ''}`;
      item.dataset.index = String(index);
      const iconEl = document.createElement('span');
      iconEl.className = 'cmd-icon';
      // U17 图标行：无注册图标的命令回退通用形，行行有图标
      iconEl.innerHTML = icon(cmd.icon || FALLBACK_ICON);
      const label = document.createElement('span');
      label.className = 'cmd-label';
      label.innerHTML = this._labelHTML(cmd); // U17：模糊命中字符 <mark> 高亮
      item.append(iconEl, label);
      // R53：最近使用过的命令带小徽标（解释它为何排在最前）
      if (this.recentSet?.has(cmd.label)) {
        const tag = document.createElement('span');
        tag.className = 'cmd-recent-tag';
        tag.textContent = t('最近');
        item.appendChild(tag);
      }
      if (cmd.hint) {
        const hint = document.createElement('span');
        hint.className = 'cmd-hint';
        hint.textContent = cmd.hint;
        item.appendChild(hint);
      }
      item.addEventListener('click', () => this._run(cmd));
      item.addEventListener('mousemove', () => {
        if (this.activeIndex !== index) { this.activeIndex = index; this._render(); }
      });
      this.listHost.appendChild(item);
    });
    this._renderPreview(this.filtered[this.activeIndex]); // U17：预览与选中项同步
    // 隐藏窗 rAF 冻结：直接同步取整（首渲染后 listHost 已在 DOM 且有尺寸）
    this._fitListHeight();
  }
}
