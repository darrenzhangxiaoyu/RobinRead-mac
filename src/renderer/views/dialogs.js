'use strict';
/**
 * RobinRead（知更）— 设置窗口（9 分区 1:1）与 Sheet 对话框
 *
 * 分区（对应 SettingsSection）：外观 / 通用 / 账号 / AI 功能 / 刷新 / 语言 / 同步 / 反馈 / 关于
 */
import { t, tf } from '../i18n.js';
import { icon } from '../icons.js';
import { FEED_REFRESH_INTERVALS_META } from '../refresh-intervals.js';
import { promptBox, confirmBox, alertBox } from '../ui-prompt.js';
import { TYPOGRAPHY_PRESETS } from '../data/typography-presets.js';
import { syncResultText } from './sync-command.js';
import { bookMetaLine, showCreateBookDialog } from './bookshelf.js';
import { Toast } from './toast.js';

const SECTIONS = [
  { id: 'appearance', title: '外观', icon: 'appearance' },
  { id: 'general', title: '通用', icon: 'general' },
  { id: 'accounts', title: '账号', icon: 'person' },
  { id: 'mail', title: '邮件订阅', icon: 'envelopeClosed' },
  { id: 'ai', title: 'AI 功能', icon: 'ai' },
  { id: 'knowledge', title: '知识', icon: 'bookOpen' },
  { id: 'goals', title: '目标', icon: 'clock' },
  { id: 'refresh', title: '刷新', icon: 'refresh' },
  { id: 'rules', title: '过滤规则', icon: 'funnel' },
  { id: 'language', title: '语言', icon: 'globe' },
  { id: 'sync', title: '同步', icon: 'cloud' },
  { id: 'obsidian', title: 'Obsidian', icon: 'bookOpen' },
  { id: 'bookshelf', title: '书架', icon: 'books' },
  { id: 'feedback', title: '反馈', icon: 'heart' },
  { id: 'about', title: '关于', icon: 'info' },
];

// ── U14 设置中心：分区锚点简介 + 搜索索引 ──────────────────────────────
// 简介一句（新 i18n 键）；搜索索引只收录既有设置项标题键（命中即跳转所在分区，
// 不改任何设置行为）。索引允许随时扩充，t() 未命中的键原样回显不致错。
const SECTION_INTRO = {
  appearance: '主题、字号与阅读排版，纸感由你定义。',
  general: '备份、托盘与系统行为的总开关。',
  accounts: '本地账号、会员与 FreshRSS 接入。',
  mail: '把 newsletter 邮件收进你的订阅流。',
  ai: '精读、翻译与朗读的模型配置。',
  knowledge: '高亮、标签与知识库增强。',
  goals: '每日/每周阅读目标与专注会话。',
  refresh: '自动刷新节奏与全文抓取。',
  rules: '按条件自动处理新文章的规则。',
  language: '界面语言与区域偏好。',
  sync: 'WebDAV 多设备同步与冲突策略。',
  obsidian: '把文章与高亮导出成 Obsidian 知识库。',
  bookshelf: '把文集成书（EPUB）并管理书目。',
  feedback: '喜欢知更的话，这里可以帮到我们。',
  about: '版本、更新与开源致谢。',
};

// 搜索索引：分区 → 代表性设置项标题（全部为既有 i18n 键，只读检索用途）
const SECTION_SEARCH_INDEX = {
  appearance: ['外观模式', '主题设计器', '预设字号', '正文字体', '页面宽度', '行距', '段落风格', '文字对齐', '列表密度', '首字下沉', '中文微排版', '自定义样式', '最低信噪分', '标题自动译中文', '版式预设'],
  general: ['自动备份', '导出备份', '导入备份', '关闭窗口时最小化到托盘', '刷新发现新文章时系统通知', '开机自启'],
  accounts: ['昵称', 'UID', '会员'],
  mail: ['邮箱接入'],
  ai: ['精读人格', '朗读引擎', '神经音色', 'API Key', '翻译目标语言'],
  knowledge: ['AI 自动标签', '运行状态'],
  goals: ['每日篇数', '每周篇数'],
  refresh: ['刷新频率', '打开应用时刷新', '手动刷新'],
  rules: ['过滤规则'],
  language: ['界面语言', '语言选择'],
  sync: ['服务器地址', '用户名', '密码', '测试连接', '自动同步', '立即同步'],
  obsidian: ['导出目录', '导出文章', '导出高亮与批注', '立即导出', '全量重导'],
  bookshelf: ['新建文集'],
  feedback: ['前往官网'],
  about: ['检查更新'],
};

/**
 * U14 设置搜索（纯函数，探针可单测）：返回 [{ id, title, hits: [设置项标题] }]。
 * 分区标题或任一设置项标题命中即收录；query 为空返回 []（即不过滤）。
 */
export function settingsSearch(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const section of SECTIONS) {
    const title = t(section.title);
    const items = (SECTION_SEARCH_INDEX[section.id] || []).map((k) => t(k));
    const hits = items.filter((label) => label.toLowerCase().includes(q));
    if (title.toLowerCase().includes(q) || hits.length) out.push({ id: section.id, title, hits });
  }
  return out;
}

// 产品官网（关于 / 反馈页入口，主进程更新检查源同源）
const WEBSITE_URL = 'https://ronbinread-d9gmsqi2vc0a18f04-1401273698.tcloudbaseapp.com/';

function websiteButton(labelKey, url = WEBSITE_URL) {
  const button = document.createElement('button');
  button.className = 'btn-text bordered';
  button.textContent = t(labelKey);
  button.addEventListener('click', () => window.robin.openLink(url));
  return button;
}

export class SettingsView {
  constructor({ state, views, onAddFreshRSS, onReload, onRefreshState }) {
    this.state = state;
    this.views = views;
    this.handlers = { onAddFreshRSS, onReload, onRefreshState };
    this.section = 'appearance';
  }

