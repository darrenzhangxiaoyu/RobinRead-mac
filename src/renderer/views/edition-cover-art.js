'use strict';
/**
 * edition-cover-art.js — U15 期刊封面「每日版画」生成器
 *
 * 按日期 + 主题色令牌确定性生成一幅 SVG 版画纹样（几何构成：远星点阵 / 日轮 /
 * 三层山峦 / 近景波纹 / 版画边框 / 期号题字），颜色全部由入参令牌（accent/paper/ink）
 * 十六进制混合派生——零外部资源、零运行时依赖。
 *
 * 确定性合同：同 (year, month, day, accent) 输入 → 逐字节相同的 SVG 输出。
 * 不使用 Date.now()/Math.random()，随机源为 FNV-1a 播种的 mulberry32。
 */

/** FNV-1a 32bit 字符串散列 → 无符号种子。 */
export function coverArtSeed(year, month, day, accent) {
  const key = `${year | 0}-${month | 0}-${day | 0}|${String(accent || '').trim().toLowerCase()}`;
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
/** 颜色线性混合（版画分层色阶的唯一派生手段）。 */
function mix(a, b, t) {
  const A = hex2rgb(a); const B = hex2rgb(b);
  const k = Math.max(0, Math.min(1, Number(t) || 0));
  return `#${[0, 1, 2].map((i) => clamp255(A[i] + (B[i] - A[i]) * k).toString(16).padStart(2, '0')).join('')}`;
}
const n2 = (v) => Math.round(v * 100) / 100; // 输出数值统一两位小数，保证序列化稳定

/**
 * 生成每日版画 SVG 字符串。
 * @param {{year:number, month:number, day:number, accent:string, paper:string, ink:string, issueText?:string}} o
 */
export function editionCoverArt({ year, month, day, accent, paper, ink, issueText = '' }) {
  const W = 300; const H = 420;
  const rng = mulberry32(coverArtSeed(year, month, day, accent));
  const pick = (lo, hi) => lo + (hi - lo) * rng();

  // 版画色阶：纸底 → 墨，由 accent 参与调配（accent 只出现在日轮与近山，符合「一版一色」）
  const inkSoft = mix(ink, paper, 0.35);
  const ridgeFar = mix(paper, ink, 0.16);
  const ridgeMid = mix(paper, ink, 0.30);
  const ridgeNear = mix(accent, ink, 0.42);
  const waveInk = mix(ink, paper, 0.30);
  const dotInk = mix(ink, paper, 0.45);
  const sunFill = mix(accent, paper, 0.18);
  const strokeInk = mix(ink, paper, 0.12);

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-hidden="true" data-edition-art="${year}-${month}-${day}">`);
  // 不再铺不透明纸底（审查 P3：会盖住书封纸张的 grain 渐变呈平块）；艺术层透明叠加，纸色由封面容器承载

  // ① 远星点阵（上半幅细点网格 + 少量星点，密度由种子决定）
  const cols = 9; const rows = 7;
  const gx = W / (cols + 1); const gy = 108 / (rows + 1);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = gx * (c + 1); const y = gy * (r + 1);
      parts.push(`<circle cx="${n2(x)}" cy="${n2(y)}" r="0.9" fill="${dotInk}" opacity="0.42"/>`);
    }
  }
  const stars = 3 + Math.floor(pick(0, 4));
  for (let i = 0; i < stars; i += 1) {
    parts.push(`<circle cx="${n2(pick(28, W - 28))}" cy="${n2(pick(16, 96))}" r="${n2(pick(1.4, 2.4))}" fill="${strokeInk}"/>`);
  }

  // ② 日轮（位置与环数随种子；主色版）
  const sunX = n2(pick(W * 0.24, W * 0.76));
  const sunY = n2(pick(64, 118));
  const sunR = n2(pick(17, 26));
  parts.push(`<circle cx="${sunX}" cy="${sunY}" r="${sunR}" fill="${sunFill}"/>`);
  if (rng() > 0.45) parts.push(`<circle cx="${sunX}" cy="${sunY}" r="${n2(sunR + 6)}" fill="none" stroke="${strokeInk}" stroke-width="1.75" opacity="0.55"/>`);

  // ③ 三层山峦（折线山脊：层数固定 3，峰数/相位/振幅随种子；版画平涂 + 描边）
  const ridgeBase = [186, 226, 268];
  for (let layer = 0; layer < 3; layer += 1) {
    const peaks = 3 + Math.floor(pick(0, 3)); // 3~5 峰
    const amp = pick(26, 52) - layer * 6;
    const phase = pick(0, Math.PI * 2);
    const freq = pick(1.1, 2.0) + layer * 0.35;
    const base = ridgeBase[layer] + pick(-8, 8);
    let d = `M0 ${n2(base + amp * 0.4)}`;
    const steps = 24;
    for (let s = 1; s <= steps; s += 1) {
      const x = (W / steps) * s;
      // 折线山脊：三角波叠加相位，形成版画式直线折峰
      const tri = Math.abs(((x / W) * freq * Math.PI + phase) % (Math.PI * 2) - Math.PI);
      const y = base - amp * (tri / Math.PI);
      d += ` L${n2(x)} ${n2(y)}`;
    }
    d += ` L${W} ${H} L0 ${H} Z`;
    const fill = [ridgeFar, ridgeMid, ridgeNear][layer];
    parts.push(`<path d="${d}" fill="${fill}" stroke="${strokeInk}" stroke-width="1.75" stroke-linejoin="round"/>`);
  }

  // ④ 近景波纹（3~4 条重复短弧，笔触同 1.75）
  const waves = 3 + Math.floor(pick(0, 2));
  for (let wv = 0; wv < waves; wv += 1) {
    const y = 306 + wv * 15 + pick(-2, 2);
    const seg = pick(26, 40);
    let d = `M${n2(pick(6, 22))} ${n2(y)}`;
    for (let x = 0; x < W - seg; x += seg) {
      d += ` q${n2(seg / 2)} ${n2(-pick(4, 7))} ${n2(seg)} 0`;
    }
    parts.push(`<path d="${d}" fill="none" stroke="${waveInk}" stroke-width="1.75" stroke-linecap="round" opacity="${n2(0.9 - wv * 0.18)}"/>`);
  }

  // ⑤ 版画边框（外细内极细双规）+ 四角铰点
  parts.push(`<rect x="10" y="10" width="${W - 20}" height="${H - 20}" fill="none" stroke="${strokeInk}" stroke-width="1.75"/>`);
  parts.push(`<rect x="16" y="16" width="${W - 32}" height="${H - 32}" fill="none" stroke="${strokeInk}" stroke-width="0.75" opacity="0.6"/>`);
  for (const [cx, cy] of [[10, 10], [W - 10, 10], [10, H - 10], [W - 10, H - 10]]) {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="2.2" fill="${strokeInk}"/>`);
  }

  // ⑥ 期号题字（版画铭牌：置于右下留白处；无期号时退化为日期针脚）
  if (issueText) {
    const label = String(issueText).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    parts.push(`<text x="${W - 26}" y="${H - 30}" text-anchor="end" font-family="Georgia, 'Times New Roman', serif" font-size="13" letter-spacing="2" fill="${mix(ink, paper, 0.25)}">${label}</text>`);
    // 压线宽按字形估算（审查 P3：CJK 全宽 ≈15px，拉丁 ≈7px；length*8.5 对「总第 N 期」明显偏短）。
    // 注意用转义前原文计宽——HTML 实体（&amp; 等）非可见字形。
    const raw = String(issueText);
    const textWidth = [...raw].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e7f ? 15 : 7), 0);
    parts.push(`<line x1="${W - 26 - textWidth}" y1="${H - 24}" x2="${W - 26}" y2="${H - 24}" stroke="${mix(ink, paper, 0.45)}" stroke-width="1"/>`);
  }

  parts.push('</svg>');
  return parts.join('');
}
