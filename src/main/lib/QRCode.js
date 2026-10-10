'use strict';
/**
 * QRCode（知更）— 纯 JS 二维码生成器（F31 口袋知更：访问链接 → SVG 网格）
 *
 * 零依赖自研（ISO/IEC 18004 子集），专为「一个带令牌的 URL」设计：
 * - 字节模式（UTF-8）+ 纠错级 M + 版本 1-10 自动选型（最长 213 字节，口袋 URL 绰绰有余）；
 * - Reed-Solomon 前向纠错（GF(256)，本原多项式 0x11D）+ 分块交织；
 * - 8 种掩码全评估（N1-N4 惩罚）取最优（并列取最小编号）——输出确定性：
 *   同参数同矩阵同 SVG，逐字节可复现（探针红线）；
 * - 输出 SVG（quiet zone 4 模块），设置页 innerHTML 直挂、无需位图。
 */

/** 纠错级 M 的 RS 分块表（版本 1-10）：每组 [块数, 总码字/块, 数据码字/块]。 */
const RS_BLOCKS_M = [
  [[1, 26, 16]],
  [[1, 44, 28]],
  [[1, 70, 44]],
  [[2, 50, 32]],
  [[2, 67, 43]],
  [[4, 43, 27]],
  [[4, 49, 31]],
  [[2, 60, 38], [2, 61, 39]],
  [[3, 58, 36], [2, 59, 37]],
  [[4, 69, 43], [1, 70, 44]],
];

/** 校正图形中心坐标表（版本 1-10）。 */
const ALIGNMENT = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

// ── GF(256) 运算表 ──────────────────────────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** RS 生成多项式（n 个系数，最高次在前，首系数恒 1）。 */
function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];                    // × x
      next[j + 1] ^= gfMul(poly[j], EXP[i]); // × α^i
    }
    poly = next;
  }
  return poly;
}

/** 对一组数据码字计算 n 个纠错码字。 */
function rsEncode(data, n) {
  const gen = rsGenerator(n);
  const res = data.concat(new Array(n).fill(0));
  for (let i = 0; i < data.length; i += 1) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j += 1) res[i + j] ^= gfMul(gen[j], factor);
  }
  return res.slice(data.length);
}

// ── 位缓冲（字节模式编码）─────────────────────────────────────────────
class BitBuffer {
  constructor() { this.bytes = []; this.length = 0; }
  put(value, bits) {
    for (let i = bits - 1; i >= 0; i -= 1) this.putBit(((value >>> i) & 1) === 1);
  }
  putBit(bit) {
    const byteIndex = this.length >> 3;
    if (this.bytes.length <= byteIndex) this.bytes.push(0);
    if (bit) this.bytes[byteIndex] |= 0x80 >>> (this.length & 7);
    this.length += 1;
  }
}

/** 版本 v 的数据码字总容量（块数 × 每块数据码字，跨组求和）。 */
function dataCapacity(version) {
  return RS_BLOCKS_M[version - 1].reduce((sum, [count, , data]) => sum + count * data, 0);
}

/** 字节模式编码 → 数据码字数组（含终止符与补位）。 */
function encodeBytes(text, version) {
  const payload = Buffer.from(String(text ?? ''), 'utf8');
  const capacity = dataCapacity(version);
  const buf = new BitBuffer();
  buf.put(4, 4); // byte mode
  buf.put(payload.length, version < 10 ? 8 : 16); // 字符计数（v1-9 为 8 位）
  for (const b of payload) buf.put(b, 8);
  // 终止符（至多 4 个 0 位）+ 对齐字节边界
  const totalBits = capacity * 8;
  if (buf.length + 4 <= totalBits) buf.put(0, Math.min(4, totalBits - buf.length));
  while (buf.length % 8 !== 0) buf.putBit(false);
  // 补位码字 0xEC / 0x11 交替
  const padBytes = [0xec, 0x11];
  for (let i = 0; buf.bytes.length < capacity; i += 1) buf.bytes.push(padBytes[i % 2]);
  return buf.bytes;
}

