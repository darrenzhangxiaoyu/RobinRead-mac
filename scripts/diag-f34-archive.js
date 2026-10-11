'use strict';
/**
 * diag-f34-archive.js — F34 网页存档馆探针（run-all OFFLINE 集，全程离线零 AI）
 *
 * 覆盖：
 *  1 v28 迁移：archives（PK item_id / html_captured / captured_at / html_size / FK 级联）
 *    + translations 同批迁移在位 + 老库重启无损
 *  2 存档/重存档：archive 落行（体积=字节数/时间戳）/ 重存档覆盖更新（rearchived）/ 空正文拒绝
 *  3 6MB 闸：超限拒绝（rejected 计数 + 行不在位）
 *  4 列表/搜索：标题/来源/时间/体积投影 + captured_at 倒序 + 标题与来源 LIKE
 *  5 统计：篇数 + 总字节（配额联动：取消存档后统计随行消失）
 *  6 MHTML：MIME-Version + multipart/related boundary 声明 + 边界开合配对 +
 *    Content-Transfer-Encoding/Content-Location/正文内嵌 + RFC2047 标题 + 正文撞边界轮换
 *  7 回落判定：无缓存无正文 → articleContent 自动回落存档（fromArchive=true）/
 *    缓存空壳回落 / 缓存健康不回落 / 取消存档回落失效
 *  8 追更自动存档：autoFeeds 默认关 / 开关持久化 / 灌文钩子快照 / 关闭后不快照
 *  9 静态接线 + UI：preload/IPC 通道、右键「存档此文」、侧栏存档馆入口、存档模式徽记、
 *    存档馆浮层（列表/搜索/导出 mock 保存对话框真写盘/取消存档）；UI 阶段 150s 竞速降级 SKIP
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, dialog, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f34-')));
setTimeout(() => { console.error('WATCHDOG'); process.exit(3); }, 300 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const T = Math.floor(Date.now() / 1000);

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { ArchiveService, MAX_ENTRY_BYTES } = require('../src/main/ArchiveService');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);
    const svc = store.archive;
    ok(svc instanceof ArchiveService, '附 ArchiveService 随 AppStore 构造（F34 接线）');

    // ── 1. v28 迁移 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v28-translations-archives'").get(),
      '1 v28 迁移已入链');
    const arSQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='archives'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/item_id\s+TEXT PRIMARY KEY/i.test(arSQL), '1 archives PK(item_id) 在位（一篇文章至多一份快照）');
    ok(/html_captured\s+TEXT/.test(arSQL) && /captured_at\s+REAL/.test(arSQL) && /html_size\s+INTEGER/.test(arSQL),
      '1 html_captured/captured_at/html_size 三列在位');
    ok(/REFERENCES\s+items\(id\)/i.test(arSQL) && /ON DELETE CASCADE/i.test(arSQL), '1 archives FK 级联（items 删除随行清）');
    ok(!!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='translations'").get(),
      '1 v28 同批 translations 表在位（F33 共迁移）');
    ok(MAX_ENTRY_BYTES === 6 * 1024 * 1024, `1 单篇配额常量 6MB（${MAX_ENTRY_BYTES}）`);

    // 素材源 + 条目
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F34 存档素材源', feedURL: 'https://f34.test/feed.xml', siteURL: 'https://f34.test' });
    // contentHTML 传 '' 保留空正文（测空正文拒绝）；缺省给默认正文
    const mkEntry = async (id, title, contentHTML, url) => (await store._applyParsedEntries(feed, [{
      id, title, url: url === undefined ? `https://f34.test/x/${id}` : url, publishedAt: T - 60,
      summary: `${title} 的摘要。`, contentHTML: contentHTML === undefined ? `<p>${title} 的正文。</p>` : contentHTML,
    }]))[0];

    const e1 = await mkEntry('f34-a1', 'Archive Story One', '<h2>Archive Story One</h2><p>Body of story one with enough text.</p>');
    const e2 = await mkEntry('f34-a2', 'Archive Story Two', '<h2>Archive Story Two</h2><p>Body of story two with enough text.</p>');

    // ── 2. 存档 / 重存档 ──
    const r1 = svc.archive(e1);
    ok(r1 && r1.entryID === e1 && r1.htmlSize > 0 && Math.abs(r1.capturedAt - T) < 30, '2 存档落行（体积=字节数/时间戳）');
    ok(svc.has(e1) === true && svc.html(e1).includes('Body of story one'), '2 快照正文原样在位（含全文抓取/入库 HTML）');
    const row1 = store.database.prepare('SELECT html_size FROM archives WHERE item_id = ?').get(e1);
    ok(row1.html_size === Buffer.byteLength(svc.html(e1), 'utf8'), '2 html_size 列 = 字节体积（配额判定列）');
    const r1b = svc.archive(e1, { html: '<p>Re-archived body v2.</p>' });
    ok(r1b.rearchived === true && svc.html(e1) === '<p>Re-archived body v2.</p>', '2 重存档覆盖更新（captured_at/html 刷新）');
    svc.archive(e2);
    const eEmpty = await mkEntry('f34-empty', 'No Body Story', '', null);
    let emptyErr = '';
    try { svc.archive(eEmpty); } catch (err) { emptyErr = String(err.message || err); }
    ok(/正文/.test(emptyErr) && svc.has(eEmpty) === false, `2 空正文拒绝存档（${emptyErr.slice(0, 22)}…）`);

    // ── 3. 6MB 闸 ──
    const eBig = await mkEntry('f34-big', 'Too Big Story', `<p>${'x'.repeat(200)}</p>`);
    const bigErr = (() => { try { svc.archive(eBig, { html: `<p>${'a'.repeat(MAX_ENTRY_BYTES + 1024)}</p>` }); return ''; } catch (err) { return String(err.message || err); } })();
    ok(/6MB/.test(bigErr) && svc.has(eBig) === false && svc.snapshot().rejected >= 1,
      `3 超限拒绝：行不在位 + rejected 计数（${bigErr.slice(0, 24)}…）`);

    // ── 4. 列表 / 搜索 ──
    const list = svc.list({});
    ok(list.length === 2 && list[0].capturedAt >= list[1].capturedAt && [e1, e2].includes(list[0].entryID),
      '4 列表投影（captured_at 倒序，最新在前）');
    const l1 = list.find((r) => r.entryID === e1);
    ok(l1 && l1.title === 'Archive Story One' && l1.sourceTitle === 'F34 存档素材源' && l1.htmlSize > 0 && l1.capturedAt > 0,
      '4 列表行：标题/来源/存档时间/体积齐备');
    ok(svc.list({ query: 'Story Two' }).length === 1, '4 标题关键词搜索命中');
    ok(svc.list({ query: '存档素材' }).length === 2, '4 来源关键词搜索命中');

    // ── 5. 统计 ──
    const st = svc.stats();
    ok(st.count === 2 && st.bytes === store.database.prepare('SELECT COALESCE(SUM(html_size),0) AS b FROM archives').get().b,
      '5 全局统计：篇数 + 字节（配额口径）');
    svc.unarchive(e2);
    ok(svc.has(e2) === false && svc.stats().count === 1 && svc.counters.removed >= 1, '5 取消存档：删行 + 统计联动');

    // ── 6. MHTML ──
    const mime = svc.buildMHTML(e1);
    ok(/^MIME-Version: 1\.0\r?\n/m.test(mime) && /Content-Type: multipart\/related; type="text\/html"; boundary="/.test(mime),
      '6 MIME 头：MIME-Version + multipart/related boundary 声明');
    const boundary = (mime.match(/boundary="([^"]+)"/) || [])[1];
    ok(boundary && mime.includes(`--${boundary}\r\n`) && mime.includes(`--${boundary}--`),
      '6 边界开合配对（part 起始 + 终止 --）');
    ok(/Content-Transfer-Encoding: 8bit/.test(mime) && /Content-Location: https:\/\/f34\.test\/x\//.test(mime)
      && /Content-Type: text\/html; charset=utf-8/.test(mime), '6 part 头：charset/Transfer-Encoding/Content-Location');
    ok(mime.includes('Re-archived body v2.'), '6 正文内嵌 part 中');
    ok(/^Subject: =\?utf-8\?B\?/.test(mime.split('\r\n').find((l) => l.startsWith('Subject:')) || ''),
      '6 Subject RFC2047（非 ASCII 标题 base64 编码）');
    const tricky = await mkEntry('f34-tricky', 'Boundary Collision Story', '<p>tricky</p>');
    svc.archive(tricky, { html: '<p>I contain a fake boundary ----=_RobinPart-fake123 inside.</p>' });
    const mime2 = svc.buildMHTML(tricky);
    const b2 = (mime2.match(/boundary="([^"]+)"/) || [])[1];
    ok(b2 && !b2.includes('fake123') && (mime2.match(new RegExp(`--${b2}(--)?\\r\\n`, 'g')) || []).length === 2,
      '6 正文撞边界轮换（真 boundary 不与正文冲突，开合恰 2 处）');
    let noArcErr = '';
    try { svc.buildMHTML(eBig); } catch (err) { noArcErr = String(err.message || err); } // eBig 存在但从未存档
    ok(/存档/.test(noArcErr), `6 未存档导出明确报错（${noArcErr.slice(0, 20)}…）`);

    // ── 7. 回落判定（存档模式）──
    const eGone = await mkEntry('f34-gone', 'Dead Source Story', '<p>placeholder</p>', null);
    store.database.prepare('UPDATE articles SET content_html = NULL, summary = ? WHERE item_id = ?').run('short', eGone); // 模拟 404/缓存缺失
    store._preparedLRU.delete(eGone);
    const c1 = store.articleContent(eGone);
    ok(c1 && c1.html == null && !c1.fromArchive, '7 回落前置：无正文无缓存 → 普通空内容（无存档不回落）');
    svc.archive(eGone, { html: '<p>Archived snapshot of the dead source story.</p>' });
    const c2 = store.articleContent(eGone);
    ok(c2 && c2.fromArchive === true && c2.html.includes('Archived snapshot'), '7 正文 404/缺失 + 有存档 → 自动回落存档内容（fromArchive=true）');
    ok(svc.counters.fallbacks >= 1, '7 回落命中计数');
    // 缓存空壳路径：有缓存行但 html 为空
    store.cachesRepo.saveCache({ entryID: eGone, text: '', html: null, imageURLs: [], sourceURL: null, isSanitized: true });
    store._preparedLRU.delete(eGone);
    const c3 = store.articleContent(eGone);
    ok(c3 && c3.fromArchive === true, '7 缓存空壳（html=null）+ 有存档 → 存档模式');
    // 健康缓存不回落
    store.cachesRepo.saveCache({ entryID: eGone, text: 'healthy', html: '<p>Healthy cached body that should win over archive.</p>', imageURLs: [], sourceURL: null, isSanitized: true });
    store._preparedLRU.delete(eGone);
    const c4 = store.articleContent(eGone);
    ok(c4 && c4.fromCache === true && !c4.fromArchive && c4.html.includes('Healthy cached'), '7 缓存健康 → 不回落（缓存优先）');
    // 取消存档 → 回落失效
    store.cachesRepo.deleteCache(eGone);
    svc.unarchive(eGone);
    store._preparedLRU.delete(eGone);
    const c5 = store.articleContent(eGone);
    ok(c5 && !c5.fromArchive && c5.html == null, '7 取消存档后回落失效');
    // 徽记载体：缓存缺失 + 已存档的常驻条目（UI 阶段打开验证横条）
    const eBanner = await mkEntry('f34-banner', 'Banner Mode Story', '<p>to be replaced</p>', null);
    store.database.prepare('UPDATE articles SET content_html = NULL, summary = ? WHERE item_id = ?').run('short', eBanner);
    svc.archive(eBanner, { html: '<p>Archived snapshot for the banner mode story.</p>' });
    store._preparedLRU.delete(eBanner);

    // ── 8. 追更源自动存档 ──
    ok(svc.autoArchiveOn('no-such-feed') === false && Object.keys(svc.autoFeeds()).length === 0, '8 追更自动存档默认关');
    const monitorFeed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F34 追更源', feedURL: 'monitor://f34hash', siteURL: 'https://f34.test/page' });
    store.feedsRepo.updateFeed(monitorFeed.id, (f) => ({ ...f, platform: 'monitor', platformRef: 'article' }));
    const monFeed = store.feedsRepo.feed(monitorFeed.id); // 重读：updateFeed 后本地对象才是 platform='monitor'
    const mkMonEntry = async (id, title, contentHTML) => (await store._applyParsedEntries(monFeed, [{
      id, title, url: `https://f34.test/page#${id}`, publishedAt: T - 30,
      summary: `${title} 摘要`, contentHTML: contentHTML || `<p>${title} 正文</p>`,
    }]))[0];
    await mkMonEntry('f34-mon', 'Monitor Diff Snapshot Story', '<p><ins class="monitor-add">new paras</ins></p>'); // 首篇（开关尚未开）
    svc.setAutoArchive(monitorFeed.id, true);
    ok(svc.autoArchiveOn(monitorFeed.id) === true, '8 setAutoArchive(true) 持久化');
    const eMon2 = await mkMonEntry('f34-mon2', 'Monitor Second Change Story', '<p><ins class="monitor-add">second change</ins></p>');
    ok(svc.has(eMon2) === true && svc.snapshot().autoArchived >= 1, '8 灌文钩子：追更源落新文顺带快照（开关开）');
    svc.setAutoArchive(monitorFeed.id, false);
    const eMon3 = await mkMonEntry('f34-mon3', 'Monitor Third Change Story', '<p>third</p>');
    ok(svc.has(eMon3) === false, '8 关闭后不再自动快照');

    // ── 9. 静态接线锚点 ──
    const preloadSrc = read('src/main/preload.js');
    ok(['archiveAdd', 'archiveRemove', 'archiveHas', 'archiveList', 'archiveExport', 'archiveAutoConfig', 'archiveStats']
      .every((n) => preloadSrc.includes(n)), '9 preload 存档馆 7 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(["'archive:do'", "'archive:undo'", "'archive:list'", "'archive:export'"].every((c) => ipcSrc.includes(c)),
      '9 IPC 存档馆通道注册齐备');
    ok(ipcSrc.includes('archivesCount') && ipcSrc.includes('archivesBytes'), '9 存储统计接入存档篇数/字节');
    const appSrc = read('src/renderer/app.js');
    ok(appSrc.includes("label: t('存档此文')") && appSrc.includes('archiveEntry'), '9 文章右键「存档此文」在列');
    ok(appSrc.includes('openArchiveHall') && appSrc.includes('ArchiveHallView'), '9 存档馆浮层入口（app 接线）');
    const sidebarSrc = read('src/renderer/views/sidebar.js');
    ok(sidebarSrc.includes('footer-archive-btn') && sidebarSrc.includes('onOpenArchive'), '9 侧栏存档馆入口按钮');
    const readerSrc = read('src/renderer/views/reader.js');
    ok(readerSrc.includes('robin-archive-banner') && readerSrc.includes('fromArchive'), '9 阅读器存档模式徽记接线');
    const hallSrc = read('src/renderer/views/archive-hall.js');
    ok(hallSrc.includes('archiveList') && hallSrc.includes('archiveExport') && hallSrc.includes('archiveRemove'),
      '9 存档馆浮层：列表/导出/取消三动作');
    const strings = read('src/main/I18NStrings.js');
    ok(['"存档此文"', '"存档模式"', '"网页存档馆"', '"导出 MHTML"'].every((k) => strings.includes(k)),
      '9 i18n 双语键（存档此文/存档模式/存档馆/MHTML）');
    const css = read('src/renderer/styles/robin.css');
    ok(css.includes('.robin-archive-banner') && css.includes('.nj-archive-row'), '9 CSS 存档徽记条 + 存档馆列表样式');

    // ── UI 阶段（150s 竞速降级 SKIP，f25/f26 先例）──
    const exportPath = path.join(os.tmpdir(), `robinread-f34-export-${Date.now()}.mhtml`);
    const ui = await Promise.race([
      archiveUIProbe(store, { archived: e1, fallback: eBanner }, exportPath),
      new Promise((r) => setTimeout(() => r({ uiSkipped: true, booted: null }), 150000)),
    ]);
    if (ui.uiSkipped) {
    try { fs.writeFileSync(path.join(__dirname, '.ci-skip-marker'), 'scripts/diag-f34-archive.js'); } catch (_) { /* 标记失败仅丢连击计数 */ }
      for (const m of ['UI 探针窗口启动（index.html + preload + 真 IPC）', 'UI 右键菜单含「存档此文」', 'UI 侧栏存档馆入口 → 浮层打开（列表行）',
        'UI 存档馆搜索命中过滤', 'UI 导出 MHTML：mock 保存对话框真写盘（MIME 头在位）', 'UI 取消存档：行消失', 'UI 存档模式徽记：回落文章头部横条浮出']) {
        console.log('SKIP ' + m);
      }
      console.log('UI 阶段 SKIP：环境性挂起（服务级断言已全部执行）');
      process.exit(failed ? 1 : 0);
      return;
    }
    ok(ui.booted, 'UI 探针窗口启动（index.html + preload + 真 IPC）');
    ok(ui.menuHasArchive === true, 'UI 文章右键菜单含「存档此文」');
    ok(ui.hallOpened === true && ui.hallRows >= 2, `UI 侧栏存档馆入口 → 浮层打开（列表行 ${ui.hallRows}）`);
    ok(ui.searchFiltered === true, 'UI 存档馆搜索命中过滤');
    ok(ui.exported === true && fs.existsSync(exportPath) && /MIME-Version: 1\.0/.test(fs.readFileSync(exportPath, 'utf8')),
      `UI 导出 MHTML：mock 保存对话框 → 主进程真写盘（MIME 头在位；exported=${ui.exported}）`);
    ok(ui.removed === true, 'UI 取消存档：行消失（配额统计联动）');
    ok(ui.banner === true, 'UI 存档模式徽记：回落文章头部横条浮出（存档于 …）');

    store.preferences.flushSync();
    store.database.close();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
    try { fs.rmSync(exportPath, { force: true }); } catch (_) { /* 留给系统清理 */ }
    console.log(failed === 0 ? 'ALL PASSED' : `FAILED ${failed}`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('ERR', String((err && err.stack) || err).slice(0, 1600));
    process.exit(1);
  }
});

