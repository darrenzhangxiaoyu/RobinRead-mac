#!/usr/bin/env node
/* 从 npm cacache 手动恢复被失败的 npm install 拆空的包。
 * 用法: node scripts/restore-from-cacache.js <pkg1> <pkg2> ...
 * 版本取自 package-lock.json；缓存 blob 解压后 package/ 内容移入 node_modules/<name>。 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_cacache');

const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

function lockVersion(name) {
  const entry = lock.packages && lock.packages[`node_modules/${name}`];
  return entry ? entry.version : null;
}

// 1) 扫描 cacache 索引，收集 <name>@<version> -> { integrity }
const wanted = process.argv.slice(2);
if (!wanted.length) { console.error('no packages given'); process.exit(1); }
const indexHits = new Map(); // `${name}@${version}` -> integrity
function* walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
for (const file of walk(path.join(CACHE, 'index-v5'))) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
  for (const line of txt.split('\n')) {
    if (!line.includes('request-cache')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    const key = rec.key || '';
    const m = key.match(/^make-fetch-happen:request-cache:(https?:\/\/[^/]+)\/([^/]+)\/-\/([^/]+?)(-(\d+\.\d+\.\d+[^.]*)?)?\.tgz$/);
    if (!m) continue;
    const name = m[2];
    if (!wanted.includes(name)) continue;
    const version = rec.manifest && rec.manifest.version
      ? rec.manifest.version
      : (m[5] || null);
    if (!version) continue;
    const k = `${name}@${version}`;
    if (!indexHits.has(k)) indexHits.set(k, rec.integrity);
  }
}

// 2) 逐包恢复
let ok = 0;
const failures = [];
for (const name of wanted) {
  const ver = lockVersion(name);
  let integrity = ver ? indexHits.get(`${name}@${ver}`) : null;
  if (!integrity) {
    // 退而求其次：任意缓存版本
    for (const [k, v] of indexHits) {
      if (k.startsWith(`${name}@`)) { integrity = v; break; }
    }
  }
  if (!integrity) { failures.push(`${name}: not in cacache (lock=${ver})`); continue; }
  const hex = Buffer.from(integrity.slice(7), 'base64').toString('hex');
  const blob = path.join(CACHE, 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
  if (!fs.existsSync(blob)) { failures.push(`${name}: blob missing ${blob}`); continue; }
  const dest = path.join(ROOT, 'node_modules', name);
  const tmp = path.join(ROOT, 'node_modules', `.restore-${name}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', blob, '-C', tmp], { stdio: 'pipe' });
    const src = path.join(tmp, 'package');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(src, dest);
    ok++;
    console.log(`OK ${name}@${ver || '?'} -> node_modules/${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
console.log(`\nrestored=${ok}/${wanted.length}`);
if (failures.length) { for (const f of failures) console.log('FAIL ' + f); process.exit(2); }
