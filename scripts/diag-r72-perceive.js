'use strict';
/**
 * diag-r72-perceive.js — R72 性能感知三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 冷启动侧栏/列表骨架先行：index.html 直出静态骨架（U11 骨架行同几何 → 真实首帧零跳变，
 *    绝对定位覆盖层不参与 DOM 流、sticky 头在上层），bootstrap 首渲（成败皆然）摘除；
 *    静态行与动态 skeletonRow 计算样式同几何实证
 *  2 长文分叶渐进渲染平滑：本叶新行即时入渐显观察（复用同一 observer 不掐断既有观察）、
 *    edge 淡出遮随叶同步；reveal-pending 高度预留合同（只动 opacity/transform，边界零高度跳动）
 *  3 视图互切滚动保持（与 R69-③ 合并验收）：切换保位 + 代际守卫让位复验
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r72-')));
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
    const html = read('src/renderer/index.html');
    const appSrc = read('src/renderer/app.js');
    const listSrc = read('src/renderer/views/list.js');

    // ── 1. 冷启动骨架先行 ──
    ok(html.includes('<div class="nj-boot-skeleton" id="nj-boot-skeleton" aria-hidden="true">')
      && html.includes('<div class="nj-boot-skeleton" id="nj-boot-skeleton-sidebar" aria-hidden="true">'),
      '1 index.html 双骨架直出（列表 + 侧栏，aria-hidden）');
    ok((html.match(/class="nj-sk-row"/g) || []).length === 11,
      '1 静态骨架 11 行与 U11 骨架行同族（列表 6 + 侧栏 5）');
    ok(/\.nj-boot-skeleton \{ position: absolute; inset: 0; pointer-events: none; overflow: hidden; \}/.test(css)
      && /#nj-boot-skeleton \{ inset: 46px 0 0; \}/.test(css)
      && /#nj-boot-skeleton-sidebar \{ inset: 34px 0 0; \}/.test(css),
      '1 绝对定位覆盖层（让出 sticky 头/侧栏上 padding，DOM 顺序无关）');
    ok(/function dismissBootSkeleton\(\) \{/.test(appSrc)
      && appSrc.includes('await reloadAll();\n  dismissBootSkeleton();')
      && appSrc.includes("bootstrap().catch((err) => { dismissBootSkeleton(); console.error('bootstrap failed', err); });"),
      '1 首渲成功即摘 + bootstrap 失败同样摘（不挂死白板）');

    // ── 2. 分叶渐进渲染平滑 ──
    ok(/_observeReveal\(scope\) \{/.test(listSrc) && /this\._observeReveal\(fresh\);/.test(listSrc)
      && /this\._syncEdgeFades\(\);\n        if \(idx < clusters\.length\) requestAnimationFrame\(appendNext\);/.test(listSrc),
      '2 本叶新行即时入观察 + edge 淡出遮随叶同步');
    ok(/if \(scope\) \{/.test(listSrc) && /if \(!this\._revealObserver\) \{/.test(listSrc),
      '2 scope 模式复用同一 observer（不掐断既有观察）');
    // reveal 高度预留合同：pending 只动 opacity/transform（行保持全高 → 叶边界零高度跳动）
    const pendingRule = /@media \(prefers-reduced-motion: no-preference\) \{\n  \.nj-reveal-pending \{ opacity: 0; transform: translateY\(8px\); \}/.test(css);
    ok(pendingRule, '2 reveal-pending 在 no-preference 档内只动 opacity/transform（高度预留）');
    ok(!/\.nj-reveal-pending \{[^}]*(height|max-height|display|margin|padding)/.test(css.replace(/\n/g, ' ')),
      '2 reveal-pending 无布局属性（零布局位移家族合同）');

    // ── UI 行为断言 ──
    const win = new BrowserWindow({
      show: false, width: 1440, height: 900,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(900);

    const exec = (js, label, ms = 60000) => Promise.race([
      win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
    ]);

    // 1：静态骨架几何实证 + 真实 bootstrap 端到端摘除断言
    // （探针窗的 preload 缺省仓可让 getState 成功 → 真 app bootstrap 会跑完 reloadAll →
    //   dismissBootSkeleton 已执行——正好看得见端到端摘除生效；几何用同款 markup 重建实证）
    const boot = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        await sleep(250); // 等 bootstrap 链走完
        const dismissed = !document.getElementById('nj-boot-skeleton') && !document.getElementById('nj-boot-skeleton-sidebar');
        // 静态骨架行与 U11 动态骨架行同几何（同款 markup 重建 → 计算样式对照）
        const STATIC_ROW = '<div class="nj-sk-row"><span class="nj-sk nj-sk-dot"></span><span class="nj-sk-lines"><i class="nj-sk nj-sk-line w70"></i><i class="nj-sk nj-sk-line w100"></i><i class="nj-sk nj-sk-line w45"></i></span></div>';
        const tmp = document.createElement('div');
        tmp.innerHTML = STATIC_ROW;
        document.body.appendChild(tmp);
        const row = tmp.querySelector('.nj-sk-row');
        const cs = getComputedStyle(row);
        const line = row.querySelector('.nj-sk-line');
        const csLine = getComputedStyle(line);
        const skAnim = getComputedStyle(row.querySelector('.nj-sk'), '::before').animationName; // shimmer 在 ::before 位移层
        return {
          dismissed,
          pos: cs.position, pad: cs.padding, display: cs.display, gap: cs.gap,
          lineH: csLine.height, radius: csLine.borderRadius, anim: skAnim,
        };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'r72-boot');
    if (boot.__err) ok(false, '1 首帧骨架探针异常 — ' + boot.__err);
    else {
      ok(boot.dismissed, '1 真实 bootstrap 后骨架已摘除（端到端 dismissBootSkeleton 生效）');
      ok(boot.pad === '12px 16px' && boot.display === 'flex' && boot.gap === '12px',
        `1 骨架行同族几何（padding=${boot.pad} display=${boot.display} gap=${boot.gap} = --space-3/--space-4/--space-3）`);
      ok(boot.lineH === '11px' && boot.radius === '6px', `1 骨架线条形状归档（height=${boot.lineH} radius=${boot.radius} = R60 口径）`);
      ok(boot.anim && boot.anim !== 'none', `1 shimmer 动效在场（${boot.anim}，reduced-motion 全局块兜底）`);
    }

    // 2：渐进渲染叶边界（渐显 pending + edge 遮提前浮现）+ 3：互切保位合并验收
    // IntersectionObserver 计算绑定渲染帧——隐藏窗不产帧时 IO 不派发（R68 showInactive 产帧同款先例）
    win.showInactive();
    await sleep(400);
    const flow = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const { ListView } = await import('./views/list.js');
        const host = document.createElement('div');
        host.className = 'list-scroll';
        // fixed 定位进视口：host 若按流式追加在真实 app body 末尾，会落在 900px 视口下方页外，
        // IntersectionObserver 永不相交（渐显永不派发）——探针观测面必须真实在视口内
        host.style.cssText = 'position:fixed;top:0;left:0;width:420px;height:420px;';
        document.body.appendChild(host);
        const lv = new ListView(host, { onSelect: () => {}, onContext: () => {}, onLoadMore: () => {}, onSearch: () => {} });
        window.__lv72 = lv;
        const TS = Math.floor(Date.now() / 1000) - 3600;
        const mk = (id) => {
          const n = parseInt(String(id).replace(/[^0-9]/g, ''), 10) || 0;
          return { id, title: 'N' + n + 'X' + (n * 7919).toString(36) + 'hao', summaryPreview: '摘要', sourceTitle: '来源', publishedAt: TS, contentHead: '' };
        };
        const ids = (n, pfx) => Array.from({ length: n }, (_, i) => pfx + i);
        // 400 行 = 7 叶：叶 1 落地后、全部完成前，edge 遮类应已提前浮现（随叶同步）
        let edgeEarly = null;
        let pendingSeen = false;
        const total = 400;
        lv.render(ids(total, 'b').map(mk), { kind: 'all' }, null, true);
        // 隐藏窗 rAF ≈250-600ms/叶（r63 实测口径）：预算 400×20ms 足够 7 叶走完
        for (let i = 0; i < 400; i += 1) {
          await sleep(20);
          const done = host.querySelectorAll('.entry-row').length;
          if (done > 0 && done < total) {
            if (edgeEarly === null) edgeEarly = host.classList.contains('nj-can-scroll-down');
            if (host.querySelector('.entry-row.nj-reveal-pending')) pendingSeen = true;
          }
          if (done >= total) break;
        }
        // 首屏行落定轮询：IO 回调在隐藏窗被节流，落定可能滞后——轮询至视口内零 pending（上限 8s）。
        // 判定收敛在「充分可见」（top 距容器底 30px 以上）——贴界被裁剪行本就低于 IO 4% 阈值、
        // 不 reveal 是正确行为，不计入。
        let visiblePending = -1;
        for (let i = 0; i < 160; i += 1) {
          await sleep(50);
          const hostBottom = host.getBoundingClientRect().bottom;
          visiblePending = [...host.querySelectorAll('.entry-row.nj-reveal-pending')]
            .filter((el) => el.getBoundingClientRect().top < hostBottom - 30).length;
          if (visiblePending === 0) break;
        }
        await sleep(200);
        const rowsNow = host.querySelectorAll('.entry-row').length;
        const edgeFinal = host.classList.contains('nj-can-scroll-down');
        // 诊断（截断）：卡住的 pending 行真身
        const hostRect = host.getBoundingClientRect();
        const stuck = [...host.querySelectorAll('.entry-row.nj-reveal-pending')].slice(0, 5).map((el) => {
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top - hostRect.top), h: Math.round(r.height) };
        });
        const pendingTotal = host.querySelectorAll('.entry-row.nj-reveal-pending').length;
        // 3：互切保位（R69-③ 合并验收复验）
        host.scrollTop = 900;
        await sleep(150);
        lv.setViewMode('magazine');
        lv.render(ids(total, 'b').map(mk), { kind: 'all' }, null, true);
        await sleep(700);
        const magTop = host.scrollTop;
        const magMax = host.scrollHeight - host.clientHeight;
        return { edgeEarly, pendingSeen, rowsNow, visiblePending, edgeFinal, magTop, magMax, stuck, pendingTotal, hostH: Math.round(hostRect.height) };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'r72-flow');
    if (flow.__err) ok(false, '2/3 流程探针异常 — ' + flow.__err);
    else {
      ok(flow.edgeEarly === true, `2 叶边界 edge 淡出遮提前浮现（首叶后即同步，非完成才亮：${flow.edgeEarly}）`);
      ok(flow.pendingSeen === true, '2 本叶新行即时获得渐显 pending（边界淡入而非瞬现）');
      ok(flow.rowsNow === 400, `2 渐进渲染完整落地（${flow.rowsNow} 行）`);
      ok(flow.visiblePending === 0, `2 首屏行全部落定（视口内残留 pending ${flow.visiblePending}；卡住行=${JSON.stringify(flow.stuck)} 全部pending=${flow.pendingTotal} hostH=${flow.hostH}）`);
      ok(flow.edgeFinal === true, '2 完成态 edge 遮保持正确');
      ok(Math.abs(flow.magTop - Math.min(900, flow.magMax)) <= 1, `3 合并验收：列表→杂志保位（${flow.magTop}，上限 ${flow.magMax}）`);
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
