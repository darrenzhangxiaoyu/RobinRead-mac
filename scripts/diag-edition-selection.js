'use strict';
/**
 * diag-edition-selection.js — R3 期刊内划词探针（run-all OFFLINE 集）
 * 验证：划选正文出胶囊（复制+AI 键）/ 复制写剪贴板+notice / 弹层打开与错误兜底 /
 *       版面卡片文本可选且划选不触发开文 / Esc 关弹层 / dismiss 清理
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, clipboard, ipcMain } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-edition-sel-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 150 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

app.whenReady().then(async () => {
  try {
    // 探针进程内注册复制兜底通道（真实应用由 registerIPCHandlers 注册）
    ipcMain.handle('app:copyText', (_e, text) => { clipboard.writeText(String(text ?? '')); return true; });
    const win = new BrowserWindow({
      show: false, width: 1600, height: 1000,
      webPreferences: {
        contextIsolation: true, backgroundThrottling: false,
        preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      },
    });
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    await sleep(600);
    const run = (tag, js) => {
      console.log('PHASE ' + tag);
      return win.webContents.executeJavaScript(`(async () => { try { ${js} } catch (e) { return { __err: String(e && e.stack || e) }; } })()`);
    };
    const a = await run('article-selection', `
      const mod = await import('./views/edition-reader.js');
      const ARTICLE = Array.from({ length: 6 }, (_, i) => '<h2>第' + (i + 1) + '节</h2><p>这是第' + (i + 1) + '节的一段用于划词测试的正文段落，长度足够覆盖一到两行文字，供鼠标划选与胶囊定位验证。纸感阅读把散落的订阅还原成一个安静的阅读空间。</p>').join('')
        + '<p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="320" height="200" alt="点图不翻页验证"></p>';
      const mk = (i) => ({ id: 'fx-' + i, title: '条目 ' + i, summaryPreview: '摘要文本用于卡片划词验证，长度足以占据两行版面空间。' + i, sourceTitle: '潮流周刊', publishedAt: 1758902400 - i * 86400, contentHead: '' });
      const er = new mod.EditionReader({ items: Array.from({ length: 12 }, (_, i) => mk(i)), fetchArticle: async () => ARTICLE });
      window.__er = er;
      er.present();
      clearTimeout(er._autoTimer);
      er._doOpen();
      await new Promise(r => setTimeout(r, 900));
      await er._openArticle(er.items[0]);
      await new Promise(r => setTimeout(r, 900));
      // 划选正文第一段
      const p = document.querySelector('.er-article p');
      const range = document.createRange();
      range.setStart(p.firstChild, 0);
      range.setEnd(p.firstChild, 12);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise(r => setTimeout(r, 500));
      const bar = document.querySelector('.er-selbar');
      const barBtns = bar ? [...bar.querySelectorAll('.er-sel-btn')].map((b) => b.textContent) : [];
      return { barBtns };
    `);
    if (a.__err) throw new Error('phase1: ' + a.__err);
    // 复制链路（主进程读剪贴板）
    clipboard.writeText('sentinel');
    await run('copy-click', `
      document.querySelector('.er-selbar .er-sel-btn').click();
      await new Promise(r => setTimeout(r, 400));
      const notice = document.querySelector('.er-notice');
      return { noticeText: notice && !notice.hidden ? notice.textContent : '' };
    `);
    const copied = clipboard.readText();
    const c = await run('copy-result', `
      const notice = document.querySelector('.er-notice');
      return { noticeText: notice && !notice.hidden ? notice.textContent : '' };
    `);
    const noticeText = c.noticeText || '';
    const d = await run('popover', `
      // 复制点击已收起胶囊：重新划选 → 点解释 → 弹层出现（无 AI handler 时走错误兜底）
      const p = document.querySelector('.er-article p');
      const range = document.createRange();
      range.setStart(p.firstChild, 0);
      range.setEnd(p.firstChild, 12);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise(r => setTimeout(r, 500));
      const bar2 = document.querySelector('.er-selbar');
      const aiBtn = bar2 ? [...bar2.querySelectorAll('.er-sel-btn.ai')].find((b) => b.textContent === '解释') : null;
      if (aiBtn) aiBtn.click();
      await new Promise(r => setTimeout(r, 500));
      const pop = document.querySelector('.er-sel-popover');
      const popTitle = pop?.querySelector('.er-sel-title')?.textContent || '';
      const popBody = pop?.querySelector('.er-sel-body')?.className || '';
      const popText = pop?.querySelector('.er-sel-body')?.textContent || '';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      const popClosedByEsc = !document.querySelector('.er-sel-popover');
      return { popOpen: !!pop, popTitle, popBody, popText: popText.slice(0, 60), popClosedByEsc };
    `);
    if (d.__err) throw new Error('popover: ' + d.__err);
    ok(a.barBtns.length >= 2 && a.barBtns[0] === '复制', '划选正文出胶囊（键：' + a.barBtns.join('/') + '）');
    ok(copied === '这是第1节的一段用于划词', '复制写入剪贴板（' + copied + '）');
    ok(noticeText.includes('已复制'), '复制后 notice 反馈（' + noticeText + '）');
    ok(d.popOpen && d.popTitle === 'AI 解释', '解释弹层打开（标题：' + d.popTitle + '）');
    ok(d.popBody.includes('error'), '无 AI 配置时错误兜底（class=' + d.popBody + '）');
    ok(d.popText.length > 0, '错误文案非空（' + d.popText.slice(0, 24) + '…）');
    ok(d.popClosedByEsc, 'Esc 关闭弹层');
    // 点图×翻页冲突（用户实报：点图放大同时翻页了）——pointer 序列直点正文图：只灯箱、页码不动
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'views', 'edition-reader.js'), 'utf8');
    ok(src.includes("ev.target.closest('.er-article img')) return; // 点图=灯箱"), '点图 guard 静态在册（_click 豁免正文图）');
    const e2 = await run('img-click-no-flip', `
      const er = window.__er;
      const img = document.querySelector('.er-article img');
      if (!img) return { noImg: true };
      const r = img.getBoundingClientRect();
      const idxBefore = er._pageIndex();
      const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height / 2, 20), button: 0, pointerId: 9, isPrimary: true };
      img.dispatchEvent(new PointerEvent('pointerdown', opts));
      window.dispatchEvent(new PointerEvent('pointerup', opts));
      img.dispatchEvent(new MouseEvent('click', opts));
      await new Promise((r2) => setTimeout(r2, 600));
      return { idxBefore, idxAfter: er._pageIndex(), lightbox: !!document.querySelector('.er-lightbox') };
    `);
    if (e2.__err) throw new Error('img-click: ' + e2.__err);
    ok(!e2.noImg, '正文图在场');
    ok(e2.idxAfter === e2.idxBefore, '点图不翻页（页码 ' + e2.idxBefore + '→' + e2.idxAfter + '——用户实报「放大同时翻页」根治）');
    ok(e2.lightbox, '点图灯箱打开（只放大，不翻页）');
    const b = await run('card-selection', `
      const er = window.__er;
      // R112 相位遗留的灯箱先收掉（否则吞掉下面本应退出正文态的 Esc）
      const lbOpen = document.querySelector('.er-lightbox.on');
      if (lbOpen) { lbOpen.classList.remove('on'); er._lightboxOn = false; }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      // 回版面，划选卡片摘要
      const sum = document.querySelector('.er-story .er-sum');
      const range = document.createRange();
      range.setStart(sum.firstChild, 0);
      range.setEnd(sum.firstChild, 8);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise(r => setTimeout(r, 500));
      const barOnCard = !!document.querySelector('.er-selbar');
      const articleNotOpened = er.mode === 'edition';
      // 清理：dismiss 后胶囊/弹层/监听不残留
      const barText = document.querySelector('.er-selbar')?.textContent || '';
      er.dismiss();
      await new Promise(r => setTimeout(r, 150));
      const cleaned = !document.querySelector('.er-selbar') && !document.querySelector('.er-sel-popover');
      return { barOnCard, articleNotOpened, barText: barText.slice(0, 20), cleaned };
    `);
    if (b.__err) throw new Error('phase2: ' + b.__err);
    ok(b.barOnCard, '版面卡片划选出胶囊');
    ok(b.articleNotOpened, '划选不触发开文（仍在版面态）');
    ok(b.cleaned, 'dismiss 后胶囊/弹层清理');
    if (failed) { console.error(failed + ' 项失败'); app.exit(1); }
    else { console.log('ALL PASSED'); app.exit(0); }
  } catch (e) {
    console.error('ERR', String(e && e.message || e).slice(0, 400));
    app.exit(1);
  }
});
