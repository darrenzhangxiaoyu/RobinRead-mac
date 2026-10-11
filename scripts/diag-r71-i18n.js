'use strict';
/**
 * diag-r71-i18n.js — R71 文案与国际化三连探针（run-all OFFLINE 集，全程离线、零 AI）
 *
 * 覆盖：
 *  1 标点全角审计二期（换题记档：句读半角已清零 → 换等价题「句读口径探针固化」）：
 *    程序化扫描渲染层 t()/tf() 字面量 CJK 邻接半角句读 = 仅 3 处冻结白名单
 *    （屏蔽词/加权词/标签输入的「分隔符格式示例」，与应用 join(', ') 解析口径一致，
 *    改全角会教错输入格式）；文件扩展名点（.robin/.ruser）按规则豁免
 *  2 英文界面硬编码中文清零：渲染层 t()/tf() 实参与 I18NStrings 键表差集 = 0
 *    （本轮补录 160 键 + 抽样断言 en 译文）
 *  3 日期/数字本地化跟随界面语言：i18n.uiLocale() 单点 + 五处 OS-locale 依赖点
 *    （dialogs ×5 / topic-view Intl(undefined) / aihot 导出戳）全部改道；
 *    运行时 configure({lang}) 翻转 uiLocale 实证；数字审计锚（计数走 %lld 占位不分区）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-r71-')));
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); // 归一 CRLF：锚点断言对行尾不敏感

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const RENDER_FILES = ['src/renderer/app.js', 'src/renderer/reader-window.js', 'src/renderer/ui-prompt.js']
  .concat(fs.readdirSync(path.join(ROOT, 'src/renderer/views')).map((f) => 'src/renderer/views/' + f));

/** 抽取 t()/tf() 字面量实参（探针内静态扫描）。
 *  批4审查P2-2 收口：单引号 + 双引号全覆盖（双引号实参曾逃过扫描）；另单独抓
 *  模板串 t(`…${…}…`) ——插值后的 key 永不命中键表（en 界面恒中文），一律违规。 */
