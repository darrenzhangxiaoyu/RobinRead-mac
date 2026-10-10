'use strict';
/**
 * user-script-sandbox-host.js — 沙箱宿主帧（F32）
 *
 * 运行在 user-script-sandbox-frame.html（唯一 CSP 允许 unsafe-eval 的文档）里，
 * 与宿主应用页面零共享：帧内无应用 DOM、无特权 API、无 nodeIntegration。
 * 职责单一：收 postMessage → 以同一沙箱（views/user-script-sandbox.js）求值 →
 * 回 postMessage。协议：
 *   入 { nonce, kind: 'us-sandbox-ping' }                                  → 就绪探针
 *   入 { nonce, kind: 'us-sandbox-transform', scripts, input }             → 变换管线
 *   入 { nonce, kind: 'us-sandbox-action', fn, input }                     → 按钮执行
 *   出 { kind: 'us-sandbox-ready', nonce } / { kind: 'us-sandbox-result', nonce, result }
 */
import { runTransformScripts, runActionFn } from './user-script-sandbox.js';

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object' || !isNumber(data.nonce) || typeof data.kind !== 'string') return;
  if (data.kind === 'us-sandbox-ping') {
    parent.postMessage({ kind: 'us-sandbox-ready', nonce: data.nonce }, '*');
    return;
  }
  if (data.kind === 'us-sandbox-transform') {
    let result;
    try {
      result = runTransformScripts(Array.isArray(data.scripts) ? data.scripts : [], data.input || {});
    } catch (err) {
      // 桥本身不应失败；兜底恒等返回（正文原样），错误带出
      result = {
        body: String((data.input || {}).body ?? ''),
        actions: [],
        applied: 0, skipped: 0,
        errors: [{ scriptID: 'bridge', message: String((err && err.message) || err).slice(0, 160) }],
        actionsDropped: 0,
      };
    }
    parent.postMessage({ kind: 'us-sandbox-result', nonce: data.nonce, result }, '*');
    return;
  }
  if (data.kind === 'us-sandbox-action') {
    let result;
    try {
      result = runActionFn(String(data.fn ?? ''), data.input || {});
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err).slice(0, 200) };
    }
    parent.postMessage({ kind: 'us-sandbox-result', nonce: data.nonce, result }, '*');
  }
});

// 模块装载完成即广播就绪（客户端 load 事件后仍以此为准）
parent.postMessage({ kind: 'us-sandbox-ready', nonce: 0 }, '*');
