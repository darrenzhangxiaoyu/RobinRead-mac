'use strict';
/**
 * EdgeTTS.js — 微软 Edge 神经语音原生客户端（替代 msedge-tts 依赖）
 *
 * 2026-10 用户实报「神经语音无法使用」：微软给 WSS 端点上了 Sec-MS-GEC v2 令牌闸
 * （cs64-sha256 复合摘要），旧 msedge-tts 库不带令牌 → 握手恒 403。
 * 本模块按 edge-tts 官方实现（drm.py/constants.py，GPL-3.0 同源许可）逐位移植：
 *  - 令牌算法与官方 Python 对拍逐位一致（golden 中间值见 diag-tts-neural 探针）
 *  - 实测：握手 750ms / 25KB mp3 合成 1.27s
 *
 * 端点与常量：speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
 * 协议三段：speech.config（输出格式）→ ssml（X-RequestId/Path:ssml）→ 二进制帧
 * Path:audio 切片累积至 Path:turn.end。
 */
const crypto = require('node:crypto');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const SEC_MS_GEC_VERSION = '2-' + CHROMIUM_FULL_VERSION;
const WIN_EPOCH = 11644473600;
const M = 0xFFFFFFFF;

// FIPS 180-4 SHA-256 常量 + 微软 GEC v2 魔改位（对照 drm.py 常量表）
const SHA256_INITIAL = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
const SHA256_STATE = [0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2];
const SHA256_SCHEDULE = [0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6, 0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564];
const K256 = [0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5, 0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174, 0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA, 0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967, 0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85, 0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070, 0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3, 0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2];
const SHA256_ADJUSTMENT = 0xC9DC06A7;
const BLOCK_K = K256.slice(0, 14).concat([SHA256_ADJUSTMENT], K256.slice(15));
const SIG0_ADJ = 0x059C0B80;
const SIG1_ADJ = 0x000B92C0;

const CS64_COEFFICIENTS = [[0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038], [0xC89C5933, 0xB328CBDF], [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C], [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB], [0x06064CF3, 0xFA51A3DA], [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61], [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167]];
const CS64_FACTOR = 0x82893933;
const CS64_ADJ0 = 0xF2F90B1A;
const CS64_ADJ1 = 0x0B1A0000;

const rol16 = (v) => (((v << 16) | (v >>> 16)) & M) >>> 0;
const rotr = (x, n) => (((x >>> n) | (x << (32 - n))) & M) >>> 0;
const sigma0 = (v) => ((v >>> 7) ^ ((v << 25) >>> 0) ^ (v >>> 18) ^ ((v << 14) >>> 0) ^ (v >>> 3)) >>> 0;
const sigma1 = (v) => ((v >>> 17) ^ ((v << 15) >>> 0) ^ (v >>> 19) ^ ((v << 13) >>> 0) ^ (v >>> 10)) >>> 0;

function expandSchedule(words, first = 16) {
  for (let i = first; i < 64; i++) {
    words.push((sigma1(words[i - 2]) + words[i - 7] + sigma0(words[i - 15]) + words[i - 16]) >>> 0);
  }
}

function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const K = firstRound === 14 ? BLOCK_K : K256;
  for (let i = firstRound; i < 64; i++) {
    const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = ((e & f) ^ (~e & g)) >>> 0;
    const t1 = (h + S1 + ch + K[i] + words[i]) >>> 0;
    const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = ((a & b) | (c & ((a | b) >>> 0))) >>> 0; // 与官方 OR 形式等价（XOR 形式在 ab=1,c=1 时翻转——移植期实错已修）
    const t2 = (S0 + maj) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

function sha256Init(data7) {
  const words = new Array(14).fill(0);
  words.push((data7[0] << 16) | (data7[1] << 8) | data7[2]);
  words.push(((data7[3] << 24) | (data7[4] << 16) | (data7[5] << 8) | data7[6]) >>> 0);
  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) value += (i === 16 ? (sigma1(words[i - 2]) ^ SIG1_ADJ) : sigma1(words[i - 2])) >>> 0;
    if (i - 7 >= 14) value += words[i - 7];
    if (i - 15 >= 14) value += (i === 29 ? (sigma0(words[i - 15]) ^ SIG0_ADJ) : sigma0(words[i - 15])) >>> 0;
    words.push(value >>> 0);
  }
  words.push((sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + SHA256_ADJUSTMENT - K256[14]) >>> 0);
  expandSchedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, i) => (x + working[i]) >>> 0);
}

