'use strict';
/**
 * diag-r66-typo.js — R66 阅读排版三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 标题断行平衡：.robin-header-title 基类（主窗/独立阅读窗全实例）+ 弹窗标题三家族 +
 *    原文弹窗标题 + 周刊刊头 text-wrap: balance（渐进增强，reader-article 既有档为对照锚）
 *  2 引用块/代码块纸面统一：--font-mono 等宽单一事实源（四散栈退役、19+ 消费）、
 *    引用块三卫星家族（研究简报/原文/研读面板）归 U5-③ 正典语言（实条+4% 微染+右圆角令牌）
 *  3 段落 hover 零布局位移：程序化扫描 robin.css 全部 :hover 规则——布局属性
 *    （padding/margin/width/height/font-size/gap/letter-spacing/border-width）零出现
 *    （transform/opacity/filter/颜色/阴影豁免；::before/::after 装饰层豁免）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r66-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

/** 程序化扫描：全部 :hover 规则（伪元素装饰层豁免）中是否出现布局位移属性。 */
function scanHoverLayoutShift(cssRaw) {
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, ''); // 剥注释：注释里的 ':hover' 字样不参与规则配对
  const LAYOUT_PROPS = ['padding', 'margin', 'width', 'height', 'font-size', 'gap', 'letter-spacing', 'border-width', 'line-height'];
  const violations = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selector = m[1].trim();
    if (!selector.includes(':hover')) continue;
    if (selector.includes('::before') || selector.includes('::after')) continue; // 装饰层豁免（绝对定位视觉加粗等）
    for (const prop of LAYOUT_PROPS) {
      const propRe = new RegExp(`(?:^|;)\\s*${prop}\\s*:`, 'm');
      if (propRe.test(m[2])) violations.push(`${selector.slice(0, 60)} → ${prop}`);
    }
  }
  return violations;
}

