'use strict';
/**
 * diag-f7-sync.js — F7 WebDAV 多设备同步端到端探针（run-all OFFLINE 集，全程离线）
 *
 * 网络：本地 node:http 假 WebDAV 服务器（最小内存文件系统：PROPFIND/GET/PUT/MKCOL/MOVE
 * + Basic Auth + ETag/If-Match），客户端走真实 WebDAVClient（无注入短路）。覆盖（对应 F7 探针 10 条）：
 *  1 WebDAV 客户端：PROPFIND 存在/不存在、GET 404/200、PUT 上行内容一致、MKCOL、MOVE、
 *    401 认证分类、412 冲突分类、超时分类、GET >8MB 响应护栏（tooLarge）
 *  2 快照序列化/解析 roundtrip + 8MB 护栏 + annotations 5000 截断 + progress 截断
 *    + 删除墓碑 roundtrip（deletedFeedIDs）+ 旧快照无墓碑字段兼容
 *  3 合并幂等：同快照合并两次零 diff；双端各自新增 feeds/annotations → 并集正确；
 *    progress 新者胜；prefs 新者胜；墓碑排除远端订阅（删除不复活）；重订阅（updatedAt 更新）胜过墓碑
 *  4 端到端（假 DAV）：设备 A 上传 → 设备 B（空库+另一 deviceId）下载合并 → B 得到 A 的
 *    订阅/批注/偏好/进度；B 新增批注 → 同步回 A → A 得到
 *  5 本地优先红线：远端独有批注被合并进来；本地独有数据永不被删；重复同步零新增（幂等）
 *  5b 删除墓碑端到端：A 软删订阅 → 上行墓碑 → B 同步后同源订阅被软删（不再复活）；
 *     B 重订阅 → 墓碑失效，A 复活且无重复行
 *  6 自动同步触发：kick 节流（<10 分钟抑制 / 归零后放行 / 关闭后抑制）+ 手动立即同步
 *  7 凭据 DPAPI 存取 + 断开清除
 *  8 冲突路径：远端 updatedAt 更新（他机写入）→ GET 合并不上传（远端文件未被改写）
 *  9 UI：设置「同步」分区渲染（服务器/开关/按钮/最后同步时间）+ 命令面板入口
 * 10 刷新主路径耗时不受同步影响（同步异步执行，kick 即返）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f7-sync-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 170 * 1000).unref();

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

// ── 假 WebDAV 服务器（最小内存文件系统）──
const USER = 'probe@test';
const PASS = 'secret-pw';

function createFakeDAV({ username = USER, password = PASS, delayMs = 0 } = {}) {
  const files = new Map(); // pathname → Buffer
  const dirs = new Set(['/']);
  const log = [];
  const etagOf = (buf) => `"${crypto.createHash('md5').update(buf).digest('hex')}"`;
  const norm = (p) => {
    let out = decodeURIComponent(p || '/');
    if (!out.startsWith('/')) out = '/' + out;
    if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
    return out;
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => { try { res.destroy(); } catch (_) {} });
    req.on('end', () => {
      const pathname = norm(new URL(req.url, 'http://local').pathname);
      const body = Buffer.concat(chunks);
      const finish = () => {
        const record = { method: req.method, path: pathname, status: 0 };
        const reply = (status, headers = {}, payload = null) => {
          record.status = status;
          log.push(record);
          res.writeHead(status, headers);
          res.end(payload);
        };
        try {
          // 超时专用路径：永不响应（客户端 abort 后静默）
          if (pathname === '/forever') return;
          // Basic Auth
          const auth = String(req.headers.authorization || '');
          const expected = 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
          if (auth !== expected) {
            return reply(401, { 'WWW-Authenticate': 'Basic realm="dav"' });
          }
          if (req.method === 'OPTIONS') return reply(200, { DAV: '1, 2', Allow: 'OPTIONS, GET, PUT, PROPFIND, MKCOL, MOVE, DELETE' });
          const isDir = dirs.has(pathname);
          const isFile = files.has(pathname);
          if (req.method === 'PROPFIND') {
            if (!isDir && !isFile) return reply(404);
            const depth = String(req.headers.depth || '0');
            const hrefs = [pathname];
            if (isDir && depth === '1') {
              for (const p of files.keys()) if (p.startsWith(pathname + '/')) hrefs.push(p);
              for (const p of dirs) if (p.startsWith(pathname + '/')) hrefs.push(p);
            }
            const xml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">` +
              hrefs.map((h) => `<D:response><D:href>${h}</D:href><D:propstat><D:prop/></D:propstat></D:response>`).join('') +
              `</D:multistatus>`;
            return reply(207, { 'Content-Type': 'application/xml; charset=utf-8' }, xml);
          }
          if (req.method === 'GET') {
            if (isFile) return reply(200, { ETag: etagOf(files.get(pathname)), 'Content-Type': 'application/json' }, files.get(pathname));
            return reply(404);
          }
          if (req.method === 'PUT') {
            if (isDir) return reply(409);
            const ifMatch = req.headers['if-match'];
            if (ifMatch && isFile && String(ifMatch) !== etagOf(files.get(pathname))) return reply(412);
            // 父目录缺失时隐式补齐（真实 DAV 会 409，这里宽容以覆盖最小面）
            const parent = pathname.slice(0, pathname.lastIndexOf('/')) || '/';
            dirs.add(parent === '' ? '/' : parent);
            files.set(pathname, body);
            return reply(201, { ETag: etagOf(body) });
          }
          if (req.method === 'MKCOL') {
            if (isDir || isFile) return reply(405);
            const parent = pathname.slice(0, pathname.lastIndexOf('/')) || '/';
            if (!dirs.has(parent)) return reply(409);
            dirs.add(pathname);
            return reply(201);
          }
          if (req.method === 'MOVE') {
            if (!isFile && !isDir) return reply(404);
            try {
              const dest = norm(new URL(String(req.headers.destination || ''), 'http://local').pathname);
              if (dirs.has(dest) || files.has(dest)) {
                if (String(req.headers.overwrite || 'T') !== 'T') return reply(412);
              }
              if (isFile) { files.set(dest, files.get(pathname)); files.delete(pathname); }
              else { dirs.add(dest); dirs.delete(pathname); }
              return reply(201);
            } catch (_) { return reply(400); }
          }
          if (req.method === 'DELETE') {
            if (isFile) { files.delete(pathname); return reply(204); }
            if (isDir) { dirs.delete(pathname); return reply(204); }
            return reply(404);
          }
          return reply(405);
        } catch (err) {
          record.status = 500;
          log.push(record);
          try { res.writeHead(500); res.end(String(err && err.message || err)); } catch (_) {}
        }
      };
      if (delayMs > 0) setTimeout(finish, delayMs);
      else finish();
    });
  });
  return {
    server,
    files,
    dirs,
    log,
    fileText: (p) => (files.has(p) ? files.get(p).toString('utf8') : null),
  };
}

/** 静默关闭（finally 清理用）。 */
function closeServer(server) {
  return new Promise((r) => { try { server.close(() => r()); } catch (_) { r(); } });
}

