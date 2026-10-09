'use strict';
/**
 * diag-f22-transcribe.js — F22 播客转文字稿探针（run-all OFFLINE 集，全程离线）
 *
 * mock ASR：本地 http server 收 multipart（POST /v1/audio/transcriptions），
 * 按请求序返回逐条不同文本 + segments；支持注入 500 失败 / 延迟（单飞观测）。
 *
 * 覆盖：
 *  1 v22 迁移：media_transcripts（status CHECK）/ media_transcripts_fts 入链
 *  2 配置：默认关闭未配置 → transcribe 明确报错；非法 URL 拒绝；合法配置读回
 *  3 状态机：queued → running → done；text/language/duration/segments 落库；
 *    进度推送齐备（含转写中%）；multipart 含 model/鉴权头/音频字节；临时文件即删
 *  4 幂等：done 后重复 transcribe 零新增端点请求
 *  5 本地优先：已离线条目直接读本地（转写期间零远端媒体请求）
 *  6 失败 → error（HTTP 500 落 error 列）→ 重试恢复 done
 *  7 单飞排队：并发 2 请求 → 同时最多 1 个在途（服务端 maxActive=1），排队者最终完成
 *  8 FTS 搜索：媒体视图按文字稿关键字过滤（FTS 命中 + <3 字符 LIKE 回退 + 无命中空集）
 *  9 AI 摘要：无 Key 报错；mock LLM 生成并落库 summary
 * 10 UI：转写按钮（未配置灰置/视频行无按钮）/「稿」徽标/文字稿面板（时间戳+复制+
 *    AI 摘要无 Key 灰置+摘要置顶）/关键字过滤输入实时过滤行集/Esc 关面板
 * 附：配置与文字稿跨重启持久化 + 静态接线锚点（preload/IPC/迁移/i18n/设置分区）。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f22-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 190 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

/** 生成静音 PCM wav（不同秒数 → 不同字节长度）。 */
function makeWav(filePath, seconds, sampleRate = 8000) {
  const samples = Math.floor(seconds * sampleRate);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples * 2, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, Buffer.alloc(samples * 2)]));
  return fs.statSync(filePath).size;
}

