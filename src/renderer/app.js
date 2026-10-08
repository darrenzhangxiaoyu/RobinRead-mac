'use strict';
/**
 * RobinRead（知更）— 渲染层主控制器
 *
 * 对应 RootView.swift + ThreeColumnSplitView.swift：
 * - 统一三区工具栏（刷新/添加 | 标题/全部已读 | 阅读胶囊居中）
 * - 栏焦点管理（←/→、点击激活、进入列表自动选中首篇）
 * - B/N/空格 双击确认导航（ReaderNavigationConfirmation + toast）
 * - 禅模式（ESC 退出，仅保留胶囊）
 * - 字号 Cmd +/−/0
 */
import { configure, t, tf } from './i18n.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { promptBox, confirmBox } from './ui-prompt.js';
import { SidebarView } from './views/sidebar.js';
import { ListView } from './views/list.js';
import { ReaderView } from './views/reader.js';
import { SettingsView, showAddFeed, showAddFolder, showRenameFolder, showFreshRSSAccount } from './views/dialogs.js';
import { ShortcutsView } from './views/shortcuts.js';
import { ContextMenu } from './views/context-menu.js';
import { CommandPalette } from './views/command-palette.js';
import { ReadingControls } from './views/reading-controls.js';
import { TYPOGRAPHY_PRESETS } from './data/typography-presets.js';
import {
  normalizeTokens, switchModeTokens, fullPalette, applyPalette, clearPalette,
  persistTokens, clearTokens, pushRecent,
} from './views/theme-engine.js';
import { ThemeProposer, ThemeDesigner } from './views/theme-designer.js';
import { FeedStore } from './views/feed-store.js';
import { KnowledgeCenter } from './views/knowledge.js';
import { EvolutionView } from './views/evolution-view.js';
import { AihotView } from './views/aihot-view.js';
import { MediaView } from './views/media-view.js';
import { MediaMiniPlayer } from './views/media-player.js';
import { PicksTTSPlayer } from './views/picks-tts.js';
import { RadioPlayer } from './views/radio-player.js';
import { FocusSessionPanel } from './views/focus-session.js';
import { TopicView } from './views/topic-view.js';
import { AccountController } from './views/account.js';
import { syncPaletteCommand } from './views/sync-command.js';
import { Toast } from './views/toast.js';

let customThemeTokens = null; // null = 使用内置纸感默认
const state = {
  snapshot: null,
  sidebar: [],
  scope: { kind: 'today' },
  selectedEntryID: null,
  retainedIDs: new Set(),       // 未读会话保留（对应 retainedUnreadIDs）
  listItems: [],
  activeQuery: '',            // 当前搜索词（runSearch / 智能文件夹共用）
  searchMode: false,          // P1-5：搜索态标志——runSearch 维护，驱动「搜索结果进文自动高亮」闭环
  zenMode: false,
  sidebarCollapsed: false,
  activeColumn: 1,              // 0=sidebar 1=list 2=reader
  updateInfo: null,
  // 状态推送瘦身：主进程修订号与结构签名（增量补丁，免全量重拉）
  entryStateRev: 0,
  listSetRev: 0,
  sidebarSignature: null,
};

const views = {};
let navConfirmation = null;     // { key, entryID, expiresAt, timer }
// F10 智能精选：开启态 + 请求序号（快速切换时过期返回丢弃）
const picksState = { on: false, seq: 0 };
// P1-8：列表请求序号——reloadList 与 onStateChanged 全量重拉并发竞争时，
// 只有最新请求的返回才允许落地（视野切换乱序的根源修复）
let listReqSeq = 0;

// MARK: - 启动

/** 旧版 localStorage 键（paperrss.* / nanjupaper.*）一次性迁移到 robinread.*，并清理旧键。 */
function migrateLegacyLocalStorage() {
  const legacyKeys = ['sidebarCollapsed', 'collapsedAccounts', 'collapsedFolders', 'customTheme', 'recentThemes'];
  for (const k of legacyKeys) {
    const next = `robinread.${k}`;
    for (const oldPrefix of ['nanjupaper', 'paperrss']) {
      const old = localStorage.getItem(`${oldPrefix}.${k}`);
      if (old != null) {
        if (localStorage.getItem(next) == null) localStorage.setItem(next, old);
        localStorage.removeItem(`${oldPrefix}.${k}`);
      }
    }
  }
}

async function bootstrap() {
  migrateLegacyLocalStorage();
  const result = await window.robin.getState();
  if (!result.ok) return;
  const snapshot = result.data;
  configure({ strings: snapshot.strings, lang: snapshot.language });
  state.snapshot = snapshot;
  applyTheme(snapshot);
  applyFontSize(snapshot.preferences.articleFontSize);
  syncLLMGlobals(snapshot);
  syncCustomTheme(snapshot);
  window.__robinFeedTypography = snapshot?.preferences?.feedTypography || {};
  window.__robinListTitleZh = snapshot?.preferences?.titleZh === true;
  window.__robinFulltextModes = snapshot?.preferences?.fulltextFeedModes || {};
  applyReaderLayout(snapshot.preferences?.readerLayout);
  restoreSidebarCollapsed();

  views.sidebar = new SidebarView(document.getElementById('sidebar-scroll'), document.getElementById('sidebar-footer'), {
    onSelect: handleScopeSelect,
    onFeedContext,
    onFolderContext,
    onMoveFeeds: (feedIDs, folder) => window.robin.setFeedFolder(feedIDs, folder),
    onDeleteFeeds: confirmDeleteFeeds,
    onOpenSettings: () => showSettings(),
    onOpenStore: () => openFeedStore(),
    onOpenKnowledge: () => openKnowledgeCenter(),
    onOpenEvolution: () => openEvolutionView(),
    onOpenAihot: () => openAihotView(),
    onOpenMedia: () => openMediaView(),
    onOpenTopics: () => openTopicsView(),
    onOpenAccount: () => views.account?.openCenter({ feedCount: () => countAllFeeds() }),
    onOpenUpdate: (url) => window.robin.openLink(url),
    onIgnoreVersion: (version) => window.robin.ignoreVersion(version),
  });

  // 账号与会员：初始化状态并与侧栏账号条联动
  views.account = new AccountController({
    feedCount: () => countAllFeeds(),
    onUserChanged: (user) => views.sidebar.updateAccount(user),
  });
  views.account.init();
  // 媒体中心（F3）：全局单实例迷你播放器（与 TTS 互斥在此裁决，双方经 deps 互通）
  // F10 起「全局 TTS 态」= 阅读器朗读 + 精选播报（PicksTTSPlayer）取非空闲者；
  // F19 起并入简报电台（RadioPlayer）——四方互斥（媒体/朗读/精选/电台）的 M→R 边
  views.mediaPlayer = new MediaMiniPlayer({
    tts: {
      state: () => {
        const readerState = views.reader?.ttsState || 'idle';
        if (readerState !== 'idle') return readerState;
        if ((views.picksTTS?.state || 'idle') !== 'idle') return views.picksTTS.state;
        return views.radio?.state || 'idle';
      },
      stop: () => {
        views.reader?.stopTTS?.();
        views.picksTTS?.stop?.();
        views.radio?.stop?.();
      },
    },
    toast: showToast,
  });
  // F10 智能精选播报：NeuralTTS 既有通路的独立胶囊播放器（不入 media_items）
  views.picksTTS = new PicksTTSPlayer({
    toast: showToast,
    onState: (s) => views.list?.setPicksBroadcastState?.(s),
  });
  window.__robinPicksTTS = views.picksTTS; // E2E 测试句柄（与 __robinReader 同惯例）
  // F19 简报电台：今日简报/模板文稿 → 逐句 NeuralTTS 链播 + 位置记忆 + 合成缓存
  views.radio = new RadioPlayer({
    toast: showToast,
    preferAI: radioPreferAI,
  });
  window.__robinRadio = views.radio; // E2E 测试句柄（含四方互斥反向缝）
  // F20 专注会话：内存对象（不持久化），篇数经 handleEntrySelect 钩子计数
  views.focus = new FocusSessionPanel({ toast: showToast });
  window.__robinFocus = views.focus; // E2E 测试句柄（探针注入时间加速）
  views.list = new ListView(document.getElementById('list-scroll'), {
    onSelect: handleEntrySelect,
    onContext: showListRowContext,
    onLoadMore: loadMoreEntries,
    onSearch: runSearch,
    onDigest: showTodayDigest,
    onTogglePicks: () => toggleSmartPicks(),
    onBroadcastPicks: () => broadcastSmartPicks(),
    onPicksDismiss: (entryID) => dismissSmartPick(entryID),
    onPicksLimit: (n) => {
      window.robin.picksSetLimit(n).then(() => refreshSmartPicks()).catch(() => {});
    },
    onClusterBrief: showClusterBrief,
    onExportEdition: showEditionExport,
    onCleanupLater: (ids) => cleanupOverdueLater(ids),
    onResumeOpen: async (candidate) => {
      await handleEntrySelect(candidate.entryID, { id: candidate.entryID, title: candidate.title });
    },
    onFilterTag: (tag) => {
      kc.dismiss();
      handleScopeSelect({ kind: 'tag', tag });
    },
    onToggleSort: () => {
      // 四态循环（F14 加「智能」）：时间序 → 未读优先 → 短文优先 → 智能（画像排序）；
      // 空画像时服务端自动降级时间序（listItems 内部处理），循环项保持可选。
      const cycle = { time: 'unreadFirst', unreadFirst: 'shortFirst', shortFirst: 'smart', smart: 'time' };
      const next = cycle[currentListSort()] || 'time';
      window.robin.setReaderLayout({ listSort: next });
    },
    onToggleViewMode: () => {
      // 列表 ⇄ 杂志；偏好经状态推送回流（applyReaderLayout 统一应用并重拉）
      const next = window.__robinReaderLayout?.listViewMode === 'magazine' ? 'list' : 'magazine';
      window.robin.setReaderLayout({ listViewMode: next });
    },
  });
  views.reader = new ReaderView(
    document.getElementById('reader-scroll'),
    {
      tocRail: document.getElementById('toc-rail'),
      tocTrack: document.getElementById('toc-track'),
      tocPeak: document.getElementById('toc-peak'),
      scrollbar: document.getElementById('floating-scrollbar'),
      thumb: document.getElementById('floating-thumb'),
    },
    {
      onFeedback: showToast,
      onSelectNext: () => selectNextEntry(),
      onFocusList: () => setActiveColumn(1),
      // 知更电台连播（方向 18）：本篇读完自动接列表下一篇（getAdjacent 取向，不触发空格双击确认）
      onOpenTag: (tag) => handleScopeSelect({ kind: 'tag', tag }),
      onTTSAdvance: async () => {
        if (!state.selectedEntryID) return;
        const result = await window.robin.getAdjacent(state.scope, state.selectedEntryID, 'next');
        const next = result.ok ? result.data : null;
        if (!next) {
          showToast(t('连播：列表已读完'));
          return;
        }
        views.reader._ttsAutoResume = Date.now(); // 8 秒内有效：open 完成后自动续播
        await handleEntrySelect(next.id, next);
      },
    },
  );
  window.__robinReader = views.reader; // E2E 测试句柄
  window.__robinList = views.list; // E2E 测试句柄（F10 探针观测精选视图态）
  window.__robinReaderOpen = (entryID) => handleEntrySelect(entryID, { isRead: true }); // F13：文末继续读打开相关文章

  buildToolbar();
  bindToolbar();
  bindWindowControls();
  applyColumnWidths();
  bindEvents();
  bindSplitters();
  bindKeyboard();

  await reloadAll();
  setActiveColumn(1, { autoSelect: false });
  setTimeout(checkUpdateQuietly, 6000);
}

// MARK: - 主题 / 字号

function applyTheme(snapshot) {
  const prefers = snapshot?.prefersDark ?? window.matchMedia('(prefers-color-scheme: dark)').matches;
  const apply = () => document.body.classList.toggle('dark', prefers);
  // 前端美化（方向 10 轻量版）：明暗切换走 View Transition 淡入淡出（尊重 reduced-motion）
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (document.startViewTransition && !reduce) document.startViewTransition(apply);
  else apply();
}

function applyFontSize(size) {
  document.documentElement.style.setProperty('--article-font-size', `${size || 17}px`);
}

/** 自定义 CSS（方向 24）：注入 <style id="nj-custom-css">，空值时移除（幂等）。 */
function applyCustomCSS(css) {
  let el = document.getElementById('nj-custom-css');
  const value = String(css || '');
  if (!value.trim()) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = 'nj-custom-css';
    document.head.appendChild(el);
  }
  el.textContent = value;
}

function syncLLMGlobals(snapshot) {
  window.__robinLLM = { ...(snapshot?.llm || {}), __hasKey: snapshot?.hasAPIKey !== false };
}

