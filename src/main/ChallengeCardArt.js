'use strict';
/**
 * ChallengeCardArt（知更）— F40 挑战赛「挑战卡」确定性 SVG 生成器
 *
 * 照 edition-cover-art（U15 每日版画）手法：主题 + 完成数 + 天数 + 日期派生一幅
 * 可分享的挑战卡（几何构成：奖杯轮廓 / 进度花环 / 主题题字 / 日期落款 / 卡框），
 * 颜色全部由入参令牌（accent/paper/ink）十六进制混合派生——零外部资源、零依赖。
 *
 * 确定性合同：同输入 → 逐字节相同的 SVG 输出。
 * 不使用 Date.now()/Math.random()，随机源为 FNV-1a 播种的 mulberry32。
 */

/** FNV-1a 32bit 字符串散列 → 无符号种子。 */
function cardSeed(theme, done, target, accent) {
  const key = `${String(theme || '')}|${done | 0}/${target | 0}|${String(accent || '').trim().toLowerCase()}`;
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

/** XML 文本转义（主题题字/落款来自用户输入，必须转义后进 SVG）。 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 生成挑战卡 SVG 字符串。
 * @param {{theme:string, days:number, done:number, target:number, status?:string,
 *          dateText?:string, accent?:string, paper?:string, ink?:string}} o
 */
function challengeCardArt({ theme, days, done, target, status = 'active', dateText = '', accent = '#617357', paper = '#eae8e1', ink = '#3f3a30' }) {
  const W = 300; const H = 400;
  const d = Math.max(0, Math.floor(Number(done) || 0));
  const t = Math.max(1, Math.floor(Number(target) || 1));
  const pct = Math.max(0, Math.min(1, d / t));
  const won = status === 'done';
  const rng = mulberry32(cardSeed(theme, d, t, accent));
  const pick = (lo, hi) => lo + (hi - lo) * rng();

  // 卡面色阶（accent 只出现在花环与奖杯主色，符合一卡一色）
  const inkSoft = mix(ink, paper, 0.42);
  const frameInk = mix(ink, paper, 0.14);
  const wreath = mix(accent, paper, 0.18);
  const wreathDim = mix(accent, paper, 0.62);
  const trophyFill = won ? mix(accent, paper, 0.18) : mix(ink, paper, 0.72);
  const bandInk = mix(paper, ink, 0.08);

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-hidden="true" data-challenge-card="${esc(String(theme || '').slice(0, 24))}">`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${paper}"/>`);
  // 卡框（双线版画框）
  parts.push(`<rect x="10" y="10" width="${W - 20}" height="${H - 20}" fill="none" stroke="${frameInk}" stroke-width="2"/>`);
  parts.push(`<rect x="16" y="16" width="${W - 32}" height="${H - 32}" fill="none" stroke="${frameInk}" stroke-width="0.8" opacity="0.6"/>`);

  // ① 底纹：完成比例的细点雨（done 越多点越密——完成度可感）
  const dots = 8 + Math.floor(pct * 40);
  for (let i = 0; i < dots; i += 1) {
    parts.push(`<circle cx="${n2(pick(30, W - 30))}" cy="${n2(pick(30, H - 30))}" r="0.9" fill="${inkSoft}" opacity="0.35"/>`);
  }

  // ② 奖杯（done ≥ target 时为 accent 主色杯，否则灰杯虚位以待）
  const cx = W / 2;
  const cupY = 86;
  parts.push('<g>');
  parts.push(`<path d="M${n2(cx - 26)} ${cupY} h52 v20 a26 26 0 0 1 -52 0 z" fill="${trophyFill}" stroke="${frameInk}" stroke-width="1.5"/>`);
  parts.push(`<path d="M${n2(cx - 26)} ${cupY + 6} c-14 0 -14 18 0 20" fill="none" stroke="${trophyFill}" stroke-width="3.5"/>`);
  parts.push(`<path d="M${n2(cx + 26)} ${cupY + 6} c14 0 14 18 0 20" fill="none" stroke="${trophyFill}" stroke-width="3.5"/>`);
  parts.push(`<rect x="${n2(cx - 5)}" y="${cupY + 46}" width="10" height="14" fill="${trophyFill}" stroke="${frameInk}" stroke-width="1"/>`);
  parts.push(`<rect x="${n2(cx - 22)}" y="${cupY + 60}" width="44" height="8" rx="2" fill="${trophyFill}" stroke="${frameInk}" stroke-width="1"/>`);
  parts.push('</g>');

  // ③ 进度花环：target 朵小花，完成 d 朵开成 accent、未完成的空心（进度逐朵可感）
  const flowers = Math.min(30, Math.max(3, t));
  const rx = 92; const ry = 26;
  const wy = 236;
  for (let i = 0; i < flowers; i += 1) {
    const ang = -Math.PI / 2 + (i / flowers) * Math.PI * 2;
    const x = n2(cx + Math.cos(ang) * rx);
    const y = n2(wy + Math.sin(ang) * ry);
    const bloomed = i < Math.round(pct * flowers);
    const fill = bloomed ? wreath : 'none';
    const stroke = bloomed ? mix(wreath, ink, 0.3) : wreathDim;
    parts.push(`<circle cx="${x}" cy="${y}" r="4.6" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>`);
    parts.push(`<circle cx="${x}" cy="${y}" r="1.2" fill="${bloomed ? paper : wreathDim}"/>`);
  }

  // ④ 进度条（花环下方细轨 + accent 填充）
  const barY = 292;
  parts.push(`<rect x="46" y="${barY}" width="${W - 92}" height="6" rx="3" fill="${bandInk}" stroke="${frameInk}" stroke-width="0.6"/>`);
  parts.push(`<rect x="46" y="${barY}" width="${n2(Math.max(3, (W - 92) * pct))}" height="6" rx="3" fill="${wreath}"/>`);

  // ⑤ 主题题字（≤14 字/行，至多两行；字体走系统衬线，字号固定——不依赖环境字体度量）
  const themeText = String(theme || '').trim().slice(0, 56);
  const lines = [];
  for (let i = 0; i < themeText.length && lines.length < 2; i += 14) lines.push(themeText.slice(i, i + 14));
  if (!lines.length) lines.push('—');
  const titleY = 186 - (lines.length - 1) * 9;
  lines.forEach((line, i) => {
    parts.push(`<text x="${cx}" y="${titleY + i * 20}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="16" font-weight="700" fill="${mix(ink, paper, 0.1)}">${esc(line)}</text>`);
  });

  // ⑥ 数据落款：完成数/目标 · 天数 · 日期
  parts.push(`<text x="${cx}" y="${barY + 26}" text-anchor="middle" font-family="Georgia, serif" font-size="12" fill="${mix(ink, paper, 0.25)}">${esc(`${d} / ${t}`)} · ${esc(String(days || 0))}d</text>`);
  if (dateText) {
    parts.push(`<text x="${cx}" y="${H - 30}" text-anchor="middle" font-family="Georgia, serif" font-size="10" fill="${inkSoft}">${esc(String(dateText).slice(0, 40))}</text>`);
  }

  parts.push('</svg>');
  return parts.join('');
}

module.exports = { challengeCardArt, cardSeed };