app.whenReady().then(async () => {
  // ── mock ASR 端点 + 媒体字节源（单一 handler，全程在位）──
  const wavBytes = {};
  const wavHits = {};   // GET 路径命中计数（本地优先断言用）
  const asr = {
    requests: [],      // {model, hasAuth, hasWav, label}
    texts: [],         // 按请求序生成的文字稿全文（标记 reqN / 短码 KN）
    failMode: false,
    delayMs: 0,
    active: 0,
    maxActive: 0,
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const asText = body.toString('latin1');
        const modelMatch = asText.match(/name="model"\r?\n\r?\n([^\r\n]+)/);
        asr.active += 1;
        asr.maxActive = Math.max(asr.maxActive, asr.active);
        const index = asr.requests.length;
        asr.requests.push({
          model: modelMatch ? modelMatch[1].trim() : null,
          hasAuth: /^Bearer\s+test-key$/i.test(String(req.headers.authorization || '')),
          hasWav: body.includes('RIFF'),
        });
        const label = `req${index}`;
        asr.texts.push(`标记${label} 的转写全文。第一句测试主题，短码K${index}。第二句收尾内容。`);
        const finish = () => {
          asr.active -= 1;
          if (asr.failMode) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'mock asr internal error' } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            text: asr.texts[index],
            language: 'zh',
            duration: 12.5 + index,
            segments: [
              { start: 0, end: 6, text: `标记${label} 的转写全文。` },
              { start: 6, end: 13, text: '第一句测试主题，第二句收尾内容。' },
            ],
          }));
        };
        if (asr.delayMs > 0) setTimeout(finish, asr.delayMs);
        else finish();
      });
      return;
    }
    wavHits[req.url] = (wavHits[req.url] || 0) + 1;
    const body = wavBytes[req.url] || Buffer.alloc(0);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const asrURL = `http://127.0.0.1:${port}/v1/audio/transcriptions`;
  const wavURL = (name) => `http://127.0.0.1:${port}/${name}.mp3`;

  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);

    // ── 1. v22 迁移 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v22-events-transcripts'").get(),
      '1 v22 迁移 events-transcripts 已入链');
    const statusSQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='media_transcripts'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/status[^']*'queued'\s*,\s*'running'\s*,\s*'done'\s*,\s*'error'/i.test(statusSQL),
      '1 media_transcripts.status 状态机 CHECK 约束在位（queued/running/done/error）');
    ok(!!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_transcripts_fts'").get(),
      '1 media_transcripts_fts FTS 虚表在位（全文检索旁路）');
    ok(['segments_json', 'summary', 'error'].every((c) => store.database.prepare('PRAGMA table_info(media_transcripts)').all().map((x) => x.name).includes(c)),
      '1 segments_json/summary/error 列在位');

    // ── 场景源：6 音频（a6 留作未转写灰置样本）+ 1 视频 ──
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F22 电台', feedURL: 'https://f22.test/radio.xml' });
    const entries = [];
    for (const [name, secs] of [['a1', 2], ['a2', 3], ['a3', 4], ['a4', 5], ['a5', 6], ['a6', 7]]) {
      const wavPath = path.join(os.tmpdir(), `robinread-f22-${name}.wav`);
      const bytes = makeWav(wavPath, secs);
      wavBytes[`/${name}.mp3`] = fs.readFileSync(wavPath);
      entries.push({
        id: `f22-${name}`, title: `电台节目 ${name}`, url: `https://f22.test/radio/${name}`,
        publishedAt: Math.floor(Date.now() / 1000) - 60, summary: '', contentHTML: '<p>audio</p>',
        enclosure: { url: wavURL(name), mime: 'audio/mpeg', kind: 'audio', lengthBytes: bytes, durationSeconds: secs },
      });
    }
    entries.push({
      id: 'f22-vid', title: '电台视频一期', url: 'https://f22.test/radio/vid',
      publishedAt: Math.floor(Date.now() / 1000) - 30, summary: '', contentHTML: '<p>video</p>',
      enclosure: { url: wavURL('a1'), mime: 'video/mp4', kind: 'video', lengthBytes: 1000, durationSeconds: 2 },
    });
    const ids = store._applyParsedEntries(feed, entries);
    const [a1, a2, a3, a4, a5, a6, vid] = ids;
    ok(ids.length === 7 && store.media.list({ filter: 'all', limit: 50 }).length === 7, '附 场景源灌入 6 音频 + 1 视频');

    const waitStatus = async (id, status, ms = 25000) => {
      const t0 = Date.now();
      for (;;) {
        const tx = store.media.transcript(id);
        if (tx.status === status) return tx;
        if (Date.now() - t0 > ms) return tx;
        await sleep(60);
      }
    };

    // ── 2. 配置默认态 ──
    let cfg = store.media.transcribeConfig();
    ok(cfg.enabled === false && cfg.url === '' && store.media.transcribeReady() === false,
      '2 默认关闭且未配置（不内置任何云端默认）');
    const noConfigErr = await (async () => store.media.transcribe(a1))().then(() => null, (e) => String(e.message || e));
    ok(!!noConfigErr && noConfigErr.includes('尚未配置转写端点'), `2 未配置时 transcribe 明确报错（${(noConfigErr || '').slice(0, 24)}…）`);
    const badURLErr = await (async () => store.media.transcribeSetConfig({ url: 'ftp://x' }))().then(() => null, (e) => String(e.message || e));
    ok(!!badURLErr && badURLErr.includes('http(s)'), '2 非法 URL（非 http(s)）写配置被拒');
    cfg = store.media.transcribeSetConfig({ enabled: true, url: asrURL, model: 'mock-whisper', apiKey: 'test-key' });
    ok(cfg.enabled === true && cfg.url === asrURL && cfg.model === 'mock-whisper' && cfg.apiKey === 'test-key'
      && store.media.transcribeReady() === true, '2 合法配置写回读回一致（enabled/url/model/key）');

    // ── 3. 状态机 queued → running → done（远端取源路径）──
    const progressStates = [];
    const offProgress = store.media.onTranscribeProgress((p) => progressStates.push(`${p.state}${p.pct != null ? ':' + p.pct : ''}`));
    const queued = store.media.transcribe(a1);
    ok(queued.status === 'queued' || queued.status === 'running', `3 发起转写即入状态机（${queued.status}）`);
    const doneTx = await waitStatus(a1, 'done');
    ok(doneTx.status === 'done' && doneTx.text.includes('标记req0'), '3 转写完成：mock 全文落库（标记 req0）');
    ok(doneTx.language === 'zh' && doneTx.durationSeconds === 12.5 && doneTx.segments?.length === 2,
      '3 language/duration/segments 落库（时间戳渲染数据面）');
    ok(progressStates.some((s) => s.startsWith('queued')) && progressStates.some((s) => s.startsWith('running'))
      && progressStates.some((s) => s.startsWith('done')), `3 进度推送齐备（${[...new Set(progressStates.map((s) => s.split(':')[0]))].join('/')}）`);
    ok(progressStates.some((s) => /^running:\d+/.test(s)), '3 取源阶段推送「转写中 N%」（running:N%）');
    const req0 = asr.requests[0];
    ok(req0.model === 'mock-whisper' && req0.hasAuth && req0.hasWav,
      '3 multipart 到端点：model 字段/Bearer 鉴权头/音频字节齐备');
    const tmpLeft = fs.existsSync(store.media.mediaDir)
      ? fs.readdirSync(store.media.mediaDir).filter((f) => f.includes('.asr-tmp')) : [];
    ok(tmpLeft.length === 0, '3 临时下载文件转写完即删（.asr-tmp 零残留）');

    // ── 4. 幂等 ──
    const hitsBefore = asr.requests.length;
    const again = await store.media.transcribe(a1);
    await sleep(300);
    ok(again.status === 'done' && asr.requests.length === hitsBefore, '4 done 后重复 transcribe 幂等（端点零新增请求）');

    // ── 5. 本地优先（已离线条目直接读本地）──
    await store.media.download(a2);
    const wavHitsBefore = wavHits['/a2.mp3'] || 0;
    const a2Tx = store.media.transcribe(a2);
    ok(a2Tx.status === 'queued' || a2Tx.status === 'running', '5 已离线条目发起转写');
    const a2Done = await waitStatus(a2, 'done');
    ok(a2Done.status === 'done' && (wavHits['/a2.mp3'] || 0) === wavHitsBefore,
      '5 本地优先：转写期间零远端媒体请求（直接读本地文件）');

    // ── 6. 失败 → error → 重试恢复 ──
    await store.media.download(a3); // a3 走本地缓存，排除取源干扰
    asr.failMode = true;
    store.media.transcribe(a3);
    const errTx = await waitStatus(a3, 'error');
    ok(errTx.status === 'error' && /HTTP 500/.test(errTx.error || ''), `6 失败落 error（${(errTx.error || '').slice(0, 20)}）`);
    ok(!!store.database.prepare('SELECT error FROM media_transcripts WHERE item_id = ?').get(a3)?.error,
      '6 error 原因落库（error 列，可回显）');
    asr.failMode = false;
    store.media.transcribe(a3);
    const retryTx = await waitStatus(a3, 'done');
    ok(retryTx.status === 'done', '6 重试恢复 done（失败可重试）');

    // ── 7. 单飞排队（延迟注入观测并发）──
    asr.delayMs = 450;
    store.media.transcribe(a4);
    store.media.transcribe(a5);
    await sleep(150);
    const st4 = store.media.transcript(a4).status;
    const st5 = store.media.transcript(a5).status;
    ok([st4, st5].filter((s) => s === 'running').length <= 1
      && [st4, st5].includes('running') && [st4, st5].includes('queued'),
      `7 并发 2 请求：单飞在途 + 排队（a4=${st4} a5=${st5}）`);
    await waitStatus(a5, 'done');
    ok(asr.maxActive === 1, `7 服务端观测最大并发 = ${asr.maxActive}（单飞）`);
    ok(store.media.transcript(a4).status === 'done' && store.media.transcript(a5).status === 'done',
      '7 排队任务接力完成（队列 drain）');
    asr.delayMs = 0;

    // ── 8. FTS 关键字过滤 ──
    const hitRows = store.media.list({ filter: 'all', query: '标记req0' });
    ok(hitRows.length === 1 && hitRows[0].itemID === a1, `8 FTS 命中：标记req0 → 仅 a1（${hitRows.length} 行）`);
    const hitRows2 = store.media.list({ filter: 'all', query: '第二句收尾内容' });
    ok(hitRows2.length === 5, `8 共有关键词命中全部 5 条已转写条目（${hitRows2.length} 行）`);
    // 注：a3 首转（500 失败）消耗请求序 2，重试成功消耗请求序 3 → a3 的标记是 req3/K3
    const likeRows = store.media.list({ filter: 'all', query: 'K3' });
    ok(likeRows.length === 1 && likeRows[0].itemID === a3, '8 <3 字符查询回退 LIKE：K3 → 仅 a3');
    const noneRows = store.media.list({ filter: 'all', query: '绝对不存在的关键字组合' });
    ok(noneRows.length === 0, '8 无命中关键字 → 空集');
    ok(store.media.list({ filter: 'all', query: '标记req3' }).length === 1
      && store.media.list({ filter: 'all', query: '标记req3' })[0].itemID === a3,
      '8 重试成功条目同样进 FTS（标记req3 命中 a3）');
    ok(store.media.list({ filter: 'all', query: '标记req0', kind: 'audio' }).length === 1
      && store.media.list({ filter: 'all', query: '标记req0', kind: 'video' }).length === 0,
      '8 关键字过滤与 kind 筛选叠加生效');

    // ── 9. AI 摘要 ──
    const noKeyErr = await (async () => store.media.transcriptSummary(a1))().then(() => null, (e) => String(e.message || e));
    ok(!!noKeyErr && (noKeyErr.includes('API Key') || noKeyErr.includes('AI')), `9 无 Key 生成摘要被拒（${(noKeyErr || '').slice(0, 24)}…）`);
    store._requireAIReady = () => ({ config: { targetLanguage: '中文', model: 'mock' }, apiKey: 'mock-key' });
    let promptHadText = false;
    store.media._llmComplete = async ({ prompt }) => {
      promptHadText = /transcript/i.test(prompt) && (prompt || '').length > 40;
      return 'AI 摘要：本期节目讲测试主题，三句话总结。';
    };
    const sum = await store.media.transcriptSummary(a1);
    ok(promptHadText, '附 摘要 prompt 携带文字稿正文');
    ok(!!sum.summary && sum.summary.includes('AI 摘要'), '9 mock LLM 生成摘要');
    ok(store.media.transcript(a1).summary?.includes('三句话总结'), '9 摘要落库（summary 列，面板顶部数据面）');

    // ── 10. UI（真 IPC + 真 index.html）──
    const ui = await mediaUIProbe(store, { a1, a6, vid, req0Mark: '标记req0' });
    ok(ui.booted, '附 UI 探针窗口启动（index.html + preload + 真 IPC）');
    ok(ui.searchInput === true, '10 媒体视图文字稿过滤输入框在位');
    ok(ui.videoNoTx === true, '10 视频行无转写按钮（仅音频行）');
    ok(ui.audioTxButtons >= 6, `10 音频行转写入口齐备（${ui.audioTxButtons} 个）`);
    ok(ui.transcriptBadges >= 5, `10 已转写条目「稿」徽标齐备（${ui.transcriptBadges} 个）`);
    ok(ui.grayWhenDisabled === true, '10 未启用配置时转写按钮灰置（disabled + tooltip 指路设置）');
    ok(ui.panelOpens === true && ui.timestampSegs >= 2 && ui.timestampTextOk === true,
      `10 文字稿面板：segments 渲染时间戳行（首个 ${ui.timestampText}）`);
    ok(ui.copyBtn === true && ui.aiBtnDisabled === true, '10 复制按钮在位；AI 摘要无 Key 灰置');
    ok(ui.summaryTop === true, '10 已生成摘要置顶展示在面板顶部');
    ok(ui.filterWorks === true, `10 过滤输入实时过滤行集（命中后 ${ui.filteredRows} 行）`);
    ok(ui.escCloses === true, '10 Esc 关闭文字稿面板');

    // ── 附：配置与文字稿跨重启持久化 ──
    store.preferences.flushSync();
    store.database.close();
    const store2 = new AppStore(userData);
    const cfg2 = store2.media.transcribeConfig();
    const tx2 = store2.media.transcript(a1);
    ok(cfg2.enabled === true && cfg2.url === asrURL && cfg2.model === 'mock-whisper', '附 转写配置跨重启持久化');
    ok(tx2.status === 'done' && tx2.text.includes('标记req0') && !!tx2.summary, '附 文字稿与摘要跨重启保留');
    store2.media.dispose();
    store2.preferences.flushSync();
    store2.database.close();
    offProgress();

    // ── 附：静态接线锚点 ──
    const preloadSrc = read('src/main/preload.js');
    ok(['transcribeMedia', 'mediaTranscript', 'transcribeGetConfig', 'transcribeSetConfig',
      'transcriptSummary', 'onTranscribeProgress'].every((n) => preloadSrc.includes(n)),
      '附 preload 桥转写 6 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(['media:transcribe', 'media:transcript', 'media:transcribeConfig:get', 'media:transcribeConfig:set',
      'media:transcript:summary', 'media:transcribe-progress'].every((c) => ipcSrc.includes(`'${c}'`)),
      '附 IPC 转写通道注册齐备');
    const migrationsSrc = read('src/main/Persistence/DatabaseMigrations.js');
    ok(migrationsSrc.includes('v22-events-transcripts') && migrationsSrc.includes('media_transcripts_fts'),
      '附 v22 迁移在迁移链中（DDL 只进迁移链）');
    const stringsSrc = read('src/main/I18NStrings.js');
    ok(stringsSrc.includes('"文字稿"') && stringsSrc.includes('"转写中 %lld%"') && stringsSrc.includes('"重试转写"')
      && stringsSrc.includes('"搜索文字稿…"') && stringsSrc.includes('"AI 摘要"'),
      '附 i18n 中英键齐备（文字稿/转写中/重试/搜索/AI 摘要）');
    const dialogsSrc = read('src/renderer/views/dialogs.js');
    ok(dialogsSrc.includes("id: 'transcribe'") && dialogsSrc.includes('_transcribe(container)'),
      '附 设置「转写」分区在册（端点/Key/模型配置）');
    const mvSrc = read('src/renderer/views/media-view.js');
    ok(mvSrc.includes('nj-media-tx') && mvSrc.includes('nj-transcript-modal') && mvSrc.includes('nj-media-transcript-badge'),
      '附 媒体视图转写按钮/面板/稿徽标接线');

    server.close();
    try { fs.rmSync(userData, { recursive: true, force: true }); }
    catch (_) { /* 临时目录留给系统清理 */ }
    console.log(failed === 0 ? 'ALL PASSED' : `FAILED ${failed}`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('ERR', String((err && err.stack) || err).slice(0, 1600));
    app.exit(1);
  }
});

