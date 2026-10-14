'use strict';
/**
 * diag-boot-hang-hunt.js — 启动阻塞猎手：起 App → t+1s 挂采样 → 心跳轮询 → 阻塞复现即留档
 * 用法：node scripts/diag-boot-hang-hunt.js [watchSec=200] [appdata=C:\\...\\rr-appdata]
 */
const { spawn } = require('node:child_process');
const watchSec = Number(process.argv[2] || 200);
const APPDATA_DIR = process.argv[3] || 'C:\\Users\\Lenovo\\AppData\\Local\\Temp\\rr-appdata';
const DEV = process.argv[4] === 'dev';
const EXE = 'D:\\Software\\RobinRead\\RobinRead.exe';
const PORT = 9227;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}, timeoutMs = 12000) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, res);
    setTimeout(() => rej(new Error('timeout ' + method)), timeoutMs);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return new Promise((res, rej) => { ws.onopen = () => res({ ws, send }); ws.onerror = () => rej(new Error('ws err')); });
}

async function main() {
  const child = DEV
    ? spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`], {
        cwd: 'E:\\Agentic_Engineering\\ZCode\\NanJuRss',
        env: { ...process.env, APPDATA: APPDATA_DIR },
        detached: true, stdio: 'ignore', shell: true,
      })
    : spawn(EXE, [`--remote-debugging-port=${PORT}`], {
        env: { ...process.env, APPDATA: APPDATA_DIR },
        detached: true, stdio: 'ignore',
      });
  child.unref();
  const t0 = Date.now();
  // 等 CDP 口就绪
  let page = null;
  for (let i = 0; i < 30 && !page; i += 1) {
    await sleep(1000);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (_) { /* not up yet */ }
  }
  if (!page) { console.log('CDP 未就绪'); process.exit(2); }
  console.log(`[+${Date.now() - t0}ms] CDP ready, attaching`);
  const r = await connect(page.webSocketDebuggerUrl);
  await r.send('Runtime.enable');
  const errors = [];
  r.ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(`[+${Date.now() - t0}ms] EXC: ` + String((d.exception && (d.exception.description || d.exception.value)) || d.text || '').slice(0, 500));
    }
  };
  try {
    await r.send('Profiler.enable');
    await r.send('Profiler.setSamplingInterval', { interval: 15 });
    await r.send('Profiler.start');
    console.log(`[+${Date.now() - t0}ms] profiler armed`);
  } catch (e) {
    console.log(`[+${Date.now() - t0}ms] profiler arm FAILED（已阻塞）: ${e}`);
  }
  // 心跳：每次 2s 超时——超时即阻塞证据
  let blocked = 0;
  for (;;) {
    if (Date.now() - t0 > watchSec * 1000) break;
    try {
      const m = await r.send('Runtime.evaluate', { expression: 'Date.now()' }, 4000);
      const dt = Date.now() - t0;
      if (blocked > 0) console.log(`[+${dt}ms] 恢复响应`);
      blocked = 0;
      void m;
    } catch (e) {
      blocked += 1;
      if (blocked === 1) console.log(`[+${Date.now() - t0}ms] **** 渲染层阻塞开始 ****`);
    }
    await sleep(2000);
  }
  let profile = null;
  try {
    const stopped = await r.send('Profiler.stop', {}, 30000);
    profile = stopped && stopped.result && stopped.result.profile;
  } catch (e) { console.log('stop 失败', String(e)); }
  if (profile && profile.nodes) {
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
      const key = (cf.functionName || '(anonymous)') + ' @' + (cf.url || '').split('/').pop().slice(0, 46);
      agg.set(key, (agg.get(key) || 0) + us);
    }
    const top = [...agg.entries()].map(([k, us]) => [Math.round(us / 1000), k]).sort((a, b) => b[0] - a[0]).slice(0, 18);
    console.log(`\n===== 全程采样 ${profile.samples.length} =====`);
    for (const [ms, k] of top) console.log(`  ${String(ms).padStart(8)} ms  ${k}`);
  }
  if (errors.length) {
    console.log(`\n===== 页面异常 ×${errors.length} =====`);
    console.log([...new Set(errors)].slice(0, 10).join('\n'));
  } else console.log('\n页面异常：无');
  spawn('powershell', ['-Command', "Get-Process RobinRead -ErrorAction SilentlyContinue | Stop-Process -Force"]);
  process.exit(0);
}

main().catch((e) => { console.error('HUNT ERR', e); process.exit(1); });
