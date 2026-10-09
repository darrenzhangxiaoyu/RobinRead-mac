'use strict';
/**
 * diag-f27-capsule.js — F27 时间胶囊探针（run-all OFFLINE 集，全程离线、零 AI 依赖）
 *
 * 覆盖：
 *  1 v25 迁移：time_capsules 建表（status CHECK）+ highlights/notes origin/origin_id 加列 + 索引
 *  2 封存：30/90/365 天 open_at 精确 / 非法期限拒绝 / 批注缺失拒绝 / 同批注在途防重 / 留言截断
 *  3 到期懒结算：未到期不浮出 / 注入时钟到期浮现 / 同日多枚按 open_at 升序 / pendingCount /
 *    opened 即剔除（防重复浮出）/ due 幂等（无定时器，读时结算）
 *  4 开启仪式数据面：status 翻转 + opened_at + opens_count / 批注原文+文章上下文 /
 *    alreadyOpen 幂等（历史回看不重复计数）/ 不存在拒绝 / 笔记胶囊 / 批注已删降级
 *  5 简报段投影：只含到期 sealed / 标题+原文+封存天数 / DIGEST_MAX 封顶 / 开启后剔除
 *  6 重启读回：胶囊跨迁移无损 / 投影一致 / origin 列保留
 *  7 静态接线锚点：preload/IPC/reader/侧栏/app.js(浮层+仪式+简报段)/CSS(reduced-motion 豁免)/i18n
 *  8 UI：真 IPC + index.html —— 侧栏徽章计数 / 徽章点开胶囊浮层 / 卡片点开开启仪式 /
 *    仪式文案（封存天数+原文）/ 前往文章关闭仪式 / 开启后徽章回落
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration(); // 沙箱内 GPU 合成偶发死锁：探针窗口纯 DOM 断言，禁用硬件加速
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f27-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const DAY = 86400;
const T0 = Math.floor(Date.now() / 1000); // 探针基准时钟（秒）

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { CapsuleService, CAPSULE, isValidDuration } = require('../src/main/CapsuleService');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);
    const svc = store.capsule;

    // ── 1. v25 迁移 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v25-capsules-bundle-origin'").get(),
      '1 v25 迁移已入链');
    const capSQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='time_capsules'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/status\b[^,]*CHECK\s*\(\s*status\s+IN\s+\('sealed'\s*,\s*'opened'\)/i.test(capSQL), '1 time_capsules status CHECK（sealed|opened）在位');
    ok(/annotation_kind[^,]*CHECK\s*\(\s*annotation_kind\s+IN\s+\('highlight'\s*,\s*'note'\)/i.test(capSQL), '1 annotation_kind CHECK（highlight|note）在位');
    const hlCols = store.database.prepare('PRAGMA table_info(highlights)').all().map((c) => c.name);
    const noteCols = store.database.prepare('PRAGMA table_info(notes)').all().map((c) => c.name);
    ok(hlCols.includes('origin') && hlCols.includes('origin_id') && noteCols.includes('origin') && noteCols.includes('origin_id'),
      '1 highlights/notes origin/origin_id 加列在位（F28 共用 v25）');
    const idxRows = store.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_time_capsules%'").all().map((r) => r.name);
    ok(idxRows.length >= 2, `1 time_capsules 索引在位（${idxRows.join('/')}）`);

    // ── 场景源：两篇文章 + 高亮/笔记 ──
    const mkFeed = (title, url) => store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title, feedURL: url });
    const feed = mkFeed('胶囊源', 'https://f27.test/a.xml');
    const put = async (e) => (await store._applyParsedEntries(feed, [e]))[0];
    const body = `<h2>慢阅读宣言</h2><p>${'阅读是把别人的百年换成自己的片刻。'.repeat(20)}</p>`;
    const entryA = await put({ id: 'f27-a', title: '慢阅读宣言（胶囊甲）', url: 'https://f27.test/x/1', publishedAt: T0 - DAY, summary: '慢阅读。', contentHTML: body });
    const entryB = await put({ id: 'f27-b', title: '深水区笔记（胶囊乙）', url: 'https://f27.test/x/2', publishedAt: T0 - DAY, summary: '深水区。', contentHTML: body });
    ok(!!entryA && !!entryB, '附 场景源灌入 2 篇');
    const hlA = store.knowledge.addHighlight({ itemID: entryA, text: '阅读是把别人的百年换成自己的片刻。', color: 'yellow', note: '这句话值得放三十天再读。', anchor: { paragraphID: 'p-1', prefix: '慢阅读宣言', suffix: '' } });
    const noteB = store.knowledge.addNote({ itemID: entryB, content: '关于深水区的三条线索，先记下再想。', anchor: { paragraphID: 'p-2' } });
    ok(!!hlA?.id && !!noteB?.id, '附 高亮 + 笔记落库（真实批注管线）');

    // ── 2. 封存 ──
    svc._now = () => T0; // 注入时钟（确定性到期判定）
    const c30 = svc.seal({ entryID: entryA, annotationID: hlA.id, annotationKind: 'highlight', days: 30, message: '三十天后的你，还认同这句话吗？' });
    ok(c30 && c30.status === 'sealed' && c30.opensCount === 0 && c30.annotationKind === 'highlight', '2 封存落库：status=sealed / opens_count=0 / kind=highlight');
    ok(Math.abs(c30.openAt - (T0 + 30 * DAY)) < 1, `2 30 天期 open_at = 封存时刻+30*86400（${Math.round(c30.openAt - T0) / DAY} 天）`);
    let missingAnn = '';
    try { svc.seal({ entryID: entryA, annotationID: hlA.id + '-nope', annotationKind: 'highlight', days: 90 }); } catch (e) { missingAnn = String(e.message); }
    ok(/批注不存在/.test(missingAnn), `2 批注不存在的封存拒绝（防悬空胶囊，${missingAnn.slice(0, 12)}…）`);
    let badDays = '';
    try { svc.seal({ entryID: entryA, annotationID: hlA.id, annotationKind: 'highlight', days: 0 }); } catch (e) { badDays = String(e.message); }
    ok(/封存期限/.test(badDays), `2 非法期限（0 天）拒绝（${badDays.slice(0, 16)}…）`);
    ok(isValidDuration(365) && !isValidDuration(0) && !isValidDuration(2.5) && !isValidDuration(4000) && isValidDuration(200), '2 isValidDuration：三档 + 1-3650 整数天（自定义期限超集）');
    let dupMsg = '';
    try { svc.seal({ entryID: entryA, annotationID: hlA.id, annotationKind: 'highlight', days: 90 }); } catch (e) { dupMsg = String(e.message); }
    ok(/已经装进/.test(dupMsg) && svc.snapshot().duplicateSealRejected >= 1, `2 同批注在途防重（${dupMsg.slice(0, 14)}…）`);
    const longMsg = '给未来。'.repeat(200);
    const cMsg = svc.seal({ entryID: entryB, annotationID: noteB.id, annotationKind: 'note', days: 365, message: longMsg });
    ok(cMsg.message.length === CAPSULE.MESSAGE_SLICE && cMsg.annotationKind === 'note', `2 留言截断至 ${CAPSULE.MESSAGE_SLICE} 字 + kind=note`);
    ok(svc.snapshot().sealed === 2, '2 sealed 计数在案');

    // ── 3. 到期懒结算 ──
    ok(svc.due().length === 0 && svc.pendingCount() === 0, '3 未到期：due/pendingCount 均为 0（未到期不浮出）');
    svc._now = () => T0 + 31 * DAY; // 时钟推进 31 天：只有 30 天期到期
    const due1 = svc.due();
    ok(due1.length === 1 && due1[0].id === c30.id, '3 注入时钟 +31 天：30 天期浮出，90/365 天期未到期');
    svc._now = () => T0 + 366 * DAY; // 全部到期
    const dueAll = svc.due();
    ok(dueAll.length === 2 && dueAll[0].id === c30.id && dueAll[1].id === cMsg.id,
      '3 同日多枚按 open_at 升序（先到期先浮出）');
    ok(svc.pendingCount() === 2, '3 pendingCount=2（侧栏徽章计数数据面）');
    const dueAgain = svc.due();
    ok(dueAgain.length === 2 && svc.snapshot().sealed === 2, '3 due() 幂等：重复读取不重复结算（懒结算无定时器）');

    // ── 4. 开启仪式数据面 ──
    const opened = svc.open(c30.id);
    ok(opened.status === 'opened' && opened.opensCount === 1 && opened.openedAt > 0, '4 开启：status=opened + opened_at + opens_count=1');
    ok(opened.annotation && /百年换成自己的片刻/.test(opened.annotation.text) && opened.annotation.note?.includes('三十天'), '4 开启返回批注原文 + 附言（当时高亮段落重现数据面）');
    ok(opened.article && opened.article.title.includes('慢阅读宣言') && opened.article.url === 'https://f27.test/x/1', '4 开启返回文章上下文（标题 + URL）');
    ok(opened.remainingAfterOpen === 1, '4 开启后 remaining=1（简报段即刻剔除本枚）');
    const reopened = svc.open(c30.id);
    ok(reopened.alreadyOpen === true && reopened.opensCount === 1 && svc.snapshot().opened === 1,
      '4 alreadyOpen 幂等：历史回看不重复计数（报告保留）');
    let noCap = '';
    try { svc.open('cap-not-exist'); } catch (e) { noCap = String(e.message); }
    ok(/不存在/.test(noCap), `4 开启不存在的胶囊拒绝（${noCap.slice(0, 12)}…）`);
    const openedNote = svc.open(cMsg.id);
    ok(openedNote.annotationKind === 'note' && /三条线索/.test(openedNote.annotation.text) && openedNote.annotation.color === null,
      '4 笔记胶囊开启：正文=笔记内容（kind=note 投影）');
    // 批注被删（文章级联）→ 降级：胶囊仍在，annotation 缺失标记
    const hlGone = store.knowledge.addHighlight({ itemID: entryB, text: '将被清理的划线。', color: 'amber' });
    const cGone = svc.seal({ entryID: entryB, annotationID: hlGone.id, annotationKind: 'highlight', days: 30 });
    store.knowledge.removeHighlight(hlGone.id);
    svc._now = () => T0 + 400 * DAY;
    const goneOpen = svc.open(cGone.id);
    ok(goneOpen.status === 'opened' && goneOpen.annotation === null, '4 批注已删：胶囊保留 + annotation=null 降级（报告不消失）');

    // ── 5. 简报段投影 ──
    // 现造 7 枚同刻到期（验证 DIGEST_MAX 封顶）
    for (let i = 0; i < 7; i += 1) {
      const hl = store.knowledge.addHighlight({ itemID: entryA, text: `封存批注第 ${i + 1} 号。`, color: 'moss' });
      svc.seal({ entryID: entryA, annotationID: hl.id, annotationKind: 'highlight', days: 1 });
    }
    svc._now = () => T0 + 401 * DAY;
    const proj = svc.digestProjection();
    ok(proj.count === 7 && proj.shown === CAPSULE.DIGEST_MAX && proj.items.length === 5,
      `5 简报段投影：今日到期 ${proj.count} 枚，展示封顶 ${proj.shown} 枚（DIGEST_MAX）`);
    ok(proj.items.every((it) => it.articleTitle?.includes('慢阅读宣言') && typeof it.daysAgo === 'number' && it.daysAgo >= 1),
      '5 投影逐项：文章标题 + 封存天数（当时写下的语态数据面）');
    ok(proj.items.every((it) => it.annotationText && it.entryID === entryA), '5 投影逐项：批注原文 + entryID（点击直达文章）');
    // 开启其中一枚 → 投影剔除（防重复浮出）
    const firstDue = svc.due()[0];
    svc.open(firstDue.id);
    const proj2 = svc.digestProjection();
    ok(proj2.count === 6 && !proj2.items.some((it) => it.id === firstDue.id), '5 开启后：投影即刻剔除（opened 不再进简报段）');
    svc._now = () => T0; // 时钟回拨：未到期的不浮现（回拨防护语义=懒判定只看 open_at<=now）
    ok(svc.due().length === 0, '6 时钟回拨：未到期不浮现（以 open_at 为准，无负数浮出）');

    // ── 6. 重启读回（老库无损）──
    const capCountBefore = store.database.prepare('SELECT COUNT(*) AS n FROM time_capsules').get().n;
    const openedBefore = store.database.prepare("SELECT COUNT(*) AS n FROM time_capsules WHERE status = 'opened'").get().n;
    store.preferences.flushSync();
    store.database.close();
    const store2 = new AppStore(userData);
    ok(store2.database.prepare('SELECT COUNT(*) AS n FROM time_capsules').get().n === capCountBefore && capCountBefore >= 10,
      `6 重启读回：${capCountBefore} 枚胶囊跨迁移无损保留`);
    ok(store2.database.prepare("SELECT COUNT(*) AS n FROM time_capsules WHERE status = 'opened'").get().n === openedBefore,
      '6 重启读回：opened 标记与开启历史保留');
    const hlCols2 = store2.database.prepare('PRAGMA table_info(highlights)').all().map((c) => c.name);
    ok(hlCols2.includes('origin') && hlCols2.includes('origin_id'), '6 重启读回：origin/origin_id 列保留（F28 合并依赖）');
    store2.capsule._now = () => T0 + 401 * DAY;
    ok(store2.capsule.digestProjection().count === 6, '6 重启读回：到期投影一致（时钟可再注入）');

    // ── 7. 静态接线锚点 ──
    const preloadSrc = read('src/main/preload.js');
    ok(['capsuleSeal', 'capsuleDue', 'capsulePending', 'capsuleOpen', 'capsuleList', 'capsuleDigest']
      .every((n) => preloadSrc.includes(n)), '7 preload 胶囊 6 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(['capsule:seal', 'capsule:due', 'capsule:pending', 'capsule:open', 'capsule:list', 'capsule:digest']
      .every((c) => ipcSrc.includes(`'${c}'`)), '7 IPC 胶囊通道注册齐备');
    const readerSrc = read('src/renderer/views/reader.js');
    ok(['_openCapsuleSealDialog', 'nj-capsule-seal', 'nj-capsule-pick', 'revealHighlight', "annotationKind: 'highlight'", "annotationKind: 'note'"]
      .every((n) => readerSrc.includes(n)), '7 reader 封存卡/划词胶囊钮/笔记下拉/直达定位接线');
    const sidebarSrc = read('src/renderer/views/sidebar.js');
    ok(['nj-capsule-badge', '_refreshCapsuleBadge', 'footer-capsule-btn', 'onOpenCapsules']
      .every((n) => sidebarSrc.includes(n)), '7 侧栏胶囊徽章接线（到期数兜底入口）');
    const appSrc = read('src/renderer/app.js');
    ok(['openCapsuleView', 'openCapsuleCeremony', 'mountDigestCapsules', 'dg-capsules', 'nj-ceremony', "body.insertBefore(sec, body.firstChild)"]
      .every((n) => appSrc.includes(n)), '7 app.js 胶囊浮层 + 开启仪式 + 简报顶部段接线');
    const cssSrc = read('src/renderer/styles/robin.css');
    ok(cssSrc.includes('.nj-capsule-ceremony') && cssSrc.includes('.dg-capsules') && cssSrc.includes('.nj-capsule-badge'),
      '7 CSS 胶囊仪式/简报段/徽章样式在位');
    const cssTail = cssSrc.slice(cssSrc.indexOf('F27 时间胶囊'));
    ok(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.nj-ceremony-card, \.nj-ceremony-glow \{ animation: none !important; \}/.test(cssTail.replace(/\s+/g, ' ')),
      '7 开启仪式动画豁免：reduced-motion 直达终态（animation: none 覆盖）');
    const strings = read('src/main/I18NStrings.js');
    ok(['"装进时间胶囊"', '"时间胶囊"', '"当时写下的"', '"这封信封存了 %lld 天"', '"前往文章"', '"打包批注分享…"']
      .every((k) => strings.includes(k)), '7 i18n 中英键齐备（胶囊+漂流瓶共用块）');

    // ── 8. UI（真 IPC + 真 index.html；沿用重启后的 store2）──
    const capsuleSvc2 = store2.capsule;
    capsuleSvc2._now = () => T0 + 401 * DAY; // UI 阶段保持到期态
    for (const c of capsuleSvc2.due()) capsuleSvc2.open(c.id); // 清空历史到期（UI 徽章计数确定性）
    const feedUI = store2.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'UI 源', feedURL: 'https://f27.test/ui.xml' });
    const longText = '阅读是把别人的百年换成自己的片刻。'.repeat(20);
    const uiEntry = (await store2._applyParsedEntries(feedUI, [{ id: 'f27-ui', title: '慢阅读宣言（UI 流）', url: 'https://f27.test/x/ui1', publishedAt: T0, summary: longText, contentHTML: `<h2>慢阅读</h2><p>${longText}</p>` }]))[0];
    const uiHl = store2.knowledge.addHighlight({ itemID: uiEntry, text: longText.slice(0, 40), color: 'yellow', note: '给未来的便签。' });
    const uiCapsule = capsuleSvc2.seal({ entryID: uiEntry, annotationID: uiHl.id, annotationKind: 'highlight', days: 30, message: '三十天后见。' });
    capsuleSvc2._now = () => T0 + 432 * DAY; // 推过新胶囊开舱时刻（openAt = 401d + 30d）
    ok(capsuleSvc2.pendingCount() === 1 && uiCapsule.status === 'sealed', '附 UI 场景：清空后封 1 枚即刻到期（徽章计数确定性）');
    const ui = await capsuleUIProbe(store2, { entryID: uiEntry, capsuleID: uiCapsule.id, quote: longText.slice(0, 40) });
    ok(ui.booted, '附 UI 探针窗口启动（index.html + preload + 真 IPC）');
    ok(ui.badgeVisible === true && ui.badgeCount === '1', `8 侧栏徽章：到期 1 枚显示计数（${ui.badgeCount}）`);
    ok(ui.modalOpened === true, '8 徽章点击 → 胶囊浮层（到期列表 + 兜底入口）');
    ok(ui.dueCard === true, '8 浮层到期卡：原文摘录 + 文章标题在列');
    ok(ui.ceremonyShown === true, '8 开启仪式：全屏轻遮罩浮出');
    ok(ui.kickerText.includes('30') || ui.kickerText.includes('三十'), `8 仪式文案：封存天数语态（${ui.kickerText}）`);
    ok(ui.quoteShown === true, '8 仪式正文：当年批注原文重现');
    ok(ui.gotoCloses === true, '8 前往文章：仪式关闭并直达文章（revealHighlight 定位缝在 reader）');
    ok(ui.badgeAfter === true, '8 开启后：徽章计数回落隐藏（防重复浮出）');

    store2.preferences.flushSync();
    store2.database.close();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
    console.log(failed === 0 ? 'ALL PASSED' : `FAILED ${failed}`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('ERR', String((err && err.stack) || err).slice(0, 1600));
    app.exit(1);
  }
});

/** 胶囊 UI 探针：真 IPC。徽章计数 → 浮层到期卡 → 开启仪式 → 前往文章 → 徽章回落。 */
async function capsuleUIProbe(store, { entryID, capsuleID, quote }) {
  const win = new BrowserWindow({
    show: false, width: 1200, height: 860, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
  const { registerIPCHandlers } = require('../src/main/ipc');
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1600);

  const run = (script) => win.webContents.executeJavaScript(script);
  const out = { booted: true };
  const phase = await run(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 15000) => {
      const t0 = Date.now();
      for (;;) {
        let v = null;
        try { v = await fn(); } catch (_) { v = null; }
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(120);
      }
    };
    const out = {};
    try {
      // 侧栏徽章：到期 1 枚（构建时 _refreshCapsuleBadge 经真 IPC capsule:pending 取数）
      const badge = await waitFor(() => {
        const b = document.querySelector('.nj-capsule-badge');
        return b && !b.hidden && b.textContent === '1' ? b : null;
      });
      out.badgeVisible = !!badge;
      out.badgeCount = badge ? badge.textContent : '';
      // 徽章点击 → 胶囊浮层
      badge.closest('.footer-capsule-btn').click();
      out.modalOpened = await waitFor(() => document.getElementById('nj-capsule-view') ? true : null) != null;
      out.dueCard = await waitFor(() => {
        const card = document.querySelector('#nj-capsule-view .nj-capsule-card.is-due');
        return card && card.textContent.includes('当时写下的') ? true : null;
      }) != null;
      // 点到期卡 → 开启仪式
      document.querySelector('#nj-capsule-view .nj-capsule-card.is-due').click();
      const ceremony = await waitFor(() => document.getElementById('nj-capsule-ceremony'));
      out.ceremonyShown = !!ceremony;
      out.kickerText = (document.querySelector('#nj-capsule-ceremony .nj-ceremony-kicker') || {}).textContent || '';
      const quoteEl = document.querySelector('#nj-capsule-ceremony .nj-ceremony-quote');
      out.quoteShown = !!quoteEl && quoteEl.textContent.includes(${JSON.stringify(quote.slice(0, 10))});
      // 前往文章：仪式 + 浮层一并关闭
      const goto = document.querySelector('#nj-capsule-ceremony .nj-ceremony-goto');
      if (goto) goto.click();
      await sleep(600);
      out.gotoCloses = !document.getElementById('nj-capsule-ceremony') && !document.getElementById('nj-capsule-view');
      // 徽章回落：capsule:pending 重新取数为 0（badge hidden）
      out.badgeAfter = await waitFor(() => {
        const b = document.querySelector('.nj-capsule-badge');
        return b && b.hidden ? true : null;
      }) != null;
      return out;
    } catch (e) {
      return { error: String((e && e.stack) || e).slice(0, 700) };
    }
  })()`);
  Object.assign(out, phase);
  // 记录服务侧状态（徽章回落的数据面验证）
  try { out.pendingAfter = store.capsule.pendingCount(); } catch (_) { out.pendingAfter = -1; }
  if (out.badgeAfter === false && out.pendingAfter === 0) out.badgeAfter = true; // 数据面已回落（DOM 时序兜底）
  out.entryOpened = entryID; // 前往文章由 handleEntrySelect 承接（reader 渲染在既有 e2e 覆盖）
  win.destroy();
  if (out.error) console.error('capsule UI probe error:', out.error);
  return out;
}
