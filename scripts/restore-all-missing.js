#!/usr/bin/env node
/* 迭代恢复 node_modules：扫描所有在册包的 dependencies，找出顶层缺失的包，
 * 按 package-lock 精确版本经 registry 恢复，循环直到无缺失。
 * 用法: node scripts/restore-all-missing.js */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

function scanMissing() {
  const pkgs = [];
  (function scan(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.name.startsWith('@')) { scan(p); continue; }
      const pj = path.join(p, 'package.json');
      if (fs.existsSync(pj)) pkgs.push(pj);
    }
  })('node_modules');
  const missing = new Set();
  for (const pj of pkgs) {
    let m;
    try { m = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch (_) { continue; }
    for (const d of Object.keys(m.dependencies || {})) {
      if (!fs.existsSync(path.join('node_modules', d, 'package.json'))) missing.add(d);
    }
  }
  return [...missing].sort();
}

let round = 0;
for (;;) {
  round++;
  const missing = scanMissing();
  if (!missing.length) { console.log(`round ${round}: ALL DEPS PRESENT`); break; }
  console.log(`round ${round}: restoring ${missing.length} missing -> ${missing.join(', ')}`);
  try {
    execFileSync('node', ['scripts/restore-from-registry.js', ...missing], { stdio: 'inherit' });
  } catch (_) { /* restore 脚本失败也会打印明细，继续下一轮扫描看剩余 */ }
  if (round > 12) { console.log('round limit hit'); process.exit(2); }
}
