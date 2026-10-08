'use strict';
/**
 * RobinRead Windows — 知识中心
 * 高亮 / 笔记 / 间隔复习 / 收藏集 / 统计 / 标签云
 */
import { t, tf } from '../i18n.js';
import { icon } from '../icons.js';
import { promptBox, confirmBox } from '../ui-prompt.js';
import { renderMarkdown } from '../markdown.js';

const TABS = [
  { id: 'dashboard', label: '看板', icon: 'general' },
  { id: 'highlights', label: '高亮', icon: 'highlight' },
  { id: 'notes', label: '笔记', icon: 'pencil' },
  { id: 'review', label: '复习', icon: 'refresh' },
  { id: 'collections', label: '收藏集', icon: 'folder' },
  { id: 'smartfolders', label: '智能文件夹', icon: 'ai' },
  { id: 'review-daily', label: '回顾', icon: 'clock' },
  { id: 'search', label: '搜索', icon: 'search' },
  { id: 'heatmap', label: '热力图', icon: 'heart' },
  { id: 'stats', label: '统计', icon: 'general' },
  { id: 'tags', label: '标签', icon: 'globe' },
  { id: 'graph', label: '图谱', icon: 'ai' },
  { id: 'ask', label: '全库问答', icon: 'spark' },
  { id: 'research', label: 'AI 研究', icon: 'spark' },
  { id: 'threads', label: '线索', icon: 'search' },
  { id: 'dash', label: '源体检', icon: 'flame' },
];

// F15 复核过滤 chips：标签云按来源过滤展示（只过滤，不改数据）
const TAG_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'manual', label: '手动' },
  { id: 'ai', label: 'AI' },
  { id: 'inherit', label: '继承' },
];

function timeAgo(seconds) {
  if (!seconds) return '';
  const diff = Math.max(0, Date.now() / 1000 - seconds);
  const m = Math.floor(diff / 60), h = Math.floor(diff / 3600), d = Math.floor(diff / 86400);
  if (d > 0) return tf('%lld 天前', d);
  if (h > 0) return tf('%lld 小时前', h);
  if (m > 0) return tf('%lld 分钟前', m);
  return t('刚刚');
}

