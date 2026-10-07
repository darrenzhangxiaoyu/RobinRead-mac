'use strict';
/**
 * RobinRead（知更）— 邮件 MIME 解析（F6，零新依赖）
 *
 * 覆盖 Newsletter 收件所需的子集：
 * - RFC 2047 编码字解码：=?charset?B|Q?...?=（B=base64、Q=quoted-printable 变体），
 *   相邻编码字（仅空白分隔）按规范拼接且不保留中间空白；折叠头先展开；
 * - multipart/* 递归拆分（boundary），text/plain 优先、text/html 兜底；
 * - Content-Transfer-Encoding：quoted-printable / base64 / 7bit / 8bit；
 * - charset 经 node:buffer TextDecoder（Electron 全量 ICU，常用中文日韩 charset 可用），
 *   不支持的 charset 显式降级 utf-8（不抛错）。
 *
 * 输出约定：parseMessage() 返回 {subject, from, messageID, dateSeconds, html, text}，
 * 其中 html/text 为「邮件正文视图」：text/plain 正文会包成极简段落 HTML，
 * text/html 原样返回（消毒由调用方走 ArticleExtractor.sanitizedHTML）。
 */

// MARK: 编码字（RFC 2047）

const ENCODED_WORD_RE = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
/** 相邻编码字（之间只允许空白）作为一个拼接组。 */
const ENCODED_WORD_GROUP_RE = /=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=(?:[\t ]+=[\t ]*\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)*/g;

/** 头部展开：折叠（CRLF+WSP）压成单空格，裸 CRLF 去除。 */
function unfoldHeader(value) {
  return String(value ?? '')
    .replace(/\r?\n[ \t]+/g, ' ')
    .replace(/\r?\n/g, ' ');
}

/** charset → TextDecoder；不支持/null 时降级 utf-8（显式标注不抛错）。 */
function decoderForCharset(charset) {
  const raw = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  const aliases = {
    'gb2312': 'gbk', 'gb_2312': 'gbk', 'csgb2312': 'gbk',
    'ks_c_5601-1987': 'euc-kr', 'iso8859-1': 'iso-8859-1', 'iso88591': 'iso-8859-1',
    'utf8': 'utf-8', 'utf-8//': 'utf-8',
  };
  const name = aliases[raw] || raw;
  try {
    return { decoder: new TextDecoder(name, { fatal: false }), charset: name };
  } catch (_) {
    return { decoder: new TextDecoder('utf-8', { fatal: false }), charset: 'utf-8', fallback: true };
  }
}

/** 字节流按 charset 解码（不支持的 charset 降级 utf-8）。 */
function decodeBuffer(buf, charset) {
  const { decoder } = decoderForCharset(charset);
  return decoder.decode(Buffer.from(buf));
}

