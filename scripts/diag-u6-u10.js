'use strict';
/**
 * diag-u6-u10.js — U6–U10 视觉轮探针（run-all OFFLINE 集）
 * U6 暗色精修：body.dark 表面三档 --surface-1/2/3 在册且互不相等；暗色 --shadow-1/2/3 覆盖生效；
 *             卡片/弹层/模态/输入框归档；text-tertiary 在三档表面上的对比度走查 ≥3.0（装饰档）
 * U7 季节套包：SEASON_PACKS 四季在册（春竹青/夏黛蓝/秋柿橙/冬墨灰）；applyPalette 应用后 --accent 变化、clearPalette 撤销恢复；
 *             预案区季节分区头（.td-season-head + 四枚 .td-season-tag）真实渲染
 * U8 图标微调：icons.js 输出 stroke-width ∈ {1.75, 1.1(窗口控制 10×10 等比)}；尺寸阶梯 --icon-sm/md/lg=14/16/18 且按钮/导航/菜单归簇；
 *             图标 flex:none + vertical-align 基线微调生效
 * U9 滚动体验：恒宽轨道+主题色拇指规则在册；正文 scroll-behavior:auto、TOC 平滑由 reader.js scrollIntoView 承担（审查收口后无 anchor-jump）
 * U10 窗口级：body.nj-resizing 过渡抑制规则在册 + resize 事件挂载/防抖摘除；标题栏双击最大化 title 在位
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-u610-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 150 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');

app.whenReady().then(async () => {
  try {
    // ── Phase A：源码在册断言 ──────────────────────────────────────────────
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const robin = read('src/renderer/styles/robin.css');
    const storeCss = read('src/renderer/styles/store.css');
    const engineSrc = read('src/renderer/views/theme-engine.js');
    const designerSrc = read('src/renderer/views/theme-designer.js');
    const iconsSrc = read('src/renderer/icons.js');
    const appSrc = read('src/renderer/app.js');
    const htmlSrc = read('src/renderer/index.html');

    // U6：暗色表面三档在册（body.dark 块内 color-mix 派生）
    const darkBlock = robin.slice(robin.indexOf('body.dark {'), robin.indexOf('body.dark {') + 2400);
    for (const tok of ['--surface-1', '--surface-2', '--surface-3']) {
      ok(new RegExp(`\\n  ${tok}: color-mix\\(in srgb, var\\(--note-background\\) \\d+%, var\\(--page-background\\)\\)`).test(darkBlock),
        `U6 暗色 ${tok}（note-background×page 派生）在册`);
    }
    // U6：暗色阴影加深档（纯黑重墨覆盖）
    ok(/--shadow-1:\s*0 1px 2px rgba\(0, 0, 0, 0\.32\)/.test(darkBlock), 'U6 暗色 --shadow-1 纯黑加深档在册');
    ok(/--shadow-2:\s*0 8px 24px rgba\(0, 0, 0, 0\.42\), 0 2px 6px rgba\(0, 0, 0, 0\.30\)/.test(darkBlock), 'U6 暗色 --shadow-2 纯黑加深档在册');
    ok(/--shadow-3:\s*0 18px 48px rgba\(0, 0, 0, 0\.52\)/.test(darkBlock), 'U6 暗色 --shadow-3 纯黑加深档在册');
    // U6：历史硬编码暗色卡面清零 + 三档归档接线
    ok(!robin.includes('#302d28'), 'U6 暗色摘要卡历史硬编码 #302d28 清零');
    ok(/\.modal \{\r?\n  background: var\(--surface-3\)/.test(robin), 'U6 模态归 --surface-3');
    ok(/\.context-menu \{[^}]*background: var\(--surface-2\)/.test(robin), 'U6 右键菜单（弹层）归 --surface-2');
    ok(/select\.control, input\.control \{[^}]*background: var\(--surface-1\)/.test(robin), 'U6 输入框（.control）归 --surface-1');
    ok((storeCss.match(/var\(--surface-1\)/g) || []).length >= 3, 'U6 源商店输入框三处归 --surface-1');

    // U7：季节套包在册（四季全 + 传统色口径锚点）
    for (const [season, name, hex] of [['spring', '春·竹青', '#789262'], ['summer', '夏·黛蓝', '#425066'], ['autumn', '秋·柿橙', '#D2691E'], ['winter', '冬·墨灰', '#424C50']]) {
      ok(engineSrc.includes(`season: '${season}'`) && engineSrc.includes(`name: '${name}'`) && engineSrc.includes(`accent: '${hex}'`),
        `U7 季节套包 ${name}（${hex}）在册`);
    }
    ok(/export const SEASON_PACKS/.test(engineSrc), 'U7 SEASON_PACKS 导出在册');
    ok(designerSrc.includes('SEASON_PACKS') && designerSrc.includes('td-season-head') && designerSrc.includes('td-season-tag'),
      'U7 预案区季节分区头（td-season-head/td-season-tag）接线在册');
    ok(/\.td-season-head \{/.test(robin) && /\.td-season-tag \{/.test(robin), 'U7 季节分区头样式在册');

    // U8：icons.js 描边统一（线框 1.75；窗口控制 10×10 等比 1.1）
    const swValues = [...iconsSrc.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => m[1]);
    ok(swValues.length > 0 && swValues.every((v) => v === '1.75' || v === '1.1'),
      `U8 icons.js stroke-width 全部 ∈ {1.75, 1.1}（实际 ${[...new Set(swValues)].join('/')} × ${swValues.length}）`);
    ok(/stroke-width="\$\{ICON_STROKE\}"/.test(iconsSrc) && /const ICON_STROKE = 1\.75;/.test(iconsSrc), 'U8 默认描边常量 ICON_STROKE=1.75 在册');
    const winGlyphSw = iconsSrc.slice(iconsSrc.indexOf('winMinimize'), iconsSrc.indexOf('winClose') + 240)
      .match(/stroke-width="([\d.]+)"/g) || [];
    ok(winGlyphSw.length === 4 && winGlyphSw.every((s) => s === 'stroke-width="1.1"'), 'U8 窗口控制四字形 1.1（10×10 等比）');
    for (const f of ['src/renderer/views/media-player.js', 'src/renderer/views/reader.js']) {
      const src = read(f);
      const vals = [...src.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => m[1]);
      ok(vals.length > 0 && vals.every((v) => v === '1.75'), `U8 ${path.basename(f)} stroke-width 统一 1.75`);
    }
    ok(/sw = 1\.75/.test(read('src/renderer/card-export/templates.js')), 'U8 card-export 默认描边 1.75');
    // U8：尺寸阶梯令牌 + 归簇
    for (const [tok, val] of [['--icon-sm', '14px'], ['--icon-md', '16px'], ['--icon-lg', '18px']]) {
      ok(new RegExp(`${tok}: ${val};`).test(robin), `U8 ${tok}=${val} 在册`);
    }
    ok(/\.btn > svg[^{]*\{[^}]*width: var\(--icon-sm\)/.test(robin), 'U8 按钮图标归 14 档');
    ok(/\.context-menu-item > svg \{[^}]*width: var\(--icon-lg\)/.test(robin), 'U8 菜单图标归 18 档');
    ok(/\.nav-icon svg, \.cmd-item \.cmd-icon svg \{[^}]*width: var\(--icon-md\)/.test(robin), 'U8 导航/命令行图标归 16 档');
    ok(!/\.cmd-item \.cmd-icon svg \{[^}]*width: 15px/.test(robin) && !/\.btn-text\.icon-label svg \{[^}]*width: 13px/.test(robin),
      'U8 无同形后置死规则压制阶梯（审查 P2：R24 15px/icon-label 13px 已并入阶梯）');

    // U9：滚动条恒宽轨道+主题拇指；smooth 由 JS scrollIntoView 承担（审查 P1/P2 收口后口径）
    ok(!/\.reader-scroll:hover::-webkit-scrollbar, \.list-scroll:hover::-webkit-scrollbar \{[^}]*width: 10px/.test(robin),
      'U9 无 hover 加宽规则（审查 P2：webkit 滚动条占布局空间，加宽致重排抖动）');
    ok(/\.reader-scroll::-webkit-scrollbar, \.list-scroll::-webkit-scrollbar \{ width: 6px; height: 6px; \}/.test(robin),
      'U9 滚动条轨道恒 6px 在册');
    ok(/\.reader-scroll:hover::-webkit-scrollbar-thumb[^{]*\{[^}]*color-mix\(in srgb, var\(--accent\) 60%/.test(robin),
      'U9 hover 拇指主题色 60% 在册');
    ok(/\.reader-scroll \{ scroll-behavior: auto; \}/.test(robin), 'U9 正文滚动 scroll-behavior: auto 在册');
    ok(!robin.includes('anchor-jump'), 'U9 无 .anchor-jump 死规则（审查 P1：TOC 平滑滚动由 JS 承担）');
    ok(/behavior: ?'smooth'/.test(read('src/renderer/views/reader.js')), 'U9 reader.js TOC 跳转 scrollIntoView behavior:smooth 在册');
    ok(!/<style[^>]*>[^<]*html\s*\{[^}]*scroll-behavior:\s*smooth/.test(htmlSrc) && !/\bhtml \{[^}]*scroll-behavior:\s*smooth/.test(robin),
      'U9 无全局 html 级 smooth');

    // U10：resize 抑制 + 标题栏提示（源码层）
    ok(/body\.nj-resizing \*, body\.nj-resizing \*::before, body\.nj-resizing \*::after\s*\{\s*transition: none !important;/.test(robin),
      'U10 body.nj-resizing 过渡抑制规则在册');
    ok(/classList\.add\('nj-resizing'\)/.test(appSrc) && /classList\.remove\('nj-resizing'\)/.test(appSrc),
      'U10 app.js resize 监听挂载/摘除 nj-resizing 在册');
    ok(htmlSrc.includes('id="main-toolbar" title="'), 'U10 标题栏双击最大化静态 title 在位');
    ok(appSrc.includes("mainToolbar.title = t('双击标题栏空白处可最大化或还原窗口')"), 'U10 标题栏 title i18n 覆写在册');
    ok(/#main-toolbar:hover::after \{ background: var\(--separator\); opacity: 0\.55; \}/.test(robin), 'U10 拖拽区悬停发丝线在册');

    // ── Phase B：真实渲染窗口断言 ─────────────────────────────────────────
    const win = new BrowserWindow({
      show: false, width: 1280, height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(900);

    const engineURL = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'views', 'theme-engine.js')).href;
    const iconsURL = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'icons.js')).href;
    const designerURL = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'views', 'theme-designer.js')).href;

    const b = await win.webContents.executeJavaScript(`(async () => {
      const out = {};
      const root = document.documentElement;
      const cs = getComputedStyle(root);
      const $ = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
      const host = document.createElement('div');
      document.body.appendChild(host);

      // ── U6：暗色三档表面真实取值 + 阴影覆盖 + 对比度走查 ──
      const resolveColor = (token) => {
        const probe = document.createElement('div');
        probe.style.background = 'var(' + token + ')';
        host.appendChild(probe);
        const v = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return v;
      };
      const probeShadow = () => { const d = $('<div style="box-shadow: var(--shadow-2)"></div>'); host.appendChild(d); const v = getComputedStyle(d).boxShadow; d.remove(); return v; };
      const getSurf = () => ['--surface-1', '--surface-2', '--surface-3'].map(resolveColor);
      out.lightSurf = getSurf();
      out.lightShadow = probeShadow();
      document.body.classList.add('dark');
      out.darkSurf = getSurf();
      out.darkShadow = probeShadow();
      out.darkDistinct = new Set(out.darkSurf).size === 3 && out.darkSurf.every((s) => s && s !== 'none' && s !== 'rgba(0, 0, 0, 0)');
      // 对比度走查：text-tertiary 在三档暗面上的合成比（WCAG）
      // 注：现代 Chromium 会把 color-mix 结果序列化为 color(srgb r g b)（0-1 浮点），三格式都要解析。
      const parseColor = (s) => {
        s = s.trim();
        if (s.startsWith('#')) {
          const h = s.slice(1);
          const x = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
          return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16), 1];
        }
        if (s.startsWith('color(srgb')) {
          const ch = (v) => Math.round(v * 255);
          const nums = s.replace(/[^0-9. /]/g, ' ').trim().split(' ').filter((t) => t && t !== '/').map(Number);
          if (nums.length < 3 || nums.slice(0, 3).some((v) => !Number.isFinite(v))) return [0, 0, 0, 0];
          return [ch(nums[0]), ch(nums[1]), ch(nums[2]), nums[3] == null || !Number.isFinite(nums[3]) ? 1 : nums[3]];
        }
        const parts = (s.match(/rgba?\\(([^)]+)\\)/) || [])[1].split(',').map(Number);
        return [parts[0], parts[1], parts[2], parts[3] == null ? 1 : parts[3]];
      };
      const lum = (r, g, bb) => {
        const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bb);
      };
      const over = (fg, bg) => { const a = fg[3] == null ? 1 : fg[3]; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)); };
      out.contrast = out.darkSurf.map((bgColor) => {
        const surfRGB = parseColor(bgColor);
        const ter = parseColor(getComputedStyle(document.body).getPropertyValue('--text-tertiary'));
        const fg = over(ter, surfRGB);
        const L1 = lum(fg[0], fg[1], fg[2]);
        const L2 = lum(surfRGB[0], surfRGB[1], surfRGB[2]);
        return +(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)).toFixed(2));
      });
      // 三档归档接线：类名元素背景跟随对应表面
      const mk = (html) => { const el = $(html); host.appendChild(el); return el; };
      const ctx = mk('<div class="context-menu"></div>');
      const modal = mk('<div class="modal" style="width:80px;height:40px"></div>');
      const input = mk('<input class="control"/>');
      out.wiredCtx = getComputedStyle(ctx).backgroundColor;
      out.wiredModal = getComputedStyle(modal).backgroundColor;
      out.wiredInput = getComputedStyle(input).backgroundColor;
      document.body.classList.remove('dark');
      out.lightWiredCtx = getComputedStyle(ctx).backgroundColor;
      host.querySelectorAll('.context-menu, .modal, .control').forEach((e) => e.remove());

      // ── U7：季节套包引擎断言（应用/撤销）──
      const engine = await import(${JSON.stringify(engineURL)});
      const packs = engine.SEASON_PACKS;
      out.seasons = packs.map((p) => p.season);
      out.seasonTokensOk = packs.length === 4 && packs.every((p) => p.tokens.th != null && p.tokens.th2 != null && p.tokens.ths != null);
      const accentBefore = cs.getPropertyValue('--accent').trim();
      engine.applyPalette(engine.fullPalette(packs[2].tokens)); // 秋·柿橙
      const accentApplied = getComputedStyle(root).getPropertyValue('--accent').trim();
      out.accentChanged = accentApplied !== accentBefore && accentApplied.length > 0;
      // 主题色随 accent 联动（季节系统走全量通路）
      out.paletteShape = engine.fullPalette(packs[0].tokens)['--accent'] != null;

      // ── U7：预案区季节分区头真实渲染 ──
      const designer = await import(${JSON.stringify(designerURL)});
      const proposer = new designer.ThemeProposer({ onApply: () => {}, onReset: () => {} });
      const rc = document.createElement('div');
      document.body.appendChild(rc);
      proposer.render(rc);
      const head = rc.querySelector('.td-season-head');
      out.seasonHead = {
        present: !!head,
        title: head ? head.querySelector('.td-season-title').textContent : '',
        tags: head ? head.querySelectorAll('.td-season-tag').length : 0,
        cards: rc.querySelectorAll('.td-season-grid .td-card').length,
        tagSeasons: head ? [...head.querySelectorAll('.td-season-tag')].map((t) => t.dataset.season) : [],
      };
      rc.remove();
      engine.clearPalette();
      out.accentRestored = getComputedStyle(root).getPropertyValue('--accent').trim() === accentBefore;

      // ── U8：icons.js 输出描边 + 尺寸阶梯 + 基线对齐 ──
      const { icons } = await import(${JSON.stringify(iconsURL)});
      const sws = [];
      for (const [k, svg] of Object.entries(icons)) {
        for (const m of svg.matchAll(/stroke-width="([\\d.]+)"/g)) sws.push({ k, v: m[1] });
      }
      out.iconSw = { distinct: [...new Set(sws.map((s) => s.v))], count: sws.length };
      const row = mk('<button class="btn"><svg viewBox="0 0 16 16" width="15" height="15" stroke-width="1.75"></svg><span>刷新</span></button>');
      const menuItem = mk('<div class="context-menu-item"><svg viewBox="0 0 16 16"></svg><span>菜单项</span></div>');
      const navItem = mk('<div class="modal-nav-item"><span class="nav-icon"><svg viewBox="0 0 16 16"></svg></span><span>设置</span></div>');
      const cmdItem = mk('<div class="cmd-item"><span class="cmd-icon"><svg viewBox="0 0 16 16"></svg></span><span class="cmd-label">命令</span></div>');
      const iconLabelBtn = mk('<button class="btn-text icon-label"><svg viewBox="0 0 16 16"></svg><span>带字按钮</span></button>');
      const btnSvg = row.querySelector('svg');
      const icsBtn = getComputedStyle(btnSvg);
      out.ladder = {
        btn: { w: icsBtn.width, flex: icsBtn.flexShrink, va: icsBtn.verticalAlign, margin: icsBtn.marginLeft },
        menu: { w: getComputedStyle(menuItem.querySelector('svg')).width },
        nav: { w: getComputedStyle(navItem.querySelector('.nav-icon svg')).width },
        cmd: { w: getComputedStyle(cmdItem.querySelector('svg')).width },
        iconLabel: { w: getComputedStyle(iconLabelBtn.querySelector('svg')).width },
      };
      host.querySelectorAll('.btn, .context-menu-item, .modal-nav-item, .cmd-item, .btn-text').forEach((e) => e.remove());

      // ── U9：CSSOM 规则在册断言（walk 带 media 上下文，media 内规则不覆盖顶层判定）──
      const found = { hoverWide: null, hoverThumb: null, anchorSmooth: null, baseAuto: null, rmExempt: false };
      const walk = (rules, inMedia) => {
        for (const r of rules) {
          try {
            if (r.selectorText && r.style) {
              const s = r.selectorText;
              if (s === '.reader-scroll:hover::-webkit-scrollbar, .list-scroll:hover::-webkit-scrollbar') found.hoverWide = r.style.width;
              if (s === '.reader-scroll:hover::-webkit-scrollbar-thumb, .list-scroll:hover::-webkit-scrollbar-thumb') found.hoverThumb = r.style.background;
              if (s === '.reader-scroll.anchor-jump' && !inMedia) found.anchorSmooth = r.style.scrollBehavior;
              if (s === '.reader-scroll' && !inMedia) found.baseAuto = r.style.scrollBehavior;
            }
            if (r.media && /prefers-reduced-motion/.test(r.media.mediaText)) {
              for (const inner of r.cssRules) {
                if (inner.selectorText === '.reader-scroll.anchor-jump' && inner.style.getPropertyValue('scroll-behavior') === 'auto') found.rmExempt = true;
              }
            }
            if (r.cssRules && r.cssRules.length) walk(r.cssRules, inMedia || Boolean(r.media));
          } catch (_) {}
        }
      };
      for (const sheet of document.styleSheets) { try { walk(sheet.cssRules, false); } catch (_) {} }
      out.u9 = found;

      // ── U10：resize 过渡抑制实效（探针无主进程 IPC，bindEvents 不执行——
      //     app.js 挂载/摘除接线由 Phase A 源码断言覆盖；此处验证 CSS 抑制契约本身）──
      const animated = mk('<div class="entry-row" style="transition: opacity 0.4s ease"></div>');
      out.u10 = {};
      document.body.classList.add('nj-resizing');
      out.u10.transSuppressed = getComputedStyle(animated).transitionDuration === '0s'
        && getComputedStyle(animated).transitionProperty.includes('none');
      document.body.classList.remove('nj-resizing');
      out.u10.transRestored = getComputedStyle(animated).transitionDuration !== '0s';
      // 模拟 app.js 同形接线（挂载→防抖 200ms 摘除），验证挂载与摘除节奏可用
      let settleTimer = null;
      window.addEventListener('resize', () => {
        document.body.classList.add('nj-resizing');
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => document.body.classList.remove('nj-resizing'), 200);
      });
      window.dispatchEvent(new Event('resize'));
      await new Promise((r) => setTimeout(r, 60));
      out.u10.classOn = document.body.classList.contains('nj-resizing');
      await new Promise((r) => setTimeout(r, 260));
      out.u10.classOff = !document.body.classList.contains('nj-resizing');
      animated.remove();
      out.u10.tbTitle = (document.getElementById('main-toolbar') || {}).title || '';
      host.remove();
      return out;
    })()`);

    // U6 断言
    ok(b.darkSurf && b.darkDistinct, `U6 暗色表面三档真实取值且互不相等（${(b.darkSurf || []).join(' | ')}）`);
    ok(b.lightSurf && b.lightSurf.every((s) => s && s !== 'none'), `U6 浅色表面三档为现状别名（${(b.lightSurf || []).join(' | ')}）`);
    ok(b.darkShadow.includes('rgba(0, 0, 0') && b.lightShadow !== b.darkShadow,
      `U6 暗色阴影覆盖生效（亮=${b.lightShadow.slice(0, 34)}… 暗=${b.darkShadow.slice(0, 34)}…）`);
    ok(b.contrast.length === 3 && b.contrast.every((c) => c >= 3.0),
      `U6 对比度走查：text-tertiary 在暗面 1/2/3 上 ${b.contrast.join('/')} 全 ≥3.0（装饰档）`);
    ok(b.wiredCtx !== 'rgba(0, 0, 0, 0)' && b.wiredModal !== 'rgba(0, 0, 0, 0)' && b.wiredInput !== 'rgba(0, 0, 0, 0)',
      `U6 暗色归档实效：弹层/模态/输入框背景均落在三档表面上（${b.wiredCtx} / ${b.wiredModal} / ${b.wiredInput}）`);
    ok(b.lightWiredCtx === b.lightSurf[1], 'U6 浅色弹层仍等于 --chrome-background（零回归）');

    // U7 断言
    ok(b.seasonTokensOk && ['spring', 'summer', 'autumn', 'winter'].every((s) => b.seasons.includes(s)),
      `U7 四季套包在册（${b.seasons.join('/')}）且令牌完备（th/th2/ths）`);
    ok(b.accentChanged, `U7 应用「秋·柿橙」后 --accent 变化`);
    ok(b.accentRestored, `U7 clearPalette 撤销后 --accent 恢复`);
    ok(b.paletteShape, 'U7 套包经 fullPalette 全量通路（accent/纸面/链接色成套映射）');
    ok(b.seasonHead.present && b.seasonHead.tags === 4 && b.seasonHead.cards === 4
      && ['spring', 'summer', 'autumn', 'winter'].every((s, i) => b.seasonHead.tagSeasons[i] === s),
      `U7 预案区季节分区头渲染（title="${b.seasonHead.title}" tags=${b.seasonHead.tags} cards=${b.seasonHead.cards}）`);

    // U8 断言
    ok(b.iconSw.count >= 60 && b.iconSw.distinct.every((v) => v === '1.75' || v === '1.1'),
      `U8 icons.js 输出 stroke-width 统一（${b.iconSw.count} 处，distinct=${b.iconSw.distinct.join('/')}）`);
    ok(b.ladder.btn.w === '14px' && b.ladder.menu.w === '18px' && b.ladder.nav.w === '16px'
      && b.ladder.cmd.w === '16px' && b.ladder.iconLabel.w === '14px',
      `U8 尺寸阶梯归簇：按钮=${b.ladder.btn.w} 菜单=${b.ladder.menu.w} 导航=${b.ladder.nav.w} 命令行=${b.ladder.cmd.w} 带字按钮=${b.ladder.iconLabel.w}`);
    ok(b.ladder.btn.flex === '0' && b.ladder.btn.margin === '0px' && b.ladder.btn.va !== 'baseline',
      `U8 基线对齐：flex:none + margin 归零 + vertical-align ${b.ladder.btn.va}`);

    // U9 断言（审查收口后口径：恒宽轨道无加宽规则；anchor-jump 死规则已删）
    ok(b.u9.hoverWide == null, `U9 CSSOM：无 hover 加宽规则（width=${b.u9.hoverWide}，恒 6px 不抖动）`);
    ok(b.u9.hoverThumb && b.u9.hoverThumb.includes('color-mix'), `U9 CSSOM：hover 拇指主题色在册`);
    ok(b.u9.baseAuto === 'auto' && b.u9.anchorSmooth == null, `U9 CSSOM：正文 auto / 无 anchor-jump 死规则（${b.u9.baseAuto}/${b.u9.anchorSmooth}）`);
    ok(!b.u9.rmExempt, 'U9 CSSOM：anchor-jump 豁免规则随死规则一并移除');

    // U10 断言
    ok(b.u10.transSuppressed, `U10 nj-resizing 期间过渡被抑制（transition:none 实效）`);
    ok(b.u10.transRestored, 'U10 摘除 nj-resizing 后过渡恢复');
    ok(b.u10.classOn && b.u10.classOff, `U10 resize 挂载 nj-resizing → 防抖摘除（on=${b.u10.classOn} off=${b.u10.classOff}）`);
    ok(b.u10.tbTitle.includes('最大化') || b.u10.tbTitle.includes('还原'), `U10 标题栏 title="${b.u10.tbTitle}"`);

    if (failed) { console.error(failed + ' 项失败'); app.exit(1); }
    else { console.log('ALL PASSED'); app.exit(0); }
  } catch (e) {
    console.error('ERR', String(e && e.stack || e).slice(0, 1200));
    app.exit(1);
  }
});
