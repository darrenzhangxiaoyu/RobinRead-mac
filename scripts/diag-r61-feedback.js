'use strict';
/**
 * diag-r61-feedback.js — R61 反馈语义三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 toast 成功/失败图标与色语义统一：成功=绿勾（--accent）/ 警告=暖赭三角（--warm-accent）/
 *    失败=暖红叹号（--danger，新图标 + 语义色令牌，与 warn 一望可辨）；
 *    兼容包装支持 { tone } 选项；全库失败路径 audit（失败关键词 toast 零裸调用）
 *  2 破坏性确认框主按钮统一警示色：.modal-footer .btn-text.danger 警示填充；
 *    全库破坏性 confirmBox audit（删除/停止/断开/重置类确认 danger:true 齐备——
 *    含话题删除 confirmLabel 键名失效真 bug 修复）；UI 实证警示填充生效
 *  3 收藏星 / 稍后读时钟点亮 pop 对称：later-pop 与 star-pop 同节奏同拍（关键帧逐字比对），
 *    计算样式实证两态动画名/时长一致
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r61-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

/** 抓取 @keyframes 体（归一空白后逐字比对用；单行/多行声明均兼容）。 */
function keyframesBody(css, name) {
  const re = new RegExp('@keyframes ' + name + '\\s*\\{((?:[^{}]*\\{[^{}]*\\})*[^{}]*)\\}');
  const m = css.match(re);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

app.whenReady().then(async () => {
  try {
    const css = read('src/renderer/styles/robin.css');
    const toastSrc = read('src/renderer/views/toast.js');
    const appSrc = read('src/renderer/app.js');
    const dialogsSrc = read('src/renderer/views/dialogs.js');
    const uiPromptSrc = read('src/renderer/ui-prompt.js');
    const topicSrc = read('src/renderer/views/topic-view.js');

    // ── 1. toast 语义统一 ──
    ok(/error: '<svg[^]+M8 4\.6v4[^]+11\.2/.test(toastSrc) && !toastSrc.includes('l4.4 4.4'),
      '1 失败图标=暖红叹号（圆底+叹号，叉形退役）');
    ok(/success: '<svg[^]+l1\.9 1\.9 3\.7-4/.test(toastSrc), '1 成功图标=绿勾（圆底+对勾，保持）');
    ok(/warn: '<svg[^]+M8 2\.4L14\.4 13\.3/.test(toastSrc), '1 警告图标=三角叹号（保持）');
    ok(/\.toast-capsule\.error \{ border-left: 3px solid var\(--danger\); \}/.test(css)
      && /\.toast-capsule\.error \.toast-ic \{ color: var\(--danger\); \}/.test(css),
      '1 失败态色走 --danger 语义令牌（边条+图标）');
    ok(!/\.toast-capsule\.error[^}]*warm-accent/.test(css), '1 失败态与警告态混色退役（一望可辨）');
    ok(/typeof duration === 'object'/.test(appSrc) && /tone: opts\.tone/.test(appSrc),
      '1 app 兼容包装支持 { tone } 选项对象');
    ok(/typeof duration === 'object'/.test(dialogsSrc), '1 设置弹层包装支持 { tone } 选项对象');
    // 全库失败路径 audit：失败关键词的 toast 调用必须带 tone（error/warn）
    const failKeyword = /失败|打不开|稍后再试|不可用|需要会员|未配置|没有正在阅读|先打开一篇文章/;
    const callRe = /(toast\?\.\(|toast\)\(|toast\(|showToast\()/;
    const bare = [];
    const files = ['src/renderer/app.js'].concat(fs.readdirSync(path.join(ROOT, 'src/renderer/views'))
      .filter((f) => f.endsWith('.js')).map((f) => 'src/renderer/views/' + f));
    for (const f of files) {
      const lines = read(f).split('\n');
      lines.forEach((line, i) => {
        if (callRe.test(line) && failKeyword.test(line) && !/tone: '(error|warn)'/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
          bare.push(`${f}:${i + 1}`);
        }
      });
    }
    ok(bare.length === 0, `1 失败路径 toast 全量带语义 tone（裸调用 ${bare.length} 处${bare.length ? '：' + bare.slice(0, 4).join(' ') : ''}）`);
    const toneErrCount = files.reduce((n, f) => n + (read(f).match(/tone: 'error'/g) || []).length, 0);
    ok(toneErrCount >= 25, `1 失败语义已落地（tone:'error' ${toneErrCount} 处）`);

    // ── 2. 破坏性确认警示色 ──
    ok(/\.modal-footer \.btn-text\.danger \{[^}]*color-mix\(in srgb, var\(--danger\) 14%[^}]*\}/.test(css.replace(/\n/g, ' ')),
      '2 破坏性确认主按钮警示填充在册（danger 14% 底 + 52% 边）');
    ok(/danger \? 'danger' : 'primary'/.test(uiPromptSrc), '2 confirmBox danger 开关在册（ui-prompt 合同）');
    ok(/okLabel: t\('删除'\),\s*\n\s*danger: true, \/\/ R61：破坏性确认主按钮统一警示色（原 confirmLabel 键名不被读取/.test(topicSrc),
      '2 话题删除确认修复（confirmLabel 键名失效真 bug → okLabel + danger）');
    ok(!/confirmLabel:/.test(topicSrc), '2 confirmLabel 幽灵键全库清零（话题）');
    ok(/停止追更'\), \{ message: t\('停止后将不再自动抓取该网页，已有文章保留。'\), okLabel: t\('停止'\), danger: true \}/.test(appSrc),
      '2 停止追更确认入 danger 组');
    ok(/重新生成令牌\？'\), \{[^}]*danger: true/.test(dialogsSrc), '2 重新生成令牌确认入 danger 组（旧令牌即刻失效）');
    // audit：全库删除类确认框 danger 覆盖率（「删除X」标题的 confirmBox 必须 danger:true）
    let delTotal = 0, delDanger = 0;
    for (const f of files) {
      const src = read(f);
      const re = /confirmBox\(t\('删除[^']*'\),\s*\{([\s\S]{0,300}?)\}\);/g;
      let m;
      while ((m = re.exec(src))) {
        delTotal += 1;
        if (m[1].includes('danger: true')) delDanger += 1;
      }
    }
    ok(delTotal > 0 && delDanger === delTotal, `2 删除类确认框 danger 覆盖 ${delDanger}/${delTotal}`);

    // ── 3. pop 家族对称 ──
    ok(/\.entry-row \.later-mini \{ animation: later-pop var\(--dur-mid\) var\(--ease-out\); transform-origin: center; \}/.test(css),
      '3 稍后读时钟点亮动画在册（与 star-mini 同拍声明）');
    const starBody = keyframesBody(css, 'star-pop');
    const laterBody = keyframesBody(css, 'later-pop');
    ok(starBody && laterBody && starBody === laterBody,
      `3 later-pop 与 star-pop 关键帧逐字一致（0.4→1.3→1 同节奏）`);

    // ── UI 行为断言 ──
    const win = new BrowserWindow({
      show: false, width: 1440, height: 900,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1200);

    const exec = (js, label, ms = 30000) => Promise.race([
      win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
    ]);

    const flow = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const { showToast } = await import('./views/toast.js');
        const { confirmBox } = await import('./ui-prompt.js');
        // toast 三态
        const errEl = showToast('失败样本', { tone: 'error' });
        const warnEl = showToast('警告样本', { tone: 'warn' });
        const okEl = showToast('成功样本');
        await sleep(80);
        const icColor = (el) => getComputedStyle(el.querySelector('.toast-ic')).color;
        const out = {
          errCls: errEl.className, warnCls: warnEl.className, okCls: okEl.className,
          errIcon: errEl.querySelector('.toast-ic').innerHTML.includes('M8 4.6v4'),
          errColor: icColor(errEl), warnColor: icColor(warnEl), okColor: icColor(okEl),
        };
        errEl.remove(); warnEl.remove(); okEl.remove();
        // 破坏性确认警示填充
        let dlg = null;
        const p = confirmBox('删除测试', { message: 'x', okLabel: '删除', danger: true });
        await sleep(120);
        const footer = document.querySelector('.modal-overlay .modal-footer');
        const dbtn = footer ? footer.querySelector('.btn-text.danger') : null;
        const dcs = dbtn ? getComputedStyle(dbtn) : null;
        out.dangerBtn = !!dbtn;
        out.dangerBg = dcs ? dcs.backgroundColor : '';
        out.dangerColor = dcs ? dcs.color : '';
        // 关闭确认框（点取消 resolve(false)，不悬挂）
        footer.querySelector('.btn-text:not(.danger)')?.click();
        await p.catch(() => {});
        await sleep(60);
        // pop 对称计算样式
        const row = document.createElement('div');
        row.className = 'entry-row later starred';
        row.innerHTML = '<span class="entry-meta"><span class="star-mini">★</span><span class="later-mini">◷</span></span>';
        document.body.appendChild(row);
        await sleep(60);
        out.starAnim = getComputedStyle(row.querySelector('.star-mini')).animationName + '@' + getComputedStyle(row.querySelector('.star-mini')).animationDuration;
        out.laterAnim = getComputedStyle(row.querySelector('.later-mini')).animationName + '@' + getComputedStyle(row.querySelector('.later-mini')).animationDuration;
        return out;
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'r61-flow');
    if (flow.__err) ok(false, 'UI 流程探针异常 — ' + flow.__err);
    else {
      ok(flow.errCls.includes('error'), '1 失败 toast 挂 error 态类');
      ok(flow.errIcon, '1 失败 toast 图标为叹号（真实渲染）');
      ok(flow.errColor === 'rgb(201, 59, 59)', `1 失败图标色 = --danger 亮档（实际 ${flow.errColor}）`);
      ok(flow.warnColor !== flow.errColor && flow.okColor !== flow.errColor,
        `1 三态色互异（ok=${flow.okColor} warn=${flow.warnColor} err=${flow.errColor}）`);
      ok(flow.dangerBtn, '2 破坏性确认主按钮挂 .btn-text.danger');
      // Chromium 对 color-mix 返回 color(srgb …) 计算值：danger 14% 叠 note 底 ≈ rgb(0.893, 0.808, 0.754)
      const mix = flow.dangerBg.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
      const tinted = mix && Number(mix[1]) > 0.88 && Number(mix[1]) < 0.90 && Number(mix[3]) > 0.74 && Number(mix[3]) < 0.77;
      ok(tinted, `2 警示填充生效（bg ${flow.dangerBg}）`);
      ok(flow.starAnim === 'star-pop@0.25s', `3 收藏星 pop（${flow.starAnim}）`);
      ok(flow.laterAnim === 'later-pop@0.25s', `3 稍后读时钟 pop 对称（${flow.laterAnim}）`);
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
