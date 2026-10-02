'use strict';
/**
 * RobinRead（知更）— FTS5 全文索引
 *
 * articles_fts 虚表（trigram 分词）索引 title/author/summary/正文缓存，
 * 支撑全文搜索的即时返回（原先四路 LIKE 全库扫描）。trigram 最小词元为
 * 3 个字符：<3 字符的查询（常见中文双字词）由搜索层回退 LIKE 路径。
 * 建表在 DatabaseMigrations 的 v4-articles-fts 中完成（FTS5 不可用时静默
 * 跳过建表，本模块的可用性探测会返回 false，写入与搜索全部退化为无操作/LIKE）。
 *
 * 行定位统一走 articles_fts_map（item_id → fts_rowid，v8 迁移建表回填）：
 * item_id 在 FTS5 内是 UNINDEXED 列，直接按它 SELECT/DELETE/UPDATE 都是全表
 * 扫描——灌文高峰（每天数百篇 × 数百 MB 索引）曾把主进程堵死数分钟。
 * 经映射全部降为 O(log n)；读时校验 rowid 归属，失配（外部工具 rebuild/
 * VACUUM 重排 rowid）自动按 item_id 修复一次。
 *
 * 入索引正文封顶 BODY_INDEX_CAP：巨页文章（实测有 3.5MB 单篇 HTML）的
 * trigram 索引与 doclist 重建成本超线性膨胀，正文搜索价值集中在前部。
 */
const availability = new WeakMap();
const mapAvailability = new WeakMap();

/** 每篇入索引正文上限（UTF-16 码元）；超出部分不参与全文搜索。 */
const BODY_INDEX_CAP = 64 * 1024;

function ftsAvailable(db) {
  if (availability.has(db)) return availability.get(db);
  let ok = false;
  try {
    ok = !!db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='articles_fts'"
    ).get();
  } catch (_) { ok = false; }
  availability.set(db, ok);
  return ok;
}

/** 映射表是否可用（v8 迁移建表；旧库/异常环境回退旧直查路径）。 */
function mapAvailable(db) {
  if (mapAvailability.has(db)) return mapAvailability.get(db);
  let ok = false;
  try {
    ok = !!db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='articles_fts_map'"
    ).get();
  } catch (_) { ok = false; }
  mapAvailability.set(db, ok);
  return ok;
}

function capBody(text) {
  const value = String(text || '');
  return value.length > BODY_INDEX_CAP ? value.slice(0, BODY_INDEX_CAP) : value;
}

function _remember(db, itemID, rowid) {
  db.prepare('INSERT OR REPLACE INTO articles_fts_map (item_id, fts_rowid) VALUES (?, ?)')
    .run(itemID, rowid);
}

function _forget(db, itemID) {
  try { db.prepare('DELETE FROM articles_fts_map WHERE item_id = ?').run(itemID); } catch (_) { /* 尽力而为 */ }
}

/**
 * item_id 的 FTS rowid（含归属校验）。映射失配时按 item_id 全扫修复一次并回写映射；
 * 两边都查不到返回 null（索引行确实不存在）。
 */
function _rowidFor(db, itemID) {
  const mapped = db.prepare('SELECT fts_rowid FROM articles_fts_map WHERE item_id = ?').get(itemID);
  if (!mapped) return null;
  const verify = db.prepare('SELECT item_id FROM articles_fts WHERE rowid = ?').get(mapped.fts_rowid);
  if (verify && verify.item_id === itemID) return Number(mapped.fts_rowid);
  const actual = db.prepare('SELECT rowid FROM articles_fts WHERE item_id = ?').get(itemID);
  if (actual) {
    const rowid = Number(actual.rowid);
    _remember(db, itemID, rowid);
    return rowid;
  }
  _forget(db, itemID);
  return null;
}

/**
 * 元数据（标题/作者/摘要）变更后重建该条目索引行。正文取值优先级：
 * 已索引正文（缓存提取稿，由 syncCacheText 维护）> fallbackBody（RSS
 * content_html 的纯文本，尚未抓取全文缓存的条目靠它支撑正文搜索）。
 */
function syncEntry(db, itemID, title, author, summary, fallbackBody = null) {
  if (!ftsAvailable(db)) return;
  try {
    if (!mapAvailable(db)) {
      const prev = db.prepare('SELECT body FROM articles_fts WHERE item_id = ?').get(itemID);
      const body = (prev && prev.body) ? prev.body : (fallbackBody || '');
      db.prepare('DELETE FROM articles_fts WHERE item_id = ?').run(itemID);
      db.prepare(
        'INSERT INTO articles_fts (item_id, title, author, summary, body) VALUES (?, ?, ?, ?, ?)'
      ).run(itemID, title || '', author || '', summary || '', capBody(body));
      return;
    }
    const rowid = _rowidFor(db, itemID);
    let prevBody = null;
    if (rowid != null) {
      prevBody = db.prepare('SELECT body FROM articles_fts WHERE rowid = ?').get(rowid)?.body ?? null;
      db.prepare('DELETE FROM articles_fts WHERE rowid = ?').run(rowid);
      _forget(db, itemID);
    }
    const body = prevBody ? prevBody : (fallbackBody || '');
    const info = db.prepare(
      'INSERT INTO articles_fts (item_id, title, author, summary, body) VALUES (?, ?, ?, ?, ?)'
    ).run(itemID, title || '', author || '', summary || '', capBody(body));
    _remember(db, itemID, Number(info.lastInsertRowid));
  } catch (_) { /* 索引失败不影响主流程（搜索有 LIKE 回退） */ }
}