  present(section = 'appearance') {
    this.section = SECTIONS.some((s) => s.id === section) ? section : 'appearance';
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) this.dismiss();
    });

    this.modal = document.createElement('div');
    this.modal.className = 'modal';
    overlay.appendChild(this.modal);
    document.body.appendChild(overlay);
    this.overlay = overlay;

    this._esc = (event) => { if (event.key === 'Escape') this.dismiss(); };
    document.addEventListener('keydown', this._esc);
    this.render();
  }

  dismiss() {
    document.removeEventListener('keydown', this._esc);
    this.overlay?.remove();
    this.overlay = null;
  }

  refresh() {
    if (this.overlay) this.render();
  }

  render() {
    if (!this.modal) return;
    this.modal.classList.add('settings-modal'); // U14：设置全屏化
    this.modal.innerHTML = '';

    // ── 左侧：标题 + 顶部搜索（过滤分区/设置项标题）+ 锚点分区导航 ──
    const sidebar = document.createElement('div');
    sidebar.className = 'modal-sidebar settings-nav';
    sidebar.innerHTML = `<h2>${escapeHTML(t('设置'))}</h2>`;

    const searchWrap = document.createElement('div');
    searchWrap.className = 'settings-search';
    searchWrap.innerHTML = `<span class="settings-search-icon">${icon('search')}</span><input type="text" spellcheck="false"/><button type="button" class="settings-search-clear" hidden>${icon('close')}</button>`;
    const searchInput = searchWrap.querySelector('input');
    const searchClear = searchWrap.querySelector('.settings-search-clear');
    searchInput.placeholder = t('搜索设置…');
    searchInput.setAttribute('aria-label', t('搜索设置…'));
    searchInput.addEventListener('input', () => this._applySearch(searchInput.value));
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      this._applySearch('');
      searchInput.focus();
    });
    searchInput.addEventListener('keydown', (e) => { // Esc 先清搜索，再按才关设置（覆盖全局 Esc 关窗）
      if (e.key === 'Escape' && searchInput.value) {
        e.stopPropagation();
        searchInput.value = '';
        this._applySearch('');
      }
    });
    sidebar.appendChild(searchWrap);

    const nav = document.createElement('nav');
    nav.className = 'settings-nav-list';
    this.navItems = new Map();
    for (const section of SECTIONS) {
      const item = document.createElement('div');
      item.className = `modal-nav-item ${section.id === this.section ? 'active' : ''}`;
      item.dataset.section = section.id;
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0'); // R52：设置导航纳入 Tab 序（此前 div 不可达，键盘用户跳不进设置分区）
      item.innerHTML = `<span class="nav-icon">${icon(section.icon)}</span><span class="nav-title"></span><div class="nav-hits" hidden></div>`;
      item.querySelector('.nav-title').textContent = t(section.title);
      item.addEventListener('click', () => {
        this.section = section.id;
        this.render();
      });
      item.addEventListener('keydown', (e) => { // Enter/空格即选中（role=button 语义）
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.section = section.id; this.render(); }
      });
      nav.appendChild(item);
      this.navItems.set(section.id, { item, hitsEl: item.querySelector('.nav-hits') });
    }
    sidebar.appendChild(nav);

    const navEmpty = document.createElement('div');
    navEmpty.className = 'settings-nav-empty';
    navEmpty.hidden = true;
    sidebar.appendChild(navEmpty);
    this.navEmpty = navEmpty;
    this.modal.appendChild(sidebar);

    // ── 右侧：分区头 + 内容（既有设置项功能与 IPC 一条不动）──
    const main = document.createElement('div');
    main.className = 'modal-main';
    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `<h3></h3>`;
    header.querySelector('h3').textContent = t(SECTIONS.find((s) => s.id === this.section).title);
    const close = document.createElement('button');
    close.className = 'btn icon-only';
    close.innerHTML = icon('close');
    close.addEventListener('click', () => this.dismiss());
    header.appendChild(close);
    main.appendChild(header);

    const scroll = document.createElement('div');
    scroll.className = 'modal-scroll';
    main.appendChild(scroll);
    this.modal.appendChild(main);

    // U14 分区卡片化：每分区顶部一块「锚点名片」（图标 + 标题 + 一句简介）
    const meta = SECTIONS.find((s) => s.id === this.section);
    const introCard = document.createElement('div');
    introCard.className = 'settings-section-card';
    introCard.innerHTML = `<span class="settings-section-ic">${icon(meta.icon)}</span><span class="settings-section-copy"><b></b><i></i></span>`;
    introCard.querySelector('b').textContent = t(meta.title);
    introCard.querySelector('i').textContent = t(SECTION_INTRO[this.section] || '');
    scroll.appendChild(introCard);

    const prefs = this.state.snapshot?.preferences || {};
    const llm = this.state.snapshot?.llm || {};
    switch (this.section) {
      case 'appearance': this._appearance(scroll, prefs); break;
      case 'general': this._general(scroll); break;
      case 'accounts': this._accounts(scroll); break;
      case 'mail': this._mail(scroll); break;
      case 'ai': this._ai(scroll, llm); break;
      case 'knowledge': this._knowledge(scroll); break;
      case 'goals': this._goals(scroll); break;
      case 'refresh': this._refresh(scroll, prefs); break;
      case 'rules': this._rules(scroll); break;
      case 'language': this._language(scroll, prefs); break;
      case 'sync': this._sync(scroll); break;
      case 'obsidian': this._obsidian(scroll); break;
      case 'bookshelf': this._bookshelf(scroll); break;
      case 'feedback': this._feedback(scroll); break;
      case 'about': this._about(scroll); break;
      default: break;
    }
  }

  /**
   * U14 搜索应用：导航只留命中分区（含设置项命中子行）；同时把当前分区里
   * 未命中的设置行就地隐藏（.sr-hidden），清空搜索即全部恢复。
   */
  _applySearch(raw) {
    if (!this.modal) return;
    const q = String(raw || '').trim().toLowerCase();
    this.modal.querySelector('.settings-search-clear')?.classList.toggle('on', !!q);
    const clearBtn = this.modal.querySelector('.settings-search-clear');
    if (clearBtn) clearBtn.hidden = !q;
    const hits = settingsSearch(q);
    const byId = new Map(hits.map((h) => [h.id, h]));
    for (const [id, nav] of (this.navItems || new Map())) {
      const { item, hitsEl } = nav;
      if (!q) {
        item.classList.remove('hidden');
        hitsEl.hidden = true;
        hitsEl.innerHTML = '';
        continue;
      }
      const h = byId.get(id);
      item.classList.toggle('hidden', !h);
      hitsEl.hidden = !h || !h.hits.length;
      hitsEl.innerHTML = '';
      for (const label of (h?.hits || []).slice(0, 3)) {
        const chip = document.createElement('span');
        chip.className = 'nav-hit';
        chip.textContent = label;
        hitsEl.appendChild(chip);
      }
    }
    if (this.navEmpty) {
      this.navEmpty.hidden = !(q && !hits.length);
      this.navEmpty.textContent = t('无匹配设置');
    }
    this._filterRows(q);
  }

  /** 当前分区设置行过滤（title/desc 命中保留；组内全隐藏则整组隐藏）。 */
  _filterRows(q) {
    const scroll = this.modal?.querySelector('.modal-scroll');
    if (!scroll) return;
    const rows = scroll.querySelectorAll('.setting-row');
    const groups = scroll.querySelectorAll('.settings-group');
    if (!q) {
      rows.forEach((r) => r.classList.remove('sr-hidden'));
      groups.forEach((g) => g.classList.remove('sr-hidden'));
      return;
    }
    rows.forEach((r) => {
      const title = r.querySelector('.title')?.textContent || '';
      const desc = r.querySelector('.desc')?.textContent || '';
      r.classList.toggle('sr-hidden', !(`${title} ${desc}`.toLowerCase().includes(q)));
    });
    groups.forEach((g) => {
      const visible = [...g.querySelectorAll('.setting-row')].some((r) => !r.classList.contains('sr-hidden'));
      g.classList.toggle('sr-hidden', !visible);
    });
  }

  // MARK: 外观

  async _appearance(container, prefs) {
    container.appendChild(group(t('颜色主题'), t('选择浅色、深色或自动跟随系统的外观风格。'), [
      row(t('外观模式'), null, segmented(
        [['system', t('自动')], ['light', t('浅色')], ['dark', t('深色')]],
        prefs.appTheme || 'system',
        (value) => window.robin.setTheme(value),
      )),
    ]));

    container.appendChild(group(t('阅读辅助'), t('列表与杂志模式下的标题自动翻译（实验功能，需已配置 AI）。'), [
      row(t('标题自动译中文'), null, segmented(
        [['off', t('关闭')], ['on', t('开启')]],
        prefs.titleZh === true ? 'on' : 'off',
        (value) => {
          window.__robinListTitleZh = value === 'on';
          window.robin.setTitleZh(value === 'on');
        },
      )),
    ]));

    // F20：阅读目标迁入独立「目标」分区（每日 + 每周 + 当前进度），外观分区不再重复放置。

    // ── 主题（提案 + 设计器入口，独立分组）──
    const themeGroup = group(t('主题'), t('OKLCH 三通道调色 · 中国传统色 · 配色关系 · 对比度检测'), []);
    container.appendChild(themeGroup);
    const themeHost = themeGroup.querySelector('.group-rows');

    const themeEntry = document.createElement('div');
    themeEntry.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px 16px;';
    const themeIcon = document.createElement('span');
    themeIcon.className = 'setting-icon';
    themeIcon.innerHTML = icon('appearance');
    const themeLabel = document.createElement('div');
    themeLabel.style.flex = '1';
    themeLabel.innerHTML = `<div class="title">${escapeHTML(t('主题设计器'))}</div><div class="desc">${escapeHTML(t('自由调色并实时预览；传统色一键应用'))}</div>`;
    const designerBtn = document.createElement('button');
    designerBtn.className = 'btn-text primary';
    designerBtn.textContent = t('打开设计器…');
    designerBtn.addEventListener('click', () => {
      import('./theme-designer.js').then(({ ThemeDesigner }) => {
        const designer = new ThemeDesigner({
          initialTokens: window.__robinCustomTokens || undefined,
          onApplied: (tokens) => {
            window.__robinCustomTokens = tokens;
            window.dispatchEvent(new CustomEvent('robinread:theme-applied', { detail: tokens }));
          },
          onReset: () => {
            window.__robinCustomTokens = null;
            window.dispatchEvent(new CustomEvent('robinread:theme-reset'));
          },
        });
        designer.present();
      });
    });
    themeEntry.append(themeIcon, themeLabel, designerBtn);
    themeHost.appendChild(themeEntry);

    const proposerHost = document.createElement('div');
    proposerHost.style.cssText = 'border-top:1px solid var(--separator);padding:10px 6px 4px;';
    themeHost.appendChild(proposerHost);
    import('./theme-designer.js').then(({ ThemeProposer }) => {
      const proposer = new ThemeProposer({
        onApply: (tokens, name) => {
          window.__robinCustomTokens = tokens;
          window.dispatchEvent(new CustomEvent('robinread:theme-applied', { detail: tokens, detailName: name }));
        },
        onReset: () => {
          window.__robinCustomTokens = null;
          window.dispatchEvent(new CustomEvent('robinread:theme-reset'));
        },
      });
      proposer.render(proposerHost);
    });

    const presets = row(t('预设字号'), null, (() => {
      const wrap = document.createElement('div');
      wrap.className = 'setting-control';
      for (const [label, size] of [[t('小 (14pt)'), 14], [t('标准 (17pt)'), 17], [t('大 (20pt)'), 20], [t('特大 (23pt)'), 23]]) {
        const button = document.createElement('button');
        button.className = 'btn-text bordered';
        button.textContent = label;
        button.style.color = (prefs.articleFontSize === size) ? 'var(--accent)' : '';
        button.addEventListener('click', async () => {
          await window.robin.setFontSize(size);
          this.handlers.onRefreshState?.();
          this.render();
        });
        wrap.appendChild(button);
      }
      return wrap;
    })());
    container.appendChild(group(t('正文字号'), t('调整文章阅读器中的正文字体大小，支持预设与微调。'), [
      presets,
      row(t('精确调节'), t('范围：13pt ~ 25pt'), (() => {
        const wrap = document.createElement('div');
        wrap.className = 'font-slider setting-control';
        wrap.innerHTML = `<span>${icon('textSmaller')}</span><input type="range" min="13" max="25" step="1"/><span>${icon('textLarger')}</span><span class="pt"></span>`;
        const range = wrap.querySelector('input');
        range.value = prefs.articleFontSize ?? 17;
        wrap.querySelector('.pt').textContent = `${prefs.articleFontSize ?? 17} pt`;
        range.addEventListener('change', async () => {
          await window.robin.setFontSize(Number(range.value));
          wrap.querySelector('.pt').textContent = `${range.value} pt`;
          this.handlers.onRefreshState?.();
        });
        return wrap;
      })()),
    ]));

    // ── 版式主题预设包（方向 3）：刊物级一键排版（单一数据源 typography-presets.js）──
    const presetMap = TYPOGRAPHY_PRESETS;
    const presetGroup = group(t('版式预设'), t('刊物级一键排版：整组参数（字体/行距/页宽/段落/对齐/微排版/首字下沉）即时生效，可再手动微调。'), []);
    container.appendChild(presetGroup);
    const presetHost = presetGroup.querySelector('.group-rows');
    const presetRow = document.createElement('div');
    presetRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;padding:10px 16px;';
    for (const [key, preset] of Object.entries(presetMap)) {
      const btn = document.createElement('button');
      btn.className = 'btn-text bordered';
      btn.textContent = preset.label;
      btn.addEventListener('click', async () => {
        await window.robin.setReaderLayout(preset.patch);
        this.handlers.onRefreshState?.();
        showToast(t('已应用版式预设') + '：' + preset.label);
      });
      presetRow.appendChild(btn);
    }
    presetHost.appendChild(presetRow);

    // ── 阅读排版 ──
    const layout = prefs.readerLayout || { fontFamily: 'serif', pageWidth: 'standard', lineHeight: 'standard', listDensity: 'comfortable' };
    container.appendChild(group(t('阅读排版'), t('字体、页宽、行距与列表密度，即刻生效并跨重启保持。'), [
      row(t('正文字体'), t('霞鹜文楷为内置开源字体（OFL 授权），离线可用，楷体风格适合文艺类长文。'), selectControl(
        [['serif', t('衬线（默认）')], ['sans', t('无衬线')], ['wenkai', t('霞鹜文楷（内置）')]],
        layout.fontFamily || 'serif',
        async (value) => { await window.robin.setReaderLayout({ fontFamily: value }); this.handlers.onRefreshState?.(); },
      )),
      row(t('标题字体'), t('标题、刊头独立选字；得意黑为内置开源斜体黑（OFL 授权），仅适合大标题，不适合正文。'), selectControl(
        [['inherit', t('跟随正文（默认）')], ['smiley', t('得意黑（内置）')]],
        layout.titleFont || 'inherit',
        async (value) => { await window.robin.setReaderLayout({ titleFont: value }); this.handlers.onRefreshState?.(); },
      )),
      row(t('页面宽度'), null, selectControl(
        [['narrow', t('窄')], ['standard', t('标准')], ['wide', t('宽')]],
        layout.pageWidth || 'standard',
        async (value) => { await window.robin.setReaderLayout({ pageWidth: value }); this.handlers.onRefreshState?.(); },
      )),
      row(t('行距'), null, selectControl(
        [['compact', t('紧凑')], ['standard', t('标准')], ['loose', t('宽松')]],
        layout.lineHeight || 'standard',
        async (value) => { await window.robin.setReaderLayout({ lineHeight: value }); this.handlers.onRefreshState?.(); },
      )),
      row(t('段落风格'), t('空行式以段间距分段（西式）；缩进式首行空两格、段间不留空（中文书刊惯例）。'), selectControl(
        [['spacing', t('空行式（默认）')], ['indent', t('缩进式')]],
        layout.paraStyle || 'spacing',
        async (value) => { await window.robin.setReaderLayout({ paraStyle: value }); this.handlers.onRefreshState?.(); },
      )),
      row(t('文字对齐'), t('两端对齐左右边缘齐平，更接近报刊排版；左对齐则行长自然。'), selectControl(
        [['left', t('左对齐（默认）')], ['justify', t('两端对齐')]],
        layout.textAlign || 'left',
        async (value) => { await window.robin.setReaderLayout({ textAlign: value }); this.handlers.onRefreshState?.(); },
      )),
      row(t('字距'), t('在默认字距基础上微调正文字间距；代码块不受影响。'), selectControl(
        [['normal', t('标准')], ['wide', t('微宽')], ['loose', t('疏朗')]],
        layout.letterSpacing || 'normal',
        async (value) => { await window.robin.setReaderLayout({ letterSpacing: value }); this.handlers.onRefreshState?.(); },
      )),
      toggleRow(t('中文微排版'), t('中西文相邻处自动加约 1/4 字宽间隙（盘古之白）并挤压行首行尾标点，符合 W3C 中文排版规范；只改版面不改文字，复制与搜索不受影响。'), layout.microTypography !== 'off', async (v) => {
        await window.robin.setReaderLayout({ microTypography: v ? 'on' : 'off' });
        this.handlers.onRefreshState?.();
      }),
      toggleRow(t('首字下沉'), t('杂志版式：正文首段首字放大并下沉两行，中英文均适用。'), layout.dropCap === 'on', async (v) => {
        await window.robin.setReaderLayout({ dropCap: v ? 'on' : 'off' });
        this.handlers.onRefreshState?.();
      }),
      row(t('列表密度'), t('紧凑模式隐藏摘要，仅显示标题行；宽松模式加大行距与留白。'), selectControl(
        [['compact', t('紧凑')], ['comfortable', t('舒适')], ['relaxed', t('宽松')]],
        layout.listDensity || 'comfortable',
        async (value) => { await window.robin.setReaderLayout({ listDensity: value }); this.handlers.onRefreshState?.(); },
      )),
      toggleRow(t('英文文章自动 AI 精读'), t('默认关闭：打开英文文章不自动翻译，点阅读器「翻译」按钮手动触发；开启后打开英文文章自动翻译。'), layout.autoTranslateEnglish === true, async (v) => {
        await window.robin.setReaderLayout({ autoTranslateEnglish: v });
        this.handlers.onRefreshState?.();
      }),
      row(t('AI 精读默认模式'), t('自动精读开启时使用的显示方式；手动点击翻译按钮也从该模式开始。'), selectControl(
        [['bilingual', t('双语对照')], ['zh', t('仅中文')]],
        layout.translateMode && layout.translateMode !== 'off' ? layout.translateMode : 'bilingual',
        async (value) => { await window.robin.setReaderLayout({ translateMode: value }); this.handlers.onRefreshState?.(); },
      )),
      row(t('对照版式'), t('对照分行将原句独立成块，译文缩进悬挂其下，更接近双语刊物版式；逐句紧跟保持译文贴行显示。'), selectControl(
        [['inline', t('逐句紧跟（默认）')], ['card', t('对照分行（双语刊物式）')]],
        layout.bilingualStyle || 'inline',
        async (value) => { await window.robin.setReaderLayout({ bilingualStyle: value }); this.handlers.onRefreshState?.(); },
      )),
    ]));

    // ── 自定义样式（方向 24）：CSS 注入阅读器窗口 ──
    const cssWrap = document.createElement('div');
    cssWrap.style.cssText = 'padding:12px 16px;display:flex;flex-direction:column;gap:8px;';
    const cssArea = document.createElement('textarea');
    cssArea.className = 'nj-css-input';
    cssArea.rows = 4;
    cssArea.spellcheck = false;
    cssArea.placeholder = t('贴入自定义 CSS，如调整字体、间距、配色…');
    cssArea.value = await window.robin.readerCustomCSS?.() || '';
    let cssTimer = null;
    cssArea.addEventListener('input', () => {
      clearTimeout(cssTimer);
      cssTimer = setTimeout(async () => {
        await window.robin.setReaderLayout({ customCss: cssArea.value });
        document.dispatchEvent(new CustomEvent('robinread:custom-css', { detail: cssArea.value }));
      }, 400);
    });
    cssWrap.appendChild(cssArea);
    container.appendChild(group(t('自定义样式'), t('注入自定义 CSS，实时生效并跨重启保持；供高级用户深度定制字体、间距与配色。'), [cssWrap]));

    // ── 存储与历史记录 ──（保留期限淘汰超期已读；未读/收藏/稍后读永不清理）
    const maintenance = (await window.robin.getMaintenance().catch(() => null)) || { retentionDays: 0 };
    const cleanupButton = document.createElement('button');
    cleanupButton.className = 'nj-settings-button';
    cleanupButton.textContent = t('立即清理');
    cleanupButton.addEventListener('click', async () => {
      cleanupButton.disabled = true;
      cleanupButton.textContent = t('清理中…');
      const p = Toast.progress(t('正在清理历史文章…'), { note: t('按保留期限淘汰超期已读') });
      try {
        const result = await window.robin.cleanupNow();
        const mb = (result.freedBytes || 0) / (1024 * 1024);
        const summary = mb >= 0.1
          ? t(`已清理 ${result.pruned} 篇，释放 ${mb.toFixed(1)} MB`)
          : t(`已清理 ${result.pruned} 篇`);
        p.set(100, t('写入完成'));
        p.done(summary);
        cleanupButton.textContent = summary;
      } catch (_) {
        p.fail(t('清理失败，请重试'));
        cleanupButton.textContent = t('清理失败，请重试');
      }
      setTimeout(() => { cleanupButton.disabled = false; cleanupButton.textContent = t('立即清理'); }, 4000);
    });
    container.appendChild(group(t('存储与历史记录'), t('按保留期限自动淘汰超期的已读文章（以拉取时间计）；未读、收藏与稍后读永远保留，源站刷新也不会把清理过的文章重新灌回。'), [
      row(t('历史文章保留期限'), t('默认永久保留。开启后每次刷新自动清理超期已读。'), selectControl(
        [['0', t('永久保留')], ['180', t('保留 180 天')], ['365', t('保留 1 年')], ['730', t('保留 2 年')]],
        String(maintenance.retentionDays || 0),
        async (value) => {
          const result = await window.robin.setRetentionDays(Number(value));
          if (result && result.pruned > 0) this.handlers.onFeedback?.(t(`已按新期限清理 ${result.pruned} 篇历史文章`));
        },
      )),
      row(t('回收磁盘空间'), t('清理历史文章后立即压缩数据库并归还磁盘空间。'), cleanupButton),
    ]));

    // ── 过滤与降噪 ──（注意路径：filterRules 在 snapshot.preferences 下）
    const rules = this.state.snapshot?.preferences?.filterRules || { minScore: 1, blockKeywords: [], boostKeywords: [], personalization: 2 };
    container.appendChild(group(t('过滤与降噪'), t('信噪评分自动为每篇文章打 1-5 分（标题党扣分、内容充实加分）；低于阈值的内容不再出现在列表。'), [
      row(t('最低信噪分'), t('1 = 不过滤；建议 2-3 降噪。'), selectControl(
        [['1', t('1 · 全部显示')], ['2', t('2 · 轻度降噪')], ['3', t('3 · 推荐')], ['4', t('4 · 只看优质')], ['5', t('5 · 极严')]],
        String(rules.minScore ?? 1),
        async (value) => { await window.robin.setFilterRules({ minScore: Number(value) }); this.handlers.onReload?.(); },
      )),
      inputRow(t('屏蔽词'), t('命中即大幅降分。逗号或换行分隔。'), t('例如：广告, 软文, 震惊'), (rules.blockKeywords || []).join(', '),
        (value) => window.robin.setFilterRules({ blockKeywords: value })),
      inputRow(t('加权词'), t('命中即加分置前。逗号或换行分隔。'), t('例如：LLM, Rust, Simulink'), (rules.boostKeywords || []).join(', '),
        (value) => window.robin.setFilterRules({ boostKeywords: value })),
      row(t('个性化强度'), t('越高，命中你兴趣标签或屏蔽词的文章被过滤得越严格（只影响过滤，不改变排序）。'), selectControl(
        [['0', t('关闭')], ['1', t('轻度')], ['2', t('标准（推荐）')], ['3', t('强')]],
        String(rules.personalization ?? 2),
        async (value) => { await window.robin.setFilterRules({ personalization: Number(value) }); this.handlers.onReload?.(); },
      )),
    ]));

    // 实时预览
    const preview = document.createElement('div');
    preview.className = 'settings-group';
    preview.innerHTML = `<div class="settings-group-header">${escapeHTML(t('实时预览'))}</div>
      <div class="live-preview" style="margin: 8px 16px 14px;">
        <h4 style="font-size:${(prefs.articleFontSize ?? 17) * 1.2}px">${escapeHTML(t('The Morning Digest · 晨间速览'))}</h4>
        <p style="font-size:${prefs.articleFontSize ?? 17}px">${escapeHTML(t('RobinRead 专为沉浸式阅读打造。在保持纸张排版美感的同时，提供舒适的长文阅读体验。字号调整会同步到所有文章。'))}</p>
      </div>`;
    container.appendChild(preview);
  }

  // MARK: 通用（桌面行为 / 备份与恢复 / 存储管理）

  async _general(container) {
    const [general, login] = await Promise.all([
      window.robin.getGeneral().catch(() => null),
      window.robin.loginItem().catch(() => null),
    ]);
    const g = general || { closeToTray: false, newArticleNotify: true };
    const l = login || { supported: false, enabled: false, message: '' };

    // ── 自动备份（数据安全）──
    const backupCfg = await window.robin.backupGetConfig?.().catch(() => null) || { enabled: true, keep: 7, dir: '' };
    const backupGroup = group(t('自动备份'), t('每天首次启动时自动把全部数据（数据库+偏好）快照到本地备份目录，滚动保留最近 N 份。恢复时选择备份文件导入即可。'), []);
    container.appendChild(backupGroup);
    const backupHost = backupGroup.querySelector('.group-rows');
    const saveCfg = (patch) => window.robin.backupSetConfig?.(patch);
    backupHost.appendChild(row(t('每日自动备份'), t('默认开启。备份写入本地 backups 目录，不含 API Key。'), (() => {
      const wrap = document.createElement('div');
      wrap.className = 'setting-control';
      const sel = document.createElement('select');
      sel.className = 'nj-typo-select';
      sel.style.maxWidth = '140px';
      for (const [val, label] of [['0', t('关闭')], ['3', t('保留 3 份')], ['7', t('保留 7 份')], ['14', t('保留 14 份')], ['30', t('保留 30 份')]]) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        sel.appendChild(opt);
      }
      sel.value = String(backupCfg.enabled ? backupCfg.keep : 0);
      sel.addEventListener('change', async () => {
        const v = Number(sel.value);
        await saveCfg({ enabled: v > 0, keep: v > 0 ? v : backupCfg.keep });
        showToast(v > 0 ? t('自动备份已开启') : t('自动备份已关闭'));
      });
      wrap.appendChild(sel);
      return wrap;
    })()));
    backupHost.appendChild(row(t('备份操作'), t('立即创建一份备份，或打开备份文件夹查看/恢复。'), (() => {
      const wrap = document.createElement('div');
      wrap.className = 'setting-control';
      wrap.style.gap = '8px';
      const nowBtn = document.createElement('button');
      nowBtn.className = 'btn-text bordered';
      nowBtn.textContent = t('立即备份');
      nowBtn.addEventListener('click', async () => {
        nowBtn.disabled = true;
        nowBtn.textContent = t('备份中…');
        try {
          const path2 = await window.robin.backupAutoNow?.();
          showToast(path2 ? t('已备份') + '：' + path2 : t('今日已备份'));
        } catch (e) { showToast(t('备份失败') + '：' + String(e?.message || e)); }
        nowBtn.disabled = false;
        nowBtn.textContent = t('立即备份');
      });
      const openBtn = document.createElement('button');
      openBtn.className = 'btn-text bordered';
      openBtn.textContent = t('打开备份文件夹');
      openBtn.addEventListener('click', () => window.robin.backupOpenFolder?.());
      wrap.append(nowBtn, openBtn);
      return wrap;
    })()));

    // ── 桌面行为 ──
    container.appendChild(group(t('桌面行为'), t('窗口与系统通知偏好，仅影响这台设备。'), [
      toggleRow(t('关闭窗口时最小化到托盘'), t('点击关闭按钮时隐藏到系统托盘并在后台保持刷新；从托盘菜单选择「退出」才会真正关闭应用。'), g.closeToTray === true, async (v) => {
        await window.robin.setGeneral({ closeToTray: v });
      }),
      toggleRow(t('刷新发现新文章时系统通知'), t('窗口最小化或隐藏时刷新到新文章会弹系统通知；前台阅读时不打扰。'), g.newArticleNotify !== false, async (v) => {
        await window.robin.setGeneral({ newArticleNotify: v });
      }),
      toggleRow(t('开机自启'), l.supported ? t('登录 Windows 后自动启动 RobinRead。') : t(l.message || '仅打包版（安装版）可用，当前环境不支持。'), l.enabled === true, async (v) => {
        const result = await window.robin.loginItem(v);
        if (result && result.supported === false) {
          await alertBox(t('开机自启'), t(result.message || '仅打包版（安装版）可用，当前环境不支持。'));
        }
        this.render();
      }),
    ]));

    // ── 备份与恢复 ──
    container.appendChild(group(t('备份与恢复'), t('备份为单个 JSON 文件（完整数据库 + 偏好）；导入后需重启应用完成恢复，将覆盖当前全部数据。'), [
      row(t('导出备份'), t('生成包含全部订阅、文章、阅读状态与偏好的单文件快照。'), (() => {
        const button = document.createElement('button');
        button.className = 'btn-text bordered';
        button.textContent = t('导出到文件…');
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const result = await window.robin.backupExport();
            if (result && result.ok) {
              await alertBox(t('导出完成'), t('备份已保存到：') + (result.data?.path || ''));
            } else if (result && !result.ok) {
              await alertBox(t('导出失败'), String(result.error || ''));
            }
          } finally {
            button.disabled = false;
          }
        });
        return button;
      })()),
      row(t('导入备份'), t('选择此前导出的备份文件；恢复在应用重启后生效。'), (() => {
        const button = document.createElement('button');
        button.className = 'btn-text bordered';
        button.textContent = t('从文件恢复…');
        button.addEventListener('click', async () => {
          const ok = await confirmBox(t('导入备份并覆盖当前数据？'), {
            message: t('导入会用备份替换本机的全部订阅、文章与偏好，且无法撤销。建议先导出当前数据作为备份。'),
            okLabel: t('选择备份文件'),
            danger: true,
          });
          if (!ok) return;
          button.disabled = true;
          try {
            const result = await window.robin.backupImport();
            if (result && result.ok) {
              await alertBox(t('恢复已就绪'), t('将重启应用完成恢复。重启后订阅与偏好会被替换为备份内容。'));
              window.robin.quitForRestore();
            } else if (result && !result.ok) {
              await alertBox(t('导入失败'), String(result.error || ''));
            }
          } finally {
            button.disabled = false;
          }
        });
        return button;
      })()),
    ]));

    // ── 存储管理 ──
    const statsGroup = group(t('存储管理'), t('数据保存在本机 %APPDATA%\\RobinRead。「立即清理」只移除孤儿 AI 产物与过期正文缓存，不触碰订阅与文章。'), []);
    container.appendChild(statsGroup);
    const statsHost = statsGroup.querySelector('.group-rows');
    const statsLine = document.createElement('div');
    statsLine.style.cssText = 'padding:12px 16px;font-size:12px;color:var(--text-secondary);line-height:1.9;';
    statsLine.textContent = t('正在统计数据体积…');
    statsHost.appendChild(statsLine);

    const fmtBytes = (value) => {
      const n = Number(value) || 0;
      if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
      if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${n} B`;
    };
    const renderStats = (s) => {
      if (!s) return;
      statsLine.innerHTML = '';
      const lines = [
        `${t('数据库')}：${fmtBytes(s.dbSize)}${s.walSize > 0 ? `（含 WAL ${fmtBytes(s.walSize)}）` : ''}`,
        `${t('正文缓存')}：${s.cachesCount} ${t('篇')} · ${fmtBytes(s.cachesBytes)}`,
        `${t('AI 产物')}：${s.artifactsCount} ${t('条')}`,
        `${t('站点图标')}：${fmtBytes(s.iconsBytes)}`,
      ];
      for (const line of lines) {
        const div = document.createElement('div');
        div.textContent = line;
        statsLine.appendChild(div);
      }
    };
    window.robin.storageStats().then(renderStats);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;padding:2px 16px 14px;';
    const cleanBtn = document.createElement('button');
    cleanBtn.className = 'btn-text bordered';
    cleanBtn.textContent = t('立即清理');
    cleanBtn.addEventListener('click', async () => {
      cleanBtn.disabled = true;
      cleanBtn.textContent = t('正在清理…');
      try {
        renderStats(await window.robin.storageCleanup());
      } finally {
        cleanBtn.disabled = false;
        cleanBtn.textContent = t('立即清理');
      }
    });
    const openBtn = document.createElement('button');
    openBtn.className = 'btn-text bordered';
    openBtn.textContent = t('打开数据目录');
    openBtn.addEventListener('click', () => window.robin.openDataDir());
    actions.append(cleanBtn, openBtn);
    statsHost.appendChild(actions);
  }

  // MARK: 账号

  async _accounts(container) {
    const accounts = this.state.snapshot?.allAccounts || [];

    // RobinRead 账号（登录 + 资料编辑，行式，独立分组）
    const rrGroup = group(t('RobinRead 账号'), '', []);
    container.appendChild(rrGroup);
    await this._renderRobinReadAccount(rrGroup.querySelector('.group-rows'));

    // 当前账号（FreshRSS / 本地）
    const groupEl = group(t('当前账号'), t('RobinRead 支持多账号并行与按需启用。本地订阅与 FreshRSS 远端订阅相互隔离，禁用账号不会删除本地数据或凭据。'), []);
    container.appendChild(groupEl);
    const host = groupEl.querySelector('.group-rows');

    // 同步状态（异步拉取）
    window.robin.getSyncStates().then((result) => {
      if (!result.ok) return;
      for (const el of host.querySelectorAll('.account-sync-line')) {
        const state = result.data[el.dataset.accountId];
        if (!state) continue;
        if (state.lastSyncCompletedAt) {
          el.querySelector('.sync-ok').textContent = tf('上次同步：%@', new Date(state.lastSyncCompletedAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
          el.querySelector('.sync-ok').style.display = '';
        }
        if (state.lastError) {
          el.querySelector('.sync-err').textContent = state.lastError;
          el.querySelector('.sync-err').style.display = '';
        }
      }
    });

    for (const account of accounts) {
      const isLocal = account.type === 'local';
      const card = document.createElement('div');
      card.style.padding = '12px 16px';
      if (!isLocal) card.style.borderTop = '1px solid var(--separator)';
      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;">
          <span class="setting-icon">${icon(isLocal ? 'macDevices' : 'server')}</span>
          <div style="flex:1;min-width:0;">
            <div class="acct-row-title" style="font-size:13.5px;font-weight:600;"></div>
            <div class="acct-row-desc" style="font-size:11.5px;color:var(--text-secondary);"></div>
          </div>
        </div>
      `;
      card.querySelector('.acct-row-title').textContent = isLocal ? t('我的 Mac (本地账号)') : account.displayName;
      card.querySelector('.acct-row-desc').textContent = isLocal ? t('本机独立存储与离线阅读') : `${account.username || ''} @ ${account.endpointURL || ''}`;

      const toggle = toggleControl(account.isEnabled, async (value) => {
        await window.robin.setAccountEnabled(account.id, value);
        this.handlers.onReload?.();
      });
      card.firstElementChild.appendChild(toggle);

      if (!isLocal) {
        const sub = document.createElement('div');
        sub.style.cssText = 'display:flex;align-items:center;gap:8px;padding-left:40px;margin-top:8px;';
        sub.innerHTML = `
          <div class="account-sync-line" data-account-id="${attr(account.id)}" style="flex:1;min-width:0;display:flex;gap:12px;font-size:11px;color:var(--text-secondary);">
            <span class="sync-ok" style="display:none;color:#4e9c51;"></span>
            <span class="sync-err" style="display:none;color:#dd8a1e;"></span>
          </div>`;
        const syncBtn = document.createElement('button');
        syncBtn.className = 'btn-text';
        syncBtn.textContent = t('立即同步');
        syncBtn.disabled = !account.isEnabled;
        syncBtn.addEventListener('click', async () => {
          syncBtn.disabled = true;
          syncBtn.textContent = t('正在同步…');
          await window.robin.syncAccount(account.id);
          syncBtn.textContent = t('立即同步');
          syncBtn.disabled = false;
        });
        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn icon-only';
        removeBtn.innerHTML = icon('trash');
        removeBtn.style.color = '#c93b3b';
        removeBtn.title = t('移除账号');
        removeBtn.addEventListener('click', async () => {
          const ok = await confirmBox(t('确认移除账号？'), { message: t('移除此账号将清除其在 RobinRead 本地同步的数据与凭据，但不会从 FreshRSS 服务器删除或退订您的 Feed。'), okLabel: t('移除'), danger: true });
          if (ok) {
            window.robin.removeAccount(account.id);
            this.handlers.onReload?.();
            this.render();
          }
        });
        sub.append(syncBtn, removeBtn);
        card.appendChild(sub);
      }
      host.appendChild(card);
    }

    const addAction = document.createElement('button');
    addAction.className = 'btn-text primary';
    addAction.style.marginTop = '10px';
    addAction.innerHTML = `${icon('plus')}<span style="margin-left:5px"></span>`;
    addAction.querySelector('span').textContent = t('添加账号…');
    addAction.addEventListener('click', () => this.handlers.onAddFreshRSS?.());
    container.appendChild(plain(actionAddHost(addAction)));
  }

  /** RobinRead 账号：登录 + 资料编辑（头像/昵称/UID/退出登录），行式布局，与设置面板视觉一致。 */
  async _renderRobinReadAccount(host) {
    host.innerHTML = '';
    const { memberStatusLabel } = await import('./account.js');
    const [meR, cfgRaw] = await Promise.all([
      window.robin.accountMe(false).catch(() => null),
      window.robin.accountConfig().catch(() => undefined),
    ]);
    const me = (meR && meR.ok) ? meR.data : { user: null, limits: { feeds: 30, aiPerDay: 3 }, quota: { unlimited: false, used: 0, limit: 3 } };
    const cfg = cfgRaw || { offline: true, wx_login_enabled: false, pay_mock: true, plans: [] };
    const user = me.user;
    const rerender = () => this._renderRobinReadAccount(host);
    const guard = async (fn) => {
      try { await fn(); } catch (err) { await alertBox(t('更新失败'), String(err.error || err.message || err)); }
    };

    if (!user) {
      const { renderAuthForm } = await import('./account.js');
      renderAuthForm(host, { onLogged: () => rerender() });
      return;
    }

    // 头像行（图标位 = 头像，点击或「更换」换图）
    const letter = (String(user.nickname || '?').trim()[0] || '?').toUpperCase();
    const avatar = document.createElement('span');
    avatar.className = 'acct-avatar-sm acct-avatar-clickable';
    avatar.title = t('更换头像');
    avatar.innerHTML = user.avatar_url
      ? `<img src="${attr(user.avatar_url)}" referrerpolicy="no-referrer"/>`
      : escapeHTML(letter);
    avatar.addEventListener('click', () => guard(async () => {
      const dataURL = await window.robin.accountPickAvatar();
      if (!dataURL) return;
      await window.robin.accountUpdateProfile({ avatar_url: dataURL });
      rerender();
    }));
    const avatarCtrl = document.createElement('div');
    avatarCtrl.style.cssText = 'display:flex;align-items:center;gap:8px;';
    avatarCtrl.append(
      linkBtn(t('更换'), () => avatar.click()),
      linkBtn(t('清除'), () => guard(async () => {
        await window.robin.accountUpdateProfile({ avatar_url: '' });
        rerender();
      }), true),
    );
    const avatarRow = row(user.nickname || t('微信用户'), memberStatusLabel(user), avatarCtrl);
    avatarRow.classList.add('with-icon');
    avatarRow.insertBefore(avatar, avatarRow.firstChild);
    host.appendChild(avatarRow);

    // 昵称行
    host.appendChild(row(t('昵称'), user.nickname || t('未设置'), linkBtn(t('修改'), () => guard(async () => {
      const name = await promptBox(t('修改昵称'), { initial: user.nickname || '', placeholder: t('最多 24 个字') });
      if (name == null || name === (user.nickname || '')) return;
      await window.robin.accountUpdateProfile({ nickname: name });
      rerender();
    }))));

    // UID 行
    const copyBtn = linkBtn(t('复制'), async () => {
      await window.robin.copyText(user.uid || '');
      copyBtn.textContent = t('已复制');
      setTimeout(() => { copyBtn.textContent = t('复制'); }, 1200);
    });
    host.appendChild(row(t('UID'), user.uid || '', copyBtn));

    // 会员行
    host.appendChild(row(t('会员'), memberStatusLabel(user), linkBtn(t('会员与套餐'), async () => {
      const { openAccountCenter } = await import('./account.js');
      openAccountCenter();
    })));

    // 退出登录
    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'btn-text danger';
    logoutBtn.textContent = t('退出登录');
    logoutBtn.addEventListener('click', async () => {
      await window.robin.accountLogout();
      rerender();
    });
    host.appendChild(row('', '', logoutBtn));
  }

  // MARK: 邮件订阅（F6 Newsletter：IMAP 账户 + 发件人白名单）

  async _mail(container) {
    const accounts = (await window.robin.mailAccounts().catch(() => [])) || [];

    container.appendChild(group(t('邮箱接入'), t('接入 IMAP 邮箱后，把指定发件人的邮件自动转成订阅文章：每个白名单发件人生成一条订阅源，正文在阅读器内干净呈现。密码经系统加密（DPAPI）只保存在本机，最多 3 个账户。'), (() => {
      const wrap = document.createElement('div');
      wrap.className = 'setting-control';
      const addBtn = document.createElement('button');
      addBtn.className = 'btn-text primary';
      addBtn.innerHTML = `${icon('plus')}<span style="margin-left:5px"></span>`;
      addBtn.querySelector('span').textContent = t('添加邮箱…');
      addBtn.addEventListener('click', () => showAddMailAccount(() => { this.handlers.onRefreshState?.(); this.render(); }));
      wrap.appendChild(addBtn);
      return [wrap]; // group() 逐个迭代 rows——必须回传数组
    })()));

    if (!accounts.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:14px 16px;font-size:12px;color:var(--text-secondary);';
      empty.textContent = t('还没有邮箱账户。常见邮箱（QQ / 163 / Gmail / Outlook）需在邮箱网页设置里开启 IMAP 并使用授权码或应用专用密码。');
      container.appendChild(plain(empty));
      return;
    }

    for (const account of accounts) {
      const card = document.createElement('div');
      card.className = 'settings-group';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 16px;';
      const iconEl = document.createElement('span');
      iconEl.className = 'setting-icon';
      iconEl.innerHTML = icon('envelopeClosed');
      const title = document.createElement('div');
      title.style.flex = '1';
      title.style.minWidth = '0';
      const titleLine = document.createElement('div');
      titleLine.style.cssText = 'font-size:13.5px;font-weight:600;';
      titleLine.textContent = account.username;
      const descLine = document.createElement('div');
      descLine.style.cssText = 'font-size:11.5px;color:var(--text-secondary);';
      const lastSyncText = account.lastSync
        ? tf('上次同步：%@', new Date(account.lastSync * 1000).toLocaleString([], { hour: '2-digit', minute: '2-digit' }))
        : t('尚未同步');
      descLine.textContent = `${account.host}:${account.port} · ${lastSyncText}`;
      title.append(titleLine, descLine);
      head.append(iconEl, title, toggleControl(account.enabled, async (value) => {
        await window.robin.mailSetEnabled(account.id, value);
      }));

      // 测试连接（用已存凭据）
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;align-items:center;gap:8px;padding:0 16px 10px;flex-wrap:wrap;';
      const testBtn = document.createElement('button');
      testBtn.className = 'btn-text bordered';
      testBtn.textContent = t('测试连接');
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true;
        testBtn.textContent = t('正在测试…');
        try {
          const result = await window.robin.mailTest({ accountID: account.id });
          testBtn.textContent = result.ok
            ? tf('连接正常 · 收件箱 %lld 封 · %lldms', result.data?.messageCount ?? 0, result.data?.elapsedMs ?? 0)
            : t('连接失败');
          if (!result.ok) await alertBox(t('连接失败'), String(result.error || ''));
        } catch (err) {
          testBtn.textContent = t('连接失败');
          await alertBox(t('连接失败'), String(err?.message || err));
        }
        setTimeout(() => { testBtn.disabled = false; testBtn.textContent = t('测试连接'); }, 4000);
      });
      const addSenderBtn = document.createElement('button');
      addSenderBtn.className = 'btn-text bordered';
      addSenderBtn.textContent = t('添加发件人…');
      addSenderBtn.addEventListener('click', async () => {
        const value = await promptBox(t('添加发件人'), {
          initial: '',
          placeholder: t('完整地址 name@example.com 或域名后缀 @example.com'),
        });
        if (value == null || !value.trim()) return;
        const result = await window.robin.mailAddSender({ accountID: account.id, sender: value.trim() });
        if (!result.ok) {
          await alertBox(t('添加失败'), String(result.error || ''));
          return;
        }
        this.render();
      });
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn icon-only';
      removeBtn.innerHTML = icon('trash');
      removeBtn.style.color = '#c93b3b';
      removeBtn.title = t('删除邮箱');
      removeBtn.addEventListener('click', async () => {
        const ok = await confirmBox(t('确认删除邮箱账户？'), {
          message: t('将删除该邮箱的所有白名单发件人订阅与已收文章，并清除本机保存的密码。邮箱本身不受影响。'),
          okLabel: t('删除'),
          danger: true,
        });
        if (!ok) return;
        await window.robin.mailDelete(account.id);
        this.handlers.onRefreshState?.();
        this.render();
      });
      actions.append(testBtn, addSenderBtn, removeBtn);

      // 自签名开关（风险明示）
      const selfSignedRow = document.createElement('div');
      selfSignedRow.style.cssText = 'display:flex;align-items:center;gap:10px;padding:0 16px 10px;font-size:12px;';
      const selfSignedToggle = toggleControl(account.allowSelfSigned, async (value) => {
        if (value) {
          const confirmed = await confirmBox(t('允许自签名证书？'), {
            message: t('自签名证书无法验证服务器身份，凭据与邮件内容可能被中间人窃取。仅在信任该服务器（如公司内网）时开启。'),
            okLabel: t('仍然开启'),
            danger: true,
          });
          if (!confirmed) { this.render(); return; }
        }
        await window.robin.mailSetSelfSigned(account.id, value);
        this.render();
      });
      const selfSignedLabel = document.createElement('span');
      selfSignedLabel.style.color = 'var(--text-secondary)';
      selfSignedLabel.textContent = t('允许自签名证书（有安全风险）');
      selfSignedRow.append(selfSignedToggle, selfSignedLabel);

      // 白名单发件人列表（异步填充）
      const senderHost = document.createElement('div');
      senderHost.style.cssText = 'border-top:1px solid var(--separator);';
      const senderHead = document.createElement('div');
      senderHead.style.cssText = 'padding:10px 16px 4px;font-size:12px;font-weight:600;color:var(--text-secondary);';
      senderHead.textContent = t('发件人白名单');
      senderHost.appendChild(senderHead);
      window.robin.mailSenders(account.id).then((senders) => {
        if (!card.isConnected) return;
        const list = Array.isArray(senders) ? senders : [];
        if (!list.length) {
          const empty = document.createElement('div');
          empty.style.cssText = 'padding:6px 16px 12px;font-size:11.5px;color:var(--text-secondary);';
          empty.textContent = t('还没有白名单发件人，点「添加发件人…」把指定发件人的邮件转成订阅。');
          senderHost.appendChild(empty);
          return;
        }
        for (const senderFeed of list) {
          const line = document.createElement('div');
          line.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 16px;font-size:12px;';
          const name = document.createElement('span');
          name.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          name.textContent = String(senderFeed.sender || senderFeed.title || '');
          const count = document.createElement('span');
          count.style.color = 'var(--text-secondary)';
          count.textContent = tf('%lld 篇', Number(senderFeed.entryCount) || 0);
          const del = document.createElement('button');
          del.className = 'btn icon-only';
          del.innerHTML = icon('close');
          del.title = t('移除发件人');
          del.addEventListener('click', async () => {
            const ok = await confirmBox(t('移除发件人？'), {
              message: tf('将移除「%@」订阅及其已收文章。', String(senderFeed.sender || senderFeed.title || '')),
              okLabel: t('移除'),
              danger: true,
            });
            if (!ok) return;
            await window.robin.mailRemoveSender(senderFeed.id);
            this.render();
          });
          line.append(name, count, del);
          senderHost.appendChild(line);
        }
      });

      card.append(head, actions, selfSignedRow, senderHost);
      container.appendChild(card);
    }
  }

  // MARK: 知识（F15 AI 自动标签）

  async _knowledge(container) {
    const snap = (await window.robin.tagsAutoSnapshot?.().catch(() => null)) || { enabled: false };
    const statusEl = staticText('');
    const statusText = () => {
      if (!snap.enabled) return t('已关闭');
      const last = snap.lastRunAt ? timeAgoSecondsAgo(snap.lastRunAt) : t('尚未运行');
      return tf('每小时自动打标 · 上次运行 %@', last);
    };
    container.appendChild(group(
      t('AI 自动标签'),
      t('开启后每小时为最近入库、还没有标签的文章调用 AI 打 1-3 个标签（每批最多 20 篇）。新文章同时会继承订阅源的高频标签（不消耗 AI）。AI 与继承标签进入知识中心「标签」复核视图与图谱，不影响已有标签。'),
      [
        row(t('AI 自动标签'), t('需要已配置 AI 服务商；未配置时静默跳过，不影响其他功能。'), toggleControl(snap.enabled === true, async (next) => {
          const fresh = await window.robin.tagsAutoConfig?.({ enabled: next });
          if (fresh) Object.assign(snap, fresh);
          statusEl.textContent = statusText();
        })),
        row(t('运行状态'), null, (() => {
          const wrap = document.createElement('div');
          wrap.className = 'setting-control';
          wrap.style.flexDirection = 'column';
          wrap.style.alignItems = 'flex-end';
          wrap.style.gap = '6px';
          statusEl.textContent = statusText();
          const kick = document.createElement('button');
          kick.className = 'btn-text bordered';
          kick.textContent = t('立即打标一批');
          kick.addEventListener('click', async () => {
            if (kick.disabled) return;
            kick.disabled = true;
            kick.textContent = t('打标中…');
            try {
              const result = await window.robin.tagsAutoKick?.();
              if (result && result.skipped) {
                kick.textContent = { noKey: t('未配置 AI，已跳过'), disabled: t('请先开启开关'), throttled: t('刚运行过，已跳过') }[result.reason] || t('已跳过');
              } else {
                kick.textContent = tf('已处理 %lld 篇', (result && result.taggedEntries) || 0);
                const fresh = await window.robin.tagsAutoSnapshot?.();
                if (fresh) Object.assign(snap, fresh);
                statusEl.textContent = statusText();
              }
            } catch (_) { kick.textContent = t('打标失败'); }
            setTimeout(() => { kick.textContent = t('立即打标一批'); kick.disabled = false; }, 2400);
          });
          wrap.append(statusEl, kick);
          return wrap;
        })()),
      ],
    ));
  }

  // MARK: 目标（F20：每日/每周篇数 + 当前进度）

  async _goals(container) {
    const prefs = this.state.snapshot?.preferences || {};
    const numOf = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
    const notePrefs = (key, value) => {
      if (this.state.snapshot?.preferences) this.state.snapshot.preferences[key] = value;
      this.handlers.onRefreshState?.();
    };
    container.appendChild(group(
      t('阅读目标'),
      t('达到每日目标时恭喜一次（每天最多一次）；设为「关」时进度环随之隐藏。'),
      [
        row(t('每日篇数'), t('今天想读完的文章数（关 = 不设目标）'), segmented(
          [[0, t('关')], [3, '3'], [5, '5'], [8, '8'], [12, '12'], [20, '20']],
          numOf(prefs.dailyGoal, 5),
          async (value) => {
            await window.robin.statsSetGoal(Number(value));
            notePrefs('dailyGoal', Number(value));
            await refreshProgress();
          },
        )),
        row(t('每周篇数'), t('本周（含今天共 7 天）想读完的文章数（关 = 不设目标）'), segmented(
          [[0, t('关')], [7, '7'], [15, '15'], [25, '25'], [35, '35']],
          numOf(prefs.weeklyGoal, 0),
          async (value) => {
            await window.robin.setWeeklyGoal(Number(value));
            notePrefs('weeklyGoal', Number(value));
            await refreshProgress();
          },
        )),
      ],
    ));

    // 当前进度（goal:progress 聚合：reading_stats 按日，周 = 近 7 天求和）
    const progressCard = document.createElement('div');
    progressCard.className = 'settings-group';
    progressCard.innerHTML = '<div class="settings-group-header"></div><div class="group-rows"></div>';
    progressCard.querySelector('.settings-group-header').textContent = t('当前进度');
    container.appendChild(progressCard);
    const refreshProgress = async () => {
      const host = progressCard.querySelector('.group-rows');
      let p = null;
      try { p = await window.robin.goalProgress(); } catch (_) { p = null; }
      host.innerHTML = '';
      if (!p) return;
      const line = (label, s) => {
        const r = document.createElement('div');
        r.className = 'setting-row nj-goal-line';
        r.dataset.role = 'goal-line';
        r.dataset.kind = label === t('今日') ? 'daily' : 'weekly';
        r.innerHTML = `<div class="setting-label"><div class="title"></div></div>`
          + `<div class="setting-control nj-goal-meter"><span class="nj-goal-bar"><i></i></span><span class="nj-goal-num"></span></div>`;
        r.querySelector('.title').textContent = label;
        r.querySelector('.nj-goal-bar i').style.width = `${Math.round((s.pct || 0) * 100)}%`;
        const num = r.querySelector('.nj-goal-num');
        num.textContent = s.enabled ? `${s.read}/${s.goal}` : t('关');
        num.classList.toggle('done', s.done === true);
        return r;
      };
      host.appendChild(line(t('今日'), p.daily || {}));
      host.appendChild(line(t('本周'), p.weekly || {}));
    };
    await refreshProgress();
  }

  // MARK: AI 功能

  async _ai(container, llm) {
    const hasKey = this.state.snapshot?.hasAPIKey;
    // LLM 开关/输入统一：保存后刷新快照，切 section 再回来状态不丢
    const setLLMField = (patch) => async (value) => {
      await window.robin.setLLM({ [patch]: value });
      this.handlers.onRefreshState?.();
      this.state.snapshot.llm = { ...(this.state.snapshot.llm || {}), [patch]: value };
    };

    // ── AI 精读风格（人格预设）：多种可选 + 自定义提示词 ──
    container.appendChild(await (async () => {
      const personas = (await window.robin.aiPersonas?.().catch(() => [])) || [];
      const saved = (await window.robin.aiPersona?.().catch(() => null)) || { id: 'scholar', custom: '' };
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:flex-end;min-width:220px;';
      const customBox = document.createElement('textarea');
      customBox.className = 'nj-css-input';
      customBox.style.cssText = 'width:280px;height:88px;font-size:12px;resize:vertical;';
      customBox.placeholder = t('输入你的精读提示词，例如：用经济学人风格输出，并附三条反方观点…');
      customBox.value = saved.custom || '';
      const persist = () => { window.robin.aiSetPersona?.({ id: select.value, custom: customBox.value.trim() }); };
      const select = selectControl(
        (personas.length ? personas : [{ id: 'scholar', label: t('严谨学者（默认）') }]).map((p) => [p.id, t(p.label)]),
        saved.id || 'scholar',
        () => {
          customBox.style.display = select.value === 'custom' ? '' : 'none';
          persist();
        },
      );
      select.style.minWidth = '190px';
      customBox.addEventListener('change', persist);
      customBox.style.display = saved.id === 'custom' ? '' : 'none';
      wrap.appendChild(select);
      wrap.appendChild(customBox);
      return group(t('AI 精读风格'), t('同一篇文章按不同视角产出精读笔记：学者=结构化笔记、讲述者=故事化、评论员=批判审视、外行版=通俗类比、教练=行动清单、自定义=你的提示词。切换后重新点「一键精读」即按新风格重写。'), [
        row(t('精读人格'), null, wrap),
      ]);
    })());

    // ── 朗读引擎（方向 18）：神经语音 / 本地语音 / 自定义 TTS ──
    const ttsCfg = (await window.robin.ttsGetConfig?.().catch(() => null)) || { engine: 'edge' };
    const neuralVoices = (await window.robin.ttsNeuralVoices?.().catch(() => null)) || [];
    const saveTTS = (patch) => async (value) => {
      await window.robin.ttsSetConfig?.({ [patch]: value });
      document.dispatchEvent(new CustomEvent('robinread:tts-config'));
    };
    container.appendChild(group(t('朗读引擎'), t('「听文章」使用的高品质语音。神经语音免费需联网；自定义服务支持情感模型与音色克隆。'), [
      row(t('朗读引擎'), t('神经语音：微软 Neural 音色（晓晓/云希等），自然接近真人，需联网；本地语音：系统离线语音；自定义 TTS：任何 OpenAI 兼容 /v1/audio/speech 服务或局域网语音服务（如 CosyVoice）。'), selectControl(
        [['edge', t('神经语音（推荐，需联网）')], ['local', t('本地语音（离线）')], ['custom', t('自定义 TTS 服务')]],
        ttsCfg.engine || 'edge',
        saveTTS('engine'),
      )),
      row(t('神经音色'), t('晓晓温暖自然、云希阳光、云健磁性、云扬新闻腔；自定义引擎时此音色作 voice 参数。'), (() => {
        const wrap = document.createElement('div');
        wrap.className = 'setting-control';
        const voiceSelect = selectControl(
          neuralVoices.map((v) => [v.id, v.label || v.id]),
          ttsCfg.neuralVoice || 'zh-CN-XiaoxiaoNeural',
          saveTTS('neuralVoice'),
        );
        const previewBtn = document.createElement('button');
        previewBtn.className = 'btn-text bordered';
        previewBtn.textContent = t('试听');
        previewBtn.addEventListener('click', async () => {
          if (previewBtn.disabled) return;
          previewBtn.disabled = true;
          previewBtn.textContent = t('试听中…');
          try {
            const base64 = await window.robin.ttsSynthesize({
              engine: 'edge',
              voice: voiceSelect.value,
              rate: 1,
              text: '你好，我是知更神经语音，很高兴为你朗读今天的文章。',
            });
            if (base64) {
              const audio = new Audio(`data:audio/mpeg;base64,${base64}`);
              audio.onended = () => { previewBtn.textContent = t('试听'); previewBtn.disabled = false; };
              await audio.play();
              return;
            }
            throw new Error('empty');
          } catch (_) {
            previewBtn.textContent = t('试听失败');
            setTimeout(() => { previewBtn.textContent = t('试听'); previewBtn.disabled = false; }, 1800);
          }
        });
        wrap.append(voiceSelect, previewBtn);
        return wrap;
      })()),
      row(t('自定义端点'), t('例如 https://api.openai.com/v1/audio/speech，或局域网语音服务地址（如 CosyVoice / GPT-SoVITS）。'), (() => {
        const wrap = document.createElement('div');
        wrap.className = 'setting-control';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'nj-css-input';
        input.style.minHeight = '32px';
        input.value = ttsCfg.customEndpoint || '';
        input.placeholder = 'https://…/v1/audio/speech';
        input.addEventListener('change', () => saveTTS('customEndpoint')(input.value.trim()));
        wrap.appendChild(input);
        return wrap;
      })()),
      row(t('模型与音色'), t('model 与 voice 参数（OpenAI 兼容格式），如 tts-1 / alloy；留空用服务端默认。'), (() => {
        const wrap = document.createElement('div');
        wrap.className = 'setting-control';
        wrap.style.gap = '8px';
        const model = document.createElement('input');
        model.type = 'text';
        model.className = 'nj-css-input';
        model.style.minHeight = '32px';
        model.value = ttsCfg.customModel || '';
        model.placeholder = 'model';
        model.addEventListener('change', () => saveTTS('customModel')(model.value.trim()));
        const voice = document.createElement('input');
        voice.type = 'text';
        voice.className = 'nj-css-input';
        voice.style.minHeight = '32px';
        voice.value = ttsCfg.customVoice || '';
        voice.placeholder = 'voice';
        voice.addEventListener('change', () => saveTTS('customVoice')(voice.value.trim()));
        wrap.append(model, voice);
        return wrap;
      })()),
      row(t('API Key'), t('自定义服务的鉴权密钥（Bearer），不出本机；本地服务可留空。'), (() => {
        const wrap = document.createElement('div');
        wrap.className = 'setting-control';
        const input = document.createElement('input');
        input.type = 'password';
        input.className = 'nj-css-input';
        input.style.minHeight = '32px';
        input.value = '';
        input.placeholder = ttsCfg.hasCustomKey ? '已保存，输入新值可覆盖' : 'sk-…';
        input.addEventListener('change', () => saveTTS('customApiKey')(input.value.trim()));
        wrap.appendChild(input);
        return wrap;
      })()),
    ]));

    // ── 服务商与连接（多服务商管理）──
    const provGroup = group(t('服务商与连接'), t('可添加多个服务商并一键切换；API Key 只保存在这台设备。切换服务商后请填写对应的 API Key。'), []);
    container.appendChild(provGroup);
    const provHost = provGroup.querySelector('.group-rows');
    this._renderProviders(provHost, llm, hasKey);

    container.appendChild(group(t('阅读助手：摘要'),
      llm.automaticallyGenerateSummary ? t('首次打开尚无摘要的文章时自动生成；已有缓存不会重复请求。') : t('保持手动模式，只在你点击“生成摘要”后请求模型。'), [
      toggleRow(t('展示 AI 摘要模块'), t('关闭后，文章阅读页不显示摘要模块；已生成的摘要不会被删除。'), llm.showsAISummary !== false, setLLMField('showsAISummary')),
      toggleRow(t('打开文章时自动生成 AI 摘要'), t('开启后，打开没有缓存摘要的文章会自动发送正文到模型。'), Boolean(llm.automaticallyGenerateSummary), setLLMField('automaticallyGenerateSummary')),
    ]));

    container.appendChild(group(t('阅读助手：翻译与划词'), t('逐段翻译只处理当前屏幕视口内容；划词功能触发后以浮窗形式呈现。'), [
      inputRow(t('翻译目标语言'), t('你可以自由填入你想翻译成的语言，例如中文、英语、法语等。'), '简体中文', llm.targetLanguage, setLLMField('targetLanguage')),
      toggleRow(t('划词解释按钮'), t('开启后，划词选择文本时展示“直接解释”按钮'), llm.showsSelectionExplanation !== false, setLLMField('showsSelectionExplanation')),
      toggleRow(t('划词提问按钮'), t('开启后，划词选择文本时展示“向 AI 提问”按钮'), llm.showsSelectionAsk !== false, setLLMField('showsSelectionAsk')),
      toggleRow(t('划词翻译按钮'), t('开启后，划词选择文本时展示“翻译”按钮'), llm.showsSelectionTranslation !== false, setLLMField('showsSelectionTranslation')),
    ]));

    container.appendChild(group(t('个性化 Prompt'), t('自定义指令会附加在系统默认 Prompt 之后（例如：“请用通俗易懂的口语解释”或“侧重分析工程实现细节”）。'), [
      textAreaRow(llm.customPrompt || '', setLLMField('customPrompt')),
    ]));

    container.appendChild(group(t('生成偏好（高级）'), t('DeepSeek 会按此选项发送 thinking；选择低、中、高时也会发送对应的 reasoning_effort。'), [
      row(t('推理偏好'), t('仅在服务商明确支持时生效；翻译和划词解释会自动关闭推理。'), selectControl(
        // value 保持中文原值（主进程 LLMService 按中文字面量分支），仅显示文案走 i18n
        [['自动', t('自动')], ['关闭', t('关闭')], ['低', t('低')], ['中', t('中')], ['高', t('高')]],
        llm.reasoningMode || '自动',
        setLLMField('reasoningMode'),
      )),
    ]));

    container.appendChild(group(t('连接安全（高级）'), t('仅用于模型 Base URL。HTTP 未加密，只有在你信任局域网环境时才建议开启。'), [
      toggleRow(t('允许局域网 HTTP（不安全）'), null, Boolean(llm.allowInsecureLocalEndpoint), setLLMField('allowInsecureLocalEndpoint')),
    ]));
  }

  /** 服务商列表 + 激活/编辑/删除 + 连接设置。 */
  _renderProviders(host, llm, hasKey) {
    host.innerHTML = '';
    // 激活测试状态行（激活服务商后由 _renderProviders 持久渲染）
    if (this._provStatus) {
      const line = document.createElement('div');
      line.className = `prov-status ${this._provStatus.kind}`;
      line.textContent = this._provStatus.text;
      host.appendChild(line);
    }
    window.robin.llmProviders().then((snap) => {
      if (!snap) return;
      const { providers, activeProviderId } = snap;
      const active = providers.find((p) => p.id === activeProviderId) || providers[0];

      for (const p of providers) {
        const isActive = p.id === activeProviderId;
        const card = document.createElement('div');
        card.className = 'prov-card' + (isActive ? ' active' : '');
        card.innerHTML = `
          <div class="prov-card-row">
            <span class="prov-dot"></span>
            <span class="prov-name"></span>
            <span class="prov-model"></span>
            ${isActive ? `<span class="prov-active-badge">${escapeHTML(t('使用中'))}</span>` : ''}
            <span class="prov-actions">
              <button class="btn icon-only prov-edit" title="${escapeHTML(t('编辑'))}">${icon('pencil')}</button>
              ${providers.length > 1 ? `<button class="btn icon-only prov-del" title="${escapeHTML(t('删除'))}">${icon('trash')}</button>` : ''}
            </span>
          </div>`;
        card.querySelector('.prov-name').textContent = p.name;
        card.querySelector('.prov-model').textContent = p.model || '';
        if (!isActive) {
          card.addEventListener('click', async () => {
            await window.robin.llmSetActive(p.id);
            // 激活即测连接：Key 与端点不匹配（401）当场暴露，不再让用户到阅读器里撞墙
            this._provStatus = { kind: 'testing', text: t('已切换到「' + p.name + '」，正在测试连接…') };
            this.handlers.onRefreshState?.();
            this.render();
            try {
              const test = await window.robin.testAI();
              this._provStatus = test.ok
                ? { kind: 'ok', text: t('「' + p.name + '」连接正常 · ') + (test.data?.model || p.model) }
                : { kind: 'bad', text: t('「' + p.name + '」连接失败：') + (test.error || t('请检查该服务商的 Base URL 与 API Key 是否匹配')) };
            } catch (err) {
              this._provStatus = { kind: 'bad', text: t('「' + p.name + '」连接测试未完成：') + (err?.message || '') };
            }
            this.render();
          });
        }
        card.querySelector('.prov-edit').addEventListener('click', async (e) => {
          e.stopPropagation();
          const name = await promptBox(t('服务商名称'), { initial: p.name });
          if (name === null) return;
          const baseURL = await promptBox(t('Base URL'), { initial: p.baseURL || '' });
          if (baseURL === null) return;
          const modelsStr = await promptBox(t('可选模型（逗号分隔，第一个为当前使用）'), { initial: (p.models && p.models.length ? p.models : [p.model].filter(Boolean)).join(', ') });
          if (modelsStr === null) return;
          const models = modelsStr.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
          await window.robin.llmUpdateProvider(p.id, {
            name: name || p.name,
            baseURL: baseURL || p.baseURL,
            models,
            model: models[0] || p.model,
          });
          this.handlers.onRefreshState?.();
          this.render();
        });
        card.querySelector('.prov-del')?.addEventListener('click', async (e) => {
          e.stopPropagation();
          const ok = await confirmBox(t('删除服务商'), { message: t('确定删除服务商「' + p.name + '」吗？'), okLabel: t('删除'), danger: true });
          if (!ok) return;
          await window.robin.llmRemoveProvider(p.id);
          this.handlers.onRefreshState?.();
          this.render();
        });
        host.appendChild(card);
      }

      // 添加服务商
      const addBtn = document.createElement('button');
      addBtn.className = 'btn-text bordered';
      addBtn.style.margin = '10px 16px';
      addBtn.innerHTML = `${icon('plus')}<span style="margin-left:5px">${escapeHTML(t('添加服务商'))}</span>`;
      addBtn.addEventListener('click', async () => {
        const name = await promptBox(t('服务商名称'), { placeholder: '例如：OpenRouter / 本地 Ollama' });
        if (!name) return;
        const baseURL = await promptBox(t('Base URL（OpenAI 兼容）'), { placeholder: 'https://openrouter.ai/api/v1' });
        if (baseURL === null) return;
        const modelsStr = await promptBox(t('可选模型（逗号分隔）'), { placeholder: 'deepseek-chat, gpt-4o-mini' });
        const models = (modelsStr || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        await window.robin.llmAddProvider({ name, baseURL, model: models[0] || '', models });
        this.handlers.onRefreshState?.();
        this.render();
      });
      host.appendChild(addBtn);

      // 激活服务商的连接设置
      if (active) {
        const conn = document.createElement('div');
        conn.className = 'prov-conn';
        const modelRow = (active.models && active.models.length > 1)
          ? row(t('模型'), null, selectControl(
              active.models.map((m) => [m, m]),
              active.model,
              async (value) => { await window.robin.llmUpdateProvider(active.id, { model: value }); this.handlers.onRefreshState?.(); this.render(); },
            ))
          : inputRow(t('模型'), null, '例如：gpt-4o-mini', active.model, async (value) => {
              await window.robin.llmUpdateProvider(active.id, { model: value });
              this.handlers.onRefreshState?.();
              this.state.snapshot.llm = { ...(this.state.snapshot.llm || {}), model: value };
            });
        conn.appendChild(modelRow);
        conn.appendChild(inputRow(t('API Key'), hasKey ? t('已设置（仅保存在这台设备）') : null, '局域网模型可留空', '', async (value) => {
          await window.robin.setAPIKey(value);
          this.handlers.onRefreshState?.();
        }, { password: true, placeholderFilled: hasKey }));
        conn.appendChild(row('测试连接', t('发送一条最小请求验证服务可用性。'), (() => {
          const wrap = document.createElement('div');
          wrap.className = 'ai-test-wrap';
          const button = document.createElement('button');
          button.className = 'btn-text primary';
          button.innerHTML = `${icon('wand')}<span style="margin-left:5px"></span>`;
          button.querySelector('span').textContent = t('开始测试');
          const status = document.createElement('span');
          status.className = 'ai-test-status';
          status.setAttribute('aria-live', 'polite');
          button.addEventListener('click', async () => {
            button.disabled = true;
            button.classList.add('testing');
            button.querySelector('span').textContent = t('正在测试…');
            status.className = 'ai-test-status';
            status.textContent = '';
            const result = await window.robin.testAI();
            button.disabled = false;
            button.classList.remove('testing');
            button.querySelector('span').textContent = t('重新测试');
            if (result.ok) {
              status.className = 'ai-test-status ok';
              status.innerHTML = `${icon('checkCircle')}<span>${escapeHTML(t('连接成功'))}</span>`;
            } else {
              status.className = 'ai-test-status err';
              status.innerHTML = `${icon('questionCircle')}<span>${escapeHTML(String(result.error || t('连接失败')))}</span>`;
            }
          });
          wrap.append(button, status);
          return wrap;
        })()));
        host.appendChild(conn);
      }
    });
  }

  // MARK: 刷新 / 语言 / 同步 / 反馈 / 关于

  _refresh(container, prefs) {
    container.appendChild(group(t('自动刷新'), t('应用保持打开时按此频率检查订阅；系统后台刷新时间可能会有所延迟。'), [
      row(t('刷新频率'), null, selectControl(
        FEED_REFRESH_INTERVALS_META.map(([value]) => [value, t(value === 'manual' ? '仅手动' : intervalLabel(value))]),
        prefs.refreshInterval || 'thirtyMinutes',
        async (value) => { await window.robin.setRefreshInterval(value); this.handlers.onRefreshState?.(); },
      )),
      toggleRow(t('打开应用时刷新'), null, Boolean(prefs.refreshOnLaunch), async (v) => {
        await window.robin.setRefreshOnLaunch(v);
        this.handlers.onRefreshState?.();
      }),
      row(t('手动刷新'), t('立即检查所有订阅源。'), (() => {
        const button = document.createElement('button');
        button.className = 'btn-text bordered';
        button.textContent = t('刷新所有订阅');
        button.addEventListener('click', async () => {
          button.disabled = true;
          await window.robin.refresh();
          button.disabled = false;
        });
        return button;
      })()),
    ]));
    this._fulltextFeeds(container, prefs);
  }

  /**
   * 全文抓取（F1）按源批量开关：简单列表，每源三态（默认关 / 开 / 仅新文章）。
   * 统计（已补抓篇数）来自 feed_fulltext_stats（fulltext:stats 通道），打开分区时拉一次。
   */
  _fulltextFeeds(container, prefs) {
    const modes = prefs.fulltextFeedModes || {};
    const feeds = [];
    let syncFeedCount = 0;
    for (const account of this.state.sidebar || []) {
      const isLocal = !account.account || !account.account.type || account.account.type === 'local';
      for (const feed of account.allFeeds || []) {
        if (isLocal) feeds.push(feed);
        else syncFeedCount += 1;
      }
    }
    const fulltextGroup = group(
      t('全文抓取'),
      t('启用后刷新不打断界面；补抓完成后列表「全文」徽标自动消失。'),
      [],
    );
    if (syncFeedCount > 0) {
      const note = document.createElement('div');
      note.style.cssText = 'padding:2px 16px 8px;font-size:11.5px;color:var(--text-tertiary);';
      note.textContent = t('同步账户（FreshRSS / Miniflux）的源由服务端提供正文，暂不参与自动补抓。');
      fulltextGroup.appendChild(note);
    }
    container.appendChild(fulltextGroup);
    const host = fulltextGroup.querySelector('.group-rows');
    const modeControl = (feedID) => segmented(
      [['off', t('默认（关）')], ['on', t('开')], ['newOnly', t('仅新文章')]],
      modes[feedID] === 'on' || modes[feedID] === 'newOnly' ? modes[feedID] : 'off',
      async (value) => {
        await window.robin.setFulltextFeedMode(feedID, value);
        this.handlers.onRefreshState?.();
      },
    );
    if (!feeds.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:4px 16px 10px;font-size:12px;color:var(--text-tertiary);';
      empty.textContent = t('还没有订阅源。');
      host.appendChild(empty);
      return;
    }
    // 每源一行：标题（含已补抓统计） + 三态分段开关；统计异步补进描述位
    const rendered = feeds.map((feed) => {
      const rowEl = row(feed.title || feed.id, '', modeControl(feed.id));
      host.appendChild(rowEl);
      return rowEl;
    });
    window.robin.fulltextStats().then((statsMap) => {
      if (!this.overlay) return; // 分区已关闭：放弃补写
      const statByFeed = statsMap || {};
      feeds.forEach((feed, index) => {
        const stat = statByFeed[feed.id];
        if (!stat || !(stat.fetched > 0)) return;
        const desc = rendered[index]?.querySelector('.desc');
        if (desc) {
          desc.textContent = t('已补抓 %lld 篇').replace('%lld', String(stat.fetched));
          desc.style.display = '';
        }
      });
    }).catch(() => { /* 统计拉取失败：开关仍可用，仅无统计文案 */ });
  }

  /**
   * 过滤规则（F2）分区：规则列表（名称/作用域/命中数/开关/顺序/编辑/删除）+
   * 新建/编辑表单（作用域多选源、条件行、动作、正则即时校验、规则测试器）+
   * 「对最近 200 篇回放」入口（带确认提示）。
   */
  _rules(container) {
    const feeds = [];
    for (const account of this.state.sidebar || []) {
      for (const feed of account.allFeeds || []) {
        feeds.push({ id: feed.id, title: feed.title || feed.id, accountTitle: account.account?.displayName || '' });
      }
    }
    const feedTitle = (id) => feeds.find((f) => f.id === id)?.title || id;

    const rulesGroup = group(t('过滤规则'), t('按条件自动处理新文章：命中即执行标已读/收藏/稍后读/打标签；规则在新文章入库时自动应用。'), []);
    container.appendChild(rulesGroup);
    const host = rulesGroup.querySelector('.group-rows');

    const toolbar = document.createElement('div');
    toolbar.className = 'rule-toolbar';
    const addButton = document.createElement('button');
    addButton.className = 'btn-text primary';
    addButton.innerHTML = `${icon('plus')}<span style="margin-left:5px"></span>`;
    addButton.querySelector('span').textContent = t('新建规则');
    addButton.addEventListener('click', () => showRuleEditor({ feeds, onSaved: () => this.render() }));
    const replayButton = document.createElement('button');
    replayButton.className = 'btn-text bordered';
    replayButton.innerHTML = `${icon('playCircle')}<span style="margin-left:5px"></span>`;
    replayButton.querySelector('span').textContent = t('对最近 200 篇回放');
    replayButton.addEventListener('click', async () => {
      const okToRun = await confirmBox(t('回放过滤规则'), {
        message: t('将对最近 200 篇文章重新执行全部启用的规则（已执行过的动作不会重复计入状态）。确定继续吗？'),
        okLabel: t('开始回放'),
      });
      if (!okToRun) return;
      replayButton.disabled = true;
      const result = await window.robin.rulesReplay({ limit: 200 });
      replayButton.disabled = false;
      if (!result) { await alertBox(t('回放失败'), t('请稍后重试。')); return; }
      showToast(t('回放完成：扫描 %lld 篇，命中 %lld 篇')
        .replace('%lld', String(result.scanned)).replace('%lld', String(result.matched)));
      this.render();
    });
    toolbar.append(addButton, replayButton);
    host.appendChild(toolbar);

    const listEl = document.createElement('div');
    listEl.className = 'rule-list';
    host.appendChild(listEl);
    const emptyEl = document.createElement('div');
    emptyEl.style.cssText = 'padding:4px 16px 10px;font-size:12px;color:var(--text-tertiary);';
    emptyEl.textContent = t('还没有规则。新建一条，让刷进来的文章自动分诊。');
    host.appendChild(emptyEl);

    window.robin.rulesList().then((rules) => {
      if (!this.overlay) return; // 分区已关闭：放弃补写
      const list = rules || [];
      emptyEl.style.display = list.length ? 'none' : '';
      const countNote = document.createElement('div');
      countNote.className = 'rule-count-note';
      countNote.textContent = t('%lld / 50 条规则').replace('%lld', String(list.length));
      toolbar.appendChild(countNote);

      list.forEach((rule, index) => {
        const scopeText = rule.scope.kind === 'all'
          ? t('全部订阅源')
          : rule.scope.ids.slice(0, 2).map(feedTitle).join('、') + (rule.scope.ids.length > 2 ? ` +${rule.scope.ids.length - 2}` : '');
        const rowEl = document.createElement('div');
        rowEl.className = 'rule-row';
        const label = document.createElement('div');
        label.className = 'rule-row-label';
        const title = document.createElement('div');
        title.className = 'rule-row-title';
        title.textContent = rule.name; // textContent：不可信回显安全
        const desc = document.createElement('div');
        desc.className = 'rule-row-desc';
        desc.textContent = `${scopeText} · ${t('已命中 %lld 次').replace('%lld', String(rule.hitCount))}`;
        label.append(title, desc);
        const controls = document.createElement('div');
        controls.className = 'rule-row-controls';
        const up = document.createElement('button');
        up.className = 'btn icon-only';
        up.title = t('上移');
        up.setAttribute('aria-label', t('上移'));
        up.innerHTML = icon('chevronUp');
        up.disabled = index === 0;
        up.addEventListener('click', async () => { await window.robin.rulesMove(rule.id, 'up'); this.render(); });
        const down = document.createElement('button');
        down.className = 'btn icon-only';
        down.title = t('下移');
        down.setAttribute('aria-label', t('下移'));
        down.innerHTML = icon('chevronDown');
        down.disabled = index === list.length - 1;
        down.addEventListener('click', async () => { await window.robin.rulesMove(rule.id, 'down'); this.render(); });
        const edit = document.createElement('button');
        edit.className = 'btn icon-only';
        edit.title = t('编辑');
        edit.setAttribute('aria-label', t('编辑'));
        edit.innerHTML = icon('pencil');
        edit.addEventListener('click', () => showRuleEditor({ feeds, rule, onSaved: () => this.render() }));
        const del = document.createElement('button');
        del.className = 'btn icon-only rule-danger';
        del.title = t('删除');
        del.setAttribute('aria-label', t('删除'));
        del.innerHTML = icon('trash');
        del.addEventListener('click', async () => {
          const okDel = await confirmBox(t('删除规则'), {
            message: t('确定删除规则「%@」吗？').replace('%@', rule.name),
            okLabel: t('删除'), danger: true,
          });
          if (!okDel) return;
          await window.robin.rulesDelete(rule.id);
          this.render();
        });
        controls.append(toggleControl(rule.enabled, async (v) => {
          await window.robin.rulesSetEnabled(rule.id, v);
          this.render();
        }), up, down, edit, del);
        rowEl.append(label, controls);
        listEl.appendChild(rowEl);
      });
    }).catch(() => { /* 列表拉取失败：保持空态文案 */ });
  }

  _language(container, prefs) {
    container.appendChild(group(t('界面语言'), t('默认跟随系统设置；也可以随时在这里切换，应用界面会立即更新。'), [
      row(t('语言选择'), null, selectControl(
        [['system', t('跟随系统')], ['zh', '简体中文'], ['en', 'English']],
        prefs.appLanguage || 'zh',
        async (value) => {
          await window.robin.setLanguage(value === 'system' ? 'zh' : value);
          this.handlers.onRefreshState?.();
          this.render();
        },
      )),
    ]));
  }

  // MARK: 同步（F7 WebDAV 多设备同步：本地优先快照合并）

  async _sync(container) {
    const cfg = (await window.robin.syncGetConfig?.().catch(() => null)) || {};

    // ── WebDAV 服务器（凭据 DPAPI 只存本机）──
    const connGroup = group(t('WebDAV 服务器'), t('订阅、阅读进度、批注与偏好经你自己的 WebDAV 网盘（坚果云等）跨设备漫游。WebDAV 只是快照交换点：本机数据始终完整，任何设备都可以离线，重连后自动合并、互不覆盖。'), []);
    container.appendChild(connGroup);
    const connHost = connGroup.querySelector('.group-rows');

    const formInput = (type, value, placeholder, onChange) => {
      const input = document.createElement('input');
      input.type = type;
      input.className = 'nj-css-input';
      input.style.minHeight = '32px';
      input.style.maxWidth = '240px';
      input.value = value || '';
      input.placeholder = placeholder || '';
      input.addEventListener('change', () => onChange(input.value.trim()));
      return input;
    };
    const currentForm = () => ({
      serverURL: serverInput.value.trim(),
      username: userInput.value.trim(),
      password: passInput.value.trim() || undefined,
    });

    const serverInput = formInput('text', cfg.serverURL, 'https://dav.jianguoyun.com/dav/', async (v) => {
      const result = await window.robin.syncSaveConfig({ serverURL: v }).catch(() => null);
      if (!result || !result.ok) {
        await alertBox(t('保存失败'), String((result && result.error) || t('同步服务器地址必须以 http:// 或 https:// 开头。')));
        serverInput.value = cfg.serverURL || '';
      }
    });
    const userInput = formInput('text', cfg.username, t('WebDAV 账户名'), (v) => window.robin.syncSaveConfig({ username: v }));
    const passInput = formInput('password', '', cfg.hasPassword ? t('已保存，输入新值可覆盖') : t('应用专用密码'),
      async (v) => { if (v) await window.robin.syncSaveConfig({ password: v }); showToast(t('密码已保存到本机')); });

    connHost.appendChild(row(t('服务器地址'), t('到目录级即可，例如 https://dav.jianguoyun.com/dav/。'), serverInput));
    connHost.appendChild(row(t('用户名'), null, userInput));
    connHost.appendChild(row(t('密码'), t('建议使用网盘的「应用专用密码」。只保存在本机（系统加密），不参与同步、不上传。'), passInput));
    connHost.appendChild(row(t('测试连接'), t('对服务器根目录发起一次真实探测，验证地址与凭据。'), (() => {
      const wrap = document.createElement('div');
      wrap.className = 'setting-control';
      wrap.style.gap = '8px';
      const button = document.createElement('button');
      button.className = 'btn-text bordered';
      button.textContent = t('测试连接');
      const status = document.createElement('span');
      status.style.cssText = 'font-size:12px;color:var(--text-secondary);';
      button.addEventListener('click', async () => {
        button.disabled = true;
        status.textContent = t('正在测试…');
        try {
          const result = await window.robin.syncTest(currentForm());
          status.textContent = result?.ok
            ? tf('连接正常 · %lldms', result.data?.elapsedMs ?? 0)
            : t('连接失败');
          if (!result?.ok) await alertBox(t('连接失败'), String(result.error || ''));
        } catch (err) {
          status.textContent = t('连接失败');
          await alertBox(t('连接失败'), String(err?.message || err));
        }
        button.disabled = false;
      });
      wrap.append(button, status);
      return wrap;
    })()));

    // ── 同步行为（自动同步 / 立即同步 / 状态）──
    const behaviorGroup = group(t('同步行为'), t('「立即同步」先下行合并远端快照，本机有新变更时再把合并结果上行。合并规则：订阅并集、批注并集（永不删除）、阅读位置与偏好新者胜。'), []);
    container.appendChild(behaviorGroup);
    const behaviorHost = behaviorGroup.querySelector('.group-rows');

    behaviorHost.appendChild(toggleRow(t('自动同步'), t('每次刷新完成后自动同步一次（至少间隔 10 分钟，避免频繁占用网盘）。'), cfg.autoEnabled !== false,
      (v) => window.robin.syncSetAuto(v === true)));

    behaviorHost.appendChild(row(t('立即同步'), t('手动触发一次完整同步，完成后提示上行/下行与合并统计。'), (() => {
      const button = document.createElement('button');
      button.className = 'btn-text primary';
      button.textContent = t('立即同步');
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        button.textContent = t('正在同步…');
        try {
          const result = await window.robin.syncNow();
          if (result?.ok) showToast(syncResultText(result.data));
          else await alertBox(t('同步失败'), String(result.error || ''));
        } catch (err) {
          await alertBox(t('同步失败'), String(err?.message || err));
        }
        button.disabled = false;
        button.textContent = t('立即同步');
        if (this.overlay) this.render();
      });
      return button;
    })()));

    behaviorHost.appendChild(row(t('上次同步'), t('最近一次成功完成同步的时间。'), staticText(cfg.lastSyncAt
      ? tf('上次同步：%@', new Date(cfg.lastSyncAt * 1000).toLocaleString([], { hour: '2-digit', minute: '2-digit' }))
      : t('尚未同步'))));

    if (cfg.deviceId) {
      behaviorHost.appendChild(row(t('本机设备标识'), t('每台设备有独立标识，快照按设备合并而不是整份覆盖。'), staticText(String(cfg.deviceId).slice(0, 8))));
    }

    if (cfg.serverURL) {
      behaviorHost.appendChild(row(t('断开同步'), t('清除本机保存的服务器配置与密码。本机订阅、批注与阅读进度不受影响。'), (() => {
        const button = document.createElement('button');
        button.className = 'btn-text danger';
        button.textContent = t('断开并清除');
        button.addEventListener('click', async () => {
          const ok = await confirmBox(t('断开 WebDAV 同步？'), {
            message: t('将删除本机保存的服务器地址与密码。已合并到本机的数据全部保留，其他设备也不受影响。'),
            okLabel: t('断开'),
            danger: true,
          });
          if (!ok) return;
          await window.robin.syncDisconnect();
          showToast(t('已断开同步'));
          this.render();
        });
        return button;
      })()));
    }

    container.appendChild(group(t('隐私'), null, [
      row(t('API Key'), null, staticText(t('仅存于本机，不参与同步'))),
      row(t('WebDAV 密码'), null, staticText(t('仅存于本机（系统加密），不参与同步'))),
    ]));
  }

  // MARK: Obsidian 知识库导出（F11）

  async _obsidian(container) {
    const cfg = (await window.robin.obsidianConfig?.().catch(() => null)) || {};
    const conf = cfg?.data || {};

    container.appendChild(group(t('Obsidian 知识库导出'), t('把文章、高亮与批注导出为 Obsidian 友好的 Markdown 库。知更只在你选择的目录里维护 RobinRead/ 命名空间：增量更新、重复导出零写入，永不删除你在 Obsidian 侧添加的内容。'), []));

    // ── 库目录（授权态仅内存；重启后需重新选择）──
    const dirGroup = group(t('库目录'), t('目录授权仅在本次会话内有效：重启知更后需重新选择目录，避免长期持有对任意文件夹的写权限。'), []);
    container.appendChild(dirGroup);
    const dirHost = dirGroup.querySelector('.group-rows');

    const dirLabel = document.createElement('span');
    dirLabel.style.cssText = 'font-size:12px;color:var(--text-secondary);max-width:240px;text-align:right;word-break:break-all;';
    if (conf.authorized && conf.dir) {
      dirLabel.textContent = conf.dir;
      dirLabel.style.color = 'var(--text-primary)';
    } else if (conf.lastDir) {
      dirLabel.textContent = `${t('上次使用（本次会话未授权）')}：${conf.lastDir}`;
    } else {
      dirLabel.textContent = t('尚未选择目录');
    }
    const pickButton = document.createElement('button');
    pickButton.className = 'btn-text bordered';
    pickButton.textContent = conf.authorized ? t('更改目录') : t('选择目录…');
    pickButton.addEventListener('click', async () => {
      const result = await window.robin.obsidianPickDir().catch(() => null);
      if (result?.ok && result.data?.dir) showToast(t('已授权导出目录'));
      this.render();
    });
    dirHost.appendChild(row(t('导出目录'), t('选择 vault 内的一个目录；知更只写入其中的 RobinRead/ 子目录。'), (() => {
      const wrap = document.createElement('div');
      wrap.className = 'setting-control';
      wrap.style.gap = '8px';
      wrap.append(dirLabel, pickButton);
      return wrap;
    })()));

    // ── 导出范围 ──
    const scope = conf.scope || { articles: true, highlights: true, tags: true };
    container.appendChild(group(t('导出范围'), null, [
      toggleRow(t('导出文章'), t('整篇正文与 frontmatter（标题 / 来源 / 链接 / 发布时间 / 标签）。'), scope.articles !== false,
        (v) => window.robin.obsidianConfig({ scope: { articles: v === true } })),
      toggleRow(t('导出高亮与批注'), t('每条高亮一个文件：引用块加上你的笔记，随文章信息带 frontmatter。'), scope.highlights !== false,
        (v) => window.robin.obsidianConfig({ scope: { highlights: v === true } })),
      toggleRow(t('标签写入 frontmatter'), t('文章的 tags 属性 = 手动 / AI 标签 ∪ 知识笔记标签。'), scope.tags !== false,
        (v) => window.robin.obsidianConfig({ scope: { tags: v === true } })),
    ]));

    // ── 导出动作 ──
    const statusLine = document.createElement('div');
    statusLine.style.cssText = 'font-size:12px;color:var(--text-secondary);text-align:right;max-width:300px;line-height:1.6;';

    const previewText = (p) => tf('预览：%lld 篇文章 · %lld 条高亮 · 新增 %lld · 变更 %lld · 不变 %lld',
      p?.counts?.articles ?? 0, p?.counts?.highlights ?? 0, p?.newFiles ?? 0, p?.changedFiles ?? 0, p?.unchangedFiles ?? 0)
      + (p?.truncated ? `\n${t('已达单次 2000 文件上限，本次将截断。')}` : '');

    const exportButton = document.createElement('button');
    exportButton.className = 'btn-text primary';
    exportButton.textContent = t('立即导出');
    exportButton.addEventListener('click', async () => {
      if (exportButton.disabled) return;
      exportButton.disabled = true;
      exportButton.textContent = t('正在导出…');
      try {
        const pv = await window.robin.obsidianPreview().catch(() => null);
        if (!pv?.ok) {
          await alertBox(t('导出失败'), String(pv?.error || t('请先选择 Obsidian 库目录。')));
          return;
        }
        const go = await confirmBox(t('立即导出？'), { message: previewText(pv.data), okLabel: t('立即导出') });
        if (!go) return;
        // U13 进度通知：导出为长任务，活跃期呼吸不消退，落定后收口
        const p = Toast.progress(t('正在导出 Obsidian 库…'), { note: t('增量比对中…') });
        const result = await window.robin.obsidianExport().catch(() => null);
        if (result?.ok) {
          p.set(100, t('写入完成'));
          p.done(exportResultText(result.data));
          if (result.data?.contentTruncatedCount) await alertBox(t('已按上限截断'), t('部分文件正文超过单文件 1MB 上限，已截断（%lld 个文件）。').replace('%lld', String(result.data.contentTruncatedCount)));
          else if (result.data?.truncated) await alertBox(t('已按上限截断'), t('已达单次 2000 文件上限，更早的文章未包含在本次导出。'));
        } else {
          p.fail(t('导出失败'));
          await alertBox(t('导出失败'), String(result?.error || ''));
        }
      } catch (err) {
        await alertBox(t('导出失败'), String(err?.message || err));
      } finally {
        exportButton.disabled = false;
        exportButton.textContent = t('立即导出');
        if (this.overlay) this.render();
      }
    });

    const fullButton = document.createElement('button');
    fullButton.className = 'btn-text bordered';
    fullButton.textContent = t('全量重导');
    fullButton.addEventListener('click', async () => {
      if (fullButton.disabled) return;
      const go = await confirmBox(t('全量重导？'), {
        message: t('将忽略增量游标重写全部导出文件（仍不删除你在 Obsidian 侧添加的内容）。'),
        okLabel: t('重新导出'),
      });
      if (!go) return;
      fullButton.disabled = true;
      const p = Toast.progress(t('正在全量重导…'), { note: t('忽略增量游标，重写全部文件') });
      try {
        const result = await window.robin.obsidianFullExport().catch(() => null);
        if (result?.ok) {
          p.set(100, t('写入完成'));
          p.done(exportResultText(result.data));
          if (result.data?.contentTruncatedCount) await alertBox(t('已按上限截断'), t('部分文件正文超过单文件 1MB 上限，已截断（%lld 个文件）。').replace('%lld', String(result.data.contentTruncatedCount)));
          else if (result.data?.truncated) await alertBox(t('已按上限截断'), t('已达单次 2000 文件上限，更早的文章未包含在本次导出。'));
        } else {
          p.fail(t('导出失败'));
          await alertBox(t('导出失败'), String(result?.error || ''));
        }
      } catch (err) {
        await alertBox(t('导出失败'), String(err?.message || err));
      } finally {
        fullButton.disabled = false;
        if (this.overlay) this.render();
      }
    });

    const previewButton = document.createElement('button');
    previewButton.className = 'btn-text bordered';
    previewButton.textContent = t('预览统计');
    previewButton.addEventListener('click', async () => {
      previewButton.disabled = true;
      statusLine.textContent = t('正在统计…');
      try {
        const pv = await window.robin.obsidianPreview().catch(() => null);
        statusLine.textContent = pv?.ok ? previewText(pv.data) : String(pv?.error || t('请先选择 Obsidian 库目录。'));
      } finally {
        previewButton.disabled = false;
      }
    });

    const lastExportAt = Number(conf.lastExportAt) || 0;
    container.appendChild(group(t('导出'), t('单次最多 2000 个文件；单个文件超过 1MB 时正文自动截断。'), [
      row(t('预览统计'), t('先看看将新增、变更多少文件，再决定是否执行。'), (() => {
        const wrap = document.createElement('div');
        wrap.className = 'setting-control';
        wrap.style.gap = '8px';
        wrap.append(statusLine, previewButton);
        return wrap;
      })()),
      row(t('立即导出'), t('增量导出：只写入新增或内容变化的文件。'), exportButton),
      row(t('全量重导'), t('忽略增量游标，重写全部文件（仍不删除你在 Obsidian 侧的内容）。'), fullButton),
      row(t('最后导出'), null, staticText(lastExportAt
        ? tf('上次导出：%@', new Date(lastExportAt * 1000).toLocaleString([], { hour: '2-digit', minute: '2-digit' }))
        : t('尚未导出'))),
    ]));
  }

  // MARK: 书架（F12 个人文集自动成书）

  async _bookshelf(container) {
    const result = await window.robin.booksList?.().catch(() => null);
    const books = (result?.ok && Array.isArray(result.data?.books)) ? result.data.books : [];
    const refresh = () => { if (this.overlay) this.render(); };
    const sidebarFeeds = () => (this.state?.sidebar || []).flatMap((a) => a.allFeeds || []);

    container.appendChild(group(t('个人文集成书'), t('把选中的订阅源（如某公众号的全部文章）按周期自动打包成带目录的 EPUB 书：文章按发布时间升序、按月分章，每 200 篇自动分卷。「自动成书」在每次刷新完成后触发（至少间隔 24 小时且源有新文章），产物存放在应用数据目录的 books/<文集>/ 下；「立即成书」则由你选择保存位置。'), []));

    // ── 新建文集 ──
    const newBtn = document.createElement('button');
    newBtn.className = 'btn-text primary';
    newBtn.textContent = t('新建文集…');
    newBtn.addEventListener('click', async () => {
      await showCreateBookDialog({
        feeds: sidebarFeeds(),
        onCreate: async ({ title, feedIDs }) => {
          const res = await window.robin.booksCreate({ title, feedIDs, schedule: 'manual' }).catch(() => null);
          showToast(res?.ok ? t('文集已创建') : String(res?.error || t('创建失败')));
        },
      });
      refresh();
    });
    container.appendChild(group(t('文集'), t('文集可绑定多个订阅源；也可在侧栏订阅源或文章的右键菜单里「加入文集」。'), [
      row(t('新建文集'), t('命名并勾选要收进书里的订阅源。'), newBtn),
    ]));

    // ── 书列表 ──
    if (!books.length) {
      container.appendChild(group(t('书架空'), t('还没有文集。点上方「新建文集」，或在订阅源右键菜单里选择「加入文集 → 新建文集」。'), []));
      return;
    }
    const listGroup = group(t('书目'), t('删除文集只移除文集本身与自动目录里的成书；你手动导出到其他位置的书不受影响。'), []);
    container.appendChild(listGroup);
    const host = listGroup.querySelector('.group-rows');

    for (const book of books) {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:12px 16px;border-bottom:1px solid var(--separator);';

      const iconEl = document.createElement('span');
      iconEl.className = 'setting-icon';
      iconEl.innerHTML = icon('books');
      iconEl.style.marginTop = '3px';

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;';
      const titleLine = document.createElement('div');
      titleLine.style.cssText = 'display:flex;align-items:center;gap:8px;';
      const titleEl = document.createElement('span');
      titleEl.style.cssText = 'font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      titleEl.textContent = book.title;
      titleLine.appendChild(titleEl);
      if (book.pendingPick) {
        const badge = document.createElement('span');
        badge.style.cssText = 'font-size:10.5px;font-weight:600;color:var(--accent);background:color-mix(in oklch, var(--accent) 14%, transparent);padding:1px 8px;border-radius:999px;flex-shrink:0;';
        badge.textContent = t('待取');
        titleLine.appendChild(badge);
      }
      if (book.schedule === 'auto') {
        const autoTag = document.createElement('span');
        autoTag.style.cssText = 'font-size:10.5px;color:var(--text-tertiary);border:1px solid var(--separator);padding:1px 8px;border-radius:999px;flex-shrink:0;';
        autoTag.textContent = t('自动');
        titleLine.appendChild(autoTag);
      }
      const metaEl = document.createElement('div');
      metaEl.style.cssText = 'font-size:12px;color:var(--text-secondary);margin-top:3px;line-height:1.6;';
      metaEl.textContent = bookMetaLine(book);
      const fileEl = document.createElement('div');
      fileEl.style.cssText = 'font-size:11.5px;color:var(--text-tertiary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      fileEl.textContent = (book.lastFiles || []).length ? book.lastFiles.join(' · ') : t('自动目录暂无成书');
      info.append(titleLine, metaEl, fileEl);

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0;';
      actions.appendChild(toggleControl(book.schedule === 'auto', async (on) => {
        await window.robin.booksUpdate({ id: book.id, schedule: on ? 'auto' : 'manual' }).catch(() => null);
        showToast(on ? t('已开启自动成书') : t('已关闭自动成书'));
        refresh();
      }));

      const btnLine = document.createElement('div');
      btnLine.style.cssText = 'display:flex;gap:6px;';
      const mkBtn = (label, cls, onClick) => {
        const b = document.createElement('button');
        b.className = `btn-text ${cls}`;
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
      };
      btnLine.appendChild(mkBtn(t('立即成书'), 'bordered', async () => {
        const res = await window.robin.booksBuild(book.id).catch(() => null);
        if (res?.ok && res.data) {
          const names = (res.data.files || []).map((f) => f.name).join('、');
          showToast(names
            ? tf('成书完成（%lld 篇）：%lld', res.data.entryCount ?? 0, names)
            : tf('成书完成：%lld 卷（%lld 篇）', res.data.volumes ?? 1, res.data.entryCount ?? 0), 3200);
        } else if (res && !res.ok) {
          await alertBox(t('成书失败'), String(res.error || ''));
        }
        refresh();
      }));
      btnLine.appendChild(mkBtn(t('打开目录'), 'bordered', async () => {
        const res = await window.robin.booksOpenDir(book.id).catch(() => null);
        if (res && !res.ok) await alertBox(t('打开失败'), String(res.error || ''));
        refresh();
      }));
      btnLine.appendChild(mkBtn(t('删除'), '', async () => {
        const go = await confirmBox(t('删除文集？'), {
          message: tf('「%@」将被删除，其自动目录里的成书文件一并清理。你手动导出到其他位置的 EPUB 不受影响。', book.title),
          okLabel: t('删除'),
          danger: true,
        });
        if (!go) return;
        const res = await window.robin.booksDelete(book.id).catch(() => null);
        showToast(res?.ok ? t('文集已删除') : String(res?.error || t('删除失败')));
        refresh();
      }));
      actions.appendChild(btnLine);

      item.append(iconEl, info, actions);
      host.appendChild(item);
    }
  }

  _feedback(container) {
    const card = document.createElement('div');
    card.className = 'settings-group';
    card.innerHTML = `<div class="settings-group-header">${escapeHTML(t('反馈与共建'))}</div>
      <div style="padding: 16px 18px; display:flex; flex-direction:column; gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="setting-icon">${icon('heart')}</span>
          <div style="flex:1;">
            <div style="font-size:13.5px;font-weight:600;">${escapeHTML(t('感谢使用 RobinRead'))}</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:3px;line-height:1.6;">${escapeHTML(t('知更是一款本地优先的纸感阅读器。你的每一条使用反馈都会让纸面更安静、更称手。'))}</div>
          </div>
        </div>
        <div style="font-size:11.5px;color:var(--text-tertiary);line-height:1.6;">${escapeHTML(t('知更 RobinRead for Windows —— 本地优先、AI 增强的纸感三栏 RSS 阅读器。'))}</div>
      </div>`;
    container.appendChild(card);

    container.appendChild(group(t('官网'), t('产品介绍、功能一览与最新版本下载。'), [
      row(t('前往官网'), null, websiteButton('前往官网')),
    ]));
  }

  _about(container) {
    const hero = document.createElement('div');
    hero.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;padding:26px 16px 10px;';
    hero.innerHTML = `
      <img src="../../assets/icon.png" width="88" height="88" style="border-radius:22px;box-shadow:var(--shadow-card);" alt="RobinRead"/>
      <div style="display:flex;align-items:center;gap:6px;margin-top:8px;">
        <span style="font-size:22px;font-weight:700;font-family:var(--font-serif);">RobinRead</span>
        <span style="font-size:10px;font-weight:700;color:var(--accent);background:rgba(97,115,87,0.12);padding:2px 7px;border-radius:999px;">Windows</span>
      </div>
      <div style="font-size:12px;color:var(--text-secondary);">Version ${this.state?.snapshot?.version || ''} · 知更阅读器</div>
      <div style="font-size:12.5px;color:var(--text-secondary);text-align:center;margin-top:6px;">${escapeHTML(t('专为沉浸式阅读打造的 RSS 订阅与 AI 阅读助手。'))}</div>
      <div style="font-size:11.5px;color: var(--accent);">${escapeHTML(t('双语流转，克制智能化。'))}</div>`;
    const siteLink = document.createElement('a');
    siteLink.className = 'about-site-link';
    siteLink.href = WEBSITE_URL;
    siteLink.target = '_blank';
    siteLink.rel = 'noreferrer';
    siteLink.textContent = t('官网：ronbinread.tcloudbaseapp.com');
    hero.appendChild(siteLink);
    container.appendChild(hero);

    container.appendChild(group(t('功能速览'), null, [
      row(t('订阅'), t('本地 + FreshRSS 同步 · 商店 170+ 源 · OPML'), staticText('')),
      row(t('阅读'), t('三栏纸感 · TOC · 禅模式 · 双语对照 · 划词 AI'), staticText('')),
      row(t('降噪'), t('信噪评分 · 关键词规则 · 今日 AI 简报'), staticText('')),
      row(t('主题'), t('OKLCH 设计器 · 中国传统色 · 明暗并排'), staticText('')),
    ]));

    container.appendChild(group(t('官网与更新'), t('支持应用内直接更新：检查新版本 → 下载 → 静默安装重启。'), [
      row(t('当前版本'), null, staticText(`v${this.state?.snapshot?.version || this.state?.version || '?'}`)),
      row(t('软件更新'), t('从 GitHub Releases 下载官方安装包并自动安装。'), this._updaterControl()),
      row(t('前往官网'), t('产品介绍 · 功能一览 · 下载'), websiteButton('前往官网', WEBSITE_URL)),
    ]));

    container.appendChild(group(t('关于本机数据'), null, [
      row(t('数据位置'), `%APPDATA%\\RobinRead`, staticText('')),
      row(t('隐私'), t('订阅、文章与 AI 配置全部保存在本机，不经过任何第三方服务器。'), staticText('')),
    ]));
  }

  /** 应用内更新控件：检查 → 展示新版 → 下载（进度条）→ 重启并安装。 */
  _updaterControl() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:180px;';
    const status = document.createElement('div');
    status.style.cssText = 'font-size:12px;color:var(--text-secondary);text-align:right;max-width:300px;';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:none;width:180px;height:5px;border-radius:999px;background:var(--separator);overflow:hidden;';
    const fill = document.createElement('div');
    fill.style.cssText = 'width:0%;height:100%;background:var(--accent);transition:width .25s ease;';
    bar.appendChild(fill);
    const button = document.createElement('button');
    button.className = 'btn-text bordered';
    button.textContent = t('检查更新');
    let phase = 'idle';
    const setStatus = (s) => { status.textContent = s; };
    button.addEventListener('click', async () => {
      try {
        if (phase === 'idle') {
          button.disabled = true;
          setStatus(t('正在检查更新…'));
          const result = await window.robin.checkUpdate();
          if (!result?.available) {
            setStatus(t('已是最新版本'));
            button.textContent = t('重新检查');
          } else {
            phase = 'ready';
            const latest = String(result.release?.tagName || '').replace(/^v/i, '');
            setStatus(t('发现新版本') + ` v${latest}`);
            button.textContent = t('立即更新');
          }
          button.disabled = false;
        } else if (phase === 'ready') {
          button.disabled = true;
          phase = 'downloading';
          bar.style.display = 'block';
          const un = window.robin.onUpdateProgress?.((p) => {
            if (p?.total) fill.style.width = `${Math.min(100, p.percent)}%`;
            setStatus(t('正在下载') + ` ${p?.percent || 0}%`);
          }) || null;
          try {
            await window.robin.updateDownload();
          } finally {
            un?.();
          }
          bar.style.display = 'none';
          fill.style.width = '0%';
          phase = 'done';
          setStatus(t('下载完成'));
          button.textContent = t('重启并安装');
          button.disabled = false;
        } else if (phase === 'done') {
          button.disabled = true;
          setStatus(t('正在退出并安装…'));
          await window.robin.updateInstall();
        }
      } catch (error) {
        phase = 'idle';
        bar.style.display = 'none';
        button.disabled = false;
        button.textContent = phase === 'idle' ? t('重试') : button.textContent;
        setStatus(`${t('更新失败')}：${String(error?.message || error).slice(0, 120)}`);
      }
    });
    wrap.appendChild(status);
    wrap.appendChild(bar);
    wrap.appendChild(button);
    return wrap;
  }
}

