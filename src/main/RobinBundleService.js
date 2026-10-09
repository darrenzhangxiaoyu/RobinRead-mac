'use strict';
/**
 * RobinBundleService（知更）— 批注漂流瓶（F28，数据主权 + 共读）
 *
 * 文章 + 你的批注打包成 .robin 包分享；对方导入可读你的划线与笔记、续写自己的，
 * 再导回给你双端合并——本地优先共读，零服务器。
 * - buildBundle(entryID, { includeFullText })：组包（纯函数，可探针直测）。
 *   包结构 JSON：{ format:'robin-bundle', version, exportedAt, author:{name},
 *   article:{ title, sourceTitle, url, publishedAt, html? }, annotations:[…] }。
 *   annotations 携带 kind/text/note/color/anchor/createdAt/origin/uid——uid 是
 *   去重身份证（本机导出 = 稳定哈希；导入批注沿用原 uid），再导出往返不丢。
 * - exportToFile：写盘走用户 pickSavePath（ipc.js 对话框链，照 BooksService
 *   手动成书先例——主进程对话框返回路径直接落盘，不经渲染层写通道）。
 * - importBundle：格式版本 / 大小上限（10MB）/ HTML 消毒（ArticleExtractor
 *   白名单管线）三道闸；两种落法——a) 文章不存在 → 漂流条目入库（合成 feed
 *   platform='drift'，正文缓存 is_sanitized=1）；b) 同 URL 已存在 → 只合并批注。
 *   合并策略：uid 或 anchor+文本哈希命中 → 去重跳过；同位置不同内容 → 并存
 *   （永不覆盖已有批注——「永不删除红线」）；导入批注 origin='imported'。
 * - 防炸弹：单条批注文本/anchor 超限截断；条数封顶；包体超限整包拒绝。
 *
 * 注入缝（探针）：_saveDialogImpl / _openDialogImpl 可换（照 Obsidian/Books 惯例）。
 */
const fs = require('node:fs');
const path = require('node:path');
const ArticleExtractor = require('./ArticleExtractor');
const { nowSeconds, stableDigest, uuid, LOCAL_ACCOUNT_ID } = require('./Models');

/** 规则常量（格式/上限/截断全部集中于此）。 */
const BUNDLE = {
  FORMAT: 'robin-bundle',
  VERSION: 1,
  FILE_EXT: '.robin',
  MAX_BYTES: 10 * 1024 * 1024,   // 包体硬上限 10MB（zip 炸弹 / 超大包拒绝）
  HTML_MAX: 6 * 1024 * 1024,     // 包内正文 HTML 上限（超出按无正文处理）
  MAX_ANNOTATIONS: 500,          // 单包含量批注条数封顶
  TEXT_SLICE: 4000,              // 高亮原文截断（防超大字段）
  NOTE_SLICE: 8000,              // 笔记内容截断
  ANCHOR_SLICE: 2000,            // anchor JSON 序列化截断（防超大锚点字段）
  TITLE_SLICE: 200,
  PREF_AUTHOR_KEY: 'RobinRead.bundle.authorName',
};

/** 批注去重键：origin_id 优先（跨机器往返身份证），否则 anchor+文本规范化哈希。 */
function annotationKey(a) {
  const uid = String(a?.uid || '').trim();
  if (uid) return `uid:${uid}`;
  const anchor = normalizeAnchorText(a?.anchor);
  const text = String(a?.text || '').replace(/\s+/g, ' ').trim();
  return `hash:${stableDigest(`${anchor}|${text}`)}`;
}

/** 锚点规范化串（位置同一性：段落 + 前后缀；无锚点回落文本前 80 字）。 */
function normalizeAnchorText(anchor) {
  if (!anchor || typeof anchor !== 'object') return '';
  return [
    String(anchor.paragraphID || anchor.paragraph_id || ''),
    String(anchor.prefix || ''),
    String(anchor.suffix || ''),
  ].join('\u0001');
}

/** 位置键（冲突判定用）：同位置不同内容 = 冲突 → 并存不覆盖。 */
function anchorPositionKey(a) {
  const anchor = a?.anchor;
  const pos = normalizeAnchorText(anchor);
  return pos || `text:${String(a?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80)}`;
}

