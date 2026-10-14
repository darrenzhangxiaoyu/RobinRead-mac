'use strict';
/**
 * diag-cpu-watch.js — 零接触启动观测：不挂 CDP，纯进程 CPU 轮询（分辨真阻塞 vs 调试器伪影）
 * 用法：node scripts/diag-cpu-watch.js <appdataDir> [watchSec=120] [dev|installed]
 */
const { spawn, execSync } = require('node:child_process');
const APPDATA_DIR = process.argv[2];
const watchSec = Number(process.argv[3] || 120);
const DEV = process.argv[4] === 'dev';
const EXE = 'D:\\Software\\RobinRead\\RobinRead.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snapshot() {
  try {
    const out = execSync(`powershell -Command "Get-Process RobinRead,electron -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU,MainWindowTitle | ConvertTo-Json -Compress"`, { encoding: 'utf8' });
    const j = JSON.parse(out);
    const arr = Array.isArray(j) ? j : [j];
    return new Map(arr.map((p) => [p.Id, { name: p.ProcessName, cpu: p.CPU || 0, title: (p.MainWindowTitle || '').slice(0, 30) }]));
  } catch (_) { return new Map(); }
}

async function main() {
  const child = DEV
    ? spawn('npx', ['electron', '.'], { cwd: process.cwd(), env: { ...process.env, APPDATA: APPDATA_DIR }, detached: true, stdio: 'ignore', shell: true })
    : spawn(EXE, [], { env: { ...process.env, APPDATA: APPDATA_DIR }, detached: true, stdio: 'ignore' });
  child.unref();
  const t0 = Date.now();
  let prev = new Map();
  console.log('t(s)  pid     proc      cpuΔ(s/3s)  window');
  for (;;) {
    await sleep(3000);
    const now = snapshot();
    const dt = Math.round((Date.now() - t0) / 1000);
    for (const [pid, p] of now) {
      const before = prev.get(pid);
      const d = before ? (p.cpu - before.cpu).toFixed(1) : 'new';
      if (!before || (p.cpu - before.cpu) > 0.2) {
        console.log(`${String(dt).padStart(4)}  ${pid}  ${p.name.padEnd(9)} ${String(d).padStart(9)}  ${p.title}`);
      }
    }
    prev = now;
    if (dt > watchSec) break;
  }
  console.log('--- 结束（进程保留运行，请手动观察窗口是否可交互）---');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
