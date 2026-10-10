'use strict';
/**
 * RobinRead（知更）— 来源立场光谱视图（F38，知识中心「光谱」tab 内容）
 *
 * 横向光谱轴（-100 技术实用 … +100 观点人文）：订阅源头像/名字点布轴上
 * （重合力分布，重叠抖动由服务端投影完成）；点击源点 → 右侧详情
 * （一句话画像 / 风格 tag / 最近 3 篇）。手动「分析我的订阅源」按钮；
 * 无 Key 灰置 + 说明（此功能核心是 LLM 判断，不做降级假装）。
 * 纯 DOM 布点（走令牌色；入场动画 reduced-motion 豁免见 robin.css）。
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

/** 轴位置百分比（x∈[0,1] → 0-100%，留出点位半径余量）。 */
function pct(x) {
  return Math.max(0, Math.min(100, Math.round((Number(x) || 0.5) * 100)));
}

export function renderSpectrum(host, view, { toast = null, onOpenFeedArticles = null } = {}) {
  host.innerHTML = '';
  if (!view) {
    const empty = el('div', 'nj-spectrum-empty list-empty stagger'); // U31 空态二期：插画 + 错峰入场
    empty.innerHTML = staggerEmptyHTML('spectrum');
    empty.querySelector('h3').textContent = t('光谱还没绘出来。');
    empty.querySelector('p').textContent = t('分析常读的订阅源后，它们会按立场排成一条光谱。');
    host.appendChild(empty);
    return;
  }
  const wrap = el('div', 'nj-spectrum-wrap');
  const toolbar = el('div', 'nj-spectrum-toolbar');
  const hint = el('span', 'nj-spectrum-hint',
    view.feeds.length
      ? tf('常读的 %lld 个源排成一条光谱：越靠左越技术实用，越靠右越观点人文。', view.feeds.length)
      : t('读完的文章越多，光谱越准。先去读几篇，再点「分析我的订阅源」。'));
  toolbar.appendChild(hint);
  const analyzeBtn = el('button', 'btn-text bordered nj-spectrum-analyze');
  analyzeBtn.type = 'button';
  analyzeBtn.innerHTML = `${icon('wand')}<span></span>`;
  analyzeBtn.querySelector('span').textContent = t('分析我的订阅源');
  analyzeBtn.disabled = !view.available?.ai; // 无 Key 灰置
  if (!view.available?.ai) analyzeBtn.title = t('未配置 AI Key，无法分析来源立场。请到 设置 → AI 填写后重试。');
  analyzeBtn.addEventListener('click', async () => {
    if (analyzeBtn.disabled || analyzeBtn.dataset.busy === '1') return;
    analyzeBtn.dataset.busy = '1';
    analyzeBtn.querySelector('span').textContent = t('正在分析…');
    try {
      const envelope = await window.robin.spectrumAnalyze({ force: false }); // invoke 信封 {ok, data}
      const fresh = envelope && envelope.ok ? envelope.data : null;
      if (!fresh) throw new Error(String((envelope && envelope.error) || 'analyze failed'));
      if (!host.isConnected) return; // 批 H 审查 P2：切 tab 重建 contentHost 后旧 host 脱离 DOM，不再覆写新 tab 内容
      if (toast && fresh.feeds && fresh.feeds.length) toast(t('光谱已更新'));
      renderSpectrum(host, fresh, { toast, onOpenFeedArticles });
    } catch (err) {
      if (toast) toast(String((err && err.message) || err).slice(0, 120));
      analyzeBtn.querySelector('span').textContent = t('分析我的订阅源');
      analyzeBtn.dataset.busy = '0';
    }
  });
  toolbar.appendChild(analyzeBtn);
  wrap.appendChild(toolbar);

  if (view.grey) {
    // 无 Key 且零画像：灰置 + 说明（不假装）；U31 插画空态 + 错峰入场
    const grey = el('div', 'nj-spectrum-grey list-empty stagger');
    grey.innerHTML = staggerEmptyHTML('spectrum');
    grey.querySelector('h3').textContent = t('光谱需要 AI');
    grey.querySelector('p').textContent = t('来源立场判断由 AI 完成：配置 AI Key 后，点「分析我的订阅源」为你常读的源绘像布点。');
    wrap.appendChild(grey);
    host.appendChild(wrap);
    return;
  }

  const layout = el('div', 'nj-spectrum-layout');
  // ── 左：光谱轴 ──
  const axisCard = el('div', 'nj-spectrum-axis-card');
  const axis = el('div', 'nj-spectrum-axis');
  const line = el('div', 'nj-spectrum-line');
  axis.appendChild(line);
  for (const [label, cls] of [[t('技术实用'), 'left'], [t('观点人文'), 'right']]) {
    const end = el('span', `nj-spectrum-end nj-spectrum-end-${cls}`, label);
    axis.appendChild(end);
  }
  const mid = el('span', 'nj-spectrum-mid');
  axis.appendChild(mid);
  const points = el('div', 'nj-spectrum-points');
  for (const feed of view.feeds || []) {
    const dot = el('button', 'nj-spectrum-point');
    dot.type = 'button';
    dot.dataset.feedId = feed.feedID || '';
    dot.style.left = `${pct(feed.x)}%`;
    dot.title = `${feed.title} · ${feed.spectrum}`;
    const labelEl = el('span', 'nj-spectrum-point-label');
    labelEl.textContent = feed.title || feed.feedID;
    dot.append(el('span', 'nj-spectrum-dot'), labelEl);
    dot.addEventListener('click', () => {
      for (const other of points.querySelectorAll('.nj-spectrum-point.picked')) other.classList.remove('picked');
      dot.classList.add('picked');
      renderDetail(detail, feed);
    });
    points.appendChild(dot);
  }
  axis.appendChild(points);
  axisCard.appendChild(axis);
  if (!view.feeds.length) {
    axisCard.appendChild(el('div', 'nj-spectrum-axis-empty', t('还没有画像。点「分析我的订阅源」开始。')));
  }
  layout.appendChild(axisCard);
  // ── 右：详情面板 ──
  const detail = el('div', 'nj-spectrum-detail');
  detail.appendChild(el('div', 'nj-spectrum-detail-empty', t('点一个源，看它的画像。')));
  layout.appendChild(detail);
  wrap.appendChild(layout);
  host.appendChild(wrap);
}