/** 恢复 / 重应用自定义主题（跟随当前明暗模式）。 */
function applyReaderLayout(layout) {
  const root = document.documentElement;
  const fontMap = { serif: 'var(--font-serif)', sans: 'var(--font-sans)', wenkai: '"LXGW WenKai Screen", var(--font-serif)' };
  const widthMap = { narrow: '680px', standard: '820px', wide: '960px' };
  const heightMap = { compact: '1.55', standard: '1.72', loose: '1.95' };
  root.style.setProperty('--reader-font', fontMap[layout?.fontFamily] || fontMap.serif);
  root.style.setProperty('--reader-page-width', widthMap[layout?.pageWidth] || widthMap.standard);
  root.style.setProperty('--reader-line-height', heightMap[layout?.lineHeight] || heightMap.standard);
  // 排版引擎 v2：字距走 CSS 变量；段落风格/对齐/微排版/首字下沉走 body 标记（CSS 按标记生效）
  const letterMap = { normal: '0.006em', wide: '0.028em', loose: '0.05em' };
  root.style.setProperty('--reader-letter-spacing', letterMap[layout?.letterSpacing] || letterMap.normal);
  const titleMap = { inherit: 'var(--font-serif)', smiley: '"Smiley Sans", var(--font-serif)' };
  root.style.setProperty('--reader-title-font', titleMap[layout?.titleFont] || titleMap.inherit);
  document.body.dataset.bilingualStyle = layout?.bilingualStyle === 'card' ? 'card' : 'inline';
  // 自定义 CSS（方向 24）：首次应用状态时从独立通道拉取一次，之后的变更由设置页事件推送
  if (!applyReaderLayout._cssHook) {
    applyReaderLayout._cssHook = true;
    document.addEventListener('robinread:custom-css', (event) => applyCustomCSS(event.detail));
    window.robin.readerCustomCSS?.().then((css) => applyCustomCSS(css)).catch(() => {});
  }
  document.body.dataset.readerPara = layout?.paraStyle === 'indent' ? 'indent' : 'spacing';
  document.body.dataset.readerAlign = layout?.textAlign === 'justify' ? 'justify' : 'left';
  document.body.classList.toggle('rp-micro-off', layout?.microTypography === 'off');
  document.body.classList.toggle('rp-dropcap', layout?.dropCap === 'on');
  window.__robinReaderLayout = layout || {};
  // 微排版是 DOM 结构性的（spacer 增删）：设置变化时通知阅读器在已打开的文章上重建。
  // 必须在 __robinReaderLayout 更新之后再派发——阅读器按新值重建
  const micro = layout?.microTypography === 'off' ? 'off' : 'on';
  if (micro !== applyReaderLayout._lastMicro) {
    const microChanged = applyReaderLayout._lastMicro !== undefined;
    applyReaderLayout._lastMicro = micro;
    if (microChanged) document.dispatchEvent(new CustomEvent('robinread:reader-layout-changed'));
  }
  document.body.dataset.listDensity = layout?.listDensity || 'comfortable';
  // 列表排序：状态变化时更新按钮并重拉列表（排序影响行序）。
  // 四态透传（F14）：既有实现把 shortFirst/smart 压缩回 time，导致这两态选不中（验证轮顺带修复）。
  const listSort = ['time', 'unreadFirst', 'shortFirst', 'smart'].includes(layout?.listSort)
    ? layout.listSort : 'time';
  if (views.list?.setSortButton) views.list.setSortButton(listSort);
  if (listSort !== applyReaderLayout._lastSort) {
    const changed = applyReaderLayout._lastSort !== undefined;
    applyReaderLayout._lastSort = listSort;
    if (changed && views.list) reloadList({ resetScroll: true }).catch(() => {});
  }
  // 时间线形态（列表 / 沉浸杂志）：切换后重拉并重渲染（前端美化：View Transition 淡入）
  const viewMode = layout?.listViewMode === 'magazine' ? 'magazine' : 'list';
  if (views.list?.setViewMode) views.list.setViewMode(viewMode);
  if (viewMode !== applyReaderLayout._lastViewMode) {
    const changed = applyReaderLayout._lastViewMode !== undefined;
    applyReaderLayout._lastViewMode = viewMode;
    if (changed && views.list) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (document.startViewTransition && !reduce) document.startViewTransition(() => reloadList({ resetScroll: true }).catch(() => {}));
      else reloadList({ resetScroll: true }).catch(() => {});
    }
  }
  // 注意：translateMode 是「打开文章时的默认模式」，由 reader.open 自行读取；
  // 不在这里强制应用——否则每次 state 推送都会把用户会话内选择的模式重置掉。
}

function syncCustomTheme(snapshot) {
  const raw = snapshot?.customTheme;
  if (!raw) { customThemeTokens = null; clearPalette(); return; }
  let tokens = normalizeTokens(raw);
  const dark = snapshot?.prefersDark ?? document.body.classList.contains('dark');
  if ((tokens.mode === 'light') === dark) tokens = switchModeTokens(tokens, dark ? 'dark' : 'light');
  customThemeTokens = tokens;
  window.__robinCustomTokens = tokens;
  applyPalette(fullPalette(tokens));
}

/** 应用一套主题令牌（提案卡片 / 设计器共用入口）。 */
function applyThemeTokens(tokens, name) {
  const dark = document.body.classList.contains('dark');
  let next = normalizeTokens(tokens);
  if ((next.mode === 'light') === dark) next = switchModeTokens(next, dark ? 'dark' : 'light');
  customThemeTokens = next;
  window.__robinCustomTokens = next;
  applyPalette(fullPalette(next));
  persistTokens(next);
  if (name) pushRecent(next, name);
}

function resetTheme() {
  customThemeTokens = null;
  window.__robinCustomTokens = null;
  clearPalette();
  clearTokens();
}

// MARK: - 工具栏

function buildToolbar() {
  const set = (id, svg, title) => {
    const el = document.getElementById(id);
    el.innerHTML = svg;
    if (title) el.title = title;
  };
  set('btn-toggle-sidebar', icon('sidebarLeft'), t('切换侧栏'));
  set('btn-refresh', icon('refresh'), t('刷新所有订阅'));
  set('btn-add', icon('plus'), t('新建与更多'));
  set('btn-mark-all', icon('envelopeOpen'), t('将当前列表全部标为已读'));
  set('cap-translate', icon('translate'));
  set('cap-deepread', icon('bookOpen'), t('一键精读：论证/概念/证据/金句 (D)'));
  set('cap-rsummary', icon('docText'), t('高质量中文摘要 (S)'));
  set('cap-read', icon('envelopeClosed'));
  set('cap-star', icon('star'));
  set('cap-zen', icon('expand'));
  set('cap-focus-session', icon('clock'), t('专注会话：设定时长开始沉浸阅读'));
  set('cap-autoscroll', icon('chevronDown'), t('自动滚动阅读'));
  set('cap-focus', icon('eye'), t('聚焦模式：非当前段落渐暗（F）'));
  set('cap-highlight', icon('marker'), t('高亮：选中文字快速高亮（H）；无选区打开批注面板'));
  set('cap-note', icon('noteSticky'), t('批注面板：本篇高亮与笔记'));
  set('cap-review', icon('refresh'), t('加入复习'));
  set('cap-popout', icon('popout'), t('在独立窗口打开'));
  set('cap-browser', icon('globe'), t('打开原网页'));
  set('wc-min', icon('winMinimize'), t('最小化'));
  updateCapBrowserState();
  set('wc-close', icon('winClose'), t('关闭'));
  updateMaximizeGlyph(false);
}

function updateMaximizeGlyph(isMaximized) {
  const btn = document.getElementById('wc-max');
  if (!btn) return;
  btn.innerHTML = icon(isMaximized ? 'winRestore' : 'winMaximize');
  btn.title = isMaximized ? t('向下还原') : t('最大化');
}

function bindWindowControls() {
  document.getElementById('wc-min').addEventListener('click', () => window.robin.winMinimize());
  document.getElementById('wc-max').addEventListener('click', () => window.robin.winToggleMaximize());
  document.getElementById('wc-close').addEventListener('click', () => window.robin.winClose());
  window.robin.winIsMaximized().then((result) => {
    if (result.ok) updateMaximizeGlyph(Boolean(result.data));
  });
  window.robin.onWindowMaxChanged((maximized) => updateMaximizeGlyph(Boolean(maximized)));
  // 双击工具栏空白处切换最大化（Windows 标题栏惯例）
  document.getElementById('main-toolbar').addEventListener('dblclick', (event) => {
    if (event.target.closest('.btn, .reader-capsule, .window-controls')) return;
    window.robin.winToggleMaximize();
  });
}

function bindToolbar() {
  document.getElementById('btn-toggle-sidebar').addEventListener('click', toggleSidebarCollapsed);
  document.getElementById('btn-refresh').addEventListener('click', () => {
    if (state.snapshot?.refreshStatus?.state === 'refreshing') return;
    window.robin.refresh();
  });
  document.getElementById('btn-add').addEventListener('click', (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    ContextMenu.show(rect.right - 210, rect.bottom + 6, [
      { label: t('浏览订阅商店…'), icon: 'store', onClick: () => openFeedStore() },
      { label: t('添加订阅'), icon: 'plus', onClick: () => showAddFeed(collectFolders(), reloadAll) },
      { label: t('新建文件夹'), icon: 'folderPlus', onClick: () => showAddFolder(reloadAll) },
      { type: 'separator' },
      { label: t('导入 OPML'), icon: 'import', onClick: () => window.robin.importOPML() },
      { label: t('导出 OPML'), icon: 'export', onClick: () => window.robin.exportOPML() },
    ]);
  });
  document.getElementById('btn-mark-all').addEventListener('click', markCurrentAllRead);

  document.getElementById('cap-translate').addEventListener('click', (event) => {
    // 翻译模式菜单：明确显示当前状态与可选模式（替代难以分辨的循环切换）
    const current = views.reader?.translateMode || 'off';
    const isChinese = views.reader?.isChineseArticle?.() === true;
    const items = [];
    if (window.__robinLLM?.__hasKey === false) {
      items.push({ label: t('AI 未配置 API Key'), disabled: true });
      items.push({ label: t('前往 设置 → AI 配置'), icon: 'gear', onClick: () => showSettings('ai') });
    } else if (isChinese) {
      items.push({ label: t('当前是中文文章，无需翻译'), disabled: true });
      if (current !== 'off') items.push({ label: t('关闭翻译'), icon: 'close', onClick: () => { views.reader.setTranslateMode('off'); updateToolbarState(); } });
    } else {
      items.push({ label: t('双语对照（原文 + 译文）'), icon: 'translate', checked: current === 'bilingual', onClick: () => { views.reader.setTranslateMode('bilingual'); updateToolbarState(); } });
      items.push({ label: t('仅显示中文'), icon: 'translate', checked: current === 'zh', onClick: () => { views.reader.setTranslateMode('zh'); updateToolbarState(); } });
      items.push({ type: 'separator' });
      items.push({ label: t('关闭翻译'), icon: 'close', checked: current === 'off', onClick: () => { views.reader.setTranslateMode('off'); updateToolbarState(); } });
    }
    const rect = event.currentTarget.getBoundingClientRect();
    ContextMenu.show(rect.left, rect.bottom + 6, items);
  });
  document.getElementById('cap-read').addEventListener('click', () => {
    if (state.selectedEntryID) window.robin.markRead(state.selectedEntryID, !currentEntryIsRead());
  });
  document.getElementById('cap-deepread').addEventListener('click', () => dispatchReaderAction('deepRead'));
  document.getElementById('cap-rsummary').addEventListener('click', () => dispatchReaderAction('richSummary'));
  document.getElementById('cap-star').addEventListener('click', () => toggleStarWithGuide());
  document.getElementById('cap-popout').addEventListener('click', () => openReaderWindow(state.selectedEntryID));
  document.getElementById('cap-zen').addEventListener('click', toggleZenMode);
  document.getElementById('cap-focus-session').addEventListener('click', () => views.focus?.open());
  document.getElementById('cap-autoscroll').addEventListener('click', () => views.reader?.toggleAutoScroll?.());
  document.getElementById('cap-focus').addEventListener('click', toggleFocusMode);

  // 批注按钮：高亮（有选区 → 快速高亮；无选区 → 批注面板）/ 笔记（批注面板）
  const capHl = document.getElementById('cap-highlight');
  let pendingSelection = '';
  if (capHl) {
    // 用 mousedown 捕获选区：click 触发时选区已被浏览器清空
    capHl.addEventListener('mousedown', () => {
      pendingSelection = window.getSelection()?.toString()?.trim() || '';
    });
    capHl.addEventListener('click', () => {
      if (!state.selectedEntryID) return;
      const selection = pendingSelection || window.getSelection()?.toString()?.trim() || '';
      pendingSelection = '';
      views.reader?.capsuleHighlight(selection);
    });
  }

  const capNote = document.getElementById('cap-note');
  capNote?.addEventListener('click', () => {
    if (!state.selectedEntryID) return;
    views.reader?.capsuleNote();
  });

  const capReview = document.getElementById('cap-review');
  capReview?.addEventListener('click', async () => {
    if (!state.selectedEntryID) return;
    await window.robin.kbAddToReview({ itemID: state.selectedEntryID });
    showToast(t('已加入复习队列'));
  });

  // 打开原文（阅读胶囊第 5 键，图标为地球）
  const capBrowser = document.getElementById('cap-browser');
  if (capBrowser) {
    capBrowser.addEventListener('click', () => {
      if (views.reader?.entry?.url) window.robin.openLink(views.reader.entry.url);
    });
  }
}

function updateCapBrowserState() {
  const btn = document.getElementById('cap-browser');
  if (btn) btn.disabled = !(views.reader?.entry?.url);
}

function currentEntryIsRead() {
  const item = state.listItems.find((entry) => entry.id === state.selectedEntryID);
  return item ? item.isRead : false;
}

/** 收藏切换 + 可发现性引导：收藏成功时 toast 附「查看收藏」直达侧栏收藏视图。 */
function toggleStarWithGuide() {
  if (!state.selectedEntryID) return;
  const item = state.listItems.find((entry) => entry.id === state.selectedEntryID);
  const willStar = !(item?.isStarred ?? views.reader?.entry?.isStarred);
  window.robin.toggleStar(state.selectedEntryID);
  if (willStar) {
    showToast(t('已收藏'), 1800, {
      label: t('查看收藏'),
      onClick: () => handleScopeSelect({ kind: 'starred' }),
    });
  } else {
    showToast(t('已取消收藏'));
  }
}

function updateToolbarState() {
  const refreshing = state.snapshot?.refreshStatus?.state === 'refreshing';
  document.getElementById('btn-refresh').classList.toggle('spinning', refreshing);
  document.getElementById('btn-mark-all').disabled = !currentHasUnread();
  document.getElementById('tb-list-title').textContent = headerTitle();

  const capsule = document.getElementById('reader-capsule');
  capsule.classList.toggle('visible', state.selectedEntryID != null);
  updateCapBrowserState();

  const item = state.listItems.find((entry) => entry.id === state.selectedEntryID);
  const capTranslate = document.getElementById('cap-translate');
  const tMode = views.reader?.translateMode || 'off';
  const modeLabels = { off: t('翻译：关闭'), bilingual: t('翻译：双语对照'), zh: t('翻译：仅中文') };
  capTranslate.classList.toggle('active', tMode !== 'off');
  capTranslate.title = `${modeLabels[tMode]} (C · 点击切换模式)`;
  const capRead = document.getElementById('cap-read');
  capRead.innerHTML = icon(item?.isRead ? 'envelopeOpen' : 'envelopeClosed');
  capRead.title = t(item?.isRead ? '标为未读' : '标为已读');
  const capStar = document.getElementById('cap-star');
  capStar.classList.toggle('active', Boolean(item?.isStarred));
  capStar.innerHTML = icon(item?.isStarred ? 'starFilled' : 'star');
  capStar.title = `${t(item?.isStarred ? '取消收藏' : '收藏')} (M)`;
  const capZen = document.getElementById('cap-zen');
  capZen.classList.toggle('active', state.zenMode);
  capZen.innerHTML = icon(state.zenMode ? 'collapse' : 'expand');
  capZen.title = t(state.zenMode ? '退出禅模式' : '禅模式全屏阅读');
}

