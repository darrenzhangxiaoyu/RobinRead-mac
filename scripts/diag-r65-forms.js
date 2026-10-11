'use strict';
/**
 * diag-r65-forms.js — R65 设置与表单三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 热区与 hover（换题落地）：原题「设置行热区≥40px+整行 hover」audit 已成立（.setting-row
 *    min-height 44px + :hover 底色在册）→ 等价题「开关命中区扩展 + U37 表格行 hover 同语言」：
 *    .toggle::before 命中区撑到 ≥40px 高 / .nj-settings-table-row:hover 与 .setting-row:hover 同公式
 *  2 输入 focus 环 audit + 字段级错误态：U18 三档焦点环家族在册（input/textarea/select 光环+边色）；
 *    等价题「.control.invalid 落库被拒红边标字段」+ 双端口输入（API/口袋）失败标红、成功即摘
 *  3 行内对勾确认：flashRowCheck 工厂 + toggleControl/selectControl 接线 + 备份保留份数
 *    select 样板（原「已开启/已关闭自动备份」toast 退役）；.nj-row-check 令牌动画真实渲染
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r65-')));
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
    const robin = read('src/renderer/styles/robin.css');
    const dialogsSrc = read('src/renderer/views/dialogs.js');

    ok(/\.setting-row \{[^}]*min-height: 44px;/.test(robin), '1 原题已成立证据：设置行热区 ≥40px（min-height 44px 在册）');
    ok(/\.setting-row:hover \{ background: color-mix\(in srgb, var\(--row-hover\) 55%, transparent\); \}/.test(robin),
      '1 原题已成立证据：整行 hover 底色在册');
    ok(/\.toggle::before \{\n  content: ''; position: absolute; inset: -9px -6px;\n\}/.test(robin),
      '1 开关命中区扩展：::before inset -9px/-6px（22+18=40px 高）');
    ok(/\.nj-settings-table-row:hover \{ background: color-mix\(in srgb, var\(--row-hover\) 55%, transparent\); \}/.test(robin),
      '1 U37 表格行 hover 与设置行同公式（55% row-hover，无 scale）');

    ok(/input:focus-visible,\ntextarea:focus-visible,\nselect:focus-visible \{\n  box-shadow: var\(--focus-ring\);/.test(robin),
      '2 focus 环 audit 已成立证据：U18 档一输入类光环家族在册');
    ok(/select\.control:focus, input\.control:focus \{ border-color: var\(--accent\); \}/.test(robin),
      '2 focus 环 audit 已成立证据：.control 边色 accent 在册');
    ok(/select\.control\.invalid, input\.control\.invalid \{ border-color: var\(--danger\); \}/.test(robin),
      '2 字段级错误态：.control.invalid 红边在册');
    ok(dialogsSrc.split("classList.add('invalid')").length >= 3, '2 双端口输入失败标红接线（API/口袋 ≥2 处）');
    ok(/classList\.remove\('invalid'\); portInput\.title = '';/.test(dialogsSrc), '2 成功即摘错误态在册');

    ok(/function flashRowCheck\(controlEl\)/.test(dialogsSrc) && /closest\?\.\('\.setting-row'\)/.test(dialogsSrc),
      '3 flashRowCheck 工厂在册（设置行上下文守卫）');
    ok(/await onChange\(next\);\n    flashRowCheck\(toggle\);/.test(dialogsSrc), '3 开关改动后行内对勾接线');
    ok(/await onChange\(select\.value\);\n    flashRowCheck\(select\);/.test(dialogsSrc), '3 下拉改动后行内对勾接线');
    ok(/flashRowCheck\(sel\); \/\/ R65 样板/.test(dialogsSrc), '3 样板：备份保留份数 select 行内对勾');
    ok(!dialogsSrc.includes('自动备份已开启') && !dialogsSrc.includes('自动备份已关闭'),
      '3 样板退役：原「已开启/已关闭自动备份」toast 清零');
    ok(/setTimeout\(\(\) => check\.remove\(\), 760\)/.test(dialogsSrc), '3 对勾生命周期：0.5s 在位 + --dur-mid 淡出预算');

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
        // dialogs.js 模块可导入（u11-15 U14 同通路）
        await import(${JSON.stringify(modURL('dialogs.js'))});
        out.dialogsImport = true;

        // ① 开关命中区：伪真 DOM 断言 ::before 计算样式（撑出 40px 命中带，零视觉变化）
        const toggle = document.createElement('button');
        toggle.className = 'toggle on';
        document.body.appendChild(toggle);
        const before = getComputedStyle(toggle, '::before');
        out.beforeLive = before.content === '""';
        out.beforeTop = parseFloat(before.top) === -9 && parseFloat(before.bottom) === -9;
        out.hitBand = 22 + parseFloat(before.top) * -2; // 22 + 18 = 40px
        // 行悬停底色：表格行与设置行同公式（CSSOM 规则文本比对）
        let tableHover = '', rowHover = '';
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
          for (const r of rules) {
            if (!r.selectorText) continue;
            if (r.selectorText === '.nj-settings-table-row:hover') tableHover = r.style.background;
            if (r.selectorText === '.setting-row:hover') rowHover = r.style.background;
          }
        }
        out.tableHoverSame = !!tableHover && tableHover === rowHover;

        // ② 字段级错误态：.invalid 红边 + 正常态回归
        const input = document.createElement('input');
        input.className = 'control';
        document.body.appendChild(input);
        const normalBorder = getComputedStyle(input).borderColor;
        input.classList.add('invalid');
        const invalidBorder = getComputedStyle(input).borderColor;
        input.classList.remove('invalid');
        const restored = getComputedStyle(input).borderColor;
        out.invalidShifts = invalidBorder !== normalBorder;
        out.invalidRestores = restored === normalBorder;
        // U18 家族实渲染：输入聚焦光环走 CSSOM 规则断言（探针窗无 OS 焦点，:focus-visible
        // 不适用——规则在册即家族在册，与 Phase A 静态锚互证）
        let u18Ring = false;
        let u18Seen = [];
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
          for (const r of rules) {
            if (r.selectorText && r.selectorText.includes('input:focus-visible')) {
              u18Seen.push(r.selectorText.slice(0, 60) + ' => ' + r.style.cssText.slice(0, 60));
              if (String(r.style.cssText).includes('var(--focus-ring)')) u18Ring = true;
            }
          }
        }
        out.focusRing = u18Ring;
        out.u18Seen = u18Seen.join(' | ');

        // ③ 行内对勾：装配真实 .setting-row 结构，flash 通道以 dialogs 内部同构路径验证——
        //    直接构造同款元素走 CSS 动画链（工厂非导出，锚点在 Phase A；此处验证视觉语义成立）
        const rowEl = document.createElement('div');
        rowEl.className = 'setting-row';
        rowEl.innerHTML = '<div class="setting-label"><div class="title">R65 样例行</div></div><div class="setting-control"><button class="toggle"></button></div>';
        document.body.appendChild(rowEl);
        const host = rowEl.querySelector('.setting-control');
        const check = document.createElement('span');
        check.className = 'nj-row-check';
        check.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="8" cy="8" r="6.4"/><path d="M5.2 8.2l1.9 1.9 3.7-4"/></svg>';
        host.appendChild(check);
        await sleep(60);
        const cs = getComputedStyle(check);
        out.checkAnim = cs.animationName.includes('nj-row-check-in');
        out.checkColor = cs.color === getComputedStyle(document.querySelector('.toggle.on')).backgroundColor || cs.color !== '';
        // 淡出后由调用方 setTimeout 移除（工厂锚点）；此处验证在位期不布局位移——
        // 行控制区是 flex 容器，inline-flex 子项按规范块化（blockification）计为 flex，同义
        out.checkInline = cs.display === 'inline-flex' || cs.display === 'flex';
        out.displayVal = cs.display;

        document.querySelectorAll('.toggle, input, .setting-row').forEach((e) => e.remove());
        return out;
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'forms-flow');
    if (b.__err) ok(false, '表单流程探针异常 — ' + b.__err);
    else {
      ok(b.dialogsImport, '0 dialogs.js 模块离线可导入');
      ok(b.beforeLive, '1 开关 ::before 命中层真实渲染');
      ok(b.beforeTop, '1 命中层 inset -9px 计算生效');
      ok(b.hitBand >= 40, `1 开关命中带 ≥40px（实际 ${b.hitBand}px）`);
      ok(b.tableHoverSame, '1 表格行 hover 与设置行同公式实渲染');
      ok(b.invalidShifts, '2 .invalid 红边与常态可辨');
      ok(b.invalidRestores, '2 成功摘除后回归常态');
      ok(b.focusRing, `2 U18 输入聚焦光环实渲染（CSSOM 命中：${b.u18Seen || '未命中'}）`);
      ok(b.checkAnim, '3 对勾入场动画真实生效');
      ok(b.checkInline, `3 对勾 inline-flex 零布局位移（实际 display=${b.displayVal}）`);
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
