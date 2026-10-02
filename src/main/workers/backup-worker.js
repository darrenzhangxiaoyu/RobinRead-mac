'use strict';
/**
 * backup-worker.js — utilityProcess 备份工作进程（单发单收，任务完即退）
 *
 * 职责：把「VACUUM INTO 快照 → base64 → 组装 JSON 落盘」整条重管线搬出主进程。
 * 此前主进程内执行：560MB 库的 VACUUM INTO 同步跑数分钟 + readFileSync 整读进堆 +
 * base64/Stringify 双份 ~1.4GB 峰值内存——启动 20 秒后整窗冻结甚至 OOM 崩溃
 * （连续 6 天备份失败即此因，进程被杀时 finally 清不了 .tmp.db 垃圾）。
 *
 * 运行环境约束（Electron utilityProcess，与 extractor-worker 相同）：
 *   - 只能 require Node 内置模块；不能 require('electron')
 *   - process.parentPort 收发消息（结构化克隆）
 *
 * 协议：
 *   收 { type: 'backup', id, sourcePath, tmpPath, outPath, version, exportedAt, preferencesJSON }
 *   回 { type: 'result', id, ok: true, bytes }
 *   回 { type: 'result', id, ok: false, error }
 *   回 { type: 'fatal',  error }
 *
 * 实现要点：
 *   - VACUUM INTO 允许只读连接执行（官方语义：只写目标文件）——worker 以 readOnly
 *     打开源库，与主进程 WAL 并发安全，主进程零阻塞
 *   - base64 流式：readStream highWaterMark 取 3MB（3 字节对齐，块间无填充错位），
 *     JSON 头尾分片写入——全程内存占用 ≈ 单个 chunk，不再出现 GB 级字符串
 */

if (!process.parentPort) {
  console.error('[backup-worker] must be started via utilityProcess.fork (process.parentPort missing)');
  process.exit(1);
}

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

process.parentPort.on('message', (event) => {
  const message = event && event.data;
  if (!message || message.type !== 'backup' || typeof message.id !== 'number') return;
  Promise.resolve()
    .then(() => runBackup(message))
    .then(
      (bytes) => postSafe({ type: 'result', id: message.id, ok: true, bytes }),
      (error) => postSafe({ type: 'result', id: message.id, ok: false, error: String((error && error.message) || error) }),
    );
});

function runBackup(message) {
  const { sourcePath, tmpPath, outPath, version, exportedAt, preferencesJSON } = message;
  return new Promise((resolve, reject) => {
    try { fs.rmSync(tmpPath, { force: true }); } catch (_) { /* 目标不存在 */ }
    let db;
    try {
      // 只读连接：不碰 WAL/锁竞争，VACUUM INTO 只写目标快照文件
      db = new DatabaseSync(sourcePath, { readOnly: true });
      const escaped = String(tmpPath).replace(/'/g, "''");
      db.exec(`VACUUM INTO '${escaped}'`);
    } catch (err) {
      try { db && db.close(); } catch (_) { /* 尽力而为 */ }
      return reject(err);
    } finally {
      try { db && db.close(); } catch (_) { /* 尽力而为 */ }
    }

    const header = `{"version":${JSON.stringify(String(version || ''))},`
      + `"exportedAt":${JSON.stringify(String(exportedAt || ''))},"dbBase64":"`;
    const footer = `","preferences":${preferencesJSON || '{}'}}`;
    const read = fs.createReadStream(tmpPath, { highWaterMark: 3 * 1024 * 1024 });
    const write = fs.createWriteStream(outPath, { encoding: 'utf8' });
    let bytes = 0;
    const fail = (err) => {
      try { read.destroy(); } catch (_) { /* 已销毁 */ }
      try { write.destroy(); } catch (_) { /* 已销毁 */ }
      reject(err);
    };
    read.on('error', fail);
    write.on('error', fail);
    write.on('finish', () => resolve(bytes));
    write.write(header);
    read.on('data', (chunk) => {
      bytes += chunk.length;
      write.write(chunk.toString('base64'));
    });
    read.on('end', () => write.end(footer));
  });
}

process.on('uncaughtException', (error) => {
  postSafe({ type: 'fatal', error: String((error && error.message) || error) });
  try { process.exit(1); } catch (_) { /* 尽力而为 */ }
});

function postSafe(message) {
  try { process.parentPort.postMessage(message); } catch (_) { /* 进程正在退出 */ }
}