/** 正文缓存写入后更新索引行（行不存在时以空元数据先建，稍后 syncEntry 补全）。 */
function syncCacheText(db, itemID, text) {
  if (!ftsAvailable(db)) return;
  try {
    const body = capBody(text || '');
    if (!mapAvailable(db)) {
      const prev = db.prepare('SELECT item_id FROM articles_fts WHERE item_id = ?').get(itemID);
      if (prev) {
        db.prepare('UPDATE articles_fts SET body = ? WHERE item_id = ?').run(body, itemID);
      } else {
        db.prepare(
          'INSERT INTO articles_fts (item_id, title, author, summary, body) VALUES (?, ?, ?, ?, ?)'
        ).run(itemID, '', '', '', body);
      }
      return;
    }
    const rowid = _rowidFor(db, itemID);
    if (rowid != null) {
      db.prepare('UPDATE articles_fts SET body = ? WHERE rowid = ?').run(body, rowid);
    } else {
      const info = db.prepare(
        'INSERT INTO articles_fts (item_id, title, author, summary, body) VALUES (?, ?, ?, ?, ?)'
      ).run(itemID, '', '', '', body);
      _remember(db, itemID, Number(info.lastInsertRowid));
    }
  } catch (_) { /* 同上 */ }
}

/** 条目索引行删除（缓存清空时传空文本保留标题可搜，条目删除时整行移除）。 */
function removeItem(db, itemID) {
  if (!ftsAvailable(db)) return;
  try {
    if (!mapAvailable(db)) {
      db.prepare('DELETE FROM articles_fts WHERE item_id = ?').run(itemID);
      return;
    }
    const rowid = _rowidFor(db, itemID);
    if (rowid != null) db.prepare('DELETE FROM articles_fts WHERE rowid = ?').run(rowid);
    _forget(db, itemID);
  } catch (_) { /* 同上 */ }
}

/** 批量删除（回填/重建路径），逐条走映射，避免 IN (...) 语句级全扫。 */
function removeMany(db, itemIDs) {
  if (!ftsAvailable(db)) return 0;
  const ids = (Array.isArray(itemIDs) ? itemIDs : []).filter(Boolean);
  if (!ids.length) return 0;
  let removed = 0;
  for (const id of ids) {
    try {
      if (!mapAvailable(db)) {
        removed += db.prepare('DELETE FROM articles_fts WHERE item_id = ?').run(id).changes;
      } else {
        const rowid = _rowidFor(db, id);
        if (rowid != null) removed += db.prepare('DELETE FROM articles_fts WHERE rowid = ?').run(rowid).changes;
        _forget(db, id);
      }
    } catch (_) { /* 单条失败不拖垮整批 */ }
  }
  return removed;
}

/** 孤儿行清理（条目删除路径分散在级联/多处，由每日数据管家统一兜底）。 */
function sweepOrphans(db) {
  if (!ftsAvailable(db)) return 0;
  try {
    if (!mapAvailable(db)) {
      return db.prepare(
        'DELETE FROM articles_fts WHERE item_id NOT IN (SELECT item_id FROM articles)'
      ).run().changes;
    }
    // 孤儿判定走映射反连 articles（主键探测），删除按 rowid 精确命中
    const orphans = db.prepare(`
      SELECT m.item_id AS item_id, m.fts_rowid AS fts_rowid
      FROM articles_fts_map m
      LEFT JOIN articles a ON a.item_id = m.item_id
      WHERE a.item_id IS NULL
    `).all();
    if (!orphans.length) return 0;
    const delRow = db.prepare('DELETE FROM articles_fts WHERE rowid = ?');
    const delMap = db.prepare('DELETE FROM articles_fts_map WHERE item_id = ?');
    let removed = 0;
    for (const o of orphans) {
      try {
        delRow.run(o.fts_rowid);
        delMap.run(o.item_id);
        removed += 1;
      } catch (_) { /* 单条失败不拖垮整批 */ }
    }
    return removed;
  } catch (_) { return 0; }
}

/**
 * 全量重建映射（item_id → rowid）。
 * SQLite VACUUM / FTS 'rebuild' 可能重排 rowid，任何此类操作之后必须调用本函数，
 * 否则映射失配（读时校验虽能逐条自愈，但首查会退化为全扫）。
 */
function rebuildMap(db) {
  if (!ftsAvailable(db) || !mapAvailable(db)) return 0;
  db.exec('DELETE FROM articles_fts_map');
  db.exec(
    'INSERT INTO articles_fts_map (item_id, fts_rowid) SELECT item_id, rowid FROM articles_fts WHERE item_id IS NOT NULL;'
  );
  return db.prepare('SELECT COUNT(*) c FROM articles_fts_map').get().c;
}

module.exports = {
  ftsAvailable, mapAvailable, syncEntry, syncCacheText,
  removeItem, removeMany, sweepOrphans, rebuildMap, BODY_INDEX_CAP,
};
