'use strict';
/**
 * verify-f5-sec.js — F5 验证轮定向实测（一次性，用完即删）
 * Part 1：对抗消毒（iframe 白名单 token 机制）+ 平台解析器鲁棒性（纯 Node，无 electron）
 */
let failed = 0;
const ok = (c, l, extra) => {
  if (c) console.log('PASS ' + l + (extra ? '  [' + extra + ']' : ''));
  else { failed += 1; console.error('FAIL ' + l + (extra ? '  [' + extra + ']' : '')); }
};

const { sanitizedHTML, plainText } = require('../src/main/ArticleExtractCore');
const { ADAPTERS, PlatformError, parseWeiboDate, extractJSONObjectAfter } = require('../src/main/PlatformService');

const countIFrames = (html) => (html.match(/<iframe\b/gi) || []).length;
const hasIFrame = (html) => /<iframe\b/i.test(html);

// ── A. 对抗消毒：非白名单必须剥 ──
{
  const cases = [
    ['https://player.bilibili.com.evil.com/x', '子域后缀绕过'],
    ['https://player.bilibili.com.evil.com/', '子域后缀绕过2'],
    ['https://evil-player.bilibili.com/x', '前缀混淆 host'],
    ['https://player.bilibili.com@evil.com/x', 'userinfo@ 绕过'],
    ['http://player.bilibili.com/x', 'http 明文'],
    ['ftp://player.bilibili.com/x', '非 http(s) scheme'],
    ['javascript:https://player.bilibili.com/', 'javascript 伪协议'],
    ['https://evil.com\\@player.bilibili.com/', '反斜杠@ 绕过'],
    ['https://player.bilibili.com\u0000.evil.com/', 'NUL 注入'],
  ];
  for (const [src, label] of cases) {
    const out = sanitizedHTML(`<p>前文</p><iframe src="${src}" onload="alert(1)"></iframe><p>后文</p>`);
    ok(!hasIFrame(out), `A1 ${label} → iframe 剥除`, src);
  }
}
{
  // 实体编码绕过（浏览器解码后才是恶意 host）
  const variants = [
    '<iframe src="https://player.bilibili.com&#46;evil&#46;com/x"></iframe>',
    "<iframe src='https://player.bilibili.com&#x2e;evil.com/x'></iframe>",
    '<iframe src="https://player.bilibili.com&colon;evil/x"></iframe>',
    '<iframe src="&Tab;https://player.bilibili.com.evil.com/x"></iframe>',
  ];
  for (const v of variants) {
    const out = sanitizedHTML(v);
    ok(!hasIFrame(out), 'A2 实体编码恶意 host → 剥除', v.slice(0, 70));
  }
}
{
  // 大小写 / 空白混淆：真白名单 host 应存活（URL 解析器语义一致），且属性零回抄
  const out = sanitizedHTML('<IFRAME SRC="HTTPS://PLAYER.BILIBILI.COM/player.html?bvid=BV1xx" ONLOAD="alert(1)" CLASS="x" ID="y" STYLE="position:fixed" SRCDOC="<script>alert(2)</script>" ALLOW="camera; microphone"><script>alert(3)</script></IFRAME>');
  ok(hasIFrame(out), 'A3 大写白名单 iframe 存活');
  ok(!/onload|srcdoc|class=|style=|script/i.test(out.replace(/<iframe[^>]*>/i, (m) => m)), 'A3 危险属性零回抄', out.slice(0, 220));
  ok(/^<iframe src="HTTPS:\/\/PLAYER\.BILIBILI\.COM\/player\.html\?bvid=BV1xx" width="100%" height="360" scrolling="no" frameborder="no" allowfullscreen="true" loading="lazy"><\/iframe>$/i.test(out.trim()) || /<iframe src=[^>]+loading="lazy"><\/iframe>/.test(out), 'A3 重建属性白名单化', out.slice(0, 240));
}
{
  // 协议相对 // → 重建为 https
  const out = sanitizedHTML('<iframe src="//player.bilibili.com/player.html?bvid=BV1yy"></iframe>');
  ok(/src="https:\/\/player\.bilibili\.com\//.test(out), 'A4 协议相对 // 补 https', out.slice(0, 160));
}
{
  // 带 path 但 host 前缀同形：player.bilibili.com:8443（端口未校验——预期为发现项）
  const out = sanitizedHTML('<iframe src="https://player.bilibili.com:8443/x"></iframe>');
  console.log('INFO A5 非默认端口 player.bilibili.com:8443 → ' + (hasIFrame(out) ? '存活（端口未纳入白名单判定）' : '剥除'));
}
{
  // 假 token：无真嵌入时不得产出任何 iframe
  const out1 = sanitizedHTML('<p>正文 ROBINEMBED0END 尾</p>');
  ok(!hasIFrame(out1), 'A6 假 token 无嵌入 → 不产出 iframe');
  const out2 = sanitizedHTML('<p>ROBINEMBED99END ROBINEMBED-1END ROBINEMBEDxEND</p>');
  ok(!hasIFrame(out2), 'A6 越界/畸形 token → 不产出 iframe');
}
{
  // 假 token + 1 个真嵌入：重复 iframe（发现项：内容级复制，src 仍受白名单约束）
  const out = sanitizedHTML('<iframe src="https://player.bilibili.com/player.html?bvid=BV1zz"></iframe><p>攻击者正文 ROBINEMBED0END</p>');
  const n = countIFrames(out);
  ok(n >= 1, 'A7 真嵌入存活');
  ok((out.match(/player\.bilibili\.com/g) || []).length === n, 'A7 重复 token 只复制白名单 src', 'iframes=' + n);
  // 注释重组 token：注释剥离在 token 展开之后 → 重组文本不再展开（良性不对称）。
  // 安全性质：存活的 iframe 数量不放大、且 src 全部指向白名单 host。
  const out2 = sanitizedHTML('<iframe src="https://player.bilibili.com/player.html?bvid=BV1zz"></iframe><p>ROBINEM<!-- -->BED0END</p>');
  const n2 = countIFrames(out2);
  const srcs2 = [...out2.matchAll(/<iframe[^>]*src="([^"]*)"/gi)].map((m) => m[1]);
  ok(n2 <= n && srcs2.every((s) => /^https:\/\/player\.bilibili\.com\//.test(s)),
    'A7b 注释重组 token → iframe 不放大且仅白名单 src', `iframes=${n2} srcs=${JSON.stringify(srcs2)}`);
}
{
  // 未闭合 / 自闭合 / 嵌套
  ok(!hasIFrame(sanitizedHTML('<p>x</p><iframe src="https://player.bilibili.com/a">')), 'A8 未闭合 iframe → 剥除');
  ok(!hasIFrame(sanitizedHTML('<iframe src="https://player.bilibili.com/a"/>')), 'A8 自闭合 iframe → 剥除');
  const nested = sanitizedHTML('<iframe src="https://player.bilibili.com/a"><iframe src="https://player.bilibili.com/b"></iframe></iframe>');
  ok(countIFrames(nested) <= 1, 'A8 嵌套 iframe 无放大', 'n=' + countIFrames(nested));
  const dbl = sanitizedHTML('<iframe src="https://player.bilibili.com/a"></iframe><iframe src="https://player.bilibili.com/b"></iframe>');
  ok(countIFrames(dbl) === 2, 'A8 双白名单 iframe 并列各存活一次', 'n=' + countIFrames(dbl));
}
{
  // src 属性二义性：data-x 内嵌 src= 在前 → 整体判非白名单（fail closed）
  ok(!hasIFrame(sanitizedHTML(`<iframe data-x="src=https://evil.com" src="https://player.bilibili.com/a"></iframe>`)), 'A9 属性二义性 → fail closed');
}
{
  // 属性外露引号逃逸尝试：src 带引号字符（attr 值内不可能，但测 escapeAttribute 兜底）
  const out = sanitizedHTML('<iframe src="https://player.bilibili.com/a?x=1&amp;y=2"></iframe>');
  ok(/&amp;y=2/.test(out) && countIFrames(out) === 1, 'A10 & 实体保真（查询串不破坏）', out.slice(0, 200));
}
{
  // 通用消毒回归：script/a[href]/img[onerror]
  ok(!/<script/i.test(sanitizedHTML('<p>a</p><script>alert(1)</script>')), 'A11 script 剥除');
  ok(!/javascript:/i.test(sanitizedHTML('<a href="javascript:alert(1)">x</a>')), 'A11 javascript: href 剥除');
  ok(!/onerror/i.test(sanitizedHTML('<img src="https://a.test/x.png" onerror="alert(1)">')), 'A11 onerror 剥除');
  ok(!/srcset.*javascript/i.test(sanitizedHTML('<img srcset="javascript:alert(1) 1x">')), 'A11 srcset 伪协议剥除');
}
{
  // 平台组装产物端到端：entryFromArchive 的 contentHTML 走消毒后 iframe 仍在、位于合法结构
  const entry = ADAPTERS.bilibili.entryFromArchive({ bvid: 'BV1ab411c001', title: '标题<svg onload=x>', pubdate: Math.floor(Date.now() / 1000), pic: 'https://i0.hdslb.com/c.jpg', description: '描述&<b>加粗</b>', length: '12:34' });
  const out = sanitizedHTML(entry.contentHTML);
  ok(countIFrames(out) === 1, 'A12 平台成品过消毒 iframe 存活', out.slice(0, 200));
  ok(!/<svg|onload/.test(out), 'A12 标题中的 svg/onload 不入正文');
  ok(plainText(entry.contentHTML).includes('描述'), 'A12 描述保留');
}
{
  // 大输入性能：50 个 iframe 混合白名单/恶意 + 大正文，应线性内完成
  const parts = [];
  for (let i = 0; i < 50; i += 1) {
    parts.push(i % 2
      ? '<iframe src="https://player.bilibili.com/player.html?bvid=BV1ok' + i + '"></iframe>'
      : '<iframe src="https://evil' + i + '.example.com/x"></iframe>');
    parts.push('<p>' + '内容填充'.repeat(200) + '</p>');
  }
  const t0 = Date.now();
  const out = sanitizedHTML(parts.join('\n'));
  const dt = Date.now() - t0;
  ok(countIFrames(out) === 25, 'A13 大输入 25/50 白名单存活', 'n=' + countIFrames(out));
  ok(dt < 3000, 'A13 大输入性能', dt + 'ms');
}

// ── B. 解析器鲁棒性 ──
{
  // extractJSONObjectAfter：字符串内花括号/转义/截断
  ok(extractJSONObjectAfter('x={"a":"}{","b":"esc\\"quote}{","c":1};(function()', 'x=').c === 1, 'B1 字符串内花括号/转义');
  ok(extractJSONObjectAfter('x={"a":"back\\\\","b":2}', 'x=').b === 2, 'B1 字符串内反斜杠收尾');
  ok(extractJSONObjectAfter('x={"a":1', 'x=') === null, 'B1 截断 JSON → null');
  ok(extractJSONObjectAfter('no marker here', 'x=') === null, 'B1 无 marker → null');
  ok(extractJSONObjectAfter('x=  {"a":1}', 'x=').a === 1, 'B1 marker 后空白');
  ok(extractJSONObjectAfter('x=[1,2]', 'x=') === null, 'B1 非对象开头 → null');
  // 双 __INITIAL_STATE__：取第一个
  ok(extractJSONObjectAfter('x={"n":1};x={"n":2}', 'x=').n === 1, 'B1 双 marker 取第一个');
}
{
  // B 站 parse：畸形输入
  const throwsOrEmpty = (html, label) => {
    try {
      const r = ADAPTERS.bilibili.parse(Buffer.from(html), '1001');
      ok(Array.isArray(r.entries) && r.entries.length === 0, 'B2 ' + label + ' → 空列表不崩', 'entries=' + r.entries.length);
    } catch (e) {
      ok(e instanceof PlatformError, 'B2 ' + label + ' → PlatformError 不崩', String(e.message).slice(0, 40));
    }
  };
  throwsOrEmpty('', 'B2 空 HTML');
  throwsOrEmpty('<html>仅文字</html>', 'B2 无状态页');
  throwsOrEmpty('<script>window.__INITIAL_STATE__={"upData":', 'B2 截断 JSON');
  throwsOrEmpty('<script>window.__INITIAL_STATE__=null;</script>', 'B2 null 状态');
  // 极深嵌套（JSON.parse 自身深度限制 → parse 捕获转 PlatformError）
  throwsOrEmpty('<script>window.__INITIAL_STATE__=' + '['.repeat(200000) + ']'.repeat(200000) + ';</script>', 'B2 20 万层嵌套');
  // 状态正常但无投稿
  {
    const r = ADAPTERS.bilibili.parse(Buffer.from('<script>window.__INITIAL_STATE__={"upData":{"name":"无名","mid":1001}};</script>'), '1001');
    ok(r.title === '无名' && r.entries.length === 0, 'B2 有 UP 无投稿 → 空列表', 'title=' + r.title);
  }
  // bvid 变体：小写 bv、非法 bvid、重复 BV 去重
  {
    const state = { lists: [
      { bvid: 'bv1lower123456', title: '小写', pubdate: Math.floor(Date.now() / 1000) },
      { bvid: 'BV1dup000001', title: '一', pubdate: 1 },
      { bvid: 'BV1dup000001', title: '二（重复）', pubdate: 2 },
      { bvid: 'XX1short', title: '非 BV 前缀', pubdate: 3 },
      { bvid: 'BV1ab', title: '过短', pubdate: 4 },
    ] };
    const r = ADAPTERS.bilibili.parse(Buffer.from('<script>window.__INITIAL_STATE__=' + JSON.stringify(state) + ';</script>'), '1001');
    ok(r.entries.length === 2, 'B3 bvid 校验+去重', 'n=' + r.entries.length);
  }
}
{
  // 微博 parse：畸形 mblog
  const mk = (cards) => Buffer.from(JSON.stringify({ ok: 1, data: { cards } }));
  // 缺 created_at
  {
    const r = ADAPTERS.weibo.parse(mk([{ card_type: 9, mblog: { id: 'w1', text: '没时间戳', user: { screen_name: 'u' } } }]), '2002');
    ok(r.entries.length === 1 && r.entries[0].publishedAt === null, 'B4 缺 created_at → publishedAt null 不崩');
  }
  // HTML 标签 + 长 emoji
  {
    const html = '正文<a href="https://x.test">链接</a><br>第二行' + '🎉'.repeat(300);
    const r = ADAPTERS.weibo.parse(mk([{ card_type: 9, mblog: { id: 'w2', text: html, user: { screen_name: 'u' } } }]), '2002');
    const e = r.entries[0];
    ok(!/<a|<br/i.test(e.contentHTML.replace(/<br>/g, '')) || !/<a /i.test(e.contentHTML), 'B4 微博 HTML 标签净化', e.contentHTML.slice(0, 80));
    ok(e.contentHTML.includes('🎉'.repeat(50).slice(0, 50)), 'B4 长 emoji 存活');
    ok(!/href="javascript/i.test(e.contentHTML), 'B4 无 javascript href');
  }
  // 被删微博形态（无 id 无 bid 无 mid）→ null 跳过
  {
    const r = ADAPTERS.weibo.parse(mk([{ card_type: 9, mblog: { text: '幽灵', user: { screen_name: 'u' } } }, { card_type: 9, mblog: { id: 'w3', text: '正常', user: { screen_name: 'u' } } }]), '2002');
    ok(r.entries.length === 1 && r.entries[0].id === 'weibo:w3', 'B4 无 id mblog → 跳过', 'n=' + r.entries.length);
  }
  // page_info javascript: page_url（对抗：适配器层直接拒绝非 http(s)——比消毒层兜底更早一步）
  {
    const r = ADAPTERS.weibo.parse(mk([{ card_type: 9, mblog: { id: 'w4', text: 't', user: { screen_name: 'u' }, page_info: { type: 'video', page_url: 'javascript:alert(1)' } } }]), '2002');
    ok(!/javascript:/i.test(r.entries[0].contentHTML), 'B4 javascript page_url 在适配器层即被拒（不发链接）');
    const rGood = ADAPTERS.weibo.parse(mk([{ card_type: 9, mblog: { id: 'w5', text: 't', user: { screen_name: 'u' }, page_info: { type: 'video', page_url: 'https://weibo.com/tv/v/x' } } }]), '2002');
    ok(/href="https:\/\/weibo\.com\/tv\/v\/x"/.test(rGood.entries[0].contentHTML), 'B4 合法 https page_url 正常发链接');
  }
  // 极深嵌套 cards
  {
    let deep = { card_type: 9, mblog: { id: 'wDeep', text: '深', user: { screen_name: 'u' } } };
    for (let i = 0; i < 100000; i += 1) deep = { cards: [deep] };
    try {
      const r = ADAPTERS.weibo.parse(Buffer.from(JSON.stringify({ ok: 1, data: { cards: [deep] } })), '2002');
      ok(r.entries.length <= 200, 'B4 深嵌套 cards 不崩', 'n=' + r.entries.length);
    } catch (e) {
      ok(e instanceof PlatformError || /call stack/i.test(String(e)), 'B4 深嵌套 → 明确错误不崩', String(e).slice(0, 60));
    }
  }
  // 风控/坏 JSON
  {
    const expectRisk = (buf, label) => {
      try { ADAPTERS.weibo.parse(buf, '2002'); ok(false, 'B5 ' + label + ' 应抛'); }
      catch (e) { ok(e instanceof PlatformError, 'B5 ' + label + ' → PlatformError', String(e.message).slice(0, 30)); }
    };
    expectRisk(Buffer.from(JSON.stringify({ ok: 0, message: '风控' })), 'ok=0');
    expectRisk(Buffer.from('{"bad json'), '坏 JSON');
    expectRisk(Buffer.from('{"ok":1,"data":{}}'), '缺 cards');
    expectRisk(Buffer.from('[1,2,3]'), '数组顶层');
  }
}
{
  // parseWeiboDate 各格式
  const now = Date.UTC(2024, 5, 20, 12, 0, 0); // 2024-06-20 12:00 UTC
  ok(parseWeiboDate('Wed Mar 13 12:30:00 +0800 2024') === Math.floor(Date.UTC(2024, 2, 13, 4, 30, 0) / 1000), 'B6 标准格式 +0800 → UTC 秒');
  ok(parseWeiboDate('刚刚', now) === Math.floor(now / 1000), 'B6 刚刚');
  ok(parseWeiboDate('5分钟前', now) === Math.floor((now - 300000) / 1000), 'B6 N分钟前');
  ok(parseWeiboDate('3小时前', now) === Math.floor((now - 10800000) / 1000), 'B6 N小时前');
  ok(Number.isFinite(parseWeiboDate('03-13')), 'B6 MM-DD 可解析');
  ok(parseWeiboDate('') === null && parseWeiboDate(null) === null && parseWeiboDate('垃圾文本!!') === null, 'B6 空/垃圾 → null');
  ok(parseWeiboDate('今天 08:30', Date.UTC(2024, 5, 20, 0, 30, 0)) === Math.floor(Date.UTC(2024, 5, 20, 0, 30, 0) / 1000), 'B6 今天 HH:mm（本地口径）');
}
{
  // parseDurationSeconds 复杂度/语义
  const { /* not exported; 经 entryFromArchive 间接验 */ } = {};
  const e1 = ADAPTERS.bilibili.entryFromArchive({ bvid: 'BV1dur00001', title: 't', length: '12:34' });
  const e2 = ADAPTERS.bilibili.entryFromArchive({ bvid: 'BV1dur00002', title: 't', duration: '1:02:03' });
  const e3 = ADAPTERS.bilibili.entryFromArchive({ bvid: 'BV1dur00003', title: 't', duration: 65 });
  const e4 = ADAPTERS.bilibili.entryFromArchive({ bvid: 'BV1dur00004', title: 't', length: 'abc' });
  ok(e1.enclosure.durationSeconds === 754, 'B7 MM:SS → 754');
  ok(e2.enclosure.durationSeconds === 3723, 'B7 HH:MM:SS → 3723');
  ok(e3.enclosure.durationSeconds === 65, 'B7 秒数');
  ok(e4.enclosure.durationSeconds === null, 'B7 非法 → null');
}
{
  // 深收集复杂度：大状态树（5000 节点）无 O(n²)
  const lists = [];
  for (let i = 0; i < 5000; i += 1) lists.push({ bvid: 'BV1big' + String(i).padStart(6, '0'), title: 'v' + i, pubdate: Math.floor(Date.now() / 1000) });
  const t0 = Date.now();
  const r = ADAPTERS.bilibili.parse(Buffer.from('<script>window.__INITIAL_STATE__=' + JSON.stringify({ lists }) + ';</script>'), '1001');
  const dt = Date.now() - t0;
  ok(r.entries.length === 30, 'B8 5000 投稿截断 30', 'n=' + r.entries.length);
  ok(dt < 2000, 'B8 大状态解析性能', dt + 'ms');
}

console.log(failed === 0 ? '\nPART1 ALL PASSED' : `\nPART1 FAILED ${failed}`);
process.exit(failed === 0 ? 0 : 1);
