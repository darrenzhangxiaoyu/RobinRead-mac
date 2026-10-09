'use strict';
/**
 * RobinRead（知更）— 侧栏视图
 *
 * - 「阅读」分组：今天 / 未读 / 收藏 / 稍后读（四个智能行）
 * - 账户分组（可折叠，状态持久化）：根订阅 + 文件夹（DisclosureGroup 可折叠）
 * - Feed 行：favicon（失败回退首字母徽章）+ 未读数；拖拽归类到文件夹
 * - 文件夹行：单击选中；再次单击折叠/展开；右键（全部已读/重命名/删除）
 * - 底栏：设置齿轮 + NEW 版本胶囊（可忽略）
 */
import { t, tf } from '../i18n.js';
import { icon } from '../icons.js';
import { emptyArtSVG } from './empty-art.js';

export class SidebarView {
  constructor(scrollEl, footerEl, handlers) {
    this.scrollEl = scrollEl;
    this.footerEl = footerEl;
    this.handlers = handlers;
    this.handlers.onOpenStore = handlers.onOpenStore || (() => {});
    this.handlers.onOpenKnowledge = handlers.onOpenKnowledge || (() => {});
    this.handlers.onOpenEvolution = handlers.onOpenEvolution || (() => {});
    this.handlers.onOpenAihot = handlers.onOpenAihot || (() => {});
    this.collapsedAccounts = new Set(JSON.parse(localStorage.getItem('robinread.collapsedAccounts') || '[]'));
    this.collapsedFolders = new Set(JSON.parse(localStorage.getItem('robinread.collapsedFolders') || '[]'));
    this.selectedFeedIDs = new Set();
    this.lastData = null;
    this.lastCounts = null;
    this.lastScope = null;
    this.healthByURL = {}; // 源健康（reloadSidebar 注入）：失败源显示警示徽标
    this._buildFooter();
  }

  // MARK: - 渲染

  /** 注入源健康映射（key=feed_url），下次 render 生效。 */
  setHealth(map) { this.healthByURL = map || {}; }

  render(sidebar, counts, scope) {
    this.lastData = sidebar;
    this.lastCounts = counts;
    this.lastScope = scope;
    this.scrollEl.innerHTML = '';
    this.selectedFeedIDs.clear();

    const hasAnyAccount = sidebar.length > 0;
    const hasAnyFeed = sidebar.some((account) => (account.rootFeeds?.length || 0) + (account.folders?.length || 0) > 0);
    if (!hasAnyAccount) {
      this.scrollEl.appendChild(this.emptyState(
        t('未启用任何账号'),
        t('请前往“设置 -> 账号”启用本地或 FreshRSS 订阅账号。'),
        'personX'
      ));
      return;
    }

    // 阅读（智能行）
    const readingSection = document.createElement('div');
    readingSection.className = 'sidebar-section';
    readingSection.appendChild(this.sectionHeader(t('阅读'), null));
    const readingGroup = document.createElement('div');
    readingGroup.className = 'sidebar-group';
    readingGroup.appendChild(this.smartRow('today', t('今天'), 'sun', counts?.todayUnread ?? 0, scope));
    readingGroup.appendChild(this.smartRow('unread', t('未读'), 'circle', counts?.allUnread ?? 0, scope));
    readingGroup.appendChild(this.smartRow('starred', t('收藏'), 'star', counts?.starred ?? 0, scope));
    // 稍后读：短期待办队列（与收藏的长期留存相区别），带未完成计数
    readingGroup.appendChild(this.smartRow('later', t('稍后读'), 'clock', counts?.laterCount ?? 0, scope));
    // 媒体中心（F3）：带媒体附件（播客/视频）的文章入口，带未播完计数（空态在浮层内）
    readingGroup.appendChild(this.mediaRow(counts, scope));
    // 话题盯梢（F4）：关键词聚合信息流入口，计数=启用话题数
    readingGroup.appendChild(this.topicsRow(counts, scope));
    readingSection.appendChild(readingGroup);
    this.scrollEl.appendChild(readingSection);

    if (!hasAnyFeed) {
      this.scrollEl.appendChild(this.emptyState(
        t('还没有订阅'),
        t('添加一个 RSS 地址，或导入 OPML 文件。'),
        'radioDot',
        t('添加订阅'),
        () => this.handlers.onOpenAddFeed?.()
      ));
      return;
    }

    for (const accountGroup of sidebar) {
      this.scrollEl.appendChild(this.accountSection(accountGroup, counts, scope));
    }
    bindFaviconFallback(this.scrollEl);
  }

