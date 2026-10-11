'use strict';
/**
 * diag-r70-retry.js — R70 错误与重试三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 网络类错误 toast 带「重试」动作：R64 动作按钮合同审计（动作保底 ≥4.2s/焦点暂停/键盘可达）
 *    + 两处高频接线静态锚（单源刷新失败 refreshThisFeed 闭包重试；全文抓取失败 openExternalUrl/
 *    openOriginal 三分支闭包重发）+ 真实 Toast 动作钮点击回调断言
 *  2 正文图片批量失败「全部重试」：≥2 张失败浮现批量条（计数 tabular-nums）、单图重试收口
 *    _retryImage、批量一键全部重试（清计数换缓存戳）、恢复一张后整条退役
 *  3 AI 面板 inline 重试：摘要卡失败态「重试」钮（走 data-action=regenerate 委托 → 强制重发）
 *    + 研读面板失败态 inline「重试」钮（与 openStudy 同通路）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r70-')));
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
    const appSrc = read('src/renderer/app.js');
    const readerSrc = read('src/renderer/views/reader.js');
    const toastSrc = read('src/renderer/views/toast.js');

    // ── 1. toast 重试动作（R64 合同 audit + R70 接线锚点）──
    ok(/const effDuration = action\?\.label \? Math\.max\(duration, 4200\) : duration;/.test(toastSrc),
      '1 带动作 toast 保底 ≥4.2s（R64 合同：动作钮可读可点）');
    ok(toastSrc.includes('function wireFocusHold(entry, btn)'),
      '1 动作钮键盘可达 + 焦点暂停（R64 wireFocusHold 在册）');
    ok(/const refreshThisFeed = async \(\) => \{/.test(appSrc)
      && appSrc.includes("action: { label: t('重试'), onClick: () => refreshThisFeed() }"),
      '1 单源刷新失败 toast 带「重试」（闭包回调原操作，可连击重试）');
    ok((readerSrc.match(/label: t\('重试'\), onClick: \(\) => this\.openExternalUrl\(url\)/g) || []).length === 2,
      '1 链接精读失败两分支（数据/异常）均带「重试」');
    ok(readerSrc.includes("action: { label: t('重试'), onClick: () => this.openOriginal() }"),
      '1 原文抓取失败 toast 带「重试」');

    // ── 2. 图片批量全部重试（静态锚点）──
    ok(readerSrc.includes('this._syncImgBatchRetry(); // R70-②：失败累计到 2 张及以上浮现批量重试条')
      && readerSrc.includes('this._syncImgBatchRetry(); // R70-②：恢复一张后批量条可能整条退役'),
      '2 失败/恢复双事件驱动批量条同步');
    ok(readerSrc.includes("const pending = [...article.querySelectorAll('.nj-img-failed-wrap img.nj-img-failed')];")
      && readerSrc.includes('pending.forEach((img) => this._retryImage(img));'),
      '2 批量重试快照失败集逐张走单图通道');
    ok(/_retryImage\(img\) \{/.test(readerSrc) && readerSrc.includes("this._retryImage(img);\n        return;"),
      '2 R41 单图点击重试收口为 _retryImage（单图/批量同通道）');
    ok(readerSrc.includes('article.insertBefore(bar, this.body);'),
      '2 批量条挂 article 容器 body 之前（不污染 _articleText/TTS 文本面）');
    ok(readerSrc.includes("tf('%lld 张图片加载失败', failedImgs.length)"),
      '2 计数走 tf 占位（%lld）');
    ok(/\.nj-img-batch-bar \{/.test(css) && /\.nj-img-batch-retry:active \{ transform: scale\(var\(--press-scale\)\); \}/.test(css),
      '2 批量条样式入册（令牌化 + U12 按压家族）');
    ok(/\.nj-img-batch-note \{[^}]*font-variant-numeric: tabular-nums;/.test(css.replace(/\n/g, ' ')),
      '2 失败计数 tabular-nums（R57 数字纪律）');
    ok(/failedImgs\.length < 2/.test(readerSrc), '2 阈值 ≥2 才浮现（单图保留 R41 原点对点出路）');

    // ── 3. AI 面板 inline 重试（静态锚点）──
    ok(/data-action="regenerate">\$\{escapeHTML\(t\('重试'\)\)\}<\/button>/.test(readerSrc),
      '3 摘要卡失败态「重试」钮走 data-action=regenerate 委托（强制重发）');
    ok(/\.robin-summary-subtext\.robin-summary-errtext \{ color: var\(--danger\);/.test(css)
      && !readerSrc.includes('style="color:#c93b3b"'),
      '3 摘要错误文案 --danger 语义令牌（内联裸 hex 退役）');
    ok(readerSrc.includes('<button class="study-panel-retry">${escapeHTML(t(\'重试\'))}</button>')
      && readerSrc.includes('this.openStudy(s.kind); // R70-③：面板内重试与头部刷新同通路'),
      '3 研读面板失败态 inline「重试」（与 openStudy 同通路）');
    ok(/\.study-panel-retry \{/.test(css) && /\.study-panel-retry:active \{ transform: scale\(var\(--press-scale\)\); \}/.test(css),
      '3 inline 重试钮样式入册（danger 描边 + 按压家族）');

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

    // 1：真实 Toast 动作钮（重试回调 + 离场）
    const toastFlow = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const { showToast } = await import('./views/toast.js');
        let clicks = 0;
        const el = showToast('R70 网络失败样本', { tone: 'error', action: { label: '重试', onClick: () => { clicks += 1; } } });
        await sleep(120);
        const btn = el.querySelector('.toast-action');
        const label = btn?.textContent || '';
        const inCapsule = !!btn?.closest('.toast-capsule.error');
        btn?.click();
        await sleep(400);
        const gone = !document.body.contains(el);
        return { clicks, label, inCapsule, gone };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'r70-toast');
    if (toastFlow.__err) ok(false, '1 toast 流程探针异常 — ' + toastFlow.__err);
    else {
      ok(toastFlow.inCapsule && toastFlow.label === '重试', '1 error toast 内「重试」钮真实挂载');
      ok(toastFlow.clicks === 1, `1 点击触发重试闭包（clicks=${toastFlow.clicks}）`);
      ok(toastFlow.gone, '1 触发后 toast 离场');
    }

    // 2：批量失败条（proto 式 ReaderView，r41 同款；noRetry 直落失败态避开 1.2s 自动重试链）
    const batch = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const { ReaderView } = await import('./views/reader.js');
        const rhost = document.createElement('div');
        rhost.className = 'reader-article';
        document.body.appendChild(rhost);
        const proto = Object.create(ReaderView.prototype);
        proto.body = document.createElement('div');
        proto.body.className = 'robin-body';
        rhost.appendChild(proto.body);
        proto.feed = {}; proto.entry = {};
        for (let i = 0; i < 3; i += 1) {
          const p = document.createElement('p');
          const img = document.createElement('img');
          img.id = 'bx' + i;
          img.src = 'https://127.0.0.1:1/broken-' + i + '.jpg';
          img.dataset.noRetry = '1'; // 探针确定性：单次 error 直接落失败态（自动重试链 r41 已覆盖）
          p.appendChild(img);
          proto.body.appendChild(p);
        }
        proto.body.querySelectorAll('img').forEach((img) => proto._decorateImage(img));
        proto.body.querySelectorAll('img').forEach((img) => img.dispatchEvent(new Event('error')));
        await sleep(120);
        const failedCount = proto.body.querySelectorAll('.nj-img-failed-wrap img.nj-img-failed').length;
        const bar1 = rhost.querySelector('.nj-img-batch-bar');
        const note1 = bar1?.querySelector('.nj-img-batch-note')?.textContent || '';
        const barInBody = proto.body.contains(bar1);
        // 恢复一张（load 事件拆壳）→ 3→2 仍 ≥2，批量条保持且计数降为 2
        const imgs = [...proto.body.querySelectorAll('.nj-img-failed-wrap img.nj-img-failed')];
        imgs[0].dispatchEvent(new Event('load'));
        await sleep(80);
        const noteAfterOne = rhost.querySelector('.nj-img-batch-note')?.textContent || '';
        const barStill = !!rhost.querySelector('.nj-img-batch-bar');
        // 再恢复一张 → 1 < 2 → 批量条退役
        imgs[1].dispatchEvent(new Event('load'));
        await sleep(80);
        const barGone = !rhost.querySelector('.nj-img-batch-bar');
        // 重造两张失败 → 批量条复现 → 点「全部重试」同步断言逐张生效
        [imgs[1], imgs[2]].forEach((img) => { img.classList.add('nj-img-failed'); img.dispatchEvent(new Event('error')); });
        await sleep(80);
        const bar2 = rhost.querySelector('.nj-img-batch-bar');
        bar2?.querySelector('.nj-img-batch-retry')?.click();
        const afterClick = [imgs[1], imgs[2]].map((img) => ({
          reset: img.dataset.retryCount === '0',
          loading: img.classList.contains('nj-img-loading'),
          bust: img.src.includes('r='),
          failedGone: !img.classList.contains('nj-img-failed'),
        }));
        return { failedCount, note1, barInBody, barHadBtn: !!bar1?.querySelector('.nj-img-batch-retry'),
          noteAfterOne, barStill, barGone, bar2Back: !!bar2, afterClick };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'r70-batch');
    if (batch.__err) ok(false, '2 批量流程探针异常 — ' + batch.__err);
    else {
      ok(batch.failedCount === 3, `2 三张图全部落失败占位（${batch.failedCount}）`);
      ok(!!batch.barHadBtn && batch.note1.includes('3'), `2 批量条浮现且计数正确（「${batch.note1}」）`);
      ok(batch.barInBody === false, '2 批量条在 article 容器、不在正文内（文本面零污染）');
      ok(batch.barStill && batch.noteAfterOne.includes('2'), `2 恢复一张：条保持且计数降档（「${batch.noteAfterOne}」）`);
      ok(batch.barGone, '2 再恢复一张（<2 阈值）：批量条整条退役');
      ok(batch.bar2Back, '2 重造两张失败：批量条复现');
      ok(batch.afterClick.every((s) => s.reset && s.loading && s.bust && s.failedGone), '2 全部重试：清计数/入加载态/换缓存戳/摘失败态逐张生效');
    }

    // 3：AI 面板 inline 重试（完整 ReaderView，d2 同款）
    const ai = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        window.__robinLLM = { showsAISummary: true, apiKeyConfigured: true };
        const { ReaderView } = await import('./views/reader.js');
        const rbody = document.createElement('div');
        rbody.className = 'reader-scroll';
        rbody.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;overflow:auto;';
        document.body.appendChild(rbody);
        const tocDeps = { tocRail: document.createElement('div'), tocTrack: document.createElement('div'), tocPeak: document.createElement('div'), scrollbar: document.createElement('div'), thumb: document.createElement('div') };
        const reader = new ReaderView(rbody, tocDeps, { onFeedback: () => {}, onSelectNext: () => {}, onFocusList: () => {}, onOpenTag: () => {}, onTTSAdvance: async () => {} });
        reader.entryID = 'r70-ai';
        reader.entry = { id: 'r70-ai', title: 'R70 AI 重试样本', summary: '', publishedAt: Math.floor(Date.now() / 1000) };
        reader.feed = { title: 'R70 来源' };
        reader.html = '<p>R70 摘要卡与研读面板 inline 重试样本正文。</p>';
        reader._render();
        await sleep(200);
        // 摘要卡失败态
        reader.summary = { expanded: false, artifact: null, generating: false, streaming: '', error: 'R70 摘要生成失败样本' };
        reader._renderSummaryCard();
        const card = reader.summaryCard;
        const retryBtn = card.querySelector('[data-action="regenerate"]');
        const errColor = getComputedStyle(card.querySelector('.robin-summary-errtext')).color;
        const calls = [];
        reader.generateSummary = (force) => { calls.push(force); };
        retryBtn?.click();
        await sleep(80);
        const summaryCalled = calls;
        // 研读面板失败态
        reader._study = { kind: 'deepRead', generating: false, streaming: '', artifact: null, error: 'R70 研读失败样本' };
        const studyCalls = [];
        reader.openStudy = (kind) => { studyCalls.push(kind); };
        reader._renderStudyPanel();
        const panel = document.getElementById('nj-study-panel');
        const studyRetry = panel?.querySelector('.study-panel-retry');
        const stateEl = panel?.querySelector('.study-panel-state')?.textContent || '';
        studyRetry?.click();
        await sleep(80);
        return {
          hasRetry: !!retryBtn, retryLabel: retryBtn?.textContent || '',
          errColor, summaryCalled,
          hasStudyRetry: !!studyRetry, studyRetryLabel: studyRetry?.textContent || '',
          stateEl, studyCalls,
        };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'r70-ai');
    if (ai.__err) ok(false, '3 AI 面板流程探针异常 — ' + ai.__err);
    else {
      ok(ai.hasRetry && ai.retryLabel === '重试', '3 摘要卡失败态「重试」钮真实渲染');
      ok(ai.summaryCalled.length === 1 && ai.summaryCalled[0] === true, `3 点击走强制重试通道（generateSummary(${ai.summaryCalled[0]})）`);
      ok(ai.errColor && ai.errColor !== 'rgb(201, 59, 59)', `3 错误文案色已脱离裸 hex（${ai.errColor}，随 --danger 令牌）`);
      ok(ai.hasStudyRetry && ai.studyRetryLabel === '重试', '3 研读面板 inline「重试」真实渲染');
      ok((ai.stateEl || '').includes('失败'), `3 面板状态行示失败（「${ai.stateEl}」）`);
      ok(ai.studyCalls.length === 1 && ai.studyCalls[0] === 'deepRead', `3 inline 重试与 openStudy 同通路（kind=${ai.studyCalls[0]}）`);
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
