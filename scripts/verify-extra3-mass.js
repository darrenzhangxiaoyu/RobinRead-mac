'use strict';
/** 979 批量端到端验证：真实 GET + XML 判定（并发 12）；失败源做 URL 变体抢救一轮。 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const items = JSON.parse(fs.readFileSync('.tmp-extra3-urls.json', 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

function fetchUrl(url, timeoutMs = 14000) {
  return new Promise((resolve) => {
    execFile('curl', ['-sL', '--max-time', String(Math.round(timeoutMs / 1000)), '-A', UA, url, '--range', '0-262144'], { encoding: 'utf8', maxBuffer: 1 << 21, timeout: timeoutMs + 6000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}
const isFeed = (body) => /<rss[\s>]|<feed[\s>]|<\?xml|<rdf:RDF/.test(body) && /<(item|entry)[\s>]/.test(body);
const variantsFor = (url) => {
  const out = [];
  try {
    const u = new URL(url);
    if (u.protocol === 'http:') out.push(url.replace('http://', 'https://'));
    if (u.hostname.startsWith('www.')) out.push(url.replace('//www.', '//'));
    else out.push(url.replace('//', '//www.'));
    const base = url.replace(/\/+(index\.(xml|html)|feed(\.xml|\/)?|rss(\.xml)?|atom\.xml)?\/?$/i, '');
    for (const p of ['/feed', '/rss', '/atom.xml', '/rss.xml', '/feed.xml', '/index.xml']) out.push(base + p);
  } catch (_) { /* 原样 */ }
  return [...new Set(out)].filter((x) => x !== url);
};

async function pool(tasks, n) {
  const results = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const idx = i += 1;
      if (idx > tasks.length) return;
      results[idx - 1] = await tasks[idx - 1]();
    }
  }));
  return results;
}

(async () => {
  const t0 = Date.now();
  const verdicts = await pool(items.map((it) => async () => {
    let body = await fetchUrl(it.url);
    if (isFeed(body)) return { ...it, ok: true };
    for (const v of variantsFor(it.url)) {
      body = await fetchUrl(v);
      if (isFeed(body)) return { ...it, ok: true, rescuedUrl: v };
    }
    return { ...it, ok: false };
  }), 12);
  const ok = verdicts.filter((v) => v.ok);
  const rescued = ok.filter((v) => v.rescuedUrl);
  const bad = verdicts.filter((v) => !v.ok);
  fs.writeFileSync('.tmp-verify-verdicts.json', JSON.stringify(verdicts));
  console.log(`总计 ${verdicts.length} | 原样可用 ${ok.length - rescued.length} | 变体抢救 ${rescued.length} | 失败 ${bad.length} | 耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
  fs.writeFileSync('.tmp-verify-bad.json', JSON.stringify(bad.map((b) => ({ name: b.name, url: b.url })), null, 1));
  console.log('失败样例:', bad.slice(0, 8).map((b) => b.name).join(' / '));
})();
