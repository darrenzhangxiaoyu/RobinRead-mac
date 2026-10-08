'use strict';
/**
 * EpubBuilder.js — 单篇文章 → EPUB 3 电子书（方向 19 v1，调研报告 2026-09-26）
 *
 * 零依赖：内置最小 ZIP 写入器（仅 store 不压缩；CRC32 查表），
 * 保证 EPUB 规范要求的 mimetype 条目「第一个、无压缩、无额外字段」。
 * 正文必须是已消毒的 HTML（调用方经 ArticleExtractor.sanitizedHTML 产出）。
 */

// ── CRC32（IEEE 802.3，ZIP 规范多项式）──
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** DOS 时间（ZIP 时间戳，2 秒精度；本地时间即可）。 */
function dosDateTime(date) {
  const d = date || new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, day };
}

/**
 * 组装 ZIP（全部 store）：entries = [{ name, data:Buffer }]。
 * 返回 Buffer。只用于 EPUB 这类小体积文本容器，不做分卷/压缩。
 */
function buildZip(entries, timestamp) {
  const { time, day } = dosDateTime(timestamp);
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8 文件名
    local.writeUInt16LE(0, 8);           // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra 长度必须为 0（mimetype 规范要求）
    locals.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);            // version made by
    cen.writeUInt16LE(20, 6);            // version needed
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(day, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);            // extra
    cen.writeUInt16LE(0, 32);            // comment
    cen.writeUInt16LE(0, 34);            // disk start
    cen.writeUInt16LE(0, 36);            // internal attrs
    cen.writeUInt32LE(0, 38);            // external attrs
    cen.writeUInt32LE(offset, 42);       // local header 偏移
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function escapeXML(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// XML 良构化的常见命名实体（HTML 实体 → 数值引用；XML 只认 amp/lt/gt/quot/apos 五个）
const ENTITY_MAP = {
  nbsp: 160, shy: 173, copy: 169, reg: 174, trade: 8482, mdash: 8212, ndash: 8211, hellip: 8230,
  lsquo: 8216, rsquo: 8217, ldquo: 8220, rdquo: 8221, laquo: 171, raquo: 187, times: 215, divide: 247,
  plusmn: 177, sup2: 178, sup3: 179, frac12: 189, frac14: 188, frac34: 190, deg: 176, middot: 183,
  bull: 8226, sect: 167, para: 182, dagger: 8224, Dagger: 8225, permil: 8240, prime: 8242, Prime: 8243,
  larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, ensp: 8194, emsp: 8195, thinsp: 8201,
  zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, euro: 8364, pound: 163, yen: 165, cent: 162, sect2: 167,
};
const VOID_TAGS = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;
// 布尔属性（HTML 允许无值，XML 不允许）
const BOOLEAN_ATTRS = /^(?:controls|autoplay|loop|muted|disabled|checked|readonly|selected|open|required|multiple|novalidate|playsinline|allowfullscreen|default|reversed|hidden)$/i;

/**
 * 消毒 HTML → XML 良构（EPUB 章节按 XML 解析，三类致命问题必须处理）：
 * 1. 裸 & 与 HTML 命名实体 → 数值引用/转义；2. void 标签自闭合；3. 布尔属性补值。
 */
function toWellFormedXML(html) {
  let s = String(html || '');
  // a. 保护已转义的 &amp; → 占位（避免二次转义）
  s = s.replace(/&amp;/g, '\u0001AMP\u0001');
  // b. 其余命名实体：已知 → 数值引用；未知 → 丢弃（防止 &xyz; 炸解析）
  s = s.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(ENTITY_MAP, name) ? `&#${ENTITY_MAP[name]};` : ''
  ));
  // c. 剩余裸 &（不含数字/十六进制实体形态）→ 转义
  s = s.replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
  // d. 还原 &amp;
  s = s.replace(/\u0001AMP\u0001/g, '&amp;');
  // e. 布尔属性补值（仅标签内裸词形态，已有 =值 的不受影响）
  s = s.replace(/(<[a-zA-Z][^<>]*?)\s(controls|autoplay|loop|muted|disabled|checked|readonly|selected|open|required|multiple|novalidate|playsinline|allowfullscreen|default|reversed|hidden)(\s*\/?>)/gi,
    (whole, head, attr, tail) => `${head} ${attr.toLowerCase()}="${attr.toLowerCase()}"${tail}`);
  // f. void 标签自闭合（<br> <img ...> → <br/> <img .../>）
  s = s.replace(/<([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\s*(\/?)>/g, (whole, tag, attrs, selfClosed) => {
    if (!VOID_TAGS.test(tag)) return whole;
    const trimmedAttrs = attrs.replace(/\s+$/, '');
    return `<${tag}${trimmedAttrs} />`;
  });
  return s;
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const STYLE_CSS = `body { font-family: "LXGW WenKai Screen", "Source Han Serif SC", "Noto Serif CJK SC", Georgia, serif; line-height: 1.75; margin: 5% auto; max-width: 34em; color: #1f1c17; }
h1 { font-size: 1.5em; line-height: 1.3; }
.meta { color: #6b6558; font-size: 0.85em; border-bottom: 1px solid #d8d2c4; padding-bottom: 0.8em; margin-bottom: 1.4em; }
img { max-width: 100%; height: auto; }
blockquote { border-left: 3px solid #8a9a7b; margin: 1.2em 0; padding: 0.2em 0 0.2em 1em; color: #4a463c; }
pre, code { font-family: Consolas, Menlo, monospace; font-size: 0.9em; }
p { text-indent: 0; margin: 0.8em 0; }`;

/**
 * 构建多章节 EPUB（方向 19 整期）：chapters = [{ title, author?, feedTitle?, publishedAt?, url?, html }]
 * 章节文件 OEBPS/ch<N>..xhtml；封面章节缺失时以目录页承担导航。
 * 返回 Buffer。buildEntryEpub 为其单章节特例。
 */
function buildEditionEpub(payload) {
  const bookTitle = String(payload?.title || 'RobinRead Edition');
  const chapters = (Array.isArray(payload?.chapters) ? payload.chapters : []).filter((ch) => ch && String(ch.html || '').trim());
  if (!chapters.length) throw new Error('epub: empty content');
  if (chapters.length > 60) chapters.length = 60;
  const uuid = `robinread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const chapterFiles = [];
  const manifestItems = [];
  const spineItems = [];
  const tocItems = [];
  chapters.forEach((ch, index) => {
    const id = `ch${index + 1}`;
    const href = `${id}.xhtml`;
    const chTitle = String(ch.title || `#${index + 1}`);
    const metaBits = [];
    if (ch.feedTitle) metaBits.push(escapeXML(ch.feedTitle));
    if (ch.publishedAt) {
      const d = new Date(ch.publishedAt * 1000);
      if (!Number.isNaN(d.getTime())) metaBits.push(d.toISOString().slice(0, 10));
    }
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh" xml:lang="zh">
<head><meta charset="utf-8"/><title>${escapeXML(chTitle)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<h1>${escapeXML(chTitle)}</h1>
${metaBits.length ? `<p class="meta">${metaBits.join(' · ')}</p>` : ''}
${toWellFormedXML(String(ch.html))}
</body></html>`;
    chapterFiles.push({ name: `OEBPS/${href}`, data: Buffer.from(xhtml, 'utf8') });
    manifestItems.push(`    <item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`    <itemref idref="${id}"/>`);
    tocItems.push(`      <li><a href="${href}">${escapeXML(chTitle)}</a></li>`);
  });

  const navXHTML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>TOC</title></head>
<body><nav epub:type="toc"><h1>${escapeXML(bookTitle)}</h1><ol>
${tocItems.join('\n')}
</ol></nav></body></html>`;

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${escapeXML(bookTitle)}</dc:title>
    <dc:language>zh</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
${manifestItems.join('\n')}
  </manifest>
  <spine>
${spineItems.join('\n')}
  </spine>
</package>`;

  return buildZip([
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8') },
    { name: 'META-INF/container.xml', data: Buffer.from(CONTAINER_XML, 'utf8') },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf, 'utf8') },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(navXHTML, 'utf8') },
    { name: 'OEBPS/style.css', data: Buffer.from(STYLE_CSS, 'utf8') },
    ...chapterFiles,
  ]);
}