/**
 * 媒体视图 UI 探针：真 IPC 信封链路。转写状态/徽标/面板/过滤全走真实数据。
 */
async function mediaUIProbe(store, { a1, a6, vid, req0Mark }) {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: { contextIsolation: true, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
  const { registerIPCHandlers } = require('../src/main/ipc');
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(900);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 8000) => {
      const t0 = Date.now();
      for (;;) {
        let v = null;
        try { v = await fn(); } catch (_) { v = null; }
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(100);
      }
    };
    const ids = ${JSON.stringify({ a1, a6, vid, req0Mark })};
    try {
      const { MediaView } = await import('./views/media-view.js');
      const out = { booted: true };
      const mv = new MediaView({ onOpenArticle: () => {}, player: null, toast: () => {} });
      mv.present();
      await waitFor(() => document.querySelectorAll('.nj-media-row').length >= 7 ? true : null);
      out.searchInput = !!document.querySelector('.nj-media-search input');
      const videoRow = document.querySelector('.nj-media-row[data-item-id="' + ids.vid + '"]');
      out.videoNoTx = !!videoRow && !videoRow.querySelector('.nj-media-tx, .nj-media-tx-open, .nj-media-tx-status');
      const audioTx = [...document.querySelectorAll('.nj-media-row')].filter((r) => r.querySelector('.nj-media-tx, .nj-media-tx-open'));
      out.audioTxButtons = audioTx.length;
      out.transcriptBadges = document.querySelectorAll('.nj-media-transcript-badge').length;
      // 未启用配置 → 未转写条目（a6）转写按钮灰置（disabled + tooltip 指路设置）
      await window.robin.transcribeSetConfig({ enabled: false });
      mv._transcribeReady = false;
      await mv._load();
      await sleep(200);
      const grayBtn = document.querySelector('.nj-media-row[data-item-id="' + ids.a6 + '"] .nj-media-tx');
      out.grayWhenDisabled = !!grayBtn && grayBtn.disabled === true
        && (grayBtn.title || '').includes('未配置转写端点');
      await window.robin.transcribeSetConfig({ enabled: true });
      mv._transcribeReady = true;
      await mv._load();
      await sleep(200);
      const activeBtn = document.querySelector('.nj-media-row[data-item-id="' + ids.a6 + '"] .nj-media-tx');
      out.activeWhenEnabled = !!activeBtn && activeBtn.disabled === false;
      // 文字稿面板：a1（done + segments + summary）
      const openBtn = await waitFor(() => document.querySelector('.nj-media-row[data-item-id="' + ids.a1 + '"] .nj-media-tx-open'));
      openBtn.click();
      await waitFor(() => document.querySelector('.nj-transcript-modal') ? true : null);
      const panel = document.querySelector('.nj-transcript-modal');
      out.panelOpens = !!panel;
      out.timestampSegs = panel.querySelectorAll('.nj-transcript-ts').length;
      out.timestampText = (panel.querySelector('.nj-transcript-ts')?.textContent || '').slice(0, 5);
      out.timestampTextOk = /^[0-9]{2}:[0-9]{2}/.test(out.timestampText);
      out.copyBtn = [...panel.querySelectorAll('.nj-transcript-foot button')].some((b) => (b.textContent || '').includes('复制'));
      const aiBtn = [...panel.querySelectorAll('.nj-transcript-foot button')].find((b) => (b.textContent || '').includes('AI 摘要'));
      out.aiBtnDisabled = !!aiBtn && aiBtn.disabled === true; // 无 Key（探针 store 无 API Key）
      out.summaryTop = !!panel.querySelector('.nj-transcript-summary')
        && (panel.querySelector('.nj-transcript-summary-text')?.textContent || '').includes('三句话总结');
      // Esc 关面板
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(120);
      out.escCloses = !document.querySelector('.nj-transcript-modal');
      // 关键字过滤输入：标记req0 → 仅 a1 行
      const input = document.querySelector('.nj-media-search input');
      input.value = ids.req0Mark;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const filtered = await waitFor(() => document.querySelectorAll('.nj-media-row').length === 1 ? true : null, 6000);
      out.filteredRows = document.querySelectorAll('.nj-media-row').length;
      out.filterWorks = filtered === true && out.filteredRows === 1
        && !!document.querySelector('.nj-media-row[data-item-id="' + ids.a1 + '"]');
      mv.dismiss();
      return out;
    } catch (e) {
      return { error: String((e && e.stack) || e).slice(0, 700) };
    }
  })()`);
  win.destroy();
  if (!result || result.error) console.error('media UI probe error:', result && (result.error || result));
  return result || {};
}
