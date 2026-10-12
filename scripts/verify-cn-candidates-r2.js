'use strict';
/** 第二轮：备选 URL + 扩充候选 */
const { execFileSync } = require('node:child_process');
const CANDIDATES = [
  { name: '机器之心（suzu 备选）', cat: 'ai', urlTry: ['https://www.jiqizhixin.com/rss', 'https://rss.jiqizhixin.com/rss'] },
  { name: 'V2EX（trojan 备选）', cat: 'cn', urlTry: ['https://www.v2ex.com/feed', 'https://v2ex.com/index.xml', 'https://www.v2ex.com/rss'] },
  { name: '虎嗅（备选）', cat: 'cn', urlTry: ['https://www.huxiu.com/rss/0.xml', 'https://rss.huxiu.com/'] },
  { name: '内核恐慌（ipn.li 官方）', cat: 'podcast', urlTry: ['https://ipn.li/kernelpanic/feed'] },
  { name: '硅谷101（备选）', cat: 'podcast', urlTry: ['https://sv101.typlog.io/feed', 'https://www.sv101.co/feed'] },
  { name: '声动早咖啡（备选）', cat: 'podcast', urlTry: ['https://shengfm.typlog.io/feed', 'https://shengfm.cn/feed'] },
  { name: 'Manjusaka（备选）', cat: 'guru', urlTry: ['https://www.manjusaka.blog/atom.xml', 'https://manjusaka.blog/feeds/rss/'] },
  { name: 'Tony Bai（www 备选）', cat: 'lang', urlTry: ['https://www.tonybai.com/feed/', 'https://tonybai.com/index.xml'] },
  { name: '煎鱼（index.xml 备选）', cat: 'lang', urlTry: ['https://eddycjy.com/index.xml', 'https://eddycjy.com/feed/'] },
  { name: '知道创宇（http 备选）', cat: 'sec', urlTry: ['https://blog.knownsec.com/feed', 'http://blog.knownsec.com/feed/'] },
  { name: '白宦成（feed 备选）', cat: 'cn', urlTry: ['https://www.ixyzero.com/blog/feed', 'https://ixyzero.com/blog/feed/'] },
  { name: '云谦 sorrycc', cat: 'fe', urlTry: ['https://sorrycc.com/feed', 'https://sorrycc.com/rss.xml'] },
  { name: '图拉鼎', cat: 'guru', urlTry: ['https://blog.tualatrix.com/feed', 'http://blog.tualatrix.com/feed'] },
  { name: '独立开发变现周刊', cat: 'cn', urlTry: ['https://www.ezindie.com/feed', 'https://www.ezindie.com/rss.xml'] },
  { name: '欧雷阁', cat: 'fe', urlTry: ['https://ourai.ws/rss/', 'https://ourai.ws/feed'] },
  { name: '腾讯 ISUX', cat: 'fe', urlTry: ['https://isux.tencent.com/feed', 'https://isux.tencent.com/rss'] },
  { name: '腾讯 CDC', cat: 'fe', urlTry: ['https://cdc.tencent.com/feed/', 'https://cdc.tencent.com/?feed=rss2'] },
  { name: '安全客', cat: 'sec', urlTry: ['https://www.anquanke.com/rss', 'https://api.anquanke.com/data/v1/rss'] },
  { name: 'FreeBuf', cat: 'sec', urlTry: ['https://www.freebuf.com/feed', 'https://www.freebuf.com/rss'] },
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
function fetchHead(url) {
  try { return execFileSync('curl', ['-sL', '--max-time', '14', '-A', UA, url, '--range', '0-131071'], { encoding: 'utf8', maxBuffer: 1 << 21, timeout: 20000 }); }
  catch (e) { return ''; }
}
function xmlDate(body) { const m = body.match(/<(?:pubDate|updated|published|dc:date)[^>]*>([^<]{10,40})</); return m ? m[1].trim() : null; }
let okCount = 0;
for (const c of CANDIDATES) {
  let hit = null;
  for (const u of c.urlTry) {
    const body = fetchHead(u);
    const isXml = /<rss[\s>]|<feed[\s>]|<\?xml/.test(body);
    const items = (body.match(/<item[\s>]|<entry[\s>]/g) || []).length;
    if (isXml && items > 0) { hit = { url: u, items, date: xmlDate(body) }; break; }
    if (!hit) hit = { url: u, fail: isXml ? 'no-items' : 'not-xml' };
  }
  if (hit.items) okCount += 1;
  console.log(`${hit.items ? 'OK ' : 'NO '} ${c.name} — ${hit.url}${hit.items ? ` (${hit.items} items, ${hit.date || '?'})` : ` (${hit.fail})`}`);
}
console.log(`DONE ${okCount}/${CANDIDATES.length}`);
