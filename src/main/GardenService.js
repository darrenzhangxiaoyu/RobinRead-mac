'use strict';
/**
 * GardenService（知更）— 知识花园 · 知更养成（F23，零 AI 纯本地统计）
 *
 * 阅读行为滋养一座纸感花园 + 一只知更鸟：
 * - 阳光   = 连续阅读天数（sun_streak，断一天清零重计）
 * - 水滴   = 完读篇数（water_total；每篇只计一次——garden_events UNIQUE(kind,ref) 防刷）
 * - 养分   = 批注数（seed_total；批注 ≥ NOTE_MIN_CHARS 字才算种子）
 * - 成长   = 种子→幼苗→花蕾→盛开→满园 五阶段（STAGE_RULES 全部满足才跃迁，只升不降）
 * - 枯萎   = 断读一天枯萎一级（不掉回零；单次断读至多枯 WILT_MAX_DROP_PER_GAP 级，
 *            长假不毁园）；回读复活（当日有行为且阶段回升 → revive 事件）
 * - 知更鸟 = 羽毛随累计完读数升级（FEATHER_READS 五档）
 *
 * 设计约束：
 * - DDL 只进 DatabaseMigrations v23（garden_state 单行 + garden_events 流水）；
 *   构造器只校验不建表（EvolutionEngine v9 同款口径）。
 * - 规则常量全部集中在 GARDEN；阶段/羽毛判定为纯函数（探针直测）。
 * - 时间可注入（_now），事件可直注（applyActivity）——探针确定性测试。
 * - 完读/批注钩子由 AppStore.markRead 与 KnowledgeEngine.addNote/addHighlight 调用，
 *   钩子侧 try/catch 静默：花园永不阻塞阅读主路径。
 * - 视觉（生成式 SVG 花园）在渲染层 garden-art.js：确定性生成（同状态逐字节同输出），
 *   本服务只提供数值状态与开花报告。
 */
const { nowSeconds, uuid } = require('./Models');

/** 规则常量（防刷/阶段/羽毛全部集中于此）。 */
const GARDEN = {
  /** 成长阶段键（渲染层按 key 取本地化名与视觉档）。 */
  STAGE_KEYS: ['seed', 'sprout', 'bud', 'bloom', 'full'],
  /** 批注 ≥ N 字才算种子（防「一划一存」刷养分）。 */
  NOTE_MIN_CHARS: 10,
  /** 断读一天枯萎一级。 */
  WILT_LEVELS_PER_MISSED_DAY: 1,
  /** 单次断读（连续缺勤多天）至多枯萎两级——长假回来花园还在。 */
  WILT_MAX_DROP_PER_GAP: 2,
  /** 知更鸟羽毛档：累计完读数阈值（5 档，含起点）。 */
  FEATHER_READS: [0, 10, 30, 80, 200],
  /**
   * 阶段准入规则（下标=阶段；sun=连续天数 water=累计完读 seeds=累计种子）。
   * 单调递增，全部满足才跃迁。
   */
  STAGE_RULES: [
    null,                            // 0 种子（初始）
    { sun: 1, water: 1, seeds: 1 },  // 1 幼苗：浇过水且至少一颗种子发了芽
    { sun: 2, water: 4, seeds: 2 },  // 2 花蕾
    { sun: 4, water: 10, seeds: 4 }, // 3 盛开
    { sun: 7, water: 20, seeds: 8 }, // 4 满园
  ],
  /** 开花报告回看窗口（天）。 */
  WEEK_REPORT_DAYS: 7,
};

/** 阶段判定（纯函数）：满足的最高阶段；规则单调，逐档判定。 */
function stageFromProgress(sunStreak, waterTotal, seedTotal) {
  let stage = 0;
  for (let i = 1; i < GARDEN.STAGE_RULES.length; i += 1) {
    const rule = GARDEN.STAGE_RULES[i];
    if (sunStreak >= rule.sun && waterTotal >= rule.water && seedTotal >= rule.seeds) stage = i;
    else break;
  }
  return stage;
}

