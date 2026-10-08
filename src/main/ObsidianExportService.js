'use strict';
/**
 * RobinRead（知更）— Obsidian 知识库导出服务（F11）
 *
 * 把文章/高亮（含笔记）导出为 Obsidian 友好的 Markdown 库，支持增量同步：
 *
 *   <授权目录>/RobinRead/
 *     Articles/<sanitized-title> <id8>.md     文章：frontmatter + 正文纯文本→MD 段落
 *     Highlights/<date> <article-title> <id8>.md  每条高亮 + 其笔记一文件（引用块 + 笔记段）
 *     _meta/sync-state.json                   增量游标：relPath → 内容 sha1 短码
 *
 * 安全模型（与 P2-11 写盘 token 同源、按 F7 DAV 式内存授权态）：
 * - 写授权只存在内存（_authorizedDir），仅由 obsidian:pickDir（dialog.showOpenDialog
 *   openDirectory）登记；重启/换实例即失效，需重新选目录——绝不持久化任意目录写权限。
 * - 所有写入路径先过 path.relative 校验必须落在 <授权目录>/RobinRead/ 内。
 * - 永不删除：只覆盖写自己命名空间（RobinRead/**）内 hash 变化的文件，
 *   用户在 Obsidian 侧加的文件/内容原样保留；sync-state 合并保留旧条目。
 *
 * 护栏：单次导出文件数 ≤2000；单文件 ≤1MB（超长正文截断并标注）。
 * 容错：sync-state.json 坏 JSON → 视为空游标（等效全量重导）后自愈回写。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { plainText, nowSeconds } = require('./Models');

const ROOT_DIR = 'RobinRead';
const ARTICLES_DIR = 'Articles';
const HIGHLIGHTS_DIR = 'Highlights';
const META_DIR = '_meta';
const SYNC_STATE_REL = `${META_DIR}/sync-state.json`;
const STATE_VERSION = 1;

const MAX_FILES_PER_EXPORT = 2000;   // 单次导出文件数护栏（含文章+高亮）
const MAX_FILE_BYTES = 1024 * 1024;  // 单文件 1MB（超长正文截断）
const MAX_STEM_CHARS = 80;           // 文件名主干（不含扩展名）长度上限
const HASH_SHORT = 12;               // 内容 hash 短码长度
const TRUNCATION_MARKER = '[RobinRead] 正文过长，已截断（单文件上限 1MB）。/ Truncated: body exceeded the 1MB per-file limit.';

const PREF = {
  scopeArticles: 'RobinRead.obsidian.scopeArticles',
  scopeHighlights: 'RobinRead.obsidian.scopeHighlights',
  scopeTags: 'RobinRead.obsidian.scopeTags',
  lastExportAt: 'RobinRead.obsidian.lastExportAt',
  lastDir: 'RobinRead.obsidian.lastDir',     // 仅作 UI 回显（重启后需重新授权，不构成写许可）
  lastStats: 'RobinRead.obsidian.lastStats', // 上次导出统计 JSON（UI 展示）
};

const ERROR_NOT_AUTHORIZED = 'OBSIDIAN_NOT_AUTHORIZED';

// MARK: - 纯函数（文件名 / YAML / 正文转换 / hash）

/** Windows/Linux 通用文件名消毒：非法字符替换为空格、折叠空白、去首尾点空格。 */
function sanitizeStem(raw) {
  let s = String(raw ?? '');
  s = s.normalize('NFC');
  s = s.replace(/[\\/:*?"<>|]/g, ' ');            // Windows 非法字符
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ');   // 控制字符
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, ''); // Windows 首尾点/空格
  return s;
}

/** 内容 hash 短码：sha1 前 12 位十六进制（稳定、可跨次比较）。 */
function contentHash(content) {
  return crypto.createHash('sha1').update(Buffer.from(String(content ?? ''), 'utf8')).digest('hex').slice(0, HASH_SHORT);
}

/** 条目 id 的 8 位稳定短码（文件名尾部防冲突；跨导出稳定是增量前提）。 */
function id8(id) {
  return crypto.createHash('sha1').update(Buffer.from(String(id ?? ''), 'utf8')).digest('hex').slice(0, 8);
}

const YAML_UNSAFE_RE = /[:#[\]{}&*!|>'"%@`,\n\t]/;
const YAML_AMBIGUOUS_RE = /^(true|false|null|yes|no|on|off|~)$/i;
const YAML_NUMERIC_RE = /^[-+]?(\d[\d_]*(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/;

/** Obsidian Properties（YAML）标量转义：含冒号/引号等特殊字符时双引号包裹并转义。 */
function yamlValue(v) {
  const s = String(v ?? '');
  if (!s.length) return '""';
  const unsafe = YAML_UNSAFE_RE.test(s) || YAML_AMBIGUOUS_RE.test(s) || YAML_NUMERIC_RE.test(s)
    || /^\s/.test(s) || /\s$/.test(s) || /^[-?:]/.test(s);
  if (!unsafe) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
}

/** frontmatter tags 行：`tags: [a, b]`（逐项 yamlValue 转义）。 */
function yamlTagsLine(tags) {
  const list = (Array.isArray(tags) ? tags : []).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (!list.length) return 'tags: []';
  return `tags: [${list.map(yamlValue).join(', ')}]`;
}

/** 秒级时间戳 → ISO 日期（YYYY-MM-DD）；无效输入返回 null。 */
function isoDate(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** 秒级时间戳 → ISO 完整时间；无效输入返回 null。 */
function isoDateTime(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** 行首 Markdown 结构符转义（#/引用/列表/有序列表），避免正文被 Obsidian 重新解释。 */
function escapeMdLeading(paragraph) {
  return paragraph.replace(/^(\s*)([#>|]|[-*+]\s|\d+[.)]\s)/, (m, sp, mark) => `${sp}\\${mark}`);
}

/** 纯文本 → MD 段落（空行分段；正文来自 plainText，天然无残留标签）。 */
function textToMarkdown(text) {
  const paragraphs = String(text ?? '')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+$/g, '').trim())
    .filter(Boolean);
  return paragraphs.map(escapeMdLeading).join('\n\n');
}

/** HTML → MD 正文（复用 Models.plainText 的消毒管线，再转段落）。 */
function htmlToMarkdownBody(html) {
  return textToMarkdown(plainText(html ?? ''));
}

/** 引用块：多行文本逐行加 `> `。 */
function blockquote(text) {
  const lines = String(text ?? '').split('\n');
  return lines.map((l) => `> ${l}`.trimEnd()).join('\n');
}

/**
 * 组装单文件内容并施加 1MB 护栏：超限时对正文二分截断并追加标注。
 * 返回 { content, truncated }。
 */
function assembleWithCap(header, body) {
  const footer = `\n\n---\n\n${TRUNCATION_MARKER}\n`;
  let content = header + body;
  if (Buffer.byteLength(content, 'utf8') <= MAX_FILE_BYTES) return { content: content + '\n', truncated: false };
  let lo = 0;
  let hi = body.length;
  // 二分找最大可保留前缀（字节口径）
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    if (Buffer.byteLength(header + body.slice(0, mid) + footer, 'utf8') <= MAX_FILE_BYTES) lo = mid;
    else hi = mid - 1;
  }
  content = header + body.slice(0, lo).trimEnd() + footer;
  return { content, truncated: true };
}

/** 文件名冲突加序号：同批内全名去重（大小写不敏感，Windows 口径）。 */
function dedupeName(relPath, used) {
  const key = relPath.toLowerCase();
  if (!used.has(key)) { used.add(key); return relPath; }
  const dir = path.posix.dirname(relPath);
  const ext = path.posix.extname(relPath);
  const stem = path.posix.basename(relPath, ext);
  for (let n = 2; ; n += 1) {
    const candidate = dir === '.' ? `${stem}-${n}${ext}` : `${dir}/${stem}-${n}${ext}`;
    const ck = candidate.toLowerCase();
    if (!used.has(ck)) { used.add(ck); return candidate; }
  }
}

// MARK: - 服务

class ObsidianExportService {
  constructor(store) {
    this.store = store;
    this._authorizedDir = null;   // 内存授权态：仅本次会话有效（重启即清空）
    this._chain = Promise.resolve(); // 单飞：导出串行化（防并发写同一 vault）
  }

  // MARK: 授权态（内存）

  /** 登记本次会话的授权目录（仅 obsidian:pickDir 的 openDirectory 结果可进入）。 */
  authorizeDirectory(dir) {
    const clean = String(dir ?? '').trim();
    if (!clean) throw new Error('目录路径为空');
    let stat = null;
    try { stat = fs.statSync(clean); } catch (_) { /* 不存在时也允许登记：首次导出前用户可能先建 vault */ }
    if (stat && !stat.isDirectory()) throw new Error('所选路径不是目录');
    this._authorizedDir = clean;
    try { this.store.preferences.set(PREF.lastDir, clean); } catch (_) { /* 回显失败不影响授权 */ }
    return this.authorizedDir();
  }

  authorizedDir() { return this._authorizedDir; }

  clearAuthorization() { this._authorizedDir = null; }

  _requireAuthorizedDir() {
    if (!this._authorizedDir) {
      const err = new Error('尚未授权导出目录：请先在设置中选择 Obsidian 库目录（授权仅本次会话有效）');
      err.code = ERROR_NOT_AUTHORIZED;
      throw err;
    }
    return this._authorizedDir;
  }

  // MARK: 配置（范围开关为持久偏好；目录授权态永不持久化）

  scope() {
    return {
      articles: this.store.preferences.get(PREF.scopeArticles, true) !== false,
      highlights: this.store.preferences.get(PREF.scopeHighlights, true) !== false,
      tags: this.store.preferences.get(PREF.scopeTags, true) !== false,
    };
  }

  getConfig() {
    let lastStats = null;
    try { lastStats = JSON.parse(this.store.preferences.get(PREF.lastStats, null) || 'null'); } catch (_) { lastStats = null; }
    return {
      authorized: Boolean(this._authorizedDir),
      dir: this._authorizedDir || null,
      lastDir: this.store.preferences.get(PREF.lastDir, '') || '',
      lastExportAt: Number(this.store.preferences.get(PREF.lastExportAt, 0)) || 0,
      lastStats: lastStats && typeof lastStats === 'object' ? lastStats : null,
      scope: this.scope(),
      limits: { maxFiles: MAX_FILES_PER_EXPORT, maxFileBytes: MAX_FILE_BYTES },
    };
  }

  saveConfig(patch = {}) {
    const scope = patch.scope || {};
    if (typeof scope.articles === 'boolean') this.store.preferences.set(PREF.scopeArticles, scope.articles);
    if (typeof scope.highlights === 'boolean') this.store.preferences.set(PREF.scopeHighlights, scope.highlights);
    if (typeof scope.tags === 'boolean') this.store.preferences.set(PREF.scopeTags, scope.tags);
    return this.getConfig();
  }

  // MARK: 数据收集

  _feedTitle(feedID) {
    try {
      const feed = this.store.feedsRepo.feed(feedID);
      return String(feed?.title ?? '').trim();
    } catch (_) { return ''; }
  }

  /** 文章 tags 并集：article_tags（手动+AI）∪ 知识笔记 tags（notes.tags JSON）。 */
  _articleTags(itemID) {
    const out = [];
    const seen = new Set();
    const push = (t) => {
      const tag = String(t ?? '').trim();
      if (!tag || seen.has(tag)) return;
      seen.add(tag);
      out.push(tag);
    };
    try {
      for (const r of this.store.knowledge.getItemTags(itemID)) push(r.tag);
      for (const note of this.store.knowledge.getNotes(itemID)) {
        // getNotes→_rowToNote 已把 tags JSON 解析成数组（防御：字符串形状再 parse 一次）
        let tags = Array.isArray(note.tags) ? note.tags : (() => { try { return JSON.parse(note.tags || '[]'); } catch (_) { return []; } })();
        if (Array.isArray(tags)) for (const t of tags) push(t);
      }
    } catch (_) { /* 标签收集失败不阻塞导出 */ }
    return out;
  }

  /** 全库文章（新→旧），分批复用 entriesByIDs 行映射。 */
  _allEntries() {
    const rows = this.store.database.prepare(`
      SELECT i.id FROM items i
      LEFT JOIN articles a ON a.item_id = i.id
      ORDER BY COALESCE(a.published_at, i.created_at) DESC, i.id ASC
    `).all();
    const ids = rows.map((r) => r.id);
    const out = [];
    for (let i = 0; i < ids.length; i += 400) out.push(...this.store.articlesRepo.entriesByIDs(ids.slice(i, i + 400)));
    return out;
  }

  /** 全库高亮（新→旧），带文章标题/URL 与 feed。 */
  _allHighlights() {
    return this.store.database.prepare(`
      SELECT h.id, h.item_id, h.text, h.color, h.note, h.created_at,
             a.title AS article_title, a.url AS article_url, i.feed_id AS feed_id
      FROM highlights h
      LEFT JOIN articles a ON a.item_id = h.item_id
      LEFT JOIN items i ON i.id = h.item_id
      ORDER BY h.created_at DESC, h.id ASC
    `).all();
  }

  // MARK: buildFiles（导出内容构建，纯逻辑、可单测）

  /**
   * 构建将写入 vault 的文件清单。
   * options: { scope?: {articles,highlights,tags}, force?: boolean（buildFiles 忽略 force，仅供 orchestrate） }
   * 返回 { files: [{relPath, content, hash, kind, key}], truncated, dropped: {articles, highlights} }
   */
  buildFiles(options = {}) {
    const scope = options.scope || this.scope();
    const files = [];
    const used = new Set();
    let truncated = false;
    const dropped = { articles: 0, highlights: 0 };

    const pushFile = (relPath, content, kind, key) => {
      if (files.length >= MAX_FILES_PER_EXPORT) { truncated = true; return false; }
      const hash = contentHash(content);
      files.push({ relPath, content, hash, kind, key });
      return true;
    };

    // ── 文章 ──
    if (scope.articles) {
      for (const entry of this._allEntries()) {
        if (files.length >= MAX_FILES_PER_EXPORT) { truncated = true; dropped.articles += 1; continue; }
        const title = String(entry.title ?? '').trim() || 'untitled';
        const suffix = id8(entry.id);
        const stemBudget = MAX_STEM_CHARS - suffix.length - 1;
        const stem = (() => {
          const s = sanitizeStem(title);
          return (s.length > stemBudget ? s.slice(0, stemBudget).trim() : s) || 'untitled';
        })();
        const relPath = dedupeName(`${ARTICLES_DIR}/${stem} ${suffix}.md`, used);

        const bodyText = entry.contentHTML ? String(entry.contentHTML) : String(entry.summary ?? '');
        let body = htmlToMarkdownBody(bodyText);
        // 独立笔记（不挂在高亮上的）随文章导出：## Notes 区段
        let notes = [];
        try { notes = this.store.knowledge.getNotes(entry.id) || []; } catch (_) { notes = []; }
        if (notes.length) {
          const notesMd = notes
            .map((n) => textToMarkdown(String(n.content ?? '')))
            .filter(Boolean)
            .join('\n\n');
          if (notesMd) body += `${body ? '\n\n' : ''}## Notes\n\n${notesMd}`;
        }

        const fm = [
          '---',
          `title: ${yamlValue(title)}`,
          `source: ${yamlValue(this._feedTitle(entry.feedID))}`,
          `url: ${yamlValue(entry.url ?? '')}`,
          `published: ${yamlValue(isoDateTime(entry.publishedAt) ?? '')}`,
          yamlTagsLine(scope.tags ? this._articleTags(entry.id) : []),
          `robinId: ${yamlValue(entry.id)}`,
          '---',
          '',
        ].join('\n');
        const { content, truncated: fileTruncated } = assembleWithCap(fm, body);
        if (!pushFile(relPath, content, 'article', entry.id)) { dropped.articles += 1; continue; }
        if (fileTruncated) truncated = true;
      }
    }

    // ── 高亮（含其笔记）──
    if (scope.highlights) {
      for (const h of this._allHighlights()) {
        if (files.length >= MAX_FILES_PER_EXPORT) { truncated = true; dropped.highlights += 1; continue; }
        const title = String(h.article_title ?? '').trim() || 'untitled';
        const date = isoDate(h.created_at) || 'unknown-date';
        const suffix = id8(h.id);
        // 主干 = date + 空格 + 消毒标题 + 空格 + id8，总长 ≤80
        const stemBudget = MAX_STEM_CHARS - date.length - suffix.length - 2;
        const stemTitle = (() => {
          const s = sanitizeStem(title);
          return (s.length > stemBudget ? s.slice(0, stemBudget).trim() : s) || 'untitled';
        })();
        const relPath = dedupeName(`${HIGHLIGHTS_DIR}/${date} ${stemTitle} ${suffix}.md`, used);

        const quote = blockquote(textToMarkdown(String(h.text ?? '')) || String(h.text ?? ''));
        const noteMd = textToMarkdown(String(h.note ?? ''));
        const body = `${quote}${noteMd ? `\n\n${noteMd}` : ''}`;
        const articleTitle = title;
        const fm = [
          '---',
          `title: ${yamlValue(articleTitle)}`,
          `source: ${yamlValue(this._feedTitle(h.feed_id))}`,
          `date: ${yamlValue(date)}`,
          `robinId: ${yamlValue(h.id)}`,
          `entryUrl: ${yamlValue(h.article_url ?? '')}`,
          '---',
          '',
        ].join('\n');
        const { content, truncated: fileTruncated } = assembleWithCap(fm, body);
        if (!pushFile(relPath, content, 'highlight', h.id)) { dropped.highlights += 1; continue; }
        if (fileTruncated) truncated = true;
      }
    }

    return { files, truncated, dropped };
  }

  // MARK: sync-state（增量游标）

  _statePath(dir) { return path.join(dir, ROOT_DIR, SYNC_STATE_REL); }

  async _loadState(dir) {
    try {
      const raw = await fs.promises.readFile(this._statePath(dir), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)) {
        return { version: Number(parsed.version) || STATE_VERSION, files: parsed.files };
      }
      return { version: STATE_VERSION, files: {} }; // 形状不对 → 等效全量重导
    } catch (_) {
      return { version: STATE_VERSION, files: {} }; // 缺失/坏 JSON → 等效全量重导（容错）
    }
  }

  async _saveState(dir, files) {
    const metaDir = path.join(dir, ROOT_DIR, META_DIR);
    await fs.promises.mkdir(metaDir, { recursive: true });
    const payload = JSON.stringify({ version: STATE_VERSION, app: 'RobinRead', updatedAt: nowSeconds(), files }, null, 1);
    const tmp = `${this._statePath(dir)}.tmp`;
    await fs.promises.writeFile(tmp, payload, 'utf8');
    await fs.promises.rename(tmp, this._statePath(dir));
  }

  /** 写入路径双重校验：必须落在 <dir>/RobinRead/ 内（防 relPath 走样）。 */
  _assertOwnPath(dir, relPath) {
    const base = path.resolve(dir, ROOT_DIR);
    const full = path.resolve(base, relPath);
    const rel = path.relative(base, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`导出路径越界：${relPath}`);
    return full;
  }

  // MARK: 预览 / 导出编排

  /** 预览：返回将写入的文件统计（新增/变更/不变/截断），不写盘。 */
  async preview(options = {}) {
    return this._enqueue(() => this._previewIn(this._requireAuthorizedDir(), options));
  }

  /** 增量导出：只写 hash 变化的文件（新增/变更覆盖写，永不删除）。未授权 → 拒绝 promise。 */
  exportOrchestrate(options = {}) {
    return this._enqueue(() => this._exportIn(this._requireAuthorizedDir(), { ...options, force: false }));
  }

  /** 全量重导：无视 hash 全写（仍不删除用户文件）。未授权 → 拒绝 promise。 */
  fullExport(options = {}) {
    return this._enqueue(() => this._exportIn(this._requireAuthorizedDir(), { ...options, force: true }));
  }

  _enqueue(task) {
    const run = this._chain.then(() => task());
    this._chain = run.catch(() => {});
    return run;
  }

  async _previewIn(dir, options) {
    const built = this.buildFiles(options);
    const state = await this._loadState(dir);
    let newFiles = 0;
    let changedFiles = 0;
    let unchangedFiles = 0;
    for (const f of built.files) {
      const prev = state.files[f.relPath];
      if (!prev) newFiles += 1;
      else if (prev !== f.hash) changedFiles += 1;
      else unchangedFiles += 1;
    }
    const articles = built.files.filter((f) => f.kind === 'article').length;
    const highlights = built.files.filter((f) => f.kind === 'highlight').length;
    return {
      dir,
      scope: options.scope || this.scope(),
      counts: { articles, highlights, total: built.files.length },
      newFiles, changedFiles, unchangedFiles,
      truncated: built.truncated,
      dropped: built.dropped,
    };
  }

  async _exportIn(dir, options) {
    const t0 = Date.now();
    const force = options.force === true;
    const built = this.buildFiles(options);
    const state = await this._loadState(dir);
    const nextFiles = { ...state.files };
    let added = 0;
    let updated = 0;
    let skipped = 0;
    let fileTruncatedCount = 0;
    const writtenRels = [];

    // 目录一次性建齐（Articles/Highlights/_meta）
    await fs.promises.mkdir(path.join(dir, ROOT_DIR), { recursive: true });
    await fs.promises.mkdir(path.join(dir, ROOT_DIR, ARTICLES_DIR), { recursive: true });
    await fs.promises.mkdir(path.join(dir, ROOT_DIR, HIGHLIGHTS_DIR), { recursive: true });

    for (const f of built.files) {
      if (!force && state.files[f.relPath] === f.hash) { skipped += 1; continue; } // hash 命中：零写入（保 mtime）
      const full = this._assertOwnPath(dir, f.relPath);
      await fs.promises.writeFile(full, f.content, 'utf8');
      nextFiles[f.relPath] = f.hash;
      if (state.files[f.relPath] === undefined) added += 1; else updated += 1;
      writtenRels.push(f.relPath);
    }

    // 游标合并：保留旧条目（本地已删数据对应的 vault 文件永不清理），写入新 hash
    await this._saveState(dir, nextFiles);

    const stats = {
      dir,
      force,
      added, updated, skipped,
      totalFiles: built.files.length,
      truncated: built.truncated,
      dropped: built.dropped,
      elapsedMs: Date.now() - t0,
    };
    try {
      this.store.preferences.set(PREF.lastExportAt, nowSeconds());
      this.store.preferences.set(PREF.lastStats, JSON.stringify({
        at: nowSeconds(), added, updated, skipped, truncated: built.truncated, totalFiles: built.files.length,
      }));
    } catch (_) { /* 统计落偏好失败不影响导出结果 */ }
    return stats;
  }
}

module.exports = {
  ObsidianExportService,
  ROOT_DIR,
  ARTICLES_DIR,
  HIGHLIGHTS_DIR,
  META_DIR,
  SYNC_STATE_REL,
  MAX_FILES_PER_EXPORT,
  MAX_FILE_BYTES,
  MAX_STEM_CHARS,
  TRUNCATION_MARKER,
  ERROR_NOT_AUTHORIZED,
  contentHash,
  id8,
  sanitizeStem,
  yamlValue,
  yamlTagsLine,
  htmlToMarkdownBody,
  textToMarkdown,
  blockquote,
  isoDate,
  isoDateTime,
};
