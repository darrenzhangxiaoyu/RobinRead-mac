'use strict';
/**
 * diag-edition-speak.js — R116 期刊神经语音朗读链探针（run-all OFFLINE 集，合成通道 stub 零网络）
 *
 * 覆盖：
 *  1 工具条 er-speak 在册 + article.html 分块（≤600 字，段落聚合）
 *  2 朗读链推进：notice 朗读中 x/N → 朗读完毕；结束后 _speakAbort 归空
 *  3 Esc 中途停读：已停止朗读 + 不再推进；回版面（_closeArticle）也停
 *  4 引擎/语速跟随用户配置（tts:getConfig.engine、robinread.tts.rate）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, ipcMain } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-edition-speak-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 150 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

app.whenReady().then(async () => {
  try {
    // stub：合成通道回一段假 mp3（Audio 解码失败走 onerror → 链继续推进——链路验证足够）
    let synthCalls = 0;
    ipcMain.handle('tts:synthesize', async (_e, payload) => {
      synthCalls += 1;
      global.__lastTtsPayload = payload;
      await new Promise((r) => setTimeout(r, 150)); // 模拟真实合成节拍——链可被中途 Esc 打断
      return { ok: true, data: Buffer.from('not-real-mp3-but-chain-ok').toString('base64') }; // data() 通道要 {ok,data} 信封（真应用由 handle() 包）
    });
    ipcMain.handle('tts:getConfig', () => ({ ok: true, data: { engine: 'custom', neuralVoice: 'zh-CN-YunxiNeural' } }));
    const win = new BrowserWindow({
      show: false, width: 1600, height: 1000,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    await sleep(600);
    const run = (tag, js) => {
      console.log('PHASE ' + tag);
      return win.webContents.executeJavaScript(`(async () => { try { ${js} } catch (e) { return { __err: String(e && e.stack || e) }; } })()`);
    };
    const ARTICLE = Array.from({ length: 30 }, (_, i) => '<p>第' + (i + 1) + '段正文。'.repeat(1) + '用于朗读分块验证的内容，确保段落足够多以产生多个分块。'.repeat(4) + '</p>').join('');
    const a = await run('speak-run', `
      const mod = await import('./views/edition-reader.js');
      const mk = (i) => ({ id: 'sp-' + i, title: '条目 ' + i, summaryPreview: '摘要 ' + i, sourceTitle: '潮流周刊', publishedAt: 1758902400 - i * 86400, contentHead: '' });
      const er = new mod.EditionReader({ items: Array.from({ length: 6 }, (_, i) => mk(i)), fetchArticle: async () => ${JSON.stringify(ARTICLE)} });
      window.__er = er;
      er.present(); clearTimeout(er._autoTimer); er._doOpen();
      await new Promise((r) => setTimeout(r, 900));
      await er._openArticle(er.items[0]);
      await new Promise((r) => setTimeout(r, 900));
      localStorage.setItem('robinread.tts.rate', '1.2');
      const cfgDebug = await window.robin.ttsGetConfig().catch((e) => 'ERR:' + e);
      const btn = document.querySelector('.er-speak');
      if (!btn) return { noBtn: true };
      btn.click();
      await new Promise((r) => setTimeout(r, 500));
      const mid = (document.querySelector('.er-notice')?.textContent || '').trim();
      let done = '';
      for (let i = 0; i < 40; i += 1) {
        if (!er._speakAbort) { done = (document.querySelector('.er-notice')?.textContent || '').trim(); break; }
        await new Promise((r) => setTimeout(r, 300));
      }
      return { mid, done, cfgDebug: JSON.stringify(cfgDebug)?.slice(0, 120), abortAfterDone: !!er._speakAbort };
    `);
    if (a.__err) throw new Error('speak-run: ' + a.__err);
    ok(!a.noBtn, 'er-speak 工具条在册');
    ok(/朗读中/.test(a.mid) || /朗读中/.test(a.done), `朗读链推进（mid=${a.mid} done=${a.done}）`);
    ok(a.abortAfterDone === false, '完毕后 _speakAbort 归空');
    ok(global.__lastTtsPayload && global.__lastTtsPayload.engine === 'custom'
      && global.__lastTtsPayload.voice === 'zh-CN-YunxiNeural'
      && Math.abs(Number(global.__lastTtsPayload.rate) - 1.2) < 0.001
      && String(global.__lastTtsPayload.text || '').length <= 600,
      `引擎/音色/语速/块长跟随配置（engine=${global.__lastTtsPayload?.engine} voice=${global.__lastTtsPayload?.voice} rate=${global.__lastTtsPayload?.rate} len=${String(global.__lastTtsPayload?.text || '').length} cfg=${a.cfgDebug}）`);
    // Esc 中途停（重新开文再读，立刻 Esc）
    const b = await run('speak-esc', `
      const er = window.__er;
      await er._openArticle(er.items[1]);
      await new Promise((r) => setTimeout(r, 800));
      document.querySelector('.er-speak').click();
      await new Promise((r) => setTimeout(r, 250));
      const during = !!er._speakAbort;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 400));
      const notice = document.querySelector('.er-notice');
      const overlayAlive = !!document.querySelector('.er-overlay');
      const afterEsc = !!er._speakAbort;
      // 再 Esc 退回版面（正文态）：_closeArticle 停读兜底
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 400));
      return { during, afterEsc, notice: (notice && !notice.hidden ? notice.textContent : '').trim(), overlayAlive, closedStillStopped: !er._speakAbort };
    `);
    if (b.__err) throw new Error('speak-esc: ' + b.__err);
    ok(b.during && !b.afterEsc, 'Esc 中途停读（朗读中 Esc 只停读不退刊）');
    ok(/已停止朗读/.test(b.notice), `停读 notice（${b.notice}）`);
    ok(b.overlayAlive, 'Esc 停读不连锁退出期刊');
    ok(b.closedStillStopped, '回版面后朗读保持停止（_closeArticle 兜底）');
    if (failed) { console.error(failed + ' 项失败'); app.exit(1); }
    else { console.log('ALL PASSED'); app.exit(0); }
  } catch (e) {
    console.error('ERR', String(e && e.message || e).slice(0, 500));
    app.exit(1);
  }
});
