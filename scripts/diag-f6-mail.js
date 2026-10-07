'use strict';
/**
 * diag-f6-mail.js — F6 Newsletter 收件端到端探针（run-all OFFLINE 集，全程离线）
 *
 * 网络：本地 node:tls.createServer(自签证书) 假 IMAPS 服务器（真 TLS 握手 + 真 IMAP
 * 字节流协议），客户端走真实 ImapClient（无注入短路）。覆盖（对应 F6 探针 10 条）：
 *  1 v16 迁移：mail_accounts 建表 + 密码不落库（password_ref 存在/明文列不存在/行值无明文）
 *  2 IMAP 客户端：LOGIN 成功 / 认证失败分类（auth）/ 网络不可达分类（network）/
 *    SELECT / SEARCH SINCE+FROM / FETCH literal 响应解析
 *  3 MIME：B 编码中文主题、Q 编码、quoted-printable、base64、multipart 取 plain、
 *    charset=gbk 解码 + 不支持 charset 降级 utf-8
 *  4 添加账户端到端：testConnection 返回 OK+邮件数；添加 → 白名单发件人 → feed(platform='mail')
 *  5 刷新：3 封命中 2 封 → 2 条目；MESSAGE-ID 幂等（重置游标全窗二刷零新增）；
 *    上次同步增量（新增 1 封 → SEARCH 窗口收窄、只 FETCH 1 封）
 *  6 阅读正文消毒：恶意 HTML（script/iframe/onerror）被剥；reader 载荷 needsExtraction=false
 *  7 密码 DPAPI（CredentialStore 写/读/删）
 *  8 断线恢复：服务端中途断开 → 明确错误；下次刷新可恢复
 *  9 并发：单账户单连接（峰值=1）+ 双账户并行（全局峰值=2）
 * 10 刷新耗时（3 邮件 <2s）+ 普通 RSS 源刷新不受影响
 * 附：设置「邮件订阅」分区 UI 冒烟（真 IPC）。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const tls = require('node:tls');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f6-mail-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 170 * 1000).unref();
if (process.env.ROBIN_MAIL_DEBUG) setInterval(() => console.error('HEARTBEAT alive'), 2000);

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

// ── 自签证书（本机生成的 RSA-2048 / CN=localhost / SAN 127.0.0.1，仅探针用）──
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDBjzEsWskUJTbk
+4dZoJl9dSlOplLnBPF0G74qg4jTtdw9QrETGWbmeol1qon1JbmWX97fSxmVuum3
KV+KIcL7kSa8THBxrnHQaavphPvF7106B7CMdPZ225h4vq5JRjjUa5tzGwuaTsLN
IzH+BD4mALdpYabBzDsESiIRVhJ088d6zGbaU1OS/iNDjMc/qNGmrJ0EwfxplGK7
w4lNd0cGy8vQ95TN9LW0fIsyJ++yAVUNCWGHwCcjFqjWclsLBqdD3Rfue61ZPZk0
83rVywF0w9O5i1FZ5Au3KRB2Ai1hbghEoVaAyVNIBi+/VYc/ac6R4eknLigat2/K
wxa3pkGxAgMBAAECggEAWxiFUBa6JB0PpN0samZHVuBZPIbS5Z9R9A9KhL+7Gcix
irNkm1SNNVPedd55Z0MGAVvFjNnPhMSfUnDKYjxZhARgcqaXFSnArxHMsu6/f/yT
p8gOs0wo4u+e5tT3Oc0u2ep7EsVbxJfk3p793Esq5L/ZkmM/FF6GOBKbzgTwUtHF
nz6gMPqy2RlAykTSfepbEBqjY5Q5QGsnhhG93UDHI01Ukp8Zer8FZ7GL8GRwF/Zx
gNrs9wbWzXC5Q3lVTnNAy3hILN3PQ5lFR1kNAqFEX2uXNmDNuEY61Bk53XSf7uB4
vR8DtLkUpaXHj22cLVzT1/VmIkCdE+8O0C7K94vmMQKBgQD8AIukV+Xk7RFsDiBG
8HDriFDN+WdY2Lje8s+9CHG1huWWcYhYHHzJ9kUYcvpf14yOszidhRzkAHUXNKXJ
ElJzv3HvrRv/b144WJaOoHKRgrtYpoiptgppaHJv3/ZAMpFONx1GOiMl5rghNu+C
kcOdXthZWQX/8YqJUJg+tiQH8wKBgQDEoUsW58tSQ6/g+jdPQFaIpF7EiPNIVCpu
GHzHZcz+U4qDU0DKVuWCtgZqdszhpzVil7qKSy4Nrpp5mBVWLmpwSFohAiVQWJ7/
YeePYr5ElNfJ6ARhYZ4udKjmUM4qCqNtjF9fF+XgGkV7N6XlpT3Nscg1RgzOYqRt
o1I5qK08ywKBgDuP3XGQnPPI3K9Pf22E8wuYgpDMfBLR1pBLj7I8RrQDGEzAtNsu
kIgjvx0SP/9bMQuhbKY+ih+RxBsiBHVL8VUOUN23asCrD/f9aEh5v9qIrcM8SVzj
e/6CA1pR8yAlU5bLDA5HO3t/1tFy7JVN4pBVlIk5s2NVMctW00UvQ8DlAoGAEkx8
Y3ZQ2qgH7yT6DrsLEo5Rb3LbSSjkBfjra9cSe7ykkFIoHmx10XNFJ5VEvd9EvZcn
OgWDFKziHVzE549MQoTJNncvp8mHina/CP4EfPdpGZYpCjL+eI5MxZpRhWIWEXTV
z1C3COMJAk2Md9Gn7cOUwThyqqZNbRKc7VbAQH8CgYBmWd2DrXb9/rCzbFAmkhI5
sT6tfvPUxGT8j4G/cZmFSOh53K7/O3XVKav1W1HhQEp4ZCXa+X3/Sn3Kfwouwx52
5VkCvX1IhZSKtwUDGqzdyXwGBIqFW/bQWPC3tdenbAJq146T3k41gOdKHWEv/lAB
wL2SiF2baD8Zv5UYtSKimA==
-----END PRIVATE KEY-----`;
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUQ9e63MoWLv48/Im9NVxRbgIpTaQwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAwNzEzMDkyNloXDTM2MTAw
NDEzMDkyNlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAwY8xLFrJFCU25PuHWaCZfXUpTqZS5wTxdBu+KoOI07Xc
PUKxExlm5nqJdaqJ9SW5ll/e30sZlbrptylfiiHC+5EmvExwca5x0Gmr6YT7xe9d
OgewjHT2dtuYeL6uSUY41GubcxsLmk7CzSMx/gQ+JgC3aWGmwcw7BEoiEVYSdPPH
esxm2lNTkv4jQ4zHP6jRpqydBMH8aZRiu8OJTXdHBsvL0PeUzfS1tHyLMifvsgFV
DQlhh8AnIxao1nJbCwanQ90X7nutWT2ZNPN61csBdMPTuYtRWeQLtykQdgItYW4I
RKFWgMlTSAYvv1WHP2nOkeHpJy4oGrdvysMWt6ZBsQIDAQABo28wbTAdBgNVHQ4E
FgQUn1BPD1IpHaesiv6hOP5wdqHaqGUwHwYDVR0jBBgwFoAUn1BPD1IpHaesiv6h
OP5wdqHaqGUwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAGmBCHygG1oNygE2s1wW3zMqaCvQJ8un
s6qadBJz5jwckWXIWU2q/GuXs6z+cynPgddhAjDV4M4s9UbO+2/o14qLDOZy95KJ
/1yTS+X3VDYmeqcYYDhTvVlGmq2oN4ERSfXmDfkRzhgp+ezE8utkK0HxnprICq50
n9doI26B5FAjTgefeqI7h1m1OZvMDYd4R5b7CnGh49VKSkkfiteY2+qF5be+Kvgk
rAgUTrov5U9yljR2NomIXQfnrgpmfYul7i6//uSZ7eYjNQgwDamb50kZ9SPD3Zrj
sw3n/Gw3LhUwsZsHV8JCL5GrLfjslQWC3OXMtLD3I7v6tPQQ9Ey+dzY=
-----END CERTIFICATE-----`;

// ── mock 信箱数据 ──
const N = () => Math.floor(Date.now() / 1000);
const USER = 'probe@test';
const PASS = 'secret-pw';
const SENDER_A = 'reporter@example.com';
const SENDER_B = 'second@example.com';
const T_OLD1 = N() - 3 * 86400 - 7200;  // 首刷命中（3 天前，超出增量重叠窗）
const T_OLD2 = N() - 3 * 86400 - 3600;

/** RFC 2822 日期（本地时间 +0800 偏移写成 +0000 亦可，V8 都能解析；统一用 UTC）。 */
function rfcDate(seconds) {
  return new Date(seconds * 1000).toUTCString().replace(/GMT$/, '+0000');
}

