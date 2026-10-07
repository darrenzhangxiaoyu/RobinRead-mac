'use strict';
/**
 * Mail/sender.js — 邮件发件人规则的纯函数（主进程与 mail-worker 共用）。
 * 从 MailService 抽出：worker 不能反向 require MailService（会连带 AppStore）。
 */
const { MailError } = require('./ImapClient');
const { i18n } = require('../I18N');

/** mail://<accountId>/<sender> → { accountID, sender }；非法返回 null。 */
function parseMailFeedURL(feedURL) {
  const m = String(feedURL || '').match(/^mail:\/\/([^/\s]+)\/(.+)$/i);
  if (!m) return null;
  return { accountID: m[1], sender: decodeURIComponent(m[2]).toLowerCase() };
}

/** 白名单规则匹配：精确地址或 @domain 后缀（FROM 子串搜索的结果在此收口）。 */
function senderMatches(rule, address) {
  const value = String(address || '').trim().toLowerCase();
  if (!value) return false;
  if (rule.startsWith('@')) return value.endsWith(rule);
  return value === rule;
}

/** 发件人规则校验/归一：精确邮箱或 @domain。非法抛错（message 已本地化）。 */
function normalizeSender(input) {
  const value = String(input || '').trim().toLowerCase();
  if (!value) throw new MailError('protocol', i18n.localized('请输入发件人地址。'));
  const emailOK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  const domainOK = /^@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(value);
  if (!emailOK && !domainOK) {
    throw new MailError('protocol', i18n.localized('发件人格式不正确：请输入完整邮箱地址（name@example.com）或域名后缀（@example.com）。'));
  }
  return value;
}

module.exports = { parseMailFeedURL, senderMatches, normalizeSender };
