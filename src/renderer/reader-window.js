'use strict';
/**
 * RobinRead（知更）— 独立阅读窗口入口（F17 多窗并读）
 *
 * index.html 的精简版：只含 reader 容器 + 迷你工具栏（字号/主题跟随/关闭）。
 * 复用同一个 ReaderView 类（构造选项 handlers.mode='popup'）：
 * - 数据经同一 preload 取 getReader(entryID)（同一 DB，天然一致）；
 *   阅读位置/批注走既有 IPC 持久化，写回自动生效（ReaderView 无 window 单例假设）；
 * - TTS / 媒体迷你播放器按构造选项禁用（多窗不混声源）；F13 继续读卡自然复用，
 *   点击相关文章在当前弹出窗内续开（window.__robinReaderOpen 指向本窗 reader.open）。
 * - 主题跟随：nativeTheme 推送（theme:changed）+ 主窗自定义主题令牌经 getState 快照同步。
 */
import { configure, t, tf } from './i18n.js';
import { icon } from './icons.js';
import { ReaderView } from './views/reader.js';
import {
  applyPalette, clearPalette, fullPalette,
  normalizeTokens, switchModeTokens,
} from './views/theme-engine.js';
import { resolveReaderFontStack } from './data/font-family-presets.js'; /* U21 字体族套装 */

const params = new URLSearchParams(location.search);
const entryID = params.get('entry') || '';

function showToast(message) {
  let host = document.querySelector('.rw-toast');
  if (!host) {
    host = document.createElement('div');
    host.className = 'rw-toast';
    document.body.appendChild(host);
  }
  host.textContent = String(message ?? '');
  host.classList.add('visible');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => host.classList.remove('visible'), 2400);
}

/** 排版变量（app.js applyReaderLayout 的 reader 作用域子集：字体/页宽/行距/字距/标题字）。 */
function applyReaderLayoutCSS(layout) {
  const root = document.documentElement;
  // U21 字体族套装：与主窗同源（font-family-presets.js 单一数据源，四档皮肤+自定义）
  const fontStack = resolveReaderFontStack(layout);
  const widthMap = { narrow: '680px', standard: '820px', wide: '960px' };
  const heightMap = { compact: '1.55', standard: '1.72', loose: '1.95' };
  const letterMap = { normal: '0.006em', wide: '0.028em', loose: '0.05em' };
  const titleMap = { inherit: 'var(--font-serif)', smiley: '"Smiley Sans", var(--font-serif)' };
  root.style.setProperty('--reader-font', fontStack);
  root.style.setProperty('--reader-font-family', fontStack);
  root.style.setProperty('--reader-page-width', widthMap[layout?.pageWidth] || widthMap.standard);
  root.style.setProperty('--reader-line-height', heightMap[layout?.lineHeight] || heightMap.standard);
  root.style.setProperty('--reader-letter-spacing', letterMap[layout?.letterSpacing] || letterMap.normal);
  root.style.setProperty('--reader-title-font', titleMap[layout?.titleFont] || titleMap.inherit);
  document.body.dataset.bilingualStyle = layout?.bilingualStyle === 'card' ? 'card' : 'inline';
  document.body.dataset.readerPara = layout?.paraStyle === 'indent' ? 'indent' : 'spacing';
  document.body.dataset.readerAlign = layout?.textAlign === 'justify' ? 'justify' : 'left';
  document.body.classList.toggle('rp-micro-off', layout?.microTypography === 'off');
  document.body.classList.toggle('rp-dropcap', layout?.dropCap === 'on');
}

/** 自定义主题令牌（与主窗 syncCustomTheme 同口径：明暗模式不匹配时换挡）。 */
function applyCustomTheme(snapshot) {
  const raw = snapshot?.customTheme;
  const dark = snapshot?.prefersDark ?? window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (!raw) { clearPalette(); return; }
  let tokens = normalizeTokens(raw);
  if ((tokens.mode === 'light') === dark) tokens = switchModeTokens(tokens, dark ? 'dark' : 'light');
  applyPalette(fullPalette(tokens));
}

function applyDarkMode(prefersDark) {
  document.body.classList.toggle('dark', prefersDark);
  const dot = document.getElementById('rw-theme-dot');
  if (dot) dot.dataset.mode = prefersDark ? 'dark' : 'light';
}

