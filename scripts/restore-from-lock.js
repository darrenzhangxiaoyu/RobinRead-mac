#!/usr/bin/env node
/* 按 package-lock.json 全树恢复 node_modules：枚举 lock.packages 每个条目，
 * 磁盘缺 package.json 的路径直接从 resolved URL 拉取解入（含嵌套 node_modules/a/node_modules/b）。
 * electron 条目跳过（本机为手动恢复的 electron37 侧目录 + wrapper）。
 * 用法: node scripts/restore-from-lock.js */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

const SKIP = new Set(['node_modules/electron']);
let ok = 0, skip = 0, present = 0;
const failures = [];

for (const [key, entry] of Object.entries(lock.packages)) {
  if (!key || key === '') continue;                    // 根
  if (!key.startsWith('node_modules/')) continue;      // workspace/其他
  if (SKIP.has(key)) { skip++; continue; }
  const dest = path.join(ROOT, key);
  if (fs.existsSync(path.join(dest, 'package.json'))) { present++; continue; }
  const tmp = path.join(ROOT, 'node_modules', `.restore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const tgz = path.join(tmp, 'pkg.tgz');
    execFileSync('curl', ['-fsSL', '--retry', '2', '-o', tgz, entry.resolved], { stdio: 'pipe', timeout: 120000 });
    const unpack = path.join(tmp, 'un');
    fs.mkdirSync(unpack);
    execFileSync('tar', ['--force-local', '-xzf', tgz.replace(/\\/g, '/'), '-C', unpack.replace(/\\/g, '/')], { stdio: 'pipe' });
    const entries = fs.readdirSync(unpack);
    const src = path.join(unpack, entries.find((e) => fs.existsSync(path.join(unpack, e, 'package.json'))) || 'package');
    if (!fs.existsSync(path.join(src, 'package.json'))) throw new Error('no package.json in tarball');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    ok++;
    console.log(`OK ${key}@${entry.version}`);
  } catch (err) {
    failures.push(`${key}: ${String(err.message || err).slice(0, 160)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\npresent=${present} restored=${ok} skipped=${skip}`);
if (failures.length) { for (const f of failures) console.log('FAIL ' + f); process.exit(2); }
console.log('LOCK TREE COMPLETE');
