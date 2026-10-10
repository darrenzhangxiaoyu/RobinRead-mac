'use strict';
/**
 * SpectrumService（知更）— 来源立场光谱（F38，有趣+媒介素养档）
 *
 * 常读话题的订阅源按立场/风格排成一条光谱轴：LLM 对 Top 20 高频源
 * （近 90 天完读统计）各做一次「立场/风格画像」，结果布在
 * -100（技术实用）… +100（观点人文）的横轴上；读某话题文章时，
 * 阅读器在对照镜旁以「光谱」小图标标出当前源的位置与一句话画像。
 *
 * - Top 源：article_states 近 90 天已读计数（一条 GROUP BY，禁 N+1）；
 * - 批量分析：一次 prompt 判全部源（数组合同，照 PerspectiveService 惯例）：
 *   [{index, spectrum, style, portrait}]；容错解析——围栏/前后杂文/越界 index
 *   剔除/缺 index 顺位兜底/非法 spectrum（非数字）剔除/越界钳位 ±100/
 *   非法风格 tag 置空（画像不因风格坏而整条丢弃）；
 * - 缓存：v29 source_profiles（feed_id PK 一源一画像），7 天过期重析；
 *   analyze({force}) 手动触发也走同一单飞；无 Key：光谱页灰置 + 说明
 *   （此功能核心是 LLM 判断，不做降级假装）。
 * - 布点投影：spectrum → [0,1] 线性映射 + 确定性重叠抖动（同值/近邻源错开，
 *   纯函数，探针直测）。
 *
 * 注入缝（探针）：_now 时钟可注入；_llmComplete 整路可换。
 */
const { LLMServiceError } = require('./LLMService');

/** 规则常量（选源/分析/过期/布点全部集中于此）。 */
const SPECTRUM = {
  TOP_FEEDS: 20,          // 一次最多分析的高频源数（数组合同一批 prompt）
  WINDOW_DAYS: 90,        // 完读统计窗口（近 90 天）
  RECENT_PER_FEED: 5,     // 画像输入：每源最近 N 篇标题 + 摘要摘选
  DETAIL_RECENT: 3,       // 详情面板：最近 3 篇标题
  PROFILE_TTL_DAYS: 7,    // 画像过期天数（过期后台重析）
  SPECTRUM_MIN: -100,     // 轴左端：技术实用
  SPECTRUM_MAX: 100,      // 轴右端：观点人文
  TITLE_SLICE: 80,        // prompt 里源名截断
  HEADLINE_SLICE: 90,     // prompt 里标题截断
  SUMMARY_SLICE: 120,     // prompt 里摘要摘选截断
  PORTRAIT_SLICE: 120,    // 一句话画像落库截断
  MIN_GAP: 0.045,         // 布点最小间距（轴宽占比；重叠抖动的目标间隔）
  STYLES: ['深度', '快讯', '评论', '教程'], // 风格 tag 合法词表
};

/** 风格 tag 归一：合法词表内原样返回，否则 null（画像保留，风格置空）。 */
function normalizeStyle(raw) {
  const v = String(raw || '').replace(/\s+/g, ' ').trim();
  return SPECTRUM.STYLES.includes(v) ? v : null;
}

/**
 * spectrum 钳位：数字越界钳到 ±100；非数字返回 null（调用方剔条）。
 */
function clampSpectrum(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(SPECTRUM.SPECTRUM_MIN, Math.min(SPECTRUM.SPECTRUM_MAX, Math.round(n)));
}

/**
 * 从 LLM 回包解析源画像数组（容错照 PerspectiveService 惯例：```json 围栏 /
 * 前后杂文 / 坏 JSON → null；对象 {profiles:[…]} 或裸数组两种合同；
 * 显式越界 index 剔除；缺 index 顺位兜底；非法 spectrum 剔条（badSpectrum 记数）；
 * 越界 spectrum 钳位；非法风格置 null）。
 * @returns null | { profiles: ([{spectrum, style, portrait}] | null)[], badSpectrum: number }
 *   槽位数 = count；null 槽 = 该源未判定（下次重析可补）。
 */
