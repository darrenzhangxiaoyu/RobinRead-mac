'use strict';
/**
 * diag-r58-truncate.js — R58 截断与光学三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 line-clamp 口径表：列表行标题 2（无摘要 4）/列表摘要 2/杂志卡标题 3/aihot 摘要 3/
 *    批注行 3、2/话题命中 2/胶囊引文 2/订阅卡描述 2——全库冻结口径逐一断言；
 *    周刊条目标题 1 行（nowrap+ellipsis）
 *  2 截断必有出路：行标题/杂志卡标题/杂志卡来源/聚簇行标题/话题命中/收藏集名/周刊条目
 *    七处截断位 title 悬停全文（真实 ListView 渲染 + 源码锚点）
 *  3 meta 行光学：entry-meta 间距归 --space-1（裸 6px 退役）；字符串点分隔 meta
 *    （话题/文字稿/书架）统一 ' · ' 全角口径
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r58-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

/** 抓取某选择器规则里的 -webkit-line-clamp 值（CSSOM 前置：源码静态口径表）。 */
function clampOf(css, selectorFragment) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[1].includes(selectorFragment) && m[2].includes('-webkit-line-clamp')) {
      return m[2].match(/-webkit-line-clamp:\s*(\d+)/)[1];
    }
  }
  return null;
}

app.whenReady().then(async () => {
  try {
    const css = read('src/renderer/styles/robin.css');
    const storeCss = read('src/renderer/styles/store.css');
    // ── 1. line-clamp 口径表（冻结值逐一断言）──
    const table = [
      ['.entry-title {', '.entry-title', '2', '列表行标题（有摘要）'],
      ['.entry-row:not(.has-summary) .entry-title', '.entry-row:not(.has-summary) .entry-title', '4', '列表行标题（无摘要）'],
      ['.entry-summary', '.entry-summary', '2', '列表行摘要'],
      ['.nj-mag-card .mag-title', '.nj-mag-card .mag-title', '3', '杂志卡标题'],
      ['.aihot-summary', '.aihot-summary', '3', 'AI 热点摘要'],
      ['.annot-row-text', '.annot-row-text', '3', '批注行原文'],
      ['.annot-row-note', '.annot-row-note', '2', '批注行笔记'],
      ['.nj-topic-hit-title', '.nj-topic-hit-title', '2', '话题命中标题'],
      ['.nj-capsule-card-quote', '.nj-capsule-card-quote', '2', '胶囊卡引文'],
      ['.dg-capsule-quote', '.dg-capsule-quote', '2', '简报胶囊引文'],
      ['.fs-card-desc', '.fs-card-desc', '2', '订阅卡描述'],
    ];
    let hit = 0;
    for (const [, frag, expect, label] of table) {
      const v = clampOf(css, frag) || clampOf(storeCss, frag);
      if (v === expect) hit += 1;
      else console.error(`  口径漂移: ${label} 期望 ${expect} 行，实际 ${v}`);
    }
    ok(hit === table.length, `1 line-clamp 口径表冻结（${hit}/${table.length} 处符合既定行数）`);
    ok(/\.nj-weekly-entry-title \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/.test(css),
      '1 周刊条目标题 1 行口径（nowrap + ellipsis）');

    // ── 2. 截断必有出路（静态锚点）──
    const listSrc = read('src/renderer/views/list.js');
    ok(listSrc.includes("row.querySelector('.entry-title').title = cleanTitle;"), '2 列表行标题悬停全文');
    ok(listSrc.includes("body.querySelector('.mag-title').title = "), '2 杂志卡标题悬停全文');
    ok(listSrc.includes("body.querySelector('.mag-feed').title = "), '2 杂志卡来源悬停全文');
    ok(listSrc.includes('clusterTitleEl.title = '), '2 聚簇行标题悬停全文');
    ok(read('src/renderer/views/topic-view.js').includes('title.title = hit.title || hit.url;'), '2 话题命中标题悬停全文');
    ok(read('src/renderer/views/knowledge.js').includes("card.querySelector('.kb-col-name').title = col.name;"), '2 收藏集名悬停全文');
    ok(/row\.title = entryTitle; \/\/ R58/.test(read('src/renderer/views/weekly-view.js')), '2 周刊条目悬停全文（取代泛提示）');

    // ── 3. meta 行光学（静态锚点）──
    ok(/\.entry-meta \{\n  display: flex; align-items: center; gap: var\(--space-1\);/.test(css),
      '3 entry-meta 间距归 --space-1（裸 6px 退役）');
    ok(!/\.entry-meta \{[^}]*gap: 6px/.test(css), '3 裸 6px 已退役');
    ok(read('src/renderer/views/topic-view.js').includes("` · `") || read('src/renderer/views/topic-view.js').includes("' · '"),
      '3 字符串点分隔 meta 走全角 · 口径（话题）');
    ok(read('src/renderer/views/bookshelf.js').includes("parts.join(' · ')"), '3 书架元信息点分隔口径');

    // ── UI 行为断言（真实 ListView 渲染，r39 同款）──
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

    const longTitle = '这是一条非常长的文章标题用于验证两行截断后悬停可以看到完整全文出路的确定性探针素材标题再补一段确保超出行数限制';
    const flow = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const { ListView } = await import('./views/list.js');
        const host = document.createElement('div');
        host.className = 'list-scroll';
        document.body.appendChild(host);
        const lv = new ListView(host, { onSelect: () => {}, onContext: () => {}, onLoadMore: () => {}, onSearch: () => {} });
        window.__lv = lv;
        const TS = Math.floor(Date.now() / 1000) - 3600;
        const mk = (i, over = {}) => ({ id: 'r58-' + i, title: '${longTitle}', summaryPreview: '摘要素材', sourceTitle: 'R58 来源名特别长的样本用于截断验证', publishedAt: TS + i * 60, contentHead: '', ...over });
        // 列表行
        lv.setViewMode('list');
        lv.render([mk(0)], { kind: 'all' }, null, true);
        await sleep(250);
        const rowTitleTitle = document.querySelector('.entry-title')?.title || '';
        // 聚簇行
        lv.render([mk(1, { title: '${longTitle}（补充报道）' }), mk(2)], { kind: 'all' }, null, true);
        await sleep(250);
        const clusterTitle = document.querySelector('.cluster-row span:nth-child(2)')?.title || '';
        // 杂志卡
        lv.setViewMode('magazine');
        lv.render([mk(3)], { kind: 'all' }, null, true);
        await sleep(250);
        const magTitle = document.querySelector('.mag-title')?.title || '';
        const magFeed = document.querySelector('.mag-feed')?.title || '';
        // meta 间距（计算样式）
        lv.setViewMode('list');
        lv.render([mk(0)], { kind: 'all' }, null, true);
        await sleep(250);
        const metaGap = getComputedStyle(document.querySelector('.entry-meta')).gap;
        return { rowTitleTitle, clusterTitle, magTitle, magFeed, metaGap };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'list-flow');
    if (flow.__err) ok(false, '2/3 列表流程探针异常 — ' + flow.__err);
    else {
      ok(flow.rowTitleTitle === longTitle, '2 行标题截断有悬停全文（title=完整标题）');
      ok(flow.clusterTitle.includes('补充报道'), '2 聚簇行标题悬停全文');
      ok(flow.magTitle === longTitle, '2 杂志卡标题悬停全文');
      ok(flow.magFeed.includes('R58 来源名'), '2 杂志卡来源悬停全文');
      ok(flow.metaGap === '4px', `3 entry-meta 计算间距 = --space-1（实际 ${flow.metaGap}）`);
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