  rerender() {
    if (this.lastData) this.render(this.lastData, this.lastCounts, this.lastScope);
  }

  sectionHeader(title, accountID) {
    const header = document.createElement('div');
    header.className = 'sidebar-header';
    if (accountID && this.collapsedAccounts.has(accountID)) header.classList.add('collapsed');
    header.innerHTML = `<span class="disclosure">${icon('chevronMenuRight')}</span><span></span>`;
    header.querySelector('span:last-child').textContent = title;
    if (accountID != null) {
      header.addEventListener('click', () => {
        this._toggleSet(this.collapsedAccounts, accountID, 'robinread.collapsedAccounts');
        header.classList.toggle('collapsed');
        const group = header.nextElementSibling;
        if (group) group.style.display = this.collapsedAccounts.has(accountID) ? 'none' : '';
      });
    }
    return header;
  }

  accountSection(accountGroup, counts, scope) {
    const account = accountGroup.account;
    const isLocal = account.type === 'local';
    const section = document.createElement('div');
    section.className = 'sidebar-section';

    section.appendChild(this.sectionHeader(isLocal ? t('我的 Mac') : account.displayName, account.id));

    const group = document.createElement('div');
    group.className = 'sidebar-group';
    if (this.collapsedAccounts.has(account.id)) group.style.display = 'none';

    // 根订阅（在文件夹之前，对应 store.rootFeeds + onMove）
    for (const feed of accountGroup.rootFeeds || []) {
      group.appendChild(this.feedRow(feed, account, counts, scope, { inFolder: false }));
    }

    // 文件夹
    for (const folder of accountGroup.folders || []) {
      group.appendChild(this.folderRow(folder, accountGroup, counts, scope));
    }

    section.appendChild(group);
    return section;
  }

  smartRow(kind, label, iconName, count, scope) {
    const row = document.createElement('div');
    row.className = 'sidebar-row';
    row.dataset.scope = kind;
    if (scope?.kind === kind) row.classList.add('selected');
    row.innerHTML = `${icon(iconName)}<span class="sidebar-label"></span><span class="sidebar-count" style="visibility:hidden"></span>`;
    row.querySelector('.sidebar-label').textContent = label;
    this._bindCount(row, count);
    row.addEventListener('click', () => this.handlers.onSelect({ kind }));
    return row;
  }

  /** 媒体入口（F3）：外观与智能行一致，但点击打开媒体浮层（onOpenMedia），计数=未播完。 */
  mediaRow(counts, scope) {
    const row = document.createElement('div');
    row.className = 'sidebar-row';
    row.dataset.scope = 'media';
    if (scope?.kind === 'media') row.classList.add('selected');
    row.innerHTML = `${icon('playCircle')}<span class="sidebar-label"></span><span class="sidebar-count" style="visibility:hidden"></span>`;
    row.querySelector('.sidebar-label').textContent = t('媒体');
    this._bindCount(row, counts?.mediaUnfinished ?? 0);
    row.title = t('媒体中心（播客 / 视频）');
    row.addEventListener('click', () => this.handlers.onOpenMedia?.());
    return row;
  }

  /** 话题入口（F4）：点击打开话题浮层（onOpenTopics），计数=启用话题数。 */
  topicsRow(counts, scope) {
    const row = document.createElement('div');
    row.className = 'sidebar-row';
    row.dataset.scope = 'topics';
    if (scope?.kind === 'topics') row.classList.add('selected');
    row.innerHTML = `${icon('search')}<span class="sidebar-label"></span><span class="sidebar-count" style="visibility:hidden"></span>`;
    row.querySelector('.sidebar-label').textContent = t('话题');
    this._bindCount(row, counts?.topicsEnabled ?? 0);
    row.title = t('话题盯梢：关键词动态自动汇成信息流');
    row.addEventListener('click', () => this.handlers.onOpenTopics?.());
    return row;
  }

