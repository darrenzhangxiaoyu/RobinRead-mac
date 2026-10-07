'use strict';
/**
 * RobinRead（知更）— Newsletter 收件服务（F6）
 *
 * IMAP 邮箱接入：把指定发件人的邮件转成原生订阅流。复用 F5 平台源架构——
 * - 白名单发件人 = feeds 行（platform='mail'，platform_ref=发件人地址，
 *   feed_url=mail://<accountId>/<sender>），侧栏/时间线/阅读器全走既有通路；
 * - 抓取经 AppStore._fetchForFeed 分派到 fetchFeed（与 PlatformService 同位置同构返回）；
 * - 正文入库前统一 sanitizedHTML 消毒（512KB 截断；邮件嵌入 iframe 默认剥除，
 *   白名单仍只有 F5 的 bilibili player）；message-id 即天然幂等键。
 *
 * 工程约束：
 * - 密码只存 CredentialStore（DPAPI），mail_accounts 表仅存 password_ref；
 * - TLS：node:tls.connect(993)，自签名默认拒绝，账户级 allow_self_signed 显式放行；
 * - 并发：单账户同一时刻至多 1 个连接（per-account promise 链），全局至多 2 个账户并行；
 * - 超时：连接 15s / 命令 30s（ImapClient 内建）；增量：SEARCH SINCE 上次同步（首刷 30 天）。
 */
const { MailError } = require('./Mail/ImapClient');
const { parseMailFeedURL, senderMatches, normalizeSender } = require('./Mail/sender');
const { i18n } = require('./I18N');
const ArticleExtractor = require('./ArticleExtractor');
const { LOCAL_ACCOUNT_ID, uuid, nowSeconds, stableDigest } = require('./Models');
const path = require('node:path');

const MAX_ACCOUNTS = 3;
const MAX_SENDERS_PER_ACCOUNT = 20;
const FIRST_SYNC_WINDOW_SECONDS = 30 * 24 * 3600; // 首刷回看 30 天
const SINCE_OVERLAP_SECONDS = 24 * 3600;          // 增量回看重叠 1 天（message-id 幂等兜底）
const MAX_MESSAGES_PER_REFRESH = 50;              // 单发件人单次抓取上限
const BODY_TRUNCATE_BYTES = 512 * 1024;           // 单邮件正文截断（消毒前）
const MAX_GLOBAL_ACCOUNT_SESSIONS = 2;            // 全局并行账户上限
const MAIL_WORKER_TIMEOUT_MS = 90_000;            // worker 单请求看门狗（楔死即杀，主进程自愈）

// sender/mail feed URL 纯函数已抽到 Mail/sender.js（主进程与 mail-worker 共用，见顶部 import）