function headerTitle() {
  if (state.selectedEntryID) {
    const item = state.listItems.find((entry) => entry.id === state.selectedEntryID);
    if (item) return item.sourceTitle;
  }
  return scopeTitle(state.scope);
}

function scopeTitle(scope) {
  switch (scope?.kind) {
    case 'today': return t('今天');
    case 'unread': return t('未读');
    case 'starred': return t('收藏');
    case 'later': return t('稍后读');
    case 'feed': {
      const feed = findFeed(scope.feedID);
      return feed ? feed.title : t('订阅');
    }
    case 'feeds': return tf('%lld 个订阅', scope.feedIDs.length);
    case 'folder': return scope.folderName;
    default: return '';
  }
}

function currentHasUnread() {
  switch (state.scope?.kind) {
    case 'today': return (state.snapshot?.sidebarCounts?.todayUnread ?? 0) > 0;
    case 'unread': return (state.snapshot?.sidebarCounts?.allUnread ?? 0) > 0;
    case 'starred': return false;
    case 'feed': return ((state.snapshot?.sidebarCounts?.unreadByFeed ?? {})[state.scope.feedID] ?? 0) > 0;
    case 'feeds': return state.scope.feedIDs.some((id) => ((state.snapshot?.sidebarCounts?.unreadByFeed ?? {})[id] ?? 0) > 0);
    case 'folder': {
      const counts = state.snapshot?.sidebarCounts?.unreadByFolder ?? {};
      return (counts[`${state.scope.accountID}::${state.scope.folderName}`] ?? counts[state.scope.folderName] ?? 0) > 0;
    }
    default: return false;
  }
}

async function markCurrentAllRead() {
  await window.robin.markAllRead(state.scope);
  // 保留当前选中，清空其余保留集
  state.retainedIDs = state.selectedEntryID ? new Set([state.selectedEntryID]) : new Set();
  await reloadList();
  showToast(t('已全部标为已读'));
}

function findFeed(feedID) {
  for (const account of state.sidebar) {
    if (account.account.id === 'local-default') continue;
    const feed = account.allFeeds?.find((f) => f.id === feedID);
    if (feed) return feed;
  }
  for (const account of state.sidebar) {
    const feed = account.allFeeds?.find((f) => f.id === feedID);
    if (feed) return feed;
  }
  return null;
}

// MARK: - 禅模式 / 侧栏折叠

function toggleZenMode() {
  state.zenMode = !state.zenMode;
  document.body.classList.toggle('zen', state.zenMode);
  if (state.zenMode) showToast(t('ESC 退出，按下 Ctrl+/ 查看快捷键'));
  updateToolbarState();
  syncToolbarZones();
  requestAnimationFrame(() => views.reader?.refreshScrollMetrics());
}

// ── 版式主题预设包（方向 3）：刊物级一键排版 ──
// 单一数据源：TYPOGRAPHY_PRESETS（src/renderer/data/typography-presets.js）

function applyPreset(name) {
  const preset = TYPOGRAPHY_PRESETS[name];
  if (!preset) return;
  window.robin.setReaderLayout(preset.patch);
  showToast(t('已应用版式预设') + '：' + ({ default: t('知更纸刊'), evening: t('新闻晚报'), minimal: t('极简留白'), eink: t('墨水屏') }[name] || name));
}

let readingControls = null;
function openReadingControls() {
  if (!state.selectedEntryID) { showToast(t('先打开一篇文章')); return; }
  readingControls = readingControls || new ReadingControls(views.reader, {
    onToggleFocus: () => toggleFocusMode(),
    onToggleZen: () => toggleZenMode(),
  });
  readingControls.open();
}

/** 聚焦模式（方向 11）：非当前段落渐暗，指针所在段保持清晰；会话级开关，再按退出。 */
function toggleFocusMode() {
  const on = document.body.classList.toggle('rp-focus');
  showToast(on ? t('聚焦模式：指针所在段落保持清晰，F 或再点按钮退出') : t('已退出聚焦模式'));
}

// MARK: - 命令面板（方向 22）

let commandPalette = null;

function buildPaletteCommands() {
  const commands = [
    { label: t('今天'), keywords: 'today 今日 open', icon: 'sun', hint: '1', action: () => handleScopeSelect({ kind: 'today' }) },
    { label: t('未读'), keywords: 'unread 未读 open', icon: 'envelopeClosed', hint: '2', action: () => handleScopeSelect({ kind: 'unread' }) },
    { label: t('收藏'), keywords: 'starred 收藏 star open', icon: 'star', action: () => handleScopeSelect({ kind: 'starred' }) },
    { label: t('稍后读'), keywords: 'later 稍后读 read later open', icon: 'clock', action: () => handleScopeSelect({ kind: 'later' }) },
    { label: t('切换杂志 / 列表视图'), keywords: 'magazine list view 杂志 列表 视图', icon: 'newspaper', action: () => window.robin.setReaderLayout({ listViewMode: window.__robinReaderLayout?.listViewMode === 'magazine' ? 'list' : 'magazine' }) },
    { label: t('切换浅色 / 深色主题'), keywords: 'theme dark light 主题 深色 浅色', icon: 'appearance', action: () => window.robin.setTheme(document.body.classList.contains('dark') ? 'light' : 'dark') },
    { label: t('知更纸刊（默认）'), keywords: 'preset 版式 预设 纸刊 默认', icon: 'bookOpen', action: () => applyPreset('default') },
    { label: t('新闻晚报'), keywords: 'preset 版式 报纸 晚报 紧凑', icon: 'newspaper', action: () => applyPreset('evening') },
    { label: t('极简留白'), keywords: 'preset 版式 极简 留白', icon: 'circle', action: () => applyPreset('minimal') },
    { label: t('墨水屏'), keywords: 'preset 版式 墨水屏 高对比', icon: 'info', action: () => applyPreset('eink') },
    { label: t('阅读控制中心'), keywords: 'reading controls 控制中心 阅读面板 aa', icon: 'textLarger', action: () => openReadingControls() },
    { label: t('自动滚动阅读'), keywords: 'auto scroll 自动滚动 悦读', icon: 'chevronDown', action: () => views.reader?.toggleAutoScroll?.() },
    { label: t('切换聚焦模式'), keywords: 'focus 聚焦 渐暗', icon: 'eye', hint: 'F', action: toggleFocusMode },
    { label: t('切换禅模式'), keywords: 'zen 禅 全屏', icon: 'expand', action: toggleZenMode },
    { label: t('今日简报'), keywords: 'digest 简报 日报 ai open', icon: 'spark', action: () => showTodayDigest() },
    { label: t('播放今日电台'), keywords: 'radio 电台 播报 简报 听 audio play', icon: 'radioDot', action: () => playTodayRadio() },
    { label: t('专注会话'), keywords: 'focus session 专注 番茄 计时', icon: 'clock', action: () => views.focus?.open() },
    { label: t('智能精选'), keywords: 'smart picks 精选 推荐 画像 兴趣 interest', icon: 'wand', action: () => toggleSmartPicks() },
    { label: t('媒体中心'), keywords: 'media podcast 播客 媒体 音频 视频 open', icon: 'playCircle', action: () => openMediaView() },
    { label: t('话题盯梢…'), keywords: 'topic track 盯梢 话题 关键词 订阅 open', icon: 'search', action: () => openTopicsView() },
    { label: t('AI 热点'), keywords: 'aihot 热点 趋势 open', icon: 'flame', action: openAihotView },
    { label: t('知识库'), keywords: 'knowledge 知识 高亮 复习 open', icon: 'bookOpen', hint: 'Ctrl+K', action: openKnowledgeCenter },
    { label: t('AI 深度研究…'), keywords: 'research 深度 研究 报告 ai open', icon: 'spark', action: () => openResearchView() },
    { label: t('搜索正文'), keywords: 'find search 搜索 正文 查找', icon: 'search', hint: 'Ctrl+F', action: () => { if (!state.selectedEntryID) { showToast(t('先打开一篇文章')); return; } views.reader?.articleSearch?.open(); } },
    { label: t('从链接精读…'), keywords: 'url link 链接 精读 extract openUrl', icon: 'globe', action: () => readFromUrlPrompt() },
    { label: t('设置'), keywords: 'settings 设置 preference open', icon: 'gear', action: () => showSettings('appearance') },
    { label: t('刷新全部订阅'), keywords: 'refresh 刷新 订阅', icon: 'refresh', action: () => window.robin.refresh() },
    syncPaletteCommand({ notify: (message) => showToast(message), silentError: false }),
    { label: t('增大字号'), keywords: 'font size larger 字号 增大', icon: 'textLarger', action: () => adjustFontSize(1) },
    { label: t('减小字号'), keywords: 'font size smaller 字号 减小', icon: 'textSmaller', action: () => adjustFontSize(-1) },
  ];
  // 全局组头（R24 补齐 R21 分组语义）：命令去冒号前缀后，归属信息由组头承担
  for (const c of commands) c.group = t('全局');
  // 订阅源直达：侧栏账号树展开为「来源」组命令（上限 40，防面板过长）
  const accounts = window.__robinSidebar || [];
  let added = 0;
  for (const account of accounts) {
    for (const feed of (account.allFeeds || [])) {
      if (added >= 40) break;
      if (!feed?.id) continue;
      commands.push({
        group: t('来源'),
        label: feed.title || feed.id,
        keywords: `feed 来源 ${feed.title || ''}`,
        icon: 'globe',
        action: () => handleScopeSelect({ kind: 'feed', feedID: feed.id }),
      });
      added += 1;
    }
    if (added >= 40) break;
  }
  // 期刊打开时：合并期刊专属命令置顶（R20；分组视觉 = 期刊 → 全局 → 来源，R24）
  const editionCommands = document.querySelector('.er-overlay')?.__editionReader?.paletteCommands?.();
  if (Array.isArray(editionCommands) && editionCommands.length) commands.unshift(...editionCommands);
  return commands;
}

function openCommandPalette() {
  commandPalette = commandPalette || new CommandPalette();
  commandPalette.present(buildPaletteCommands());
}

function toggleSidebarCollapsed() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem('robinread.sidebarCollapsed', state.sidebarCollapsed ? '1' : '');
  applySidebarCollapsed();
}

function applySidebarCollapsed() {
  const collapsed = state.sidebarCollapsed;
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  document.getElementById('sidebar').style.display = collapsed ? 'none' : '';
  document.getElementById('splitter-sidebar').style.display = collapsed ? 'none' : '';

  // 折叠时侧栏列消失、列表列左缘归 0；顶栏必须同步：
  // 侧栏区三按钮并入列表区最左、侧栏区隐藏，让阅读区 ::before 分割线与下方 splitter-list 对齐。
  const sidebarZone = document.querySelector('.tb-zone-sidebar');
  const listZone = document.getElementById('tb-zone-list');
  const sidebarButtons = document.querySelectorAll('#btn-toggle-sidebar, #btn-refresh, #btn-add');
  const listTitle = listZone.querySelector('.tb-title');

  if (collapsed && !state.zenMode) {
    for (const b of sidebarButtons) listZone.insertBefore(b, listTitle || listZone.firstChild);
    sidebarZone.style.display = 'none';
    listZone.style.display = '';
  } else {
    for (const b of sidebarButtons) sidebarZone.appendChild(b);
    sidebarZone.style.display = state.zenMode ? 'none' : '';
    listZone.style.display = state.zenMode ? 'none' : '';
  }
  syncToolbarZones();
}

function restoreSidebarCollapsed() {
  state.sidebarCollapsed = localStorage.getItem('robinread.sidebarCollapsed') === '1';
  applySidebarCollapsed();
}

/** 工具栏中区跟随列表栏左缘（顶栏区块左缘对齐列表栏分割线）。 */
function applyColumnWidths() {
  const sidebarWidth = state.snapshot?.preferences?.sidebarWidth || 240;
  const listWidth = state.snapshot?.preferences?.listWidth || 340;
  document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
  document.documentElement.style.setProperty('--list-width', `${listWidth}px`);
}

function syncToolbarZones() {
  const listEl = document.getElementById('list');
  const rect = listEl.getBoundingClientRect();
  const bodyRect = document.body.getBoundingClientRect();
  document.getElementById('tb-zone-list').style.minWidth = `${Math.max(0, rect.width)}px`;
}

// MARK: - 数据加载

async function reloadAll() {
  await reloadSidebar();
  await reloadList();
}

async function reloadSidebar() {
  const result = await window.robin.getSidebar();
  if (!result.ok) return;
  state.sidebar = result.data;
  window.__robinSidebar = result.data;
  window.__robinLanguage = state.snapshot?.language || 'zh';
  // 源健康：失败源在侧栏显示警示徽标（is_dead 或连续失败 ≥3）
  const health = await window.robin.storeHealth?.();
  views.sidebar.setHealth?.(health?.ok ? health.data : {});
  views.sidebar.render(state.sidebar, state.snapshot?.sidebarCounts, state.scope);
}

