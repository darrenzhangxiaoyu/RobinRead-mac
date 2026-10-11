'use strict';
/**
 * diag-r63-scroll.js — R63 滚动细节三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 浮层内滚动条全量主题化：media/garden/weekly/挑战/订阅源网格五内滚容器
 *    入 5px 悬停主题色家族（默认隐藏、容器悬停浮现 accent 细条、scrollbar-width thin）
 *  2 列表顶/底 edge 淡出遮：sticky 双条零布局占位；滚出顶部/未到底浮现、在位即隐
 *    （真实 ListView 滚动驱动类切换 + 计算样式透明度实证；暗色经 --article-list-background 自动跟随）
 *  3 新文章到达滚动锚定：用户在顶部之外时重绘插顶不顶走阅读位置
 *    （scrollTop 回补 = 高度差 + 视口顶行逐字不换；在顶部时新文章自然到顶）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r63-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

/** 抓取包含某选择器片段的全部规则文本（拼接）。 */
function ruleOf(css, selectorFragment) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const hits = [];
  let m;
  while ((m = re.exec(css))) {
    if (m[1].includes(selectorFragment)) hits.push(m[2].trim().replace(/\s+/g, ' '));
  }
  return hits.join(' | ');
}

app.whenReady().then(async () => {
  try {
    const css = read('src/renderer/styles/robin.css');
    const robinStore = read('src/renderer/styles/store.css');
    const listSrc = read('src/renderer/views/list.js');

    // ── 1. 浮层内滚动条主题化 ──
    const containers = ['.nj-media-list', '.nj-garden-modal', '.nj-weekly-body', '.nj-challenge-list', '.fs-grid-host'];
    const thinRule = ruleOf(css, containers.slice(0, 4).join(', '));
    for (const c of containers) {
      const scope = c === '.fs-grid-host' ? robinStore + css : css;
      const joined = ruleOf(scope, c);
      ok(joined.includes('scrollbar-width: thin'), `1 ${c} scrollbar-width thin 在册`);
    }
    ok(/\.nj-media-list::-webkit-scrollbar, \.nj-garden-modal::-webkit-scrollbar, \.nj-weekly-body::-webkit-scrollbar,\n\.nj-challenge-list::-webkit-scrollbar, \.fs-grid-host::-webkit-scrollbar \{ width: 5px; \}/.test(css),
      '1 五容器 5px 细滚动条在册（与 modal-scroll 同语言）');
    ok(/\.nj-media-list:hover::-webkit-scrollbar-thumb[^{]*\{[^}]*color-mix\(in srgb, var\(--accent\) 24%, transparent\)/.test(css.replace(/\n/g, ' ')),
      '1 悬停浮现 accent 24% 主题色 thumb（全组同规则）');
    ok(/transition: background var\(--dur-mid\) var\(--ease-out\)/.test(ruleOf(css, '.nj-media-list::-webkit-scrollbar-thumb')),
      '1 thumb 过渡走 --dur-mid/--ease-out 令牌');

    // ── 2. edge 淡出遮（静态锚点）──
    ok(/\.list-edge-fade \{[^}]*position: sticky;/.test(css.replace(/\n/g, ' ')) && /\.list-edge-fade \{[^}]*pointer-events: none;/.test(css.replace(/\n/g, ' ')),
      '2 淡出遮 sticky + pointer-events none（零干涉零布局占位）');
    ok(/\.list-edge-fade-top \{[^}]*top: 46px;/.test(css.replace(/\n/g, ' ')) && /\.list-edge-fade-bottom \{[^}]*bottom: 0;/.test(css.replace(/\n/g, ' ')),
      '2 顶遮贴 inset 下缘（46px）/底遮贴视口底');
    ok(/margin-bottom: calc\(-1 \* var\(--space-6\)\)/.test(css) && /margin-top: calc\(-1 \* var\(--space-6\)\)/.test(css),
      '2 负 margin 抵消（零布局占位）');
    ok(css.split('color-mix(in srgb, var(--article-list-background) 94%, transparent)').length >= 3,
      '2 渐变自 --article-list-background 派生（暗色自动跟随）');
    ok(/\.list-scroll\.nj-can-scroll-up \.list-edge-fade-top \{ opacity: 1; \}/.test(css)
      && /\.list-scroll\.nj-can-scroll-down \.list-edge-fade-bottom \{ opacity: 1; \}/.test(css),
      '2 浮现/隐去类钩子在册');
    ok(listSrc.includes("el.classList.toggle('nj-can-scroll-up', el.scrollTop > 4)")
      && listSrc.includes("el.classList.toggle('nj-can-scroll-down', el.scrollTop + el.clientHeight < el.scrollHeight - 4)"),
      '2 滚动同步逻辑在册（顶部之外/未到底才浮现）');

    // ── 3. 滚动锚定（静态锚点）──
    ok(listSrc.includes('const anchorTop = this.scrollEl.scrollTop;') && listSrc.includes('const anchorHeight = this.scrollEl.scrollHeight;'),
      '3 重绘前基线捕获在册');
    ok(listSrc.includes('_restoreScrollAnchor(anchorTop, anchorHeight, anchorGen); // R63-③ 新文章到达：顶部之外保持阅读位置'),
      '3 常规路径锚定回补在册');
    ok(/_restoreScrollAnchor\(anchorTop, anchorHeight, anchorGen\); \/\/ R63-③：渐进渲染完成后高度才有代表性/.test(listSrc),
      '3 渐进路径完成后回补（高度有代表性后再回补）');
    ok(/if \(!prevTop || !prevHeight\) return;/.test(listSrc), '3 在顶部不介入（新文章自然到顶）');
    // 批2审查P1-1 收口：代际作废——外部滚动干预使在途延迟回补让位
    ok(listSrc.includes('const anchorGen = this._scrollGen || 0;') && /_restoreScrollAnchor\(prevTop, prevHeight, gen\) \{/.test(listSrc),
      '3 锚定基线带代际快照（capture/restore 同 gen 通道）');
    ok(listSrc.includes('this._scrollGen = (this._scrollGen || 0) + 1; // 批2审查P1-1'),
      '3 scrollTop() 外部干预推进代际（resetScroll 击穿在途回补的修复）');
    ok(/gen !== undefined && gen !== \(this\._scrollGen \|\| 0\)\) return;/.test(listSrc),
      '3 代际过期回补让位（切视野后视口不被拽回旧阅读位）');

    // ── UI 行为断言（真实 ListView + 真滚动）──
    const win = new BrowserWindow({
      show: false, width: 1440, height: 900,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1200);

    const exec = (js, label, ms = 45000) => Promise.race([
      win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
    ]);

    const flow = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const { ListView } = await import('./views/list.js');
        const host = document.createElement('div');
        host.className = 'list-scroll';
        host.style.height = '420px';
        document.body.appendChild(host);
        const lv = new ListView(host, { onSelect: () => {}, onContext: () => {}, onLoadMore: () => {}, onSearch: () => {} });
        window.__lv = lv;
        const TS = Math.floor(Date.now() / 1000) - 7200;
        // 标题走互斥字串（N<idx>X<base36>）——避免 clusterSimilar 把全列表聚成一簇（R63 需要真实行海）
        const mk = (id) => {
          const n = parseInt(String(id).replace(/[^0-9]/g, ''), 10) || 0;
          return { id, title: 'N' + n + 'X' + (n * 7919).toString(36) + 'hao', summaryPreview: '摘要', sourceTitle: '来源', publishedAt: TS, contentHead: '' };
        };
        const ids = (n, pfx) => Array.from({ length: n }, (_, i) => pfx + i);
        // 80 行（渐进渲染路径：>BATCH 60）
        lv.setViewMode('list');
        lv.render(ids(80, 'a').map(mk), { kind: 'all' }, null, true);
        await sleep(500); // 渐进渲染两帧批
        const scrollEl = host; // host 即 .list-scroll（构造器直接用传入元素）
        const strips = { top: !!scrollEl.querySelector('.list-edge-fade-top'), bottom: !!scrollEl.querySelector('.list-edge-fade-bottom') };
        // 初始（在顶部）：只应亮底遮
        const atTopCls = { up: scrollEl.classList.contains('nj-can-scroll-up'), down: scrollEl.classList.contains('nj-can-scroll-down') };
        const topOpacityAtTop = getComputedStyle(scrollEl.querySelector('.list-edge-fade-top')).opacity;
        const bottomOpacityAtTop = getComputedStyle(scrollEl.querySelector('.list-edge-fade-bottom')).opacity;
        // 滚到中部（留足 --dur-fast 过渡时长让透明度走完）
        scrollEl.scrollTop = 900;
        await sleep(350);
        const midCls = { up: scrollEl.classList.contains('nj-can-scroll-up'), down: scrollEl.classList.contains('nj-can-scroll-down') };
        const topOpacityMid = getComputedStyle(scrollEl.querySelector('.list-edge-fade-top')).opacity;
        // 锚定：记录当前视口顶行
        const rows = [...scrollEl.querySelectorAll('.entry-row')];
        const before = rows.find((r) => r.getBoundingClientRect().top >= scrollEl.getBoundingClientRect().top);
        const beforeRectTop = before?.getBoundingClientRect().top;
        const prevTop = scrollEl.scrollTop;
        // 新文章到达：顶部插 5 条（总高差 = 5 行高）
        const news = ids(5, 'new').map(mk);
        lv.render(news.concat(ids(80, 'a').map(mk)), { kind: 'all' }, null, true);
        await sleep(700); // 等渐进渲染完成
        const afterTop = scrollEl.scrollTop;
        const rows2 = [...scrollEl.querySelectorAll('.entry-row')];
        // 按重绘前视口顶行的标题文本找回同一行，比较视口位移
        const wanted = (before?.querySelector('.entry-title')?.textContent) || '';
        const same = rows2.find((r) => (r.querySelector('.entry-title')?.textContent) === wanted);
        const afterRectTop = same?.getBoundingClientRect().top;
        // 对照组：在顶部时新文章自然到顶（fresh 走不相干编号，避免与 a 行标题互聚）
        scrollEl.scrollTop = 0;
        await sleep(120);
        lv.render(['w900', 'w901', 'w902'].map(mk).concat(ids(80, 'a').map(mk)), { kind: 'all' }, null, true);
        await sleep(700);
        const freshFirstTitle = scrollEl.querySelector('.entry-row .entry-title')?.textContent || '';
        const topAfterFresh = scrollEl.scrollTop;
        // 批2审查P1-1 收口：渐进渲染 × scrollTop() 干预交叉——在途锚定回补必须作废（视口不被拽回旧位）
        scrollEl.scrollTop = 900;
        await sleep(200);
        lv.render(Array.from({ length: 80 }, (_, i) => mk('z' + (1000 + i))), { kind: 'all' }, null, true);
        lv.scrollTop(); // app 级 resetScroll 同帧干预（切视野路径）
        await sleep(700); // 渐进链完成
        const afterInterveneTop = scrollEl.scrollTop;
        return { strips, atTopCls, topOpacityAtTop, bottomOpacityAtTop, midCls, topOpacityMid,
          prevTop, afterTop, beforeRectTop, afterRectTop, wanted, freshFirstTitle, topAfterFresh,
          afterInterveneTop,
          rowH: (rows2[1]?.getBoundingClientRect().height) || 0 };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'r63-flow');
    if (flow.__err) ok(false, 'UI 流程探针异常 — ' + flow.__err);
    else {
      ok(flow.strips.top && flow.strips.bottom, '2 顶/底淡出遮条真实挂载');
      ok(flow.atTopCls.up === false && flow.atTopCls.down === true, '2 在顶部：顶遮隐、底遮现（类切换正确）');
      ok(flow.topOpacityAtTop === '0' && flow.bottomOpacityAtTop === '1', `2 在顶部计算透明度（top=${flow.topOpacityAtTop} bottom=${flow.bottomOpacityAtTop}）`);
      ok(flow.midCls.up === true && flow.midCls.down === true, '2 滚出顶部：双遮齐现');
      ok(flow.topOpacityMid === '1', `2 顶遮计算透明度浮现（${flow.topOpacityMid}）`);
      // 锚定：同一行视口位置几乎不变（±2px 容差）
        // 锚定合同 = 同一行视口位移 ≤2px（回补量可为负：行海上方内容收缩时同样保位）
        const drift = Math.abs((flow.afterRectTop || 0) - (flow.beforeRectTop || 0));
        ok(drift <= 2, `3 视口顶行逐字不换（同一行位移 ${drift.toFixed(1)}px ≤2；scrollTop ${flow.prevTop} → ${flow.afterTop} 随内容差回补）`);
      ok(String(flow.freshFirstTitle).includes('N900X'), `3 在顶部时新文章自然到顶（首行=${flow.freshFirstTitle}）`);
      ok(flow.topAfterFresh === 0, '3 顶部对照：scrollTop 保持 0');
      ok(flow.afterInterveneTop < 40, `3 交叉用例：渐进渲染 × scrollTop() 干预——在途回补作废、视口不被拽回旧位（top=${flow.afterInterveneTop}）`);
    }

    // 滚动条计算样式（真实容器）
    const sb = await exec(`(() => {
      const el = document.createElement('div');
      el.className = 'nj-media-list';
      el.style.overflowY = 'auto'; el.style.height = '60px';
      el.innerHTML = '<div style="height:200px"></div>';
      document.body.appendChild(el);
      const weekly = document.createElement('div');
      weekly.className = 'nj-weekly-body';
      document.body.appendChild(weekly);
      const out = { media: getComputedStyle(el).scrollbarWidth, weekly: getComputedStyle(weekly).scrollbarWidth };
      el.remove(); weekly.remove();
      return out;
    })()`, 'r63-scrollbar');
    ok(sb.media === 'thin' && sb.weekly === 'thin', `1 内滚容器 scrollbar-width 实测 thin（media=${sb.media} weekly=${sb.weekly}）`);

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
