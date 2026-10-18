'use strict';
/**
 * UpdaterService.js — 应用内在线更新（下载安装包 → 完整性校验 → 静默安装 → 重启）
 *
 * 流程：检查更新（UpdateCheckService 双源）→ 拿 GitHub release 的平台安装包资产直链
 *      → net.fetch 流式下载到 userData/updates/（进度经 onProgress 回调推送渲染层）
 *      → release 提供 sha256 时做完整性校验（不匹配即删包拒绝安装；缺失时日志标注后放行）
 *      → 渲染层确认后 install()：
 *          Windows：以 /S 静默重装到当前安装目录 → 应用退出，安装器接管；
 *          macOS：挂载 dmg / 打开 zip（zip 便携版降级为打开所在目录或 Release 页）。
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const UPDATE_DIR_NAME = 'updates';

/** 从任意写法（"abc..." / "sha256:abc..."）里取 64 位十六进制摘要；无效返回 null。 */
function normalizeSHA256(value) {
  const match = String(value || '').match(/[0-9a-fA-F]{64}/);
  return match ? match[0].toLowerCase() : null;
}

/** 流式计算文件 sha256（安装包可达上百 MB，避免整读进内存）。 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

class UpdaterService {
  constructor(userDataDir) {
    this.updateDir = path.join(userDataDir, UPDATE_DIR_NAME);
    this.downloading = false;
    this.file = null;
    this.cancelled = false;
    // 取消所需的在途资源句柄（download 开始时登记，结束时清空）
    this._abort = null;   // AbortController：中止 fetch 请求体
    this._writer = null;  // fs.WriteStream：销毁即停止落盘
    this._body = null;    // Node 流形态的响应体
    this._reader = null;  // Web ReadableStream 形态的响应体
  }

  /**
   * 当前平台的安装包资产匹配器。
   * Windows：NSIS setup.exe；macOS：优先 dmg（可挂载安装），其次 zip。
   */
  platformAssetPattern() {
    if (process.platform === 'darwin') return /\.(dmg|zip)$/i;
    return /-setup\.exe$/i;
  }

  /** 从 release 信息里解析当前平台安装包直链（GitHub assets；官网源无 assets → null）。 */
  resolveSetupAssetURL(release) {
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const pattern = this.platformAssetPattern();
    // macOS 优先 dmg
    const preferred = process.platform === 'darwin'
      ? (assets.find((a) => /\.dmg$/i.test(a.name || '')) || null)
      : null;
    const setup = preferred
      || assets.find((a) => pattern.test(a.name || ''))
      || null;
    return setup ? (setup.browser_download_url || setup.url || null) : null;
  }

  /**
   * 解析安装包的预期 sha256（P0-1 完整性校验用）。
   * 查找顺序：asset 级（sha256 / digest.sha256 / digest 字符串）→
   * release 级按文件名映射（sha256_map / sha256ByFile / sha256s / checksums.sha256）→
   * release 级单值（sha256）。都没有返回 null（调用方在日志标注后退回不校验）。
   */
  resolveSetupAssetSHA256(release, assetName) {
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const wanted = String(assetName || '').toLowerCase();
    const asset = assets.find((a) => String(a.name || '').toLowerCase() === wanted && wanted)
      || assets.find((a) => this.platformAssetPattern().test(a.name || '')) || null;
    const fromAsset = normalizeSHA256(asset?.sha256)
      || normalizeSHA256(asset?.digest?.sha256)
      || normalizeSHA256(asset?.digest_sha256)
      || (typeof asset?.digest === 'string' ? normalizeSHA256(asset.digest) : null);
    if (fromAsset) return fromAsset;
    const mapSources = [release?.sha256_map, release?.sha256ByFile, release?.sha256s, release?.checksums?.sha256];
    for (const map of mapSources) {
      if (!map || typeof map !== 'object') continue;
      for (const [name, hash] of Object.entries(map)) {
        if (String(name).toLowerCase() === wanted && wanted) return normalizeSHA256(hash);
      }
    }
    return normalizeSHA256(release?.sha256);
  }

  /**
   * 下载安装包。onProgress({ received, total, percent }) 节流回调；返回 { file, bytes, sha256Verified }。
   * fetchImpl 由 main.js 注入（net.fetch 走系统代理）。
   * expectedSHA256 非空时下载完成后逐块校验，不匹配 → 删除文件并抛错（拒绝进入 install）。
   */
  async download(assetURL, expectedName, onProgress, fetchImpl, expectedSHA256 = null) {
    if (this.downloading) throw new Error('已有下载任务进行中');
    this.downloading = true;
    this.cancelled = false;
    this._abort = new AbortController();
    let out = null;
    try {
      const doFetch = fetchImpl || fetch;
      const response = await doFetch(assetURL, {
        headers: { 'User-Agent': 'RobinRead' },
        signal: this._abort.signal,
      });
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
      const total = Number(response.headers.get('content-length')) || 0;
      fs.mkdirSync(this.updateDir, { recursive: true });
      const safeName = String(expectedName || 'update').replace(/[^\w.-]/g, '_');
      this.file = path.join(this.updateDir, safeName);
      out = fs.createWriteStream(this.file);
      this._writer = out;
      this._body = response.body && response.body.pipe ? response.body : null;
      let received = 0;
      let lastEmit = 0;
      const emit = () => {
        const now = Date.now();
        if (now - lastEmit < 300 && !(total && received >= total)) return;
        lastEmit = now;
        try { onProgress?.({ received, total, percent: total ? Math.min(100, Math.round((received / total) * 100)) : 0 }); } catch (_) { /* 忽略 */ }
      };
      const write = (buf) => { out.write(buf); received += buf.length; emit(); };
      const pump = response.body && response.body.pipe ? response.body : null;
      await new Promise((resolve, reject) => {
        if (pump) {
          pump.on('data', write);
          pump.on('error', reject);
          out.on('error', reject);
          pump.on('end', resolve);
          // cancel() 销毁读流时不一定走 error：close 兜底收尾（正常 end 后也会触发，幂等）
          pump.on('close', () => { if (this.cancelled) reject(new Error('下载已取消')); else resolve(); });
        } else {
          // Web 流回退（fetch polyfill）
          (async () => {
            const reader = response.body.getReader();
            this._reader = reader;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              write(Buffer.from(value));
            }
            resolve();
          })().catch(reject);
        }
      });
      // writer 已被 cancel 销毁时 end 回调不会触发：同时监听 close 收尾
      await new Promise((resolve) => {
        if (out.destroyed) return resolve();
        out.once('close', resolve);
        out.end(resolve);
      });
      if (this.cancelled) throw new Error('下载已取消');
      // P0-1 完整性校验：sha256 不匹配 → 删包拒绝（杜绝被篡改/截断的安装包静默执行）
      const expected = normalizeSHA256(expectedSHA256);
      if (expected) {
        const actual = await sha256File(this.file);
        if (actual !== expected) {
          await this._discardPartial(out);
          throw new Error('安装包完整性校验失败（sha256 不匹配），已删除下载文件');
        }
        console.log('[updater] 安装包 sha256 校验通过');
      } else {
        console.warn('[updater] 更新源未提供 sha256，本次安装包跳过完整性校验');
      }
      return { file: this.file, bytes: received, sha256Verified: Boolean(expected) };
    } catch (err) {
      await this._discardPartial(out);
      if (this.cancelled) throw new Error('下载已取消');
      throw err;
    } finally {
      this.downloading = false;
      this.cancelled = false;
      this._abort = null;
      this._writer = null;
      this._body = null;
      this._reader = null;
    }
  }

  /** 删除半成品安装包（取消/校验失败/下载异常路径共用；销毁写流后尽力删除）。 */
  async _discardPartial(out) {
    if (out) { try { out.destroy(); } catch (_) { /* 已销毁 */ } }
    if (!this.file) return;
    const target = this.file;
    await new Promise((resolve) => setTimeout(resolve, 50)); // Windows 句柄异步释放
    try { fs.rmSync(target, { force: true }); } catch (_) { /* 下次同名下载会覆盖 */ }
    if (this.file === target) this.file = null;
  }

  /**
   * 取消下载（P2-8：原先 cancelled 是死代码）。中止在途 fetch、销毁读写流并置标志，
   * download() 随即以「下载已取消」收尾并清理半成品文件。
   */
  cancel() {
    if (!this.downloading) return false;
    this.cancelled = true;
    try { this._abort?.abort(); } catch (_) { /* 已中止 */ }
    try { this._body?.destroy?.(); } catch (_) { /* 已销毁 */ }
    try { const r = this._reader?.cancel?.(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (_) { /* 已取消 */ }
    try { this._writer?.destroy?.(); } catch (_) { /* 已销毁 */ }
    return true;
  }

  /**
   * 安装更新。Windows：NSIS /S 静默重装到当前安装目录后退出应用。
   * macOS：挂载下载的 dmg（zip 则直接打开所在目录），用户拖入 Applications 后自行重启。
   */
  install() {
    if (!this.file || !fs.existsSync(this.file)) throw new Error('安装包不存在，请先下载');
    if (process.platform === 'darwin') {
      const { shell } = require('electron');
      // dmg 直接挂载安装器；zip 打开访达让用户解压替换
      shell.openPath(this.file).catch(() => {});
      setTimeout(() => { try { require('electron').app.quit(); } catch (_) { process.exit(0); } }, 1500);
      return { launched: true, installDir: null };
    }
    const installDir = path.dirname(process.execPath); // 安装版 exe 所在目录
    const child = spawn(this.file, ['/S', `/D=${installDir}`], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => { try { require('electron').app.quit(); } catch (_) { process.exit(0); } }, 1200);
    return { launched: true, installDir };
  }
}

module.exports = { UpdaterService };
