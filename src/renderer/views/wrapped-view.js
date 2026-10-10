'use strict';
/**
 * wrapped-view.js — 阅读年报（U25，配合 F37/F40 年度数据既有统计）
 *
 * 知识中心「阅读年报」tab 内容：
 * - 四大数据卡：本年完读数 / 批注数（高亮+笔记）/ 连续天数 / Top 主题，
 *   每卡一幅确定性插画 SVG（纯几何，零随机）+ 数字 countup（chart-kit 入场动画，
 *   reduced-motion 单帧直达终态）。
 * - 年度关键词云：Top 主题按频次映射字号（数据驱动 inline 字号，非 CSS 字面量）。
 * - 分享卡导出：wrappedCardArt 确定性 SVG，下载为文件（同输入逐字节同输出）。
 * 本模块零业务逻辑：数据全部来自 kb:wrapped（KnowledgeEngine.wrapped 既有统计聚合）。
 */
import { t, tf } from '../i18n.js';
import { icon } from '../icons.js';
import { runChartIntro } from './chart-kit.js';
import { wrappedCardArt } from './wrapped-card-art.js';

/** 关键词云字号映射：频次线性映射到 14px~30px（数据驱动 inline 样式，非 CSS 字面量）。 */
export function cloudFontSize(count, minCount, maxCount) {
  const c = Math.max(0, Number(count) || 0);
  const lo = Math.max(0, Number(minCount) || 0);
  const hi = Math.max(lo, Number(maxCount) || 0);
  if (hi <= lo) return 20; // 单词/同频：中档
  const k = (c - lo) / (hi - lo);
  return Math.round(14 + k * 16);
}

/** 确定性小插画（四卡各一幅；纯几何，无随机源）。 */
function cardArt(kind) {
  const s = [];
  s.push('<svg viewBox="0 0 64 40" width="64" height="40" role="img" aria-hidden="true">');
  if (kind === 'read') {
    // 摊开的书
    s.push('<path d="M6 30 C16 24 26 24 32 28 C38 24 48 24 58 30 L58 10 C48 4 38 4 32 8 C26 4 16 4 6 10 Z" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>');
    s.push('<line x1="32" y1="8" x2="32" y2="28" stroke="var(--accent)" stroke-width="2"/>');
  } else if (kind === 'annotations') {
    // 批注笔
    s.push('<path d="M14 30 L40 8 L48 16 L22 34 L12 36 Z" fill="none" stroke="var(--warm-accent)" stroke-width="2" stroke-linejoin="round"/>');
    s.push('<line x1="36" y1="12" x2="44" y2="20" stroke="var(--warm-accent)" stroke-width="2"/>');
  } else if (kind === 'streak') {
    // 连击火苗
    s.push('<path d="M32 6 C38 14 44 18 44 26 A12 12 0 1 1 20 26 C20 18 26 14 32 6 Z" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>');
    s.push('<circle cx="32" cy="27" r="4" fill="var(--accent)"/>');
  } else {
    // 主题标签
    s.push('<path d="M10 8 L38 8 L54 20 L38 32 L10 32 Z" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>');
    s.push('<circle cx="20" cy="20" r="3" fill="var(--accent)"/>');
  }
  s.push('</svg>');
  return s.join('');
}

/** 读 computed 主题色令牌（非 #hex 值回退默认，保证 SVG 合同）。 */
function tokenHex(root, name, fallback) {
  const v = String(root ? getComputedStyle(root).getPropertyValue(name) : '').trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  // rgba() 墨色（--text-primary 系）：取不透明近似（分享卡不需要半透明）
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(v);
  if (m) {
    return '#' + [1, 2, 3].map((i) => Math.round(Number(m[i])).toString(16).padStart(2, '0')).join('');
  }
  return fallback;
}

/**
 * 渲染年报 tab 内容。
 * @param {HTMLElement} host contentHost
 * @param {{year?:number, read?:number, highlights?:number, notes?:number, annotations?:number,
 *          streak?:number, bestStreak?:number, activeDays?:number, days?:number,
 *          topThemes?:Array<{tag:string,count:number}>}} data
 * @param {{toast?:(msg:string)=>void}} handlers
 */
