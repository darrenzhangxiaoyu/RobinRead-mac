#!/usr/bin/env node
/* 从 registry 按 package-lock 精确版本拉取 tarball 并解入 node_modules/<name>。
 * 用法: node scripts/restore-from-registry.js <pkg1> <pkg2> ...
 * npm pack 单包操作，不 reify node_modules，绕开 electron EBUSY 锁。 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

function lockInfo(name) {
  const entry = lock.packages && lock.packages[`node_modules/${name}`];
  if (!entry) return null;
  return { version: entry.version, resolved: entry.resolved };
}

let ok = 0;
const failures = [];
for (const name of process.argv.slice(2)) {
  const info = lockInfo(name);
  if (!info) { failures.push(`${name}: not in package-lock`); continue; }
  const spec = info.resolved || `${name}@${info.version}`;
  const tmp = path.join(ROOT, 'node_modules', `.restore-${name.replace(/[^\w.@-]/g, '_')}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    let tgz;
    if (info.resolved) {
      tgz = path.join(tmp, 'pkg.tgz');
      execFileSync('curl', ['-fsSL', '--retry', '2', '-o', tgz, info.resolved], { stdio: 'pipe', timeout: 120000 });
    } else {
      const out = execFileSync('npm', ['pack', spec, '--pack-destination', tmp], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000, shell: true }).toString().trim();
      tgz = path.join(tmp, out.split('\n').pop().trim());
    }
    const unpack = path.join(tmp, 'un');
    fs.mkdirSync(unpack);
    const tgzPosix = tgz.replace(/\\/g, '/');
    const unpackPosix = unpack.replace(/\\/g, '/');
    execFileSync('tar', ['--force-local', '-xzf', tgzPosix, '-C', unpackPosix], { stdio: 'pipe' });
    const entries = fs.readdirSync(unpack);
    const src = path.join(unpack, entries.find((e) => fs.existsSync(path.join(unpack, e, 'package.json'))) || 'package');
    if (!fs.existsSync(path.join(src, 'package.json'))) throw new Error('no package.json in tarball');
    const dest = path.join(ROOT, 'node_modules', name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    ok++;
    console.log(`OK ${name}@${info.version}`);
  } catch (err) {
    failures.push(`${name}: ${String(err.message || err).slice(0, 200)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
console.log(`\nrestored=${ok}/${process.argv.length - 2}`);
if (failures.length) { for (const f of failures) console.log('FAIL ' + f); process.exit(2); }
