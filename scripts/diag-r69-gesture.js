'use strict';
/**
 * diag-r69-gesture.js — R69 手势与滚动三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 滚轮阅读器顶/底过滚动不冒泡：.reader-scroll overscroll-behavior: contain
 *    （CSS 在册 + 真实元素计算样式；翻页视图滚轮自管/灯箱缩放不受影响的 audit 锚点）
 *  2 双击正文空白回顶：真实 ReaderView 渲染长文 → 双击版心外空白平滑回顶；
 *    双击段落文本（划词选词面）不触发；守卫链静态锚点
 *  3 列表↔杂志互切保持滚动位置：setViewMode 布防 → render 落地经代际守卫通道恢复
 *    scrollTop（同值钳位）；外部 scrollTop() 干预（resetScroll 同款）推进代际即让位；
 *    app.js 切换通路不再 resetScroll 的静态锚点
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r69-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const css = read('src/renderer/styles/robin.css');
    const listSrc = read('src/renderer/views/list.js');
    const readerSrc = read('src/renderer/views/reader.js');
    const appSrc = read('src/renderer/app.js');
    const editionSrc = read('src/renderer/views/edition-reader.js');

    // ── 1. 滚轮过滚动不冒泡（静态 + audit 锚点）──
    ok(/\.reader-scroll \{\n  flex: 1; overflow-y: auto;\n  position: relative; z-index: 1;\n  \/\* R69-① [^*]*\*\/\n  overscroll-behavior: contain;/.test(css),
      '1 .reader-scroll overscroll-behavior: contain 在册（主窗/独立阅读窗同基类）');
    ok(editionSrc.includes(".addEventListener('wheel', (e) => this._wheel(e), { passive: false })"),
      '1 audit：翻页视图滚轮自管（er-stage wheel → _wheel 翻页/字号，无链式滚动面）');
    ok(editionSrc.includes('if (this._lightboxOn && this.overlay.querySelector(\'.er-lightbox.on\')) return;'),
      '1 audit：灯箱开启时滚轮不翻页（缩放通道独立）');
    ok(readerSrc.includes("lightbox.addEventListener('wheel', wheel, { passive: false });"),
      '1 audit：正文灯箱滚轮缩放自管（被动 false）');

    // ── 2. 双击正文空白回顶（静态锚点）──
    ok(readerSrc.includes("this.scrollEl.addEventListener('dblclick', (event) => this._onBodyDblClick(event));"),
      '2 scrollEl dblclick 监听在册');
    ok(/_onBodyDblClick\(event\) \{/.test(readerSrc), '2 守卫方法在册');
    ok(readerSrc.includes("target.classList?.contains('reader-article')")
      && readerSrc.includes("target.classList?.contains('robin-header-container')")
      && readerSrc.includes('target === this.body'),
      '2 触发面收敛空白（滚动容器/正文容器/文章容器/报头容器）');
    ok(readerSrc.includes("if (selection && !selection.isCollapsed) return;"),
      '2 有选区不动作（划词双击选词让位）');
    ok(readerSrc.includes("if (!this.entryID || !this.body) return; // 空态（选择一篇文章）不响应"),
      '2 空态不响应');
    ok(/behavior: reduced \? 'auto' : 'smooth'/.test(readerSrc),
      '2 平滑回顶 reduced-motion 豁免（降级 instant）');

    // ── 3. 互切保位（静态锚点）──
    ok(listSrc.includes('this._switchArmed = true;') && listSrc.includes('this._switchTop = this.scrollEl?.scrollTop || 0;'),
      '3 setViewMode 形态真变化时布防切换锚');
    ok(/const next = mode === 'magazine' \? 'magazine' : 'list';\n    if \(next !== this\.viewMode\) \{/.test(listSrc),
      '3 同值重复调用（state 推送常态）不布防');
    ok(listSrc.includes('const switchPending = this._switchArmed === true;') && listSrc.includes('this._switchArmed = false;'),
      '3 render 落地消费布防（一次性）');
    ok((listSrc.match(/restoreFor\(\); \/\/ R63-③/g) || []).length === 4,
      '3 四条渲染分支统一收口（事件/杂志/渐进完成/常规）');
    ok(/_restoreSwitchTop\(top, gen\) \{/.test(listSrc) && /gen !== undefined && gen !== \(this\._scrollGen \|\| 0\)\) return; \/\/ 外部滚动干预：旧恢复让位/.test(listSrc),
      '3 切换恢复走 R63 同一代际守卫通道');
    ok(/el\.scrollTop = Math\.max\(0, Math\.min\(top \|\| 0, Math\.max\(0, max\)\)\);/.test(listSrc),
      '3 同值钳位（新形态可视高度不足时贴边）');
    ok(/if \(document\.startViewTransition && !reduce\) document\.startViewTransition\(\(\) => reloadList\(\{ resetScroll: false \}\)\.catch\(\(\) => \{\}\)\);\n      else reloadList\(\{ resetScroll: false \}\)\.catch\(\(\) => \{\}\);/.test(appSrc),
      '3 app.js 形态切换通路 resetScroll: false（不再回落顶）');

    // ── UI 行为断言 ──
    const win = new BrowserWindow({
      show: false, width: 1440, height: 900,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1200);

    const exec = (js, label, ms = 60000) => Promise.race([
      win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
    ]);

    // 1 + 2：overscroll 计算样式 + 双击回顶（正例/反例）
    const gesture = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const { ReaderView } = await import('./views/reader.js');
        const rbody = document.createElement('div');
        rbody.className = 'reader-scroll';
        rbody.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;overflow:auto;';
        document.body.appendChild(rbody);
        const tocDeps = {
          tocRail: document.createElement('div'),
          tocTrack: document.createElement('div'),
          tocPeak: document.createElement('div'),
          scrollbar: document.createElement('div'),
          thumb: document.createElement('div'),
        };
        const reader = new ReaderView(rbody, tocDeps, {
          onFeedback: () => {}, onSelectNext: () => {}, onFocusList: () => {}, onOpenTag: () => {}, onTTSAdvance: async () => {},
        });
        window.__r69reader = reader;
        const ob = getComputedStyle(rbody).overscrollBehavior;
        // 长文渲染（30 段）
        reader.entryID = 'r69-dbl';
        reader.entry = { id: 'r69-dbl', title: 'R69 双击回顶样本', summary: '', publishedAt: Math.floor(Date.now() / 1000) };
        reader.feed = { title: 'R69 来源' };
        reader.html = Array.from({ length: 30 }, (_, i) => '<p>R69 第' + i + '段正文样本内容，足够长以撑出滚动空间。</p>').join('');
        reader._render();
        await sleep(300);
        const maxScroll = rbody.scrollHeight - rbody.clientHeight;
        rbody.scrollTop = maxScroll;
        await sleep(150);
        const beforeDbl = rbody.scrollTop;
        // 正例：双击正文容器（版心内段落之间的空白面 = body 本体）
        rbody.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        let settled = 0; let last = -1; let stable = 0;
        for (let i = 0; i < 60; i += 1) {
          await sleep(80);
          if (rbody.scrollTop === last && rbody.scrollTop === 0) { stable += 1; if (stable >= 2) break; }
          else { stable = 0; last = rbody.scrollTop; }
        }
        const afterBlank = rbody.scrollTop;
        // 反例：滚回底部，双击段落（划词选词面）——不得回顶
        rbody.scrollTop = maxScroll;
        await sleep(150);
        const p = rbody.querySelector('.robin-body p');
        p.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        await sleep(700);
        const afterPara = rbody.scrollTop;
        // 反例：空态（entryID 置空）双击容器——不响应
        const eid = reader.entryID;
        reader.entryID = null;
        rbody.scrollTop = maxScroll;
        await sleep(120);
        reader.body.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        await sleep(400);
        const afterEmpty = rbody.scrollTop;
        reader.entryID = eid;
        return { ob, maxScroll, beforeDbl, afterBlank, afterPara, afterEmpty };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'r69-gesture');
    if (gesture.__err) ok(false, '1/2 手势流程探针异常 — ' + gesture.__err);
    else {
      ok(gesture.ob === 'contain', `1 计算样式 overscroll-behavior = contain（实际 ${gesture.ob}）`);
      ok(gesture.maxScroll > 200, `2 样本长文可滚（maxScroll=${gesture.maxScroll}）`);
      ok(gesture.beforeDbl > 0 && gesture.afterBlank === 0, `2 双击正文空白回顶（${gesture.beforeDbl} → ${gesture.afterBlank}）`);
      ok(gesture.afterPara >= gesture.maxScroll - 2, `2 双击段落不触发（scrollTop 保持 ${gesture.afterPara} ≈ ${gesture.maxScroll}）`);
      ok(gesture.afterEmpty >= gesture.maxScroll - 2, `2 空态双击不响应`);
    }

    // 3：互切保位 + 代际守卫让位
    const sw = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const { ListView } = await import('./views/list.js');
        const host = document.createElement('div');
        host.className = 'list-scroll';
        host.style.height = '420px';
        document.body.appendChild(host);
        const lv = new ListView(host, { onSelect: () => {}, onContext: () => {}, onLoadMore: () => {}, onSearch: () => {} });
        window.__lv69 = lv;
        const TS = Math.floor(Date.now() / 1000) - 3600;
        const mk = (id) => {
          const n = parseInt(String(id).replace(/[^0-9]/g, ''), 10) || 0;
          return { id, title: 'N' + n + 'X' + (n * 7919).toString(36) + 'hao', summaryPreview: '摘要', sourceTitle: '来源', publishedAt: TS, contentHead: '' };
        };
        const ids = (n, pfx) => Array.from({ length: n }, (_, i) => pfx + i);
        lv.setViewMode('list');
        lv.render(ids(120, 'a').map(mk), { kind: 'all' }, null, true);
        await sleep(600); // 渐进渲染完成
        host.scrollTop = 900;
        await sleep(150);
        const beforeSwitchTop = host.scrollTop;
        // 列表 → 杂志：互切保位
        lv.setViewMode('magazine');
        lv.render(ids(120, 'a').map(mk), { kind: 'all' }, null, true);
        await sleep(700);
        const magTop = host.scrollTop;
        const magMax = host.scrollHeight - host.clientHeight;
        // 杂志 → 列表：反向同样保位
        lv.setViewMode('list');
        lv.render(ids(120, 'a').map(mk), { kind: 'all' }, null, true);
        await sleep(700);
        const backTop = host.scrollTop;
        // 代际守卫：布防后外部 scrollTop() 干预（resetScroll 同款）→ 恢复让位回落顶
        host.scrollTop = 700;
        await sleep(120);
        lv.setViewMode('magazine');
        lv.scrollTop(); // 外部干预推进代际
        lv.render(ids(120, 'a').map(mk), { kind: 'all' }, null, true);
        await sleep(700);
        const afterIntervene = host.scrollTop;
        return { beforeSwitchTop, magTop, magMax, backTop, afterIntervene };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'r69-switch');
    if (sw.__err) ok(false, '3 互切流程探针异常 — ' + sw.__err);
    else {
      ok(sw.beforeSwitchTop === 900, `3 切前位置在册（${sw.beforeSwitchTop}）`);
      ok(Math.abs(sw.magTop - Math.min(900, sw.magMax)) <= 1, `3 列表→杂志保位（scrollTop=${sw.magTop}，可视上限 ${sw.magMax}）`);
      ok(Math.abs(sw.backTop - Math.min(900, sw.magTop)) <= 1 || Math.abs(sw.backTop - 900) <= 2, `3 杂志→列表保位（scrollTop=${sw.backTop}）`);
      ok(sw.afterIntervene < 40, `3 代际守卫：外部干预后恢复让位（top=${sw.afterIntervene}）`);
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
