'use strict';
/**
 * maint-db-compact.js — RobinRead library.db 一次性压缩维护（命令行，纯 node）
 *
 * 背景：FTS5 trigram 全文索引在「按 item_id 全表扫描」的写路径上长期劣化，
 * 且巨型正文（单篇 3.5MB HTML）与反复删除留下的段级垃圾把库撑到 560MB+。
 * 代码侧修复（SearchIndex 行映射 + 64K 封顶 + 整批单事务）落地后，用本脚本
 * 对存量库做一次回收。步骤：
 *
 *   1) 建/回填 articles_fts_map（与 v8 迁移同构，幂等；新版本 App 首启再跑迁移也无冲突）
 *   2) 清扫 FTS 孤儿行（条目已删、索引残留）
 *   3) 截断超长已索引正文至 SearchIndex.BODY_INDEX_CAP（与代码侧封顶一致）
 *   4) FTS5 'optimize'：合并段、回收已删文档的 doclist 空间
 *   5) wal_checkpoint(TRUNCATE) + VACUUM + ANALYZE
 *   6) 重建映射（VACUUM 可能重排 rowid）
 *
 * 用法：先完全退出 RobinRead（含托盘），再执行
 *   node scripts/maint-db-compact.js [db路径]
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const SearchIndex = require('../src/main/Persistence/SearchIndex');

const DEFAULT_DB = path.join(process.env.APPDATA || '', 'RobinRead', 'library.db');
const dbPath = process.argv[2] || DEFAULT_DB;

if (!fs.existsSync(dbPath)) {
  console.error('库文件不存在：' + dbPath);
  process.exit(1);
}

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const fileSize = () => {
  let total = fs.statSync(dbPath).size;
  for (const suffix of ['-wal', '-shm']) {
    try { total += fs.statSync(dbPath + suffix).size; } catch (_) { /* 无 WAL */ }
  }
  return total;
};

console.log('目标库：' + dbPath);
console.log('压缩前总占用：' + mb(fileSize()));

const db = new DatabaseSync(dbPath);

// 独占探测：应用未退出时 VACUUM 必然失败，提前给出可读的错误
try {
  db.exec('BEGIN EXCLUSIVE;');
  db.exec('ROLLBACK;');
} catch (err) {
  console.error('库被占用——请先完全退出 RobinRead（含系统托盘）再执行本脚本。');
  console.error('（' + err.message + '）');
  process.exit(2);
}

const stat = (sql) => { try { return db.prepare(sql).get(); } catch (_) { return null; } };

console.log('\n== 压缩前概览 ==');
console.log('FTS 行数：' + (stat('SELECT COUNT(*) c FROM articles_fts')?.c ?? 'n/a'));

// 1) 映射表（幂等，与 v8 迁移同构）
db.exec(`
  CREATE TABLE IF NOT EXISTS articles_fts_map (
      item_id   TEXT PRIMARY KEY NOT NULL,
      fts_rowid INTEGER NOT NULL
  );
`);
db.exec(`INSERT OR IGNORE INTO articles_fts_map (item_id, fts_rowid)
         SELECT item_id, rowid FROM articles_fts WHERE item_id IS NOT NULL;`);
console.log('映射表就绪：' + stat('SELECT COUNT(*) c FROM articles_fts_map')?.c + ' 行');

// 2) 孤儿清扫
const swept = SearchIndex.sweepOrphans(db);
console.log('孤儿清扫：' + swept + ' 行');

// 3) 截断超长已索引正文
const oversized = db.prepare(
  'SELECT rowid, LENGTH(body) l FROM articles_fts WHERE body IS NOT NULL AND LENGTH(body) > ?'
).all(SearchIndex.BODY_INDEX_CAP);
if (oversized.length) {
  const trunc = db.prepare('UPDATE articles_fts SET body = SUBSTR(body, 1, ?) WHERE rowid = ?');
  for (const row of oversized) trunc.run(SearchIndex.BODY_INDEX_CAP, row.rowid);
}
console.log('超长正文截断：' + oversized.length + ' 篇');

// 4) FTS 段合并回收
console.log('FTS optimize（大库可能耗时 1-3 分钟）…');
const t0 = Date.now();
try {
  db.exec(`INSERT INTO articles_fts(articles_fts) VALUES('optimize');`);
  console.log('optimize 完成，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
} catch (err) {
  console.warn('optimize 跳过：' + err.message);
}

// 5) VACUUM + ANALYZE + checkpoint
// 注意顺序：VACUUM 自身会写出约等于库体积的 WAL，checkpoint 必须放在它之后
console.log('VACUUM + checkpoint（大库可能耗时 1-3 分钟）…');
const t1 = Date.now();
db.exec('VACUUM;');
db.exec('ANALYZE;');
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
console.log('VACUUM 完成，耗时 ' + ((Date.now() - t1) / 1000).toFixed(1) + 's');

// 6) rowid 可能被 VACUUM 重排：全量重建映射
const mapped = SearchIndex.rebuildMap(db);
console.log('映射重建：' + mapped + ' 行');

console.log('\n== 压缩后概览 ==');
console.log('FTS 行数：' + (stat('SELECT COUNT(*) c FROM articles_fts')?.c ?? 'n/a'));
console.log('压缩后总占用：' + mb(fileSize()));
try {
  const rows = db.prepare(
    'SELECT name, SUM(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 8'
  ).all();
  console.log('Top 表占用：');
  for (const r of rows) console.log('  ' + String(r.name).padEnd(30) + ' ' + mb(r.bytes));
} catch (_) { /* dbstat 不可用时忽略 */ }

db.close();
console.log('\n完成。现在可以启动 RobinRead。');
