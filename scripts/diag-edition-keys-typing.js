'use strict';
/**
 * diag-edition-keys-typing.js — BLOCKER-1 期刊键盘输入框打字守卫探针
 * 验证：INPUT 聚焦时 f/s/l/p/? 不被 capture 级键盘导航劫持（不被 preventDefault）；
 * Ctrl+F 仍呼出搜索条（Ctrl/Cmd 组合键豁免）；搜索框内 Esc 正常关闭、字母正常键入；
 * 非输入目标（document）的 ? 仍呼出快捷键面板（守卫不过度拦截）。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-edition-keys-typing-')));
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
    const a = await run('typing-guard', `
      const mod = await import('./views/edition-reader.js');
      const mk = (i) => ({ id: 'fx-' + i, title: '条目 ' + i, summaryPreview: '摘要 ' + i, sourceTitle: '潮流周刊', publishedAt: 1758902400 - i * 86400, contentHead: '' });
      const er = new mod.EditionReader({ items: Array.from({ length: 12 }, (_, i) => mk(i)), fetchArticle: async () => '' });
      window.__er = er;
      er.present(); clearTimeout(er._autoTimer); er._doOpen();
      await new Promise(r => setTimeout(r, 900));
      const press = (el, key, extra = {}) => {
        const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      };
      // 1) 普通输入框聚焦：字母/符号键不被劫持
      const probe = document.createElement('input');
      probe.id = 'diag-typing-probe';
      document.body.appendChild(probe);
      probe.focus();
      const pF = press(probe, 'f');
      const pS = press(probe, 's');
      const pL = press(probe, 'l');
      const pP = press(probe, 'p');
      const pQ = press(probe, '?', { shiftKey: true });
      await new Promise(r => setTimeout(r, 200));
      const noPanel = !document.querySelector('.er-keys-panel');
      probe.remove();
      // 2) 输入框聚焦时 Ctrl+F 仍呼出搜索条（组合键豁免）
      const probe2 = document.createElement('input');
      document.body.appendChild(probe2);
      probe2.focus();
      const pCtrlF = press(probe2, 'f', { ctrlKey: true });
      await new Promise(r => setTimeout(r, 300));
      const findbarOpen = !!er.overlay.querySelector('.er-findbar');
      // 3) 搜索框内：字母可键入（不拦截）、Esc 走输入框自身监听关闭
      const findInput = er.overlay.querySelector('.er-find-input');
      const pFFindbar = findInput ? press(findInput, 'f') : null;
      const pEscFindbar = findInput ? press(findInput, 'Escape') : null;
      await new Promise(r => setTimeout(r, 200));
      const findbarClosed = !er.overlay.querySelector('.er-findbar');
      probe2.remove();
      // 4) 回归：非输入目标（document）的 ? 仍呼出快捷键面板
      const pQDoc = press(document, '?', { shiftKey: true });
      await new Promise(r => setTimeout(r, 250));
      const panelOnDoc = !!document.querySelector('.er-keys-panel');
      if (panelOnDoc) document.querySelector('.er-keys-panel').remove();
      er.dismiss();
      return { pF, pS, pL, pP, pQ, noPanel, pCtrlF, findbarOpen, pFFindbar, pEscFindbar, findbarClosed, pQDoc, panelOnDoc };
    `);
    if (a.__err) throw new Error('typing-guard: ' + a.__err);
    ok(!a.pF, '聚焦输入框：f 不被劫持（defaultPrevented=' + a.pF + '）');
    ok(!a.pS, '聚焦输入框：s 不被劫持');
    ok(!a.pL, '聚焦输入框：l 不被劫持');
    ok(!a.pP, '聚焦输入框：p 不被劫持');
    ok(!a.pQ && a.noPanel, '聚焦输入框：? 不被劫持且快捷键面板未误呼出');
    ok(a.pCtrlF, '聚焦输入框：Ctrl+F 仍被拦截（组合键豁免生效）');
    ok(a.findbarOpen, 'Ctrl+F 呼出期刊搜索条');
    ok(a.pFFindbar === false, '搜索框内 f 正常键入不被拦截');
    ok(a.pEscFindbar === true && a.findbarClosed, '搜索框内 Esc 经输入框自身监听关闭搜索条');
    ok(a.pQDoc && a.panelOnDoc, '回归：document 级 ? 仍呼出快捷键面板（守卫不过度拦截）');
    if (failed) { console.error(failed + ' 项失败'); app.exit(1); }
    else { console.log('ALL PASSED'); app.exit(0); }
  } catch (e) {
    console.error('ERR', String(e && e.message || e).slice(0, 400));
    app.exit(1);
  }
});
