'use strict';
/** v2.14.0 README 配图：观点对照镜 / 知识花园 / 阅读挑战 / 知更周刊 / 时间胶囊 / 阅读生物钟。
 *  输出 docs/images/{mirror,garden,challenge,weekly,capsule,reading-clock}.jpg */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const OUT = path.join(__dirname, '..', 'docs', 'images');
const LOG = path.join(__dirname, 'shot-v2140.log');
const T0 = Date.now();
const DAY = 86400;
const log = (m) => { const line = `[${Math.round((Date.now() - T0) / 1000)}s] ${m}`; console.log(line); fs.appendFileSync(LOG, line + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-shot-'));
app.setPath('userData', userData);

setTimeout(() => { log('WATCHDOG 退出'); app.exit(3); }, 8 * 60 * 1000).unref();

const OPINION = '我认为远程办公将重新定义知识工作的组织形态';
const BODY = (t) => `<p>${t}。这个判断不是情绪，而是过去三年协作工具演化的直接推论——当异步沟通成为默认，地理就不再是组织的边界。</p><p>真正值得讨论的是代价：导师制的断层、新人融入的迟滞、以及「顺带聊两句」带来的创造性偶然。这些恰恰是办公室最不可替代的部分。</p><p>所以答案大概率不在两端，而在中间态：以周为节律的混合制，让集中协作与深度独处各得其所。</p>`;

app.whenReady().then(async () => {
  let failures = 0;
  const ok = (name) => { console.log(`PASS ${name}`); log(`PASS ${name}`); };
  const fail = (name, d) => { failures += 1; console.log(`FAIL ${name} — ${d}`); log(`FAIL ${name} — ${d}`); };

  const { AppStore } = require('../src/main/AppStore');
  const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
  const { mondayOf } = require('../src/main/WeeklyService');
  const store = new AppStore(userData);

  // ── 播种（开窗前全部就位）──
  const mkFeed = (title, url) => store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title, siteURL: url, feedURL: `${url}/feed.xml` });
  const feedA = mkFeed('未来工作观察', 'https://shot.test/a');
  const feedB = mkFeed('组织进化评论', 'https://shot.test/b');
  const put = async (feed, id, title, ageDays, source) => (await store._applyParsedEntries(feed, [{
    id, title, url: `https://shot.test/x/${id}`, publishedAt: T0 / 1000 - ageDays * DAY,
    summary: `${title}。`, contentHTML: BODY(title),
  }]))[0];

  // 周刊 + 花园的阅读底料：本周读完 6 篇
  const weekIds = [];
  const weekTitles = [
    '注意力经济之后：慢媒体的商业闭环', '卡片盒笔记法的工程化实践', '电子纸平板半年体验：读得更慢，记得更牢',
    '深度工作的日历防御术', 'RSS 复兴：从时间线回到订阅', '为什么好的工具都长得不性感',
  ];
  for (let i = 0; i < weekTitles.length; i += 1) {
    const id = await put(feedB, `shot-w${i}`, weekTitles[i], i, '组织进化评论');
    weekIds.push(id);
  }
  store.knowledge.addManualTag(weekIds[0], '慢读');
  store.knowledge.addManualTag(weekIds[1], '方法论');
  store.knowledge.addManualTag(weekIds[2], '装备');
  const wkHl = store.knowledge.addHighlight({ itemID: weekIds[0], text: '当异步沟通成为默认，地理就不再是组织的边界。', color: 'yellow', note: '本周最触动的一句。' });
  for (const id of weekIds) store.markRead(id, true);
  ok(`阅读底料 ${weekIds.length} 篇（花园浇水 + 周刊窗口）`);

  // 周刊生成（无 Key → 模板版面，ready 可开）；再生成上上周一期填满历史栏
  try {
    const wk = await store.weekly.generateWeek(mondayOf(T0 / 1000), { origin: 'manual' });
    if (wk && wk.status === 'ready') ok('周刊已生成（模板版面）'); else fail('周刊生成', JSON.stringify(wk || {}).slice(0, 200));
  } catch (e) { fail('周刊生成', String(e.message || e)); }
  try {
    const lwTitles = ['慢读俱乐部实践指南', '一年读一百本与读透一本', '书店正在变成图书馆'];
    const lwIds = [];
    for (let i = 0; i < lwTitles.length; i += 1) {
      const id = await put(feedB, `shot-lw${i}`, lwTitles[i], 8 + i, '组织进化评论');
      lwIds.push(id);
    }
    for (const id of lwIds) {
      store.markRead(id, true);
      store.database.prepare('UPDATE article_states SET updated_at = ? WHERE item_id = ?').run(T0 / 1000 - 7 * DAY + 3600, id);
    }
    const lw = await store.weekly.generateWeek(mondayOf(T0 / 1000 - 7 * DAY), { origin: 'manual' });
    if (lw && lw.status === 'ready') ok('上上周周刊已生成（历史栏）'); else fail('上上周周刊', JSON.stringify(lw || {}).slice(0, 120));
  } catch (e) { fail('上上周周刊', String(e.message || e)); }

  // 观点对照镜：同文异龄三源对照 + mock LLM 判定落库
  const cur = await put(feedA, 'shot-cur', `${OPINION}`, 0, '未来工作观察');
  const oldE = await put(feedB, 'shot-old', `${OPINION}`, 30, '组织进化评论');
  const newE = await put(feedB, 'shot-new', `${OPINION}`, 2, '组织进化评论');
  const midE = await put(feedA, 'shot-mid', '混合办公之外：我认为办公室依然不可替代', 16, '未来工作观察');
  await put(feedA, 'shot-fill', '远足笔记：山间一日与林道观察', 1, '未来工作观察'); // 垫行：防 mid 成同源邻位被相似引擎剔除
  store.setAIAPIKey('shot-key-2140');
  store.perspectives._llmComplete = async (entryID, candidates) => JSON.stringify(candidates.map((c, i) => {
    const map = {
      [oldE]: ['contradict', '三十天前的你正好看反：办公室的在场感与偶然碰撞不可替代'],
      [newE]: ['complement', '两天前的补充：远程重配的是注意力，而非取消协作'],
      [midE]: ['echo', '同一争论的另一面：弹性制度的代价由新人默默承担'],
    };
    const v = map[c.id] || ['none', '同领域不同主题'];
    return { index: i + 1, relation: v[0], reason: v[1] };
  }));
  try {
    const mir = await store.perspectives.mirror(cur);
    if (mir.groups && (mir.groups.contradict.length + mir.groups.complement.length + mir.groups.echo.length) >= 3) {
      ok(`对照镜判定落库（${mir.judged}/${mir.candidates}）`);
    } else fail('对照镜判定', JSON.stringify({ judged: mir.judged, candidates: mir.candidates }));
  } catch (e) { fail('对照镜判定', String(e.message || e)); }

  // 时间胶囊：高亮封存 30 天，拨到到期
  const capsuleText = '给三十天后的自己：如果这条笔记依然成立，说明慢读是真的。';
  const cHl = store.knowledge.addHighlight({ itemID: weekIds[1], text: capsuleText, color: 'yellow', note: '封存给未来。' });
  try {
    store.capsule.seal({ entryID: weekIds[1], annotationID: cHl.id, annotationKind: 'highlight', days: 30, message: '三十天后见。' });
    const realNow = store.capsule._now;
    store.capsule._now = () => (realNow ? realNow.call(store.capsule) : Date.now() / 1000) + 40 * DAY;
    if (store.capsule.pendingCount() >= 1) ok('时间胶囊已封存并到期'); else fail('时间胶囊', 'pendingCount=0');
  } catch (e) { fail('时间胶囊', String(e.message || e)); }

  // 阅读生物钟底料：近几日 9/10 点与 20/21 点双峰（reading_clock 直播种——阅读器落账在棚拍里来不及积累）
  const d = new Date();
  const dayKey = (offset) => { const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
  const clockSeed = store.database.prepare('INSERT OR REPLACE INTO reading_clock (day, hour, count, total_ms, updated_at) VALUES (?, ?, ?, ?, ?)');
  for (let off = 0; off < 6; off += 1) {
    clockSeed.run(dayKey(off), 9, 3 + ((off * 2) % 5), 0, T0 / 1000);
    clockSeed.run(dayKey(off), 10, 2 + (off % 4), 0, T0 / 1000);
    clockSeed.run(dayKey(off), 20, 8 + (off % 6), 900000, T0 / 1000);
    clockSeed.run(dayKey(off), 21, 5 + (off % 3), 300000, T0 / 1000);
  }

  // 今日简报（生物钟行载体；计数/来源与实况一致：今日 9 篇、2 个来源）
  store._saveTodayDigest('## 总览\n\n今日读完 9 篇，慢读主线贯穿全天：上午偏方法论，下午回到工具与装备。整体节奏平稳，阅读生物钟落在上午与夜间双峰。', 9, [{ feedTitle: '组织进化评论' }, { feedTitle: '未来工作观察' }], 'brief');

  // 花园展示底料：连读多日的养成态（截图棚拍——服务计算后直接拨状态行到盛开）
  store.database.prepare(`UPDATE garden_state SET stage = 3, sun_streak = 5, water_total = 12, seed_total = 5, updated_at = ? WHERE id = 1`).run(Date.now() / 1000);

  // ── 开窗（真显示窗口截图；首启引导记账后重载）──
  const win = new BrowserWindow({
    show: false, width: 1440, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  const { registerIPCHandlers } = require('../src/main/ipc');
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await win.webContents.executeJavaScript(`localStorage.setItem('robinread.onboardingSeen', '1'); true`);
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  win.show();
  const dbg = win.webContents.debugger;
  dbg.attach();
  await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(2800);
  const run = (js) => win.webContents.executeJavaScript(`(async () => { try { return (${js}); } catch (e) { return { error: String(e.message || e) }; } })()`);
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    const p = path.join(OUT, name);
    fs.writeFileSync(p, img.toJPEG(88));
    log(`${name} 截图完成（${Math.round(fs.statSync(p).size / 1024)}KB）`);
  };
  const esc = async () => { await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(700); };
  const waitSel = async (sel, timeoutMs = 9000) => {
    for (let t = 0; t < timeoutMs; t += 250) {
      if (await run(`Boolean(document.querySelector(${JSON.stringify(sel)}))`)) return true;
      await sleep(250);
    }
    return false;
  };
  const clickFirst = async (sel) => run(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { miss: true }; el.click(); return { hit: true }; })()`);

  // ── 1. 观点对照镜（阅读器 + 镜面板）──
  await run(`window.__robinReaderOpen(${JSON.stringify(cur)})`);
  await sleep(1800);
  await clickFirst('.nj-mirror-header-btn');
  const mirrorOpen = await waitSel('.nj-mirror-sec[data-relation="contradict"]');
  await sleep(900);
  const mirChk = await run(`(() => ({ secs: document.querySelectorAll('.nj-mirror-sec').length, cards: document.querySelectorAll('.nj-mirror-card').length }))()`);
  if (mirrorOpen && (mirChk.secs || 0) >= 3) ok(`观点对照镜（区 ${mirChk.secs} / 卡 ${mirChk.cards}）`); else fail('观点对照镜', JSON.stringify({ mirrorOpen, mirChk }));
  await shot('mirror.jpg');
  await esc();

  // ── 2. 知识花园 ──
  await clickFirst('.footer-garden-btn');
  const gardenOpen = await waitSel('.nj-garden-scene svg');
  await sleep(1200);
  const gChk = await run(`(() => ({ stage: (document.querySelector('.nj-garden-stage')?.textContent || '').trim().slice(0, 12), svg: Boolean(document.querySelector('.nj-garden-scene svg')) }))()`);
  if (gardenOpen && gChk.svg) ok(`知识花园（阶段：${gChk.stage}）`); else fail('知识花园', JSON.stringify({ gardenOpen, gChk }));
  await shot('garden.jpg');

  // ── 3. 阅读挑战（花园浮层第 3 tab → 模板创建）──
  await run(`(() => { const tabs = document.querySelectorAll('.nj-garden-tab'); if (tabs.length < 3) return { miss: true, tabs: tabs.length }; tabs[2].click(); return { hit: true }; })()`);
  await waitSel('.nj-challenge-tpl');
  await clickFirst('.nj-challenge-tpl');
  const chOpen = await waitSel('[data-role="challenge-active"]');
  await sleep(900);
  const chChk = await run(`(() => ({ bar: Boolean(document.querySelector('.nj-challenge-bar-fill')), left: (document.querySelector('.nj-challenge-left')?.textContent || '').trim(), entries: document.querySelectorAll('.nj-challenge-entry').length }))()`);
  if (chOpen && chChk.bar) ok(`阅读挑战（剩余 ${chChk.left} · 书单 ${chChk.entries} 篇）`); else fail('阅读挑战', JSON.stringify({ chOpen, chChk }));
  await shot('challenge.jpg');
  await esc();

  // ── 4. 知更周刊（「更多」第二行，先保开展开）──
  await run(`(() => { const w = document.querySelector('.footer-more-wrap'); if (w && !w.classList.contains('open')) document.querySelector('.footer-more-btn')?.click(); return true; })()`);
  await sleep(500);
  await clickFirst('.footer-weekly-btn');
  const wkOpen = await waitSel('.nj-weekly-masthead');
  await sleep(1400);
  const wkChk = await run(`(() => ({ name: (document.querySelector('.nj-weekly-name')?.textContent || '').trim(), sections: document.querySelectorAll('.nj-weekly-section').length }))()`);
  if (wkOpen) ok(`知更周刊（${wkChk.name || '刊头在'} · 板块 ${wkChk.sections}）`); else fail('知更周刊', JSON.stringify(wkChk));
  await shot('weekly.jpg');
  await esc();

  // ── 5. 时间胶囊 · 开启仪式 ──
  await run(`(() => { const b = document.querySelector('.footer-capsule-btn') || document.querySelector('.nj-capsule-badge')?.closest('.footer-capsule-btn'); if (b) { b.click(); return { hit: true }; } return { miss: true }; })()`);
  const capOpen = await waitSel('#nj-capsule-view .nj-capsule-card.is-due');
  if (capOpen) await clickFirst('#nj-capsule-view .nj-capsule-card.is-due');
  const cerOpen = await waitSel('#nj-capsule-ceremony');
  await sleep(1000);
  const cerChk = await run(`(() => ({ kicker: (document.querySelector('#nj-capsule-ceremony .nj-ceremony-kicker')?.textContent || '').trim().slice(0, 24), quote: Boolean(document.querySelector('#nj-capsule-ceremony .nj-ceremony-quote')) }))()`);
  if (cerOpen && cerChk.quote) ok(`时间胶囊仪式（${cerChk.kicker}）`); else fail('时间胶囊仪式', JSON.stringify({ capOpen, cerOpen, cerChk }));
  await shot('capsule.jpg');
  await clickFirst('.nj-ceremony-later'); // 仪式不响应 Esc，先收下关闭
  await sleep(700);
  await esc(); // 再关胶囊浮层

  // ── 6. 阅读生物钟（今日简报顶部行；等异步取数落文本）──
  await run(`document.getElementById('digest-btn')?.click()`);
  await waitSel('.digest-modal [data-role="digest-clock"]');
  let clockText = '';
  for (let t = 0; t < 9000; t += 300) {
    clockText = (await run(`(document.querySelector('.digest-modal .dg-clock-text')?.textContent || '').trim()`)) || '';
    if (clockText) break;
    await sleep(300);
  }
  await sleep(1000);
  const dgChk = await run(`(() => ({ clock: (document.querySelector('.digest-modal .dg-clock-text')?.textContent || '').trim().slice(0, 24), body: document.querySelectorAll('.digest-modal .digest-body *').length }))()`);
  if (clockText) ok(`阅读生物钟（${clockText.slice(0, 24)}）`); else fail('阅读生物钟', JSON.stringify(dgChk));
  await shot('reading-clock.jpg');
  await run(`document.querySelector('.digest-modal')?.closest('.modal-overlay')?.remove()`);

  log(failures ? `DONE with ${failures} failures` : 'DONE all passed');
  app.exit(failures ? 1 : 0);
});
