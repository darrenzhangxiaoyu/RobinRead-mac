'use strict';
/**
 * RobinRead（知更）— 凭据存储
 *
 * Windows 上使用 Electron safeStorage（DPAPI）加密后落盘，
 * API Key 与 FreshRSS 密码只保存在本机，不参与任何云同步。
 */
const fs = require('node:fs');
const path = require('node:path');
const { safeStorage, app } = require('electron');

class CredentialStore {
  constructor() {
    this.directory = path.join(app.getPath('userData'), 'credentials');
    fs.mkdirSync(this.directory, { recursive: true });
  }

  _filePath(key) {
    const safe = String(key).replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(this.directory, `${safe}.bin`);
  }

  _write(key, plaintext) {
    const target = this._filePath(key);
    if (plaintext == null || plaintext === '') {
      try { fs.unlinkSync(target); } catch (_) { /* 不存在即可 */ }
      return;
    }
    const encrypted = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(String(plaintext))
      : Buffer.from(String(plaintext), 'utf8'); // 兜底（极少数旧系统无 DPAPI）
    fs.writeFileSync(target, encrypted);
  }

  _read(key) {
    try {
      const target = this._filePath(key);
      if (!fs.existsSync(target)) return null;
      const data = fs.readFileSync(target);
      if (!data.length) return null;
      if (safeStorage.isEncryptionAvailable()) {
        try {
          return safeStorage.decryptString(data);
        } catch (_) {
          // P2-3：解密失败不能把 DPAPI 密文当明文返回——调用方会拿密文当真实凭据去认证，
          // 制造难排查的「密码错误」。Windows DPAPI blob 固定以 0x01 版本字节开头；
          // 仅当首字节非 0x01（= 无 DPAPI 环境写入的明文兜底）才保留明文回退，
          // 真正解不开的密文一律返回 null（所有调用方均有 null → 凭据缺失的既有处理路径）。
          if (data[0] === 0x01) return null;
          return data.toString('utf8');
        }
      }
      return data.toString('utf8');
    } catch (_) {
      return null;
    }
  }

  aiAPIKey() {
    return this._read('ai-api-key') || '';
  }

  setAIAPIKey(value) {
    this._write('ai-api-key', value);
  }

  freshRSSPassword(accountID) {
    return this._read(`freshrss-password-${accountID}`);
  }

  setFreshRSSPassword(accountID, password) {
    this._write(`freshrss-password-${accountID}`, password);
  }

  deleteFreshRSSPassword(accountID) {
    this._write(`freshrss-password-${accountID}`, null);
  }

  /** Newsletter 收件（F6）：IMAP 邮箱密码，同样 DPAPI 落盘、mail_accounts 只存 key 引用。 */
  mailPassword(accountID) {
    return this._read(`mail-password-${accountID}`);
  }

  setMailPassword(accountID, password) {
    this._write(`mail-password-${accountID}`, password);
  }

  deleteMailPassword(accountID) {
    this._write(`mail-password-${accountID}`, null);
  }

  /** WebDAV 多设备同步（F7）：应用专用密码，DPAPI 落盘，不落库不进快照。 */
  webDAVPassword() {
    return this._read('webdav-password');
  }

  setWebDAVPassword(password) {
    this._write('webdav-password', password);
  }

  deleteWebDAVPassword() {
    this._write('webdav-password', null);
  }

  /** 账号登录 JWT（会员服务），同样只存本机。 */
  authToken() {
    return this._read('auth-token') || '';
  }

  setAuthToken(value) {
    this._write('auth-token', value);
  }
}

module.exports = { CredentialStore };