// MARK: - Sheet 对话框（AddFeed / AddFolder / RenameFolder / FreshRSS 账号）

/**
 * 「添加订阅」四 tab：RSS / B 站 UP 主 / 微博用户 / 网页追更（F5 + F18）。
 * 平台 tab：输入 UID 或主页链接 → 试抓预览前 3 条 → 确认添加（feed 落 platform/platform_ref）。
 * 追更 tab：URL + 可选选择器 → 抓取预览（正文前 200 字）→ 确认（platform='monitor' 合成源）。
 */
export function showAddFeed(folders, onDone) {
  const { overlay, modal } = smallModal(t('添加订阅'));
  const body = modal.querySelector('.sheet-body');
  const footer = modal.querySelector('.modal-footer');
  let active = 'rss';
  // 时序 token（topic-view 同款）：快速切 tab 时，旧 tab 的异步返回不再写回新页面
  let seq = 0;

  const TABS = [
    ['rss', t('RSS')],
    ['bilibili', t('B 站 UP 主')],
    ['weibo', t('微博用户')],
    ['monitor', t('网页追更')],
  ];
  const tabs = document.createElement('div');
  tabs.className = 'segmented';
  tabs.style.cssText = 'margin:2px 0 10px;';
  for (const [id, label] of TABS) {
    const tabButton = document.createElement('button');
    tabButton.type = 'button';
    tabButton.textContent = label;
    tabButton.dataset.tab = id;
    tabButton.addEventListener('click', () => {
      active = id;
      renderTab();
    });
    tabs.appendChild(tabButton);
  }
  body.appendChild(tabs);

  const content = document.createElement('div');
  body.appendChild(content);

  const cancelButton = () => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn-text';
    b.textContent = t('取消');
    b.addEventListener('click', () => overlay.remove());
    return b;
  };
  const setFooter = (buttons) => {
    footer.innerHTML = '';
    for (const b of buttons) footer.appendChild(b);
  };
  const folderOptions = () => [['', t('无分类')], ...folders.map((f) => [f.name, f.name])];
  const platformTitle = (platform) => (platform === 'bilibili' ? t('B 站 UP 主') : t('微博用户'));

  function renderTab() {
    seq += 1;
    for (const b of tabs.children) b.classList.toggle('active', b.dataset.tab === active);
    content.innerHTML = '';
    if (active === 'rss') renderRSSBody();
    else if (active === 'monitor') renderMonitorBody();
    else renderPlatformBody(active);
  }

  // ── RSS tab：与既有单表单流程逐字段一致 ──
  function renderRSSBody() {
    const urlInput = field(content, t('订阅地址'), 'link', 'https://example.com/feed.xml');
    let httpWarn = null;
    urlInput.addEventListener('input', () => {
      const insecure = urlInput.value.trim().toLowerCase().startsWith('http://');
      if (insecure && !httpWarn) {
        httpWarn = document.createElement('div');
        httpWarn.className = 'http-warning';
        httpWarn.innerHTML = `${icon('info')}<span></span>`;
        httpWarn.querySelector('span').textContent = t('这是未加密的 HTTP 地址，内容可能被网络中间人篡改。仅在你信任该来源时使用。');
        content.insertBefore(httpWarn, urlInput.closest('.sheet-field').nextSibling);
      } else if (!insecure && httpWarn) {
        httpWarn.remove();
        httpWarn = null;
      }
    });
    const folderSelect = selectField(content, t('可选分类'), 'folder', folderOptions());
    hint(content, t('保存后会立即抓取一次 Feed。RobinRead 只保存订阅地址、文章和阅读状态。'));

    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = 'btn-text primary';
    confirmButton.textContent = t('添加');
    confirmButton.addEventListener('click', async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      confirmButton.disabled = true;
      try {
        const result = await window.robin.addFeed(url, folderSelect.value || null);
        if (!result.ok) {
          // 免费版订阅源达上限 → 转升级引导（比报错更清晰的路径）
          if (/会员/.test(String(result.error))) {
            overlay.remove();
            const { showUpgradeGate } = await import('./account.js');
            showUpgradeGate({ message: String(result.error) });
            return;
          }
          await alertBox(t('添加失败'), String(result.error));
          return;
        }
        onDone?.();
        overlay.remove();
      } finally {
        confirmButton.disabled = false;
      }
    });
    setFooter([cancelButton(), confirmButton]);
    setTimeout(() => urlInput.focus(), 50);
  }

  // ── 平台 tab（B 站 / 微博）：UID/链接 → 试抓预览 3 条 → 确认添加 ──
  function renderPlatformBody(platform) {
    const isBili = platform === 'bilibili';
    const input = field(content,
      isBili ? t('UP 主 UID 或主页链接') : t('用户 UID 或主页链接'),
      isBili ? 'playCircle' : 'person',
      isBili ? t('例如：123456 或 https://space.bilibili.com/123456') : t('例如：789 或 https://weibo.com/u/789'));
    const folderSelect = selectField(content, t('可选分类'), 'folder', folderOptions());
    hint(content, isBili
      ? t('保存后会按 UP 主投稿自动刷新，视频在阅读器内直接播放。')
      : t('保存后按微博时间线自动刷新；接口被风控时会自动重试。'));

    const previewBox = document.createElement('div');
    content.appendChild(previewBox);

    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.className = 'btn-text bordered';
    previewButton.textContent = t('试抓预览');
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'btn-text primary';
    addButton.textContent = t('添加');
    addButton.disabled = true;
    setFooter([cancelButton(), previewButton, addButton]);

    let selectedRef = null;

    previewButton.addEventListener('click', async () => {
      const inputText = input.value.trim();
      if (!inputText) return;
      const ticket = ++seq;
      previewButton.disabled = true;
      addButton.disabled = true;
      previewBox.innerHTML = '';
      previewBox.appendChild(previewStatus(t('正在试抓…')));
      try {
        const result = await window.robin.platformPreview({ platform, input: inputText });
        if (ticket !== seq || !overlay.isConnected) return; // 已切 tab / 关闭：丢弃旧返回
        if (!result.ok) throw new Error(String(result.error || t('预览失败')));
        selectedRef = result.data?.ref || null;
        previewBox.innerHTML = '';
        const entries = Array.isArray(result.data?.entries) ? result.data.entries : [];
        if (!selectedRef || !entries.length) {
          previewBox.appendChild(previewStatus(t('没有抓到最近投稿，请确认 UID 或链接后重试。')));
          return;
        }
        previewBox.appendChild(previewHeader(platformTitle(platform), result.data.title));
        for (const entry of entries.slice(0, 3)) previewBox.appendChild(previewRow(entry));
        addButton.disabled = false;
      } catch (err) {
        if (ticket !== seq || !overlay.isConnected) return;
        previewBox.innerHTML = '';
        previewBox.appendChild(previewStatus(String(err?.message || err)));
      } finally {
        if (ticket === seq && overlay.isConnected) previewButton.disabled = false;
      }
    });

    addButton.addEventListener('click', async () => {
      if (!selectedRef) return;
      addButton.disabled = true;
      try {
        const result = await window.robin.addPlatformFeed({
          platform, ref: selectedRef, folder: folderSelect.value || null,
        });
        if (!result.ok) {
          await alertBox(t('添加失败'), String(result.error));
          addButton.disabled = false;
          return;
        }
        onDone?.();
        overlay.remove();
      } catch (err) {
        await alertBox(t('添加失败'), String(err?.message || err));
        addButton.disabled = false;
      }
    });
    setTimeout(() => input.focus(), 50);
  }

  // ── 追更 tab（F18）：URL + 可选选择器 → 抓取预览（前 200 字）→ 确认添加 ──
  function renderMonitorBody() {
    const urlInput = field(content, t('网页地址'), 'globe', 'https://example.com/article');
    const selectorInput = field(content, t('CSS 选择器（可选）'), 'monitorPage', t('如 #content、.article-body、article；留空自动取正文主体'));
    const folderSelect = selectField(content, t('可选分类'), 'folder', folderOptions());
    hint(content, t('保存后定时检查该网页（至少间隔 30 分钟），内容变化时生成一篇「更新」文章并高亮新增段落。'));

    const previewBox = document.createElement('div');
    content.appendChild(previewBox);

    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.className = 'btn-text bordered';
    previewButton.textContent = t('抓取预览');
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'btn-text primary';
    addButton.textContent = t('开始追更');
    setFooter([cancelButton(), previewButton, addButton]);

    previewButton.addEventListener('click', async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      const ticket = ++seq;
      previewButton.disabled = true;
      previewBox.innerHTML = '';
      previewBox.appendChild(previewStatus(t('正在抓取…')));
      try {
        const result = await window.robin.monitorPreview({ url, selector: selectorInput.value.trim() });
        if (ticket !== seq || !overlay.isConnected) return; // 已切 tab / 关闭：丢弃旧返回
        if (!result.ok) throw new Error(String(result.error || t('预览失败')));
        const data = result.data || {};
        previewBox.innerHTML = '';
        const head = previewHeader(t('网页追更'), data.title || '');
        previewBox.appendChild(head);
        const excerpt = document.createElement('div');
        excerpt.className = 'platform-preview-row';
        excerpt.style.cssText = 'font-size:12px;color:var(--text-secondary);padding:7px 10px;margin:4px 0;border:1px solid var(--separator);border-radius:8px;line-height:1.5;max-height:96px;overflow:hidden;';
        excerpt.textContent = data.excerpt || t('没有抓到页面正文，请检查地址或改用其他选择器。');
        previewBox.appendChild(excerpt);
      } catch (err) {
        if (ticket !== seq || !overlay.isConnected) return;
        previewBox.innerHTML = '';
        previewBox.appendChild(previewStatus(String(err?.message || err)));
      } finally {
        if (ticket === seq && overlay.isConnected) previewButton.disabled = false;
      }
    });

    addButton.addEventListener('click', async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      addButton.disabled = true;
      try {
        const result = await window.robin.monitorAdd({
          url, selector: selectorInput.value.trim(), folder: folderSelect.value || null,
        });
        if (!result.ok) {
          if (/会员/.test(String(result.error))) {
            overlay.remove();
            const { showUpgradeGate } = await import('./account.js');
            showUpgradeGate({ message: String(result.error) });
            return;
          }
          await alertBox(t('添加失败'), String(result.error));
          addButton.disabled = false;
          return;
        }
        onDone?.();
        overlay.remove();
      } catch (err) {
        await alertBox(t('添加失败'), String(err?.message || err));
        addButton.disabled = false;
      }
    });
    setTimeout(() => urlInput.focus(), 50);
  }

  renderTab();
}