function extractTLiterals(src) {
  const out = [];
  const re = /\bt(?:f)?\(\s*('((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[2] !== undefined ? m[2] : m[3];
    out.push(raw.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  }
  return out;
}

/** 模板串 t()（t(`…${…}…`)）：插值 key 永不命中键表，属违规用法（应改 tf 占位键）。 */
function countTemplateT(src) {
  return (src.match(/\bt\(\s*`[^`]*\$\{[^`]*`/g) || []).length;
}

app.whenReady().then(async () => {
  try {
    const { STRINGS } = require(path.join(ROOT, 'src/main/I18NStrings.js'));
    const keys = new Set(Object.keys(STRINGS));
    const sources = RENDER_FILES.map((f) => ({ f, src: read(f) }));

    // ── 1. 标点全角二期（句读口径探针固化）──
    // CJK 邻接半角句读（含后随空格变体）；数字.数字小数豁免
    const suspects = [];
    for (const { f, src } of sources) {
      for (const lit of extractTLiterals(src)) {
        if (!/[\u4e00-\u9fff]/.test(lit)) continue;
        if (/[\u4e00-\u9fff]\s*[,;:!?]|[,;:!?]\s*[\u4e00-\u9fff]/.test(lit)) suspects.push(lit);
      }
    }
    // 冻结白名单：三处「分隔符格式示例」——半角逗号即应用接受的输入分隔符（join(', ') 口径）
    const WHITELIST = [
      '逗号分隔，例如：OpenAI, 芯片, Rust',
      '例如：广告, 软文, 震惊',
      '例如：大模型, Agent',
    ];
    const violations = suspects.filter((s) => !WHITELIST.includes(s));
    ok(violations.length === 0, `1 句读半角残留清零（白名单外 ${violations.length} 处${violations.length ? '：' + violations.join(' / ') : ''}）`);
    ok(WHITELIST.every((w) => suspects.includes(w)), '1 三处分隔符格式示例在册（有意保留：教的就是半角逗号输入格式）');
    ok(read('src/renderer/views/dialogs.js').includes("(rules.blockKeywords || []).join(', ')"),
      '1 应用解析口径 = 半角逗号 join（示例与实现一致，非文案疏漏）');
    // 文件扩展名点按规则豁免：.robin / .ruser 后随字母、非句读语义
    ok(/导入 \.robin 批注包/.test(read('src/renderer/app.js')) && /\.ruser 文件（JSON 合同/.test(read('src/renderer/views/dialogs.js')),
      '1 文件扩展名点（.robin/.ruser）在册——技术 token 非句读');

    // ── 2. 键表差集 = 0（英文界面硬编码中文清零）──
    const missing = new Set();
    for (const { src } of sources) for (const lit of extractTLiterals(src)) if (!keys.has(lit)) missing.add(lit);
    ok(missing.size === 0, `2 t()/tf() 实参与键表差集 = 0（${missing.size} 缺${missing.size ? '：' + [...missing].slice(0, 5).join(' / ') : ''}）`);
    // 批4审查P2-1/P2-2 收口：模板串 t() 违规清零 + 双引号实参入扫（list.js "已收藏" 先例）
    let tmplTotal = 0;
    for (const { src } of sources) tmplTotal += countTemplateT(src);
    ok(tmplTotal === 0, `2 模板串 t(\`…\${…}…\`) 违规清零（实插值 key 永不命中键表，应改 tf 占位键；现存 ${tmplTotal} 处）`);
    const dqHit = sources.some(({ src }) => /\bt\(\s*"/.test(src));
    ok(dqHit, '2 双引号实参在扫（list.js t("已收藏") 先例不再逃过扫描）');
    ok(Object.keys(STRINGS).length > 2780, `2 键表规模在册（${Object.keys(STRINGS).length} 键，本轮 +162）`);
    // 抽样断言 en 译文真实落库（高频面 + 本轮代表性键）
    const samples = [
      ['杂志', 'Magazine'], ['列表', 'List'], ['重试', 'Retry'], ['全部重试', 'Retry All'],
      ['本期选读', 'In This Issue'], ['搜索本期 / 本文', 'Search issue / article'],
      ['批量操作', 'Batch'], ['同题报道 · 点击展开', 'Related coverage · click to expand'],
      ['自动滚动', 'Auto Scroll'], ['存储与历史记录', 'Storage & History'],
      ['确定删除「', 'Delete "'], ['%lld 张图片加载失败', '%lld images failed to load'],
    ];
    const badSamples = samples.filter(([k, en]) => STRINGS[k]?.en !== en);
    ok(badSamples.length === 0, `2 en 译文抽样 ${samples.length - badSamples.length}/${samples.length} 命中${badSamples.length ? '（' + badSamples.map((x) => x[0]).join('/') + '）' : ''}`);

    // ── 3. 日期/数字本地化跟随界面语言 ──
    const i18nSrc = read('src/renderer/i18n.js');
    ok(/export function uiLocale\(\) \{/.test(i18nSrc) && /language === 'en' \? 'en-US' : 'zh-CN'/.test(i18nSrc),
      '3 uiLocale() 单点在册（界面语言 → BCP47）');
    const dialogsSrc = read('src/renderer/views/dialogs.js');
    const topicSrc = read('src/renderer/views/topic-view.js');
    const aihotSrc = read('src/renderer/views/aihot-view.js');
    ok(!/toLocaleTimeString\(\[\]/.test(dialogsSrc) && !/toLocaleString\(\[\]/.test(dialogsSrc) && !/toLocaleDateString\(\)/.test(dialogsSrc),
      '3 dialogs 五处 OS-locale 依赖（[]/undefined/裸调用）清零');
    const uiLocaleHits = (dialogsSrc.match(/uiLocale\(\)/g) || []).length;
    ok(uiLocaleHits >= 5, `3 dialogs ${uiLocaleHits} 处日期点位全部改道 uiLocale()`);
    ok(topicSrc.includes('new Intl.DateTimeFormat(uiLocale(),'), '3 话题命中时间 Intl.DateTimeFormat 跟随界面语言');
    ok(aihotSrc.includes('new Date().toLocaleString(uiLocale())'), '3 AI 热点导出时间戳跟随界面语言');
    const listSrc = read('src/renderer/views/list.js');
    ok(/const locale = \(window\.__robinLanguage \|\| 'zh'\) === 'zh' \? 'zh-CN' : 'en-US';/.test(listSrc)
      && /const locale = \(window\.__robinLanguage \|\| "zh"\) === "zh" \? "zh-CN" : "en-US";/.test(listSrc),
      '3 audit：列表时间桶/悬停全量时间既有语言跟随在册（主面）');
    const editionSrc = read('src/renderer/views/edition-reader.js');
    ok(editionSrc.includes("d.toLocaleDateString('en-US'") && editionSrc.includes('const zh = (window.__robinLanguage || \'zh\') === \'zh\';'),
      '3 audit：期刊刊头日期 zh/en 双档在册');
    ok(!/toLocale(Date|Time|)?String\(\)/.test(listSrc + topicSrc + aihotSrc + dialogsSrc),
      '3 渲染层裸 toLocale*String() 无参调用清零');
    // 数字审计锚：计数走 %lld 占位（zh/en 同阿拉伯数字，无千分位分区需求）；tf 不做本地化分组
    ok(/template\.replace\(%lld\|%@\|%d\/g/.test(i18nSrc.replace(/\//g, '/')) || /%lld\|%@\|%d/g.test(i18nSrc),
      '3 audit：tf 占位直替（数字原样，无 locale 分组——当前量纲无千分位面）');

    // ── 运行时实证：configure 翻转 uiLocale ──
    const win = new BrowserWindow({
      show: false, width: 1200, height: 800,
      webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(ROOT, 'src', 'main', 'preload.js') },
    });
    global.__r71win = win; // exec 助手经由全局引用（函数声明提升，定义顺序无关）
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(1000);
    const rt = await exec(`(async () => {
      const i18n = await import('./i18n.js');
      // 探针窗口无主进程 strings 下发（app:state 无 handler）——注入样本表实证机制
      const sample = { '杂志': { zh: '杂志', en: 'Magazine' } };
      i18n.configure({ strings: sample, lang: 'en' });
      const en = i18n.uiLocale();
      const tEn = i18n.t('杂志');
      const fmtEn = new Intl.DateTimeFormat(i18n.uiLocale(), { month: 'long', day: 'numeric' }).format(new Date(2026, 9, 11));
      i18n.configure({ lang: 'zh' });
      const zh = i18n.uiLocale();
      const tZh = i18n.t('杂志');
      const fmtZh = new Intl.DateTimeFormat(i18n.uiLocale(), { month: 'long', day: 'numeric' }).format(new Date(2026, 9, 11));
      return { en, tEn, fmtEn, zh, tZh, fmtZh };
    })()`, 'r71-runtime');
    if (rt.__err) ok(false, '3 运行时探针异常 — ' + rt.__err);
    else {
      ok(rt.en === 'en-US' && rt.zh === 'zh-CN', `3 uiLocale 随 configure 翻转（en=${rt.en} zh=${rt.zh}）`);
      ok(rt.tEn === 'Magazine' && rt.tZh === '杂志', `3 t() 同键双语（en=${rt.tEn} zh=${rt.tZh}）`);
      ok(rt.fmtEn === 'October 11' && rt.fmtZh.includes('10月11日'), `3 同一时间双语格式（en=${rt.fmtEn} zh=${rt.fmtZh}）`);
    }

    win.destroy();
    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});

// exec 助手（与家族探针同款）
function exec(js, label, ms = 45000) {
  return Promise.race([
    global.__r71win.webContents.executeJavaScript(js).then((v) => { console.log(`UI step done: ${label}`); return v; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`UI step timeout: ${label}`)), ms)),
  ]);
}
