'use strict';
/**
 * diag-f15-tags.js — F15 AI 自动标签探针（run-all OFFLINE，全程离线）
 *
 * 覆盖：
 *  1 继承打标：预灌同源带标签文章 → 新文章入库自动继承 Top 标签（source='inherit'）
 *  2 AI 批量打标：mock LLM 输出 JSON → source='ai'，未标记文章被消化
 *  3 解析失败静默：LLM 回包非 JSON → 跳过不写库不抛错
 *  4 每小时节流：注入时间 → 节流窗口内 skipped=throttled，过窗后放行
 *  5 复核过滤 chips：知识中心标签 tab 渲染（全部/手动/AI/继承）且只过滤展示
 *  6 图谱含 AI/继承标签（getGraphData 天然包含）
 *  7 无 Key 静默跳过（skipped=noKey）
 *  8 开关持久化（偏好 + IPC tags:autoConfig 往返）+ 设置「知识」分区渲染
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f15-tags-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 170 * 1000).unref();

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { TagAutoService, parseTagsPayload, normalizeTag } = require('../src/main/TagAutoService');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const store = new AppStore(userData);

    // ── 1. 继承打标（入库钩子） ──
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F15 老刊', feedURL: 'https://f15.test/old.xml' });
    const seed = [];
    for (let i = 1; i <= 3; i++) seed.push({ id: `s-${i}`, title: `量子计算旧文${i}`, url: `https://f15.test/s/${i}`, publishedAt: Math.floor(Date.now() / 1000) - i * 3600, summary: '', contentHTML: null });
    store._applyParsedEntries(feed, seed);
    const seedIDs = store.database.prepare('SELECT id FROM items WHERE feed_id = ?').all(feed.id).map((r) => r.id);
    for (const id of seedIDs) store.knowledge.addManualTag(id, '量子计算');
    store.knowledge.addManualTag(seedIDs[0], '芯片');
    store.knowledge.addManualTag(seedIDs[1], '芯片');

    const batch2 = [];
    for (let i = 1; i <= 2; i++) batch2.push({ id: `n-${i}`, title: `量子计算新章${i}`, url: `https://f15.test/n/${i}`, publishedAt: Math.floor(Date.now() / 1000) - i * 60, summary: '', contentHTML: null });
    store._applyParsedEntries(feed, batch2);
    const inherited = store.database.prepare("SELECT item_id, tag FROM article_tags WHERE source = 'inherit'").all();
    ok(inherited.length >= 4, `1 继承打标：新文章继承同源 Top 标签（inherit 行=${inherited.length}）`);
    ok(inherited.every((r) => ['量子计算', '芯片'].includes(r.tag)), `1 继承内容为同源高频 Top 标签（${[...new Set(inherited.map((r) => r.tag))].join('/')}）`);

    // ── 7. 无 Key 静默（先于 AI mock） ──
    store.tagAuto.setEnabled(true);
    const noKey = await store.tagAuto.kick();
    ok(noKey.skipped === true && noKey.reason === 'noKey' && store.tagAuto.snapshot().skippedNoKey >= 1,
      `7 无 Key 静默跳过（reason=${noKey.reason}）`);

    // ── 2. AI 批量打标（mock _requireAIReady + LLM 回包） ──
    const feed2 = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F15 新刊（无标签史）', feedURL: 'https://f15.test/new.xml' });
    store._applyParsedEntries(feed2, [{ id: 'u-1', title: '无标签史文章甲', url: 'https://f15.test/u/1', publishedAt: Math.floor(Date.now() / 1000), summary: '一片空白的摘要', contentHTML: null }]);
    const untaggedBefore = store.tagAuto.untaggedCandidates(Math.floor(Date.now() / 1000) - 7 * 86400).length;
    ok(untaggedBefore >= 1, `2 未打标候选可见（${untaggedBefore} 篇）`);

    const origReady = store._requireAIReady;
    store._requireAIReady = () => ({ config: { model: 'mock' }, apiKey: 'mock-key' });
    store.tagAuto._llmComplete = async () => '```json\n["人工智能", "测试主题"]\n```';
    const run1 = await store.tagAuto.kick({ force: true });
    const aiRows = store.database.prepare("SELECT item_id, tag FROM article_tags WHERE source = 'ai' AND tag IN ('人工智能','测试主题')").all();
    ok(run1.skipped === false && aiRows.length >= 2, `2 AI 批量打标落库（source='ai' 行=${aiRows.length}，tagged=${run1.taggedEntries}）`);
    ok(store.tagAuto.snapshot().aiEntries >= 1, `2 未标记文章被消化（aiEntries=${store.tagAuto.snapshot().aiEntries}）`);

    // ── 3. 解析失败静默（新刊三号：无标签史，保证候选不被继承消化） ──
    const aiBefore = store.database.prepare("SELECT COUNT(*) AS n FROM article_tags WHERE source = 'ai'").get().n;
    store.tagAuto._llmComplete = async () => '我觉得这篇讲得还不错，推荐阅读。';
    const feed3 = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F15 第三刊（无标签史）', feedURL: 'https://f15.test/third.xml' });
    store._applyParsedEntries(feed3, [{ id: 'u-2', title: '解析失败文章丙', url: 'https://f15.test/u/2', publishedAt: Math.floor(Date.now() / 1000), summary: '又一片空白', contentHTML: null }]);
    const run2 = await store.tagAuto.kick({ force: true });
    const aiAfter = store.database.prepare("SELECT COUNT(*) AS n FROM article_tags WHERE source = 'ai'").get().n;
    ok(run2.skipped === false && aiAfter === aiBefore && store.tagAuto.snapshot().parseFailures >= 1,
      `3 解析失败静默跳过（库未变 ${aiAfter}=${aiBefore}，parseFailures=${store.tagAuto.snapshot().parseFailures}）`);

    // ── 6. 图谱含 AI / 继承标签（查询对 source 无过滤 → 天然包含） ──
    const graph = store.knowledge.getGraphData(300);
    const graphTags = new Set(graph.tags.map((x) => x.tag));
    ok(graphTags.has('人工智能') && graphTags.has('量子计算') && graph.edges.length >= 6,
      `6 图谱含 AI 标签与继承标签（tags=${graph.tags.length}，edges=${graph.edges.length}）`);

    // ── 4. 每小时节流（注入时间） ──
    const fakeNow = Math.floor(Date.now() / 1000) + 100000;
    const svc2 = new TagAutoService(store);
    svc2._now = () => fakeNow;
    svc2._llmComplete = async () => '["节流标签"]';
    store.preferences.set(TagAutoService.PREF_LAST_RUN, fakeNow - 600); // 10 分钟前跑过
    const throttled = await svc2.kick();
    store.preferences.set(TagAutoService.PREF_LAST_RUN, fakeNow - 7200); // 2 小时前
    const passed = await svc2.kick();
    ok(throttled.skipped === true && throttled.reason === 'throttled' && svc2.snapshot().skippedThrottled >= 1,
      '4 节流窗口内跳过（throttled）');
    ok(passed.skipped === false, '4 过节流窗口后放行');

    // 标签规范化 + 解析器单元（≤24 字、小写、围栏容忍）
    ok(normalizeTag('  AI  Security ') === 'ai security' && normalizeTag('x'.repeat(30)).length === 24,
      '2 标签规范化：小写 + ≤24 字');
    ok(JSON.stringify(parseTagsPayload('前缀杂讯 ["甲","乙","丙","丁"] 后缀')) === JSON.stringify(['甲', '乙', '丙']),
      '2 解析器：容忍杂讯 + 截到 3 个');

    // ── 8. 开关持久化 ──
    ok(store.tagAuto.enabled === true && store.preferences.get('RobinRead.tags.autoAI', false) === true,
      '8 开关持久化（偏好 true）');
    store.tagAuto.setEnabled(false);
    ok(store.tagAuto.enabled === false && store.tagAuto.snapshot().enabled === false, '8 开关可关（快照同步）');
    store.tagAuto.setEnabled(true);

    // ── 5. UI：知识中心标签 tab 复核 chips + 设置「知识」分区（真 IPC） ──
    const { BrowserWindow } = require('electron');
    const { registerIPCHandlers } = require('../src/main/ipc');
    const win = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
    });
    registerIPCHandlers(store, win);
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    await sleep(900);
    const ui = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, ms = 8000) => {
        const t0 = Date.now();
        for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); }
      };
      try {
        const { KnowledgeCenter } = await import('./views/knowledge.js');
        const kc = new KnowledgeCenter({ onOpenArticle: () => {}, onOpenURL: () => {} });
        kc.present('tags');
        const chips = await waitFor(() => document.querySelectorAll('.kb-tag-chip').length === 4 ? [...document.querySelectorAll('.kb-tag-chip')] : null);
        const chipLabels = chips ? chips.map((c) => c.textContent) : [];
        const cloudAll = await waitFor(() => document.querySelectorAll('.kb-tag2').length ? document.querySelectorAll('.kb-tag2').length : null);
        // 点「继承」chip → 只显示继承来源标签
        chips.find((c) => c.textContent === '继承').click();
        await sleep(120);
        const inheritActive = document.querySelector('.kb-tag-chip.active')?.textContent;
        const cloudInherit = document.querySelectorAll('.kb-tag2').length;
        const inheritTags = [...document.querySelectorAll('.kb-tag2-label')].map((n) => n.textContent);
        // 点「AI」chip → 显示 AI 标签
        chips.find((c) => c.textContent === 'AI').click();
        await sleep(120);
        const aiTags = [...document.querySelectorAll('.kb-tag2-label')].map((n) => n.textContent);
        // 回「全部」
        chips.find((c) => c.textContent === '全部').click();
        await sleep(120);
        const cloudBackAll = document.querySelectorAll('.kb-tag2').length >= cloudAll;
        kc.dismiss();

        // 设置「知识」分区
        const { SettingsView } = await import('./views/dialogs.js');
        const view = new SettingsView({ state: {}, views: {}, onAddFreshRSS: () => {}, onReload: () => {}, onRefreshState: () => {} });
        view.present('knowledge');
        const navOk = [...document.querySelectorAll('.modal-nav-item')].some((el) => el.textContent.includes('知识'));
        await waitFor(() => (document.querySelector('.modal-scroll')?.textContent || '').includes('AI 自动标签') ? true : null);
        const body = document.querySelector('.modal-scroll')?.textContent || '';
        const hasToggle = Boolean(document.querySelector('.modal-scroll .toggle'));
        const hasKick = body.includes('立即打标一批');
        // IPC 往返：开关关 → 快照 enabled=false → 再开
        await window.robin.tagsAutoConfig({ enabled: false });
        const snapOff = await window.robin.tagsAutoSnapshot();
        await window.robin.tagsAutoConfig({ enabled: true });
        const snapOn = await window.robin.tagsAutoSnapshot();
        view.dismiss();
        return { chipLabels, cloudAll, inheritActive, cloudInherit, inheritTags, aiTags, cloudBackAll, navOk, hasToggle, hasKick,
          ipcOff: snapOff && snapOff.enabled === false, ipcOn: snapOn && snapOn.enabled === true };
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`);
    if (ui && ui.__err) ok(false, '5 UI 探针异常 — ' + ui.__err);
    else {
      ok(JSON.stringify(ui.chipLabels) === JSON.stringify(['全部', '手动', 'AI', '继承']), `5 复核 chips 渲染（${JSON.stringify(ui.chipLabels)}）`);
      ok(ui.cloudAll >= 3, `5 全部口径标签云渲染（${ui.cloudAll} 个标签）`);
      ok(ui.inheritActive === '继承' && ui.cloudInherit >= 1 && ui.inheritTags.every((x) => ['量子计算', '芯片'].includes(x)),
        `5 继承过滤只显示继承标签（${JSON.stringify(ui.inheritTags)}）`);
      ok(ui.aiTags.includes('人工智能'), `5 AI 过滤显示 AI 标签（${JSON.stringify(ui.aiTags)}）`);
      ok(ui.cloudBackAll, '5 切回全部口径恢复');
      ok(ui.navOk && ui.hasToggle && ui.hasKick, '5 设置「知识」分区渲染（导航/开关/立即打标按钮）');
      ok(ui.ipcOff && ui.ipcOn, '8 IPC tags:autoConfig 往返持久化');
    }

    win.destroy();
    store.database.close();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
