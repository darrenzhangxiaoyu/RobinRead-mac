'use strict';
/**
 * diag-tts-neural.js — 神经语音 GEC v2 修复探针（run-all OFFLINE 集，全程离线、零网络）
 *
 * 背景：微软 2025 起 Edge TTS WSS 端点强制 Sec-MS-GEC v2 令牌（cs64-sha256 复合摘要），
 * 旧 msedge-tts 库不带令牌 → 握手恒 403 → 用户实报「神经语音无法使用」。
 * src/main/EdgeTTS.js 按官方 drm.py 逐位移植；本探针离线锁定移植正确性：
 *  1 静态：EdgeTTS 原生客户端在册 + NeuralTTSService 已弃 msedge-tts
 *  2 黄金值：secMsGecV2(固定时间戳) 与官方 Python 实现逐位一致（2026-10-14 对拍采集）
 *  3 黄金值：sha256Digest/cs64Digest 中间摘要逐位一致
 *  4 语速换算 '+0%' 形态
 */
const path = require('node:path');
const fs = require('node:fs');
setTimeout(() => { process.exit(3); }, 60 * 1000).unref();
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

try {
  const edgeSrc = read('src/main/EdgeTTS.js');
  const svcSrc = read('src/main/NeuralTTSService.js');
  ok(edgeSrc.includes('Sec-MS-GEC') && edgeSrc.includes('cs64Digest') && edgeSrc.includes("require('ws')"),
    '1 EdgeTTS 原生客户端在册（GEC v2 令牌 + ws 依赖）');
  ok(!svcSrc.includes("require('msedge-tts')") && svcSrc.includes("require('./EdgeTTS')"),
    '1 NeuralTTSService 已切原生客户端（msedge-tts 弃用——403 根因）');

  const { secMsGecV2, rateToPercent, _internals } = require('../src/main/EdgeTTS');
  // 官方 Python generate_sec_ms_gec_v2 对拍值（rany2/edge-tts drm.py，2026-10-14 采集）
  ok(secMsGecV2(1760000000) === '6D50DDDB91812C33-DD68EFB01898B0750C9797D51A5FF93471DFDAE6888A1039D532CBDCCE54545D',
    '2 GEC v2 黄金值 #1（t=1760000000 与官方 Python 逐位一致）');
  ok(secMsGecV2(1760000123) === 'BAF4076F572BFE4E-2D6FBE5C0E24F56622EB94F37395F2D153C6C0C451DAAE2249A459BB3AFAD62C',
    '2 GEC v2 黄金值 #2（t=1760000123 跨 5 分钟桶边界语义）');
  // 中间摘要黄金值（输入 = t=1760000000 的 ticks+token 串）
  const data = Buffer.from('1332447360000000006A5AA1D4EAFF4E9FB37E23D68491D6F4', 'ascii');
  const d = _internals.sha256Digest(data);
  ok(d.toString('hex').toUpperCase() === 'A3E2CB5899B7B1714673E962046E735695C523899D3B5E086E8E7AB6F0E2F6EC',
    '3 魔改 SHA-256 摘要黄金值（首 7 字节预置态 + 调整位全对齐）');
  const cs = _internals.cs64Digest(data, d);
  const csHex = cs[0].toString(16).toUpperCase().padStart(8, '0') + cs[1].toString(16).toUpperCase().padStart(8, '0');
  ok(csHex === 'A464744AB6E0926F', '3 CS64 双字黄金值（小端打包）');
  ok(rateToPercent(1) === '+0%' && rateToPercent(1.25) === '+25%' && rateToPercent(0.9) === '-10%',
    "4 语速换算形态（+0%/+25%/-10%）");
  console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
} catch (e) {
  console.error('PROBE ERROR:', e && e.stack || e);
  process.exit(2);
}