  folderRow(folder, accountGroup, counts, scope) {
    const account = accountGroup.account;
    const key = `${account.id}::${folder.name}`;
    const collapsed = this.collapsedFolders.has(key);

    const wrapper = document.createElement('div');
    wrapper.className = `sidebar-folder ${collapsed ? 'collapsed' : ''}`;
    wrapper.dataset.folderId = folder.id;

    // 「订阅源」拖拽头（仅本地账户根区展示，对应 SubscriptionsHeaderView 的移出文件夹语义放在文件夹内）
    const row = document.createElement('div');
    row.className = 'sidebar-row sidebar-folder-row';
    // P1-6：文件夹行挂可更新锚点——updateCounts 据此刷新文件夹未读徽标
    // （key 与主进程 sidebarCounts.unreadByFolder 的 `${accountID}::${folderName}` 同构）
    row.dataset.folderKey = key;
    const selected = scope?.kind === 'folder' && scope.accountID === account.id && scope.folderName === folder.name;
    if (selected) row.classList.add('selected');

    const folderCount = counts?.unreadByFolder?.[`${account.id}::${folder.name}`] ?? 0;
    row.innerHTML = `
      <span class="sidebar-disclosure">${icon('chevronMenuRight')}</span>
      ${icon('folder')}
      <span class="sidebar-label"></span>
      <span class="sidebar-count" style="visibility:hidden"></span>
    `;
    row.querySelector('.sidebar-label').textContent = folder.name;
    this._bindCount(row, folderCount);

    // 单击选中；选中态再次单击切换折叠（1:1 对应 folderRow.onTapGesture）
    row.addEventListener('click', (event) => {
      if (event.target.closest('.sidebar-disclosure')) {
        this.toggleFolder(key, wrapper);
        return;
      }
      const isCurrent = scope?.kind === 'folder' && scope.accountID === account.id && scope.folderName === folder.name;
      if (isCurrent) {
        this.toggleFolder(key, wrapper);
      } else {
        this.handlers.onSelect({ kind: 'folder', accountID: account.id, folderName: folder.name });
      }
    });
    row.querySelector('.sidebar-disclosure').addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleFolder(key, wrapper);
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.handlers.onFolderContext(event, { folder, account });
    });
    this._bindDrop(row, (feedIDs) => this.handlers.onMoveFeeds(feedIDs, folder.name), () => {
      this._removeFromCollapsed(key);
    });
    wrapper.appendChild(row);

    // U3-①：折叠动画走 CSS grid-template-rows 0fr⇄1fr（.sidebar-folder-inner 为高度约束层），
    // 显隐完全由 .collapsed 类驱动——不再写 inline display，保证过渡可播。
    const children = document.createElement('div');
    children.className = 'sidebar-folder-children';
    const inner = document.createElement('div');
    inner.className = 'sidebar-folder-inner';
    for (const feed of folder.feeds || []) {
      inner.appendChild(this.feedRow(feed, account, counts, scope, { inFolder: true }));
    }
    children.appendChild(inner);
    wrapper.appendChild(children);
    return wrapper;
  }

  toggleFolder(key, wrapper) {
    const collapsed = !this.collapsedFolders.has(key);
    this._toggleSet(this.collapsedFolders, key, 'robinread.collapsedFolders', collapsed);
    // 显隐交给 CSS（.sidebar-folder.collapsed .sidebar-folder-children）；此处只翻类，动画自然播放
    wrapper.classList.toggle('collapsed', collapsed);
  }

  _removeFromCollapsed(key) {
    this.collapsedFolders.delete(key);
    this._persist('robinread.collapsedFolders', this.collapsedFolders);
  }

  feedRow(feed, account, counts, scope, { inFolder }) {
    const row = document.createElement('div');
    row.className = 'sidebar-row';
    row.dataset.feedId = feed.id;
    row.dataset.accountId = account.id;
    if (scope?.kind === 'feed' && scope.feedID === feed.id) row.classList.add('selected');

    const iconHTML = faviconHTML(feed);
    row.innerHTML = `${iconHTML}<span class="sidebar-label"></span><span class="sidebar-count" style="visibility:hidden"></span>`;
    row.querySelector('.sidebar-label').textContent = feed.title;
    this._bindCount(row, counts?.unreadByFeed?.[feed.id] ?? 0);

    // 源健康警示：连续失败 ≥3 次或已判死 → 标题旁小徽标，悬停看原因
    const health = this.healthByURL[feed.feedURL];
    if (health && (health.isDead || (health.recentFailures || 0) >= 3)) {
      const warn = document.createElement('span');
      warn.className = 'sidebar-health-warn' + (health.isDead ? ' dead' : '');
      warn.textContent = '!';
      const parts = [health.isDead
        ? t('连续多次刷新失败，已暂停自动刷新（手动刷新成功后自动恢复）')
        : t(`连续 ${health.recentFailures} 次刷新失败`)];
      if (health.lastError) parts.push(String(health.lastError).slice(0, 80));
      warn.title = parts.join('\n');
      row.appendChild(warn);
    }

    row.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey) {
        // 多选（对应 List 多选 → .feeds scope）
        if (this.selectedFeedIDs.has(feed.id)) this.selectedFeedIDs.delete(feed.id);
        else this.selectedFeedIDs.add(feed.id);
        this._refreshMultiSelect();
        if (this.selectedFeedIDs.size >= 2) {
          this.handlers.onSelect({ kind: 'feeds', feedIDs: [...this.selectedFeedIDs] });
        } else if (this.selectedFeedIDs.size === 1) {
          this.handlers.onSelect({ kind: 'feed', feedID: [...this.selectedFeedIDs][0] });
        }
        return;
      }
      this.selectedFeedIDs.clear();
      this._refreshMultiSelect();
      this.handlers.onSelect({ kind: 'feed', feedID: feed.id });
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.handlers.onFeedContext(event, { feed, selectedFeedIDs: this.selectedFeedIDs, account });
    });

    // 拖拽源（对应 .draggable）
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      const ids = this.selectedFeedIDs.has(feed.id) && this.selectedFeedIDs.size > 1
        ? [...this.selectedFeedIDs] : [feed.id];
      event.dataTransfer.setData('application/x-robinread-feeds', JSON.stringify(ids));
      event.dataTransfer.effectAllowed = 'move';
    });

    // 根区行作为「移出文件夹」目标（对应根 Section 的 dropDestination）
    if (!inFolder) {
      this._bindDrop(row, (feedIDs) => this.handlers.onMoveFeeds(feedIDs, null));
    }
    return row;
  }

  _refreshMultiSelect() {
    this.scrollEl.querySelectorAll('.sidebar-row[data-feed-id]').forEach((row) => {
      row.classList.toggle('selected', this.selectedFeedIDs.has(row.dataset.feedId));
    });
  }

  _bindCount(row, count) {
    const el = row.querySelector('.sidebar-count');
    if (count > 0) {
      el.textContent = count > 999 ? '999+' : String(count);
      el.style.visibility = 'visible';
    } else {
      el.style.visibility = 'hidden';
    }
  }

  _bindDrop(element, onDrop, onDropSuccess) {
    element.addEventListener('dragover', (event) => {
      if (event.dataTransfer.types.includes('application/x-robinread-feeds')) {
        event.preventDefault();
        element.classList.add('drop-target');
      }
    });
    element.addEventListener('dragleave', () => element.classList.remove('drop-target'));
    element.addEventListener('drop', (event) => {
      element.classList.remove('drop-target');
      const raw = event.dataTransfer.getData('application/x-robinread-feeds');
      if (!raw) return;
      event.preventDefault();
      try {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids) && ids.length) {
          onDrop(ids);
          onDropSuccess?.();
        }
      } catch (_) { /* 忽略非法数据 */ }
    });
  }

  _toggleSet(set, key, storageKey, force) {
    const shouldCollapse = force !== undefined ? force : !set.has(key);
    if (shouldCollapse) set.add(key);
    else set.delete(key);
    this._persist(storageKey, set);
  }

  _persist(storageKey, set) {
    localStorage.setItem(storageKey, JSON.stringify([...set]));
  }

  emptyState(title, message, glyph, actionLabel, onAction) {
    const el = document.createElement('div');
    el.className = 'list-empty';
    // U11 插画空态：命中线稿库时以插画替代单图标，未命中回退既有 .glyph 图标
    const art = emptyArtSVG(glyph);
    el.innerHTML = art
      ? `<div class="empty-art">${art}</div><h3></h3><p></p>`
      : `<div class="glyph">${icon(glyph)}</div><h3></h3><p></p>`;
    el.querySelector('h3').textContent = title;
    el.querySelector('p').textContent = message;
    if (actionLabel) {
      const button = document.createElement('button');
      button.className = 'btn-text primary';
      button.textContent = actionLabel;
      button.addEventListener('click', onAction);
      el.appendChild(button);
    }
    return el;
  }

  // MARK: - 底栏（settingsFooter 1:1）

  _buildFooter() {
    this.footerEl.innerHTML = '';

    const nav = document.createElement('div');
    nav.className = 'footer-nav';

    // 账号入口（导航条首位，头像/人形图标按钮，与其它入口同占一列，
    // 详细信息放 title，避免挤占侧栏横向空间）
    this.accountBtn = document.createElement('button');
    this.accountBtn.className = 'footer-nav-btn footer-account-btn';
    nav.appendChild(this.accountBtn);
    this.updateAccount(null);

    const storeBtn = document.createElement('button');
    storeBtn.className = 'footer-nav-btn';
    storeBtn.title = t('浏览订阅商店');
    storeBtn.innerHTML = `${icon('store')}<span class="nav-label"></span>`;
    storeBtn.querySelector('.nav-label').textContent = t('商店');
    storeBtn.addEventListener('click', () => this.handlers.onOpenStore());
    nav.appendChild(storeBtn);

    const aihotBtn = document.createElement('button');
    aihotBtn.className = 'footer-nav-btn';
    aihotBtn.title = t('AI 热点榜');
    aihotBtn.innerHTML = `${icon('flame')}<span class="nav-label"></span>`;
    aihotBtn.querySelector('.nav-label').textContent = t('热点');
    aihotBtn.addEventListener('click', () => this.handlers.onOpenAihot());
    nav.appendChild(aihotBtn);

    const knowledgeBtn = document.createElement('button');
    knowledgeBtn.className = 'footer-nav-btn';
    knowledgeBtn.title = t('知识中心 (Ctrl+K)');
    knowledgeBtn.innerHTML = `${icon('spark')}<span class="nav-label"></span>`;
    knowledgeBtn.querySelector('.nav-label').textContent = t('知识');
    knowledgeBtn.addEventListener('click', () => this.handlers.onOpenKnowledge());
    nav.appendChild(knowledgeBtn);

    const evoBtn = document.createElement('button');
    evoBtn.className = 'footer-nav-btn';
    evoBtn.title = t('自进化面板');
    evoBtn.innerHTML = `${icon('heart')}<span class="nav-label"></span>`;
    evoBtn.querySelector('.nav-label').textContent = t('进化');
    evoBtn.addEventListener('click', () => this.handlers.onOpenEvolution());
    nav.appendChild(evoBtn);

    // 知识花园徽章（F23）：小花园 + 成长阶段点，点击开花园浮层
    const gardenBtn = document.createElement('button');
    gardenBtn.className = 'footer-nav-btn footer-garden-btn';
    gardenBtn.title = t('知识花园');
    gardenBtn.innerHTML = `${icon('flower')}<span class="nav-label"></span><span class="nj-garden-dot" data-stage="0"></span>`;
    gardenBtn.querySelector('.nav-label').textContent = t('花园');
    gardenBtn.addEventListener('click', () => this.handlers.onOpenGarden?.());
    nav.appendChild(gardenBtn);
    this.gardenBtn = gardenBtn;
    this._refreshGardenBadge();

    // 时间胶囊徽章（F27）：到期未开启枚数兜底入口（无简报习惯的用户也从这里浮出）
    const capsuleBtn = document.createElement('button');
    capsuleBtn.className = 'footer-nav-btn footer-capsule-btn';
    capsuleBtn.title = t('时间胶囊');
    capsuleBtn.innerHTML = `${icon('clock')}<span class="nav-label"></span><span class="nj-capsule-badge" hidden>0</span>`;
    capsuleBtn.querySelector('.nav-label').textContent = t('胶囊');
    capsuleBtn.addEventListener('click', () => this.handlers.onOpenCapsules?.());
    nav.appendChild(capsuleBtn);
    this.capsuleBtn = capsuleBtn;
    this._refreshCapsuleBadge();

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'footer-nav-btn';
    settingsBtn.title = t('设置');
    settingsBtn.innerHTML = `${icon('gear')}<span class="nav-label"></span>`;
    settingsBtn.querySelector('.nav-label').textContent = t('设置');
    settingsBtn.addEventListener('click', () => this.handlers.onOpenSettings());
    nav.appendChild(settingsBtn);

    this.footerEl.appendChild(nav);
    this.updateBadgeHost = document.createElement('span');
    this.footerEl.appendChild(this.updateBadgeHost);
  }

  /**
   * 花园徽章刷新（F23）：阶段点 + title 摘要；garden:changed 推送在场即热更。
   * 懒订阅（首次构建后），通道缺失（旧 preload）静默。
   */
  _refreshGardenBadge() {
    const btn = this.gardenBtn;
    if (!btn) return;
    window.robin.gardenState?.().then((state) => {
      if (!state || !btn.isConnected) return;
      const dot = btn.querySelector('.nj-garden-dot');
      if (dot) {
        dot.dataset.stage = String(state.stage);
        dot.classList.toggle('wilted', (state.wiltLevel || 0) > 0);
      }
      btn.title = t('知识花园');
    }).catch(() => { /* 花园状态不可得：徽章保持静默 */ });
    if (!this._gardenSubscribed && window.robin.onGardenChanged) {
      this._gardenSubscribed = true;
      window.robin.onGardenChanged(() => this._refreshGardenBadge());
    }
  }

  /**
   * 时间胶囊徽章刷新（F27）：到期未开启枚数；0 枚时隐藏角标（入口仍在，
   * 点开是空态引导）。懒查询，通道缺失（旧 preload）静默。
   */
  _refreshCapsuleBadge() {
    const btn = this.capsuleBtn;
    if (!btn) return;
    window.robin.capsulePending?.().then((count) => {
      if (!btn.isConnected) return;
      const badge = btn.querySelector('.nj-capsule-badge');
      if (!badge) return;
      const n = Number(count) || 0;
      badge.textContent = String(n);
      badge.hidden = n <= 0;
      btn.title = n > 0 ? tf('%lld 枚时间胶囊已到期', n) : t('时间胶囊');
    }).catch(() => { /* 胶囊计数不可得：徽章保持静默 */ });
  }

  /** 账号入口按钮：未登录=人形图标；已登录=头像（会员加金圈）。昵称与状态放 title。 */
  updateAccount(account) {
    if (!this.accountBtn) return;
    const btn = this.accountBtn;
    btn.classList.toggle('is-member', !!(account && account.is_member));
    if (account) {
      btn.title = `${account.nickname || t('已登录')} · ${
        account.is_member ? (account.member_until === 'lifetime' ? t('终身会员') : t('会员有效')) : t('免费版')}`;
      btn.innerHTML = account.avatar_url
        ? `<span class="acct-mini-avatar"><img src="${attr(account.avatar_url)}" referrerpolicy="no-referrer"/></span>`
        : icon('person');
    } else {
      btn.title = t('登录 / 开通会员');
      btn.innerHTML = icon('person');
    }
    if (!btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => this.handlers.onOpenAccount?.());
    }
  }

  showUpdateBadge(release) {
    if (!this.updateBadgeHost) return;
    const version = String(release.tagName || '').replace(/^v/i, '');
    const capsule = document.createElement('span');
    capsule.className = 'update-capsule';
    capsule.title = tf('点击前往下载新版本 v%@', version); // P2-5：本地中文模板改走 i18n
    capsule.innerHTML = `<span>NEW</span><span class="ver"></span><span class="dismiss" title="${attr(t('不再提示此版本更新'))}">✕</span>`;
    capsule.querySelector('.ver').textContent = `v${version}`;
    capsule.addEventListener('click', (event) => {
      if (event.target.closest('.dismiss')) {
        this.handlers.onIgnoreVersion(release.tagName || version);
        capsule.remove();
        return;
      }
      this.handlers.onOpenUpdate(release.htmlURL);
    });
    this.updateBadgeHost.innerHTML = '';
    this.updateBadgeHost.appendChild(capsule);
  }

  // 轻量计数更新（不重建 DOM）
  updateCounts(counts, updateInfo) {
    this.lastCounts = counts;
    this.scrollEl.querySelectorAll('.sidebar-row[data-feed-id]').forEach((row) => {
      this._bindCount(row, counts?.unreadByFeed?.[row.dataset.feedId] ?? 0);
    });
    // P1-6：文件夹未读徽标同步刷新（主进程 counts 推送含 unreadByFolder，键为 accountID::folderName）
    this.scrollEl.querySelectorAll('.sidebar-row[data-folder-key]').forEach((row) => {
      this._bindCount(row, counts?.unreadByFolder?.[row.dataset.folderKey] ?? 0);
    });
    const smartRows = this.scrollEl.querySelectorAll('.sidebar-row[data-scope]');
    const map = {
      today: counts?.todayUnread ?? 0,
      unread: counts?.allUnread ?? 0,
      starred: counts?.starred ?? 0,
      later: counts?.laterCount ?? 0,
      media: counts?.mediaUnfinished ?? 0, // F3：媒体未播完计数
      topics: counts?.topicsEnabled ?? 0, // F4：话题盯梢行——缺键会把话题徽标清零隐藏（P2 修复）
    };
    smartRows.forEach((row) => this._bindCount(row, map[row.dataset.scope] ?? 0));
  }
}

