'use strict';
/**
 * diag-r60-loading.js — R60 加载语言三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 骨架屏形状令牌统一：--dur-shimmer 单一事实源（列表骨架/杂志封面/正文图三屏同拍）；
 *    骨架圆角归档（50%→--radius-full、5px→--radius-sm）；行内间距归 --space-*（计算样式实证）
 *  2 图片 shimmer 与失败占位几何统一：失败占位图与基础正文图同一圆角档 --radius-lg
 *    （loading → failed → loaded 三态零跳变）
 *  3 动作按钮 loading 态：.btn-text.spinning 家族（与 .btn.spinning 同几何同拍）——
 *    周刊生成按钮生成中 spinner+disabled+禁用原因 title；媒体 AI 摘要按钮接线（真实 UI 实证）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r60-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

/** 抓取包含某选择器片段的全部规则文本（拼接——同一选择器可能在多处声明，取并集）。 */
function ruleOf(css, selectorFragment) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const hits = [];
  let m;
  while ((m = re.exec(css))) {
    if (m[1].includes(selectorFragment)) hits.push(m[2].trim().replace(/\s+/g, ' '));
  }
  return hits.length ? hits.join(' | ') : null;
}

app.whenReady().then(async () => {
  try {
    const css = read('src/renderer/styles/robin.css');
    const weeklySrc = read('src/renderer/views/weekly-view.js');
    const mediaSrc = read('src/renderer/views/media-view.js');

    // ── 1. 骨架屏形状令牌统一 ──
    ok(/--dur-shimmer: 1\.4s;/.test(css), '1 --dur-shimmer 令牌在册（1.4s 单一事实源）');
    ok(!/animation: (kb|img)-shimmer 1\.[45]s/.test(css), '1 shimmer 裸秒数退役（1.4s/1.5s 归簇）');
    const shimmerConsumers = (css.match(/animation: (?:kb|img)-shimmer var\(--dur-shimmer\)/g) || []).length;
    ok(shimmerConsumers === 3, `1 shimmer 三屏同拍（列表骨架/杂志封面/正文图，实际 ${shimmerConsumers} 处消费）`);
    const aihotRank = ruleOf(css, '.aihot-skeleton-rank') || '';
    ok(aihotRank.includes('border-radius: var(--radius-full)'), '1 AIHOT 骨架圆点归 --radius-full（与列表骨架圆点同族）');
    const aihotLine = ruleOf(css, '.aihot-skeleton-line') || '';
    ok(aihotLine.includes('border-radius: var(--radius-sm)') && !aihotLine.includes('5px'), '1 AIHOT 骨架条圆角归 --radius-sm（裸 5px 退役）');
    const skRow = ruleOf(css, '.nj-sk-row') || '';
    ok(skRow.includes('gap: var(--space-3)') && skRow.includes('padding: var(--space-3) var(--space-4)'),
      '1 列表骨架行间距归 --space-*（10px/13px 16px 裸值退役）');
    const skLines = ruleOf(css, '.nj-sk-lines') || '';
    ok(skLines.includes('gap: var(--space-2)'), '1 骨架行线距归 --space-2（裸 7px 退役）');

    // ── 2. 图片 shimmer 与失败占位几何统一 ──
    const failedImg = ruleOf(css, '.nj-img-failed-wrap img') || '';
    ok(failedImg.includes('border-radius: var(--radius-lg)'), '2 失败占位图归 --radius-lg（与基础正文图同圆角档）');
    const baseImg = ruleOf(css, '.reader-article img, .reader-article video') || '';
    ok(baseImg.includes('border-radius: var(--radius-lg)'), '2 基础正文图圆角档 --radius-lg（同一几何基准）');

    // ── 3. 动作按钮 loading 态（静态锚点）──
    const spinningRule = ruleOf(css, '.btn-text.spinning') || '';
    ok(spinningRule.includes('color: transparent') && spinningRule.includes('pointer-events: none'),
      '3 .btn-text.spinning 家族在册（标签隐去 + 不可点）');
    ok(/\.btn-text\.spinning::after\s*\{[^}]*rotate 0\.8s linear infinite/.test(css) && /\.btn\.spinning::after\s*\{[^}]*rotate 0\.8s linear infinite/.test(css),
      '3 与 .btn.spinning 同几何同拍（13px 双环 spinner）');
    ok(weeklySrc.includes("genBtn.classList.toggle('spinning', !!this.generating)"), '3 周刊生成按钮接线 spinning');
    ok(weeklySrc.includes("genBtn.title = this.generating ? t('主编正在排版这一周的阅读，完成后会通知你')"), '3 周刊生成中禁用原因 title');
    ok(mediaSrc.includes("aiBtn.classList.add('spinning')") && mediaSrc.includes("aiBtn.title = t('正在生成 AI 摘要，请稍候')"),
      '3 媒体 AI 摘要按钮接线 spinning + 禁用原因 title');

    // ── UI 行为断言 ──
    const win = new BrowserWindow({
      show: false, width: 1440, height: 900,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1200);

    const exec = (js, label, ms = 30000) => Promise.race([
      win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
    ]);

    const flow = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        // 骨架屏计算样式（真实 DOM 走 showSkeleton 同款结构）
        const { ListView } = await import('./views/list.js');
        const host = document.createElement('div');
        host.className = 'list-scroll';
        document.body.appendChild(host);
        const lv = new ListView(host, { onSelect: () => {}, onContext: () => {}, onLoadMore: () => {}, onSearch: () => {} });
        lv.showSkeleton();
        await sleep(200);
        const skRow = host.querySelector('.nj-sk-row');
        const rowGap = skRow ? getComputedStyle(skRow).gap : '';
        const aihotRank = document.createElement('div');
        aihotRank.className = 'aihot-skeleton-rank';
        document.body.appendChild(aihotRank);
        const rankRadius = getComputedStyle(aihotRank).borderRadius;
        const shimmer = getComputedStyle(skRow.querySelector('.nj-sk-line'), '::before').animationName + '@' +
          getComputedStyle(skRow.querySelector('.nj-sk-line'), '::before').animationDuration;
        // loading 态按钮（.btn-text.spinning 家族实效）
        const gen = document.createElement('button');
        gen.type = 'button';
        gen.className = 'btn-text bordered nj-weekly-gen spinning';
        gen.innerHTML = '<svg viewBox="0 0 16 16"></svg><span>排版中…</span>';
        document.body.appendChild(gen);
        await sleep(120);
        const cs = getComputedStyle(gen);
        const spin = {
          color: cs.color, pe: cs.pointerEvents,
          afterName: getComputedStyle(gen, '::after').animationName,
          afterDur: getComputedStyle(gen, '::after').animationDuration,
        };
        gen.classList.remove('spinning');
        await sleep(250); // U12 家族给 color 挂了 dur-fast 过渡——等过渡走完再读终态
        const restored = getComputedStyle(gen).color;
        // 失败图占位几何
        const wrap = document.createElement('div');
        wrap.className = 'nj-img-failed-wrap';
        wrap.innerHTML = '<img class="nj-img nj-img-failed" style="aspect-ratio:16/9">';
        const art = document.createElement('article');
        art.className = 'reader-article';
        art.appendChild(wrap);
        document.body.appendChild(art);
        await sleep(120);
        const failedRadius = getComputedStyle(wrap.querySelector('img')).borderRadius;
        const plainRadius = getComputedStyle(wrap.querySelector('img')).borderTopLeftRadius;
        return { rowGap, rankRadius, shimmer, spin, restored, failedRadius, plainRadius };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'r60-flow');
    if (flow.__err) ok(false, 'UI 流程探针异常 — ' + flow.__err);
    else {
      ok(flow.rowGap === '12px', `1 骨架行计算 gap = --space-3（实际 ${flow.rowGap}）`);
      ok(flow.rankRadius.includes('999px') || flow.rankRadius.includes('13px'), `1 骨架圆点归 --radius-full 圆形（${flow.rankRadius}）`);
      ok(/^kb-shimmer@1\.4s$/.test(flow.shimmer), `1 骨架 shimmer 计算值 = kb-shimmer@--dur-shimmer（实际 ${flow.shimmer}）`);
      ok(flow.spin.color === 'rgba(0, 0, 0, 0)', `3 spinning 标签隐去（color transparent，实际 ${flow.spin.color}）`);
      ok(flow.spin.pe === 'none', '3 spinning 期间不可点（pointer-events none）');
      ok(flow.spin.afterName === 'rotate' && flow.spin.afterDur === '0.8s', `3 spinner 动画在拍（${flow.spin.afterName}@${flow.spin.afterDur}）`);
      ok(flow.restored !== 'rgba(0, 0, 0, 0)', '3 退出 loading 标签恢复可见');
      ok(flow.plainRadius.includes('10') || flow.failedRadius.includes('10'), `2 失败占位图计算圆角 = --radius-lg 10px（实际 ${flow.failedRadius}）`);
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
