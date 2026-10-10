'use strict';
/**
 * user-script-sandbox.js — 知更实验室 · 用户脚本沙箱（F32，渲染层受控执行）
 *
 * 安全模型（红线）：
 * - `new Function` 受控执行：code 外层包 "use strict"；**危险全局以 undefined
 *   形参遮蔽**（document/window/fetch/localStorage/navigator/Function 等——形参
 *   名遮蔽外层作用域，脚本体内这些名字解析为 undefined，不提供 DOM/网络/IO）；
 *   注：脚本体内经间接 eval / 构造器逃逸在无realm环境下无法 100% 封死，威胁模型
 *   按「用户自装、导入前可见源码、纯字符串变换」设定——纯字符串处理的风险量级
 *   与内置代码相同（UI 卡死风险同量级，可接受并在此注明）；
 * - context 只暴露白名单对象：{ body（消毒后正文 HTML 字符串）, title, url,
 *   actions（声明式按钮收集器）}——脚本只能「输入正文 → 输出正文」与
 *   「声明按钮 → 点击时以同一沙箱跑 fn」；
 * - 权限声明制：permissions_json 列出使用的钩子（transform-body / add-actions），
 *   未声明对应权限的产物一律丢弃；
 * - 异常全隔离：单脚本出错只跳过本脚本并计数，不影响阅读器与其他脚本；
 * - 体积闸：code ≤64KB（导入侧已闸，此处防御性再判）；变换输出 ≤2MB（超限按
 *   异常丢弃，防内存放大）；
 * - 无脚本零开销：scripts 为空直接原样返回（阅读器热路径不付任何沙箱成本）。
 */

/** 沙箱常量（与主进程 USER_SCRIPT.CODE_MAX 同源口径）。 */
export const USER_SANDBOX = {
  CODE_MAX: 64 * 1024,
  ACTIONS_MAX: 6,             // 单脚本声明按钮上限
  ACTIONS_TOTAL_MAX: 12,      // 全部脚本按钮合计上限
  OUTPUT_MAX: 2 * 1024 * 1024,
};

/** 受遮蔽的全局名单（undefined 形参）：无 DOM / 无网络 / 无存储 / 无弹窗。 */
const SHADOWED_GLOBALS = [
  'document', 'window', 'globalThis', 'self', 'frames', 'parent', 'top',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches',
  'navigator', 'location', 'history',
  'alert', 'confirm', 'prompt', 'open', 'close',
  'require', 'process', 'module', 'exports', 'Function',
];

const TEXT_ENCODER = new TextEncoder();
/** 渲染层无 Node Buffer：字节长度走 TextEncoder（UTF-8）。 */
function byteLength(text) { return TEXT_ENCODER.encode(String(text ?? '')).length; }

/** 编译用户函数体（只编译不执行；语法错误即抛）。 */
export function compileUserFunction(code) {
  const source = String(code ?? '');
  if (byteLength(source) > USER_SANDBOX.CODE_MAX) {
    throw new Error('脚本超过 64KB 执行闸。');
  }
  // eslint-disable-next-line no-new-func
  return new Function('context', ...SHADOWED_GLOBALS, `"use strict";\n${source}`);
}

/** 在沙箱里执行一个已编译函数（undefined 逐位注入遮蔽名单）。 */
function invoke(compiled, context) {
  const shims = new Array(SHADOWED_GLOBALS.length).fill(undefined);
  return compiled(context, ...shims);
}

/** 校验脚本声明的 actions 项（label/fn 均为字符串；fn 同样过执行闸）。 */
function sanitizeActions(rawActions, scriptID, scriptName, onDrop) {
  const out = [];
  if (!Array.isArray(rawActions)) return out;
  for (const item of rawActions) {
    if (out.length >= USER_SANDBOX.ACTIONS_MAX) break;
    if (!item || typeof item !== 'object') continue;
    const label = String(item.label ?? '').trim().slice(0, 40);
    const fn = String(item.fn ?? '');
    if (!label || !fn.trim()) { onDrop?.(); continue; }
    try { compileUserFunction(fn); } catch (_) { onDrop?.(); continue; } // fn 语法预检
    out.push({ scriptID, scriptName, label, fn });
  }
  return out;
}

/**
 * 依次跑所有启用脚本的 transform-body（列表序即执行序）。
 * @param {Array} scripts [{id,name,permissions,code,enabled}]（enabled 已过滤亦可）
 * @param {{title,url,body}} input
 * @returns {{body, actions, applied, skipped, errors, actionsDropped}}
 *   - body：最终正文 HTML 字符串（异常/空返回保持前值）；
 *   - actions：[{scriptID,scriptName,label,fn}]（阅读器渲染为正文底部按钮）；
 *   - applied/skipped/errors：计数与异常明细（设置分区诊断用）。
 */
export function runTransformScripts(scripts, { title = '', url = '', body = '' } = {}) {
  const list = Array.isArray(scripts) ? scripts : [];
  if (!list.length) return { body, actions: [], applied: 0, skipped: 0, errors: [], actionsDropped: 0 };

  let current = String(body ?? '');
  let applied = 0;
  let skipped = 0;
  let actionsDropped = 0;
  const errors = [];
  const actions = [];

  for (const script of list) {
    const perms = Array.isArray(script.permissions) ? script.permissions : [];
    const wantsTransform = perms.includes('transform-body');
    const wantsActions = perms.includes('add-actions');
    if (!wantsTransform && !wantsActions) { skipped += 1; continue; }
    let compiled = null;
    try {
      compiled = compileUserFunction(script.code);
    } catch (err) {
      errors.push({ scriptID: script.id, message: String((err && err.message) || err).slice(0, 160) });
      continue;
    }
    try {
      const declared = [];
      const context = { body: current, title: String(title ?? ''), url: String(url ?? ''), actions: declared };
      const result = invoke(compiled, context);
      // 权限声明制：未声明 transform-body 的返回值一律丢弃
      if (wantsTransform && typeof result === 'string' && result.length && result !== current) {
        if (result.length > USER_SANDBOX.OUTPUT_MAX) throw new Error('变换输出超过 2MB 闸。');
        current = result;
        applied += 1;
      } else if (wantsTransform && typeof result === 'string' && result.length && result === current) {
        applied += 1; // 恒等变换也计「已应用」
      }
      // 权限声明制：未声明 add-actions 的按钮声明一律丢弃
      if (wantsActions) {
        const room = USER_SANDBOX.ACTIONS_TOTAL_MAX - actions.length;
        const collected = sanitizeActions(
          declared.slice(0, room),
          script.id, script.name,
          () => { actionsDropped += 1; }
        );
        actionsDropped += Math.max(0, declared.length - room);
        actions.push(...collected);
      }
    } catch (err) {
      errors.push({ scriptID: script.id, message: String((err && err.message) || err).slice(0, 160) });
      continue; // 异常隔离：跳过该脚本（正文保持该脚本执行前的值）
    }
  }
  return { body: current, actions, applied, skipped, errors, actionsDropped };
}

/**
 * 点击脚本按钮：fn（函数体字符串）以同一沙箱执行。
 * @returns {{ok:true, value:*} | {ok:false, error:string}}
 *   value 为字符串时由调用方以 toast 显示。
 */
export function runActionFn(fn, { title = '', url = '', body = '' } = {}) {
  try {
    const compiled = compileUserFunction(fn);
    const context = { body: String(body ?? ''), title: String(title ?? ''), url: String(url ?? ''), actions: [] };
    return { ok: true, value: invoke(compiled, context) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 200) };
  }
}
