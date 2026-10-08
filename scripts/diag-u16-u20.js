'use strict';
/**
 * diag-u16-u20.js — U16–U20 收官批视觉轮探针（run-all OFFLINE 集）
 *
 * U16 图表视觉升级：chart-kit 在册（dpr 清晰化/rAF 单驱动/进度裁剪/统一描边基线环形）；
 *                   knowledge 折线生长+图谱入场接线；knowledge/evolution 柱条 nj-bars 交错升起；
 *                   dpr=2 实测物理像素放大；reduced-motion 直达终态（单帧 progress=1）
 * U17 命令面板 2.0：fuzzyMark 单测（子串/子序列/未命中）；命中字符 <mark> 高亮真渲染；
 *                   图标行零缺图标（回退 general）；预览窗格真渲染（标题/影响范围/快捷键/说明/关键词）
 *                   且随 ↑↓ 零重建联动；既有注册结构只扩不破（desc 可选扩展）
 * U18 键盘焦点体系：--focus-w/--focus-off/--focus-off-in 量纲令牌；三档环（输入/按钮/列表项）在册；
 *                   focusArrowSiblings 单测（环绕/不可达跳过）；设置中心与自进化模态 ↑↓ 真移焦
 * U19 窗口级体验：标题栏 role=banner 语义；拖拽态 body.nj-win-drag 真挂摘；
 *                   snap 提示层四缘元素+显现规则；窗口管理逻辑零触碰（window:maximize 原样）
 * U20 终极一致性 pass：--fs-* 五档令牌在册；三 CSS 文件 <12px font-size 字面量清零
 *                   （CSSOM 全表扫描=0）；同名类分叉修复对照（td-card/kb-card/list-top-title/
 *                   robin-header-meta/list-empty/favicon-badge）；标点归全角（新建文件夹…/提问…）；
 *                   间距归 4px 网格档（cmd-item 8px / 组头 8px4px / loading-more 8px）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-u1620-')));
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
    const accountCss = read('src/renderer/styles/account.css');
    const kitSrc = read('src/renderer/views/chart-kit.js');
    const kbSrc = read('src/renderer/views/knowledge.js');
    const evoSrc = read('src/renderer/views/evolution-view.js');
    const palSrc = read('src/renderer/views/command-palette.js');
    const appSrc = read('src/renderer/app.js');
    const dlgSrc = read('src/renderer/views/dialogs.js');
    const kbdSrc = read('src/renderer/views/kbd-nav.js');
    const htmlSrc = read('src/renderer/index.html');
    const ipcSrc = read('src/main/ipc.js');
    const i18nSrc = read('src/main/I18NStrings.js');

    // U16：chart-kit 契约
    for (const fn of ['setupCanvas', 'runChartIntro', 'clipSeriesByProgress', 'strokeSeries', 'drawBaseline', 'drawRing', 'easeOutCubic', 'chartToken', 'prefersReducedMotion']) {
      ok(new RegExp(`export (function|const) ${fn}`).test(kitSrc), `U16 chart-kit 导出 ${fn} 在册`);
    }
    ok(/requestAnimationFrame\(tick\)/.test(kitSrc) && /cancelAnimationFrame/.test(kitSrc), 'U16 入场动画 rAF 单驱动（可取消）在册');
    ok(/prefersReducedMotion\(\)/.test(kitSrc) && /onFrame\(1\);/.test(kitSrc), 'U16 reduced-motion 直达终态（单帧 progress=1）在册');
    ok(kbSrc.includes("from './chart-kit.js'"), 'U16 knowledge 接线 chart-kit');
    ok(/setupCanvas\(canvas, W, H\)/.test(kbSrc) && /runChartIntro\(\{ onFrame: render \}\)/.test(kbSrc), 'U16 知识趋势折线：dpr 清晰化 + 生长动画接线');
    ok(/clipSeriesByProgress\(full\[si\], progress\)/.test(kbSrc) && /drawBaseline\(ctx, 8, W - 8, H - 14, gridColor\)/.test(kbSrc), 'U16 折线进度裁剪 + 统一网格基线在册');
    ok(/runChartIntro\(\{\s*\n\s*onFrame: \(progress\) =>/.test(kbSrc) && /kb-graph-canvas/.test(kbSrc), 'U16 知识图谱入场动画（节点浮现/边淡入）在册');
    ok(/kb-hour-bars nj-bars/.test(kbSrc) && /setProperty\('--nj-bar-i'/.test(kbSrc), 'U16 知识时段柱条 nj-bars + 交错次序在册');
    ok(/kb-chart nj-bars/.test(evoSrc) && /setProperty\('--nj-bar-i'/.test(evoSrc), 'U16 进化引擎密度柱条 nj-bars + 交错次序在册');
    ok(/@keyframes nj-bar-rise \{[^}]*scaleY\(0\)/.test(robin) && /animation: nj-bar-rise var\(--dur-slow\) var\(--ease-out\) both;/.test(robin), 'U16 柱条升起 keyframes（scaleY 合成层）在册');
    ok(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.nj-bars > \.kb-chart-bar/.test(robin), 'U16 柱条动画门控 no-preference 在册');
    ok(/\.kb-chart-bar, \.kb-hour-col > i \{\s*transform-origin: bottom;/.test(robin), 'U16 柱条 transform-origin 底部在册');

    // U17：命令面板 2.0
    ok(/export function fuzzyMark/.test(palSrc), 'U17 fuzzyMark 导出在册');
    ok(/cmd-preview/.test(palSrc) && /_renderPreview\(this\.filtered\[this\.activeIndex\]\)/.test(palSrc), 'U17 预览窗格挂载 + 随选中项同步在册');
    ok(/icon\(cmd\.icon \|\| FALLBACK_ICON\)/.test(palSrc) && /const FALLBACK_ICON = 'general';/.test(palSrc), 'U17 图标行零缺图标（回退 general）在册');
    ok(/<mark>/.test(palSrc) && /_labelHTML\(cmd\)/.test(palSrc), 'U17 命中字符 <mark> 高亮在册');
    ok(/t\('影响范围'\)/.test(palSrc) && /t\('快捷键'\)/.test(palSrc) && /cmd\.desc/.test(palSrc), 'U17 预览元数据行（影响范围/快捷键/说明）在册');
    ok(/desc: t\(/.test(appSrc), 'U17 app.js 命令注册 desc 扩展在册（只扩不破）');
    for (const k of ['影响范围', '快捷键', '说明', '关键词', '切换整窗纸面配色，夜间读长文更省眼。', '高亮、笔记、复习与知识图谱的中心。', '外观、账户、同步与 AI 配置都在这里。']) {
      ok(i18nSrc.includes(`"${k}"`), `U17 i18n 在册「${k.slice(0, 12)}…」`);
    }
    ok(/\.cmd-item \.cmd-label mark \{/.test(robin) && /\.cmd-palette\.has-preview \{ width: min\(780px, 94vw\); \}/.test(robin) && /\.cmd-preview \{/.test(robin), 'U17 mark/双列布局/预览窗格样式在册');

    // U18：焦点环家族 + 箭头导航补缺
    ok(/--focus-w: 2px;/.test(robin) && /--focus-off: 2px;/.test(robin) && /--focus-off-in: -2px;/.test(robin), 'U18 焦点环量纲令牌（--focus-w/--focus-off/--focus-off-in）在册');
    ok(/input:focus-visible,\s*\ntextarea:focus-visible,\s*\nselect:focus-visible \{\s*\n  box-shadow: var\(--focus-ring\);/.test(robin), 'U18 档一（输入类 accent 光环）在册');
    ok(/button:focus-visible,\s*\n\[role="button"\]:focus-visible,\s*\na:focus-visible \{\s*\n  outline: var\(--focus-w\) solid var\(--accent\);\s*\n  outline-offset: var\(--focus-off\);/.test(robin), 'U18 档二（按钮/链接类外扩环）在册');
    ok(/\.modal-nav-item:focus-visible,\s*\n\.cmd-item:focus-visible,[^}]*outline: var\(--focus-w\) solid var\(--accent\);\s*\n  outline-offset: var\(--focus-off-in\);/.test(robin), 'U18 档三（列表项内嵌环）在册');
    ok(/export function focusArrowSiblings/.test(kbdSrc), 'U18 focusArrowSiblings 导出在册');
    ok(/% items\.length/.test(kbdSrc), 'U18 环绕移动（取模）在册（无焦点陷阱）');
    ok(dlgSrc.includes('focusArrowSiblings(nav, e, \'.modal-nav-item\')'), 'U18 设置中心分区导航 ↑↓ 接线在册');
    ok(/focusArrowSiblings\(sidebar, e, '\.modal-nav-item'\)/.test(evoSrc) && /setAttribute\('tabindex', '0'\)/.test(evoSrc), 'U18 自进化模态导航可聚焦 + ↑↓ 接线在册');

    // U19：窗口级体验
    ok(/classList\.add\('nj-win-drag'\)/.test(appSrc) && /classList\.remove\('nj-win-drag'\)/.test(appSrc), 'U19 拖拽态 body.nj-win-drag 挂/摘接线在册');
    ok(htmlSrc.includes('nj-snap-hint') && (htmlSrc.match(/nj-snap-edge nj-snap-/g) || []).length === 4, 'U19 snap 提示层四缘元素在册');
    ok(/body\.nj-win-drag \.nj-snap-hint \{ opacity: 1; \}/.test(robin) && /\.nj-snap-top \{/.test(robin) && /\.nj-snap-bottom \{/.test(robin) && /\.nj-snap-left \{/.test(robin) && /\.nj-snap-right \{/.test(robin), 'U19 snap 显现规则 + 四缘样式在册');
    ok(/body\.nj-win-drag #main-toolbar \{/.test(robin), 'U19 拖拽态标题栏提亮规则在册');
    ok(/id="main-toolbar"[^>]*role="banner"/.test(htmlSrc), 'U19 标题栏 role=banner 语义在册');
    ok(ipcSrc.includes("ipcMain.on('window:maximize'") && ipcSrc.includes('window.unmaximize()'), 'U19 窗口管理逻辑零触碰（window:maximize 原样回归锚）');

    // U20：一致性审计修
    ok(/--fs-2xs: 9\.5px;/.test(robin) && /--fs-xs: 10px;/.test(robin) && /--fs-sm: 10\.5px;/.test(robin) && /--fs-md: 11px;/.test(robin) && /--fs-lg: 11\.5px;/.test(robin), 'U20 字号阶梯五档令牌在册');
    const countSub12 = (css) => {
      const re = /font-size:\s*(\d+(?:\.\d+)?)px/g;
      let m; let n = 0;
      while ((m = re.exec(css))) if (parseFloat(m[1]) < 12) n += 1;
      return n;
    };
    ok(countSub12(robin) === 0 && countSub12(storeCss) === 0 && countSub12(accountCss) === 0,
      `U20 三 CSS <12px font-size 字面量清零（robin/store/account = ${countSub12(robin)}/${countSub12(storeCss)}/${countSub12(accountCss)}）`);
    ok(!/translateY\(-2px\); box-shadow: 0 8px 20px -12px/.test(robin) && (robin.match(/\.td-card:hover \{/g) || []).length === 1, 'U20 漂移修复：td-card 陈旧硬编码 hover 块清零（唯一令牌规则）');
    ok(/\.kb-card:hover \{ border-color: var\(--note-border\); transform: translateY\(var\(--lift-y\)\); box-shadow: var\(--shadow-1\); \}/.test(robin), 'U20 漂移修复：kb-card hover 归 --lift-y 令牌族');
    ok((robin.match(/^\.list-top-title \{/gm) || []).length === 1, 'U20 漂移修复：list-top-title 分叉块合并为单声明');
    ok((robin.match(/gap: 6px 8px;[^}\n]*\n\s*font-size: 0\.82em;/m) || []).length === 1 && !/tabular-nums; gap: 6px/.test(robin), 'U20 漂移修复：robin-header-meta gap 归一单处');
    ok(!/rgba\(97, 115, 87, 0\.18\)/.test(robin) && /favicon-badge \{ box-shadow: inset 0 0 0 1px color-mix\(in srgb, var\(--accent\) 18%, transparent\)/.test(robin), 'U20 漂移修复：favicon-badge 硬编码描边归 accent 派生');
    ok(/\.list-empty h3, \.reader-empty h3 \{ font-family: var\(--font-serif\); font-size: 16\.5px; font-weight: 600;/.test(robin) && (robin.match(/^\.list-empty p, \.reader-empty p \{/gm) || []).length === 1, 'U20 漂移修复：list-empty h3/p 两代样式合并单处');
    ok(i18nSrc.includes('"新建文件夹…"') && !i18nSrc.includes('"新建文件夹..."'), 'U20 标点修复：「新建文件夹…」全角省略号');
    ok(i18nSrc.includes('"针对划选文字提问…"') && !i18nSrc.includes('"针对划选文字提问..."'), 'U20 标点修复：「针对划选文字提问…」全角省略号');
    ok(/t\('新建文件夹…'\)/.test(appSrc) && !/t\('新建文件夹\.\.\.'\)/.test(appSrc), 'U20 标点修复：app.js 调用点同步');
    ok(/padding: 8px 10px; \/\* U20/.test(robin), 'U20 间距归档：cmd-item 纵向 8px（原 9px）');
    ok(/padding: 8px 10px 4px; margin-top: 3px; \/\* U20/.test(robin), 'U20 间距归档：cmd-group-head 8px/4px（原 9px/5px）');
    ok(/justify-content: center; gap: var\(--space-2\); \/\* U20/.test(robin), 'U20 间距归档：list-loading-more gap 8px 令牌（原 7px）');

    // ── Phase B：真实渲染窗口断言 ─────────────────────────────────────────
    const win = new BrowserWindow({
      show: false, width: 1280, height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(900);

    const modURL = (f) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'views', f)).href;
    // Phase B 顺序（重要）：先正常媒体环境跑主断言，再 dpr=2 覆写，最后 reduced-motion
    // （CDP setEmulatedMedia 清除在本版本不彻底，仿真必须放在最后避免污染后续断言）

    const b = await win.webContents.executeJavaScript(`(async () => {
      const out = {};
      const kitURL = ${JSON.stringify(modURL('chart-kit.js'))};
      const palURL = ${JSON.stringify(modURL('command-palette.js'))};
      const kbdURL = ${JSON.stringify(modURL('kbd-nav.js'))};
      const dlgURL = ${JSON.stringify(modURL('dialogs.js'))};
      const evoURL = ${JSON.stringify(modURL('evolution-view.js'))};
      const kit = await import(kitURL);

      // ── U16：缓动/裁剪/真绘制 ──
      out.easeEnds = kit.easeOutCubic(0) === 0 && Math.abs(kit.easeOutCubic(1) - 1) < 1e-9;
      const samples = [0, 0.2, 0.4, 0.6, 0.8, 1].map(kit.easeOutCubic);
      out.easeMono = samples.every((v, i) => i === 0 || v >= samples[i - 1]);
      const pts = Array.from({ length: 30 }, (_, i) => ({ x: i, y: i }));
      out.clipHalf = kit.clipSeriesByProgress(pts, 0.5).length >= 15 && kit.clipSeriesByProgress(pts, 0.5).length <= 17;
      out.clipZero = kit.clipSeriesByProgress(pts, 0).length === 0;
      out.clipFull = kit.clipSeriesByProgress(pts, 1) === pts;
      const c = document.createElement('canvas');
      c.width = 200; c.height = 100;
      document.body.appendChild(c);
      const ctx = c.getContext('2d');
      const drawSum = () => {
        const d = ctx.getImageData(0, 0, 200, 100).data;
        let s = 0;
        for (let i = 3; i < d.length; i += 4) s += d[i];
        return s;
      };
      ctx.clearRect(0, 0, 200, 100);
      kit.drawBaseline(ctx, 10, 190, 90, '#617357');
      out.baselineInk = drawSum() > 0;
      ctx.clearRect(0, 0, 200, 100);
      kit.strokeSeries(ctx, [{ x: 10, y: 90 }, { x: 60, y: 40 }, { x: 120, y: 55 }, { x: 190, y: 20 }], { color: '#a3573d', baselineY: 90 });
      out.seriesInk = drawSum() > 0 && ctx.globalAlpha === 1;
      ctx.clearRect(0, 0, 200, 100);
      kit.drawRing(ctx, { progress: 0.6, x: 50, y: 50, r: 30, width: 6, track: '#d8d5c6', color: '#617357' });
      out.ringInk = drawSum() > 0;
      c.remove();
      // 正常模式入场动画：多帧推进到 1
      const seq = [];
      await new Promise((resolve) => {
        kit.runChartIntro({ duration: 160, onFrame: (p) => seq.push(p), onDone: resolve });
      });
      await new Promise((r) => setTimeout(r, 120));
      out.introFrames = seq.length;
      out.introFinal = seq.length > 1 && Math.abs(seq[seq.length - 1] - 1) < 1e-6;
      // 柱条交错：delay 随 --nj-bar-i 递增
      const host = document.createElement('div');
      host.className = 'kb-chart nj-bars';
      for (let i = 0; i < 6; i++) {
        const bar = document.createElement('div');
        bar.className = 'kb-chart-bar';
        bar.style.setProperty('--nj-bar-i', String(i));
        host.appendChild(bar);
      }
      document.body.appendChild(host);
      const d0 = getComputedStyle(host.children[0]).animationDelay;
      const d5 = getComputedStyle(host.children[5]).animationDelay;
      out.barAnim = getComputedStyle(host.children[0]).animationName === 'nj-bar-rise';
      out.barStagger = parseFloat(d5) > parseFloat(d0);
      host.remove();

      // ── U17：fuzzyMark 单测 + 面板真实行为 ──
      const { fuzzyMark, CommandPalette } = await import(palURL);
      out.fuzzySub = JSON.stringify(fuzzyMark('未读', '未读文章')) === '[0,1]';
      const f2 = fuzzyMark('kdg', '知识库 knowledge');
      out.fuzzySeq = Array.isArray(f2) && f2.length === 3 && f2.every((v, i) => i === 0 || v > f2[i - 1]);
      out.fuzzyMiss = fuzzyMark('zz', '未读') === null && fuzzyMark('', '未读') === null;
      const cmds = [
        { label: '知识库', keywords: 'knowledge 知识', icon: 'bookOpen', hint: 'Ctrl+K', desc: '高亮、笔记、复习与知识图谱的中心。', group: '全局', action: () => {} },
        { label: '未读文章', keywords: 'unread', action: () => {} },
        { label: '切换主题', keywords: 'theme dark light', icon: 'appearance', hint: 'T', group: '全局', action: () => {} },
      ];
      const cp = new CommandPalette();
      cp.present(cmds);
      await new Promise((r) => setTimeout(r, 250));
      out.paletteEl = !!document.querySelector('.cmd-palette.has-preview');
      const items = [...document.querySelectorAll('.cmd-item')];
      out.iconRows = items.length === 3 && items.every((it) => !!it.querySelector('.cmd-icon svg'));
      out.previewTitle0 = document.querySelector('.cmd-preview-title')?.textContent;
      const input = document.querySelector('.cmd-palette input');
      input.value = '未读';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      const marks = [...document.querySelectorAll('.cmd-item .cmd-label mark')];
      out.markHit = marks.length > 0 && marks.map((m) => m.textContent).join('') === '未读';
      out.previewFiltered = document.querySelector('.cmd-preview-title')?.textContent === '未读文章';
      // 回全量 → 预览带影响范围/快捷键/说明
      input.value = '知识库';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      const pvText = document.querySelector('.cmd-preview').textContent;
      out.previewMeta = pvText.includes('影响范围') && pvText.includes('快捷键') && pvText.includes('Ctrl+K') && pvText.includes('知识图谱');
      // ↑↓ 零重建联动（先回全量，再在同一次渲染内取节点引用基线）
      const input2 = document.querySelector('.cmd-palette input');
      input2.value = '';
      input2.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      const before = [...cp.listHost.querySelectorAll('.cmd-item')];
      const nodesBefore = cp.listHost.querySelectorAll('.cmd-item').length;
      const t0 = document.querySelector('.cmd-preview-title').textContent;
      cp.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 60));
      const t1 = document.querySelector('.cmd-preview-title').textContent;
      out.previewTracks = t0 !== t1 && cp.listHost.querySelectorAll('.cmd-item').length === nodesBefore;
      out.nodesSameRef = cp.listHost.querySelectorAll('.cmd-item')[0] === before[0];
      cp.dismiss();
      out.dismissed = !document.querySelector('.cmd-palette');

      // ── U18：focusArrowSiblings 单测 + 设置/自进化真移焦 ──
      const { focusArrowSiblings } = await import(kbdURL);
      const box = document.createElement('div');
      for (let i = 0; i < 3; i++) {
        const btn = document.createElement('button');
        btn.className = 'nav-x';
        btn.textContent = 'b' + i;
        box.appendChild(btn);
      }
      document.body.appendChild(box);
      box.querySelector('.nav-x').focus();
      const evDown = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      const consumed = focusArrowSiblings(box, evDown, '.nav-x');
      out.kbdConsumes = consumed && document.activeElement.textContent === 'b1';
      const evUp = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
      focusArrowSiblings(box, evUp, '.nav-x');
      focusArrowSiblings(box, evUp, '.nav-x'); // b0 → 环绕到 b2
      out.kbdWraps = document.activeElement.textContent === 'b2';
      const evLeft = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
      out.kbdIgnoresOther = focusArrowSiblings(box, evLeft, '.nav-x') === false;
      box.remove();
      // 焦点环令牌实效
      const csRoot = getComputedStyle(document.documentElement);
      out.focusTokens = csRoot.getPropertyValue('--focus-w').trim() === '2px' && csRoot.getPropertyValue('--focus-off-in').trim() === '-2px';
      // 设置中心：焦点第一分区 → ↓ 到第二分区（真移焦）
      const dlg = await import(dlgURL);
      const sv = new dlg.SettingsView({ state: { snapshot: { preferences: {}, llm: {} } }, views: {}, onAddFreshRSS: null, onReload: null, onRefreshState: null });
      sv.present('appearance');
      const navItems = [...sv.modal.querySelectorAll('.modal-nav-item')].filter((n) => !n.classList.contains('hidden'));
      navItems[0].focus();
      navItems[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      out.settingsNav = document.activeElement === navItems[1];
      navItems[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      out.settingsNavBack = document.activeElement === navItems[0];
      sv.dismiss();
      // 自进化模态：注入 robin mock → ↑↓ 移焦
      window.robin = window.robin || {};
      window.robin.evoDiagnose = async () => ({ okCount: 1, total: 1, feedCount: 1, unreadCount: 0, checks: [] });
      const { EvolutionView } = await import(evoURL);
      const evo = new EvolutionView({ onOpenArticle: () => {} });
      evo.present();
      await new Promise((r) => setTimeout(r, 400));
      const evoItems = [...evo.modal.querySelectorAll('.modal-nav-item')];
      out.evoTabbable = evoItems.length >= 6 && evoItems.every((n) => n.getAttribute('tabindex') === '0');
      evoItems[0].focus();
      evoItems[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      out.evoNav = document.activeElement === evoItems[1];
      evo.dismiss();

      // ── U19：拖拽态/snap 层真实切换 ──
      const toolbar = document.getElementById('main-toolbar');
      out.bannerRole = toolbar.getAttribute('role') === 'banner';
      out.snapEl = !!document.querySelector('.nj-snap-hint') && document.querySelectorAll('.nj-snap-hint .nj-snap-edge').length === 4;
      toolbar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      out.dragOn = document.body.classList.contains('nj-win-drag');
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      out.dragOff = !document.body.classList.contains('nj-win-drag');
      toolbar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      window.dispatchEvent(new Event('blur'));
      out.dragBlurOff = !document.body.classList.contains('nj-win-drag');

      // ── U20：CSSOM 全表扫描 + 具体归档值 ──
      // 注意：新版 Chromium 中 CSSStyleRule 也有 cssRules（嵌套 CSS，常为空表），
      // 必须先读本规则的 style 声明、再按 length 递归，否则会整表漏读。
      let sub12 = 0;
      let ruleCount = 0;
      const walk = (rules) => {
        for (const r of rules) {
          if (r.style) {
            ruleCount += 1;
            const fs = r.style.getPropertyValue('font-size');
            const m = fs.match(/^([\d.]+)px$/);
            if (m && parseFloat(m[1]) < 12) sub12 += 1;
          }
          if (r.cssRules && r.cssRules.length > 0) walk(r.cssRules);
        }
      };
      for (const sheet of document.styleSheets) {
        try { walk(sheet.cssRules); } catch (_) { /* 跨域表跳过 */ }
      }
      out.sub12Count = sub12;
      out.ruleCount = ruleCount;
      out.fsTokens = csRoot.getPropertyValue('--fs-sm').trim() === '10.5px' && csRoot.getPropertyValue('--fs-lg').trim() === '11.5px';
      const probe = document.createElement('div');
      probe.className = 'cmd-item';
      probe.innerHTML = '<span class="cmd-label">x</span>';
      document.body.appendChild(probe);
      out.cmdItemPad = getComputedStyle(probe).paddingTop === '8px';
      probe.remove();
      const meta = document.createElement('div');
      meta.className = 'robin-header-meta';
      document.body.appendChild(meta);
      out.metaGap = getComputedStyle(meta).columnGap === '8px';
      meta.remove();
      let tdHover = 0;
      let tdToken = false;
      const walk2 = (rules) => {
        for (const r of rules) {
          if (r.selectorText && r.selectorText.includes('.td-card:hover')) {
            tdHover += 1;
            if ((r.cssText || '').includes('var(--lift-y)')) tdToken = true;
          }
          if (r.cssRules && r.cssRules.length > 0) walk2(r.cssRules);
        }
      };
      for (const sheet of document.styleSheets) {
        try { walk2(sheet.cssRules); } catch (_) {}
      }
      out.tdHover = tdHover;
      out.tdToken = tdToken;
      out.tdCardSingle = tdHover === 1 && tdToken;
      return out;
    })()`);

    // ── dpr=2 与 reduced-motion 仿真（最后做，避免媒体/度量覆写污染主断言）──
    const dbg = win.webContents.debugger;
    await dbg.attach();
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
    const dprProbe = await win.webContents.executeJavaScript(`(async () => {
      const { setupCanvas } = await import(${JSON.stringify(modURL('chart-kit.js'))});
      const c = document.createElement('canvas');
      document.body.appendChild(c);
      const ctx = setupCanvas(c, 120, 60);
      const out = { pw: c.width, ph: c.height, cssW: c.style.width, transform: ctx.getTransform().a };
      c.remove();
      return out;
    })()`);
    await dbg.sendCommand('Emulation.clearDeviceMetricsOverride');
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const rmBars = await win.webContents.executeJavaScript(`(async () => {
      const { runChartIntro } = await import(${JSON.stringify(modURL('chart-kit.js'))});
      let frames = 0; let last = 0; let done = false;
      runChartIntro({ duration: 500, onFrame: (p) => { frames += 1; last = p; }, onDone: () => { done = true; } });
      const host = document.createElement('div');
      host.className = 'kb-chart nj-bars';
      for (let i = 0; i < 3; i++) {
        const bar = document.createElement('div');
        bar.className = 'kb-chart-bar';
        bar.style.setProperty('--nj-bar-i', String(i));
        host.appendChild(bar);
      }
      document.body.appendChild(host);
      const cs = getComputedStyle(host.children[0]);
      const out = { frames, last, done, anim: cs.animationName, dur: cs.animationDuration, iter: cs.animationIterationCount };
      host.remove();
      return out;
    })()`);
    await dbg.detach();

    // ── Phase B 断言 ──
    // U16
    ok(rmBars.frames === 1 && rmBars.last === 1 && rmBars.done,
      `U16 reduced-motion 下入场动画直达终态（frames=${rmBars.frames} last=${rmBars.last} done=${rmBars.done}）`);
    ok(rmBars.anim === 'none' || parseFloat(rmBars.dur) < 0.05, `U16 reduced-motion 下柱条动画收敛（anim=${rmBars.anim} dur=${rmBars.dur}）`);
    ok(dprProbe.pw === 240 && dprProbe.ph === 120 && dprProbe.cssW === '120px' && Math.abs(dprProbe.transform - 2) < 1e-6,
      `U16 dpr=2 实测：物理 240×120 / CSS 120px / ctx 缩放 2（got ${dprProbe.pw}×${dprProbe.ph} ${dprProbe.cssW} ×${dprProbe.transform}）`);
    ok(b.easeEnds && b.easeMono, 'U16 easeOutCubic 端点正确且单调不减');
    ok(b.clipHalf && b.clipZero && b.clipFull, 'U16 clipSeriesByProgress：半程 15~17 点 / 零程 0 点 / 满程原样');
    ok(b.baselineInk, 'U16 drawBaseline 真实出墨（统一网格基线）');
    ok(b.seriesInk, 'U16 strokeSeries 真实出墨且 globalAlpha 复位');
    ok(b.ringInk, 'U16 drawRing 真实出墨（进度弧扫入）');
    ok(b.introFrames > 1 && b.introFinal, `U16 正常模式入场多帧推进至 1（frames=${b.introFrames}）`);
    ok(b.barAnim && b.barStagger, `U16 柱条升起动画 + 交错 delay 递增（d0→d5=${b.barStagger}）`);
    // U17
    ok(b.fuzzySub, 'U17 fuzzyMark 子串命中位置正确（未读→[0,1]）');
    ok(b.fuzzySeq, 'U17 fuzzyMark 子序列命中位置升序（kdg→知识库 knowledge）');
    ok(b.fuzzyMiss, 'U17 fuzzyMark 未命中/空查询返回 null');
    ok(b.paletteEl, 'U17 面板 has-preview 双列结构真挂载');
    ok(b.iconRows, 'U17 图标行：3/3 命令都有图标（无注册图标走回退）');
    ok(b.markHit, 'U17 命中字符 <mark> 真渲染且标记文本=查询词');
    ok(b.previewFiltered, 'U17 过滤后预览标题=首条命中命令');
    ok(b.previewMeta, 'U17 预览窗格影响范围/快捷键/说明真实渲染');
    ok(b.previewTracks && b.nodesSameRef, 'U17 ↑↓ 预览联动且列表节点零重建');
    ok(b.dismissed, 'U17 dismiss 后面板/预览整体离场');
    // U18
    ok(b.kbdConsumes, 'U18 focusArrowSiblings ↓ 真移焦 b0→b1');
    ok(b.kbdWraps, 'U18 ↑ 环绕 b0→b2');
    ok(b.kbdIgnoresOther, 'U18 非箭头键不消费');
    ok(b.focusTokens, 'U18 --focus-w/--focus-off-in 令牌实效取值');
    ok(b.settingsNav && b.settingsNavBack, 'U18 设置分区导航 ↓/↑ 真移焦');
    ok(b.evoTabbable && b.evoNav, 'U18 自进化模态导航 tabindex=0 + ↓ 移焦');
    // U19
    ok(b.bannerRole, 'U19 标题栏 role=banner 真挂载');
    ok(b.snapEl, 'U19 snap 提示层容器 + 四缘元素真渲染');
    ok(b.dragOn && b.dragOff, 'U19 标题栏 pointerdown/up 拖拽态真挂摘');
    ok(b.dragBlurOff, 'U19 窗口失焦兜底摘除拖拽态');
    // U20
    ok(b.sub12Count === 0 && b.ruleCount > 300, `U20 CSSOM 全表扫描 <12px font-size 字面量 = ${b.sub12Count}/${b.ruleCount} 条规则实读（要求 0）`);
    ok(b.fsTokens, 'U20 --fs-sm/--fs-lg 令牌实效取值');
    ok(b.cmdItemPad, 'U20 cmd-item 纵向 padding 实测 8px');
    ok(b.metaGap, 'U20 robin-header-meta 列间距实测 8px（分叉归一）');
    ok(b.tdCardSingle, `U20 td-card:hover 全表唯一且走 --lift-y（count=${b.tdHover}）`);

    if (failed) { console.error(failed + ' 项失败'); app.exit(1); }
    else { console.log('ALL PASSED'); app.exit(0); }
  } catch (e) {
    console.error('ERR', String(e && e.stack || e).slice(0, 1400));
    app.exit(1);
  }
});
