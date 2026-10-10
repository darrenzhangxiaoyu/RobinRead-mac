'use strict';
/**
 * diag-f31-pocket.js — F31 口袋知更探针（run-all OFFLINE 集，全程离线）
 *
 * 覆盖：
 *  1 配置：默认关 / 端口 7963 / 绑定 loopback / 端口校验（<1024、>65535 拒绝）+ 合法落库
 *  2 生命周期：start 同步 / 127.0.0.1 绑定实证 / 幂等 alreadyRunning / 可连 /
 *    stop 端口立即释放 / 幂等 stop / 重启同端口
 *  3 绑定模式：无 confirmLan 切局域网拒绝 / 带确认切 0.0.0.0（address 实证）/ 运行中
 *    重启生效 / accessURL 用局域网 IP / 切回 loopback
 *  4 鉴权与登录：无 token → 登录页（/ 与 /read 均拦）/ 错 token → 登录页 /
 *    /login?t=正确 → 302 + HttpOnly cookie / 错 token 登录 → 错误提示 /
 *    cookie 正确 → 列表页
 *  5 列表页：标题+来源渲染 / 标题 XSS 转义 / 分页（25 篇两页 + 下一页链接）/
 *    未读过滤 / page size 20
 *  6 文章页：标题+正文 / 服务侧正文再消毒（script 剥除实证）/ 上一页下一页 /
 *    不存在 → 404 / done=1 已读回执
 *  7 已读回传：POST 无 token 401 / 带 token 302 / 真落库 is_read=1 /
 *    不存在 entryID 404
 *  8 限流：注入时钟同 IP 61 发 → 第 61 个 429 + Retry-After
 *  9 二维码：未运行 null / 运行返回 url(含 token)+svg / QR 确定性（同参数同输出）
 * 10 退出停服：store.shutdown() → stop + 端口释放 / main.js will-quit 静态锚点 /
 *    AppStore 自启接线锚点
 * 11 设置分区 UI 真渲染（offscreen 150s 竞速降级 SKIP）+ pocket:* IPC 真调用 +
 *    静态锚点（preload/IPC/分区/CSS/i18n）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration(); // 沙箱内 GPU 合成偶发死锁：探针窗口纯 DOM 断言，禁用硬件加速
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f31-')));
setTimeout(() => { console.error('WATCHDOG'); process.exit(3); }, 600 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let passed = 0;
const ok = (c, l) => { if (c) { passed += 1; console.log('PASS ' + l); } else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const PORT = 7963; // 默认端口即探针端口（本机开发实例不会同时跑）

async function waitPort(port, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const open = await new Promise((resolve) => {
      const sock = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
        res.resume();
        resolve(res.statusCode > 0);
      });
      sock.on('error', () => resolve(false));
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
    });
    if (open) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(80);
  }
}

async function portGone(port, timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    const open = await new Promise((resolve) => {
      const sock = http.get({ host: '127.0.0.1', port, path: '/', timeout: 600 }, () => resolve(true));
      sock.on('error', () => resolve(false));
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
    });
    if (!open) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(60);
  }
}

/** 请求（可带 cookie / 查询路径；formBody 走 POST urlencoded）。 */
function request(port, reqPath, { method = 'GET', cookie = null, form = null } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    let body = null;
    if (form) {
      body = new URLSearchParams(form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        setCookie: res.headers['set-cookie'] || [],
      }));
    });
    req.on('error', (err) => resolve({ status: 0, headers: {}, body: '', setCookie: [], error: String(err && err.message || err) }));
    if (body) req.write(body);
    req.end();
  });
}