/** 羽毛档判定（纯函数）：累计完读数所在的最高档。 */
function featherStage(totalReads) {
  let tier = 0;
  for (let i = 1; i < GARDEN.FEATHER_READS.length; i += 1) {
    if (totalReads >= GARDEN.FEATHER_READS[i]) tier = i;
  }
  return tier;
}

/** 本地日期串（YYYY-MM-DD）。 */
function dayOf(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 两个 YYYY-MM-DD 的天数差（b - a；纯日历运算，无时区漂移）。 */
function dayDiff(a, b) {
  const pa = String(a).split('-').map(Number);
  const pb = String(b).split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

class GardenService {
  constructor(store, { now = null } = {}) {
    this.store = store;
    this._now = now || (() => Date.now() / 1000);
    this.counters = { waters: 0, seeds: 0, wilts: 0, revives: 0, stageUps: 0, featherUps: 0, dedupHits: 0 };
    const required = ['garden_state', 'garden_events'];
    const missing = required.filter((t) => !this.store.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(t));
    if (missing.length) {
      throw new Error(`数据库 schema 缺少知识花园表（${missing.join(', ')}）：DatabaseMigrations v23 未执行`);
    }
    this.store.database.prepare(`
      INSERT OR IGNORE INTO garden_state (id, stage, sun_streak, water_total, seed_total, wilt_level, last_active_day, created_at, updated_at)
      VALUES (1, 0, 0, 0, 0, 0, NULL, ?, ?)
    `).run(nowSeconds(), nowSeconds());
  }

  now() { return this._now(); }

  _row() {
    return this.store.database.prepare('SELECT * FROM garden_state WHERE id = 1').get();
  }

  _persist(row) {
    this.store.database.prepare(`
      UPDATE garden_state SET stage = ?, sun_streak = ?, water_total = ?, seed_total = ?,
        wilt_level = ?, last_active_day = ?, updated_at = ?
      WHERE id = 1
    `).run(row.stage, row.sun_streak, row.water_total, row.seed_total, row.wilt_level, row.last_active_day, nowSeconds());
  }

  /**
   * 单日事件（water / seed）入口：日切换（枯萎/复活/连击）先行，再落事件、
   * 重算阶段与羽毛。ref 重复（已浇过/已结过）静默吞掉——防刷核心。
   * @returns {{ applied: boolean, stage: number, changed: boolean }}
   */
  applyActivity(kind, ref, { points = 1, payload = null } = {}) {
    const db = this.store.database;
    const row = this._row();
    const day = dayOf(this._now());
    const events = [];
    let changed = false;

    // ── 日切换：枯萎 → 连击重算 ──
    if (row.last_active_day && day > row.last_active_day) {
      const missed = dayDiff(row.last_active_day, day) - 1; // 缺勤天数（今日已在读不计）
      if (missed > 0) {
        const drop = Math.min(
          missed * GARDEN.WILT_LEVELS_PER_MISSED_DAY,
          GARDEN.WILT_MAX_DROP_PER_GAP,
          row.stage,
        );
        if (drop > 0) {
          row.stage -= drop;
          row.wilt_level = drop;
          events.push({ kind: 'wilt', ref: day, points: -drop, payload: { drop, missed } });
          this.counters.wilts += 1;
          changed = true;
        }
        row.sun_streak = 0; // 连击断档（阶段只降级不归零——「不掉回零」）
      }
    }

    // ── 阳光：今日首次活动 +1（同日幂等；断档重计从 1 起）──
    // 时钟回拨防护（批 B 审查 P2-4）：已有活动日且 day <= last_active_day 视为同日，
    // 回拨一天读一篇不可无限刷连击（满园 sun 门槛否则可被纯刷穿）；last_active_day 为空=首次活动照常 +1。
    const sameDay = Boolean(row.last_active_day) && day <= row.last_active_day;
    if (!sameDay) row.sun_streak += 1;
    const wiltedToday = events.some((e) => e.kind === 'wilt');

    // ── 事件本体（UNIQUE(kind, ref) 防刷：重复即零成本吞掉） ──
    const info = db.prepare(`
      INSERT OR IGNORE INTO garden_events (id, kind, ref, day, points, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), kind, String(ref || ''), day, points, payload ? JSON.stringify(payload) : null, nowSeconds());
    if (info.changes > 0) {
      if (kind === 'water') { row.water_total += 1; this.counters.waters += 1; }
      else if (kind === 'seed') { row.seed_total += 1; this.counters.seeds += 1; }
      events.push({ kind, ref, points, payload });
      changed = true;
    } else {
      this.counters.dedupHits += 1;
    }

    // ── 阶段：只升不降（降级只走枯萎路径）；枯萎档未清零时回升即「复活」──
    // （复活常滞后一天：枯萎日连击重置，阶段凭水/养分数常当日回升不到——
    //   只要 wilt_level 仍在，之后任何一次跃迁都视为复活。）
    const grown = stageFromProgress(row.sun_streak, row.water_total, row.seed_total);
    if (grown > row.stage) {
      const from = row.stage;
      const hadWilt = row.wilt_level > 0;
      row.stage = grown;
      row.wilt_level = 0;
      events.push({ kind: 'stage', ref: `${grown}@${day}`, points: grown - from, payload: { from, to: grown } });
      this.counters.stageUps += 1;
      if (wiltedToday || hadWilt) { // 断读枯萎后的回升 = 回读复活
        events.push({ kind: 'revive', ref: `r${day}`, points: 0, payload: { stage: grown } });
        this.counters.revives += 1;
      }
      changed = true;
    }

    // ── 知更羽毛：随累计完读升级（water_total 单调不减 → 每档至多一次） ──
    const feather = featherStage(row.water_total);
    if (feather > featherStage(row.water_total - (info.changes > 0 && kind === 'water' ? 1 : 0))) {
      events.push({ kind: 'feather', ref: `f${feather}`, points: 0, payload: { tier: feather } });
      this.counters.featherUps += 1;
      changed = true;
    }

    row.last_active_day = day;
    this._persist(row);
    const insertEvent = db.prepare(`
      INSERT OR IGNORE INTO garden_events (id, kind, ref, day, points, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const e of events) {
      insertEvent.run(uuid(), e.kind, String(e.ref), day, e.points, e.payload ? JSON.stringify(e.payload) : null, nowSeconds());
    }

    const state = this.state();
    if (changed) {
      try { this.store.emit('garden:changed', state); } catch (_) { /* 无订阅者不阻塞 */ }
    }
    return { applied: info.changes > 0, stage: row.stage, changed };
  }

  /** 完读浇水（AppStore.markRead 钩子；未读→已读才计，重复完读被 UNIQUE 吞掉）。 */
  onComplete({ entryID }) {
    const id = String(entryID || '').trim();
    if (!id) return { applied: false, stage: this._row().stage, changed: false };
    return this.applyActivity('water', id);
  }

  /** 批注种子（KnowledgeEngine 钩子；< N 字不结种——防刷）。 */
  onSeed({ ref, chars = 0 }) {
    const row = this._row();
    const id = String(ref || '').trim();
    if (!id || Number(chars) < GARDEN.NOTE_MIN_CHARS) {
      return { applied: false, stage: row.stage, changed: false };
    }
    return this.applyActivity('seed', id, { payload: { chars: Number(chars) } });
  }

  /** 当前状态（渲染层花园徽章/浮层数据面）。 */
  state() {
    const row = this._row();
    const day = dayOf(this._now());
    const waterToday = this.store.database.prepare(
      "SELECT COUNT(*) AS n FROM garden_events WHERE kind = 'water' AND day = ?"
    ).get(day).n;
    const seedToday = this.store.database.prepare(
      "SELECT COUNT(*) AS n FROM garden_events WHERE kind = 'seed' AND day = ?"
    ).get(day).n;
    const stage = row.stage;
    return {
      stage,
      stageKey: GARDEN.STAGE_KEYS[stage] || 'seed',
      sunStreak: row.sun_streak,
      waterToday,
      waterTotal: row.water_total,
      seedTotal: row.seed_total,
      seedToday,
      wiltLevel: row.wilt_level,
      lastActiveDay: row.last_active_day,
      day,
      birdStage: featherStage(row.water_total),
      featherMax: GARDEN.FEATHER_READS.length - 1,
      nextRule: stage < GARDEN.STAGE_RULES.length - 1 ? GARDEN.STAGE_RULES[stage + 1] : null,
      noteMinChars: GARDEN.NOTE_MIN_CHARS,
      challengeDecor: this._decor(row), // F40 挑战赛季限定装饰（v30 列；老库无列时为 []）
    };
  }

  /** 限定装饰投影（challenge_decor JSON 数组；坏 JSON/缺列容错为空）。 */
  _decor(row = null) {
    const raw = (row || this._row()).challenge_decor;
    try {
      const list = JSON.parse(raw || '[]');
      return Array.isArray(list) ? list : [];
    } catch (_) { return []; }
  }

  /**
   * 发放限定装饰（F40 挑战赛季奖励入口；按 decor.id 幂等——重复发放零增量）。
   * @param {{ id: string, kind?: string, label?: string }} decor
   * @returns {{ applied: boolean, decor: object[] }}
   */
  grantDecor(decor) {
    const id = String((decor && decor.id) || '').trim();
    if (!id) return { applied: false, decor: this._decor() };
    const list = this._decor();
    if (list.some((d) => d && d.id === id)) return { applied: false, decor: list };
    list.push({
      id,
      kind: String((decor && decor.kind) || 'challenge'),
      label: String((decor && decor.label) || '').slice(0, 60),
      grantedAt: nowSeconds(),
    });
    this.store.database.prepare('UPDATE garden_state SET challenge_decor = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(list), nowSeconds());
    try { this.store.emit('garden:changed', this.state()); } catch (_) { /* 无订阅者不阻塞 */ }
    return { applied: true, decor: this._decor() };
  }

  /** 开花报告：本周（回看 WEEK_REPORT_DAYS 天）统计 + 阶段跃迁 + 新开花清单。 */
  weeklyReport() {
    const db = this.store.database;
    const today = dayOf(this._now());
    const from = dayOf(this._now() - (GARDEN.WEEK_REPORT_DAYS - 1) * 86400);
    const days = [];
    for (let i = 0; i < GARDEN.WEEK_REPORT_DAYS; i += 1) {
      const d = dayOf(this._now() - (GARDEN.WEEK_REPORT_DAYS - 1 - i) * 86400);
      const waters = db.prepare("SELECT COUNT(*) AS n FROM garden_events WHERE kind = 'water' AND day = ?").get(d).n;
      const seeds = db.prepare("SELECT COUNT(*) AS n FROM garden_events WHERE kind = 'seed' AND day = ?").get(d).n;
      days.push({ day: d, waters, seeds });
    }
    const stageUps = db.prepare(`
      SELECT day, payload_json FROM garden_events
      WHERE kind = 'stage' AND day >= ? ORDER BY created_at ASC
    `).all(from).map((r) => {
      let payload = null;
      try { payload = JSON.parse(r.payload_json || 'null'); } catch (_) { /* 容错 */ }
      return { day: r.day, ...(payload || {}) };
    });
    const newBlooms = stageUps.filter((e) => (e.to || 0) >= 3);
    const state = this.state();
    return {
      from,
      to: today,
      days,
      waters: days.reduce((s, d) => s + d.waters, 0),
      seeds: days.reduce((s, d) => s + d.seeds, 0),
      stageUps,
      newBlooms,
      birdStage: state.birdStage,
      stage: state.stage,
      sunStreak: state.sunStreak,
    };
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return {
      ...this.counters,
      ...GARDEN,
      state: this.state(),
    };
  }
}

module.exports = {
  GardenService,
  GARDEN,
  stageFromProgress,
  featherStage,
  dayOf,
  dayDiff,
};