function faviconHTML(feed) {
  const url = feedIconURL(feed);
  if (url) {
    // CSP 禁内联脚本：失败兜底（替换为首字母徽标）由 bindFaviconFallback 统一挂载
    return `<span class="sidebar-icon"><img src="${attr(url)}" referrerpolicy="no-referrer" loading="lazy" data-fallback-letter="${attr(letter(feed.title))}"/></span>`;
  }
  return `<span class="sidebar-icon"><span class="favicon-badge">${attr(letter(feed.title))}</span></span>`;
}

/** favicon 加载失败 → 首字母徽标（含缓存已失败的同步态）。 */
export function bindFaviconFallback(scope) {
  (scope || document).querySelectorAll('img[data-fallback-letter]').forEach((img) => {
    if (img.dataset.fallbackBound === '1') return;
    img.dataset.fallbackBound = '1';
    const swap = () => {
      const badge = document.createElement('span');
      badge.className = 'favicon-badge';
      badge.textContent = img.dataset.fallbackLetter || '?';
      img.replaceWith(badge);
    };
    if (img.complete && img.naturalWidth === 0) swap();
    else img.addEventListener('error', swap, { once: true });
  });
}

export function feedIconURL(feed) {
  // 统一走主进程 robin-icon:// 协议（内存/磁盘/网络三级缓存 + 失败 5 天冷却）。
  // 原先热链 google s2：无缓存且大陆网络不可达，图标区反复失败空转。
  let host = null;
  try {
    host = (feed.siteURL ? new URL(feed.siteURL).hostname : null)
      || (feed.feedURL ? new URL(feed.feedURL).hostname : null);
  } catch (_) { host = null; }
  host = host ? host.toLowerCase() : '';
  const path = (feed.feedURL || '').toLowerCase();
  let stored = feed.storedIconURL || '';
  if (!stored && (host.includes('twitter.com') || host.includes('x.com') || path.includes('/twitter/') || path.startsWith('/twitter') || path.includes('/x/'))) {
    stored = 'https://abs.twimg.com/favicons/twitter.3.ico';
  }
  if (!host && !stored) return null;
  const params = new URLSearchParams();
  if (stored) params.set('stored', stored);
  if (feed.siteURL) params.set('site', feed.siteURL);
  if (feed.feedURL) params.set('feed', feed.feedURL);
  if (host) params.set('host', host);
  return `robin-icon://icon/?${params.toString()}`;
}

function letter(title) {
  return (String(title || '?').trim()[0] || '?').toUpperCase();
}

function attr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
