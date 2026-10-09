'use strict';
/**
 * garden-art.js — F23 知识花园「纸感生成式花园」渲染器
 *
 * 按花园状态（成长阶段 / 知更羽毛档 / 枯萎 / 阳光）+ 颜色令牌确定性生成一幅
 * 内联 SVG：花株、知更鸟、天气（日轮/云）全部由状态驱动——零外部资源、零随机
 * 全局态（U15 edition-cover-art 同款手法：FNV-1a 播种 mulberry32）。
 *
 * 确定性合同：同 (state, tokens) 输入 → 逐字节相同的 SVG 输出。
 * 不使用 Date.now()/Math.random()。
 */

/** FNV-1a 32bit 字符串散列 → 无符号种子。 */
export function gardenSeed(state) {
  const key = `${state.stage | 0}|${state.birdStage | 0}|${state.wiltLevel | 0}|${state.sunStreak | 0}|${state.waterTotal | 0}|${state.seedTotal | 0}|${String(state.accent || '').toLowerCase()}`;
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
/** 颜色线性混合（纸感分层色阶的唯一派生手段）。 */
function mix(a, b, t) {
  const A = hex2rgb(a); const B = hex2rgb(b);
  const k = Math.max(0, Math.min(1, Number(t) || 0));
  return `#${[0, 1, 2].map((i) => clamp255(A[i] + (B[i] - A[i]) * k).toString(16).padStart(2, '0')).join('')}`;
}
const n2 = (v) => Math.round(v * 100) / 100; // 两位小数，保证序列化稳定

const W = 320; const H = 200;
const GROUND_Y = 158;

/**
 * 生成花园 SVG 字符串。
 * @param {{stage:number, birdStage:number, wiltLevel:number, sunStreak:number,
 *          waterTotal:number, seedTotal:number, day?:string,
 *          accent:string, paper:string, ink:string}} o
 */
export function gardenArt(o) {
  const state = {
    stage: Math.max(0, Math.min(4, Number(o.stage) || 0)),
    birdStage: Math.max(0, Math.min(4, Number(o.birdStage) || 0)),
    wiltLevel: Math.max(0, Math.min(2, Number(o.wiltLevel) || 0)),
    sunStreak: Math.max(0, Number(o.sunStreak) || 0),
    waterTotal: Math.max(0, Number(o.waterTotal) || 0),
    seedTotal: Math.max(0, Number(o.seedTotal) || 0),
    day: String(o.day || ''),
    accent: o.accent,
    paper: o.paper,
    ink: o.ink,
  };
  const rng = mulberry32(gardenSeed(state));
  const pick = (lo, hi) => lo + (hi - lo) * rng();
  const wilted = state.wiltLevel > 0;

  // 纸感色阶：纸底 → 墨派生；枯萎时全园向纸色褪色
  const fade = wilted ? 0.45 : 0;
  const fadeTo = (c) => mix(c, state.paper, fade);
  const stemColor = fadeTo(mix(state.ink, state.accent, 0.55));
  const leafColor = fadeTo(mix(state.accent, state.ink, 0.25));
  const petalColor = fadeTo(mix(state.accent, state.paper, 0.12));
  const petalDeep = fadeTo(mix(state.accent, state.ink, 0.35));
  const soilColor = mix(state.ink, state.paper, 0.62);
  const strokeInk = mix(state.ink, state.paper, 0.18);
  const birdBody = fadeTo(mix(state.ink, state.paper, 0.28));
  const birdBreast = fadeTo(mix(state.accent, state.ink, 0.18));
  const sunColor = mix(state.accent, state.paper, 0.22);

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-hidden="true" data-garden-art="${state.stage}-${state.birdStage}-${state.wiltLevel}">`);

  // ① 天气：日轮（阳光在）或云（枯萎）。位置由种子微扰，确定性。
  const sunX = n2(pick(258, 286)); const sunY = n2(pick(30, 48)); const sunR = n2(pick(14, 18));
  if (wilted) {
    parts.push(`<g opacity="0.9"><ellipse cx="${sunX - 8}" cy="${sunY + 4}" rx="20" ry="9" fill="${mix(state.ink, state.paper, 0.55)}"/><ellipse cx="${sunX + 12}" cy="${sunY + 8}" rx="16" ry="7" fill="${mix(state.ink, state.paper, 0.68)}"/></g>`);
  } else {
    parts.push(`<circle cx="${sunX}" cy="${sunY}" r="${sunR}" fill="${sunColor}"/>`);
    for (let i = 0; i < 8; i += 1) {
      const ang = (Math.PI * 2 * i) / 8 + pick(0, 0.4);
      const r1 = sunR + 4; const r2 = sunR + 9 + pick(0, 2);
      parts.push(`<line x1="${n2(sunX + Math.cos(ang) * r1)}" y1="${n2(sunY + Math.sin(ang) * r1)}" x2="${n2(sunX + Math.cos(ang) * r2)}" y2="${n2(sunY + Math.sin(ang) * r2)}" stroke="${sunColor}" stroke-width="1.75" stroke-linecap="round" opacity="0.75"/>`);
    }
  }

  // ② 远景点缀（满园阶段才有：远树两层）
  if (state.stage >= 4) {
    for (let i = 0; i < 2; i += 1) {
      const tx = n2(pick(26, 70) + i * 220);
      const th = n2(pick(16, 24));
      parts.push(`<path d="M${tx} ${GROUND_Y} v-${n2(th)}" stroke="${strokeInk}" stroke-width="2.4" stroke-linecap="round"/>`);
      parts.push(`<circle cx="${tx}" cy="${n2(GROUND_Y - th - 4)}" r="${n2(pick(8, 11))}" fill="${leafColor}" opacity="0.55"/>`);
    }
  }

  // ③ 大地（纸感土壤条 + 草皮线）
  parts.push(`<rect x="0" y="${GROUND_Y}" width="${W}" height="${H - GROUND_Y}" fill="${soilColor}" opacity="0.5"/>`);
  parts.push(`<line x1="0" y1="${GROUND_Y}" x2="${W}" y2="${GROUND_Y}" stroke="${strokeInk}" stroke-width="1.75"/>`);
  const tufts = 3 + state.stage * 2; // 草丛密度随阶段可感增长
  for (let i = 0; i < tufts; i += 1) {
    const x = n2(pick(8, W - 8)); const h = n2(pick(4, 9));
    parts.push(`<path d="M${x} ${GROUND_Y} q${n2(pick(-2, 2))} -${n2(h)} ${n2(pick(-4, 4))} -${n2(h + 2)}" fill="none" stroke="${leafColor}" stroke-width="1.4" stroke-linecap="round" opacity="0.8"/>`);
  }

  // ④ 花株（数量/形态随阶段跃迁；枯萎时垂头）
  const spots = [W * 0.5, W * 0.26, W * 0.72, W * 0.14, W * 0.86];
  const plantCount = [1, 1, 2, 3, 5][state.stage];
  for (let p = 0; p < plantCount; p += 1) {
    const x = n2(spots[p] + pick(-8, 8));
    const stemH = n2(pick(30, 46) + state.stage * 4);
    const droop = wilted ? pick(10, 20) * state.wiltLevel : 0;
    const topY = GROUND_Y - stemH;
    // 茎（枯萎→弯曲垂头）
    if (wilted) {
      parts.push(`<path d="M${x} ${GROUND_Y} C${n2(x + pick(-4, 4))} ${n2(GROUND_Y - stemH * 0.5)} ${n2(x - droop)} ${n2(topY + 10)} ${n2(x - droop * 1.4)} ${n2(topY + 6)}" fill="none" stroke="${stemColor}" stroke-width="2.4" stroke-linecap="round"/>`);
    } else {
      parts.push(`<line x1="${x}" y1="${GROUND_Y}" x2="${x}" y2="${topY}" stroke="${stemColor}" stroke-width="2.4" stroke-linecap="round"/>`);
    }
    // 叶（幼苗起成对）
    if (state.stage >= 1) {
      const leafY = GROUND_Y - stemH * 0.38;
      const leafL = n2(pick(9, 13));
      parts.push(`<path d="M${x} ${n2(leafY)} q-${leafL} -${n2(leafL * 0.7)} -${n2(leafL * 1.5)} 0 q${n2(leafL * 0.6)} ${n2(leafL * 0.55)} ${n2(leafL * 1.5)} 0z" fill="${leafColor}"/>`);
      parts.push(`<path d="M${x} ${n2(leafY + 8)} q${leafL} -${n2(leafL * 0.7)} ${n2(leafL * 1.5)} 0 q-${n2(leafL * 0.6)} ${n2(leafL * 0.55)} -${n2(leafL * 1.5)} 0z" fill="${leafColor}" opacity="0.85"/>`);
    }
    // 顶端形态：种子堆 / 幼苗芯 / 花蕾 / 盛开
    const apexX = wilted ? x - droop * 1.4 : x;
    const apexY = wilted ? topY + 6 : topY;
    if (state.stage === 0) {
      // 种子：土中一点 + 土堆
      parts.push(`<ellipse cx="${x}" cy="${n2(GROUND_Y - 3)}" rx="9" ry="3" fill="${soilColor}"/>`);
      parts.push(`<ellipse cx="${x}" cy="${n2(GROUND_Y - 5)}" rx="3.2" ry="4.2" fill="${mix(state.ink, state.paper, 0.35)}" transform="rotate(${n2(pick(-16, 16))} ${x} ${GROUND_Y - 5})"/>`);
    } else if (state.stage === 1) {
      parts.push(`<circle cx="${apexX}" cy="${n2(apexY - 2)}" r="2.6" fill="${leafColor}"/>`);
    } else if (state.stage === 2) {
      // 花蕾：水滴形闭蕾
      parts.push(`<path d="M${apexX} ${n2(apexY + 6)} C${n2(apexX - 6)} ${n2(apexY)} ${n2(apexX - 5)} ${n2(apexY - 8)} ${apexX} ${n2(apexY - 11)} C${n2(apexX + 5)} ${n2(apexY - 8)} ${n2(apexX + 6)} ${n2(apexY)} ${apexX} ${n2(apexY + 6)}z" fill="${petalDeep}"/>`);
    } else {
      // 盛开：五瓣花 + 花芯（满园阶段多层花瓣）
      const petals = state.stage >= 4 ? 7 : 5;
      const pr = n2(pick(6.5, 8.5) + (state.stage >= 4 ? 1.5 : 0));
      for (let i = 0; i < petals; i += 1) {
        const ang = (Math.PI * 2 * i) / petals - Math.PI / 2;
        const px = n2(apexX + Math.cos(ang) * pr);
        const py = n2(apexY + Math.sin(ang) * pr);
        parts.push(`<ellipse cx="${px}" cy="${py}" rx="${n2(pr * 0.72)}" ry="${n2(pr * 0.5)}" fill="${petalColor}" stroke="${petalDeep}" stroke-width="1" transform="rotate(${n2((ang * 180) / Math.PI)} ${px} ${py})"/>`);
      }
      parts.push(`<circle cx="${apexX}" cy="${apexY}" r="${n2(pr * 0.42)}" fill="${mix(state.ink, state.paper, 0.3)}"/>`);
    }
  }

  // ⑤ 知更鸟（羽毛档 0-4：羽色深度/尾羽/翅纹/冠羽随档升级；枯萎时低头收羽）
  const bx = n2(pick(190, 216)); const by = GROUND_Y - 14 - pick(0, 4);
  const tier = state.birdStage;
  const crest = tier >= 3 ? `<path d="M${n2(bx + 2)} ${n2(by - 12)} q3 -6 7 -4" fill="none" stroke="${birdBody}" stroke-width="1.75" stroke-linecap="round"/>` : '';
  const tails = 1 + tier; // 尾羽根数随羽毛档
  let tail = '';
  for (let i = 0; i < tails; i += 1) {
    const off = i * 2.4 - (tails - 1) * 1.2;
    tail += `<line x1="${n2(bx - 11)}" y1="${n2(by + 1)}" x2="${n2(bx - 20 - off * 0.6)}" y2="${n2(by - 2 + off)}" stroke="${birdBody}" stroke-width="1.75" stroke-linecap="round"/>`;
  }
  const wingArcs = tier >= 1
    ? `<path d="M${n2(bx - 6)} ${n2(by + 1)} q5 -4 10 0" fill="none" stroke="${mix(birdBody, state.paper, 0.45)}" stroke-width="1.4"/>`
      + (tier >= 2 ? `<path d="M${n2(bx - 5)} ${n2(by + 3.5)} q5 -3.4 9 0" fill="none" stroke="${mix(birdBody, state.paper, 0.45)}" stroke-width="1.2"/>` : '')
      + (tier >= 4 ? `<path d="M${n2(bx - 4)} ${n2(by + 6)} q4 -2.6 7 0" fill="none" stroke="${mix(birdBody, state.paper, 0.45)}" stroke-width="1"/>` : '')
    : '';
  const headTilt = wilted ? 3 : 0;
  parts.push(`<g>
    <line x1="${n2(bx - 2)}" y1="${n2(by + 9)}" x2="${n2(bx - 2)}" y2="${GROUND_Y}" stroke="${strokeInk}" stroke-width="1.4"/>
    <line x1="${n2(bx + 3)}" y1="${n2(by + 9)}" x2="${n2(bx + 3)}" y2="${GROUND_Y}" stroke="${strokeInk}" stroke-width="1.4"/>
    ${tail}
    <ellipse cx="${bx}" cy="${n2(by + 3)}" rx="11" ry="8" fill="${birdBody}"/>
    <path d="M${n2(bx - 9)} ${n2(by + 6)} a11 8 0 0 0 10 5 a9 7 0 0 1 -10 -5z" fill="${birdBreast}"/>
    <circle cx="${n2(bx + 8)}" cy="${n2(by - 6 + headTilt)}" r="5.6" fill="${birdBody}"/>
    <path d="M${n2(bx + 13)} ${n2(by - 6 + headTilt)} l6 2 l-6 2z" fill="${mix(state.ink, state.paper, 0.15)}"/>
    <circle cx="${n2(bx + 9.4)}" cy="${n2(by - 7 + headTilt)}" r="1" fill="${mix(state.ink, state.paper, 0.1)}"/>
    ${wingArcs}
    ${crest}
  </g>`);

  // ⑥ 落花针脚（本周新开花时地上散瓣——开花报告的可视回声；数量确定性）
  const petals = Math.min(6, 0 + (state.stage >= 3 ? Math.floor(pick(2, 5)) : 0));
  for (let i = 0; i < petals; i += 1) {
    parts.push(`<ellipse cx="${n2(pick(30, W - 30))}" cy="${n2(GROUND_Y + pick(4, H - GROUND_Y - 6))}" rx="2.6" ry="1.4" fill="${petalColor}" transform="rotate(${n2(pick(0, 180))} ${n2(pick(30, W - 30))} ${GROUND_Y + 8})"/>`);
  }

  parts.push('</svg>');
  return parts.join('');
}
