'use strict';
/**
 * diag-r59-emptyout.js — R59 空态出路三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 空态主按钮三态归簇：.list-empty-refresh hover/active/focus-visible 三态在册——
 *    active 按压归 U12 --press-scale 家族（裸 0.96 双写退役）、focus 环归 U18 --focus-* 量纲、
 *    过渡含 transform（计算样式实证）
 *  2 空态垂直节奏令牌化：空态壳四拍（插画/标题/文案/出路按钮）间距归 --space-*——
 *    gap 8px 与 padding 30px 裸值退役；CTA 第四拍 margin-top 归 --space-4（计算样式实证）
 *  3 搜索无结果出路：列表搜索空态（kind:'search'）补「清空搜索」出路按钮——
 *    镜中山野插画 + 换关键词文案 + 一键清空回全部（点击清输入/回调/焦点归还，对齐 R53 命令面板先例）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r59-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

/** 抓取包含某选择器片段的完整规则文本（CSSOM 前置：源码静态口径）。 */
function ruleOf(css, selectorFragment) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[1].includes(selectorFragment)) return m[1].trim() + ' { ' + m[2].trim().replace(/\s+/g, ' ') + ' }';
  }
  return null;
}

app.whenReady().then(async () => {
  try {
    const css = read('src/renderer/styles/robin.css');
    const listSrc = read('src/renderer/views/list.js');

    // ── 1. 空态主按钮三态（归簇收口）──
    const ctaHover = ruleOf(css, '.list-empty-refresh:hover') || '';
    ok(ctaHover.includes('border-color: var(--accent)'),
      '1 空态 CTA hover 态在册（边框提亮 + 底色 hover）');
    ok(!/\.list-empty-refresh:active\s*\{\s*transform:\s*scale\(0\.96\)/.test(css),
      '1 裸 0.96 按压双写退役（归簇 --press-scale）');
    const pressBlock = (css.match(/\.btn:active:not\(:disabled\)[^{}]*\{[^}]*\}/) || [''])[0];
    ok(pressBlock.includes('.list-empty-refresh:active') && pressBlock.includes('var(--press-scale)'),
      '1 active 态归 U12 --press-scale 按压家族（全家族同量纲）');
    ok(/\.list-empty-refresh:focus-visible\s*\{[^}]*var\(--focus-w/.test(css) && /\.list-empty-refresh:focus-visible\s*\{[^}]*var\(--focus-off/.test(css),
      '1 focus-visible 环归 U18 --focus-* 量纲');
    const ctaBase = (ruleOf(css, '.list-empty-refresh') || '').replace(/\s+/g, ' ');
    ok(/transform var\(--dur-fast\) var\(--ease-out\)/.test(ctaBase),
      '1 过渡承接 transform（按压反馈有动画路径）');
    ok(css.includes('--press-scale: 0.96'), '1 --press-scale 令牌在册（0.96 量纲单一事实源）');

    // ── 2. 空态垂直节奏令牌化 ──
    const shellRule = ruleOf(css, '.list-empty, .reader-empty') || '';
    ok(/gap:\s*var\(--space-2\)/.test(shellRule) && !/gap:\s*\d+px/.test(shellRule),
      '2 空态壳 gap 归 --space-2（裸 8px/10px 退役）');
    ok(/padding:\s*var\(--space-8\)\s+var\(--space-6\)/.test(shellRule),
      '2 空态壳 padding 归 --space-8/--space-6（裸 30px 退役）');
    ok(!/\.list-empty, \.reader-empty \{ gap: 10px; \}/.test(css), '2 精修块裸 10px gap 退役');
    const ctaRule = (ruleOf(css, '.list-empty-refresh') || '').replace(/\s+/g, ' ');
    ok(/padding:\s*var\(--space-2\)\s+var\(--space-5\)/.test(ctaRule), '2 CTA 内边距归令牌（6px 18px 裸值退役）');
    ok(/margin-top:\s*var\(--space-4\)/.test(ctaRule), '2 CTA 第四拍 margin-top 归 --space-4（裸 14px 退役）');
    ok(/\.list-empty\.stagger \.btn-text \{/.test(css), '2 stagger 第四拍（btn-text 出路按钮）与节奏表一致');

    // ── 3. 搜索无结果出路（静态锚点）──
    ok(listSrc.includes("scope?.kind === 'search'"), '3 列表空态搜索分支在册');
    ok(listSrc.includes("artFor('search')"), '3 搜索空态用镜中山野插画（search 场景）');
    ok(listSrc.includes("'list-empty-refresh list-empty-clear'"), '3 清空搜索出路按钮共用空态 CTA 家族');
    ok(listSrc.includes("this.handlers.onSearch?.('')"), '3 清空按钮回调 onSearch(\'\')（回到全部文章）');
    ok(read('src/main/I18NStrings.js').includes('"清空搜索": { zh: "清空搜索", en: "Clear Search" }'),
      '3 i18n 键在册（清空搜索）');

    // ── UI 行为断言（真实 ListView 渲染，r58 同款）──
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
        const { ListView } = await import('./views/list.js');
        const host = document.createElement('div');
        host.className = 'list-scroll';
        document.body.appendChild(host);
        let searched = null;
        const lv = new ListView(host, { onSelect: () => {}, onContext: () => {}, onLoadMore: () => {}, onSearch: (q) => { searched = q; } });
        window.__lv = lv;
        // 搜索无结果空态
        lv.render([], { kind: 'search' }, null, false);
        await sleep(250);
        const empty = host.querySelector('.list-empty');
        const clearBtn = host.querySelector('.list-empty-clear');
        const hasArt = !!empty?.querySelector('.empty-art .ea-scene');
        const h3 = empty?.querySelector('h3')?.textContent || '';
        const btnText = clearBtn?.textContent || '';
        const ctaCls = clearBtn?.className || '';
        // 三态/节奏计算样式（真实 DOM）
        const cs = clearBtn ? getComputedStyle(clearBtn) : null;
        const transProp = cs ? cs.transitionProperty : '';
        const marginTop = cs ? cs.marginTop : '';
        const padTop = cs ? cs.paddingTop : '';
        const gap = empty ? getComputedStyle(empty).gap : '';
        const shellPad = empty ? getComputedStyle(empty).paddingTop : '';
        // 点击出路：清输入 + 回调 + 焦点归还
        lv.searchInput.value = '知更';
        lv.searchHost.classList.add('has-value');
        clearBtn?.click();
        await sleep(120);
        return { hasArt, h3, btnText, ctaCls, transProp, marginTop, padTop, gap, shellPad,
          searched, inputCleared: lv.searchInput.value === '', hasValueOff: !lv.searchHost.classList.contains('has-value'),
          focusBack: document.activeElement === lv.searchInput };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'r59-flow');
    if (flow.__err) ok(false, '3 搜索空态流程探针异常 — ' + flow.__err);
    else {
      ok(flow.hasArt, '3 搜索空态渲染插画（ea-scene 镜中山野）');
      ok(flow.h3.includes('没有匹配'), `3 空态标题语义正确（${flow.h3}）`);
      ok(flow.btnText === '清空搜索', `3 出路按钮文案「清空搜索」（实际 ${flow.btnText}）`);
      ok(flow.ctaCls.includes('list-empty-refresh'), '3 出路按钮入空态 CTA 家族（同类元素同语言）');
      ok(flow.searched === '', `3 点击清空 → onSearch('') 回调（实际 ${JSON.stringify(flow.searched)}）`);
      ok(flow.inputCleared && flow.hasValueOff, '3 点击清空 → 输入框与 has-value 态同步清位');
      ok(flow.focusBack, '3 清空后焦点归还搜索框（可继续换词）');
      ok(flow.transProp.includes('transform'), `1 计算样式：过渡含 transform（${flow.transProp.slice(0, 60)}…）`);
      ok(flow.marginTop === '16px', `2 CTA 第四拍计算间距 = --space-4（实际 ${flow.marginTop}）`);
      ok(flow.padTop === '8px', `2 CTA 内边距计算 = --space-2（实际 ${flow.padTop}）`);
      ok(flow.gap === '8px', `2 空态壳计算 gap = --space-2（实际 ${flow.gap}）`);
      ok(flow.shellPad === '32px', `2 空态壳纵向 padding = --space-8（实际 ${flow.shellPad}）`);
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