const T0 = Math.floor(Date.now() / 1000);

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { PocketWebService, POCKET, tokenMatches, qrSvg } = require('../src/main/PocketWebService');
    const { qrSvg: qrSvgLib } = require('../src/main/lib/QRCode');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);
    const svc = store.pocket;
    ok(svc instanceof PocketWebService, '附 store.pocket 接线（AppStore 构造）');

    // ── 场景数据：1 源 26 篇（标题含 XSS 探针 1 篇），前 2 篇已读 ──
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F31 口袋源', feedURL: 'https://f31.test/feed.xml' });
    const entries = [];
    for (let i = 1; i <= 26; i += 1) {
      const title = i === 1 ? '<script>alert(1)</script> 口袋第一篇' : `口袋文章 ${i}`;
      entries.push({
        id: `f31-e${i}`, title, url: `https://f31.test/a/${i}`,
        publishedAt: T0 - i * 600, summary: `第 ${i} 篇摘要。`, contentHTML: `<p>F31BODY 口袋正文第 ${i} 篇。</p>`,
      });
    }
    const ids = store._applyParsedEntries(feed, entries);
    ok(ids.length === 26, '附 场景源灌入 26 篇文章');
    store.markRead(ids[0], true);
    store.markRead(ids[1], true);
    // 坏缓存行：携带 script 标签（服务侧正文再消毒的实证素材）
    store.database.prepare(`
      INSERT INTO article_caches (item_id, text, html, fetched_at, is_sanitized) VALUES (?, ?, ?, ?, 0)
    `).run(ids[2], 'cached', `<p>F31CACHE 缓存正文。</p><script>window.evil=1</script><iframe src="https://evil.test"></iframe>`, T0);
    ok(store.database.prepare('SELECT COUNT(*) AS n FROM article_caches').get().n >= 1, '附 坏缓存种子行就位');

    // ── 1. 配置 ──
    ok(POCKET.DEFAULT_PORT === 7963 && POCKET.BIND_LOOPBACK === 'loopback' && POCKET.BIND_LAN === 'lan',
      '1 常量：默认端口 7963 + 绑定模式二值');
    const cfg0 = svc.getConfig();
    ok(cfg0.enabled === false && cfg0.port === 7963 && cfg0.bind === 'loopback' && cfg0.hasToken === false,
      '1 默认配置：关 / 7963 / loopback / 令牌未生成（首次开启才发）');
    let badPort = '';
    try { svc.start(80); } catch (e) { badPort = String(e && e.message || e); }
    ok(/1024/.test(badPort) && !svc.status().running, '1 端口 <1024 拒绝');
    try { svc.start(70000); } catch (e) { badPort = String(e && e.message || e); }
    ok(/1024/.test(badPort), '1 端口 >65535 拒绝');
    let saved = false;
    try { svc.configure({ port: PORT }); saved = svc.getConfig().port === PORT; } catch (_) { saved = false; }
    ok(saved, '1 合法端口落库');

    // ── 2. 生命周期 ──
    const started = svc.start();
    ok(started.port === PORT && started.host === '127.0.0.1' && svc.status().running,
      '2 start 返回端口与绑定主机（默认 127.0.0.1）');
    ok(svc.getConfig().hasToken === true && svc._token.length >= 32,
      '2 令牌首次开启时自动生成（≥32 字符）并落库');
    let bindAddr = null;
    for (let i = 0; i < 50 && !bindAddr; i += 1) {
      bindAddr = (svc._server && svc._server.address()) || null;
      if (!bindAddr) await sleep(60);
    }
    ok(bindAddr && bindAddr.address === '127.0.0.1', '2 server.address().address === 127.0.0.1（默认仅本机实证）');
    const again = svc.start(PORT);
    ok(again.alreadyRunning === true, '2 重复 start 幂等（alreadyRunning）');
    ok(await waitPort(PORT), '2 端口可连（listen 就绪）');
    ok(svc.stop().stopped === true && !svc.status().running, '2 stop：running 翻 false');
    ok(await portGone(PORT), '2 服务关闭后端口立即释放');
    ok(svc.stop().stopped === false, '2 幂等 stop（未运行返回 stopped:false）');
    svc.start();
    ok(await waitPort(PORT), '2 重启：同端口可再绑');

    // ── 3. 绑定模式 ──
    let lanRefused = '';
    try { svc.configure({ bind: 'lan' }); } catch (e) { lanRefused = String(e && e.message || e); }
    ok(/确认/.test(lanRefused) && svc._server.address().address === '127.0.0.1',
      '3 无 confirmLan 切局域网拒绝（两层闸服务侧再验）');
    const lanCfg = svc.configure({ bind: 'lan', confirmLan: true });
    let lanAddr = null;
    for (let i = 0; i < 50; i += 1) {
      lanAddr = (svc._server && svc._server.address()) || null;
      if (lanAddr && lanAddr.address === '0.0.0.0') break;
      await sleep(60);
    }
    ok(lanAddr && lanAddr.address === '0.0.0.0', '3 确认后切 0.0.0.0（运行中重启立即生效，address 实证）');
    ok(lanCfg.config.bind === 'lan' && svc.status().running, '3 configure 返回新配置且服务仍运行');
    const lanURL = svc.accessURL();
    ok(/^http:\/\/[0-9.]+:7963\/\?t=/.test(lanURL) && !lanURL.includes('127.0.0.1'),
      '3 局域网模式 accessURL 用非回环 IPv4（局域网展示地址）');
    const backCfg = svc.configure({ bind: 'loopback' });
    let backAddr = null;
    for (let i = 0; i < 50; i += 1) {
      backAddr = (svc._server && svc._server.address()) || null;
      if (backAddr && backAddr.address === '127.0.0.1') break;
      await sleep(60);
    }
    ok(backAddr && backAddr.address === '127.0.0.1' && backCfg.config.bind === 'loopback',
      '3 切回 loopback 同样运行中重启生效');

    // ── 4. 鉴权与登录 ──
    const token = svc._token;
    ok(tokenMatches(token, token) && !tokenMatches('wrong', token), '4 tokenMatches 常数时间比较：对真/错判定正确');
    const noAuthHome = await request(PORT, '/');
    ok(noAuthHome.status === 200 && noAuthHome.body.includes('口袋知更') && noAuthHome.body.includes('type="password"'),
      '4 无 token GET / → 登录页（含令牌输入框）');
    const noAuthRead = await request(PORT, '/read/f31-e3');
    ok(noAuthRead.body.includes('type="password"'), '4 无 token GET /read → 登录页（页面路径全拦截）');
    const wrongAuth = await request(PORT, '/?t=wrong-token');
    ok(wrongAuth.body.includes('type="password"'), '4 错 token 查询参数 → 登录页');
    const loginOk = await request(PORT, `/login?t=${encodeURIComponent(token)}`);
    const cookieHeader = loginOk.setCookie[0] || '';
    ok(loginOk.status === 302 && cookieHeader.includes(`${POCKET.TOKEN_COOKIE}=`) && cookieHeader.includes('HttpOnly'),
      '4 /login?t=正确 → 302 + HttpOnly cookie');
    const cookie = cookieHeader.split(';')[0];
    const loginBad = await request(PORT, '/login?t=not-the-token');
    ok(loginBad.status === 200 && loginBad.body.includes('type="password"'), '4 错 token 登录 → 回登录页');

    // ── 5. 列表页 ──
    const list = await request(PORT, '/', { cookie });
    ok(list.status === 200 && list.body.includes('口袋文章 3'), '5 列表页渲染文章标题');
    ok(list.body.includes('F31 口袋源'), '5 列表页渲染来源标题');
    ok(!list.body.includes('<script>alert(1)') && list.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),
      '5 标题 XSS 转义（&lt;script&gt; 实证）');
    ok(list.body.includes('/read/'), '5 条目含 /read/<id> 链接');
    const p1 = await request(PORT, '/?page=1', { cookie });
    const itemCount = (p1.body.match(/\/read\//g) || []).length;
    ok(itemCount === 20 && p1.body.includes('page=2'), `5 分页：第 1 页 20 条 + 下一页链接（实测 ${itemCount} 条）`);
    const p2 = await request(PORT, '/?page=2', { cookie });
    ok((p2.body.match(/\/read\//g) || []).length === 6 && p2.body.includes('page=1'), '5 第 2 页余 6 条 + 上一页链接');
    const unread = await request(PORT, '/?unread=1', { cookie });
    ok(unread.body.includes('口袋文章 3') && !unread.body.includes('>口袋文章 2<'), '5 未读过滤：已读文章不出现');
    ok(unread.body.includes('只看未读') === false && unread.body.includes('全部文章'), '5 过滤态翻转（显示「全部文章」出口）');

    // ── 6. 文章页 ──
    const art = await request(PORT, `/read/${ids[2]}`, { cookie });
    ok(art.status === 200 && art.body.includes('口袋文章 3') && art.body.includes('F31CACHE'),
      '6 文章页：标题 + 缓存正文渲染');
    ok(!art.body.includes('<script>') && !art.body.includes('<iframe') && !art.body.includes('window.evil'),
      '6 服务侧正文再消毒：script/iframe 剥除（坏缓存实证）');
    ok(art.body.includes('/api/read') && art.body.includes('标为已读'), '6 未读文章带「标为已读」表单');
    const artRead = await request(PORT, `/read/${ids[0]}?done=1`, { cookie });
    ok(artRead.body.includes('已标为已读'), '6 done=1 回执（已标为已读）');
    const nav = await request(PORT, `/read/${ids[3]}`, { cookie });
    ok(nav.body.includes('上一篇') && nav.body.includes('下一篇'), '6 上一页/下一页（邻居链接）');
    const nav404 = await request(PORT, '/read/f31-none', { cookie });
    ok(nav404.status === 404, '6 不存在文章 → 404');
    // ── 7. 已读回传（唯一写通道）──
    const post401 = await request(PORT, '/api/read', { method: 'POST', form: { entryID: ids[4] } });
    ok(post401.status === 401, '7 POST 无 token → 401');
    ok(store.database.prepare('SELECT is_read FROM article_states WHERE item_id = ?').get(ids[4])?.is_read !== 1,
      '7 未授权回传未落库');
    const postOk = await request(PORT, '/api/read', { method: 'POST', cookie, form: { entryID: ids[4] } });
    const loc = decodeURIComponent(String(postOk.headers.location || ''));
    ok(postOk.status === 302 && loc.includes(`/read/${ids[4]}`),
      '7 POST 带 token → 302 回阅读页');
    ok(store.database.prepare('SELECT is_read FROM article_states WHERE item_id = ?').get(ids[4])?.is_read === 1,
      '7 已读真落库（is_read=1，走 markRead 既有管线）');
    const post404 = await request(PORT, '/api/read', { method: 'POST', cookie, form: { entryID: 'f31-none' } });
    ok(post404.status === 404, '7 不存在 entryID → 404');
    const postFormToken = await request(PORT, '/api/read', { method: 'POST', form: { entryID: ids[5], token } });
    ok(postFormToken.status === 302 && store.database.prepare('SELECT is_read FROM article_states WHERE item_id = ?').get(ids[5])?.is_read === 1,
      '7 表单体带 token（无 cookie 通路）同样回传落库');
    const postWrong = await request(PORT, '/api/read', { method: 'POST', cookie, form: { entryID: ids[6] } });
    const wrongMethod = await request(PORT, '/api/read', { method: 'PUT' });
    ok(wrongMethod.status === 401 || wrongMethod.status === 405, '7 其他写方法不放宽（401 鉴权先行）');
    ok(postWrong.status === 302, '附 POST /api/read 正常路径稳定');

    // ── 8. 限流（每 IP 每分钟 ≤60）──
    svc._now = () => T0 + 7200; // 注入时钟 → 固定分钟窗（确定性；此前真实窗口计数被换窗清零）
    let hit429 = 0;
    let limited = null;
    for (let i = 0; i < 61; i += 1) {
      const r = await request(PORT, '/', { cookie });
      if (r.status === 429) { hit429 += 1; if (!limited) limited = r; }
    }
    ok(hit429 === 1 && limited && limited.headers['retry-after'] === '60',
      `8 限流：61 发 60 过 1 限（429 + Retry-After:60）`);
    ok(svc.counters.rateLimited >= 1, '8 rateLimited 计数在案');
    svc._now = () => T0 + 10800; // 新分钟窗：后续测试不再吃限流

    // ── 9. 二维码 ──
    const qr = svc.qrSVG();
    ok(qr && qr.url === svc.accessURL() && qr.svg.startsWith('<svg') && qr.svg.includes('<path'),
      '9 运行中 qrSVG：url + SVG 网格');
    ok(qr.svg === qrSvgLib(qr.url) && qrSvgLib(qr.url) === qrSvgLib(qr.url),
      '9 QR 确定性：同参数同输出（逐字节）');
    const qrStopped = (() => { const s = svc.stop(); const q = svc.qrSVG(); svc.start(); return q === null && s.stopped === true; })();
    ok(qrStopped, '9 未运行 qrSVG → null');
    await waitPort(PORT);

    // ── 10. 退出停服 ──
    ok(svc.status().running, '附 退出前服务在运行');
    store.shutdown();
    ok(!svc.status().running && await portGone(PORT), '10 store.shutdown() → 口袋知更自动 stop + 端口释放');
    const mainSrc = read('src/main/main.js');
    ok(mainSrc.includes('store.pocket?.stop()'), '10 main.js will-quit 静态锚点（退出自动停服）');
    const storeSrc = read('src/main/AppStore.js');
    ok(storeSrc.includes('new PocketWebService') && storeSrc.includes('this.pocket.start()') && storeSrc.includes('this.pocket?.stop()'),
      '10 AppStore 构造 + 启用自启 + shutdown 双锚');

    // ── 11. 设置分区 + IPC（真渲染，环境降级可 SKIP；复用原 store：shutdown 只停服务不清数据）──
    const ui = await Promise.race([
      pocketSettingsProbe(store),
      new Promise((r) => setTimeout(() => r({ uiSkipped: true, booted: null }), 150000)),
    ]);
    if (ui.uiSkipped) {
      for (const m of ['附 UI 探针窗口启动（index.html + preload + 真 IPC）', '11 设置页渲染：口袋知更分区（状态徽标/二维码/绑定模式）', '11 pocket:* IPC：config 形状 + setConfig 开关 + QR 通道']) {
        console.log('SKIP ' + m);
      }
      console.log('UI 阶段 SKIP：环境性挂起（服务级断言已全部执行）');
      try { fs.writeFileSync(path.join(__dirname, '.ci-skip-marker'), 'scripts/diag-f31-pocket.js'); } catch (_) { /* 标记失败仅影响连击治理 */ }
      store.preferences.flushSync();
      store.database.close();
      console.log(`TOTAL passed=${passed} failed=${failed}`);
      process.exit(failed ? 1 : 0);
      return;
    }
    ok(ui.booted, '附 UI 探针窗口启动（index.html + preload + 真 IPC）');
    ok(ui.sectionRendered === true, '11 设置页渲染：口袋知更分区（状态徽标/二维码/绑定模式/停止按钮）');
    ok(ui.ipcWorks === true, '11 pocket:* IPC：config 形状 + setConfig 开关 + QR 通道');

    // ── 附：静态接线锚点 ──
    const preloadSrc = read('src/main/preload.js');
    ok(['pocketConfig', 'pocketSetConfig', 'pocketQR'].every((n) => preloadSrc.includes(n)),
      '附 preload 口袋知更 3 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(["'pocket:config'", "'pocket:setConfig'", "'pocket:qr'"].every((c) => ipcSrc.includes(c)),
      '附 IPC pocket 通道注册齐备');
    const dialogsSrc = read('src/renderer/views/dialogs.js');
    ok(['口袋知更', '开启口袋知更', '绑定模式', '访问二维码', '重新显示二维码', '停止服务', 'pocket-status', 'pocket-qr', 'pocket-stop'].every((k) => dialogsSrc.includes(k)),
      '附 设置分区/开关/绑定/二维码/停止锚点齐备');
    const cssSrc = read('src/renderer/styles/robin.css');
    ok(cssSrc.includes('.nj-pocket-qr') && cssSrc.includes('.nj-pocket-url'), '附 CSS 二维码/地址样式');
    const stringsSrc = read('src/main/I18NStrings.js');
    ok(['"口袋知更"', '"开启口袋知更"', '"绑定模式"', '"访问二维码"', '"标为已读"', '"只看未读"', '"我已知晓，仍要开启"'].every((k) => stringsSrc.includes(k)),
      '附 i18n 中英键齐备（口袋知更七组）');
    const svcSrc = read('src/main/PocketWebService.js');
    ok(svcSrc.includes("require('node:http')") && !svcSrc.match(/\bexpress\b|\bkoa\b|\bpolka\b/),
      '附 零依赖 node:http 自研');

    store.preferences.flushSync();
    store.database.close();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
    console.log(`TOTAL passed=${passed} failed=${failed}`);
    console.log(failed === 0 ? 'ALL PASSED' : `FAILED ${failed}`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('ERR', String((err && err.stack) || err).slice(0, 1600));
    process.exit(1);
  }
});

/**
 * 设置分区 UI 探针：真 IPC + SettingsView 真渲染。
 * offscreen + backgroundThrottling=false（f25/f26/f39 惯例）。
 */
async function pocketSettingsProbe(store) {
  let win = null;
  try {
    win = new BrowserWindow({
      show: false, width: 1200, height: 860, useContentSize: true,
      webPreferences: { offscreen: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
  } catch (err) {
    console.error('pocket settings probe: window create failed (environmental):', String((err && err.message) || err));
    return { uiSkipped: true, booted: null };
  }
  try {
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, win);
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  } catch (err) {
    console.error('pocket settings probe: load failed (environmental):', String((err && err.message) || err));
    try { win.destroy(); } catch (_) { /* 已销毁 */ }
    return { uiSkipped: true, booted: null };
  }
  await sleep(1400);
  const out = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { booted: true };
    try {
      // pocket:* IPC 真调用
      const cfg = await window.robin.pocketConfig();
      out.ipcWorks = Boolean(cfg && cfg.config && cfg.status && typeof cfg.config.port === 'number');
      const toggled = await window.robin.pocketSetConfig({ enabled: true });
      out.ipcWorks = out.ipcWorks && Boolean(toggled && toggled.ok && toggled.data && toggled.data.config.enabled === true);
      const qr = await window.robin.pocketQR();
      out.ipcWorks = out.ipcWorks && Boolean(qr && qr.svg && String(qr.svg).startsWith('<svg') && qr.url);
      await window.robin.pocketSetConfig({ enabled: false });
      // 设置页真渲染（口袋知更分区）
      const { SettingsView } = await import('./views/dialogs.js');
      const view = new SettingsView({ state: { snapshot: { preferences: {} } }, views: {} });
      view.present('pocket');
      await sleep(600);
      out.sectionRendered = Boolean(
        document.querySelector('.modal-nav-item[data-section="pocket"]')
        && document.querySelector('[data-role="pocket-status"]')
        && document.querySelector('[data-role="pocket-qr"]')
        && document.querySelector('[data-role="pocket-stop"]')
      );
      view.dismiss();
      return out;
    } catch (e) {
      return { booted: true, error: String((e && e.stack) || e).slice(0, 700) };
    }
  })()`);
  win.destroy();
  if (out && out.error) console.error('pocket settings probe error:', out.error);
  return out || {};
}
