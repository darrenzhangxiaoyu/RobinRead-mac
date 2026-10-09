'use strict';
/**
 * RobinRead（知更）— 同步快照序列化与合并（F7，纯函数层）
 *
 * 快照固定结构（version 1）：
 * {
 *   version: 1, deviceId, updatedAt,
 *   feeds: [{ feedURL, title, siteURL, folder, platform, platformRef, updatedAt }],
 *   deletedFeedIDs: [{ feedURL, deletedAt }],   // 删除墓碑（P2-2）：本机软删订阅的 feedURL + 删除时间
 *   prefs: { values: {白名单键...}, updatedAt },
 *   annotations: [{ entryURL, kind:'highlight'|'note', text?, content?, color?, note?,
 *                   paragraphID?, startOffset?, endOffset?, anchor?, tags?, createdAt, updatedAt }],
 *   progress: { [entryURL]: { pct, at } },
 *   tags: { [entryURL]: [{ t, s }] },
 * }
 *
 * 合并语义（本地优先，全部幂等——同快照合并两次零 diff）：
 * - feeds：按 feedURL 并集；同源时整条记录「updatedAt 新者胜」；
 *   墓碑排除：feed 记录的 updatedAt ≤ 墓碑 deletedAt → 视为已删，从并集中剔除
 *   （订阅记录比墓碑新 = 本机重订阅 → 保留）；旧快照无该字段 = 无墓碑（兼容）；
 * - annotations：按 (entryURL, kind, 锚点摘要) 去重并集（批注永不删）；
 * - progress：按 entryURL 取 at 更新者；
 * - tags：并集（tag+source 归一去重）；
 * - prefs：整块「新者胜」（本地基准 = prefsDirtyAt，与 remote.prefs.updatedAt 比较）。
 * 护栏：快照 >8MB 拒绝（tooLarge）；annotations >5000 截最旧；墓碑 >500 条截最旧。
 */
const { stableDigest } = require('../Models');

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;   // 单快照 8MB 上传护栏
const ANNOTATION_LIMIT = 5000;                // 批注上限（超出截最旧）
const PROGRESS_LIMIT = 2000;                  // 阅读位置上限（超出截最旧）
const DELETION_TOMBSTONE_LIMIT = 500;         // 删除墓碑上限（超出截最旧，防快照无限膨胀）

/** 同步层错误（kind: tooLarge|invalid|config）。 */
class SyncError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'SyncError';
    this.kind = kind;
  }
}

/** 批注去重键：(entryURL, kind, 锚点摘要)。 */
function annotationKey(record) {
  const anchorDigest = record.anchor != null ? stableDigest(JSON.stringify(record.anchor)) : '';
  return [
    String(record.entryURL || ''),
    String(record.kind || ''),
    stableDigest([
      String(record.text ?? record.content ?? ''),
      String(record.paragraphID ?? ''),
      String(record.startOffset ?? ''),
      String(record.endOffset ?? ''),
      anchorDigest,
    ].join('\u0000')),
  ].join('|');
}

/** 批注排序时间（createdAt 优先，缺失回落 updatedAt）。 */
function annotationTime(record) {
  const t = Number(record.createdAt ?? record.updatedAt ?? 0);
  return Number.isFinite(t) ? t : 0;
}

/** 超限截最旧：按时间保留最新 limit 条（稳定：相等时间按原顺序）。 */
function truncateAnnotations(list, limit = ANNOTATION_LIMIT) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (arr.length <= limit) return arr;
  const withIndex = arr.map((r, i) => ({ r, i, t: annotationTime(r) }));
  withIndex.sort((a, b) => (a.t - b.t) || (a.i - b.i));
  const kept = withIndex.slice(arr.length - limit).sort((a, b) => a.i - b.i);
  return kept.map((x) => x.r);
}

/** progress 超限截最旧：按 at 保留最新 limit 条。 */
function truncateProgress(progress, limit = PROGRESS_LIMIT) {
  const entries = Object.entries(progress && typeof progress === 'object' ? progress : {});
  if (entries.length <= limit) return progress;
  entries.sort((a, b) => (Number(a[1]?.at) || 0) - (Number(b[1]?.at) || 0));
  return Object.fromEntries(entries.slice(entries.length - limit));
}

/**
 * 删除墓碑归一化（P2-2）：接受 [{ feedURL, deletedAt }] 或旧式字符串数组；
 * 按 feedURL 去重（保留最大 deletedAt）、按 deletedAt 截最新 limit 条。
 * deletedAt 缺省记 0（未知删除时间）：合并时只有墓碑时间 ≥ 订阅记录时间才生效，
 * 未知时间墓碑不参与排除（保守：无删除时间证据不动远端订阅）。
 */