/** 数据码字 → RS 分块 + 交织（数据先行纠错后随）。 */
function interleave(codewords, version) {
  const groups = RS_BLOCKS_M[version - 1];
  const blocks = [];
  let cursor = 0;
  for (const [count, total, dataLen] of groups) {
    for (let b = 0; b < count; b += 1) {
      const dc = codewords.slice(cursor, cursor + dataLen);
      cursor += dataLen;
      blocks.push({ dc, ec: rsEncode(dc, total - dataLen) });
    }
  }
  const maxDc = Math.max(...blocks.map((b) => b.dc.length));
  const maxEc = Math.max(...blocks.map((b) => b.ec.length));
  const out = [];
  for (let i = 0; i < maxDc; i += 1) for (const b of blocks) if (i < b.dc.length) out.push(b.dc[i]);
  for (let i = 0; i < maxEc; i += 1) for (const b of blocks) if (i < b.ec.length) out.push(b.ec[i]);
  return out;
}

// ── 矩阵构建 ───────────────────────────────────────────────────────────

function makeMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function setFinder(m, row, col) {
  for (let r = -1; r <= 7; r += 1) {
    if (row + r < 0 || row + r >= m.length) continue;
    for (let c = -1; c <= 7; c += 1) {
      if (col + c < 0 || col + c >= m.length) continue;
      const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6))
        || (c >= 0 && c <= 6 && (r === 0 || r === 6))
        || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      m[row + r][col + c] = dark;
    }
  }
}

function setAlignment(m, row, col) {
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      m[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
    }
  }
}

/** 功能图案（定位/校正/时序/格式与版本预留区）。 */
function drawFunctionPatterns(m, version) {
  const size = m.length;
  for (let i = 0; i < size; i += 1) {
    m[6][i] = i % 2 === 0;
    m[i][6] = i % 2 === 0;
  }
  setFinder(m, 0, 0);
  setFinder(m, 0, size - 7);
  setFinder(m, size - 7, 0);
  const centers = ALIGNMENT[version - 1];
  const last = size - 7;
  for (const r of centers) {
    for (const c of centers) {
      // 与三个定位图形重叠的位置不布校正图形
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      setAlignment(m, r, c);
    }
  }
  // 格式信息预留（占位 false，正式值由 applyFormatInfo 写入）
  for (let i = 0; i < 15; i += 1) {
    if (i < 6) m[i][8] = false;
    else if (i < 8) m[i + 1][8] = false;
    else m[size - 15 + i][8] = false;
    if (i < 8) m[8][size - 1 - i] = false;
    else if (i < 9) m[8][15 - 1 - i + 1] = false;
    else m[8][15 - 1 - i] = false;
  }
  m[size - 8][8] = false; // 暗模块（永久暗点）
  // 版本信息（v≥7）
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      m[Math.floor(i / 3)][(i % 3) + size - 8 - 3] = false;
      m[(i % 3) + size - 8 - 3][Math.floor(i / 3)] = false;
    }
  }
}

/** 格式信息 15 位（EC 级 M=00 + 掩码 3 位 → BCH(15,5) → 异或 0x5412）。 */
function formatBits(mask) {
  const data = (0b00 << 3) | mask; // M 级位型 00
  const gen = 0b10100110111;
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if (((rem >> i) & 1) === 1) rem ^= gen << (i - 10);
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function applyFormatInfo(m, mask) {
  const bits = formatBits(mask);
  const size = m.length;
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    if (i < 6) m[i][8] = dark;
    else if (i < 8) m[i + 1][8] = dark;
    else m[size - 15 + i][8] = dark;
    if (i < 8) m[8][size - 1 - i] = dark;
    else if (i < 9) m[8][15 - 1 - i + 1] = dark;
    else m[8][15 - 1 - i] = dark;
  }
  m[size - 8][8] = true; // 暗模块
}

/** 版本信息 18 位（v≥7）：版本 6 位 → BCH(18,6)，两处 6×3 块。 */
function applyVersionInfo(m, version) {
  if (version < 7) return;
  const gen = 0b1111100100101;
  let rem = version << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if (((rem >> i) & 1) === 1) rem ^= gen << (i - 12);
  }
  const bits = (version << 12) | rem;
  const size = m.length;
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >> i) & 1) === 1;
    m[Math.floor(i / 3)][(i % 3) + size - 8 - 3] = dark;
    m[(i % 3) + size - 8 - 3][Math.floor(i / 3)] = dark;
  }
}

/** 掩码函数（0-7）。 */
function maskBit(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r * c) % 3) + ((r + c) % 2)) % 2 === 0;
  }
}

