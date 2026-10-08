'use strict';
/**
 * diag-auditfix-ui.js — UI 视觉层审查修复探针（auditfix 轮）
 *
 * 覆盖：
 *  ① 阅读进度线：轨道计算高度>0 且有背景；填充宽度 0→100% 单调生效（transform/transition 各归位）
 *  ② 四处 materialize 入场动画计算样式不再是 none（修 var(--ease-out)-out 非法缓动）
 *  ③ account 卡片暗态：body.dark 下背景切换为暗态令牌（不再白卡）
 *  ④ accent-ink：注入亮 accent 主题后主按钮 color === 引擎产出的 --accent-ink；清除后回退 #f6f2e7
 *  ⑤ 引擎透明阶梯 0.92/0.66/0.54 + auditPalette 新增 secondary/tertiary 合成色两档检测（含故意坏例）
 *  ⑥ --font-serif 栈首为内置字体家族 'LXGW WenKai Screen'
 *  ⑦ er-tick 悬停波浪：过渡属性含 transform 且不再含 height；--wave 生效为 scaleY
 *  ⑧ knowledge 趋势 canvas 颜色随 --accent 令牌变化（mock 主题切换后重绘颜色改变）
 * 另附源码级护栏（ease-out)-out / 重复规则 / account fallback / 内置栈首）。
 * 退出码 0=PASS，非 0=FAIL。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-auditfix-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 180 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

const ROOT = path.join(__dirname, '..');

app.whenReady().then(async () => {
  try {
    // ── 源码级护栏 ──
    const cssSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'robin.css'), 'utf8');
    const acctSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'account.css'), 'utf8');
    const kbSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'views', 'knowledge.js'), 'utf8');
    ok(!cssSrc.includes('var(--ease-out)-out'), '源码：robin.css 无 var(--ease-out)-out 非法缓动');
    ok((cssSrc.match(/\.nj-lightbox-save \{/g) || []).length === 1, '源码：.nj-lightbox-save 规则仅一份（重复已删）');
    ok(!acctSrc.includes('--bg-surface, rgba(255, 255, 255'), '源码：account.css 不再以白卡作 --bg-surface 回退');
    ok(acctSrc.includes('body.dark .acct-identity'), '源码：account.css 含 body.dark 暗态规则');
    ok((cssSrc.match(/var\(--accent-ink, #f6f2e7\)/gi) || []).length >= 12, '源码：accent-ink 消费点 ≥12 处');
    ok(/^ {2}--font-serif: "LXGW WenKai Screen",/m.test(cssSrc), '源码：--font-serif 栈首为 LXGW WenKai Screen');
    ok(!kbSrc.includes('stop-color="#617357"') && !kbSrc.includes("'#d4a834'}"), '源码：knowledge.js 渐变/描边不再写死主题色');

    const win = new BrowserWindow({
      show: false, width: 1440, height: 900,
      webPreferences: { contextIsolation: true, backgroundThrottling: false },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(700);
    win.webContents.on('console-message', (e, level, msg) => { if (level >= 2) console.log('PAGE', String(msg).slice(0, 220)); });
    const run = (tag, js) => {
      console.log('PHASE ' + tag);
      return win.webContents.executeJavaScript(`(async () => { try { ${js} } catch (e) { return { __err: String(e && e.stack || e) }; } })()`);
    };
    const check = (r, pairs) => {
      if (r && r.__err) throw new Error('page: ' + r.__err);
      for (const [key, label] of pairs) ok(r && r[key], label + (r ? '' : '（无结果）'));
    };

    // ── ① 阅读进度线 ──
    const p1 = await run('progress', `
      const track = document.getElementById('reading-progress');
      const fill = track ? track.querySelector('.reading-progress-fill') : null;
      if (!track || !fill) return { hasDom: false };
      const cs = getComputedStyle(track);
      const nums = (cs.backgroundColor.match(/[\\d.]+/g) || []).map(Number);
      const alpha = nums.length >= 4 ? nums[3] : (cs.backgroundColor === 'transparent' ? 0 : 1);
      // 填充测量：临时关过渡，验证 width 生效且单调
      const prevTransition = fill.style.transition;
      fill.style.transition = 'none';
      const widths = [];
      for (const pct of ['0%', '25%', '50%', '75%', '100%']) {
        fill.style.width = pct;
        widths.push(Math.round(fill.getBoundingClientRect().width * 10) / 10);
      }
      fill.style.transition = prevTransition;
      const monotonic = widths.every((w, i) => i === 0 || w > widths[i - 1]);
      const trackW = Math.round(track.getBoundingClientRect().width);
      const csFill = getComputedStyle(fill);
      const fillTrans = csFill.transitionProperty || '';
      const fillBgNums = (csFill.backgroundColor.match(/[\\d.]+/g) || []).map(Number);
      const fillAlpha = fillBgNums.length >= 4 ? fillBgNums[3] : (csFill.backgroundColor === 'transparent' ? 0 : 1);
      return {
        hasDom: true,
        heightPx: track.getBoundingClientRect().height,
        hasBg: alpha > 0.05 && (nums[0] + nums[1] + nums[2]) > 0,
        trackW, widths, monotonic,
        fillFull: Math.abs(widths[widths.length - 1] - trackW) <= 1.5,
        fillHasBg: fillAlpha > 0.15,
        fillTransWidth: fillTrans === 'all' || fillTrans.split(',').map(s => s.trim()).includes('width'),
        pctBubble: (() => { track.dataset.pct = '42%'; return (getComputedStyle(track, '::after').content || '').includes('42%'); })(),
      };
    `);
    check(p1, [
      ['hasDom', '① 进度线 DOM：轨道 + 填充子元素在册'],
    ]);
    if (p1 && p1.hasDom) {
      ok(p1.heightPx >= 2 && p1.heightPx <= 3, `① 轨道计算高度 2-3px（实际 ${p1.heightPx}px）`);
      ok(p1.hasBg, '① 轨道有背景（color-mix accent 家族）');
      ok(p1.trackW > 400, `① 轨道满宽铺开（${p1.trackW}px）`);
      ok(p1.monotonic, `① 填充宽度随 style.width 单调变化（${JSON.stringify(p1.widths)}）`);
      ok(p1.fillFull, '① 填充 100% 时贴合轨道全宽');
      ok(p1.fillHasBg, '① 填充自身有更强背景');
      ok(p1.fillTransWidth, '① 填充带 width transition（渐进填充）');
      ok(p1.pctBubble, '① 端点百分比气泡 ::after 挂 data-pct（42% 可见）');
    }

    // ── ② 四组入场动画 ──
    const p2 = await run('animations', `
      const made = ['nj-selection-actions', 'nj-hl-menu', 'nj-note-editor', 'annot-panel'].map((cls) => {
        const el = document.createElement('div');
        el.className = cls;
        document.body.appendChild(el);
        const name = getComputedStyle(el).animationName;
        const dur = getComputedStyle(el).animationDuration;
        el.remove();
        return { cls, name, dur };
      });
      return { made, allLive: made.every((x) => x.name !== 'none' && parseFloat(x.dur) > 0) };
    `);
    check(p2, [['allLive', '② 四组 materialize 动画计算样式非 none（缓动已修复）']]);
    for (const x of (p2 && p2.made) || []) ok(x.name === 'materialize', `② .${x.cls} animationName=${x.name}`);

    // ── ③ account 暗态 ──
    const p3 = await run('account-dark', `
      const card = document.createElement('div');
      card.className = 'acct-identity';
      document.body.appendChild(card);
      const rgb = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
      const lightBg = rgb(getComputedStyle(card).backgroundColor);
      document.body.classList.add('dark');
      const darkBg = rgb(getComputedStyle(card).backgroundColor);
      const qr = document.createElement('div'); qr.className = 'acct-pay-qrbox'; document.body.appendChild(qr);
      const qrBg = rgb(getComputedStyle(qr).backgroundColor);
      qr.remove();
      document.body.classList.remove('dark');
      card.remove();
      const darkish = darkBg.length === 3 && darkBg.every((v) => v < 70);
      return { lightBg, darkBg, qrBg, differs: JSON.stringify(lightBg) !== JSON.stringify(darkBg), darkish, qrWhite: qrBg.every((v) => v > 230) };
    `);
    check(p3, [
      ['differs', '③ account 卡片背景随暗态切换（不再恒为 fallback 白卡）'],
      ['darkish', `③ 暗态卡片底为暗色令牌（rgb=${JSON.stringify(p3 && p3.darkBg)}）`],
      ['qrWhite', '③ 支付二维码 qrbox 白底保留'],
    ]);

    // ── ⑥ 字体栈首 + 默认 accent-ink 回退 ──
    const p6 = await run('font-ink-default', `
      const serif = getComputedStyle(document.documentElement).getPropertyValue('--font-serif').trim();
      const btn = document.createElement('button'); btn.className = 'btn-text primary'; document.body.appendChild(btn);
      const fbColor = getComputedStyle(btn).color;
      btn.remove();
      return { serif, headWenkai: serif.startsWith('"LXGW WenKai Screen"'), fbColor };
    `);
    check(p6, [
      ['headWenkai', `⑥ --font-serif 栈首为内置字体（${(p6 && p6.serif || '').slice(0, 44)}…）`],
    ]);
    ok(p6 && p6.fbColor === 'rgb(246, 242, 231)', `⑥ 无主题引擎时主按钮回退 #f6f2e7（${p6 && p6.fbColor}）`);

    // ── ⑦ er-tick 波浪 ──
    const p7 = await run('er-tick', `
      const tick = document.createElement('button'); tick.className = 'er-tick';
      document.body.appendChild(tick);
      const cs = getComputedStyle(tick, '::before');
      const trans = cs.transitionProperty || '';
      const props = trans.split(',').map((s) => s.trim());
      // 隐藏窗口不产帧：transition 停在起点无法观察终值——测量态显式关掉过渡再读终值
      const noTrans = document.createElement('style');
      noTrans.textContent = '.er-tick::before { transition: none !important; }';
      document.head.appendChild(noTrans);
      tick.style.setProperty('--wave', '10');
      const tf = getComputedStyle(tick, '::before').transform;
      const waveSeen = getComputedStyle(tick, '::before').getPropertyValue('--wave').trim();
      tick.remove();
      noTrans.remove();
      const m = /matrix\\(([-\\d.e]+), ([-\\d.e]+), ([-\\d.e]+), ([-\\d.e]+)/.exec(tf || '');
      const scaleY = m ? Number(m[4]) : 0;
      return { props, hasTransform: props.includes('transform'), noHeight: !props.includes('height'), tf, scaleY, waveSeen };
    `);
    check(p7, [
      ['hasTransform', `⑦ er-tick 过渡属性含 transform（${(p7 && p7.props || []).join(',')}）`],
      ['noHeight', '⑦ er-tick 过渡不再含 height（不触发 layout）'],
    ]);
    ok(p7 && p7.scaleY > 1.5 && p7.scaleY < 3.01, `⑦ --wave=10 → scaleY≈2.25 合成缩放（实际 ${p7 && p7.scaleY}）`);

    // ── ⑤ 引擎阶梯 + auditPalette 两档合成检测（渲染进程内跑模块） ──
    const p5 = await run('engine-ladder', `
      const te = await import('./views/theme-engine.js');
      const palDef = te.fullPalette(te.defaultTokens('light'));
      const sec = palDef['--text-secondary'];
      const ter = palDef['--text-tertiary'];
      const audits = te.auditPalette(palDef);
      const secRow = audits.find((r) => r.label.includes('次级'));
      const terRow = audits.find((r) => r.label.includes('三级'));
      const bad = te.auditPalette({ ...palDef, '--text-secondary': 'rgba(250, 248, 240, 0.66)', '--text-tertiary': 'rgba(250, 248, 240, 0.54)' });
      const badSec = bad.find((r) => r.label.includes('次级'));
      const badTer = bad.find((r) => r.label.includes('三级'));
      return {
        primary092: palDef['--text-primary'].includes('0.92'),
        sec066: sec.includes('0.66'), sec,
        ter054: ter.includes('0.54'), ter,
        hasRows: !!secRow && !!terRow,
        secRatio: secRow ? secRow.ratio : 0, secPass: secRow ? secRow.pass : false, secHex: secRow ? secRow.fg : '',
        terRatio: terRow ? terRow.ratio : 0, terPass: terRow ? terRow.pass : false, terHex: terRow ? terRow.fg : '',
        badRejected: !!badSec && badSec.pass === false && !!badTer && badTer.pass === false,
      };
    `);
    if (p5 && p5.__err) throw new Error('engine-ladder: ' + p5.__err);
    ok(p5 && p5.primary092, '⑤ primary 阶梯保持 0.92');
    ok(p5 && p5.sec066, `⑤ secondary 阶梯对齐 0.66（${p5 && p5.sec}）`);
    ok(p5 && p5.ter054, `⑤ tertiary 阶梯对齐 0.54（${p5 && p5.ter}）`);
    ok(p5 && p5.hasRows, '⑤ auditPalette 新增 secondary/tertiary 合成两档');
    if (p5 && p5.hasRows) {
      ok(p5.secPass && p5.secRatio >= 4.5, `⑤ 默认纸感主题 次级合成 ≥4.5（${p5.secRatio.toFixed(2)}:1）`);
      ok(p5.terPass && p5.terRatio >= 3.0, `⑤ 默认纸感主题 三级合成 ≥3.0（${p5.terRatio.toFixed(2)}:1）`);
      ok(/^#[0-9a-f]{6}$/i.test(p5.secHex) && /^#[0-9a-f]{6}$/i.test(p5.terHex), `⑤ 合成色为不透明 hex（${p5.secHex} / ${p5.terHex}）`);
    }
    ok(p5 && p5.badRejected, '⑤ 故意坏例：近纸色的合成色被两档检测判不达标');

    // ── ④ accent-ink 注入与清除 ──
    const p4 = await run('accent-ink', `
      const te2 = await import('./views/theme-engine.js');
      const bright = te2.normalizeTokens({ th: 100, th2: 30, ths: 90, c1: 0.12, c2: 0.09, sc: 0.02, l1: 0.85, l2: 0.6, bg: 0.95, tx: 0.16, sb: 0.93, mode: 'light' });
      const pal = te2.fullPalette(bright);
      te2.applyPalette(pal);
      const btn = document.createElement('button'); btn.className = 'btn-text primary'; document.body.appendChild(btn);
      const btnColor = getComputedStyle(btn).color;
      const ref = document.createElement('div'); ref.style.color = pal['--accent-ink']; document.body.appendChild(ref);
      const refColor = getComputedStyle(ref).color;
      const ratio = te2.contrastRatio(pal['--accent-ink'], pal._meta.accent);
      te2.clearPalette();
      btn.style.transition = 'none'; /* U12 起 color 参与过渡——同步读会拿到过渡起点，断言终态前先关过渡 */
      const afterClear = getComputedStyle(btn).color;
      btn.remove(); ref.remove();
      const nums = (btnColor.match(/[\\d.]+/g) || []).map(Number);
      return { btnColor, refColor, equal: btnColor === refColor, ratio, afterClear, darkInk: nums.slice(0, 3).every((v) => v < 110) };
    `);
    check(p4, [
      ['equal', `④ 亮 accent 主题下主按钮 color === 引擎 --accent-ink（${p4 && p4.btnColor}）`],
      ['darkInk', '④ 亮 accent → accent-ink 翻转为深墨（onAccent 逻辑）'],
    ]);
    ok(p4 && p4.ratio >= 3, `④ accent-ink 对 accent 对比 ≥3（${p4 && p4.ratio.toFixed(2)}:1）`);
    ok(p4 && p4.afterClear === 'rgb(246, 242, 231)', `④ clearPalette 后回退默认纸墨（${p4 && p4.afterClear}）`);

    // ── ⑧ knowledge canvas 令牌色（放最后：mock body 内联 --accent） ──
    const p8 = await run('kb-canvas', `
      const kb = await import('./views/knowledge.js');
      if (!window.robin) window.robin = { kbStatsExtras: async () => null }; // 无 preload 窗口的桥桩
      // 隐藏窗口不产帧 → rAF 永不触发（趋势图在 rAF 里绘制）。探针内将 rAF 降级为定时器，
      // 只为让绘制回调执行——颜色断言与帧调度无关。
      const origRaf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;top:0;left:0;width:880px;';
      document.body.appendChild(host);
      const kc = Object.create(kb.KnowledgeCenter.prototype);
      kc.contentHost = host;
      const heat = {};
      for (let i = 0; i < 6; i += 1) {
        const d = new Date(Date.now() - i * 86400000);
        const key = d.toISOString().slice(0, 10);
        heat[key] = { read: 3 + i, highlights: i, notes: 1 };
      }
      const dist = (a, b) => Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2);
      const scan = (canvas, target) => {
        const ctx = canvas.getContext('2d');
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let best = 1e9, vivid = 0, opaque = 0;
        for (let i = 3; i < data.length; i += 16) {
          if (data[i] > 40) opaque += 1;
          const r = data[i - 3], g = data[i - 2], b = data[i - 1];
          if (Math.max(r, g, b) - Math.min(r, g, b) < 60) continue; // 跳过低饱和（网格/底色）
          vivid += 1;
          const d = dist([r, g, b], target);
          if (d < best) best = d;
        }
        return { best: Math.round(best), vivid, opaque, w: canvas.width, h: canvas.height };
      };
      const A = [0, 0, 255], B = [255, 0, 0];
      document.body.style.setProperty('--accent', 'rgb(0, 0, 255)');
      kc._renderDashboard({ heat, goal: 5, streak: 2 });
      await new Promise((r2) => setTimeout(r2, 300));
      const c1 = host.querySelector('.kb-spark-canvas');
      if (!c1) return { hasCanvas: false };
      const s1 = scan(c1, A);
      host.innerHTML = '';
      document.body.style.setProperty('--accent', 'rgb(255, 0, 0)');
      const kc2 = Object.create(kb.KnowledgeCenter.prototype);
      kc2.contentHost = host;
      kc2._renderDashboard({ heat, goal: 5, streak: 2 });
      await new Promise((r2) => setTimeout(r2, 300));
      const c2 = host.querySelector('.kb-spark-canvas');
      const s2B = c2 ? scan(c2, B) : { best: 9999, vivid: 0 };
      const s2A = c2 ? scan(c2, A) : { best: 9999, vivid: 0 };
      document.body.style.removeProperty('--accent');
      host.remove();
      window.requestAnimationFrame = origRaf;
      return {
        hasCanvas: true,
        dA1: s1.best, dB2: s2B.best, dA2: s2A.best,
        dbg1: s1, dbg2: s2B,
      };
    `);
    check(p8, [['hasCanvas', '⑧ 知识看板趋势 canvas 渲染在册']]);
    if (p8 && p8.hasCanvas) {
      ok(p8.dA1 < 60, `⑧ 主题 A(--accent 蓝) 下 canvas 描边命中令牌色（dist=${p8.dA1}）`);
      ok(p8.dB2 < 60, `⑧ 切主题 B(--accent 红) 重绘后命中新令牌色（dist=${p8.dB2}）`);
      ok(p8.dA2 > 120, `⑧ 旧主题色已随重绘消失（对 A 残留 dist=${p8.dA2}）`);
    }

    if (failed) { console.error(failed + ' 项失败'); app.exit(1); }
    else { console.log('ALL PASSED'); app.exit(0); }
  } catch (e) {
    console.error('ERR', String(e && e.stack || e).slice(0, 1200));
    app.exit(1);
  }
});
