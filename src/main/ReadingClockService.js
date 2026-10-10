'use strict';
/**
 * ReadingClockService（知更）— 阅读生物钟（F36，零 AI 纯本地统计）
 *
 * 统计一周最佳阅读时段，让刷新建议 / 专注提示 / 简报对齐你的高峰期：
 * - 小时桶：reading_clock(day, hour) 两路喂入——
 *     ① markRead（未读→已读）→ count +1（AppStore 钩子，重复已读不计）；
 *     ② 阅读时长：渲染层 reader 开启文章期间的 15s 心跳 → pulse(ms) 累计 total_ms
 *        （单脉冲钳制 ≤ PULSE_MAX_MS，睡眠/休眠不会虚增一个桶）。
 * - 高峰判定：近 7 天样本加权（weight = 1/(1+距今天数)，近一天权重最高），
 *   Top2 小时为「高峰时段」；窗口总样本 < MIN_SAMPLES → 不判定（冷启动不误判）。
 * - 对齐动作（全部温和、设置可关）：
 *     a) 刷新调度建议：自动刷新锚点小时不在高峰 → 设置页提示「建议改到 HH:00」；
 *     b) 高峰专注提示：处于高峰时段且浅色主题（渲染层判主题）→ 每天至多一次提示条；
 *     c) 简报生物钟行：每日简报顶部「你的生物钟：高峰 HH:00-HH:00」。
 *
 * 设计约束：
 * - DDL 只进 DatabaseMigrations v27；构造器只校验不建表（GardenService v23 同款口径）。
 * - 时间可注入（_now）、锚点小时可注入（advice 参数）——探针确定性测试。
 * - 窗外旧行惰性清理（KEEP_DAYS）：表体量 = 天数 × ≤24 行，无定时器。
 * - 喂入钩子 try/catch 静默：生物钟永不阻塞阅读主路径。
 */
const { nowSeconds } = require('./Models');

/** 规则常量（窗口/阈值/钳制全部集中于此）。 */
const CLOCK = {
  /** 高峰判定的回看窗口（天）。 */
  WINDOW_DAYS: 7,
  /** 窗口总样本（count 之和）低于此数不判定高峰——避免冷启动误判。 */
  MIN_SAMPLES: 20,
  /** 单次时长脉冲上限（ms）：超过视为休眠/挂起，只按上限计入。 */
  PULSE_MAX_MS: 120000,
  /** 单次时长脉冲下限（ms）：低于视为噪声丢弃。 */
  PULSE_MIN_MS: 1000,
  /** 单日高峰取的小时数（Top N）。 */
  PEAK_HOURS: 2,
  /** 桶滚动保留天数（含今天）。 */
  KEEP_DAYS: 35,
  /** 对齐动作偏好键（默认全开——动作皆温和，设置可关）。 */
  KEYS: {
    alignRefresh: 'RobinRead.clock.alignRefresh',
    focusPrompt: 'RobinRead.clock.focusPrompt',
    digestLine: 'RobinRead.clock.digestLine',
  },
};

/** 本地日期串（YYYY-MM-DD）+ 小时（0-23）——同一可注入时钟拆出。 */
function dayHourOf(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return { day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, hour: d.getHours() };
}

/** 两个 YYYY-MM-DD 的天数差（b - a；纯日历运算，无时区漂移）。 */
function dayDiff(a, b) {
  const pa = String(a).split('-').map(Number);
  const pb = String(b).split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

/** 近一天权重最高的线性衰减：今天=1.0，6 天前=1/7。 */
function sampleWeight(ageDays) {
  return 1 / (1 + Math.max(0, ageDays));
}

/**
 * 高峰判定（纯函数，探针直测）：按加权分取 Top N 小时。
 * @param {Array<{hour:number, weight:number, count:number}>} samples 已加权样本
 * @returns {number[]} 高峰小时（升序；同分取更早的小时）
 */
function peakHoursFrom(samples, topN = CLOCK.PEAK_HOURS) {
  const scores = new Array(24).fill(0);
  for (const s of samples) {
    const h = Math.min(23, Math.max(0, Math.floor(Number(s.hour) || 0)));
    scores[h] += (Number(s.weight) || 0) * (Number(s.count) || 0);
  }
  const order = scores
    .map((score, hour) => ({ hour, score }))
    .filter((e) => e.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.hour - b.hour));
  return order.slice(0, topN).map((e) => e.hour).sort((a, b) => a - b);
}