/** 组包内单条批注的形状清洗（截断 + 字段收敛，出包入包同用）。 */
function shapeAnnotation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || '') === 'note' ? 'note' : 'highlight';
  const text = String(raw.text ?? raw.content ?? '').replace(/\r/g, '').trim();
  if (!text) return null;
  const anchorRaw = raw.anchor ?? null;
  let anchor = null;
  if (anchorRaw && typeof anchorRaw === 'object') {
    try {
      let json = JSON.stringify(anchorRaw);
      if (json && json.length > BUNDLE.ANCHOR_SLICE) {
        // 超大锚点：只保留定位三要素（段落/前后缀），丢弃其余扩展字段
        anchor = {
          paragraphID: String(anchorRaw.paragraphID || anchorRaw.paragraph_id || '') || null,
          prefix: String(anchorRaw.prefix || '').slice(0, 96) || null,
          suffix: String(anchorRaw.suffix || '').slice(0, 96) || null,
        };
      } else {
        anchor = anchorRaw;
      }
    } catch (_) { anchor = null; }
  }
  const out = {
    kind,
    text: text.slice(0, kind === 'note' ? BUNDLE.NOTE_SLICE : BUNDLE.TEXT_SLICE),
    note: raw.note ? String(raw.note).slice(0, BUNDLE.NOTE_SLICE) : null,
    color: raw.color || (kind === 'note' ? null : 'yellow'),
    anchor,
    createdAt: Number(raw.createdAt) || null,
  };
  const uid = String(raw.uid || '').trim();
  if (uid) out.uid = uid.slice(0, 80);
  const origin = String(raw.origin || '').trim();
  if (origin === 'imported') out.origin = 'imported'; // 再导出往返：导入身份随身携带
  return out;
}

class RobinBundleService {
  constructor(store, userDataPath) {
    this.store = store;
    this.userDataPath = userDataPath;
    this.counters = { exported: 0, imported: 0, driftArticles: 0, mergedEntries: 0, addedHighlights: 0, addedNotes: 0, duplicates: 0, conflicts: 0, rejected: 0 };
    // 对话框注入缝（探针 mock；生产由 ipc.js 传入真实 dialog 调用）
    this._saveDialogImpl = null;
    this._openDialogImpl = null;
  }

  // MARK: 导出（组包 → 写盘）

  /**
   * 组包（纯数据面，探针直测）：文章元数据 +（可选）消毒正文 + 全量批注。
   * @returns {{ payload, json, byteLength, suggestedName, annotationCount }}
   */
  buildBundle(entryID, { includeFullText = true, authorName = null } = {}) {
    const entry = this.store.articlesRepo.entry(String(entryID || ''));
    if (!entry) throw new Error('文章不存在或已被清理。');
    const feed = this.store.feedsRepo.feed?.(entry.feedID) || null;
    const author = authorName != null
      ? String(authorName)
      : String(this.store.preferences.get(BUNDLE.PREF_AUTHOR_KEY, '') || '');
    let html = null;
    if (includeFullText) {
      const cache = this.store.cachesRepo.cache(entry.id);
      const rawHTML = (cache && cache.html && String(cache.html).trim()) ? String(cache.html)
        : (entry.contentHTML && String(entry.contentHTML).trim()) ? String(entry.contentHTML) : '';
      if (rawHTML) {
        try {
          html = ArticleExtractor.sanitizedHTML(ArticleExtractor.normalizeFeedMarkup(rawHTML), entry.url);
        } catch (_) { html = null; }
        if (html && html.length > BUNDLE.HTML_MAX) html = html.slice(0, BUNDLE.HTML_MAX);
      }
    }
    const annotations = [];
    const pushAll = (rows, kind) => {
      for (const r of rows) {
        const shaped = shapeAnnotation({
          kind,
          text: r.text ?? r.content,
          note: r.note ?? null,
          color: r.color ?? null,
          anchor: r.anchor ?? null,
          createdAt: r.createdAt ?? null,
          origin: r.origin ?? null,
          uid: r.originID ?? null, // 导入身份随批注走（再导出往返不丢）
        });
        if (shaped) annotations.push(shaped);
      }
    };
    pushAll(this.store.knowledge.getHighlights(entry.id), 'highlight');
    pushAll(this.store.knowledge.getNotes(entry.id), 'note');
    if (annotations.length > BUNDLE.MAX_ANNOTATIONS) annotations.length = BUNDLE.MAX_ANNOTATIONS;
    const payload = {
      format: BUNDLE.FORMAT,
      version: BUNDLE.VERSION,
      exportedAt: nowSeconds(),
      author: { name: author },
      article: {
        title: String(entry.title || '').slice(0, BUNDLE.TITLE_SLICE),
        sourceTitle: String(feed?.title || ''),
        url: entry.url || null,
        publishedAt: entry.publishedAt ?? null,
        html,
      },
      annotations,
    };
    const json = JSON.stringify(payload, null, 2);
    this.counters.exported += 1;
    return {
      payload,
      json,
      byteLength: Buffer.byteLength(json, 'utf8'),
      suggestedName: `${sanitizeFileName(payload.article.title) || 'RobinRead 文章'}${BUNDLE.FILE_EXT}`,
      annotationCount: annotations.length,
    };
  }