function renderDetail(detail, feed) {
  detail.innerHTML = '';
  const head = el('div', 'nj-spectrum-detail-head');
  head.appendChild(el('h4', null, feed.title || feed.feedID));
  if (feed.style) {
    const tag = el('span', 'nj-spectrum-style-tag', feed.style);
    head.appendChild(tag);
  }
  detail.appendChild(head);
  const meter = el('div', 'nj-spectrum-detail-meter');
  const meterDot = el('span', 'nj-spectrum-detail-dot');
  meterDot.style.left = `${pct(feed.x)}%`;
  meter.appendChild(meterDot);
  meter.appendChild(el('div', 'nj-spectrum-detail-line'));
  detail.appendChild(meter);
  const meterLabel = el('div', 'nj-spectrum-detail-meterlabel',
    tf('立场 %lld（%lld 至 %lld）', feed.spectrum || 0, -100, 100));
  detail.appendChild(meterLabel);
  if (feed.portrait) detail.appendChild(el('p', 'nj-spectrum-portrait', feed.portrait));
  if (feed.stale) detail.appendChild(el('p', 'nj-spectrum-stale', t('画像已超过 7 天，可重新分析。')));
  const recent = el('div', 'nj-spectrum-recent');
  recent.appendChild(el('div', 'nj-spectrum-recent-title', t('最近文章')));
  for (const title of (feed.recent || [])) {
    recent.appendChild(el('div', 'nj-spectrum-recent-item', title || t('（无标题）')));
  }
  detail.appendChild(recent);
  if (typeof feed.readCount === 'number' && feed.readCount > 0) {
    detail.appendChild(el('p', 'nj-spectrum-readcount', tf('近 90 天读完 %lld 篇', feed.readCount)));
  }
}
