'use strict';
/**
 * empty-art.js — U11 插画空态（内联 SVG 轻量线稿）
 *
 * 与 icons.js 同一描边语言（stroke 1.75 / round cap / currentColor），
 * 每幅一枚 accent 高亮元素（class="ea-accent"，由 CSS 染 --accent）。
 * 全部确定性内联生成：零外部资源、零运行时依赖。
 *
 * API：emptyArtSVG(glyph) → SVG 字符串（未知 glyph 返回 ''，调用方回退既有图标）。
 */

/* 知更鸟线稿（16 网格、朝右、尾在左下；可缩放复用）。 */
const BIRD = `<g class="ea-bird">`
  + `<circle cx="0" cy="0" r="2.6"/>`
  + `<path d="M2.4 -0.5 L4.8 0.2 L2.4 1"/>`
  + `<circle class="ea-eye" cx="1.1" cy="-0.9" r="0.6"/>`
  + `<path d="M-2.2 1.2 C-5.6 2.3 -7.5 4.7 -8.2 7.6 L-3.5 6.9 C-2.9 4.4 -1.9 2.6 0.3 1.8 Z"/>`
  + `</g>`;

function bird(x, y, s = 2, extra = '') {
  return `<g transform="translate(${x} ${y}) scale(${s})">${BIRD}${extra}</g>`;
}
/** 飞鸟（两笔弧线翼）。 */
const flyingBird = (x, y, s = 1.6) =>
  `<g transform="translate(${x} ${y}) scale(${s})"><path d="M0 0 Q3 -2.6 6 0"/><path d="M6 0 Q9 -2.6 12 0"/></g>`;

