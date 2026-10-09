'use strict';
/**
 * diag-u11-u15.js — U11–U15 视觉轮探针（run-all OFFLINE 集）
 *
 * U11 空态与加载体系：empty-art.js 线稿库在册且全场景合法；sidebar/list/media/topic/aihot/knowledge
 *                     空态接线 .empty-art；列表骨架屏 .nj-sk-row 真渲染且 reduced-motion 下动画收敛；
 *                     进度语言（.nj-breath/.nj-indet/加载更多呼吸点）在册
 * U12 微交互全家桶：--press-scale/--lift-y 令牌在册；按压规则命中；开关编舞（spring 位移+按压捏合+激活光环）；
 *                   悬停抬升归 --shadow-1（td-card/fs-card 硬编码阴影迁移）
 * U13 通知 Toast 体系：toast 栈容器/三态图标/进出动画类；可堆叠（上限 4）；hover 暂停（hold 类）；
 *                      进度通知 set→bar 宽度→done/fail 收口；旧签名 showToast 委托（app.js/dialogs.js 零残留实现）
 * U14 设置中心重构：settings-modal 全屏类；搜索框+锚点导航+分区名片 DOM；settingsSearch 纯函数
 *                   （分区命中/设置项命中/空查询）单测式断言；行过滤 .sr-hidden 行为
 * U15 期刊封面艺术：同日期+同主题色两次生成逐字节一致；日期/主题色变化输出变化；含期号文本；
 *                   无外部引用（url(/<image/href/外链 http 均无）；edition-reader 接线 .er-cover-art + 期号艺术字 CSS
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-u1115-')));
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
    const artSrc = read('src/renderer/views/empty-art.js');
    const appSrc = read('src/renderer/app.js');
    const dialogsSrc = read('src/renderer/views/dialogs.js');
    const editionSrc = read('src/renderer/views/edition-reader.js');
    const toastSrc = read('src/renderer/views/toast.js');
    const listSrc = read('src/renderer/views/list.js');
    const sidebarSrc = read('src/renderer/views/sidebar.js');
    const i18nSrc = read('src/main/I18NStrings.js');

    // U11：线稿库与接线
    ok(artSrc.includes('export function emptyArtSVG'), 'U11 emptyArtSVG 导出在册');
    for (const g of ['newspaper', 'star', 'clock', 'search', 'radioDot', 'personX', 'playCircle', 'spark', 'flame', 'wand', 'books', 'plug']) {
      ok(artSrc.includes(`${g}: frame(`), `U11 线稿场景 ${g} 在册`);
    }
    ok(sidebarSrc.includes("emptyArtSVG(glyph)") && sidebarSrc.includes('class="empty-art"'), 'U11 sidebar 空态接线 .empty-art');
    ok(listSrc.includes('emptyArtSVG') && listSrc.includes('artFor'), 'U11 list 空态接线 .empty-art');
    ok(listSrc.includes('showSkeleton') && listSrc.includes('nj-sk-row'), 'U11 列表骨架屏 showSkeleton/nj-sk-row 在册');
    ok(appSrc.includes('views.list.showSkeleton()'), 'U11 app.js reloadList/search 骨架接线在册');
    ok(read('src/renderer/views/media-view.js').includes('emptyArtSVG'), 'U11 media-view 空态接线');
    ok(read('src/renderer/views/topic-view.js').includes('emptyArtSVG'), 'U11 topic-view 空态接线');
    ok(read('src/renderer/views/aihot-view.js').includes('emptyArtSVG'), 'U11 aihot-view 空态接线');
    ok(read('src/renderer/views/knowledge.js').includes('emptyArtSVG'), 'U11 knowledge 空态接线');
    ok(/\.empty-art \{/.test(robin) && /\.ea-accent \{ color: var\(--accent\)/.test(robin), 'U11 .empty-art/.ea-accent 样式在册');
    ok(/\.nj-skeleton-list \{/.test(robin) && /\.nj-sk-row \{/.test(robin), 'U11 骨架屏样式在册');
    ok(/\.nj-breath \{/.test(robin) && /@keyframes nj-breathe/.test(robin), 'U11 呼吸点 .nj-breath 在册');
    ok(/\.nj-indet \{/.test(robin) && /@keyframes nj-indet-slide/.test(robin), 'U11 不确定进度条 .nj-indet 在册');
    ok(/\.list-loading-more::before \{/.test(robin), 'U11 加载更多呼吸点（::before）在册');
    // P2-1 同步断言：shimmer 光带位移已从 background-position 收口为 ::before translateX（合成器路径），
    // 统一 shimmer 层选择器随之变化；AIHOT 骨架仍与 .nj-sk 同层（"并入统一 shimmer"语义不变）。
    ok(/\.nj-sk::before, \.nj-sk-dot::before, \.aihot-skeleton-rank::before, \.aihot-skeleton-line::before \{[^}]*kb-shimmer/.test(robin), 'U11 AIHOT 骨架并入统一 shimmer（::before translateX 层）');

    // U12：令牌与规则
    ok(/--press-scale: 0\.96;/.test(robin) && /--lift-y: -2px;/.test(robin), 'U12 --press-scale/--lift-y 令牌归档在册');
    ok(/\.btn:active:not\(:disabled\)[^{]*\{[^}]*transform: scale\(var\(--press-scale\)\)/.test(robin), 'U12 按压反馈规则（--press-scale）在册');
    ok(/\.toggle:active::after \{ transform: scale\(0\.86\); \}/.test(robin) && /\.toggle\.on:active::after \{ transform: translateX\(16px\) scale\(0\.86\); \}/.test(robin), 'U12 开关按压捏合编舞在册');
    ok(/\.toggle::after \{\r?\n  transition: transform var\(--dur-fast\) var\(--ease-spring\);/.test(robin), 'U12 开关旋钮弹簧位移（--ease-spring）在册');
    ok(/\.toggle\.on \{ box-shadow: 0 0 0 3px color-mix\(in srgb, var\(--accent\) 14%, transparent\); \}/.test(robin), 'U12 开关激活光环（accent 派生）在册');
    ok(/\.td-card:hover \{[^}]*transform: translateY\(var\(--lift-y\)\);[^}]*box-shadow: var\(--shadow-1\);/.test(robin), 'U12 td-card 悬停抬升归 --lift-y/--shadow-1');
    ok(/\.prov-card:hover \{ transform: translateY\(var\(--lift-y\)\); box-shadow: var\(--shadow-1\); \}/.test(robin), 'U12 prov-card 悬停抬升归令牌');
    ok(/\.fs-card:hover \{ transform: translateY\(var\(--lift-y\)\); box-shadow: var\(--shadow-1\)[^}]*\}/.test(storeCss), 'U12 store fs-card 抬升归令牌（store.css）');
    ok(/\.context-menu-item:active/.test(robin) && /\.modal-nav-item:active/.test(robin), 'U12 菜单/导航按压覆盖在册');

    // U13：toast 栈模块与兼容委托
    ok(/export function showToast/.test(toastSrc) && /export function showProgress/.test(toastSrc), 'U13 toast.js showToast/showProgress 导出在册');
    ok(/const CAP = 4;/.test(toastSrc), 'U13 栈容量上限 4 在册');
    ok(/mouseenter/.test(toastSrc) && /mouseleave/.test(toastSrc) && /classList\.add\('hold'\)/.test(toastSrc), 'U13 hover 暂停（hold 挂载/摘除）在册');
    ok(/done\(message\)|fail\(message\)/.test(toastSrc) && /TONE_ICON\.success/.test(toastSrc), 'U13 进度通知 done/fail 三态收口在册');
    ok(/import \{ Toast \} from '\.\/views\/toast\.js'/.test(appSrc) && /return Toast\.show\(message, \{ duration, action \}\);/.test(appSrc), 'U13 app.js showToast 委托 toast 栈（具名导入 Toast 对象）');
    ok(!/document\.getElementById\('toast-capsule'\)/.test(appSrc), 'U13 app.js 旧单例 id 残留清零');
    ok(dialogsSrc.includes('Toast.show(message, { duration })'), 'U13 dialogs.js showToast 委托 toast 栈');
    ok(/Toast\.progress\(t\('正在导出 Obsidian 库…'\)/.test(dialogsSrc) && /Toast\.progress\(t\('正在清理历史文章…'\)/.test(dialogsSrc), 'U13 长任务进度通知接线（导出/清理）');
    ok(/#nj-toast-stack \{/.test(robin) && /toast-capsule\.success \.toast-ic/.test(robin) && /toast-capsule\.warn/.test(robin) && /toast-capsule\.error/.test(robin), 'U13 栈容器/三态样式在册');
    ok(/@keyframes toast-in \{ from \{ opacity: 0; transform: translateY\(12px\)/.test(robin), 'U13 进场动画（translateY+scale 合成层）在册');
    for (const k of ['正在导出 Obsidian 库…', '增量比对中…', '写入完成', '正在全量重导…', '忽略增量游标，重写全部文件', '正在清理历史文章…', '按保留期限淘汰超期已读', '清理失败，请重试']) {
      ok(i18nSrc.includes(`"${k}"`), `U13 i18n 在册「${k}」`);
    }

    // U14：设置重构源码
    ok(/modal\.classList\.add\('settings-modal'\)/.test(dialogsSrc), 'U14 设置全屏类挂载在册');
    ok(/\.modal\.settings-modal \{[^}]*width: 100vw; height: 100vh;/.test(robin), 'U14 settings-modal 全屏化样式在册');
    ok(/settings-search/.test(dialogsSrc) && /搜索设置…/.test(dialogsSrc), 'U14 顶部搜索框（占位「搜索设置…」）在册');
    ok(/export function settingsSearch/.test(dialogsSrc), 'U14 settingsSearch 纯函数导出在册');
    ok(/SECTION_SEARCH_INDEX/.test(dialogsSrc) && /SECTION_INTRO/.test(dialogsSrc), 'U14 搜索索引/分区简介表在册');
    ok(/settings-section-card/.test(dialogsSrc) && /\.settings-section-card \{/.test(robin), 'U14 分区锚点名片（DOM+CSS）在册');
    ok(/_filterRows/.test(dialogsSrc) && /\.setting-row\.sr-hidden \{ display: none; \}/.test(robin), 'U14 设置行搜索过滤（.sr-hidden）在册');
    ok(/settings-nav-empty/.test(dialogsSrc), 'U14 搜索无匹配出路在册');
    for (const k of ['搜索设置…', '无匹配设置', '主题、字号与阅读排版，纸感由你定义。', '版本、更新与开源致谢。']) {
      ok(i18nSrc.includes(`"${k}"`), `U14 i18n 在册「${k.slice(0, 12)}…」`);
    }

    // U15：封面艺术源码接线
    ok(editionSrc.includes("import { editionCoverArt } from './edition-cover-art.js'"), 'U15 edition-reader 接线封面艺术模块');
    ok(editionSrc.includes('er-cover-art') && editionSrc.includes('issueText: this._coverVol()'), 'U15 封面版画层挂载 + 期号文本传入');
    ok(/\.er-cover-face > \.er-cover-art \{[^}]*position: absolute; inset:/.test(robin), 'U15 版画层铺纸样式在册');
    ok(/\.er-cover-face \.er-cover-volbig \.er-vol-num \{[^}]*clamp\(/.test(robin), 'U15 期号艺术字（特大衬线 clamp）在册');
    ok(/\.er-cover-volbig::after \{/.test(robin), 'U15 期号版画压线在册');

    // ── Phase B：真实渲染窗口断言 ─────────────────────────────────────────
    const win = new BrowserWindow({
      show: false, width: 1280, height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(900);

    const modURL = (f) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'views', f)).href;
    // reduced-motion 实效：经 CDP Emulation.setEmulatedMedia 仿真媒体特性（版本稳）
    const dbg = win.webContents.debugger;
    await dbg.attach();
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const rm = await win.webContents.executeJavaScript(`(async () => {
      const el = document.createElement('div');
      el.className = 'nj-sk nj-sk-line w70';
      document.body.appendChild(el);
      // P2-1 同步：shimmer 动画移至 ::before 位移层，reduced-motion 收敛效果同样读伪元素
      const skPseudo = getComputedStyle(el, '::before');
      const dur = skPseudo.animationDuration;
      const iter = skPseudo.animationIterationCount;
      el.remove();
      const tr = document.createElement('button');
      tr.className = 'btn';
      document.body.appendChild(tr);
      const tdur = getComputedStyle(tr).transitionDuration;
      tr.remove();
      return { dur, iter, tdur };
    })()`);
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    await dbg.detach();

    const b = await win.webContents.executeJavaScript(`(async () => {
      const out = {};
      const artURL = ${JSON.stringify(modURL('empty-art.js'))};
      const toastURL = ${JSON.stringify(modURL('toast.js'))};
      const dialogsURL = ${JSON.stringify(modURL('dialogs.js'))};
      const coverArtURL = ${JSON.stringify(modURL('edition-cover-art.js'))};

      // ── U11：线稿库真实输出 + 空态渲染 ──
      const { emptyArtSVG } = await import(artURL);
      out.artKinds = ['newspaper','star','clock','search','radioDot','personX','playCircle','spark','flame','wand','books','plug']
        .filter((g) => emptyArtSVG(g).startsWith('<svg')).length;
      out.artUnknown = emptyArtSVG('nope') === '';
      out.artNoExternal = emptyArtSVG('newspaper').indexOf('http') < 0;
      // 真实渲染侧栏空态（构造器只建 DOM，不触 IPC）
      const { SidebarView } = await import(${JSON.stringify(modURL('sidebar.js'))});
      const scrollEl = document.createElement('div');
      const footerEl = document.createElement('div');
      const sb = new SidebarView(scrollEl, footerEl, {});
      const empty = sb.emptyState('还没有订阅', '添加一个 RSS 地址。', 'radioDot', '添加订阅', () => {});
      out.sidebarEmptyArt = !!empty.querySelector('.empty-art svg.ea-scene');
      out.sidebarEmptyAccent = !!empty.querySelector('.empty-art .ea-accent');
      // 骨架屏真渲染
      const host = document.createElement('div');
      document.body.appendChild(host);
      const listHost = document.createElement('div');
      host.appendChild(listHost);
      const { ListView } = await import(${JSON.stringify(modURL('list.js'))});
      const lv = Object.create(ListView.prototype);
      lv.rowsHost = listHost;
      lv.showSkeleton();
      out.skRows = listHost.querySelectorAll('.nj-sk-row').length;
      out.skShimmer = !!listHost.querySelector('.nj-sk-row .nj-sk');
      // 骨架被下一次 render 覆盖（零手动摘除合同）
      listHost.innerHTML = '<div class="list-empty"><div class="empty-art">x</div></div>';
      out.skCovered = listHost.querySelector('.nj-sk-row') === null;

      // ── U13：toast 栈真实行为 ──
      const { Toast } = await import(toastURL);
      Toast.show('第一条');
      Toast.show('警告', { tone: 'warn' });
      const errEl = Toast.show('错误', { tone: 'error', duration: 10 });
      out.stack = !!document.getElementById('nj-toast-stack');
      out.live3 = Toast.liveCount() === 3;
      out.tones = ['success', 'warn', 'error'].every((tn) => !!document.querySelector('.toast-capsule.' + tn + ' .toast-ic svg'));
      await new Promise((r) => setTimeout(r, 340)); // 10ms 定时 + 250ms 离场动画预算
      out.errorLeft = !document.body.contains(errEl);
      // 堆叠上限：连打 7 条最多留 4
      for (let i = 0; i < 7; i += 1) Toast.show('m' + i, { duration: 4000 });
      out.cap4 = Toast.liveCount() === 4;
      // hover 暂停：进入悬停挂 hold、离开摘除并续期
      const hEl = Toast.show('悬停我', { duration: 900 });
      hEl.dispatchEvent(new Event('mouseenter'));
      out.holdOn = hEl.classList.contains('hold');
      hEl.dispatchEvent(new Event('mouseleave'));
      out.holdOff = !hEl.classList.contains('hold');
      // 进度通知：set → 条宽；done → 成功态收口；fail → 错误态
      const p = Toast.progress('导出中', { note: '0%' });
      out.progressDom = !!p && !!document.querySelector('.toast-capsule.progress .toast-bar > i');
      p.set(40, '40%');
      const bar = document.querySelector('.toast-capsule.progress .toast-bar > i');
      out.barWidth = bar && bar.style.width === '40%';
      p.done('完成');
      out.doneMorph = !!document.querySelector('.toast-capsule.success .toast-title');
      out.progressGone = !document.querySelector('.toast-capsule.progress');
      const pf = Toast.progress('会失败');
      pf.fail('失败');
      out.failMorph = !!document.querySelector('.toast-capsule.error .toast-title');
      Toast.dismissTop();
      out.dismissTopWorks = Toast.liveCount() < 4;
      // 清场
      document.querySelectorAll('.toast-capsule').forEach((e) => e.remove());

      // ── U14：设置视图真渲染 + 搜索单测 ──
      const dlg = await import(dialogsURL);
      const q1 = dlg.settingsSearch('');
      out.searchEmpty = Array.isArray(q1) && q1.length === 0;
      const q2 = dlg.settingsSearch('外观');
      out.searchSection = q2.some((h) => h.id === 'appearance');
      const q3 = dlg.settingsSearch('字体');
      out.searchItem = q3.length > 0 && q3.some((h) => h.hits.length > 0);
      const q4 = dlg.settingsSearch('云存储不存在词');
      out.searchMiss = q4.length === 0;
      const sv = new dlg.SettingsView({ state: { snapshot: { preferences: {}, llm: {} } }, views: {}, onAddFreshRSS: null, onReload: null, onRefreshState: null });
      sv.present('appearance');
      out.fullscreen = sv.modal.classList.contains('settings-modal');
      out.searchBox = !!sv.modal.querySelector('.settings-search input');
      out.navCount = sv.modal.querySelectorAll('.modal-nav-item').length;
      out.introCard = !!sv.modal.querySelector('.settings-section-card');
      const rowsBefore = sv.modal.querySelectorAll('.setting-row:not(.sr-hidden)').length;
      sv._applySearch('字体');
      const navHiddenAfter = [...sv.modal.querySelectorAll('.modal-nav-item')].filter((n) => n.classList.contains('hidden')).length;
      const hitShown = [...sv.modal.querySelectorAll('.nav-hit')].length > 0;
      const rowsAfter = sv.modal.querySelectorAll('.setting-row:not(.sr-hidden)').length;
      out.filterNav = navHiddenAfter > 0 && navHiddenAfter < sv.modal.querySelectorAll('.modal-nav-item').length;
      out.filterHit = hitShown;
      out.filterRows = rowsBefore > 0 && rowsAfter > 0 && rowsAfter < rowsBefore;
      sv._applySearch('');
      out.filterRestore = sv.modal.querySelectorAll('.setting-row:not(.sr-hidden)').length === rowsBefore;
      sv.dismiss();

      // ── U15：确定性版画逐字节一致 ──
      const art = await import(coverArtURL);
      const args = { year: 2026, month: 10, day: 8, accent: '#617357', paper: '#f6f2e7', ink: '#2b2721', issueText: '总第 41 期' };
      const s1 = art.editionCoverArt(args);
      const s2 = art.editionCoverArt({ ...args });
      out.artDeterministic = s1 === s2 && s1.length > 500;
      out.artLen = s1.length;
      out.artIssueText = s1.includes('总第 41 期');
      out.artNoExternal = !/(<image|url\\(|href=|https?:\\/\\/(?!www\\.w3\\.org))/.test(s1);
      out.artDayVaries = s1 !== art.editionCoverArt({ ...args, day: 9 });
      out.artAccentVaries = s1 !== art.editionCoverArt({ ...args, accent: '#D2691E' });
      out.artGeo = (s1.match(/<path/g) || []).length >= 5 && (s1.match(/<circle/g) || []).length >= 30;
      const csRoot = getComputedStyle(document.documentElement);
      out.accentToken = (csRoot.getPropertyValue('--accent') || '').trim().length > 0;
      host.remove();
      return out;
    })()`);

    // ── Phase B 断言 ──
    // U11
    ok(rm.dur && parseFloat(rm.dur) < 0.05 && String(rm.iter) === '1',
      `U11 reduced-motion 下骨架动画收敛（duration=${rm.dur} iteration=${rm.iter}）`);
    ok(b.artKinds === 12, `U11 线稿库 12 场景全部产出合法 SVG（实际 ${b.artKinds}）`);
    ok(b.artUnknown, 'U11 未知 glyph 返回空串（调用方回退图标）');
    ok(b.artNoExternal, 'U11 线稿零外部引用');
    ok(b.sidebarEmptyArt && b.sidebarEmptyAccent, 'U11 侧栏空态真实渲染插画（含 accent 高亮元素）');
    ok(b.skRows === 8, `U11 列表骨架屏真渲染 8 行（实际 ${b.skRows}）`);
    ok(b.skShimmer && b.skCovered, 'U11 骨架行 shimmer 在册且被下一次 render 覆盖');
    // U13
    ok(b.stack, 'U13 toast 栈容器 #nj-toast-stack 真实挂载');
    ok(b.live3 && b.tones, 'U13 三态图标（success/warn/error）真实渲染');
    ok(b.errorLeft, 'U13 短时长 toast 自动离场');
    ok(b.cap4, 'U13 可堆叠且上限 4（连打 7 条留 4）');
    ok(b.holdOn && b.holdOff, 'U13 hover 暂停：mouseenter 挂 hold / mouseleave 摘除续期');
    ok(b.progressDom && b.barWidth, 'U13 进度通知 DOM 与 set(40) 精确落条');
    ok(b.doneMorph && b.progressGone, 'U13 done() 收口成功态并移除进度态');
    ok(b.failMorph, 'U13 fail() 收口错误态');
    ok(b.dismissTopWorks, 'U13 dismissTop 兼容旧 dismissToast 语义');
    // U14
    ok(b.searchEmpty && b.searchMiss, 'U14 settingsSearch：空查询/未命中返回 []');
    ok(b.searchSection, 'U14 settingsSearch：分区标题命中（外观）');
    ok(b.searchItem, 'U14 settingsSearch：设置项标题命中且带 hits');
    ok(b.fullscreen, 'U14 设置全屏化（settings-modal 类真挂载）');
    ok(b.searchBox, 'U14 顶部搜索框真渲染');
    ok(b.navCount === 15, `U14 锚点导航 15 分区真渲染（实际 ${b.navCount}）`);
    ok(b.introCard, 'U14 分区锚点名片真渲染');
    ok(b.filterNav && b.filterHit, 'U14 搜索过滤：导航只留命中分区并展示命中设置项');
    ok(b.filterRows && b.filterRestore, 'U14 搜索过滤：当前分区行就地隐藏/清空恢复');
    // U15
    ok(b.artDeterministic, `U15 同日期+同主题色两次生成逐字节一致（len=${b.artLen}）`);
    ok(b.artIssueText, 'U15 版画含期号文本（总第 N 期）');
    ok(b.artNoExternal, 'U15 版画无外部引用（url(/<image/href/外链)）');
    ok(b.artDayVaries && b.artAccentVaries, 'U15 日期/主题色变化 → 版画随之变化');
    ok(b.artGeo, 'U15 版画几何构成（山峦路径≥5 + 星点圆≥30）');
    ok(b.accentToken, 'U15 --accent 主题色令牌在场（派生源）');

    if (failed) { console.error(failed + ' 项失败'); app.exit(1); }
    else { console.log('ALL PASSED'); app.exit(0); }
  } catch (e) {
    console.error('ERR', String(e && e.stack || e).slice(0, 1400));
    app.exit(1);
  }
});
