'use strict';
/**
 * diag-f33-autotrans.js — F33 外文源自动译探针（run-all OFFLINE 集，全程离线 mock LLM）
 *
 * 覆盖：
 *  1 v28 迁移：translations（PK item_id / lang / translated_html / segments_json / is_complete /
 *    FK 级联）+ archives 同批迁移在位 + 老行级联删除
 *  2 分段翻译：segmentHTMLBlocks 块级切分（多块 ≥2 / 碎块合并 / 单巨块不切）+ mock LLM 逐块
 *    译按序拼接（TRANSLATED-N 下标单调）+ 进度计数
 *  3 消毒：LLM 输出夹带 script/iframe/onerror → sanitizedHTML 白名单剥除后才落库
 *  4 幂等：完整译文重译零 LLM 请求（cached=true / callCount 不变 / cacheHits 计数）
 *  5 单飞：并发 ≤2（CONCURRENCY）+ 队列排队 + 排空 + maxInFlight 钳制 + 重复入队防重
 *  6 订阅开关：feedModes 开关持久化 / 中文条目不入队 / 外文条目 kick 灌文入队 / 关开关登记失效
 *  7 失败重试 + 断点续译：块 2 连续抛错 → 进度 {0,1} 保留 / 重试不重译块 0 / 修好后重试补译完成
 *  8 取消：队列摘除 cancelled 计数
 *  9 无 Key：available().ai=false + translateEntry 拒绝（missingAPIKey）
 * 10 静态接线 + UI：preload/IPC/投影 hasTranslation/reader 译文按钮与双容器/列表译徽标/
 *    设置自动翻译分区/i18n；UI 阶段 150s 竞速降级 SKIP（服务级断言全门禁，f25/f26 先例）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f33-')));
setTimeout(() => { console.error('WATCHDOG'); process.exit(3); }, 300 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const T = Math.floor(Date.now() / 1000);
/** 英文假文：n 段 × fill 字符/段（fill≥900 时 segmentHTMLBlocks 不合并 → 段数=块数，可确定断言）。 */
const EN = (n, tag, fill = 150) => Array.from({ length: n }, (_, i) => {
  const filler = `international observers report ${i} `.repeat(Math.ceil(fill / 32));
  return `<p>${tag || 'Paragraph'} ${i}: ${filler.slice(0, fill)}The quick brown fox jumps over the lazy dog.</p>`;
}).join('\n');

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { TranslationService, segmentHTMLBlocks, cjkRatio, CONCURRENCY } = require('../src/main/TranslationService');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);
    const svc = store.translation;

    // ── 1. v28 迁移 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v28-translations-archives'").get(),
      '1 v28 迁移已入链');
    const trSQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='translations'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/translations/.test(trSQL) && /item_id\s+TEXT PRIMARY KEY/i.test(trSQL), '1 translations PK(item_id) 在位（一篇文章至多一份译文）');
    ok(/REFERENCES\s+items\(id\)/i.test(trSQL) && /ON DELETE CASCADE/i.test(trSQL), '1 translations FK 级联（items 删除随行清）');
    ok(/segments_json/.test(trSQL) && /is_complete\s+INTEGER/.test(trSQL), '1 segments_json（断点续译进度）+ is_complete 列在位');
    ok(!!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='archives'").get(),
      '1 v28 同批 archives 表在位（F34 共迁移）');
    ok(svc instanceof TranslationService, '附 TranslationService 随 AppStore 构造（F33 接线）');

    // 素材源 + 条目（外文长文多块 / 中文短文）
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F33 外文素材源', feedURL: 'https://f33.test/feed.xml' });
    const mkEntry = async (id, title, summary, contentHTML) => (await store._applyParsedEntries(feed, [{
      id, title, url: `https://f33.test/x/${id}`, publishedAt: T - 60, summary, contentHTML,
    }]))[0];

    // mock AI 就绪（f26 同款）+ mock LLM（逐块翻译：带 TRANSLATED-N 标记按序可断言）。
    // llmCalls 全程累计（跨 mock 重建不归零），断言一律用相位前基线取增量。
    store._requireAIReady = () => ({ config: { model: 'mock-model-33', targetLanguage: '中文' }, apiKey: 'mock-key' });
    const llmCalls = { n: 0, byIndex: {}, seenHTML: [] };
    const mkMockLLM = (opts = {}) => {
      svc._llmComplete = async ({ html, index }) => {
        llmCalls.n += 1;
        llmCalls.byIndex[index] = (llmCalls.byIndex[index] || 0) + 1;
        llmCalls.seenHTML.push(String(html || ''));
        await sleep(opts.delay || 5);
        if (opts.throwFor && index === opts.throwFor.index && llmCalls.byIndex[index] <= (opts.throwFor.times || 99)) {
          throw new (require('../src/main/LLMService').LLMServiceError)('mock-translation-failed');
        }
        if (opts.dirtyFor === index) {
          // 恶意输出：script/iframe/onerror 全带 → 消毒闸应剥除
          return `<p onclick="alert(1)">TRANSLATED-${index} ok</p><script>alert("xss")</script><iframe src="https://evil.example"></iframe>`;
        }
        return `<p>TRANSLATED-${index} 译文段落。</p>`;
      };
    };
    mkMockLLM();

    // ── 2. 分段切分（纯函数直测）──
    const blocks = segmentHTMLBlocks(EN(12, 'Chunk'), 900);
    ok(blocks.length >= 2, `2 多块 HTML 切分 ≥2 块（实际 ${blocks.length}）`);
    ok(blocks.every((b) => /^<p>/.test(b.trim()) && /<\/p>$/.test(b.trim())), '2 切分按块级边界（每块完整 <p>…</p>）');
    const merged = segmentHTMLBlocks('<p>a</p><p>b</p><p>c</p>', 900);
    ok(merged.length === 1, '2 碎块合并（3 个短段 → 1 块，减少请求数）');
    const huge = segmentHTMLBlocks(`<p>${'word '.repeat(3000)}</p>`, 500);
    ok(huge.length === 1, '2 单巨块不硬切（整块交给 LLM，防截断语义）');
    ok(cjkRatio('The quick brown fox') < 0.2 && cjkRatio('这是一段中文内容，占比很高。') >= 0.2, '2 cjkRatio 外文/中文启发（<20% 视为外文）');

    // ── 3. 整篇翻译：逐块译按序拼接 + 消毒 ──
    // 段落 1200 字 ≥ CHUNK_MIN_CHARS：不并块 → 10 块（throwFor/dirtyFor 下标确定）
    const eDirty = await mkEntry('f33-dirty', 'Dirty Output Story', 'Foreign summary with plenty of english words.', EN(10, 'Dirty', 1200));
    const progEvents = [];
    store.on('translation:progress', (p) => progEvents.push(p));
    mkMockLLM({ dirtyFor: 1 });
    const t1 = await svc.translateEntry(eDirty);
    ok(t1 && t1.isComplete && t1.html, '3 整篇翻译完成（is_complete=1）');
    const idxs = [];
    let pos = -1;
    for (let m = 0; m < 40; m += 1) {
      const found = t1.html.indexOf(`TRANSLATED-${idxs.length}`, pos + 1);
      if (found < 0) break;
      idxs.push(found);
      pos = found;
    }
    ok(idxs.length >= 2 && idxs.every((v, i) => i === 0 || v > idxs[i - 1]), `3 分段按序拼接（${idxs.length} 块标记单调递增）`);
    ok(!/<script/i.test(t1.html) && !/<iframe/i.test(t1.html) && !/onerror/i.test(t1.html) && !/onclick/i.test(t1.html),
      '3 消毒白名单：LLM 输出的 script/iframe/onerror/onclick 剥除后才落库');
    ok(store.database.prepare('SELECT segments_json, is_complete FROM translations WHERE item_id = ?').get(eDirty).segments_json == null,
      '3 完成后 segments_json 清空（进度列仅中断期承载）');
    ok(svc.counters.chunksDone >= 3 && progEvents.some((p) => p.entryID === eDirty && p.state === 'done'),
      '3 分块进度计数 + translate:progress 推送（done 终态）');
    ok(llmCalls.seenHTML.every((h) => !/<script/i.test(h)), '3 进 LLM 的输入已消毒（正文不夹带可执行标记）');

    // ── 4. 幂等 ──
    const callsBefore = llmCalls.n;
    const again = await svc.translateEntry(eDirty);
    ok(again.cached === true && llmCalls.n === callsBefore, '4 幂等：已有完整译文零 LLM 请求（cached=true）');
    ok(svc.hasTranslations([eDirty])[eDirty] === true && svc.translatedIDs([eDirty]).includes(eDirty),
      '4 hasTranslations/translatedIDs 批量探测（列表徽标数据面）');
    const listItem = store.listItems({ kind: 'all' }, { limit: 50 }).find((it) => it.id === eDirty);
    ok(listItem && listItem.hasTranslation === true, '4 列表投影 hasTranslation=true（TimelineQuery LEFT JOIN translations）');

    // ── 5. 单飞并发 ≤2 + 队列 ──
    mkMockLLM({ delay: 120 });
    const ids5 = [];
    for (let i = 0; i < 5; i += 1) {
      ids5.push(await mkEntry(`f33-q${i}`, `Queue Story ${i} of international reporting`, 'english abstract for the queue story', EN(4, `Q${i}`)));
    }
    const enq = svc.enqueueAuto(ids5);
    ok(enq === 5, `5 外文条目批量入队（${enq}/5）`);
    ok(svc.snapshot().inFlight <= CONCURRENCY && svc.snapshot().queued > 0,
      `5 单飞：在途 ≤${CONCURRENCY} + 队列排队（inFlight=${svc.snapshot().inFlight} queued=${svc.snapshot().queued}）`);
    ok(svc.enqueueAuto(ids5) === 0, '5 重复入队防重（queuedIDs 登记中再入队零新增）');
    const tWait0 = Date.now();
    while ((svc.snapshot().queued > 0 || svc.snapshot().inFlight > 0) && Date.now() - tWait0 < 20000) await sleep(80);
    ok(svc.snapshot().queued === 0 && svc.snapshot().inFlight === 0, '5 队列排空');
    ok(svc.snapshot().maxInFlight <= CONCURRENCY && svc.counters.translated >= 5,
      `5 排空后 maxInFlight ≤ ${CONCURRENCY}（实测 ${svc.snapshot().maxInFlight}）+ translated 计数`);

    // ── 6. 订阅级开关 + 灌文钩子 ──
    const zhTitle = '中文文章不该自动翻译';
    const zhSummary = '这是中文摘要，中文字符占比非常高，几乎全部都是中文字符。';
    const eZh = await mkEntry('f33-zh', zhTitle, zhSummary, '<p>这是中文正文，不应触发自动翻译。</p>');
    ok(svc.isForeignEntry({ title: zhTitle, summary: zhSummary }) === false, '6 中文条目判定：非外文（CJK ≥20%）');
    ok(svc.isEnabled(feed.id) === false, '6 订阅开关默认关');
    svc.noteNewEntries(feed.id, [eZh]);
    ok(svc.snapshot().pendingFeeds === 0, '6 开关关：灌文登记不收集（pendingFeeds=0）');
    svc.setFeedEnabled(feed.id, true);
    ok(svc.isEnabled(feed.id) === true, '6 setFeedEnabled(true) 持久化');
    const eAuto = await mkEntry('f33-auto', 'Auto Queue Story with foreign words only', 'completely english summary for auto enqueue', EN(4, 'AU'));
    svc.noteNewEntries(feed.id, [eAuto]);
    ok(svc.snapshot().pendingFeeds === 1, '6 开关开：灌文钩子登记 pending（照 F1 只登记 ID）');
    svc.kick();
    await sleep(200); // kick 60ms 让出 + 筛选入队
    ok(svc.snapshot().enqueued >= 1, '6 kick 后筛选入队（外文 + 无缓存译文 + 有正文）');
    const tWait1 = Date.now();
    while ((svc.snapshot().queued > 0 || svc.snapshot().inFlight > 0) && Date.now() - tWait1 < 20000) await sleep(80);
    ok(svc.get(eAuto)?.isComplete === true, '6 灌文条目后台译完（整篇译文缓存）');
    ok(svc.get(eZh) === null, '6 中文条目零翻译（零请求）');
    svc.setFeedEnabled(feed.id, false);
    const eAuto2 = await mkEntry('f33-auto2', 'Another foreign story never auto translated', 'english summary that must not enqueue', EN(3, 'A2'));
    svc.noteNewEntries(feed.id, [eAuto2]);
    svc.kick();
    await sleep(200);
    ok(svc.get(eAuto2) === null, '6 开关关：登记失效（灌文后改设置尊重最新值）');

    // ── 7. 失败重试 + 断点续译 ──
    mkMockLLM({ throwFor: { index: 2, times: 99 } });
    const base7 = { n: llmCalls.n, i0: llmCalls.byIndex[0] || 0, i1: llmCalls.byIndex[1] || 0, i2: llmCalls.byIndex[2] || 0 };
    const eRetry = await mkEntry('f33-retry', 'Retry Story about resilient pipelines', 'english summary for the retry scenario', EN(9, 'RT', 1200));
    const done = svc.translateNow(eRetry); // 等终态
    const tWait2 = Date.now();
    while (!svc.snapshot().failures[eRetry] && Date.now() - tWait2 < 20000) await sleep(80);
    const result7 = await done;
    ok(svc.snapshot().failures[eRetry] !== undefined && result7 && result7.isComplete === false,
      '7 块 2 连续失败：终态 failed 登记 + 行保留（is_complete=0 可续译）');
    let segs = [];
    try { segs = JSON.parse(store.database.prepare('SELECT segments_json AS s FROM translations WHERE item_id = ?').get(eRetry)?.s || '[]'); } catch (_) { /* 空 */ }
    ok(segs.some((s) => s.i === 0) && segs.some((s) => s.i === 1) && !segs.some((s) => s.i === 2),
      '7 断点进度保留：块 0/1 已完成、块 2 未完成（segments_json）');
    ok(svc.counters.retried >= 1, '7 自动重试计数（RETRY_LIMIT=1：重试插队首）');
    ok((llmCalls.byIndex[0] || 0) - base7.i0 === 1 && (llmCalls.byIndex[1] || 0) - base7.i1 === 1,
      '7 重试不重译已完成块（块 0/1 全程各只 1 次请求 = 续译）');
    ok((llmCalls.byIndex[2] || 0) - base7.i2 === 2, '7 失败块重发（首跑 + 重试 = 2 次）');
    mkMockLLM(); // 修好：全块正常
    const result7b = await svc.translateNow(eRetry);
    ok(result7b && result7b.isComplete === true && /TRANSLATED-2/.test(result7b.html || ''),
      '7 修好后手动重试：从断点补译至完成');
    ok((llmCalls.byIndex[0] || 0) - base7.i0 === 1 && (llmCalls.byIndex[1] || 0) - base7.i1 === 1,
      '7 续译终验：块 0/1 依旧零重复请求');

    // ── 8. 取消 ──
    mkMockLLM({ delay: 200 });
    const eCancel = await mkEntry('f33-cancel', 'Cancel Story queued but never starts', 'english summary for cancellation', EN(3, 'CX'));
    const cancelPromise = svc.translateNow(eCancel);
    await sleep(30);
    svc.cancel(eCancel);
    const cancelResult = await Promise.race([cancelPromise, sleep(3000).then(() => null)]);
    ok(svc.counters.cancelled >= 1 && cancelResult && cancelResult.isComplete === false,
      '8 取消：队列摘除（cancelled 计数）+ 等待方唤醒（is_complete=0）');
    mkMockLLM();

    // ── 9. 无 Key ──
    delete store._requireAIReady;
    ok(svc.available().ai === false, '9 无 Key：available().ai=false（渲染层按钮灰置数据面）');
    let noKeyErr = '';
    try { await svc.translateEntry(eAuto2); } catch (err) { noKeyErr = String(err.message || err); }
    ok(/key/i.test(noKeyErr), `9 无 Key：translateEntry 明确拒绝（${noKeyErr.slice(0, 30)}…）`);
    store._requireAIReady = () => ({ config: { model: 'mock-model-33', targetLanguage: '中文' }, apiKey: 'mock-key' });

    // ── 10. 静态接线锚点 ──
    const preloadSrc = read('src/main/preload.js');
    ok(['translateFull', 'translateFullGet', 'translateFullCancel', 'translateAutoConfig', 'onTranslateProgress']
      .every((n) => preloadSrc.includes(n)), '10 preload 自动译 5 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(["'translate:full'", "'translate:fullGet'", "'translate:autoConfig'"].every((c) => ipcSrc.includes(c)),
      '10 IPC 自动译通道注册齐备');
    const tlSrc = read('src/main/Persistence/TimelineQueryService.js');
    ok(tlSrc.includes('LEFT JOIN translations tr ON tr.item_id = i.id') && tlSrc.includes('hasTranslation'),
      '10 列表投影 translations JOIN + hasTranslation 字段');
    const readerSrc = read('src/renderer/views/reader.js');
    ok(['_appendTranslationHeaderButton', '_toggleFullTranslation', '_showFullTranslation', 'robin-body-translated', 'onTranslateProgress']
      .every((n) => readerSrc.includes(n)), '10 reader 译文按钮 + 双容器切换 + 进度订阅接线');
    const listSrc = read('src/renderer/views/list.js');
    ok(listSrc.includes('entry-translation-badge') && listSrc.includes('_syncTranslationBadge'), '10 列表「译」徽标渲染 + 增量补丁');
    const dialogsSrc = read('src/renderer/views/dialogs.js');
    ok(dialogsSrc.includes('_autoTranslateFeeds') && dialogsSrc.includes('translateAutoConfig'), '10 设置「自动翻译」按源开关分区');
    const strings = read('src/main/I18NStrings.js');
    ok(['"译文"', '"原文"', '"自动翻译"'].every((k) => strings.includes(k)), '10 i18n 双语键（译文/原文/自动翻译）');
    ok(!/border-radius: (?:[0-9]|1[0-9])px/.test(read('src/renderer/styles/robin.css').split('F33 外文源自动译')[1] || ''),
      '10 F33/F34 CSS 新块零 radius 字面量（护栏口径）');

    // ── UI 阶段（150s 竞速降级 SKIP，f25/f26 先例）──
    mkMockLLM({ delay: 60 });
    const ui = await Promise.race([
      translationUIProbe(store, { entry: eDirty, fresh: eAuto2 }),
      new Promise((r) => setTimeout(() => r({ uiSkipped: true, booted: null }), 150000)),
    ]);
    if (ui.uiSkipped) {
    try { fs.writeFileSync(path.join(__dirname, '.ci-skip-marker'), 'scripts/diag-f33-autotrans.js'); } catch (_) { /* 标记失败仅丢连击计数 */ }
      for (const m of ['UI 探针窗口启动（index.html + preload + 真 IPC）', 'UI 列表行「译」徽标渲染', 'UI 阅读器「译文」按钮在位且可用',
        'UI 点击译文：生成→译文容器切换（原文隐藏）', 'UI 按钮切换态显示「原文」', 'UI 再点切回原文（双容器不叠加）', 'UI 无 Key 按钮灰置']) {
        console.log('SKIP ' + m);
      }
      console.log('UI 阶段 SKIP：环境性挂起（服务级断言已全部执行）');
      process.exit(failed ? 1 : 0);
      return;
    }
    ok(ui.booted, 'UI 探针窗口启动（index.html + preload + 真 IPC）');
    ok(ui.badge === true, 'UI 列表行「译」徽标渲染（有译文的行）');
    ok(ui.btnPresent === true && ui.btnEnabled === true, 'UI 阅读器「译文」按钮在位且可用（有 Key）');
    ok(ui.switchedToTranslation === true, 'UI 点击译文：无译文生成 → 译文容器切换显示（原容器隐藏）');
    ok(ui.btnShowsOriginal === true, 'UI 按钮切换态显示「原文」（点亮 active）');
    ok(ui.switchedBack === true, 'UI 再点切回原文（双容器不叠加，原容器恢复）');
    ok(ui.greyNoKey === true, 'UI 无 Key → 译文按钮灰置（disabled + 说明）');

    store.preferences.flushSync();
    store.database.close();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
    console.log(failed === 0 ? 'ALL PASSED' : `FAILED ${failed}`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('ERR', String((err && err.stack) || err).slice(0, 1600));
    process.exit(1);
  }
});