/** 行 → API 形态（密码本体永不出库）。 */
function accountFromRow(row) {
  return {
    id: row.id,
    host: row.host,
    port: Number(row.port) || 993,
    username: row.username,
    passwordRef: row.password_ref,
    allowSelfSigned: Number(row.allow_self_signed) === 1,
    enabled: Number(row.enabled) === 1,
    lastSync: row.last_sync,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class MailService {
  constructor(store) {
    this.store = store;
    this._accountChains = new Map(); // accountID → 尾部 promise（单账户串行）
    this._slotWaiters = [];          // 全局 ≤2 账户并行的等待队列
    this._activeSessions = 0;
    this._mailWorker = null;         // utilityProcess：IMAP 会话在 worker 内跑（Windows 主线程楔死规避）
    this._workerSeq = 0;
    /** 诊断计数（探针断言：单账户单连接 / 全局 ≤2 账户）。 */
    this.counters = {
      activeAccounts: 0,
      maxActiveAccounts: 0,
      perAccountActive: new Map(), // accountID → 当前连接数
      maxPerAccount: {},           // accountID → 历史峰值
      fetchedMessages: 0,
      searches: 0,
    };
  }

  // MARK: 账户管理

  listAccounts() {
    return this.store.database
      .prepare('SELECT * FROM mail_accounts ORDER BY created_at ASC')
      .all()
      .map(accountFromRow);
  }

  account(id) {
    const row = this.store.database.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(id);
    return row ? accountFromRow(row) : null;
  }

  _assertAccountQuota() {
    const count = this.store.database.prepare('SELECT COUNT(*) AS n FROM mail_accounts').get().n;
    if (count >= MAX_ACCOUNTS) {
      throw new MailError('protocol', i18n.localizedFormat('最多添加 %lld 个邮箱账户。', MAX_ACCOUNTS));
    }
  }

  /**
   * 添加邮箱账户（不即时连网：连接性走 testConnection 按钮显式验证）。
   * 密码写入 CredentialStore（DPAPI），表内只存 password_ref。
   */
  addAccount({ host, port = 993, username, password, allowSelfSigned = false } = {}) {
    const cleanHost = String(host || '').trim().toLowerCase();
    const cleanUser = String(username || '').trim();
    if (!cleanHost) throw new MailError('protocol', i18n.localized('请填写 IMAP 服务器地址。'));
    const portNum = Number(port) || 993;
    if (!(portNum >= 1 && portNum <= 65535)) throw new MailError('protocol', i18n.localized('端口不合法（1-65535）。'));
    if (!cleanUser) throw new MailError('protocol', i18n.localized('请填写邮箱用户名。'));
    if (!String(password || '')) throw new MailError('protocol', i18n.localized('请填写邮箱密码或应用专用密码。'));
    this._assertAccountQuota();

    const id = `mail-${uuid()}`;
    const now = nowSeconds();
    this.store.database.prepare(`
      INSERT INTO mail_accounts (id, host, port, username, password_ref, allow_self_signed, enabled, last_sync, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
    `).run(id, cleanHost, portNum, cleanUser, `mail-password-${id}`, allowSelfSigned ? 1 : 0, now, now);
    this.store.credentials.setMailPassword(id, String(password));
    return this.account(id);
  }

  /** 删除账户：白名单 feed（随文章级联）、凭据、账户行一并清除。 */
  deleteAccount(id) {
    const account = this.account(id);
    if (!account) return { removed: false };
    const feedRows = this.store.database.prepare(
      "SELECT id FROM feeds WHERE account_id = ? AND platform = 'mail' AND feed_url LIKE ?",
    ).all(LOCAL_ACCOUNT_ID, `mail://${id}/%`);
    if (feedRows.length) this.store.deleteFeeds(feedRows.map((r) => r.id));
    this.store.credentials.deleteMailPassword(id);
    this.store.database.prepare('DELETE FROM mail_accounts WHERE id = ?').run(id);
    this.store._invalidatePrepared?.();
    this.store._emitState?.();
    return { removed: true, removedSenders: feedRows.length };
  }

  setAccountEnabled(id, enabled) {
    this.store.database.prepare('UPDATE mail_accounts SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, nowSeconds(), id);
    return this.account(id);
  }

  /** 自签名证书放行（账户级偏好；设置里明示风险）。 */
  setSelfSigned(id, allow) {
    this.store.database.prepare('UPDATE mail_accounts SET allow_self_signed = ?, updated_at = ? WHERE id = ?')
      .run(allow ? 1 : 0, nowSeconds(), id);
    return this.account(id);
  }

  /**
   * 测试连接：LOGIN + SELECT + LOGOUT 真连，返回耗时与收件箱邮件总数。
   * 两种形态：{accountID}（用已存凭据，设置页「测试连接」）或完整 payload（添加表单）。
   */
  async testConnection(payload = {}) {
    let { host, port = 993, username, password, allowSelfSigned = false } = payload;
    if (payload.accountID) {
      const account = this.account(payload.accountID);
      if (!account) throw new MailError('protocol', i18n.localized('邮箱账户不存在或已被删除。'));
      const stored = this.store.credentials.mailPassword(account.id);
      if (!stored) throw new MailError('auth', i18n.localized('邮箱密码缺失，请删除账户后重新添加。'));
      ({ host, port, username, allowSelfSigned } = account);
      password = stored;
    }
    const startedAt = Date.now();
    // 测试连接同样走 worker（与抓取同一条楔死规避通路）
    const { exists } = await this._workerRequest({
      type: 'probe',
      config: {
        host: String(host || '').trim(),
        port: Number(port) || 993,
        username: String(username || '').trim(),
        password: String(password || ''),
        allowSelfSigned: Boolean(allowSelfSigned),
      },
    });
    return {
      elapsedMs: Date.now() - startedAt,
      messageCount: exists,
      host: String(host || '').trim(),
      username: String(username || '').trim(),
    };
  }

  // MARK: 发件人白名单（= 平台源同构的合成 feed）

  listSenders(accountID) {
    return this.store.database.prepare(`
      SELECT f.id, f.title, f.platform_ref AS sender, f.feed_url AS feedURL,
             f.last_refreshed_at AS lastRefreshedAt,
             (SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id) AS entryCount
      FROM feeds f
      WHERE f.account_id = ? AND f.platform = 'mail' AND f.feed_url LIKE ?
      ORDER BY f.sort_order ASC, f.updated_at DESC
    `).all(LOCAL_ACCOUNT_ID, `mail://${accountID}/%`);
  }

  /** 添加发件人 → 建一条 platform='mail' 的 feed（与手动添加/商店同一数量闸口）。 */
  addSender({ accountID, sender, folder = null } = {}) {
    const account = this.account(accountID);
    if (!account) throw new MailError('protocol', i18n.localized('邮箱账户不存在或已被删除。'));
    const rule = normalizeSender(sender);

    const count = this.store.database.prepare(
      "SELECT COUNT(*) AS n FROM feeds WHERE account_id = ? AND platform = 'mail' AND feed_url LIKE ?",
    ).get(LOCAL_ACCOUNT_ID, `mail://${accountID}/%`).n;
    if (count >= MAX_SENDERS_PER_ACCOUNT) {
      throw new MailError('protocol', i18n.localizedFormat('每个邮箱最多添加 %lld 个发件人。', MAX_SENDERS_PER_ACCOUNT));
    }

    // feed_url 存 `mail://<accountId>/<sender>`（发件人已归一为 email/@domain 安全字符，无需转义）
    const feedURL = `mail://${accountID}/${rule}`;
    const existing = this.store.feedsRepo.feedByURL(LOCAL_ACCOUNT_ID, feedURL);
    if (existing) throw new Error(i18n.localized('这个订阅已经存在。'));

    if (this.store.accountGate) {
      const gate = this.store.accountGate.canAddFeeds(this.store.feedsRepo.allFeeds().length);
      if (!gate.ok) throw gate.error;
    }

    const feed = this.store.feedsRepo.insertFeed({
      accountID: LOCAL_ACCOUNT_ID,
      title: rule,
      siteURL: null,
      feedURL,
      storedIconURL: null,
      platform: 'mail',
      platformRef: rule,
    });
    if (folder && String(folder).trim()) {
      this.store.feedsRepo.setFeedFolder(feed.id, this.store.feedsRepo.ensureFolder(LOCAL_ACCOUNT_ID, String(folder).trim()).id);
    }
    this.store._invalidatePrepared?.();
    this.store._emitState?.();
    return this.store.feedsRepo.feed(feed.id);
  }

  /** 移除发件人（feed 行删 → 文章/媒体级联；白名单即 feed 行，无独立表）。 */
  removeSender(feedID) {
    const feed = this.store.feedsRepo.feed(feedID);
    if (!feed) return { removed: false };
    if (feed.platform !== 'mail') throw new MailError('protocol', i18n.localized('不是邮件订阅源。'));
    this.store.deleteFeeds([feedID]);
    return { removed: true };
  }

  // MARK: 抓取（AppStore._fetchForFeed 分派目标，返回结构与 FeedService.fetchFeed 同构）

  /**
   * 单发件人刷新：
   * SELECT INBOX → SEARCH SINCE（上次同步-1d 重叠；首刷 30 天）FROM 发件人 →
   * 逐封 FETCH（跳过 message-id 已入库的）→ 解析 → 条目（消毒正文 + 200 字摘要）。
   * force 与 RSS 同语义保留（邮件天然走 message-id 幂等，条件请求不适用）。
   */
  async fetchFeed(feed, { force = false } = {}) {
    void force;
    const route = parseMailFeedURL(feed.feedURL);
    if (!route) throw new MailError('protocol', i18n.localized('邮件订阅源地址异常，请删除后重新添加发件人。'));
    const { accountID, sender } = route;
    const account = this.account(accountID);
    if (!account) throw new MailError('network', i18n.localized('邮箱账户不存在或已被删除，请移除该发件人订阅。'));
    if (!this.store.credentials.mailPassword(accountID)) {
      throw new MailError('auth', i18n.localized('邮箱密码缺失，请删除账户后重新添加。'));
    }

    return this._runAccountSession(accountID, async () => {
      const result = await this._fetchViaWorker({ account, sender, feed });
      // 成功才推进增量游标（失败下次重刷同一窗口）
      this.store.database.prepare('UPDATE mail_accounts SET last_sync = ?, updated_at = ? WHERE id = ?')
        .run(nowSeconds(), nowSeconds(), accountID);
      return result;
    });
  }

  // MARK: 邮件工作进程（Windows 楔死规避——IMAP 会话整体在 utilityProcess 内执行）

  /**
   * 一次性 worker 会话：fork → 发请求 → 收应答/超时杀。
   * Windows + Electron 37 下同进程「前一条 TLS destroy 与下一条 tls.connect 竞态」
   * 会同步楔死主线程（纯 Node 不复现 = Electron 专属缺陷）。会话搬进 worker 后，
   * 即使楔死也只影响 worker：看门狗 kill 后下次刷新自动 fork 新 worker，主进程无感。
   */
  _workerRequest(payload, timeoutMs = MAIL_WORKER_TIMEOUT_MS) {
    const electron = require('electron');
    const up = electron && electron.utilityProcess;
    if (!up || typeof up.fork !== 'function') {
      throw new MailError('network', i18n.localized('邮件服务不可用（工作进程启动失败）。'));
    }
    const keepAlive = payload.keepAlive === true; // mock 类请求：应答后不杀 worker（mock 服务器与其共存亡）
    const reuseShared = payload.toShared === true && Boolean(this._mailWorker); // 控制类 op 复用 keepAlive worker
    // 注意：不可传 stdio 选项——utilityProcess 下显式 stdio 会打断 parentPort IPC 通道
    //（消息静默丢失，实测 mock start 永不应答）；worker 日志经 postMessage 回传。
    const worker = reuseShared
      ? this._mailWorker
      : up.fork(path.join(__dirname, 'workers', 'mail-worker.js'), [], { serviceName: 'robin-mail' });
    const id = ++this._workerSeq;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, arg, opts = {}) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { worker.removeListener('message', onMessage); } catch (_) {}
        try { worker.removeListener('exit', onExit); } catch (_) {}
        const keep = opts.keep === true || reuseShared;
        if (!keep) { try { worker.kill(); } catch (_) {} }
        fn(arg);
      };
      const timer = setTimeout(() => finish(() => reject(new MailError('timeout', i18n.localized('邮件会话超时（已重置邮件服务，请稍后重试）。')))), timeoutMs);
      const onMessage = (event) => {
        // utilityProcess 父侧 'message' 事件直接携带消息本体（不是 ipcRenderer 的 event.data 包装）——
        // 取错形状会静默丢回复直到超时（实测根因）。
        const msg = (event && typeof event === 'object' && 'id' in event)
          ? event
          : (event && event.data);
        if (!msg || msg.id !== id) return;
        finish(() => {
          if (msg.ok && keepAlive) this._mailWorker = worker;
          if (msg.ok) resolve(msg);
          else reject(Object.assign(new MailError(msg.error?.kind || 'network', msg.error?.message || 'mail worker error', { serverText: msg.error?.serverText })));
        }, null, { keep: keepAlive && msg.ok === true });
      };
      const onExit = (code) => {
        finish(() => reject(new MailError('network', i18n.localized('邮件服务工作进程异常退出（code=%lld）。').replace('%lld', String(code ?? -1)))));
      };
      worker.on('message', onMessage);
      worker.on('exit', onExit);
      // spawn 完成前 postMessage 会被静默丢弃（fork 的 IPC 通道尚未建立）——
      // 首次 fork 等 spawn 再发；复用共享 worker 时通道已就绪，直接发。
      const post = () => {
        try { worker.postMessage({ id, ...payload }); } catch (err) { finish(() => reject(err)); }
      };
      if (reuseShared) post();
      else worker.once('spawn', post);
    });
  }

  async _fetchViaWorker({ account, sender, feed }) {
    const password = this.store.credentials.mailPassword(account.id);
    if (!password) throw new MailError('auth', i18n.localized('邮箱密码缺失，请删除账户后重新添加。'));
    const since = (account.lastSync || (nowSeconds() - FIRST_SYNC_WINDOW_SECONDS)) - SINCE_OVERLAP_SECONDS;
    // 已入库 entryID 集（local:<feedID>:<digest(messageID)>）：worker 按 messageID 做批内去重，
    // 与库内幂等键的精确比对留在主进程（键形如 local:<feedID>:<digest>，含 feedID 前缀）
    const existingEntryIDs = new Set(
      this.store.database.prepare('SELECT external_id FROM items WHERE feed_id = ?')
        .all(feed.id)
        .map((r) => String(r.external_id || '')),
    );

    const { entries } = await this._workerRequest({
      type: 'session',
      config: {
        host: account.host,
        port: account.port,
        username: account.username,
        password,
        allowSelfSigned: Boolean(account.allowSelfSigned),
      },
      params: { sender, since, maxMessages: MAX_MESSAGES_PER_REFRESH },
    });

    const mapped = [];
    for (const raw of entries) {
      this.counters.fetchedMessages += 1;
      const entryID = `local:${feed.id}:${stableDigest(raw.messageID)}`;
      if (existingEntryIDs.has(entryID)) continue;
      mapped.push(this._entryFromParsed(raw, sender));
    }
    this.counters.searches += 1;
    return {
      notModified: false,
      parsed: { title: sender, siteURL: null, iconURL: null, entries: mapped },
      etag: null,
      lastModified: null,
    };
  }

  /** 解析结果 → FeedParser 同构条目（正文消毒 + 512KB 截断 + 200 字摘要）。 */
  _entryFromParsed(parsed, sender) {
    let bodyHTML = parsed.html && parsed.html.trim() ? parsed.html : '<p></p>';
    if (Buffer.byteLength(bodyHTML, 'utf8') > BODY_TRUNCATE_BYTES) {
      bodyHTML = Buffer.from(bodyHTML, 'utf8').subarray(0, BODY_TRUNCATE_BYTES).toString('utf8') + '<p>…</p>';
    }
    const contentHTML = ArticleExtractor.sanitizedHTML(bodyHTML, null);
    const summary = String(parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return {
      id: parsed.messageID,
      title: parsed.subject || i18n.localized('(无主题)'),
      url: null,
      publishedAt: parsed.dateSeconds ?? nowSeconds(),
      summary,
      contentHTML,
      author: parsed.from.name || parsed.from.address || sender,
      cover: null,
      enclosure: null,
    };
  }

  // MARK: 并发闸口（单账户单连接 + 全局 ≤2 账户）

  /** 同一账户串行（复用连接语义 = 每会话一条连接），跨账户经全局信号量限 ≤2。 */
  async _runAccountSession(accountID, fn) {
    if (process.env.ROBIN_MAIL_DEBUG) console.error(`[mail-debug] session queued acct=${accountID.slice(-6)} active=${this._activeSessions} waiters=${this._slotWaiters.length}`);
    const previous = this._accountChains.get(accountID) || Promise.resolve();
    const run = async () => {
      if (process.env.ROBIN_MAIL_DEBUG) console.error(`[mail-debug] session chain-enter acct=${accountID.slice(-6)}`);
      await this._acquireGlobalSlot();
      if (process.env.ROBIN_MAIL_DEBUG) console.error(`[mail-debug] slot acquired acct=${accountID.slice(-6)} active=${this._activeSessions}`);
      const active = (this.counters.perAccountActive.get(accountID) || 0) + 1;
      this.counters.perAccountActive.set(accountID, active);
      this.counters.maxPerAccount[accountID] = Math.max(this.counters.maxPerAccount[accountID] || 0, active);
      this.counters.activeAccounts += 1;
      this.counters.maxActiveAccounts = Math.max(this.counters.maxActiveAccounts, this.counters.activeAccounts);
      try {
        return await fn();
      } finally {
        this.counters.activeAccounts -= 1;
        this.counters.perAccountActive.set(accountID, active - 1);
        this._releaseGlobalSlot();
      }
    };
    const chain = previous.then(run, run);
    // 链尾吞错：后续会话不被前次失败卡死
    this._accountChains.set(accountID, chain.catch(() => {}));
    return chain;
  }

  async _acquireGlobalSlot() {
    // 名额计数只在 acquire 末端 +1；释放时若有等待者则直接「转让」名额（计数不变），
    // 避免释放-等待两个微任务间隙被第三方插入导致超发。
    if (this._activeSessions + this._slotWaiters.length < MAX_GLOBAL_ACCOUNT_SESSIONS) {
      this._activeSessions += 1;
      return;
    }
    await new Promise((resolve) => this._slotWaiters.push(resolve));
  }

  _releaseGlobalSlot() {
    const next = this._slotWaiters.shift();
    if (next) {
      next(); // 名额直接转让给队首等待者（计数不变）
      return;
    }
    this._activeSessions -= 1;
  }
}

module.exports = {
  MailService,
  MailError,
  parseMailFeedURL,
  senderMatches,
  normalizeSender,
  MAX_ACCOUNTS,
  MAX_SENDERS_PER_ACCOUNT,
  BODY_TRUNCATE_BYTES,
  MAX_GLOBAL_ACCOUNT_SESSIONS,
};
