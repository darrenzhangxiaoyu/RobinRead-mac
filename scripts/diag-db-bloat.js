'use strict';
// 只读体检 RobinRead library.db：各表行数 + 大字段字节数 + 页级占用
const { DatabaseSync } = require('node:sqlite');

const DB = process.argv[2] || 'C:/Users/Lenovo/AppData/Roaming/RobinRead/library.db';
const db = new DatabaseSync(DB, { readOnly: true, open: true });

console.log('=== 行数 ===');
const tables = [
  'items', 'articles', 'article_states', 'article_caches', 'ai_artifacts',
  'reading_behavior', 'pruned_articles', 'article_state_outbox', 'feeds',
  'entry_tags', 'article_topics', 'fts_items', 'fts_articles',
];
for (const t of tables) {
  try {
    const r = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get();
    console.log(`${t.padEnd(24)} ${r.c}`);
  } catch (_) { /* 表不存在 */ }
}

console.log('\n=== 字节占用（sum(length)）===');
const byteQueries = [
  ['articles.content_html', 'SELECT SUM(LENGTH(content_html)) s, COUNT(content_html) n FROM articles WHERE content_html IS NOT NULL'],
  ['articles.summary', 'SELECT SUM(LENGTH(summary)) s, COUNT(summary) n FROM articles WHERE summary IS NOT NULL'],
  ['article_caches.text', 'SELECT SUM(LENGTH(text)) s, COUNT(text) n FROM article_caches'],
  ['article_caches.html', 'SELECT SUM(LENGTH(html)) s, COUNT(html) n FROM article_caches WHERE html IS NOT NULL'],
];
for (const [label, sql] of byteQueries) {
  try {
    const r = db.prepare(sql).get();
    const mb = r.s ? (r.s / 1048576).toFixed(1) : '0';
    console.log(`${label.padEnd(24)} ${(mb + ' MB').padStart(12)}  rows=${r.n}`);
  } catch (e) { console.log(`${label} err: ${e.message}`); }
}

console.log('\n=== 页级占用（dbstat，若可用）===');
try {
  const rows = db.prepare(`SELECT name, SUM(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 15`).all();
  for (const r of rows) console.log(`${String(r.name).padEnd(30)} ${(r.bytes / 1048576).toFixed(1)} MB`);
} catch (e) { console.log('dbstat 不可用：' + e.message); }

console.log('\n=== 文章时间分布 ===');
try {
  const r = db.prepare(`SELECT MIN(published_at) mn, MAX(published_at) mx, COUNT(*) c FROM items`).get();
  console.log(`items: ${r.c} 条, ${new Date(r.mn * 1000).toISOString()} ~ ${new Date(r.mx * 1000).toISOString()}`);
  const recent = db.prepare(`SELECT COUNT(*) c FROM items WHERE date_arrived > strftime('%s','now','-1 day')`).get();
  console.log(`最近24h到达: ${recent.c}`);
} catch (e) { console.log(e.message); }

console.log('\n=== 最大单篇文章 ===');
try {
  const r = db.prepare(`SELECT item_id, LENGTH(content_html) len FROM articles WHERE content_html IS NOT NULL ORDER BY len DESC LIMIT 5`).all();
  for (const x of r) console.log(`${x.item_id}  ${(x.len / 1024).toFixed(0)} KB`);
} catch (e) { console.log(e.message); }

db.close();