// 邮件 1：B 编码中文主题 + quoted-printable 正文 + 恶意 HTML（消毒断言用）
// 正文按 RFC 2045 全量 QP 编码（非 ASCII 必须为 =XX 转义）
const MAIL1_BODY = [
  'Content-Type: text/html; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<div style=3D"font-family:x"><h1>=E6=AF=8F=E5=91=A8=E6=8A=80=E6=9C=AF=E7=B2=BE=E9=80=89</h1>',
  '<script>alert(1)</script>',
  '<iframe src=3D"https://evil.example/frame"></iframe>',
  '<img src=3D"https://cdn.example/pic.png" onerror=3D"steal()">',
  '<p>=E6=9C=AC=E6=9C=9F=E8=81=8A=E8=81=8A=E6=B5=8F=E8=A7=88=E5=99=A8=E5=BC=95=E6=93=8E=E7=9A=84=E6=BC=94=E8=BF=9B=E3=80=82</p>',
  '<a href=3D"https://ok.example/article">=E9=98=85=E8=AF=BB=E5=8E=9F=E6=96=87</a>',
  '</div>',
].join('\r\n');
const MAIL1 = {
  from: ` weekly@reporter <${SENDER_A}>`,
  subject: `=?utf-8?B?${Buffer.from('每周技术精选 · 第 42 期', 'utf8').toString('base64')}?=`,
  date: T_OLD1,
  messageID: '<mail-1@example.com>',
  internalDate: T_OLD1,
  body: MAIL1_BODY,
};