const N = () => Math.floor(Date.now() / 1000);
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

app.whenReady().then(async () => {
  let dav = null;
  const cleanup = [];
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { WebDAVClient, DAVError, RESPONSE_MAX_BYTES } = require('../src/main/Sync/WebDAVClient');
    const {
      serializeSnapshot, parseSnapshot, mergeSnapshots, SyncError,
      truncateAnnotations, annotationKey, SNAPSHOT_MAX_BYTES, ANNOTATION_LIMIT,
    } = require('../src/main/Sync/merge');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');

    // ══ 1. WebDAV 客户端（直连假 DAV）══
    dav = createFakeDAV();
    await new Promise((r) => dav.server.listen(0, '127.0.0.1', r));
    const port = dav.server.address().port;
    const client = new WebDAVClient({ base: `http://127.0.0.1:${port}/dav`, username: USER, password: PASS, timeoutMs: 5000 });
    {
      const noDir = await client.propfind(client.url('robinread'), 0);
      ok(noDir.exists === false, '1 PROPFIND 不存在 → exists=false');
      await client.mkcol(client.base); // 父目录（自建 DAV 常缺；坚果云 base 一般已存在）
      await client.mkcol(client.url('robinread'));
      const yesDir = await client.propfind(client.url('robinread'), 0);
      ok(yesDir.exists === true, '1 MKCOL 建目录 + PROPFIND 存在');
      const listed = await client.propfind(client.url('robinread'), 1);
      ok(Array.isArray(listed.hrefs) && listed.hrefs.some((h) => h.endsWith('/robinread')), `1 PROPFIND Depth:1 列目录（${listed.hrefs.length} 项）`);
      let get404 = null;
      try { await client.get(client.url('robinread', 'sync.json')); } catch (e) { get404 = e; }
      ok(get404 instanceof DAVError && get404.kind === 'notFound', '1 GET 404 → notFound 分类');
      const putBody = JSON.stringify({ hello: '同步', n: 42 });
      await client.put(client.url('robinread', 'probe-roundtrip.json'), putBody);
      const back = await client.get(client.url('robinread', 'probe-roundtrip.json'));
      ok(back.body.toString('utf8') === putBody, '1 PUT 上行内容一致（GET 读回）');
      await client.put(client.url('robinread', 'probe-move-src.json'), 'move-me');
      await client.move(client.url('robinread', 'probe-move-src.json'), client.url('robinread', 'probe-move-dst.json'));
      const moved = await client.get(client.url('robinread', 'probe-move-dst.json'));
      let srcGone = null;
      try { await client.get(client.url('robinread', 'probe-move-src.json')); } catch (e) { srcGone = e; }
      ok(moved.body.toString('utf8') === 'move-me' && srcGone?.kind === 'notFound', '1 MOVE 原子替换（目标就位、源消失）');
      const badAuth = new WebDAVClient({ base: `http://127.0.0.1:${port}/dav`, username: USER, password: 'wrong', timeoutMs: 5000 });
      let authErr = null;
      try { await badAuth.propfind(client.base, 0); } catch (e) { authErr = e; }
      ok(authErr instanceof DAVError && authErr.kind === 'auth', `1 401 → auth 分类（${authErr && authErr.kind}）`);
      // If-Match 冲突（412 → conflict）
      const et = (await client.get(client.url('robinread', 'probe-roundtrip.json'))).etag;
      let conflictErr = null;
      try { await client.put(client.url('robinread', 'probe-roundtrip.json'), 'x', { ifMatch: '"stale"' }); } catch (e) { conflictErr = e; }
      ok(conflictErr instanceof DAVError && conflictErr.kind === 'conflict' && et, `1 412 If-Match → conflict 分类（etag=${!!et}）`);
      // 超时分类（/forever 永不响应；注意用 slowClient 自己的 base 构造 URL）
      const slowClient = new WebDAVClient({ base: `http://127.0.0.1:${port}`, username: USER, password: PASS, timeoutMs: 400 });
      let timeoutErr = null;
      try { await slowClient.get(slowClient.url('forever')); } catch (e) { timeoutErr = e; }
      ok(timeoutErr instanceof DAVError && timeoutErr.kind === 'timeout', `1 超时 → timeout 分类（${timeoutErr && timeoutErr.kind}）`);
      // P2-6：GET 响应字节护栏（>8MB → tooLarge，中断下载不再整吞内存）
      await client.put(client.url('robinread', 'probe-huge.bin'), 'x'.repeat(RESPONSE_MAX_BYTES + 1024));
      let hugeErr = null;
      try { await client.get(client.url('robinread', 'probe-huge.bin')); } catch (e) { hugeErr = e; }
      ok(hugeErr instanceof DAVError && hugeErr.kind === 'tooLarge', `1 GET >8MB → tooLarge 分类（${hugeErr && hugeErr.kind}）`);
      // 护栏边界内照常可读（8MB 以内小文件）
      await client.put(client.url('robinread', 'probe-ok.bin'), 'y'.repeat(1024));
      const okBody = await client.get(client.url('robinread', 'probe-ok.bin'));
      ok(okBody.body.length === 1024, '1 GET 8MB 以内照常可读');
    }

    // ══ 2. 快照序列化 / 护栏 ══
    {
      const snap = {
        version: 1, deviceId: 'dev-x', updatedAt: 1000,
        feeds: [{ feedURL: 'https://x.test/f.xml', title: 'X', siteURL: null, folder: '科技', platform: 'web', platformRef: null, updatedAt: 900 }],
        prefs: { values: { appTheme: 'dark' }, updatedAt: 800 },
        annotations: [{ entryURL: 'https://x.test/a1', kind: 'highlight', text: '高亮', createdAt: 700, updatedAt: 700 }],
        progress: { 'https://x.test/a1': { pct: 40, at: 900 } },
        tags: { 'https://x.test/a1': [{ t: '科技', s: 'manual' }] },
      };
      const text = serializeSnapshot(snap);
      const parsed = parseSnapshot(text);
      ok(parsed.deviceId === 'dev-x' && parsed.feeds.length === 1 && parsed.prefs.values.appTheme === 'dark'
        && parsed.annotations.length === 1 && parsed.progress['https://x.test/a1'].pct === 40
        && parsed.tags['https://x.test/a1'][0].t === '科技', '2 快照 roundtrip（结构字段全保留）');
      ok(annotationKey(snap.annotations[0]) === annotationKey(parsed.annotations[0]), '2 批注去重键 roundtrip 稳定');
      let invalid = null;
      try { parseSnapshot('{"version":9}'); } catch (e) { invalid = e; }
      ok(invalid instanceof SyncError && invalid.kind === 'invalid', '2 version 不符 → invalid');
      // 8MB 护栏
      const big = { ...snap, annotations: [{ entryURL: 'https://x.test/big', kind: 'note', content: 'x'.repeat(SNAPSHOT_MAX_BYTES), createdAt: 1, updatedAt: 1 }] };
      let tooLarge = null;
      try { serializeSnapshot(big); } catch (e) { tooLarge = e; }
      ok(tooLarge instanceof SyncError && tooLarge.kind === 'tooLarge', '2 单快照 >8MB → tooLarge（拒绝上传）');
      // annotations 5000 截断
      const many = Array.from({ length: ANNOTATION_LIMIT + 100 }, (_, i) => ({
        entryURL: 'https://x.test/a', kind: 'highlight', text: `#${i}`, createdAt: i, updatedAt: i,
      }));
      const kept = truncateAnnotations(many);
      ok(kept.length === ANNOTATION_LIMIT && Math.min(...kept.map((r) => r.createdAt)) === 100, '2 批注 >5000 → 截最旧（保留最新 5000）');
      // P2-2：删除墓碑 roundtrip + 旧快照兼容
      const tombSnap = { ...snap, deletedFeedIDs: [{ feedURL: 'https://x.test/gone.xml', deletedAt: 123 }, 'https://x.test/legacy.xml'] };
      const tombParsed = parseSnapshot(serializeSnapshot(tombSnap));
      ok(Array.isArray(tombParsed.deletedFeedIDs) && tombParsed.deletedFeedIDs.length === 2
        && tombParsed.deletedFeedIDs[0].feedURL === 'https://x.test/gone.xml' && tombParsed.deletedFeedIDs[0].deletedAt === 123
        && tombParsed.deletedFeedIDs[1].deletedAt === 0,
        '2 删除墓碑 roundtrip（对象/旧式字符串混排归一化）');
      const legacyParsed = parseSnapshot(serializeSnapshot(snap)); // snap 无 deletedFeedIDs 字段 = 旧快照
      ok(Array.isArray(legacyParsed.deletedFeedIDs) && legacyParsed.deletedFeedIDs.length === 0, '2 旧快照无墓碑字段 → 兼容（空数组）');
    }

    // ══ 3. 合并纯函数：幂等 + 并集 + 新者胜 ══
    {
      const T = N();
      const local = {
        version: 1, deviceId: 'A', updatedAt: T,
        feeds: [
          { feedURL: 'https://f.test/a.xml', title: 'A 源', siteURL: null, folder: '旧文件夹', platform: 'web', platformRef: null, updatedAt: T },
          { feedURL: 'https://f.test/common.xml', title: '共有源', siteURL: null, folder: null, platform: 'web', platformRef: null, updatedAt: T - 50 },
        ],
        prefs: { values: { appTheme: 'light' }, updatedAt: T },
        annotations: [{ entryURL: 'https://f.test/a1', kind: 'highlight', text: '本地批注', createdAt: T - 10, updatedAt: T - 10 }],
        progress: { 'https://f.test/a1': { pct: 20, at: T - 5 } },
        tags: { 'https://f.test/a1': [{ t: '本地', s: 'manual' }] },
      };
      const remote = {
        version: 1, deviceId: 'B', updatedAt: T + 30,
        feeds: [
          { feedURL: 'https://f.test/b.xml', title: 'B 源', siteURL: null, folder: '新分类', platform: 'weibo', platformRef: 'u1', updatedAt: T + 20 },
          { feedURL: 'https://f.test/common.xml', title: '共有源', siteURL: null, folder: '远端新文件夹', platform: 'web', platformRef: null, updatedAt: T + 10 },
        ],
        prefs: { values: { appTheme: 'dark', articleFontSize: 20 }, updatedAt: T + 30 },
        annotations: [
          { entryURL: 'https://f.test/a1', kind: 'highlight', text: '本地批注', createdAt: T - 10, updatedAt: T - 10 }, // 双端同款（幂等）
          { entryURL: 'https://f.test/b1', kind: 'note', content: '远端批注', createdAt: T - 8, updatedAt: T - 8 },
        ],
        progress: {
          'https://f.test/a1': { pct: 80, at: T + 5 },   // 远端更新 → 胜
          'https://f.test/b1': { pct: 50, at: T + 6 },
        },
        tags: { 'https://f.test/a1': [{ t: '远端', s: 'manual' }] },
      };
      const first = mergeSnapshots(local, remote, { prefsDirtyAt: T });
      const second = mergeSnapshots(first.merged, remote, { prefsDirtyAt: first.merged.prefs.updatedAt });
      ok(deepEqual(first.merged, second.merged), '3 合并幂等：同快照合并两次零 diff');
      const m = first.merged;
      ok(m.feeds.length === 3, `3 feeds 并集（3=${m.feeds.length}）`);
      const common = m.feeds.find((f) => f.feedURL === 'https://f.test/common.xml');
      ok(common.folder === '远端新文件夹', '3 同源 folder 新者胜（远端 updatedAt 更新）');
      const annKeys = new Set(m.annotations.map((a) => `${a.entryURL}|${a.text ?? a.content}`));
      ok(m.annotations.length === 2 && annKeys.has('https://f.test/b1|远端批注') && annKeys.has('https://f.test/a1|本地批注'),
        '3 annotations 并集（双端同款不重复）');
      ok(m.progress['https://f.test/a1'].pct === 80 && m.progress['https://f.test/b1'].pct === 50, '3 progress 新者胜（远端 80 > 本地 20）');
      ok(m.prefs.values.appTheme === 'dark' && m.prefs.values.articleFontSize === 20, '3 prefs 新者胜（远端块更新）');
      // 本地偏好更新 → 本地胜
      const localNewer = mergeSnapshots({ ...local, prefs: { values: { appTheme: 'light' }, updatedAt: T + 60 } }, remote, { prefsDirtyAt: T + 60 });
      ok(localNewer.merged.prefs.values.appTheme === 'light' && localNewer.stats.prefsSource === 'local', '3 prefs 本机更新时本地胜');
      const tagsOf = m.tags['https://f.test/a1'].map((x) => x.t).sort();
      ok(deepEqual(tagsOf, ['本地', '远端']), '3 tags 并集');
      // P2-2：墓碑排除远端订阅（删除不复活）+ 重订阅（updatedAt 晚于墓碑）胜过墓碑
      const tLocal = { ...local, deletedFeedIDs: [{ feedURL: 'https://f.test/b.xml', deletedAt: T + 40 }] }; // 本机删了 B 源（晚于远端记录 T+20）
      const tombMerged = mergeSnapshots(tLocal, remote, { prefsDirtyAt: T });
      ok(!tombMerged.merged.feeds.some((f) => f.feedURL === 'https://f.test/b.xml')
        && tombMerged.merged.deletedFeedIDs.some((t) => t.feedURL === 'https://f.test/b.xml')
        && tombMerged.stats.feedsExcludedByTombstone === 1, '3 墓碑排除远端订阅（删除不复活）');
      const resubRemote = {
        ...remote,
        feeds: remote.feeds.map((f) => (f.feedURL === 'https://f.test/b.xml' ? { ...f, updatedAt: T + 50 } : f)),
      };
      const resubMerged = mergeSnapshots(tLocal, resubRemote, { prefsDirtyAt: T });
      ok(resubMerged.merged.feeds.some((f) => f.feedURL === 'https://f.test/b.xml'), '3 重订阅（updatedAt 晚于墓碑）胜过墓碑');
      // 幂等回归：墓碑版合并两次零 diff
      const tombFirst = mergeSnapshots(tLocal, remote, { prefsDirtyAt: T });
      const tombSecond = mergeSnapshots(tombFirst.merged, remote, { prefsDirtyAt: tombFirst.merged.prefs.updatedAt });
      ok(deepEqual(tombFirst.merged, tombSecond.merged), '3 墓碑合并幂等：两次零 diff');
    }

    // ══ 4–8. 端到端（双设备 + 真 SyncService）══
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f7-devA-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f7-devB-'));
    cleanup.push(dirA, dirB);
    const storeA = new AppStore(dirA);
    await new Promise((r) => setTimeout(r, 1500)); // 等启动自愈批处理落地
    const storeB = new AppStore(dirB);
    // 同目录 preferences.json 由两个实例共享（运行时各自内存值独立）——显式指定不同设备身份
    storeA.preferences.set('RobinRead.sync.deviceId', 'device-A');
    storeB.preferences.set('RobinRead.sync.deviceId', 'device-B');
    const base = `http://127.0.0.1:${port}/dav`;
    storeA.sync.saveConfig({ serverURL: base, username: USER, password: PASS });
    storeB.sync.saveConfig({ serverURL: base, username: USER, password: PASS });

    // ── 7. 凭据 DPAPI 存取 + 断开清除 ──
    {
      ok(storeA.credentials.webDAVPassword() === PASS, '7 CredentialStore 写入/读取（DPAPI）');
      storeA.sync.saveConfig({ password: 'rotated' });
      ok(storeA.credentials.webDAVPassword() === 'rotated', '7 密码可轮换');
      const cfgSave = storeA.sync.saveConfig({}); // 不传密码 = 保留
      ok(cfgSave.hasPassword === true, '7 saveConfig 不传密码保留原值');
      storeA.sync.saveConfig({ password: PASS }); // 还原供后续用例
      const test = await storeA.sync.testConnection();
      ok(test.exists === true && test.elapsedMs >= 0, `7 测试连接（PROPFIND base，exists=${test.exists}）`);
      const cfgA = storeA.sync.getConfig();
      ok(cfgA.serverURL === base && cfgA.username === USER && cfgA.hasPassword && cfgA.autoEnabled === true, '7 getConfig 回显配置');
      // storeB 上演练断开清理
      storeB.credentials.setWebDAVPassword('to-be-cleared');
      storeB.sync.disconnect();
      ok(storeB.credentials.webDAVPassword() === null && storeB.sync.getConfig().serverURL === '' && storeB.sync.getConfig().hasPassword === false,
        '7 断开清除：凭据+配置全清（DPAPI 删除验证）');
      storeB.sync.saveConfig({ serverURL: base, username: USER, password: PASS });
    }

    // ── 设备 A 造数：订阅（带 folder/平台字段）+ 文章 + 批注 + 笔记 + 进度 + 标签 ──
    const feedA = storeA.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'A 的周刊', feedURL: 'https://a.test/feed1.xml' });
    const folderA = storeA.feedsRepo.ensureFolder(LOCAL_ACCOUNT_ID, '科技');
    storeA.feedsRepo.setFeedFolder(feedA.id, folderA.id);
    const entryA1 = storeA.articlesRepo.upsertEntry({
      id: `local:${feedA.id}:a1`, accountID: LOCAL_ACCOUNT_ID, externalID: `local:${feedA.id}:a1`, feedID: feedA.id,
      title: 'A 的文章一', url: 'https://a.test/article-1', publishedAt: N() - 600, summary: '第一篇', contentHTML: '<p>正文一</p>',
    });
    storeA.knowledge.addHighlight({ itemID: entryA1, text: 'A 的高亮', note: 'A 的批注' });
    storeA.knowledge.addNote({ itemID: entryA1, content: 'A 的笔记内容' });
    storeA.knowledge.addManualTag(entryA1, 'AI');
    storeA.sync.reportProgress([{ url: 'https://a.test/article-1', pct: 42, at: N() }]);

    // ── 4a. 设备 A 首次同步（远端空 → 上行）──
    const statA1 = await storeA.sync.syncNow({ origin: 'manual' });
    ok(statA1.direction === 'upload' && statA1.atomic === true, `4 A 首同步上行（direction=${statA1.direction}，MOVE 原子写=${statA1.atomic}）`);
    const raw1 = dav.fileText('/dav/robinread/sync.json');
    ok(!!raw1 && JSON.parse(raw1).deviceId === 'device-A', '4 远端快照就位（deviceId=A）');

    // ── 4b. 设备 B（空库）下载合并 ──
    const statB1 = await storeB.sync.syncNow({ origin: 'manual' });
    ok(statB1.direction === 'merge-download', `4 B 首同步下行合并（direction=${statB1.direction}，本机无新变更不上行）`);
    const feedAinB = storeB.feedsRepo.feedByURL(LOCAL_ACCOUNT_ID, 'https://a.test/feed1.xml');
    ok(!!feedAinB && feedAinB.title === 'A 的周刊', '4 B 得到 A 的订阅');
    {
      const folderID = storeB.database.prepare('SELECT folder_id FROM feed_folders WHERE feed_id = ?').get(feedAinB.id)?.folder_id;
      const folderName = folderID ? storeB.feedsRepo.folder(folderID)?.name : null;
      ok(folderName === '科技', `4 B 订阅带 folder（${folderName}）`);
    }
    // B 空库（同步只传订阅不传文章）→ A 的批注按设计进 pending（本地暂无文章可挂载，绝不丢弃）
    const bPending = JSON.parse(fs.readFileSync(path.join(dirB, 'sync', 'pending-annotations.json'), 'utf8'));
    ok(bPending.some((p) => p.kind === 'highlight' && p.text === 'A 的高亮')
      && bPending.some((p) => p.kind === 'note' && p.content === 'A 的笔记内容'),
      '4 B 得到 A 的批注/笔记（暂存 pending，本地暂无对应文章）');
    const bSnap = storeB.sync.buildLocalSnapshot();
    ok(bSnap.annotations.some((a) => a.text === 'A 的高亮'), '4 pending 批注并入 B 的本地快照（下次上行携带）');
    ok(storeB.sync._progress.get('https://a.test/article-1')?.pct === 42, '4 B 得到 A 的阅读位置');

    // ── 4c. B 本机变更（同 URL 批注 + 偏好 + 新订阅）→ 同步上行 → A 下行得到 ──
    const feedB = storeB.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'B 的日报', feedURL: 'https://b.test/daily.xml' });
    const entryB1 = storeB.articlesRepo.upsertEntry({
      id: `local:${feedB.id}:b1`, accountID: LOCAL_ACCOUNT_ID, externalID: `local:${feedB.id}:b1`, feedID: feedB.id,
      title: 'B 的文章一', url: 'https://a.test/article-1', publishedAt: N() - 300, summary: '同 URL 文章', contentHTML: '<p>正文</p>',
    });
    storeB.knowledge.addHighlight({ itemID: entryB1, text: 'B 的高亮', color: 'green' });
    storeB.setAppTheme('dark'); // 白名单偏好（走 setter → notePrefsChanged）
    await storeB.sync.syncNow({ origin: 'manual' });
    // B 的文章此刻已存在 → 上一次合并进 pending 的 A 批注在本次同步时物化落库
    const bHighlightsNow = storeB.database.prepare('SELECT text FROM highlights').all();
    ok(bHighlightsNow.some((h) => h.text === 'A 的高亮') && bHighlightsNow.some((h) => h.text === 'B 的高亮'),
      '4 B 文章到达后 pending 批注物化（A 的高亮 + B 自己的高亮并存）');
    const bTagsNow = storeB.database.prepare('SELECT tag FROM article_tags').all();
    ok(bTagsNow.some((t) => t.tag === 'AI'), '4 B 得到 A 的标签（文章就位后应用）');
    ok(dav.fileText('/dav/robinread/sync.json') !== null, '4 B 上行完成');
    const statA2 = await storeA.sync.syncNow({ origin: 'manual' });
    ok(['merge-download', 'merge-upload'].includes(statA2.direction), `4 A 二次同步方向=${statA2.direction}`);
    const aHighlights = storeA.database.prepare('SELECT text FROM highlights').all();
    ok(aHighlights.some((h) => h.text === 'B 的高亮'), '4 A 得到 B 的高亮（同 entryURL 物化）');
    ok(storeA.feedsRepo.feedByURL(LOCAL_ACCOUNT_ID, 'https://b.test/daily.xml') != null, '4 A 得到 B 的新订阅');
    ok(storeA.preferences.get('RobinRead.appTheme', null) === 'dark', '4 A 偏好被远端更新（dark）');

    // ── 5. 本地优先红线 + 幂等（A 连续两次同步零变化）──
    {
      const beforeFeeds = storeA.feedsRepo.allFeeds().length;
      const beforeHL = storeA.database.prepare('SELECT COUNT(*) AS n FROM highlights').get().n;
      const beforeNotes = storeA.database.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
      await storeA.sync.syncNow({ origin: 'manual' });
      await storeA.sync.syncNow({ origin: 'manual' });
      const afterFeeds = storeA.feedsRepo.allFeeds().length;
      const afterHL = storeA.database.prepare('SELECT COUNT(*) AS n FROM highlights').get().n;
      const afterNotes = storeA.database.prepare('SELECT COUNT(*) AS n FROM notes').get().n;
      ok(beforeFeeds === afterFeeds && beforeHL === afterHL && beforeNotes === afterNotes,
        `5 重复同步零新增（feeds ${beforeFeeds}→${afterFeeds}，hl ${beforeHL}→${afterHL}，notes ${beforeNotes}→${afterNotes}）`);
      ok(aHighlights.some((h) => h.text === 'A 的高亮') && storeA.feedsRepo.feedByURL(LOCAL_ACCOUNT_ID, 'https://a.test/feed1.xml') != null,
        '5 本地独有/首发数据永不被删');
    }

    // ── 8. 冲突路径：他机（device-C）写入更新快照 → A GET 合并不上传 ──
    {
      // A 先把偏好改回 light 并同步上行（建立基线）
      storeA.setAppTheme('light');
      await storeA.sync.syncNow({ origin: 'manual' });
      const before = JSON.parse(dav.fileText('/dav/robinread/sync.json'));
      ok(before.deviceId === 'device-A', '8 前置：远端为 A 的快照');
      // device-C 直接写一份更新的快照（含 A 没有的批注 URL 与偏好）
      const cSnap = {
        version: 1, deviceId: 'device-C', updatedAt: N() + 30,
        feeds: [],
        prefs: { values: { articleFontSize: 23 }, updatedAt: N() + 30 },
        annotations: [{ entryURL: 'https://c.test/unknown-article', kind: 'highlight', text: 'C 的批注', createdAt: N(), updatedAt: N() }],
        progress: {},
        tags: {},
      };
      const cClient = new WebDAVClient({ base, username: USER, password: PASS });
      await cClient.put(cClient.url('robinread', 'sync.json'), JSON.stringify(cSnap));
      const statC = await storeA.sync.syncNow({ origin: 'manual' });
      ok(statC.direction === 'merge-download' && statC.remoteDeviceId === 'device-C', `8 远端更新 → GET 合并不上传（${statC.direction}）`);
      const after = JSON.parse(dav.fileText('/dav/robinread/sync.json'));
      ok(after.deviceId === 'device-C' && after.updatedAt === cSnap.updatedAt, '8 远端文件未被 A 改写（本机无新变更）');
      ok(storeA.preferences.get('RobinRead.articleFontSize', 0) === 23, '8 远端偏好合并进本机');
      const pending = JSON.parse(fs.readFileSync(path.join(dirA, 'sync', 'pending-annotations.json'), 'utf8'));
      ok(Array.isArray(pending) && pending.some((p) => p.text === 'C 的批注'), '8 本地无文章的远端批注进 pending（不丢）');
      // 本地出新变更后 → 合并结果上行（pending 一并携带）
      storeA.sync.reportProgress([{ url: 'https://a.test/article-1', pct: 90, at: N() + 60 }]);
      const statPush = await storeA.sync.syncNow({ origin: 'manual' });
      ok(statPush.direction === 'merge-upload', `8 本机有新变更 → 合并后上行（${statPush.direction}）`);
      const pushed = JSON.parse(dav.fileText('/dav/robinread/sync.json'));
      ok(pushed.deviceId === 'device-A' && pushed.annotations.some((a) => a.text === 'C 的批注'),
        '8 pending 批注随上行快照保留（批注永不删）');
    }

    // ══ 5b. P2-2 删除墓碑端到端：A 删订阅 → 上行墓碑 → B 软删生效；B 重订阅 → A 复活 ══
    {
      const victim = storeA.feedsRepo.feedByURL(LOCAL_ACCOUNT_ID, 'https://b.test/daily.xml');
      ok(!!victim, '5b 前置：A 持有 B 的日报订阅');
      storeA.feedsRepo.updateFeed(victim.id, (f) => ({ ...f, isDeleted: true }));
      const statDel = await storeA.sync.syncNow({ origin: 'manual' });
      ok(['upload', 'merge-upload'].includes(statDel.direction),
        `5b 删除算本机变更 → 墓碑随上行快照出发（direction=${statDel.direction}）`);
      const remoteAfterDel = JSON.parse(dav.fileText('/dav/robinread/sync.json'));
      ok((remoteAfterDel.deletedFeedIDs || []).some((t) => t.feedURL === 'https://b.test/daily.xml'),
        '5b 远端快照含删除墓碑（deletedFeedIDs）');
      await storeB.sync.syncNow({ origin: 'manual' });
      const bRowAfter = storeB.database.prepare(
        'SELECT is_deleted FROM feeds WHERE account_id = ? AND feed_url = ?',
      ).get(LOCAL_ACCOUNT_ID, 'https://b.test/daily.xml');
      ok(bRowAfter && Number(bRowAfter.is_deleted) === 1, '5b B 的同源订阅被墓碑软删（删除不再被同步复活）');
      ok(storeB.sync.buildLocalSnapshot().deletedFeedIDs.some((t) => t.feedURL === 'https://b.test/daily.xml'),
        '5b B 快照继承墓碑（删除可继续向第三台设备传播）');
      ok((storeB.feedsRepo.feeds(LOCAL_ACCOUNT_ID) || []).every((f) => f.feedURL !== 'https://b.test/daily.xml'),
        '5b B 活跃订阅列表不再含被删源');
      // 重订阅胜过墓碑：B 重订阅同 URL → 上行 → A 复活且无重复行
      storeB.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'B 的日报', feedURL: 'https://b.test/daily.xml' });
      await storeB.sync.syncNow({ origin: 'manual' });
      await storeA.sync.syncNow({ origin: 'manual' });
      const aRows = storeA.database.prepare(
        'SELECT is_deleted FROM feeds WHERE account_id = ? AND feed_url = ?',
      ).all(LOCAL_ACCOUNT_ID, 'https://b.test/daily.xml');
      ok(aRows.length === 1 && Number(aRows[0].is_deleted) === 0,
        `5b 重订阅跨设备复活且无重复行（rows=${aRows.length}）`);
      const bActive = storeB.feedsRepo.feedByURL(LOCAL_ACCOUNT_ID, 'https://b.test/daily.xml');
      ok(bActive && Number(bActive.isDeleted ?? 0) === 0, '5b B 重订阅行保持活跃');
    }

    // ══ 6. 自动同步：kick 节流 + 手动立即同步 ══
    {
      const requestsBefore = dav.log.length;
      const throttled = storeA.sync.kick('refresh'); // 刚同步过 → 节流窗内
      ok(throttled === null, '6 kick 节流：10 分钟窗内返回 null 不执行');
      storeA.sync._lastAutoAt = 0;
      const kicked = storeA.sync.kick('refresh');
      ok(kicked && typeof kicked.then === 'function', '6 kick 节流窗归零 → 放行（异步 promise）');
      await kicked;
      ok(dav.log.length > requestsBefore, '6 kick 实际执行了同步请求');
      storeA.sync.setAutoEnabled(false);
      ok(storeA.sync.kick('refresh') === null, '6 自动同步关闭 → kick 抑制');
      storeA.sync.setAutoEnabled(true);
      // 手动立即同步绕过节流
      const manual = await storeA.sync.syncNow({ origin: 'manual' });
      ok(manual && manual.elapsedMs >= 0, '6 手动立即同步可用（绕过节流）');
    }

    // ══ 10. 刷新主路径不受同步影响（同步在飞时刷新照常完成）══
    {
      const RSS_XML = `<?xml version="1.0"?><rss version="2.0"><channel><title>F7 回归周刊</title><link>https://rss.test</link>
<item><title>普通源文章</title><link>https://rss.test/a1</link><pubDate>${new Date(Date.now() - 3600 * 1000).toUTCString()}</pubDate><description>普通源正文。</description></item>
</channel></rss>`;
      const { useNetFetch } = require('../src/main/FeedService');
      useNetFetch(async (url) => {
        if (url.startsWith('https://rss.test/')) {
          return new Response(RSS_XML, { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
        }
        throw new Error('mock net: unexpected URL ' + url);
      });
      const rssFeed = storeA.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F7 回归周刊', feedURL: 'https://rss.test/feed.xml' });
      // 慢 DAV：同步在飞（服务器每请求延迟 250ms）
      const slowDav = createFakeDAV({ delayMs: 250 });
      await new Promise((r) => slowDav.server.listen(0, '127.0.0.1', r));
      storeB.sync.saveConfig({ serverURL: `http://127.0.0.1:${slowDav.server.address().port}/dav`, username: USER, password: PASS });
      const inFlight = storeB.sync.syncNow({ origin: 'manual' }); // 不 await：同步后台执行
      const t0 = Date.now();
      const refresh = await storeA.refreshFeed(rssFeed.id);
      const refreshMs = Date.now() - t0;
      ok(refresh && refresh.newEntries === 1 && refreshMs < 2000,
        `10 同步在飞时刷新主路径不受影响（${refresh.newEntries} 条 / ${refreshMs}ms < 2000ms）`);
      const kickStart = Date.now();
      const kicked = storeA.sync.kick('refresh');
      const kickMs = Date.now() - kickStart;
      ok(kickMs < 100, `10 kick 即返（${kickMs}ms < 100ms，异步不阻塞）`);
      if (kicked) await kicked;
      await inFlight.catch(() => {});
      await closeServer(slowDav.server);
    }

    // ══ 9. UI：设置「同步」分区 + 命令面板入口（真 IPC + 隐藏窗口）══
    {
      const { BrowserWindow } = require('electron');
      const { registerIPCHandlers } = require('../src/main/ipc');
      const win = new BrowserWindow({
        show: false, width: 1100, height: 820,
        webPreferences: { contextIsolation: true, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
      });
      registerIPCHandlers(storeA, win);
      await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
      await new Promise((r) => setTimeout(r, 900));
      const result = await win.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const waitFor = async (fn, ms = 8000) => {
          const t0 = Date.now();
          for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); }
        };
        try {
          const { SettingsView } = await import('./views/dialogs.js');
          const view = new SettingsView({ state: {}, views: {}, onAddFreshRSS: () => {}, onReload: () => {}, onRefreshState: () => {} });
          view.present('sync');
          const navOk = [...document.querySelectorAll('.modal-nav-item')].some((el) => el.textContent.includes('同步'));
          await waitFor(() => (document.querySelector('.modal-scroll')?.textContent || '').includes('WebDAV 服务器') ? true : null, 8000);
          const bodyText = document.querySelector('.modal-scroll')?.textContent || '';
          const serverInput = [...document.querySelectorAll('.modal-scroll input')].find((el) => (el.value || '').includes('127.0.0.1'));
          const hasAuto = bodyText.includes('自动同步');
          const hasNow = bodyText.includes('立即同步');
          const hasLast = bodyText.includes('上次同步');
          const hasTest = bodyText.includes('测试连接');
          const hasDisconnect = bodyText.includes('断开同步');
          view.dismiss();
          // 命令面板入口（sync-command 模块）
          const { syncPaletteCommand, syncResultText } = await import('./views/sync-command.js');
          const cmd = syncPaletteCommand({ notify: () => {}, silentError: true });
          // IPC：配置读取走真通道
          const cfg = await window.robin.syncGetConfig();
          return {
            navOk, hasAuto, hasNow, hasLast, hasTest, hasDisconnect,
            serverRendered: !!serverInput,
            cmdLabel: cmd.label, cmdIcon: !!cmd.icon, cmdKw: /webdav|同步/.test(cmd.keywords),
            ipcServerURL: cfg && cfg.serverURL, ipcAuto: cfg && cfg.autoEnabled,
            resultText: syncResultText({ direction: 'upload', uploadedEntries: { feeds: 1, annotations: 2, progress: 3 } }),
          };
        } catch (e) { return { __err: String(e && e.stack || e) }; }
      })()`);
      if (result.__err) { ok(false, 'UI 探针异常 — ' + result.__err); } else {
        ok(result.navOk, 'UI 设置导航含「同步」分区');
        ok(result.serverRendered, 'UI 服务器地址输入框渲染（真 IPC 读到配置）');
        ok(result.hasAuto && result.hasNow && result.hasTest, 'UI 自动同步开关/立即同步/测试连接齐全');
        ok(result.hasLast, 'UI 上次同步时间行渲染');
        ok(result.hasDisconnect, 'UI 断开同步入口渲染');
        ok(result.cmdLabel === '立即同步' && result.cmdIcon && result.cmdKw, 'UI 命令面板「立即同步」入口（图标+关键词）');
        ok(result.ipcServerURL === base && result.ipcAuto === true, `UI 真 IPC 配置回读（${result.ipcServerURL}）`);
        ok(/已上行快照/.test(String(result.resultText)), 'UI 同步结果文案（上行/下行/合并统计）');
      }
      win.destroy();
    }

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  } finally {
    await closeServer(dav ? dav.server : null);
    for (const dir of cleanup) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  }
});
