'use strict';
/**
 * RobinRead（知更）— 话题视图（F4 话题盯梢）
 *
 * 单浮层双态：管理页（话题卡片列表 + 新建/编辑表单）与信息流页（话题聚合文章）。
 * - 三路聚合：本库（本地匹配）/ AIHOT（热点过滤）/ 源池（feed-pool 命中源抓取）；
 * - 信息流行点击：本库命中（entryID）直达阅读器；AIHOT/池命中走 onOpenURL 外链通路；
 * - 「立即聚合」手动触发 + 结果 toast；Esc 关闭（defaultPrevented 守卫与既有浮层家族一致）；
 * - 不可信回显一律 textContent；样式全 OKLCH 令牌（robin.css nj-topic-* 区块）。
 */
import { t, tf } from '../i18n.js';
import { icon } from '../icons.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fmtWhen(epochSeconds) {
  const ms = Number(epochSeconds) * 1000;
  if (!ms) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  } catch (_) { return ''; }
}

const LANE_LABELS = [
  ['local', '本库订阅'],
  ['aihot', 'AIHOT 热点'],
  ['pool', '订阅源池'],
];

export class TopicView {
  /**
   * @param deps.onOpenEntry(itemID) 本库命中 → 打开阅读器
   * @param deps.onOpenURL(url) 外部命中 → 任意链接精读/外链通路
   * @param deps.toast?(message)
   */
  constructor(deps = {}) {
    this.deps = {
      onOpenEntry: deps.onOpenEntry || (() => {}),
      onOpenURL: deps.onOpenURL || (() => {}),
      toast: deps.toast || null,
    };
    this.mode = 'manage';
    this.currentTopic = null;
    this._keyHandler = null;
  }

