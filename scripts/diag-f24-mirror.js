'use strict';
/**
 * diag-f24-mirror.js — F24 观点对照镜探针（run-all OFFLINE 集，全程离线）
 *
 * mock LLM：服务级 _llmComplete 注入（记录每次调用；可控返回 JSON/围栏/垃圾/
 * 挂起拒绝），_requireAIReady 实例覆写控制 Key 有无。
 *
 * 覆盖：
 *  1 v23 迁移：perspectives 建表 + relation CHECK + 唯一约束防重
 *  2 召回（本地零 AI）：相似引擎复用 / 时间差 ≥14 天优先（同文异龄对照）/
 *    不同源加分 / 无关旧文不入榜 / 上限 10
 *  3 mock LLM 关系判定：批量一次 prompt / JSON 解析三组（矛盾/互补/呼应）/
 *    非法 relation 兜底 none / ```json 围栏容错 / 坏输出不落库可重试
 *  4 perspectives 持久化防重：同对文章二次 mirror 零 LLM 调用 / reason+model 落库
 *  5 单飞锁与取消：并发第二次 mirror 抛 requestInProgress / cancelAI 后返回
 *    cancelled 且零落库 / cancellers 注册表用后即清
 *  6 无 Key 降级：degraded=true + judged=0 + 相似旧文列表在 + 零 LLM 调用
 *  7 UI：对照镜按钮显隐规则（观点词/AI 可用/两者皆否）/ 判定中转圈与取消按钮 /
 *    侧板三组卡片流（标题+日期+理由）/ 卡片点击跳转 / 降级侧板（相似旧文+
 *    明示未判定）/ 空态 / 静态接线锚点
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f24-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 190 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const T = Math.floor(Date.now() / 1000);
const DAY = 86400;

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { parseMirrorPayload, normalizeRelation, PERSPECTIVE } = require('../src/main/PerspectiveService');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);
    const svc = store.perspectives;

    // ── 1. v23 迁移（perspectives）──
    ok(!!store.database.prepare("SELECT 1 FROM schema_migrations WHERE id = 'v23-garden-perspectives'").get(),
      '1 v23 迁移已入链');
    const pSQL = (store.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='perspectives'").get()?.sql || '').replace(/\s+/g, ' ');
    ok(/PRIMARY KEY\s*\(entry_id\s*,\s*related_entry_id\)/i.test(pSQL),
      '1 perspectives 唯一约束（同对文章不重复判）');
    ok(/relation[^']*'contradict'/i.test(pSQL) && /'complement'/.test(pSQL) && /'echo'/.test(pSQL),
      '1 relation CHECK 三类判定 + none 兜底在位');

    // ── 场景源：三个源 · 观点文生态 ──
    const OPINION_TEXT = '混合办公是未来：我认为分布式团队将重塑城市与工作方式';
    const mkFeed = (title, url) => store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title, feedURL: url });
    const feedA = mkFeed('观点源甲', 'https://f24.test/a.xml');
    const feedB = mkFeed('观点源乙', 'https://f24.test/b.xml');
    const feedC = mkFeed('观点源丙', 'https://f24.test/c.xml');
    const feedD = mkFeed('深海源丁', 'https://f24.test/d.xml');
    const entry = (feed, id, title, ageDays, summary) => ({
      id, title, url: `https://f24.test/x/${id}`,
      publishedAt: T - ageDays * DAY, summary: summary || `${title}。全文讨论。`, contentHTML: `<p>${title}。正文。</p>`,
    });
    // 同文异龄对照对（确定性排序断言的关键：bigram 完全一致 → 只剩时间差/同源加分）
    const ids = {};
    const put = async (feed, e) => (await store._applyParsedEntries(feed, [e]))[0];
    ids.cur = await put(feedA, entry(feedA, 'f24-cur', OPINION_TEXT, 0, `${OPINION_TEXT}。这是当下的立场。`));
    ids.old = await put(feedB, entry(feedB, 'f24-old', OPINION_TEXT, 30, `${OPINION_TEXT}。这是三十天前的立场。`));
    ids.new = await put(feedC, entry(feedC, 'f24-new', OPINION_TEXT, 2, `${OPINION_TEXT}。这是两天前的立场。`));
    ids.mid = await put(feedA, entry(feedA, 'f24-mid', '混合办公之外：我认为办公室依然不可替代', 16, '反方观点：办公室的价值。'));
    ids.noise = await put(feedB, entry(feedB, 'f24-noise', '红烧肉的家常做法与火候诀窍', 40, '今天聊聊红烧肉。'));
    // 垫行：避免 mid 成为 cur 的同 feed 直接邻居（SimilarService 剔除邻居）
    await put(feedA, entry(feedA, 'f24-fill', '远足笔记：山间一日与林道观察', 1, '徒步记录。'));
    ids.ui = await put(feedA, entry(feedA, 'f24-ui', '分布式团队管理手记：我认为弹性制度更重要', 3, '管理实践观察。'));
    ids.uniq = await put(feedD, entry(feedD, 'f24-uniq', '我认为深海热泉生态依赖化能合成而非光合', 60, '深海生物学漫谈。'));
    ok(!!ids.cur && !!ids.old && !!ids.new && !!ids.mid && !!ids.noise && !!ids.ui && !!ids.uniq,
      '附 场景源灌入 8 篇（3 源）');

    // ── 2. 召回（本地零 AI）──
    const recall = svc.recall(ids.cur);
    ok(recall.items.length >= 3, `2 召回：相似引擎复用（${recall.items.length} 条候选）`);
    ok(!recall.items.some((c) => c.id === ids.noise), '2 无关旧文不入榜（噪声过滤）');
    ok(recall.items[0].id === ids.old && recall.items[1].id === ids.new,
      '2 时间差优先：30 天旧文排在你 2 天前的新文前（同文异龄对照）');
    ok(recall.items[0].gapDays >= PERSPECTIVE.MIN_GAP_DAYS && recall.items[1].gapDays < PERSPECTIVE.MIN_GAP_DAYS,
      `2 gapDays 字段正确（旧文 ≥${PERSPECTIVE.MIN_GAP_DAYS} 天）`);
    ok(recall.items[0].differentSource === true, '2 不同源候选（跨源对照）');
    ok(recall.items.every((c) => c.id !== ids.cur), '2 召回不含自身');
    // 解析器：围栏/杂文/非法 relation/缺 index 顺位兜底
    ok(JSON.stringify(parseMirrorPayload('```json\n[{"index":1,"relation":"contradict","reason":"立场相反"}]\n```', 1))
      === JSON.stringify([{ relation: 'contradict', reason: '立场相反' }]),
      '3 解析器：```json 围栏容错');
    ok(parseMirrorPayload('抱歉，我无法判断这些文章的关系。', 2) === null, '3 解析器：纯垃圾输出返回 null（不落库可重试）');
    ok(normalizeRelation('CONTRADICT') === 'contradict' && normalizeRelation('胡说') === 'none',
      '3 解析器：relation 归一（大小写/非法值兜底 none）');
    ok(JSON.stringify(parseMirrorPayload('[{"relation":"echo","reason":"呼应"},{"index":9,"relation":"complement","reason":"x"}]', 2))
      === JSON.stringify([{ relation: 'echo', reason: '呼应' }, { relation: 'complement', reason: 'x' }]),
      '3 解析器：越界 index 顺位兜底 + 长度对齐');
    ok(JSON.stringify(parseMirrorPayload('[{"index":2,"relation":"echo","reason":"r"}]', 2))
      === JSON.stringify([{ relation: 'none', reason: '' }, { relation: 'echo', reason: 'r' }]),
      '3 解析器：缺位自动补 none（长度合同）');

    // ── 3/4. mock LLM 批量判定 + 持久化防重 ──
    const llmCalls = [];
    svc._llmComplete = async (entryID, candidates) => {
      llmCalls.push({ entryID, count: candidates.length });
      const verdicts = candidates.map((c, i) => {
        const map = { [ids.old]: ['contradict', '三十天前的你正好看反：办公室不可替代'], [ids.new]: ['complement', '两天前的补充：远非全盘远程'], [ids.mid]: ['echo', '同一争论的不同侧面'] };
        const v = map[c.id] || ['none', '同领域不同主题'];
        return { index: i + 1, relation: v[0], reason: v[1] };
      });
      return JSON.stringify(verdicts);
    };
    store._requireAIReady = () => ({ config: { model: 'mock-model', targetLanguage: '中文' }, apiKey: 'mock-key' });

    const res1 = await svc.mirror(ids.cur);
    ok(res1.judged === res1.candidates && res1.candidates >= 3, `3 批量判定：${res1.judged}/${res1.candidates} 条完成（一批 prompt）`);
    ok(llmCalls.length === 1 && llmCalls[0].count >= 3 && llmCalls[0].entryID === ids.cur,
      `3 批量一次 prompt（${llmCalls.length} 次调用 / ${llmCalls[0]?.count} 候选）`);
    ok(res1.groups.contradict.length === 1 && res1.groups.contradict[0].id === ids.old
      && res1.groups.contradict[0].reason.includes('唱反调') === false
      && res1.groups.contradict[0].reason.includes('反') === true,
      '3 唱反调组：30 天旧文 + 一句话理由');
    ok(res1.groups.complement.length === 1 && res1.groups.complement[0].id === ids.new, '3 相辅相成组在位');
    ok(res1.groups.echo.length === 1 && res1.groups.echo[0].id === ids.mid, '3 遥相呼应组在位');
    const rowOld = store.database.prepare('SELECT * FROM perspectives WHERE entry_id = ? AND related_entry_id = ?').get(ids.cur, ids.old);
    ok(!!rowOld && rowOld.relation === 'contradict' && rowOld.model === 'mock-model' && !!rowOld.reason,
      '4 判定持久化：relation/reason/model 落库');
    const rowsTotal1 = store.database.prepare('SELECT COUNT(*) AS n FROM perspectives').get().n;
    ok(rowsTotal1 >= 3, `4 判定持久化：${rowsTotal1} 行（含 none 兜底行——重判零浪费）`);

    const res2 = await svc.mirror(ids.cur);
    ok(res2.judged === 0 && llmCalls.length === 1 && store.database.prepare('SELECT COUNT(*) AS n FROM perspectives').get().n === rowsTotal1,
      '4 持久化防重：同对文章二次 mirror 零 LLM 调用零新增行');
    const dup = store.database.prepare(`
      INSERT OR IGNORE INTO perspectives (entry_id, related_entry_id, relation, reason, model, created_at)
      VALUES (?, ?, 'echo', 'dup', 'm', ?)
    `).run(ids.cur, ids.old, T);
    ok(dup.changes === 0, '4 唯一约束兜底：重复对 INSERT OR IGNORE 零写入');

    // ── 5. 单飞锁与取消 ──
    let releaseJudge = null;
    svc._llmComplete = (entryID, candidates) => new Promise((resolve, reject) => {
      releaseJudge = { resolve, reject, entryID, count: candidates.length };
    });
    const p1 = svc.mirror(ids.mid);
    await sleep(80);
    ok(!!releaseJudge && store.activeAICancellers.has(`perspectives:${ids.mid}`),
      '5 判定进行中：canceller 注册在册（activeAICancellers 惯例）');
    let inFlightErr = '';
    const p2 = await svc.mirror(ids.mid).then(() => null, (e) => e);
    inFlightErr = String(p2 && p2.message || p2);
    ok(/正在进行|in progress|requestInProgress/i.test(inFlightErr) || p2?.kind === 'requestInProgress',
      `5 单飞锁：并发第二次 mirror 被拒（${inFlightErr.slice(0, 24)}…）`);
    store.cancelAI(`perspectives:${ids.mid}`);
    releaseJudge.resolve(JSON.stringify([{ index: 1, relation: 'echo', reason: '不应落库' }]));
    const resCancel = await p1;
    ok(resCancel.cancelled === true, '5 取消：cancelAI 后判定以 cancelled 收场');
    ok(store.database.prepare('SELECT COUNT(*) AS n FROM perspectives WHERE entry_id = ?').get(ids.mid).n === 0,
      '5 取消：已取消判定零落库');
    ok(!store.activeAICancellers.has(`perspectives:${ids.mid}`), '5 canceller 用后即清（无泄漏）');

    // 坏输出容错：整体垃圾 → parseFailed 不落库
    svc._llmComplete = async () => '抱歉我无法输出 JSON。';
    const resBad = await svc.mirror(ids.new);
    ok(resBad.parseFailed === true && store.database.prepare('SELECT COUNT(*) AS n FROM perspectives WHERE entry_id = ?').get(ids.new).n === 0,
      '3 坏输出：parseFailed 明示且零落库（可重试不谎报）');

    // ── 6. 无 Key 降级（真实路径：无实例覆写、无 Key）──
    delete store._requireAIReady;
    svc._llmComplete = null;
    ok(store.hasAIAPIKey() === false, '6 无 Key 前置（真实凭据态）');
    const degradedCalls = llmCalls.length;
    const resDeg = await svc.mirror(ids.old); // old 侧待判对未消耗（cur 对已全部判毕）
    ok(resDeg.degraded === true && resDeg.judged === 0, '6 无 Key 降级：degraded=true / 零判定');
    ok(Array.isArray(resDeg.similar) && resDeg.similar.length >= 3, '6 降级仍给「相似旧文」列表（明示未判定）');
    ok(llmCalls.length === degradedCalls, '6 降级路径零 LLM 调用');

    // ── 7. UI（真 IPC + 真 index.html，分阶段批次驱动）──
    // mock LLM（延迟 700ms 的 echo 判定，供「判定中」态观测）+ 真实 Key
    store.setAIAPIKey('mock-key-24');
    svc._llmComplete = async (entryID, candidates) => {
      await sleep(700);
      return JSON.stringify(candidates.map((c, i) => ({ index: i + 1, relation: 'echo', reason: '同一争论的不同侧面（UI 流）' })));
    };
    const ui = await mirrorUIProbe(store, { cur: ids.cur, old: ids.old, noise: ids.noise, ui: ids.ui, uniq: ids.uniq });
    ok(ui.booted, '附 UI 探针窗口启动（index.html + preload + 真 IPC）');
    ok(ui.plainBtnHidden === true, '7 无观点词 + 无 AI → 按钮隐藏（两者皆否）');
    ok(ui.plainBtnVisibleWithAI === true, '7 无观点词 + AI 可用 → 按钮显示（AI 可用即显）');
    ok(ui.opinionBtnVisible === true, '7 观点文（含观点词）→ 对照镜按钮显示');
    ok(ui.groups3 === true, '7 侧板三组渲染（唱反调/相辅相成/遥相呼应）');
    ok(ui.cardMeta === true && ui.cardReason === true, '7 卡片：旧文标题+日期+关系理由');
    ok(ui.jumpWorks === true, '7 卡片点击跳转旧文（阅读器切换 entry）');
    ok(ui.loadingSpinner === true && ui.cancelBtn === true, '7 判定中：转圈 + 取消按钮');
    ok(ui.cancelNotice === true, '7 点击取消 → 已取消明示（不再谎报判定）');
    ok(ui.degradedPanel === true, '7 无 Key 降级侧板：相似旧文 + 未判定明示');
    ok(ui.emptyState === true, '7 无对照发现 → 空态文案');
    ok(ui.panelCleaned === true, '7 换文后侧板无残留');

    // ── 附：静态接线锚点 ──
    const preloadSrc = read('src/main/preload.js');
    ok(['perspectivesAvailable', 'perspectivesMirror', 'perspectivesCancel', 'perspectivesGroups']
      .every((n) => preloadSrc.includes(n)), '附 preload 对照镜 4 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(['perspectives:available', 'perspectives:mirror', 'perspectives:cancel', 'perspectives:groups']
      .every((c) => ipcSrc.includes(`'${c}'`)), '附 IPC 对照镜通道注册齐备');
    const readerSrc = read('src/renderer/views/reader.js');
    ok(['nj-mirror-header-btn', 'nj-mirror-panel', '_appendMirrorHeaderButton', 'OPINION_WORDS']
      .every((n) => readerSrc.includes(n)), '附 reader 对照镜按钮/侧板接线');

    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
    console.log(failed === 0 ? 'ALL PASSED' : `FAILED ${failed}`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('ERR', String((err && err.stack) || err).slice(0, 1600));
    app.exit(1);
  }
});

/**
 * 对照镜 UI 探针：真 IPC。分阶段批次（主进程侧在批间切换 Key/判定的可用性）：
 * A 无 Key（两者皆否隐藏）→ B 有 Key（AI 可用即显 / 三组 / 跳转 / 判定中 / 取消）→
 * C 判定被禁（降级 / 空态 / 无残留）。
 */