function previewStatus(text) {
  const el = document.createElement('div');
  el.className = 'platform-preview-status';
  el.style.cssText = 'font-size:12px;color:var(--text-secondary);padding:6px 2px;';
  el.textContent = text;
  return el;
}

function previewHeader(platformName, title) {
  const el = document.createElement('div');
  el.style.cssText = 'font-size:12.5px;font-weight:700;padding:6px 2px 2px;color:var(--text-primary);';
  el.textContent = `${platformName} · ${title || ''}`;
  return el;
}

function previewRow(entry) {
  const row = document.createElement('div');
  row.className = 'platform-preview-row';
  row.style.cssText = 'display:flex;flex-direction:column;gap:2px;padding:7px 10px;margin:4px 0;border:1px solid var(--separator);border-radius:8px;';
  const title = document.createElement('div');
  title.style.cssText = 'font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  title.textContent = entry.title || '';
  const meta = document.createElement('div');
  meta.style.cssText = 'font-size:11px;color:var(--text-secondary);';
  const when = Number(entry.publishedAt) > 0
    ? new Date(Number(entry.publishedAt) * 1000).toLocaleDateString()
    : '';
  meta.textContent = when;
  row.append(title, meta);
  return row;
}

export function showAddFolder(onDone) {
  const { overlay, modal } = smallModal(t('新建文件夹'));
  const body = modal.querySelector('.sheet-body');
  const input = field(body, t('文件夹名称'), 'folder', t('例如：科技、新闻、设计'));
  hint(body, t('创建后可以将订阅源拖拽归类到此文件夹中。'));
  submitBar(modal, t('取消'), t('创建'), async () => {
    const name = input.value.trim();
    if (!name) return false;
    const result = await window.robin.addFolder(name);
    if (!result.ok) return false;
    onDone?.();
    return true;
  });
  setTimeout(() => input.focus(), 50);
}

