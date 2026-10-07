'use strict';
/**
 * mail-worker.js — 邮件订阅工作进程（utilityProcess，F6）
 *
 * 为什么在 worker 里跑 IMAP：Windows + Electron 37 下「同进程内前一条 TLS 连接
 * destroy 与下一条 tls.connect 竞态」会同步楔死主线程（原生层死锁，实测连非 unref
 * 定时器都不再触发；纯 Node 25 复现失败 = Electron 专属缺陷）。会话整体搬进本
 * worker 后：即使楔死也只影响 worker，主进程看门狗杀掉重生，UI 与刷新永不被拖死。
 *
 * 协议（process.parentPort，结构化克隆）：
 * - { id, type: 'session', config: {host,port,username,password,allowSelfSigned},
 *     params: { sender, since, existingIDs, maxMessages, fetchHeaderFields } }
 *   → { id, ok, entries: [{messageID,subject,from:{name,address},dateSeconds,text,html}] }
 *     | { id, ok: false, error: { kind, message, serverText? } }
 * - { id, type: 'mock', op: 'start', delayMs }  → { id, ok, port }   （探针：worker 内起假 IMAPS）
 * - { id, type: 'mock', op: 'stop' }            → { id, ok: true }
 * - { id, type: 'mock', op: 'stats' }           → { id, ok, stats }
 */
const tls = require('node:tls');
const { ImapClient, MailError } = require('../Mail/ImapClient');
const MimeParser = require('../Mail/MimeParser');
const { senderMatches } = require('../Mail/sender');

// MARK: 会话执行（与 MailService.fetchFeed 同语义；条目在此收口成纯数据，主进程消毒）

async function runSession({ config, params }) {
  const client = new ImapClient({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    allowSelfSigned: Boolean(config.allowSelfSigned),
  });
  try {
    await client.connect();
    await client.login();
    await client.selectInbox();

    const seqs = await client.searchMessages({ sinceSeconds: params.since, from: params.sender });
    const existing = new Set(params.existingIDs || []);
    const entries = [];
    for (const seq of seqs) {
      if (entries.length >= params.maxMessages) break;
      const { headerText, bodyText } = await client.fetchMessage(seq);
      const parsed = MimeParser.parseMessage(headerText, bodyText);
      if (!senderMatches(params.sender, parsed.from.address)) continue;
      if (!parsed.messageID) continue; // 无 message-id 无幂等键：跳过
      const key = String(parsed.messageID);
      if (existing.has(key)) continue;
      existing.add(key);
      entries.push({
        messageID: parsed.messageID,
        subject: parsed.subject || '',
        from: parsed.from || { name: '', address: params.sender },
        dateSeconds: parsed.dateSeconds ?? null,
        text: String(parsed.text || ''),
        html: String(parsed.html || ''),
      });
    }
    return { entries };
  } finally {
    try { await client.logout(); } catch (_) { /* 断开属预期 */ }
    // 会话衔接（Windows 原生缺陷规避）：等 socket 完全 close 再放行下一个会话
    try { await client.waitClosed(6000); } catch (_) { /* 兜底超时即放行 */ }
  }
}

/** 测试连接：LOGIN + SELECT + LOGOUT，返回收件箱邮件总数（设置页「测试连接」）。 */
async function runProbe({ config }) {
  const client = new ImapClient({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    allowSelfSigned: Boolean(config.allowSelfSigned),
  });
  try {
    await client.connect();
    await client.login();
    const { exists } = await client.selectInbox();
    return { exists };
  } finally {
    try { await client.logout(); } catch (_) { /* 断开属预期 */ }
    try { await client.waitClosed(6000); } catch (_) { /* 兜底超时即放行 */ }
  }
}

// MARK: 探针用假 IMAPS 服务器（worker 内起，配合真 TLS 全链路；主进程不再承载 server）
//
// 全功能版（与原探针本地 mock 同语义）：SEARCH 按 SINCE/FROM 过滤并记录 searchLog、
// FETCH 计数与 dropOnFetch 掐断、LOGIN 失败计数、delayMs 放慢会话——供探针逐项断言。

const mock = { server: null, state: null, mailbox: [] };

function rfcDate(seconds) {
  return new Date(Number(seconds) * 1000).toUTCString().replace(/GMT$/, '+0000');
}