  present() {
    if (this.overlay) return;
    const overlay = el('div', 'modal-overlay nj-topic-overlay');
    const modal = el('div', 'modal nj-topic-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', t('话题盯梢'));
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.modal = modal;

    this._keyHandler = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (this.mode === 'stream') { this._showManage(); event.preventDefault(); return; }
        this.dismiss();
      }
    };
    document.addEventListener('keydown', this._keyHandler);
    this._showManage();
  }

  dismiss() {
    if (!this.overlay) return;
    if (this._keyHandler) { document.removeEventListener('keydown', this._keyHandler); this._keyHandler = null; }
    const overlay = this.overlay;
    this.overlay = null;
    this.modal = null;
    this.currentTopic = null;
    this.mode = 'manage';
    overlay.remove();
  }

  /** 外部入口：右键「盯梢这类内容」预填关键词。 */
  presentCreate(prefill = '') {
    this.present();
    this._showForm({ keywordsText: String(prefill || '') });
  }

  // MARK: - 管理页

  async _showManage() {
    this.mode = 'manage';
    this.currentTopic = null;
    const modal = this.modal;
    if (!modal) return;
    modal.innerHTML = '';
    const head = el('div', 'nj-topic-head');
    const title = el('h3', null, t('话题盯梢'));
    const add = el('button', 'btn-text primary');
    add.type = 'button';
    add.textContent = t('新建话题');
    add.addEventListener('click', () => this._showForm({}));
    const close = el('button', 'btn icon-only');
    close.type = 'button';
    close.innerHTML = icon('close');
    close.title = t('关闭');
    close.addEventListener('click', () => this.dismiss());
    head.append(title, add, close);
    modal.appendChild(head);

    const desc = el('div', 'nj-topic-desc', t('盯一个关键词，订阅源、AIHOT 热点与订阅源池的动态自动汇成一条专属信息流。'));
    modal.appendChild(desc);

    this.bodyEl = el('div', 'nj-topic-list');
    modal.appendChild(this.bodyEl);

    let topics = [];
    try {
      const res = await window.robin.topicsList();
      topics = Array.isArray(res) ? res : [];
    } catch (_) { /* 列表失败给空态 */ }
    if (!this.overlay) return;

    if (!topics.length) {
      const empty = el('div', 'nj-topic-empty');
      empty.innerHTML = `<div class="glyph">${icon('search')}</div><h3></h3><p></p>`;
      empty.querySelector('h3').textContent = t('还没有盯梢的话题');
      empty.querySelector('p').textContent = t('从文章右键「盯梢这类内容」，或点右上角新建。');
      this.bodyEl.appendChild(empty);
      return;
    }
    for (const topic of topics) this.bodyEl.appendChild(this._topicCard(topic));
  }

  _topicCard(topic) {
    const card = el('div', 'nj-topic-card');
    const top = el('div', 'nj-topic-card-top');
    const name = el('div', 'nj-topic-name', topic.name);
    if (!topic.enabled) name.classList.add('off');
    const sw = el('button', 'nj-topic-switch' + (topic.enabled ? ' on' : ''));
    sw.type = 'button';
    sw.title = topic.enabled ? t('已启用（点击暂停聚合）') : t('已暂停（点击启用）');
    sw.setAttribute('aria-label', sw.title);
    sw.addEventListener('click', async () => {
      await window.robin.topicsSetEnabled(topic.id, !topic.enabled);
      this._showManage();
    });
    top.append(name, sw);
    card.appendChild(top);

    const kwRow = el('div', 'nj-topic-kws');
    for (const kw of topic.keywords) kwRow.appendChild(el('span', 'nj-topic-kw', kw));
    card.appendChild(kwRow);

    const meta = el('div', 'nj-topic-meta');
    const laneNames = LANE_LABELS.filter(([key]) => topic.lanes?.[key]).map(([, label]) => t(label)).join(' · ');
    meta.textContent = `${topic.hitCount || 0} ${t('条命中')} · ${laneNames}`;
    card.appendChild(meta);

    const actions = el('div', 'nj-topic-card-actions');
    const mk = (label, cls, handler, title) => {
      const b = el('button', cls);
      b.type = 'button';
      b.textContent = label;
      if (title) b.title = title;
      b.addEventListener('click', handler);
      return b;
    };
    actions.appendChild(mk(t('打开信息流'), 'btn-text primary', () => this._showStream(topic)));
    actions.appendChild(mk(t('立即聚合'), 'btn-text', async () => {
      const res = await window.robin.topicsAggregate(topic.id);
      const summary = res && res.inserted != null ? ` +${res.inserted}` : '';
      this.deps.toast?.(t('聚合完成') + summary);
      this._showManage();
    }, t('马上按关键词聚合一次')));
    actions.appendChild(mk(t('编辑'), 'btn-text', () => this._showForm({
      id: topic.id, name: topic.name, keywordsText: topic.keywords.join(', '),
      lanes: topic.lanes, frequency: topic.frequency, aiFilter: topic.aiFilter,
    })));
    actions.appendChild(mk(t('删除'), 'btn-text danger', async () => {
      const { confirmBox } = await import('./ui-prompt.js');
      const ok = await confirmBox(t('删除话题'), {
        message: tf('确定删除话题「%@」吗？命中记录会一并删除。', topic.name),
        confirmLabel: t('删除'),
      });
      if (!ok) return;
      await window.robin.topicsDelete(topic.id);
      this._showManage();
    }));
    card.appendChild(actions);
    return card;
  }

  // MARK: - 新建/编辑表单

  _showForm(prefill = {}) {
    this.mode = 'form';
    const modal = this.modal;
    if (!modal) return;
    modal.innerHTML = '';
    const head = el('div', 'nj-topic-head');
    head.appendChild(el('h3', null, prefill.id ? t('编辑话题') : t('新建话题')));
    const close = el('button', 'btn icon-only');
    close.type = 'button';
    close.innerHTML = icon('close');
    close.title = t('关闭');
    close.addEventListener('click', () => this._showManage());
    head.appendChild(close);
    modal.appendChild(head);

    const form = el('div', 'nj-topic-form');
    modal.appendChild(form);

    const kwLabel = el('label', 'nj-topic-flabel', t('关键词（最多 3 个，逗号分隔）'));
    const kwInput = el('input', 'nj-topic-input');
    kwInput.type = 'text';
    kwInput.value = String(prefill.keywordsText || '');
    kwInput.placeholder = t('例如：大模型, Agent');
    form.append(kwLabel, kwInput);

    const nameInput = el('input', 'nj-topic-input');
    nameInput.type = 'text';
    nameInput.value = String(prefill.name || '');
    nameInput.placeholder = t('话题名（留空自动用关键词）');
    form.append(nameInput);

    const lanesLabel = el('label', 'nj-topic-flabel', t('聚合来源'));
    const lanesRow = el('div', 'nj-topic-lanes');
    const laneChecks = {};
    for (const [key, label] of LANE_LABELS) {
      const id = `nj-topic-lane-${key}`;
      const wrap = el('label', 'nj-topic-lane');
      const check = el('input');
      check.type = 'checkbox';
      check.id = id;
      const on = prefill.lanes ? !!prefill.lanes[key] : key === 'local';
      check.checked = on;
      const text = el('span', null, t(label));
      wrap.append(check, text);
      lanesRow.appendChild(wrap);
      laneChecks[key] = check;
    }
    form.append(lanesLabel, lanesRow);

    const freqLabel = el('label', 'nj-topic-flabel', t('聚合频率'));
    const freqRow = el('div', 'nj-topic-lanes');
    const freqChecks = {};
    for (const [key, label] of [['refresh', '每次刷新后'], ['daily', '每日一次']]) {
      const wrap = el('label', 'nj-topic-lane');
      const check = el('input');
      check.type = 'radio';
      check.name = 'nj-topic-freq';
      check.checked = (prefill.frequency || 'refresh') === key;
      const text = el('span', null, t(label));
      wrap.append(check, text);
      freqRow.appendChild(wrap);
      freqChecks[key] = check;
    }
    form.append(freqLabel, freqRow);

    const aiWrap = el('label', 'nj-topic-lane');
    const aiCheck = el('input');
    aiCheck.type = 'checkbox';
    aiCheck.checked = prefill.aiFilter === true;
    aiCheck.title = t('用 AI 判断候选是否真的和话题相关；未配置 AI 或失败时自动跳过');
    const aiText = el('span', null, t('AI 精筛（过滤不相关内容）'));
    aiWrap.append(aiCheck, aiText);
    form.appendChild(aiWrap);

    const err = el('div', 'nj-topic-form-err');
    const save = el('button', 'btn-text primary nj-topic-save');
    save.type = 'button';
    save.textContent = prefill.id ? t('保存修改') : t('创建并聚合');
    save.addEventListener('click', async () => {
      const keywords = kwInput.value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
      save.disabled = true;
      try {
        const saved = await window.robin.topicsSave({
          id: prefill.id || undefined,
          name: nameInput.value.trim(),
          keywords,
          lanes: {
            local: laneChecks.local.checked,
            aihot: laneChecks.aihot.checked,
            pool: laneChecks.pool.checked,
          },
          frequency: freqChecks.daily.checked ? 'daily' : 'refresh',
          aiFilter: aiCheck.checked,
        });
        if (!this.overlay) return;
        this.deps.toast?.(prefill.id ? t('话题已更新') : t('话题已创建'));
        await this._showManage();
        if (!prefill.id && saved && saved.id) {
          // 新话题：创建即聚合一次，用户立刻能看到信息流
          try { await window.robin.topicsAggregate(saved.id); } catch (_) { /* 首聚合失败不阻塞 */ }
        }
      } catch (e) {
        err.textContent = String(e && e.message || e);
      } finally {
        save.disabled = false;
      }
    });
    form.append(err, save);
    kwInput.focus();
  }

  // MARK: - 信息流页

  async _showStream(topic) {
    this.mode = 'stream';
    this.currentTopic = topic;
    const modal = this.modal;
    if (!modal) return;
    modal.innerHTML = '';
    const head = el('div', 'nj-topic-head');
    const back = el('button', 'btn icon-only');
    back.type = 'button';
    back.innerHTML = icon('chevronLeft');
    back.title = t('返回话题列表');
    back.addEventListener('click', () => this._showManage());
    const titleWrap = el('div', 'nj-topic-stream-title');
    titleWrap.appendChild(el('h3', null, topic.name));
    titleWrap.appendChild(el('div', 'nj-topic-stream-meta',
      tf('最近聚合：%lld', topic.lastRun ? fmtWhen(topic.lastRun) : t('还没有'))));
    const refresh = el('button', 'btn-text primary');
    refresh.type = 'button';
    refresh.textContent = t('立即聚合');
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      try {
        const res = await window.robin.topicsAggregate(topic.id);
        this.deps.toast?.(t('聚合完成') + (res && res.inserted != null ? ` +${res.inserted}` : ''));
        await this._showStream(this.currentTopic || topic);
      } finally { refresh.disabled = false; }
    });
    const close = el('button', 'btn icon-only');
    close.type = 'button';
    close.innerHTML = icon('close');
    close.title = t('关闭');
    close.addEventListener('click', () => this.dismiss());
    head.append(back, titleWrap, refresh, close);
    modal.appendChild(head);

    this.streamEl = el('div', 'nj-topic-stream');
    modal.appendChild(this.streamEl);

    let hits = [];
    try {
      const res = await window.robin.topicsHits(topic.id, { limit: 100 });
      hits = Array.isArray(res) ? res : [];
    } catch (_) { /* 读失败给空态 */ }
    if (!this.overlay) return;

    if (!hits.length) {
      const empty = el('div', 'nj-topic-empty');
      empty.innerHTML = `<div class="glyph">${icon('search')}</div><h3></h3><p></p>`;
      empty.querySelector('h3').textContent = t('还没有命中');
      empty.querySelector('p').textContent = t('点「立即聚合」马上收集一次，之后会随刷新自动更新。');
      this.streamEl.appendChild(empty);
      return;
    }
    for (const hit of hits) this.streamEl.appendChild(this._hitRow(hit));
  }

  _hitRow(hit) {
    const row = el('div', 'nj-topic-hit');
    const laneBadge = el('span', `nj-topic-lane-badge lane-${hit.lane}`);
    laneBadge.textContent = { local: t('本库'), aihot: 'AIHOT', pool: t('源池') }[hit.lane] || hit.lane;
    const main = el('div', 'nj-topic-hit-main');
    const title = el('div', 'nj-topic-hit-title', hit.title || hit.url);
    const meta = el('div', 'nj-topic-hit-meta', `${hit.sourceName || ''} · ${fmtWhen(hit.publishedAt || hit.hitAt)}`);
    main.append(title, meta);
    row.append(laneBadge, main);
    row.addEventListener('click', () => {
      if (hit.entryID) this.deps.onOpenEntry(hit.entryID);
      else if (hit.url) { this.dismiss(); this.deps.onOpenURL(hit.url); }
    });
    return row;
  }
}
