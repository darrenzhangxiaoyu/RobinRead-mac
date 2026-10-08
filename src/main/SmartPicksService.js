'use strict';
/**
 * SmartPicksService（知更）— 智能每日精选（F10）
 *
 * 与「今日 AI 简报」的本质区别：纯本地阅读画像、零 AI 依赖。
 * - 画像 = 关键词权重表：近 30 天行为（打开=1 / 收藏=3 / 高亮=2 / 笔记=2 / 跳过=-1）
 *   × 已读/收藏/高亮文章标题分词（词法与 F9 RAGService 显著词提取同源）聚合词频，
 *   取 Top 120。每次 gather 即时重算（200ms 红线内，不持久化）。
 * - 评分：候选 = 今日未读 + 近 3 天未读（去重，排除稍后读与「不感兴趣」名单）；
 *   score = 命中画像词的权重和 × 0.6 + 订阅源近期打开率 × 0.25 + 新鲜度（24h 半衰）× 0.15；
 *   同分回退发布时间新者在前。空画像降级为纯新鲜度排序。
 * - 「不感兴趣」：排除名单存偏好 JSON（RobinRead.picks.excluded，{id, until} 带 24h
 *   过期惰性清理）——无新表。
 * - 播报精选：Top N 标题+摘要按本地模板拼装成简报式文稿（非 LLM），交渲染层
 *   NeuralTTSService 既有 tts:synthesize 通路流式合成；不入 media_items（TTS 与媒体
 *   互斥语义已由渲染层裁决）。
 *
 * 可注入缝（探针离线化）：_candidatesImpl / _nowImpl / _behaviorImpl。
 */
const { i18n } = require('./I18N');

// MARK: - 常量

/** 行为 → 画像权重（任务约定：打开=1 / 收藏=3 / 高亮=2；笔记同高亮、跳过为负）。 */
const BEHAVIOR_WEIGHTS = { read: 1, star: 3, highlight: 2, note: 2, skip: -1 };
const PROFILE_WINDOW_DAYS = 30;   // 画像回看窗口
const PROFILE_MAX_WORDS = 120;    // 画像词表上限
const CANDIDATE_WINDOW_DAYS = 3;  // 候选回看窗口（今日 + 近 3 天，取并集天然覆盖今日）
const CANDIDATE_HARD_CAP = 400;   // 候选硬上限（排序 O(N×词表) 的 N 侧约束）
const SUMMARY_PREVIEW_MAX = 240;  // 精选行摘要截断（与列表 rowToListItem 口径一致）
const BROADCAST_SUMMARY_MAX = 120; // 播报文稿单篇摘要上限（字）
const EXCLUDE_TTL_HOURS = 24;     // 「不感兴趣」记忆时长
const FEED_RATE_WINDOW_DAYS = 30; // 订阅源打开率回看窗口
const SCORE_W_INTEREST = 0.6;
const SCORE_W_FEED = 0.25;
const SCORE_W_FRESH = 0.15;
const PICK_LIMITS = [10, 15, 20, 30];
const PICK_LIMIT_DEFAULT = 15;

const PREF_EXCLUDED_KEY = 'RobinRead.picks.excluded';
const PREF_LIMIT_KEY = 'RobinRead.picks.limit';

