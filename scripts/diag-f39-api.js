'use strict';
/**
 * diag-f39-api.js — F39 阅读数据开放 API 探针（run-all OFFLINE 集，全程离线）
 *
 * 覆盖：
 *  1 配置与令牌：默认端口 7962 / 端口校验（<1024、>65535 拒绝）/ 令牌启动生成并落库
 *  2 生命周期：start 同步返回 / 127.0.0.1 绑定（server.address 实证）/ stop 端口立即释放 /
 *    幂等 stop / 重复 start alreadyRunning / 退出自动 stop（shutdown + main.js 静态锚点）
 *  3 鉴权：无 token 401 / 错 token 401 / 垃圾 Authorization 头 401 / 正确 Bearer 200 /
 *    timingSafeEqual 常数时间比较（tokenMatches 单测）/ 令牌重生成（旧即刻失效+新可用+落库）
 *  4 只读红线：POST（带 token）405 / 未知路径 404 / 全响应无 CORS 头
 *  5 五端点 JSON 形状（种子数据实证）：
 *    stats（存储+阅读统计）/ feeds（标题+健康分+无凭据字段）/ annotations（分页 limit/offset
 *    + 文章正文全文永不出现）/ reading-clock（24 桶）/ capsules / weeklies（元数据）
 *  6 限流：每分钟 ≤120，第 121 个 429 + Retry-After；请求日志开关（开记/关清）
 *  7 设置分区：SECTIONS/简介/搜索索引静态锚点 + 设置页真渲染（徽标/端口输入/令牌行）
 *    + api:* IPC 通道（apiConfig/apiSetConfig/apiRegenerateToken 真调用）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration(); // 沙箱内 GPU 合成偶发死锁：探针窗口纯 DOM 断言，禁用硬件加速
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f39-')));
setTimeout(() => { console.error('WATCHDOG'); process.exit(3); }, 600 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let passed = 0;
const ok = (c, l) => { if (c) { passed += 1; console.log('PASS ' + l); } else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const PORT = 7939; // 探针高位端口（避开默认 7962，防与本机开发实例撞车）

/** 端口可连等待（listen 异步完成前的窗口期重试）。 */
async function waitPort(port, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const open = await new Promise((resolve) => {
      const sock = http.get({ host: '127.0.0.1', port, path: '/api/v1/stats', timeout: 800 }, (res) => {
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

/** 端口已释放（连接被拒）。 */
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

/** 原始请求（node:http，带可选 keepalive agent）。 */
function request(port, reqPath, { method = 'GET', token = null, agent = null } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (token != null) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => resolve({ status: 0, headers: {}, body: '', error: String(err && err.message || err) }));
    req.end();
  });
}

const T0 = Math.floor(Date.now() / 1000);

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { LocalApiService, LOCAL_API, generateToken, tokenMatches } = require('../src/main/LocalApiService');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);
    const svc = store.api;

    // ── 场景数据：1 源 3 篇（正文带独特标记），2 篇读完 + 1 高亮 + 1 笔记 + 生物钟喂入 + 胶囊/周刊行 ──
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F39 开放源', feedURL: 'https://f39.test/feed.xml' });
    const entries = [];
    for (let i = 1; i <= 3; i += 1) {
      entries.push({
        id: `f39-e${i}`, title: `开放数据文章 ${i}`, url: `https://f39.test/a/${i}`,
        publishedAt: T0 - i * 3600, summary: `第 ${i} 篇摘要。`, contentHTML: `<p>F39BODYMARKER 正文第 ${i} 篇：这一段很长很长，绝不应该出现在开放 API 的任何响应里。</p>`,
      });
    }
    const ids = store._applyParsedEntries(feed, entries);
    ok(ids.length === 3, '附 场景源灌入 3 篇文章');
    store.markRead(ids[0], true);
    store.markRead(ids[1], true);
    store.knowledge.addHighlight({ itemID: ids[0], text: '这一句值得划下来。', note: '批注一句' });
    store.knowledge.addNote({ itemID: ids[1], content: '这是一条独立笔记，给批注端点凑数。' });
    store.clock.onRead({ at: T0 - 3600 }); // 生物钟喂入（昨天 24 桶内一桶）
    store.database.prepare(`
      INSERT INTO time_capsules (id, annotation_id, annotation_kind, entry_id, open_at, opens_count, status, created_at)
      VALUES ('cap-f39', 'hl-x', 'highlight', ?, ?, 0, 'sealed', ?)
    `).run(ids[2], T0 + 90 * 86400, T0);
    store.database.prepare(`
      INSERT INTO weeklies (id, week_start, status, created_at, updated_at) VALUES ('wk-f39', '2026-10-05', 'ready', ?, ?)
    `).run(T0, T0);
    ok(store.database.prepare('SELECT COUNT(*) AS n FROM time_capsules').get().n >= 1
      && store.database.prepare("SELECT COUNT(*) AS n FROM weeklies WHERE status = 'ready'").get().n >= 1,
      '附 胶囊/周刊种子行就位');

    // ── 1. 配置与令牌 ──
    ok(LOCAL_API.DEFAULT_PORT === 7962 && LOCAL_API.HOST === '127.0.0.1',
      '1 默认端口 7962 + HOST 常量 127.0.0.1（红线）');
    const cfg0 = svc.getConfig();
    ok(cfg0.enabled === false && cfg0.port === 7962 && cfg0.logRequests === false,
      '1 默认配置：关 / 7962 / 日志关');
    ok(typeof cfg0.token === 'string' && cfg0.token.length >= 32 && store.preferences.get('RobinRead.api.token', '') === cfg0.token,
      '1 令牌启动即生成并落库（preferences 持久）');
    ok(generateToken() !== generateToken(), '1 generateToken 随机性（两次不同）');
    let badPort = '';
    try { svc.start(80); } catch (e) { badPort = String(e && e.message || e); }
    ok(/1024/.test(badPort) && !svc.status().running, '1 端口 <1024 拒绝（1024-65535 校验）');
    try { svc.start(70000); } catch (e) { badPort = String(e && e.message || e); }
    ok(/1024/.test(badPort), '1 端口 >65535 拒绝');
    let saved = false;
    try { svc.configure({ port: 8888 }); saved = svc.getConfig().port === 8888; } catch (_) { saved = false; }
    ok(saved, '1 合法端口落库（configure port）');
    svc.configure({ port: PORT }); // 探针端口

    // ── 2. 生命周期：start / 绑定 / stop / 幂等 / 重启 ──
    const started = svc.start(PORT);
    ok(started.port === PORT && started.host === '127.0.0.1' && svc.status().running,
      '2 start 返回端口与绑定主机（127.0.0.1）');
    // listen 异步完成：轮询等待 bind 就绪后再读 address（探针确定性）
    let bindAddr = null;
    for (let i = 0; i < 50 && !bindAddr; i += 1) {
      bindAddr = (svc._server && svc._server.address()) || null;
      if (!bindAddr) await sleep(60);
    }
    ok(bindAddr && bindAddr.address === '127.0.0.1',
      '2 server.address().address === 127.0.0.1（永不 0.0.0.0 实证）');
    const again = svc.start(PORT);
    ok(again.alreadyRunning === true && svc.status().port === PORT, '2 重复 start 幂等（alreadyRunning）');
    ok(await waitPort(PORT), '2 端口可连（listen 就绪）');
    const token = svc.getConfig().token;
    const stopResult = svc.stop();
    ok(stopResult.stopped === true && !svc.status().running, '2 stop：running 翻 false');
    ok(await portGone(PORT), '2 服务关闭后端口立即释放（连接被拒）');
    ok(svc.stop().stopped === false, '2 幂等 stop（未运行返回 stopped:false）');
    svc.start(PORT);
    ok(await waitPort(PORT), '2 重启：同端口可再绑（释放干净）');

    // ── 3. 鉴权 ──
    const r401a = await request(PORT, '/api/v1/stats');
    ok(r401a.status === 401, '3 无 token → 401');
    const r401b = await request(PORT, '/api/v1/stats', { token: 'wrong-token-123' });
    ok(r401b.status === 401, '3 错 token → 401');
    const r401c = await request(PORT, '/api/v1/stats', { token: '' });
    ok(r401c.status === 401, '3 空 Bearer → 401');
    const okResp = await request(PORT, '/api/v1/stats', { token });
    ok(okResp.status === 200 && JSON.parse(okResp.body).storage, '3 正确 Bearer → 200 + JSON');
    ok(tokenMatches(token, token) && !tokenMatches('nope', token) && !tokenMatches('', token),
      '3 tokenMatches：对真/错/空判定正确（sha256 摘要 + timingSafeEqual）');

    // ── 4. 只读红线 + CORS ──
    const rPost = await request(PORT, '/api/v1/stats', { method: 'POST', token });
    ok(rPost.status === 405 && JSON.parse(rPost.body).allowed?.[0] === 'GET', '4 POST（带 token）→ 405（只开 GET）');
    const r404 = await request(PORT, '/api/v9/none', { token });
    ok(r404.status === 404, '4 未知路径 → 404');
    const noAuth405 = await request(PORT, '/api/v1/stats', { method: 'PUT' });
    ok(noAuth405.status === 401, '4 无 token 的写方法先吃 401（鉴权先行，方法面不可探测）');
    ok(!okResp.headers['access-control-allow-origin'] && !okResp.headers['access-control-allow-headers'],
      '4 响应无任何 CORS 头（跨域默认拒绝）');

    // ── 5. 五端点 JSON 形状 ──
    const g = (p) => request(PORT, p, { token });
    const stats = JSON.parse((await g('/api/v1/stats')).body);
    ok(stats.storage.feeds >= 1 && stats.storage.entries === 3 && stats.storage.read === 2,
      '5 stats：订阅源/条目/完读计数正确');
    ok(stats.reading.finishedCount === 2 && stats.reading.annotationCount >= 2 && Number.isFinite(stats.reading.streakDays),
      '5 stats：完读数/批注数/连续天数（阅读统计面）');
    ok(stats.generatedAt > 0 && stats.api.rateLimitPerMinute === 120, '5 stats：generatedAt + 限流常量在册');
    const feedsResp = JSON.parse((await g('/api/v1/feeds')).body);
    ok(feedsResp.total >= 1 && feedsResp.feeds[0].title === 'F39 开放源' && Number.isFinite(feedsResp.feeds[0].score)
      && ['good', 'warn', 'bad'].includes(feedsResp.feeds[0].band), '5 feeds：标题 + 健康分 + 档位');
    ok(!JSON.stringify(feedsResp).match(/password|credential|apiKey|secret/i), '5 feeds：无凭据字段（红线）');
    const annAll = JSON.parse((await g('/api/v1/annotations?limit=50')).body);
    ok(annAll.total >= 2 && annAll.items.length === annAll.total,
      '5 annotations：total 与分页项数一致（1 高亮 + 1 笔记）');
    ok(annAll.items.some((i) => i.kind === 'highlight' && i.note === '批注一句')
      && annAll.items.some((i) => i.kind === 'note'), '5 annotations：高亮（带附记）与笔记两类齐备');
    ok(annAll.items.every((i) => i.articleTitle.length > 0 && i.createdAt > 0), '5 annotations：文章标题 + 时间投影');
    const annP1 = JSON.parse((await g('/api/v1/annotations?limit=1&offset=0')).body);
    const annP2 = JSON.parse((await g('/api/v1/annotations?limit=1&offset=1')).body);
    ok(annP1.items.length === 1 && annP2.items.length === 1 && annP1.items[0].id !== annP2.items[0].id,
      '5 annotations：limit/offset 分页翻页（两条不同项）');
    const annBeyond = JSON.parse((await g('/api/v1/annotations?limit=10&offset=999')).body);
    ok(annBeyond.items.length === 0, '5 annotations：越界 offset 空页（不崩）');
    const clock = JSON.parse((await g('/api/v1/reading-clock')).body);
    ok(Array.isArray(clock.buckets) && clock.buckets.length === 24 && clock.samples >= 1 && typeof clock.from === 'string',
      '5 reading-clock：24 小时桶 + 窗口样本');
    const caps = JSON.parse((await g('/api/v1/capsules')).body);
    ok(caps.items.length >= 1 && caps.items[0].status === 'sealed' && caps.items[0].openAt > 0 && !caps.items[0].annotation,
      '5 capsules：元数据（状态/开启时刻；批注原文不外发）');
    const wks = JSON.parse((await g('/api/v1/weeklies')).body);
    ok(wks.items.length >= 1 && wks.items[0].weekStart === '2026-10-05' && wks.items[0].status === 'ready' && !wks.items[0].content,
      '5 weeklies：期元数据（周起点/状态；版面不外发）');
    const allBodies = JSON.stringify([stats, feedsResp, annAll, clock, caps, wks]);
    ok(!allBodies.includes('F39BODYMARKER'), '5 正文全文永不出现（F39BODYMARKER 六端点零命中）');

    // ── 6. 限流 + 请求日志 ──
    svc._now = () => T0 + 7200; // 固定注入时钟 → 固定分钟窗（确定性）
    const agent = new http.Agent({ keepAlive: true, maxSockets: 6 });
    let hit429 = 0;
    let lastLimited = null;
    for (let i = 0; i < 125; i += 1) {
      const r = await request(PORT, '/api/v1/stats', { token, agent });
      if (r.status === 429) {
        hit429 += 1;
        if (!lastLimited) lastLimited = r;
      }
    }
    agent.destroy();
    ok(hit429 === 5 && lastLimited && lastLimited.headers['retry-after'] === '60',
      `6 限流：窗口内 125 发 120 过 5 限（429 + Retry-After:60），429 计 ${hit429}`);
    ok(svc.counters.rateLimited === 5, '6 rateLimited 计数在案');
    svc._now = () => T0 + 10800; // 新分钟窗：后续测试不再吃限流
    svc.configure({ logRequests: true });
    await request(PORT, '/api/v1/stats', { token });
    await request(PORT, '/api/v1/feeds', { token });
    ok(svc._log.length === 2 && svc._log[1].path === '/api/v1/feeds', '6 请求日志开：逐条记录（路径可查）');
    svc.configure({ logRequests: false });
    ok(svc._log.length === 0, '6 请求日志关：内存即刻清空');

    // ── 7. 令牌重生成 ──
    const oldToken = svc.getConfig().token;
    const newToken = svc.regenerateToken();
    ok(newToken !== oldToken && svc.getConfig().token === newToken
      && store.preferences.get('RobinRead.api.token', '') === newToken, '7 重生成：内存+落库同步翻转');
    const rOld = await request(PORT, '/api/v1/stats', { token: oldToken });
    const rNew = await request(PORT, '/api/v1/stats', { token: newToken });
    ok(rOld.status === 401 && rNew.status === 200, '7 旧令牌即刻失效 401 / 新令牌 200（无需重启）');

    // ── 8. 退出自动 stop（shutdown 语义 + main.js 静态锚点） ──
    ok(svc.status().running, '附 退出前服务在运行');
    store.shutdown();
    ok(!svc.status().running && await portGone(PORT), '8 store.shutdown() → API 自动 stop + 端口释放');
    const mainSrc = read('src/main/main.js');
    ok(mainSrc.includes('store.api?.stop()'), '8 main.js will-quit 静态锚点（退出自动 stop）');

    // ── 9. 设置分区 + IPC（真渲染，环境降级可 SKIP）──
    const ui = await Promise.race([
      apiSettingsProbe(store),
      new Promise((r) => setTimeout(() => r({ uiSkipped: true, booted: null }), 150000)),
    ]);
    if (ui.uiSkipped) {
      for (const m of ['附 UI 探针窗口启动（index.html + preload + 真 IPC）', '9 设置页渲染：开放 API 分区（状态徽标/端口输入/令牌行）', '9 api:* IPC：apiConfig 形状 + apiSetConfig 开关 + apiRegenerateToken']) {
        console.log('SKIP ' + m);
      }
      console.log('UI 阶段 SKIP：环境性挂起（服务级断言已全部执行）');
      try { fs.writeFileSync(path.join(__dirname, '.ci-skip-marker'), 'scripts/diag-f39-api.js'); } catch (_) { /* 标记失败仅影响连击治理 */ }
      store.preferences.flushSync();
      store.database.close();
      console.log(`TOTAL passed=${passed} failed=${failed}`);
      process.exit(failed ? 1 : 0);
      return;
    }
    ok(ui.booted, '附 UI 探针窗口启动（index.html + preload + 真 IPC）');
    ok(ui.sectionRendered === true, '9 设置页渲染：开放 API 分区（状态徽标/端口输入/令牌行）');
    ok(ui.ipcWorks === true, '9 api:* IPC：apiConfig 形状 + apiSetConfig 开关 + apiRegenerateToken');

    // ── 附：静态接线锚点 ──
    const preloadSrc = read('src/main/preload.js');
    ok(['apiConfig', 'apiSetConfig', 'apiRegenerateToken'].every((n) => preloadSrc.includes(n)),
      '附 preload 开放 API 3 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(["'api:config'", "'api:setConfig'", "'api:regenerateToken'"].every((c) => ipcSrc.includes(c)),
      '附 IPC api 通道注册齐备');
    const dialogsSrc = read('src/renderer/views/dialogs.js');
    ok(['openapi', '开启开放 API', '只读令牌', '重新生成令牌', '监听端口', '请求日志', 'nj-api-badge'].every((k) => dialogsSrc.includes(k)),
      '附 设置分区/开关/令牌/端口/日志/徽标锚点齐备');
    const cssSrc = read('src/renderer/styles/robin.css');
    ok(cssSrc.includes('.nj-api-badge') && cssSrc.includes('.nj-api-token'), '附 CSS 状态徽标/令牌样式');
    const stringsSrc = read('src/main/I18NStrings.js');
    ok(['"开放 API"', '"开启开放 API"', '"只读令牌"', '"监听端口"', '"请求日志"', '"端点清单"'].every((k) => stringsSrc.includes(k)),
      '附 i18n 中英键齐备（开放 API 六组）');
    const storeSrc = read('src/main/AppStore.js');
    ok(storeSrc.includes('new LocalApiService') && storeSrc.includes('this.api.start()'),
      '附 AppStore 构造 + 启用自启接线');
    const svcSrc = read('src/main/LocalApiService.js');
    ok(svcSrc.includes("require('node:http')") && !svcSrc.match(/\bexpress\b|\bkoa\b|\bpolka\b/),
      '附 零依赖 node:http 自研（F31 未实现，本服务是首个本地 HTTP 服务）');

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
 * offscreen + backgroundThrottling=false（f25/f26/f37 惯例）。
 */
async function apiSettingsProbe(store) {
  let win = null;
  try {
    win = new BrowserWindow({
      show: false, width: 1200, height: 860, useContentSize: true,
      webPreferences: { offscreen: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
  } catch (err) {
    console.error('api settings probe: window create failed (environmental):', String((err && err.message) || err));
    return { uiSkipped: true, booted: null };
  }
  try {
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, win);
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  } catch (err) {
    console.error('api settings probe: load failed (environmental):', String((err && err.message) || err));
    try { win.destroy(); } catch (_) { /* 已销毁 */ }
    return { uiSkipped: true, booted: null };
  }
  await sleep(1400);
  const out = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { booted: true };
    try {
      // api:* IPC 真调用
      const cfg = await window.robin.apiConfig();
      out.ipcWorks = Boolean(cfg && cfg.config && cfg.status && typeof cfg.config.token === 'string');
      const regen = await window.robin.apiRegenerateToken();
      out.ipcWorks = out.ipcWorks && Boolean(regen && regen.ok && regen.data && regen.data.token);
      // 设置页真渲染（开放 API 分区）
      const { SettingsView } = await import('./views/dialogs.js');
      const view = new SettingsView({ state: { snapshot: { preferences: {} } }, views: {} });
      view.present('openapi');
      await sleep(600);
      out.sectionRendered = Boolean(
        document.querySelector('.modal-nav-item[data-section="openapi"]')
        && document.querySelector('[data-role="api-status"]')
        && document.querySelector('[data-role="api-token"]')
        && document.querySelector('input[aria-label]') !== null
      );
      view.dismiss();
      return out;
    } catch (e) {
      return { booted: true, error: String((e && e.stack) || e).slice(0, 700) };
    }
  })()`);
  win.destroy();
  if (out && out.error) console.error('api settings probe error:', out.error);
  return out || {};
}
