'use strict';
/**
 * diag-f12-books.js — F12 个人文集自动成书端到端探针（run-all OFFLINE 集，全程离线）
 *
 * 覆盖（对应 F12 探针 10 条）：
 *  1 v19 迁移：books 表就位/列齐全 + 幂等重入 + 老库（v18 止）升级无损
 *  2 文集 CRUD（create/list/update/addFeeds 幂并集）+ 右键「加入文集」子菜单项（既有文集 + 新建入口）
 *  3 成书：60 篇跨 3 个月 → EPUB 合法（zip 结构/mimetype 首条无压缩/nav 目录/3 个月分章/60 篇）
 *    + 1000 篇 → 5 卷 vol.1–5 每卷 200（确定性）；封面：源 icon 命中 → images/cover.png，未命中 → 纯色 cover.svg
 *  4 自动成书：auto 文集刷新 kick 成功 + 24h 节流（注入 last_built_at）+ 无新文章不成 + manual 永不自动
 *  5 书架 UI：书列表/「待取」徽标/立即成书/打开目录/删除按钮渲染；打开目录 shell.showItemInFolder（mock）
 *  6 既有整期 EPUB 导出回归 → diag-phase10-export（独立探针，run-all 常驻）
 *  7 成书耗时：200 篇 < 2s
 *  8 右键加入文集的 feed_ids 持久化（独立只读连接回读）
 *  9 userData/books/<id>/ 自动目录落盘（userData 白名单内）+ showItemInFolder 调用与「待取」清除
 * 10 删除文集：books 行删 + userData/books/<id> 清理 + 用户 pickSavePath 落盘的书保留
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, dialog, shell, BrowserWindow } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f12-app-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 300 * 1000).unref();

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const N = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
/** 极简 ZIP 解析（EpubBuilder 全 store 无压缩：顺序读 local file header）。 */
function zipEntries(buf) {
  const entries = [];
  let off = 0;
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break;
    const method = buf.readUInt16LE(off + 8);
    const csize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;
    entries.push({ name, method, data: buf.slice(dataStart, dataStart + csize) });
    off = dataStart + csize;
  }
  return entries;
}
const entryText = (entries, name) => {
  const hit = entries.find((e) => e.name === name);
  return hit ? hit.data.toString('utf8') : null;
};
const TinyPNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