let lastListScopeKey = ''; // U11 骨架屏：视野切换在途时给列表占位（同视野静默刷新不打扰）
async function reloadList({ resetScroll = false } = {}) {
  const seq = ++listReqSeq; // P1-8：登记本次请求序号，过期返回直接丢弃
  const scopeKey = JSON.stringify(state.scope || {});
  if (scopeKey !== lastListScopeKey) {
    lastListScopeKey = scopeKey;
    views.list.showSkeleton(); // 数据落地后由 render() 整体覆盖
  }
  const result = await window.robin.getList(state.scope, { limit: 100, retainingIDs: [...state.retainedIDs], sort: currentListSort() });
  if (!result.ok) return;
  if (seq !== listReqSeq) return; // 已有更新请求在途/落地：本次结果过期
  state.listItems = result.data;
  // F10 智能精选：开启态只适用于 today/unread 视野——切到其他视野自动收起
  if (picksState.on && !ListView.picksEligible(state.scope)) {
    picksState.on = false;
    views.list.clearPicks();
  }
  if (picksState.on) {
    await refreshSmartPicks({ resetScroll });
  } else {
    views.list.render(state.listItems, state.scope, state.selectedEntryID, currentHasUnread());
  }
  views.list.setDigestVisible(state.scope?.kind === 'today' || state.scope?.kind === 'unread');
  views.list.setPicksVisible(ListView.picksEligible(state.scope));
  // 智能稍后读（方向 23）：稍后读视野下出现「清理超龄」入口（入队超 14 天）
  const overdue = state.scope?.kind === 'later' ? laterOverdueIDs() : [];
  views.list.setLaterCleanup(overdue);
  views.list.setLaterAges(laterAgeMap());
  views.list.setResume(state.scope?.kind === 'today' ? views.reader?.resumeCandidate?.() || null : null);
  updateToolbarState();
  if (resetScroll) views.list.scrollTop();
}

// MARK: - 智能每日精选（F10：工具栏「精选」切换 / 播报 / 不感兴趣）

/** 「精选」切换：开 = 拉取画像 Top N 并让列表让位；关 = 回普通列表。 */
async function toggleSmartPicks() {
  picksState.on = !picksState.on;
  if (!picksState.on) {
    views.picksTTS?.stop();
    views.list.clearPicks();
    await reloadList();
    return;
  }
  await refreshSmartPicks({ resetScroll: true });
}

/** 拉取精选载荷（主进程即时重算画像 + 排序），驱动精选视图渲染。 */
async function refreshSmartPicks({ resetScroll = false } = {}) {
  if (!picksState.on || !ListView.picksEligible(state.scope)) return;
  const seq = ++picksState.seq;
  const payload = await window.robin.picksGet();
  if (seq !== picksState.seq) return; // 快速切换/重排竞态：过期载荷丢弃
  if (!payload || !Array.isArray(payload.picks)) {
    showToast(t('精选暂时不可用，请稍后再试。'));
    return;
  }
  views.list.setPicks(payload);
  views.list.setPicksVisible(true);
  if (resetScroll) views.list.scrollTop();
}

/** 「播报精选」：拼简报文稿 → PicksTTSPlayer 流式合成播放；播放中再点 = 停止。 */
async function broadcastSmartPicks() {
  if (!views.picksTTS) return;
  if (views.picksTTS.state !== 'idle') {
    views.picksTTS.stop();
    return;
  }
  const result = await window.robin.picksBroadcast();
  if (!result?.script) {
    showToast(t('还没有可播报的精选。'));
    return;
  }
  await views.picksTTS.play(result.script);
}

// MARK: - 简报电台（F19：简报浮层入口 / 命令面板 / 播放中再点 = 停止）

/** AI 改写门：有 Key 且会员/额度门通过才请求 AI 文稿，否则主进程自动降级模板。 */
async function radioPreferAI() {
  if (window.__robinLLM?.__hasKey === false) return false;
  try {
    return await views.account?.gateAI?.() === true;
  } catch (_) {
    return false;
  }
}

/** 「播放今日电台」：idle → 开播；播放中/暂停 → 停止（再点语义与精选播报一致）。 */
async function playTodayRadio() {
  if (!views.radio) return;
  if (views.radio.state !== 'idle') {
    views.radio.stop();
    return;
  }
  await views.radio.play();
}

/** 「不感兴趣」：主进程记入 24h 排除名单，前端即时重排。 */
async function dismissSmartPick(entryID) {
  try {
    await window.robin.picksExclude(entryID);
    showToast(t('已移出精选，24 小时内不再推荐。'));
  } catch (e) {
    showToast(String(e && e.message || e) || t('操作失败'));
  }
  await refreshSmartPicks();
}

async function runSearch(query) {
  if (!query) {
    views.list.setSearchMode(false);
    state.activeQuery = '';
    state.searchMode = false; // P1-5：清空搜索退出搜索态，后续进文不再自动高亮
    views.list.setDigestVisible(state.scope?.kind === 'today' || state.scope?.kind === 'unread');
    await reloadList();
    return;
  }
  state.activeQuery = query;
  state.searchMode = true; // P1-5：从搜索结果进入文章 → reader.searchAfterOpen 自动高亮首个命中
  views.list.setSearchMode(true);
  views.list.setDigestVisible(false);
  views.list.setPicksVisible(false); // F10：搜索态收起精选入口（清空搜索后经 reloadList 恢复）
  views.list.showSkeleton(); // U11：全文检索在途占位
  // 优先全文搜索（含正文），空结果回退到标题/摘要搜索
  let items = await window.robin.fullTextSearch(query);
  if (!items || !items.length) {
    const result = await window.robin.search(query);
    items = result.ok ? result.data : [];
  }
  state.listItems = items || [];
  views.list.render(items || [], { kind: 'search' }, state.selectedEntryID, false);
  updateToolbarState();
}

/** 简报可视化渲染：主视觉/统计徽章/主题卡片/来源芯片（[n] 可点击跳转原文）。 */
function renderDigestVisual(raw, refs, meta, onClose = null) {
  const refMap = new Map((refs || []).map((r) => [r.n, r]));
  const host = document.createElement('div');
  host.className = 'digest-visual';

  // ── 主视觉：日期 + 统计徽章 ──
  const now = new Date();
  const locale = window.__robinLanguage === 'en' ? 'en-US' : 'zh-CN';
  const dateStr = now.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
  // P2-5：星期名改按界面语言经 Intl 取（原 t('星期'+week) 动态拼 key 永不命中）
  const weekdayStr = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now);
  const hero = document.createElement('div');
  hero.className = 'dg-hero';
  const topicCount = (String(raw).match(/^## 主题：/gm) || []).length;
  const modeLabel = meta?.mode === 'deep' ? t('精读版') : t('简报版');
  hero.innerHTML = `
    <div class="dg-hero-date"></div>
    <div class="dg-hero-sub">${escapeHTMLInline(t('今日 AI 简报'))} · ${escapeHTMLInline(modeLabel)} · ${escapeHTMLInline(weekdayStr)}</div>
    <div class="dg-hero-stats">
      <span class="dg-stat"><b>${meta?.items ?? '—'}</b>${escapeHTMLInline(t('篇文章'))}</span>
      <span class="dg-stat"><b>${topicCount || '—'}</b>${escapeHTMLInline(t('个主题'))}</span>
      <span class="dg-stat"><b>${(refs || []).length}</b>${escapeHTMLInline(t('个来源'))}</span>
    </div>`;
  hero.querySelector('.dg-hero-date').textContent = dateStr;
  host.appendChild(hero);

  // ── 正文分节渲染 ──
  const lines = String(raw).split('\n');
  let mode = 'plain';            // overview | topic | deepread | plain
  let card = null;               // 当前主题卡
  let topicNo = 0;
  const chip = (n) => {
    const r = refMap.get(n);
    const el = document.createElement('button');
    el.className = 'dg-ref' + (r ? '' : ' missing');
    el.textContent = String(n);
    el.title = r ? r.title : t('来源已失效');
    if (r) el.addEventListener('click', () => {
      onClose?.();
      handleEntrySelect(r.id, null);
    });
    return el;
  };
  const addBullet = (text, target) => {
    const li = document.createElement('div');
    li.className = 'dg-li';
    // 拆出 [n] 来源编号 → 芯片
    const parts = String(text).split(/(\[\d+\])/g);
    for (const p of parts) {
      const m = p.match(/^\[(\d+)\]$/);
      if (m) { li.appendChild(chip(Number(m[1]))); continue; }
      if (!p.trim()) continue;
      const span = document.createElement('span');
      span.className = 'dg-li-text';
      // 加粗短语
      const bold = p.match(/^\*\*(.+?)\*\*\s*([\s\S]*)$/);
      if (bold) {
        const b = document.createElement('b');
        b.textContent = bold[1];
        span.appendChild(b);
        span.appendChild(document.createTextNode(bold[2]));
      } else {
        span.textContent = p.replace(/\*\*/g, '');
      }
      li.appendChild(span);
    }
    target.appendChild(li);
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^##\s*总览/.test(line)) { mode = 'overview'; continue; }
    if (/^##\s*值得深读/.test(line)) {
      mode = 'deepread';
      card = document.createElement('div');
      card.className = 'dg-deepread';
      card.innerHTML = `<div class="dg-deepread-head">${icon('starFilled')}<span></span></div><div class="dg-deepread-body"></div>`;
      card.querySelector('span').textContent = t('今日值得深读');
      host.appendChild(card);
      continue;
    }
    const topic = line.match(/^##\s*主题[：:]\s*(.+)$/);
    if (topic) {
      mode = 'topic';
      topicNo += 1;
      card = document.createElement('div');
      card.className = 'dg-topic';
      card.innerHTML = `<div class="dg-topic-head"><span class="dg-topic-no"></span><span class="dg-topic-title"></span></div><div class="dg-topic-list"></div>`;
      card.querySelector('.dg-topic-no').textContent = String(topicNo).padStart(2, '0');
      card.querySelector('.dg-topic-title').textContent = topic[1].replace(/\*\*/g, '');
      host.appendChild(card);
      continue;
    }
    // 精读版：逐篇深度解读节
    const deepSec = line.match(/^##\s*精读[：:]\s*(.+)$/);
    if (deepSec) {
      mode = 'deepsec';
      topicNo += 1;
      card = document.createElement('div');
      card.className = 'dg-topic dg-deep-sec';
      card.innerHTML = `<div class="dg-topic-head"><span class="dg-topic-no"></span><span class="dg-topic-title"></span></div><div class="dg-topic-body"></div>`;
      card.querySelector('.dg-topic-no').textContent = String(topicNo).padStart(2, '0');
      card.querySelector('.dg-topic-title').textContent = deepSec[1].replace(/\*\*/g, '');
      host.appendChild(card);
      continue;
    }
    if (/^##\s*今日一句话/.test(line)) {
      mode = 'deepread';
      card = document.createElement('div');
      card.className = 'dg-deepread';
      card.innerHTML = `<div class="dg-deepread-head">${icon('spark')}<span></span></div><div class="dg-deepread-body"></div>`;
      card.querySelector('span').textContent = t('今日一句话');
      host.appendChild(card);
      continue;
    }
    if (/^#/.test(line) || mode === 'plain') continue; // 其它标题忽略
    const bullet = line.match(/^[-*]\s+(.+)$/) || line.match(/^\d+[.、]\s+(.+)$/);
    if (mode === 'overview' && card === null) {
      // 总览段落：大字引言卡
      const ov = host.querySelector('.dg-overview') || (() => {
        const d = document.createElement('div');
        d.className = 'dg-overview';
        host.insertBefore(d, host.children[1] || null);
        return d;
      })();
      if (bullet) addBullet(bullet[1], ov);
      else { const p = document.createElement('p'); p.textContent = line.replace(/\*\*/g, ''); ov.appendChild(p); }
      continue;
    }
    if (mode === 'topic' && card) { if (bullet) addBullet(bullet[1], card.querySelector('.dg-topic-list')); continue; }
    if (mode === 'deepsec' && card) {
      // 精读节正文：段落文本 + 行内 [n] 来源芯片
      const bodyEl = card.querySelector('.dg-topic-body');
      const p = document.createElement('p');
      for (const part of line.split(/(\[\d+\])/)) {
        const m = part.match(/^\[(\d+)\]$/);
        if (m) { p.appendChild(chip(Number(m[1]))); continue; }
        if (!part) continue;
        p.appendChild(document.createTextNode(part.replace(/\*\*/g, '')));
      }
      bodyEl.appendChild(p);
      continue;
    }
    if (mode === 'deepread' && card) {
      const bodyEl = card.querySelector('.dg-deepread-body');
      if (bullet) addBullet(bullet[1], bodyEl);
      else { const p = document.createElement('p'); p.textContent = line.replace(/\*\*/g, ''); bodyEl.appendChild(p); }
      continue;
    }
  }
  return host;
}

async function showTodayDigest({ forceRegenerate = false, mode = 'brief' } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'modal digest-modal';
  modal.innerHTML = `
    <div class="modal-header"><h3>${escapeHTMLInline(t('今日 AI 简报'))}</h3>
      <div class="dg-mode-seg" role="tablist">
        <button id="digest-mode-brief" class="${mode === 'brief' ? 'on' : ''}">${escapeHTMLInline(t('简报版'))}</button>
        <button id="digest-mode-deep" class="${mode === 'deep' ? 'on' : ''}">${escapeHTMLInline(t('精读版'))}</button>
      </div>
      <button class="btn icon-only" id="digest-full" title="${escapeHTMLInline(t('全屏'))}" style="margin-right:8px;">${icon('expand')}</button>
      <button class="btn-text" id="digest-radio" style="display:none;margin-right:8px;"></button>
      <button class="btn-text" id="digest-copy" style="display:none;margin-right:8px;"></button>
      <button class="btn-text" id="digest-regen" style="display:none;margin-right:8px;"></button>
      <button class="btn icon-only" id="digest-close">${''}</button></div>
    <div class="digest-body loading">${escapeHTMLInline(t('正在汇总今天的文章…'))}</div>`;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) overlay.remove(); });
  modal.querySelector('#digest-close').innerHTML = icon('close');
  modal.querySelector('#digest-close').addEventListener('click', () => overlay.remove());
  const fullBtn = modal.querySelector('#digest-full');
  fullBtn.addEventListener('click', () => {
    const on = modal.classList.toggle('is-full');
    fullBtn.innerHTML = icon(on ? 'collapse' : 'expand');
  });
  modal.querySelector('#digest-mode-brief').addEventListener('click', () => {
    if (mode !== 'brief') { overlay.remove(); showTodayDigest({ mode: 'brief' }); }
  });
  modal.querySelector('#digest-mode-deep').addEventListener('click', () => {
    if (mode !== 'deep') { overlay.remove(); showTodayDigest({ mode: 'deep' }); }
  });

  const body = modal.querySelector('.digest-body');
  const regenBtn = modal.querySelector('#digest-regen');
  const copyBtn = modal.querySelector('#digest-copy');
  const radioBtn = modal.querySelector('#digest-radio');
  regenBtn.textContent = t('重新生成');
  copyBtn.textContent = t('复制全文');
  radioBtn.textContent = t('电台播放');
  radioBtn.addEventListener('click', () => playTodayRadio());
  let lastContent = '';
  let lastRefs = [];
  copyBtn.addEventListener('click', async () => {
    const ok = await window.robin.copyText(lastContent);
    showToast(ok ? t('已复制简报全文') : t('复制失败'));
  });
  regenBtn.addEventListener('click', () => {
    overlay.remove();
    showTodayDigest({ forceRegenerate: true, mode });
  });

  // 性能：流式 delta 高频到达——rAF 合帧渲染（一帧至多一次全量重建），
  // 且仅当用户本就停在底部时才自动跟随滚动（翻看上文不被拽回底部）
  let rafPending = false;
  let pendingPaint = null;
  const renderInto = (content, refs, meta, streaming) => {
    lastContent = content || '';
    lastRefs = refs || [];
    pendingPaint = { content, refs, meta, streaming };
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const job = pendingPaint;
      pendingPaint = null;
      if (!job || !document.body.contains(body)) return; // 弹窗已关闭
      const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
      body.classList.remove('loading');
      body.classList.toggle('streaming', !!job.streaming);
      body.innerHTML = '';
      body.appendChild(renderDigestVisual(job.content, job.refs, { ...job.meta, mode }, () => overlay.remove()));
      if (nearBottom) body.scrollTop = body.scrollHeight; // 首帧/缓存渲染时内容未溢出，等效始终落底
    });
  };

  // 当日缓存：秒开渲染 + 提供「重新生成」；强制重新生成或无缓存时走流式
  if (!forceRegenerate) {
    const cached = await window.robin.cachedDigest(mode);
    if (cached?.ok && cached.data?.content) {
      renderInto(cached.data.content, cached.data.entryRefs, cached.data, false);
      regenBtn.style.display = '';
      copyBtn.style.display = '';
      radioBtn.style.display = '';
      mountDigestGoal(body);
      return;
    }
  }
  regenBtn.style.display = 'none';
  radioBtn.style.display = 'none';

  // 生成属 AI 功能：过会员/每日额度门（缓存命中不消耗额度）
  if (!(await views.account?.gateAI())) {
    body.classList.remove('loading');
    body.textContent = t('生成今日简报需要会员或每日 AI 额度。');
    return;
  }

  // 流式阶段按可视化渲染（增量全量重绘）
  let streamed = '';
  let done = false;
  const unsubscribe = window.robin.onDigestDelta((payload) => {
    if (done) return;
    streamed += payload.delta || '';
    renderInto(streamed, [], { items: null }, true);
  });

  const result = await window.robin.generateDigest(mode);
  done = true;
  unsubscribe?.();
  if (!result.ok) {
    body.classList.remove('streaming');
    body.classList.add('loading');
    body.textContent = result.error || t('生成失败');
    regenBtn.style.display = '';
    return;
  }
  renderInto(result.data?.content || streamed, result.data?.entryRefs, result.data, false);
  regenBtn.style.display = '';
  copyBtn.style.display = '';
  radioBtn.style.display = '';
  mountDigestGoal(body);
}