const SEPARATOR_RE = /[\s，。！？、；：,.!?;:()（）\[\]【】{}"'“”《》<>\-—–\/\\|@#$%^&*+=~`…·]+/u;
const CJK_RE = /[\u4e00-\u9fff]/;

// MARK: - 纯函数（探针直测）

/**
 * 标题分词：与 F9 RAGService.extractKeywords 同源的分隔符切词 + 停用词剔除思路，
 * 面向画像聚合扩展：CJK 段生成 2–4 字滑窗（「量子计算」类主题词可整体成词），
 * 西文段取小写词（2–24 字）。
 */
function tokenizeTitle(title) {
  const out = [];
  for (const seg of String(title || '').split(SEPARATOR_RE)) {
    if (!seg) continue;
    if (CJK_RE.test(seg)) {
      for (let n = 2; n <= 4 && n <= seg.length; n += 1) {
        for (let i = 0; i + n <= seg.length; i += 1) out.push(seg.slice(i, i + n));
      }
    } else {
      const word = seg.toLowerCase();
      if (word.length >= 2 && word.length <= 24 && !/^\d+$/.test(word)) out.push(word);
    }
  }
  return out;
}

/**
 * 行为流 × 标题分词 → 画像词表。
 * @param rows [{item_id, action, weight, title}]（窗口过滤由调用方完成）
 * @returns [{word, weight}] 权重降序（同分按词升序，确定性），Top maxWords，仅保留正权重
 */
function buildProfileFromBehavior(rows, { maxWords = PROFILE_MAX_WORDS } = {}) {
  const acc = new Map();
  for (const row of rows || []) {
    const base = BEHAVIOR_WEIGHTS[row.action] ?? BEHAVIOR_WEIGHTS.read;
    const gained = base * (Number(row.weight) || 1);
    for (const token of tokenizeTitle(row.title)) {
      acc.set(token, (acc.get(token) || 0) + gained);
    }
  }
  const words = [];
  for (const [word, weight] of acc) {
    if (weight > 0) words.push({ word, weight: Math.round(weight * 1000) / 1000 });
  }
  words.sort((a, b) => b.weight - a.weight || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  // 滑窗重叠词剪枝（验证轮 P2）：步长 1 滑窗会让「量子计算」衍生 6 个等权变体
  // （量子/子计/计算/…），污染词表且「子计」类噪声造成伪命中——
  // 按权重降序保留长词，丢弃其子串（子串权重已自然并入长词的累计）。
  const kept = [];
  for (const w of words) {
    if (!kept.some((k) => k.word.includes(w.word) && k.word !== w.word)) kept.push(w);
  }
  return kept.slice(0, maxWords);
}

/** 新鲜度：24h 半衰指数衰减，封顶 30 天（0 下限）。 */
function freshnessOf(publishedAt, now) {
  const ts = Number(publishedAt) || 0;
  if (!ts) return 0;
  const ageHours = Math.max(0, (now - ts) / 3600);
  return Math.pow(0.5, Math.min(ageHours, 24 * 30) / 24);
}

/**
 * 单篇评分：score = 画像命中权重 × 0.6 + 订阅源打开率 × 0.25 + 新鲜度 × 0.15。
 * wordWeights 为 Map（画像词 → 权重）；命中 = 词是 标题+摘要 的子串。
 * 长摘要偏置防护（验证轮 P1）：标题命中全额计权；摘要命中每词 0.3 折算且最多计 5 词——
 * 长摘要「蹭满」画像词无法再压过精准命中短标题（实测 9 倍偏差根因）。
 * weights 可选覆盖（F14 智能列表排序同引擎不同配比 0.5/0.2/0.3，缺省 F10 精选配比）。
 */
function scoreArticle(item, wordWeights, feedOpenRate, now, weights = null) {
  const title = item.title || '';
  const summary = item.summary || item.summaryPreview || '';
  let interest = 0;
  let summaryHits = 0;
  for (const [word, weight] of wordWeights) {
    if (title.includes(word)) {
      interest += weight;
    } else if (summary && summary.includes(word) && summaryHits < 5) {
      summaryHits += 1;
      interest += weight * 0.3;
    }
  }
  const freshness = freshnessOf(item.publishedAt, now);
  const wInterest = weights?.interest ?? SCORE_W_INTEREST;
  const wFeed = weights?.feed ?? SCORE_W_FEED;
  const wFresh = weights?.fresh ?? SCORE_W_FRESH;
  const score = interest * wInterest + (Number(feedOpenRate) || 0) * wFeed + freshness * wFresh;
  return { score: Math.round(score * 10000) / 10000, interest: Math.round(interest * 1000) / 1000 };
}

/** F14 智能列表排序配比：画像命中 × 0.5 + 源打开率 × 0.2 + 新鲜度 × 0.3。 */
const SORT_WEIGHTS = { interest: 0.5, feed: 0.2, fresh: 0.3 };

/**
 * 候选排序。
 * 空画像（degraded）：按发布时间新者在前（纯新鲜度降级）。
 * 正常：得分降序 → 同分发布时间新者在前（新鲜度衰减之外的第二重保险）→ id 升序。
 */
function rankCandidates(candidates, profileWords, feedOpenRates, { now, limit } = {}) {
  const degraded = !profileWords || profileWords.length === 0;
  const wordMap = new Map((profileWords || []).map((w) => [w.word, w.weight]));
  const sortKey = (a, b) => (b.publishedAt || 0) - (a.publishedAt || 0) || String(a.id).localeCompare(String(b.id));
  let ranked;
  if (degraded) {
    ranked = candidates.slice().sort(sortKey).map((item) => ({ ...item, score: 0, interest: 0 }));
  } else {
    ranked = candidates
      .map((item) => {
        const { score, interest } = scoreArticle(item, wordMap, feedOpenRates?.[item.feedID] || 0, now);
        return { ...item, score, interest };
      })
      .sort((a, b) => b.score - a.score || sortKey(a, b));
  }
  const capped = Number(limit) > 0 ? ranked.slice(0, Number(limit)) : ranked;
  return { picks: capped, degraded };
}

/**
 * 播报文稿（本地模板拼装，非 LLM）：精选流 → 简报式朗读稿。
 * 首行日期 + 逐篇「第 n 篇，《标题》，来自源。摘要」+ 收尾。
 */
function composeBroadcastScript(picks, { now = Date.now() / 1000, degraded = false } = {}) {
  const date = new Date(now * 1000);
  const dateLabel = i18n.localizedFormat('X年X月X日', date.getFullYear(), date.getMonth() + 1, date.getDate());
  const lines = [i18n.localizedFormat('知更智能精选，%lld 篇。', (picks || []).length)];
  if (degraded) lines.push(i18n.localized('你的阅读画像还在积累，读得越多推荐越准。'));
  (picks || []).forEach((pick, index) => {
    const summary = String(pick.summary || pick.summaryPreview || '')
      .replace(/\s+/g, ' ').trim().slice(0, BROADCAST_SUMMARY_MAX);
    const source = pick.sourceTitle ? i18n.localizedFormat('，来自%@。', pick.sourceTitle) : i18n.localized('。');
    lines.push(i18n.localizedFormat('第 %lld 篇，《%@》', index + 1, String(pick.title || '').replace(/[《》]/g, '')) + source + (summary || ''));
  });
  lines.push(i18n.localized('以上就是本期的智能精选。'));
  return lines.filter(Boolean).join('\n');
}

// MARK: - 服务

class SmartPicksService {
  constructor(store) {
    this.store = store;
    this.counters = { profilesBuilt: 0, picksComputed: 0, excluded: 0, expiredPruned: 0 };
    // 注入缝：候选集 / 行为流 / 时间（探针固定文章集 + 24h 过期语义注入）
    this._candidatesImpl = null;
    this._behaviorImpl = null;
    this._nowImpl = null;
  }

  now() {
    return this._nowImpl ? this._nowImpl() : Date.now() / 1000;
  }

  // MARK: Top N 配置

  get limit() {
    const v = Number(this.store.preferences.get(PREF_LIMIT_KEY, PICK_LIMIT_DEFAULT));
    return PICK_LIMITS.includes(v) ? v : PICK_LIMIT_DEFAULT;
  }

  setLimit(n) {
    const v = Number(n);
    if (!PICK_LIMITS.includes(v)) throw new Error(i18n.localized('精选数量仅支持 10 / 15 / 20 / 30。'));
    this.store.preferences.set(PREF_LIMIT_KEY, v);
    return v;
  }

  // MARK: 排除名单（偏好 JSON + 24h 过期惰性清理）

  _readExcluded() {
    let raw = this.store.preferences.get(PREF_EXCLUDED_KEY, []);
    if (!Array.isArray(raw)) raw = [];
    return raw
      .filter((e) => e && typeof e.id === 'string' && Number.isFinite(Number(e.until)))
      .map((e) => ({ id: e.id, until: Number(e.until) }));
  }

  _writeExcluded(list) {
    // 上限护栏：名单只用于 24h 记忆，防异常膨胀
    this.store.preferences.set(PREF_EXCLUDED_KEY, list.slice(-500));
  }

  /** 惰性清理过期项；返回仍有效的名单。 */
  pruneExcluded(now = this.now()) {
    const list = this._readExcluded();
    const kept = list.filter((e) => e.until > now);
    this.counters.expiredPruned += list.length - kept.length;
    if (kept.length !== list.length) this._writeExcluded(kept);
    return kept;
  }

  isExcluded(entryID, now = this.now()) {
    return this.pruneExcluded(now).some((e) => e.id === entryID);
  }

  /** 「不感兴趣」：加入排除名单（24h 后自动失效），返回当前名单。 */
  exclude(entryID, { now = null } = {}) {
    const id = String(entryID || '');
    if (!id) throw new Error(i18n.localized('缺少文章 ID。'));
    const at = now == null ? this.now() : Number(now);
    const list = this._readExcluded().filter((e) => e.id !== id);
    list.push({ id, until: at + EXCLUDE_TTL_HOURS * 3600 });
    this._writeExcluded(list);
    this.counters.excluded += 1;
    return list;
  }

  // MARK: 画像（即时重算，不持久化）

  /** 近 30 天行为流（含文章标题）。注入缝 _behaviorImpl 优先。 */
  behaviorRows(since) {
    if (this._behaviorImpl) return this._behaviorImpl(since);
    return this.store.database.prepare(`
      SELECT b.item_id, b.action, b.weight, b.created_at, IFNULL(a.title, '') AS title
      FROM reading_behavior b
      LEFT JOIN articles a ON a.item_id = b.item_id
      WHERE b.created_at >= ? AND b.action IN ('read', 'star', 'highlight', 'note', 'skip')
    `).all(since);
  }

  /** 画像 = 标题分词词频 × 行为权重，Top 120。 */
  buildProfile({ now = null } = {}) {
    const at = now == null ? this.now() : Number(now);
    const rows = this.behaviorRows(at - PROFILE_WINDOW_DAYS * 86400);
    const words = buildProfileFromBehavior(rows);
    this.counters.profilesBuilt += 1;
    return { words, sampled: rows.length, isEmpty: words.length === 0, builtAt: at };
  }

  /** UI 画像摘要：Top 8 词 + 归一化权重条（0..1）。 */
  profileSummary({ now = null } = {}) {
    const profile = this.buildProfile({ now });
    const max = profile.words.length ? profile.words[0].weight : 0;
    return {
      words: profile.words.slice(0, 8).map((w) => ({ word: w.word, weight: w.weight, bar: max > 0 ? Math.max(0.08, w.weight / max) : 0 })),
      sampled: profile.sampled,
      degraded: profile.isEmpty,
    };
  }

  /** 订阅源近期打开率（近 30 天 read 行为计数 → 按最大值归一到 0..1）。 */
  feedOpenRates(now) {
    const rows = this.store.database.prepare(`
      SELECT feed_id, COUNT(*) AS n FROM reading_behavior
      WHERE action = 'read' AND created_at >= ? AND feed_id IS NOT NULL
      GROUP BY feed_id
    `).all(now - FEED_RATE_WINDOW_DAYS * 86400);
    let max = 0;
    for (const r of rows) max = Math.max(max, r.n);
    const rates = {};
    if (max > 0) for (const r of rows) rates[r.feed_id] = r.n / max;
    return rates;
  }

  /** 候选集：今日未读 + 近 3 天未读（去重），排除稍后读。注入缝 _candidatesImpl 优先。 */
  _fetchCandidates(now) {
    if (this._candidatesImpl) return this._candidatesImpl(now);
    const since = now - CANDIDATE_WINDOW_DAYS * 86400;
    const rows = this.store.database.prepare(`
      SELECT i.id, i.feed_id, IFNULL(f.title, '') AS feed_title,
             IFNULL(a.title, '') AS title, IFNULL(a.summary, '') AS summary, a.url,
             COALESCE(a.published_at, i.created_at) AS published_at,
             COALESCE(s.is_starred, 0) AS is_starred,
             CASE WHEN mi.item_id IS NULL THEN 0 ELSE 1 END AS has_media
      FROM items i
      INNER JOIN feeds f ON f.id = i.feed_id AND f.is_deleted = 0
      INNER JOIN articles a ON a.item_id = i.id
      LEFT JOIN article_states s ON s.item_id = i.id
      LEFT JOIN media_items mi ON mi.item_id = i.id
      WHERE COALESCE(s.is_read, 0) = 0 AND COALESCE(s.is_later, 0) = 0
        AND COALESCE(a.published_at, i.created_at) >= ?
      ORDER BY COALESCE(a.published_at, i.created_at) DESC
      LIMIT ${CANDIDATE_HARD_CAP}
    `).all(since);
    return rows.map((r) => ({
      id: r.id,
      feedID: r.feed_id,
      sourceTitle: r.feed_title,
      title: r.title,
      summary: r.summary,
      url: r.url,
      publishedAt: r.published_at,
      isStarred: Number(r.is_starred) === 1,
      hasMedia: Number(r.has_media) === 1,
    }));
  }

  // MARK: 精选流

  /**
   * 取 Top N 精选。
   * @returns { picks, profileTop(8), degraded, candidateCount, excludedCount, generatedAt, limit }
   */
  pickTop({ n = null, now = null } = {}) {
    const at = now == null ? this.now() : Number(now);
    const lim = n == null ? this.limit : (PICK_LIMITS.includes(Number(n)) ? Number(n) : this.limit);
    const keptExcluded = this.pruneExcluded(at);
    const profile = this.buildProfile({ now: at });
    const rates = profile.isEmpty ? {} : this.feedOpenRates(at);
    const raw = this._fetchCandidates(at);
    const excludedSet = new Set(keptExcluded.map((e) => e.id));
    const candidates = raw.filter((item) => !excludedSet.has(item.id));
    const { picks, degraded } = rankCandidates(candidates, profile.words, rates, { now: at, limit: lim });
    this.counters.picksComputed += 1;
    return {
      picks: picks.map((p) => ({
        id: p.id,
        feedID: p.feedID,
        title: p.title,
        summary: String(p.summary || '').slice(0, SUMMARY_PREVIEW_MAX),
        sourceTitle: p.sourceTitle,
        url: p.url || null,
        publishedAt: p.publishedAt,
        isStarred: p.isStarred === true,
        hasMedia: p.hasMedia === true,
        score: p.score,
        interest: p.interest,
      })),
      profileTop: profile.words.slice(0, 8).map((w) => ({ word: w.word, weight: w.weight })),
      degraded,
      candidateCount: raw.length,
      excludedCount: keptExcluded.length,
      generatedAt: at,
      limit: lim,
    };
  }

  /** 播报文稿：Top N 标题+摘要本地模板拼装（渲染层走 NeuralTTS 既有通路播放）。 */
  broadcastScript({ n = null, now = null } = {}) {
    const result = this.pickTop({ n, now });
    return {
      script: composeBroadcastScript(result.picks, { now: result.generatedAt, degraded: result.degraded }),
      count: result.picks.length,
      titles: result.picks.map((p) => p.title),
      degraded: result.degraded,
    };
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return {
      counters: { ...this.counters },
      limit: this.limit,
      limits: PICK_LIMITS,
      excludeTTLHours: EXCLUDE_TTL_HOURS,
      profileWindowDays: PROFILE_WINDOW_DAYS,
      profileMaxWords: PROFILE_MAX_WORDS,
      candidateWindowDays: CANDIDATE_WINDOW_DAYS,
      candidateHardCap: CANDIDATE_HARD_CAP,
      weights: { interest: SCORE_W_INTEREST, feed: SCORE_W_FEED, fresh: SCORE_W_FRESH },
    };
  }
}

module.exports = {
  SmartPicksService,
  tokenizeTitle,
  buildProfileFromBehavior,
  scoreArticle,
  rankCandidates,
  composeBroadcastScript,
  freshnessOf,
  BEHAVIOR_WEIGHTS,
  PROFILE_MAX_WORDS,
  PROFILE_WINDOW_DAYS,
  CANDIDATE_WINDOW_DAYS,
  CANDIDATE_HARD_CAP,
  EXCLUDE_TTL_HOURS,
  PICK_LIMITS,
  PICK_LIMIT_DEFAULT,
  PREF_EXCLUDED_KEY,
  PREF_LIMIT_KEY,
  SORT_WEIGHTS,
};