/** Q 编码体解码：_ → 空格，=XX → 字节。输出原始字节（charset 在外层统一解）。 */
function qDecodeBytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '_') { out.push(0x20); continue; }
    if (ch === '=' && i + 2 < text.length + 1 && /[0-9a-fA-F]{2}/.test(text.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    out.push(text.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

/** quoted-printable 解码（RFC 2045 §6.7：=XX 十六进制、=行尾软换行）。 */
function qpDecodeBytes(text) {
  const normalized = String(text ?? '').replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === '=' && /[0-9a-fA-F]{2}/.test(normalized.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(normalized.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    out.push(normalized.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

/** 单个编码字 token → 解码后文本。 */
function decodeEncodedToken(charset, encoding, body) {
  const bytes = encoding.toLowerCase() === 'b'
    ? Buffer.from(body, 'base64')
    : qDecodeBytes(body);
  return decodeBuffer(bytes, charset);
}

/** 完整头部值解码：编码字组拼接 + 其余空白保留。 */
function decodeHeaderValue(value) {
  const unfolded = unfoldHeader(value);
  const SINGLE_RE = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/;
  return unfolded.replace(ENCODED_WORD_GROUP_RE, (group) => group
    .match(ENCODED_WORD_RE)
    .map((token) => {
      const single = token.match(SINGLE_RE);
      try {
        return decodeEncodedToken(single[1], single[2], single[3]);
      } catch (_) {
        return token; // 单 token 损坏：原样保留
      }
    })
    .join(''));
}

// MARK: 头部块解析

/** 头部块 → {小写名: 值}（重复名取首个；名字原样保留在 _names 备查）。 */
function parseHeaderBlock(headerText) {
  const headers = { __names: {} };
  const unfolded = String(headerText ?? '').replace(/\r?\n[ \t]+/g, ' ');
  for (const rawLine of unfolded.split(/\r?\n/)) {
    if (!rawLine) continue;
    const idx = rawLine.indexOf(':');
    if (idx <= 0) continue;
    const name = rawLine.slice(0, idx).trim().toLowerCase();
    const value = rawLine.slice(idx + 1).trim();
    if (!(name in headers)) {
      headers[name] = value;
      headers.__names[name] = rawLine.slice(0, idx).trim();
    }
  }
  return headers;
}

/** Content-Type 解析 → {type, params}（type 小写；params 键小写）。 */
function parseContentType(value) {
  const text = unfoldHeader(value || '').trim();
  const semi = text.indexOf(';');
  const type = (semi < 0 ? text : text.slice(0, semi)).trim().toLowerCase() || 'text/plain';
  const params = {};
  const rest = semi < 0 ? '' : text.slice(semi + 1);
  const attrRe = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/g;
  let m;
  while ((m = attrRe.exec(rest)) !== null) {
    params[m[1].toLowerCase()] = (m[2] != null ? m[2].replace(/\\(.)/g, '$1') : m[3]) || '';
  }
  return { type, params };
}

// MARK: 正文拆分

/** 按 boundary 拆 multipart 体 → 原始 part 字符串数组（忽略 preamble/epilogue）。 */
function splitMultipart(bodyText, boundary) {
  const delimiter = `--${boundary}`;
  const lines = String(bodyText ?? '').split(/\r?\n/);
  const parts = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === delimiter) {
      if (current) parts.push(current);
      current = [];
    } else if (trimmed === `${delimiter}--`) {
      if (current) parts.push(current);
      current = null;
      break;
    } else if (current) {
      current.push(line);
    }
  }
  if (current && current.length) parts.push(current);
  return parts.map((arr) => arr.join('\r\n'));
}

/** 从 part（headers+body 原文）取 (headers, bodyText)。 */
function splitPart(text) {
  const sep = text.search(/\r?\n\r?\n/);
  if (sep < 0) return { headerText: text, bodyText: '' };
  const headerText = text.slice(0, sep);
  const bodyText = text.slice(sep).replace(/^\r?\n\r?\n/, '');
  return { headerText, bodyText };
}

/** Content-Transfer-Encoding 解码 → 字节。 */
function decodeTransfer(bodyText, cte) {
  const enc = String(cte || '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(String(bodyText ?? '').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return qpDecodeBytes(bodyText);
  return Buffer.from(String(bodyText ?? ''), 'latin1'); // 7bit/8bit/binary/未知
}

/**
 * 递归解析消息/部分，取最优文本正文（text/plain 优先，text/html 兜底）。
 * 返回 {html, text, charsetFallback}：html = 视图 HTML；text = 纯文本（摘要用）。
 */
function pickBody(headerText, bodyText, depth = 0) {
  if (depth > 8) return { html: null, text: null, charsetFallback: false };
  const headers = parseHeaderBlock(headerText);
  const { type, params } = parseContentType(headers['content-type']);

  if (type.startsWith('multipart/')) {
    const boundary = params.boundary;
    if (!boundary) return { html: null, text: null, charsetFallback: false };
    let html = null;
    let text = null;
    let charsetFallback = false;
    // 先扫一遍收 text/plain（规范优先级），缺省时再收 text/html
    for (const part of splitMultipart(bodyText, boundary)) {
      const sub = splitPart(part);
      const subHeaders = parseHeaderBlock(sub.headerText);
      const subType = parseContentType(subHeaders['content-type']).type;
      if (subType === 'message/rfc822') continue;
      const picked = pickBody(sub.headerText, sub.bodyText, depth + 1);
      charsetFallback = charsetFallback || picked.charsetFallback;
      if (picked.text != null && text == null) text = picked.text;
      if (picked.html != null && html == null) html = picked.html;
    }
    return { html, text, charsetFallback };
  }

  if (type === 'message/rfc822') {
    const sub = splitPart(bodyText);
    return pickBody(sub.headerText, sub.bodyText, depth + 1);
  }

  if (type !== 'text/plain' && type !== 'text/html') {
    return { html: null, text: null, charsetFallback: false }; // 附件等非正文部分
  }

  const bytes = decodeTransfer(bodyText, headers['content-transfer-encoding']);
  const { charset, fallback } = decoderForCharset(params.charset || 'utf-8');
  const decoded = decodeBuffer(bytes, charset);

  if (type === 'text/html') {
    return { html: decoded, text: null, charsetFallback: fallback };
  }
  return { html: null, text: decoded, charsetFallback: fallback };
}

// MARK: 地址与时间

/** From 头 → {name, address}（解码显示名；地址取 <> 内或整体）。 */
function parseFrom(rawHeader) {
  const decoded = decodeHeaderValue(rawHeader || '');
  const angle = decoded.match(/<([^>]+)>/);
  const address = angle ? angle[1].trim() : decoded.trim();
  let name = angle ? decoded.slice(0, decoded.indexOf('<')).trim() : '';
  name = name.replace(/^"(.*)"$/, '$1').trim();
  return { name, address };
}

/** RFC 2822 Date 头 → 秒（解析失败 null）。 */
function parseDateSeconds(rawHeader) {
  if (!rawHeader) return null;
  const t = Date.parse(unfoldHeader(rawHeader).replace(/\(.*?\)\s*$/, '').trim());
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

// MARK: 纯文本视图

/** 宽松 HTML → 纯文本（摘要与 text/plain 化视图共用）。 */
function htmlToText(value) {
  return String(value ?? '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|blockquote|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** text/plain → 极简段落 HTML（转义；空行分段）。后续统一过 sanitizedHTML。 */
function plainTextToHTML(text) {
  const paragraphs = String(text ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (!paragraphs.length) return '<p></p>';
  return paragraphs
    .map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// MARK: 顶层入口

/**
 * 解析整封邮件。注意 IMAP 形态：FETCH 的头 literal 只含请求的字段
 * （Subject/From/Date/Message-ID），而 BODY[TEXT] literal 自带实体的
 * MIME 小头（Content-Type / Content-Transfer-Encoding）。
 * 兼容两种入体：
 * - bodyText 带小头（IMAP 标准形态）：拆出小头后按实体挑正文；
 * - bodyText 为裸正文（整消息拆分传入）：回退用 headerText（含全局 Content-Type）。
 * @returns {{subject, from:{name,address}, messageID, dateSeconds, html, text, charsetFallback}}
 */
function parseMessage(headerText, bodyText) {
  const headers = parseHeaderBlock(headerText);
  const subject = decodeHeaderValue(headers['subject'] || '');
  const from = parseFrom(headers['from'] || '');
  const messageID = String(headers['message-id'] || '').trim();
  const dateSeconds = parseDateSeconds(headers['date']);

  const rawBody = String(bodyText ?? '');
  // 顶层（外层头）声明了 Content-Type 时以外层为准——multipart 体第一个 part 自带
  // content-type 小头，mini-header 启发式只在「完全无外层头」的裸体输入时兜底，
  // 否则会把 multipart/alternative 误判成叶子正文（实测整段 html 部分被黏进 plain）。
  const outerHeaders = parseHeaderBlock(headerText);
  const hasOuterContentType = Boolean(outerHeaders['content-type']);
  const part = splitPart(rawBody);
  const hasMiniHeader = /(^|\r?\n)content-(?:type|transfer-encoding)\s*:/i.test(part.headerText);
  const picked = hasOuterContentType
    ? pickBody(headerText, rawBody)
    : (hasMiniHeader
      ? pickBody(part.headerText, part.bodyText)
      : pickBody(headerText, rawBody));

  // 正文视图：任务口径 text/plain 优先（天然避开邮件跟踪像素与复杂标记），
  // 仅当整封无 text/plain 时才取 text/html；摘要文本同步从 html 剥取
  let html = null;
  let text = picked.text;
  if (text != null && text.trim()) {
    html = plainTextToHTML(text);
  } else {
    html = picked.html;
    text = picked.html != null ? htmlToText(picked.html) : '';
  }

  return {
    subject,
    from,
    messageID,
    dateSeconds,
    html,
    text: text || '',
    charsetFallback: Boolean(picked.charsetFallback),
  };
}

module.exports = {
  parseMessage,
  decodeHeaderValue,
  parseHeaderBlock,
  parseContentType,
  splitMultipart,
  qpDecodeBytes,
  qDecodeBytes,
  decodeBuffer,
  decodeTransfer,
  parseFrom,
  parseDateSeconds,
  plainTextToHTML,
  htmlToText,
};