/**
 * 今日简报浮层的阅读目标进度卡（F20）：SVG 进度环（今日 N/目标 M）+ 周进度条。
 * 双目标都关闭（0）时不渲染；数据走 goal:progress 聚合通道（reading_stats 按日）。
 */
function mountDigestGoal(body) {
  // renderInto 内部经 rAF 合帧重绘——双 rAF 等首帧绘制完成后再插入，避免被整表重建清掉
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    if (!document.body.contains(body) || body.querySelector('.dg-goal')) return;
    let progress = null;
    try {
      progress = await window.robin.goalProgress?.();
    } catch (_) {
      progress = null;
    }
    if (!progress || !document.body.contains(body) || body.querySelector('.dg-goal')) return;
    if (!progress.daily?.enabled && !progress.weekly?.enabled) return; // 目标全关：隐藏
    const wrap = document.createElement('div');
    wrap.className = 'dg-goal';
    wrap.dataset.role = 'digest-goal';
    const R = 20;
    const C = 2 * Math.PI * R;
    const d = progress.daily;
    const w = progress.weekly;
    const dailyPart = d.enabled ? `
      <div class="dg-goal-ring ${d.done ? 'done' : ''}" title="${escapeHTMLInline(t('今日阅读目标'))}">
        <svg viewBox="0 0 48 48" role="img">
          <circle class="dg-goal-track" cx="24" cy="24" r="${R}"/>
          <circle class="dg-goal-fill" cx="24" cy="24" r="${R}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - d.pct)).toFixed(1)}"/>
        </svg>
        <span class="dg-goal-num"><b>${d.read}</b>/${d.goal}</span>
      </div>
      <span class="dg-goal-label">${escapeHTMLInline(t('今日阅读目标'))}${d.done ? ` · ${escapeHTMLInline(t('已达成'))}` : ''}</span>` : '';
    const weeklyPart = w.enabled ? `
      <div class="dg-goal-week">
        <span class="dg-goal-label">${escapeHTMLInline(t('本周'))}</span>
        <span class="dg-goal-bar"><i style="width:${Math.round(w.pct * 100)}%"></i></span>
        <span class="dg-goal-weeknum">${w.read}/${w.goal}</span>
      </div>` : '';
    wrap.innerHTML = `${dailyPart}${weeklyPart}`;
    body.insertBefore(wrap, body.firstChild);
  }));
}

function escapeHTMLInline(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 同题对比速读（方向 14 v1）：聚类行「AI 速读」按钮 → 多源同题报道的 AI 融合对比弹窗。
 * 与今日简报同管线约定：门控在渲染层（gateAI），材料用列表摘要预览，来源编号点击跳原文。
 */
async function showClusterBrief(items) {
  const list = (items || []).filter((it) => it && it.title);
  if (list.length < 2) return;
  if (!(await views.account?.gateAI())) {
    showToast(t('对比速读需要会员或每日 AI 额度。'));
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) overlay.remove(); });
  const modal = document.createElement('div');
  modal.className = 'modal nj-brief-modal';
  modal.innerHTML = `
    <div class="nj-brief-head">
      <h3></h3>
      <span class="nj-brief-sub"></span>
      <button class="nj-brief-close">${icon('close')}</button>
    </div>
    <div class="nj-brief-body loading"></div>
    <div class="nj-brief-refs"></div>
    <div class="nj-brief-foot"><button class="btn-text nj-brief-copy"></button></div>`;
  modal.querySelector('h3').textContent = t('同题对比速读');
  modal.querySelector('.nj-brief-sub').textContent = `${list.length} ${t('个来源')}`;
  modal.querySelector('.nj-brief-close').addEventListener('click', () => overlay.remove());
  modal.querySelector('.nj-brief-copy').textContent = t('复制全文');
  const body = modal.querySelector('.nj-brief-body');
  const refsHost = modal.querySelector('.nj-brief-refs');
  const copyBtn = modal.querySelector('.nj-brief-copy');
  let lastContent = '';
  copyBtn.addEventListener('click', async () => {
    const ok = await window.robin.copyText(lastContent);
    showToast(ok ? t('已复制') : t('复制失败'));
  });
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const result = await window.robin.clusterBrief(list.map((it) => ({
    id: it.id, title: it.title, sourceTitle: it.sourceTitle || '', summaryPreview: it.summaryPreview || '',
  }))).catch((error) => ({ ok: false, error: String(error?.message || error) }));
  body.classList.remove('loading');
  if (!result.ok) {
    body.textContent = result.error || t('生成失败');
    return;
  }
  lastContent = result.data?.content || '';
  body.innerHTML = renderMarkdown(lastContent);
  copyBtn.style.display = '';
  for (const ref of result.data?.refs || []) {
    const chip = document.createElement('button');
    chip.className = 'dg-ref';
    chip.textContent = String(ref.n);
    chip.title = ref.title || '';
    chip.addEventListener('click', () => {
      overlay.remove();
      handleEntrySelect(ref.id, null);
    });
    refsHost.appendChild(chip);
  }
}

/** 整期导出 EPUB（方向 19b）：刊头「导出本期」→ 主进程打包 → 存盘。 */
async function showEditionExport(entryIDs) {
  const ids = (entryIDs || []).slice(0, 40);
  if (!ids.length) return;
  showToast(t('正在打包本期 EPUB…'));
  try {
    const base64 = await window.robin.exportEditionEpub(ids);
    if (!base64) throw new Error(t('导出失败：没有可导出的内容。'));
    const picked = await window.robin.pickSavePath(`知更-本期-${new Date().toISOString().slice(0, 10)}.epub`);
    const filePath = picked?.ok ? picked.data : null;
    if (!filePath) return; // 用户取消
    const written = await window.robin.writeBinaryFile(filePath, base64);
    if (!written?.ok) throw new Error(written?.error || t('写入文件失败'));
    showToast(t('已导出'));
  } catch (err) {
    showToast(`${t('导出失败')}：${err?.message || err}`);
  }
}
async function loadMoreEntries() {
  if (state.listItems.length === 0 || state.listItems.length % 100 !== 0) return;
  const result = await window.robin.getList(state.scope, {
    limit: 100, offset: state.listItems.length, sort: currentListSort(),
  });
  if (!result.ok || result.data.length === 0) return;
  const existing = new Set(state.listItems.map((entry) => entry.id));
  const fresh = result.data.filter((entry) => !existing.has(entry.id));
  if (fresh.length === 0) return;
  state.listItems.push(...fresh);
  views.list.appendRows(fresh);
}

// MARK: - 智能稍后读（方向 23）：入队时间记录 + 超龄清理（14 天）

const LATER_AGE_KEY = 'robinread.later.addedAt';
const LATER_OVERDUE_DAYS = 14;

function laterAgeMap() {
  try { return JSON.parse(localStorage.getItem(LATER_AGE_KEY) || '{}') || {}; } catch (_) { return {}; }
}

/** 稍后读唯一入口：切状态的同时记录入队时间（退出时清除），供超龄判定与清理。 */
function __robinMarkLater(entryID, on) {
  const map = laterAgeMap();
  if (on) map[entryID] = Math.floor(Date.now() / 1000);
  else delete map[entryID];
  const entries = Object.entries(map);
  if (entries.length > 500) {
    entries.sort((a, b) => a[1] - b[1]);
    for (const [id] of entries.slice(0, entries.length - 500)) delete map[id];
  }
  try { localStorage.setItem(LATER_AGE_KEY, JSON.stringify(map)); } catch (_) { /* 忽略 */ }
  window.robin.toggleLater(entryID, on);
}

function laterOverdueIDs() {
  const cutoff = Math.floor(Date.now() / 1000) - LATER_OVERDUE_DAYS * 86400;
  const map = laterAgeMap();
  return state.listItems.filter((it) => it.isLater && map[it.id] && map[it.id] < cutoff).map((it) => it.id);
}

window.__robinMarkLater = __robinMarkLater;

/** 批量清理超龄稍后读：标记已读并移出队列。 */
async function cleanupOverdueLater(ids) {
  if (!ids?.length) return;
  for (const id of ids) {
    await window.robin.markRead(id, true);
    await window.robin.toggleLater(id, false);
  }
  showToast(tf('已清理 %lld 篇超龄稍后读', ids.length));
  await reloadList({ resetScroll: true });
  reloadSidebar();
}

// MARK: - 选择

function handleScopeSelect(scope) {
  if (sameScope(scope, state.scope)) return;
  cancelNavConfirmation(true);
  state.scope = scope;
  state.selectedEntryID = null;
  state.retainedIDs.clear();
  state.searchMode = false; // P1-5：切换视野退出搜索态——残留 searchMode 会让旧查询误高亮新文章
  state.activeQuery = '';
  views.list.clearSearch?.();
  views.reader.clear();
  reloadSidebar();
  reloadList({ resetScroll: true });
}