function parseProfilePayload(text, count) {
  if (!text) return null;
  let raw = String(text).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  // 两步截取按「括号出现先后」排序（裸数组 [{…}] 若先切 {…} 会得到合法 JSON
  // 但错误形状——单元素数组被当对象解析），解析出列表合同才算成功。
  const firstObj = raw.indexOf('{');
  const firstArr = raw.indexOf('[');
  const pairs = (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj))
    ? [['[', ']'], ['{', '}']]
    : [['{', '}'], ['[', ']']];
  let list = null;
  for (const [open, close] of pairs) {
    const start = raw.indexOf(open);
    const end = raw.lastIndexOf(close);
    if (start === -1 || end <= start) continue;
    let parsed = null;
    try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (_) { parsed = null; }
    if (Array.isArray(parsed)) { list = parsed; break; }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.profiles)) { list = parsed.profiles; break; }
  }
  if (!list || !list.length) return null;
  const out = new Array(count).fill(null);
  let badSpectrum = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    let index = -1;
    if (Number.isFinite(Number(item.index))) index = Number(item.index) - 1;
    if (index < 0 || index >= count) {
      if (Number.isFinite(Number(item.index)) && Number(item.index) > 0) continue; // 显式越界：剔条不张冠李戴
      index = out.findIndex((slot) => slot === null); // 缺 index：顺位兜底
      if (index === -1) break;
    }
    if (out[index]) continue; // 重复 index：先到先得
    const spectrum = clampSpectrum(item.spectrum);
    if (spectrum === null) { badSpectrum += 1; continue; } // 非法 spectrum：剔条
    const portrait = String(item.portrait || item.desc || '').replace(/\s+/g, ' ').trim().slice(0, SPECTRUM.PORTRAIT_SLICE);
    out[index] = { spectrum, style: normalizeStyle(item.style), portrait };
  }
  if (out.every((slot) => slot === null)) return null; // 全空 = 整体解析失败
  return { profiles: out, badSpectrum };
}

/**
 * 布点投影（纯函数）：spectrum → [0,1] 线性映射后做确定性重叠抖动——
 * 按位置排序顺序扫描，间距 < MIN_GAP 的近邻依次右推；右推溢出轴右端时
 * 自右向左压缩回收（保持相对次序 = 确定性）；极端拥挤（超过 1/MIN_GAP 个点）
 * 容忍少量同值重叠（视觉妥协），但永不越出 [0,1]。
 * @param {[{feedID, spectrum, ...}]} items
 * @returns [{...item, x}]（x 保留 4 位小数）
 */
function projectPositions(items) {
  const span = SPECTRUM.SPECTRUM_MAX - SPECTRUM.SPECTRUM_MIN;
  const sorted = (Array.isArray(items) ? items : [])
    .slice()
    .sort((a, b) => (a.spectrum - b.spectrum) || String(a.feedID).localeCompare(String(b.feedID)));
  const xs = sorted.map((it) => ((Number(it.spectrum) - SPECTRUM.SPECTRUM_MIN) / span));
  for (let i = 1; i < xs.length; i += 1) {
    if (xs[i] - xs[i - 1] < SPECTRUM.MIN_GAP) xs[i] = xs[i - 1] + SPECTRUM.MIN_GAP;
  }
  const overflow = xs.length ? xs[xs.length - 1] - 1 : 0;
  if (overflow > 0) {
    // 右推溢出：末点钉在 1，自右向左压缩（next - MIN_GAP 与原值取小）
    xs[xs.length - 1] = 1;
    for (let i = xs.length - 2; i >= 0; i -= 1) xs[i] = Math.min(xs[i], xs[i + 1] - SPECTRUM.MIN_GAP);
    if (xs[0] < 0) {
      // 极端拥挤（点数 > 1/MIN_GAP）：整体抬回轴内，越界钳边（容忍尾部少量重叠）
      const lift = -xs[0];
      for (let i = 0; i < xs.length; i += 1) xs[i] = Math.min(1, Math.max(0, xs[i] + lift));
    }
  }
  return sorted.map((it, i) => ({ ...it, x: Math.round(xs[i] * 10000) / 10000 }));
}

class SpectrumService {
  constructor(store, { now = null } = {}) {
    this.store = store;
    this._now = now || (() => Date.now() / 1000); // 注入时钟（探针确定性）
    this._llmComplete = null; // 注入缝（探针 mock）
    this._running = false; // 单飞（分析后台至多一场）
    this.counters = {
      analyses: 0, profiled: 0, cacheHits: 0, expired: 0,
      parseFailures: 0, degraded: 0, cancelled: 0, requestInFlightRejected: 0,
    };
    const required = ['source_profiles'];
    const missing = required.filter((t) => !this.store.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(t));
    if (missing.length) {
      throw new Error(`数据库 schema 缺少来源光谱表（${missing.join(', ')}）：DatabaseMigrations v29 未执行`);
    }
  }

  now() { return this._now(); }

  /** AI 可用性（光谱页灰置判定）。 */
  available() {
    return { ai: this.store.hasAIAPIKey() };
  }