export async function showRenameFolder(folder, onDone) {
  const { overlay, modal } = smallModal(t('重命名文件夹'));
  const body = modal.querySelector('.sheet-body');
  const input = field(body, t('新文件夹名称'), 'pencil', t('文件夹名称'));
  input.value = folder.name;
  submitBar(modal, t('取消'), t('保存'), async () => {
    const name = input.value.trim();
    if (!name || name === folder.name) return false;
    const result = await window.robin.renameFolder(folder.id, name);
    if (!result.ok) return false;
    onDone?.(name);
    return true;
  });
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

export function showFreshRSSAccount(onAdded) {
  const { overlay, modal } = smallModal(t('添加 FreshRSS 账号'));
  const body = modal.querySelector('.sheet-body');
  // 服务类型下拉：Miniflux 与 FreshRSS 共用同一账户类型（freshRSS），
  // 差异只在端点地址（Miniflux 的 Google Reader API base 以 /greader 结尾）
  const serviceSelect = selectField(body, t('服务类型'), 'server', [
    ['freshrss', t('FreshRSS')],
    ['miniflux', t('Miniflux（Google Reader API）')],
  ]);
  const nameInput = field(body, t('显示名称'), 'person', 'FreshRSS');
  const endpointInput = field(body, t('服务器地址'), 'server', 'https://freshrss.example.com');
  const userInput = field(body, t('用户名'), 'person', 'api_user');
  const passwordInput = field(body, t('应用专用密码'), 'general', '', true);
  const freshRSSHint = t('在 FreshRSS 网页「设置 → 账户 → API 管理」中开启 API 并生成应用专用密码。');
  const minifluxHint = t('Miniflux 用户：地址填 https://你的实例/greader（2.42+ 内置 Google Reader API），裸域名会自动补 /greader；在 Miniflux「设置 → 集成」中启用 Google Reader API 并使用其专用用户名与密码。');
  const hintEl = hint(body, freshRSSHint);

  const applyServiceUI = () => {
    const isMiniflux = serviceSelect.value === 'miniflux';
    endpointInput.placeholder = isMiniflux ? 'https://miniflux.example.com/greader' : 'https://freshrss.example.com';
    nameInput.placeholder = isMiniflux ? 'Miniflux' : 'FreshRSS';
    hintEl.textContent = isMiniflux ? minifluxHint : freshRSSHint;
  };
  serviceSelect.addEventListener('change', applyServiceUI);

  submitBar(modal, t('取消'), t('验证并添加'), async (button) => {
    const isMiniflux = serviceSelect.value === 'miniflux';
    let endpointURL = endpointInput.value.trim();
    if (isMiniflux && /^https?:\/\/[^/]+\/?$/i.test(endpointURL)) {
      // Miniflux 预设：裸域名补 /greader（与主进程 normalizeMinifluxEndpoint 同规则的轻量副本）
      endpointURL = `${endpointURL.replace(/\/+$/, '')}/greader`;
    }
    const payload = {
      displayName: nameInput.value.trim() || (isMiniflux ? 'Miniflux' : 'FreshRSS'),
      endpointURL,
      username: userInput.value.trim(),
      password: passwordInput.value,
      service: isMiniflux ? 'miniflux' : null,
    };
    if (!payload.endpointURL || !payload.username || !payload.password) return false;
    button.textContent = t('正在验证…');
    const validate = await window.robin.validateFreshRSS(payload);
    if (!validate.ok) {
      button.textContent = t('验证并添加');
      await alertBox(t('验证失败'), String(validate.error));
      return false;
    }
    const result = await window.robin.addFreshRSSAccount(payload);
    button.textContent = t('验证并添加');
    if (!result.ok) {
      await alertBox(t('添加失败'), String(result.error));
      return false;
    }
    onAdded?.();
    return true;
  });
}

/**
 * 添加邮箱账户（F6）：IMAP host/port/用户名/密码 + 自签名放行（明示风险）。
 * 「测试连接」走真实 LOGIN+SELECT+LOGOUT；密码只在添加时传给主进程，落 CredentialStore。
 */
export function showAddMailAccount(onAdded) {
  const { overlay, modal } = smallModal(t('添加邮箱'));
  const body = modal.querySelector('.sheet-body');

  const hostInput = field(body, t('IMAP 服务器'), 'server', t('例如：imap.qq.com、imap.gmail.com'));
  const portInput = field(body, t('端口'), 'general', '993');
  portInput.value = '993';
  const userInput = field(body, t('账号'), 'person', t('完整邮箱地址'));
  const passwordInput = field(body, t('密码 / 授权码'), 'general', '', true);
  const hintEl = hint(body, t('多数邮箱需先在网页版设置开启 IMAP，并使用授权码或应用专用密码登录。密码经系统加密只保存在本机。'));

  // 自签名放行（默认关；开启时把提示换成风险文案）
  const riskRow = document.createElement('label');
  riskRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:2px 2px 0;font-size:12px;color:var(--text-secondary);cursor:pointer;';
  const riskCheck = document.createElement('input');
  riskCheck.type = 'checkbox';
  const riskText = document.createElement('span');
  riskText.textContent = t('允许自签名证书（仅限可信内网，有安全风险）');
  riskRow.append(riskCheck, riskText);
  body.appendChild(riskRow);
  riskCheck.addEventListener('change', () => {
    hintEl.textContent = riskCheck.checked
      ? t('已选择信任自签名证书：该服务器身份无法被验证，凭据与邮件可能被中间人窃取。仅在你明确信任该服务器时开启。')
      : t('多数邮箱需先在网页版设置开启 IMAP，并使用授权码或应用专用密码登录。密码经系统加密只保存在本机。');
  });

  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;min-height:16px;color:var(--text-secondary);padding:6px 2px 0;';
  body.appendChild(status);

  const collect = () => ({
    host: hostInput.value.trim(),
    port: Number(portInput.value.trim()) || 993,
    username: userInput.value.trim(),
    password: passwordInput.value,
    allowSelfSigned: riskCheck.checked,
  });

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'btn-text';
  cancelButton.textContent = t('取消');
  cancelButton.addEventListener('click', () => overlay.remove());

  const testButton = document.createElement('button');
  testButton.type = 'button';
  testButton.className = 'btn-text bordered';
  testButton.textContent = t('测试连接');
  testButton.addEventListener('click', async () => {
    const payload = collect();
    if (!payload.host || !payload.username || !payload.password) {
      status.textContent = t('请先填写服务器、账号与密码。');
      return;
    }
    testButton.disabled = true;
    status.textContent = t('正在连接…');
    try {
      const result = await window.robin.mailTest(payload);
      status.textContent = result.ok
        ? tf('连接正常 · 收件箱 %lld 封 · %lldms', result.data?.messageCount ?? 0, result.data?.elapsedMs ?? 0)
        : t('连接失败：') + String(result.error || '');
    } catch (err) {
      status.textContent = t('连接失败：') + String(err?.message || err);
    } finally {
      testButton.disabled = false;
    }
  });

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'btn-text primary';
  addButton.textContent = t('添加');
  addButton.addEventListener('click', async () => {
    const payload = collect();
    if (!payload.host || !payload.username || !payload.password) {
      status.textContent = t('请先填写服务器、账号与密码。');
      return;
    }
    addButton.disabled = true;
    try {
      const result = await window.robin.mailAdd(payload);
      if (!result.ok) {
        await alertBox(t('添加失败'), String(result.error || ''));
        addButton.disabled = false;
        return;
      }
      onAdded?.();
      overlay.remove();
    } catch (err) {
      await alertBox(t('添加失败'), String(err?.message || err));
      addButton.disabled = false;
    }
  });

  const footer = modal.querySelector('.modal-footer');
  footer.append(cancelButton, testButton, addButton);
  setTimeout(() => hostInput.focus(), 50);
}

// MARK: - 构建工具

/**
 * 规则编辑器（F2）：名称 / 作用域（全局或指定源多选）/ 条件行（增删+正则即时校验）/
 * 动作多选（标已读、收藏、稍后读、打标签）/ 规则测试器（粘贴或从最近文章选样本，
 * 实时显示逐条件命中与将执行的动作）。保存走 rules:save（主进程全量校验）。
 */
export function showRuleEditor({ feeds = [], rule = null, onSaved }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) overlay.remove(); });
  const modal = document.createElement('div');
  modal.className = 'modal small rule-editor';
  modal.innerHTML = `
    <div class="modal-main">
      <div class="modal-header"><h3></h3></div>
      <div class="sheet-body rule-editor-body"></div>
      <div class="modal-footer"></div>
    </div>`;
  modal.querySelector('h3').textContent = rule ? t('编辑规则') : t('新建规则');
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  const esc = (event) => {
    if (event.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  };
  document.addEventListener('keydown', esc);

  const body = modal.querySelector('.sheet-body');

  const FIELD_OPTIONS = [
    ['title', t('标题')], ['summary', t('摘要')], ['author', t('作者')],
    ['url', t('URL')], ['body', t('正文')],
  ];
  const OP_OPTIONS = [
    ['contains', t('包含')], ['notContains', t('不包含')], ['regex', t('正则匹配')],
    ['notRegex', t('正则不匹配')], ['startsWith', t('以…开头')], ['endsWith', t('以…结尾')],
  ];

  // ── 名称 ──
  const nameInput = field(body, t('规则名称'), 'pencil', t('例如：周报自动已读'));

  // ── 作用域 ──
  const scopeBlock = document.createElement('div');
  scopeBlock.className = 'rule-block';
  const scopeLabel = document.createElement('div');
  scopeLabel.className = 'rule-block-label';
  scopeLabel.textContent = t('作用域');
  const scopeSelect = document.createElement('select');
  scopeSelect.className = 'control';
  scopeSelect.innerHTML = `<option value="all"></option><option value="feeds"></option>`;
  scopeSelect.options[0].textContent = t('全部订阅源（全局）');
  scopeSelect.options[1].textContent = t('指定订阅源…');
  scopeBlock.append(scopeLabel, scopeSelect);
  const feedPick = document.createElement('div');
  feedPick.className = 'rule-feed-pick';
  const renderFeedPick = (selectedIDs) => {
    feedPick.innerHTML = '';
    if (!feeds.length) {
      const empty = document.createElement('div');
      empty.className = 'rule-feed-empty';
      empty.textContent = t('还没有订阅源。');
      feedPick.appendChild(empty);
      return;
    }
    for (const feed of feeds) {
      const item = document.createElement('label');
      item.className = 'rule-feed-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedIDs.includes(feed.id);
      checkbox.dataset.feedID = feed.id;
      const text = document.createElement('span');
      text.textContent = feed.title; // textContent：源名不可信回显安全
      item.append(checkbox, text);
      feedPick.appendChild(item);
    }
  };
  scopeBlock.appendChild(feedPick);
  body.appendChild(scopeBlock);
  const syncScopeUI = () => {
    const scoped = scopeSelect.value === 'feeds';
    feedPick.style.display = scoped ? '' : 'none';
  };
  scopeSelect.addEventListener('change', syncScopeUI);

  // ── 条件 ──
  const condBlock = document.createElement('div');
  condBlock.className = 'rule-block';
  const condHead = document.createElement('div');
  condHead.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;';
  const condLabel = document.createElement('div');
  condLabel.className = 'rule-block-label';
  condLabel.style.margin = '0';
  condLabel.textContent = t('条件');
  let matchMode = rule?.match === 'any' ? 'any' : 'all';
  let testTimer = null;
  const scheduleTest = () => {
    clearTimeout(testTimer);
    testTimer = setTimeout(() => runTest(), 300);
  };
  const matchSeg = segmented([['all', t('全部满足')], ['any', t('任一满足')]], matchMode, (value) => {
    matchMode = value;
    scheduleTest();
  });
  condHead.append(condLabel, matchSeg);
  condBlock.appendChild(condHead);
  const condRows = document.createElement('div');
  condRows.className = 'rule-cond-rows';
  condBlock.appendChild(condRows);
  const addCondButton = document.createElement('button');
  addCondButton.className = 'btn-text bordered rule-add-cond';
  addCondButton.innerHTML = `${icon('plus')}<span style="margin-left:5px"></span>`;
  addCondButton.querySelector('span').textContent = t('添加条件');
  condBlock.appendChild(addCondButton);
  body.appendChild(condBlock);

  const makeCondRow = (condition = { field: 'title', op: 'contains', value: '' }) => {
    const row = document.createElement('div');
    row.className = 'rule-cond-row';
    const fieldSel = document.createElement('select');
    fieldSel.className = 'control';
    for (const [value, text] of FIELD_OPTIONS) {
      const option = document.createElement('option');
      option.value = value; option.textContent = text;
      fieldSel.appendChild(option);
    }
    fieldSel.value = condition.field;
    const opSel = document.createElement('select');
    opSel.className = 'control';
    for (const [value, text] of OP_OPTIONS) {
      const option = document.createElement('option');
      option.value = value; option.textContent = text;
      opSel.appendChild(option);
    }
    opSel.value = condition.op;
    const valueInput = document.createElement('input');
    valueInput.className = 'control rule-cond-value';
    valueInput.placeholder = t('关键词或正则…');
    valueInput.value = condition.value ?? '';
    const errLine = document.createElement('div');
    errLine.className = 'rule-regex-error';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn icon-only';
    removeBtn.title = t('删除条件');
    removeBtn.setAttribute('aria-label', t('删除条件'));
    removeBtn.innerHTML = icon('trash');
    removeBtn.addEventListener('click', () => {
      row.remove();
      if (condRows.children.length === 0) addCondRow(); // 至少保留一行
      scheduleTest();
    });
    row.append(fieldSel, opSel, valueInput, removeBtn, errLine);
    const validateValue = () => {
      const op = opSel.value;
      const value = valueInput.value.trim();
      const isRegex = op === 'regex' || op === 'notRegex';
      let problem = null;
      if (value) {
        if (value.length > 200) problem = t('条件值过长（最多 200 字，正则同限）。');
        else if (isRegex) problem = regexProblem(value);
      }
      errLine.textContent = problem || '';
      valueInput.classList.toggle('invalid', Boolean(problem));
    };
    valueInput.addEventListener('input', () => { validateValue(); scheduleTest(); });
    opSel.addEventListener('change', () => { validateValue(); scheduleTest(); });
    fieldSel.addEventListener('change', scheduleTest);
    validateValue();
    return row;
  };
  const addCondRow = (condition) => condRows.appendChild(makeCondRow(condition));
  addCondButton.addEventListener('click', () => { addCondRow(); scheduleTest(); });

  // ── 动作 ──
  const actionBlock = document.createElement('div');
  actionBlock.className = 'rule-block';
  const actionLabel = document.createElement('div');
  actionLabel.className = 'rule-block-label';
  actionLabel.textContent = t('动作（可多选）');
  actionBlock.appendChild(actionLabel);
  const actionChips = document.createElement('div');
  actionChips.className = 'rule-action-chips';
  const chipFor = (actionKey, label) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'rule-action-chip';
    chip.dataset.action = actionKey;
    chip.textContent = label;
    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
      scheduleTest();
    });
    return chip;
  };
  const readChip = chipFor('read', t('标为已读'));
  const starChip = chipFor('star', t('收藏'));
  const laterChip = chipFor('later', t('加入稍后读'));
  actionChips.append(readChip, starChip, laterChip);
  actionBlock.appendChild(actionChips);
  const tagInput = document.createElement('input');
  tagInput.className = 'control rule-tag-input';
  tagInput.placeholder = t('打标签（多个用逗号分隔，留空则不打）');
  actionBlock.appendChild(tagInput);
  const tagErr = document.createElement('div');
  tagErr.className = 'rule-regex-error';
  actionBlock.appendChild(tagErr);
  const parseTags = () => tagInput.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  tagInput.addEventListener('input', () => {
    const bad = parseTags().some((tag) => tag.length > 50 || /[\x00-\x1f]/.test(tag));
    tagErr.textContent = bad ? t('标签名长度需在 1-50 字之间。') : '';
    scheduleTest();
  });
  body.appendChild(actionBlock);

  // ── 规则测试器 ──
  const testBlock = document.createElement('div');
  testBlock.className = 'rule-block rule-test-block';
  const testHead = document.createElement('div');
  testHead.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;';
  const testLabel = document.createElement('div');
  testLabel.className = 'rule-block-label';
  testLabel.style.margin = '0';
  testLabel.textContent = t('规则测试器');
  const sampleSelect = document.createElement('select');
  sampleSelect.className = 'control';
  sampleSelect.innerHTML = `<option value="custom"></option>`;
  sampleSelect.options[0].textContent = t('自定义样本（直接粘贴）');
  testHead.append(testLabel, sampleSelect);
  testBlock.appendChild(testHead);
  hint(testBlock, t('粘贴或从最近文章选一篇样本，实时预览逐条件命中与将执行的动作。'));

  const sampleFields = {};
  for (const [key, label] of [['title', t('标题')], ['author', t('作者')], ['url', t('URL')], ['summary', t('摘要')], ['body', t('正文')]]) {
    const wrap = document.createElement('label');
    wrap.className = 'sheet-field';
    const labelEl = document.createElement('div');
    labelEl.textContent = label;
    const input = key === 'body' || key === 'summary' ? document.createElement('textarea') : document.createElement('input');
    input.className = 'control wide';
    if (key === 'body') input.rows = 3;
    if (key === 'summary') input.rows = 2;
    input.addEventListener('input', () => { sampleSelect.value = 'custom'; scheduleTest(); });
    wrap.append(labelEl, input);
    sampleFields[key] = input;
    testBlock.appendChild(wrap);
  }
  const testResult = document.createElement('div');
  testResult.className = 'rule-test-result';
  testResult.setAttribute('aria-live', 'polite');
  testBlock.appendChild(testResult);
  body.appendChild(testBlock);

  // 测试执行：表单 → rules:test（主进程同一套匹配与校验，所见即所得）
  const collect = () => {
    const conditions = [...condRows.querySelectorAll('.rule-cond-row')].map((row) => {
      const [fieldSel, opSel, valueInput] = row.querySelectorAll('select, input.rule-cond-value');
      return { field: fieldSel.value, op: opSel.value, value: valueInput.value.trim() };
    });
    const actions = [...actionChips.querySelectorAll('.rule-action-chip.active')].map((chip) => chip.dataset.action);
    for (const tag of parseTags()) actions.push(`tag:${tag}`);
    const scope = scopeSelect.value === 'feeds'
      ? { kind: 'feeds', ids: [...feedPick.querySelectorAll('input:checked')].map((el) => el.dataset.feedID) }
      : { kind: 'all' };
    return {
      id: rule?.id ?? null,
      name: nameInput.value.trim(),
      scope,
      match: matchMode,
      conditions,
      actions,
      enabled: true,
    };
  };
  const runTest = async () => {
    const payload = collect();
    const complete = payload.conditions.length >= 1 && payload.conditions.every((c) => c.field && c.op && c.value);
    if (!complete) {
      testResult.innerHTML = '';
      const note = document.createElement('div');
      note.className = 'rule-test-hint';
      note.textContent = t('补全条件后自动预览命中结果。');
      testResult.appendChild(note);
      return;
    }
    const sample = {
      title: sampleFields.title.value, author: sampleFields.author.value,
      url: sampleFields.url.value, summary: sampleFields.summary.value, body: sampleFields.body.value,
    };
    const result = await window.robin.rulesTest(payload, sample);
    testResult.innerHTML = '';
    if (!result) {
      const bad = document.createElement('div');
      bad.className = 'rule-test-hint rule-test-invalid';
      bad.textContent = t('规则尚未通过校验，修正后可预览。');
      testResult.appendChild(bad);
      return;
    }
    const verdict = document.createElement('div');
    verdict.className = `rule-test-verdict ${result.matched ? 'hit' : 'miss'}`;
    verdict.innerHTML = `${icon(result.matched ? 'checkCircle' : 'questionCircle')}<span></span>`;
    verdict.querySelector('span').textContent = result.matched ? t('命中：将执行以下动作') : t('未命中：不执行动作');
    testResult.appendChild(verdict);
    const list = document.createElement('div');
    list.className = 'rule-test-conditions';
    result.conditions.forEach((condition) => {
      const item = document.createElement('div');
      item.className = `rule-test-cond ${condition.hit ? 'hit' : 'miss'}`;
      const fieldText = (FIELD_OPTIONS.find(([v]) => v === condition.field) || ['', condition.field])[1];
      const opText = (OP_OPTIONS.find(([v]) => v === condition.op) || ['', condition.op])[1];
      item.innerHTML = `${icon(condition.hit ? 'checkCircle' : 'close')}<span class="cond"></span>`;
      const condEl = item.querySelector('.cond');
      condEl.textContent = `${fieldText} ${opText} ${condition.value}`;
      list.appendChild(item);
    });
    testResult.appendChild(list);
    if (result.matched && result.actions.length) {
      const actionsLine = document.createElement('div');
      actionsLine.className = 'rule-test-actions';
      const labels = { read: t('标为已读'), star: t('收藏'), later: t('加入稍后读') };
      actionsLine.textContent = result.actions.map((action) => action.startsWith('tag:')
        ? `${t('打标签')}：${action.slice(4)}` : labels[action] || action).join(' · ');
      testResult.appendChild(actionsLine);
    }
  };

  // 最近样本下拉（异步载入；选中即填充样本字段）
  window.robin.rulesSamples(20).then((samples) => {
    for (const sample of samples || []) {
      const option = document.createElement('option');
      option.value = sample.id;
      option.textContent = sample.title || sample.id;
      sampleSelect.appendChild(option);
    }
    sampleSelect.addEventListener('change', () => {
      const picked = (samples || []).find((s) => s.id === sampleSelect.value);
      if (!picked) return;
      sampleFields.title.value = picked.title || '';
      sampleFields.author.value = picked.author || '';
      sampleFields.url.value = picked.url || '';
      sampleFields.summary.value = picked.summary || '';
      sampleFields.body.value = picked.body || '';
      scheduleTest();
    });
  }).catch(() => { /* 样本拉取失败：仍可手贴样本 */ });

  // ── 初始值回填 ──
  if (rule) {
    nameInput.value = rule.name || '';
    scopeSelect.value = rule.scope?.kind === 'feeds' ? 'feeds' : 'all';
    renderFeedPick(rule.scope?.kind === 'feeds' ? rule.scope.ids : []);
    for (const condition of (rule.conditions?.length ? rule.conditions : [{}])) addCondRow(condition);
    for (const chip of actionChips.querySelectorAll('.rule-action-chip')) {
      chip.classList.toggle('active', (rule.actions || []).includes(chip.dataset.action));
    }
    tagInput.value = (rule.actions || []).filter((a) => a.startsWith('tag:')).map((a) => a.slice(4)).join(', ');
  } else {
    renderFeedPick([]);
    addCondRow();
  }
  syncScopeUI();

  // ── 保存 ──
  submitBar(modal, t('取消'), t('保存'), async (button) => {
    const payload = collect();
    if (!payload.name) { await alertBox(t('无法保存'), t('请填写规则名称。')); return false; }
    button.textContent = t('保存中…');
    const result = await window.robin.rulesSave(payload);
    if (!result.ok) {
      await alertBox(t('无法保存'), String(result.error || t('请检查规则配置。')));
      return false;
    }
    onSaved?.();
    return true;
  });

  scheduleTest(); // 初始（新建空态 → 提示补全条件）
}