async function bootstrap() {
  const result = await window.robin.getState();
  if (!result.ok) return;
  const snapshot = result.data;
  configure({ strings: snapshot.strings, lang: snapshot.language });
  applyDarkMode(snapshot.prefersDark ?? false);
  applyCustomTheme(snapshot);
  applyReaderLayoutCSS(snapshot.preferences?.readerLayout);
  document.documentElement.style.setProperty('--article-font-size', `${snapshot.preferences?.articleFontSize || 17}px`);
  // reader.js 读取的全局：LLM 偏好（自动摘要判定）/ 每源排版 / 全文抓取徽标映射
  window.__robinLLM = { ...(snapshot.llm || {}), __hasKey: snapshot.hasAPIKey !== false };
  window.__robinFeedTypography = snapshot?.preferences?.feedTypography || {};
  window.__robinFulltextModes = snapshot?.preferences?.fulltextFeedModes || {};
  window.__robinListTitleZh = snapshot?.preferences?.titleZh === true;

  // 迷你工具栏
  const setBtn = (id, svg, title) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = svg;
    if (title) {
      el.title = t(title);
      el.setAttribute('aria-label', el.title); // R67 纯图标按钮 title+aria 双补
    }
  };
  setBtn('rw-font-minus', icon('textSmaller'), '缩小正文字号');
  setBtn('rw-font-plus', icon('textLarger'), '放大正文字号');
  setBtn('rw-close', icon('winClose'), '关闭窗口');
  // F10 起字号为活状态（批次 C 审查 P1-1：闭包冻结快照会使第二次点击起失效）
  let currentFontSize = Number(snapshot.preferences?.articleFontSize) || 17;
  const adjustFont = async (delta) => {
    const size = Math.max(12, Math.min(28, currentFontSize + delta));
    currentFontSize = size;
    document.documentElement.style.setProperty('--article-font-size', `${size}px`);
    await window.robin.setFontSize(size); // 写回同一偏好：主窗/弹出窗共用
  };
  document.getElementById('rw-font-minus')?.addEventListener('click', () => adjustFont(-1));
  document.getElementById('rw-font-plus')?.addEventListener('click', () => adjustFont(1));
  document.getElementById('rw-close')?.addEventListener('click', () => window.close());

  // 独立阅读器（复用 ReaderView；构造选项 mode:'popup' 关闭 TTS 与媒体卡）
  const reader = new ReaderView(
    document.getElementById('reader-scroll'),
    {
      tocRail: document.getElementById('toc-rail'),
      tocTrack: document.getElementById('toc-track'),
      tocPeak: document.getElementById('toc-peak'),
      scrollbar: document.getElementById('floating-scrollbar'),
      thumb: document.getElementById('floating-thumb'),
    },
    {
      mode: 'popup', // F17 构造选项：禁 TTS / 媒体卡（reader.js 仅读该标记，核心逻辑零改动）
      onFeedback: showToast,
      onSelectNext: () => {}, // 弹出窗无列表：空格到底不翻篇
    },
  );
  window.__robinReader = reader; // E2E 句柄（与主窗同惯例）
  // F13 继续读卡在弹出窗内续开：本窗 reader.open（主窗句柄 __robinReaderOpen 不存在时兜底）
  window.__robinReaderOpen = (id) => reader.open(id);

  // 主题跟随：主进程 nativeTheme 变化推送 + 主窗自定义令牌（快照轮询走 state:changed 不可达，
  // 弹出窗按打开时快照 + 明暗推送双通道跟随，切换设置后重开窗口即取新令牌）
  window.robin.onThemeChanged?.(({ shouldUseDarkColors }) => {
    applyDarkMode(shouldUseDarkColors);
    if (window.__robinCustomTokens) {
      applyPalette(fullPalette(switchModeTokens(window.__robinCustomTokens, shouldUseDarkColors ? 'dark' : 'light')));
    }
  });
  if (snapshot.customTheme) window.__robinCustomTokens = normalizeTokens(snapshot.customTheme);

  if (!entryID) {
    document.getElementById('rw-title').textContent = t('未选择文章');
    return;
  }
  document.getElementById('rw-title').textContent = t('正在准备正文…');
  await reader.open(entryID);
  const title = reader.entry?.title;
  if (title) {
    document.title = title; // 窗口标题 = 文章标题（与主进程 setTitle 双保险）
    document.getElementById('rw-title').textContent = title;
  }
  // 与主窗阅读语义一致：打开即已读（写回同一 DB 通路）
  try { await window.robin.markRead(entryID, true); } catch (_) { /* 状态写回失败不影响阅读 */ }
}

bootstrap().catch((err) => {
  console.error('[reader-window] bootstrap failed', err);
  document.getElementById('rw-title').textContent = tf('加载失败：%@', String(err?.message || err));
});