function downloadText(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export class KnowledgeCenter {
  constructor({ onOpenArticle, onOpenSmartFolder, onFilterTag, onOpenURL }) {
    this.handlers = { onOpenArticle, onOpenSmartFolder, onFilterTag, onOpenURL };
    this.tab = 'highlights';
    this.data = {};
    // AI 研究（F8）会话态：流式运行标记 + 订阅退订器
    this._research = { running: false, mode: null, unsubscribe: null, seq: 0 };
    // 全库问答（F9）会话态：当前会话 ID + 流式运行标记 + 订阅退订器
    this._rag = { running: false, mode: null, unsubscribe: null, seq: 0, sessionID: null };
    // F15 复核过滤：标签云当前来源过滤（只过滤展示，不改数据）
    this.tagFilter = 'all';
    // F16 源体检：总览卡点击过滤（null=不过滤）+ 当前展开的源详情
    this.dashFilter = null;
  }

  present(initialTab = null) {
    if (initialTab && TABS.some((x) => x.id === initialTab)) this.tab = initialTab;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) this.dismiss(); });
    this.modal = document.createElement('div');
    this.modal.className = 'modal';
    overlay.appendChild(this.modal);
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this._esc = (e) => { if (e.key === 'Escape') this.dismiss(); };
    document.addEventListener('keydown', this._esc);
    this._render();
    this._load();
  }

  dismiss() {
    this._cleanupSession();
    document.removeEventListener('keydown', this._esc);
    this.overlay?.remove();
    this.overlay = null;
  }

  async _load() {
    const loads = {
      dashboard: async () => {
        const [dash, heat, tags, goal, goals] = await Promise.all([
          window.robin.kbDashboard(),
          window.robin.kbHeatmap(30),
          window.robin.kbTags(),
          window.robin.statsGetGoal?.() ?? 5,
          window.robin.goalProgress?.().catch(() => null), // F20：目标进度聚合（日/周）
        ]);
        return { ...dash, heat: heat?.map || {}, tags, goal, goals };
      },
      highlights: async () => (await window.robin.kbAllHighlights()).slice(0, 100),
      notes: async () => (await window.robin.kbNotes()).slice(0, 80),
      review: async () => window.robin.kbDueReviews(),
      collections: async () => window.robin.kbCollections(),
      smartfolders: async () => window.robin.kbSmartFolders(),
      'review-daily': async () => window.robin.kbDailyReview(),
      search: async () => ({ query: '' }),
      heatmap: async () => window.robin.kbHeatmap(365),
      stats: async () => window.robin.kbStats(30),
      tags: async () => ({ all: await window.robin.kbTags(), rows: await window.robin.kbTagsSource() }),
      graph: async () => window.robin.kbGraph(240),
      ask: async () => ({ sessions: (await window.robin.ragSessions()) || [] }),
      research: async () => window.robin.researchList(),
      threads: async () => window.robin.threadsList(), // F13：线索聚类（_renderThreads 自取详情）
      dash: async () => window.robin.dashOverview(), // F16：源体检总览（60s 缓存）
    };
    const loader = loads[this.tab];
    if (!loader) return;
    const result = await loader();
    this.data[this.tab] = result;
    this._renderContent();
  }

  _render() {
    this._cleanupSession();
    if (!this.modal) return;
    this.modal.innerHTML = '';
    const sidebar = document.createElement('div');
    sidebar.className = 'modal-sidebar';
    sidebar.innerHTML = `<h2>${escapeHTML(t('知识中心'))}</h2>`;
    for (const tab of TABS) {
      const item = document.createElement('div');
      item.className = `modal-nav-item ${tab.id === this.tab ? 'active' : ''}`;
      item.innerHTML = `<span class="nav-icon">${icon(tab.icon)}</span><span></span>`;
      item.querySelector('span:last-child').textContent = t(tab.label);
      item.addEventListener('click', () => { this.tab = tab.id; this._render(); this._load(); });
      sidebar.appendChild(item);
    }
    this.modal.appendChild(sidebar);
    const main = document.createElement('div');
    main.className = 'modal-main';
    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `<h3>${escapeHTML(t(TABS.find((x) => x.id === this.tab)?.label || ''))}</h3>`;
    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn-text bordered';
    exportBtn.innerHTML = `${icon('export')}<span style="margin-left:5px">${escapeHTML(t('导出'))}</span>`;
    exportBtn.addEventListener('click', (event) => this._showExportMenu(event, exportBtn));
    header.appendChild(exportBtn);
    const close = document.createElement('button');
    close.className = 'btn icon-only';
    close.innerHTML = icon('close');
    close.addEventListener('click', () => this.dismiss());
    header.appendChild(close);
    main.appendChild(header);
    this.contentHost = document.createElement('div');
    this.contentHost.className = 'modal-scroll';
    this.contentHost.innerHTML = `<div class="list-empty"><div class="glyph">${icon('spark')}</div><h3>${escapeHTML(t('加载中…'))}</h3></div>`;
    main.appendChild(this.contentHost);
    this.modal.appendChild(main);
  }

  async _showExportMenu(event, anchor) {
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${rect.right - 180}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    const items = [
      { label: t('导出 Markdown'), icon: 'pencil', action: async () => { const md = await window.robin.kbExportNotes(); downloadText('robinread-knowledge.md', md, 'text/markdown'); } },
      { label: t('导出 JSON'), icon: 'import', action: async () => { const json = await window.robin.kbExportJSON(); downloadText('robinread-knowledge.json', json, 'application/json'); } },
      { label: t('导出 HTML'), icon: 'globe', action: async () => { const html = await window.robin.kbExportHTML(); downloadText('robinread-knowledge.html', html, 'text/html'); } },
      { label: t('导出 Anki 卡片'), icon: 'refresh', action: async () => { const tsv = await window.robin.kbExportAnki(); downloadText('robinread-anki.txt', tsv, 'text/tab-separated-values'); } },
    ];
    for (const it of items) {
      const row = document.createElement('button');
      row.className = 'context-menu-item';
      row.innerHTML = `<span class="nav-icon">${icon(it.icon)}</span><span>${escapeHTML(it.label)}</span>`;
      row.addEventListener('click', async () => { menu.remove(); await it.action(); });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    const dismiss = (e) => { if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener('mousedown', dismiss); } };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
  }

  _renderContent() {
    if (!this.contentHost) return;
    const data = this.data[this.tab];
    this.contentHost.innerHTML = '';
    switch (this.tab) {
      case 'dashboard': this._renderDashboard(data || {}); break;
      case 'highlights': this._renderHighlights(data || []); break;
      case 'notes': this._renderNotes(data || []); break;
      case 'review': this._renderReview(data || []); break;
      case 'collections': this._renderCollections(data || []); break;
      case 'smartfolders': this._renderSmartFolders(data || []); break;
      case 'review-daily': this._renderDaily(data || {}); break;
      case 'search': this._renderSearch(); break;
      case 'heatmap': this._renderHeatmap(data || {}); break;
      case 'stats': this._renderStats(data || {}); break;
      case 'tags': this._renderTags(data || {}); break;
      case 'graph': this._renderGraph(data || {}); break;
      case 'ask': this._renderAsk(data || {}); break;
      case 'research': this._renderResearch(Array.isArray(data) ? data : []); break;
      case 'threads': this._renderThreads(); break;
      case 'dash': this._renderDash(data || {}); break;
    }
  }

  // ── 看板 ──
  _renderDashboard(d) {
    const el = document.createElement('div');
    el.className = 'kb-stats';
    el.innerHTML = `
      <div class="kb-stats-grid">
        <div class="kb-stat-card"><span class="kb-stat-num">${d.highlights || 0}</span><span class="kb-stat-label">高亮</span></div>
        <div class="kb-stat-card"><span class="kb-stat-num">${d.notes || 0}</span><span class="kb-stat-label">笔记</span></div>
        <div class="kb-stat-card"><span class="kb-stat-num">${d.review || 0}</span><span class="kb-stat-label">复习卡片</span></div>
        <div class="kb-stat-card"><span class="kb-stat-num">${d.due || 0}</span><span class="kb-stat-label">今日待复习</span></div>
        <div class="kb-stat-card"><span class="kb-stat-num">${d.collections || 0}</span><span class="kb-stat-label">收藏集</span></div>
        <div class="kb-stat-card"><span class="kb-stat-num">${Array.isArray(d.tags) ? d.tags.length : (d.tags || 0)}</span><span class="kb-stat-label">标签</span></div>
        <div class="kb-stat-card"><span class="kb-stat-num">${d.streak || 0}</span><span class="kb-stat-label">连续天数</span></div>
      </div>`;
    // ── 每日目标进度环（R13；F20 扩展：0 = 关闭时隐藏 + 周进度条）──
    {
      const goals = d.goals || null;
      const goal = goals ? Number(goals.daily?.goal) : (Number(d.goal) || 5);
      const streak = Number(d.streak) || 0;
      if (goal > 0) {
        const tk = new Date();
        const todayKey = new Date(tk.getTime() - tk.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        const todayRead = goals ? Number(goals.daily?.read) || 0 : Number(d.heat?.[todayKey]?.read) || 0;
        const pct = goals ? Number(goals.daily?.pct) || 0 : Math.max(0, Math.min(1, todayRead / goal));
        const done = goals ? goals.daily?.done === true : todayRead >= goal;
        const R = 34;
        const C = 2 * Math.PI * R;
        const week = goals?.weekly?.enabled === true ? goals.weekly : null;
        const ringWrap = document.createElement('div');
        ringWrap.className = 'kb-goal-ring' + (done ? ' done' : '');
        ringWrap.innerHTML = `
          <div class="kb-goal-figure">
            <svg class="kb-goal-svg" viewBox="0 0 88 88" role="img">
              <defs>
                <linearGradient id="kbGoalGrad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" style="stop-color: var(--accent, #617357)"/><stop offset="1" style="stop-color: var(--warm-accent, #a3573d)"/>
                </linearGradient>
              </defs>
              <circle class="kb-goal-track" cx="44" cy="44" r="${R}"/>
              <circle class="kb-goal-fill" cx="44" cy="44" r="${R}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - pct)).toFixed(1)}"/>
            </svg>
            <div class="kb-goal-center"><b>${todayRead}</b><span>/ ${goal}</span></div>
          </div>
          <div class="kb-goal-text">
            <div class="kb-goal-title">${escapeHTML(t('今日阅读目标'))}</div>
            <div class="kb-goal-sub">${done ? `${icon('check', 13)} ${escapeHTML(t('已达成，读得漂亮'))}` : escapeHTML(t('再读') + ' ' + (goal - todayRead) + ' ' + t('篇即达成'))}</div>
            ${streak >= 2 ? `<div class="kb-goal-streak">${icon('flame', 12)} ${escapeHTML(tf('%lld 天连击', streak))}</div>` : ''}
            ${week ? `<div class="kb-goal-week" data-role="weekly-bar"><span class="kb-goal-week-label">${escapeHTML(t('本周'))}</span><span class="kb-goal-week-bar"><i style="width:${Math.round((Number(week.pct) || 0) * 100)}%"></i></span><span class="kb-goal-week-num">${Number(week.read) || 0}/${Number(week.goal) || 0}</span></div>` : ''}
          </div>`;
        el.insertBefore(ringWrap, el.firstChild);
      }
    }
    if (d.due > 0) {
      const cta = document.createElement('button');
      cta.className = 'btn-text primary';
      cta.style.marginTop = '16px';
      cta.textContent = t('去复习（有 ' + d.due + ' 张卡片到期）');
      cta.addEventListener('click', () => { this.tab = 'review'; this._render(); this._load(); });
      el.appendChild(cta);
    }

    // ── 30 天趋势 sparkline（R4）：阅读篇数 + 知识产出双序列 ──
    const heat = d.heat || {};
    const dates = Object.keys(heat).sort().slice(-30);
    if (dates.length >= 2) {
      const sparkWrap = document.createElement('div');
      sparkWrap.className = 'kb-spark-wrap';
      const sparkHead = document.createElement('div');
      sparkHead.className = 'kb-graph-head';
      sparkHead.innerHTML = `<span class="kb-daily-title">${escapeHTML(t('近 30 天趋势'))}</span><span class="kb-graph-legend"><span class="kb-legend-dot kb-legend-read"></span>${escapeHTML(t('阅读'))}  <span class="kb-legend-dot kb-legend-know"></span>${escapeHTML(t('知识产出'))}</span>`;
      sparkWrap.appendChild(sparkHead);
      const canvas = document.createElement('canvas');
      canvas.className = 'kb-spark-canvas';
      sparkWrap.appendChild(canvas);
      el.appendChild(sparkWrap);

      requestAnimationFrame(() => {
        // 令牌从 body 读取：body.dark 覆盖的暗态令牌（--note-background 等）才能解析到暗值
        const css = getComputedStyle(document.body);
        const token = (name, fb) => (css.getPropertyValue(name) || '').trim() || fb;
        const readColor = token('--accent', '#617357');
        const knowColor = token('--warm-accent', '#a3573d');
        const gridColor = token('--note-border', '#d8d5c6');
        const dpr = window.devicePixelRatio || 1;
        // 画布宽度取自身 content-box（CSS width:100% 已扣除卡片 padding）；取 parent clientWidth 会连 padding 一起量，右缘溢出卡片
        const H = 120;
        const W = Math.max(320, canvas.clientWidth || canvas.parentElement.clientWidth || 700);
        canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        // 补全日期序列（缺日补 0）
        const seq = [];
        const base = new Date(); base.setDate(base.getDate() - 29);
        for (let i = 0; i < 30; i++) {
          const dt = new Date(base); dt.setDate(base.getDate() + i);
          const key = dt.toISOString().slice(0, 10);
          const day = heat[key] || { read: 0, highlights: 0, notes: 0 };
          seq.push({ read: day.read || 0, know: (day.highlights || 0) + (day.notes || 0) });
        }
        const maxV = Math.max(1, ...seq.map((x) => Math.max(x.read, x.know)));
        const px = (i) => 8 + (i / 29) * (W - 16);
        const py = (v) => H - 14 - (v / maxV) * (H - 30);
        // 网格基线
        ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(8, H - 14); ctx.lineTo(W - 8, H - 14); ctx.stroke();
        // 双序列面积+折线
        const series = [
          { key: 'read', color: readColor },
          { key: 'know', color: knowColor },
        ];
        for (const ser of series) {
          ctx.beginPath();
          seq.forEach((x, i) => {
            const X = px(i), Y = py(ser.key === 'read' ? x.read : x.know);
            if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
          });
          ctx.strokeStyle = ser.color; ctx.lineWidth = 1.8; ctx.stroke();
          ctx.lineTo(px(29), H - 14); ctx.lineTo(px(0), H - 14); ctx.closePath();
          ctx.globalAlpha = 0.10; ctx.fillStyle = ser.color; ctx.fill(); ctx.globalAlpha = 1;
        }
      });
    }

    // ── 标签 top5 横条（知识结构）──
    if (d.tags?.length) {
      const tagWrap = document.createElement('div');
      tagWrap.className = 'kb-spark-wrap';
      const tagHead = document.createElement('div');
      tagHead.className = 'kb-graph-head';
      tagHead.innerHTML = `<span class="kb-daily-title">${escapeHTML(t('知识结构 · 标签 Top 5'))}</span>`;
      tagWrap.appendChild(tagHead);
      const max = d.tags[0].count || 1;
      for (const tg of d.tags.slice(0, 5)) {
        const rowEl = document.createElement('div');
        rowEl.className = 'kb-tag-bar-row';
        rowEl.innerHTML = `
          <span class="kb-tag-bar-label"></span>
          <span class="kb-tag-bar-track"><span class="kb-tag-bar-fill"></span></span>
          <span class="kb-tag-bar-num">${tg.count}</span>`;
        rowEl.querySelector('.kb-tag-bar-label').textContent = tg.tag;
        rowEl.querySelector('.kb-tag-bar-fill').style.width = Math.max(6, Math.round((tg.count / max) * 100)) + '%';
        tagWrap.appendChild(rowEl);
      }
      el.appendChild(tagWrap);
    }
    // ── 来源 Top 榜 + 时段分布（近 30 天，异步补充）──
    window.robin.kbStatsExtras?.().then((extras) => {
      if (!extras) return;
      if (extras.topFeeds?.length) {
        const feedWrap = document.createElement('div');
        feedWrap.className = 'kb-spark-wrap';
        feedWrap.innerHTML = `<div class="kb-graph-head"><span class="kb-daily-title">${escapeHTML(t('来源 Top 8 · 近 30 天'))}</span></div>`;
        const max = extras.topFeeds[0].n || 1;
        for (const f of extras.topFeeds) {
          const rowEl = document.createElement('div');
          rowEl.className = 'kb-tag-bar-row';
          rowEl.innerHTML = `
            <span class="kb-tag-bar-label"></span>
            <span class="kb-tag-bar-track"><span class="kb-tag-bar-fill kb-feed-fill"></span></span>
            <span class="kb-tag-bar-num">${f.n}</span>`;
          rowEl.querySelector('.kb-tag-bar-label').textContent = f.name;
          rowEl.querySelector('.kb-tag-bar-fill').style.width = Math.max(6, Math.round((f.n / max) * 100)) + '%';
          feedWrap.appendChild(rowEl);
        }
        el.appendChild(feedWrap);
      }
      const hours = extras.hours || [];
      if (hours.some((n) => n > 0)) {
        const hourWrap = document.createElement('div');
        hourWrap.className = 'kb-spark-wrap';
        hourWrap.innerHTML = `<div class="kb-graph-head"><span class="kb-daily-title">${escapeHTML(t('时段分布 · 近 30 天'))}</span></div>`;
        const barRow = document.createElement('div');
        barRow.className = 'kb-hour-bars';
        const maxH = Math.max(...hours, 1);
        for (let h = 0; h < 24; h++) {
          const col = document.createElement('div');
          col.className = 'kb-hour-col';
          col.title = `${String(h).padStart(2, '0')}:00 · ${hours[h]}`;
          const bar = document.createElement('i');
          bar.style.height = Math.max(4, Math.round((hours[h] / maxH) * 64)) + 'px';
          col.appendChild(bar);
          const lab = document.createElement('span');
          lab.textContent = h % 6 === 0 ? String(h) : '';
          col.appendChild(lab);
          barRow.appendChild(col);
        }
        hourWrap.appendChild(barRow);
        el.appendChild(hourWrap);
      }
    }).catch(() => {});
    this.contentHost.appendChild(el);
  }

  // ── 每日回顾 ──
  _renderDaily(review) {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'kb-daily-head';
    head.innerHTML = `<span class="kb-daily-title">${escapeHTML(t('每日回顾'))}</span><span class="kb-daily-sub">${escapeHTML(review.date || '')} · ${review.total || 0} 条知识</span>`;
    wrap.appendChild(head);
    if (!review.highlights?.length && !review.notes?.length) {
      this._emptyIn(wrap, '今天还没有知识沉淀', '阅读时高亮或记笔记，晚上回来回顾。');
      this.contentHost.appendChild(wrap);
      return;
    }
    if (review.highlights?.length) {
      const lbl = document.createElement('div'); lbl.className = 'td-section-label'; lbl.textContent = t('高亮');
      wrap.appendChild(lbl);
      for (const hl of review.highlights) {
        const card = document.createElement('div');
        card.className = 'kb-card';
        card.innerHTML = `<div class="kb-card-source">${icon('newspaper')}<span></span></div><div class="kb-hl-text" style="border-left:3px solid var(--accent)"></div>`;
        card.querySelector('.kb-card-source span').textContent = hl.article_title || '';
        card.querySelector('.kb-hl-text').textContent = hl.text;
        card.addEventListener('click', () => this.handlers.onOpenArticle?.(hl.item_id));
        wrap.appendChild(card);
      }
    }
    if (review.notes?.length) {
      const lbl = document.createElement('div'); lbl.className = 'td-section-label'; lbl.textContent = t('笔记');
      wrap.appendChild(lbl);
      for (const n of review.notes) {
        const card = document.createElement('div');
        card.className = 'kb-card';
        card.innerHTML = `<div class="kb-card-source">${icon('newspaper')}<span></span></div><div class="kb-note-content"></div>`;
        card.querySelector('.kb-card-source span').textContent = n.article_title || '';
        card.querySelector('.kb-note-content').textContent = n.content;
        card.addEventListener('click', () => this.handlers.onOpenArticle?.(n.item_id));
        wrap.appendChild(card);
      }
    }
    this.contentHost.appendChild(wrap);
  }

  // ── 知识搜索 ──
  _renderSearch() {
    const wrap = document.createElement('div');
    const bar = document.createElement('div');
    bar.className = 'kb-search-bar';
    bar.innerHTML = `${icon('search')}<input type="text" placeholder="${attr(t('搜索高亮与笔记内容…'))}"/>`;
    const input = bar.querySelector('input');
    const resultHost = document.createElement('div');
    resultHost.className = 'kb-search-results';
    wrap.append(bar, resultHost);

    const run = async (q) => {
      if (!q.trim()) { resultHost.innerHTML = ''; return; }
      const result = await window.robin.kbSearchKnowledge(q, { limit: 50 });
      resultHost.innerHTML = '';
      if (!result.total) { this._emptyIn(resultHost, '没有匹配', '换个关键词试试。'); return; }
      const lbl = document.createElement('div');
      lbl.className = 'td-section-label';
      lbl.textContent = t(`找到 ${result.total} 条结果`);
      resultHost.appendChild(lbl);
      for (const n of result.notes || []) {
        const card = document.createElement('div');
        card.className = 'kb-card';
        card.innerHTML = `<div class="kb-card-source">${icon('pencil')}<span></span></div><div class="kb-note-content"></div>`;
        card.querySelector('.kb-card-source span').textContent = n.articleTitle || t('笔记');
        card.querySelector('.kb-note-content').textContent = n.content;
        card.addEventListener('click', () => this.handlers.onOpenArticle?.(n.itemID));
        resultHost.appendChild(card);
      }
      for (const hl of result.highlights || []) {
        const card = document.createElement('div');
        card.className = 'kb-card';
        card.innerHTML = `<div class="kb-card-source">${icon('highlight')}<span></span></div><div class="kb-hl-text" style="border-left:3px solid var(--accent)"></div>`;
        card.querySelector('.kb-card-source span').textContent = hl.articleTitle || t('高亮');
        card.querySelector('.kb-hl-text').textContent = hl.text;
        card.addEventListener('click', () => this.handlers.onOpenArticle?.(hl.itemID));
        resultHost.appendChild(card);
      }
    };
    let timer = null;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(input.value), 300); });
    setTimeout(() => input.focus(), 50);
    this.contentHost.appendChild(wrap);
  }

  // ── 阅读热力图 ──
  _renderHeatmap(data) {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'kb-daily-head';
    head.innerHTML = `<span class="kb-daily-title">${escapeHTML(t('阅读热力图'))}</span><span class="kb-daily-sub">${escapeHTML(t('近一年活跃度'))}</span>`;
    wrap.appendChild(head);
    const map = data.map || {};
    const grid = document.createElement('div');
    grid.className = 'kb-heatmap';
    const today = new Date();
    let max = 1;
    for (const v of Object.values(map)) max = Math.max(max, v.intensity || 0);
    // GitHub 式年度热力：窗口锚定 today 一端，end 对齐本周六、start=end-364（周六锚，365 格），
    // 53 列 × 7 行（列=周 行=星期恒定对齐，CSS grid-auto-flow:column）；today 之后为隐藏占位格
    const end = new Date(today);
    end.setDate(end.getDate() + (6 - end.getDay()));
    const start = new Date(end);
    start.setDate(end.getDate() - 364);
    const days = Math.round((end - start) / 86400000) + 1;
    const todayKey = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const cells = [];
    for (let d = 0; d < days; d++) {
      const dt = new Date(start);
      dt.setDate(start.getDate() + d);
      const key = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      const future = dt > today;
      const v = future ? null : map[key];
      const intensity = v ? v.intensity : 0;
      cells.push({ key, intensity, date: dt, future });
    }
    for (const c of cells) {
      const cell = document.createElement('div');
      cell.className = 'kb-heat-cell';
      if (c.future) {
        cell.classList.add('future');
        grid.appendChild(cell);
        continue;
      }
      cell.title = `${c.key} · 活跃度 ${c.intensity}`;
      const level = c.intensity === 0 ? 0 : Math.min(4, Math.ceil((c.intensity / max) * 4));
      cell.dataset.level = String(level);
      if (c.key === todayKey) cell.classList.add('today');
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    // 年度统计行：有阅读天数 / 总强度 / 连续（由 map 推导）
    const activeDays = cells.filter((c) => c.intensity > 0).length;
    const totalIntensity = cells.reduce((sum, c) => sum + c.intensity, 0);
    const summary = document.createElement('div');
    summary.className = 'kb-heat-summary';
    summary.innerHTML = `<span>${escapeHTML(t('近一年'))} <b>${activeDays}</b> ${escapeHTML(t('天有阅读'))} · <b>${totalIntensity}</b> ${escapeHTML(t('点活跃度'))}</span>`;
    wrap.appendChild(summary);
    const legend = document.createElement('div');
    legend.className = 'kb-heat-legend';
    legend.innerHTML = `<span>${escapeHTML(t('少'))}</span>${[0,1,2,3,4].map((i) => `<i data-level="${i}"></i>`).join('')}<span>${escapeHTML(t('多'))}</span>`;
    wrap.appendChild(legend);
    this.contentHost.appendChild(wrap);
  }

  _emptyIn(host, title, desc) {
    host.innerHTML = `<div class="list-empty"><div class="glyph">${icon('spark')}</div><h3>${escapeHTML(t(title))}</h3><p>${escapeHTML(t(desc))}</p></div>`;
  }

  _renderHighlights(items) {
    if (!items.length) { this._empty('还没有高亮', '在阅读器中选中文字后点击高亮按钮。'); return; }
    for (const hl of items) {
      const card = document.createElement('div');
      card.className = 'kb-card';
      card.innerHTML = `
        ${hl.articleTitle ? `<div class="kb-card-source">${icon('newspaper')}<span></span></div>` : ''}
        <div class="kb-hl-text" style="border-left: 3px solid ${hl.color === 'blue' ? 'var(--accent, #617357)' : 'var(--kb-hl-yellow, #d4a834)'};"></div>
        ${hl.note ? `<div class="kb-hl-note">${escapeHTML(hl.note)}</div>` : ''}
        <div class="kb-card-foot">
          ${hl.createdAt ? `<span class="kb-card-time">${escapeHTML(timeAgo(hl.createdAt))}</span>` : ''}
          <span class="kb-card-actions">
            <button class="btn icon-only kb-edit" data-id="${attr(hl.id)}" title="${attr(t('编辑备注'))}">${icon('pencil')}</button>
            <button class="btn icon-only kb-del" data-id="${attr(hl.id)}" title="${attr(t('删除高亮'))}">${icon('trash')}</button>
          </span>
        </div>`;
      if (hl.articleTitle) card.querySelector('.kb-card-source span').textContent = hl.articleTitle;
      card.querySelector('.kb-hl-text').textContent = hl.text;
      card.querySelector('.kb-edit').addEventListener('click', async (e) => {
        e.stopPropagation();
        const note = await promptBox(t('编辑高亮备注'), { initial: hl.note || '', multiline: true });
        if (note === null) return;
        await window.robin.kbUpdateHighlight(hl.id, { note: note });
        this._load();
      });
      card.querySelector('.kb-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmBox(t('删除高亮'), { message: t('确定删除这条高亮吗？此操作无法撤销。'), okLabel: t('删除'), danger: true });
        if (!ok) return;
        await window.robin.kbRemoveHighlight(hl.id);
        this._load();
      });
      card.addEventListener('click', () => this.handlers.onOpenArticle?.(hl.itemID));
      this.contentHost.appendChild(card);
    }
  }

  _renderNotes(notes) {
    if (!notes.length) { this._empty('还没有笔记', '在阅读器中点笔记按钮添加你的第一条笔记。'); return; }
    for (const note of notes) {
      const card = document.createElement('div');
      card.className = 'kb-card';
      const hasWikiLinks = /\[\[[^\]]+\]\]/.test(note.content || '');
      card.innerHTML = `
        ${note.articleTitle ? `<div class="kb-card-source">${icon('newspaper')}<span></span></div>` : ''}
        <div class="kb-note-content"></div>
        ${note.tags.length ? `<div class="kb-note-tags">${note.tags.map((tag) => `<span class="fs-tag">${escapeHTML(tag)}</span>`).join('')}</div>` : ''}
        <div class="kb-card-foot">
          ${note.updatedAt ? `<span class="kb-card-time">${escapeHTML(timeAgo(note.updatedAt))}</span>` : ''}
          <span class="kb-card-actions">
            ${hasWikiLinks ? `<button class="btn-text bordered kb-links-btn" title="${attr(t('查看反向链接'))}">${escapeHTML(t('反链'))}</button>` : ''}
            <button class="btn icon-only kb-edit" data-id="${attr(note.id)}" title="${attr(t('编辑笔记'))}">${icon('pencil')}</button>
            <button class="btn icon-only kb-del" data-id="${attr(note.id)}" title="${attr(t('删除笔记'))}">${icon('trash')}</button>
          </span>
        </div>`;
      if (note.articleTitle) card.querySelector('.kb-card-source span').textContent = note.articleTitle;
      card.querySelector('.kb-note-content').textContent = note.content;
      const linksBtn = card.querySelector('.kb-links-btn');
      if (linksBtn) {
        linksBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await window.robin.kbRefreshLinks(note.id);
          this._viewBacklinks(note);
        });
      }
      card.querySelector('.kb-edit').addEventListener('click', async (e) => {
        e.stopPropagation();
        const content = await promptBox(t('编辑笔记'), { initial: note.content, multiline: true });
        if (content === null) return;
        await window.robin.kbUpdateNote(note.id, { content });
        this._load();
      });
      card.querySelector('.kb-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmBox(t('删除笔记'), { message: t('确定删除这条笔记吗？此操作无法撤销。'), okLabel: t('删除'), danger: true });
        if (!ok) return;
        await window.robin.kbDeleteNote(note.id);
        this._load();
      });
      card.addEventListener('click', () => this.handlers.onOpenArticle?.(note.itemID));
      this.contentHost.appendChild(card);
    }
  }

  /** 查看某条笔记的反向链接。 */
  async _viewBacklinks(note) {
    const backlinks = await window.robin.kbBacklinks(note.id);
    this.contentHost.innerHTML = '';
    const back = document.createElement('button');
    back.className = 'btn-text bordered';
    back.style.marginBottom = '12px';
    back.innerHTML = `${icon('chevronMenuRight')}<span style="margin-left:4px">${escapeHTML(t('返回笔记'))}</span>`;
    back.addEventListener('click', () => { this.tab = 'notes'; this._render(); this._load(); });
    this.contentHost.appendChild(back);
    const lbl = document.createElement('div');
    lbl.className = 'td-section-label';
    lbl.textContent = t('反向链接（' + (backlinks || []).length + '）');
    this.contentHost.appendChild(lbl);
    if (!backlinks?.length) {
      this._emptyIn(this.contentHost, '还没有反链', '其他笔记用 [[链接]] 引用这条笔记后，会出现在这里。');
      return;
    }
    for (const bl of backlinks) {
      const card = document.createElement('div');
      card.className = 'kb-card';
      card.innerHTML = `<div class="kb-note-content"></div>`;
      card.querySelector('.kb-note-content').textContent = bl.fromContent || '';
      card.addEventListener('click', () => this.handlers.onOpenArticle?.(bl.itemID));
      this.contentHost.appendChild(card);
    }
  }

  _renderReview(items) {
    if (!items.length) { this._empty('复习队列空了', '高亮一篇文章的重要段落并加入复习，它会按记忆曲线回来。'); return; }
    // 复习会话入口（重量级）：专注单卡翻转 + 三档评分 + 记忆曲线调度
    const sessionBtn = document.createElement('button');
    sessionBtn.className = 'btn-text primary kb-session-btn';
    sessionBtn.textContent = tf('开始复习（%lld 张）', items.length);
    sessionBtn.addEventListener('click', () => this._startReviewSession(items));
    this.contentHost.appendChild(sessionBtn);
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'kb-card kb-review-card';
      const reps = item.repetitions || 0;
      const interval = item.intervalDays || 1;
      card.innerHTML = `
        <div class="kb-review-head">
          <span class="kb-review-title"></span>
          <span class="kb-review-meta">${icon('clock')}<span>${interval} 天 · ${reps} 次复习</span></span>
        </div>
        ${item.highlightText ? `<div class="kb-hl-text"></div>` : ''}
        <div class="kb-review-actions">
          <button class="btn-text" data-q="1">😅 忘了</button>
          <button class="btn-text" data-q="3">🤔 想起来了</button>
          <button class="btn-text primary" data-q="5">😎 简单</button>
          <button class="btn-text danger kb-review-remove" title="${attr(t('移出复习队列'))}">${escapeHTML(t('移除'))}</button>
        </div>`;
      card.querySelector('.kb-review-title').textContent = item.articleTitle || t('未知文章');
      if (item.highlightText) card.querySelector('.kb-hl-text').textContent = item.highlightText;
      card.querySelector('.kb-review-remove').addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmBox(t('移出复习'), { message: t('确定把这张卡片移出复习队列吗？'), okLabel: t('移除'), danger: true });
        if (!ok) return;
        await window.robin.kbRemoveFromReview(item.id);
        card.style.opacity = '0.3';
        setTimeout(() => card.remove(), 300);
      });
      card.querySelectorAll('[data-q]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const q = Number(btn.dataset.q);
          await window.robin.kbReview(item.id, q);
          btn.closest('.kb-review-card').style.opacity = '0.3';
          setTimeout(() => btn.closest('.kb-review-card')?.remove(), 300);
        });
      });
      this.contentHost.appendChild(card);
    }
  }

  /** 复习会话：单卡专注流。正面提示 → 翻面 → 三档评分（SM-2 调度）→ 下一张 → 结束统计。 */
  _startReviewSession(items) {
    this._reviewSession = { cards: items.slice(), index: 0, revealed: false };
    this._renderSession();
  }

  /** 当日已复习计数（跨会话累计，跨零点清零）。 */
  _bumpReviewCount() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const raw = JSON.parse(localStorage.getItem('robinread.review.today') || '{}');
      const count = raw.date === today ? (raw.count || 0) + 1 : 1;
      localStorage.setItem('robinread.review.today', JSON.stringify({ date: today, count }));
    } catch (_) { /* 忽略 */ }
  }

  _reviewedToday() {
    try {
      const raw = JSON.parse(localStorage.getItem('robinread.review.today') || '{}');
      return raw.date === new Date().toISOString().slice(0, 10) ? (raw.count || 0) : 0;
    } catch (_) { return 0; }
  }

  _sessionKeyHandler(event) {
    const session = this._reviewSession;
    if (!session) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation(); // 抢在知识中心 modal 的 Esc 关闭之前
      this._endReviewSession();
      return;
    }
    if (session.revealed && ['1', '2', '3'].includes(event.key)) {
      event.preventDefault();
      const q = event.key === '1' ? 1 : event.key === '2' ? 3 : 5;
      const btn = document.querySelector('.kb-session-a [data-q="' + q + '"]');
      btn?.click();
      return;
    }
    if ((event.key === ' ' || event.key === 'Enter') && !session.revealed) {
      event.preventDefault();
      event.stopPropagation();
      document.querySelector('.kb-session-reveal')?.click();
    }
  }

  /** 仅清理会话态与监听（不触发渲染）。 */
  _cleanupSession() {
    if (this._sessionKeys) document.removeEventListener('keydown', this._sessionKeys, true);
    this._sessionKeys = null;
    this._reviewSession = null;
    // AI 研究（F8）：离开页面时退订流式分片（后台生成继续，报告照常落库）
    if (this._research?.unsubscribe) { this._research.unsubscribe(); this._research.unsubscribe = null; }
    if (this._research) { this._research.running = false; this._research.mode = null; }
    // 全库问答（F9）：离开页面时退订流式分片（后台回答继续，消息照常落库）
    if (this._rag?.unsubscribe) { this._rag.unsubscribe(); this._rag.unsubscribe = null; }
    if (this._rag) { this._rag.running = false; this._rag.mode = null; }
  }

  _endReviewSession() {
    this._cleanupSession();
    this.tab = 'review';
    this._render();
    this._load();
  }

  _renderSession() {
    const session = this._reviewSession;
    if (!session) return;
    if (this._sessionKeys) document.removeEventListener('keydown', this._sessionKeys, true);
    this._sessionKeys = (event) => this._sessionKeyHandler(event);
    document.addEventListener('keydown', this._sessionKeys, true /* capture：抢在知识中心 modal 冒泡 Esc 之前 */);
    this.contentHost.innerHTML = '';
    const total = session.cards.length;
    const done = session.index;

    if (done >= total) {
      this._reviewSession = null;
      const doneEl = document.createElement('div');
      doneEl.className = 'kb-session-done';
      doneEl.innerHTML = `
        <div class="kb-session-done-icon">${icon('checkCircle')}</div>
        <div class="kb-session-done-title"></div>
        <div class="kb-session-done-sub"></div>`;
      doneEl.querySelector('.kb-session-done-title').textContent = t('本次复习完成');
      doneEl.querySelector('.kb-session-done-sub').textContent = tf('共复习 %lld 张卡片，记忆曲线已更新', total);
      doneEl.querySelector('.kb-session-done-sub').textContent += ' · ' + tf('今日累计 %lld 张', this._reviewedToday());
      const back = document.createElement('button');
      back.className = 'btn-text primary';
      back.style.marginTop = '14px';
      back.textContent = t('返回列表');
      back.addEventListener('click', () => { this.tab = 'review'; this._render(); this._load(); });
      doneEl.appendChild(back);
      this.contentHost.appendChild(doneEl);
      return;
    }

    const card = session.cards[session.index];
    const wrap = document.createElement('div');
    wrap.className = 'kb-session';
    wrap.innerHTML = `
      <div class="kb-session-progress"><span class="kb-session-bar"><span class="kb-session-bar-fill"></span></span><span class="kb-session-count"></span></div>
      <div class="kb-session-card">
        <div class="kb-session-q">
          <div class="kb-session-title"></div>
          <div class="kb-session-hint"></div>
          <button class="btn-text primary kb-session-reveal"></button>
        </div>
        <div class="kb-session-a" style="display:none">
          <div class="kb-hl-text"></div>
          <div class="kb-session-note" style="display:none"></div>
          <div class="kb-session-hint2"></div>
          <div class="kb-review-actions">
            <button class="btn-text" data-q="1"></button>
            <button class="btn-text" data-q="3"></button>
            <button class="btn-text primary" data-q="5"></button>
          </div>
        </div>
      </div>
      <div class="kb-session-foot"><button class="btn-text kb-session-exit"></button></div>`;
    wrap.querySelector('.kb-session-title').textContent = card.articleTitle || t('未知文章');
    wrap.querySelector('.kb-session-hint').textContent = t('回忆这段高亮的内容，然后翻面');
    wrap.querySelector('.kb-session-reveal').textContent = t('显示答案');
    wrap.querySelector('.kb-session-count').textContent = (session.index + 1) + ' / ' + total;
    wrap.querySelector('.kb-session-bar-fill').style.width = Math.round((done / total) * 100) + '%';
    if (card.highlightText) wrap.querySelector('.kb-hl-text').textContent = card.highlightText;
    if (card.highlightNote) {
      const note = wrap.querySelector('.kb-session-note');
      note.style.display = '';
      note.textContent = t('笔记') + '：' + card.highlightNote;
    }
    wrap.querySelector('.kb-session-hint2').textContent = t('按记忆曲线评分：忘了 → 明天再见；简单 → 间隔拉长');
    const qLabels = { 1: '😵 ' + t('忘了'), 3: '🤔 ' + t('想起来了'), 5: '😎 ' + t('简单') };
    wrap.querySelectorAll('[data-q]').forEach((btn) => {
      const q = Number(btn.dataset.q);
      btn.textContent = qLabels[q] || String(q);
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!session.revealed) return;
        try { await window.robin.kbReview(card.id, q); } catch (_) { /* 单卡失败不断会话 */ }
        this._bumpReviewCount();
        session.index += 1;
        this._renderSession();
      });
    });
    wrap.querySelector('.kb-session-exit').textContent = t('结束本次复习');
    wrap.querySelector('.kb-session-exit').addEventListener('click', () => this._endReviewSession());
    const revealBtn = wrap.querySelector('.kb-session-reveal');
    const answer = wrap.querySelector('.kb-session-a');
    revealBtn.addEventListener('click', () => {
      session.revealed = true;
      wrap.querySelector('.kb-session-q').style.display = 'none';
      answer.style.display = '';
    });
    this.contentHost.appendChild(wrap);
  }

  async _renderCollections(collections) {
    if (!collections.length) {
      this._empty('还没有收藏集', '收藏集帮助你按主题归档文章，可从阅读器加入。');
      const create = document.createElement('button');
      create.className = 'btn-text primary';
      create.style.marginTop = '12px';
      create.textContent = t('新建收藏集');
      create.addEventListener('click', () => this._promptNewCollection());
      this.contentHost.appendChild(create);
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'kb-col-grid';
    for (const col of collections) {
      const card = document.createElement('div');
      card.className = 'kb-col-card';
      card.innerHTML = `
        <div class="kb-col-top">
          <div class="kb-col-icon">${icon('folder')}</div>
          <span class="kb-card-actions">
            <button class="btn icon-only kb-col-rename" title="${attr(t('重命名'))}">${icon('pencil')}</button>
            <button class="btn icon-only kb-col-del" title="${attr(t('删除收藏集'))}">${icon('trash')}</button>
          </span>
        </div>
        <div class="kb-col-name"></div>
        ${col.description ? `<div class="kb-col-desc"></div>` : ''}
        <div class="kb-col-count">${col.item_count || 0} 篇文章</div>`;
      card.querySelector('.kb-col-name').textContent = col.name;
      if (col.description) card.querySelector('.kb-col-desc').textContent = col.description;
      card.querySelector('.kb-col-rename').addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = await promptBox(t('重命名收藏集'), { initial: col.name });
        if (!name?.trim() || name === col.name) return;
        const desc = await promptBox(t('描述（可选）'), { initial: col.description || '' });
        if (desc === null) return;
        await window.robin.kbUpdateCollection(col.id, { name: name.trim(), description: desc.trim() });
        this._load();
      });
      card.querySelector('.kb-col-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmBox(t('删除收藏集'), { message: t('确定删除「' + col.name + '」吗？其中的文章不会被删除。'), okLabel: t('删除'), danger: true });
        if (!ok) return;
        await window.robin.kbDeleteCollection(col.id);
        this._load();
      });
      card.addEventListener('click', async () => this._openCollection(col));
      grid.appendChild(card);
    }
    this.contentHost.appendChild(grid);
    const add = document.createElement('button');
    add.className = 'btn-text bordered';
    add.style.marginTop = '14px';
    add.textContent = t('新建收藏集');
    add.addEventListener('click', () => this._promptNewCollection());
    this.contentHost.appendChild(add);
  }

  async _promptNewCollection() {
    const name = await promptBox(t('收藏集名称'));
    if (!name?.trim()) return;
    const desc = (await promptBox(t('描述（可选）'))) || '';
    await window.robin.kbCreateCollection(name.trim(), desc.trim());
    this._load();
  }

  async _openCollection(col) {
    const items = await window.robin.kbCollectionItems(col.id);
    if (!items.length) { this._empty('收藏集是空的', '从阅读器或列表中把文章加入这个收藏集。'); return; }
    this.contentHost.innerHTML = '';
    const back = document.createElement('button');
    back.className = 'btn-text bordered';
    back.style.marginBottom = '12px';
    back.innerHTML = `${icon('chevronMenuRight')}<span style="margin-left:4px">${escapeHTML(t('返回收藏集'))}</span>`;
    back.addEventListener('click', () => this._load());
    this.contentHost.appendChild(back);
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'kb-card';
      card.innerHTML = `<div class="kb-note-content"></div>
        <div class="kb-card-foot">
          <div class="kb-card-source">${icon('newspaper')}<span></span></div>
          <button class="btn icon-only kb-item-remove" title="${attr(t('移出收藏集'))}">${icon('trash')}</button>
        </div>`;
      card.querySelector('.kb-note-content').textContent = it.title;
      card.querySelector('.kb-card-source span').textContent = it.feed_title || '';
      card.querySelector('.kb-item-remove').addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.robin.kbRemoveFromCollection(col.id, it.id);
        card.style.opacity = '0.3';
        setTimeout(() => card.remove(), 250);
      });
      card.addEventListener('click', () => this.handlers.onOpenArticle?.(it.id));
      this.contentHost.appendChild(card);
    }
  }

  _renderStats(data) {
    const totals = data.totals || {};
    const daily = data.daily || [];
    const el = document.createElement('div');
    el.className = 'kb-stats';
    el.innerHTML = `
      <div class="kb-stats-grid">
        <div class="kb-stat-card"><span class="kb-stat-num">${totals.read || 0}</span><span class="kb-stat-label">已读文章</span></div>
        <div class="kb-stat-card"><span class="kb-stat-num">${data.streak || 0}</span><span class="kb-stat-label">连续阅读天数</span></div>
        <div class="kb-stat-card"><span class="kb-stat-num">${totals.highlights || 0}</span><span class="kb-stat-label">高亮次数</span></div>
        <div class="kb-stat-card"><span class="kb-stat-num">${totals.notes || 0}</span><span class="kb-stat-label">笔记条数</span></div>
        <div class="kb-stat-card"><span class="kb-stat-num">${totals.ai || 0}</span><span class="kb-stat-label">AI 摘要</span></div>
        <div class="kb-stat-card"><span class="kb-stat-num">${daily.length}</span><span class="kb-stat-label">活跃天数</span></div>
      </div>`;
    if (daily.length) {
      const chart = document.createElement('div');
      chart.className = 'kb-chart';
      const max = Math.max(1, ...daily.map((d) => Math.max(d.articles_read || 0, d.highlights_made || 0)));
      for (const d of daily.slice(-30)) {
        const bar = document.createElement('div');
        bar.className = 'kb-chart-bar';
        bar.title = `${d.date} · 阅读 ${d.articles_read || 0} · 高亮 ${d.highlights_made || 0}`;
        const v = Math.max(d.articles_read || 0, d.highlights_made || 0);
        bar.style.height = `${Math.max(4, (v / max) * 72)}px`;
        bar.style.opacity = v > 0 ? '1' : '0.25';
        chart.appendChild(bar);
      }
      el.appendChild(chart);
    }
    this.contentHost.appendChild(el);
  }

  // ── 图谱（知识增强）：标签 ↔ 文章 canvas 力导向图 ──
  _renderGraph(data) {
    const el = document.createElement('div');
    if (!data?.edges?.length) {
      this._empty('图谱还是空的', '阅读时高亮、打标签或生成 AI 摘要，知识节点会在这里生长。');
      return;
    }
    const head = document.createElement('div');
    head.className = 'kb-graph-head';
    head.innerHTML = `<span class="kb-daily-title">${escapeHTML(t('知识图谱'))}</span><span class="kb-graph-legend">${escapeHTML(t('大节点 = 高频标签 · 悬停高亮关联 · 点击文章节点直达'))}</span>`;
    el.appendChild(head);

    const wrap = document.createElement('div');
    wrap.className = 'kb-graph-wrap';
    const canvas = document.createElement('canvas');
    canvas.className = 'kb-graph-canvas';
    wrap.appendChild(canvas);
    el.appendChild(wrap);
    this.contentHost.appendChild(el);
    const panel = document.createElement('div');
    panel.className = 'kb-graph-panel';
    panel.style.display = 'none';
    el.appendChild(panel);

    // 主题取色（canvas 不能直接用 CSS 变量）
    const css = getComputedStyle(document.documentElement);
    const palette = {
      ink: css.getPropertyValue('--text-primary').trim() || '#333',
      muted: css.getPropertyValue('--text-secondary').trim() || '#888',
      accent: css.getPropertyValue('--accent').trim() || '#617357',
      paper: css.getPropertyValue('--page-background').trim() || '#faf7ee',
      line: css.getPropertyValue('--note-border').trim() || '#ddd',
    };

    // 节点/边构建
    const nodes = [];
    const nodeByKey = new Map();
    const addNode = (key, kind, label, weight) => {
      let node = nodeByKey.get(key);
      if (!node) {
        node = { key, kind, label, weight: 0, x: 0, y: 0, vx: 0, vy: 0 };
        nodeByKey.set(key, node);
        nodes.push(node);
      }
      node.weight += weight;
      return node;
    };
    for (const tg of data.tags || []) addNode(`tag:${tg.tag}`, 'tag', tg.tag, tg.count);
    for (const a of data.articles || []) addNode(`art:${a.id}`, 'article', a.title || a.id, 1);
    const edges = (data.edges || []).map((e) => ({
      a: nodeByKey.get(`tag:${e.tag}`),
      b: nodeByKey.get(`art:${e.id}`),
    })).filter((e) => e.a && e.b);

    // 初始布局：同心圆撒点
    const W = Math.max(420, wrap.clientWidth || 760);
    const H = 460;
    nodes.forEach((node, i) => {
      const angle = (i / nodes.length) * Math.PI * 2;
      const radius = node.kind === 'tag' ? 90 : 180;
      node.x = W / 2 + Math.cos(angle) * radius * (0.6 + 0.4 * Math.sin(i * 7));
      node.y = H / 2 + Math.sin(angle) * radius * (0.6 + 0.4 * Math.cos(i * 5));
    });

    // 力导向模拟（固定迭代成静态图；悬停仅视觉高亮，不重排）
    const REPULSION = 2600;
    const SPRING = 0.015;
    const REST = 86;
    const CENTER = 0.012;
    for (let iter = 0; iter < 160; iter += 1) {
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let dist2 = dx * dx + dy * dy;
          if (dist2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dist2 = 1; }
          const force = REPULSION / dist2;
          const dist = Math.sqrt(dist2);
          const fx = (dx / dist) * Math.min(force, 12);
          const fy = (dy / dist) * Math.min(force, 12);
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }
      for (const edge of edges) {
        const dx = edge.b.x - edge.a.x;
        const dy = edge.b.y - edge.a.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const force = (dist - REST) * SPRING;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        edge.a.vx += fx; edge.a.vy += fy;
        edge.b.vx -= fx; edge.b.vy -= fy;
      }
      for (const node of nodes) {
        node.vx += (W / 2 - node.x) * CENTER;
        node.vy += (H / 2 - node.y) * CENTER;
        node.vx *= 0.82; node.vy *= 0.82;
        node.x = Math.max(26, Math.min(W - 26, node.x + Math.max(-9, Math.min(9, node.vx))));
        node.y = Math.max(22, Math.min(H - 22, node.y + Math.max(-9, Math.min(9, node.vy))));
      }
    }

    // 绘制
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const radiusOf = (node) => (node.kind === 'tag' ? Math.min(20, 6 + Math.sqrt(node.weight) * 3.2) : 5);
    let hover = null;
    let pinnedTag = null; // 点击标签节点：钉住并在面板中列出关联文章
    const related = (node) => {
      const set = new Set([node]);
      for (const edge of edges) {
        if (edge.a === node) set.add(edge.b);
        if (edge.b === node) set.add(edge.a);
      }
      return set;
    };
    let hoverSet = null;
    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      for (const edge of edges) {
        const hot = hover && (edge.a === hover || edge.b === hover);
        ctx.strokeStyle = hot ? palette.accent : palette.line;
        ctx.globalAlpha = hover ? (hot ? 0.9 : 0.15) : 0.55;
        ctx.beginPath();
        ctx.moveTo(edge.a.x, edge.a.y);
        ctx.lineTo(edge.b.x, edge.b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const node of nodes) {
        const r = radiusOf(node);
        const dim = hoverSet ? !hoverSet.has(node) : false;
        ctx.globalAlpha = dim ? 0.15 : 1;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        if (node.kind === 'tag') {
          ctx.fillStyle = palette.accent;
          ctx.fill();
        } else {
          ctx.fillStyle = palette.paper;
          ctx.fill();
          ctx.strokeStyle = palette.muted;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }
        const showLabel = node.kind === 'tag' ? (node.weight >= 3 || hoverSet?.has(node)) : hoverSet?.has(node);
        if (showLabel) {
          ctx.globalAlpha = dim ? 0.25 : 0.92;
          ctx.fillStyle = palette.ink;
          ctx.font = `${node.kind === 'tag' ? 600 : 400} 11px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          const label = node.label.length > 18 ? `${node.label.slice(0, 17)}…` : node.label;
          ctx.fillText(label, node.x, node.y - r - 5);
        }
        ctx.globalAlpha = 1;
      }
    };
    draw();

    // 交互：悬停高亮关联子图 + 点击文章节点直达
    const nodeAt = (evt) => {
      const rect = canvas.getBoundingClientRect();
      const x = evt.clientX - rect.left;
      const y = evt.clientY - rect.top;
      let best = null;
      let bestDist = 24;
      for (const node of nodes) {
        const d = Math.hypot(node.x - x, node.y - y);
        if (d < Math.max(radiusOf(node) + 6, 12) && d < bestDist) { best = node; bestDist = d; }
      }
      return best;
    };
    canvas.addEventListener('mouseleave', () => { hover = null; hoverSet = null; draw(); });

    // 标签联动面板：钉住标签 → 列出关联文章（点击直达）
    const showTagPanel = (tagNode) => {
      if (!tagNode) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
      const linked = edges.filter((e) => e.a === tagNode).map((e) => e.b);
      panel.style.display = '';
      panel.innerHTML = `<div class="kb-graph-panel-head"><span class="kb-daily-title"></span><span class="kb-graph-legend">${escapeHTML(t('点击文章直达 · 再次点击标签取消'))}</span></div>`;
      panel.querySelector('.kb-daily-title').textContent = `#${tagNode.label} · ${linked.length}`;
      const filterBtn = document.createElement('button');
      filterBtn.className = 'btn-text primary kb-graph-filter';
      filterBtn.textContent = t('在主列表查看');
      filterBtn.addEventListener('click', () => {
        this.dismiss?.();
        this.handlers.onFilterTag?.(tagNode.label);
      });
      panel.querySelector('.kb-graph-panel-head').appendChild(filterBtn);
      const list = document.createElement('div');
      list.className = 'kb-graph-panel-list';
      for (const articleNode of linked) {
        const rowBtn = document.createElement('button');
        rowBtn.className = 'kb-graph-panel-row';
        rowBtn.textContent = articleNode.label || articleNode.key;
        rowBtn.title = articleNode.label || '';
        rowBtn.addEventListener('click', () => this.handlers.onOpenArticle?.(articleNode.key.slice(4)));
        list.appendChild(rowBtn);
      }
      panel.appendChild(list);
    };
    canvas.addEventListener('click', (event) => {
      const node = nodeAt(event);
      if (!node) return;
      if (node.kind === 'article') { this.handlers.onOpenArticle?.(node.key.slice(4)); return; }
      if (pinnedTag === node) { pinnedTag = null; showTagPanel(null); }
      else {
        pinnedTag = node;
        hover = node; hoverSet = related(node);
        showTagPanel(node);
        draw();
      }
    });

    // 节点拖拽：按住拖动重摆位置（释放后自然停驻，即时重绘）
    let dragging = null;
    canvas.addEventListener('pointerdown', (event) => {
      const node = nodeAt(event);
      if (!node) return;
      dragging = node;
      try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* 忽略 */ }
    });
    canvas.addEventListener('pointermove', (event) => {
      if (dragging) {
        const rect = canvas.getBoundingClientRect();
        dragging.x = Math.max(20, Math.min(W - 20, event.clientX - rect.left));
        dragging.y = Math.max(18, Math.min(H - 18, event.clientY - rect.top));
        draw();
        return;
      }
      const node = nodeAt(event);
      if (node !== hover) {
        hover = node;
        hoverSet = node ? related(node) : null;
        canvas.style.cursor = node ? 'grab' : 'default';
        draw();
      }
    });
    canvas.addEventListener('pointerup', () => { dragging = null; });
  }

  // ── 全库问答（F9）：全库 RAG——会话侧栏 + 消息流 + 引用芯片 + 素材浮层 ──

  /** 订阅问答流式分片与阶段推送（seq 守卫：过期会话的事件全部忽略）。返回统一退订器。 */
  _subscribeRagEvents(seq, { onDelta, onStatus }) {
    const offDelta = window.robin.onRagDelta?.((p) => {
      if (this._rag.running && this._rag.seq === seq) onDelta?.(p);
    });
    const offStatus = window.robin.onRagStatus?.((p) => {
      if (this._rag.running && this._rag.seq === seq) onStatus?.(p);
    });
    return () => { offDelta?.(); offStatus?.(); };
  }

  /** 结束一次问答运行：退订 + 释放单飞标记。 */
  _endRagRun(unsubscribe) {
    if (unsubscribe) unsubscribe();
    if (this._rag.unsubscribe === unsubscribe) this._rag.unsubscribe = null;
    this._rag.running = false;
    this._rag.mode = null;
  }

  _renderAsk(data) {
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'kb-graph-head';
    head.innerHTML = `<span class="kb-daily-title">${escapeHTML(t('全库问答'))}</span><span class="kb-graph-legend">${escapeHTML(t('全库 RAG：检索订阅全文、高亮与笔记，多轮问答，[n] 引用可跳原文。'))}</span>`;
    wrap.appendChild(head);

    const layout = document.createElement('div');
    layout.className = 'nj-rag-layout';

    // 会话侧栏：新建 + 历史列表
    const side = document.createElement('div');
    side.className = 'nj-rag-side';
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'btn-text bordered nj-rag-new';
    newBtn.innerHTML = `${icon('spark')}<span style="margin-left:5px"></span>`;
    newBtn.querySelector('span').textContent = t('新建会话');
    side.appendChild(newBtn);
    const sessionsHost = document.createElement('div');
    sessionsHost.className = 'nj-rag-sessions';
    side.appendChild(sessionsHost);
    layout.appendChild(side);

    // 聊天区：消息流 + 状态/取消 + 输入行
    const chat = document.createElement('div');
    chat.className = 'nj-rag-chat';
    const streamHost = document.createElement('div');
    streamHost.className = 'nj-rag-stream';
    chat.appendChild(streamHost);

    const statusBar = document.createElement('div');
    statusBar.className = 'nj-research-status nj-rag-status';
    statusBar.style.display = 'none';
    // 阶段文本独立 span：textContent 直写 statusBar 会连带清掉子级取消按钮
    const statusText = document.createElement('span');
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-text nj-rag-cancel';
    cancelBtn.style.display = 'none';
    cancelBtn.style.marginLeft = '8px';
    cancelBtn.textContent = t('取消生成');
    cancelBtn.addEventListener('click', () => { try { window.robin.ragCancel(); } catch (_) { /* 服务层取消，已流部分照存 */ } });
    statusBar.append(statusText, cancelBtn);
    chat.appendChild(statusBar);

    const inputRow = document.createElement('div');
    inputRow.className = 'kb-ask-row nj-rag-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'kb-ask-input nj-rag-input';
    input.placeholder = t('输入问题，从全库检索作答…');
    const askBtn = document.createElement('button');
    askBtn.className = 'btn-text primary kb-ask-btn nj-rag-go';
    askBtn.textContent = t('提问');
    inputRow.append(input, askBtn);
    chat.appendChild(inputRow);
    layout.appendChild(chat);
    wrap.appendChild(layout);
    this.contentHost.appendChild(wrap);

    const scrollBottom = () => { streamHost.scrollTop = streamHost.scrollHeight; };
    const setBusy = (busy) => { askBtn.disabled = busy; input.disabled = busy; };
    const setStreaming = (on) => {
      statusBar.style.display = on ? '' : 'none';
      cancelBtn.style.display = on ? '' : 'none';
    };

    /** 单条消息气泡：user 纯文本；assistant 走 renderMarkdown + [n] 引用芯片。 */
    const renderMessage = (msg) => {
      const bubble = document.createElement('div');
      bubble.className = `nj-rag-msg ${msg.role === 'user' ? 'user' : 'assistant'}`;
      if (msg.role === 'user') bubble.textContent = msg.content || '';
      else {
        bubble.innerHTML = renderMarkdown(msg.content || t('（空回答）'));
        this._linkifyCitations(bubble, Array.isArray(msg.sources) ? msg.sources : []);
      }
      return bubble;
    };

    const renderEmptyHint = () => {
      streamHost.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'list-empty nj-rag-empty';
      empty.innerHTML = `<div class="glyph">${icon('spark')}</div><h3></h3><p></p>`;
      empty.querySelector('h3').textContent = t('问点什么吧');
      empty.querySelector('p').textContent = t('问题会先在你的订阅全文、高亮与笔记里检索，再由 AI 作答。');
      streamHost.appendChild(empty);
    };

    /** 会话侧栏列表（active 高亮当前会话；行内重命名/删除）。 */
    const renderSessionList = (list) => {
      sessionsHost.innerHTML = '';
      if (!list.length) {
        const hint = document.createElement('div');
        hint.className = 'nj-rag-no-session';
        hint.textContent = t('还没有会话');
        sessionsHost.appendChild(hint);
        return;
      }
      for (const s of list) {
        const row = document.createElement('div');
        row.className = 'nj-rag-session' + (s.id === this._rag.sessionID ? ' active' : '');
        const main = document.createElement('div');
        main.className = 'nj-rag-session-main';
        const title = document.createElement('div');
        title.className = 'nj-rag-session-title';
        title.textContent = s.title || t('无标题会话');
        title.title = s.title || '';
        const meta = document.createElement('div');
        meta.className = 'nj-rag-session-meta';
        meta.textContent = timeAgo(s.updatedAt);
        main.append(title, meta);
        const actions = document.createElement('span');
        actions.className = 'nj-rag-session-actions';
        const rename = document.createElement('button');
        rename.className = 'btn icon-only';
        rename.innerHTML = icon('pencil');
        rename.title = t('重命名会话');
        rename.addEventListener('click', async (e) => {
          e.stopPropagation();
          const name = await promptBox(t('重命名会话'), { initial: s.title || '' });
          if (name === null || !name.trim() || name.trim() === s.title) return;
          await window.robin.ragRename(s.id, name.trim());
          renderSessionList((await window.robin.ragSessions()) || []);
        });
        const del = document.createElement('button');
        del.className = 'btn icon-only';
        del.innerHTML = icon('trash');
        del.title = t('删除会话');
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          const ok = await confirmBox(t('删除会话'), { message: t('确定删除这个问答会话吗？全部消息将一并删除，此操作无法撤销。'), okLabel: t('删除'), danger: true });
          if (!ok) return;
          await window.robin.ragDelete(s.id);
          if (s.id === this._rag.sessionID) { this._rag.sessionID = null; renderEmptyHint(); }
          renderSessionList((await window.robin.ragSessions()) || []);
        });
        actions.append(rename, del);
        row.append(main, actions);
        row.addEventListener('click', async () => {
          if (this._rag.running) return;
          const full = await window.robin.ragSession(s.id);
          if (!full) { renderSessionList((await window.robin.ragSessions()) || []); return; }
          this._rag.sessionID = s.id;
          streamHost.innerHTML = '';
          for (const m of full.messages || []) streamHost.appendChild(renderMessage(m));
          if (!(full.messages || []).length) renderEmptyHint();
          renderSessionList(list);
          scrollBottom();
        });
        sessionsHost.appendChild(row);
      }
    };
    renderSessionList(sessions);
    renderEmptyHint();

    const refreshSessionList = async () => renderSessionList((await window.robin.ragSessions()) || []);

    const submit = async () => {
      const question = input.value.trim();
      if (!question || this._rag.running) return;
      this._rag.running = true;
      this._rag.mode = 'ask';
      this._rag.seq = (this._rag.seq || 0) + 1;
      const seq = this._rag.seq;
      input.value = '';
      setBusy(true);
      setStreaming(true);
      statusText.textContent = t('正在检索全库素材…');
      if (streamHost.querySelector('.nj-rag-empty')) streamHost.innerHTML = '';

      // user 气泡 + assistant 流式气泡
      streamHost.appendChild(renderMessage({ role: 'user', content: question }));
      const bubble = document.createElement('div');
      bubble.className = 'nj-rag-msg assistant';
      bubble.innerHTML = '<div class="robin-spinner"></div>';
      streamHost.appendChild(bubble);
      scrollBottom();

      let streamed = '';
      // 首个分片同步上屏（首 token 零延迟 + 隐藏窗口 rAF 节流时仍可见），后续 rAF 合帧
      let rafPending = false;
      let paintedOnce = false;
      const applyPaint = () => {
        bubble.innerHTML = renderMarkdown(streamed);
        streamHost.scrollTop = streamHost.scrollHeight;
      };
      const paint = () => {
        if (seq !== this._rag.seq || !bubble.isConnected) return;
        if (!paintedOnce) { paintedOnce = true; applyPaint(); return; }
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; applyPaint(); });
      };
      const unsubscribe = this._subscribeRagEvents(seq, {
        onDelta: (p) => { streamed += p?.delta || ''; paint(); },
        onStatus: (p) => {
          if (seq !== this._rag.seq || streamed) return;
          statusText.textContent = p?.phase === 'gather' ? t('正在检索全库素材…') : t('正在回答…');
        },
      });
      this._rag.unsubscribe = unsubscribe;
      try {
        const res = await window.robin.ragAsk(this._rag.sessionID, question);
        if (seq !== this._rag.seq) return; // 页面已切走：后台照常落库
        if (!res || res.ok === false) throw new Error(res?.error || t('生成失败'));
        const d = res.data || {};
        this._rag.sessionID = d.sessionID || this._rag.sessionID;
        bubble.innerHTML = renderMarkdown(d.content || t('（空回答）'));
        this._linkifyCitations(bubble, Array.isArray(d.materials) ? d.materials : []);
        if (d.cancelled) {
          const note = document.createElement('div');
          note.className = 'nj-rag-cancel-note';
          note.textContent = t('回答已取消，已收到的部分已保留。');
          bubble.appendChild(note);
        }
        refreshSessionList(); // 新会话标题/排序更新（不抢消息流）
      } catch (error) {
        if (seq !== this._rag.seq) return;
        const msg = String(error?.message || error) || t('生成失败');
        bubble.classList.add('nj-rag-msg-error');
        bubble.innerHTML = '';
        // 无 Key：明确降级提示 + 纯检索素材列表（gather 不依赖 AI）
        if (/API Key/i.test(msg)) {
          const err = document.createElement('div');
          err.className = 'nj-research-error';
          err.textContent = msg;
          bubble.appendChild(err);
          try {
            const g = await window.robin.ragGather(question);
            const materials = g?.materials || [];
            if (materials.length) {
              const label = document.createElement('div');
              label.className = 'nj-rag-retrieval-label';
              label.textContent = tf('已找到 %lld 条相关素材（未配置 AI，仅检索模式）', materials.length);
              bubble.appendChild(label);
              const list = document.createElement('div');
              list.className = 'nj-rag-materials';
              materials.forEach((m, i) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'nj-rag-material';
                item.innerHTML = `<span class="nj-rag-material-n"></span><span class="nj-rag-material-body"><b></b><i></i></span>`;
                item.querySelector('.nj-rag-material-n').textContent = String(i + 1);
                item.querySelector('.nj-rag-material-body b').textContent = m.title || t('（无标题）');
                item.querySelector('.nj-rag-material-body i').textContent = m.snippet || '';
                item.addEventListener('click', (e) => { e.stopPropagation(); this._showSourcePopover(m, item); });
                list.appendChild(item);
              });
              bubble.appendChild(list);
            }
          } catch (_) { /* 纯检索也失败：仅保留错误提示 */ }
        } else {
          bubble.textContent = msg;
        }
      } finally {
        this._endRagRun(unsubscribe);
        if (seq === this._rag.seq) {
          setStreaming(false);
          setBusy(false);
          scrollBottom();
        }
      }
    };
    askBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });

    newBtn.addEventListener('click', () => {
      if (this._rag.running) return;
      this._rag.sessionID = null;
      renderEmptyHint();
      renderSessionList(sessions);
      input.focus();
    });
    setTimeout(() => input.focus(), 50);
  }

  // ── AI 研究（F8）：主题输入 + 历史列表 + 流式带引用报告 + 追问 ──

  /** rAF 合帧渲染器（今日简报同款）：高频 delta 一帧至多一次重建。 */
  _rafPainter(render) {
    let rafPending = false;
    return () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        render();
      });
    };
  }

  /** 订阅流式分片与阶段推送（seq 守卫：过期会话的事件全部忽略）。返回统一退订器。 */
  _subscribeResearchEvents(seq, { onDelta, onStatus }) {
    const offDelta = window.robin.onResearchDelta?.((p) => {
      if (this._research.running && this._research.seq === seq) onDelta?.(p);
    });
    const offStatus = window.robin.onResearchStatus?.((p) => {
      if (this._research.running && this._research.seq === seq) onStatus?.(p);
    });
    return () => { offDelta?.(); offStatus?.(); };
  }

  /** 结束一次研究运行：退订 + 释放单飞标记。 */
  _endResearchRun(unsubscribe) {
    if (unsubscribe) unsubscribe();
    if (this._research.unsubscribe === unsubscribe) this._research.unsubscribe = null;
    this._research.running = false;
    this._research.mode = null;
  }

  /**
   * F13 线索视图：自动聚类近 90 天文章为「线索」（关键词 + 时间线）。
   * 两次渲染：先列表（Top 12 线索）→ 点开线索拉时间线详情；可一键追踪为话题。
   */
  async _renderThreads() {
    const host = this.contentHost;
    if (!host) return;
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'kb-threads';
    const head = document.createElement('div');
    head.className = 'kb-graph-head';
    head.innerHTML = `<span class="kb-daily-title">${escapeHTML(t('线索'))}</span><span class="kb-graph-legend">${escapeHTML(t('近 90 天文章按话题自动聚类，点开看时间线，可一键转为盯梢话题。'))}</span>`;
    wrap.appendChild(head);
    const listEl = document.createElement('div');
    listEl.className = 'kb-threads-list';
    wrap.appendChild(listEl);
    host.appendChild(wrap);

    let threads = [];
    try {
      const res = await window.robin.threadsList();
      threads = Array.isArray(res?.threads) ? res.threads : [];
    } catch (_) { /* 读失败给空态 */ }
    if (this.contentHost !== host) return; // 时序守卫：已切走丢弃

    if (!threads.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:32px 16px;text-align:center;color:var(--text-tertiary);font-size:12.5px;';
      empty.textContent = t('近期文章还聚不出线索——多读几天、或订阅更多同主题源后再来看看。');
      listEl.appendChild(empty);
      return;
    }
    for (const th of threads) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'kb-thread-row';
      const kw = document.createElement('span');
      kw.className = 'kb-thread-kw';
      kw.textContent = th.keyword || '';
      const count = document.createElement('span');
      count.className = 'kb-thread-count';
      count.textContent = tf('%lld 篇', Number(th.count) || 0);
      row.append(kw, count);
      row.addEventListener('click', () => this._openThreadDetail(th.keyword));
      listEl.appendChild(row);
    }
  }

  /** 线索时间线详情：该关键词下文章按时间降序；「追踪为话题」走 TopicService 预填。 */
  async _openThreadDetail(keyword) {
    const host = this.contentHost;
    if (!host) return;
    const prev = host.firstChild; // 返回入口：记住列表视图
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'kb-thread-detail';
    const head = document.createElement('div');
    head.className = 'kb-graph-head';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn-text';
    back.textContent = t('返回线索');
    back.addEventListener('click', () => { host.innerHTML = ''; if (prev) host.appendChild(prev); });
    const title = document.createElement('span');
    title.className = 'kb-daily-title';
    title.style.marginLeft = '8px';
    title.textContent = `# ${keyword}`;
    const track = document.createElement('button');
    track.type = 'button';
    track.className = 'btn-text primary';
    track.style.marginLeft = 'auto';
    track.textContent = t('追踪为话题');
    track.addEventListener('click', async () => {
      try {
        await window.robin.topicsSave({ keywords: [keyword], lanes: { local: true, aihot: true, pool: false } });
        const { alertBox } = await import('../ui-prompt.js');
        await alertBox(t('已创建盯梢话题'), t('在侧栏「话题」或知识中心可查看其聚合信息流。'));
      } catch (e) {
        const { alertBox } = await import('../ui-prompt.js');
        await alertBox(t('创建失败'), String(e && e.message || e));
      }
    });
    head.append(back, title, track);
    wrap.appendChild(head);
    const listEl = document.createElement('div');
    wrap.appendChild(listEl);
    host.innerHTML = '';
    host.appendChild(wrap);

    let items = [];
    try {
      const res = await window.robin.threadsDetail(keyword);
      items = Array.isArray(res?.entries) ? res.entries : [];
    } catch (_) { /* 读失败给空态 */ }
    if (this.contentHost !== host) return;

    if (!items.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:24px 16px;color:var(--text-tertiary);font-size:12.5px;';
      empty.textContent = t('这个线索下暂无文章。');
      listEl.appendChild(empty);
      return;
    }
    for (const it of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'kb-thread-item';
      const title = document.createElement('div');
      title.className = 'kb-thread-item-title';
      title.textContent = it.title || '';
      const meta = document.createElement('div');
      meta.className = 'kb-thread-item-meta';
      meta.textContent = [it.feedTitle, timeAgo(it.publishedAt)].filter(Boolean).join(' · ');
      row.append(title, meta);
      row.addEventListener('click', () => {
        if (it.id && window.__robinReaderOpen) { window.__robinReaderOpen(it.id); }
        else if (it.url) window.robin.openLink(it.url);
      });
      listEl.appendChild(row);
    }
  }

  _renderResearch(list) {
    const wrap = document.createElement('div');
    this._research.tabHost = wrap; // 完成回调判「用户是否仍停留本 tab」用
    const head = document.createElement('div');
    head.className = 'kb-graph-head';
    head.innerHTML = `<span class="kb-daily-title">${escapeHTML(t('AI 研究'))}</span><span class="kb-graph-legend">${escapeHTML(t('聚合你的订阅库与 AIHOT 素材，生成带引用编号的研究报告，可继续追问。'))}</span>`;
    wrap.appendChild(head);

    const inputRow = document.createElement('div');
    inputRow.className = 'kb-ask-row nj-research-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'kb-ask-input nj-research-input';
    input.placeholder = t('输入研究主题，如：端侧大模型的最新进展');
    const goBtn = document.createElement('button');
    goBtn.className = 'btn-text primary kb-ask-btn nj-research-go';
    goBtn.textContent = t('开始研究');
    inputRow.append(input, goBtn);
    wrap.appendChild(inputRow);

    const statusBar = document.createElement('div');
    statusBar.className = 'nj-research-status';
    statusBar.style.display = 'none';
    // 阶段文本独立 span：textContent 直写 statusBar 会连带清掉子级取消按钮（F9 修复顺带）
    const statusText = document.createElement('span');
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-text nj-research-cancel';
    cancelBtn.style.display = 'none';
    cancelBtn.style.marginLeft = '8px';
    cancelBtn.textContent = t('取消生成');
    cancelBtn.addEventListener('click', () => { try { window.robin.researchCancel(); } catch (_) { /* 服务层取消，草稿保留 */ } });
    statusBar.append(statusText, cancelBtn);
    wrap.appendChild(statusBar);

    const liveHost = document.createElement('div');
    liveHost.className = 'nj-research-live';
    liveHost.style.display = 'none';
    wrap.appendChild(liveHost);

    const errBox = document.createElement('div');
    errBox.className = 'nj-research-error';
    errBox.style.display = 'none';
    wrap.appendChild(errBox);

    const lbl = document.createElement('div');
    lbl.className = 'td-section-label';
    lbl.textContent = t('历史研究');
    wrap.appendChild(lbl);
    const listHost = document.createElement('div');
    wrap.appendChild(listHost);
    this.contentHost.appendChild(wrap);

    const setBusy = (busy) => { goBtn.disabled = busy; input.disabled = busy; };
    const phaseText = (phase) => ({
      gather: t('正在聚合素材…'),
      generate: t('正在生成报告…'),
      followup: t('正在回答追问…'),
    }[phase] || '');

    const submit = async () => {
      const topic = input.value.trim();
      if (!topic || this._research.running) return;
      this._research.running = true;
      this._research.mode = 'generate';
      this._research.seq = (this._research.seq || 0) + 1;
      const seq = this._research.seq;
      setBusy(true);
      errBox.style.display = 'none';
      errBox.textContent = '';
      liveHost.style.display = '';
      liveHost.innerHTML = '';
      statusBar.style.display = '';
      statusText.textContent = t('正在聚合素材…');
      cancelBtn.style.display = '';
      let streamed = '';
      const paint = this._rafPainter(() => {
        if (seq !== this._research.seq || !document.body.contains(liveHost)) return;
        liveHost.innerHTML = renderMarkdown(streamed);
      });
      const unsubscribe = this._subscribeResearchEvents(seq, {
        onDelta: (p) => { streamed += p?.delta || ''; paint(); },
        onStatus: (p) => { const txt = phaseText(p?.phase); if (txt) statusText.textContent = txt; },
      });
      this._research.unsubscribe = unsubscribe;
      try {
        const res = await window.robin.researchGenerate(topic);
        if (seq !== this._research.seq) return; // 页面已切走：后台照常落库
        if (!res || res.ok === false) throw new Error(res?.error || t('生成失败'));
        const { report, cancelled } = res.data || {};
        const fresh = report?.id ? ((await window.robin.researchGet(report.id)) || report) : report;
        this._endResearchRun(unsubscribe);
        // 完成回调仅在用户仍停留本 tab（research 视图仍挂在 DOM）时跳详情；
        // 生成中切走的不抢屏——报告留在历史列表，用户自行重开
        if (fresh && this._research.tabHost && this._research.tabHost.isConnected) {
          this._openResearchDetail(fresh, { draft: cancelled || !fresh.isComplete });
        }
      } catch (error) {
        if (seq !== this._research.seq) return;
        liveHost.style.display = 'none';
        errBox.style.display = '';
        // 无 Key / AI 失败：明确降级提示（不隐藏功能，输入框在 finally 里恢复可用）
        errBox.textContent = String(error?.message || error) || t('生成失败');
      } finally {
        this._endResearchRun(unsubscribe);
        if (seq === this._research.seq) {
          statusBar.style.display = 'none';
          cancelBtn.style.display = 'none';
          setBusy(false);
        }
      }
    };
    goBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
    setTimeout(() => input.focus(), 50);

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'nj-topic-empty';
      empty.innerHTML = `<div class="glyph">${icon('spark')}</div><h3></h3><p></p>`;
      empty.querySelector('h3').textContent = t('还没有研究报告');
      empty.querySelector('p').textContent = t('输入一个主题，开始第一次研究。');
      listHost.appendChild(empty);
      return;
    }
    for (const item of list) listHost.appendChild(this._researchRow(item));
  }

  _researchRow(item) {
    const row = document.createElement('div');
    row.className = 'nj-research-item';
    const main = document.createElement('div');
    main.className = 'nj-research-item-main';
    const title = document.createElement('div');
    title.className = 'nj-research-item-topic';
    title.textContent = item.topic;
    const meta = document.createElement('div');
    meta.className = 'nj-research-item-meta';
    meta.textContent = [
      item.isComplete ? '' : t('草稿 · 未完成'),
      tf('%lld 条素材', item.sourceCount || 0),
      timeAgo(item.updatedAt),
    ].filter(Boolean).join(' · ');
    main.append(title, meta);
    const del = document.createElement('button');
    del.className = 'btn icon-only';
    del.innerHTML = icon('trash');
    del.title = t('删除报告');
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmBox(t('删除报告'), { message: t('确定删除这份研究报告吗？此操作无法撤销。'), okLabel: t('删除'), danger: true });
      if (!ok) return;
      await window.robin.researchDelete(item.id);
      this._load();
    });
    row.append(main, del);
    row.addEventListener('click', async () => {
      const report = await window.robin.researchGet(item.id);
      if (report) this._openResearchDetail(report, { draft: !report.isComplete });
    });
    return row;
  }

  /** 报告详情：Markdown 渲染 + [n] 引用芯片 + 追问输入（流式追加）。 */
  _openResearchDetail(report, { draft = false } = {}) {
    if (!report) return;
    this._research.seq = (this._research.seq || 0) + 1;
    this.contentHost.innerHTML = '';
    const back = document.createElement('button');
    back.className = 'btn-text bordered';
    back.style.marginBottom = '12px';
    back.innerHTML = `${icon('chevronMenuRight')}<span style="margin-left:4px">${escapeHTML(t('返回列表'))}</span>`;
    back.addEventListener('click', () => this._load());
    this.contentHost.appendChild(back);

    if (draft || !report.isComplete) {
      const note = document.createElement('div');
      note.className = 'nj-research-draft-note';
      note.textContent = t('未完成草稿：生成被取消，已收到的部分已保留。');
      this.contentHost.appendChild(note);
    }

    const head = document.createElement('div');
    head.className = 'nj-research-detail-head';
    const title = document.createElement('h3');
    title.className = 'nj-research-detail-topic';
    title.textContent = report.topic;
    const meta = document.createElement('div');
    meta.className = 'nj-research-detail-meta';
    meta.textContent = [tf('%lld 条素材', (report.sources || []).length), t('点击 [n] 查看来源')].filter(Boolean).join(' · ');
    head.append(title, meta);
    this.contentHost.appendChild(head);

    const body = document.createElement('div');
    body.className = 'nj-research-report';
    body.innerHTML = renderMarkdown(report.reportMd || t('（空报告）'));
    this._linkifyCitations(body, report.sources || []);
    this.contentHost.appendChild(body);

    const followRow = document.createElement('div');
    followRow.className = 'kb-ask-row nj-research-follow';
    const followInput = document.createElement('input');
    followInput.type = 'text';
    followInput.className = 'kb-ask-input nj-research-follow-input';
    followInput.placeholder = t('继续追问这份报告…');
    const followBtn = document.createElement('button');
    followBtn.className = 'btn-text primary kb-ask-btn nj-research-follow-btn';
    followBtn.textContent = t('追问');
    followRow.append(followInput, followBtn);
    this.contentHost.appendChild(followRow);

    const followLive = document.createElement('div');
    followLive.className = 'nj-research-live';
    followLive.style.display = 'none';
    this.contentHost.appendChild(followLive);
    const followErr = document.createElement('div');
    followErr.className = 'nj-research-error';
    followErr.style.display = 'none';
    this.contentHost.appendChild(followErr);

    const submitFollow = async () => {
      const q = followInput.value.trim();
      if (!q || this._research.running) return;
      this._research.running = true;
      this._research.mode = 'followUp';
      this._research.seq = (this._research.seq || 0) + 1;
      const seq = this._research.seq;
      followBtn.disabled = true;
      followInput.disabled = true;
      followErr.style.display = 'none';
      followErr.textContent = '';
      followLive.style.display = '';
      followLive.innerHTML = `<div class="nj-research-status">${escapeHTML(t('正在回答追问…'))}</div>`;
      let streamed = '';
      const paint = this._rafPainter(() => {
        if (seq !== this._research.seq || !document.body.contains(followLive)) return;
        followLive.innerHTML = renderMarkdown(streamed);
      });
      const unsubscribe = this._subscribeResearchEvents(seq, {
        onDelta: (p) => { streamed += p?.delta || ''; paint(); },
        onStatus: (p) => {
          if (p?.phase === 'followup' && seq === this._research.seq && !streamed) {
            followLive.innerHTML = `<div class="nj-research-status">${escapeHTML(t('正在回答追问…'))}</div>`;
          }
        },
      });
      this._research.unsubscribe = unsubscribe;
      try {
        const res = await window.robin.researchFollowUp(report.id, q);
        if (seq !== this._research.seq) return;
        if (!res || res.ok === false) throw new Error(res?.error || t('生成失败'));
        const fresh = res.data?.report || await window.robin.researchGet(report.id);
        this._endResearchRun(unsubscribe);
        if (fresh) this._openResearchDetail(fresh, { draft: !fresh.isComplete });
      } catch (error) {
        if (seq !== this._research.seq) return;
        followLive.style.display = 'none';
        followErr.style.display = '';
        followErr.textContent = String(error?.message || error) || t('生成失败');
      } finally {
        this._endResearchRun(unsubscribe);
        if (seq === this._research.seq) {
          followBtn.disabled = false;
          followInput.disabled = false;
        }
      }
    };
    followBtn.addEventListener('click', submitFollow);
    followInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') submitFollow(); });
    setTimeout(() => followInput.focus(), 50);
  }

  /** [n] 引用编号 → 可点击来源芯片（严格只链接素材列表内的编号）。 */
  _linkifyCitations(host, sources) {
    if (!host || !Array.isArray(sources)) return;
    const total = sources.length;
    const re = /\[(\d{1,3})\]/g;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) {
      const text = node.nodeValue || '';
      re.lastIndex = 0;
      if (!re.test(text)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const n = Number(m[1]);
        if (n >= 1 && n <= total) {
          const chip = document.createElement('button');
          chip.className = 'dg-ref';
          chip.type = 'button';
          chip.textContent = String(n);
          chip.title = sources[n - 1]?.title || '';
          chip.addEventListener('click', (e) => {
            e.stopPropagation();
            this._showSourcePopover(sources[n - 1], chip);
          });
          frag.appendChild(chip);
        } else {
          frag.appendChild(document.createTextNode(m[0]));
        }
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  /** 素材原文浮层：snippet + 打开原文（entryID → 阅读器 / url → 外链精读，F4 双通路）。
   *  F9 全库问答素材用 kind（article/highlight/note/hot），F8 研究素材用 lane——两者归一到 lane 徽标。 */
  _showSourcePopover(material, anchor) {
    if (!material) return;
    document.querySelectorAll('.nj-research-pop').forEach((n) => n.remove());
    const kindToLane = { article: 'local', highlight: 'knowledge', note: 'knowledge', hot: 'aihot' };
    const lane = material.lane || kindToLane[material.kind] || 'local';
    const pop = document.createElement('div');
    pop.className = 'nj-research-pop';
    const laneLabels = { local: t('本库'), knowledge: t('知识库'), aihot: 'AIHOT' };
    const head = document.createElement('div');
    head.className = 'nj-research-pop-head';
    const badge = document.createElement('span');
    badge.className = `nj-topic-lane-badge lane-${lane}`;
    badge.textContent = laneLabels[lane] || lane || '';
    const src = document.createElement('span');
    src.className = 'nj-research-pop-source';
    src.textContent = material.source || '';
    head.append(badge, src);
    const title = document.createElement('div');
    title.className = 'nj-research-pop-title';
    title.textContent = material.title || '';
    const snip = document.createElement('div');
    snip.className = 'nj-research-pop-snippet';
    snip.textContent = material.snippet || t('（无摘要）');
    pop.append(head, title, snip);
    if (material.entryID || material.url) {
      const open = document.createElement('button');
      open.className = 'btn-text primary nj-research-pop-open';
      open.textContent = t('打开原文');
      open.addEventListener('click', () => {
        cleanup();
        if (material.entryID) this.handlers.onOpenArticle?.(material.entryID);
        else if (material.url) this.handlers.onOpenURL?.(material.url);
      });
      pop.appendChild(open);
    }
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 300;
    const ph = pop.offsetHeight || 160;
    pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - pw - 12))}px`;
    pop.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - ph - 12)}px`;
    const cleanup = () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      pop.remove();
    };
    const onDown = (e) => { if (!pop.contains(e.target)) cleanup(); };
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        e.stopImmediatePropagation(); // 只关浮层，不让知识中心 modal 一起退场
        cleanup();
      }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }

  _renderTags(data) {
    // F15：数据面 = { all: 全部标签计数, rows: [{tag,source,count}] }。
    // 复核过滤 chips（全部/手动/AI/继承）只切换展示口径——数据与既有标签逻辑零改动。
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const all = Array.isArray(data.all) ? data.all : [];
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'kb-daily-head';
    head.innerHTML = `<span class="kb-daily-title">${escapeHTML(t('标签云'))}</span><span class="kb-daily-sub">${escapeHTML(t('点击标签查看相关文章 · 字号与色深代表文章数'))}</span>`;
    wrap.appendChild(head);

    // 复核过滤 chips
    const chips = document.createElement('div');
    chips.className = 'kb-tag-chips';
    chips.setAttribute('role', 'tablist');
    for (const f of TAG_FILTERS) {
      const chip = document.createElement('button');
      chip.className = `kb-tag-chip ${this.tagFilter === f.id ? 'active' : ''}`;
      chip.setAttribute('role', 'tab');
      chip.setAttribute('aria-selected', this.tagFilter === f.id ? 'true' : 'false');
      chip.textContent = t(f.label);
      chip.addEventListener('click', () => {
        if (this.tagFilter === f.id) return;
        this.tagFilter = f.id;
        this._renderContent(); // 清空 contentHost 后按缓存数据重渲染（只过滤展示，不重拉）
      });
      chips.appendChild(chip);
    }
    wrap.appendChild(chips);

    // 按当前过滤口径聚合：all=全部求和；manual/ai/inherit=仅该来源
    const counts = new Map();
    if (this.tagFilter === 'all') {
      for (const { tag, count } of all) counts.set(tag, (counts.get(tag) || 0) + (Number(count) || 0));
    } else {
      for (const row of rows) {
        if (row.source !== this.tagFilter) continue;
        counts.set(row.tag, (counts.get(row.tag) || 0) + (Number(row.count) || 0));
      }
    }
    const tags = [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

    if (!tags.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.innerHTML = `<div class="glyph">${icon('spark')}</div><h3>${escapeHTML(t('该来源暂无标签'))}</h3><p>${escapeHTML(t('AI 自动标签开启后，新文章会在这里等待复核。'))}</p>`;
      wrap.appendChild(empty);
      this.contentHost.appendChild(wrap);
      return;
    }
    const cloud = document.createElement('div');
    cloud.className = 'kb-tag-cloud';
    const max = Math.max(1, ...tags.map((x) => x.count));
    for (const { tag, count } of tags.slice(0, 80)) {
      // 四档字号（对数分层，头部标签明显更大）；色相由标签名散列（稳定不变）
      const tier = count >= Math.max(4, max * 0.5) ? 't1' : count >= 3 ? 't2' : count >= 2 ? 't3' : 't4';
      let hash = 0;
      for (const ch of tag) hash = (hash * 31 + ch.codePointAt(0)) % 360;
      const chip = document.createElement('button');
      chip.className = `kb-tag2 ${tier}`;
      chip.style.setProperty('--tag-h', String((hash * 47) % 360));
      const label = document.createElement('span');
      label.className = 'kb-tag2-label';
      label.textContent = tag;
      const badge = document.createElement('i');
      badge.className = 'kb-tag2-n';
      badge.textContent = count;
      chip.append(label, badge);
      chip.title = t('点击查看「' + tag + '」的相关文章');
      chip.addEventListener('click', () => this._viewTagArticles(tag));
      cloud.appendChild(chip);
    }
    wrap.appendChild(cloud);
    this.contentHost.appendChild(wrap);
  }

  /** 点击标签 → 列出带该标签的文章（article_tags 真关系查询）。 */
  async _viewTagArticles(tag) {
    this.contentHost.innerHTML = '';
    const back = document.createElement('button');
    back.className = 'btn-text bordered';
    back.style.marginBottom = '12px';
    back.innerHTML = `${icon('chevronMenuRight')}<span style="margin-left:4px">${escapeHTML(t('返回标签云'))}</span>`;
    back.addEventListener('click', () => { this.tab = 'tags'; this._render(); this._load(); });
    this.contentHost.appendChild(back);
    const lbl = document.createElement('div');
    lbl.className = 'td-section-label';
    lbl.textContent = t('标签「' + tag + '」');
    this.contentHost.appendChild(lbl);
    const items = (await window.robin.kbEntriesForTag(tag, 30)) || [];
    if (!items.length) {
      this._emptyIn(this.contentHost, '暂无相关文章', '这个标签还没有关联文章。');
      return;
    }
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'kb-card';
      card.innerHTML = `<div class="kb-note-content"></div><div class="kb-card-source">${icon('newspaper')}<span></span></div>`;
      card.querySelector('.kb-note-content').textContent = it.title || it.id;
      card.querySelector('.kb-card-source span').textContent = it.feed_title || '';
      card.addEventListener('click', () => this.handlers.onOpenArticle?.(it.id));
      this.contentHost.appendChild(card);
    }
  }

  // ── 源体检（F16）：总览卡 + 健康分排序列表 + 单源详情 ──

  static DASH_CARDS = [
    { id: 'top', label: '健康源' },
    { id: 'silent', label: '沉默源' },
    { id: 'failing', label: '失败源' },
  ];

  _renderDash(data) {
    const feeds = Array.isArray(data.feeds) ? data.feeds : [];
    const summary = data.summary || { total: feeds.length, top: 0, silent: 0, failing: 0 };
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'kb-daily-head';
    head.innerHTML = `<span class="kb-daily-title">${escapeHTML(t('源体检'))}</span><span class="kb-daily-sub">${escapeHTML(t('每源近 30 天发文 / 阅读 / 抓取健康，按健康分排序。'))}</span>`;
    wrap.appendChild(head);

    if (!feeds.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.innerHTML = `<div class="glyph">${icon('flame')}</div><h3>${escapeHTML(t('暂无订阅源'))}</h3><p>${escapeHTML(t('添加订阅后，这里会给出每份源的健康体检。'))}</p>`;
      wrap.appendChild(empty);
      this.contentHost.appendChild(wrap);
      return;
    }

    // 总览三卡：点击过滤（再点一次取消）
    const cards = document.createElement('div');
    cards.className = 'kb-dash-cards';
    for (const def of KnowledgeCenter.DASH_CARDS) {
      const card = document.createElement('button');
      card.className = `kb-dash-card ${this.dashFilter === def.id ? 'active' : ''}`;
      card.innerHTML = `<span class="kb-dash-card-num"></span><span class="kb-dash-card-label"></span>`;
      card.querySelector('.kb-dash-card-num').textContent = String(summary[def.id] ?? 0);
      card.querySelector('.kb-dash-card-label').textContent = t(def.label);
      card.title = t('点击筛选') + ' · ' + t(def.label);
      card.addEventListener('click', () => {
        this.dashFilter = this.dashFilter === def.id ? null : def.id;
        this._renderContent(); // 清空 contentHost 后按缓存数据重渲染（不发新请求）
      });
      cards.appendChild(card);
    }
    wrap.appendChild(cards);

    const filtered = this.dashFilter
      ? feeds.filter((f) => this.dashFilter === 'top' ? f.score >= 80
        : this.dashFilter === 'silent' ? f.posts30 === 0
          : (f.consecutiveFailures >= 3 || f.isDead))
      : feeds;
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.innerHTML = `<div class="glyph">${icon('flame')}</div><h3>${escapeHTML(t('没有匹配的源'))}</h3><p>${escapeHTML(t('换个筛选条件试试。'))}</p>`;
      wrap.appendChild(empty);
      this.contentHost.appendChild(wrap);
      return;
    }

    const list = document.createElement('div');
    list.className = 'kb-dash-list';
    const maxTrend = Math.max(1, ...filtered.map((f) => Math.max(...(f.trend || [0]))));
    for (const f of filtered) {
      const row = document.createElement('button');
      row.className = 'kb-dash-row';
      row.innerHTML = `
        <span class="kb-dash-icon"><img alt="" referrerpolicy="no-referrer"/></span>
        <span class="kb-dash-main">
          <span class="kb-dash-title"></span>
          <span class="kb-dash-meta"></span>
          <span class="kb-dash-bars"></span>
        </span>
        <span class="kb-dash-score-badge"></span>`;
      const img = row.querySelector('img');
      if (f.iconURL) { img.src = f.iconURL; img.onerror = () => { img.remove(); }; }
      else img.remove();
      row.querySelector('.kb-dash-title').textContent = f.title || f.feedID;
      row.querySelector('.kb-dash-meta').textContent = f.lastSuccessAt
        ? `${t('最近成功抓取')} · ${timeAgo(f.lastSuccessAt)}`
        : t('暂无抓取记录');
      const bars = row.querySelector('.kb-dash-bars');
      for (const n of (f.trend || [])) {
        const bar = document.createElement('i');
        bar.style.height = `${Math.max(2, Math.round((n / maxTrend) * 18))}px`;
        bar.title = `${n}`;
        bars.appendChild(bar);
      }
      const badge = row.querySelector('.kb-dash-score-badge');
      badge.className = `kb-dash-score-badge ${f.band || 'bad'}`;
      badge.textContent = String(f.score ?? 0);
      badge.title = t('健康分') + ` ${f.score} / 100`;
      row.addEventListener('click', () => this._dashDetail(f.feedID));
      list.appendChild(row);
    }
    wrap.appendChild(list);
    this.contentHost.appendChild(wrap);
  }

  /** 单源详情：7 天失败口径 + 月发文趋势 + 建议文案。 */
  async _dashDetail(feedID) {
    this.contentHost.innerHTML = '';
    const back = document.createElement('button');
    back.className = 'btn-text bordered';
    back.style.marginBottom = '12px';
    back.innerHTML = `${icon('chevronMenuRight')}<span style="margin-left:4px">${escapeHTML(t('返回源体检'))}</span>`;
    back.addEventListener('click', () => { this.tab = 'dash'; this._render(); this._load(); });
    this.contentHost.appendChild(back);

    const d = await window.robin.dashFeed(feedID);
    if (!d) { this._emptyIn(this.contentHost, '暂无数据', '该订阅源可能已被删除。'); return; }

    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'kb-daily-head';
    head.innerHTML = `<span class="kb-daily-title"></span><span class="kb-dash-score-badge"></span>`;
    head.querySelector('.kb-daily-title').textContent = d.title || feedID;
    const badge = head.querySelector('.kb-dash-score-badge');
    badge.className = `kb-dash-score-badge ${d.band || 'bad'}`;
    badge.textContent = `${d.score ?? 0} / 100`;
    wrap.appendChild(head);

    const metrics = document.createElement('div');
    metrics.className = 'kb-dash-metrics';
    const rows = [
      [t('30 天发文'), String(d.posts30 ?? 0)],
      [t('阅读率'), `${Math.round((d.readRate || 0) * 100)}%`],
      [t('收藏率'), `${Math.round((d.starRate || 0) * 100)}%`],
      [t('打开次数'), String(d.opens30 ?? 0)],
      [t('抓取失败率'), `${Math.round((d.failureRate || 0) * 100)}%`],
      [t('连续失败'), String(d.consecutiveFailures ?? 0)],
      [t('最近成功抓取'), d.lastSuccessAt ? timeAgo(d.lastSuccessAt) : t('暂无抓取记录')],
    ];
    for (const [label, value] of rows) {
      const line = document.createElement('div');
      line.className = 'kb-dash-metric';
      line.innerHTML = `<span></span><b></b>`;
      line.querySelector('span').textContent = label;
      line.querySelector('b').textContent = value;
      metrics.appendChild(line);
    }
    wrap.appendChild(metrics);

    // 30 天发文趋势（迷你条形，纯 div 条——与列表共用画法）
    const trendHead = document.createElement('div');
    trendHead.className = 'td-section-label';
    trendHead.textContent = t('30 天发文趋势');
    wrap.appendChild(trendHead);
    const trend = document.createElement('div');
    trend.className = 'kb-dash-trend';
    const maxN = Math.max(1, ...(d.trend || [0]));
    for (const n of (d.trend || [])) {
      const bar = document.createElement('i');
      bar.style.height = `${Math.max(2, Math.round((n / maxN) * 40))}px`;
      bar.title = String(n);
      trend.appendChild(bar);
    }
    wrap.appendChild(trend);

    // 建议文案
    const sugHead = document.createElement('div');
    sugHead.className = 'td-section-label';
    sugHead.textContent = t('体检建议');
    wrap.appendChild(sugHead);
    for (const sug of (d.suggestions || [])) {
      const line = document.createElement('div');
      line.className = 'kb-dash-suggestion';
      line.textContent = sug.code === 'consecutiveFailures'
        ? tf('连续失败 %lld 次，建议检查源', sug.count)
        : sug.code === 'highFailureRate'
          ? tf('抓取失败率 %lld%，建议检查源', sug.rate)
          : t({
            noUpdate30d: '30 天无更新',
            neverSucceeded: '从未成功抓取，请检查源地址',
            healthy: '运行良好',
          }[sug.code] || '运行良好');
      wrap.appendChild(line);
    }
    this.contentHost.appendChild(wrap);
  }

  /** 智能文件夹：列出 + 新建 + 删除。 */
  _renderSmartFolders(folders) {    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'kb-daily-head';
    head.innerHTML = `<span class="kb-daily-title">${escapeHTML(t('智能文件夹'))}</span><span class="kb-daily-sub">${escapeHTML(t('按关键词自动归档'))}</span>`;
    wrap.appendChild(head);
    if (!folders.length) {
      this._emptyIn(wrap, '还没有智能文件夹', '创建一个按关键词自动聚合文章的智能文件夹。');
    }
    for (const f of folders) {
      const row = document.createElement('div');
      row.className = 'evo-feedback-row';
      row.innerHTML = `<span style="display:flex;align-items:center;gap:8px">${icon('ai')}<b>${escapeHTML(f.name)}</b></span>
        <span style="display:flex;align-items:center;gap:8px"><span style="color:var(--text-tertiary)">${escapeHTML(f.query || '')}</span>
        <button class="btn-text" data-open="${attr(f.id)}">${escapeHTML(t('打开'))}</button>
        <button class="btn icon-only" data-del="${attr(f.id)}" title="${attr(t('删除'))}">${icon('trash')}</button></span>`;
      row.querySelector('[data-open]').addEventListener('click', () => {
        this.handlers.onOpenSmartFolder?.({ name: f.name, query: f.query || '' });
      });
      row.querySelector('[data-del]').addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.robin.kbDeleteSmartFolder(f.id);
        this._load();
      });
      wrap.appendChild(row);
    }
    const add = document.createElement('button');
    add.className = 'btn-text primary';
    add.style.marginTop = '14px';
    add.textContent = t('新建智能文件夹');
    add.addEventListener('click', () => this._promptNewSmartFolder());
    wrap.appendChild(add);
    this.contentHost.appendChild(wrap);
  }

  async _promptNewSmartFolder() {
    const name = await promptBox(t('智能文件夹名称'));
    if (!name?.trim()) return;
    const query = await promptBox(t('关键词（匹配文章标题/标签，逗号分隔）'));
    if (query === null) return;
    await window.robin.kbCreateSmartFolder(name.trim(), (query || '').trim());
    this._load();
  }

  _empty(title, desc) {
    this.contentHost.innerHTML = `<div class="list-empty"><div class="glyph">${icon('spark')}</div><h3>${escapeHTML(t(title))}</h3><p>${escapeHTML(t(desc))}</p></div>`;
  }
}

function escapeHTML(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function attr(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