/** 正则即时校验（与主进程同一套规则：长度/编译/嵌套量词）。返回错误文案或 null。 */
function regexProblem(value) {
  if (!value) return null;
  if (value.length > 200) return t('正则过长（最多 200 字）。');
  try { new RegExp(value, 'i'); } catch (_) { return t('正则表达式无法编译，请检查语法。'); }
  if (/(?:\((?:[^()\\]|\\.|\([^()]*\))*[+*}]\s*\)|\[[^\]]*[+*}]\s*\])[+*{]/.test(value)) {
    return t('正则含嵌套量词（如 (a+)+），有灾难性回溯风险，已被拒绝。');
  }
  return null;
}

/** 设置弹层内轻量 toast（U13：委托自绘 toast 栈，与 app.js 全局提示同栈同语言）。 */
function showToast(message, duration = 1800) {
  return Toast.show(message, { duration });
}

/** F11：Obsidian 导出结果 toast 文案（新增/更新/跳过 + 截断标注）。 */
function exportResultText(stats) {
  const base = tf('导出完成：新增 %lld · 更新 %lld · 跳过 %lld',
    Number(stats?.added) || 0, Number(stats?.updated) || 0, Number(stats?.skipped) || 0);
  return stats?.truncated ? `${base} · ${t('已达单次 2000 文件上限，本次将截断。')}` : base;
}

