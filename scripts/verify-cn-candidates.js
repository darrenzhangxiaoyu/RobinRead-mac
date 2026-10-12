'use strict';
/** 中文高质量订阅源候选 · 批量可达性/活性验证（curl 拉取 + XML 判定 + 最新日期） */
const { execFileSync } = require('node:child_process');

const CANDIDATES = [
  // ── AI / 科技媒体 ──
  { name: '机器之心', cat: 'ai', url: 'https://www.jiqizhixin.com/rss', desc: 'AI 学术与产业并重的老牌媒体：论文解读、大厂动态', tags: ['AI', '媒体'] },
  { name: '量子位', cat: 'ai', url: 'https://www.qbitai.com/feed', desc: 'AI 产业媒体：大模型动态、行业落地跟踪最快的一批', tags: ['AI', '媒体'] },
  { name: '雷峰网', cat: 'ai', url: 'https://www.leiphone.com/feed', desc: '老牌科技媒体：AI、出行与产业报道', tags: ['AI', '媒体'] },
  // ── 科技/商业媒体 ──
  { name: '虎嗅', cat: 'cn', url: 'https://www.huxiu.com/rss/0.xml', desc: '商业科技深度报道与专栏', tags: ['商业', '媒体'] },
  { name: '品玩', cat: 'cn', url: 'https://www.pingwest.com/feed', desc: '科技创新与公司报道', tags: ['商业', '媒体'] },
  { name: '钛媒体', cat: 'cn', url: 'https://www.tmtpost.com/feed', desc: 'TMT 产业财经媒体', tags: ['商业', '媒体'] },
  { name: '42号车库', cat: 'cn', url: 'https://42how.com/feed.xml', desc: '产品与商业的深度拆解（车、AI、消费）', tags: ['产品', '商业'] },
  // ── 技术社区/团队 ──
  { name: 'V2EX', cat: 'cn', url: 'https://www.v2ex.com/index.xml', desc: '创意工作者社区：技术讨论热帖聚合', tags: ['社区', '聚合'] },
  { name: '开源中国', cat: 'cn', url: 'https://www.oschina.net/news/rss', desc: '开源软件资讯与版本动态', tags: ['开源', '资讯'] },
  { name: '博客园', cat: 'cn', url: 'https://feed.cnblogs.com/blog/sitehome/rss', desc: '.NET 与后端技术博客聚合（质量参差，可配合过滤规则）', tags: ['聚合', '编程'] },
  { name: 'vivo 互联网技术', cat: 'eng', url: 'https://www.vivotech.com.cn/rss', desc: 'vivo 互联网技术团队官方博客', tags: ['工程', '团队'] },
  { name: '有赞技术团队', cat: 'eng', url: 'https://tech.youzan.com/atom.xml', desc: '有赞技术团队：电商系统的工程实践', tags: ['工程', '团队'] },
  { name: '并发编程网', cat: 'eng', url: 'http://ifeve.com/feed/', desc: '并发编程与 JVM 深度翻译与实践', tags: ['工程', '并发'] },
  // ── 独立博客（活跃中文）──
  { name: 'Manjusaka', cat: 'guru', url: 'https://www.manjusaka.blog/feeds/rss/', desc: '安全与后端工程的长文写作者', tags: ['编程', '安全'] },
  { name: 'Tony Bai', cat: 'lang', url: 'https://tonybai.com/feed/', desc: 'Go 语言三十年老兵：Go 演进与工程实践评注', tags: ['Go', '编程'] },
  { name: '煎鱼', cat: 'lang', url: 'https://eddycjy.com/atom.xml', desc: 'Go 语言生态：源码剖析与社区动态', tags: ['Go', '编程'] },
  { name: '知道创宇', cat: 'sec', url: 'https://blog.knownsec.com/feed/', desc: '知道创宇安全研究博客（ZoomEye 团队）', tags: ['安全'] },
  { name: '白宦成', cat: 'cn', url: 'https://www.ixyzero.com/blog/feed/', desc: '独立开发者：PHP/工程效率与个人成长', tags: ['编程', '独立开发'] },
  // ── 产品 / 设计 ──
  { name: '人人都是产品经理', cat: 'method', url: 'https://www.woshipm.com/feed', desc: '产品经理社区聚合：方法论、案例分析、行业观察', tags: ['产品', '方法论'] },
  { name: '优设', cat: 'method', url: 'https://www.uisdc.com/feed', desc: '设计师垂直媒体：UI/UX 教程与行业观察', tags: ['设计', '教程'] },
  // ── 中文播客（native RSS，联动媒体中心）──
  { name: '内核恐慌 Kernel Panic', cat: 'podcast', url: 'https://kernelpanic.fm/feed', desc: 'IPN 出品：软件工程与科技行业的轻松深聊', tags: ['播客', '科技'] },
  { name: '硅谷101', cat: 'podcast', url: 'https://sv101.typlog.io/feed.xml', desc: '分享全球科技、创投与商业模式的前沿趋势', tags: ['播客', '硅谷'] },
  { name: '疯投圈', cat: 'podcast', url: 'https://crazy.capital/feed/', desc: '风险投资与创业的中文播客', tags: ['播客', '创投'] },
  { name: '声动早咖啡', cat: 'podcast', url: 'https://shengfm.typlog.io/feed.xml', desc: '声动活泼：每天 15 分钟听懂全球商业', tags: ['播客', '商业'] },
  { name: 'What\'s Next｜科技早知道', cat: 'podcast', url: 'https://guiguzaojiao.com/feed/', desc: '硅谷与中国的科技趋势对话', tags: ['播客', '科技'] },
  // ── 备选（主 URL 失败时的替代，验证脚本按 urlTry 顺序尝试）──
  { name: '少数派（首页模板）', cat: 'cn', urlTry: ['https://sspai.com/api/v1/index?free=1&offset=0&limit=10'], skip: true, desc: '备用', tags: [] },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
function fetchHead(url) {
  try {
    const out = execFileSync('curl', ['-sL', '--max-time', '14', '-A', UA, '-H', 'Accept: application/rss+xml, application/atom+xml, application/xml, text/xml, */*', url, '--range', '0-131071'], { encoding: 'utf8', maxBuffer: 1 << 21, timeout: 20000 });
    return out;
  } catch (e) { return ''; }
}
function xmlDate(body) {
  const m = body.match(/<(?:pubDate|updated|published|dc:date)[^>]*>([^<]{10,40})</);
  return m ? m[1].trim() : null;
}
const results = [];
for (const c of CANDIDATES) {
  const urls = c.urlTry || [c.url];
  let hit = null;
  for (const u of urls) {
    const body = fetchHead(u);
    const isXml = /<rss[\s>]|<feed[\s>]|<\?xml/.test(body);
    const items = (body.match(/<item[\s>]|<entry[\s>]/g) || []).length;
    if (isXml && items > 0) { hit = { url: u, items, date: xmlDate(body), bytes: body.length }; break; }
    if (!hit) hit = { url: u, fail: isXml ? 'no-items' : 'not-xml', bytes: body.length };
  }
  results.push({ name: c.name, cat: c.cat, ...hit, desc: c.desc, tags: c.tags });
  console.log(`${hit.items ? 'OK ' : 'NO '} ${c.name} — ${hit.url} (${hit.fail || hit.items + ' items, ' + (hit.date || '?')})`);
}
require('node:fs').writeFileSync('/tmp/candidates-verified.json', JSON.stringify(results, null, 1));
console.log(`DONE ${results.filter((r) => r.items).length}/${results.length} verified`);
