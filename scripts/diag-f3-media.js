'use strict';
/**
 * diag-f3-media.js — F3 媒体中心端到端探针（run-all OFFLINE 集，全程离线）
 *
 * 音频源：探针内生成静音 wav（本地 http server 供下载 + file:// 本地播放），
 * 渲染层用真实 HTMLAudioElement 播放（真实 timeupdate/pause/ended 事件驱动断言）。
 *
 * 覆盖（对应 F3 验收 10 条）：
 *  1 enclosure 解析入库（audio+video 各一；mime/kind/url/duration 正确；重复刷新零重复行）
 *  2 无 enclosure 源零媒体行
 *  3 媒体视图渲染（行数 / 全部-未播完-已播完筛选正确 / 离线徽标）
 *  4 播放器单实例（开第二个媒体：单一 audio 元素、第一个被替换停止）
 *  5 进度持久化+续播（播到 N 秒 flush → 重开恢复；>95% 归零视为播完）
 *  6 倍速切换 playbackRate 生效（1 → 1.25 循环 + setRate(2)）
 *  7 队列连播（3 项队列真实 ended 自动下一首 + 手动跳下一首）
 *  8 下载：流式落盘存在、大小>0、进度推送、离线徽标、播放器优先本地（file:// 断言）、删除恢复远程
 *  9 与 TTS 互斥（TTS 播放态 mock → 开媒体 → TTS 停；媒体侧 pauseForTTS 暂停音频）
 * 10 媒体视图查询耗时（200 媒体行 < 50ms）
 * 附：v13 迁移、reader 内嵌视频载荷、静态接线锚点（IPC/preload/侧栏/列表▶/i18n/令牌样式）。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f3-media-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 170 * 1000).unref();

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

/** 生成静音 PCM wav（16bit 单声道）。 */
function makeWav(filePath, seconds, sampleRate = 8000) {
  const samples = Math.floor(seconds * sampleRate);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
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
  // ── 本地 http server：提供 wav 字节（离线下载源；删除离线后「恢复远程」断言用）──
  const wavBytes = {};
  const server = http.createServer((req, res) => {
    const body = wavBytes[req.url] || Buffer.alloc(0);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const wavURL = (name) => `http://127.0.0.1:${port}/${name}.mp3`;

  try {
    const { AppStore } = require('../src/main/AppStore');
    const FeedParser = require('../src/main/FeedParser');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(userData);

    // ── 附：v13 迁移落地 ──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v13-media-items'").get(),
      '附 v13 迁移 media_items 已入链');
    ok(!!store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_items'").get(),
      '附 media_items 表存在（DDL 只进迁移链）');

    // ── 1. enclosure 解析入库（audio + video）──
    const podcastXML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>F3 播客台</title>
<item><title>第 1 期：音频节目</title><guid>f3-a-1</guid>
  <enclosure url="https://f3.test/audio/ep1.mp3" type="audio/mpeg" length="123456"/>
  <itunes:duration>1:02:03</itunes:duration>
</item>
<item><title>第 2 期：视频节目</title><guid>f3-v-1</guid>
  <enclosure url="https://f3.test/video/ep1.mp4" type="video/mp4" length="654321"/>
</item>
<item><title>第 3 期：没有附件</title><guid>f3-none-1</guid></item>
</channel></rss>`;
    const parsedPodcast = FeedParser.parse(podcastXML, 'https://f3.test/feed.xml');
    ok(parsedPodcast.entries.length === 3
      && parsedPodcast.entries[0].enclosure && parsedPodcast.entries[1].enclosure
      && parsedPodcast.entries[2].enclosure === null,
      '1 FeedParser 解析：audio/video enclosure 各一，无附件条目为 null');
    ok(parsedPodcast.entries[0].enclosure.kind === 'audio'
      && parsedPodcast.entries[0].enclosure.mime === 'audio/mpeg'
      && parsedPodcast.entries[0].enclosure.url === 'https://f3.test/audio/ep1.mp3'
      && parsedPodcast.entries[0].enclosure.lengthBytes === 123456
      && parsedPodcast.entries[0].enclosure.durationSeconds === 3723,
      '1 audio enclosure：kind/mime/url/length 正确 + itunes:duration 解析为秒（1:02:03→3723）');
    ok(parsedPodcast.entries[1].enclosure.kind === 'video' && parsedPodcast.entries[1].enclosure.mime === 'video/mp4',
      '1 video enclosure：kind/mime 正确');

    const feedPodcast = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F3 播客台', feedURL: 'https://f3.test/feed.xml' });
    const newIDs = store._applyParsedEntries(feedPodcast, parsedPodcast.entries);
    const mediaRows = () => store.database.prepare('SELECT COUNT(*) AS n FROM media_items').get().n;
    ok(mediaRows() === 2, '1 灌文入库：2 条媒体行（第 3 期无附件零行）');
    const m1 = store.media.forItem(newIDs[0]);
    const m2 = store.media.forItem(newIDs[1]);
    ok(m1.kind === 'audio' && m1.url === 'https://f3.test/audio/ep1.mp3' && m1.mime === 'audio/mpeg' && m1.durationSeconds === 3723,
      '1 media_items 行：audio 条目 mime/kind/url/duration 与解析一致');
    ok(m2.kind === 'video' && m2.url === 'https://f3.test/video/ep1.mp4' && m2.mime === 'video/mp4',
      '1 media_items 行：video 条目 kind/mime/url 正确');
    // 重复刷新（同 guid 再灌）→ 零重复行；播放进度不被元数据 upsert 触碰
    store.media.saveProgress(newIDs[0], 600);
    store._applyParsedEntries(feedPodcast, parsedPodcast.entries);
    ok(mediaRows() === 2, '1 重复刷新零重复行（PK 防重）');
    ok(store.media.forItem(newIDs[0]).positionSeconds === 600, '1 元数据 upsert 不清播放进度');

    // ── 2. 无 enclosure 源零行 ──
    const beforeNoMedia = mediaRows();
    const feedPlain = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F3 纯文本源', feedURL: 'https://f3.test/plain.xml' });
    store._applyParsedEntries(feedPlain, [
      { id: 'plain-1', title: '纯文本一篇', url: 'https://f3.test/plain/1', publishedAt: Math.floor(Date.now() / 1000) - 60, summary: '', contentHTML: '<p>x</p>', enclosure: null },
      { id: 'plain-2', title: '纯文本二篇', url: 'https://f3.test/plain/2', publishedAt: Math.floor(Date.now() / 1000) - 60, summary: '', contentHTML: '<p>y</p>', enclosure: null },
    ]);
    ok(mediaRows() === beforeNoMedia, '2 无 enclosure 源灌文后媒体行数不变（零行）');

    // ── 可播放场景源：5 条音频（本地 http server wav）+ 1 条视频 ──
    const feedPlay = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F3 电台', feedURL: 'https://f3.test/radio.xml' });
    const playEntries = [];
    for (const name of ['a1', 'a2', 'a3', 'a4', 'a5']) {
      const wavPath = path.join(os.tmpdir(), `robinread-f3-${name}.wav`);
      const bytes = makeWav(wavPath, 2);
      wavBytes[`/${name}.mp3`] = fs.readFileSync(wavPath);
      playEntries.push({
        id: `f3-radio-${name}`, title: `电台节目 ${name}`, url: `https://f3.test/radio/${name}`,
        publishedAt: Math.floor(Date.now() / 1000) - 30, summary: '', contentHTML: '<p>audio</p>',
        enclosure: { url: wavURL(name), mime: 'audio/mpeg', kind: 'audio', lengthBytes: bytes, durationSeconds: 2 },
      });
    }
    playEntries.push({
      id: 'f3-radio-vid', title: '电台视频一期', url: 'https://f3.test/radio/vid',
      publishedAt: Math.floor(Date.now() / 1000) - 20, summary: '', contentHTML: '<p>video</p>',
      enclosure: { url: wavURL('a1'), mime: 'video/mp4', kind: 'video', lengthBytes: 1000, durationSeconds: 2 },
    });
    const playIDs = store._applyParsedEntries(feedPlay, playEntries);
    const audioIDs = playIDs.slice(0, 5);
    const videoEntryID = store.database.prepare("SELECT item_id FROM media_items WHERE kind='video' AND url LIKE '%a1%'").get().item_id;
    const videoID = videoEntryID;
    ok(playIDs.length === 6 && audioIDs.length === 5, '附 场景源灌入 5 音频 + 1 视频');

    // ── 8（主进程路径）：预下载 a1-a4，流式落盘 + 进度推送 + 本地优先 + 删除恢复远程 ──
    const progressStates = new Set();
    const offProgress = store.media.onDownloadProgress((p) => progressStates.add(p.state));
    for (let i = 0; i < 4; i++) {
      const result = await store.media.download(audioIDs[i]);
      ok(result.ok === true, `8 下载 a${i + 1} 成功（流式写盘）`);
    }
    offProgress();
    const doneRow = store.media.forItem(audioIDs[0]);
    ok(doneRow.downloadState === 'done' && !!doneRow.localPath
      && fs.existsSync(doneRow.localPath) && fs.statSync(doneRow.localPath).size > 0,
      '8 流式落盘：文件存在且大小>0（download_state=done）');
    ok(progressStates.has('downloading') && progressStates.has('done'),
      '8 下载进度推送齐备（downloading + done）');
    ok(store.media.source(audioIDs[0]).isLocal === true
      && store.media.source(audioIDs[0]).url.startsWith('file://'),
      '8 播放源解析：离线后优先本地 file://');
    const afterDelete = store.media.deleteDownload(audioIDs[0]);
    ok(afterDelete.downloadState === 'none' && !afterDelete.hasLocal
      && store.media.source(audioIDs[0]).url === wavURL('a1'),
      '8 删除离线文件恢复远程 URL（可重试下载）');
    await store.media.download(audioIDs[0]); // 恢复离线（渲染层断言要用本地）

    // ── 渲染层 UI 探针（真 IPC 信封 + 真音频元素；此时尚无性能批数据 → 视图 8 行）──
    const ui = await mediaUIProbe(store, { audioIDs, videoID, videoEntryID });
    ok(ui.booted, '附 UI 探针窗口启动（index.html + preload + 真 IPC）');
    ok((ui.ttsStopped || 0) >= 1, `9 与 TTS 互斥：TTS 播放态开媒体 → stopTTS 被调用（${ui.ttsStopped} 次）`);
    ok(ui.pauseForTTSWorks === true, '9 媒体侧互斥：pauseForTTS 暂停音频（TTS 开播时由 reader 调用）');
    ok(ui.singleInstance === true, '4 播放器单实例：开第二个媒体 → 单一 audio 元素、第一个被替换');
    ok(ui.rateWorks === true, '6 倍速切换 playbackRate 生效（1 → 1.25 → 2）');
    ok(ui.resumeWorks === true, `5 进度持久化+续播（保存 ${Number(ui.savedPosition || 0).toFixed(2)}s → 重开恢复 ${Number(ui.resumedPosition || 0).toFixed(2)}s）`);
    ok(ui.finishedZero === true, '5 >95% 视为播完归零（position=0 + finished 标记）');
    ok(ui.viewRows === 8 && ui.finishedSwitch === true && ui.unfinishedSwitch === true
      && ui.unfinishedRows === 7 && ui.finishedRows === 1,
      `3 媒体视图渲染：全部 ${ui.viewRows} 行 / 未播完 ${ui.unfinishedRows} 行 / 已播完 ${ui.finishedRows} 行（筛选切换生效）`);
    ok(ui.offlineBadge === true, '3 列表行「离线可播」徽标出现（已下载条目）');
    ok(ui.ipcDownloadWorks === true, '8 UI 下载按钮 → IPC → 落盘 → 徽标（真链路 + 进度推送）');
    ok(ui.priorityLocalFile === true, '8 播放器优先本地：audio.src 为 file://（离线条目）');
    ok(ui.deleteRestoresRemote === true, '8 删除离线文件 → 播放源恢复远程（http://127.0.0.1）');
    ok(ui.queueAutoNext === true, `7 队列连播：ended 自动下一首（${(ui.queueTrace || []).join(' → ')}）`);
    ok(ui.queueSkip === true, '7 跳下一首按钮生效');
    ok(ui.videoPayload === true, '附 reader 载荷带 video 媒体（阅读器内嵌 <video controls>）');
    ok(ui.spaceKeyToggles === true, '附 媒体视图聚焦时空格切换播放/暂停（capture 消费）');

    // ── 10. 媒体视图查询耗时（200 媒体行 < 50ms；放在 UI 探针后免污染行数断言）──
    const feedPerf = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F3 性能源', feedURL: 'https://f3.test/perf.xml' });
    const perfEntries = [];
    for (let i = 0; i < 200; i++) {
      perfEntries.push({
        id: `f3-perf-${i}`, title: `性能媒体 ${i}`, url: `https://f3.test/perf/${i}`,
        publishedAt: Math.floor(Date.now() / 1000) - 3600 + i, summary: '', contentHTML: null,
        enclosure: { url: `https://f3.test/perf/${i}.mp3`, mime: 'audio/mpeg', kind: 'audio', lengthBytes: 1, durationSeconds: 60 },
      });
    }
    const tIngest = process.hrtime.bigint();
    store._applyParsedEntries(feedPerf, perfEntries);
    const ingestMs = Number(process.hrtime.bigint() - tIngest) / 1e6;
    ok(mediaRows() >= 208, `附 200 媒体行灌入（media_items 总数 ${mediaRows()}）`);
    let listMs = Infinity;
    for (let round = 0; round < 3; round++) {
      const t0 = process.hrtime.bigint();
      const rows = store.media.list({ filter: 'all', limit: 100, offset: 0 });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (rows.length === 100) listMs = Math.min(listMs, ms);
    }
    ok(listMs < 50, `10 媒体视图查询耗时（208 行取 100，${listMs.toFixed(1)}ms < 50ms；200 行灌入 ${ingestMs.toFixed(0)}ms）`);
    const counts = store.media.counts();
    ok(counts.total === mediaRows() && counts.unfinished + counts.finished === counts.total,
      `附 计数自洽（total=${counts.total} unfinished=${counts.unfinished} finished=${counts.finished}）`);

    // ── 重启读回：进度/队列/离线状态持久化 ──
    store.preferences.flushSync();
    store.database.close();
    const store2 = new AppStore(userData);
    const posAfter = store2.media.forItem(audioIDs[2]);
    const queueAfter = store2.media.queueList();
    ok(!!posAfter && queueAfter.length >= 3 && posAfter.positionSeconds > 0,
      `附 重启读回：进度/队列/离线状态持久化（队列 ${queueAfter.length} 项，续播位 ${posAfter.positionSeconds}s）`);
    store2.media.dispose();
    store2.preferences.flushSync();
    store2.database.close();

    // ── 附：静态接线锚点 ──
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    const preloadSrc = read('src/main/preload.js');
    ok(['mediaList', 'mediaCounts', 'mediaSource', 'mediaProgress', 'mediaQueueList', 'mediaQueueAdd',
      'mediaQueueRemove', 'mediaQueueClear', 'mediaQueueNext', 'mediaDownload', 'mediaDownloadDelete', 'onMediaDownloadProgress']
      .every((name) => preloadSrc.includes(name)), '附 preload 桥 12 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(['media:list', 'media:counts', 'media:source', 'media:progress', 'media:queue:list', 'media:queue:add',
      'media:queue:remove', 'media:queue:clear', 'media:queue:next', 'media:download', 'media:download:delete']
      .every((channel) => ipcSrc.includes(`'${channel}'`)), '附 IPC 通道注册齐备');
    const readerSrc = read('src/renderer/views/reader.js');
    ok(readerSrc.includes('_buildMediaCard')
      && readerSrc.includes("video.controls = true")
      && readerSrc.includes('pauseForTTS')
      && /stopTTS\(\)\s*\{/.test(readerSrc),
      '附 阅读器媒体卡片（<video controls>）+ TTS 互斥双缝接线');
    const sidebarSrc = read('src/renderer/views/sidebar.js');
    ok(sidebarSrc.includes('mediaRow') && sidebarSrc.includes('onOpenMedia') && sidebarSrc.includes('mediaUnfinished'),
      '附 侧栏「媒体」入口 + 未播完计数接线');
    const listSrc = read('src/renderer/views/list.js');
    ok(listSrc.includes('entry-media-badge') && listSrc.includes('hasMedia'), '附 列表行 ▶ 媒体标记');
    const timelineSrc = read('src/main/Persistence/TimelineQueryService.js');
    ok(timelineSrc.includes('media_items mi') && timelineSrc.includes('has_media'), '附 列表投影 has_media（媒体行标记数据面）');
    const playerSrc = read('src/renderer/views/media-player.js');
    ok(playerSrc.includes('SAVE_INTERVAL_MS = 5000') && !playerSrc.includes('requestAnimationFrame'),
      '附 迷你播放器：5s 节流持久化 + 无 rAF 轮询（timeupdate 驱动）');
    const migrationsSrc = read('src/main/Persistence/DatabaseMigrations.js');
    ok(migrationsSrc.includes('v13-media-items'), '附 v13 迁移在迁移链中');
    const stringsSrc = read('src/main/I18NStrings.js');
    ok(stringsSrc.includes('"媒体中心"') && stringsSrc.includes('"离线可播"') && stringsSrc.includes('"快进 15 秒"'),
      '附 i18n 中英键齐备（媒体中心/离线可播/快进）');
    const cssSrc = read('src/renderer/styles/robin.css');
    const mediaCss = cssSrc.split('F3 媒体中心')[1] || '';
    ok(cssSrc.includes('.nj-media-player') && cssSrc.includes('.nj-media-offline')
      && !/\.nj-[a-z-]*media[a-z-]*\s*[,{][^}]*#[0-9a-fA-F]{3,6}/.test(mediaCss),
      '附 样式走令牌（媒体区块无硬编码色值）');

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
 * UI 探针：隐藏窗口 + 真 preload + registerIPCHandlers（真 IPC 信封链路）。
 * 真实 HTMLAudioElement 播放本地 wav（file://），真实 timeupdate/pause/ended 事件驱动。
 */
async function mediaUIProbe(store, { audioIDs, videoID, videoEntryID }) {
  const { BrowserWindow } = require('electron');
  const { registerIPCHandlers } = require('../src/main/ipc');
  const win = new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
  });
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(900); // 渲染应用启动（app.js 装配迷你播放器/阅读器/侧栏）

  const idsJSON = JSON.stringify({ audioIDs, videoID, videoEntryID });
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
    const ids = ${idsJSON};
    const out = { booted: true };
    try {
      const player = window.__robinMedia;
      const reader = window.__robinReader;
      if (!player || !reader) { out.booted = false; return out; }
      const source = (id) => window.robin.mediaSource(id);
      const isPlaying = () => !!(player.audio && player.current && !player.audio.paused);
      const waitMeta = () => waitFor(() => player.audio && Number.isFinite(player.audio.duration) && player.audio.duration > 0);

      // ── 9. TTS 互斥：TTS 播放态 mock → 开媒体 → stopTTS 被调 ──
      reader._tts = { state: 'playing' };
      let ttsStopped = 0;
      reader.stopTTS = () => { ttsStopped += 1; };
      await player.open(ids.audioIDs[0]);
      out.ttsStopped = ttsStopped;
      await waitFor(() => isPlaying());
      // 媒体侧互斥：pauseForTTS 直接暂停音频（TTS 开播时 reader 调同一缝）
      player.pauseForTTS();
      await sleep(100);
      out.pauseForTTSWorks = player.audio.paused === true;
      reader._tts = null;

      // ── 4. 单实例：开第二个媒体，第一个被替换（同一 audio 元素）──
      await player.open(ids.audioIDs[1]);
      await waitFor(() => isPlaying() && player.itemID === ids.audioIDs[1]);
      const elAfterFirst = player.audio;
      await player.open(ids.audioIDs[2]);
      await waitFor(() => isPlaying() && player.itemID === ids.audioIDs[2]);
      out.singleInstance = player.audio === elAfterFirst && player.itemID === ids.audioIDs[2];

      // ── 6. 倍速 ──
      player.setRate(1);
      player.cycleRate(); // 1 → 1.25
      const rate125 = player.audio.playbackRate === 1.25;
      player.setRate(2);
      out.rateWorks = rate125 && player.audio.playbackRate === 2;
      player.setRate(1);

      // ── 5. 进度持久化 + 续播（audioIDs[2] 播到 ~0.8s → flush → 重开恢复）──
      await waitMeta();
      player.audio.currentTime = 0.8;
      await sleep(80);
      player.pauseForTTS(); // flush（pause 事件落库）
      await sleep(200);
      const saved = await source(ids.audioIDs[2]);
      out.savedPosition = saved.position;
      player.close();
      await sleep(100);
      await player.open(ids.audioIDs[2]);
      const resumed = await waitFor(() => player.audio && player.audio.currentTime > 0.4 ? player.audio.currentTime : null);
      out.resumedPosition = resumed || 0;
      out.resumeWorks = out.savedPosition > 0.5 && out.resumedPosition > 0.4 && out.resumedPosition < 1.4;
      player.close();
      await sleep(100);

      // ── 5b. >95% 归零（audioIDs[3]）──
      await player.open(ids.audioIDs[3]);
      await waitFor(() => isPlaying());
      await waitMeta();
      player.audio.currentTime = 1.96; // 2s wav 的 98%
      await sleep(80);
      player.pauseForTTS();
      await sleep(200);
      const fin = await source(ids.audioIDs[3]);
      out.finishedZero = fin.position === 0 && fin.finished === true;
      player.close();
      await sleep(100);

      // ── 3. 媒体视图渲染 + 筛选（此时媒体行 8：播客 2 + 电台 6；已播完 1 = a4）──
      const { MediaView } = await import('./views/media-view.js');
      const mv = new MediaView({ onOpenArticle: () => {}, player, toast: () => {} });
      mv.present();
      const rowsAll = await waitFor(() => mv.items.length >= 8 ? document.querySelectorAll('.nj-media-row').length : null);
      out.viewRows = rowsAll || 0;
      out.offlineBadge = document.querySelectorAll('.nj-media-row .nj-media-offline').length >= 4;
      // 筛选切换：等待行集真正变化（items 与 DOM 同步）
      const switchFilter = async (btn, expectRows) => {
        btn.click();
        const changed = await waitFor(() => mv.items.length === expectRows
          && document.querySelectorAll('.nj-media-row').length === expectRows ? true : null, 6000);
        return changed === true;
      };
      out.finishedSwitch = await switchFilter(mv._filterButtons.finished, 1);
      out.finishedRows = document.querySelectorAll('.nj-media-row').length;
      out.unfinishedSwitch = await switchFilter(mv._filterButtons.unfinished, 7);
      out.unfinishedRows = document.querySelectorAll('.nj-media-row').length;
      await switchFilter(mv._filterButtons.all, 8);

      // 空格切换（视图聚焦：capture 消费，不与阅读器空格冲突；每次派发后等 open 完全落地）
      player.close(); // 空态起点：空格播列表第一条音频
      await sleep(150);
      const beforeSpace = player.state;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
      const playingBySpace = await waitFor(() => player.state === 'playing');
      await sleep(300); // open（含 play promise）完全落地，消除与后续步骤的竞态
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
      const pausedBySpace = await waitFor(() => player.state === 'paused');
      await sleep(150);
      out.spaceKeyToggles = beforeSpace === 'idle' && !!playingBySpace && !!pausedBySpace;

      // ── 8. UI 下载（audioIDs[4] 尚未离线）：按钮 → IPC → 落盘 → 徽标 → 优先本地 → 删除恢复远程 ──
      player.close();
      await sleep(200);
      let progressSeen = false;
      window.robin.onMediaDownloadProgress((p) => { if (p.state === 'downloading' || p.state === 'done') progressSeen = true; });
      const rowSel = '.nj-media-row[data-item-id="' + ids.audioIDs[4] + '"]';
      document.querySelector(rowSel + ' .nj-media-dl').click();
      const offlineNow = await waitFor(() => document.querySelector(rowSel + ' .nj-media-offline') ? true : null, 10000);
      out.ipcDownloadWorks = offlineNow === true && progressSeen;
      await player.open(ids.audioIDs[4]);
      await waitFor(() => isPlaying());
      out.priorityLocalFile = player.audio.src.startsWith('file://');
      player.close();
      await waitFor(() => document.querySelector(rowSel + ' .nj-media-del') ? true : null, 6000);
      document.querySelector(rowSel + ' .nj-media-del').click();
      const remoteRestored = await waitFor(async () => {
        const s = await source(ids.audioIDs[4]);
        return s && !s.isLocal && s.url.startsWith('http://127.0.0.1') ? true : null;
      }, 8000);
      out.deleteRestoresRemote = remoteRestored === true;
      await window.robin.mediaDownload(ids.audioIDs[4]); // 重新离线（持久化断言用）

      // ── 7. 队列连播（真实 ended → 自动下一首 → 手动跳下一首）──
      await window.robin.mediaQueueClear();
      await window.robin.mediaQueueAdd(ids.audioIDs[0]);
      await window.robin.mediaQueueAdd(ids.audioIDs[1]);
      await window.robin.mediaQueueAdd(ids.audioIDs[2]);
      player.setRate(2); // 2x 加速真实播完
      await player.open(ids.audioIDs[0]);
      await waitFor(() => isPlaying());
      await waitMeta();
      player.audio.currentTime = 1.9; // 接近结尾 → ended 快速触发
      out.queueTrace = [String(player.itemID).slice(-6)];
      const autoNext = await waitFor(() => player.itemID === ids.audioIDs[1] ? true : null, 10000);
      out.queueTrace.push(String(player.itemID || '?').slice(-6));
      out.queueAutoNext = autoNext === true;
      await player.playNext(); // 手动跳下一首
      const skipped = await waitFor(() => player.itemID === ids.audioIDs[2] ? true : null, 8000);
      out.queueTrace.push(String(player.itemID || '?').slice(-6));
      out.queueSkip = skipped === true;
      player.setRate(1);

      // ── 附：reader 载荷带 video 媒体 ──
      const payload = await window.robin.getReader(ids.videoEntryID);
      out.videoPayload = !!(payload.ok && payload.data && payload.data.media && payload.data.media.kind === 'video');

      mv.dismiss();
      return out;
    } catch (e) {
      out.error = String((e && e.stack) || e).slice(0, 700);
      return out;
    }
  })()`);
  win.destroy();
  if (!result || result.error) console.error('media UI probe error:', result && (result.error || result));
  return result || {};
}
