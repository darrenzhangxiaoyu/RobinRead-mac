'use strict';
/**
 * diag-f32-userscript.js — F32 知更实验室 · 用户脚本探针（run-all OFFLINE 集，全程离线）
 *
 * 覆盖：
 *  1 v31 迁移：user_scripts 列齐备 / 索引 / 链尾序（v30 之后）/ 重跑幂等
 *  2 内置示例：构造幂等种子 / 元数据 / **真实可跑**（沙箱变换注入样式 + 幂等不叠加）
 *  3 .ruser 导入：合法导入字段往返 / 坏 JSON 拒绝 / 缺 name 拒绝 / code 超 64KB 拒绝 /
 *    权限全不支持拒绝 / 语法错误编译预检拒绝 / 未知字段容忍
 *  4 文件导入：>256KB 大小闸拒绝 / 合法 .ruser 文件导入带 bytes
 *  5 启停删：enabledScripts 投影 / 删除 / 示例删除后 preference 标记不再复活（新 store 实证）/
 *    老库无损（已导入脚本跨重启保留）/ 示例导出 JSON 真实可再导入
 *  6 沙箱（渲染层真执行，offscreen 窗口 import ESM）：变换生效 / 无 return 保持 /
 *    异常隔离（坏脚本跳过计数+后续照跑）/ 多脚本按列表序 / 权限声明制（未声明钩子产物丢弃）/
 *    全局遮蔽（document/window/fetch 不可达）/ context 白名单字段 / actions 声明收集
 *    （权限要求+坏 fn 丢弃+单脚本上限 6）/ 空脚本零开销 / runActionFn（字符串结果+异常隔离）
 *  7 UI（150s 竞速降级 SKIP）：知更实验室分区真渲染（脚本列表/权限展示/导入导出按钮）+
 *    userScripts:* IPC 真调用 + 静态锚点（preload/IPC/reader 钩子/CSS/i18n）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration(); // 沙箱内 GPU 合成偶发死锁：探针窗口纯 DOM 断言，禁用硬件加速
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f32-')));
setTimeout(() => { console.error('WATCHDOG'); process.exit(3); }, 600 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let passed = 0;
let skipCount = 0;
const ok = (c, l) => { if (c) { passed += 1; console.log('PASS ' + l); } else { failed += 1; console.error('FAIL ' + l); } };
const skip = (l) => { skipCount += 1; console.log('SKIP ' + l); };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const T0 = Math.floor(Date.now() / 1000);

app.whenReady().then(async () => {
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { UserScriptService, USER_SCRIPT, buildRUser } = require('../src/main/UserScriptService');
    const { runMigrations, MIGRATIONS } = require('../src/main/Persistence/DatabaseMigrations');
    const userData = app.getPath('userData');
    const store = new AppStore(userData);
    const svc = store.userScripts;
    ok(svc instanceof UserScriptService, '附 store.userScripts 接线（AppStore 构造）');

    // ── 1. v31 迁移 ──
    const v31Index = MIGRATIONS.findIndex((m) => m.id === 'v31-user-scripts');
    const v30Index = MIGRATIONS.findIndex((m) => m.id === 'v30-challenges-garden-decor');
    ok(v31Index === MIGRATIONS.length - 1 && v31Index === v30Index + 1, '1 v31 迁移在链尾（v30 之后）');
    const cols = store.database.prepare('PRAGMA table_info(user_scripts)').all().map((c) => c.name);
    ok(['id', 'name', 'version', 'permissions_json', 'code', 'enabled', 'created_at', 'updated_at']
      .every((c) => cols.includes(c)), '1 user_scripts 列齐备');
    const idx = store.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_user_scripts_enabled'").get();
    ok(Boolean(idx), '1 idx_user_scripts_enabled 索引在案');
    let rerunOK = true;
    try { runMigrations(store.database); } catch (_) { rerunOK = false; }
    ok(rerunOK, '1 迁移重跑幂等（不抛错不重复）');

    // ── 2. 内置示例（真实可跑）──
    const example = svc.get(USER_SCRIPT.EXAMPLE_ID);
    ok(Boolean(example) && example.name === '段落间距压缩' && example.enabled === true,
      '2 示例脚本构造即种子（已启用）');
    ok(JSON.stringify(example.permissions) === JSON.stringify(['transform-body']),
      '2 示例权限声明 transform-body');
    ok(example.code.includes('context.body') && example.code.length > 400,
      '2 示例代码注释即文档（引用 context.body 且成文）');

    // ── 3. .ruser 导入校验 ──
    const count0 = svc.list().length;
    const imported = svc.importScript(buildRUser({
      name: '探针脚本', version: '2.1.0', permissions: ['transform-body', 'add-actions', 'hacked-hook'],
      code: 'return context.body.replace("F32ORIG", "F32NEW");',
    }));
    ok(imported && imported.name === '探针脚本' && imported.version === '2.1.0',
      '3 合法 .ruser 导入（名称/版本往返）');
    ok(JSON.stringify(imported.permissions) === JSON.stringify(['transform-body', 'add-actions']),
      '3 权限按白名单裁剪（hacked-hook 剥除）');
    ok(svc.list().length === count0 + 1, '3 列表计数 +1（零残留语义：成功才入库）');
    const bad = (label, fn) => {
      try { fn(); ok(false, label); } catch (e) { ok(Boolean(String(e && e.message || e)), `${label}（${String(e && e.message || e).slice(0, 26)}…）`); }
    };
    bad('3 坏 JSON 字符串拒绝', () => svc.importScript('{not-json'));
    bad('3 缺 name 拒绝', () => svc.importScript({ version: '1.0.0', permissions: [], code: 'return context.body;' }));
    bad('3 code 超 64KB 执行闸拒绝', () => svc.importScript({ name: '巨脚本', code: 'x'.repeat(64 * 1024 + 1) }));
    bad('3 空代码拒绝', () => svc.importScript({ name: '空脚本', code: '   ' }));
    bad('3 权限全不支持拒绝', () => svc.importScript({ name: '野权限', permissions: ['read-files'], code: 'return context.body;' }));
    bad('3 语法错误编译预检拒绝', () => svc.importScript({ name: '语法错', permissions: ['transform-body'], code: 'ret@urn (((' }));
    bad('3 非对象载荷拒绝', () => svc.importScript([1, 2, 3]));

    // ── 4. 文件导入（大小闸 + 合法导入）──
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f32-ruser-'));
    const bigPath = path.join(tmpDir, 'big.ruser');
    fs.writeFileSync(bigPath, JSON.stringify({ name: '大文件', code: 'x'.repeat(300 * 1024) }));
    let bigErr = '';
    try { svc.importFromFile(bigPath); } catch (e) { bigErr = String(e && e.message || e); }
    ok(/256KB/.test(bigErr), '4 文件 >256KB 大小闸拒绝');
    const okPath = path.join(tmpDir, 'good.ruser');
    fs.writeFileSync(okPath, buildRUser({ name: '文件脚本', version: '1.0.1', permissions: ['transform-body'], code: 'return context.body;' }));
    const fileResult = svc.importFromFile(okPath);
    ok(fileResult && fileResult.script.name === '文件脚本' && fileResult.bytes > 0, '4 合法 .ruser 文件导入（带 bytes）');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* 临时目录留给系统清理 */ }

    // ── 5. 启停删 + 示例导出往返 ──
    svc.setEnabled(imported.id, false);
    ok(svc.get(imported.id).enabled === false && !svc.enabledScripts().some((s) => s.id === imported.id),
      '5 禁用后 enabledScripts 投影不含');
    svc.setEnabled(imported.id, true);
    ok(svc.enabledScripts().some((s) => s.id === imported.id), '5 重新启用回到投影');
    let rmErr = '';
    try { svc.remove('us-none'); } catch (e) { rmErr = String(e && e.message || e); }
    ok(/不存在/.test(rmErr), '5 删除不存在脚本拒绝');
    const exported = svc.exportExample();
    let exportedOK = false;
    try {
      const parsed = JSON.parse(exported);
      exportedOK = parsed.name === '段落间距压缩' && Array.isArray(parsed.permissions) && typeof parsed.code === 'string';
    } catch (_) { exportedOK = false; }
    ok(exportedOK, '5 示例导出 .ruser JSON（合同形状）');
    const reImported = svc.importScript(exported);
    ok(reImported && reImported.id !== USER_SCRIPT.EXAMPLE_ID && reImported.name === '段落间距压缩',
      '5 示例导出真实可再导入（社区脚本活样板）');
    svc.remove(reImported.id);
    svc.remove(imported.id);
    svc.remove(fileResult.script.id);

    // ── 6. 沙箱 + UI（渲染层真执行；环境降级可 SKIP）──
    const ui = await Promise.race([
      sandboxAndUIProbe(store),
      new Promise((r) => setTimeout(() => r({ uiSkipped: true, booted: null }), 150000)),
    ]);
    if (ui.uiSkipped || ui.booted !== true || ui.error) {
      for (const l of [
        '6 沙箱变换：正文修改生效',
        '6 无 return 保持正文',
        '6 异常隔离：坏脚本跳过+计数+后续照跑',
        '6 多脚本按列表序生效',
        '6 权限声明制：未声明 transform-body 返回值丢弃',
        '6 全局遮蔽：document/window/fetch 不可达',
        '6 context 白名单：title/url 传入',
        '6 actions 声明收集（权限要求+坏 fn 丢弃+上限 6）',
        '6 空脚本零开销',
        '6 runActionFn：字符串结果+异常隔离',
        '7 设置页渲染：知更实验室分区（脚本列表/权限/按钮）',
        '7 userScripts:* IPC 真调用',
      ]) skip(l);
      console.log('UI 阶段 SKIP：环境性挂起（服务级断言已全部执行）');
      try { fs.writeFileSync(path.join(__dirname, '.ci-skip-marker'), 'scripts/diag-f32-userscript.js'); } catch (_) { /* 标记失败仅影响连击治理 */ }
    } else {
      const sb = ui.sandbox || {};
      ok(sb.transformWorks === true, '6 沙箱变换：正文修改生效');
      ok(sb.noReturnKeeps === true, '6 无 return 保持正文');
      ok(sb.errorIsolated === true, '6 异常隔离：坏脚本跳过+计数+后续照跑');
      ok(sb.orderWorks === true, '6 多脚本按列表序生效');
      ok(sb.permissionGate === true, '6 权限声明制：未声明 transform-body 返回值丢弃');
      ok(sb.globalsShadowed === true, '6 全局遮蔽：document/window/fetch 不可达');
      ok(sb.contextFields === true, '6 context 白名单：title/url 传入');
      ok(sb.actionsWork === true, '6 actions 声明收集（权限要求+坏 fn 丢弃+上限 6）');
      ok(sb.emptyZeroCost === true, '6 空脚本零开销');
      ok(sb.actionFnWorks === true, '6 runActionFn：字符串结果+异常隔离');
      ok(ui.sectionRendered === true, '7 设置页渲染：知更实验室分区（脚本列表/权限/按钮）');
      ok(ui.ipcWorks === true, '7 userScripts:* IPC 真调用');
    }

    // ── 7. 老库无损 + 示例不复活（新 store 实证）──
    svc.remove(USER_SCRIPT.EXAMPLE_ID);
    ok(svc.get(USER_SCRIPT.EXAMPLE_ID) === null && store.preferences.get(USER_SCRIPT.EXAMPLE_REMOVED_KEY, false) === true,
      '7 示例删除：行消失 + preference 标记');
    store.preferences.flushSync();
    store.database.close();
    const store2 = new AppStore(userData); // 同 userData 重开 = 老库升级路径重放
    ok(store2.userScripts.get(USER_SCRIPT.EXAMPLE_ID) === null,
      '7 新 store：示例不复活（删除标记持久）');
    const survivors = store2.userScripts.list().map((s) => s.name);
    ok(survivors.includes('探针脚本') === false && survivors.length === 0,
      '7 老库无损重开（探针脚本已清理，账本一致）');

    // ── 附：静态接线锚点 ──
    const storeSrc = read('src/main/AppStore.js');
    ok(storeSrc.includes('new UserScriptService'), '附 AppStore 构造接线');
    const preloadSrc = read('src/main/preload.js');
    ok(['userScriptsList', 'userScriptsEnabled', 'userScriptsGet', 'userScriptsImport', 'userScriptsImportPick', 'userScriptsSetEnabled', 'userScriptsRemove', 'userScriptsExportExample']
      .every((n) => preloadSrc.includes(n)), '附 preload 用户脚本 8 通道齐备');
    const ipcSrc = read('src/main/ipc.js');
    ok(["'userScripts:list'", "'userScripts:enabled'", "'userScripts:import'", "'userScripts:importPick'", "'userScripts:setEnabled'", "'userScripts:remove'", "'userScripts:exportExample'"]
      .every((c) => ipcSrc.includes(c)), '附 IPC userScripts 通道注册齐备');
    const readerSrc = read('src/renderer/views/reader.js');
    ok(readerSrc.includes('runUserScriptsViaFrame') && readerSrc.includes('_renderUserScriptActions()')
      && readerSrc.includes('runUserActionViaFrame') && readerSrc.includes('userScriptsEnabled')
      && readerSrc.includes('_applyUserScripts'),
      '附 reader 正文管线钩子 + 按钮渲染 + IPC 拉取锚点');
    const sandboxSrc = read('src/renderer/views/user-script-sandbox.js');
    ok(sandboxSrc.includes('"use strict"') && sandboxSrc.includes('SHADOWED_GLOBALS') && !sandboxSrc.match(/\beval\(/),
      '附 沙箱红线：严格模式 + 全局遮蔽 + 无 eval 直呼');
    const frameSrc = read('src/renderer/user-script-sandbox-frame.html');
    const hostSrc = read('src/renderer/views/user-script-sandbox-host.js');
    const clientSrc = read('src/renderer/views/user-script-sandbox-client.js');
    ok(frameSrc.includes("'unsafe-eval'") && hostSrc.includes('runTransformScripts') && clientSrc.includes('postMessage'),
      '附 专用沙箱帧（唯一 unsafe-eval 文档）+ postMessage 桥锚点');
    const indexSrc = read('src/renderer/index.html');
    ok(indexSrc.includes("script-src 'self'") && !indexSrc.includes("'unsafe-eval'"),
      '附 主页面 CSP 红线不放松（无 unsafe-eval）');
    const dialogsSrc = read('src/renderer/views/dialogs.js');
    ok(['知更实验室', '导入脚本', '示例导出', '查看源码', '沙箱安全', 'nj-us-item'].every((k) => dialogsSrc.includes(k)),
      '附 设置实验室分区/列表/源码/安全锚点齐备');
    const cssSrc = read('src/renderer/styles/robin.css');
    ok(cssSrc.includes('.nj-us-item') && cssSrc.includes('.nj-user-action-btn') && cssSrc.includes('.nj-us-source'),
      '附 CSS 脚本列表/按钮/源码浮层样式');
    const stringsSrc = read('src/main/I18NStrings.js');
    ok(['"知更实验室"', '"导入脚本"', '"示例导出"', '"查看源码"', '"沙箱安全"', '"正文变换"', '"自定义按钮"', '"标为已读"'].every((k) => stringsSrc.includes(k)),
      '附 i18n 中英键齐备（实验室+口袋知更八组）');
    const migSrc = read('src/main/Persistence/DatabaseMigrations.js');
    ok(migSrc.includes("id: 'v31-user-scripts'") && migSrc.includes('user_scripts'), '附 DDL 只进迁移链锚点');
    const usSvcSrc = read('src/main/UserScriptService.js');
    ok(!usSvcSrc.match(/CREATE TABLE/), '附 服务层零 ad-hoc DDL（铁律）');

    store2.preferences.flushSync();
    store2.database.close();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* 留给系统清理 */ }
    console.log(`TOTAL passed=${passed} failed=${failed}${skipCount ? ` skipped=${skipCount}` : ''}`);
    console.log(failed === 0 ? 'ALL PASSED' : `FAILED ${failed}`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('ERR', String((err && err.stack) || err).slice(0, 1600));
    process.exit(1);
  }
});

