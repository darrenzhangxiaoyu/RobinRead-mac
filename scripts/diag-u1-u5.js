'use strict';
/**
 * diag-u1-u5.js — U1–U5 视觉轮探针（run-all OFFLINE 集）
 * U1 设计令牌大整编：--shadow-1/2/3 三档在册 + 旧阴影字面量残留 ≤3
 * U2 动效体系：四档时长令牌 + 三曲线缓动在册 + 裸 transition/animation 秒数残留 ≤5（循环/延迟/令牌定义豁免）
 * U3 侧栏：折叠高度过渡（grid-template-rows）/订阅行 hover 4px 指示条/徽标胶囊 tabular-nums/选中态层次（真实渲染窗口）
 * U4 行卡：hover 抬升 transform+shadow-1 / 未读标题加粗 / 键盘光标 accent 左条 3px + 底色 8%
 * U5 阅读排版：段落字距 / h2 小节标记 ::before / 引用块 accent 条+微染+引号 / 代码块圆角+语言标签位
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-u15-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 150 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');

app.whenReady().then(async () => {
  try {
    // ── Phase A：源码在册断言 ──────────────────────────────────────────────
    const css = ['robin.css', 'store.css', 'account.css']
      .map((f) => fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', f), 'utf8'));
    const robin = css[0];

    // U1：三档阴影令牌在册
    ok(/--shadow-1:\s*0 1px 2px rgba\(41, 38, 32, 0\.05\)/.test(robin), 'U1 --shadow-1（浮起卡片）令牌在册');
    ok(/--shadow-2:\s*0 8px 24px rgba\(35, 31, 25, 0\.16\), 0 2px 6px rgba\(35, 31, 25, 0\.08\)/.test(robin), 'U1 --shadow-2（弹层）令牌在册');
    ok(/--shadow-3:\s*0 18px 48px rgba\(20, 17, 12, 0\.22\)/.test(robin), 'U1 --shadow-3（模态）令牌在册');
    // U1：旧阴影字面量残留 ≤3（等值归簇后应清零；令牌定义行本身不计）
    const legacyShadows = [
      'box-shadow: 0 8px 24px rgba(35, 31, 25, 0.16)',
      'box-shadow: 0 18px 48px rgba(20, 17, 12, 0.28)',
      'box-shadow: 0 18px 48px rgba(35, 31, 25, 0.24)',
      'box-shadow: 0 10px 30px rgba(35, 31, 25, 0.18)',
      'box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15)',
      'box-shadow: 0 4px 12px rgba(27, 26, 23, 0.12)',
      'box-shadow: 0 2px 8px rgba(27, 26, 23, 0.12)',
      'box-shadow: 0 10px 28px rgba(40, 36, 28, 0.16)',
      'box-shadow: 0 12px 32px rgba(40, 36, 28, 0.18)',
    ];
    const shadowResidual = css.reduce((n, src) => n + legacyShadows.reduce((m, s) => m + src.split(s).length - 1, 0), 0);
    ok(shadowResidual <= 3, `U1 旧阴影字面量残留 ${shadowResidual} ≤ 3`);

    // U2：四档时长 + 三曲线令牌在册
    for (const [tok, val] of [['--dur-instant', '0.12s'], ['--dur-fast', '0.18s'], ['--dur-mid', '0.25s'], ['--dur-slow', '0.4s']]) {
      ok(new RegExp(`${tok}:\\s*${val.replace('.', '\\.')}`).test(robin), `U2 ${tok}=${val} 令牌在册`);
    }
    for (const tok of ['--ease-out', '--ease-spring', '--ease-in-out']) {
      ok(new RegExp(`${tok}:\\s*cubic-bezier\\(`).test(robin), `U2 ${tok} 缓动令牌在册`);
    }
    // U2：裸秒数残留 ≤5（豁免：infinite 循环 / animation-delay 错峰 / 令牌定义行）
    const durResidual = css.reduce((n, src) => {
      let m = 0;
      for (const line of src.split('\n')) {
        const t = line.trim();
        if (t.startsWith('--dur-') || t.includes('infinite') || t.includes('animation-delay')) continue;
        if (!/transition|animation/.test(t)) continue;
        m += (t.match(/\b0\.\d+s\b/g) || []).length;
      }
      return n + m;
    }, 0);
    ok(durResidual <= 5, `U2 裸 transition/animation 秒数残留 ${durResidual} ≤ 5（hljs 等第三方不在本库样式内）`);
    // U2：reduced-motion 全局收敛块仍在（U2 不削弱无障碍覆盖）
    ok(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{[^}]*transition-duration:\s*0\.01ms !important/.test(robin.replace(/\n/g, '\n')), 'U2 reduced-motion 全局覆盖块保持不变');

    // ── Phase B：真实渲染窗口计算样式断言 ─────────────────────────────────
    const win = new BrowserWindow({
      show: false, width: 1280, height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(900);

    const b = await win.webContents.executeJavaScript(`(() => {
      const out = {};
      const $ = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
      const host = document.createElement('div');
      document.body.appendChild(host);

      // ── U1：阴影令牌真实解析 ──
      const card1 = $('<div style="box-shadow: var(--shadow-1)"></div>');
      const card2 = $('<div style="box-shadow: var(--shadow-2)"></div>');
      const card3 = $('<div style="box-shadow: var(--shadow-3)"></div>');
      host.append(card1, card2, card3);
      const sh1 = getComputedStyle(card1).boxShadow;
      const sh2 = getComputedStyle(card2).boxShadow;
      const sh3 = getComputedStyle(card3).boxShadow;
      out.shadows = { sh1, sh2, sh3,
        ok1: sh1 !== 'none' && sh1.includes('rgba'),
        ok2: sh2.includes('8px') && sh2.includes('24px'),
        ok3: sh3.includes('18px') && sh3.includes('48px'),
        distinct: new Set([sh1, sh2, sh3]).size === 3 };

      // ── U2：时长/缓动令牌真实取值 ──
      const csRoot = getComputedStyle(document.documentElement);
      out.durs = ['--dur-instant', '--dur-fast', '--dur-mid', '--dur-slow'].map((t) => csRoot.getPropertyValue(t).trim());
      out.dursOk = out.durs.join(',') === '0.12s,0.18s,0.25s,0.4s';

      // ── U3：侧栏（真实结构：folder > children > inner > row[data-feed-id] + count 徽标）──
      const folder = $('<div class="sidebar-folder"><div class="sidebar-row sidebar-folder-row" data-folder-key="a::b"><span class="sidebar-count" style="visibility:visible">12</span></div><div class="sidebar-folder-children"><div class="sidebar-folder-inner"><div class="sidebar-row" data-feed-id="fx"><span class="sidebar-count" style="visibility:visible">7</span></div></div></div></div>');
      host.appendChild(folder);
      const kids = folder.querySelector('.sidebar-folder-children');
      const feedRowEl = folder.querySelector('[data-feed-id]');
      const gTransRaw = getComputedStyle(kids).transitionProperty; // 先读过渡属性，再关过渡测终值（隐藏窗不产帧，与 diag-auditfix-ui 同法）
      kids.style.transition = 'none';
      const gRowsOpen = getComputedStyle(kids).gridTemplateRows;
      folder.classList.add('collapsed');
      const gRowsClosed = getComputedStyle(kids).gridTemplateRows;
      const kidsOpacityClosed = getComputedStyle(kids).opacity;
      folder.classList.remove('collapsed');
      const afterBar = getComputedStyle(feedRowEl, '::after');
      const cnt = folder.querySelector('[data-feed-id] .sidebar-count');
      const cntCs = getComputedStyle(cnt);
      out.u3 = {
        gRowsOpen, gRowsClosed, kidsOpacityClosed,
        gTrans: gTransRaw,
        bar: { content: afterBar.content, width: afterBar.width, position: afterBar.position, bg: afterBar.backgroundColor, op: afterBar.opacity },
        barBgOk: afterBar.backgroundColor && afterBar.backgroundColor !== 'rgba(0, 0, 0, 0)',
        badgeRadius: cntCs.borderRadius, badgeNums: cntCs.fontVariantNumeric,
      };

      // ── U4：行卡（hover 抬升规则/未读加粗/光标左条+底色）──
      const row = $('<div class="entry-row unread"><div class="entry-body"><span class="entry-title">标题</span><span class="entry-summary">摘要</span><span class="entry-meta"><span class="entry-time">12:30</span></span></div></div>');
      host.appendChild(row);
      const titleCs = getComputedStyle(row.querySelector('.entry-title'));
      const timeCs = getComputedStyle(row.querySelector('.entry-time'));
      row.classList.add('nj-cursor');
      const cursorCs = getComputedStyle(row);
      out.u4 = {
        titleWeight: titleCs.fontWeight,
        timeNums: timeCs.fontVariantNumeric,
        timeColor: timeCs.color,
        cursorShadow: cursorCs.boxShadow,
        cursorBg: cursorCs.backgroundColor,
        rowTrans: getComputedStyle(row).transitionProperty,
      };

      // ── U5：阅读排版（h2 标记 / 引用块 / 代码块 / 段距字距）──
      const art = $('<div class="reader-article" style="font-size:17px"><h2>小节甲</h2><p>正文段落。</p><blockquote>引文一句。</blockquote><pre>code()</pre><pre data-lang="js">let a=1;</pre></div>');
      host.appendChild(art);
      const h2 = art.querySelector('h2');
      const p = art.querySelector('p');
      const bq = art.querySelector('blockquote');
      const pre = art.querySelectorAll('pre')[0];
      const preLang = art.querySelectorAll('pre')[1];
      const h2b = getComputedStyle(h2, '::before');
      const bqb = getComputedStyle(bq, '::before');
      const bqCs = getComputedStyle(bq);
      const preCs = getComputedStyle(pre);
      const preLangCs = getComputedStyle(preLang);
      const preLangB = getComputedStyle(preLang, '::before');
      const fs = parseFloat(getComputedStyle(p).fontSize);
      out.u5 = {
        h2Before: { content: h2b.content, display: h2b.display, bg: h2b.backgroundColor },
        pLs: getComputedStyle(p).letterSpacing, pFs: fs,
        bq: { leftW: bqCs.borderLeftWidth, bg: bqCs.backgroundColor, quote: bqb.content },
        pre: { radius: preCs.borderRadius, padTop: preCs.paddingTop, padX: preCs.paddingLeft },
        preLang: { padTop: preLangCs.paddingTop, label: preLangB.content },
      };
      host.remove();
      return out;
    })()`);

    // U1 断言
    ok(b.shadows.ok1 && b.shadows.ok2 && b.shadows.ok3 && b.shadows.distinct,
      `U1 三档阴影令牌真实解析且互异（1=${b.shadows.sh1.slice(0, 28)}… 2=${b.shadows.sh2.slice(0, 28)}… 3=${b.shadows.sh3.slice(0, 28)}…）`);
    // U2 断言
    ok(b.dursOk, `U2 四档时长令牌取值（${b.durs.join('/')}）`);
    // U3 断言
    ok(b.u3.gTrans.includes('grid-template-rows'), `U3 折叠容器带 grid-template-rows 过渡（${b.u3.gTrans}）`);
    ok(parseFloat(b.u3.gRowsOpen) > 0, `U3 展开态子行高度 >0（${b.u3.gRowsOpen}）`);
    ok(parseFloat(b.u3.gRowsClosed) === 0 && parseFloat(b.u3.kidsOpacityClosed) === 0,
      `U3 折叠态收拢到 0 高 + 全透明（${b.u3.gRowsClosed} / ${b.u3.kidsOpacityClosed}）`);
    ok(b.u3.bar.content !== 'none' && b.u3.bar.position === 'absolute' && b.u3.bar.width === '4px' && b.u3.barBgOk,
      `U3 订阅行 hover 指示条 ::after 4px 主题色（w=${b.u3.bar.width} bg=${b.u3.bar.bg}）`);
    ok(b.u3.badgeRadius === '999px' && b.u3.badgeNums.includes('tabular-nums'),
      `U3 未读徽标胶囊形 + tabular-nums（r=${b.u3.badgeRadius} / ${b.u3.badgeNums}）`);
    // U4 断言
    ok(b.u4.rowTrans.includes('transform') && b.u4.rowTrans.includes('box-shadow'),
      `U4 行卡带 transform/box-shadow 过渡（hover 微抬升可播）`);
    ok(b.u4.titleWeight === '700', `U4 未读行标题加粗 700（${b.u4.titleWeight}）`);
    ok(b.u4.cursorShadow.includes('3px') && b.u4.cursorShadow.includes('inset'),
      `U4 键盘光标行 accent 左条 3px（${b.u4.cursorShadow.slice(0, 44)}…）`);
    ok(/0\.08\)/.test(b.u4.cursorBg), `U4 光标行底色 accent 8%（${b.u4.cursorBg}）`);
    ok(b.u4.timeNums.includes('tabular-nums'), `U4 时间戳 tabular-nums`);
    // U5 断言
    ok(b.u5.h2Before.content !== 'none' && b.u5.h2Before.display === 'inline-block' && b.u5.h2Before.bg !== 'rgba(0, 0, 0, 0)',
      `U5 h2 小节标记 ::before 生效（content=${b.u5.h2Before.content} display=${b.u5.h2Before.display}）`);
    const lsPx = parseFloat(b.u5.pLs);
    ok(lsPx > 0 && Math.abs(lsPx - 0.01 * b.u5.pFs) < 0.1, `U5 段落 letter-spacing 0.01em（${b.u5.pLs} @ ${b.u5.pFs}px）`);
    // 注：borderLeftWidth 为设备像素吸附后的使用值（Windows 125% 缩放下 3px → 2.67px），声明值 3px 由 CSSOM 断言兜底
    const bw = parseFloat(b.u5.bq.leftW);
    ok(bw >= 2.5 && bw <= 3.5 && /0\.04\)/.test(b.u5.bq.bg) && b.u5.bq.quote.includes('\u201C'),
      `U5 引用块 accent 3px 条 + 4% 微染 + 引号装饰（${b.u5.bq.leftW} / ${b.u5.bq.bg} / ${b.u5.bq.quote}）`);
    ok(parseFloat(b.u5.pre.radius) >= 8 && parseFloat(b.u5.pre.padX) >= 14,
      `U5 代码块圆角+内边距（r=${b.u5.pre.radius} pad=${b.u5.pre.padX}）`);
    ok(b.u5.preLang.label.includes('js') && parseFloat(b.u5.preLang.padTop) >= 30,
      `U5 代码块语言标签位（data-lang → "${b.u5.preLang.label}" padTop=${b.u5.preLang.padTop}）`);

    // ── Phase C：CSSOM 规则在册断言（hover 态无法鼠标模拟 / DPR 吸附值兜底，验证规则本体）──
    const c = await win.webContents.executeJavaScript(`(() => {
      const found = { rowHoverLift: null, rowHoverBar: null, bqLeft: null, folderRule: null };
      const walk = (rules, media) => {
        for (const r of rules) {
          try {
            if (r.selectorText && r.style) {
              const s = r.selectorText;
              if (s === '.entry-row:hover' && (r.style.transform || '').includes('translateY(-1px)')) found.rowHoverLift = r.cssText.slice(0, 160);
              if (s.includes('.sidebar-row[data-feed-id]:hover::after')) found.rowHoverBar = true;
              if (s === '.reader-article blockquote' && (r.style.borderLeft || '').includes('3px')) found.bqLeft = r.style.borderLeft;
              if (s === '.sidebar-folder.collapsed .sidebar-folder-children') found.folderRule = r.style.gridTemplateRows;
            }
            if (r.cssRules && r.cssRules.length) walk(r.cssRules, r.media ? r.media.mediaText : media);
          } catch (_) {}
        }
      };
      for (const sheet of document.styleSheets) { try { walk(sheet.cssRules, null); } catch (_) {} }
      return found;
    })()`);
    ok(!!c.rowHoverLift, `U4 CSSOM：.entry-row:hover 抬升规则在册（${(c.rowHoverLift || '').slice(0, 90)}…）`);
    ok(!!c.rowHoverBar, 'U3 CSSOM：订阅行 hover 指示条规则在册');
    ok(!!c.bqLeft, `U5 CSSOM：引用块 accent 3px 实条声明在册（${c.bqLeft || ''}）`);
    ok(c.folderRule === '0fr', 'U3 CSSOM：折叠态 grid-template-rows:0fr 在册');

    if (failed) { console.error(failed + ' 项失败'); app.exit(1); }
    else { console.log('ALL PASSED'); app.exit(0); }
  } catch (e) {
    console.error('ERR', String(e && e.stack || e).slice(0, 1200));
    app.exit(1);
  }
});
