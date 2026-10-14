'use strict';
/**
 * diag-late-attach.js — 延迟附加实证：DOM 健康度 + 点开文章计时 + 截图
 * 用法：node scripts/diag-late-attach.js <port> [outPrefix]
 */
const port = Number(process.argv[2] || 9223);
const prefix = process.argv[3] || 'shot';
const fs = require('node:fs');

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
  const evalJS = async (expr, ms = 20000) => {
    const m = await r.send('Runtime.evaluate', { expression: expr, returnByValue: true }, ms);
    if (m.result && m.result.exceptionDetails) return 'EXC: ' + m.result.exceptionDetails.text;
    return m.result ? m.result.result.value : undefined;
  };

  const health = await evalJS(`(() => {
    const q = (s) => document.querySelectorAll(s).length;
    return JSON.stringify({
      listRows: q('.entry-row'), unread: q('.entry-row.unread'),
      readerOpen: q('.reader-article'), feedTree: q('.feed-node, .sidebar-item'),
      windowTitle: document.title, bodyCls: document.body.className.slice(0, 60),
    });
  })()`);
  console.log('HEALTH:', health);

  // 点开第一篇文章并计时到正文渲染
  const t0 = Date.now();
  const clickRes = await evalJS(`(() => {
    const row = document.querySelector('.entry-row');
    if (!row) return 'NO-ROW';
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'CLICKED';
  })()`);
  console.log('click:', clickRes);
  for (let i = 0; i < 40; i += 1) {
    await new Promise((res) => setTimeout(res, 250));
    const paras = await evalJS(`document.querySelectorAll('.robin-body p').length`, 8000);
    if (paras && paras > 0) {
      console.log(`正文渲染成功：${paras} 段，耗时 ${Date.now() - t0}ms`);
      break;
    }
    if (i === 39) console.log('正文 10s 未渲染');
  }
  // 再点第二篇（验证连续打开）
  await new Promise((res) => setTimeout(res, 1500));
  await evalJS(`(() => { const rows = document.querySelectorAll('.entry-row'); if (rows[1]) rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); return 1; })()`);
  await new Promise((res) => setTimeout(res, 2500));
  const state2 = await evalJS(`document.querySelectorAll('.robin-body p').length + ' 段@' + document.querySelector('.robin-header-title')?.textContent?.slice(0, 40)`);
  console.log('第二篇:', state2);

  // 截图（列表态 + 正文态）
  await r.send('Page.enable');
  for (const [name, expr] of [
    ['list', `document.querySelector('.column-list, .list-scroll')?.scrollTop = 0; 1`],
  ]) {
    await evalJS(expr);
    await new Promise((res) => setTimeout(res, 600));
    const shot = await r.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 }, 30000);
    fs.writeFileSync(`C:\\Users\\Lenovo\\AppData\\Local\\Temp\\${prefix}-${name}.jpg`, Buffer.from(shot.result.data, 'base64'));
    console.log(`截图: ${prefix}-${name}.jpg`);
  }
  const shot2 = await r.send('Page.captureScreenshot', { format: 'jpeg', quality: 85 }, 30000);
  fs.writeFileSync(`C:\\Users\\Lenovo\\AppData\\Local\\Temp\\${prefix}-article.jpg`, Buffer.from(shot2.result.data, 'base64'));
  console.log(`截图: ${prefix}-article.jpg`);
  process.exit(0);
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