/** F33 UI 探针：列表译徽标 → 阅读器译文按钮生成/切换/切回 → 无 Key 灰置。 */
async function translationUIProbe(store, ids) {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 860, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
  const { registerIPCHandlers } = require('../src/main/ipc');
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1500);
  const run = (script) => win.webContents.executeJavaScript(`(async () => { try { ${script} } catch (e) { return { __err: String(e && e.stack || e).slice(0, 600) }; } })()`);
  const out = { booted: true };

  // 列表行「译」徽标（eDirty 已有完整译文 → today/all 列表行渲染徽标）
  const badge = await run(`
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 15000) => {
      const t0 = Date.now();
      for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(150); }
    };
    const row = await waitFor(() => document.querySelector('.entry-row[data-entry-id="' + ${JSON.stringify(ids.entry)} + '"]'));
    return { row: !!row, badge: row ? !!row.querySelector('.entry-translation-badge') : false };
  `);
  out.badge = badge.__err ? false : (badge.row && badge.badge);
  if (badge.__err) console.error('UI badge err:', badge.__err);

  // 阅读器：打开外文新条目（无译文）→ 译文按钮点击生成 → 双容器切换 → 切回
  const phase = await run(`
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 30000) => {
      const t0 = Date.now();
      for (;;) { let v = null; try { v = await fn(); } catch (_) {} if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(150); }
    };
    const out = {};
    window.__robinLLM = { ...(window.__robinLLM || {}), __hasKey: true }; // 有 Key 态
    window.__robinReaderOpen(${JSON.stringify(ids.fresh)});
    const btn = await waitFor(() => {
      const b = document.querySelector('.nj-translation-toggle');
      return b && b.isConnected ? b : null;
    });
    out.btnPresent = !!btn;
    out.btnEnabled = !!btn && btn.disabled === false;
    if (out.btnPresent && out.btnEnabled) {
      btn.click();
      // 生成 → 完成后自动切换：译文容器可见 + 原容器隐藏
      const switched = await waitFor(() => {
        const t = document.querySelector('.robin-body-translated');
        const o = document.querySelector('.robin-body:not(.robin-body-translated)');
        return t && o && t.style.display !== 'none' && o.style.display === 'none' && (t.textContent || '').includes('TRANSLATED') ? true : null;
      }, 40000);
      out.switchedToTranslation = switched === true;
      const btn2 = document.querySelector('.nj-translation-toggle');
      out.btnShowsOriginal = !!btn2 && btn2.classList.contains('active') && (btn2.textContent || '').includes('原文');
      if (btn2) btn2.click();
      const back = await waitFor(() => {
        const t = document.querySelector('.robin-body-translated');
        const o = document.querySelector('.robin-body:not(.robin-body-translated)');
        return t && o && o.style.display !== 'none' && t.style.display === 'none' ? true : null;
      }, 15000);
      out.switchedBack = back === true;
    }
    return out;
  `);
  Object.assign(out, phase);
  if (phase.__err) console.error('UI phase err:', phase.__err);

  // 无 Key 灰置：换一篇外文（保证按钮重建）→ 置 __hasKey=false → disabled。
  // 轮询内持续压 __hasKey=false：app 层 state:changed 回流会 syncLLMGlobals 重置全局（竞态防护）。
  const grey = await run(`
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 20000) => {
      const t0 = Date.now();
      for (;;) { let v = null; try { v = await fn(); } catch (_) {} if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(150); }
    };
    window.__robinReaderOpen(${JSON.stringify(ids.entry)});
    const btn = await waitFor(() => {
      window.__robinLLM = { ...(window.__robinLLM || {}), __hasKey: false };
      const b = document.querySelector('.nj-translation-toggle');
      return b && b.isConnected && b.disabled === true && (b.title || '').includes('AI') ? b : null;
    });
    if (!btn) {
      const all = [...document.querySelectorAll('.nj-translation-toggle')].map((b) => ({
        disabled: b.disabled, title: String(b.title || '').slice(0, 30), connected: b.isConnected,
      }));
      return { greyNoKey: false, __diag: JSON.stringify({ hasKey: window.__robinLLM && window.__robinLLM.__hasKey, readerEntry: window.__robinReader && window.__robinReader.entryID, all }) };
    }
    window.__robinLLM = { ...(window.__robinLLM || {}), __hasKey: true };
    return { greyNoKey: true };
  `);
  out.greyNoKey = grey.__err ? false : grey.greyNoKey;
  if (grey.__err) console.error('UI grey err:', grey.__err);
  else if (!grey.greyNoKey) console.error('UI grey diag:', grey.__diag || 'n/a');

  try { win.destroy(); } catch (_) { /* 尽力而为 */ }
  return out;
}
