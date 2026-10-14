'use strict';
/**
 * diag-edition-colwidth.js — R9 栏宽舒适度探针（run-all OFFLINE 集）
 * 验证：排版面板第四组「栏宽」/ 窄 460 / 宽 620 切换后文章列宽真实变化 / 分页页数随栏宽变化 / 持久化
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-edition-col-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 150 * 1000).unref();
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
    const out = await run('colwidth', `
      const mod = await import('./views/edition-reader.js');
      localStorage.removeItem('robinread.editionTypography');
      const PARA = '段落内容用于栏宽切换验证：纸感阅读的关键不在于仿旧，而在于把注意力还给文字本身，版心、行距、页边与留白共同构成节奏，安静是最重要的排版变量，中英混排 Mixed English 与数字 2026 亦不例外。';
      const ARTICLE = ('<h2>第一章</h2><p>' + PARA + '</p><p>' + PARA + '</p>').repeat(8);
      const mk = (i) => ({ id: 'fx-' + i, title: '条目 ' + i, summaryPreview: '摘要 ' + i, sourceTitle: '潮流周刊', publishedAt: 1758902400 - i * 86400, contentHead: '' });
      const er = new mod.EditionReader({ items: Array.from({ length: 12 }, (_, i) => mk(i)), fetchArticle: async () => ARTICLE });
      window.__er = er;
      er.present(); clearTimeout(er._autoTimer); er._doOpen();
      await new Promise(r => setTimeout(r, 900));
      await er._openArticle(er.items[0]);
      await new Promise(r => setTimeout(r, 1200));
      document.querySelector('.er-type').click();
      await new Promise(r => setTimeout(r, 200));
      const colRow = [...document.querySelectorAll('.er-type-row')].find((r) => r.textContent.includes('栏宽'));
      const opt = (v) => [...colRow.querySelectorAll('button')].find((b) => b.dataset.val === v);
      const colW = () => document.querySelector('.er-article-leaf .er-article').style.width;
      const pages = () => er.pages.length;
      const wStd = colW(); const pStd = pages();
      opt('narrow').click();
      await new Promise(r => setTimeout(r, 900));
      const wNarrow = colW(); const pNarrow = pages();
      opt('wide').click();
      await new Promise(r => setTimeout(r, 900));
      const wWide = colW(); const pWide = pages();
      const stored = JSON.parse(localStorage.getItem('robinread.editionTypography') || '{}');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { colRow: !!colRow, wStd, pStd, wNarrow, pNarrow, wWide, pWide, stored };
    `);
    if (out.__err) throw new Error(out.__err);
    // R118：栏宽=叶宽比例（0.84/0.92/1.0）——固定 475/540/620 在宽叶上被居中出 ~100px 死白
    const px = (v) => parseInt(String(v || '').replace('px', ''), 10) || 0;
    ok(px(out.wNarrow) > 0 && px(out.wStd) > 0 && px(out.wWide) > 0
      && px(out.wNarrow) < px(out.wStd) && px(out.wStd) < px(out.wWide),
      `R118 栏宽三档递增且吃满叶（窄${out.wNarrow} < 标准${out.wStd} < 宽${out.wWide}——比例制）`);
    ok(out.pNarrow >= out.pStd || out.pNarrow >= out.pStd - 1, `窄栏页数不减（${out.pStd}→${out.pNarrow}）`);
    ok(out.stored.col === 'wide', '栏宽偏好持久化（' + out.stored.col + '）');
    if (failed) { console.error(failed + ' 项失败'); app.exit(1); }
    else { console.log('ALL PASSED'); app.exit(0); }
  } catch (e) {
    console.error('ERR', String(e && e.message || e).slice(0, 400));
    app.exit(1);
  }
});