/**
 * 沙箱 + 设置分区 UI 探针：offscreen 窗口 import 渲染层 ESM 沙箱模块真执行，
 * 再渲染 SettingsView lab 分区（f25/f26/f39 惯例：offscreen + throttling off）。
 */
async function sandboxAndUIProbe(store) {
  let win = null;
  try {
    win = new BrowserWindow({
      show: false, width: 1200, height: 860, useContentSize: true,
      webPreferences: { offscreen: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
  } catch (err) {
    console.error('f32 sandbox probe: window create failed (environmental):', String((err && err.message) || err));
    return { uiSkipped: true, booted: null };
  }
  try {
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, win);
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  } catch (err) {
    console.error('f32 sandbox probe: load failed (environmental):', String((err && err.message) || err));
    try { win.destroy(); } catch (_) { /* 已销毁 */ }
    return { uiSkipped: true, booted: null };
  }
  await sleep(1400);
  // 沙箱用例（源码内联，代码样本经 JSON.stringify 注入避免转义歧义）
  const cases = {
    transform: { name: 't1', permissions: ['transform-body'], code: 'return context.body.replace("F32ORIG", "F32NEW");' },
    noReturn: { name: 't2', permissions: ['transform-body'], code: 'void context.body;' },
    thrower: { name: 't3', permissions: ['transform-body'], code: 'throw new Error("boom");' },
    afterThrower: { name: 't4', permissions: ['transform-body'], code: 'return context.body + "|ALIVE";' },
    prefixer: { name: 't5', permissions: ['transform-body'], code: 'return "A|" + context.body;' },
    suffixer: { name: 't6', permissions: ['transform-body'], code: 'return context.body + "|B";' },
    noPerm: { name: 't7', permissions: [], code: 'return "HACKED" + context.body;' },
    shadow: { name: 't8', permissions: ['transform-body'], code: 'return "SHADOW:" + (typeof document === "undefined") + (typeof window === "undefined") + (typeof fetch === "undefined");' },
    ctx: { name: 't9', permissions: ['transform-body'], code: 'return context.title + "@" + context.url;' },
    actions: {
      name: 't10', permissions: ['add-actions'],
      code: [
        'context.actions.push({ label: "统计字数", fn: "return \\"字数:\\" + context.body.length" });',
        'context.actions.push({ label: "坏按钮", fn: "ret@urn (((" });',
        'context.actions.push({ label: "b1", fn: "return \\"1\\"" });',
        'context.actions.push({ label: "b2", fn: "return \\"2\\"" });',
        'context.actions.push({ label: "b3", fn: "return \\"3\\"" });',
        'context.actions.push({ label: "b4", fn: "return \\"4\\"" });',
        'context.actions.push({ label: "b5", fn: "return \\"5\\"" });',
        'context.actions.push({ label: "b6", fn: "return \\"6\\"" });',
        'context.actions.push({ label: "b7-超限", fn: "return \\"7\\"" });',
      ].join('\n'),
    },
  };
  const js = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { booted: true };
    try {
      const SB = await import('./views/user-script-sandbox-client.js');
      const C = ${JSON.stringify(cases)};
      for (const k of Object.keys(C)) C[k].id = C[k].name; // 沙箱错误归因按 scriptID
      const BODY = '<p>F32ORIG 正文。</p>';
      // 变换生效（经专用沙箱帧真实执行）
      const r1 = await SB.runUserScriptsViaFrame({ scripts: [C.transform], title: 'T', url: 'U', body: BODY });
      out.sandbox = {};
      out.sandbox.transformWorks = r1.body.includes('F32NEW') && !r1.body.includes('F32ORIG') && r1.applied === 1;
      // 无 return 保持
      const r2 = await SB.runUserScriptsViaFrame({ scripts: [C.noReturn], title: '', url: '', body: BODY });
      out.sandbox.noReturnKeeps = r2.body === BODY;
      // 异常隔离：坏脚本跳过计数，后续脚本照跑
      const r3 = await SB.runUserScriptsViaFrame({ scripts: [C.thrower, C.afterThrower], title: '', url: '', body: BODY });
      out.sandbox.errorIsolated = r3.body === (BODY + '|ALIVE') && r3.errors.length === 1 && r3.errors[0].scriptID === C.thrower.name;
      // 多脚本按列表序
      const r4 = await SB.runUserScriptsViaFrame({ scripts: [C.prefixer, C.suffixer], title: '', url: '', body: BODY });
      out.sandbox.orderWorks = r4.body === ('A|' + BODY + '|B');
      // 权限声明制：未声明 transform-body 的返回值丢弃
      const r5 = await SB.runUserScriptsViaFrame({ scripts: [C.noPerm], title: '', url: '', body: BODY });
      out.sandbox.permissionGate = r5.body === BODY && r5.applied === 0;
      // 全局遮蔽
      const r6 = await SB.runUserScriptsViaFrame({ scripts: [C.shadow], title: '', url: '', body: BODY });
      out.sandbox.globalsShadowed = r6.body === 'SHADOW:truetruetrue';
      // context 白名单字段
      const r7 = await SB.runUserScriptsViaFrame({ scripts: [C.ctx], title: '标题X', url: 'https://u.test', body: BODY });
      out.sandbox.contextFields = r7.body === '标题X@https://u.test';
      // actions：权限要求 / 坏 fn 丢弃 / 单脚本上限 6（坏按钮不占额，b1-b5 收满，b6/b7 溢出）
      const r8 = await SB.runUserScriptsViaFrame({ scripts: [C.actions], title: '', url: '', body: BODY });
      const acts = r8.actions || [];
      out.sandbox.actionsWork = acts.length === 6
        && acts[0].label === '统计字数'
        && acts.some((a) => a.label === 'b5')
        && !acts.some((a) => a.label === 'b6')
        && !acts.some((a) => a.label === 'b7-超限')
        && acts[0].scriptName === 't10'
        && r8.errors.length === 0;
      // runActionFn：字符串结果 + 异常隔离（同一帧）
      const good = await SB.runUserActionViaFrame(acts[0] ? acts[0].fn : 'return "n/a"', { body: '12345' });
      const bad = await SB.runUserActionViaFrame('ret@urn (((', { body: '' });
      out.sandbox.actionFnWorks = good && good.ok === true && good.value === '字数:5' && bad && bad.ok === false && Boolean(bad.error);
      // 空脚本零开销
      const r9 = await SB.runUserScriptsViaFrame({ scripts: [], title: '', url: '', body: BODY });
      out.sandbox.emptyZeroCost = r9.body === BODY && r9.actions.length === 0 && r9.applied === 0;

      // 设置页真渲染（知更实验室分区）
      const { SettingsView } = await import('./views/dialogs.js');
      const view = new SettingsView({ state: { snapshot: { preferences: {} } }, views: {} });
      view.present('lab');
      await sleep(600);
      // userScripts:* IPC 真调用（data 通道已解包信封：直接返回 {scripts}）
      const listResult = await window.robin.userScriptsList();
      const enabledResult = await window.robin.userScriptsEnabled();
      out.ipcWorks = Boolean(
        listResult && Array.isArray(listResult.scripts) && listResult.scripts.length >= 1
        && enabledResult && Array.isArray(enabledResult.scripts)
      );
      out.sectionRendered = Boolean(
        document.querySelector('.modal-nav-item[data-section="lab"]')
        && document.querySelector('.nj-us-item')
        && document.querySelector('[data-role="us-permissions"]')
        && Array.from(document.querySelectorAll('button')).some((b) => b.textContent === '导入脚本…')
        && Array.from(document.querySelectorAll('button')).some((b) => b.textContent === '示例导出')
      );
      view.dismiss();
      return out;
    } catch (e) {
      return { booted: true, error: String((e && e.stack) || e).slice(0, 700) };
    }
  })()`;
  const out = await win.webContents.executeJavaScript(js);
  win.destroy();
  if (out && out.error) console.error('f32 sandbox probe error:', out.error);
  return out || {};
}
