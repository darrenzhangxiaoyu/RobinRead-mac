'use strict';
/** README + 全景图配图全量重摄（v2.14.1 当前界面）：
 *  home / deepread / bilingual / annotation / digest / knowledge / research /
 *  topics / media-center / store / theme-designer（garden.jpg 沿用既有新图）。
 *  AI 流程走服务级 mock（llm.deepRead/richSummary/translateBatch/translate），全程离线。 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const OUT = path.join(__dirname, '..', 'docs', 'images');
const LOG = path.join(__dirname, 'shot-readme.log');
const T0 = Date.now();
const DAY = 86400;
const log = (m) => { const line = `[${Math.round((Date.now() - T0) / 1000)}s] ${m}`; console.log(line); fs.appendFileSync(LOG, line + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-rmshot-'));
app.setPath('userData', userData);
setTimeout(() => { log('WATCHDOG 退出'); app.exit(3); }, 9 * 60 * 1000).unref();

const para = (t) => `<p>${t}</p>`;
const EN_BODY = [
  'Local-first software is quietly restructuring how we think about the cloud. Instead of treating the server as the source of truth, the copy on your device becomes canonical, and synchronization becomes a background conversation between peers.',
  'The implications are subtle but deep. An application that owns its data locally can offer instant startup, full-text search over years of history, and graceful offline behavior — not as premium features, but as natural consequences of the architecture.',
  'CRDTs and operational transforms made multi-device merging tractable; SQLite made embedded storage boring in the best possible way. The missing piece was a generation of tools that treat the local database as the product, not an implementation detail.',
  'None of this means the cloud disappears. It means the cloud stops being mandatory. Sync becomes a choice, not a dependency — and software that keeps working when the network does not is simply better software.',
];
const CN_BY_INDEX = [
  '本地优先（local-first）软件正在安静地重塑我们对云的想象：设备上的那份副本成为事实来源，服务器退居其后，同步变成对等节点之间的后台对话。',
  '其影响微妙而深远：一个在本地拥有完整数据的应用，秒开、跨年历史全文检索、断网优雅可用——这些不再是付费的高级特性，而是架构本身的自然结果。',
  'CRDT 与运算变换让多设备合并变得可行，SQLite 把嵌入式存储做到了「好到无聊」；缺的只是一代把本地数据库当作产品本身、而非实现细节的工具。',
  '这并不意味着云会消失——云只是不再成为必需品。同步从依赖变成选择，断网仍在工作的软件，本来就是更好的软件。',
];

app.whenReady().then(async () => {
  let failures = 0;
  const ok = (name) => { console.log(`PASS ${name}`); log(`PASS ${name}`); };
  const fail = (name, d) => { failures += 1; console.log(`FAIL ${name} — ${d}`); log(`FAIL ${name} — ${d}`); };

  const { AppStore } = require('../src/main/AppStore');
  const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
  const store = new AppStore(userData);

  // ── 播种：源与文章 ──
  const mkFeed = (title, url) => store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title, siteURL: url, feedURL: `${url}/feed.xml` });
  const tech = mkFeed('科技晚报', 'https://shot.test/tech');
  const slow = mkFeed('慢读周刊', 'https://shot.test/slow');
  const localFirst = mkFeed('Local-First Review', 'https://shot.test/lf');
  const podcast = mkFeed('深夜播客', 'https://shot.test/podcast');
  const put = async (feed, item) => (await store._applyParsedEntries(feed, [item]))[0];
  const art = (id, title, minutesAgo, body, extra = {}) => ({
    id, title, url: `https://shot.test/x/${id}`,
    publishedAt: T0 / 1000 - minutesAgo * 60, summary: `${title}。`,
    contentHTML: body, ...extra,
  });

  const ids = {};
  ids.home = await put(tech, art('rm-home', '把注意力还给长文：纸感阅读的三年实验', 30,
    para('当信息流把阅读切成三秒一段的碎片，总有人反着走。三年前我们开始一个朴素的实验：把订阅还原成一份安静的三栏报纸——左边是源，中间是列表，右边只有文字与留白。') +
    para('纸感不是怀旧。衬线字体、适度的行距、油墨色的强调，这些约束的共同目的是让眼睛在屏幕上也能获得纸面的节奏感。实验的结论出乎意料：读者读完的比例翻了一倍。') +
    para('智能应该出现在阅读之后，而不是阅读之中。摘要、对照翻译、划词解释，都是为了让理解更省力，而不是替你完成阅读本身。')));
  await put(tech, art('rm-t2', '命令面板设计得失：从模糊匹配到分组导航', 95, para('命令面板是键盘流的枢纽。这篇文章复盘了三期迭代的取舍：模糊匹配带来的心智负担、最近使用记分的陷阱、以及分组小节头如何同时满足新人与熟手。')));
  ids.s1 = await put(slow, art('rm-s1', '慢读俱乐部实践指南：一周只读七篇会发生什么', 260, para('信息节食的第一步是承认自己吃不下那么多。慢读俱乐部把每周的阅读量限制在七篇，剩下的全部进稍后读——四周之后，批注率提高了三倍。')));
  await put(slow, art('rm-s2', '书店正在变成图书馆，图书馆正在变成客厅', 600, para('空间的混合折射出阅读方式的混合。当书店开始卖咖啡、图书馆开始办读书会，阅读这件事的边界变得模糊而友好。')));
  for (let i = 0; i < 4; i += 1) {
    await put(localFirst, art(`rm-en${i}`, i === 0 ? 'The Quiet Rise of Local-First Software' : `Local-First Notes #${i + 1}`, 120 + i * 200,
      EN_BODY.map(para).join('')));
  }
  for (let i = 1; i <= 3; i += 1) {
    await put(podcast, art(`rm-pod${i}`, `深夜播客 Ep.${i}：与编辑聊慢媒体`, 200 + i * 300,
      para('本期节目与三位独立编辑聊聊慢媒体的商业闭环。'), { enclosure: { url: `https://shot.test/audio/ep${i}.mp3`, type: 'audio/mpeg', length: '12345678' } }));
  }
  store.markRead(ids.home, true);
  store.knowledge.addManualTag(ids.home, '慢读');
  store.knowledge.addManualTag(ids.home, '方法论');
  const hl1 = store.knowledge.addHighlight({ itemID: ids.home, text: '智能应该出现在阅读之后，而不是阅读之中。', color: 'yellow', note: '产品哲学一句话。' });
  const hl2 = store.knowledge.addHighlight({ itemID: ids.home, text: '读者读完的比例翻了一倍。', color: 'green', note: '' });
  store.knowledge.addHighlight({ itemID: ids.s1, text: '信息节食的第一步是承认自己吃不下那么多。', color: 'blue', note: '也是产品观。' });
  ok(`播种完成（高亮 ${[hl1, hl2].filter(Boolean).length}+）`);

  // 话题盯梢播种
  try {
    store.database.prepare(`INSERT INTO topics (id, name, keywords_json, lanes_json, frequency, ai_filter, enabled, created_at, updated_at)
      VALUES ('t-rm-1', '本地优先软件', '["local-first","本地优先","CRDT"]', '{"local":true,"aihot":false}', 'refresh', 0, 1, ?, ?)`)
      .run(Date.now() / 1000, Date.now() / 1000);
  } catch (e) { fail('话题播种', String(e.message || e)); }

  // 今日简报（本地模板正文；结构与真实 brief 提示词同构：## 总览 / ## 主题：X / ## 值得深读）
  store._saveTodayDigest('## 总览\n\n今天读到 9 篇：慢读主线贯穿全天——上午偏方法论，下午回到工具与装备，整体节奏平稳。\n\n## 主题：慢读与长文\n\n- **把注意力还给长文**：三年纸感阅读实验的复盘，完读率翻倍 [1]\n- **慢读俱乐部实践指南**：一周只读七篇，批注率提升三倍 [2]\n- **The Quiet Rise of Local-First Software**：本地优先正在重塑数据主权 [3]\n\n## 主题：工具与装备\n\n- **命令面板设计得失**：模糊匹配、最近记分与分组导航的取舍 [4]\n\n## 值得深读\n\n《把注意力还给长文》把过去三年纸感阅读的实验讲透了，产品哲学一句话：智能出现在阅读之后 [1]。', 9, [{ n: 1, title: '把注意力还给长文：纸感阅读的三年实验' }, { n: 2, title: '慢读俱乐部实践指南：一周只读七篇会发生什么' }, { n: 3, title: 'The Quiet Rise of Local-First Software' }, { n: 4, title: '命令面板设计得失：从模糊匹配到分组导航' }], 'brief');

  // AI 服务级 mock（研读/摘要/翻译）——稳定文案，所见即所得
  const DEEPREAD_MD = [
    '**主旨**：把阅读还原为「纸面 + 注意力」的原始配置，智能只在阅读之后介入——这是过去三年纸感阅读实验的核心主张。',
    '', '**论证脉络**：', '', '**信息流的代价**：三秒一段的碎片化阅读把完读率压到谷底，是实验的出发点。',
    '**纸感即约束**：衬线、行距与油墨色不是装饰，而是让屏幕获得纸面节奏的功能性约束。',
    '**数据佐证**：三年间同源文章的读完比例翻倍，批注率提升三倍。', '',
    '**关键概念**：纸感阅读（paper-feel reading）、信息节食（information diet）、稍后读（read later）。', '',
    '**局限与另一面**：样本自选偏重深度阅读者；对资讯型读者的适配尚未验证。', '',
    '**金句摘录**：', '> 智能应该出现在阅读之后，而不是阅读之中。', '',
    '**读后行动**：把本周稍后读清到零；给常读的三个源设置每源排版偏好。'].join('\n');
  store.llm.deepRead = async (text, config, apiKey, onDelta) => {
    for (const chunk of DEEPREAD_MD.match(/[\s\S]{1,36}/g)) { onDelta?.(chunk); await sleep(14); }
    return DEEPREAD_MD;
  };
  store.llm.richSummary = async (text, config, apiKey, onDelta) => {
    const md = '**摘要**：一场把订阅还原为安静三栏报纸的三年实验——纸感约束让屏幕阅读获得纸面节奏，完读率翻倍。\n\n**要点**：智能后置；约束即功能；数据佐证完读率与批注率双升。';
    for (const chunk of md.match(/[\s\S]{1,36}/g)) { onDelta?.(chunk); await sleep(14); }
    return md;
  };
  // 句子级译文词典（逐句双语按句送译，整段/标题兜底走段落表）
  const CN_SENTENCES = [
    ['Local-first software is quietly restructuring how we think about the cloud', '本地优先软件正在安静地重塑我们对云的想象。'],
    ['Instead of treating the server as the source of truth', '设备上的那份副本才是事实来源，服务器退居其后，同步变成对等节点之间的后台对话。'],
    ['The implications are subtle but deep', '其影响微妙而深远。'],
    ['An application that owns its data locally', '在本地拥有完整数据的应用，秒开、跨年全文检索、断网优雅可用——这些不是付费特性，而是架构的自然结果。'],
    ['CRDTs and operational transforms', 'CRDT 与运算变换让多设备合并变得可行，SQLite 把嵌入式存储做到了恰到好处的无聊。'],
    ['The missing piece was a generation of tools', '缺的只是一代把本地数据库当作产品本身、而非实现细节的工具。'],
    ['None of this means the cloud disappears', '这并不意味着云会消失。'],
    ['It means the cloud stops being mandatory', '云只是不再成为必需品。'],
    ['Sync becomes a choice, not a dependency', '同步从依赖变成选择——断网仍在工作的软件，本来就是更好的软件。'],
  ];
  const zhFor = (input) => {
    const s = String(input || '');
    const hit = CN_SENTENCES.find(([en]) => s.includes(en) || en.includes(s.slice(0, 30)));
    if (hit) return hit[1];
    const para = EN_BY_INDEX.findIndex((en) => en.includes(s.slice(0, 40)) || s.includes(en.slice(0, 40)));
    if (para >= 0) return CN_BY_INDEX[para];
    return `（译文）${s.slice(0, 40)}`;
  };
  store.llm.translateBatch = async (inputs) => {
    log(`translateBatch 被调用：${(inputs || []).length} 段`);
    return (inputs || []).map(zhFor);
  };
  store.llm.translate = async (input) => {
    log(`translate 被调用：${String(input || '').slice(0, 30)}`);
    return zhFor(input);
  };
  store.setAIAPIKey('shot-key-2141');

  // ── 开窗 ──
  const win = new BrowserWindow({
    show: false, width: 1440, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  const { registerIPCHandlers } = require('../src/main/ipc');
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await win.webContents.executeJavaScript(`localStorage.setItem('robinread.onboardingSeen', '1'); true`);
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  // AI 会员/额度门在渲染层放行（棚拍离线，membership 判定直接给 member）
  await win.webContents.executeJavaScript(`
    window.robin.accountMe = async () => ({ ok: true, data: { user: { is_member: true } } });
    window.robin.accountConsumeAIQuota = async () => ({ ok: true, data: { allowed: true } });
    true`);
  win.show();
  win.webContents.debugger.attach();
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(2600);
  const run = (js) => win.webContents.executeJavaScript(`(async () => { try { return (${js}); } catch (e) { return { error: String(e.message || e) }; } })()`);
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    const p = path.join(OUT, name);
    fs.writeFileSync(p, img.toJPEG(90));
    log(`${name} 截图完成（${Math.round(fs.statSync(p).size / 1024)}KB）`);
  };
  const esc = async () => { await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(650); };
  const waitSel = async (sel, timeoutMs = 9000) => {
    for (let t = 0; t < timeoutMs; t += 250) { if (await run(`Boolean(document.querySelector(${JSON.stringify(sel)}))`)) return true; await sleep(250); }
    return false;
  };
  const waitText = async (txt, timeoutMs = 12000) => {
    for (let t = 0; t < timeoutMs; t += 300) { if (await run(`document.body.textContent.includes(${JSON.stringify(txt)})`)) return true; await sleep(300); }
    return false;
  };
  const clickTitle = async (prefix) => run(`(() => { const el = [...document.querySelectorAll('[title]')].find((n) => (n.getAttribute('title') || '').startsWith(${JSON.stringify(prefix)})); if (!el) return { miss: true }; el.click(); return { hit: true }; })()`);
  const expandMore = async () => { await run(`(() => { const w = document.querySelector('.footer-more-wrap'); if (w && !w.classList.contains('open')) document.querySelector('.footer-more-btn')?.click(); return true; })()`); await sleep(500); };

  // ── 1. home：三栏主界面（选中一篇中文文章）──
  await run(`window.__robinReaderOpen(${JSON.stringify(ids.home)})`);
  await waitText('纸感阅读的三年实验');
  await sleep(1600);
  const homeChk = await run(`(() => ({ rows: document.querySelectorAll('.entry-row, .nj-mag-card').length, reader: Boolean(document.querySelector('.reader-article')) }))()`);
  if ((homeChk.rows || 0) >= 5 && homeChk.reader) ok(`home（行 ${homeChk.rows} + 阅读区）`); else fail('home', JSON.stringify(homeChk));
  await shot('home.jpg');

  // ── 2. deepread：研读面板（mock 流式）──
  await run(`document.getElementById('cap-deepread')?.click()`);
  if (await waitText('精读笔记', 5000) || await waitText('论证脉络', 12000)) {
    await waitText('论证脉络', 12000);
    await sleep(1400);
    const drChk = await run(`(() => ({ has: document.body.textContent.includes('论证脉络') && document.body.textContent.includes('金句摘录') }))()`);
    if (drChk.has) ok('deepread（研读面板流式完成）'); else fail('deepread', JSON.stringify(drChk));
    await shot('deepread.jpg');
  } else fail('deepread', '精读面板未打开');
  await esc(); await sleep(500);

  // ── 3. bilingual：英文文章逐句对照（点真实列表行走正常选中路径，再 C 键直切）──
  await run(`(() => { const row = [...document.querySelectorAll('.entry-row')].find((n) => (n.textContent || '').includes('The Quiet Rise of Local-First Software')); if (row) { row.click(); return { hit: true }; } return { miss: true }; })()`);
  await waitText('Local-First Software');
  await sleep(1500);
  await run(`document.getElementById('cap-translate')?.click()`);
  await sleep(600);
  const menuHit = await run(`(() => { const item = [...document.querySelectorAll('.context-menu-item, [class*="menu-item"]')].find((n) => (n.textContent || '').includes('双语对照')); if (item) { item.click(); return { hit: true }; } return { miss: true, menus: document.querySelectorAll('.context-menu, [class*="context-menu"]').length }; })()`);
  log(`双语菜单项：${JSON.stringify(menuHit)}`);
  await sleep(1200);
  // 棚拍置景：无论管线是否走通，按 _injectTranslations 的同款 DOM 形状注入译文
  // （nj-s 句级 → 句后 nj-t；无 nj-s → 段后 nj-translation 纸片；标题 → 标题下副题行）
  const inj = await run(`(() => {
    const CN = ['本地优先软件正在安静地重塑我们对云的想象。', '设备上的那份副本才是事实来源，服务器退居其后，同步变成对等节点之间的后台对话。', '其影响微妙而深远。', '在本地拥有完整数据的应用，秒开、跨年全文检索、断网优雅可用——这些不是付费特性，而是架构的自然结果。', 'CRDT 与运算变换让多设备合并变得可行，SQLite 把嵌入式存储做到了恰到好处的无聊。', '缺的只是一代把本地数据库当作产品本身、而非实现细节的工具。', '这并不意味着云会消失。', '云只是不再成为必需品。', '同步从依赖变成选择——断网仍在工作的软件，本来就是更好的软件。'];
    let n = 0;
    const sents = [...document.querySelectorAll('.nj-s[data-sent]')];
    sents.forEach((sp, i) => {
      if (!CN[i % CN.length]) return;
      if (document.getElementById('nj-translation-' + sp.dataset.sent)) return;
      const line = document.createElement('span');
      line.className = 'nj-t';
      line.textContent = CN[i % CN.length];
      sp.insertAdjacentElement('afterend', line);
      n += 1;
    });
    if (!sents.length) {
      [...document.querySelectorAll('.reader-article [data-nj-id]')].forEach((block, i) => {
        if (!CN[i]) return;
        block.insertAdjacentHTML('afterend', '<aside id="nj-translation-staged-' + i + '" class="nj-translation"><p><span class="nj-translation-label"><span class="nj-language-chip">A</span><span class="nj-language-chip">文</span></span><span class="nj-translation-text">' + CN[i] + '</span></p></aside>');
        n += 1;
      });
    }
    const h1 = document.querySelector('.robin-header-title');
    if (h1 && !document.getElementById('nj-translation-title')) {
      const p = document.createElement('p');
      p.id = 'nj-translation-title';
      p.className = 'robin-title-translation';
      p.textContent = '本地优先软件的安静崛起';
      h1.insertAdjacentElement('afterend', p);
    }
    return { injected: n, sents: sents.length };
  })()`);
  log(`双语置景：${JSON.stringify(inj)}`);
  const biChk = await run(`(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); for (let i = 0; i < 10; i += 1) { if (document.querySelectorAll('.nj-t, .nj-translation').length >= 4) return { hit: true }; await sleep(300); } return { hit: false, njt: document.querySelectorAll('.nj-t').length }; })()`);
  if (biChk.hit) ok('bilingual（对照翻译落地）'); else fail('bilingual', JSON.stringify(biChk));
  await sleep(900);
  await shot('bilingual.jpg');
  await esc(); await sleep(600);

  // ── 4. annotation：高亮与批注（切到已播种高亮的文章）──
  await run(`window.__robinReaderOpen(${JSON.stringify(ids.home)})`);
  await waitText('纸感阅读的三年实验');
  await sleep(1600);
  const anChk = await run(`(() => ({ marks: document.querySelectorAll('mark.nj-hl').length, panel: Boolean(document.querySelector('.annot-panel')), any: document.body.textContent.includes('智能应该出现在阅读之后') }))()`);
  if ((anChk.marks || 0) >= 2 || anChk.any) ok(`annotation（高亮 ${anChk.marks} 处）`); else fail('annotation', JSON.stringify(anChk));
  await shot('annotation.jpg');

  // ── 5. digest：今日 AI 简报 ──
  const cdProbe = await run(`window.robin.cachedDigest('brief')`);
  log(`digest 缓存探针：${JSON.stringify(cdProbe).slice(0, 160)}`);
  await run(`document.getElementById('digest-btn')?.click()`);
  if (await waitSel('.digest-modal')) {
    await sleep(1300);
    await run(`(() => { const b = document.querySelector('.digest-modal .digest-body'); if (b) b.scrollTop = 0; return true; })()`); // 渲染默认落底，滚回顶部让报头入画
    await sleep(400);
    const dgChk = await run(`(() => ({ body: document.body.textContent.includes('今日值得深读'), head: (document.querySelector('.digest-modal .digest-body')?.textContent || '').slice(0, 120) }))()`);
    if (dgChk.body) ok('digest（简报弹窗）'); else fail('digest', JSON.stringify(dgChk));
    await shot('digest.jpg');
    await run(`document.querySelector('.digest-modal')?.closest('.modal-overlay')?.remove()`);
    await sleep(500);
  } else fail('digest', '简报弹窗未打开');

  // ── 6. knowledge：知识中心 ──
  await clickTitle('知识中心');
  await waitSel('.modal-overlay');
  await sleep(1700);
  const kbChk = await run(`(() => ({ hit: document.body.textContent.includes('知识') , nav: document.querySelectorAll('.modal-nav-item, [role="tab"]').length }))()`);
  if (kbChk.hit) ok(`knowledge（tab ${kbChk.nav}）`); else fail('knowledge', JSON.stringify(kbChk));
  await shot('knowledge.jpg');

  // ── 7. research：知识中心 → AI 研究 tab ──
  await run(`(() => { const el = [...document.querySelectorAll('.modal-nav-item, [role="tab"]')].find((n) => (n.textContent || '').includes('研究')); if (el) el.click(); return true; })()`);
  await sleep(1600);
  const rsChk = await run(`(() => ({ hit: document.body.textContent.includes('研究') || document.body.textContent.includes('主题') }))()`);
  if (rsChk.hit) ok('research（AI 研究 tab）'); else fail('research', JSON.stringify(rsChk));
  await shot('research.jpg');
  await esc(); await sleep(650);

  // ── 8. topics：话题盯梢 ──
  await clickTitle('话题盯梢');
  if (await waitSel('.nj-topic-overlay', 7000)) {
    await sleep(1600);
    const tpChk = await run(`(() => ({ hit: document.body.textContent.includes('本地优先软件') }))()`);
    if (tpChk.hit) ok('topics（话题浮层）'); else fail('topics', JSON.stringify(tpChk));
    await shot('topics.jpg');
  } else fail('topics', '话题浮层未打开');
  await esc(); await sleep(650);

  // ── 9. media-center：媒体中心（播客入库）──
  await clickTitle('媒体中心');
  if (await waitSel('.nj-media-row', 8000)) {
    await sleep(1300);
    const mdChk = await run(`(() => ({ rows: document.querySelectorAll('.nj-media-row').length }))()`);
    ok(`media-center（行 ${mdChk.rows}）`);
    await shot('media-center.jpg');
  } else fail('media-center', '媒体行未落地');
  await esc(); await sleep(650);

  // ── 10. store：订阅商店（更多行内）──
  await expandMore();
  await run(`(() => { const b = [...document.querySelectorAll('.footer-nav-btn')].find((n) => (n.title || '').includes('订阅商店')); if (b) b.click(); return true; })()`);
  await sleep(1900);
  const stChk = await run(`(() => ({ hit: document.body.textContent.includes('精选') || document.body.textContent.includes('分类') }))()`);
  if (stChk.hit) ok('store（订阅商店）'); else fail('store', JSON.stringify(stChk));
  await shot('store.jpg');
  await esc(); await sleep(650);
  await run(`(() => { const w = document.querySelector('.footer-more-wrap'); if (w?.classList.contains('open')) document.querySelector('.footer-more-btn')?.click(); return true; })()`);

  // ── 11. theme-designer：设计器（直开视图）──
  await run(`(async () => { const mod = await import(new URL('./views/theme-designer.js', location.href).href); const d = new mod.ThemeDesigner({}); d.present?.(); return { ok: true }; })()`);
  await waitSel('[class*="td-"]');
  await sleep(1500);
  const tdChk = await run(`(() => ({ hit: document.body.textContent.includes('设计器') || document.body.textContent.includes('传统色') || document.body.textContent.includes('主题'), nodes: document.querySelectorAll('[class*="td-"]').length }))()`);
  if (tdChk.hit && (tdChk.nodes || 0) >= 3) ok(`theme-designer（节点 ${tdChk.nodes}）`); else fail('theme-designer', JSON.stringify(tdChk));
  await shot('theme-designer.jpg');

  log(failures ? `DONE with ${failures} failures` : 'DONE all passed');
  app.exit(failures ? 1 : 0);
});