/** 高峰窗口展示（相邻两小时合并成 HH:00-HH:00；不相邻用「 / 」连接）。 */
function peakWindowLabel(hours) {
  const list = [...(hours || [])].sort((a, b) => a - b);
  if (!list.length) return '';
  if (list.length === 1) return `${fmtHour(list[0])}-${fmtHour((list[0] + 1) % 24)}`;
  const [a, b] = list;
  if (b - a === 1) return `${fmtHour(a)}-${fmtHour((b + 1) % 24)}`;
  return `${fmtHour(a)} / ${fmtHour(b)}`;
}

function fmtHour(h) {
  return `${String(h).padStart(2, '0')}:00`;
}

class ReadingClockService {
  constructor(store, { now = null } = {}) {
    this.store = store;
    this._now = now || (() => Date.now() / 1000);
    this.counters = { reads: 0, pulses: 0, pulsesClamped: 0, pulsesDropped: 0, cleanups: 0 };
    const missing = ['reading_clock'].filter((t) => !this.store.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(t));
    if (missing.length) {
      throw new Error(`数据库 schema 缺少阅读生物钟表（${missing.join(', ')}）：DatabaseMigrations v27 未执行`);
    }
  }

  now() { return this._now(); }

  /** 喂入 ①：markRead 钩子（未读→已读计一次；重复已读静默忽略）。 */
  onRead({ at = null } = {}) {
    const ts = Number(at) || this._now();
    const { day, hour } = dayHourOf(ts);
    this._bump(day, hour, 'count', 1);
    this.counters.reads += 1;
    this._lazyCleanup();
  }

  /** 喂入 ②：阅读时长脉冲（渲染层心跳；越界钳制/丢弃，见 CLOCK）。 */
  pulse(ms, { at = null } = {}) {
    const value = Number(ms) || 0;
    if (value < CLOCK.PULSE_MIN_MS) { this.counters.pulsesDropped += 1; return { applied: false }; }
    const clamped = Math.min(value, CLOCK.PULSE_MAX_MS);
    if (clamped < value) this.counters.pulsesClamped += 1;
    const ts = Number(at) || this._now();
    const { day, hour } = dayHourOf(ts);
    this._bump(day, hour, 'total_ms', clamped);
    this.counters.pulses += 1;
    this._lazyCleanup();
    return { applied: true, ms: clamped };
  }

  _bump(day, hour, field, delta) {
    this.store.database.prepare(`
      INSERT INTO reading_clock (day, hour, count, total_ms, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(day, hour) DO UPDATE SET
        ${field} = ${field} + ?,
        updated_at = ?
    `).run(day, hour, field === 'count' ? delta : 0, field === 'total_ms' ? delta : 0, nowSeconds(), delta, nowSeconds());
  }

  /** 惰性清理窗外旧行（每次喂入顺手跑，DELETE 命中 0 行即零成本）。 */
  _lazyCleanup() {
    const cutoff = dayHourOf(this._now() - (CLOCK.KEEP_DAYS - 1) * 86400).day;
    const info = this.store.database.prepare('DELETE FROM reading_clock WHERE day < ?').run(cutoff);
    if (info.changes > 0) this.counters.cleanups += 1;
  }

  /** 近 7 天窗口样本（含加权；window 为 [{day,hour,count}] 的原始桶）。 */
  _window(nowTs = null) {
    const ts = Number(nowTs) || this._now();
    const today = dayHourOf(ts).day;
    const from = dayHourOf(ts - (CLOCK.WINDOW_DAYS - 1) * 86400).day;
    const rows = this.store.database.prepare(
      'SELECT day, hour, count, total_ms FROM reading_clock WHERE day >= ? AND day <= ? ORDER BY day, hour'
    ).all(from, today);
    const samples = rows
      .filter((r) => r.count > 0)
      .map((r) => ({ hour: r.hour, count: r.count, weight: sampleWeight(Math.max(0, dayDiff(r.day, today))) }));
    const total = rows.reduce((sum, r) => sum + (r.count || 0), 0);
    return { from, to: today, rows, samples, total };
  }