function mockStart({ delayMs = 0, user = 'probe@test', pass = 'pw', mailbox = [], key, cert } = {}) {
  return new Promise((resolve, reject) => {
    mock.mailbox = mailbox;
    const state = {
      dropOnFetch: false,
      delayMs,
      searchLog: [],
      fetchCount: 0,
      authFails: 0,
      concurrent: 0,
      maxConcurrent: 0,
      totalConnections: 0,
    };
    const server = tls.createServer({ key, cert }, (socket) => {
      state.totalConnections += 1;
      state.concurrent += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
      let authed = false;
      socket.on('error', () => {});
      socket.on('close', () => { state.concurrent -= 1; });
      socket.write('* OK [CAPABILITY IMAP4rev1 LITERAL+] RobinRead mock ready\r\n');

      const write = async (text) => {
        if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
        socket.write(text);
      };

      const parseArgs = (rest) => {
        const out = [];
        let cur = '';
        let inQ = false;
        for (let i = 0; i < rest.length; i += 1) {
          const ch = rest[i];
          if (inQ) {
            if (ch === '\\' && rest[i + 1]) { cur += rest[i + 1]; i += 1; continue; }
            if (ch === '"') { inQ = false; continue; }
            cur += ch;
            continue;
          }
          if (ch === '"') { inQ = true; continue; }
          if (ch === ' ') { if (cur) { out.push(cur); cur = ''; } continue; }
          cur += ch;
        }
        if (cur) out.push(cur);
        return out;
      };

      socket.on('data', (buf) => {
        for (const rawLine of buf.toString('utf8').split('\r\n')) {
          if (!rawLine) continue;
          const sp = rawLine.indexOf(' ');
          const tag = sp > 0 ? rawLine.slice(0, sp) : rawLine;
          const rest = sp > 0 ? rawLine.slice(sp + 1) : '';
          const head = rest.split(/\s+/)[0]?.toUpperCase() || '';
          const body = rest.replace(/^\S+\s+/, '');
          (async () => {
            if (head === 'LOGIN') {
              const [u, p] = parseArgs(body);
              if (u === user && p === pass) {
                authed = true;
                await write(`* CAPABILITY IMAP4rev1\r\n${tag} OK [CAPABILITY IMAP4rev1] Logged in\r\n`);
              } else {
                state.authFails += 1;
                await write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
              }
              return;
            }
            if (!authed) { await write(`${tag} NO Not authenticated\r\n`); return; }
            if (head === 'SELECT' && /INBOX/i.test(body)) {
              await write(`* ${mailbox.length} EXISTS\r\n* FLAGS (\\Seen \\Answered)\r\n* OK [UIDVALIDITY 1] UIDs valid\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
              return;
            }
            if (head === 'SEARCH') {
              const sinceM = body.match(/SINCE\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/);
              const fromM = body.match(/FROM\s+"([^"]*)"/i) || body.match(/FROM\s+(\S+)/i);
              state.searchLog.push({ since: sinceM ? sinceM[1] : null, from: fromM ? fromM[1] : null });
              const sinceMs = sinceM ? Date.parse(`${sinceM[1]} 00:00:00 UTC`) : 0;
              const fromNeedle = (fromM ? fromM[1] : '').toLowerCase();
              const hits = [];
              mailbox.forEach((m, idx) => {
                if (m.internalDate * 1000 >= sinceMs
                  && (!fromNeedle || m.from.toLowerCase().includes(fromNeedle))) hits.push(idx + 1);
              });
              await write(`* SEARCH ${hits.join(' ')}\r\n${tag} OK SEARCH completed\r\n`.replace('SEARCH \r\n', 'SEARCH\r\n'));
              return;
            }
            if (head === 'FETCH') {
              if (state.dropOnFetch) { socket.destroy(); return; }
              const seq = Number(body.match(/^(\d+)/)?.[1] || 0);
              const m = mailbox[seq - 1];
              if (!m) { await write(`${tag} OK FETCH completed\r\n`); return; }
              state.fetchCount += 1;
              const headerText = [
                `Subject: ${m.subject}`,
                `From: ${m.from}`,
                `Date: ${rfcDate(m.date)}`,
                `Message-ID: ${m.messageID}`,
              ].join('\r\n') + '\r\n';
              const headerBuf = Buffer.from(headerText, 'utf8');
              const bodyBuf = Buffer.from(m.body, 'utf8');
              await write(`* ${seq} FETCH (BODY[HEADER.FIELDS (SUBJECT FROM DATE MESSAGE-ID)] {${headerBuf.length}}\r\n`);
              socket.write(headerBuf);
              await write(` BODY[TEXT] {${bodyBuf.length}}\r\n`);
              socket.write(bodyBuf);
              await write(`)\r\n${tag} OK FETCH completed\r\n`);
              return;
            }
            if (head === 'NOOP') { await write(`${tag} OK NOOP completed\r\n`); return; }
            if (head === 'LOGOUT') {
              await write(`* BYE RobinRead mock logging out\r\n${tag} OK LOGOUT completed\r\n`);
              socket.end();
              return;
            }
            await write(`${tag} BAD Unknown command\r\n`);
          })().catch(() => { try { socket.destroy(); } catch (_) { /* 忽略 */ } });
        }
      });
    });
    server.on('error', (err) => { if (!mock.server) reject(err); });
    server.listen(0, '127.0.0.1', () => {
      mock.server = server;
      mock.state = state;
      resolve({ port: server.address().port });
    });
  });
}

function mockStop() {
  return new Promise((resolve) => {
    if (!mock.server) return resolve({});
    mock.server.close(() => resolve({}));
    mock.server = null;
    mock.state = null;
  });
}

/** 探针运行时控制/读数（stats 不回传夹具与凭据）。 */
function mockStats() {
  const s = mock.state;
  return s ? { ...s } : null;
}

// MARK: 消息泵

if (!process.parentPort) {
  console.error('[mail-worker] must be started via utilityProcess.fork (process.parentPort missing)');
} else {
  process.on('uncaughtException', (err) => {
    console.error('[mail-worker] uncaught:', err && err.stack || err);
  });
  process.parentPort.on('message', (event) => {
    const msg = event && event.data;
    if (!msg || typeof msg.id === 'undefined') return;
    if (process.env.ROBIN_MAIL_DEBUG) console.error(`[mw-debug] recv id=${msg.id} type=${msg.type}/${msg.op || ''}`);
    const reply = (payload) => {
      if (process.env.ROBIN_MAIL_DEBUG) console.error(`[mw-debug] reply id=${msg.id} ok=${payload.ok}`);
      try { process.parentPort.postMessage({ id: msg.id, ...payload }); } catch (_) { /* 退出中 */ }
    };
    (async () => {
      if (msg.type === 'session') {
        const { entries } = await runSession({ config: msg.config, params: msg.params });
        reply({ ok: true, entries });
      } else if (msg.type === 'probe') {
        const { exists } = await runProbe({ config: msg.config });
        reply({ ok: true, exists });
      } else if (msg.type === 'mock' && msg.op === 'delay') {
        if (mock.state) mock.state.delayMs = Number(msg.delayMs) || 0;
        reply({ ok: true });
      } else if (msg.type === 'mock' && msg.op === 'start') {
        if (!msg.key || !msg.cert) { reply({ ok: false, error: { kind: 'protocol', message: 'mock start requires key/cert' } }); return; }
        const { port } = await mockStart({ ...(msg.options || {}), key: msg.key, cert: msg.cert });
        reply({ ok: true, port });
      } else if (msg.type === 'mock' && msg.op === 'stop') {
        reply({ ok: true, ...(await mockStop()) });
      } else if (msg.type === 'mock' && msg.op === 'stats') {
        reply({ ok: true, stats: mockStats() });
      } else if (msg.type === 'mock' && msg.op === 'drop') {
        if (mock.state) mock.state.dropOnFetch = msg.on === true;
        reply({ ok: true });
      } else if (msg.type === 'mock' && msg.op === 'push') {
        if (mock.mailbox && msg.message) mock.mailbox.push(msg.message);
        reply({ ok: true });
      } else if (msg.type === 'mock' && msg.op === 'reset') {
        if (mock.state) { mock.state.fetchCount = 0; mock.state.searchLog = []; mock.state.authFails = 0; }
        reply({ ok: true });
      } else {
        reply({ ok: false, error: { kind: 'protocol', message: 'unknown message type' } });
      }
    })().catch((err) => {
      const kind = err instanceof MailError ? err.kind : 'network';
      reply({ ok: false, error: { kind, message: String(err && err.message || err), serverText: err && err.serverText } });
    });
  });
}