app.whenReady().then(async () => {
  try {
    // ── Phase A：源码在册断言 ──────────────────────────────────────────────
    const robin = read('src/renderer/styles/robin.css');

    // 1 断行平衡
    ok(/\.robin-header-title \{[^}]*?text-wrap: balance;/.test(robin), '1 .robin-header-title 基类断行平衡（主窗+独立阅读窗全实例）');
    ok(/\.reader-article \.robin-header-title \{[^}]*text-wrap: balance;/.test(robin), '1 reader-article 既有 balance 档在册（对照锚）');
    let balanceHits = 0;
    for (const frag of ['.modal-header h3 {', '.nj-brief-head h3 {', '.nj-media-head h3 {', '.aihot-reader-title {', '.nj-weekly-name {']) {
      const idx = robin.indexOf(frag);
      if (idx >= 0 && robin.slice(idx, idx + 320).includes('text-wrap: balance')) balanceHits += 1;
    }
    ok(balanceHits === 5, `1 弹窗/原文/刊头标题 balance 扩面（${balanceHits}/5 家族）`);

    // 2 等宽单一事实源
    ok(/--font-mono: 'Cascadia Code', ui-monospace, Consolas, 'JetBrains Mono', Menlo, monospace;/.test(robin),
      '2 --font-mono 令牌在册（:root 单一事实源）');
    const monoUses = (robin.match(/var\(--font-mono\)/g) || []).length;
    ok(monoUses >= 15, `2 等宽令牌消费面（${monoUses} 处 ≥15）`);
    const strayMono = (robin.match(/font-family:\s*('Cascadia Code'|Consolas|ui-monospace)/g) || []).length;
    ok(strayMono === 0, `2 散栈退役（font-family 直写等宽栈残留 ${strayMono} 处，应为 0）`);
    ok(/\.reader-article code \{\n  font-family: var\(--font-mono\);/.test(robin), '2 正文内联 code 消费令牌');
    ok(/\.er-article pre \{ font-family: var\(--font-mono\);/.test(robin), '2 期刊纸面 pre 消费令牌');

    // 2 引用块纸面统一（U5-③ 正典：实条 + 4% 微染 + 右圆角令牌）
    const canon = /\.reader-article blockquote \{[^}]*border-left: 3px solid var\(--accent\);[^}]*background: color-mix\(in srgb, var\(--accent\) 4%, transparent\);/;
    ok(canon.test(robin), '2 正典引用块语言在册（reader-article U5-③ 对照锚）');
    let quoteHits = 0;
    for (const frag of ['.nj-explanation-body.rendered blockquote {', '.aihot-original-body blockquote {', '.study-panel-body blockquote {']) {
      const idx = robin.indexOf(frag);
      if (idx >= 0) {
        const block = robin.slice(idx, idx + 420);
        if (block.includes('color-mix(in srgb, var(--accent) 4%, transparent)') && block.includes('0 var(--radius-md) var(--radius-md) 0')) quoteHits += 1;
      }
    }
    ok(quoteHits === 3, `2 三卫星引用家族归正典语言（${quoteHits}/3：研读简报/原文/研读面板）`);
    ok(!/border-radius: 0 8px 8px 0/.test(robin), '2 圆角裸 8px 退役（研读面板引用块）');

    // 3 hover 零布局位移固化（程序化全景扫描）
    const violations = scanHoverLayoutShift(robin);
    ok(violations.length === 0, `3 正文区 :hover 零布局位移（程序化扫描违规 ${violations.length} 处${violations.length ? '：' + violations.slice(0, 3).join('；') : ''}）`);
    ok(/border-radius: var\(--radius-xs\); \/\* R66：裸 3px 归档/.test(robin), '3 划词高亮 mark 圆角裸 3px 归 --radius-xs');

    // ── Phase B：真实渲染窗口断言 ─────────────────────────────────────────
    const win = new BrowserWindow({
      show: false, width: 1280, height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1000);

    const b = await win.webContents.executeJavaScript(`(() => {
      const out = {};
      const host = document.createElement('div');
      host.className = 'reader-article';
      host.innerHTML =
        '<div class="robin-header-container"><h1 class="robin-header-title">R66 标题断行平衡样本这是一段足够长的中文标题用于观察两行分布是否均衡分布</h1></div>' +
        '<blockquote><p>引用块样本</p></blockquote>' +
        '<p>正文段落，内联 <code>code_token</code> 样本。</p>' +
        '<pre><code>const x = 1;</code></pre>' +
        '<p>高亮 <mark class="nj-hl" data-color="yellow">划词样本</mark> 段落。</p>';
      document.body.appendChild(host);
      const cs = (el) => getComputedStyle(el);
      const h1 = host.querySelector('.robin-header-title');
      out.titleBalance = cs(h1).textWrap === 'balance';
      const bq = host.querySelector('blockquote');
      const bqBg = cs(bq).backgroundColor;
      out.quoteTinted = bqBg && bqBg !== 'rgba(0, 0, 0, 0)' && !bqBg.startsWith('rgba(0, 0, 0, 0');
      out.quoteRadiusR = cs(bq).borderTopRightRadius === '8px';
      const code = host.querySelector('p code');
      out.codeMono = cs(code).fontFamily.toLowerCase().includes('cascadia');
      const preCode = host.querySelector('pre code');
      out.preMono = cs(preCode).fontFamily.toLowerCase().includes('cascadia');
      out.preMonoDirect = cs(host.querySelector('pre')).fontFamily.toLowerCase().includes('cascadia');
      const mark = host.querySelector('mark');
      out.markRadius = cs(mark).borderTopLeftRadius === '4px';
      // 引用块三卫星家族同语言实渲染（研读面板家族样本）
      const study = document.createElement('blockquote');
      study.className = '';
      study.style.margin = '0';
      const panelBody = document.createElement('div');
      panelBody.className = 'study-panel-body';
      panelBody.appendChild(study);
      document.body.appendChild(panelBody);
      out.studyTint = cs(study).backgroundColor === bqBg;
      host.remove(); panelBody.remove();
      return out;
    })()`, 'typo-flow');
    if (b.__err) ok(false, '排版流程探针异常 — ' + b.__err);
    else {
      ok(b.titleBalance, '1 文章标题 balance 计算生效');
      ok(b.quoteTinted, '2 引用块微染底实渲染');
      ok(b.quoteRadiusR, '2 引用块右圆角 8px（--radius-md）实渲染');
      ok(b.codeMono, '2 内联 code 等宽令牌实渲染（Cascadia 先行）');
      ok(b.preMono, '2 代码块内 code 等宽令牌实渲染');
      ok(b.preMonoDirect, '2 pre 本体直落等宽令牌（R66 补齐基类 font-family）');
      ok(b.markRadius, '3 mark 圆角 4px 实渲染');
      ok(b.studyTint, '2 研读面板引用块与正文引用块同染底');
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