/**
 * 构建单篇 EPUB。payload: { title, author, feedTitle, publishedAt(秒), url, html }
 * 返回 Buffer。
 */
function buildEntryEpub(payload) {
  const title = String(payload?.title || 'Untitled');
  const html = String(payload?.html || '');
  if (!html.trim()) throw new Error('epub: empty content');
  const metaBits = [];
  if (payload?.feedTitle) metaBits.push(escapeXML(payload.feedTitle));
  if (payload?.publishedAt) {
    const d = new Date(payload.publishedAt * 1000);
    if (!Number.isNaN(d.getTime())) metaBits.push(d.toISOString().slice(0, 10));
  }
  return buildEditionEpub({
    title,
    chapters: [{ title, author: payload?.author, feedTitle: payload?.feedTitle, publishedAt: payload?.publishedAt, url: payload?.url, html }],
  });
}

// MARK: - 成书（F12 个人文集）：无篇数上限 + 按月分章 + 元数据 + 封面

const BOOK_STYLE_CSS = `${STYLE_CSS}
h2 { font-size: 1.2em; line-height: 1.3; margin-top: 1.6em; }
section { border-top: 1px solid #d8d2c4; margin-top: 2em; padding-top: 1em; }
.cover-page { text-align: center; margin-top: 18%; }
.cover-page img { max-width: 128px; max-height: 128px; }
.cover-title { font-size: 1.9em; margin-top: 1em; line-height: 1.4; }
.cover-author { color: #6b6558; margin-top: 0.8em; }`;