  // MARK: Top 源选取（本地零 AI）

  /**
   * 近 90 天完读 Top N（一条 GROUP BY，禁 N+1）：已读且最近 90 天内读过
   * （article_states.updated_at 口径，与 F16 仪表盘一致），活跃源在前。
   */
  topFeeds({ limit = SPECTRUM.TOP_FEEDS, nowMs = null } = {}) {
    const now = nowMs != null ? Number(nowMs) / 1000 : this.now();
    const since = Math.floor(now) - SPECTRUM.WINDOW_DAYS * 86400;
    return this.store.database.prepare(`
      SELECT i.feed_id AS feedID, IFNULL(f.title, '') AS title, COUNT(*) AS readCount
      FROM article_states s
      INNER JOIN items i ON i.id = s.item_id
      INNER JOIN feeds f ON f.id = i.feed_id
      WHERE s.is_read = 1 AND s.updated_at >= ? AND f.is_deleted = 0
      GROUP BY i.feed_id
      ORDER BY readCount DESC, i.feed_id ASC
      LIMIT ?
    `).all(since, Math.max(1, Math.min(Number(limit) || SPECTRUM.TOP_FEEDS, SPECTRUM.TOP_FEEDS)));
  }

  /** 每源画像输入：最近 N 篇标题 + 摘要摘选（published_at 新→旧）。 */
  _feedContext(feedID, limit = SPECTRUM.RECENT_PER_FEED) {
    return this.store.database.prepare(`
      SELECT IFNULL(a.title, '') AS title, IFNULL(a.summary, '') AS summary
      FROM items i INNER JOIN articles a ON a.item_id = i.id
      WHERE i.feed_id = ?
      ORDER BY COALESCE(a.published_at, i.created_at) DESC, i.id ASC
      LIMIT ?
    `).all(String(feedID || ''), Math.max(1, limit))
      .map((r) => ({
        title: String(r.title || '').replace(/\s+/g, ' ').trim().slice(0, SPECTRUM.HEADLINE_SLICE),
        summary: String(r.summary || '').replace(/\s+/g, ' ').trim().slice(0, SPECTRUM.SUMMARY_SLICE),
      }));
  }

  // MARK: 缓存读取

  _row(feedID) {
    return this.store.database.prepare('SELECT * FROM source_profiles WHERE feed_id = ?').get(String(feedID || ''));
  }

  _parseProfile(row) {
    if (!row) return null;
    try {
      const p = JSON.parse(row.profile_json || '{}');
      if (!p || typeof p !== 'object') return null;
      return { spectrum: clampSpectrum(p.spectrum) ?? 0, style: normalizeStyle(p.style), portrait: String(p.portrait || '') };
    } catch (_) {
      return null;
    }
  }

  /** 单源画像缓存（7 天内有效；过期/缺失返回 null——stale 语义由调用方标）。 */
  profile(feedID, nowMs = null) {
    const row = this._row(feedID);
    if (!row) return null;
    const now = nowMs != null ? Number(nowMs) / 1000 : this.now();
    if (now - row.analyzed_at >= SPECTRUM.PROFILE_TTL_DAYS * 86400) return null; // 过期视同无
    const parsed = this._parseProfile(row);
    if (parsed) this.counters.cacheHits += 1;
    return parsed;
  }

  /** 缓存行年龄（秒）；无行返回 null。供视图标 stale 徽记。 */
  profileAge(feedID, nowMs = null) {
    const row = this._row(feedID);
    if (!row) return null;
    const now = nowMs != null ? Number(nowMs) / 1000 : this.now();
    return Math.max(0, Math.round(now - row.analyzed_at));
  }

  // MARK: 分析主流程（手动触发 / 过期后台重析，单飞）

