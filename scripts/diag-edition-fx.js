'use strict';
/**
 * diag-edition-fx.js — R16 动作音效探针（run-all OFFLINE 集）
 * 验证：收藏/导出/开书触发 _fx（计数）/ 音效开关关闭时不发声 / 开书走纸声变奏（Audio 实例）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-edition-fx-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 120 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

app.whenReady().then(async () => {
  try {
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
    const a = await run('fx', `
      const mod = await import('./views/edition-reader.js');
      const mk = (i) => ({ id: 'fx-' + i, title: '条目 ' + i, summaryPreview: '摘要 ' + i, sourceTitle: '潮流周刊', publishedAt: 1758902400 - i * 86400, contentHead: '' });
      const er = new mod.EditionReader({ items: Array.from({ length: 12 }, (_, i) => mk(i)), fetchArticle: async () => '' });
      window.__er = er;
      er.present(); clearTimeout(er._autoTimer); er._doOpen();
      await new Promise(r => setTimeout(r, 900));
      const openFx = er._fxCalls || 0;
      er._select('fx-1');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 250));
      const afterStar = er._fxCalls || 0;
      // 关音效再操作：计数不变
      er.soundOn = false;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 250));
      const afterMuted = er._fxCalls || 0;
      // 导出成功音（stub captureRect/copyImage 已由 preload？无 handler → 走 catch 分支不计 done；直接断言 tick/open 链路）
      er.soundOn = true;
      const doneFx0 = er._fxCalls || 0;
      er._fx('done');
      const doneFx = er._fxCalls || 0;
      // R113 实测：页边距档位驱动版宽（「两边边框有点大，在设置里优化」——面板页边距→窄，版面立宽）
      const wStd = Math.round(document.querySelector('.er-book').getBoundingClientRect().width);
      er.typo.margin = 'narrow';
      er._applyTypography();
      await new Promise((r) => setTimeout(r, 800));
      const wNarrow = Math.round(document.querySelector('.er-book').getBoundingClientRect().width);
      er.typo.margin = 'standard';
      er._applyTypography();
      er.dismiss();
      return { openFx, afterStar, afterMuted, doneFx0, doneFx, wStd, wNarrow };
    `);
    if (a.__err) throw new Error('fx: ' + a.__err);
    ok(a.openFx >= 1, '开书触发纸声变奏（fx=' + a.openFx + '）');
    ok(a.afterStar === a.openFx + 1, '收藏触发 tick（' + a.afterStar + '）');
    ok(a.afterMuted === a.afterStar, '音效关闭时不发声（' + a.afterMuted + '）');
    ok(a.doneFx === a.doneFx0 + 1, 'done 双音触发（' + a.doneFx + '）');
    // ── R113-R116 静态锚点（用户实见四连：页边框大/导出错位/背景不同步/无朗读）──
    const ROOT = path.join(__dirname, '..');
    const edSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'views', 'edition-reader.js'), 'utf8').replace(/\r\n/g, '\n');
    const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'robin.css'), 'utf8').replace(/\r\n/g, '\n');
    const ipcSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8').replace(/\r\n/g, '\n');
    ok(/PAPER_RATIO = \{ narrow: 0\.96, standard: 0\.94, wide: 0\.90 \}/.test(edSrc)
      && /pageWidth\(w, fs, this\.typo\?\.margin\)/.test(edSrc),
      'R113 页边距联动版宽在册（窄0.96/标准0.94/宽0.90——「两边边框有点大」可在排版面板页边距直接调');
    ok(/getZoomFactor\(\) \|\| 1;[\s\S]{0,300}Number\(rect\?\.x\) \|\| 0\) \* z/.test(ipcSrc),
      'R114 导出 zoom 校正在册（CSS 矩形 × zoomFactor → DIP——「导出的不是当前界面」）');
    ok(/\[data-paper="white"\] \{[^}]*?--erp-stage: #E9E8E4;/.test(css)
      && /\[data-paper="book"\] \{[^}]*?--erp-stage: #E6DCC4;/.test(css),
      'R115 纸感背景同步在册（white/book 台面色随纸变——「只有书页变色」）');
    ok(/class="er-speak"/.test(edSrc) && /_toggleSpeak\(\)/.test(edSrc) && /ttsSynthesize\(\{ engine,/.test(edSrc)
      && /_stopSpeak\(\); \/\/ R116/.test(edSrc),
      'R116 期刊神经语音在册（er-speak 钮 + 分块合成链（engine 变量跟随配置）+ Esc/换文/退出三停点）');
    ok(/x\.dataset\.key === 'firstCap' \? \(this\.typo\.firstCap \? 'on' : 'off'\) : String\(this\.typo\[x\.dataset\.key\]\)/.test(edSrc),
      'R117 首字下沉选中态映射在册（布尔→on/off——「按钮点了不高亮」）');
    ok(/\.er-paper, \.er-sound, \.er-full, \.er-speak \{/.test(css)
      && /\.er-speak svg \{ width: 13px; height: 13px; margin-right: 5px; \}/.test(css),
      'R116 朗读钮并入工具条家族样式在册（serif/墨色/0.55——「和周边按钮不是一个风格」根治）');
    ok(a.wNarrow > a.wStd + 20, `R113 页边距联动版宽实测（页边距→窄：版宽 ${a.wStd} → ${a.wNarrow}，+${a.wNarrow - a.wStd}px——两侧边框立收）`);
    if (failed) { console.error(failed + ' 项失败'); app.exit(1); }
    else { console.log('ALL PASSED'); app.exit(0); }
  } catch (e) {
    console.error('ERR', String(e && e.message || e).slice(0, 400));
    app.exit(1);
  }
});
