'use strict';
/**
 * diag-auditfix-main.js — 主进程侧审查修复回归探针（离线，不联网）
 *
 * 逐项断言本轮修复（编号对应审查报告）：
 *   P0-1  更新包完整性：sha256 匹配放行 / 不匹配删包拒绝 / 无 sha256 日志放行
 *   P2-8  UpdaterService.cancel()：中止在途下载并清理半成品
 *   P1-1  app:captureRect 通道可调用（原先 ReferenceError: win is not defined）
 *   P1-2  deepRead 缓存命中：existingArticleWork 与写入侧同 hash（含 persona）
 *   P1-3  LLM 取消链：外部 AbortSignal 直达 fetch 层（预中止 → cancelled）
 *   P1-4  cleanupNow VACUUM 后 FTS 映射完好（rowid 归属零失配）
 *   P1-5  导出离线 HTML：title/feed/author 转义（恶意标题不落原样）
 *   P2-2  引擎表结构来自 v9 迁移（构造器无 DDL 也齐表）；v9/v10 重放幂等
 *   P2-3  dailyReview 本地时区口径（今日高亮进今日回顾）
 *   P2-4  批量标读/收藏/稍后读/全部已读 = 单事务（BEGIN 计数）
 *   P2-5  url_norm 等值判重 + v10 存量回填 + 写入点维护
 *   P2-6  标题翻译缓存封顶 2000
 *   P2-12 ai_artifacts 同 (subject_key,kind,hash) 复用行；housekeeping 同 item+kind 保留 3 条
 *   性能  _refreshLocalFeed N+1 → entriesByIDs 单查询（行为等价：返回条目齐整）
 *
 * 幂等：全部数据落在一次性临时目录；退出码 0=全 PASS，非 0=有 FAIL。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { app, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-auditfix-'));
app.setPath('userData', userData);
app.on('window-all-closed', () => { /* 探针自行控制退出 */ });
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 150 * 1000).unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let failed = 0;
  const check = (name, ok, detail = '') => {
    if (ok) console.log(`PASS ${name}${detail ? ' — ' + detail : ''}`);
    else { failed += 1; console.error(`FAIL ${name}${detail ? ' — ' + detail : ''}`); }
  };

  try {
    const { AppStore } = require('../src/main/AppStore');
    const { UpdaterService } = require('../src/main/UpdaterService');
    const {
      registerIPCHandlers, registerSavedPath, assertWritablePath, consumeSavedPath,
    } = require('../src/main/ipc');
    const SearchIndex = require('../src/main/Persistence/SearchIndex');
    const { MIGRATIONS } = require('../src/main/Persistence/DatabaseMigrations');
    const { parse: parseFeed } = require('../src/main/FeedParser');
    const { AIArtifactKind, LOCAL_ACCOUNT_ID } = require('../src/main/Models');

    const store = new AppStore(userData);
    const db = store.database;

    // ── P2-2：v9/v10 已应用；引擎构造器无 DDL 也齐表 ──
    const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
    check('P2-2a v9/v10 迁移已应用', applied.has('v9-knowledge-evolution-schema') && applied.has('v10-articles-url-norm'));
    const v9Tables = ['highlights', 'notes', 'review_queue', 'smart_folders', 'article_tags', 'reading_stats',
      'collections', 'collection_items', 'ai_quality_scores', 'feed_health', 'reading_behavior', 'ai_feedback', 'interest_profile'];
    const missingTable = v9Tables.filter((t) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t));
    check('P2-2b 引擎表齐全（来自迁移链）', missingTable.length === 0, missingTable.join(','));
    const anchorCol = db.prepare("SELECT name FROM pragma_table_info('highlights') WHERE name = 'anchor'").get();
    check('P2-2c highlights.anchor 列在位', Boolean(anchorCol));
    // 迁移重放幂等（模拟旧库升级/中断重入）
    const countsBefore = {
      articles: db.prepare('SELECT COUNT(*) c FROM articles').get().c,
      highlights: db.prepare('SELECT COUNT(*) c FROM highlights').get().c,
    };
    let replayErr = null;
    try {
      MIGRATIONS.find((m) => m.id === 'v9-knowledge-evolution-schema').up(db.db);
      MIGRATIONS.find((m) => m.id === 'v10-articles-url-norm').up(db.db);
    } catch (err) { replayErr = err; }
    check('P2-2d v9/v10 up() 重放不报错', replayErr == null, replayErr && replayErr.message);
    check('P2-2e 重放后数据无增减',
      db.prepare('SELECT COUNT(*) c FROM articles').get().c === countsBefore.articles
      && db.prepare('SELECT COUNT(*) c FROM highlights').get().c === countsBefore.highlights);

    // ── 样本数据 ──
    const feed = store.feedsRepo.insertFeed({
      accountID: LOCAL_ACCOUNT_ID, title: '审查修复探针源', siteURL: 'https://example.com/',
      feedURL: 'https://example.com/auditfix.xml',
    });
    store._applyParsedEntries(feed, [1, 2, 3, 4, 5].map((n) => ({
      id: `auditfix-${n}`,
      title: `探针文章${n}`,
      url: `https://example.com/a${n}`,
      publishedAt: Math.floor(Date.now() / 1000) - n * 60,
      summary: `第 ${n} 篇摘要内容。`,
      contentHTML: `<p>第 ${n} 篇正文内容，足够长的正文用于评分与索引。</p>`.repeat(3),
    })));
    const fiveIDs = [1, 2, 3, 4, 5].map((n) => `local:${feed.id}:${require('../src/main/Models').stableDigest(`auditfix-${n}`)}`);
    check('前置 样本入库 5 篇', store.articlesRepo.entriesByIDs(fiveIDs).length === 5);

    // ── 性能小修：entriesByIDs 单查询行为等价 ──
    const byID = store.articlesRepo.entriesByIDs(fiveIDs);
    check('N+1 修复 批量取回齐全且可映射',
      byID.length === 5 && fiveIDs.every((id) => byID.some((e) => e.id === id)));

    // ── P2-4：批量操作单事务（统计外层 BEGIN 次数；transaction() 直呼 raw db.exec）──
    const rawDb = db.db;
    const realExec = rawDb.exec.bind(rawDb);
    let beginCount = 0;
    rawDb.exec = (sql) => { if (String(sql).trim() === 'BEGIN') beginCount += 1; return realExec(sql); };
    let base = beginCount; store.markMany(fiveIDs, true);
    const markManyBegins = beginCount - base;
    base = beginCount; store.starMany(fiveIDs, true);
    const starManyBegins = beginCount - base;
    base = beginCount; store.laterMany(fiveIDs, true);
    const laterManyBegins = beginCount - base;
    // 全部反标未读后再测 markAllRead
    store.markMany(fiveIDs, false);
    base = beginCount; store.markAllRead({ kind: 'feed', feedID: feed.id });
    const markAllBegins = beginCount - base;
    rawDb.exec = realExec;
    check('P2-4a markMany 单事务', markManyBegins === 1, `BEGIN=${markManyBegins}`);
    check('P2-4b starMany 单事务', starManyBegins === 1, `BEGIN=${starManyBegins}`);
    check('P2-4c laterMany 单事务', laterManyBegins === 1, `BEGIN=${laterManyBegins}`);
    check('P2-4d markAllRead 单事务', markAllBegins === 1, `BEGIN=${markAllBegins}`);
    const readFlags = store.articlesRepo.entriesByIDs(fiveIDs).map((e) => e.isRead);
    check('P2-4e 批量语义保持（全部已读）', readFlags.every(Boolean), JSON.stringify(readFlags));

    // ── P1-4：VACUUM 后 FTS 映射完好 ──
    const ftsCountBefore = db.prepare('SELECT COUNT(*) c FROM articles_fts').get().c;
    store.cleanupNow(); // 内部 VACUUM + rebuildMap
    const ftsCountAfter = db.prepare('SELECT COUNT(*) c FROM articles_fts').get().c;
    const mapCountAfter = db.prepare('SELECT COUNT(*) c FROM articles_fts_map').get().c;
    const mismatches = db.prepare(`
      SELECT COUNT(*) c FROM articles_fts_map m
      WHERE (SELECT item_id FROM articles_fts WHERE rowid = m.fts_rowid) IS NOT m.item_id
    `).get().c;
    check('P1-4a VACUUM 后 FTS 行数不变', ftsCountBefore === ftsCountAfter, `${ftsCountBefore}->${ftsCountAfter}`);
    check('P1-4b VACUUM 后映射行数与 FTS 一致', mapCountAfter === ftsCountAfter, `${mapCountAfter}/${ftsCountAfter}`);
    check('P1-4c 映射 rowid 归属零失配', mismatches === 0, `mismatch=${mismatches}`);

    // ── P2-5：url_norm 等值判重 + 回填 + 写入点维护 ──
    const feed2 = store.feedsRepo.insertFeed({
      accountID: LOCAL_ACCOUNT_ID, title: '微信桥样本', siteURL: 'https://w.example.com/',
      feedURL: 'https://w.example.com/feed.xml',
    });
    const wechatURL = 'https://mp.weixin.qq.com/s?__biz=1&amp;mid=2&amp;idx=3&amp;sn=abc';
    store.articlesRepo.upsertEntry({
      id: 'local:wechat:1', accountID: LOCAL_ACCOUNT_ID, externalID: 'local:wechat:1', feedID: feed2.id,
      title: '带实体参数的微信文章', url: wechatURL, publishedAt: Math.floor(Date.now() / 1000),
      summary: '摘要', contentHTML: '<p>正文</p>', dateArrived: Math.floor(Date.now() / 1000),
    });
    check('P2-5a 写入点维护 url_norm（&amp; 解码）',
      db.prepare('SELECT url_norm FROM articles WHERE item_id = ?').get('local:wechat:1').url_norm === 'https://mp.weixin.qq.com/s?__biz=1&mid=2&idx=3&sn=abc');
    check('P2-5b 判重命中解码形式', store._entryExistsByURL(feed2.id, 'https://mp.weixin.qq.com/s?__biz=1&mid=2&idx=3&sn=abc') === true);
    check('P2-5c 判重命中实体形式', store._entryExistsByURL(feed2.id, wechatURL) === true);
    check('P2-5d 不同 url 不误判', store._entryExistsByURL(feed2.id, 'https://mp.weixin.qq.com/s?__biz=9') === false);
    // v10 存量回填：模拟旧行 url_norm 缺失后重放迁移
    db.prepare('UPDATE articles SET url_norm = NULL WHERE item_id = ?').run('local:wechat:1');
    MIGRATIONS.find((m) => m.id === 'v10-articles-url-norm').up(db.db);
    check('P2-5e v10 回填补齐缺失行',
      db.prepare('SELECT url_norm FROM articles WHERE item_id = ?').get('local:wechat:1').url_norm === 'https://mp.weixin.qq.com/s?__biz=1&mid=2&idx=3&sn=abc');

    // ── P2-10：FeedParser 确定性 fallback（两次解析同 id；二次灌入不重复）──
    const noIDXML = '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><link>https://e.com/</link>'
      + '<item><title>无标识条目一</title><description>其摘要甲</description></item>'
      + '<item><title>无标识条目二</title><description>其摘要乙</description></item>'
      + '</channel></rss>';
    const p1 = parseFeed(noIDXML, 'https://e.com/f.xml');
    const p2 = parseFeed(noIDXML, 'https://e.com/f.xml');
    check('P2-10a 同输入两次解析 id 全等',
      p1.entries.length === 2 && p1.entries.every((e, i) => e.id === p2.entries[i].id),
      JSON.stringify(p1.entries.map((e) => e.id)));
    const feed3 = store.feedsRepo.insertFeed({
      accountID: LOCAL_ACCOUNT_ID, title: '无标识源', siteURL: 'https://n.example.com/',
      feedURL: 'https://n.example.com/feed.xml',
    });
    store._applyParsedEntries(feed3, p1.entries);
    store._applyParsedEntries(feed3, p2.entries); // 刷新重放：判重应全部命中
    const feed3Count = db.prepare('SELECT COUNT(*) c FROM items WHERE feed_id = ?').get(feed3.id).c;
    check('P2-10b 两次灌入不重复入库', feed3Count === 2, `n=${feed3Count}（原先随机 uuid 会是 4）`);

    // ── P1-2 + P2-12：deepRead 缓存命中 + 行复用（mock LLM，不联网）──
    store.credentials.setAIAPIKey('probe-key');
    // 用 custom 人格：resolveDeepReadSystem 对预设 id 忽略 custom 文本，custom 才进 hash
    store.preferences.set('RobinRead.ai.persona', { id: 'custom', custom: 'PROBE-PERSONA-A' });
    let deepCalls = 0;
    store.llm.deepRead = async () => { deepCalls += 1; return '这是探针精读结果。'; };
    const workID = fiveIDs[0];
    const missBefore = store.existingArticleWork(workID, AIArtifactKind.deepRead);
    const art1 = await store.deepRead(workID);
    const hitAfter = store.existingArticleWork(workID, AIArtifactKind.deepRead);
    check('P1-2a 生成前缓存 miss', missBefore == null);
    check('P1-2b 生成后缓存命中（hash 同口径含 persona）',
      hitAfter != null && hitAfter.content === '这是探针精读结果。' && hitAfter.id === art1.id,
      hitAfter ? `content=${hitAfter.content.slice(0, 8)}…` : 'null');
    // 换 persona → hash 变化 → miss（证明 hash 确实纳入 persona，而非恒定命中）
    store.preferences.set('RobinRead.ai.persona', { id: 'custom', custom: 'PROBE-PERSONA-B' });
    check('P1-2c persona 变化后缓存 miss', store.existingArticleWork(workID, AIArtifactKind.deepRead) == null);
    store.preferences.set('RobinRead.ai.persona', { id: 'custom', custom: 'PROBE-PERSONA-A' });
    // 重新生成：行复用（不新增行）
    await store.deepRead(workID);
    const deepRows = db.prepare('SELECT COUNT(*) c FROM ai_artifacts WHERE item_id = ? AND kind = ?').get(workID, AIArtifactKind.deepRead).c;
    check('P2-12a deepRead 重复生成复用同一行', deepRows === 1 && deepCalls === 2, `rows=${deepRows} calls=${deepCalls}`);

    // ── P2-12：housekeeping 同 item 同 kind 保留最新 3 条 ──
    for (let n = 1; n <= 5; n += 1) {
      store.artifactsRepo.saveArtifact({
        id: `probe-art-${n}`, accountID: LOCAL_ACCOUNT_ID, itemID: fiveIDs[1],
        subjectKey: `summary:${fiveIDs[1]}:v${n}`, kind: AIArtifactKind.summary,
        contentHash: `hash-${n}`, model: 'probe', targetLanguage: 'zh',
        content: `产物 ${n}`, segments: [], isComplete: true,
      });
    }
    const beforeKeep = db.prepare('SELECT COUNT(*) c FROM ai_artifacts WHERE item_id = ? AND kind = ?').get(fiveIDs[1], AIArtifactKind.summary).c;
    store.housekeeping();
    const afterKeep = db.prepare('SELECT COUNT(*) c FROM ai_artifacts WHERE item_id = ? AND kind = ?').get(fiveIDs[1], AIArtifactKind.summary).c;
    check('P2-12b housekeeping 同 item+kind 保留 3 条', beforeKeep === 5 && afterKeep === 3, `${beforeKeep}->${afterKeep}`);

    // ── P1-5：导出离线 HTML 转义 ──
    const evilFeed = store.feedsRepo.insertFeed({
      accountID: LOCAL_ACCOUNT_ID, title: '<img src=x onerror=alert(1)>', siteURL: 'https://x.example.com/',
      feedURL: 'https://x.example.com/feed.xml',
    });
    store.articlesRepo.upsertEntry({
      id: 'local:evil:1', accountID: LOCAL_ACCOUNT_ID, externalID: 'local:evil:1', feedID: evilFeed.id,
      title: '<script>alert("title")</script>', author: '"><svg onload=1>', url: 'https://x.example.com/e',
      publishedAt: Math.floor(Date.now() / 1000), summary: 's', contentHTML: '<p>正文内容。</p>',
      dateArrived: Math.floor(Date.now() / 1000),
    });
    const evilHTML = store.exportEntryHtml('local:evil:1');
    check('P1-5a 恶意 title 不落原样', !evilHTML.includes('<script>alert("title")</script>'));
    check('P1-5b 恶意 title 已转义', evilHTML.includes('&lt;script&gt;'));
    check('P1-5c feed.title/author 已转义',
      !evilHTML.includes('<img src=x onerror') && !evilHTML.includes('<svg onload') && evilHTML.includes('&lt;svg onload=1&gt;'));

    // ── P2-3：dailyReview 本地时区口径 ──
    store.knowledge.addHighlight({ itemID: fiveIDs[2], text: '今日高亮探针' });
    const todayKey = store.knowledge._localDate();
    const review = store.knowledge.dailyReview(todayKey);
    check('P2-3 今日高亮进今日回顾（本地时区）',
      review.highlights.some((h) => h.text === '今日高亮探针'), `date=${todayKey} n=${review.highlights.length}`);

    // ── P2-6：标题翻译缓存封顶 2000（mock complete，测毕还原）──
    const seed = {};
    for (let i = 0; i < 1999; i += 1) seed[`old-title-${i}`] = '旧译';
    store.preferences.set('RobinRead.titleTranslations', seed);
    const originalComplete = store.llm.complete.bind(store.llm);
    store.llm.complete = async () => '1. 译一\n2. 译二\n3. 译三';
    await store.translateTitlesBulk([
      { id: 't1', title: 'Alpha One' }, { id: 't2', title: 'Beta Two' }, { id: 't3', title: 'Gamma Three' },
    ]);
    store.llm.complete = originalComplete; // 还原，P1-3 要测真实的取消链
    const titleCache = store.preferences.get('RobinRead.titleTranslations', {});
    const titleCacheN = Object.keys(titleCache).length;
    check('P2-6 标题翻译缓存封顶 2000 且新译在', titleCacheN <= 2000 && titleCache['Alpha One'] === '译一', `n=${titleCacheN}`);

    // ── P1-3：LLM 取消链（外部 signal 直达 fetch 层）──
    const cfg = store.llmConfigurationSnapshot();
    const abortedAC = new AbortController(); abortedAC.abort();
    let nonStreamCancelled = false;
    try { await store.llm.complete({ prompt: 'x', system: 'y', configuration: cfg, apiKey: 'k', signal: abortedAC.signal }); }
    catch (e) { nonStreamCancelled = /cancel/i.test(String(e && e.message)); }
    check('P1-3a 非流式预中止 signal → cancelled（未发请求）', nonStreamCancelled === true);
    let streamCancelled = false;
    try {
      await store.llm.complete({
        prompt: 'x', system: 'y', configuration: cfg, apiKey: 'k',
        onDelta: () => {}, signal: abortedAC.signal,
      });
    } catch (e) { streamCancelled = /cancel/i.test(String(e && e.message)); }
    check('P1-3b 流式预中止 signal → cancelled（未发请求）', streamCancelled === true);

    // ── P2-11：写文件路径 token（主进程侧）──
    const victimPath = path.join(os.tmpdir(), `robinread-audit-victim-${Date.now()}.txt`);
    let rejected = false;
    try { assertWritablePath(victimPath); } catch (_) { rejected = true; }
    check('P2-11a 未登记路径被拒绝', rejected === true);
    registerSavedPath(victimPath);
    let accepted = true;
    try { assertWritablePath(victimPath); } catch (_) { accepted = false; }
    check('P2-11b 已登记路径放行', accepted === true);
    consumeSavedPath(victimPath);
    let rejectedAfterConsume = false;
    try { assertWritablePath(victimPath); } catch (_) { rejectedAfterConsume = true; }
    check('P2-11c token 一次性消费', rejectedAfterConsume === true);
    let userDataOK = true;
    try { assertWritablePath(path.join(userData, 'exports', 'a.txt')); } catch (_) { userDataOK = false; }
    check('P2-11d userData 子目录放行', userDataOK === true);

    // ── P0-1 + P2-8：更新包 sha256 校验与取消（本地 HTTP 服务）──
    const payload = Buffer.from('FAKE-NSIS-INSTALLER-BYTES'.repeat(500));
    const goodHash = crypto.createHash('sha256').update(payload).digest('hex');
    let slow = false;
    const srv = http.createServer((req, res) => {
      if (!slow) { res.writeHead(200, { 'content-length': payload.length }); res.end(payload); return; }
      res.writeHead(200, { 'content-length': 100000 });
      let sent = 0;
      const timer = setInterval(() => { res.write(Buffer.alloc(1024, 7)); sent += 1024; if (sent >= 100000) { clearInterval(timer); res.end(); } }, 25);
      req.on('close', () => clearInterval(timer));
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const assetURL = `http://127.0.0.1:${srv.address().port}/RobinRead-9.9.9-setup.exe`;
    const updDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-audit-upd-'));
    const upd = new UpdaterService(updDir);
    check('P0-1a sha256 匹配放行', (await upd.download(assetURL, 'a-setup.exe', null, null, goodHash)).sha256Verified === true);
    let badRejected = false; let badFileGone = false;
    try { await upd.download(assetURL, 'b-setup.exe', null, null, '0'.repeat(64)); }
    catch (e) { badRejected = /校验失败/.test(String(e && e.message)); }
    badFileGone = !fs.existsSync(path.join(updDir, 'updates', 'b-setup.exe'));
    check('P0-1b sha256 不匹配拒绝且删包', badRejected && badFileGone, `rejected=${badRejected} fileGone=${badFileGone}`);
    check('P0-1c 无 sha256 时退回放行（日志标注）',
      (await upd.download(assetURL, 'c-setup.exe', null, null, null)).sha256Verified === false);
    check('P0-1d release 元数据解析（map/单值）',
      upd.resolveSetupAssetSHA256({ sha256: `sha256:${goodHash}` }, 'x-setup.exe') === goodHash
      && upd.resolveSetupAssetSHA256({ assets: [{ name: 'K-setup.exe', digest: { sha256: goodHash } }] }, 'K-setup.exe') === goodHash
      && upd.resolveSetupAssetSHA256({}, 'x-setup.exe') == null);
    slow = true;
    const cancelPromise = upd.download(assetURL, 'd-setup.exe', () => {}, null, null)
      .then(() => ({ ok: false, err: 'completed' }), (e) => ({ ok: true, err: String(e && e.message) }));
    await sleep(250);
    const cancelRet = upd.cancel();
    const cancelResult = await cancelPromise;
    await sleep(200);
    check('P2-8a cancel() 中止在途下载', cancelRet === true && cancelResult.ok === true, JSON.stringify(cancelResult));
    check('P2-8b 半成品已清理', !fs.existsSync(path.join(updDir, 'updates', 'd-setup.exe')));
    slow = false;
    srv.close();

    // ── P1-1 + P2-11（IPC 链路）：captureRect 可调用 / 写通道拒绝未登记路径 ──
    const win = new BrowserWindow({
      show: true, width: 420, height: 300, useContentSize: true,
      webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
    });
    registerIPCHandlers(store, win);
    await win.loadURL('data:text/html,<html><body style="background:#fff"><h1>auditfix-probe</h1></body></html>');
    await sleep(900);
    const run = async (js) => {
      try { return await win.webContents.executeJavaScript(js, true); }
      catch (e) { return { ok: false, error: 'rejected: ' + String((e && e.message) || e) }; }
    };
    const capJS = `window.robin.captureRect({ x: 0, y: 0, width: 60, height: 40 })
      .then((v) => ({ ok: !!(v && v.ok), len: v && v.data ? String(v.data).length : 0, err: v && v.error }))
      .catch((e) => ({ ok: false, err: String(e) }))`;
    let cap = await run(capJS);
    if (!(cap.ok === true && cap.len > 100)) {
      await sleep(900); // 首帧未上屏时重试一次
      cap = await run(capJS);
    }
    check('P1-1 captureRect 通道可调用（不再 ReferenceError）', cap.ok === true && cap.len > 100, JSON.stringify(cap));
    const writeVictim = path.join(os.tmpdir(), `robinread-audit-ipc-victim-${Date.now()}.txt`);
    const wv = await run(`window.robin.writeTextFile(${JSON.stringify(writeVictim)}, 'x')
      .then((v) => ({ ok: !!(v && v.ok), err: v && v.error })).catch((e) => ({ ok: false, err: String(e) }))`);
    check('P2-11e IPC 写未登记路径被拒', wv.ok === false && /授权/.test(String(wv.err)), JSON.stringify(wv));
    check('P2-11f 拒绝后文件确实未写', !fs.existsSync(writeVictim));
    if (!win.isDestroyed()) win.destroy();

    db.close();
  } catch (err) {
    failed += 1;
    console.error('FAIL unexpected-error', err && (err.stack || err.message));
  }

  console.log(failed === 0 ? 'AUDITFIX-MAIN PROBE: ALL PASSED' : `AUDITFIX-MAIN PROBE: ${failed} FAILED`);
  app.exit(failed === 0 ? 0 : 1);
});