  /**
   * 高峰状态（读取侧统一出口）。
   * @returns {{ peak: number[]|null, peakLabel: string, samples: number,
   *             isPeakNow: boolean, buckets: number[24], ms: number[24], from, to }}
   */
  status({ now = null } = {}) {
    const ts = Number(now) || this._now();
    const { from, to, rows, samples, total } = this._window(ts);
    const buckets = new Array(24).fill(0);
    const ms = new Array(24).fill(0);
    for (const r of rows) {
      buckets[r.hour] += r.count || 0;
      ms[r.hour] += r.total_ms || 0;
    }
    const enough = total >= CLOCK.MIN_SAMPLES;
    const peak = enough ? peakHoursFrom(samples) : null;
    const currentHour = dayHourOf(ts).hour;
    return {
      peak,
      peakLabel: peak ? peakWindowLabel(peak) : '',
      samples: total,
      minSamples: CLOCK.MIN_SAMPLES,
      isPeakNow: Boolean(peak && peak.includes(currentHour)),
      currentHour,
      buckets,
      ms,
      from,
      to,
    };
  }

  /**
   * 刷新调度建议：锚点小时不在高峰时提示「建议改到 HH:00」（温和，不强制改）。
   * @param {{anchorHour: number|null, now?: number}} opts anchorHour=null 表示暂无固定
   *        刷新锚点（从未刷新/仅手动）——同样给出高峰锚点建议。
   */
  refreshAdvice({ anchorHour = null, now = null } = {}) {
    const st = this.status({ now });
    if (!st.peak) return { peak: null, suggest: false, hour: null, label: '', reason: 'no-peak' };
    const anchor = Number.isFinite(Number(anchorHour)) && anchorHour !== null ? Number(anchorHour) : null;
    const aligned = anchor !== null && st.peak.includes(anchor);
    const hour = st.peak[0];
    return {
      peak: st.peak,
      peakLabel: st.peakLabel,
      suggest: !aligned,
      anchorHour: anchor,
      hour,
      label: `${fmtHour(hour)}`,
      reason: aligned ? 'aligned' : (anchor === null ? 'no-anchor' : 'off-peak'),
    };
  }

  /** 高峰专注提示判定（每天至多一次；渲染层再叠加「浅色主题」条件）。 */
  shouldPromptFocus({ now = null } = {}) {
    if (!this.getConfig().focusPrompt) return false;
    const ts = Number(now) || this._now();
    const st = this.status({ now: ts });
    if (!st.isPeakNow) return false;
    const day = dayHourOf(ts).day;
    return this.store.preferences.get('RobinRead.clock.focusPromptDay', '') !== day;
  }

  /** 记录「今天已提示过」（用户看到提示条即记，无论点没点）。 */
  markFocusPrompted({ now = null } = {}) {
    const ts = Number(now) || this._now();
    this.store.preferences.set('RobinRead.clock.focusPromptDay', dayHourOf(ts).day);
  }

  /** 对齐动作开关（默认全开）。 */
  getConfig() {
    return {
      alignRefresh: this.store.preferences.get(CLOCK.KEYS.alignRefresh, true) !== false,
      focusPrompt: this.store.preferences.get(CLOCK.KEYS.focusPrompt, true) !== false,
      digestLine: this.store.preferences.get(CLOCK.KEYS.digestLine, true) !== false,
    };
  }

  configure(patch = {}) {
    const next = this.getConfig();
    for (const key of ['alignRefresh', 'focusPrompt', 'digestLine']) {
      if (patch[key] === true || patch[key] === false) {
        this.store.preferences.set(CLOCK.KEYS[key], patch[key]);
        next[key] = patch[key];
      }
    }
    return next;
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return { ...this.counters, ...CLOCK, config: this.getConfig(), status: this.status() };
  }
}

module.exports = {
  ReadingClockService,
  CLOCK,
  dayHourOf,
  dayDiff,
  sampleWeight,
  peakHoursFrom,
  peakWindowLabel,
  fmtHour,
};