async function mirrorUIProbe(store, ids) {
  const win = new BrowserWindow({
    show: false, width: 1200, height: 860,
    webPreferences: { contextIsolation: true, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
  });
  const { registerIPCHandlers } = require('../src/main/ipc');
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await sleep(1400);

  const run = (script) => win.webContents.executeJavaScript(script);
  const out = { booted: true };

  // ── 阶段 A：无 Key ──
  store.hasAIAPIKey = () => false; // 实例覆写：两者皆否分支（原型方法用后恢复）
  out.plainBtnHidden = await run(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__robinReaderOpen('${ids.noise}');
    await sleep(1100);
    const btn = document.querySelector('.nj-mirror-header-btn');
    return !btn || btn.hidden === true;
  })()`);
  delete store.hasAIAPIKey;

  // ── 阶段 B：有 Key（真实凭据，mock LLM 在服务级）──
  const phaseB = await run(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 14000) => {
      const t0 = Date.now();
      for (;;) {
        let v = null;
        try { v = await fn(); } catch (_) { v = null; }
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(120);
      }
    };
    const ids = ${JSON.stringify(ids)};
    const out = {};
    try {
      const open = async (id) => { window.__robinReaderOpen(id); await sleep(1000); };
      const mirrorBtn = () => document.querySelector('.nj-mirror-header-btn');

      // AI 可用即显（无观点词文章）
      await open(ids.noise);
      const btnN = await waitFor(() => mirrorBtn() && !mirrorBtn().hidden ? true : null, 4000);
      out.plainBtnVisibleWithAI = !!btnN;

      // 观点文 → 显示 → 点击开侧板（已判对直接出三组）
      await open(ids.cur);
      const btn = await waitFor(() => mirrorBtn() && !mirrorBtn().hidden ? mirrorBtn() : null);
      out.opinionBtnVisible = !!btn;
      if (btn) btn.click();
      const secs = await waitFor(() => document.querySelectorAll('.nj-mirror-sec[data-relation]').length >= 3 ? true : null);
      out.groups3 = !!secs
        && !!document.querySelector('.nj-mirror-sec[data-relation="contradict"]')
        && !!document.querySelector('.nj-mirror-sec[data-relation="complement"]')
        && !!document.querySelector('.nj-mirror-sec[data-relation="echo"]');
      const firstCard = document.querySelector('.nj-mirror-sec[data-relation="contradict"] .nj-mirror-card');
      out.cardMeta = !!firstCard && (firstCard.querySelector('.nj-mirror-card-title')?.textContent || '').length > 0
        && (firstCard.querySelector('.nj-mirror-card-meta')?.textContent || '').length > 0;
      out.cardReason = !!firstCard && (firstCard.querySelector('.nj-mirror-card-reason')?.textContent || '').length > 0;
      const beforeID = window.__robinReader?.entryID;
      if (firstCard) firstCard.click();
      await sleep(1300);
      out.jumpWorks = !!window.__robinReader?.entryID && window.__robinReader.entryID !== beforeID;

      // 判定中：转圈 + 取消按钮（f24-ui 有待判对 + mock LLM 延迟 700ms）
      await open(ids.ui);
      const btn2 = await waitFor(() => mirrorBtn() && !mirrorBtn().hidden ? mirrorBtn() : null);
      if (btn2) btn2.click();
      const loading = await waitFor(() => document.querySelector('.nj-mirror-panel .nj-mirror-loading') ? true : null, 4000);
      out.loadingSpinner = !!loading && !!document.querySelector('.nj-mirror-spinner');
      out.cancelBtn = !!document.querySelector('.nj-mirror-cancel');
      const cancelBtn = document.querySelector('.nj-mirror-cancel');
      if (cancelBtn) cancelBtn.click();
      const notice = await waitFor(() => {
        const el = document.querySelector('.nj-mirror-degraded');
        return el && (el.textContent || '').includes('取消') ? true : null;
      }, 12000);
      out.cancelNotice = !!notice;
      return out;
    } catch (e) {
      return { error: String((e && e.stack) || e).slice(0, 700) };
    }
  })()`);
  Object.assign(out, phaseB);

  // ── 阶段 C：判定被禁（无 Key 抛错 → 降级）──
  store._requireAIReady = () => { throw new Error('尚未设置 API Key。请先在设置中完成 AI 服务配置。'); };
  const phaseC = await run(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 12000) => {
      const t0 = Date.now();
      for (;;) {
        let v = null;
        try { v = await fn(); } catch (_) { v = null; }
        if (v) return v;
        if (Date.now() - t0 > ms) return null;
        await sleep(120);
      }
    };
    const ids = ${JSON.stringify(ids)};
    const out = {};
    try {
      const open = async (id) => { window.__robinReaderOpen(id); await sleep(1000); };
      const mirrorBtn = () => document.querySelector('.nj-mirror-header-btn');

      // 降级侧板：old 有相似旧文（cur 侧已判，old 侧未判 → pending > 0 → 禁判 → 降级）
      await open(ids.old);
      const btn = await waitFor(() => mirrorBtn() && !mirrorBtn().hidden ? mirrorBtn() : null);
      if (btn) btn.click();
      const deg = await waitFor(() => {
        const el = document.querySelector('.nj-mirror-degraded');
        return el && (el.textContent || '').includes('未') ? true : null;
      });
      out.degradedPanel = !!deg
        && !!document.querySelector('.nj-mirror-sec[data-relation="similar"]')
        && document.querySelectorAll('.nj-mirror-sec[data-relation="similar"] .nj-mirror-card').length >= 1;

      // 空态：uniq 无相似候选 → 无判定直接空态
      await open(ids.uniq);
      const btn2 = await waitFor(() => mirrorBtn() && !mirrorBtn().hidden ? mirrorBtn() : null);
      if (btn2) btn2.click();
      const empty = await waitFor(() => document.querySelector('.nj-mirror-empty') ? true : null);
      out.emptyState = !!empty && (document.querySelector('.nj-mirror-empty')?.textContent || '').includes('没照出');

      // 换文无残留
      await open(ids.noise);
      await sleep(400);
      out.panelCleaned = !document.querySelector('.nj-mirror-panel');
      return out;
    } catch (e) {
      return { error: String((e && e.stack) || e).slice(0, 700) };
    }
  })()`);
  Object.assign(out, phaseC);
  delete store._requireAIReady;

  win.destroy();
  if (out.error) console.error('mirror UI probe error:', out.error);
  return out;
}