/** 纯色标题封面 SVG（无源 icon 时的确定性回退；600×800，白字居中）。 */
function titleCoverSVG(title) {
  const raw = String(title || 'RobinRead');
  // CJK 主场：按 12 字/行硬换行（确定性，不依赖字体度量），最多 8 行 + 省略号
  const lines = [];
  for (let i = 0; i < raw.length && lines.length < 8; i += 12) lines.push(raw.slice(i, i + 12));
  if (raw.length > 96) lines[7] = `${lines[7].slice(0, 11)}…`;
  const tspans = lines
    .map((line, i) => `<text x="300" y="${330 + i * 62}" text-anchor="middle" font-size="44" fill="#f6f2e7" font-family="serif">${escapeXML(line)}</text>`)
    .join('\n  ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <rect width="600" height="800" fill="#37503f"/>
  <rect x="40" y="40" width="520" height="720" fill="none" stroke="#d8d2c4" stroke-width="2"/>
  ${tspans}
  <text x="300" y="726" text-anchor="middle" font-size="24" fill="#b9c4b2" font-family="serif">RobinRead</text>
</svg>`;
}

/**
 * 构建成书 EPUB（F12 个人文集；与 buildEditionEpub 互不影响——整期导出行为保持不变）。
 *
 * payload: {
 *   title:   书名（必填），
 *   author:  作者元数据（默认 'RobinRead'），
 *   sections: [{ title: 'YYYY年M月', articles: [{ title, feedTitle?, publishedAt?(秒), url?, html }] }]
 *            —— 每个分章一个 XHTML（章内文章按传入顺序排；篇数无上限，分卷由调用方负责），
 *   cover:   { mime, base64 }（源 icon 图片）| null（回退纯色标题封面 SVG），
 * }
 * 返回 Buffer。
 */
function buildBookEpub(payload) {
  const bookTitle = String(payload?.title || 'RobinRead Book');
  const author = String(payload?.author || 'RobinRead');
  const sections = (Array.isArray(payload?.sections) ? payload.sections : [])
    .map((sec) => ({
      title: String(sec?.title || ''),
      articles: (Array.isArray(sec?.articles) ? sec.articles : []).filter((a) => a && String(a.html || '').trim()),
    }))
    .filter((sec) => sec.articles.length);
  if (!sections.length) throw new Error('epub: empty content');
  const uuid = `robinread-book-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const dateISO = modified.slice(0, 10);

  const files = [];
  const manifestItems = [];
  const spineItems = [];
  const tocItems = [];
  let articleTotal = 0;

  // ── 封面：源 icon 图片（images/cover.*，properties=cover-image）或纯色标题封面 SVG ──
  const cover = payload?.cover && payload.cover.base64 ? payload.cover : null;
  let coverHref = null;
  if (cover) {
    const ext = /svg/i.test(cover.mime) ? 'svg' : (/gif/i.test(cover.mime) ? 'gif' : (/jpg|jpeg/i.test(cover.mime) ? 'jpg' : (/webp/i.test(cover.mime) ? 'webp' : 'png')));
    coverHref = `images/cover.${ext}`;
    files.push({ name: `OEBPS/${coverHref}`, data: Buffer.from(String(cover.base64), 'base64') });
    manifestItems.push(`    <item id="cover-image" href="${coverHref}" media-type="${escapeXML(cover.mime)}" properties="cover-image"/>`);
  } else {
    coverHref = 'cover.svg';
    files.push({ name: 'OEBPS/cover.svg', data: Buffer.from(titleCoverSVG(bookTitle), 'utf8') });
    manifestItems.push(`    <item id="cover-image" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>`);
  }
  const coverXHTML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh" xml:lang="zh">
<head><meta charset="utf-8"/><title>${escapeXML(bookTitle)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<div class="cover-page" epub:type="cover">
${cover ? `<img src="${coverHref}" alt="cover"/>` : `<img src="cover.svg" alt="cover"/>`}
<h1 class="cover-title">${escapeXML(bookTitle)}</h1>
<p class="cover-author">${escapeXML(author)}</p>
</div>
</body></html>`;
  files.push({ name: 'OEBPS/cover.xhtml', data: Buffer.from(coverXHTML, 'utf8') });
  manifestItems.push('    <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>');
  spineItems.push('    <itemref idref="cover-page" linear="yes"/>');

  // ── 分章（月）文件 ──
  sections.forEach((sec, sIndex) => {
    const secId = `sec${sIndex + 1}`;
    const href = `${secId}.xhtml`;
    const articleBlocks = [];
    const tocChildren = [];
    sec.articles.forEach((art, aIndex) => {
      const anchor = `a${aIndex + 1}`;
      articleTotal += 1;
      const artTitle = String(art.title || `#${aIndex + 1}`);
      const metaBits = [];
      if (art.feedTitle) metaBits.push(escapeXML(art.feedTitle));
      if (art.publishedAt) {
        const d = new Date(art.publishedAt * 1000);
        if (!Number.isNaN(d.getTime())) metaBits.push(d.toISOString().slice(0, 10));
      }
      articleBlocks.push(`<section id="${anchor}">
<h2>${escapeXML(artTitle)}</h2>
${metaBits.length ? `<p class="meta">${metaBits.join(' · ')}</p>` : ''}
${toWellFormedXML(String(art.html))}
</section>`);
      tocChildren.push(`        <li><a href="${href}#${anchor}">${escapeXML(artTitle)}</a></li>`);
    });
    const secXHTML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh" xml:lang="zh">
<head><meta charset="utf-8"/><title>${escapeXML(sec.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<h1>${escapeXML(sec.title)}</h1>
${articleBlocks.join('\n')}
</body></html>`;
    files.push({ name: `OEBPS/${href}`, data: Buffer.from(secXHTML, 'utf8') });
    manifestItems.push(`    <item id="${secId}" href="${href}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`    <itemref idref="${secId}"/>`);
    tocItems.push(`      <li><span>${escapeXML(sec.title)}</span>
<ol>
${tocChildren.join('\n')}
</ol></li>`);
  });

  const navXHTML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>TOC</title></head>
<body><nav epub:type="toc"><h1>${escapeXML(bookTitle)}</h1><ol>
${tocItems.join('\n')}
</ol></nav></body></html>`;

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="zh">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${escapeXML(bookTitle)}</dc:title>
    <dc:creator>${escapeXML(author)}</dc:creator>
    <dc:language>zh</dc:language>
    <dc:date>${dateISO}</dc:date>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
${manifestItems.join('\n')}
  </manifest>
  <spine>
${spineItems.join('\n')}
  </spine>
</package>`;

  return buildZip([
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8') },
    { name: 'META-INF/container.xml', data: Buffer.from(CONTAINER_XML, 'utf8') },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf, 'utf8') },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(navXHTML, 'utf8') },
    { name: 'OEBPS/style.css', data: Buffer.from(BOOK_STYLE_CSS, 'utf8') },
    ...files,
  ]);
}

module.exports = { buildEntryEpub, buildEditionEpub, buildBookEpub, titleCoverSVG, buildZip, crc32, toWellFormedXML };
