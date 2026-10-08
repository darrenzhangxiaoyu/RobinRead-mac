'use strict';
/**
 * DigestRadioService（知更）— 简报电台（F19）
 *
 * 把「今日 AI 简报」（或无 AI 时的本地模板摘要）转成可听的电台节目文稿：
 * - 文稿二选一：有 AI Key 且当日简报已生成（用户已过会员/额度门）→ 简报全文
 *   改写口语化电台稿（LLM，renderer 传 preferAI 才启用）；否则降级本地模板：
 *   开场白（日期+问候）→ 今日未读 Top 10（标题+摘要）→ 结尾语（复用 F10
 *   composeBroadcastScript 的本地拼装思路，零 AI 依赖）。
 * - 分句：splitSentences 纯函数按句读边界切分（单句 ≤ RADIO_SENTENCE_MAX 字
 *   硬上限再截），渲染层 RadioPlayer 逐句交 NeuralTTSService 既有 tts:synthesize
 *   通路合成、下一句预取链播（复用 PicksTTSPlayer 模式）。
 * - 位置记忆：偏好 JSON（RobinRead.radio.positions）按 sessionKey 存
 *   {index, total, hash, updatedAt}——听到第 N 句，重启后可续听第 N 句；
 *   文稿 hash 变化时位置自动失效（不再对不上号的文稿续播）。
 * - 合成去重：同 sessionKey 文稿 hash 不重合成由渲染层 RadioPlayer 内存缓存
 *   裁决（NeuralTTSService 磁盘缓存按 文本+音色+语速 兜底）；本服务提供 hash。
 *
 * 无新表：位置记忆与全部状态进偏好 JSON。可注入缝：_topUnreadImpl / _aiRewriteImpl / _nowImpl。
 */
const { i18n } = require('./I18N');
const { stableDigest, nowSeconds } = require('./Models');

// MARK: - 常量

const RADIO_TOP_N = 10;            // 模板文稿：今日未读 Top 10
const RADIO_SUMMARY_MAX = 90;      // 模板文稿单条摘要上限（字）
const RADIO_SENTENCE_MAX = 110;    // 单句合成上限（字），超长句在此截断
const PREF_POSITIONS_KEY = 'RobinRead.radio.positions';
const POSITIONS_CAP = 8;           // 位置记忆保留的 sessionKey 数（按 updatedAt 淘汰）

// MARK: - 纯函数（探针直测）

/** 本地日期键 YYYY-MM-DD（与 AppStore._digestDateKey 同口径：本地时区）。 */
function localDateKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 按时段问候（电台开场白）。 */
function greetingFor(hour) {
  if (hour < 5) return i18n.localized('夜深了');
  if (hour < 11) return i18n.localized('早上好');
  if (hour < 14) return i18n.localized('中午好');
  if (hour < 18) return i18n.localized('下午好');
  return i18n.localized('晚上好');
}

/**
 * 文稿分句：按句读边界（。！？!?；;\n）切分，空白折叠；
 * 超过 RADIO_SENTENCE_MAX 的长句按上限硬截（TTS 单句合成的长度约束）。
 * @returns [string] 非空句序列
 */