  /** 写盘（主进程直写；savePath 来自 ipc 层保存对话框，照 BooksService 许可链）。 */
  writeBundleFile(json, savePath) {
    const target = String(savePath || '');
    if (!target) throw new Error('缺少保存路径。');
    const withExt = target.toLowerCase().endsWith(BUNDLE.FILE_EXT) ? target : target + BUNDLE.FILE_EXT;
    fs.mkdirSync(path.dirname(withExt), { recursive: true });
    fs.writeFileSync(withExt, String(json), 'utf8');
    return { path: withExt, bytes: Buffer.byteLength(String(json), 'utf8') };
  }

  /** 导出编排：组包 + 写盘（savePath 直传时跳过对话框；探针/主进程复用）。 */
  async exportToFile(entryID, { includeFullText = true, savePath = null, defaultName = null } = {}) {
    let target = savePath;
    if (!target) {
      const picked = this._saveDialogImpl
        ? await this._saveDialogImpl({ defaultName })
        : null;
      if (!picked) return null; // 用户取消
      target = picked;
    }
    const bundle = this.buildBundle(entryID, { includeFullText });
    const written = this.writeBundleFile(bundle.json, target);
    return { ...written, annotationCount: bundle.annotationCount, title: bundle.payload.article.title };
  }

  // MARK: 导入（三道闸 → 漂流入库 / 同源合并）

