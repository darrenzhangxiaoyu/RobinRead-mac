'use strict';
/**
 * RobinRead（知更）— 知识花园浮层（F23 知识花园 · 知更养成 + F40 挑战赛季）
 *
 * 侧栏底部花园徽章点击唤起：
 * - 「花园」tab：garden-art 确定性 SVG 花园（按状态渲染花株/知更鸟/天气，
 *   颜色取当前主题令牌）+ 阶段铭牌 + 阳光/水滴/养分三枚计 + 下一阶段目标；
 * - 「开花报告」tab：本周（7 天）浇水/种子统计 + 阶段跃迁清单 + 本周新开花；
 * - 「挑战」tab（F40）：进行中挑战卡（进度条 + 剩余天数 + 书单勾选）+ 新挑战
 *   （3 个零 AI 模板 / 自定义主题）+ 历史挑战（含 failed 诚实展示）+ 完成挑战卡
 *   （确定性 SVG，可复制分享）；
 * - 阶段跃迁入场动画：浮层打开时若阶段较上次观看有跃迁 → 花园生长动画
 *   （reduced-motion 直达终态，见 robin.css）；
 * - garden:changed / challenge:changed 推送在场时热刷新（读着读着花开当场可见）。
 */
import { t, tf } from '../i18n.js';
import { icon } from '../icons.js';
import { staggerEmptyHTML } from './empty-art.js'; // U31 空态二期：插画空态统一壳
import { gardenArt } from './garden-art.js';
import { playSfx } from './sfx.js'; /* U27 微交互音效：挑战完成琶音 */

