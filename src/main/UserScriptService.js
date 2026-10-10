'use strict';
/**
 * UserScriptService（知更）— 知更实验室 · 用户脚本（F32，极客创意档）
 *
 * 沙箱 JS 用户脚本：正文净化规则（transform-body）/ 渲染钩子 / 自定义按钮
 * （add-actions），可导入 .ruser 社区脚本，权限声明制。
 *
 * - 存储走迁移链 v31 `user_scripts`（id/name/version/permissions_json/code/
 *   enabled/created_at/updated_at）；
 * - .ruser 文件 = JSON 合同 { name, version, permissions, code }：导入走打开
 *   对话框 + 大小闸（文件 ≤256KB）+ JSON 校验 + 语法编译预检（new Function 只
 *   编译不执行）+ 权限白名单裁剪（声明外的钩子一律剥除——权限声明制的执行侧）；
 * - 沙箱执行在渲染层（views/user-script-sandbox.js）：`new Function('context',
 *   '"use strict";' + code)` 受控执行，context 只暴露白名单对象
 *   { body, title, url, actions }，document/window 等浏览器全局一律不可达；
 *   本服务只管「账」（导入/启停/删/权限展示），不碰执行；
 * - 内置示例脚本 1 个（段落间距压缩，注释即文档）：构造时幂等落库；用户删除后
 *   经 preference 标记不再复活；「示例导出」原样输出 .ruser JSON（社区脚本格式
 *   的活样板）。
 *
 * 注入缝（探针）：importScript/importFromFile 全纯函数校验，坏 JSON/超限/坏权限
 * 明确报错零残留。
 */
const fs = require('node:fs');
const { nowSeconds, uuid } = require('./Models');

/** 规则常量（闸值/权限白名单全部集中于此）。 */
const USER_SCRIPT = {
  CODE_MAX: 64 * 1024,        // 执行闸：脚本源码上限（防 while(true) 巨串等）
  FILE_MAX: 256 * 1024,       // 导入大小闸：.ruser 文件字节上限
  NAME_MAX: 80,               // 名称上限
  VERSION_MAX: 24,            // 版本串上限
  TITLE_SLICE: 120,           // 列表回显切片
  /**
   * 权限白名单（声明制）：脚本只可用声明过的钩子。
   * - transform-body：正文变换（渲染管线尾端依次执行）；
   * - add-actions：声明正文底部自定义按钮。
   */
  PERMISSIONS: ['transform-body', 'add-actions'],
  EXAMPLE_ID: 'builtin-paragraph-tighten',
  EXAMPLE_REMOVED_KEY: 'RobinRead.lab.exampleRemoved',
  /**
   * 内置示例脚本（注释即文档）：纯字符串变换的活样板——
   * 拿到 context.body（消毒后正文 HTML），返回修改版；无 IO 无网络无 DOM。
   */
  EXAMPLE: {
    name: '段落间距压缩',
    version: '1.0.0',
    permissions: ['transform-body'],
    code: [
      '// ═══════════════════════════════════════════════════════════════',
      '// 段落间距压缩 · 知更实验室内置示例（本注释即用户脚本的全部文档）',
      '// ',
      '// 一个用户脚本 = 纯字符串变换：',
      '//   输入  context.body  —— 消毒后的正文 HTML 字符串',
      '//         context.title —— 文章标题',
      '//         context.url   —— 原文链接',
      '//   输出  return 修改后的正文 HTML 字符串（不 return 则保持原文）',
      '// ',
      '// 沙箱红线（平台保证，脚本无需关心）：',
      '//   无 document / window / 网络 / 文件——只能「输入正文 → 输出正文」；',
      '//   异常全隔离：脚本出错只跳过本脚本，不影响阅读器。',
      '// ',
      '// 权限：permissions 里声明了 "transform-body"，才会参与正文管线。',
      '// 想加自定义按钮？声明 "add-actions" 后向 context.actions 推入',
      '// { label: "按钮文字", fn: "return …" }（fn 是函数体字符串，',
      '// 点击时在同一个沙箱里执行，返回字符串则以 toast 显示）。',
      '// ═══════════════════════════════════════════════════════════════',
      '',
      '// 正文过密时压一压段距：注入一段带标记的样式（只作用于阅读区）。',
      'var tag = \'data-nj-user-script="paragraph-tighten"\';',
      'var style = \'<style \' + tag + \'>\' +',
      '  \'.robin-body p { margin-block: 0.5em !important; }\' +',
      '  \'</style>\';',
      '',
      '// 幂等：同一段样式只注入一次（重排不会越叠越多）。',
      'if (context.body.indexOf(tag) === -1) {',
      '  return context.body + style;',
      '}',
      'return context.body;',
    ].join('\n'),
  },
};

/** 生成 .ruser JSON（导入合同的同款形状，示例导出用）。 */
function buildRUser({ name, version, permissions, code }) {
  return JSON.stringify({ name, version, permissions, code }, null, 2);
}

class UserScriptService {
  constructor(store) {
    this.store = store;
    this._seedExample();
  }

  // MARK: 内置示例

