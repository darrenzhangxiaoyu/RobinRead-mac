'use strict';
/**
 * diag-r67-icons.js — R67 图标语义三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 收藏星/稍后读时钟/已读勾 全域同形：star/starFilled 同形双态（动作描边/状态填充）、
 *    clock 单一形状多点复用、已读二元动作全域统一（checkAll=标为已读 / envelopeOpen=标为未读，
 *    阅读胶囊与行内快捷同一二元；envelopeClosed 仅留状态语义：未读筛选/邮件账户）
 *  2 stroke 统一 1.75：icons.js 全量扫描 stroke-width ∈ {1.75, 1.1（窗口控制 10×10 光学档）}，
 *    冗余 per-path stroke-width 退役，toast 三态图标同语言
 *  3 纯图标按钮 title+aria-label 双补：工具栏三家族（btn/cap/wc）真实渲染全量断言 +
 *    行内快捷/精选移出/原文窗迷你工具栏/AI 热点卡片接线在册
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r67-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

// bootstrap 的第一 await 是 robin.getState()（app:state）——离线探针无主进程注册表时
// bootstrap 会在此中止、工具栏永不装配。最小快照 mock 让 init 走到 buildToolbar。
ipcMain.handle('app:state', () => ({
  ok: true,
  data: {
    strings: {}, language: 'zh-CN', prefersDark: false,
    hasAPIKey: false, llm: {}, theme: null,
    preferences: { articleFontSize: 17, readerLayout: {}, feedTypography: {} },
  },
}));

app.whenReady().then(async () => {
  try {
    // ── Phase A：源码在册断言 ──────────────────────────────────────────────
    const iconsSrc = read('src/renderer/icons.js');
    const appSrc = read('src/renderer/app.js');
    const listSrc = read('src/renderer/views/list.js');
    const rwSrc = read('src/renderer/reader-window.js');
    const aihotSrc = read('src/renderer/views/aihot-view.js');
    const toastSrc = read('src/renderer/views/toast.js');

    // 1 同形审计
    ok(/starFilled: `<svg[^`]+fill="currentColor"><path d="M8 1\.6l1\.9 3\.9/.test(iconsSrc)
      && /star: i\('<path d="M8 1\.6l1\.9 3\.9/.test(iconsSrc),
      '1 收藏星同形双态：star（动作描边）/starFilled（状态填充）同一路径');
    ok(listSrc.includes("icon('clock')") && read('src/renderer/views/edition-reader.js').includes("icon('clock')")
      && appSrc.includes("icon('clock')"),
      '1 稍后读时钟 clock 单一形状（列表行标/期刊/阅读器同源）');
    ok(/set\('btn-mark-all', icon\('checkAll'\), t\('将当前列表全部标为已读'\)\)/.test(appSrc),
      '1 已读同形：全部标为已读 = checkAll（原 envelopeOpen 退役）');
    ok(/capRead\.innerHTML = icon\(item\?\.isRead \? 'envelopeOpen' : 'checkAll'\);/.test(appSrc)
      && /bar\.appendChild\(mk\('q-read', item\.isRead \? 'envelopeOpen' : 'checkAll',/.test(listSrc),
      '1 已读二元全域统一：阅读胶囊与行内快捷同同一二元（勾=标为已读/开信封=标为未读）');
    const envelopeClosedUses = (appSrc.match(/icon\('envelopeClosed'\)/g) || []).length;
    ok(envelopeClosedUses === 0 && /icon: 'envelopeClosed'/.test(appSrc),
      '1 envelopeClosed 收敛为状态语义（动作位清零；命令面板未读筛选保留字形属性）');
    ok(iconsSrc.includes('已读动作 = checkAll') && iconsSrc.includes('envelopeClosed 仅保留给'),
      '1 图标集语义同形约定文档化（icons.js 头注）');

    // 2 stroke 归簇
    ok(/const ICON_STROKE = 1\.75;/.test(iconsSrc), '2 ICON_STROKE = 1.75 单一事实源在册');
    const strokeVals = [...iconsSrc.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => m[1]);
    const offCluster = strokeVals.filter((v) => v !== '1.75' && v !== '1.1');
    ok(offCluster.length === 0, `2 描边值全量归簇 {1.75, 1.1}（偏差 ${offCluster.length} 处）`);
    ok(/keyboard: i\('<rect[^`]*?\/>'\)/.test(iconsSrc.replace(/\n/g, '')) || !/keyboard:[^>]+stroke-width="1\.75"\/>/.test(iconsSrc),
      '2 冗余 per-path stroke-width（keyboard）退役');
    ok(!/server:[^>]+stroke-width="1\.75"\/>'\)/.test(iconsSrc),
      '2 冗余 per-path stroke-width（server）退役');
    ok((toastSrc.match(/stroke-width="1\.75"/g) || []).length === 4, '2 toast 三态+progress 图标描边 1.75 同语言');

    // 3 title+aria 双补
    ok(/el\.title = title;\n      el\.setAttribute\('aria-label', title\);/.test(appSrc.replace(/\r/g, '')),
      '3 工具栏 set() 工厂双补在册');
    ok(/btn\.setAttribute\('aria-label', btn\.title\); \/\/ R67 纯图标按钮 title\+aria 双补（换形时同步）/.test(appSrc),
      '3 窗口最大化按钮换形同步双补在册');
    ok(!/set\('cap-read', icon\('envelopeClosed'\)\)/.test(appSrc), '3 cap-read 静态形态已随同形更新（checkAll）');
    ok(/capStar\.setAttribute\('aria-label', capStar\.title\);/.test(appSrc)
      && /capZen\.setAttribute\('aria-label', capZen\.title\);/.test(appSrc)
      && /capRead\.setAttribute\('aria-label', capRead\.title\);/.test(appSrc),
      '3 阅读胶囊动态按钮（star/zen/read）双补在册');
    ok(/capTranslate\.setAttribute\('aria-label', capTranslate\.title\);/.test(appSrc),
      '3 cap-translate aria 随三模式同步（批3审查P3-11 收口：此前恒停静态兜底）');
    ok(/b\.setAttribute\('aria-label', title\); \/\/ R67 纯图标按钮 title\+aria 双补/.test(listSrc)
      && /btn\.setAttribute\('aria-label', btn\.title\); \/\/ R67 纯图标按钮 title\+aria 双补/.test(listSrc),
      '3 行内快捷三连 + 精选移出双补在册');
    ok(/el\.setAttribute\('aria-label', el\.title\); \/\/ R67 纯图标按钮 title\+aria 双补/.test(rwSrc),
      '3 独立阅读窗迷你工具栏双补在册');
    ok((aihotSrc.match(/aria-label=/g) || []).length >= 8, '3 AI 热点卡片图标按钮双补（≥8 处）');

    // ── Phase B：真实渲染窗口断言 ─────────────────────────────────────────
    const win = new BrowserWindow({
      show: false, width: 1280, height: 860,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1200);

    const iconsURL = pathToFileURL(path.join(ROOT, 'src', 'renderer', 'icons.js')).href;
    const b = await win.webContents.executeJavaScript(`(async () => {
      const out = {};
      try {
        // ① 图标集全量扫描：描边值 ∈ {1.75, 1.1}；无描边者仅允许填充态 starFilled
        const { icons } = await import(${JSON.stringify(iconsURL)});
        out.iconCount = Object.keys(icons).length;
        out.strokeOff = [];
        out.noStroke = [];
        for (const [name, svg] of Object.entries(icons)) {
          const vals = [...svg.matchAll(/stroke-width="([\\d.]+)"/g)].map((m) => m[1]);
          for (const v of vals) if (v !== '1.75' && v !== '1.1') out.strokeOff.push(name + ':' + v);
          if (!vals.length && !/fill="currentColor"/.test(svg)) out.noStroke.push(name);
        }
        // ② 工具栏三家族真实渲染：纯图标按钮 title+aria 双补全量
        const fams = ['.btn.icon-only', '.cap-btn', '.wc-btn'];
        out.missing = [];
        out.total = 0;
        for (const fam of fams) {
          for (const btn of document.querySelectorAll(fam)) {
            out.total += 1;
            const label = btn.getAttribute('aria-label');
            const hasText = (btn.textContent || '').trim().length > 0;
            if (!hasText && !label) out.missing.push(fam + '#' + btn.id);
          }
        }
        // ③ 已读同形实渲染：全部已读按钮与阅读胶囊初始形态都是勾
        const checkPath = 'M5.2 8.2l1.9 1.9 3.7-4';
        out.markAllIsCheck = (document.getElementById('btn-mark-all')?.innerHTML || '').includes(checkPath);
        out.capReadIsCheck = (document.getElementById('cap-read')?.innerHTML || '').includes(checkPath);
        out.capReadAria = document.getElementById('cap-read')?.getAttribute('aria-label') || '';
        return out;
      } catch (e) { return { __err: String(e && e.stack || e) }; }
    })()`, 'icons-flow');
    if (b.__err) ok(false, '图标流程探针异常 — ' + b.__err);
    else {
      ok(b.iconCount >= 70, `1 图标集在册（${b.iconCount} 枚）`);
      ok(b.strokeOff.length === 0, `2 全量扫描描边值归簇（偏差 ${b.strokeOff.length} 处）`);
      ok(b.noStroke.length === 0, `2 无描边且非填充态的图标清零（${b.noStroke.length} 枚）`);
      ok(b.total >= 15, `3 工具栏三家族纯图标按钮在册（${b.total} 枚）`);
      ok(b.missing.length === 0, `3 双补全量断言（缺 aria：${b.missing.length ? b.missing.join(',') : '无'}）`);
      ok(b.markAllIsCheck, '1 全部已读按钮实渲染为勾形');
      ok(b.capReadIsCheck, '1 阅读胶囊已读按钮实渲染为勾形');
      ok(!!b.capReadAria, '3 阅读胶囊已读按钮 aria-label 在位');
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
