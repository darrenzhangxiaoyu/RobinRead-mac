'use strict';
/**
 * RobinRead（知更）— 数据库与偏好存储
 *
 * - 文章库：node:sqlite DatabaseSync（WAL），模式由 DatabaseMigrations 管理
 * - 偏好：preferences.json（%APPDATA%/RobinRead），键前缀 RobinRead.*
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { DatabaseSync } = require('node:sqlite');
const { runMigrations } = require('./DatabaseMigrations');

class LibraryDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // synchronous=NORMAL 是 WAL 推荐档：提交不再逐次 fsync（批量灌文时差距数百倍），
    // 崩溃最多丢最后一次 checkpoint 后的事务，不会损坏库
    this.db.exec('PRAGMA synchronous = NORMAL;');
    // 默认页缓存仅 ~2MB，大库热路径反复换页；提到 16MB（负数 = KB）
    this.db.exec('PRAGMA cache_size = -16000;');
    this.db.exec('PRAGMA temp_store = MEMORY;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this._txDepth = 0;
    runMigrations(this.db);
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  exec(sql) {
    this.db.exec(sql);
  }

  /**
   * 事务（可嵌套：内层自动降级为 SAVEPOINT）。
   * 批量灌文路径（AppStore._applyParsedEntries）在外层事务里逐篇调 upsertEntry——
   * 裸 BEGIN 遇内层会抛「within a transaction」；SAVEPOINT 语义下各层可独立回滚。
   */
  transaction(fn) {
    if (this._txDepth > 0) {
      const sp = `rr_sp_${this._txDepth}`;
      this.db.exec(`SAVEPOINT ${sp}`);
      this._txDepth += 1;
      try {
        return fn();
      } catch (err) {
        try { this.db.exec(`ROLLBACK TO ${sp}`); } catch (_) { /* 外层会继续回滚 */ }
        throw err;
      } finally {
        this._txDepth -= 1;
        try { this.db.exec(`RELEASE ${sp}`); } catch (_) { /* 已回滚 */ }
      }
    }
    this.db.exec('BEGIN');
    this._txDepth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch (_) { /* 已回滚 */ }
      throw err;
    } finally {
      this._txDepth = 0;
    }
  }

  close() {
    try { this.db.close(); } catch (_) { /* 忽略关闭错误 */ }
  }
}

/** 偏好键。 */
const PreferenceKey = Object.freeze({
  refreshInterval: 'RobinRead.refreshInterval',
  refreshOnLaunch: 'RobinRead.refreshOnLaunch',
  appTheme: 'RobinRead.appTheme',
  articleFontSize: 'RobinRead.articleFontSize',
  ignoredVersion: 'RobinRead.ignoredVersion',
  llmConfiguration: 'RobinRead.llmConfiguration',
  aiAPIKey: 'RobinRead.ai.apiKey',
  appLanguage: 'RobinRead.appLanguage',
  aiOutputLanguage: 'RobinRead.ai.outputLanguage',
  windowBounds: 'RobinRead.windowBounds',
  sidebarWidth: 'RobinRead.sidebarWidth',
  listWidth: 'RobinRead.listWidth',
});

class PreferenceStore {
  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'preferences.json');
    this.values = this._readOrQuarantine();
    this._migrateLegacyKeys();
  }

  /** 读取偏好；损坏文件改名留存（corrupt-<ts>）后从 {} 起步——不再无痕吞掉用户数据。 */
  _readOrQuarantine() {
    try {
      if (!fs.existsSync(this.filePath)) return {};
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      // 合法 JSON 但不是普通对象（数组/标量/字面 null）同样按损坏处理，否则 get/set 行为未定义
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('preferences root is not an object');
      }
      return parsed;
    } catch (err) {
      // P1-1：崩溃/断电留下的截断 JSON 不再静默清零——原文件改名留存供人工抢救
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt-${stamp}`);
        console.warn(`[RobinRead] preferences.json 已损坏（${err && err.message || err}），原文件留存为 preferences.json.corrupt-${stamp}，本次以空偏好启动`);
      } catch (_) {
        console.warn('[RobinRead] preferences.json 已损坏且留存失败，本次以空偏好启动');
      }
      return {};
    }
  }

  /** 旧版偏好键（PaperRss.* / NanJuPaper.*）一次性迁移到新键名（RobinRead.*），并清理旧键避免双份残留。 */
  _migrateLegacyKeys() {
    let touched = false;
    for (const legacyPrefix of ['NanJuPaper.', 'PaperRss.']) {
      for (const key of Object.keys(this.values)) {
        if (!key.startsWith(legacyPrefix)) continue;
        const next = `RobinRead.${key.slice(legacyPrefix.length)}`;
        if (!Object.prototype.hasOwnProperty.call(this.values, next)) {
          this.values[next] = this.values[key];
        }
        delete this.values[key];
        touched = true;
      }
    }
    if (touched) this._scheduleSave();
  }

  get(key, fallback = null) {
    return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : fallback;
  }

  set(key, value) {
    this.values[key] = value;
    this._scheduleSave();
  }

  remove(key) {
    delete this.values[key];
    this._scheduleSave();
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flushSync();
    }, 150);
  }

  /** 立即落盘（清除防抖定时器）。应用退出（before-quit）时调用，避免最后一次修改丢失。 */
  flushSync() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // P1-1：原子写（tmp + rename，先例 AuthService._writeState）——崩溃/断电瞬间
      // 不会留下截断的 JSON 把全部偏好无痕清零
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (_) { /* 保存失败不阻塞主流程 */ }
  }
}

module.exports = { LibraryDatabase, PreferenceStore, PreferenceKey };