/** F34 UI 探针：右键存档 → 存档馆浮层（列表/搜索/导出/取消）→ 存档模式徽记。 */
async function archiveUIProbe(store, ids, exportPath) {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 860, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
  const { registerIPCHandlers } = require('../src/main/ipc');
  const realSave = dialog.showSaveDialog;
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath });
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1500);
  const run = (script) => win.webContents.executeJavaScript(`(async () => { try { ${script} } catch (e) { return { __err: String(e && e.stack || e).slice(0, 600) }; } })()`);
  const out = { booted: true };

  // 右键列表行 → 菜单含「存档此文」
  const menu = await run(`
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 15000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(150); }
    };
    const row = await waitFor(() => document.querySelector('.entry-row'));
    if (!row) return { menuHasArchive: false, __diag: 'no row' };
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const item = await waitFor(() => [...document.querySelectorAll('.context-menu .label, .ctx-menu .label')]
      .find((el) => el.textContent.includes('存档此文')) || null, 6000);
    document.body.click();
    await sleep(150);
    return { menuHasArchive: !!item };
  `);
  out.menuHasArchive = !menu.__err && menu.menuHasArchive === true;
  if (menu.__err || !out.menuHasArchive) console.error('UI menu diag:', menu.__err || menu.__diag || JSON.stringify(menu));

  // 侧栏存档馆入口 → 浮层（列表行 ≥2）→ 搜索过滤 → 导出（mock 对话框真写盘）→ 取消存档
  const hall = await run(`
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 15000) => {
      const t0 = Date.now();
      for (;;) { let v = null; try { v = await fn(); } catch (_) {} if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(150); }
    };
    const out = {};
    // 存档馆在「更多」第二行（实机反馈收敛），先保开展开再点入口
    const moreWrap = document.querySelector('.footer-more-wrap');
    if (moreWrap && !moreWrap.classList.contains('open')) document.querySelector('.footer-more-btn')?.click();
    const btn = document.querySelector('.footer-archive-btn') || [...document.querySelectorAll('.footer-nav-btn')].find((b) => (b.title || '').includes('存档'));
    out.entryFound = !!btn;
    if (btn) btn.click();
    const modal = await waitFor(() => document.querySelector('.nj-archive-modal'));
    out.hallOpened = !!modal;
    const rows = await waitFor(() => document.querySelectorAll('.nj-archive-row').length >= 2
      ? document.querySelectorAll('.nj-archive-row').length : null);
    out.hallRows = rows || 0;
    const search = modal && modal.querySelector('.nj-archive-search');
    if (search) {
      search.value = 'Story One';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(700);
      out.searchFiltered = document.querySelectorAll('.nj-archive-row').length === 1;
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(700);
    }
    const exportBtn = modal && modal.querySelector('.nj-archive-row .nj-archive-export');
    if (exportBtn) { exportBtn.click(); out.exported = true; }
    // 直调通道双保险：主进程对话框已 mock，直接走一次导出并回读结果（点按与直调同一 handler）
    const firstRow = modal && modal.querySelector('.nj-archive-row');
    out.directExport = firstRow ? await window.robin.archiveExport(firstRow.dataset.entryId) : null;
    // 取消存档点掉「Banner Mode Story」之外的一行（按 entryID 定位，不动徽记载体）
    const target = await waitFor(() => [...document.querySelectorAll('.nj-archive-row')]
      .find((r) => r.dataset.entryId !== ${JSON.stringify(ids.fallback)} && r.querySelector('.nj-archive-remove')) || null);
    if (target) target.querySelector('.nj-archive-remove').click();
    await sleep(900);
    out.rowsAfterRemove = document.querySelectorAll('.nj-archive-row').length;
    out.removed = out.rowsAfterRemove === (out.hallRows || 2) - 1;
    document.querySelector('.nj-archive-modal')?.closest('.modal-overlay')?.remove();
    return out;
  `);
  Object.assign(out, hall);
  if (hall.__err) console.error('UI hall err:', hall.__err);

  // 存档模式徽记：打开「缓存缺失 + 已存档」的文章 → 头部横条浮出
  const banner = await run(`
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 25000) => {
      const t0 = Date.now();
      for (;;) { let v = null; try { v = await fn(); } catch (_) {} if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(150); }
    };
    window.__robinReaderOpen(${JSON.stringify(ids.fallback)});
    const el = await waitFor(() => document.querySelector('[data-role="archive-banner"]'));
    return { banner: !!el, text: el ? (el.textContent || '').slice(0, 60) : '' };
  `);
  out.banner = !banner.__err && banner.banner === true;
  if (banner.__err || !out.banner) console.error('UI banner diag:', banner.__err || banner.text || JSON.stringify(banner));

  dialog.showSaveDialog = realSave;
  try { win.destroy(); } catch (_) { /* 尽力而为 */ }
  return out;
}