/** 数据码字 + 掩码进矩阵（之字自右下起，跳过第 6 列）。 */
function mapData(m, codewords, mask) {
  const size = m.length;
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        if (m[row][col - c] == null) {
          let dark = false;
          if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
          if (maskBit(mask, row, col - c)) dark = !dark;
          m[row][col - c] = dark;
          bitIndex -= 1;
          if (bitIndex === -1) { byteIndex += 1; bitIndex = 7; }
        }
      }
      row += inc;
      if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
    }
  }
}

// ── 掩码惩罚评估（N1-N4）─────────────────────────────────────────────

function penalty(m) {
  const size = m.length;
  let score = 0;
  // N1：行/列同色连续 ≥5（3 + 超出量）
  for (let axis = 0; axis < 2; axis += 1) {
    for (let i = 0; i < size; i += 1) {
      let run = 1;
      for (let j = 1; j < size; j += 1) {
        const cur = axis === 0 ? m[i][j] : m[j][i];
        const prev = axis === 0 ? m[i][j - 1] : m[j - 1][i];
        if (cur === prev) {
          run += 1;
          if (j === size - 1 && run >= 5) score += 3 + (run - 5);
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
    }
  }
  // N2：2×2 同色块（每处 +3）
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = m[r][c];
      if (m[r][c + 1] === v && m[r + 1][c] === v && m[r + 1][c + 1] === v) score += 3;
    }
  }
  // N3：1011101 且一侧带 4 个亮模（10111010000 / 00001011101）行/列出现（每处 +40）
  const P1 = [true, false, true, true, true, false, true, false, false, false, false];
  const P2 = [...P1].reverse();
  const match = (get) => {
    for (let i = 0; i < size; i += 1) {
      for (let j = 0; j + 11 <= size; j += 1) {
        let ok1 = true; let ok2 = true;
        for (let k = 0; k < 11; k += 1) {
          const v = get(i, j + k);
          if (v !== P1[k]) ok1 = false;
          if (v !== P2[k]) ok2 = false;
          if (!ok1 && !ok2) break;
        }
        if (ok1 || ok2) score += 40;
      }
    }
  };
  match((i, j) => m[i][j]);
  match((i, j) => m[j][i]);
  // N4：暗模占比偏离 50%（每 5% +10）
  let dark = 0;
  for (const rowArr of m) for (const v of rowArr) if (v) dark += 1;
  const k = Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5);
  score += k * 10;
  return score;
}

// ── 对外 API ───────────────────────────────────────────────────────────

/** 文本 → QR 矩阵（布尔二维数组，true=暗模）。 */
function qrMatrix(text) {
  const bytes = Buffer.from(String(text ?? ''), 'utf8');
  let version = 0;
  for (let v = 1; v <= 10; v += 1) {
    // 字节模式开销：模式 4 位 + 计数（v1-9 8 位 / v10 16 位）
    const overheadBits = 4 + (v < 10 ? 8 : 16);
    if (bytes.length * 8 + overheadBits <= dataCapacity(v) * 8) { version = v; break; }
  }
  if (!version) throw new Error('QR 内容过长（版本 1-10 · 纠错 M 最长 213 字节）。');
  const codewords = interleave(encodeBytes(text, version), version);
  const size = 17 + 4 * version;
  let best = null;
  let bestScore = Infinity;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask += 1) {
    const m = makeMatrix(size);
    drawFunctionPatterns(m, version);
    mapData(m, codewords, mask);
    applyFormatInfo(m, mask);
    applyVersionInfo(m, version);
    const s = penalty(m);
    if (s < bestScore) { bestScore = s; best = m; bestMask = mask; }
  }
  best.version = version;
  best.mask = bestMask;
  return best;
}

/** 文本 → SVG 字符串（白底 quiet zone 4 模块；同参数逐字节同输出）。 */
function qrSvg(text, { border = 4, dark = '#1c1c1e', light = '#ffffff' } = {}) {
  const m = qrMatrix(text);
  const size = m.length;
  const parts = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (m[r][c]) parts.push(`M${c} ${r}h1v1h-1z`);
    }
  }
  const total = size + border * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total * 4}" height="${total * 4}" shape-rendering="crispEdges" role="img" aria-label="QR">`
    + `<rect width="${total}" height="${total}" fill="${light}"/>`
    + `<path d="${parts.join('')}" transform="translate(${border},${border})" fill="${dark}"/>`
    + `</svg>`;
}

module.exports = { qrMatrix, qrSvg, dataCapacity, formatBits };