function group(title, footer, rows) {
  const el = document.createElement('div');
  el.className = 'settings-group';
  el.innerHTML = `<div class="settings-group-header"></div><div class="group-rows"></div>`;
  el.querySelector('.settings-group-header').textContent = title;
  for (const rowEl of rows) el.querySelector('.group-rows').appendChild(rowEl);
  if (footer) {
    const footerEl = document.createElement('div');
    footerEl.className = 'settings-group-footer';
    footerEl.textContent = footer;
    el.appendChild(footerEl);
  }
  return el;
}

function row(title, desc, control) {
  const el = document.createElement('div');
  el.className = 'setting-row';
  el.innerHTML = `<div class="setting-label"><div class="title"></div><div class="desc" style="display:none"></div></div>`;
  el.querySelector('.title').textContent = title;
  if (desc) {
    el.querySelector('.desc').textContent = desc;
    el.querySelector('.desc').style.display = '';
  }
  if (control) {
    const wrap = document.createElement('div');
    wrap.className = 'setting-control';
    wrap.appendChild(control);
    el.appendChild(wrap);
  }
  return el;
}

function iconRow(iconName, title, desc, control) {
  const el = row(title, desc, control);
  const iconEl = document.createElement('span');
  iconEl.className = 'setting-icon';
  iconEl.innerHTML = icon(iconName);
  el.insertBefore(iconEl, el.firstChild);
  el.classList.add('with-icon');
  return el;
}