const LAST_STAGE_KEY = 'robinread.garden.lastStage';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function attr(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** 读取主题令牌色（花园 SVG 用；SVG 里渐变/混合需要具体色值而非 var()）。 */
function gardenTokens() {
  const cs = getComputedStyle(document.body);
  const read = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  return {
    accent: read('--accent', '#617357'),
    paper: read('--page-background', '#eae8e1'),
    ink: read('--text-primary', '#3f3a30'),
  };
}

/** 阶段本地化名（与 GardenService.STAGE_KEYS 一一对应）。 */
export function stageName(stageKey) {
  return {
    seed: t('种子'),
    sprout: t('幼苗'),
    bud: t('花蕾'),
    bloom: t('盛开'),
    full: t('满园'),
  }[stageKey] || t('种子');
}

export class GardenView {
  constructor(deps = {}) {
    this.deps = { toast: deps.toast || null };
    this.overlay = null;
    this.tab = 'garden';
    this.state = null;
    this.report = null;
    this.challenges = null;   // F40：{ challenges, templates }（懒加载）
    this._unsubscribe = null;
    this._unsubscribeChallenge = null;
  }

  present() {
    if (this.overlay) return;
    const overlay = el('div', 'modal-overlay nj-garden-overlay');
    const modal = el('div', 'modal nj-garden-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', t('知识花园'));
    const head = el('div', 'nj-garden-head');
    const title = el('h3', null, t('知识花园'));
    const sub = el('span', 'nj-garden-sub', t('阅读滋养花园 · 完读浇水 / 批注播种 / 连读开花'));
    const close = el('button', 'btn icon-only nj-garden-close');
    close.type = 'button';
    close.innerHTML = icon('close');
    close.title = t('关闭');
    close.addEventListener('click', () => this.dismiss());
    head.append(title, sub, close);
    modal.appendChild(head);

    const tabs = el('div', 'nj-garden-tabs');
    this._tabButtons = {};
    for (const [key, label] of [['garden', t('花园')], ['report', t('开花报告')], ['challenge', t('挑战')]]) {
      const btn = el('button', 'nj-garden-tab');
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        this.tab = key;
        this._syncTabs();
        this._renderBody();
      });
      tabs.appendChild(btn);
      this._tabButtons[key] = btn;
    }
    modal.appendChild(tabs);

    this.bodyEl = el('div', 'nj-garden-body');
    modal.appendChild(this.bodyEl);

    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) this.dismiss(); });
    document.body.appendChild(overlay);
    this.overlay = overlay;
    window.__robinGardenView = this; // E2E 探测句柄

    this._esc = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      this.dismiss();
    };
    document.addEventListener('keydown', this._esc);
    // 花园变更推送（主进程花园服务）：在场时热刷新
    this._unsubscribe = window.robin.onGardenChanged?.(() => {
      if (!this.overlay) return;
      this._load(true);
    });
    // F40 挑战变更推送（完成/放弃/新建）：在场时热刷新挑战 tab；
    // U27：挑战完成（status=done 推送）播一枚合成琶音（开关关/能力缺省静默）
    this._unsubscribeChallenge = window.robin.onChallengeChanged?.((payload) => {
      if (payload && payload.status === 'done') playSfx('done');
      if (!this.overlay || this.tab !== 'challenge') return;
      this.challenges = null;
      this._renderBody();
    });

    this._syncTabs();
    this._load();
  }

  dismiss() {
    if (!this.overlay) return;
    document.removeEventListener('keydown', this._esc);
    if (this._unsubscribe) { try { this._unsubscribe(); } catch (_) { /* 已退订 */ } this._unsubscribe = null; }
    if (this._unsubscribeChallenge) { try { this._unsubscribeChallenge(); } catch (_) { /* 已退订 */ } this._unsubscribeChallenge = null; }
    this.overlay.remove();
    this.overlay = null;
  }

  _syncTabs() {
    for (const [key, btn] of Object.entries(this._tabButtons || {})) {
      btn.classList.toggle('active', key === this.tab);
    }
  }

  async _load(silent = false) {
    try {
      const [state, report] = await Promise.all([
        window.robin.gardenState(),
        window.robin.gardenReport(),
      ]);
      this.state = state || null;
      this.report = report || null;
      this._renderBody();
    } catch (err) {
      if (!silent && this.deps.toast) this.deps.toast(t('花园暂时打不开，稍后再试试。'));
    }
  }

  _renderBody() {
    if (!this.overlay || !this.bodyEl) return;
    if (this.tab === 'challenge') { this._renderChallenge(); return; }
    if (!this.state) {
      // U31 空态二期：插画空态 + 错峰入场
      this.bodyEl.innerHTML = `<div class="nj-garden-empty list-empty stagger">${staggerEmptyHTML('spark')}</div>`;
      this.bodyEl.querySelector('h3').textContent = t('花园还在整理土壤');
      this.bodyEl.querySelector('p').textContent = t('稍后再来看看。');
      return;
    }
    if (this.tab === 'report') this._renderReport();
    else this._renderGarden();
  }

  _renderGarden() {
    const state = this.state;
    const tokens = gardenTokens();
    // 阶段跃迁入场：较上次观看有跃迁 → 生长动画（reduced-motion 由 CSS 直达终态）
    let stageUp = false;
    try {
      const last = Number(localStorage.getItem(LAST_STAGE_KEY) || '0') || 0;
      if (state.stage > last) stageUp = true;
      localStorage.setItem(LAST_STAGE_KEY, String(state.stage));
    } catch (_) { /* 隐私模式等：跳过记忆 */ }

    const svg = gardenArt({
      stage: state.stage,
      birdStage: state.birdStage,
      wiltLevel: state.wiltLevel,
      sunStreak: state.sunStreak,
      waterTotal: state.waterTotal,
      seedTotal: state.seedTotal,
      day: state.day,
      ...tokens,
    });

    const wiltNote = state.wiltLevel > 0
      ? `<div class="nj-garden-wilt">${escapeText(t('花园缺水有点蔫——今天读一篇就复活。'))}</div>` : '';
    const nextRule = state.nextRule
      ? `<div class="nj-garden-next">${escapeText(tf('下一阶段：连读 %lld 天 · 累计完读 %lld 篇 · 批注 %lld 条', state.nextRule.sun, state.nextRule.water, state.nextRule.seeds))}</div>`
      : `<div class="nj-garden-next">${escapeText(t('满园春色——花园已到最终阶段。'))}</div>`;

    this.bodyEl.innerHTML = `
      <div class="nj-garden-scene${stageUp ? ' nj-garden-stageup' : ''}">${svg}</div>
      <div class="nj-garden-plate">
        <span class="nj-garden-stage"></span>
        <span class="nj-garden-bird">${escapeText(tf('知更羽毛 · %lld 档', state.birdStage + 1))}</span>
      </div>
      <div class="nj-garden-stats">
        <span class="nj-garden-stat" title="${attr(t('连续阅读天数'))}">${icon('sun')}<b>${state.sunStreak}</b><i></i></span>
        <span class="nj-garden-stat" title="${attr(t('完读篇数（每篇只计一次）'))}"><b>${state.waterToday}</b><i></i></span>
        <span class="nj-garden-stat" title="${attr(t('批注数（够长才算种子）'))}"><b>${state.seedToday}</b><i></i></span>
      </div>
      ${wiltNote}
      ${nextRule}`;
    this.bodyEl.querySelector('.nj-garden-stage').textContent = stageName(state.stageKey);
    const stats = this.bodyEl.querySelectorAll('.nj-garden-stat i');
    if (stats[0]) stats[0].textContent = t('阳光');
    if (stats[1]) stats[1].textContent = t('今日水滴');
    if (stats[2]) stats[2].textContent = t('今日种子');
  }

  _renderReport() {
    const r = this.report;
    if (!r) { this._renderGarden(); return; }
    const maxDay = Math.max(1, ...r.days.map((d) => Math.max(d.waters, d.seeds)));
    const dayBars = r.days.map((d) => `
      <div class="nj-garden-day" title="${attr(`${d.day} · ${t('浇水')} ${d.waters} · ${t('种子')} ${d.seeds}`)}">
        <div class="nj-garden-day-bars">
          <span style="height:${Math.round((d.waters / maxDay) * 100)}%"></span>
          <span style="height:${Math.round((d.seeds / maxDay) * 100)}%"></span>
        </div>
        <i>${escapeText(d.day.slice(5))}</i>
      </div>`).join('');
    const blooms = (r.newBlooms || []).map((b) => `
      <div class="nj-garden-bloom-row">
        <span class="nj-garden-bloom-day">${escapeText(b.day || '')}</span>
        <span>${escapeText(tf('%lld 株新开花（%lld → %lld）', 1, b.from ?? 0, b.to ?? 0))}</span>
      </div>`).join('');
    const stageUps = (r.stageUps || []).map((s) => `
      <div class="nj-garden-bloom-row">
        <span class="nj-garden-bloom-day">${escapeText(s.day || '')}</span>
        <span>${escapeText(tf('花园成长：阶段 %lld → %lld', (s.from ?? 0) + 1, (s.to ?? 0) + 1))}</span>
      </div>`).join('');

    this.bodyEl.innerHTML = `
      <div class="nj-garden-report">
        <div class="nj-garden-report-totals">
          <span><b>${r.waters}</b><i>${escapeText(t('本周浇水'))}</i></span>
          <span><b>${r.seeds}</b><i>${escapeText(t('本周种子'))}</i></span>
          <span><b>${r.sunStreak}</b><i>${escapeText(t('连续天数'))}</i></span>
          <span><b>${r.birdStage + 1}</b><i>${escapeText(t('羽毛档'))}</i></span>
        </div>
        <div class="nj-garden-chart">${dayBars}</div>
        <div class="nj-garden-report-sec"><h4></h4>${blooms || `<div class="nj-garden-bloom-row muted"><span>${escapeText(t('本周还没有新开花——读到盛开阶段就会记录在这里。'))}</span></div>`}</div>
        <div class="nj-garden-report-sec"><h4></h4>${stageUps || `<div class="nj-garden-bloom-row muted"><span>${escapeText(t('本周暂无阶段跃迁。'))}</span></div>`}</div>
      </div>`;
    const heads = this.bodyEl.querySelectorAll('.nj-garden-report-sec h4');
    if (heads[0]) heads[0].textContent = t('本周新开花');
    if (heads[1]) heads[1].textContent = t('阶段跃迁');
  }

  // MARK: 挑战赛季（F40：进行中 / 新挑战 / 历史 + 挑战卡）

  async _renderChallenge() {
    if (!this.challenges) {
      try {
        const [list, tpl, avail] = await Promise.all([
          window.robin.challengeList?.(),
          window.robin.challengeTemplates?.(),
          window.robin.challengeAvailable?.(),
        ]);
        this.challenges = {
          items: (list && Array.isArray(list.challenges)) ? list.challenges : [],
          templates: (tpl && Array.isArray(tpl.templates)) ? tpl.templates : [],
          ai: Boolean(avail && avail.ai),
        };
      } catch (_) {
        this.challenges = { items: [], templates: [], ai: false };
      }
    }
    const { items, templates, ai } = this.challenges;
    const active = items.find((c) => c.status === 'active') || null;
    const history = items.filter((c) => c.status !== 'active');
    const doneLatest = history.find((c) => c.status === 'done') || null;

    this.bodyEl.innerHTML = '';
    const root = el('div', 'nj-challenge');
    this.bodyEl.appendChild(root);

    // ── 进行中挑战：进度条 + 剩余天数 + 书单勾选 ──
    if (active) {
      const card = el('div', 'nj-challenge-active');
      card.dataset.role = 'challenge-active';
      const headLine = el('div', 'nj-challenge-head');
      const theme = el('b', 'nj-challenge-theme', active.theme);
      const left = el('span', 'nj-challenge-left', active.daysLeft > 0
        ? tf('剩 %lld 天', active.daysLeft)
        : t('今天截止'));
      headLine.append(theme, left);
      const barWrap = el('div', 'nj-challenge-bar');
      const barFill = el('span', 'nj-challenge-bar-fill');
      barFill.style.width = `${Math.max(2, active.pct)}%`;
      barWrap.appendChild(barFill);
      const counts = el('div', 'nj-challenge-counts', tf('%lld / %lld 篇', active.done, active.target));
      const listWrap = el('div', 'nj-challenge-list');
      for (const entry of (active.entries || [])) {
        const rowEl = el('div', `nj-challenge-entry${entry.isRead ? ' read' : ''}`);
        rowEl.innerHTML = `<span class="nj-challenge-check"></span><span class="nj-challenge-entry-title"></span>`;
        rowEl.querySelector('.nj-challenge-entry-title').textContent = entry.title || entry.entryID;
        rowEl.title = entry.sourceTitle ? `${entry.sourceTitle} · ${entry.isRead ? t('已读完') : t('未读完')}` : '';
        listWrap.appendChild(rowEl);
      }
      const abandonBtn = el('button', 'btn-text bordered nj-challenge-abandon', t('放弃挑战'));
      abandonBtn.type = 'button';
      abandonBtn.addEventListener('click', async () => {
        abandonBtn.disabled = true;
        try {
          await window.robin.challengeAbandon?.(active.id);
          if (this.deps.toast) this.deps.toast(t('已放弃——随时可以开新赛季。'));
        } finally {
          this.challenges = null;
          this._renderChallenge();
        }
      });
      card.append(headLine, barWrap, counts, listWrap, abandonBtn);
      root.appendChild(card);
    }

    // ── 完成挑战卡（最近一次 done；确定性 SVG，点击复制分享）──
    if (doneLatest && !active) {
      const cardWrap = el('div', 'nj-challenge-share');
      cardWrap.dataset.role = 'challenge-card';
      const cap = el('div', 'nj-challenge-share-cap', t('挑战卡 · 点击复制，分享你的战绩'));
      const artBox = el('div', 'nj-challenge-share-art');
      cardWrap.append(cap, artBox);
      root.appendChild(cardWrap);
      try {
        const svg = await window.robin.challengeCard?.(doneLatest.id);
        if (svg) {
          artBox.innerHTML = svg;
          artBox.addEventListener('click', async () => {
            try {
              await window.robin.copyText?.(svg);
              if (this.deps.toast) this.deps.toast(t('挑战卡 SVG 已复制'));
            } catch (_) { /* 剪贴板不可用静默 */ }
          });
        }
      } catch (_) { /* 挑战卡生成失败静默 */ }
    }

    // ── 新挑战（模板 3 个零 AI / 自定义主题）──
    const isNewDisabled = Boolean(active);
    const newWrap = el('div', 'nj-challenge-new');
    newWrap.dataset.role = 'challenge-new';
    newWrap.appendChild(el('div', 'nj-challenge-sec-title', t('开个新赛季')));
    const tplRow = el('div', 'nj-challenge-tpl-row');
    for (const tpl of templates) {
      const btn = el('button', 'nj-challenge-tpl');
      btn.type = 'button';
      btn.disabled = isNewDisabled;
      btn.innerHTML = `<b></b><i></i>`;
      btn.querySelector('b').textContent = tpl.theme;
      btn.querySelector('i').textContent = tf('%lld 天 · %lld 篇', tpl.days, tpl.target);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await window.robin.challengeCreate?.({ templateID: tpl.id });
          if (res && res.ok === false) { if (this.deps.toast) this.deps.toast(String(res.error || t('创建失败'))); btn.disabled = false; return; }
          if (this.deps.toast) this.deps.toast(t('新赛季开跑了！'));
        } catch (err) {
          if (this.deps.toast) this.deps.toast(String((err && err.message) || err));
          btn.disabled = false;
          return;
        }
        this.challenges = null;
        this._renderChallenge();
      });
      tplRow.appendChild(btn);
    }
    newWrap.appendChild(tplRow);

    const customRow = el('div', 'nj-challenge-custom');
    const themeInput = el('input', 'control nj-challenge-theme-input');
    themeInput.type = 'text';
    themeInput.placeholder = t('自定义主题，如：量子计算入门');
    themeInput.setAttribute('aria-label', t('自定义主题'));
    const daysInput = el('input', 'control nj-challenge-days');
    daysInput.type = 'number';
    daysInput.min = '1'; daysInput.max = '60';
    daysInput.value = '7';
    daysInput.setAttribute('aria-label', t('天数'));
    const targetInput = el('input', 'control nj-challenge-target');
    targetInput.type = 'number';
    targetInput.min = '1'; targetInput.max = '30';
    targetInput.value = '10';
    targetInput.setAttribute('aria-label', t('篇数'));
    const createBtn = el('button', 'btn-text primary nj-challenge-create', t('创建挑战'));
    createBtn.type = 'button';
    createBtn.disabled = isNewDisabled;
    createBtn.addEventListener('click', async () => {
      createBtn.disabled = true;
      try {
        const res = await window.robin.challengeCreate?.({
          theme: themeInput.value.trim(),
          days: Number(daysInput.value) || 7,
          target: Number(targetInput.value) || 10,
        });
        if (res && res.ok === false) { if (this.deps.toast) this.deps.toast(String(res.error || t('创建失败'))); createBtn.disabled = false; return; }
        if (this.deps.toast) this.deps.toast(t('新赛季开跑了！'));
        this.challenges = null;
        this._renderChallenge();
      } catch (err) {
        if (this.deps.toast) this.deps.toast(String((err && err.message) || err));
        createBtn.disabled = false;
      }
    });
    customRow.append(themeInput, daysInput, targetInput, createBtn);
    newWrap.appendChild(customRow);
    newWrap.appendChild(el('div', 'nj-challenge-hint', ai
      ? t('自定义挑战会请 AI 从订阅库挑书；未配置 AI 时按标签聚合选文。')
      : t('未配置 AI Key：按标签聚合选文，模板挑战不受影响。')));
    root.appendChild(newWrap);

    // ── 历史挑战（done / failed / abandoned 诚实展示）──
    const histWrap = el('div', 'nj-challenge-history');
    histWrap.dataset.role = 'challenge-history';
    histWrap.appendChild(el('div', 'nj-challenge-sec-title', t('历史挑战')));
    if (!history.length) {
      histWrap.appendChild(el('div', 'nj-challenge-hint', t('还没有历史挑战——完成或放弃的挑战都会诚实记录在这里。')));
    } else {
      for (const c of history) {
        const rowEl = el('div', `nj-challenge-history-row st-${c.status}`);
        rowEl.innerHTML = `<span class="nj-challenge-h-theme"></span><span class="nj-challenge-h-meta"></span><span class="nj-challenge-h-badge"></span>`;
        rowEl.querySelector('.nj-challenge-h-theme').textContent = c.theme;
        rowEl.querySelector('.nj-challenge-h-meta').textContent = tf('%lld / %lld 篇 · %lld 天', c.done, c.target, c.days);
        rowEl.querySelector('.nj-challenge-h-badge').textContent = {
          done: t('已完成'),
          failed: t('未达标'),
          abandoned: t('已放弃'),
        }[c.status] || c.status;
        histWrap.appendChild(rowEl);
      }
    }
    root.appendChild(histWrap);
  }
}

function escapeText(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