function sameScope(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 当前列表排序（主进程 listItems sort 参数）。
 * 四态透传（批次 A 审查 B1）：既有实现坍缩为二态，shortFirst/smart 从渲染层永远不可达。 */
function currentListSort() {
  const s = window.__robinReaderLayout?.listSort;
  return ['time', 'unreadFirst', 'shortFirst', 'smart'].includes(s) ? s : 'time';
}

/** 下一篇文章打开的翻页方向（'fwd' 正翻 / 'back' 回翻），由打开动作设置、handleEntrySelect 消费。 */
let pendingPageTurn = null;

async function handleEntrySelect(entryID, item) {
  state.selectedEntryID = entryID;
  views.focus?.countRead?.(); // F20 专注会话：会话期间打开文章计数（内存对象）
  if (state.scope.kind === 'unread') {
    state.retainedIDs.add(entryID);
    // 保留集无界增长会让 unread 过滤 SQL 恶化（IN 参数膨胀），封顶 500
    if (state.retainedIDs.size > 500) {
      const oldest = state.retainedIDs.values().next().value;
      state.retainedIDs.delete(oldest);
    }
  } else {
    state.retainedIDs.clear();
  }
  views.list.markSelected(entryID);
  updateToolbarState();
  const turn = pendingPageTurn || (item ? 'fwd' : null);
  pendingPageTurn = null;
  // 搜索定位闭环：从搜索结果进入的文章，打开后自动高亮该查询
  views.reader.searchAfterOpen = state.searchMode && state.activeQuery ? state.activeQuery : '';
  await views.reader.open(entryID, { turn });
  // 自动精读可能在 open 内改变翻译模式：确定性刷新胶囊状态
  updateToolbarState();
  if (item && !item.isRead) {
    window.robin.markRead(entryID, true);
    maybeCelebrateGoal(); // F20：今日目标达成时一次性恭喜（主进程记 lastCelebrateDate）
  }
}

// MARK: - 阅读目标（F20）：达标恭喜一次性（当日不重复，判定在主进程）

let celebrateInFlight = false;
function maybeCelebrateGoal() {
  if (celebrateInFlight) return;
  celebrateInFlight = true;
  window.robin.goalCelebrate?.().then((result) => {
    if (result?.celebrated) {
      showToast(tf('今日阅读目标达成（%lld/%lld），读得漂亮！', result.progress.daily.read, result.progress.daily.goal), 4200);
    }
  }).catch(() => { /* 静默：庆祝失败不影响阅读 */ }).finally(() => {
    celebrateInFlight = false;
  });
}

// MARK: - 相邻导航（B/N/空格，双击确认 + toast）

function requestAdjacentArticle(direction) {
  if (!state.selectedEntryID) { cancelNavConfirmation(true); return; }
  const isPrev = direction === 'previous';
  const prompt = isPrev ? t('再次按下 B 查看上一篇') : t('再次按下 N 查看下一篇');
  const boundary = isPrev ? t('已经是列表第一篇') : t('列表已经阅读完毕');
  runWithConfirmation(
    isPrev ? 'prev-article' : 'next-article',
    prompt,
    async () => {
      const result = await window.robin.getAdjacent(state.scope, state.selectedEntryID, direction);
      return result.ok ? result.data : null;
    },
    boundary,
    isPrev ? 'back' : 'fwd',
  );
}

function selectNextEntry() {
  runWithConfirmation(
    'space-next-article',
    tf('再次按下空格，切换下一篇。未读 %lld 篇', Math.max(1, state.snapshot?.sidebarCounts?.allUnread ?? 1)),
    async () => {
      if (!state.selectedEntryID) {
        const result = await window.robin.getList(state.scope, { limit: 1 });
        return result.ok && result.data.length ? result.data[0] : null;
      }
      const result = await window.robin.getAdjacent(state.scope, state.selectedEntryID, 'next');
      return result.ok ? result.data : null;
    },
    t('列表已经阅读完毕'),
    'fwd',
  );
}

/**
 * 1:1 对应 confirmNavigation：同一 key 在有效期内第二次触发才执行；
 * toast 展示剩余时间后自动过期取消。
 */
async function runWithConfirmation(key, prompt, resolveTarget, boundaryMessage, turn = null) {
  const now = Date.now();
  const active = navConfirmation && navConfirmation.key === key
    && navConfirmation.entryID === state.selectedEntryID
    && navConfirmation.expiresAt > now;

  if (!active) {
    const expiresAt = now + 1600;
    clearTimeout(navConfirmation?.timer);
    navConfirmation = { key, entryID: state.selectedEntryID, expiresAt, timer: setTimeout(() => { navConfirmation = null; }, 1600) };
    showToast(prompt, 1600);
    return;
  }

  clearTimeout(navConfirmation.timer);
  navConfirmation = null;
  dismissToast();

  const target = await resolveTarget();
  if (!target) {
    showToast(boundaryMessage);
    return;
  }
  pendingPageTurn = turn;
  await handleEntrySelect(target.id, target);
  views.list.scrollToEntry(target.id);
}

function cancelNavConfirmation(dismissToastAlso) {
  if (navConfirmation) {
    clearTimeout(navConfirmation.timer);
    navConfirmation = null;
  }
  if (dismissToastAlso) dismissToast();
}

// MARK: - Toast（U13 自绘栈；旧 showToast 签名委托 toast.js，全部既有调用点零改动）

/** showToast(message, duration?, action?) — action: { label, onClick }（收藏后「查看收藏」直达）。 */
function showToast(message, duration = 1800, action = null) {
  return Toast.show(message, { duration, action }); // 带动作的提示在 toast.js 内保底 ≥4.2s
}

function dismissToast() {
  Toast.dismissTop();
}

// MARK: - 栏焦点

function setActiveColumn(index, { autoSelect = true } = {}) {
  if (state.zenMode && index < 2) index = 2;
  state.activeColumn = index;
  document.querySelectorAll('.column').forEach((el) => el.classList.remove('column-focused'));
  const map = ['sidebar', 'list', 'reader'];
  const el = document.getElementById(map[index]);
  if (el) el.classList.add('column-focused');
  if (index === 1 && autoSelect && !state.selectedEntryID && state.listItems.length) {
    handleEntrySelect(state.listItems[0].id, state.listItems[0]);
  }
  if (index === 2) views.reader?.focus();
}

// MARK: - 键盘（1:1 对应 ReaderShortcutPolicy + 三栏协调器）

document.addEventListener('rc-focus-toggle', () => toggleFocusMode());
document.addEventListener('rc-zen-toggle', () => toggleZenMode());
function bindKeyboard() {
  document.addEventListener('keydown', (event) => {
    // 阅读控制中心开启：屏蔽全部全局键（Esc 关闭由面板自身处理）
    if (document.querySelector('.rc-overlay')) {
      if (event.key === 'Escape') {
        event.preventDefault();
        readingControls?.close();
      }
      return;
    }
    const target = event.target;
    const typing = target instanceof HTMLElement && (
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable
    );

    // ESC：退出禅模式
    if (event.key === 'Escape' && state.zenMode) {
      event.preventDefault();
      toggleZenMode();
      return;
    }

    // Cmd/Ctrl + / − / 0 字号
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      if (event.key === '=' || event.key === '+') { event.preventDefault(); adjustFontSize(+1); return; }
      if (event.key === '-' || event.key === '_') { event.preventDefault(); adjustFontSize(-1); return; }
      if (event.key === '0') { event.preventDefault(); adjustFontSize(0); return; }
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyR') {
      event.preventDefault(); window.robin.refresh(); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyK') {
      event.preventDefault(); openKnowledgeCenter(); return;
    }
    // Ctrl/Cmd+Shift+P：命令面板（方向 22）
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyP') {
      event.preventDefault(); openCommandPalette(); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.code === 'Slash') {
      event.preventDefault(); new ShortcutsView().present(); return;
    }

    // 期刊打开（P1-4）：裸键整体让路——期刊 _keydown 以 capture 阶段独占键盘
    // （与 list.js _navKey 对 .er-overlay 的既有约定一致，杜绝 j/k/F/S/空格/←→ 双触发）。
    // Ctrl/Cmd 系全局快捷键（上方分支）不在此列：命令面板在期刊打开时仍可用（R20 期刊命令组）
    if (document.querySelector('.er-overlay')) return;

    if (typing) return;

    // j/k 下一篇/上一篇（列表导航，vim 风格）
    // P1-7：仅阅读器为活动栏时由全局处理器做上/下一篇导航；列表/侧栏栏活动时
    // 让路给 R28 光标模型（list.js _navKey：J/K 移光标，Enter/O 打开），不再双开
    if (event.code === 'KeyJ' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (state.activeColumn !== 2) return;
      event.preventDefault();
      navigateList(1);
      return;
    }
    // F：聚焦模式（方向 11）
    if (event.code === 'KeyF' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      toggleFocusMode();
      return;
    }
    // A：阅读控制中心（阅读器栏聚焦时）
    if (event.code === 'KeyA' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && state.selectedEntryID) {
      event.preventDefault();
      openReadingControls();
      return;
    }
    // Shift+G 跳到文末；g g 双击跳到文首（vim 惯例）
    if (event.code === 'KeyG' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const el = views.reader?.scrollEl;
      if (el) el.scrollTop = el.scrollHeight;
      return;
    }
    if (event.code === 'KeyG' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const now = Date.now();
      const last = window.__robinLastGPress || 0;
      window.__robinLastGPress = now;
      if (now - last < 600) {
        window.__robinLastGPress = 0;
        event.preventDefault();
        const el = views.reader?.scrollEl;
        if (el) el.scrollTop = 0;
      } else {
        showToast(t('再按一次 G 回到顶部'), 700);
      }
      return;
    }
    if (event.code === 'KeyK' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (state.activeColumn !== 2) return; // P1-7：列表栏活动时让路给 _navKey 光标模型
      event.preventDefault();
      navigateList(-1);
      return;
    }
    // “/” 聚焦搜索
    if (event.key === '/' && state.activeColumn <= 1) {
      event.preventDefault();
      views.list?.focusSearch();
      return;
    }

    // 连按 O O：在浏览器/应用内打开原文（借鉴上游 v1.4.2，防误触双击确认）
    if (event.code === 'KeyO' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const now = Date.now();
      const last = window.__robinLastOPress || 0;
      window.__robinLastOPress = now;
      if (state.selectedEntryID && now - last < 600) {
        window.__robinLastOPress = 0;
        event.preventDefault();
        views.reader?.openOriginal?.();
        return;
      }
      if (state.selectedEntryID) showToast(t('再按一次 O 打开原文'), 700);
      return;
    }

    // ←/→ 栏导航（无修饰键）
    if (event.key === 'ArrowLeft' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      const next = state.zenMode ? 2 : Math.max(state.sidebarCollapsed ? 1 : 0, state.activeColumn - 1);
      setActiveColumn(next, { autoSelect: false });
      return;
    }
    if (event.key === 'ArrowRight' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      setActiveColumn(Math.min(2, state.activeColumn + 1), { autoSelect: false });
      return;
    }

    // 空格（列表栏 → 聚焦阅读器并滚动；阅读器栏 → 滚动/翻页）
    if (event.code === 'Space' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (state.activeColumn === 1 && state.selectedEntryID) {
        event.preventDefault();
        setActiveColumn(2, { autoSelect: false });
        views.reader.spaceAdvance();
        return;
      }
      if (state.activeColumn === 2) {
        event.preventDefault();
        views.reader.spaceAdvance();
        return;
      }
    }

    // 阅读器裸键（仅在有选中文章、无划词弹层时）
    if (state.selectedEntryID == null) return;
    if (views.reader?.selectionPopoverOpen) return;

    // 有选区时：H = 快速高亮（选中文本的唯一裸键出口）
    if (event.code === 'KeyH' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      && getSelectionText().length > 2 && views.reader?.quickHighlightSelection()) {
      event.preventDefault();
      return;
    }
    if (getSelectionText().length > 0) return;

    switch (event.code) {
      case 'KeyC':
        event.preventDefault();
        dispatchReaderAction('toggleBilingual');
        break;
      case 'KeyD':
        event.preventDefault();
        dispatchReaderAction('deepRead');
        break;
      case 'KeyS':
        event.preventDefault();
        dispatchReaderAction('richSummary');
        break;
      case 'KeyV':
        event.preventDefault();
        dispatchReaderAction('showSummary');
        break;
      case 'KeyM':
        event.preventDefault();
        toggleStarWithGuide();
        break;
      case 'KeyB':
        event.preventDefault();
        requestAdjacentArticle('previous');
        break;
      case 'KeyN':
        event.preventDefault();
        requestAdjacentArticle('next');
        break;
      default:
        break;
    }
  });
}

async function navigateList(direction) {
  const items = state.listItems;
  if (!items.length) return;
  const index = items.findIndex((entry) => entry.id === state.selectedEntryID);
  let nextIndex;
  if (index < 0) nextIndex = direction > 0 ? 0 : items.length - 1;
  else nextIndex = Math.max(0, Math.min(items.length - 1, index + direction));
  if (nextIndex === index) return;
  const next = items[nextIndex];
  await handleEntrySelect(next.id, next);
  views.list.scrollToEntry(next.id);
}

/** 当前订阅源总数（各账户合计，用于会员中心展示与额度判断）。 */
function countAllFeeds() {
  return state.sidebar.reduce((n, account) => n + (account.allFeeds?.length || 0), 0);
}

const AI_GATED_ACTIONS = new Set(['deepRead', 'richSummary', 'toggleBilingual']);

function dispatchReaderAction(action) {
  if (state.selectedEntryID == null) return;
  if (AI_GATED_ACTIONS.has(action)) {
    // AI 生成类动作先过会员/免费额度门（会员直接放行，免费扣每日次数）
    views.account?.gateAI().then((allowed) => {
      if (!allowed) return;
      cancelNavConfirmation(true);
      views.reader.handleShortcut(action);
      updateToolbarState();
    });
    return;
  }
  cancelNavConfirmation(true);
  views.reader.handleShortcut(action);
  updateToolbarState();
}

async function adjustFontSize(delta) {
  const current = state.snapshot?.preferences.articleFontSize ?? 17;
  const next = delta === 0 ? 17 : Math.max(13, Math.min(25, current + delta));
  await window.robin.setFontSize(next);
  state.snapshot.preferences.articleFontSize = next;
  applyFontSize(next);
}

function getSelectionText() {
  return String(window.getSelection?.() || '');
}

// MARK: - 分栏拖拽

function bindSplitters() {
  setupSplitter('splitter-sidebar', 'sidebar', 240, 340);
  setupSplitter('splitter-list', 'list', 280, 560);
}

