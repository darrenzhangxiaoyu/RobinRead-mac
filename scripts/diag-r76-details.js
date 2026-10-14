'use strict';
/**
 * diag-r76-details.js — R76 列表与表格三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 任务列表复真：消毒层 <input type=checkbox> → .nj-task 只读状态位（勾选态保真），
 *    勾走 accent、任务行去 marker、非 checkbox input 仍剥除
 *  2 表格横滚提示：超宽表格左右缘渐隐遮（can-right/can-left 按滚动位切换，
 *    滚到头退役、窄表不显）
 *  3 嵌套列表层级：逐级缩进收紧 + marker 形态演进（disc→circle→square、ol→alpha→roman）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r76-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    // ── Phase A：消毒层单元 ──
    const Core = require('../src/main/ArticleExtractCore');
    const taskHTML = Core.sanitizedHTML(
      '<ul>' +
      '<li><input type="checkbox" disabled checked> 已完成事项</li>' +
      '<li><input type="checkbox" disabled> 待办事项</li>' +
      '<li><input type="text" value="x"> 文本框</li>' +
      '</ul>',
      'https://r76.test/x',
    );
    ok(taskHTML.includes('<span class="nj-task" data-task="1"></span>'), '1 勾选态 input → .nj-task[data-task=1]');
    ok(taskHTML.includes('<span class="nj-task" data-task="0"></span>'), '1 未勾选 input → .nj-task[data-task=0]');
    ok(!taskHTML.includes('<input'), '1 input 标签零残留（含 type=text 非勾选框整颗剥除）');

    // ── Phase B：静态锚点 ──
    const css = read('src/renderer/styles/robin.css');
    ok(/\.reader-article \.nj-task\[data-task="1"\]::after \{[^}]*?border: solid var\(--accent-ink, #fff\);/.test(css),
      '1 勾选勾形在册（accent 底 + accent-ink 墨，深浅双档自动）');
    ok(css.includes('.reader-article li:has(> .nj-task)::marker { content: \'\'; font-size: 0; }'),
      '1 任务行 marker 置空（勾选框即视觉锚，文本列对齐其他项）');
    ok(css.includes('.table-scroll.can-right::after') && css.includes('.table-scroll.can-left::before'),
      '2 表格横滚左右缘渐隐遮规则在册');
    const readerSrc = read('src/renderer/views/reader.js');
    ok(readerSrc.includes('_syncOneTableScrollHint(wrap)') && readerSrc.includes("wrap.classList.toggle('can-right'"),
      '2 滚动位切换逻辑在册（scrollLeft 驱动 can-right/can-left）');
    ok(css.includes('.reader-article li > ul, .reader-article li > ol { margin: 0.3em 0 0.4em; padding-left: 1.4em; }'),
      '3 嵌套列表缩进收紧（1.4em 逐级）');
    ok(css.includes('.reader-article ul ul { list-style-type: circle; }') && css.includes('.reader-article ul ul ul, .reader-article ul ul ul ul { list-style-type: square; }'),
      '3 ul marker 形态演进（disc→circle→square）');
    ok(css.includes('.reader-article ol ol { list-style-type: lower-alpha; }') && css.includes('.reader-article ol ol ol { list-style-type: lower-roman; }'),
      '3 ol marker 形态演进（decimal→alpha→roman）');

    // ── Phase C：真实 UI 行为 ──
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(app.getPath('userData'));
    const uiWin = await openUIWindow();
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, uiWin);

    const wideHead = Array.from({ length: 8 }, (_, i) => `<th>宽表头列样本${i + 1}</th>`).join('');
    const wideRow = Array.from({ length: 8 }, (_, i) => `<td>数据单元样本内容${i + 1}</td>`).join('');
    const filler = '这是用于避开正文补抓阈值的填充段落，保持内容完整。'.repeat(20);
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'R76 素材源', feedURL: 'https://r76.test/feed.xml' });
    const [entryID] = await store._applyParsedEntries(feed, [{
      id: 'r76-a1', title: '列表与表格的文章', url: 'https://r76.test/x/1', publishedAt: Math.floor(Date.now() / 1000) - 3600,
      summary: 'R76 素材。',
      contentHTML: `<ul><li><input type="checkbox" disabled checked> 已完成事项</li><li><input type="checkbox" disabled> 待办事项</li></ul>` +
        `<ul><li>一级条目<ul><li>二级条目<ul><li>三级条目</li></ul></li></ul></li></ul>` +
        `<table><thead><tr>${wideHead}</tr></thead><tbody><tr>${wideRow}</tr></tbody></table>` +
        `<p>${filler}</p>`,
    }]);
    ok(typeof entryID === 'string' && entryID.startsWith('local:'), `播种文章入库（entryID=${String(entryID).slice(0, 24)}…）`);

    await loadUI(uiWin);
    await sleep(1200);
    const b = await execJS(uiWin, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        window.__robinReaderOpen('${entryID}');
        const t0 = Date.now();
        let body = null;
        for (;;) {
          body = document.querySelector('.robin-body');
          if (body && body.querySelector('.nj-task')) break;
          if (Date.now() - t0 > 12000) return { found: false };
          await sleep(50);
        }
        await sleep(300);
        const out = { found: true };
        // 1 任务列表：状态位 + 勾形实渲染
        const tasks = body.querySelectorAll('.nj-task');
        out.taskCount = tasks.length;
        out.checked = tasks[0]?.dataset.task;
        out.unchecked = tasks[1]?.dataset.task;
        const cs1 = getComputedStyle(tasks[0]);
        out.checkedBg = cs1.backgroundColor;
        out.checkPs = getComputedStyle(tasks[0], '::after').content;
        const taskLi = tasks[0].closest('li');
        out.markerGone = getComputedStyle(taskLi, '::marker').fontSize === '0px';
        // 3 嵌套列表 marker 形态
        const nested = body.querySelector('li > ul > li > ul');
        out.lvl3Type = nested ? getComputedStyle(nested).listStyleType : null;
        const lvl2 = body.querySelector('li > ul');
        out.lvl2Type = lvl2 ? getComputedStyle(lvl2).listStyleType : null;
        // 2 表格横滚：宽表溢出 → can-right；滚到尾 → can-left 顶 can-right 退
        const wrap = body.querySelector('.table-scroll');
        if (!wrap) { out.table = 'missing'; return out; }
        out.tableOverflow = wrap.scrollWidth > wrap.clientWidth;
        out.canRight0 = wrap.classList.contains('can-right');
        out.canLeft0 = wrap.classList.contains('can-left');
        wrap.scrollLeft = wrap.scrollWidth; // 滚到最右
        wrap.dispatchEvent(new Event('scroll'));
        await sleep(120);
        out.canRightEnd = wrap.classList.contains('can-right');
        out.canLeftEnd = wrap.classList.contains('can-left');
        return out;
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'r76-runtime');
    if (b.__err) ok(false, 'UI 实证探针异常 — ' + b.__err);
    else if (!b.found) ok(false, '阅读区未渲染（环境性）');
    else {
      ok(b.taskCount === 2 && b.checked === '1' && b.unchecked === '0', `1 任务状态位保真（${b.taskCount} 框，checked=${b.checked}/unchecked=${b.unchecked}）`);
      ok(b.checkedBg !== 'rgba(0, 0, 0, 0)' && b.checkPs !== 'none', `1 勾形实渲染（accent 底${b.checkedBg !== 'rgba(0, 0, 0, 0)' ? '✓' : '✗'} ::after${b.checkPs !== 'none' ? '✓' : '✗'}）`);
      ok(b.markerGone, '1 任务行 marker 置空实渲染');
      ok(b.lvl2Type === 'circle' && b.lvl3Type === 'square', `3 嵌套 marker 形态演进（二级=${b.lvl2Type} 三级=${b.lvl3Type}）`);
      ok(b.tableOverflow === true && b.canRight0 === true && b.canLeft0 === false,
        `2 宽表溢出右缘提示（溢出${b.tableOverflow} can-right${b.canRight0} 无 can-left${!b.canLeft0}）`);
      ok(b.canRightEnd === false && b.canLeftEnd === true,
        `2 滚到尾切换（can-right 退${!b.canRightEnd} can-left 起${b.canLeftEnd}）`);
    }

    uiWin.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});

async function loadUI(win) {
  let loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt += 1) {
    try {
      await Promise.race([
        win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html')),
        new Promise((_, reject) => setTimeout(() => reject(new Error('loadFile timeout')), 25000)),
      ]);
      loaded = true;
    } catch (err) {
      console.error(`UI: load attempt ${attempt} failed — ${String(err && err.message || err)}`);
      if (attempt < 3) { try { await win.loadURL('about:blank'); } catch (_) { /* 原地再试 */ } }
    }
  }
  if (!loaded) throw new Error('UI 渲染层加载失败（3 次尝试均悬挂）');
}

async function openUIWindow() {
  const win = new BrowserWindow({
    show: false, width: 1100, height: 820,
    webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
  win.webContents.on('render-process-gone', (_e, details) => console.error('UI RENDER GONE:', details && details.reason));
  win.webContents.on('did-fail-load', (_e, code, desc) => console.error('UI LOAD FAIL:', code, desc));
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer:${level}] ${String(message).slice(0, 240)} (${path.basename(String(sourceId))}:${line})`);
  });
  return win;
}

async function execJS(win, js, label = 'step', ms = 30000) {
  return Promise.race([
    win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}
