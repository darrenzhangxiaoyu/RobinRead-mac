'use strict';
/**
 * diag-click-hang-profile.js — 挂采样器 → 模拟点开首篇文章 → 穿过阻塞期抓渲染层热栈
 * 用法：node scripts/diag-click-hang-profile.js <port> [sampleSec]
 */
const port = Number(process.argv[2] || 9223);
const sampleSec = Number(process.argv[3] || 90);

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}, timeoutMs = 20000) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, res);
    setTimeout(() => rej(new Error('timeout ' + method)), timeoutMs);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return new Promise((res, rej) => { ws.onopen = () => res({ ws, send }); ws.onerror = () => rej(new Error('ws err')); });
}

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const r = await connect(page.webSocketDebuggerUrl);
  await r.send('Profiler.enable');
  await r.send('Profiler.setSamplingInterval', { interval: 15 });
  await r.send('Profiler.start');

  // 5s 后模拟点击第一篇文章行（真实事件路径）
  setTimeout(() => {
    r.send('Runtime.evaluate', { expression: `(() => {
      const row = document.querySelector('.entry-row');
      if (!row) return 'NO-ROW';
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return 'CLICKED';
    })()`, returnByValue: true }, 15000).then((m) => console.log('click →', m.result && m.result.value)).catch((e) => console.log('click eval', String(e)));
  }, 5000);

  // 20s 后再探 DOM（若阻塞，此调用会超时——本身就是证据）
  setTimeout(() => {
    r.send('Runtime.evaluate', { expression: 'document.querySelectorAll(".robin-body p").length + " paras @ " + Date.now()' }, 20000)
      .then((m) => console.log('post-click DOM:', m.result && m.result.value))
      .catch((e) => console.log('post-click BLOCKED:', String(e)));
  }, 20000);

  await new Promise((res) => setTimeout(res, sampleSec * 1000));
  const stopped = await r.send('Profiler.stop', {}, 60000);
  const profile = stopped && stopped.result && stopped.result.profile;
  if (!profile || !profile.nodes) { console.log('profile 不可用'); process.exit(1); }
  const nodeById = new Map(profile.nodes.map((n) => [n.id, n]));
  const hit = new Map();
  profile.samples.forEach((id, i) => {
    const dt = profile.timeDeltas ? (profile.timeDeltas[i] || 0) : 0;
    hit.set(id, (hit.get(id) || 0) + dt);
  });
  const agg = new Map();
  for (const [id, us] of hit) {
    const n = nodeById.get(id);
    if (!n) continue;
    const cf = n.callFrame;
    const key = (cf.functionName || '(anonymous)') + ' @' + (cf.url || '').split('/').pop().slice(0, 44);
    agg.set(key, (agg.get(key) || 0) + us);
  }
  const top = [...agg.entries()].map(([k, us]) => [Math.round(us / 1000), k]).sort((a, b) => b[0] - a[0]).slice(0, 16);
  console.log(`\n===== 采样 ${profile.samples.length} =====`);
  for (const [ms, k] of top) console.log(`  ${String(ms).padStart(8)} ms  ${k}`);
  process.exit(0);
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