function sha256Digest(data) {
  if (data.length < 7) throw new Error('Token salt must contain at least seven bytes');
  const length = 57 + data.length;
  const padN = (((55 - length) % 64) + 64) % 64;
  const head = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(padN)]);
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64BE(BigInt(length * 8));
  const full = Buffer.concat([head, lenBuf]);
  let state = sha256Init(data.subarray(0, 7));
  for (let off = 0; off < full.length; off += 64) {
    const words = [];
    for (let i = 0; i < 16; i++) words.push(full.readUInt32BE(off + i * 4));
    expandSchedule(words, 16);
    const working = sha256Rounds(state, words);
    state = state.map((x, i) => (x + working[i]) >>> 0);
  }
  const out = Buffer.alloc(32);
  state.forEach((w, i) => out.writeUInt32BE(w, i * 4));
  return out;
}

function wordsLe4Even(data) {
  const padLen = (4 - (data.length % 4)) % 4;
  const padded = Buffer.concat([data, Buffer.alloc(padLen)]);
  const words = [];
  for (let i = 0; i < padded.length; i += 4) words.push(padded.readUInt32LE(i));
  if (words.length % 2) words.push(0);
  return words;
}

function cs64Digest(data, digest) {
  const keyA = digest.readUInt32LE(0) | 1;
  const keyB = digest.readUInt32LE(4) | 1;
  const f0 = Math.imul(keyA, CS64_FACTOR) >>> 0;
  const f1 = Math.imul(keyB, CS64_FACTOR) >>> 0;
  const terms = [], offsets = [];
  CS64_COEFFICIENTS.forEach(([coef], i) => terms.push(Math.imul(coef, i % 2 === 0 ? f0 : f1) >>> 0));
  CS64_COEFFICIENTS.forEach(([, off]) => offsets.push(off >>> 0));
  wordsLe4Even(Buffer.concat([Buffer.from([0]), data])).forEach((word, index) => {
    let term = Math.imul(word, index % 2 === 0 ? keyA : keyB);
    let off = Math.imul(rol16(word), index % 2 === 0 ? 0xEF0569FB : 0xC31713DB);
    if (index === 0) {
      term += Math.imul(CS64_ADJ0, f0);
      off += CS64_ADJ1;
    }
    terms.push(term >>> 0);
    offsets.push(off >>> 0);
  });
  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16((offsets[i] + x) >>> 0);
    let q = Math.imul(t, 0x76F50F34) >>> 0;
    swapAcc += (Math.imul(rol16(q), 0xC3EFEA97) + q) >>> 0;
    t = rol16((offsets[i + 1] + y) >>> 0);
    q = Math.imul(t, 0x1881CE3C) >>> 0;
    swapLast = (Math.imul(rol16(q), 0x35BD1EC9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;
    state = (Math.imul(state, keyA) + x) >>> 0;
    state = Math.imul(rol16(state), 0xCF98B111) >>> 0;
    state = Math.imul(rol16(state), 0x87085B9F) >>> 0;
    state = Math.imul(rol16(state), 0x12CEB96D) >>> 0;
    state = Math.imul(rol16(state), 0x257E1D83) >>> 0;
    acc += state;
    let t2 = (Math.imul(state, keyB) + y) >>> 0;
    t2 = Math.imul(rol16(t2), 0xA27416F5) >>> 0;
    t2 = Math.imul(rol16(t2), 0xD38396FF) >>> 0;
    state = Math.imul(rol16(Math.imul(rol16(t2), 0x7C932B89) >>> 0), 0xBFA49F69) >>> 0;
    acc = (acc + state) >>> 0;
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

/** GEC v2 令牌：「<16hex>-<64hex>」；ticks 走 BigInt（×1e7 后 1.3e17 超 2^53，float 会失位）。 */
function secMsGecV2(nowSec) {
  let ticks = BigInt(nowSec == null ? Math.floor(Date.now() / 1000) : nowSec) + BigInt(WIN_EPOCH);
  ticks -= ticks % 300n; // 5 分钟地板
  ticks *= 10000000n; // 100ns 单位
  const data = Buffer.from(ticks.toString() + TRUSTED_CLIENT_TOKEN, 'ascii');
  const digest = sha256Digest(data);
  const cs = cs64Digest(data, digest);
  const csBuf = Buffer.alloc(8);
  csBuf.writeUInt32LE(cs[0], 0);
  csBuf.writeUInt32LE(cs[1], 4);
  return csBuf.toString('hex').toUpperCase() + '-' + digest.toString('hex').toUpperCase();
}

/** 本地语速倍率 → Edge 百分比语速（'+0%' 形态）。 */
function rateToPercent(rate) {
  const pct = Math.round((Number(rate) || 1) * 100) - 100;
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

function ssmlClock() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '');
}

/**
 * Edge 神经语音合成（WSS 三段协议）。resolve mp3 Buffer。
 * @param {object} opts { text, voice, rate, timeoutMs }
 */
function synthesizeEdge({ text, voice = 'zh-CN-XiaoxiaoNeural', rate = 1, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    let WebSocketImpl;
    try {
      WebSocketImpl = require('ws');
    } catch (_) {
      reject(new Error('neural tts: ws module missing'));
      return;
    }
    const content = String(text || '').trim();
    if (!content) { reject(new Error('empty text')); return; }
    const gec = secMsGecV2();
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`
      + `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${encodeURIComponent(SEC_MS_GEC_VERSION)}`;
    const muid = crypto.randomBytes(16).toString('hex').toUpperCase();
    const ws = new WebSocketImpl(url, {
      headers: {
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION.split('.')[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM_FULL_VERSION.split('.')[0]}.0.0.0`,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Cookie: `muid=${muid};`,
      },
      handshakeTimeout: 15000,
    });
    const chunks = [];
    const timer = setTimeout(() => { try { ws.close(); } catch (_) { /* 已关 */ } reject(new Error('neural tts: timeout')); }, timeoutMs);
    const done = (fn, arg) => { clearTimeout(timer); try { ws.close(); } catch (_) { /* 已关 */ } fn(arg); };
    ws.on('open', () => {
      const cfg = `X-RequestId:${crypto.randomBytes(16).toString('hex')}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } });
      ws.send(cfg);
      const safe = content.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${voice}'><prosody rate='${rateToPercent(rate)}' pitch='+0Hz'>${safe}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${crypto.randomBytes(16).toString('hex')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ssmlClock()}\r\nPath:ssml\r\n\r\n${ssml}`);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const idx = data.toString('latin1').indexOf('Path:audio\r\n');
        if (idx >= 0) chunks.push(data.subarray(idx + 'Path:audio\r\n'.length));
      } else if (data.toString().includes('Path:turn.end')) {
        const buffer = Buffer.concat(chunks);
        if (buffer.length < 512) done(reject, new Error('neural tts: empty audio'));
        else done(resolve, buffer);
      }
    });
    ws.on('error', (e) => done(reject, new Error(`Edge TTS WebSocket error: ${e && e.message}`)));
  });
}

module.exports = { synthesizeEdge, secMsGecV2, rateToPercent, _internals: { sha256Digest, cs64Digest } };