export function renderWrapped(host, data, handlers = {}) {
  if (!host) return;
  const d = data || {};
  const year = Number(d.year) || new Date().getFullYear();
  const read = Math.max(0, Number(d.read) || 0);
  const annotations = Math.max(0, Number(d.annotations ?? (Number(d.highlights) || 0) + (Number(d.notes) || 0)));
  const streak = Math.max(0, Number(d.streak) || 0);
  const themes = Array.isArray(d.topThemes) ? d.topThemes.filter((x) => x && x.tag) : [];
  const top = themes[0]?.tag || '';

  host.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'wrapped-view';
  wrap.dataset.role = 'wrapped-view';

  // ── 刊头 ──
  const hero = document.createElement('div');
  hero.className = 'wrapped-hero';
  const heroTitle = document.createElement('h2');
  heroTitle.className = 'wrapped-hero-title';
  heroTitle.textContent = tf('%lld 阅读年报', year);
  const heroSub = document.createElement('p');
  heroSub.className = 'wrapped-hero-sub';
  heroSub.textContent = t('这一年的纸页、批注与连击，都折在这一页。');
  hero.append(heroTitle, heroSub);
  wrap.appendChild(hero);

  // ── 四大数据卡（插画 + countup）──
  const grid = document.createElement('div');
  grid.className = 'wrapped-grid';
  const cards = [
    { kind: 'read', num: read, label: t('本年完读') },
    { kind: 'annotations', num: annotations, label: t('批注（高亮+笔记）') },
    { kind: 'streak', num: streak, label: t('连续天数') },
    { kind: 'theme', num: themes.length, label: t('Top 主题'), text: top || t('尚无主题') },
  ];
  for (const c of cards) {
    const card = document.createElement('div');
    card.className = 'wrapped-card';
    card.dataset.role = `wrapped-card-${c.kind}`;
    const art = document.createElement('div');
    art.className = 'wrapped-card-art';
    art.innerHTML = cardArt(c.kind);
    const num = document.createElement('span');
    num.className = 'wrapped-num';
    num.textContent = '0';
    const label = document.createElement('span');
    label.className = 'wrapped-label';
    label.textContent = c.label;
    card.append(art, num, label);
    if (c.kind === 'theme' && c.text) {
      const themeEl = document.createElement('span');
      themeEl.className = 'wrapped-theme';
      themeEl.textContent = c.text;
      card.appendChild(themeEl);
    }
    grid.appendChild(card);
    // countup：chart-kit 入场动画（reduced-motion 单帧直达终态）
    runChartIntro({
      duration: 900,
      onFrame: (p) => { num.textContent = String(Math.round(c.num * p)); },
      onDone: () => { num.textContent = String(c.num); },
    });
  }
  wrap.appendChild(grid);

  // ── 年度关键词云 ──
  if (themes.length) {
    const cloud = document.createElement('div');
    cloud.className = 'wrapped-cloud';
    cloud.dataset.role = 'wrapped-cloud';
    const counts = themes.map((x) => Number(x.count) || 0);
    const lo = Math.min(...counts);
    const hi = Math.max(...counts);
    for (const th of themes) {
      const word = document.createElement('span');
      word.className = 'wrapped-cloud-word';
      word.textContent = th.tag;
      word.style.fontSize = `${cloudFontSize(th.count, lo, hi)}px`;
      word.title = tf('%lld 篇', Number(th.count) || 0);
      cloud.appendChild(word);
    }
    wrap.appendChild(cloud);
  }

  // ── 分享卡导出（确定性 SVG）──
  const actions = document.createElement('div');
  actions.className = 'wrapped-actions';
  const dl = document.createElement('button');
  dl.className = 'btn-text bordered';
  dl.dataset.role = 'wrapped-download';
  dl.innerHTML = `${icon('export')}<span style="margin-left:5px"></span>`;
  dl.querySelector('span').textContent = t('导出年度分享卡（SVG）');
  dl.addEventListener('click', () => {
    try {
      const root = document.body;
      const svg = wrappedCardArt({
        year,
        read,
        annotations,
        streak,
        topTheme: top,
        accent: tokenHex(root, '--accent', '#617357'),
        paper: tokenHex(root, '--sidebar-background', '#eae8e1'),
        ink: tokenHex(root, '--text-primary', '#3f3a30'),
      });
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `robinread-wrapped-${year}.svg`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      handlers.toast?.(t('年度分享卡已导出'));
    } catch (_) { /* 导出失败静默（不影响页面） */ }
  });
  actions.appendChild(dl);
  wrap.appendChild(actions);

  host.appendChild(wrap);
}