  _seedExample() {
    try {
      if (this.store.preferences.get(USER_SCRIPT.EXAMPLE_REMOVED_KEY, false) === true) return;
      const row = this.store.database.prepare('SELECT id FROM user_scripts WHERE id = ?').get(USER_SCRIPT.EXAMPLE_ID);
      if (row) return;
      const ts = nowSeconds();
      this.store.database.prepare(`
        INSERT INTO user_scripts (id, name, version, permissions_json, code, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(USER_SCRIPT.EXAMPLE_ID, USER_SCRIPT.EXAMPLE.name, USER_SCRIPT.EXAMPLE.version,
        JSON.stringify(USER_SCRIPT.EXAMPLE.permissions), USER_SCRIPT.EXAMPLE.code, ts, ts);
    } catch (_) { /* 种子失败不阻塞启动（设置分区可见可重导） */ }
  }

  /** 示例导出：.ruser JSON 字符串（社区脚本格式的活样板）。 */
  exportExample() {
    return buildRUser(USER_SCRIPT.EXAMPLE);
  }

  // MARK: 校验（纯函数，导入/探针共用）

  /**
   * 校验并规整 .ruser JSON 载荷：坏形状/坏权限明确报错；权限按白名单裁剪；
   * code 做语法编译预检（只编译不执行）。@returns 规整后的 {name,version,permissions,code}
   */
  static validatePayload(raw) {
    let data = raw;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (_) { throw new Error('不是合法的 JSON 文件。'); }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('脚本包形状不对：需要 { name, version, permissions, code }。');
    }
    const name = String(data.name ?? '').trim();
    if (!name || name.length > USER_SCRIPT.NAME_MAX) {
      throw new Error(`脚本名称须为 1-${USER_SCRIPT.NAME_MAX} 字。`);
    }
    const version = String(data.version ?? '1.0.0').trim().slice(0, USER_SCRIPT.VERSION_MAX) || '1.0.0';
    const declared = Array.isArray(data.permissions) ? data.permissions : [];
    const permissions = [...new Set(declared
      .map((p) => String(p))
      .filter((p) => USER_SCRIPT.PERMISSIONS.includes(p)))];
    if (declared.length && !permissions.length) {
      throw new Error(`权限声明不含任何受支持的钩子（${USER_SCRIPT.PERMISSIONS.join(' / ')}）。`);
    }
    const code = String(data.code ?? '');
    if (!code.trim()) throw new Error('脚本代码为空。');
    if (Buffer.byteLength(code, 'utf8') > USER_SCRIPT.CODE_MAX) {
      throw new Error(`脚本代码超过 ${Math.floor(USER_SCRIPT.CODE_MAX / 1024)}KB 执行闸。`);
    }
    // 语法预检：new Function 只编译不执行（语法错误在导入时就报，而非阅读时静默跳过）
    try {
      // eslint-disable-next-line no-new-func
      new Function('context', `"use strict";\n${code}`);
    } catch (err) {
      throw new Error(`脚本语法无法编译：${String((err && err.message) || err).slice(0, 120)}`);
    }
    return { name, version, permissions, code };
  }

  // MARK: CRUD

  _rowToScript(row) {
    let permissions = [];
    try { permissions = JSON.parse(row.permissions_json || '[]'); } catch (_) { /* 坏 JSON 视为空 */ }
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      permissions,
      code: row.code,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** 全量列表（updated_at 倒序）。 */
  list() {
    return this.store.database.prepare(
      'SELECT * FROM user_scripts ORDER BY updated_at DESC, id ASC'
    ).all().map((r) => this._rowToScript(r));
  }

  get(id) {
    const row = this.store.database.prepare('SELECT * FROM user_scripts WHERE id = ?').get(String(id || ''));
    return row ? this._rowToScript(row) : null;
  }

  /** 启用的脚本（阅读器渲染管线消费的投影：带 code 与权限）。 */
  enabledScripts() {
    return this.list().filter((s) => s.enabled);
  }

  /** 导入脚本（载荷为对象或 JSON 字符串；校验失败明确报错零残留）。 */
  importScript(raw) {
    const clean = UserScriptService.validatePayload(raw);
    const ts = nowSeconds();
    const id = `us-${uuid()}`;
    this.store.database.prepare(`
      INSERT INTO user_scripts (id, name, version, permissions_json, code, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, clean.name, clean.version, JSON.stringify(clean.permissions), clean.code, ts, ts);
    return this.get(id);
  }

  /**
   * 从 .ruser 文件导入：大小闸（≤256KB，读文件前 stat 判定）→ JSON 解析 → 校验。
   * @returns {script, bytes}
   */
  importFromFile(filePath) {
    const stat = fs.statSync(String(filePath || ''));
    if (stat.size > USER_SCRIPT.FILE_MAX) {
      throw new Error(`文件超过 ${Math.floor(USER_SCRIPT.FILE_MAX / 1024)}KB 导入闸。`);
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const script = this.importScript(text);
    return { script, bytes: stat.size };
  }

  /** 启用/禁用（禁用脚本不参与渲染管线）。 */
  setEnabled(id, enabled) {
    const script = this.get(id);
    if (!script) throw new Error('脚本不存在。');
    this.store.database.prepare('UPDATE user_scripts SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled === true ? 1 : 0, nowSeconds(), String(id));
    return this.get(id);
  }

  /** 删除（内置示例删除时记 preference，重启不再复活）。 */
  remove(id) {
    const script = this.get(id);
    if (!script) throw new Error('脚本不存在。');
    this.store.database.prepare('DELETE FROM user_scripts WHERE id = ?').run(String(id));
    if (id === USER_SCRIPT.EXAMPLE_ID) {
      this.store.preferences.set(USER_SCRIPT.EXAMPLE_REMOVED_KEY, true);
    }
    return { removed: true, id: String(id) };
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    const list = this.list();
    return {
      ...USER_SCRIPT,
      exampleRUser: this.exportExample(),
      count: list.length,
      enabledCount: list.filter((s) => s.enabled).length,
      hasExample: list.some((s) => s.id === USER_SCRIPT.EXAMPLE_ID),
    };
  }
}

module.exports = { UserScriptService, USER_SCRIPT, buildRUser };
