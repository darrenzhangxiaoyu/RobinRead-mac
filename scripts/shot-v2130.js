'use strict';
/** v2.13.0 README 配图：媒体中心 / 话题盯梢 / 智能精选 / AI 深度研究 / 设置 2.0 / 季节套包。
 *  输出 docs/images/{media-center,topics,picks,research,settings-v2,theme-season}.jpg */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

const OUT = path.join(__dirname, '..', 'docs', 'images');
const LOG = path.join(__dirname, 'shot-v2130.log');
const T0 = Date.now();
const log = (m) => { const line = `[${Math.round((Date.now() - T0) / 1000)}s] ${m}`; console.log(line); fs.appendFileSync(LOG, line + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-shot-'));
app.setPath('userData', userData);

const mkItem = (i, enclosure) => `
  <item><title>文章标题 ${i}：从模型到智能体的工程实践</title><link>https://example.com/p/${i}</link>
  <pubDate>${new Date(Date.now() - i * 3600e3).toUTCString()}</pubDate>
  <description>第 ${i} 篇文章摘要。</description>
  ${enclosure || ''}
  <content:encoded><![CDATA[<p>这是第 ${i} 篇文章的正文，包含足够的文字用于展示阅读排版、智能精选排名与媒体卡片。纸感三栏阅读器把散落的订阅还原为一个安静、清晰的阅读空间，让注意力回到文字本身。智能体工程化的每一步都值得记录：从提示词到工具调用，从单轮问答到多步规划。</p>]]></content:encoded></item>`;

const PODCAST = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>科技深夜谈（播客）</title><link>https://example.com/podcast</link>
${[1, 2, 3].map((i) => mkItem(i, `<enclosure url="https://example.com/audio/ep${i}.mp3" type="audio/mpeg" length="12345678"/>`)).join('\n')}
</channel></rss>`;

const WEEKLY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>科技前沿周刊</title><link>https://example.com/weekly</link>
${[11, 12, 13, 14, 15, 16, 17, 18].map((i) => mkItem(i)).join('\n')}
</channel></rss>`;

setTimeout(() => { log('WATCHDOG 退出'); app.exit(3); }, 8 * 60 * 1000).unref();

app.whenReady().then(async () => {
  let failures = 0;
  const ok = (name) => console.log(`PASS ${name}`);
  const fail = (name, d) => { failures += 1; console.log(`FAIL ${name} — ${d}`); };

  const { AppStore } = require('../src/main/AppStore');
  const { parse: parseFeed } = require('../src/main/FeedParser');
  const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
  const store = new AppStore(userData);

  const podcast = store.feedsRepo.insertFeed({
    accountID: LOCAL_ACCOUNT_ID, title: '科技深夜谈（播客）', siteURL: 'https://example.com/podcast',
    feedURL: 'https://example.com/podcast/feed.xml',
  });
  store._applyParsedEntries(podcast, parseFeed(PODCAST, 'https://example.com/podcast/feed.xml').entries);
  const weekly = store.feedsRepo.insertFeed({
    accountID: LOCAL_ACCOUNT_ID, title: '科技前沿周刊', siteURL: 'https://example.com/weekly',
    feedURL: 'https://example.com/weekly/feed.xml',
  });
  store._applyParsedEntries(weekly, parseFeed(WEEKLY, 'https://example.com/weekly/feed.xml').entries);
  // 话题盯梢播种一条（本地+AIHOT 双道）
  try {
    store.database.prepare(`INSERT INTO topics (id, name, keywords_json, lanes_json, frequency, ai_filter, enabled, created_at, updated_at)
      VALUES ('t-shot-1', '智能体工程化', '["智能体","Agent","大模型"]', '{"local":true,"aihot":true}', 'refresh', 0, 1, ?, ?)`)
      .run(Date.now() / 1000, Date.now() / 1000);
    ok('话题已播种');
  } catch (e) { fail('话题播种', String(e.message || e)); }

  const win = new BrowserWindow({
    show: false, width: 1440, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  const { registerIPCHandlers } = require('../src/main/ipc');
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  // 隐藏窗口里 rAF 永不触发（浮层可见类/图表入场全卡住）——真实显示窗口截图，帧管线完整。
  // reduced-motion 仿真保留：跳过入场动画，即开即拍。
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
  const clickTitle = async (prefix) => run(`(() => { const el = [...document.querySelectorAll('[title]')].find((n) => (n.getAttribute('title') || '').startsWith(${JSON.stringify(prefix)})); if (!el) return { miss: true }; el.click(); return { hit: true }; })()`);
  /** 等浮层出现（present 异步取数后才挂 overlay，盲等不可靠）。 */
  const waitOverlay = async (sel, timeoutMs = 6000) => {
    for (let t = 0; t < timeoutMs; t += 250) {
      const hit = await run(`Boolean(document.querySelector(${JSON.stringify(sel)}))`);
      if (hit) return true;
      await sleep(250);
    }
    return false;
  };

  // ── 1. 媒体中心 ──
  const mediaClick = await clickTitle('媒体中心（播客 / 视频）');
  const mediaOpen = await waitOverlay('.nj-media-row', 8000); // 等媒体行落地（列表异步加载）
  const mediaChk = await run(`(() => ({ items: document.querySelectorAll('.nj-media-row').length }))()`);
  if (mediaOpen && !mediaChk.error) ok(`媒体中心（条目 ${mediaChk.items}）`); else fail('媒体中心', JSON.stringify({ mediaClick, mediaOpen, mediaChk }));
  await shot('media-center.jpg');
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(600);

  // ── 2. 话题盯梢 ──
  const topicClick = await clickTitle('话题盯梢');
  const topicOpen = await waitOverlay('.nj-topic-overlay', 6000);
  await sleep(1500); // 等信息流/管理列表异步落地
  const topicChk = await run(`(() => ({ hit: document.body.textContent.includes('智能体工程化'), rows: document.querySelectorAll('.nj-topic-overlay *').length }))()`);
  if (topicOpen && topicChk.hit) ok('话题盯梢'); else fail('话题盯梢', JSON.stringify({ topicClick, topicOpen, topicChk }));
  await shot('topics.jpg');
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(600);

  // ── 3. 智能精选（先读一篇建行为，再开精选）──
  await run(`window.__robinReaderOpen?.((window.robin && 0) || document.querySelector('.entry-row')?.dataset?.id || '')`);
  await sleep(2000);
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(800);
  await run(`document.getElementById('picks-btn')?.click()`);
  await sleep(2000);
  const picksChk = await run(`(() => ({ title: document.body.textContent.includes('智能精选'), rows: document.querySelectorAll('.entry-row, .nj-mag-card').length }))()`);
  if (picksChk.title) ok(`智能精选（行 ${picksChk.rows}）`); else fail('智能精选', JSON.stringify(picksChk));
  await shot('picks.jpg');
  await run(`document.getElementById('picks-btn')?.click()`);
  await sleep(800);

  // ── 4. AI 深度研究（知识中心 → AI 研究 tab）──
  await clickTitle('知识中心');
  await sleep(1800);
  const tabClick = await run(`(() => { const el = [...document.querySelectorAll('.modal-nav-item, .kb-tab, [role="tab"]')].find((n) => n.textContent.includes('AI 研究') || n.textContent.includes('研究')); if (!el) return { miss: true }; el.click(); return { hit: true, label: el.textContent.trim().slice(0, 20) }; })()`);
  await sleep(1500);
  const resChk = await run(`(() => ({ hit: document.body.textContent.includes('深度研究') || document.body.textContent.includes('研究') }))()`);
  if (resChk.hit) ok(`AI 研究（tab=${tabClick.label || 'n/a'}）`); else fail('AI 研究', JSON.stringify({ tabClick, resChk }));
  await shot('research.jpg');
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(600);

  // ── 5. 设置中心 2.0 ──
  win.webContents.send('menu:openSettings');
  await sleep(1800);
  const setChk = await run(`(() => ({ nav: document.querySelectorAll('.modal-nav-item').length, search: Boolean(document.querySelector('.settings-search input')) }))()`);
  if (setChk.nav >= 8 && setChk.search) ok(`设置 2.0（分区 ${setChk.nav} + 搜索框）`); else fail('设置 2.0', JSON.stringify(setChk));
  await shot('settings-v2.jpg');

  // ── 6. 季节套包（设置 → 外观 → 主题预案区滚到季节分区；不打开设计器编辑器）──
  const seasonVisible = await waitOverlay('.td-season-head', 6000);
  await run(`document.querySelector('.td-season-head')?.scrollIntoView({ block: 'center' })`);
  await sleep(900);
  const seasonChk = await run(`(() => ({ season: document.body.textContent.includes('季节套包'), spring: document.body.textContent.includes('竹青'), cards: document.querySelectorAll('.td-season-grid .td-card').length, inView: (() => { const r = document.querySelector('.td-season-head')?.getBoundingClientRect(); return r ? (r.top >= 0 && r.top < window.innerHeight) : false; })() }))()`);
  if ((seasonChk.season || seasonChk.spring) && seasonChk.inView) ok(`季节套包在册（卡 ${seasonChk.cards}）`); else fail('季节套包', JSON.stringify({ seasonVisible, seasonChk }));
  await shot('theme-season.jpg');

  log(failures ? `DONE with ${failures} failures` : 'DONE all passed');
  app.exit(failures ? 1 : 0);
});