function normalizeTombstones(value, limit = DELETION_TOMBSTONE_LIMIT) {
  const list = Array.isArray(value) ? value : [];
  const byURL = new Map();
  for (const item of list) {
    const url = typeof item === 'string' ? item : String(item && item.feedURL || '');
    if (!/^https?:\/\//i.test(url)) continue;
    const at = (item && typeof item === 'object') ? (Number(item.deletedAt) || 0) : 0;
    const prev = byURL.get(url);
    if (prev == null || at > prev) byURL.set(url, at);
  }
  return Array.from(byURL.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([feedURL, deletedAt]) => ({ feedURL, deletedAt }));
}

/** 序列化（>8MB 抛 SyncError('tooLarge')，拒绝上传）。 */
function serializeSnapshot(snapshot) {
  const text = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > SNAPSHOT_MAX_BYTES) {
    throw new SyncError('tooLarge', `snapshot too large: ${bytes} bytes > ${SNAPSHOT_MAX_BYTES}`);
  }
  return text;
}

/** 解析 + 结构校验（宽松：字段缺失按空处理；version 不符抛 SyncError('invalid')）。 */
function parseSnapshot(text) {
  let raw;
  try {
    raw = JSON.parse(String(text ?? '').toString('utf8'));
  } catch (err) {
    throw new SyncError('invalid', `snapshot is not valid JSON: ${String(err && err.message || err)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SyncError('invalid', 'snapshot is not an object');
  }
  if (Number(raw.version) !== SNAPSHOT_VERSION) {
    throw new SyncError('invalid', `unsupported snapshot version: ${raw.version}`);
  }
  if (!raw.deviceId || typeof raw.deviceId !== 'string') {
    throw new SyncError('invalid', 'snapshot missing deviceId');
  }
  return {
    version: SNAPSHOT_VERSION,
    deviceId: raw.deviceId,
    updatedAt: Number(raw.updatedAt) || 0,
    feeds: Array.isArray(raw.feeds) ? raw.feeds.filter((f) => f && typeof f.feedURL === 'string') : [],
    // 旧快照无 deletedFeedIDs 字段 = 无墓碑（兼容：缺省空数组）
    deletedFeedIDs: normalizeTombstones(raw.deletedFeedIDs),
    prefs: (raw.prefs && typeof raw.prefs === 'object' && !Array.isArray(raw.prefs))
      ? { values: (raw.prefs.values && typeof raw.prefs.values === 'object') ? raw.prefs.values : {}, updatedAt: Number(raw.prefs.updatedAt) || 0 }
      : { values: {}, updatedAt: 0 },
    annotations: Array.isArray(raw.annotations) ? raw.annotations.filter((a) => a && typeof a === 'object') : [],
    progress: truncateProgress(raw.progress),
    tags: (raw.tags && typeof raw.tags === 'object' && !Array.isArray(raw.tags)) ? raw.tags : {},
  };
}

/**
 * 双端合并（纯函数，幂等）：merge(merge(L,R), R) === merge(L,R)。
 * @returns {{ merged: object, stats: object }}
 */
function mergeSnapshots(local, remote, { prefsDirtyAt = 0 } = {}) {
  const stats = {
    feedsAddedFromRemote: 0,
    feedsKeptLocalNewer: 0,
    feedsKeptRemoteNewer: 0,
    feedsExcludedByTombstone: 0,
    annotationsAddedFromRemote: 0,
    progressUpdatedFromRemote: 0,
    progressKeptLocalNewer: 0,
    tagsAddedFromRemote: 0,
    prefsSource: 'local',
  };

  // ── 删除墓碑（P2-2）：双端并集，去重截最旧 ──
  const tombstones = normalizeTombstones([
    ...((local && local.deletedFeedIDs) || []),
    ...((remote && remote.deletedFeedIDs) || []),
  ]);
  const tombstoneAt = new Map(tombstones.map((t) => [t.feedURL, t.deletedAt]));

  // ── feeds：按 feedURL 并集，整条新者胜；墓碑时间 ≥ 记录时间 → 已删剔除 ──
  const feedMap = new Map();
  for (const feed of (Array.isArray(local.feeds) ? local.feeds : [])) {
    if (feed && feed.feedURL) feedMap.set(feed.feedURL, feed);
  }
  for (const feed of (Array.isArray(remote.feeds) ? remote.feeds : [])) {
    if (!feed || !feed.feedURL) continue;
    const existing = feedMap.get(feed.feedURL);
    if (!existing) {
      feedMap.set(feed.feedURL, feed);
      stats.feedsAddedFromRemote += 1;
      continue;
    }
    const localT = Number(existing.updatedAt) || 0;
    const remoteT = Number(feed.updatedAt) || 0;
    if (remoteT > localT) {
      feedMap.set(feed.feedURL, feed);
      stats.feedsKeptRemoteNewer += 1;
    } else {
      stats.feedsKeptLocalNewer += 1;
    }
  }
  const feeds = Array.from(feedMap.values()).filter((feed) => {
    const deletedAt = tombstoneAt.get(feed.feedURL);
    if (deletedAt == null) return true;
    // 订阅记录至少与删除一样旧 → 已被删除；记录更新（本机重订阅）→ 保留（墓碑对它失效）
    if (deletedAt >= (Number(feed.updatedAt) || 0)) {
      stats.feedsExcludedByTombstone += 1;
      return false;
    }
    return true;
  });

  // ── annotations：按去重键并集（批注永不删）──
  const annMap = new Map();
  for (const ann of (Array.isArray(local.annotations) ? local.annotations : [])) {
    annMap.set(annotationKey(ann), ann);
  }
  for (const ann of (Array.isArray(remote.annotations) ? remote.annotations : [])) {
    const key = annotationKey(ann);
    if (!annMap.has(key)) {
      annMap.set(key, ann);
      stats.annotationsAddedFromRemote += 1;
      continue;
    }
    // 同一批注双端都有：保留 updatedAt 较新版本（内容演进不改去重键）
    const existing = annMap.get(key);
    if ((Number(ann.updatedAt) || 0) > (Number(existing.updatedAt) || 0)) annMap.set(key, ann);
  }
  const annotations = truncateAnnotations(Array.from(annMap.values()));

  // ── progress：per entryURL 取 at 更新者 ──
  const progress = { ...(local.progress && typeof local.progress === 'object' ? local.progress : {}) };
  for (const [url, rec] of Object.entries(remote.progress || {})) {
    if (!rec || typeof rec !== 'object') continue;
    const localRec = progress[url];
    if (!localRec || (Number(rec.at) || 0) > (Number(localRec.at) || 0)) {
      progress[url] = rec;
      stats.progressUpdatedFromRemote += 1;
    } else {
      stats.progressKeptLocalNewer += 1;
    }
  }

  // ── tags：并集（entryURL → [{t,s}]，tag+source 归一去重）──
  const tags = {};
  const tagKey = (t, s) => `${String(t)}\u0000${String(s || '')}`;
  for (const [url, list] of Object.entries(local.tags || {})) {
    if (!Array.isArray(list)) continue;
    tags[url] = list.map((x) => ({ t: String(x?.t ?? x ?? ''), s: String(x?.s ?? 'manual') }));
  }
  for (const [url, list] of Object.entries(remote.tags || {})) {
    if (!Array.isArray(list)) continue;
    const seen = new Set((tags[url] || []).map((x) => tagKey(x.t, x.s)));
    for (const item of list) {
      const t = String(item?.t ?? item ?? '');
      const s = String(item?.s ?? 'manual');
      if (!t || seen.has(tagKey(t, s))) continue;
      (tags[url] = tags[url] || []).push({ t, s });
      stats.tagsAddedFromRemote += 1;
    }
  }

  // ── prefs：整块新者胜（本地基准 = prefsDirtyAt）──
  let prefs;
  if ((Number(remote.prefs.updatedAt) || 0) > (Number(prefsDirtyAt) || 0)) {
    prefs = { values: { ...(remote.prefs.values || {}) }, updatedAt: Number(remote.prefs.updatedAt) || 0 };
    stats.prefsSource = 'remote';
  } else {
    prefs = {
      values: { ...((local.prefs && local.prefs.values) || {}) },
      updatedAt: Number(local.prefs?.updatedAt) || 0,
    };
    stats.prefsSource = 'local';
  }

  const merged = {
    version: SNAPSHOT_VERSION,
    deviceId: local.deviceId || remote.deviceId,
    updatedAt: local.updatedAt || remote.updatedAt,
    feeds,
    deletedFeedIDs: tombstones,
    prefs,
    annotations,
    progress: truncateProgress(progress),
    tags,
  };
  return { merged, stats };
}

module.exports = {
  SNAPSHOT_VERSION,
  SNAPSHOT_MAX_BYTES,
  ANNOTATION_LIMIT,
  PROGRESS_LIMIT,
  DELETION_TOMBSTONE_LIMIT,
  SyncError,
  annotationKey,
  annotationTime,
  truncateAnnotations,
  truncateProgress,
  normalizeTombstones,
  serializeSnapshot,
  parseSnapshot,
  mergeSnapshots,
};
