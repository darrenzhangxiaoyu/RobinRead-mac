'use strict';
/**
 * diag-f28-bundle.js — F28 批注漂流瓶探针（run-all OFFLINE 集，全程离线）
 *
 * 覆盖：
 *  1 导出包结构：format/version/exportedAt/作者 / 文章元数据（标题/来源/URL/发布时间）/
 *    正文 HTML（消毒后含 / includeFullText=false 不带）/ 批注全量（高亮+笔记，含 anchor/颜色）/
 *    suggestedName .robin / byteLength 一致
 *  2 三道闸：合法包解析 / 恶意 HTML 白名单剔除（script/iframe/onerror）/ 超 10MB 拒绝 /
 *    格式不符 / 版本不符明确报错 / 坏 JSON 损坏
 *  3 漂流入库：platform='drift' 合成源 / 确定性 entryID + 元数据 / 正文缓存 is_sanitized=1 /
 *    作者落库 / 同包重导不重复入库（URL 归并）
 *  4 同源合并：已存在只并批注（零新文章）/ 同 anchor+文本哈希去重 / 冲突（同位置不同内容）
 *    并存不覆盖 / origin='imported'+origin_id / 整包重导 added=0（防往返重复）/ 超大 anchor 截断 /
 *    超长文本截断 + 条数封顶
 *  5 再导出往返：导入身份随身携带（origin/uid）/ 落盘读回一致 / 跨库导入批注存活 / uid 跨库保持
 *  6 许可链 mock：_saveDialogImpl mock 写盘 / 用户取消零写盘 / 缺文件导入报错
 *  7 静态接线 + UI：右键菜单「打包批注分享…」（mock 保存对话框真写盘）/
 *    命令面板「导入批注包…」（mock 打开对话框真导入 + toast 统计）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, dialog, BrowserWindow } = require('electron');
app.disableHardwareAcceleration(); // 沙箱内 GPU 合成偶发死锁：探针窗口纯 DOM 断言，禁用硬件加速
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f28-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const DAY = 86400;
const T = Math.floor(Date.now() / 1000);

/** 朋友侧的 .robin 包（对齐 E1 的 URL → 走合并路径）。 */
function friendBundle() {
  return {
    format: 'robin-bundle',
    version: 1,
    exportedAt: T - 3600,
    author: { name: '对面的知更' },
    article: {
      title: '慢阅读宣言（合并流）',
      sourceTitle: '朋友订阅源',
      url: 'https://f28.test/x/1',
      publishedAt: T - 2 * DAY,
      html: '<h2>慢阅读宣言</h2><p>朋友的正文。</p><script>alert("xss")</script><iframe src="https://evil.example"></iframe><img src="https://f28.test/i.png" onerror="alert(3)">',
    },
    annotations: [
      { kind: 'highlight', text: '阅读是把别人的百年换成自己的片刻。', color: 'yellow', anchor: { paragraphID: 'p-1', prefix: '慢阅读宣言', suffix: '' }, createdAt: T - 3600 }, // 与本地 H1 同文同位 → 去重
      { kind: 'highlight', text: '同一位置，朋友的另一番解读。', color: 'amber', anchor: { paragraphID: 'p-1', prefix: '慢阅读宣言', suffix: '' }, createdAt: T - 3500 }, // 同位不同文 → 冲突并存
      { kind: 'highlight', text: '朋友划的全新句子：慢是一种能力。', color: 'blue', anchor: { paragraphID: 'p-9', prefix: '', suffix: '' }, uid: 'fr-hl-1', origin: 'imported', createdAt: T - 3400 }, // 新批注带身份证
      { kind: 'note', text: '朋友的笔记：读完想关掉手机散个步。', anchor: { paragraphID: 'p-9' }, uid: 'fr-note-1', createdAt: T - 3300 }, // 笔记批注
    ],
  };
}

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { RobinBundleService, BUNDLE, shapeAnnotation } = require('../src/main/RobinBundleService');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);
    const svc = store.bundles;

    // ── 场景源：E1（含脏 HTML：script/onerror——导出侧消毒验证）+ 高亮 + 笔记 ──
    const mkFeed = (title, url) => store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title, feedURL: url });
    const feed = mkFeed('F28 源', 'https://f28.test/a.xml');
    const dirtyHTML = '<h2>慢阅读宣言</h2><p>阅读是把别人的百年换成自己的片刻。正文足够长。</p><script>alert(1)</script><img src="https://f28.test/cover.png" onerror="alert(2)">';
    const e1 = (await store._applyParsedEntries(feed, [{ id: 'f28-e1', title: '慢阅读宣言', url: 'https://f28.test/x/1', publishedAt: T - 2 * DAY, summary: '慢阅读。', contentHTML: dirtyHTML }]))[0];
    const h1 = store.knowledge.addHighlight({ itemID: e1, text: '阅读是把别人的百年换成自己的片刻。', color: 'yellow', anchor: { paragraphID: 'p-1', prefix: '慢阅读宣言', suffix: '' } });
    const n1 = store.knowledge.addNote({ itemID: e1, content: '本地笔记：这句话要封进胶囊。', anchor: { paragraphID: 'p-1' } });
    ok(!!e1 && !!h1?.id && !!n1?.id, '附 场景源灌入 + 高亮/笔记落库');

    // ── 1. 导出包结构 ──
    const bundle = svc.buildBundle(e1, { includeFullText: true });
    ok(bundle.payload.format === BUNDLE.FORMAT && bundle.payload.version === BUNDLE.VERSION
      && typeof bundle.payload.exportedAt === 'number', `1 包结构：format=${bundle.payload.format} v${bundle.payload.version} + exportedAt`);
    const art = bundle.payload.article;
    ok(art.title === '慢阅读宣言' && art.sourceTitle === 'F28 源' && art.url === 'https://f28.test/x/1' && art.publishedAt === T - 2 * DAY,
      '1 文章元数据：标题/来源/URL/发布时间全量随包');
    ok(typeof art.html === 'string' && art.html.includes('慢阅读宣言') && !/<script/i.test(art.html) && !/onerror/i.test(art.html),
      '1 正文 HTML：导出侧已过消毒白名单（script/onerror 出包前剔除）');
    const slim = svc.buildBundle(e1, { includeFullText: false });
    ok(slim.payload.article.html === null && slim.payload.annotations.length === bundle.payload.annotations.length,
      '1 includeFullText=false：正文缺省、批注仍全量（轻量分享）');
    const hlIn = bundle.payload.annotations.find((a) => a.kind === 'highlight' && a.text.includes('百年'));
    const noteIn = bundle.payload.annotations.find((a) => a.kind === 'note');
    ok(!!hlIn && hlIn.color === 'yellow' && hlIn.anchor?.paragraphID === 'p-1' && typeof hlIn.createdAt === 'number',
      '1 高亮随包：颜色 + anchor + 时间戳');
    ok(!!noteIn && noteIn.text.includes('封进胶囊') && noteIn.color === null, '1 笔记随包：kind=note（无颜色）');
    ok(bundle.suggestedName.endsWith(BUNDLE.FILE_EXT) && bundle.suggestedName.includes('慢阅读宣言')
      && bundle.byteLength === Buffer.byteLength(bundle.json, 'utf8'),
      `1 suggestedName=${bundle.suggestedName} + byteLength 一致`);
    ok(svc.snapshot().exported >= 2, '1 exported 计数在案');

    // ── 2. 三道闸（导入校验）──
    const parsed = svc.parseBundle(JSON.stringify(friendBundle()));
    ok(parsed.article.title.includes('慢阅读宣言') && parsed.annotations.length === 4 && parsed.author === '对面的知更',
      '2 合法包解析：文章 + 4 条批注 + 作者');
    ok(/<script/i.test(parsed.article.html) === false && /alert\("xss"\)/.test(parsed.article.html) === false,
      '2 恶意 HTML：<script> 白名单剔除');
    ok(/<iframe/i.test(parsed.article.html) === false, '2 恶意 HTML：非白名单域 <iframe> 剔除');
    ok(/onerror/i.test(parsed.article.html) === false, '2 恶意 HTML：事件属性 onerror 剔除');
    const bigPad = 'x'.repeat(BUNDLE.MAX_BYTES + 1024);
    let sizeErr = '';
    try { svc.parseBundle(JSON.stringify({ ...friendBundle(), _pad: bigPad })); } catch (e) { sizeErr = String(e.message); }
    ok(/大小上限/.test(sizeErr) && svc.snapshot().rejected >= 1, `2 超限（>10MB）整包拒绝（${sizeErr.slice(0, 18)}…）`);
    let verErr = '';
    try { svc.parseBundle(JSON.stringify({ ...friendBundle(), version: 99 })); } catch (e) { verErr = String(e.message); }
    ok(/版本不符/.test(verErr), `2 版本不符明确报错（${verErr.slice(0, 24)}…）`);
    let fmtErr = '';
    try { svc.parseBundle(JSON.stringify({ ...friendBundle(), format: 'someone-else' })); } catch (e) { fmtErr = String(e.message); }
    ok(/format 不符/.test(fmtErr), `2 非知更包（format 不符）拒绝（${fmtErr.slice(0, 18)}…）`);
    let jsonErr = '';
    try { svc.parseBundle('{"format":"robin-bundle","version":1,"article":'); } catch (e) { jsonErr = String(e.message); }
    ok(/损坏/.test(jsonErr), `2 坏 JSON 明确报错（${jsonErr.slice(0, 16)}…）`);

    // ── 3. 漂流入库 ──
    const driftBundle = {
      ...friendBundle(),
      article: { ...friendBundle().article, url: 'https://f28.test/drift/9', title: '漂流来的好文章' },
    };
    const drift = svc.importBundle(JSON.stringify(driftBundle));
    const driftFeeds = store.database.prepare("SELECT * FROM feeds WHERE platform = 'drift'").all();
    ok(drift.drift === true && driftFeeds.length === 1 && driftFeeds[0].feed_url === 'drift://bundles',
      '3 漂流入库：drift=true + 合成源 platform=drift（drift://bundles 单例）');
    ok(!!store.articlesRepo.entry(drift.entryID) && store.articlesRepo.entry(drift.entryID).title === '漂流来的好文章'
      && store.articlesRepo.entry(drift.entryID).url === 'https://f28.test/drift/9',
      '3 漂流条目可读：标题/URL 元数据落库');
    const driftCache = store.cachesRepo.cache(drift.entryID);
    ok(driftCache && driftCache.isSanitized === true && typeof driftCache.text === 'string' && driftCache.text.length > 0,
      '3 正文缓存 is_sanitized=1（reader 缓存通路原样呈现消毒正文）');
    ok(store.articlesRepo.entry(drift.entryID).author === '对面的知更', '3 漂流文章作者落库（包作者署名）');
    const driftAgain = svc.importBundle(JSON.stringify(driftBundle));
    ok(driftAgain.drift === false && store.database.prepare("SELECT COUNT(*) AS n FROM items i JOIN feeds f ON f.id = i.feed_id WHERE f.platform = 'drift'").get().n === 1,
      '3 同源漂流包重导：URL 归并到既有条目（不再重复入库）');

    // ── 4. 同源合并（对 E1：已存在 → 只并批注）──
    const articlesBefore = store.database.prepare('SELECT COUNT(*) AS n FROM articles').get().n;
    const merged = svc.importBundle(JSON.stringify(friendBundle()));
    ok(merged.drift === false && store.database.prepare('SELECT COUNT(*) AS n FROM articles').get().n === articlesBefore,
      '4 同 URL 已存在：只合并批注，零新文章');
    ok(merged.duplicates === 1 && merged.added === 3 && merged.conflicts === 1,
      `4 合并统计：去重 ${merged.duplicates} / 新增 ${merged.added} / 并存 ${merged.conflicts}（同文同位哈希去重 + 同位异文并存）`);
    const h1After = store.knowledge.getHighlight(h1.id);
    ok(h1After && h1After.text.includes('百年') && h1After.color === 'yellow',
      '4 永不覆盖红线：本地原批注逐字保留（冲突并存而非改写）');
    const e1Hls = store.knowledge.getHighlights(e1);
    const conflictRow = e1Hls.find((h) => h.text === '同一位置，朋友的另一番解读。');
    ok(!!conflictRow && conflictRow.id !== h1.id, '4 冲突行独立并存（同位置第二条批注）');
    const frRow = e1Hls.find((h) => h.text.includes('慢是一种能力'));
    const frNote = store.knowledge.getNotes(e1).find((nt) => nt.content.includes('散个步'));
    ok(frRow?.origin === 'imported' && (frRow?.originID ?? frRow?.origin_id) === 'fr-hl-1' && frNote?.origin === 'imported',
      '4 导入身份：origin=imported + origin_id=uid 落库');
    const reMerged = svc.importBundle(JSON.stringify(friendBundle()));
    ok(reMerged.added === 0 && reMerged.duplicates === 4,
      `4 整包重导：added=0 / duplicates=${reMerged.duplicates}（uid/哈希双通道防往返重复）`);
    // 超大字段截断
    const fatAnchor = { paragraphID: 'p-fat', prefix: 'A'.repeat(5000), suffix: 'B'.repeat(5000), junk: 'J'.repeat(8000) };
    const fatText = '超长划线。'.repeat(1200); // 7200 字 > TEXT_SLICE
    const fatParsed = svc.parseBundle(JSON.stringify({ ...friendBundle(), annotations: [
      { kind: 'highlight', text: fatText, anchor: fatAnchor, uid: 'fat-1' },
    ] }));
    ok(fatParsed.annotations.length === 1 && Buffer.byteLength(JSON.stringify(fatParsed.annotations[0].anchor)) < 400
      && fatParsed.annotations[0].text.length === BUNDLE.TEXT_SLICE,
      `4 超大 anchor 收敛三要素 / 超长文本截至 ${BUNDLE.TEXT_SLICE}（防炸弹字段）`);
    const manyParsed = svc.parseBundle(JSON.stringify({ ...friendBundle(), annotations: Array.from({ length: 600 }, (_, i) => ({ kind: 'highlight', text: `第 ${i} 条`, uid: `m-${i}` })) }));
    ok(manyParsed.annotations.length === BUNDLE.MAX_ANNOTATIONS, `4 批注条数封顶 ${BUNDLE.MAX_ANNOTATIONS}（600 → 500）`);

    // ── 5. 再导出往返（跨库）──
    const rebundle = svc.buildBundle(e1, { includeFullText: true, authorName: '本机知更' });
    const reImp = rebundle.payload.annotations.find((a) => a.uid === 'fr-hl-1');
    ok(!!reImp && reImp.origin === 'imported' && rebundle.payload.annotations.length >= 5,
      '5 再导出：导入批注随身携带（origin=imported + uid 不丢）');
    const roundPath = path.join(os.tmpdir(), `robinread-f28-round-${Date.now()}${BUNDLE.FILE_EXT}`);
    const written = svc.writeBundleFile(rebundle.json, roundPath);
    const roundParsed = JSON.parse(fs.readFileSync(roundPath, 'utf8'));
    ok(written.path === roundPath && roundParsed.format === BUNDLE.FORMAT && roundParsed.annotations.length === rebundle.payload.annotations.length,
      '5 落盘契约：.robin 写盘 → 读回 JSON 一致');
    const userDataB = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f28-b-'));
    const storeB = new AppStore(userDataB);
    const fromFile = storeB.bundles.importFromFile(roundPath);
    ok(fromFile.drift === true && fromFile.added === rebundle.payload.annotations.length,
      `5 跨库导入：漂流文章 + ${fromFile.added} 条批注全部存活`);
    const bRow = storeB.database.prepare("SELECT origin_id FROM highlights WHERE origin_id = 'fr-hl-1'").get();
    ok(!!bRow, '5 uid 跨库保持（fr-hl-1 在 B 库可查——再导回去仍对得上）');
    const bHlCount = storeB.database.prepare('SELECT COUNT(*) AS n FROM highlights').get().n;
    const bReImport = storeB.bundles.importFromFile(roundPath);
    ok(bHlCount === storeB.database.prepare('SELECT COUNT(*) AS n FROM highlights').get().n && bReImport.added === 0,
      '5 B 库重导同一包：零重复（永不重复红线）');

    // ── 6. 许可链 mock（pickSavePath 惯例）──
    const savePick = path.join(os.tmpdir(), `robinread-f28-pick-${Date.now()}${BUNDLE.FILE_EXT}`);
    svc._saveDialogImpl = async () => savePick;
    const viaDialog = await svc.exportToFile(e1, { includeFullText: true });
    ok(!!viaDialog && fs.existsSync(viaDialog.path) && viaDialog.path.endsWith(BUNDLE.FILE_EXT) && viaDialog.annotationCount >= 5,
      '6 _saveDialogImpl mock：exportToFile 按所选路径写盘（pickSavePath 惯例缝）');
    svc._saveDialogImpl = async () => null;
    const cancelled = await svc.exportToFile(e1, {});
    ok(cancelled === null, '6 用户取消：返回 null 零写盘');
    svc._saveDialogImpl = null;
    let missingErr = '';
    try { svc.importFromFile(path.join(os.tmpdir(), 'robinread-f28-nope.robin')); } catch (e) { missingErr = String(e.message || e); }
    ok(missingErr.length > 0, '6 缺文件导入：显式报错（不静默）');

    // ── 7. 静态接线锚点 ──
    const appSrc = read('src/renderer/app.js');
    ok(['打包批注分享', 'exportRobinBundle', 'importRobinBundle', 'bundleExport', 'bundleImportPick']
      .every((n) => appSrc.includes(n)), '7 app.js 右键菜单 + 导入导出流接线');
    ok(appSrc.includes("label: t('导入批注包…')") && appSrc.includes('新增 %lld 条批注'),
      '7 命令面板「导入批注包…」命令 + toast 统计文案');
    const preloadSrc = read('src/main/preload.js');
    ok(preloadSrc.includes('bundleExport') && preloadSrc.includes('bundleImportPick'), '7 preload 漂流瓶 2 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(ipcSrc.includes("'bundle:export'") && ipcSrc.includes("'bundle:importPick'"), '7 IPC 漂流瓶通道注册齐备');
    const strings = read('src/main/I18NStrings.js');
    ok(['"打包批注分享…"', '"导入批注包…"', '"导入 1 篇漂流文章"', '"已并入既有文章"', '"跳过重复 %lld 条"']
      .every((k) => strings.includes(k)), '7 i18n 中英键齐备（打包/导入/漂流/合并统计）');

    // ── 8. UI（真 IPC：右键菜单真打包 + 命令面板真导入 + toast）──
    const userDataC = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f28-c-'));
    const storeC = new AppStore(userDataC);
    const sharePath = path.join(os.tmpdir(), `robinread-f28-share-${Date.now()}${BUNDLE.FILE_EXT}`);
    // UI 导入专用包：publishedAt=现在（'今天'作用域按 published_at 过滤，旧文只在漂生源里）
    const uiImportPath = path.join(os.tmpdir(), `robinread-f28-ui-import-${Date.now()}${BUNDLE.FILE_EXT}`);
    fs.writeFileSync(uiImportPath, JSON.stringify({
      format: 'robin-bundle', version: 1, exportedAt: T, author: { name: 'UI 朋友' },
      article: { title: '漂流来的今日新文（UI 流）', sourceTitle: '朋友订阅源', url: 'https://f28.test/ui-drift/1', publishedAt: T, html: '<h2>漂流新文</h2><p>今天刚写的正文，落进今天作用域。</p><script>alert("x")</script>' },
      annotations: [
        { kind: 'highlight', text: '朋友划的句子：今天的风很轻。', color: 'blue', anchor: { paragraphID: 'p-1' }, uid: 'fr-ui-1', createdAt: T },
        { kind: 'note', text: '朋友的笔记：读完去散步。', anchor: { paragraphID: 'p-1' }, uid: 'fr-ui-2', createdAt: T },
      ],
    }));
    const realSave = dialog.showSaveDialog;
    const realOpen = dialog.showOpenDialog;
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: sharePath });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [uiImportPath] });
    const ui = await bundleUIProbe(storeC);
    dialog.showSaveDialog = realSave;
    dialog.showOpenDialog = realOpen;
    ok(ui.booted, '附 UI 探针窗口启动（index.html + preload + 真 IPC）');
    ok(ui.paletteHasImport === true, '8 命令面板：「导入批注包…」命令可搜可点');
    ok(ui.importToast === true, `8 导入 toast 统计（${(ui.toastText || '').slice(0, 40)}）`);
    ok(ui.driftInList === true, '8 漂流文章入列表（platform=drift 合成源随 reloadAll 出列）');
    ok(ui.menuHasShare === true, '8 文章右键菜单：「打包批注分享…」在列');
    ok(ui.exportRequested === true && fs.existsSync(sharePath),
      '8 右键打包：mock 保存对话框 → 主进程真写盘（.robin 可解析）');
    try {
      const shareParsed = JSON.parse(fs.readFileSync(sharePath, 'utf8'));
      ok(shareParsed.article && Array.isArray(shareParsed.annotations), '8 打包产物：合法 .robin 包（format/article/annotations）');
    } catch (_) { ok(false, '8 打包产物：合法 .robin 包（format/article/annotations）'); }

    [storeB, storeC].forEach((s) => { try { s.preferences.flushSync(); s.database.close(); } catch (_) { /* 尽力而为 */ } });
    store.preferences.flushSync();
    store.database.close();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
    try { fs.rmSync(userDataB, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
    try { fs.rmSync(userDataC, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
    try { fs.rmSync(roundPath, { force: true }); } catch (_) { /* 留给系统清理 */ }
    try { fs.rmSync(uiImportPath, { force: true }); } catch (_) { /* 留给系统清理 */ }
    console.log(failed === 0 ? 'ALL PASSED' : `FAILED ${failed}`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('ERR', String((err && err.stack) || err).slice(0, 1600));
    app.exit(1);
  }
});

/** 漂流瓶 UI 探针：真 IPC。命令面板导入（toast）→ 漂流条目入列 → 右键打包（写盘）。 */
async function bundleUIProbe(store) {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 860, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
  const { registerIPCHandlers } = require('../src/main/ipc');
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1700);

  const run = (script) => win.webContents.executeJavaScript(`(async () => { try { ${script} } catch (e) { return { __err: String(e && e.stack || e).slice(0, 700) }; } })()`);
  const out = { booted: true };

  // 命令面板：Ctrl+Shift+P → 搜「导入」→ 点「导入批注包…」（对话框已 mock）→ toast 统计
  const phasePalette = await run(`
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
    document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, code: 'KeyP', bubbles: true }));
    const input = await waitFor(() => document.querySelector('.cmd-palette input') || null);
    out.paletteOpened = !!input;
    if (input) {
      input.value = '导入';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(250);
      const item = [...document.querySelectorAll('.cmd-item')].find((el) => el.textContent.includes('导入批注包'));
      out.paletteHasImport = !!item;
      if (item) {
        item.click();
        const toast = await waitFor(() => {
          const t = document.querySelector('#nj-toast-stack');
          return t && t.textContent.includes('漂流') && t.textContent.includes('新增') ? t.textContent : null;
        }, 12000);
        out.importToast = !!toast;
        out.toastText = toast || '';
      }
      await sleep(300);
      const esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCodes: 27, bubbles: true });
      document.dispatchEvent(esc);
    }
    return out;
  `);
  Object.assign(out, phasePalette);

  // 漂流条目入列表（reloadAll 后行卡出现；list/magazine 两种形态都带 .entry-row）
  const phaseList = await run(`
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 20000) => {
      const t0 = Date.now();
      for (;;) {
        let v = null;
        try { v = await fn(); } catch (_) { v = null; }
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(150);
      }
    };
    const out = {};
    const row = await waitFor(() => document.querySelector('.entry-row') || null);
    out.driftInList = !!row;
    out.rowTitle = row ? row.textContent.slice(0, 40) : '';
    out.diag = {
      rows: document.querySelectorAll('.entry-row').length,
      listItems: (window.__robinList && window.__robinList.items ? window.__robinList.items.length : -1),
      emptyShown: !!document.querySelector('.list-empty'),
      rowsHostLen: (document.getElementById('list-rows') || {}).childElementCount ?? -1,
      bodySample: (document.getElementById('list-rows') || document.querySelector('.list-scroll') || {}).textContent?.slice(0, 60) || '',
    };
    return out;
  `);
  Object.assign(out, phaseList);
  if (!out.driftInList && out.diag) console.error('list diag:', JSON.stringify(out.diag));

  // 右键菜单：打包批注分享 → 主进程 mock 对话框真写盘
  const phaseMenu = await run(`
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
    const row = document.querySelector('.entry-row');
    if (row) {
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: rect.left + 40, clientY: rect.top + 12,
      }));
      const item = await waitFor(() => [...document.querySelectorAll('.context-menu .context-menu-item')]
        .find((el) => el.textContent.includes('打包批注分享')) || null);
      out.menuHasShare = !!item;
      if (item) {
        item.click();
        // 打包完成有「已打包…」toast（写盘断言在主进程侧做——渲染层无 require）
        const packed = await waitFor(() => {
          const t = document.querySelector('#nj-toast-stack');
          return t && t.textContent.includes('已打包') ? true : null;
        }, 12000);
        out.exportRequested = !!packed;
      }
    }
    return out;
  `);
  Object.assign(out, phaseMenu);

  win.destroy();
  if (out.__err) console.error('bundle UI probe error:', out.__err);
  return out;
}