function splitSentences(scriptText, max = RADIO_SENTENCE_MAX) {
  const source = String(scriptText || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  if (!source.trim()) return [];
  const sentences = [];
  for (const raw of source.split(/(?<=[。！？!?；;\n])/)) {
    const piece = raw.replace(/\s*\n\s*/g, '').trim();
    if (!piece) continue;
    if (piece.length <= max) {
      sentences.push(piece);
      continue;
    }
    for (let i = 0; i < piece.length; i += max) sentences.push(piece.slice(i, i + max));
  }
  return sentences;
}

/**
 * 模板文稿（本地拼装，非 LLM）：开场白（日期+问候+条数）→ 逐条「第 n 条，
 * 《标题》，来自源。摘要」→ 结尾语。空列表仍有开场/结尾（播报空态引导）。
 */
function composeTemplateScript(items, { nowMs = Date.now() } = {}) {
  const d = new Date(nowMs);
  const dateLabel = i18n.localizedFormat('%lld 年 %lld 月 %lld 日', d.getFullYear(), d.getMonth() + 1, d.getDate());
  const list = Array.isArray(items) ? items : [];
  const lines = [];
  lines.push(i18n.localizedFormat('%@，%@。欢迎收听知更电台，为你播报今日阅读简报，共 %lld 条。', dateLabel, greetingFor(d.getHours()), list.length));
  if (!list.length) {
    lines.push(i18n.localized('今天还没有待读的文章，刷新订阅后再来听吧。'));
  }
  list.forEach((item, index) => {
    const summary = String(item.summary || item.summaryPreview || '').replace(/\s+/g, ' ').trim().slice(0, RADIO_SUMMARY_MAX);
    const source = item.sourceTitle ? i18n.localizedFormat('，来自%@。', item.sourceTitle) : i18n.localized('。');
    lines.push(
      i18n.localizedFormat('第 %lld 条，《%@》', index + 1, String(item.title || '').replace(/[《》]/g, ''))
      + source
      + (summary || ''),
    );
  });
  lines.push(i18n.localized('以上就是今天的知更电台简报，祝你阅读愉快。'));
  return lines.filter(Boolean).join('\n');
}

/** AI 简报 Markdown → 口语化电台稿的提示词（结构约束与禁编造）。 */
function radioRewritePrompt(digestContent, dateLabel) {
  return [
    `下面是今天（${dateLabel}）的 AI 阅读简报，请把它改写成一段电台播报文稿：`,
    String(digestContent || '').slice(0, 4000),
    '',
    '改写要求：',
    '- 开头一句：报日期并向听众问好，介绍这是知更电台今日简报',
    '- 按简报分节逐节播报：每节先报小节标题，再用 2-3 句口语化转述要点',
    '- 省略 Markdown 符号（#、*、[n] 编号），来源名自然带过（如「据某某报道」）',
    '- 结尾一句：感谢收听并道别',
    '- 只使用简报中出现的信息，禁止编造；总长度控制在 1200 字以内',
  ].join('\n');
}

// MARK: - 服务

class DigestRadioService {
  constructor(store) {
    this.store = store;
    this.counters = { scriptsBuilt: 0, aiScripts: 0, templateScripts: 0, positionsSaved: 0, positionsDropped: 0 };
    // 注入缝：未读素材 / AI 改写 / 时间（探针离线化）
    this._topUnreadImpl = null;
    this._aiRewriteImpl = null;
    this._nowImpl = null;
  }

  now() {
    return this._nowImpl ? this._nowImpl() : Date.now();
  }

  /** 会话键：按天 + 电台（位置记忆与合成缓存的作用域）。 */
  sessionKey(nowMs = this.now()) {
    return `radio:${localDateKey(nowMs)}`;
  }

  // MARK: 文稿

  /** 今日未读 Top N（模板素材）。注入缝 _topUnreadImpl 优先。 */
  topUnread(nowMs = this.now(), n = RADIO_TOP_N) {
    if (this._topUnreadImpl) return this._topUnreadImpl(n);
    let source = this.store.listItems({ kind: 'today' }, { limit: 60 }).filter((item) => !item.isRead);
    if (!source.length) source = this.store.listItems({ kind: 'unread' }, { limit: 60 });
    return source.slice(0, n).map((item) => ({
      id: item.id,
      title: item.title,
      sourceTitle: item.sourceTitle || '',
      summary: item.summaryPreview || item.summary || '',
    }));
  }

  /**
   * 电台文稿：AI 改写（有 Key + 当日简报已生成 + preferAI）→ 否则模板降级。
   * @param {object} opts { preferAI?: boolean }
   * @returns { script, sentences, sentenceTotal, source: 'ai'|'template', hash,
   *            sessionKey, dateKey, generatedAt }
   */
  async radioScript({ preferAI = false } = {}) {
    const nowMs = this.now();
    const dateKey = localDateKey(nowMs);
    const dateLabel = i18n.localizedFormat('%lld 年 %lld 月 %lld 日', new Date(nowMs).getFullYear(), new Date(nowMs).getMonth() + 1, new Date(nowMs).getDate());
    let script = null;
    let source = 'template';
    if (preferAI) {
      const hasKey = this.store.hasAIAPIKey ? this.store.hasAIAPIKey() : false;
      const digest = this.store.cachedTodayDigest ? (this.store.cachedTodayDigest('brief') || this.store.cachedTodayDigest('deep')) : null;
      if (hasKey && digest?.content) {
        try {
          script = this._aiRewriteImpl
            ? await this._aiRewriteImpl(digest.content)
            : await this._rewriteWithLLM(digest.content, dateLabel);
          if (script && String(script).trim()) source = 'ai';
          else script = null;
        } catch (_) {
          script = null; // AI 改写失败静默降级模板（电台不能因为 LLM 抖动不可用）
        }
      }
    }
    if (!script) {
      script = composeTemplateScript(this.topUnread(nowMs), { nowMs });
      source = 'template';
    }
    const clean = String(script).replace(/\s*\n\s*/g, '\n').trim();
    const sentences = splitSentences(clean);
    this.counters.scriptsBuilt += 1;
    if (source === 'ai') this.counters.aiScripts += 1;
    else this.counters.templateScripts += 1;
    return {
      script: clean,
      sentences,
      sentenceTotal: sentences.length,
      source,
      hash: stableDigest(`${source}:${clean}`),
      sessionKey: this.sessionKey(nowMs),
      dateKey,
      generatedAt: Math.floor(nowMs / 1000),
    };
  }

  /** LLM 口语化改写（有 Key 才会被调用；失败由调用方降级模板）。 */
  async _rewriteWithLLM(digestContent, dateLabel) {
    const { config, apiKey } = this.store._requireAIReady();
    return this.store.llm.complete({
      prompt: radioRewritePrompt(digestContent, dateLabel),
      system: '你是一位亲切的电台主播，把每日阅读简报改写成适合朗读的口播稿。输出纯文本口播稿（无 Markdown 符号），口语自然、信息忠实。',
      configuration: config,
      apiKey,
      forceDisableReasoning: true,
      overrideTemperature: 0.4,
    });
  }

  // MARK: 播放位置记忆（偏好 JSON）

  _readPositions() {
    let raw = this.store.preferences.get(PREF_POSITIONS_KEY, {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
    return raw;
  }

  /** 保存播放位置（听到第 N 句）。重启后经 getPosition 读回续听。 */
  savePosition(sessionKey, index, { total = 0, hash = '' } = {}) {
    const key = String(sessionKey || '');
    if (!key) return null;
    const positions = this._readPositions();
    positions[key] = {
      index: Math.max(0, Math.floor(Number(index) || 0)),
      total: Math.max(0, Math.floor(Number(total) || 0)),
      hash: String(hash || ''),
      updatedAt: nowSeconds(),
    };
    // 容量护栏：按 updatedAt 淘汰最旧（位置记忆只服务「上次听到哪」）
    const keys = Object.keys(positions)
      .sort((a, b) => (positions[a].updatedAt || 0) - (positions[b].updatedAt || 0));
    while (keys.length > POSITIONS_CAP) {
      delete positions[keys.shift()];
      this.counters.positionsDropped += 1;
    }
    this.store.preferences.set(PREF_POSITIONS_KEY, positions);
    this.counters.positionsSaved += 1;
    return positions[key];
  }

  /**
   * 读回播放位置。带 hash 校验：文稿已重新生成（hash 变化）时返回 null——
   * 不对不上号的文稿续播。
   */
  getPosition(sessionKey, { hash = null } = {}) {
    const p = this._readPositions()[String(sessionKey || '')];
    if (!p) return null;
    if (hash && p.hash && p.hash !== String(hash)) return null;
    return p;
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return {
      counters: { ...this.counters },
      topN: RADIO_TOP_N,
      summaryMax: RADIO_SUMMARY_MAX,
      sentenceMax: RADIO_SENTENCE_MAX,
      positionsCap: POSITIONS_CAP,
      sessionKey: this.sessionKey(),
      positions: this._readPositions(),
    };
  }
}

module.exports = {
  DigestRadioService,
  splitSentences,
  composeTemplateScript,
  radioRewritePrompt,
  greetingFor,
  localDateKey,
  RADIO_TOP_N,
  RADIO_SUMMARY_MAX,
  RADIO_SENTENCE_MAX,
  PREF_POSITIONS_KEY,
  POSITIONS_CAP,
};