function toggleRow(title, desc, initial, onChange) {
  return row(title, desc, toggleControl(initial, onChange));
}

function inputRow(title, desc, placeholder, initial, onChange, options = {}) {
  const input = document.createElement('input');
  input.className = 'control';
  input.style.minWidth = '200px';
  input.placeholder = placeholder || '';
  if (options.password) input.type = 'password';
  if (options.placeholderFilled && initial == null && options.password) input.placeholder = '••••••••';
  input.value = initial ?? '';
  let timer = null;
  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onChange(input.value), 600);
  });
  return row(title, desc, input);
}

function textAreaRow(initial, onChange) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding: 4px 16px 10px;';
  const area = document.createElement('textarea');
  area.className = 'control';
  area.style.cssText = 'width:100%;min-height:70px;max-height:120px;resize:vertical;line-height:1.5;';
  area.value = initial;
  let timer = null;
  area.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onChange(area.value), 600);
  });
  wrap.appendChild(area);
  return plain(wrap);
}

function segmented(options, current, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'segmented';
  for (const [value, label] of options) {
    const button = document.createElement('button');
    button.textContent = label;
    button.classList.toggle('active', value === current);
    button.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      onChange(value);
    });
    wrap.appendChild(button);
  }
  return wrap;
}

function toggleControl(initial, onChange) {
  const toggle = document.createElement('button');
  toggle.className = `toggle ${initial ? 'on' : ''}`;
  toggle.addEventListener('click', async () => {
    const next = !toggle.classList.contains('on');
    toggle.classList.toggle('on', next);
    await onChange(next);
  });
  return toggle;
}

function selectControl(options, current, onChange) {
  const select = document.createElement('select');
  select.className = 'control';
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = String(value) === String(current);
    select.appendChild(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function staticText(text) {
  const el = document.createElement('span');
  el.style.cssText = 'font-size:12px;color:var(--text-secondary);max-width:240px;text-align:right;';
  el.textContent = text;
  return el;
}

function linkBtn(label, onClick, bordered = false) {
  const button = document.createElement('button');
  button.className = `btn-text ${bordered ? 'bordered' : 'primary'}`;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function plain(el) {
  const wrap = document.createElement('div');
  wrap.style.marginBottom = '14px';
  wrap.appendChild(el);
  return wrap;
}

function actionAddHost(button) {
  const wrap = document.createElement('div');
  wrap.style.padding = '0 4px';
  wrap.appendChild(button);
  return wrap;
}

function intervalLabel(rawValue) {
  const map = {
    thirtyMinutes: '每 30 分钟', oneHour: '每小时', twoHours: '每 2 小时',
    fourHours: '每 4 小时', eightHours: '每 8 小时',
  };
  return t(map[rawValue] || rawValue);
}

// MARK: - Sheet 工具

function smallModal(title) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) overlay.remove();
  });
  const modal = document.createElement('div');
  modal.className = 'modal small';
  modal.innerHTML = `
    <div class="modal-main">
      <div class="modal-header"><h3></h3></div>
      <div class="sheet-body"></div>
      <div class="modal-footer"></div>
    </div>`;
  modal.querySelector('h3').textContent = title;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  const esc = (event) => {
    if (event.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', esc);
    }
  };
  document.addEventListener('keydown', esc);
  return { overlay, modal };
}

function field(container, label, iconName, placeholder, password = false) {
  const wrap = document.createElement('label');
  wrap.className = 'sheet-field';
  wrap.innerHTML = `<label></label>`;
  const labelEl = document.createElement('div');
  labelEl.className = '';
  labelEl.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;';
  labelEl.innerHTML = `${icon(iconName)}<span></span>`;
  labelEl.querySelector('span').textContent = label;
  wrap.innerHTML = '';
  const input = document.createElement('input');
  input.className = 'control wide';
  input.placeholder = placeholder || '';
  if (password) input.type = 'password';
  wrap.append(labelEl, input);
  container.appendChild(wrap);
  return input;
}

function selectField(container, label, iconName, options) {
  const wrap = document.createElement('label');
  wrap.className = 'sheet-field';
  const labelEl = document.createElement('div');
  labelEl.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;';
  labelEl.innerHTML = `${icon(iconName)}<span></span>`;
  labelEl.querySelector('span').textContent = label;
  const select = document.createElement('select');
  select.className = 'control wide';
  for (const [value, text] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  }
  wrap.append(labelEl, select);
  container.appendChild(wrap);
  return select;
}

function hint(container, text) {
  const el = document.createElement('p');
  el.className = 'sheet-hint';
  el.textContent = text;
  container.appendChild(el);
  return el; // 返回引用，便于按表单状态切换提示文案
}

function submitBar(modal, cancelLabel, confirmLabel, onSubmit) {
  const footer = modal.querySelector('.modal-footer');
  const cancelButton = document.createElement('button');
  cancelButton.className = 'btn-text';
  cancelButton.textContent = cancelLabel;
  cancelButton.addEventListener('click', () => modal.closest('.modal-overlay').remove());

  const confirmButton = document.createElement('button');
  confirmButton.className = 'btn-text primary';
  confirmButton.textContent = confirmLabel;
  confirmButton.addEventListener('click', async () => {
    confirmButton.disabled = true;
    const original = confirmButton.textContent;
    try {
      const ok = await onSubmit(confirmButton);
      if (ok !== false) modal.closest('.modal-overlay').remove();
      else confirmButton.disabled = false;
    } catch (err) {
      await alertBox(t('出错了'), String(err?.message || err));
      confirmButton.disabled = false;
    } finally {
      confirmButton.textContent = original;
    }
  });
  footer.append(cancelButton, confirmButton);
}

function escapeHTML(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 秒级时间戳 → 相对时间（F15 知识分区「上次运行」回显）。 */
function timeAgoSecondsAgo(seconds) {
  const diff = Math.max(0, Date.now() / 1000 - Number(seconds || 0));
  const m = Math.floor(diff / 60), h = Math.floor(diff / 3600), d = Math.floor(diff / 86400);
  if (d > 0) return tf('%lld 天前', d);
  if (h > 0) return tf('%lld 小时前', h);
  if (m > 0) return tf('%lld 分钟前', m);
  return t('刚刚');
}

function attr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