  /**
   * 批量分析：Top 源里缺画像或已过期（7 天）的进一批 prompt（至多 TOP_FEEDS）。
   * @param {{ force?: boolean }} opts force=true 忽略缓存全量重析
   * @returns 视图投影（view()）；degraded=true 表示无 Key（零 LLM 调用）。
   */
  async analyze({ force = false } = {}) {
    if (!this.store.hasAIAPIKey()) {
      this.counters.degraded += 1;
      return { ...this.view(), degraded: true };
    }
    if (this._running) {
      this.counters.requestInFlightRejected += 1;
      throw new LLMServiceError('requestInProgress');
    }
    const lockKey = 'spectrum:analyze';
    const canceller = { cancelled: false, controller: new AbortController() };
    this._running = true;
    this.store.activeAICancellers.set(lockKey, canceller);
    try {
      const now = this.now();
      const tops = this.topFeeds({ nowMs: now * 1000 });
      if (tops.length) {
        const ttl = SPECTRUM.PROFILE_TTL_DAYS * 86400;
        const pending = force
          ? tops
          : tops.filter((f) => {
            const row = this._row(f.feedID);
            return !row || (now - row.analyzed_at >= ttl);
          });
        if (!force) {
          for (const f of pending) {
            if (this._row(f.feedID)) this.counters.expired += 1; // 已有行 = 7 天过期重析
          }
        }
        if (pending.length) {
          const contexts = pending.map((f) => ({ feedID: f.feedID, title: f.title, recent: this._feedContext(f.feedID) }));
          const ai = this.store._requireAIReady();
          const raw = await this.llmComplete(contexts, ai, canceller.controller.signal);
          if (canceller.cancelled) {
            this.counters.cancelled += 1;
          } else {
            const parsed = parseProfilePayload(raw, contexts.length);
            if (!parsed) {
              this.counters.parseFailures += 1; // 坏输出不落库，下次可重析
            } else {
              const upsert = this.store.database.prepare(`
                INSERT INTO source_profiles (feed_id, profile_json, analyzed_at)
                VALUES (?, ?, ?)
                ON CONFLICT(feed_id) DO UPDATE SET profile_json = excluded.profile_json, analyzed_at = excluded.analyzed_at
              `);
              for (let i = 0; i < contexts.length; i += 1) {
                const profile = parsed.profiles[i];
                if (!profile) continue; // 缺槽不落（下次重析补判）
                upsert.run(contexts[i].feedID, JSON.stringify(profile), now); // 服务时钟（注入下 stale 判定自洽）
                this.counters.profiled += 1;
              }
              this.counters.analyses += 1;
            }
          }
        }
      }
    } finally {
      this.store.activeAICancellers.delete(lockKey);
      this._running = false;
    }
    return this.view();
  }

  /** 是否需要重析：Top 源里存在缺画像或已过期（7 天）者（轻量判定，刷新钩子用）。 */
  needsReanalyze(nowMs = null) {
    const now = nowMs != null ? Number(nowMs) / 1000 : this.now();
    const ttl = SPECTRUM.PROFILE_TTL_DAYS * 86400;
    return this.topFeeds({ nowMs: now * 1000 }).some((f) => {
      const row = this._row(f.feedID);
      return !row || (now - row.analyzed_at) >= ttl;
    });
  }

  // MARK: 投影

  /**
   * 光谱视图投影：布点 + 详情数据（画像/风格/最近 3 篇）+ stale 标记 + 灰置说明。
   * 无 Key 且零画像 → grey=true（渲染层灰置整页 + 说明文案）。
   */
  view(nowMs = null) {
    const now = nowMs != null ? Number(nowMs) / 1000 : this.now();
    const rows = this.store.database.prepare(`
      SELECT sp.feed_id AS feedID, sp.profile_json AS profileJson, sp.analyzed_at AS analyzedAt,
             IFNULL(f.title, '') AS title
      FROM source_profiles sp
      INNER JOIN feeds f ON f.id = sp.feed_id
      WHERE f.is_deleted = 0
    `).all();
    const ttl = SPECTRUM.PROFILE_TTL_DAYS * 86400;
    const items = rows.map((row) => {
      const parsed = this._parseProfile({ profile_json: row.profileJson });
      const recent = this.store.database.prepare(`
        SELECT IFNULL(a.title, '') AS title
        FROM items i INNER JOIN articles a ON a.item_id = i.id
        WHERE i.feed_id = ?
        ORDER BY COALESCE(a.published_at, i.created_at) DESC, i.id ASC
        LIMIT ?
      `).all(row.feedID, SPECTRUM.DETAIL_RECENT).map((r) => r.title);
      return {
        feedID: row.feedID,
        title: String(row.title || '').slice(0, SPECTRUM.TITLE_SLICE),
        spectrum: parsed ? parsed.spectrum : 0,
        style: parsed ? parsed.style : null,
        portrait: parsed ? parsed.portrait : '',
        analyzedAt: row.analyzedAt,
        stale: (now - row.analyzedAt) >= ttl,
        readCount: 0,
        recent,
      };
    });
    // 完读计数并入（一条聚合，供详情与轴点 size）
    const tops = this.topFeeds({ nowMs: now * 1000, limit: SPECTRUM.TOP_FEEDS });
    const readsByID = new Map(tops.map((t) => [t.feedID, t.readCount]));
    for (const item of items) item.readCount = readsByID.get(item.feedID) || 0;
    const projected = projectPositions(items);
    const hasKey = this.store.hasAIAPIKey();
    return {
      available: { ai: hasKey },
      grey: !hasKey && projected.length === 0,
      greyReason: !hasKey ? 'missingAPIKey' : null,
      axis: { min: SPECTRUM.SPECTRUM_MIN, max: SPECTRUM.SPECTRUM_MAX },
      styles: [...SPECTRUM.STYLES],
      feeds: projected,
      dueReanalyze: hasKey && this.needsReanalyze(now * 1000),
    };
  }

