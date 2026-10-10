'use strict';
/**
 * wrapped-card-art.js — 阅读年报「年度卡」确定性 SVG 生成器（U25）
 *
 * 照 ChallengeCardArt（F40，主进程 CommonJS）手法在渲染层 ESM 重写同套合同：
 * FNV-1a 播种 mulberry32，同输入 → 逐字节相同输出；随机源与时钟一律不进本模块。
 * 几何构成：年份大字 / 四数据点阵带 / Top 主题题字 / 纸感卡框 / 阅读行星轨。
 * 颜色全部由入参令牌（accent/paper/ink）十六进制混合派生——零外部资源、零依赖。
 */

/** FNV-1a 32bit 字符串散列 → 无符号种子。 */
export function wrappedSeed(year, read, annotations, streak, topTheme, accent) {
  const key = `${String(year || '')}|${read | 0}|${annotations | 0}|${streak | 0}|${String(topTheme || '')}|${String(accent || '').trim().toLowerCase()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 确定性 PRNG（纯函数：闭包内推进，无全局态）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 十六进制颜色解析 → [r,g,b]；非法输入回退中性墨色，保证总可产出。 */
function hex2rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [64, 60, 50];
  const x = m[1];
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
}
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
/** 颜色线性混合（卡面分层色阶的唯一派生手段）。 */
function mix(a, b, t) {
  const A = hex2rgb(a); const B = hex2rgb(b);
  const k = Math.max(0, Math.min(1, Number(t) || 0));
  return `#${[0, 1, 2].map((i) => clamp255(A[i] + (B[i] - A[i]) * k).toString(16).padStart(2, '0')).join('')}`;
}
const n2 = (v) => Math.round(v * 100) / 100; // 输出数值统一两位小数，保证序列化稳定

/** XML 文本转义（主题题字来自用户数据，必须转义后进 SVG）。 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 生成年报卡 SVG 字符串。
 * @param {{year?:number|string, read?:number, annotations?:number, streak?:number,
 *          topTheme?:string, dateText?:string, accent?:string, paper?:string, ink?:string}} o
 */
export function wrappedCardArt({
  year = '', read = 0, annotations = 0, streak = 0,
  topTheme = '', dateText = '', accent = '#617357', paper = '#eae8e1', ink = '#3f3a30',
} = {}) {
  const W = 300; const H = 420;
  const d = Math.max(0, Math.floor(Number(read) || 0));
  const anno = Math.max(0, Math.floor(Number(annotations) || 0));
  const stk = Math.max(0, Math.floor(Number(streak) || 0));
  const themeText = String(topTheme || '').trim().slice(0, 12);
  const rng = mulberry32(wrappedSeed(year, d, anno, stk, themeText, accent));
  const pick = (lo, hi) => lo + (hi - lo) * rng();

  // 卡面色阶（accent 只出现在年份与星轨主色，一卡一色）
  const inkSoft = mix(ink, paper, 0.42);
  const frameInk = mix(ink, paper, 0.14);
  const heroInk = mix(accent, paper, 0.12);
  const trackDim = mix(accent, paper, 0.62);
  const bandInk = mix(paper, ink, 0.08);

  const cx = W / 2;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-hidden="true" data-wrapped-card="${esc(String(year || '').slice(0, 8))}">`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${paper}"/>`);
  // 卡框（双线版画框）
  parts.push(`<rect x="10" y="10" width="${W - 20}" height="${H - 20}" fill="none" stroke="${frameInk}" stroke-width="2"/>`);
  parts.push(`<rect x="16" y="16" width="${W - 32}" height="${H - 32}" fill="none" stroke="${frameInk}" stroke-width="0.8" opacity="0.6"/>`);

  // ① 底纹：完读比例的点雨（读得越多点越密——年度分量可感）
  const dots = 8 + Math.min(42, Math.floor(d / 8));
  for (let i = 0; i < dots; i += 1) {
    parts.push(`<circle cx="${n2(pick(30, W - 30))}" cy="${n2(pick(30, H - 30))}" r="0.9" fill="${inkSoft}" opacity="0.35"/>`);
  }

  // ② 年份大字（题字区：accent 主色，衬线固定字号——不依赖环境字体度量）
  parts.push(`<text x="${cx}" y="108" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="44" font-weight="700" letter-spacing="4" fill="${heroInk}">${esc(String(year || '').slice(0, 8))}</text>`);
  parts.push(`<text x="${cx}" y="130" text-anchor="middle" font-family="Georgia, serif" font-size="11" letter-spacing="6" fill="${inkSoft}">${esc('ROBINREAD · WRAPPED')}</text>`);
  parts.push(`<line x1="60" y1="144" x2="${W - 60}" y2="144" stroke="${frameInk}" stroke-width="0.8"/>`);

  // ③ 阅读行星轨：streak 天数决定轨道上点亮的小星（连续可感）
  const orbY = 196;
  const stars = Math.min(14, stk);
  parts.push(`<ellipse cx="${cx}" cy="${orbY}" rx="${W / 2 - 46}" ry="16" fill="none" stroke="${trackDim}" stroke-width="1" stroke-dasharray="2 4"/>`);
  for (let i = 0; i < stars; i += 1) {
    const ang = Math.PI + (i / Math.max(1, stars - 1 || 1)) * Math.PI;
    const x = n2(cx + Math.cos(ang) * (W / 2 - 46));
    const y = n2(orbY + Math.sin(ang) * 16);
    parts.push(`<circle cx="${x}" cy="${y}" r="2.6" fill="${mix(accent, paper, 0.2 + 0.4 * (i / Math.max(1, stars)))}"/>`);
  }
  parts.push(`<circle cx="${cx}" cy="${n2(orbY - 16)}" r="4" fill="${heroInk}"/>`); // 轨顶阅读星

  // ④ 四数据点阵带：完读/批注（衬底纸带先画，数字后画不被盖）
  const rowY = 262;
  parts.push(`<rect x="40" y="${rowY - 30}" width="${W - 80}" height="56" rx="4" fill="${bandInk}" stroke="${frameInk}" stroke-width="0.6" opacity="0.5"/>`);
  const cell = (x, num, label) => {
    parts.push(`<text x="${x}" y="${rowY}" text-anchor="middle" font-family="Georgia, serif" font-size="18" font-weight="700" fill="${mix(ink, paper, 0.12)}">${esc(String(num))}</text>`);
    parts.push(`<text x="${x}" y="${rowY + 14}" text-anchor="middle" font-family="Georgia, serif" font-size="9" letter-spacing="2" fill="${inkSoft}">${esc(label)}</text>`);
  };
  parts.push(`<line x1="${cx}" y1="${rowY - 26}" x2="${cx}" y2="${rowY + 18}" stroke="${frameInk}" stroke-width="0.6"/>`);
  cell(cx - 70, d, 'READ');
  cell(cx + 70, anno, 'NOTES');
  parts.push(`<text x="${cx}" y="316" text-anchor="middle" font-family="Georgia, serif" font-size="12" fill="${mix(ink, paper, 0.25)}">${esc(String(stk))}d streak${themeText ? ` · #${themeText}` : ''}</text>`);

  // ⑤ 落款（dateText 由调用方传入；不内部取时钟，保确定性合同）
  if (dateText) {
    parts.push(`<text x="${cx}" y="${H - 30}" text-anchor="middle" font-family="Georgia, serif" font-size="10" fill="${inkSoft}">${esc(String(dateText).slice(0, 40))}</text>`);
  }

  parts.push('</svg>');
  return parts.join('');
}