// 邮件 2：multipart/alternative（plain + html，取 plain）+ base64 正文
const MAIL2_PLAIN = '纯文本版本的第二封邮件：newsletter body two。';
const MAIL2_HTML = '<p>HTML 版本第二封（应被忽略）</p>';
const MAIL2 = {
  from: `${SENDER_A}`,
  subject: 'Plain second mail',
  date: T_OLD2,
  messageID: '<mail-2@example.com>',
  internalDate: T_OLD2,
  body: [
    'Content-Type: multipart/alternative; boundary="BB2"',
    '',
    '--BB2',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(MAIL2_PLAIN, 'utf8').toString('base64'),
    '--BB2',
    'Content-Type: text/html; charset=utf-8',
    '',
    MAIL2_HTML,
    '--BB2--',
  ].join('\r\n'),
};

// 邮件 3：不在白名单的发件人
const MAIL3 = {
  from: `spam <nobody@other.org>`,
  subject: 'Not whitelisted',
  date: N() - 3600,
  messageID: '<mail-3@other.org>',
  internalDate: N() - 3600,
  body: ['Content-Type: text/plain; charset=utf-8', '', 'should never be fetched'].join('\r\n'),
};

const mailbox = [MAIL1, MAIL2, MAIL3];

// ── mock IMAPS 服务器（已迁入 mail worker：见 src/main/workers/mail-worker.js 'mock' 协议）──
// 探针侧只保留 helper：启动（传证书+夹具）/运行时控制（delay/drop/reset/push）/读数。
let MAIL = null; // whenReady 内赋值（store.mail）
const mockDelay = (ms) => MAIL._workerRequest({ type: 'mock', op: 'delay', delayMs: ms, toShared: true });
const mockDrop = (on) => MAIL._workerRequest({ type: 'mock', op: 'drop', on, toShared: true });
const mockReset = () => MAIL._workerRequest({ type: 'mock', op: 'reset', toShared: true });
const mockPush = (message) => MAIL._workerRequest({ type: 'mock', op: 'push', message, toShared: true });
const mockStats = async () => (await MAIL._workerRequest({ type: 'mock', op: 'stats', toShared: true })).stats;