function setupSplitter(splitterID, columnID, min, max) {
  const splitter = document.getElementById(splitterID);
  const column = document.getElementById(columnID);
  let startX = 0;
  let startWidth = 0;

  splitter.addEventListener('mousedown', (event) => {
    startX = event.clientX;
    startWidth = column.getBoundingClientRect().width;
    splitter.classList.add('active');
    event.preventDefault();

    const onMove = (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      const width = Math.max(min, Math.min(max, startWidth + delta));
      column.style.width = `${width}px`;
      column.style.minWidth = `${width}px`;
      column.style.maxWidth = `${width}px`;
      syncToolbarZones();
    };
    const onUp = () => {
      splitter.classList.remove('active');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const sidebarWidth = document.getElementById('sidebar').getBoundingClientRect().width;
      const listWidth = document.getElementById('list').getBoundingClientRect().width;
      document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
      document.documentElement.style.setProperty('--list-width', `${listWidth}px`);
      window.robin.setColumnWidths({ sidebarWidth, listWidth });
      state.snapshot.preferences.sidebarWidth = sidebarWidth;
      state.snapshot.preferences.listWidth = listWidth;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// MARK: - 右键菜单

/**
 * F17 多窗并读：在独立窗口打开当前文章。
 * 主进程 ReaderWindows 负责：同文章去重聚焦 / 上限 4 窗 / 标题与位置记忆。
 */
function openReaderWindow(entryID) {
  if (!entryID) return;
  window.robin.openReaderWindow(entryID).then((result) => {
    if (!result.ok) showToast(String(result.error || t('打开失败')));
  }).catch(() => {});
}

/** 书架文集缓存（F12）：右键菜单打开前按需拉取一次（文集量小，直接拉全量）。 */
async function fetchBooksForMenu() {
  try {
    const result = await window.robin.booksList();
    return (result?.ok && Array.isArray(result.data?.books)) ? result.data.books : [];
  } catch (_) { return []; }
}

/** 「加入文集」动作：并入文集（幂等）+ toast 回执。 */
async function addFeedsToBook(bookID, feedIDs) {
  const result = await window.robin.booksAddFeeds({ id: bookID, feedIDs }).catch(() => null);
  if (result?.ok) showToast(t('已加入文集'));
  else showToast(String(result?.error || t('加入文集失败')));
}

/** 「加入文集」子菜单项（既有文集 + 新建文集入口；文集可含多源）。 */
async function addToBookMenuItems(feedIDs) {
  const { bookMenuItems, showCreateBookDialog } = await import('./views/bookshelf.js');
  const books = await fetchBooksForMenu();
  return bookMenuItems({
    books,
    feedIDs,
    onAddToBook: (bookID, ids) => addFeedsToBook(bookID, ids),
    onCreateBook: async (ids) => {
      const feeds = state.sidebar.flatMap((a) => a.allFeeds || []);
      await showCreateBookDialog({
        feeds,
        preselectedFeedIDs: ids,
        onCreate: async ({ title, feedIDs: picked }) => {
          const result = await window.robin.booksCreate({ title, feedIDs: picked, schedule: 'manual' }).catch(() => null);
          showToast(result?.ok ? t('文集已创建') : String(result?.error || t('创建失败')));
        },
      });
    },
  });
}

function collectFolders() {
  const folders = [];
  for (const account of state.sidebar) {
    for (const folder of account.folders) folders.push(folder);
  }
  return folders;
}

function folderMenuItems(feedIDs, currentFolder) {
  const items = [{
    label: t('无分类'),
    checked: currentFolder == null,
    onClick: () => window.robin.setFeedFolder(feedIDs, null),
  }];
  const folders = collectFolders();
  if (folders.length) items.push({ type: 'separator' });
  for (const folder of folders) {
    items.push({
      label: folder.name,
      checked: currentFolder === folder.name,
      onClick: () => window.robin.setFeedFolder(feedIDs, folder.name),
    });
  }
  items.push({ type: 'separator' });
  items.push({
    label: t('新建文件夹...'),
    icon: 'folderPlus',
    onClick: () => showAddFolder(reloadAll),
  });
  return items;
}

async function onFeedContext(event, { feed, selectedFeedIDs }) {
  const multi = selectedFeedIDs && selectedFeedIDs.size > 1 && selectedFeedIDs.has(feed.id);
  if (multi) {
    const ids = [...selectedFeedIDs];
    ContextMenu.show(event.clientX, event.clientY, [
      {
        label: tf('标记选中源全部已读 (%lld)', ids.length), icon: 'checkAll',
        onClick: async () => { await window.robin.markAllRead({ kind: 'feeds', feedIDs: ids }); },
      },
      {
        label: tf('复制选中订阅链接 (%lld)', ids.length), icon: 'copy',
        onClick: () => {
          const urls = state.sidebar.flatMap((a) => a.allFeeds)
            .filter((f) => selectedFeedIDs.has(f.id))
            .map((f) => f.feedURL).join('\n');
          navigator.clipboard.writeText(urls);
        },
      },
      { type: 'separator' },
      { label: t('移动选中项到文件夹'), icon: 'folder', children: folderMenuItems(ids) },
      { label: t('加入文集'), icon: 'books', children: await addToBookMenuItems(ids) },
      { type: 'separator' },
      {
        label: tf('删除选中的订阅 (%lld)', ids.length), icon: 'trash', destructive: true,
        onClick: () => confirmDeleteFeeds(ids.map((id) => ({ id })), ids.length),
      },
    ]);
    return;
  }
  ContextMenu.show(event.clientX, event.clientY, [
    { label: t('刷新此源'), icon: 'refresh', onClick: async (item) => {
      const result = await window.robin.refreshFeed(feed.id);
      if (result.ok) { await reloadAll(); showToast(t('已刷新')); }
      else showToast(result.error || t('刷新失败'));
    } },
    { label: t('全部已读'), icon: 'checkAll', onClick: () => window.robin.markAllRead({ kind: 'feed', feedID: feed.id }) },
    { label: t('复制订阅'), icon: 'copy', onClick: () => navigator.clipboard.writeText(feed.feedURL) },
    { label: t('此源排版偏好…'), icon: 'appearance', onClick: () => showFeedTypographyDialog(feed) },
    // F18：追更与停止态都给管理入口（停止态唯一恢复路径就是「更改选择器」）
    ...(['monitor', 'monitor-stopped'].includes(feed.platform) ? monitorFeedMenuItems(feed) : []),
    { label: t('全文抓取'), icon: 'docText', children: fulltextMenuItems(feed) },
    { label: t('AI 精读翻译'), icon: 'spark', children: [
      { label: t('跟随默认'), onClick: async () => { await window.robin.setTranslateFeedMode(feed.id, 'auto'); showToast(t('此源翻译已改为跟随默认')); } },
      { label: t('总是翻译'), onClick: async () => { await window.robin.setTranslateFeedMode(feed.id, 'always'); showToast(t('打开此源文章将自动 AI 精读翻译')); } },
      { label: t('从不翻译'), onClick: async () => { await window.robin.setTranslateFeedMode(feed.id, 'never'); showToast(t('此源文章不再自动翻译')); } },
    ] },
    { type: 'separator' },
    { label: t('移动到文件夹'), icon: 'folder', children: folderMenuItems([feed.id], feedFolderName(feed)) },
    { label: t('加入文集'), icon: 'books', children: await addToBookMenuItems([feed.id]) },
    { type: 'separator' },
    { label: t('删除订阅'), icon: 'trash', destructive: true, onClick: () => confirmDeleteFeeds([feed], 1) },
  ]);
}

function feedFolderName(feed) {
  for (const account of state.sidebar) {
    for (const folder of account.folders) {
      if ((folder.feedIDs || []).includes(feed.id)) return folder.name;
    }
  }
  return null;
}

/**
 * 每源全文抓取三态（F1）：默认（关）/ 开 / 仅新文章。
 * 模式随状态快照下发（preferences.fulltextFeedModes）；切换后刷新快照，
 * 列表「全文」徽标立即按新模式显示/隐藏。
 */
function fulltextMenuItems(feed) {
  const current = (state.snapshot?.preferences?.fulltextFeedModes || {})[feed.id] || 'off';
  const applyMode = async (mode, message) => {
    await window.robin.setFulltextFeedMode(feed.id, mode);
    showToast(message);
    await refreshState();
    views.list.updateItems(state.listItems, state.selectedEntryID); // 徽标按新模式即时增减
  };
  return [
    { label: t('默认（关）'), checked: current === 'off', onClick: () => applyMode('off', t('此源全文抓取已关闭')) },
    { label: t('开'), checked: current === 'on', onClick: () => applyMode('on', t('此源将自动补抓全文（新文章即时补，手动刷新回补存量）')) },
    { label: t('仅新文章'), checked: current === 'newOnly', onClick: () => applyMode('newOnly', t('此源仅对新文章补抓全文，存量不回补')) },
  ];
}

/**
 * F18 网页追更：追更源右键专属操作——更改选择器 / 停止追更。
 * 更改选择器：ui-prompt 输入（frameless 禁 window.prompt），确认后主进程重建
 * feedURL（monitor://hash）并立即重抓基线；停止追更：转 monitor-stopped 不再自动抓取。
 */
function monitorFeedMenuItems(feed) {
  return [
    {
      label: t('更改选择器…'), icon: 'pencil',
      onClick: async () => {
        const selector = await promptBox(t('更改选择器'), {
          placeholder: t('CSS 选择器（可选，留空取正文主体）'),
          initial: feed.platformRef || '',
        });
        if (selector == null) return; // 取消
        const result = await window.robin.monitorSetSelector(feed.id, selector.trim());
        if (result.ok) {
          showToast(t('选择器已更新，正在重抓基线'));
          await refreshState();
        } else {
          showToast(String(result.error || t('更新失败')));
        }
      },
    },
    {
      label: t('停止追更'), icon: 'close',
      onClick: async () => {
        const ok = await confirmBox(t('停止追更'), { message: t('停止后将不再自动抓取该网页，已有文章保留。'), okLabel: t('停止') });
        if (!ok) return;
        const result = await window.robin.monitorStop(feed.id);
        if (result.ok) {
          showToast(t('已停止追更'));
          await refreshState();
        } else {
          showToast(String(result.error || t('操作失败')));
        }
      },
    },
  ];
}

function onFolderContext(event, { folder }) {
  ContextMenu.show(event.clientX, event.clientY, [
    {
      label: t('全部已读'), icon: 'checkAll',
      onClick: () => window.robin.markAllRead({ kind: 'folder', accountID: folder.accountID, folderName: folder.name }),
    },
    { type: 'separator' },
    { label: t('重命名文件夹'), icon: 'pencil', onClick: async () => { await showRenameFolder(folder, reloadAll); } },
    {
      label: t('删除文件夹'), icon: 'trash', destructive: true,
      onClick: async () => {
        await window.robin.deleteFolder(folder.id);
        if (state.scope.kind === 'folder' && state.scope.folderName === folder.name) {
          handleScopeSelect({ kind: 'today' });
        }
      },
    },
  ]);
}

async function showListRowContext(event, item) {
  ContextMenu.show(event.clientX, event.clientY, [
    {
      label: t(item.isRead ? '标为未读' : '标为已读'), icon: 'checkAll',
      onClick: () => window.robin.markRead(item.id, !item.isRead),
    },
    {
      label: t(item.isStarred ? '取消收藏' : '收藏'), icon: 'star',
      onClick: () => window.robin.toggleStar(item.id),
    },
    {
      // F17 多窗并读：右键直接弹出独立阅读窗口
      label: t('在独立窗口打开'), icon: 'popout',
      onClick: () => openReaderWindow(item.id),
    },
    {
      label: t('盯梢这类内容'), icon: 'search',
      onClick: () => openTopicsView(item.title || ''),
    },
    {
      // 加入文集（F12）：把文章所属订阅源并入文集——文集按源成书，后续新文章自动入册
      label: t('加入文集'), icon: 'books', children: await addToBookMenuItems([item.feedID]),
    },
  ]);
}

async function confirmDeleteFeeds(feeds, countOverride = null) {
  const count = countOverride ?? feeds.length;
  const message = tf('确定要删除选中的 %lld 个订阅源及其所有文章吗？此操作无法撤销。', count);
  const ok = await confirmBox(t('删除订阅'), { message, okLabel: t('删除'), danger: true });
  if (ok) {
    window.robin.deleteFeeds(feeds.map((f) => f.id));
    if (state.selectedEntryID) {
      // 删除订阅后清除阅读器选择（对应 onDeleteSelection）
      state.selectedEntryID = null;
      views.reader.clear();
    }
    if (state.scope.kind === 'feed' && feeds.some((f) => f.id === state.scope.feedID)) {
      handleScopeSelect({ kind: 'today' });
    }
  }
}

// MARK: - 设置

function openKnowledgeCenter() {
  const kc = new KnowledgeCenter({
    onOpenArticle: (itemID) => {
      kc.dismiss();
      handleEntrySelect(itemID, { isRead: true, isStarred: false });
    },
    onFilterTag: (tag) => {
      kc.dismiss();
      handleScopeSelect({ kind: 'tag', tag });
    },
    onOpenSmartFolder: ({ name, query }) => {
      // 智能文件夹 = 保存的搜索：任一关键词命中（标题/摘要/正文）即入列表
      kc.dismiss();
      runSmartFolderSearch(name, query);
    },
    // AI 研究来源浮层：无本地条目的素材（AIHOT 等）走任意链接精读（F4 同款通路）
    onOpenURL: (url) => {
      kc.dismiss();
      openLinkReader(url);
    },
  });
  kc.present();
}

/** AI 深度研究（F8）：知识中心「AI 研究」标签页直达（主题输入 + 历史研究）。 */
function openResearchView() {
  const kc = new KnowledgeCenter({
    onOpenArticle: (itemID) => {
      kc.dismiss();
      handleEntrySelect(itemID, { isRead: true, isStarred: false });
    },
    onFilterTag: (tag) => {
      kc.dismiss();
      handleScopeSelect({ kind: 'tag', tag });
    },
    onOpenSmartFolder: ({ name, query }) => {
      kc.dismiss();
      runSmartFolderSearch(name, query);
    },
    onOpenURL: (url) => {
      kc.dismiss();
      openLinkReader(url);
    },
  });
  kc.present('research');
}

/** 智能文件夹：任一关键词命中即收录（OR 语义），列表头显示文件夹名。 */
async function runSmartFolderSearch(name, query) {
  const result = await window.robin.smartFolderSearch(query, 200);
  const items = result.ok ? result.data : [];
  state.listItems = items;
  state.activeQuery = query;
  state.searchMode = true; // P1-5：智能文件夹=保存的搜索，进文同样自动高亮关键词
  views.list.setSearchMode(true);
  views.list.setDigestVisible(false);
  views.list.setPicksVisible(false); // F10：智能文件夹视图不提供精选入口
  views.list.render(items, { kind: 'smart', name }, state.selectedEntryID, false);
  updateToolbarState();
}

function openEvolutionView() {
  const ev = new EvolutionView({
    onOpenArticle: (itemID) => {
      ev.dismiss();
      handleEntrySelect(itemID, { isRead: true, isStarred: false });
    },
  });
  ev.present();
}

function openAihotView() {
  const ah = new AihotView({
    onOpenURL: (url) => window.robin.openLink(url),
    onFeedback: showToast,
  });
  ah.present();
}

/** 媒体中心（F3）：媒体条目浮层（音频→迷你播放器 / 视频→打开阅读器内嵌播放）。 */
function openMediaView() {
  const mv = new MediaView({
    onOpenArticle: (itemID) => {
      mv.dismiss();
      handleEntrySelect(itemID, { isRead: true });
    },
    player: views.mediaPlayer,
    toast: showToast,
  });
  mv.present();
}

/** 话题盯梢（F4）：管理页/信息流浮层；本库命中直达阅读器，外部命中走任意链接精读。 */
function openTopicsView(prefill = '') {
  const tv = new TopicView({
    onOpenEntry: (itemID) => {
      tv.dismiss();
      handleEntrySelect(itemID, { isRead: true });
    },
    onOpenURL: (url) => openLinkReader(url),
    toast: showToast,
  });
  tv.present();
  if (prefill) tv.presentCreate(prefill);
}

/** 任意链接精读（复用 R-D3 通路）：外部命中也进阅读器而不只是裸外链。 */
async function openLinkReader(url) {
  try {
    const ok = await views.reader.openExternalUrl(String(url).trim());
    if (!ok) window.robin.openLink(url);
  } catch (_) {
    window.robin.openLink(url);
  }
}

function openFeedStore() {
  const store = new FeedStore({
    onSubscribed: async () => {
      await reloadAll();
    },
    onOpenFeed: (feedID, feedTitle) => {
      // 订阅成功页「去读第一篇」：切到该源视图（handleScopeSelect 会重拉列表）
      handleScopeSelect({ kind: 'feed', feedID, feedName: feedTitle || '' });
    },
  });
  store.present();
}

let settingsView = null;

const FEED_TYPO_FONTS = [['global', '跟随全局'], ['serif', '衬线'], ['sans', '无衬线'], ['wenkai', '霞鹜文楷']];
const FEED_TYPO_SIZES = [[0, '跟随全局'], [15, '15pt（小）'], [17, '17pt（标准）'], [19, '19pt（大）'], [21, '21pt（特大）']];
const FEED_TYPO_WIDTHS = [['global', '跟随全局'], ['narrow', '窄 (680px)'], ['standard', '标准 (820px)'], ['wide', '宽 (960px)']];

/** 每源排版偏好（重量级）：为单个订阅源覆盖字体 / 字号 / 页宽，仅影响该源文章。 */
function showFeedTypographyDialog(feed) {
  const map = window.__robinFeedTypography || {};
  const current = map[feed.id] || { fontFamily: 'global', fontSize: 0, pageWidth: 'global' };
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) overlay.remove(); });
  const modal = document.createElement('div');
  modal.className = 'modal nj-brief-modal';
  modal.innerHTML = `
    <div class="nj-brief-head">
      <h3>${t('此源排版偏好')}</h3>
      <span class="nj-brief-sub"></span>
      <button class="nj-brief-close">${icon('close')}</button>
    </div>
    <div class="nj-typo-form"></div>
    <div class="nj-brief-foot">
      <button class="btn-text nj-typo-reset">${t('恢复跟随全局')}</button>
      <button class="btn-text primary nj-typo-save">${t('保存')}</button>
    </div>`;
  modal.querySelector('.nj-brief-sub').textContent = feed.title || feed.id || '';
  modal.querySelector('.nj-brief-close').addEventListener('click', () => overlay.remove());
  const form = modal.querySelector('.nj-typo-form');
  const build = (label, options, value, onChange) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'nj-typo-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'nj-typo-label';
    labelEl.textContent = label;
    const select = document.createElement('select');
    select.className = 'nj-typo-select';
    for (const [val, text] of options) {
      const opt = document.createElement('option');
      opt.value = String(val);
      opt.textContent = t(text);
      select.appendChild(opt);
    }
    select.value = String(value);
    select.addEventListener('change', () => onChange(select.value));
    rowEl.append(labelEl, select);
    form.appendChild(rowEl);
    return () => String(select.value);
  };
  const getFont = build(t('正文字体'), FEED_TYPO_FONTS, current.fontFamily || 'global', () => {});
  const getSize = build(t('正文字号'), FEED_TYPO_SIZES, current.fontSize || 0, () => {});
  const getWidth = build(t('页面宽度'), FEED_TYPO_WIDTHS, current.pageWidth || 'global', () => {});
  modal.querySelector('.nj-typo-reset').addEventListener('click', async () => {
    await window.robin.setFeedTypography(feed.id, { fontFamily: 'global', fontSize: 0, pageWidth: 'global' });
    overlay.remove();
    showToast(t('已恢复跟随全局'));
  });
  modal.querySelector('.nj-typo-save').addEventListener('click', async () => {
    await window.robin.setFeedTypography(feed.id, {
      fontFamily: getFont(),
      fontSize: Number(getSize()) || 0,
      pageWidth: getWidth(),
    });
    overlay.remove();
    showToast(t('已保存此源排版偏好'));
    await refreshState();
  });
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

/** R-D3：任意链接 → 精读（抓取+提取后在阅读器渲染，翻译/摘要/划词/导出卡片图全可用）。 */
async function readFromUrlPrompt() {
  const url = await promptBox(t('从链接精读'), { message: t('粘贴文章链接，将抓取正文并生成精读视图（可再导出卡片图）。'), placeholder: 'https://…' });
  if (!url) return;
  const ok = await views.reader.openExternalUrl(String(url).trim());
  if (ok) {
    views.reader.scrollEl.scrollTop = 0;
  }
}

function showSettings(section = 'appearance') {  if (settingsView) settingsView.dismiss();
  settingsView = new SettingsView({
    state,
    views,
    onAddFreshRSS: () => showFreshRSSAccount(async () => {
      await reloadAll();
      settingsView?.refresh?.();
    }),
    onReload: reloadAll,
    onRefreshState: refreshState,
  });
  settingsView.present(section);
}

async function refreshState() {
  const result = await window.robin.getState();
  if (!result.ok) return;
  state.snapshot = result.data;
  configure({ lang: result.data.language });
  syncLLMGlobals(result.data);
  window.__robinFulltextModes = result.data?.preferences?.fulltextFeedModes || {};
  applyFontSize(result.data.preferences.articleFontSize);
  updateToolbarState();
}

// MARK: - 更新

async function checkUpdateQuietly() {
  try {
    const result = await window.robin.checkUpdate();
    if (!result.ok || !result.data?.available) return;
    state.updateInfo = result.data;
    views.sidebar.showUpdateBadge(result.data.release);
  } catch (_) { /* 静默 */ }
}

// MARK: - 事件

function bindEvents() {
  window.robin.onStateChanged(async (snapshot) => {
    const languageChanged = state.snapshot && state.snapshot.language !== snapshot.language;
    state.snapshot = snapshot;
    window.__robinLanguage = snapshot.language || 'zh';
    syncLLMGlobals(snapshot);
    if (typeof snapshot.prefersDark === 'boolean') {
      document.body.classList.toggle('dark', snapshot.prefersDark);
    }
    if (customThemeTokens) syncCustomTheme(snapshot);
    window.__robinFeedTypography = snapshot?.preferences?.feedTypography || {};
  window.__robinListTitleZh = snapshot?.preferences?.titleZh === true;
  window.__robinFulltextModes = snapshot?.preferences?.fulltextFeedModes || {};
  applyReaderLayout(snapshot.preferences?.readerLayout);
    if (languageChanged) {
      configure({ lang: snapshot.language });
      buildToolbar();
      views.sidebar.rerender?.();
    }
    views.sidebar.updateCounts(snapshot.sidebarCounts, state.updateInfo);
    // 侧栏结构（订阅/文件夹/账户）未变化时跳过整栏重建——updateCounts 已更新数字
    if (snapshot.sidebarSignature && snapshot.sidebarSignature !== state.sidebarSignature) {
      state.sidebarSignature = snapshot.sidebarSignature;
      await reloadSidebar();
    }
    // 条目状态增量：仅读/星变化且当前视图行集不受影响时，打补丁即可，免去全量重拉
    const entryStateRev = Number(snapshot.entryStateRev) || 0;
    const listSetRev = Number(snapshot.listSetRev) || 0;
    const deltaChanged = entryStateRev !== state.entryStateRev;
    const setChanged = listSetRev !== state.listSetRev;
    const scopeSetAffecting = deltaChanged && scopeSetAffectedByEntryState(state.scope, snapshot.entryChanges || []);
    state.entryStateRev = entryStateRev;
    state.listSetRev = listSetRev;
    updateToolbarState();
    applyFontSize(snapshot.preferences.articleFontSize);
    if (deltaChanged && !setChanged && !scopeSetAffecting && state.listItems.length) {
      views.list.patchEntries(snapshot.entryChanges || [], state.selectedEntryID);
      const delta = (snapshot.entryChanges || []).find((c) => c.id === state.selectedEntryID);
      if (delta) views.reader.updateEntryState({ isRead: delta.isRead, isStarred: delta.isStarred, isLater: delta.isLater });
      return;
    }
    // 静默刷新行状态（不整体重建，避免打断滚动与选择）
    const seq = ++listReqSeq; // P1-8：与 reloadList 同一序号空间，互相竞争时新者胜
    const result = await window.robin.getList(state.scope, { limit: Math.max(100, state.listItems.length), retainingIDs: [...state.retainedIDs], sort: currentListSort() });
    if (result.ok && seq === listReqSeq) {
      const beforeIDs = new Set(state.listItems.map((entry) => entry.id));
      const afterIDs = new Set(result.data.map((entry) => entry.id));
      let sameSet = beforeIDs.size === afterIDs.size;
      if (sameSet) for (const id of afterIDs) { if (!beforeIDs.has(id)) { sameSet = false; break; } }
      state.listItems = result.data;
      if (sameSet) {
        views.list.updateItems(result.data, state.selectedEntryID);
      } else {
        // 行集变化（过滤规则/新增文章/删除）：全量重建，保持选择与滚动位置
        const scrollTop = document.getElementById('list-scroll')?.scrollTop || 0;
        // F10：精选开启时行集变化走精选重取（普通 render 会让位于精选视图，载荷需新）
        if (picksState.on && ListView.picksEligible(state.scope)) {
          await refreshSmartPicks();
        } else {
          views.list.render(result.data, state.scope, state.selectedEntryID, currentHasUnread());
        }
        views.list.setDigestVisible(state.scope?.kind === 'today' || state.scope?.kind === 'unread');
        const scroller = document.getElementById('list-scroll');
        if (scroller) scroller.scrollTop = scrollTop;
      }
    }
    const item = state.listItems.find((entry) => entry.id === state.selectedEntryID);
    if (item) views.reader.updateEntryState({ isRead: item.isRead, isStarred: item.isStarred, isLater: item.isLater });
  });

  /** 当前视图的行集是否会随条目读/星状态变化（决定增量补丁后是否需要重拉）。 */
  function scopeSetAffectedByEntryState(scope, changes) {
    if (!scope || !changes.length) return false;
    if (scope.kind === 'unread') return changes.some((c) => c.isRead);
    if (scope.kind === 'starred') return changes.some((c) => c.isStarred);
    return false; // 全部/今日/源/文件夹视图：读/星不影响行集
  }

  window.robin.onAIDelta((payload) => {
    if (payload.entryID !== state.selectedEntryID) return;
    if (payload.kind === 'deepRead' || payload.kind === 'richSummary') views.reader.onWorkDelta(payload);
    else views.reader.onSummaryDelta(payload);
  });

  window.robin.onAIStatus((payload) => {
    views.reader.onAIStatus(payload);
    views.reader.onWorkStatus?.(payload);
  });

  window.robin.onSelectionDelta((payload) => {
    views.reader.onSelectionDelta(payload);
  });

  window.robin.onThemeChanged(({ shouldUseDarkColors }) => {
    document.body.classList.toggle('dark', Boolean(shouldUseDarkColors));
  });

  window.robin.onMenu('menu:addFeed', () => showAddFeed(collectFolders(), reloadAll));
  window.robin.onMenu('menu:importOPML', () => window.robin.importOPML());
  window.robin.onMenu('menu:exportOPML', () => window.robin.exportOPML());
  window.robin.onMenu('menu:openSettings', () => showSettings('appearance'));
  window.robin.onMenu('menu:openShortcuts', () => new ShortcutsView().present());
  window.robin.onMenu('menu:openStore', () => openFeedStore());
  window.robin.onMenu('menu:checkUpdate', () => checkUpdateQuietly());
  window.robin.onMenu('menu:fontSize', (delta) => adjustFontSize(delta));

  // 点击激活栏（对应 mouseDownMonitor）
  document.addEventListener('mousedown', (event) => {
    if (event.target.closest('.modal-overlay, .context-menu, .toast-capsule, .nj-selection-actions, .nj-selection-popover, .nj-lightbox')) return;
    const sidebar = event.target.closest('#sidebar');
    const list = event.target.closest('#list');
    const reader = event.target.closest('#reader');
    if (list) setActiveColumn(1, { autoSelect: false });
    else if (reader) setActiveColumn(2, { autoSelect: false });
    else if (sidebar) setActiveColumn(0, { autoSelect: false });
  }, true);

  window.addEventListener('resize', debounce(syncToolbarZones, 200));

  // U10-②：resize 期间给 body 挂 .nj-resizing（CSS 侧 transition:none !important），
  // 消除拖拽缩放时列表/阅读器过渡抖动；复用既有 debounce 通道，停止缩放 200ms 后摘除。
  let resizeSettleTimer = null;
  window.addEventListener('resize', () => {
    document.body.classList.add('nj-resizing');
    clearTimeout(resizeSettleTimer);
    resizeSettleTimer = setTimeout(() => document.body.classList.remove('nj-resizing'), 200);
  });

  // U10-①：标题栏双击最大化提示（拖拽区悬停态在 CSS：#main-toolbar:hover::after 发丝线）
  const mainToolbar = document.getElementById('main-toolbar');
  if (mainToolbar) mainToolbar.title = t('双击标题栏空白处可最大化或还原窗口');

  // 主题事件（设置页提案 / 设计器）
  window.addEventListener('robinread:theme-applied', (event) => {
    applyThemeTokens(event.detail, event.detailName || null);
  });
  window.addEventListener('robinread:theme-reset', () => {
    resetTheme();
  });
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

window.addEventListener('DOMContentLoaded', () => setActiveColumn(1, { autoSelect: false }));

bootstrap().catch((err) => console.error('bootstrap failed', err));
