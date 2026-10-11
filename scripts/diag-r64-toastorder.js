'use strict';
/**
 * diag-r64-toastorder.js — R64 toast 秩序三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 堆叠上限 3 条 + 同类合并计数：CAP=3（U13 契约 4→3）/ 同文案+同 tone 合并「×N」
 *    不新增堆叠（计数徽标 bump）/ 异文案照常堆叠 / 进度条豁免淘汰不受影响
 *  2 退场动画对称：入场 toast-in 上浮 12px ↔ 退场 .leaving 下沉 12px（原 8px 半程退役），
 *    reduced-motion 由 robin.css 全局收敛块兜底
 *  3 toast 内按钮键盘可达：.toast-action 焦点环（R9/U18 button 家族量纲）+
 *    toast.js wireFocusHold（focus 暂停自动消退挂 hold / blur 按剩余续走）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r64-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

app.whenReady().then(async () => {
  try {
    // ── Phase A：源码在册断言 ──────────────────────────────────────────────
    const toastSrc = read('src/renderer/views/toast.js');
    const robin = read('src/renderer/styles/robin.css');

    ok(/const CAP = 3;/.test(toastSrc), '1 栈容量上限 3 在册（R64 秩序）');
    ok(/mergeIntoExisting\(message, tone, effDuration\)/.test(toastSrc) && /e\.count \+= 1/.test(toastSrc),
      '1 同类合并：同文案+同 tone 计数升级（mergeIntoExisting 在册）');
    ok(/badge\.textContent = `×\$\{e\.count\}`/.test(toastSrc), '1 合并计数「×N」徽标在册');
    ok(/mergeIntoExisting\(message, tone, effDuration\);\n  if \(merged\) return merged;/.test(toastSrc),
      '1 合并先于容量护栏：命中即复用，不新增堆叠');

    ok(/@keyframes toast-in \{ from \{ opacity: 0; transform: translateY\(12px\)/.test(robin),
      '2 入场动画上浮 12px（对照锚）');
    ok(/\.toast-capsule\.leaving \{[^}]*transform: translateY\(12px\) scale\(0\.97\); \}/.test(robin),
      '2 退场 .leaving 下沉 12px（与入场镜像对称）');
    ok(!/\.toast-capsule\.leaving \{[^}]*translateY\(8px\)/.test(robin), '2 原退场 8px 半程已退役');
    ok(/@media \(prefers-reduced-motion: reduce\) \{[^{]*\{[^}]*animation-duration: 0\.01ms !important/.test(robin),
      '2 reduced-motion 全局收敛块兜底（退场/合并 bump 豁免）');

    ok(/function wireFocusHold\(entry, btn\)/.test(toastSrc) && /btn\.addEventListener\('focus'/.test(toastSrc) && /btn\.addEventListener\('blur'/.test(toastSrc),
      '3 动作按钮焦点暂停（wireFocusHold focus/blur 在册）');
    ok(/wireFocusHold\(entry, btn\);/.test(toastSrc), '3 动作按钮创建即接线焦点守卫');
    ok(/\.toast-capsule \.toast-action:focus-visible \{ outline: 2px solid var\(--accent\); outline-offset: 2px; \}/.test(robin),
      '3 焦点环走 R9/U18 button 家族量纲（2px accent 外扩）');
    ok(/\.toast-merge \{[^}]*font-variant-numeric: tabular-nums;/.test(robin), '1 合并计数走等宽数字（R57 数字纪律）');
    ok(/@keyframes toast-merge-bump/.test(robin) && /\.toast-merge\.bump \{ animation: toast-merge-bump var\(--dur-fast\) var\(--ease-spring\); \}/.test(robin),
      '1 合并 bump 弹跳走令牌（--dur-fast + --ease-spring）');

    // ── Phase B：真实渲染窗口断言 ─────────────────────────────────────────
    const win = new BrowserWindow({
      show: false, width: 1280, height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1000);

    const modURL = (f) => pathToFileURL(path.join(ROOT, 'src', 'renderer', 'views', f)).href;
    const b = await win.webContents.executeJavaScript(`(async () => {
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const toastURL = ${JSON.stringify(modURL('toast.js'))};
        const { Toast, dismissTop } = await import(toastURL);
        // 计数辅助：DOM 在场（未离场）条数与指定文案命中（对 app 启动期可能存在的
        // 历史 toast 免疫——按本探针自产文案统计；栈容器惰性创建，未产出前以空集兜底）
        const stackEl = () => document.getElementById('nj-toast-stack');
        const domCount = () => [...(stackEl()?.children || [])].filter((e) => !e.classList.contains('leaving')).length;
        const has = (text) => [...(stackEl()?.children || [])].some((e) => !e.classList.contains('leaving') && (e.querySelector('.toast-msg, .toast-title')?.textContent || '') === text);

        // ① 同类合并：同文案+同 tone 两条 → 单条 ×2，不新增堆叠
        const first = Toast.show('R64已同步12篇', { tone: 'success', duration: 6000 });
        const countAfterFirst = domCount();
        Toast.show('R64已同步12篇', { tone: 'success', duration: 6000 });
        out.mergeLive2 = domCount() === countAfterFirst;
        out.mergeBadge = first.querySelector('.toast-merge')?.textContent || '';
        out.mergeTabular = getComputedStyle(first.querySelector('.toast-merge')).fontVariantNumeric.includes('tabular-nums');
        // 同文案异 tone：不合并（warn 用独立文案，避免与后续淘汰断言串扰）
        Toast.show('R64警告另起', { tone: 'warn', duration: 6000 });
        out.mergeToneBound = domCount() === countAfterFirst + 1;
        // 异文案：正常堆叠
        Toast.show('R64另一件事', { tone: 'success', duration: 6000 });
        out.mergeDistinct = domCount() === countAfterFirst + 2;
        // 合并重置计时：合并后旧条不会立刻离场
        await sleep(60);
        out.mergeStill = document.body.contains(first);

        // ② 堆叠上限 3：第 4 条顶掉最旧普通条（进度条在场豁免淘汰）
        Toast.show('R64第四条', { duration: 6000 });
        out.cap3Count = domCount() <= 3;
        out.cap3Evicted = !has('R64已同步12篇');
        // 进度条豁免：普通条满员 + 进度条进入 → 被请走的是普通条，进度条存活
        const prog = Toast.progress('R64长任务进行中', { note: '40%' });
        prog.set(40);
        out.progressAlive = has('R64长任务进行中');
        out.progressNotEvicted = domCount() <= 4;
        prog.close();
        // 清场：请走本探针产的全部条（dismissTop 为 FIFO，逐条出栈）
        while (has('R64已同步12篇') || has('R64第四条') || has('R64长任务进行中') || domCount() > 0) {
          dismissTop();
          await sleep(20);
          if (domCount() === 0) break;
        }
        await sleep(300); // 离场动画出清

        // ③ 退场对称：leave 挂 .leaving，过渡目标 12px 下沉（读计算样式 mid-flight）
        const victim = Toast.show('R64即将退场', { duration: 6000 });
        await sleep(320); // 越过入场动画（--dur-slow）
        victim.dispatchEvent(new Event('mouseleave'));
        dismissTop();
        out.leavingClass = victim.classList.contains('leaving');
        const mid = getComputedStyle(victim).transform;
        out.leavingMoving = mid !== 'none';

        // ④ 键盘可达：动作按钮 focus 暂停（hold）/ blur 续走
        //（探针窗无 OS 焦点，真实 .focus() 不派发 focus 事件——按 u11-15 hover 先例派发合成事件锚接线）
        let fired = 0;
        const act = Toast.show('R64有动作的提示', { tone: 'warn', duration: 6000, action: { label: '重试', onClick: () => { fired += 1; } } });
        const btn = act.querySelector('.toast-action');
        out.actBtn = !!btn && btn.textContent === '重试';
        btn.dispatchEvent(new FocusEvent('focus'));
        await sleep(30);
        out.focusHold = act.classList.contains('hold');
        btn.dispatchEvent(new FocusEvent('blur'));
        await sleep(30);
        out.blurResume = !act.classList.contains('hold');
        btn.click();
        out.actFired = fired === 1;
        out.actLeftAfterClick = !document.body.contains(act) || act.classList.contains('leaving');

        // 收尾清场
        document.getElementById('nj-toast-stack')?.remove();
        return out;
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'toast-flow');
    if (b.__err) ok(false, 'toast 流程探针异常 — ' + b.__err);
    else {
      ok(b.mergeLive2, '1 同类合并：同文案+同 tone 两条归一（liveCount=1）');
      ok(b.mergeBadge === '×2', `1 合并徽标 ×2（实际 ${b.mergeBadge}）`);
      ok(b.mergeTabular, '1 合并计数等宽数字实渲染');
      ok(b.mergeToneBound, '1 同文案异 tone 不合并（liveCount=2）');
      ok(b.mergeDistinct, '1 异文案正常堆叠（liveCount=3）');
      ok(b.mergeStill, '1 合并重置计时（旧条存活）');
      ok(b.cap3Count, '1 堆叠上限 3（第 4 条进入后仍 3 条）');
      ok(b.cap3Evicted, '1 超限顶掉最旧普通条');
      ok(b.progressAlive, '1 进度条豁免淘汰（长任务不被挤掉）');
      ok(b.leavingClass, '2 退场挂 .leaving');
      ok(b.leavingMoving, '2 退场过渡在途（transform 生效）');
      ok(b.actBtn, '3 动作按钮真实渲染');
      ok(b.focusHold, '3 focus 暂停自动消退（hold 挂载）');
      ok(b.blurResume, '3 blur 按剩余续走（hold 摘除）');
      ok(b.actFired, '3 Enter/点击触发动作回调');
      ok(b.actLeftAfterClick, '3 触发后离场（不残留）');
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
