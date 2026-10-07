'use strict';
/**
 * RobinRead（知更）— 规则过滤引擎（F2）
 *
 * 用户可对流入的文章配置规则（对标 Inoreader Filters / Feedbin Rules）：
 *   作用域（全局 / 指定源多选） + 条件组合（全部满足 / 任一满足） + 动作（可多选）
 * 在新文章灌入库时（_applyParsedEntries 之后、状态推送之前）同步应用——
 * 纯内存匹配 + 批量写走单事务；另提供「对最近 200 篇回放」入口与规则测试器。
 *
 * 契约：
 * - 匹配字段全在内存（标题/摘要/作者/URL 来自同一条 IN 查询；正文缓存仅在
 *   有规则用到 body 字段时随同一查询 LEFT JOIN 一次，禁止为匹配额外查库）；
 * - 不可信内容只做 includes/startsWith/RegExp 测试，绝不 eval；正则一律
 *   new RegExp(value, 'i')（global 关闭），长度 ≤200，保存时拒绝编译失败与
 *   嵌套量词（catastrophic 回溯高危形态），运行期再包 try/catch 兜底；
 * - 规则总数 ≤50，单源适用规则 ≤20；动作执行失败不影响入库主流程
 *   （匹配逐规则独立 try/catch，整体再兜一层）；
 * - 已读/收藏/稍后读走既有 ArticleStateRepository 写通路（统计自然入账），
 *   同步账户的变更照常进 outbox；打标签复用 article_tags（source='rule'）。
 */
const { i18n } = require('./I18N');
const { plainText, uuid, nowSeconds, LOCAL_ACCOUNT_ID } = require('./Models');

const MAX_RULES = 50;            // 规则总数上限
const MAX_RULES_PER_FEED = 20;   // 单源适用规则上限（全局规则计入每个源）
const MAX_CONDITIONS = 20;       // 单规则条件行上限
const MAX_ACTIONS = 10;          // 单规则动作上限
const VALUE_MAX = 200;           // 条件值长度上限（正则同限）
const NAME_MAX = 100;            // 规则名长度上限
const TAG_MAX = 50;              // 标签名长度上限
const REPLAY_LIMIT = 200;        // 回放最近文章数上限
const SAMPLES_LIMIT = 20;        // 测试器「最近文章」样本数

const FIELDS = ['title', 'summary', 'author', 'url', 'body'];
const OPS = ['contains', 'notContains', 'regex', 'notRegex', 'startsWith', 'endsWith'];
const SIMPLE_ACTIONS = ['read', 'star', 'later'];

/**
 * 嵌套量词高危形态探测（catastrophic backtracking 风险）：
 * 捕获「捕获组/字符组的最后一个语元自带量词（+ * {n,}），且组本身又带量词」
 * 的经典爆炸形态，如 (a+)+、(a*)*、(a|b{1,9}){2,}。启发式拒绝 + 长度限制 +
 * 运行期 try/catch 三层防护（并非完备的 ReDoS 证明器，够用的安全边际）。
 */