/** 统一画布：160×104，描边语言对齐 icons.js。 */
function frame(inner) {
  return `<svg class="ea-scene" viewBox="0 0 160 104" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

const SCENES = {
  // 没有文章 / 暂无内容：一叠报纸 + 立在报上的知更
  newspaper: frame(`
    <rect x="34" y="44" width="70" height="44" rx="4"/>
    <rect x="44" y="36" width="70" height="44" rx="4"/>
    <line x1="54" y1="50" x2="100" y2="50"/>
    <line x1="54" y1="60" x2="92" y2="60"/>
    <line x1="54" y1="69" x2="84" y2="69"/>
    ${bird(128, 34)}
    <path class="ea-accent" d="M18 30 Q22 24 28 26"/>`),
  // 还没有收藏：大星 + 迎飞的知更
  star: frame(`
    <path class="ea-accent" d="M62 30 l8.2 16.6 18.3 2.7 -13.2 12.9 3.1 18.2 -16.4 -8.6 -16.4 8.6 3.1 -18.2 -13.2 -12.9 18.3 -2.7 Z"/>
    ${bird(126, 42)}
    <path d="M118 26 l3 0 M121 23 l0 3"/>
    <path d="M132 58 l2.4 0 M134.2 55.6 l0 2.4"/>`),
  // 稍后读队列为空：怀表 + 落叶
  clock: frame(`
    <circle cx="76" cy="56" r="26"/>
    <path class="ea-accent" d="M76 44 L76 57 L86 61"/>
    <path d="M68 28 L84 28 M72 24 L80 24"/>
    <path d="M118 34 q6 8 -2 14 q-7 -7 2 -14 Z"/>
    <path d="M116 46 l-6 8"/>`),
  // 无匹配结果：镜中山野
  search: frame(`
    <circle cx="72" cy="48" r="24"/>
    <path d="M52 58 q8 -10 14 -2 q6 8 12 -2"/>
    <line x1="89" y1="66" x2="106" y2="84"/>
    ${bird(126, 30)}
    <path class="ea-accent" d="M30 30 l3.4 0 M31.7 28.3 l0 3.4"/>`),
  // 还没有订阅：天线收音点 + 落鸟
  radioDot: frame(`
    <line x1="80" y1="42" x2="80" y2="88"/>
    <path d="M62 88 L98 88"/>
    <circle class="ea-accent" cx="80" cy="34" r="6"/>
    <path d="M64 22 Q80 8 96 22"/>
    <path d="M56 30 Q80 10 104 30" opacity="0.55"/>
    ${bird(112, 44)}`),
  // 未启用任何账号：人形 + 新芽
  personX: frame(`
    <circle cx="70" cy="40" r="14"/>
    <path d="M44 86 q4 -24 26 -24 q22 0 26 24"/>
    <path class="ea-accent" d="M118 78 q0 -14 12 -16 q2 14 -12 16 Z"/>
    <path d="M118 78 l0 10"/>`),
  // 还没有可播放的媒体：播放圆盘 + 声波
  playCircle: frame(`
    <circle cx="74" cy="54" r="28"/>
    <path class="ea-accent" d="M66 42 L92 54 L66 66 Z"/>
    <path d="M114 36 Q122 54 114 72"/>
    <path d="M124 28 Q136 54 124 80" opacity="0.55"/>`),
  // 通用暂无（AIHOT / 知识中心 / 演化）：四芒星 + 轨道
  spark: frame(`
    <ellipse cx="80" cy="54" rx="44" ry="16" opacity="0.6"/>
    <path class="ea-accent" d="M80 30 l4.6 19.4 L104 54 l-19.4 4.6 L80 78 l-4.6 -19.4 L56 54 l19.4 -4.6 Z"/>
    ${bird(128, 26, 1.7)}`),
  // 热点榜空：火苗 + 山影
  flame: frame(`
    <path class="ea-accent" d="M78 22 q16 14 10 30 q10 -2 8 -12 q10 12 2 26 q-8 12 -24 12 q-16 0 -22 -12 q-6 -14 4 -26 q2 10 8 10 q-6 -16 14 -28 Z"/>
    <path d="M30 88 L60 66 L86 88"/>
    <path d="M86 88 L112 72 L134 88"/>`),
  // 精选暂无：魔杖 + 星屑
  wand: frame(`
    <line x1="52" y1="82" x2="92" y2="42"/>
    <path class="ea-accent" d="M98 26 l3.4 8.6 8.6 3.4 -8.6 3.4 -3.4 8.6 -3.4 -8.6 -8.6 -3.4 8.6 -3.4 Z"/>
    <path d="M42 40 l2.6 0 M43.3 38.7 l0 2.6"/>
    <path d="M118 66 l2.6 0 M119.3 64.7 l0 2.6"/>
    ${bird(132, 40, 1.6)}`),
  // 书架空：两立一倚的书 + 落鸟
  books: frame(`
    <rect x="52" y="40" width="14" height="48" rx="2"/>
    <rect x="70" y="40" width="14" height="48" rx="2"/>
    <path d="M92 88 L104 40 L118 44 L106 88 Z"/>
    <line x1="40" y1="88" x2="128" y2="88"/>
    ${bird(70, 30)}
    <path class="ea-accent" d="M124 26 q4 6 -2 10 q-5 -5 2 -10 Z"/>`),
  // 加载失败 / 离线：断线插头
  plug: frame(`
    <circle cx="58" cy="52" r="16"/>
    <path class="ea-accent" d="M74 52 l14 0"/>
    <path d="M96 44 l10 8 -10 8"/>
    <path d="M118 44 l-10 8 10 8"/>
    <path d="M132 34 l3 0 M133.5 32.5 l0 3"/>`),
  // U31 标签空：吊牌 + 缠线 + 落鸟
  tag: frame(`
    <path d="M60 42 L96 42 L114 60 L96 78 L60 78 Z"/>
    <circle class="ea-accent" cx="72" cy="60" r="4.5"/>
    <path d="M114 60 q14 -6 18 -16"/>
    <path d="M50 84 q6 6 14 2"/>
    ${bird(126, 36, 1.7)}`),
  // U31 光谱空：天平横轴 + 两端砝码 + 游星
  spectrum: frame(`
    <line x1="36" y1="66" x2="128" y2="66"/>
    <path d="M36 66 l-6 12 M36 66 l6 12"/>
    <path d="M128 66 l-6 12 M128 66 l6 12"/>
    <line x1="82" y1="58" x2="82" y2="82"/>
    <circle class="ea-accent" cx="82" cy="52" r="6"/>
    <path d="M46 30 q4 6 -2 10"/>
    ${bird(116, 30, 1.6)}`),
};

/** glyph → 版画场景；未知 glyph 返回空串（调用方回退既有 .glyph 图标）。 */
export function emptyArtSVG(glyph) {
  return SCENES[glyph] || '';
}

/**
 * U31 空态二期：统一空态壳（插画 + 标题 + 副文案），挂 `stagger` 错峰类。
 * 返回 innerHTML；标题/副文案由调用方以 textContent 填充（防注入），按钮类内容随后续 append。
 * 未命中线稿库时回退空 .glyph 槽位（调用方可再注入图标）。
 */
export function staggerEmptyHTML(glyph) {
  const art = emptyArtSVG(glyph);
  return art
    ? `<div class="empty-art">${art}</div><h3></h3><p></p>`
    : `<div class="glyph"></div><h3></h3><p></p>`;
}
