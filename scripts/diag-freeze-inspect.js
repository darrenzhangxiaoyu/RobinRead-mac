'use strict';
/**
 * diag-freeze-inspect.js — 冻结窗口内窥：渲染层 DOM/控制台 + 主进程 CPU 采样
 * 用法：node scripts/diag-freeze-inspect.js <rendererPort> <nodePort> <sampleMs>
 */
const rPort = Number(process.argv[2] || 9223);
const nPort = Number(process.argv[3] || 9229);
const sampleMs = Number(process.argv[4] || 60000);

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, res);
    setTimeout(() => rej(new Error('timeout ' + method)), 45000);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return new Promise((res, rej) => { ws.onopen = () => res({ ws, send }); ws.onerror = (e) => rej(new Error('ws err')); });
}

async function main() {
  const rList = await (await fetch(`http://127.0.0.1:${rPort}/json/list`)).json();
  const page = rList.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const r = await connect(page.webSocketDebuggerUrl);
  await r.send('Runtime.enable');

  // 1) 渲染层 DOM 状态快照（冻结期屏幕上到底是什么）
  const dom = await r.send('Runtime.evaluate', { expression: `(() => {
    const q = (s) => document.querySelectorAll(s).length;
    return JSON.stringify({
      listRows: q('.entry-row'),
      readerArticle: q('.reader-article'),
      readerLoading: q('.reader-loading'),
      robinBodyParas: q('.robin-body p, .robin-body > div'),
      digestModal: q('.digest-modal'),
      onboarding: q('.nj-onboarding-overlay'),
      storeOpen: q('.store-modal, .feed-store'),
      bodyClasses: document.body.className,
      emptyState: q('.reader-empty, .list-empty'),
      title: document.title,
      ts: Date.now(),
    });
  })()`, returnByValue: true });
  console.log('DOM SNAPSHOT:', dom.result.value);

  // 2) 渲染层控制台错误（收集已有 + 后续）
  const errors = [];
  r.ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      errors.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push('EXCEPTION: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text || '').slice(0, 400));
    }
  };

  // 3) 双端 CPU 采样
  const nList = await (await fetch(`http://127.0.0.1:${nPort}/json/list`)).json();
  const nodeT = nList.find((t) => t.webSocketDebuggerUrl);
  const profs = [];
  const startProfiler = async (conn, label) => {
    await conn.send('Profiler.enable');
    await conn.send('Profiler.setSamplingInterval', { interval: 20 });
    await conn.send('Profiler.start');
    profs.push({ conn, label });
  };
  await startProfiler(r, 'renderer');
  let nodeConn = null;
  if (nodeT) {
    nodeConn = await connect(nodeT.webSocketDebuggerUrl);
    await startProfiler(nodeConn, 'MAIN(node)');
  }
  await new Promise((res) => setTimeout(res, sampleMs));

  for (const p of profs) {
    const stopped = await p.conn.send('Profiler.stop');
    const profile = stopped && stopped.result && stopped.result.profile;
    if (!profile || !profile.nodes) { console.log(`[${p.label}] profile 不可用`); continue; }
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
      const fn = cf.functionName || '(anonymous)';
      const url = (cf.url || '').split('/').pop().slice(0, 40);
      const key = fn + ' @' + url;
      agg.set(key, (agg.get(key) || 0) + us);
    }
    const top = [...agg.entries()].map(([k, us]) => [Math.round(us / 1000), k]).sort((a, b) => b[0] - a[0]).slice(0, 14);
    console.log(`\n===== [${p.label}] 采样 ${profile.samples.length} =====`);
    for (const [ms, k] of top) console.log(`  ${String(ms).padStart(8)} ms  ${k}`);
  }

  console.log('\n===== 渲染层错误/异常 =====');
  console.log(errors.length ? errors.slice(0, 20).join('\n') : '(无)');
  process.exit(0);
}

main().catch((e) => { console.error('INSPECT ERR', e); process.exit(1); });