const NESTED_QUANTIFIER_RE = /(?:\((?:[^()\\]|\\.|\([^()]*\))*[+*}]\s*\)|\[[^\]]*[+*}]\s*\])[+*{]/;

/** 规则行 → API 形态（scope/match 展平，JSON 列解包）。 */
function ruleFromRow(row) {
  let scope = { kind: 'all' };
  let conditionsEnvelope = { mode: 'all', list: [] };
  let actions = [];
  try { scope = JSON.parse(row.scope_json || '{}'); } catch (_) { /* 兜底全局 */ }
  try { conditionsEnvelope = JSON.parse(row.conditions_json || '{}'); } catch (_) { /* 兜底空 */ }
  try { actions = JSON.parse(row.actions_json || '[]'); } catch (_) { /* 兜底空 */ }
  const conditions = Array.isArray(conditionsEnvelope.list) ? conditionsEnvelope.list : [];
  // 正常路径 conditions ≥1（saveRule 强制）；空列表只可能来自坏 JSON——
  // 按「惰性规则」处理（all 空条件会命中一切，批量自动已读是最坏的失败形态）
  const inert = conditions.length === 0;
  return {
    id: row.id,
    name: row.name,
    scope: scope && scope.kind === 'feeds' ? { kind: 'feeds', ids: Array.isArray(scope.ids) ? scope.ids : [] } : { kind: 'all' },
    match: conditionsEnvelope.mode === 'any' ? 'any' : 'all',
    conditions,
    actions: Array.isArray(actions) ? actions : [],
    enabled: Number(row.enabled) === 1 && !inert,
    priority: Number(row.priority) || 0,
    hitCount: Number(row.hit_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class RulesEngine {
  constructor(store) {
    this.store = store;
    this._compiledVersion = -1; // 编译缓存失效号（任意 CRUD 递增）
    this._rulesVersion = 0;
    this.counters = { applies: 0, transactions: 0, matchedEntries: 0, errors: 0 };
  }

  // MARK: - 规则 CRUD

  /** 全部规则（按执行顺序：priority 升序、created_at 升序）。 */
  listRules() {
    return this.store.database.prepare(
      'SELECT * FROM filter_rules ORDER BY priority ASC, created_at ASC'
    ).all().map(ruleFromRow);
  }

  rule(id) {
    const row = this.store.database.prepare('SELECT * FROM filter_rules WHERE id = ?').get(id);
    return row ? ruleFromRow(row) : null;
  }

  /** 新建（不带 id）/ 更新（带 id）规则；保存前全量校验 + 配额检查。 */
  saveRule(payload) {
    const draft = this._validate(payload || {});
    const now = nowSeconds();
    const scopeJSON = JSON.stringify(draft.scope);
    const conditionsJSON = JSON.stringify({ mode: draft.match, list: draft.conditions });
    const actionsJSON = JSON.stringify(draft.actions);
    if (payload.id) {
      const existing = this.rule(payload.id);
      if (!existing) throw new Error(i18n.localized('规则不存在或已删除。'));
      this._assertQuotas(draft, payload.id);
      this.store.database.prepare(`
        UPDATE filter_rules SET name = ?, scope_json = ?, conditions_json = ?, actions_json = ?,
          enabled = ?, updated_at = ?
        WHERE id = ?
      `).run(draft.name, scopeJSON, conditionsJSON, actionsJSON, draft.enabled ? 1 : 0, now, payload.id);
      this._bumpVersion();
      return this.rule(payload.id);
    }
    this._assertQuotas(draft, null);
    const id = `rule-${uuid()}`;
    const maxRow = this.store.database.prepare('SELECT COALESCE(MAX(priority), -1) AS p FROM filter_rules').get();
    this.store.database.prepare(`
      INSERT INTO filter_rules (id, name, scope_json, conditions_json, actions_json, enabled, priority, hit_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, draft.name, scopeJSON, conditionsJSON, actionsJSON, draft.enabled ? 1 : 0, (Number(maxRow?.p) ?? -1) + 1, now, now);
    this._bumpVersion();
    return this.rule(id);
  }

  deleteRule(id) {
    const { changes } = this.store.database.prepare('DELETE FROM filter_rules WHERE id = ?').run(id);
    if (changes > 0) this._bumpVersion();
    return changes > 0;
  }

  setRuleEnabled(id, enabled) {
    const { changes } = this.store.database.prepare(
      'UPDATE filter_rules SET enabled = ?, updated_at = ? WHERE id = ?'
    ).run(enabled ? 1 : 0, nowSeconds(), id);
    if (changes > 0) this._bumpVersion();
    return changes > 0;
  }

  /** 上移 / 下移（与相邻规则交换 priority，随后重排紧凑）。 */
  moveRule(id, direction) {
    const rules = this.listRules();
    const index = rules.findIndex((r) => r.id === id);
    if (index < 0) throw new Error(i18n.localized('规则不存在或已删除。'));
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= rules.length) return false;
    const swap = rules[index];
    rules[index] = rules[target];
    rules[target] = swap;
    this._repack(rules);
    this._bumpVersion();
    return true;
  }

  /** 按给定顺序重排（拖拽落点用；保持 id 集合一致）。 */
  reorderRules(orderedIDs) {
    const byID = new Map(this.listRules().map((r) => [r.id, r]));
    const ordered = (Array.isArray(orderedIDs) ? orderedIDs : [])
      .map((id) => byID.get(id)).filter(Boolean);
    if (ordered.length !== byID.size) throw new Error(i18n.localized('规则顺序不完整，请刷新后重试。'));
    this._repack(ordered);
    this._bumpVersion();
    return true;
  }

  _repack(orderedRules) {
    const update = this.store.database.prepare('UPDATE filter_rules SET priority = ? WHERE id = ?');
    this.store.database.transaction(() => {
      orderedRules.forEach((rule, index) => update.run(index, rule.id));
    });
  }

  _bumpVersion() {
    this._rulesVersion += 1;
    this.store._emitState();
  }

  // MARK: - 校验（编辑器保存 + 探针共用）

  /**
   * 校验并规范化规则草稿。非法即抛本地化错误（编辑器红线提示同一套文案）。
   * 返回 { name, scope, match, conditions, actions, enabled }。
   */
  _validate(payload) {
    const name = String(payload.name ?? '').trim();
    if (!name) throw new Error(i18n.localized('请填写规则名称。'));
    if (name.length > NAME_MAX) throw new Error(i18n.localized('规则名称过长（最多 100 字）。'));

    const match = payload.match === 'any' ? 'any' : 'all';

    const conditions = Array.isArray(payload.conditions) ? payload.conditions : [];
    if (conditions.length < 1) throw new Error(i18n.localized('至少需要一条条件。'));
    if (conditions.length > MAX_CONDITIONS) throw new Error(i18n.localized('条件行过多（最多 20 条）。'));
    const normalizedConditions = conditions.map((condition, index) => {
      const field = String(condition?.field ?? '');
      const op = String(condition?.op ?? '');
      const value = String(condition?.value ?? '').trim();
      if (!FIELDS.includes(field)) throw new Error(i18n.localized('条件字段不受支持。'));
      if (!OPS.includes(op)) throw new Error(i18n.localized('条件操作符不受支持。'));
      if (!value) throw new Error(i18n.localized('条件值不能为空。'));
      if (value.length > VALUE_MAX) {
        throw new Error(i18n.localized('条件值过长（最多 200 字，正则同限）。'));
      }
      if (op === 'regex' || op === 'notRegex') this._assertSafeRegex(value);
      return { field, op, value };
    });

    const rawActions = Array.isArray(payload.actions) ? payload.actions : [];
    if (rawActions.length < 1) throw new Error(i18n.localized('至少选择一个动作。'));
    if (rawActions.length > MAX_ACTIONS) throw new Error(i18n.localized('动作过多（最多 10 个）。'));
    const actions = [];
    for (const raw of rawActions) {
      const action = String(raw ?? '');
      if (SIMPLE_ACTIONS.includes(action)) {
        if (!actions.includes(action)) actions.push(action);
        continue;
      }
      const tagMatch = /^tag:(.*)$/.exec(action);
      if (tagMatch) {
        const tag = tagMatch[1].trim();
        if (!tag || tag.length > TAG_MAX) throw new Error(i18n.localized('标签名长度需在 1-50 字之间。'));
        if (/[\x00-\x1f]/.test(tag)) throw new Error(i18n.localized('标签名含非法字符。'));
        const actionTag = `tag:${tag}`;
        if (!actions.includes(actionTag)) actions.push(actionTag);
        continue;
      }
      throw new Error(i18n.localized('动作不受支持。'));
    }

    let scope = payload.scope || { kind: 'all' };
    if (scope.kind === 'feeds') {
      const ids = [...new Set((Array.isArray(scope.ids) ? scope.ids : []).map(String).filter(Boolean))];
      if (!ids.length) throw new Error(i18n.localized('指定源作用域至少选择一个订阅源。'));
      scope = { kind: 'feeds', ids };
    } else {
      scope = { kind: 'all' };
    }

    return { name, scope, match, conditions: normalizedConditions, actions, enabled: payload.enabled !== false };
  }

  /** 正则安全门：长度 ≤200 + 可编译 + 拒绝嵌套量词高危形态。 */
  _assertSafeRegex(value) {
    if (value.length > VALUE_MAX) throw new Error(i18n.localized('正则过长（最多 200 字）。'));
    let re;
    try {
      re = new RegExp(value, 'i'); // global 关闭：防 lastIndex 状态串味
    } catch (_) {
      throw new Error(i18n.localized('正则表达式无法编译，请检查语法。'));
    }
    if (NESTED_QUANTIFIER_RE.test(value)) {
      throw new Error(i18n.localized('正则含嵌套量词（如 (a+)+），有灾难性回溯风险，已被拒绝。'));
    }
    return re;
  }

  /** 配额：总数 ≤50；单源适用规则 ≤20（全局规则计入每个现有源）。 */
  _assertQuotas(draft, excludeID) {
    const existing = this.listRules().filter((r) => r.id !== excludeID);
    if (existing.length + 1 > MAX_RULES) {
      throw new Error(i18n.localized('规则总数已达上限（50 条）。'));
    }
    // 计算每源现有适用数
    const perFeed = new Map();
    const addFeed = (feedID, n = 1) => perFeed.set(feedID, (perFeed.get(feedID) || 0) + n);
    for (const rule of existing) {
      if (rule.scope.kind === 'all') {
        for (const feed of this.store.feedsRepo.allFeeds()) addFeed(feed.id);
      } else {
        for (const feedID of rule.scope.ids) addFeed(feedID);
      }
    }
    const affected = draft.scope.kind === 'all'
      ? this.store.feedsRepo.allFeeds().map((f) => f.id)
      : draft.scope.ids;
    for (const feedID of affected) {
      if ((perFeed.get(feedID) || 0) + 1 > MAX_RULES_PER_FEED) {
        throw new Error(i18n.localized('单个订阅源适用的规则已达上限（20 条）。'));
      }
    }
  }

  // MARK: - 编译与匹配（纯内存，无 IO）

  /** 启用规则编译缓存（CRUD 后失效重编）。 */
  enabledCompiledRules() {
    if (this._compiledVersion !== this._rulesVersion || !this._compiledCache) {
      this._compiledCache = this.listRules()
        .filter((r) => r.enabled)
        .map((rule) => {
          const conditionFields = new Set(rule.conditions.map((c) => c.field));
          const compiledConditions = rule.conditions.map((condition) => ({
            ...condition,
            re: condition.op === 'regex' || condition.op === 'notRegex' ? compileQuietly(condition.value) : null,
          }));
          return { ...rule, conditionFields, compiledConditions };
        });
      this._compiledVersion = this._rulesVersion;
    }
    return this._compiledCache;
  }

  /** 单条件测试（编译期已保证字段/操作符合法，运行期再兜 try/catch）。 */
  _testCondition(condition, sample) {
    const text = sampleText(sample, condition.field);
    const value = String(condition.value ?? '');
    const lowerText = text.toLowerCase();
    const lowerValue = value.toLowerCase();
    switch (condition.op) {
      case 'contains': return lowerText.includes(lowerValue);
      case 'notContains': return !lowerText.includes(lowerValue);
      case 'startsWith': return lowerText.startsWith(lowerValue);
      case 'endsWith': return lowerText.endsWith(lowerValue);
      case 'regex': return condition.re ? safeRegexTest(condition.re, text) : false;
      case 'notRegex': return condition.re ? !safeRegexTest(condition.re, text) : true;
      default: return false;
    }
  }

  /**
   * 规则测试器：给定规则草稿与样本，返回逐条件命中明细 + 将执行的动作。
   * 草稿先过校验（非法正则等直接抛错，编辑器红线复用同一错误文案）。
   */
  testRule(payload, sample) {
    const draft = this._validate(payload || {});
    const compiled = {
      match: draft.match,
      compiledConditions: draft.conditions.map((condition) => ({
        ...condition,
        re: condition.op === 'regex' || condition.op === 'notRegex' ? compileQuietly(condition.value) : null,
      })),
    };
    const detail = this._matchCompiled(compiled, normalizeSample(sample));
    return {
      matched: detail.matched,
      mode: draft.match,
      conditions: detail.conditions.map((hit, index) => ({ index, ...hit })),
      actions: detail.matched ? draft.actions : [],
    };
  }

  _matchCompiled(compiledRule, sample) {
    const conditions = [];
    let allHit = true;
    let anyHit = false;
    for (const condition of compiledRule.compiledConditions) {
      let hit = false;
      try { hit = this._testCondition(condition, sample); }
      catch (_) { hit = false; /* 单条件运行异常按未命中，不炸测试器 */ }
      conditions.push({ field: condition.field, op: condition.op, value: condition.value, hit });
      if (hit) anyHit = true; else allHit = false;
    }
    return { matched: compiledRule.match === 'any' ? anyHit : allHit, conditions };
  }

  // MARK: - 刷新接线（灌文事务之后、状态推送之前）

  /**
   * 新文章灌入后的规则应用入口（_applyParsedEntries 内调用）：
   * 一次 IN 查询取匹配字段（仅当有规则用到正文时 JOIN 正文缓存一次），
   * 匹配纯内存，批量写单事务。任何异常不外抛（不影响入库主流程）。
   * 作用域判定按条目自身 feedID（本地 / 同步账户通吃）。
   */
  applyToNewEntries(entryIDs) {
    const ids = (Array.isArray(entryIDs) ? entryIDs : []).filter(Boolean);
    if (!ids.length) return null;
    let compiled;
    try { compiled = this.enabledCompiledRules(); } catch (err) { this.counters.errors += 1; return null; }
    if (!compiled.length) return null; // 零规则零成本（不查库）
    let entries;
    try {
      const needBody = compiled.some((rule) => rule.conditionFields.has('body'));
      entries = this._fetchForMatch(ids, needBody);
    } catch (err) {
      console.warn('[rules] fetch for match failed:', err?.message || err);
      this.counters.errors += 1;
      return null;
    }
    return this._applyCompiled(compiled, entries);
  }

  /**
   * 对最近 N 篇（默认 200，可限定单源）回放全部启用规则。
   * 动作幂等（已读/已收藏/已稍后读跳过写、标签 INSERT OR IGNORE）；
   * 命中计数按实际命中累加。返回回放摘要。
   */
  replayRecent({ limit = REPLAY_LIMIT, feedID = null } = {}) {
    const compiled = this.enabledCompiledRules();
    if (!compiled.length) return { scanned: 0, matched: 0, applied: { read: 0, star: 0, later: 0, tag: 0 } };
    const capped = Math.max(1, Math.min(Number(limit) || REPLAY_LIMIT, REPLAY_LIMIT));
    const needBody = compiled.some((rule) => rule.conditionFields.has('body'));
    const entries = this._fetchRecentForMatch(capped, feedID, needBody);
    const result = this._applyCompiled(compiled, entries);
    this.store._emitState();
    return result;
  }

  /** 测试器「从最近文章选一篇」样本列表（默认 20 篇；正文截前 2000 字防超大载荷）。 */
  recentSamples(limit = SAMPLES_LIMIT) {
    const capped = Math.max(1, Math.min(Number(limit) || SAMPLES_LIMIT, 50));
    return this.store.database.prepare(`
      SELECT i.id AS id, a.title AS title, a.author AS author, a.url AS url,
             a.summary AS summary, a.content_html AS content_html, c.text AS body_cache,
             f.title AS feed_title, f.id AS feed_id,
             COALESCE(a.published_at, i.created_at) AS published_at
      FROM items i
      LEFT JOIN articles a ON a.item_id = i.id
      LEFT JOIN article_caches c ON c.item_id = i.id
      LEFT JOIN feeds f ON f.id = i.feed_id
      ORDER BY COALESCE(a.published_at, i.created_at) DESC
      LIMIT ?
    `).all(capped).map((row) => ({
      id: row.id,
      title: row.title ?? '',
      author: row.author ?? '',
      url: row.url ?? '',
      summary: row.summary ?? '',
      body: ((row.body_cache != null && row.body_cache !== '')
        ? String(row.body_cache)
        : (row.content_html ? plainText(row.content_html) : '')).slice(0, 2000),
      feedTitle: row.feed_title ?? '',
      feedID: row.feed_id ?? '',
      publishedAt: row.published_at,
    }));
  }

  // MARK: - 匹配字段获取（一次 IN 查询；正文缓存仅按需 JOIN 一次）

  _fetchForMatch(entryIDs, needBody) {
    const placeholders = entryIDs.map(() => '?').join(',');
    const sql = `
      SELECT i.id AS id, i.account_id AS account_id, i.feed_id AS feed_id,
             a.title AS title, a.author AS author, a.url AS url,
             a.summary AS summary
             ${needBody ? ', a.content_html AS content_html' : ''},
             COALESCE(s.is_read, 0) AS is_read, COALESCE(s.is_starred, 0) AS is_starred,
             COALESCE(s.is_later, 0) AS is_later
             ${needBody ? ', c.text AS body_cache' : ''}
      FROM items i
      LEFT JOIN articles a ON a.item_id = i.id
      LEFT JOIN article_states s ON s.item_id = i.id
      ${needBody ? 'LEFT JOIN article_caches c ON c.item_id = i.id' : ''}
      WHERE i.id IN (${placeholders})
    `;
    return this.store.database.prepare(sql).all(...entryIDs).map((row) => rowToMatchEntry(row, needBody));
  }

  _fetchRecentForMatch(limit, feedID, needBody) {
    const sql = `
      SELECT i.id AS id, i.account_id AS account_id, i.feed_id AS feed_id,
             a.title AS title, a.author AS author, a.url AS url,
             a.summary AS summary
             ${needBody ? ', a.content_html AS content_html' : ''},
             COALESCE(s.is_read, 0) AS is_read, COALESCE(s.is_starred, 0) AS is_starred,
             COALESCE(s.is_later, 0) AS is_later
             ${needBody ? ', c.text AS body_cache' : ''}
      FROM items i
      LEFT JOIN articles a ON a.item_id = i.id
      LEFT JOIN article_states s ON s.item_id = i.id
      ${needBody ? 'LEFT JOIN article_caches c ON c.item_id = i.id' : ''}
      ${feedID ? 'WHERE i.feed_id = ?' : ''}
      ORDER BY COALESCE(a.published_at, i.created_at) DESC
      LIMIT ?
    `;
    const params = feedID ? [feedID, limit] : [limit];
    return this.store.database.prepare(sql).all(...params).map((row) => rowToMatchEntry(row, needBody));
  }

  // MARK: - 批量执行（单事务；状态走既有 repo 写通路）

  /**
   * 对条目批量执行启用规则：
   * - 逐条目 × 逐规则内存匹配（每规则独立 try/catch，坏规则不拖累其他）；
   * - 全部写操作（read/star/later/tag/命中计数/outbox）合并为单事务；
   * - 已是目标状态的条目跳过对应写（回放幂等）；标签 INSERT OR IGNORE。
   */
  _applyCompiled(compiledRules, entries) {
    if (!entries.length) return { scanned: 0, matched: 0, applied: { read: 0, star: 0, later: 0, tag: 0 } };
    this.counters.applies += 1;

    const readIDs = [];
    const starIDs = []; // { id, isRead }（增量推送需带原已读态）
    const laterIDs = [];
    const tagPairs = [];  // [entryID, tag]
    const outboxQueue = []; // [accountID, entryID, stateKey, value]
    const hitsByRule = new Map();
    let matchedEntries = 0;

    for (const entry of entries) {
      let entryHit = false;
      for (const rule of compiledRules) {
        if (!ruleAppliesToFeed(rule, entry.feedID)) continue;
        let matched = false;
        try { matched = this._matchCompiled(rule, entry).matched; }
        catch (_) { matched = false; /* 单规则异常独立兜底 */ }
        if (!matched) continue;
        entryHit = true;
        hitsByRule.set(rule.id, (hitsByRule.get(rule.id) || 0) + 1);
        for (const action of rule.actions) {
          if (action === 'read' && !entry.isRead) {
            readIDs.push(entry.id);
            if (entry.accountID !== LOCAL_ACCOUNT_ID) outboxQueue.push([entry.accountID, entry.id, 'read', true]);
          } else if (action === 'star' && !entry.isStarred) {
            starIDs.push({ id: entry.id, isRead: entry.isRead });
            if (entry.accountID !== LOCAL_ACCOUNT_ID) outboxQueue.push([entry.accountID, entry.id, 'starred', true]);
          } else if (action === 'later' && !entry.isLater) {
            laterIDs.push(entry.id);
          } else if (action.startsWith('tag:')) {
            tagPairs.push([entry.id, action.slice(4)]);
          }
        }
      }
      if (entryHit) matchedEntries += 1;
    }

    const hasWrites = readIDs.length + starIDs.length + laterIDs.length + tagPairs.length > 0;
    if (hasWrites || hitsByRule.size > 0) {
      this.counters.transactions += 1;
      this.store.database.transaction(() => {
        for (const id of readIDs) this.store.statesRepo.setRead(id, true);
        for (const item of starIDs) this.store.statesRepo.setStarred(item.id, true);
        for (const id of laterIDs) this.store.statesRepo.setLater(id, true);
        if (tagPairs.length) {
          const addTag = this.store.database.prepare(
            "INSERT OR IGNORE INTO article_tags (item_id, tag, source) VALUES (?, ?, 'rule')"
          );
          for (const [entryID, tag] of tagPairs) addTag.run(entryID, tag);
        }
        for (const [accountID, entryID, stateKey, value] of outboxQueue) {
          this.store.statesRepo.enqueueOutbox(accountID, entryID, stateKey, value);
        }
        if (hitsByRule.size > 0) {
          const bumpHit = this.store.database.prepare(
            'UPDATE filter_rules SET hit_count = hit_count + ?, updated_at = updated_at WHERE id = ?'
          );
          for (const [ruleID, count] of hitsByRule) bumpHit.run(count, ruleID);
        }
      });
      // 状态修订（事务提交后）：计数缓存失效 + 逐条目增量 + 行集变更（later/标签影响视野）
      // star 通知的 isRead 用「本批 read 规则写入后」的值——entry.isRead 是事务前快照，
      // 同批 read+star 双规则命中同条目时，陈旧 false 会覆盖先前的 read 通知（渲染层短暂回退未读样式）。
      const readSet = new Set(readIDs);
      this.store._noteEntryChange(null, true, false);
      for (const id of readIDs) this.store._noteEntryChange(id, true, false);
      for (const item of starIDs) this.store._noteEntryChange(item.id, readSet.has(item.id) || item.isRead, true);
      if (laterIDs.length || tagPairs.length) this.store._bumpListSet();
      if (outboxQueue.length) this.store._scheduleOutboxDrain(1500);
      this.counters.matchedEntries += matchedEntries;
    }

    return {
      scanned: entries.length,
      matched: matchedEntries,
      applied: { read: readIDs.length, star: starIDs.length, later: laterIDs.length, tag: tagPairs.length },
    };
  }

  /** 诊断快照（探针断言事务数 / 应用次数 / 错误数用）。 */
  snapshot() {
    return {
      rules: this.listRules().length,
      enabled: this.enabledCompiledRules().length,
      limits: { maxRules: MAX_RULES, maxPerFeed: MAX_RULES_PER_FEED, replay: REPLAY_LIMIT },
      ...this.counters,
    };
  }
}

// MARK: - 纯函数助手（探针可直接 require 复用）

function ruleAppliesToFeed(rule, feedID) {
  if (!feedID) return false;
  return rule.scope.kind === 'all' || (rule.scope.ids || []).includes(feedID);
}

function sampleText(sample, field) {
  switch (field) {
    case 'title': return String(sample.title ?? '');
    case 'summary': return String(sample.summary ?? '');
    case 'author': return String(sample.author ?? '');
    case 'url': return String(sample.url ?? '');
    case 'body': return String(sample.body ?? '');
    default: return '';
  }
}

/** 测试器样本归一（允许只贴部分字段）。 */
function normalizeSample(sample) {
  const src = sample || {};
  return {
    title: String(src.title ?? ''),
    summary: String(src.summary ?? ''),
    author: String(src.author ?? ''),
    url: String(src.url ?? ''),
    body: String(src.body ?? ''),
  };
}

/** 静默编译（非法正则返回 null → 运行期按未命中处理，不炸主流程）。 */
function compileQuietly(value) {
  try { return new RegExp(String(value ?? ''), 'i'); } catch (_) { return null; }
}

/** 正则测试兜底：任何运行异常按未命中。 */
function safeRegexTest(re, text) {
  try { return re.test(text); } catch (_) { return false; }
}

/** 匹配行 → 匹配样本（正文：缓存优先，回退 RSS content 纯文本）。 */
function rowToMatchEntry(row, needBody = true) {
  return {
    id: row.id,
    accountID: row.account_id,
    feedID: row.feed_id,
    title: row.title ?? '',
    author: row.author ?? '',
    url: row.url ?? '',
    summary: row.summary ?? '',
    // body 仅在规则确实用到时才计算（plainText 剥 HTML 是灌文热路径上最贵的一步）
    body: !needBody ? '' : (row.body_cache != null && row.body_cache !== ''
      ? String(row.body_cache)
      : (row.content_html ? plainText(row.content_html) : '')),
    isRead: Number(row.is_read) === 1,
    isStarred: Number(row.is_starred) === 1,
    isLater: Number(row.is_later) === 1,
  };
}

module.exports = {
  RulesEngine,
  ruleAppliesToFeed,
  normalizeSample,
  compileQuietly,
  safeRegexTest,
  NESTED_QUANTIFIER_RE,
  LIMITS: {
    MAX_RULES, MAX_RULES_PER_FEED, MAX_CONDITIONS, MAX_ACTIONS,
    VALUE_MAX, NAME_MAX, TAG_MAX, REPLAY_LIMIT, SAMPLES_LIMIT,
  },
  FIELDS,
  OPS,
  SIMPLE_ACTIONS,
};
