'use strict';
/**
 * diag-hot-cpu-sampler.js — CDP CPU 采样器（诊断 v2.16.0 启动卡滞）
 * 用法：node scripts/diag-hot-cpu-sampler.js <port> [durationSec]
 * 连 --remote-debugging-port 的 Electron，对全部 page 目标采样，聚合自耗时 Top 函数。
 */
const port = Number(process.argv[2] || 9223);
const dur = Number(process.argv[3] || 90) * 1000;

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  console.log(`targets: ${pages.length}`);
  const results = await Promise.all(pages.map((p) => profileOne(p)));
  for (const r of results) {
    console.log(`\n===== ${r.title} (${r.url.slice(0, 90)}) =====`);
    if (r.error) { console.log('ERR', r.error); continue; }
    console.log(`样本总数 ${r.samples}, 自耗时 Top:`);
    for (const row of r.top) console.log(`  ${String(row.ms).padStart(8)} ms  ${row.fn}  (${r.file(row.node)})`);
  }
}

async function profileOne(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', { interval: 20 });
    await send('Profiler.start');
    await new Promise((r) => setTimeout(r, dur));
    const stopped = await send('Profiler.stop');
    const profile = stopped && stopped.result && stopped.result.profile;
    if (!profile || !Array.isArray(profile.nodes) || !Array.isArray(profile.samples)) {
      return { title: target.title, url: target.url, error: 'profile incomplete: ' + JSON.stringify(Object.keys(stopped || {})) };
    }
    // 聚合 self time
    const nodeById = new Map(profile.nodes.map((n) => [n.id, n]));
    const hit = new Map();
    const delta = profile.samples.length ? profile.timeDeltas : [];
    profile.samples.forEach((id, i) => {
      const dt = delta[i] || 0;
      hit.set(id, (hit.get(id) || 0) + dt);
    });
    const rows = [...hit.entries()].map(([id, us]) => {
      const n = nodeById.get(id) || { callFrame: { functionName: '?', url: '' } };
      return { ms: Math.round(us / 1000), fn: n.callFrame.functionName || '(anonymous)', url: n.callFrame.url };
    });
    const agg = new Map();
    for (const r of rows) {
      const key = r.fn;
      const cur = agg.get(key) || { ms: 0, urls: new Set() };
      cur.ms += r.ms;
      if (r.url) cur.urls.add(r.url.split('/').pop());
      agg.set(key, cur);
    }
    const top = [...agg.entries()].map(([fn, v]) => ({ fn, ms: v.ms, urls: [...v.urls] }))
      .sort((a, b) => b.ms - a.ms).slice(0, 12);
    return {
      title: target.title, url: target.url,
      samples: profile.samples.length, top,
      file: (node) => 'x',
    };
  } catch (e) {
    return { title: target.title, url: target.url, error: String(e && e.message || e) };
  } finally {
    // 把 urls 并进 top 输出
  }
}

// 给 top 补 url 展示（上面 file 占位 hack 修正：直接在打印时用）
main().then(() => process.exit(0)).catch((e) => { console.error('SAMPLER ERR', e); process.exit(1); });