  /** 解析与校验（版本 / 大小 / 形状）。损坏 / 超限 / 版本不符 → 抛错（探针断言文案）。 */
  parseBundle(rawInput) {
    const raw = Buffer.isBuffer(rawInput) ? rawInput : Buffer.from(String(rawInput ?? ''), 'utf8');
    if (raw.length > BUNDLE.MAX_BYTES) {
      this.counters.rejected += 1;
      throw new Error(`批注包超过大小上限（${Math.round(BUNDLE.MAX_BYTES / 1024 / 1024)}MB），已拒绝导入。`);
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch (_) {
      this.counters.rejected += 1;
      throw new Error('批注包内容损坏（不是有效的 JSON）。');
    }
    if (!payload || typeof payload !== 'object' || payload.format !== BUNDLE.FORMAT) {
      this.counters.rejected += 1;
      throw new Error('这不是 RobinRead 批注包（format 不符）。');
    }
    if (Number(payload.version) > BUNDLE.VERSION) {
      this.counters.rejected += 1;
      throw new Error(`批注包格式版本不符（v${Number(payload.version)}，当前支持 v${BUNDLE.VERSION}），请升级知更后再导入。`);
    }
    const article = payload.article && typeof payload.article === 'object' ? payload.article : null;
    if (!article) {
      this.counters.rejected += 1;
      throw new Error('批注包缺少文章信息，无法导入。');
    }
    const list = Array.isArray(payload.annotations) ? payload.annotations : [];
    const annotations = [];
    for (const item of list) {
      const shaped = shapeAnnotation(item);
      if (shaped) annotations.push(shaped);
      if (annotations.length >= BUNDLE.MAX_ANNOTATIONS) break;
    }
    // 正文 HTML 过消毒白名单管线（script/iframe/事件属性一律剥除）
    let html = null;
    const rawHTML = String(article.html || '');
    if (rawHTML.trim()) {
      try {
        html = ArticleExtractor.sanitizedHTML(ArticleExtractor.normalizeFeedMarkup(rawHTML.slice(0, BUNDLE.HTML_MAX)), article.url || null);
      } catch (_) { html = null; }
    }
    return {
      payload,
      article: {
        title: String(article.title || '漂流文章').slice(0, BUNDLE.TITLE_SLICE),
        sourceTitle: String(article.sourceTitle || ''),
        url: article.url ? String(article.url) : null,
        publishedAt: Number(article.publishedAt) || null,
        html,
      },
      author: payload.author && typeof payload.author === 'object' ? String(payload.author.name || '') : '',
      exportedAt: Number(payload.exportedAt) || null,
      annotations,
    };
  }

  /**
   * 导入：同 URL（规范化）已存在 → 只合并批注；不存在 → 漂流条目入库。
   * @returns {{ entryID, drift, added, duplicates, conflicts, total }}
   */
  importBundle(rawInput, { sourcePath = null } = {}) {
    const parsed = this.parseBundle(rawInput);
    const urlNorm = parsed.article.url ? parsed.article.url.replace(/&amp;/g, '&') : null;
    const existing = urlNorm ? this._entryByURL(urlNorm) : null;
    const result = existing
      ? { entryID: existing, drift: false, added: 0, duplicates: 0, conflicts: 0, total: parsed.annotations.length }
      : this._insertDriftEntry(parsed);
    // 批注合并（漂流新文同样把包内批注落成你的本地批注，可续写可再导出）
    const merge = this._mergeAnnotations(result.entryID, parsed.annotations);
    result.added = merge.added;
    result.duplicates = merge.duplicates;
    result.conflicts = merge.conflicts;
    result.addedHighlights = merge.addedHighlights;
    result.addedNotes = merge.addedNotes;
    this.counters.imported += 1;
    if (result.drift) this.counters.driftArticles += 1;
    else this.counters.mergedEntries += 1;
    this.counters.addedHighlights += merge.addedHighlights;
    this.counters.addedNotes += merge.addedNotes;
    this.counters.duplicates += merge.duplicates;
    this.counters.conflicts += merge.conflicts;
    result.sourcePath = sourcePath;
    return result;
  }

  /** 从文件导入（主进程读取；filePath 来自 ipc 层打开对话框）。 */
  importFromFile(filePath) {
    const target = String(filePath || '');
    if (!target) throw new Error('缺少批注包路径。');
    const raw = fs.readFileSync(target); // 超限由 parseBundle 按字节裁决（先读后判，10MB 内安全）
    return this.importBundle(raw, { sourcePath: target });
  }

  // MARK: 内部：漂流入库与合并

  /** 漂流条目入库：合成 feed（platform='drift'）+ 确定性 entryID + 消毒正文缓存。 */
  _insertDriftEntry(parsed) {
    const feed = this._driftFeed();
    const identity = parsed.article.url || `title:${parsed.article.title}`;
    const entryID = `local:${feed.id}:${stableDigest(identity)}`;
    const existing = this.store.articlesRepo.entry(entryID);
    if (existing) return { entryID, drift: true, added: 0, duplicates: 0, conflicts: 0, total: parsed.annotations.length };
    const publishedAt = parsed.article.publishedAt || nowSeconds();
    this.store.articlesRepo.upsertEntry({
      id: entryID,
      accountID: feed.accountID,
      externalID: entryID,
      feedID: feed.id,
      title: parsed.article.title,
      author: parsed.author ? String(parsed.author).slice(0, 80) : null,
      url: parsed.article.url,
      publishedAt,
      summary: '',
      contentHTML: parsed.article.html || '',
      dateArrived: nowSeconds(),
    });
    // 正文缓存：reader 优先读缓存通路；is_sanitized=1（已过白名单管线，原样呈现）
    if (parsed.article.html) {
      try {
        this.store.cachesRepo.saveCache({
          entryID,
          text: ArticleExtractor.plainText(parsed.article.html).slice(0, 512 * 1024),
          html: parsed.article.html,
          isSanitized: true,
          sourceURL: parsed.article.url,
        });
      } catch (_) { /* 缓存失败不阻塞入库：contentHTML 兜底 */ }
    }
    this.store._invalidatePrepared();
    return { entryID, drift: true, added: 0, duplicates: 0, conflicts: 0, total: parsed.annotations.length };
  }

  /** 漂流收件箱（合成 feed）：单例复用；侧栏按 platform 语义与其他源并列。 */
  _driftFeed() {
    const feedURL = 'drift://bundles';
    const existing = this.store.feedsRepo.feedByURL(LOCAL_ACCOUNT_ID, feedURL);
    if (existing) return existing;
    return this.store.feedsRepo.insertFeed({
      accountID: LOCAL_ACCOUNT_ID,
      title: '批注漂流',
      siteURL: null,
      feedURL,
      platform: 'drift',
      platformRef: null,
    });
  }

  /** URL 规范化匹配既有条目（articles.url_norm 口径：&amp; → &）。 */
  _entryByURL(urlNorm) {
    const row = this.store.database.prepare(
      'SELECT item_id FROM articles WHERE url_norm = ? LIMIT 1'
    ).get(String(urlNorm));
    return row ? row.item_id : null;
  }

  /**
   * 批注合并（永不覆盖红线）：
   * - origin_id（uid）命中既有 → 去重跳过（重复导入 / 往返回流）；
   * - anchor+文本哈希命中本地既有（含无 uid 的原生批注）→ 去重跳过；
   * - 同位置（anchor 键）不同内容 → 并存为新批注（冲突计数，绝不改写已有行）；
   * - 导入批注 origin='imported' + origin_id=uid（无 uid 时按内容哈希生成稳定 uid）。
   */
  _mergeAnnotations(entryID, annotations) {
    let added = 0;
    let duplicates = 0;
    let conflicts = 0;
    let addedHighlights = 0;
    let addedNotes = 0;
    for (const a of annotations) {
      const uid = String(a.uid || '') || `hb-${stableDigest(`${a.kind}|${normalizeAnchorText(a.anchor)}|${String(a.text).replace(/\s+/g, ' ').trim()}`)}`;
      // 1) 身份证命中（重复导入 / 往返回流）→ 跳过
      if (this._originExists(entryID, a.kind, uid)) { duplicates += 1; continue; }
      // 2) 内容哈希命中（同文同位：对方把你导出的批注原样导回；与本机原生批注撞车）→ 跳过
      const local = this._localAnnotations(entryID, a.kind);
      const localKeys = new Set(local.map((r) => annotationKey({ uid: r.originID ?? r.origin_id, anchor: r.anchor, text: r.text ?? r.content })));
      const incomingHashKey = annotationKey({ uid: null, anchor: a.anchor, text: a.text });
      if (a.uid && localKeys.has(`uid:${a.uid}`)) { duplicates += 1; continue; }
      if (localKeys.has(incomingHashKey)) { duplicates += 1; continue; }
      // 3) 位置冲突（同位置不同内容）→ 并存新批注（永不覆盖）
      const positionKey = anchorPositionKey(a);
      const positionTaken = local.some((r) => anchorPositionKey({ anchor: r.anchor, text: r.text ?? r.content }) === positionKey);
      if (positionTaken) conflicts += 1;
      // 落库：走 KnowledgeEngine 统一入口（统计/花园钩子照常），再补导入身份
      let newID = null;
      try {
        if (a.kind === 'note') {
          const note = this.store.knowledge.addNote({ itemID: entryID, content: a.text, anchor: a.anchor });
          newID = note.id;
          addedNotes += 1;
        } else {
          const hl = this.store.knowledge.addHighlight({
            itemID: entryID, text: a.text, color: a.color || 'yellow', note: a.note || null, anchor: a.anchor,
          });
          newID = hl.id;
          addedHighlights += 1;
        }
        this.store.database.prepare(
          'UPDATE ' + (a.kind === 'note' ? 'notes' : 'highlights') + ' SET origin = ?, origin_id = ? WHERE id = ?'
        ).run('imported', uid, newID);
        added += 1;
      } catch (_) { /* 单条失败不拖垮整包 */ }
    }
    return { added, duplicates, conflicts, addedHighlights, addedNotes };
  }

  _originExists(entryID, kind, uid) {
    if (!uid) return false;
    const table = kind === 'note' ? 'notes' : 'highlights';
    const row = this.store.database.prepare(
      `SELECT id FROM ${table} WHERE item_id = ? AND origin_id = ? LIMIT 1`
    ).get(entryID, uid);
    return !!row;
  }

  _localAnnotations(entryID, kind) {
    return kind === 'note'
      ? this.store.knowledge.getNotes(entryID)
      : this.store.knowledge.getHighlights(entryID);
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return { ...this.counters, ...BUNDLE, format: BUNDLE.FORMAT, version: BUNDLE.VERSION };
  }
}

/** 文件名净化（Windows 非法字符 + 控制长度；与 Obsidian sanitizeStem 同思路）。 */
function sanitizeFileName(raw) {
  return String(raw || '')
    .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

module.exports = {
  RobinBundleService,
  BUNDLE,
  annotationKey,
  anchorPositionKey,
  shapeAnnotation,
  sanitizeFileName,
};