app.whenReady().then(async () => {
  let mockPort = null;
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { ImapClient, MailError } = require('../src/main/Mail/ImapClient');
    const MimeParser = require('../src/main/Mail/MimeParser');
    const { MIGRATIONS, runMigrations } = require('../src/main/Persistence/DatabaseMigrations');
    const { LibraryDatabase } = require('../src/main/Persistence/LibraryDatabase');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { useNetFetch } = require('../src/main/FeedService');

    // ── 3. MIME 解析（纯函数单测，先于建库）──
    {
      const bSub = `=?utf-8?B?${Buffer.from('每周精选：第 42 期', 'utf8').toString('base64')}?=`;
      ok(MimeParser.decodeHeaderValue(bSub) === '每周精选：第 42 期', '3 B 编码中文主题解码');
      const qSub = '=?utf-8?Q?Hello_=E4=B8=96=E7=95=8C?= =?utf-8?Q?_Part2?= tail';
      ok(MimeParser.decodeHeaderValue(qSub) === 'Hello 世界 Part2 tail', '3 Q 编码 + 相邻编码字拼接（编码内 _ = 空格）');
      const qp = 'Hello=2C=20=E4=B8=96=E7=95=8C=\r\nnext';
      ok(MimeParser.decodeBuffer(MimeParser.qpDecodeBytes(qp), 'utf-8') === 'Hello, 世界next', '3 quoted-printable 正文解码（含软换行）');
      const b64Body = Buffer.from('纯 base64 正文', 'utf8').toString('base64');
      ok(MimeParser.decodeBuffer(MimeParser.decodeTransfer(b64Body, 'base64'), 'utf-8') === '纯 base64 正文', '3 base64 正文解码');
      ok(MimeParser.decodeBuffer(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'gbk') === '中文', '3 charset=gbk 解码');
      ok(MimeParser.decodeBuffer(Buffer.from('fallback', 'utf8'), 'x-nonexistent-charset') === 'fallback', '3 不支持 charset 降级 utf-8（不抛错）');
      const msg = [
        'Subject: s', 'From: a@b.c', 'Message-ID: <x@y>', 'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary=BB', '', '--BB',
        'Content-Type: text/plain; charset=utf-8', '', 'plain wins', '--BB',
        'Content-Type: text/html; charset=utf-8', '', '<p>html part</p>', '--BB--',
      ].join('\r\n');
      const cut = msg.indexOf('\r\n\r\n');
      const parsed = MimeParser.parseMessage(msg.slice(0, cut), msg.slice(cut + 4));
      ok(parsed.html === '<p>plain wins</p>' && parsed.text === 'plain wins', '3 multipart 取 text/plain 优先');
      const htmlOnly = [
        'Subject: s', 'From: a@b.c', 'Message-ID: <x@y>',
        'Content-Type: text/html; charset=utf-8', '', '<p>only <b>html</b></p>',
      ].join('\r\n');
      const cutH = htmlOnly.indexOf('\r\n\r\n');
      const parsedH = MimeParser.parseMessage(htmlOnly.slice(0, cutH), htmlOnly.slice(cutH + 4));
      ok(parsedH.html === '<p>only <b>html</b></p>' && parsedH.text === 'only html', '3 纯 html 邮件兜底 + 摘要剥取');
      const fromP = MimeParser.parseFrom(`=?utf-8?B?${Buffer.from('张三', 'utf8').toString('base64')}?= <zhang@ex.com>`);
      ok(fromP.name === '张三' && fromP.address === 'zhang@ex.com', '3 From 显示名解码 + 地址提取');
    }

    // ── 1. v16 迁移 + 密码不落库 ──
    const store = new AppStore(userData);
    MAIL = store.mail;
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v16-mail-accounts'").get(), '1 v16 迁移已入链');
    const mailCols = store.database.prepare('PRAGMA table_info(mail_accounts)').all().map((r) => r.name);
    ok(mailCols.includes('password_ref') && !mailCols.includes('password') && !mailCols.includes('password_plain'),
      '1 mail_accounts 有 password_ref、无明文密码列');
    {
      const v16 = MIGRATIONS.find((m) => m.id === 'v16-mail-accounts');
      try { v16.up(store.database); ok(true, '1 v16 up() 重放幂等'); } catch (e) { ok(false, '1 v16 up() 重放幂等 — ' + e.message); }
      // 老库（v15 形态）升级无损
      const legacy = new LibraryDatabase(path.join(userData, 'legacy-f6.db'));
      legacy.exec("INSERT INTO accounts (id, type, display_name, is_enabled, created_at, updated_at) VALUES ('local-default','local','本地',1,1,1)");
      legacy.exec("INSERT INTO feeds (id, account_id, title, feed_url, updated_at) VALUES ('lf1','local-default','老库订阅','https://legacy.test/feed.xml',1)");
      legacy.exec('DROP TABLE mail_accounts');
      legacy.exec("DELETE FROM schema_migrations WHERE id = 'v16-mail-accounts'");
      runMigrations(legacy.db);
      const restored = legacy.db.prepare('SELECT title FROM feeds WHERE id = ?').get('lf1');
      const legacyMailCols = legacy.db.prepare('PRAGMA table_info(mail_accounts)').all().map((r) => r.name);
      ok(legacyMailCols.includes('password_ref') && restored && restored.title === '老库订阅', '1 老库（v15 形态）升级无损');
      legacy.close();
    }

    await new Promise((r) => setTimeout(r, 3000)); // BISECT: let extractor prewarm fork settle
    // ── 2. IMAP 客户端直连 mock（mock 运行在 mail worker 内——主进程楔死规避架构的实测通路）──
    {
      const started = await store.mail._workerRequest({
        type: 'mock', op: 'start', key: TLS_KEY, cert: TLS_CERT, keepAlive: true,
        options: { delayMs: 0, user: USER, pass: PASS, mailbox },
      });
      mockPort = started.port;
      ok(Number(mockPort) > 0, '2 worker 内 mock IMAPS 启动（真 TLS）');
      const client = new ImapClient({ host: '127.0.0.1', port: mockPort, username: USER, password: PASS, allowSelfSigned: true });
      await client.connect();
      await client.login();
      const sel = await client.selectInbox();
      ok(sel.exists === mailbox.length, `2 SELECT INBOX（exists=${sel.exists}）`);
      const since = N() - 10 * 86400;
      const seqs = await client.searchMessages({ sinceSeconds: since, from: SENDER_A });
      ok(seqs.length === 2 && seqs[0] === 1 && seqs[1] === 2, `2 SEARCH SINCE+FROM（${seqs.join(',')}）`);
      const fetched = await client.fetchMessage(seqs[0]);
      ok(/Subject: =\?utf-8\?B\?/.test(fetched.headerText) && /Message-ID: <mail-1@example\.com>/.test(fetched.headerText),
        '2 FETCH 头 literal 解析（Subject/Message-ID 完整）');
      ok(fetched.bodyText.includes('<iframe src=3D"https://evil.example/frame">'), '2 FETCH 正文 literal 完整（QP 编码原样）');
      await client.noop();
      await client.logout();
      // 认证失败 → auth 分类
      const badClient = new ImapClient({ host: '127.0.0.1', port: mockPort, username: USER, password: 'wrong', allowSelfSigned: true });
      let authErr = null;
      try { await badClient.connect(); await badClient.login(); } catch (e) { authErr = e; }
      ok(authErr instanceof MailError && authErr.kind === 'auth', `2 认证失败 → kind=auth（${authErr && authErr.kind}）`);
      try { await badClient.logout(); } catch (_) { /* 已断 */ }
      // 网络不可达 → network 分类（连已关闭端口）
      const dead = tls.createServer({ key: TLS_KEY, cert: TLS_CERT }, () => {});
      await new Promise((r) => dead.listen(0, '127.0.0.1', r));
      const deadPort = dead.address().port;
      await new Promise((r) => dead.close(r));
      const netClient = new ImapClient({ host: '127.0.0.1', port: deadPort, username: USER, password: PASS, allowSelfSigned: true });
      let netErr = null;
      try { await netClient.connect(); } catch (e) { netErr = e; }
      ok(netErr instanceof MailError && netErr.kind === 'network', `2 网络不可达 → kind=network（${netErr && netErr.kind}）`);
    }

    // ── 4. 添加账户端到端（测试连接 → 建账户 → 白名单 → feed）──
    {
      const test = await store.mail.testConnection({
        host: '127.0.0.1', port: mockPort, username: USER, password: PASS, allowSelfSigned: true,
      });
      ok(test && typeof test.elapsedMs === 'number' && test.messageCount === mailbox.length,
        `4 测试连接 OK（count=${test.messageCount}，${test.elapsedMs}ms）`);
    }
    const account = store.mail.addAccount({
      host: '127.0.0.1', port: mockPort, username: USER, password: PASS, allowSelfSigned: true,
    });
    ok(!!account && account.enabled === true, '4 添加账户（enabled 默认开）');
    {
      const row = store.database.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(account.id);
      ok(row.password_ref === `mail-password-${account.id}` && !JSON.stringify(row).includes(PASS),
        '4 密码不落库：password_ref 指向凭据 key、行值无明文');
    }
    const mailFeed = store.mail.addSender({ accountID: account.id, sender: SENDER_A });
    ok(mailFeed.platform === 'mail' && mailFeed.platformRef === SENDER_A
      && mailFeed.feedURL === `mail://${account.id}/${SENDER_A}`,
      `4 白名单发件人 → feed（platform=mail，feedURL=${mailFeed.feedURL}）`);
    let dupSenderErr = null;
    try { store.mail.addSender({ accountID: account.id, sender: SENDER_A }); } catch (e) { dupSenderErr = e; }
    ok(dupSenderErr && /这个订阅已经存在/.test(dupSenderErr.message), '4 重复发件人被拒');
    let badSenderErr = null;
    try { store.mail.addSender({ accountID: account.id, sender: 'not an address' }); } catch (e) { badSenderErr = e; }
    ok(badSenderErr && /发件人格式不正确/.test(badSenderErr.message), '4 非法发件人格式被拒');

    // ── 5. 刷新：2 封命中 → 2 条目；MESSAGE-ID 幂等；增量 ──
    const t0 = process.hrtime.bigint();
    const refresh1 = await store.refreshFeed(mailFeed.id);
    const ms1 = Number(process.hrtime.bigint() - t0) / 1e6;
    ok(refresh1.newEntries === 2, `5 首刷 3 封命中 2 封 → 2 条目（${refresh1.newEntries}）`);
    ok(ms1 < 2000, `10 刷新耗时 ${ms1.toFixed(0)}ms < 2000ms（3 邮件）`);
    {
      const rows = store.listItems({ kind: 'feed', feedID: mailFeed.id }, { limit: 50 });
      ok(rows.length === 2 && rows.every((r) => r.sourceTitle === SENDER_A), `5 列表可见 2 行且来源=发件人（${rows.map((r) => r.sourceTitle).join('|')}）`);
      const titles = rows.map((r) => r.title).join('|');
      ok(/每周技术精选 · 第 42 期/.test(titles) && /Plain second mail/.test(titles), `5 B 编码中文主题解码入库（${titles}）`);
    }
    // MESSAGE-ID 幂等：重置增量游标为空（回到 30 天首刷窗）再刷 → 全窗重搜但零新增
    store.database.prepare('UPDATE mail_accounts SET last_sync = NULL WHERE id = ?').run(account.id);
    store.database.prepare('UPDATE feeds SET last_refreshed_at = NULL WHERE id = ?').run(mailFeed.id); // feed 级游标一并归零（F6 验证：新发件人首刷窗按 feed 游标）
    await mockReset();
    const refreshIdem = await store.refreshFeed(mailFeed.id);
    const stIdem = await mockStats();
    ok(refreshIdem.newEntries === 0 && stIdem.fetchCount === 2,
      `5 MESSAGE-ID 幂等（全窗二刷 0 新增，FETCH=${stIdem.fetchCount} 全被跳过）`);
    // 增量：上次同步后新增 1 封 → SEARCH 窗口收窄，只 FETCH 1 封
    {
      const lastSyncBefore = store.database.prepare('SELECT last_sync FROM mail_accounts WHERE id = ?').get(account.id).last_sync;
      ok(Number.isFinite(lastSyncBefore) && lastSyncBefore > 0, '5 成功刷新推进 last_sync 游标');
      const T_NEW = N() - 600;
      await mockPush({
        from: ` digest <${SENDER_A}>`,
        subject: 'Increment third mail',
        date: T_NEW,
        messageID: '<mail-4@example.com>',
        internalDate: T_NEW,
        body: ['Content-Type: text/plain; charset=utf-8', '', '增量第三封。'].join('\r\n'),
      });
      await mockReset();
      const refresh2 = await store.refreshFeed(mailFeed.id);
      ok(refresh2.newEntries === 1, `5 增量刷新新增 1 条（${refresh2.newEntries}）`);
      const stInc = await mockStats();
      ok(stInc.fetchCount === 1, `5 增量只 FETCH 1 封（fetchCount=${stInc.fetchCount}）`);
      const sinceSeen = stInc.searchLog[0]?.since;
      ok(!!sinceSeen, `5 SEARCH SINCE 记录（${sinceSeen}）`);
      const rows = store.listItems({ kind: 'feed', feedID: mailFeed.id }, { limit: 50 });
      ok(rows.length === 3 && rows.some((r) => r.title === 'Increment third mail'), `5 增量条目入库（共 ${rows.length} 行）`);
    }

    // ── 6. 阅读正文消毒 + reader 载荷 ──
    {
      const rows = store.listItems({ kind: 'feed', feedID: mailFeed.id }, { limit: 50 });
      const target = rows.find((r) => /第 42 期/.test(r.title || ''));
      const payload = store.readerArticle(target.id);
      const html = payload.content?.html || '';
      ok(!/<script/i.test(html) && !/onerror/i.test(html) && !/<iframe/i.test(html),
        '6 恶意 HTML 被消毒（无 script/onerror/iframe）');
      ok(html.includes('<a href="https://ok.example/article"'), '6 正文超链接存活（邮件里的链接可跳转）');
      ok(payload.content.needsExtraction === false, '6 邮件条目不进全文提取（isPlatformFeed 覆盖 mail）');
      ok(payload.entry && payload.entry.id === target.id, '6 reader 载荷可打开（entry 完整）');
    }

    // ── 7. 密码 DPAPI（CredentialStore 写/读/删）──
    {
      const readBack = store.credentials.mailPassword(account.id);
      ok(readBack === PASS, '7 CredentialStore 写入/读取（DPAPI）');
      store.credentials.setMailPassword(account.id, 'rotated-pw');
      ok(store.credentials.mailPassword(account.id) === 'rotated-pw', '7 密码可轮换');
      store.credentials.setMailPassword(account.id, PASS); // 还原供后续用例
    }

    // ── 8. 断线恢复 ──
    {
      await mockDrop(true);
      let dropErr = null;
      try { await store.refreshFeed(mailFeed.id); } catch (e) { dropErr = e; }
      ok(dropErr instanceof MailError && dropErr.kind === 'network',
        `8 服务端中途断开 → 明确错误（kind=${dropErr && dropErr.kind}）`);
      await mockDrop(false);
      const recovery = await store.refreshFeed(mailFeed.id);
      ok(recovery && recovery.newEntries === 0, '8 下次刷新恢复（正常会话）');
    }

    // ── 9. 多账户并行 ≤2 + 单账户单连接 ──
    {
      const accountB = store.mail.addAccount({
        host: '127.0.0.1', port: mockPort, username: USER, password: PASS, allowSelfSigned: true,
      });
      const feedB = store.mail.addSender({ accountID: accountB.id, sender: SENDER_B });
      await mockPush({
        from: `${SENDER_B}`,
        subject: 'Second account mail',
        date: N() - 600,
        messageID: '<mail-b@second>',
        internalDate: N() - 600,
        body: ['Content-Type: text/plain; charset=utf-8', '', '第二个账户的邮件。'].join('\r\n'),
      });
      await mockDelay(150); // 放慢会话：两个刷新必然并行重叠
      const feedARowsBefore = store.listItems({ kind: 'feed', feedID: mailFeed.id }, { limit: 50 }).length;
      void feedARowsBefore;
      const [ra, rb] = await Promise.all([
        store.refreshFeed(mailFeed.id),
        store.refreshFeed(feedB.id),
      ]);
      await mockDelay(0);
      ok(ra && rb && rb.newEntries === 1, `9 双账户并行刷新成功（B 新增 ${rb.newEntries}）`);
      ok(store.mail.counters.maxActiveAccounts <= 2, `9 全局并行账户 ≤2（max=${store.mail.counters.maxActiveAccounts}）`);
      ok(store.mail.counters.maxPerAccount[account.id] === 1 && store.mail.counters.maxPerAccount[accountB.id] === 1,
        `9 单账户连接峰值=1（A=${store.mail.counters.maxPerAccount[account.id]}，B=${store.mail.counters.maxPerAccount[accountB.id]}）`);
      // 同账户并发触发：同 feed 连刷两次也只允许 1 条连接串行
      console.log('MARK 9c triple-refresh start');
      await mockDelay(100);
      await Promise.all([store.refreshFeed(feedB.id), store.refreshFeed(feedB.id), store.refreshFeed(feedB.id)]);
      await mockDelay(0);
      console.log('MARK 9c triple-refresh done');
      ok(store.mail.counters.maxPerAccount[accountB.id] === 1, '9 同账户并发刷新仍单连接（串行化）');
      // 清理 B 账户：白名单 feed + 凭据一并删除
      console.log('MARK 9d delete account');
      const removed = store.mail.deleteAccount(accountB.id);
      const feedsLeft = store.database.prepare(
        "SELECT COUNT(*) AS n FROM feeds WHERE account_id = ? AND platform = 'mail' AND feed_url LIKE ?",
      ).get(LOCAL_ACCOUNT_ID, `mail://${accountB.id}/%`).n;
      const credGone = store.credentials.mailPassword(accountB.id) === null;
      const rowGone = store.mail.account(accountB.id) === null;
      ok(removed.removed === true && feedsLeft === 0 && credGone && rowGone, '9 删除账户：feed/凭据/行全清（DPAPI 删除验证）');
    }

    // ── 10. 普通源不受影响（RSS mock 经 useNetFetch）──
    console.log('MARK 10 rss');
    {
      const RSS_XML = `<?xml version="1.0"?><rss version="2.0"><channel><title>F6 回归周刊</title><link>https://rss.test</link>
<item><title>普通源文章</title><link>https://rss.test/a1</link><pubDate>${new Date(Date.now() - 3600 * 1000).toUTCString()}</pubDate><description>普通源正文。</description></item>
</channel></rss>`;
      useNetFetch(async (url) => {
        if (url.startsWith('https://rss.test/')) {
          return new Response(RSS_XML, { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
        }
        throw new Error('mock net: unexpected URL ' + url);
      });
      const rssFeed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F6 回归周刊', feedURL: 'https://rss.test/feed.xml' });
      const rssRefresh = await store.refreshFeed(rssFeed.id);
      ok(rssRefresh.newEntries === 1, '10 普通 RSS 源刷新不受影响（1 条入库）');
    }

    // ── 附：设置「邮件订阅」分区 UI 冒烟（真 IPC）──
    console.log('MARK ui-probe start');
    ok(store.mail.listAccounts().length >= 1, 'UI 前置：主进程 listAccounts 有数据');
    await mailSettingsUIProbe(store);
    console.log('MARK ui-probe done');

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  } finally {
    try { mock?.server.close(); } catch (_) { /* 退出即清 */ }
  }
});

/** 附：设置分区 + 添加邮箱对话框（真 IPC + 隐藏窗口）。 */
async function mailSettingsUIProbe(store) {
  const { BrowserWindow } = require('electron');
  const { registerIPCHandlers } = require('../src/main/ipc');
  const win = new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
  });
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 900));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 8000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); }
    };
    try {
      const { SettingsView, showAddMailAccount } = await import('./views/dialogs.js');
      const view = new SettingsView({
        state: {},
        views: {},
        onAddFreshRSS: () => {},
        onReload: () => {},
        onRefreshState: () => {},
      });
      view.present('mail');
      const navOk = [...document.querySelectorAll('.modal-nav-item')].some((el) => el.textContent.includes('邮件订阅'));
      await waitFor(() => (document.querySelector('.modal-scroll')?.textContent || '').includes('probe@test') ? true : null, 8000);
      const bodyText = document.querySelector('.modal-scroll')?.textContent || '';
      const hasMailbox = bodyText.includes('probe@test');
      const hasWhitelistHead = bodyText.includes('发件人白名单');
      view.dismiss();
      // 添加邮箱对话框字段
      showAddMailAccount(() => {});
      const hostInput = await waitFor(() => [...document.querySelectorAll('.modal.small input.control')]
        .find((el) => /imap\\./.test(el.placeholder || '')));
      const testBtn = [...document.querySelectorAll('.modal.small .modal-footer button')].find((b) => b.textContent === '测试连接');
      const addBtn = [...document.querySelectorAll('.modal.small .modal-footer button')].find((b) => b.textContent === '添加');
      document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
      // IPC：账户与白名单查询（主侧数据经真通道）
      const accounts = await window.robin.mailAccounts();
      const senders = accounts && accounts.length ? await window.robin.mailSenders(accounts[0].id) : [];
      return { navOk, hasMailbox, hasWhitelistHead, hostRendered: !!hostInput, testBtn: !!testBtn, addBtn: !!addBtn, ipcAccounts: (accounts || []).length, ipcSenders: (senders || []).length };
    } catch (e) { return { __err: String(e && e.stack || e) }; }
  })()`);
  if (result.__err) { ok(false, 'UI 探针异常 — ' + result.__err); return; }
  ok(result.navOk, 'UI 设置导航含「邮件订阅」分区');
  ok(result.hasMailbox && result.hasWhitelistHead, 'UI 账户卡片 + 白名单列表渲染');
  ok(result.hostRendered && result.testBtn && result.addBtn, 'UI 添加邮箱对话框字段与按钮齐全');
  ok(result.ipcAccounts >= 1 && result.ipcSenders >= 1, `UI 真 IPC 查询（accounts=${result.ipcAccounts}，senders=${result.ipcSenders}）`);
  win.destroy();
}