  /**
   * 文章级联动：当前文章的源画像（无画像返回 null——阅读器按钮显隐判定）。
   * @returns null | { feedID, title, spectrum, style, portrait, recent[3], analyzedAt }
   */
  forEntry(entryID, nowMs = null) {
    const entry = this.store.articlesRepo.entry(String(entryID || ''));
    if (!entry || !entry.feedID) return null;
    const row = this._row(entry.feedID);
    if (!row) return null;
    const parsed = this._parseProfile(row);
    if (!parsed) return null;
    const recent = this.store.database.prepare(`
      SELECT IFNULL(a.title, '') AS title
      FROM items i INNER JOIN articles a ON a.item_id = i.id
      WHERE i.feed_id = ? AND i.id != ?
      ORDER BY COALESCE(a.published_at, i.created_at) DESC, i.id ASC
      LIMIT ?
    `).all(entry.feedID, String(entryID || ''), SPECTRUM.DETAIL_RECENT).map((r) => r.title);
    const feed = this.store.feedsRepo.feed(entry.feedID);
    return {
      feedID: entry.feedID,
      title: String(feed?.title || '').slice(0, SPECTRUM.TITLE_SLICE),
      ...parsed,
      recent,
      stale: (this.profileAge(entry.feedID, nowMs) ?? 0) >= SPECTRUM.PROFILE_TTL_DAYS * 86400,
      analyzedAt: row.analyzed_at,
    };
  }

  cancel() {
    this.store.cancelAI('spectrum:analyze');
  }

  // MARK: LLM

  /** 单条源的 prompt 块。 */
  static feedBlock(index, feed) {
    const lines = [`[${index + 1}] 源名：${String(feed.title || '').replace(/\s+/g, ' ').trim().slice(0, SPECTRUM.TITLE_SLICE) || '（未命名源）'}`];
    for (const r of (feed.recent || []).slice(0, SPECTRUM.RECENT_PER_FEED)) {
      lines.push(`- 《${r.title || '（无标题）'}》${r.summary ? `：${r.summary}` : ''}`);
    }
    return lines.join('\n');
  }

  /** LLM 批量画像（一次 prompt 判全部源）。可整路注入（探针 mock）。 */
  async llmComplete(feeds, { config, apiKey }, signal = null) {
    if (this._llmComplete) return this._llmComplete(feeds, { config, apiKey }, signal);
    const blocks = feeds.map((f, i) => SpectrumService.feedBlock(i, f)).join('\n\n');
    const prompt = [
      `以下是读者常读的 ${feeds.length} 个订阅源及其最近文章标题与摘要摘选：`,
      blocks,
      '',
      '请为每个源做「立场/风格画像」：',
      '- spectrum：该源内容整体倾向，-100=技术实用（硬核技术/工具/方法论），+100=观点人文（评论/随笔/文化），0=中间；',
      `- style：风格 tag，只能取 ${SPECTRUM.STYLES.join(' / ')} 之一；`,
      '- portrait：一句话画像（不超过 40 字，说清这个源是谁在为谁写什么）。',
      `只输出 JSON 数组（${feeds.length} 个元素，按源编号顺序），例如 [{"index":1,"spectrum":-60,"style":"深度","portrait":"…"}]，不要输出任何其他文字。`,
    ].join('\n');
    return this.store.llm.complete({
      prompt,
      system: '你是严谨的中文媒体分析师，只依据给出的源名与文章标题/摘要判断，不编造内容，只输出 JSON 数组，不输出其他内容。',
      configuration: config,
      apiKey,
      signal,
      forceDisableReasoning: true,
      overrideTemperature: 0.1,
    });
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return {
      ...this.counters,
      ...SPECTRUM,
      running: this._running,
      cachedRows: this.store.database.prepare('SELECT COUNT(*) AS n FROM source_profiles').get().n,
    };
  }
}

module.exports = {
  SpectrumService,
  SPECTRUM,
  parseProfilePayload,
  projectPositions,
  clampSpectrum,
  normalizeStyle,
};
