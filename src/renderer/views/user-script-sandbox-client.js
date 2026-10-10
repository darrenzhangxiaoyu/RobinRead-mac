'use strict';
/**
 * user-script-sandbox-client.js — 沙箱桥（F32，主页面侧）
 *
 * 应用主页面 CSP 是 script-src 'self'（无 unsafe-eval，红线不放松）——用户脚本
 * 的 new Function 只能在专用宿主帧（user-script-sandbox-frame.html，唯一 CSP
 * 允许 eval 的文档）里求值。本模块惰性创建隐藏 iframe + postMessage 往返：
 *
 * - 惰性单帧：首次调用才挂帧（无脚本的文章零成本，连帧都不建）；
 * - nonce 配对 + 超时降级：帧无响应（脚本死循环只挂起帧本身）→ 恒等返回
 *   零脚本结果并**重建帧**（下次调用拿全新帧，长文管线不残废）；
 * - 全部降级路径零脚本语义：body 原样、actions 空——阅读器永远出得了正文。
 */
import { t } from '../i18n.js';

const FRAME_SRC = './user-script-sandbox-frame.html';
const READY_TIMEOUT_MS = 4000;   // 帧装载/就绪上限
const CALL_TIMEOUT_MS = 8000;    // 单次求值上限（帧内死循环的止损线）

let frameEl = null;
let readyPromise = null;
let nonceSeq = 1;
const pending = new Map(); // nonce -> { resolve, timer }

function identityResult(input) {
  return { body: String((input && input.body) ?? ''), actions: [], applied: 0, skipped: 0, errors: [], actionsDropped: 0 };
}

function teardownFrame() {
  try { frameEl?.remove(); } catch (_) { /* 已移除 */ }
  frameEl = null;
  readyPromise = null;
}

function ensureFrame() {
  if (frameEl) return readyPromise;
  frameEl = document.createElement('iframe');
  frameEl.className = 'nj-us-sandbox-frame';
  frameEl.setAttribute('aria-hidden', 'true');
  frameEl.setAttribute('tabindex', '-1');
  frameEl.title = t('用户脚本沙箱');
  frameEl.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;border:0;';
  frameEl.src = FRAME_SRC;
  readyPromise = new Promise((resolve) => {
    // 就绪与结果共用一个监听；帧起不来时超时放行（调用方走零脚本降级）
    window.addEventListener('message', onFrameMessage);
    setTimeout(resolve, READY_TIMEOUT_MS);
  });
  document.body.appendChild(frameEl);
  return readyPromise;
}

function onFrameMessage(event) {
  const data = event.data;
  if (!data || typeof data !== 'object' || typeof data.kind !== 'string') return;
  if (data.kind === 'us-sandbox-ready') {
    // 就绪广播：持有 readyPromise 的等待方自行 resolve，这里无需额外状态
    return;
  }
  if (data.kind === 'us-sandbox-result' && pending.has(data.nonce)) {
    const entry = pending.get(data.nonce);
    pending.delete(data.nonce);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(data.result);
  }
}

async function callFrame(kind, payload) {
  await ensureFrame();
  if (!frameEl || !frameEl.contentWindow) return null; // 帧不可用 → 调用方降级
  const nonce = nonceSeq;
  nonceSeq += 1;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(nonce);
      resolve(null); // 超时：恒等降级 + 重建帧（本帧可能已被死循环脚本挂起）
      teardownFrame();
    }, CALL_TIMEOUT_MS);
    pending.set(nonce, { resolve, timer });
    try {
      frameEl.contentWindow.postMessage({ nonce, kind, ...payload }, '*');
    } catch (_) {
      pending.delete(nonce);
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/**
 * 变换管线（reader 打开文章时一次）：帧不可用/超时 → 恒等结果（零脚本语义）。
 * @returns {Promise<{body,actions,applied,skipped,errors,actionsDropped}>}
 */
export async function runUserScriptsViaFrame({ scripts = [], title = '', url = '', body = '' } = {}) {
  const input = { title, url, body };
  if (!Array.isArray(scripts) || !scripts.length) return identityResult(input);
  const result = await callFrame('us-sandbox-transform', { scripts, input });
  return result || identityResult(input);
}

/**
 * 按钮点击执行（fn 函数体字符串）：帧不可用/超时 → 明确失败（toast 提示）。
 * @returns {Promise<{ok:true,value:*}|{ok:false,error:string}>}
 */
export async function runUserActionViaFrame(fn, { title = '', url = '', body = '' } = {}) {
  const result = await callFrame('us-sandbox-action', { fn: String(fn ?? ''), input: { title, url, body } });
  if (!result) return { ok: false, error: t('脚本沙箱无响应，请重试。') };
  return result;
}