app.whenReady().then(async () => {
  const cleanup = [userData];
  const realShowSave = dialog.showSaveDialog;
  const realShowItem = shell.showItemInFolder;
  const realOpenPath = shell.openPath;
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { LOCAL_ACCOUNT_ID, stableDigest, nowSeconds } = require('../src/main/Models');
    const { MIGRATIONS } = require('../src/main/Persistence/DatabaseMigrations');
    const { DatabaseSync } = require('node:sqlite');
    const { VOLUME_SIZE, monthChapterTitle, volumeFileName } = require('../src/main/BooksService');

    // ── 预置：源 icon 磁盘缓存（feeder 走「源 icon 封面」路径；另一源无 icon 走纯色回退）──
    const iconKey = stableDigest('https://cover.test/icon.png|https://cover.test|https://cover.test/feed.xml|cover.test');
    fs.mkdirSync(path.join(userData, 'favicons'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'favicons', `${iconKey}.txt`), `data:image/png;base64,${TinyPNG_B64}`, 'utf8');

    const store = new AppStore(userData);
    await new Promise((r) => setTimeout(r, 1500)); // 等启动自愈批处理落地

    // ── 灌数：主源（带 icon 缓存）+ 次源 ──
    const feed = store.feedsRepo.insertFeed({
      accountID: LOCAL_ACCOUNT_ID, title: 'F12 周刊', siteURL: 'https://cover.test',
      feedURL: 'https://cover.test/feed.xml', storedIconURL: 'https://cover.test/icon.png',
    });
    const feedB = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F12 副刊', feedURL: 'https://b.test/feed.xml' });

    // 隐藏窗口 + 真 IPC（preload），与 F11 探针同构
    const win = new BrowserWindow({
      show: false, width: 1100, height: 820,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
    });
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, win);
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    await new Promise((r) => setTimeout(r, 900));
    const ipc = (expr, label) => Promise.race([
      win.webContents.executeJavaScript(expr),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`IPC 超时（${label || expr.slice(0, 50)}…）`)), 25000)),
    ]);
    const mkEntry = (feedRef, suffix, title, publishedAt) => store.articlesRepo.upsertEntry({
      id: `local:${feedRef.id}:${suffix}`, accountID: LOCAL_ACCOUNT_ID, externalID: `local:${feedRef.id}:${suffix}`, feedID: feedRef.id,
      title, url: `https://x.test/${suffix}`, publishedAt, summary: '', contentHTML: `<p>${title} 的正文段落。</p><blockquote>引文。</blockquote>`,
    });

    // ══ 1. v19 迁移 + 幂等 + 老库无损 ══
    {
      const applied = store.database.prepare("SELECT id FROM schema_migrations WHERE id = 'v19-books'").get();
      ok(!!applied, '1 v19-books 迁移已登记');
      const cols = store.database.prepare("PRAGMA table_info(books)").all().map((c) => c.name);
      ok(['id', 'title', 'feed_ids_json', 'schedule', 'last_built_at', 'last_entry_count', 'created_at', 'updated_at']
        .every((c) => cols.includes(c)), `1 books 列齐全（${cols.join(',')}）`);
      // 幂等：重跑全部迁移不报错、登记数不变
      const before = store.database.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
      const { runMigrations } = require('../src/main/Persistence/DatabaseMigrations');
      runMigrations(store.database.db);
      const after = store.database.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
      ok(before === after, `1 幂等重入：迁移登记数不变（${before}）`);
      // 老库（v18 止）升级：手工补齐 v1–v18 + 灌数据 → 新开 AppStore（自动补 v19）→ 数据无损
      const dirOld = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f12-old-'));
      cleanup.push(dirOld);
      const raw = new DatabaseSync(path.join(dirOld, 'library.db'));
      raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY NOT NULL, applied_at REAL NOT NULL);`);
      for (const mig of MIGRATIONS.slice(0, -1)) {
        raw.exec('BEGIN');
        mig.up(raw);
        raw.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(mig.id, N());
        raw.exec('COMMIT');
      }
      raw.exec(`INSERT INTO accounts (id, type, display_name, is_enabled, created_at, updated_at)
        VALUES ('${LOCAL_ACCOUNT_ID}', 'local', '本机', 1, ${N()}, ${N()})`);
      raw.exec(`INSERT INTO feeds (id, account_id, title, feed_url, updated_at)
        VALUES ('feed-old', '${LOCAL_ACCOUNT_ID}', '老库源', 'https://old.test/feed.xml', ${N()})`);
      raw.exec(`INSERT INTO items (id, account_id, external_id, feed_id, created_at, updated_at)
        VALUES ('local:feed-old:legacy', '${LOCAL_ACCOUNT_ID}', 'local:feed-old:legacy', 'feed-old', ${N()}, ${N()})`);
      raw.exec(`INSERT INTO articles (item_id, title, url, published_at, summary, content_updated_at)
        VALUES ('local:feed-old:legacy', '老库文章', 'https://old.test/a', ${N()}, '摘要', ${N()})`);
      raw.close();
      const storeOld = new AppStore(dirOld);
      await new Promise((r) => setTimeout(r, 1200));
      const migrated = storeOld.database.prepare("SELECT id FROM schema_migrations WHERE id = 'v19-books'").get();
      const legacyFeed = storeOld.database.prepare("SELECT title FROM feeds WHERE id = 'feed-old'").get();
      const legacyArticle = storeOld.database.prepare("SELECT title FROM articles WHERE item_id = 'local:feed-old:legacy'").get();
      ok(!!migrated && legacyFeed && legacyArticle && legacyArticle.title === '老库文章',
        `1 老库无损升级：v19 补齐（${!!migrated}），源/文章原样保留`);
      ok(storeOld.books && typeof storeOld.books.createBook === 'function', '1 老库升级后 books 服务可用');
      storeOld.database.close();
    }

    // ══ 2. 文集 CRUD + 右键「加入文集」子菜单 ══
    let bookMain = null;
    {
      const created = await ipc(`window.robin.booksCreate({ title: '我的文集', feedIDs: ['${feed.id}'], schedule: 'manual' })`);
      ok(created && created.ok === true && created.data && created.data.title === '我的文集' && created.data.schedule === 'manual',
        '2 IPC 创建文集（信封 {ok,data}）');
      bookMain = created.data;
      const listed = await ipc(`window.robin.booksList()`);
      ok(listed && listed.ok && listed.data.books.length === 1 && listed.data.books[0].feedCount === 1,
        '2 booksList：1 部文集、绑定 1 源');
      const added = await ipc(`window.robin.booksAddFeeds({ id: '${bookMain.id}', feedIDs: ['${feed.id}', '${feedB.id}'] })`);
      ok(added && added.ok && added.data.feedIDs.length === 2 && added.data.feedIDs[0] === feed.id,
        '2 加入文集幂等去重（重复源不双记，多源并入）');
      const updated = await ipc(`window.robin.booksUpdate({ id: '${bookMain.id}', schedule: 'auto' })`);
      ok(updated && updated.ok && updated.data.schedule === 'auto', '2 更新文集 schedule=auto');
      const cleared = await ipc(`window.robin.booksUpdate({ id: '${bookMain.id}', schedule: 'manual', feedIDs: ['${feed.id}'] })`);
      ok(cleared && cleared.ok && cleared.data.schedule === 'manual' && cleared.data.feedIDs.length === 1, '2 还原 manual 与单源');
      const badName = await ipc(`window.robin.booksCreate({ title: '  ', feedIDs: [] })`);
      ok(badName && badName.ok === false && /名称不能为空/.test(String(badName.error)), '2 空名创建被拒');
      // 右键子菜单项（渲染层模块纯函数）
      const menu = await ipc(`(async () => {
        const { bookMenuItems } = await import('./views/bookshelf.js');
        const items = bookMenuItems({ books: [{ id: 'b1', title: '科技合集' }, { id: 'b2', title: '公众号合辑' }], feedIDs: ['feed-x'], onAddToBook: () => {}, onCreateBook: () => {} });
        return { labels: items.map((i) => (i.type === 'separator' ? '---' : i.label)), hasCreate: items[items.length - 1].label === '新建文集…', hasIcons: items.every((i) => i.type === 'separator' || i.icon === 'books') };
      })()`);
      ok(menu && menu.hasCreate && menu.hasIcons && menu.labels.includes('科技合集') && menu.labels.includes('公众号合辑')
        && menu.labels.includes('新建文集…') && menu.labels.includes('---'),
        `2 加入文集子菜单：既有文集 + 分隔线 + 新建入口（${JSON.stringify(menu && menu.labels)}）`);
    }

    // ══ 3. 成书：60 篇跨 3 个月 → EPUB 结构/分章/封面 ══
    {
      // 60 篇：4/3/2 个月前各 20 篇（全部已过去，避免未来时间戳干扰第 4 节「有新文章」判定），同月内按天升序
      const nowD = new Date();
      const monthStart = (ago) => new Date(nowD.getFullYear(), nowD.getMonth() - ago, 1);
      for (let i = 0; i < 60; i += 1) {
        const ago = 4 - Math.floor(i / 20);
        const day = (i % 20) + 1;
        const d = new Date(monthStart(ago).getFullYear(), monthStart(ago).getMonth(), day, 8, 0, 0);
        mkEntry(feed, `m${i}`, `文章 ${i + 1}`, Math.floor(d.getTime() / 1000));
      }
      const book = store.books.createBook({ title: 'F12 文集', feedIDs: [feed.id], schedule: 'manual' });
      const volumes = await store.books.buildVolumes(book);
      ok(volumes.length === 1 && volumes[0].entryCount === 60 && volumes[0].fileName === 'F12 文集.epub',
        `3 单卷成书（${volumes.length} 卷 / ${volumes[0].entryCount} 篇 / ${volumes[0].fileName}）`);
      const entries = zipEntries(volumes[0].buffer);
      const names = entries.map((e) => e.name);
      ok(entries[0].name === 'mimetype' && entries[0].method === 0 && entries[0].data.toString('utf8') === 'application/epub+zip',
        '3 mimetype 首条、无压缩、内容正确');
      ok(names.includes('META-INF/container.xml') && names.includes('OEBPS/content.opf') && names.includes('OEBPS/nav.xhtml')
        && names.includes('OEBPS/style.css'), '3 容器/OPF/nav/CSS 就位');
      ok(names.includes('OEBPS/images/cover.png') && names.includes('OEBPS/cover.xhtml'), '3 源 icon 封面命中（images/cover.png + 封面页）');
      const opf = entryText(entries, 'OEBPS/content.opf');
      ok(/<dc:title>F12 文集<\/dc:title>/.test(opf) && /<dc:creator>RobinRead<\/dc:creator>/.test(opf)
        && /<dc:date>20\d\d-/.test(opf) && /properties="cover-image"/.test(opf) && /properties="nav"/.test(opf),
        '3 OPF 元数据（title/creator/date）与 nav/cover 声明');
      const nav = entryText(entries, 'OEBPS/nav.xhtml');
      const monthTitles = (nav.match(/\d{4}年\d{1,2}月/g) || []);
      ok(new Set(monthTitles).size === 3, `3 nav 按月分章 = 3 个月（${JSON.stringify([...new Set(monthTitles)])}）`);
      ok((nav.match(/<li><a href="sec\d+\.xhtml#a\d+"/g) || []).length === 60, '3 nav 文章链接 = 60 篇');
      const secNames = names.filter((n) => /^OEBPS\/sec\d+\.xhtml$/.test(n));
      ok(secNames.length === 3, `3 章节文件 = 3 个月（${secNames.length}）`);
      // 章内升序：sec1（最早月）首篇是「文章 1」、末篇「文章 20」
      const sec1 = entryText(entries, 'OEBPS/sec1.xhtml');
      ok(sec1.indexOf('文章 1') < sec1.indexOf('文章 19') && sec1.indexOf('文章 19') < sec1.indexOf('文章 20') && /<h1>/.test(sec1),
        '3 章内按时间升序（sec1: 文章1 → 文章20）');
      ok(sec1.includes('F12 周刊') && /<blockquote>/.test(sec1) && !/<script/i.test(sec1), '3 章内容：来源署名 + 消毒 HTML');
      ok((volumes[0].buffer.slice(-22).readUInt16LE(8) === entries.length), '3 ZIP EOCD 条目数一致');
      store.books.deleteBook(book.id);
    }

    // ══ 3b. 1000 篇 → 5 卷 vol.1–5 每卷 200（确定性）+ 无 icon 纯色封面 ══
    {
      ok(VOLUME_SIZE === 200, '3 每卷 200 篇（VOLUME_SIZE）');
      for (let i = 0; i < 1000; i += 1) mkEntry(feedB, `v${i}`, `海量文章 ${i + 1}`, N() - (1000 - i) * 60);
      const book = store.books.createBook({ title: '千篇合集', feedIDs: [feedB.id], schedule: 'manual' });
      const t0 = Date.now();
      const volumes = await store.books.buildVolumes(book);
      const elapsed = Date.now() - t0;
      ok(volumes.length === 5 && volumes.every((v) => v.entryCount === 200),
        `3 1000 篇 → 5 卷 × 200（${volumes.length} 卷，组装 ${elapsed}ms）`);
      ok(volumes.map((v) => v.fileName).join('|') === ['千篇合集 vol.1.epub', '千篇合集 vol.2.epub', '千篇合集 vol.3.epub', '千篇合集 vol.4.epub', '千篇合集 vol.5.epub'].join('|'),
        `3 卷名 vol.1–5（${volumes.map((v) => v.fileName).join('、')}）`);
      ok(volumeFileName('千篇合集', 1, 1) === '千篇合集.epub', '3 单卷不带卷号');
      const v1 = zipEntries(volumes[0].buffer);
      const v1nav = entryText(v1, 'OEBPS/nav.xhtml');
      ok((v1nav.match(/<li><a href="sec/g) || []).length === 200, '3 vol.1 nav 链接 = 200 篇');
      const v1opf = entryText(v1, 'OEBPS/content.opf');
      ok(/<dc:title>千篇合集 vol\.1<\/dc:title>/.test(v1opf) && /<dc:creator>RobinRead<\/dc:creator>/.test(v1opf), '3 卷标题元数据 = 书名 vol.N');
      ok(v1.some((e) => e.name === 'OEBPS/cover.svg') && !v1.some((e) => e.name.startsWith('OEBPS/images/')),
        '3 无 icon 源 → 纯色标题封面 SVG 回退');
      const svg = entryText(v1, 'OEBPS/cover.svg');
      ok(svg && svg.includes('<svg') && svg.includes('千篇合集') && svg.includes('#37503f'), '3 纯色封面含书名文本');
      // 分卷切分确定性：同输入重复组卷，切分与章序完全一致（zip 内 uuid/时间戳随构建变化属预期）
      const volumes2 = await store.books.buildVolumes(book);
      ok(volumes2.map((v) => v.entryCount).join(',') === '200,200,200,200,200'
        && volumes2.map((v) => v.fileName).join(',') === volumes.map((v) => v.fileName).join(','),
        `3 分卷切分确定性（${volumes2.map((v) => v.entryCount).join(',')}）`);
      store.books.deleteBook(book.id);
    }

    // ══ 7. 成书耗时：200 篇 < 2s ══
    {
      const feedT = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F12 计时源', feedURL: 'https://t.test/feed.xml' });
      for (let i = 0; i < 200; i += 1) mkEntry(feedT, `t${i}`, `计时文章 ${i + 1}`, N() - (200 - i) * 120);
      const book = store.books.createBook({ title: '计时文集', feedIDs: [feedT.id] });
      const t0 = Date.now();
      const volumes = await store.books.buildVolumes(book);
      const ms = Date.now() - t0;
      ok(volumes.length === 1 && volumes[0].entryCount === 200 && ms < 2000, `7 200 篇成书 ${ms}ms < 2000ms 红线`);
      store.books.deleteBook(book.id);
    }

    // ══ 4. 自动成书：kick + 24h 节流 + 有新文章才成 + manual 永不自动 ══
    let autoBook = null;
    let manualBook = null;
    {
      autoBook = store.books.createBook({ title: '自动文集', feedIDs: [feed.id], schedule: 'auto' });
      manualBook = store.books.createBook({ title: '手动文集', feedIDs: [feedB.id], schedule: 'manual' });
      const result = await store.books.kick();
      ok(result && result.built === 1, `4 首次 kick：auto 文集成书（built=${result.built}）`);
      const autoDir = store.books.autoDir(autoBook.id);
      const files = fs.readdirSync(autoDir).filter((f) => f.endsWith('.epub'));
      ok(files.length === 1 && files[0] === '自动文集.epub', `4 自动目录落盘 userData/books/<id>/（${files.join(',')}）`);
      const rel = path.relative(userData, autoDir);
      ok(!rel.startsWith('..') && !path.isAbsolute(rel), '9 自动目录在 userData 白名单内');
      const row = store.database.prepare('SELECT last_built_at, last_entry_count FROM books WHERE id = ?').get(autoBook.id);
      ok(row.last_built_at > 0 && row.last_entry_count === 60, `4 成书回写（last_built_at=${Math.round(row.last_built_at)} count=${row.last_entry_count}）`);
      let listed = store.books.listBooks();
      ok(listed.find((b) => b.id === autoBook.id).pendingPick === true, '5 自动成书后「待取」徽标亮起');
      ok(!fs.existsSync(store.books.autoDir(manualBook.id)), '4 manual 文集 kick 后无自动目录');

      // 24h 节流：注入 last_built_at = 现在 → 不成
      store.database.prepare('UPDATE books SET last_built_at = ? WHERE id = ?').run(N(), autoBook.id);
      const r2 = await store.books.kick();
      const mtime1 = fs.statSync(path.join(autoDir, '自动文集.epub')).mtimeMs;
      ok(r2.built === 0, `4 24h 节流：未到点不成书（built=${r2.built}）`);
      // 到点但无新文章：注入 last_built_at = 25h 前，但不加新文章 → 不成
      store.database.prepare('UPDATE books SET last_built_at = ? WHERE id = ?').run(N() - 25 * 3600, autoBook.id);
      const r3 = await store.books.kick();
      ok(r3.built === 0, `4 无新文章不成书（built=${r3.built}）`);
      // 加新文章 + 25h 前 → 成书（目录只保留最新一卷）
      mkEntry(feed, 'fresh1', '新到的文章', N());
      const r4 = await store.books.kick();
      const files2 = fs.readdirSync(autoDir).filter((f) => f.endsWith('.epub'));
      const row2 = store.database.prepare('SELECT last_entry_count FROM books WHERE id = ?').get(autoBook.id);
      ok(r4.built === 1 && files2.length === 1 && row2.last_entry_count === 61,
        `4 有新文章 + 到点 → 重成书（目录 ${files2.length} 卷，count=${row2.last_entry_count}）`);
      listed = store.books.listBooks();
      ok(listed.find((b) => b.id === autoBook.id).pendingPick === true, '5 重成书后「待取」重新亮起');
    }

    // ══ 5 + 9. 书架 UI + 打开目录（shell mock）══
    {
      const shown = [];
      shell.showItemInFolder = (p) => shown.push(p);
      shell.openPath = async () => '';
      const result = await ipc(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const waitFor = async (fn, ms = 8000) => {
          const t0 = Date.now();
          for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); }
        };
        try {
          const { SettingsView } = await import('./views/dialogs.js');
          const view = new SettingsView({ state: { sidebar: [] }, views: {}, onAddFreshRSS: () => {}, onReload: () => {}, onRefreshState: () => {} });
          view.present('bookshelf');
          const navOk = [...document.querySelectorAll('.modal-nav-item')].some((el) => el.textContent.includes('书架'));
          // 20s：CI 全量连跑高载窗口下 booksList IPC+设置渲染偶发 >8s（负载偶发，见 roadmap 遗留记档）
          await waitFor(() => (document.querySelector('.modal-scroll')?.textContent || '').includes('立即成书') ? true : null, 20000);
          const body = document.querySelector('.modal-scroll')?.textContent || '';
          const hasBadge = body.includes('待取');
          const hasBooks = body.includes('自动文集') && body.includes('手动文集') && body.includes('我的文集');
          const hasButtons = body.includes('立即成书') && body.includes('打开目录') && body.includes('删除');
          const hasMeta = body.includes('上次成书 61 篇') && body.includes('个订阅源');
          const hasAutoTag = body.includes('自动');
          const hasIntro = body.includes('新建文集');
          const openButtons = [...document.querySelectorAll('.modal-scroll button')].filter((b) => b.textContent === '打开目录');
          openButtons.forEach((b) => b.click());
          const clicked = openButtons.length;
          view.dismiss();
          return { navOk, hasBadge, hasBooks, hasButtons, hasMeta, hasAutoTag, hasIntro, clicked };
        } catch (e) { return { __err: String(e && e.stack || e) }; }
      })()`);
      if (result.__err) { ok(false, 'UI 探针异常 — ' + result.__err); } else {
        ok(result.navOk, '5 设置导航含「书架」分区');
        ok(result.hasBooks, '5 书列表渲染（自动文集/手动文集/我的文集）');
        ok(result.hasBadge, '5 「待取」徽标渲染');
        ok(result.hasButtons, '5 立即成书/打开目录/删除按钮渲染');
        ok(result.hasMeta, '5 元信息行（绑定源数 · 上次成书篇数 · 日期）');
        ok(result.hasAutoTag && result.hasIntro, '5 auto 标记与新建文集入口渲染');
        ok(result.clicked >= 3, `5 打开目录按钮可点（${result.clicked} 个）`);
      }
      // 等全部 openDir IPC 真正落地（「待取」全部清除）再还原 shell stub——
      // 盲等会在 IPC 仍在途时还原真实 shell，导致误唤资源管理器/句柄悬置
      for (let i = 0; i < 40 && (shown.length < 1 || store.books.listBooks().some((b) => b.pendingPick)); i += 1) {
        await new Promise((r) => setTimeout(r, 250));
      }
      ok(shown.length >= 1 && shown.some((p) => p.startsWith(store.books.autoDir(autoBook.id)) && p.endsWith('.epub')),
        `9 shell.showItemInFolder 指向自动目录成书（${shown.length} 次调用）`);
      const listed = store.books.listBooks();
      ok(listed.every((b) => !b.pendingPick), '9 打开目录后「待取」全部清除（markPicked）');
      shell.showItemInFolder = realShowItem;
      shell.openPath = realOpenPath;
    }

    // ══ 10. 删除文集：行删 + 自动目录清理 + 用户 pickSavePath 书保留；8. feed_ids 持久化 ══
    {
      // 手动成书经保存对话框（mock）落盘到用户目录——多卷：第 1 卷 = 所选路径
      const feedBig = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F12 导出源', feedURL: 'https://e.test/feed.xml' });
      for (let i = 0; i < 250; i += 1) mkEntry(feedBig, `e${i}`, `导出文章 ${i + 1}`, N() - (250 - i) * 60);
      const pickBook = store.books.createBook({ title: '我的第一本书', feedIDs: [feedBig.id] });
      const pickDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f12-pick-'));
      cleanup.push(pickDir);
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(pickDir, '我的第一本书.epub') });
      const built = await ipc(`window.robin.booksBuild('${pickBook.id}')`);
      ok(built && built.ok && built.data && built.data.volumes === 2 && fs.existsSync(path.join(pickDir, '我的第一本书.epub'))
        && fs.existsSync(path.join(pickDir, '我的第一本书 vol.2.epub')),
        `10 手动成书落盘：vol.1 = 所选路径 + vol.2 落其旁（${built && built.data && built.data.files && built.data.files.map((f) => f.name).join('、')}）`);
      dialog.showSaveDialog = realShowSave;

      // 8. feed_ids 持久化：右键加入后独立只读连接回读
      const viaIPC = await ipc(`window.robin.booksAddFeeds({ id: '${pickBook.id}', feedIDs: ['${feed.id}'] })`);
      ok(viaIPC && viaIPC.ok && viaIPC.data.feedIDs.includes(feed.id), '8 右键加入文集（IPC addFeeds）');
      const ro = new DatabaseSync(path.join(userData, 'library.db'));
      const persisted = ro.prepare('SELECT feed_ids_json FROM books WHERE id = ?').get(pickBook.id);
      ro.close();
      const ids = JSON.parse(persisted.feed_ids_json);
      ok(ids.length === 2 && ids.includes(feedBig.id) && ids.includes(feed.id), `8 feed_ids 持久化（${ids.length} 源，独立连接回读）`);

      // 10. 删除：books 行删 + userData/books/<id> 清理 + 用户 pickSavePath 书保留
      const delAuto = await ipc(`window.robin.booksDelete('${autoBook.id}')`);
      ok(delAuto && delAuto.ok && delAuto.data === true, '10 删除 auto 文集（IPC）');
      ok(!store.database.prepare('SELECT id FROM books WHERE id = ?').get(autoBook.id), '10 books 行已删');
      ok(!fs.existsSync(store.books.autoDir(autoBook.id)), '10 userData/books/<id> 自动目录已清理');
      ok(fs.existsSync(path.join(pickDir, '我的第一本书.epub')) && fs.existsSync(path.join(pickDir, '我的第一本书 vol.2.epub')),
        '10 用户 pickSavePath 落盘的书保留（不受文集删除影响）');
      const remain = store.books.listBooks().map((b) => b.title);
      ok(remain.includes('我的第一本书') && remain.includes('手动文集') && !remain.includes('自动文集'),
        `10 书架剩余书目正确（${remain.join('、')}）`);
      // 重复删除幂等（行已不在 → false，不抛）
      const delAgain = await ipc(`window.robin.booksDelete('${autoBook.id}')`);
      ok(delAgain && delAgain.ok === true && delAgain.data === false, '10 重复删除幂等（返回 false）');
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  } finally {
    dialog.showSaveDialog = realShowSave;
    shell.showItemInFolder = realShowItem;
    shell.openPath = realOpenPath;
    for (const dir of cleanup) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  }
});
