'use strict';
/**
 * diag-db-health.js — FTS 行映射 + 嵌套事务 + 灌文性能探针
 *
 * 背景：item_id 在 articles_fts（FTS5）里是 UNINDEXED 列，历史上按它
 * SELECT/DELETE/UPDATE 都是全表扫描——每天数百篇灌文把主进程堵死数分钟。
 * 修复：v8 迁移建 articles_fts_map（item_id→rowid），SearchIndex 全走映射。
 * 本探针在隔离临时库上验证行为与性能。
 *
 * 验证项：
 *  A1 v8 迁移建映射表并可用
 *  B1 syncEntry 首插：FTS 行=1 且映射行=1，MATCH 可搜
 *  B2 syncEntry 再插（元数据更新）：仍 1 行（不重复），且保留已索引 body
 *  B3 syncCacheText：按 rowid 更新 body，仍 1 行
 *  B4 removeItem：FTS 与映射同删
 *  B5 removeMany：批量同删
 *  B6 sweepOrphans：articles 行删除后 FTS+映射孤儿同清
 *  C1 映射失配自愈：人为改坏 rowid，操作仍正确且映射被修复
 *  C2 正文封顶：超长 body 入索引后长度 == BODY_INDEX_CAP
 *  D1 嵌套事务：内层 SAVEPOINT 回滚不炸外层，外层可继续提交
 *  D2 整批单事务原子性：外层回滚 → items/articles/FTS/映射全部消失
 *  E1 性能：500 篇批量灌文（含 FTS）耗时应远小于旧逐篇事务方案
 *  F1 偏好原子写（P1-1）：flushSync 落盘内容就位且无 .tmp 残留
 *  F2 偏好损坏留存（P1-1）：截断 JSON → corrupt-<ts> 留存 + 空偏好起步（不再无痕清零）
 *  F3 偏好非对象 JSON（P1-1）：合法 JSON 但根非对象 → 同样按损坏留存处理
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');
const { LibraryDatabase } = require('../src/main/Persistence/LibraryDatabase');
const { AccountRepository, FeedRepository, ArticleRepository } = require('../src/main/Persistence/Repositories');
const SearchIndex = require('../src/main/Persistence/SearchIndex');

setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 150 * 1000).unref();
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

app.whenReady().then(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-db-health-'));
  const lib = new LibraryDatabase(path.join(dir, 'library.db'));
  const db = lib;
  const accounts = new AccountRepository(db);
  const feeds = new FeedRepository(db);
  const articles = new ArticleRepository(db);

  const account = accounts.ensureLocalAccount();
  const feed = feeds.insertFeed({
    accountID: account.id, externalID: null, title: '探针源',
    siteURL: 'https://example.com', feedURL: 'https://example.com/rss',
  });

  const ftsCount = () => db.prepare('SELECT COUNT(*) c FROM articles_fts').get().c;
  const mapCount = () => db.prepare('SELECT COUNT(*) c FROM articles_fts_map').get().c;
  const makeEntry = (n, bodyLen = 2000) => ({
    id: `local:${feed.id}:digest-${n}`,
    accountID: account.id,
    externalID: `local:${feed.id}:digest-${n}`,
    feedID: feed.id,
    title: `探针文章 ${n} robinread`,
    author: '作者',
    url: `https://example.com/${n}`,
    publishedAt: 1700000000 + n,
    summary: `摘要 ${n}`,
    contentHTML: `<p>${'正文内容'.repeat(Math.ceil(bodyLen / 4))}</p>`,
    dateArrived: 1700000000 + n,
  });

  // A1 映射表存在
  ok(SearchIndex.mapAvailable(db), 'A1 v8 映射表已建且可用');

  // B1 首插
  const e1 = makeEntry(1);
  articles.upsertEntry(e1);
  ok(ftsCount() === 1 && mapCount() === 1, `B1 首插 FTS=1 映射=1（实际 ${ftsCount()}/${mapCount()}）`);
  const hit = db.prepare(`SELECT item_id FROM articles_fts WHERE articles_fts MATCH '"robinread"'`).all();
  ok(hit.some((r) => r.item_id === e1.id), 'B1 MATCH 搜索可命中');

  // B2 元数据更新：不重复 + 保留 body
  const bodyBefore = db.prepare('SELECT body FROM articles_fts WHERE item_id = ?').get(e1.id).body;
  articles.upsertEntry({ ...e1, title: '改题 robinread2' });
  ok(ftsCount() === 1 && mapCount() === 1, `B2 元数据更新仍 1 行（实际 ${ftsCount()}/${mapCount()}）`);
  const bodyAfter = db.prepare('SELECT body FROM articles_fts WHERE item_id = ?').get(e1.id).body;
  ok(bodyAfter === bodyBefore, 'B2 已索引 body 不被 fallback 覆盖');

  // B3 syncCacheText 更新
  SearchIndex.syncCacheText(db, e1.id, '缓存提取稿全文内容 xyzq');
  ok(ftsCount() === 1, 'B3 syncCacheText 后仍 1 行');
  const cached = db.prepare('SELECT body FROM articles_fts WHERE item_id = ?').get(e1.id).body;
  ok(cached === '缓存提取稿全文内容 xyzq', 'B3 body 已切换为缓存提取稿');

  // C1 映射失配自愈
  db.prepare('UPDATE articles_fts_map SET fts_rowid = 999999 WHERE item_id = ?').run(e1.id);
  articles.upsertEntry({ ...e1, title: '自愈后 robinread3' });
  ok(ftsCount() === 1, `C1 失配自愈后仍 1 行（实际 ${ftsCount()}）`);
  ok(mapCount() === 1 && db.prepare('SELECT fts_rowid FROM articles_fts_map WHERE item_id = ?').get(e1.id).fts_rowid !== 999999,
    'C1 映射已被修复');

  // C2 封顶
  const e2 = makeEntry(2, SearchIndex.BODY_INDEX_CAP * 2);
  articles.upsertEntry(e2);
  const len2 = db.prepare('SELECT LENGTH(body) l FROM articles_fts WHERE item_id = ?').get(e2.id).l;
  ok(len2 === SearchIndex.BODY_INDEX_CAP, `C2 超长正文封顶（实际 ${len2} / cap ${SearchIndex.BODY_INDEX_CAP}）`);

  // B5 removeMany
  SearchIndex.removeMany(db, [e1.id, e2.id]);
  ok(ftsCount() === 0 && mapCount() === 0, `B5 removeMany 清空（实际 ${ftsCount()}/${mapCount()}）`);

  // B4 removeItem
  articles.upsertEntry(makeEntry(3));
  SearchIndex.removeItem(db, `local:${feed.id}:digest-3`);
  ok(ftsCount() === 0 && mapCount() === 0, 'B4 removeItem 清单条');

  // B6 sweepOrphans：直接删 items（FK 级联不清 FTS），靠 sweep 兜底
  articles.upsertEntry(makeEntry(4));
  ok(ftsCount() === 1, 'B6 前置：孤几 FTS 行存在');
  db.prepare('DELETE FROM items WHERE id = ?').run(`local:${feed.id}:digest-4`);
  const swept = SearchIndex.sweepOrphans(db);
  ok(swept === 1 && ftsCount() === 0 && mapCount() === 0, `B6 孤儿清扫（swept=${swept}）`);

  // D1 嵌套事务：内层回滚不炸外层
  lib.transaction(() => {
    db.prepare("INSERT INTO feeds (id, account_id, external_id, title, site_url, feed_url, updated_at, sort_order) VALUES ('tx-feed', ?, NULL, 'tx', '', '', 0, 0)")
      .run(account.id);
    try {
      lib.transaction(() => {
        db.prepare("UPDATE feeds SET title = 'inner' WHERE id = 'tx-feed'").run();
        throw new Error('inner boom');
      });
    } catch (_) { /* 内层已回滚，外层继续 */ }
    const t = db.prepare("SELECT title FROM feeds WHERE id = 'tx-feed'").get().title;
    ok(t === 'tx', `D1 内层 SAVEPOINT 回滚、外层存活（实际 title=${t}）`);
  });
  ok(db.prepare("SELECT COUNT(*) c FROM feeds WHERE id = 'tx-feed'").get().c === 1, 'D1 外层已提交');

  // D2 整批单事务原子性（_applyParsedEntries 模式）
  try {
    lib.transaction(() => {
      articles.upsertEntry(makeEntry(5));
      articles.upsertEntry(makeEntry(6));
      ok(ftsCount() === 2 && mapCount() === 2, 'D2 事务内两行就绪');
      throw new Error('outer boom');
    });
  } catch (_) { /* 预期回滚 */ }
  ok(db.prepare('SELECT COUNT(*) c FROM items WHERE id IN (?, ?)').get(makeEntry(5).id, makeEntry(6).id).c === 0
    && ftsCount() === 0 && mapCount() === 0, `D2 外层回滚全消失（FTS/映射 = ${ftsCount()}/${mapCount()}）`);

  // E1 性能：500 篇批量灌文
  const batch = [];
  for (let n = 0; n < 500; n++) batch.push(makeEntry(1000 + n, 6000));
  const t0 = Date.now();
  lib.transaction(() => { for (const e of batch) articles.upsertEntry(e); });
  const ms = Date.now() - t0;
  ok(ftsCount() === 500 && mapCount() === 500, `E1 500 篇全部入索引（FTS=${ftsCount()}）`);
  ok(ms < 30000, `E1 批量灌文耗时 ${ms}ms（<30s）`);
  console.log(`INFO 500 篇（每篇 ~6KB 正文，含 FTS trigram）整批耗时 ${ms}ms → 单篇均摊 ${(ms / 500).toFixed(1)}ms`);

  // 搜索冒烟：批量后 MATCH 仍可用
  const found = db.prepare(`SELECT COUNT(*) c FROM articles_fts WHERE articles_fts MATCH '"robinread"'`).get().c;
  ok(found === 500, `E1 批量后搜索命中 500（实际 ${found}）`);

  // ── F. P1-1 偏好存储：原子写 + 损坏留存 ──
  {
    const prefsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-prefs-'));
    app.setPath('userData', prefsDir); // PreferenceStore 构造时才读 userData，此处隔离探针写放
    const { PreferenceStore } = require('../src/main/Persistence/LibraryDatabase');
    const prefsPath = path.join(prefsDir, 'preferences.json');

    // F1 原子写：内容就位、无 .tmp 残留
    const ps1 = new PreferenceStore();
    ps1.set('RobinRead.appTheme', 'dark');
    ps1.set('RobinRead.articleFontSize', 18);
    ps1.flushSync();
    ok(JSON.parse(fs.readFileSync(prefsPath, 'utf8'))['RobinRead.appTheme'] === 'dark'
      && !fs.existsSync(`${prefsPath}.tmp`),
      'F1 flushSync 原子写内容就位且无 .tmp 残留');

    // F2 截断 JSON（崩溃/断电现场）→ 原文件改名留存 + 空偏好起步
    fs.writeFileSync(prefsPath, '{"RobinRead.appTheme":"dar', 'utf8');
    const ps2 = new PreferenceStore();
    const corrupt1 = fs.readdirSync(prefsDir).filter((f) => f.startsWith('preferences.json.corrupt-'));
    ok(Object.keys(ps2.values).length === 0 && corrupt1.length === 1,
      `F2 截断 JSON → corrupt-<ts> 留存 ${corrupt1.length} 份 + 空偏好起步`);
    // 损坏后写回不吞留存文件
    ps2.set('RobinRead.appTheme', 'light');
    ps2.flushSync();
    ok(JSON.parse(fs.readFileSync(prefsPath, 'utf8'))['RobinRead.appTheme'] === 'light',
      'F2 损坏恢复后 flushSync 正常写回新值');

    // F3 合法 JSON 但根非对象（数组）→ 同样按损坏留存
    fs.writeFileSync(prefsPath, '[]', 'utf8');
    const ps3 = new PreferenceStore();
    const corrupt2 = fs.readdirSync(prefsDir).filter((f) => f.startsWith('preferences.json.corrupt-'));
    ok(Object.keys(ps3.values).length === 0 && corrupt2.length === 2,
      `F3 非对象 JSON → 按损坏留存（累计 ${corrupt2.length} 份）`);

    fs.rmSync(prefsDir, { recursive: true, force: true });
  }

  lib.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed === 0 ? 'ALL PASS' : `FAILED ${failed}`);
  app.exit(failed === 0 ? 0 : 1);
});
