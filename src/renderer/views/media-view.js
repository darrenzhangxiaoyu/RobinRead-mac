'use strict';
/**
 * RobinRead（知更）— 媒体视图（F3 媒体中心）
 *
 * 列出全部带媒体（enclosure 播客音频/视频）的文章：
 * - 封面 = 源图标（robin-icon://，与侧栏同一缓存管线）+ 标题 + 源名 + 时长 + 进度条；
 * - 筛选：全部 / 未播完 / 已播完（计数与行集同源）；加载更多（LIMIT 100 分页）；
 * - 行动作：播放（音频→迷你播放器 / 视频→打开阅读器内嵌播放）、加入/移出队列、
 *   下载（离线收听，进度条 + 「离线可播」徽标）、删除离线文件；
 * - 空格键：视图聚焦（浮层开启）时播放/暂停——capture 阶段消费，阅读器/列表空格不受影响；
 * - 不可信回显一律 textContent / escapeHTML；下载进度经主进程推送事件刷新行内 UI。
 */
import { t, tf } from '../i18n.js';
import { icon } from '../icons.js';

const PAGE_SIZE = 100;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function attr(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function fmtDuration(seconds) {
  const s = Math.floor(Number(seconds) || 0);
  if (s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return tf('%lld 小时 %lld 分', h, m);
  if (m) return tf('%lld 分钟', m);
  return tf('%lld 秒', s);
}

export class MediaView {
  /**
   * @param deps.onOpenArticle(itemID) 行内视频条目 → 打开阅读器（内嵌 <video controls>）
   * @param deps.player MediaMiniPlayer 单例（window.__robinMedia）
   * @param deps.toast?(message)
   */
  constructor(deps = {}) {
    this.deps = {
      onOpenArticle: deps.onOpenArticle || (() => {}),
      player: deps.player || null,
      toast: deps.toast || null,
    };
    this.filter = 'all';
    this.items = [];
    this._downloadProgress = new Map(); // itemID -> {received, total, state}（IPC 推送直连）
    this._unsubscribeProgress = null;
  }

  present() {
    if (this.overlay) return;
    const overlay = el('div', 'modal-overlay nj-media-overlay');
    const modal = el('div', 'modal nj-media-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', t('媒体中心'));
    const head = el('div', 'nj-media-head');
    const title = el('h3', null, t('媒体中心'));
    const close = el('button', 'btn icon-only nj-media-close');
    close.type = 'button';
    close.innerHTML = icon('close');
    close.title = t('关闭');
    close.addEventListener('click', () => this.dismiss());
    head.append(title, close);

    const filters = el('div', 'nj-media-filters');
    this._filterButtons = {};
    for (const [key, label] of [['all', t('全部')], ['unfinished', t('未播完')], ['finished', t('已播完')]]) {
      const btn = el('button', 'nj-media-filter');
      btn.type = 'button';
      btn.dataset.filter = key;
      btn.addEventListener('click', () => {
        this.filter = key;
        this._syncFilterButtons();
        this._load();
      });
      filters.appendChild(btn);
      this._filterButtons[key] = btn;
    }
    head.appendChild(filters);
    modal.appendChild(head);

    this.listEl = el('div', 'nj-media-list');
    modal.appendChild(this.listEl);

    this.moreBtn = el('button', 'btn-text nj-media-more');
    this.moreBtn.type = 'button';
    this.moreBtn.textContent = t('加载更多');
    this.moreBtn.addEventListener('click', () => this._loadMore());
    this.moreBtn.hidden = true;
    modal.appendChild(this.moreBtn);

    this.emptyEl = el('div', 'list-empty nj-media-empty');
    this.emptyEl.innerHTML = `<div class="glyph">${icon('playCircle')}</div><h3></h3><p></p>`;
    this.emptyEl.querySelector('h3').textContent = t('还没有可播放的媒体');
    this.emptyEl.querySelector('p').textContent = t('带音频/视频附件的文章（播客等）会自动出现在这里。');
    this.emptyEl.hidden = true;
    modal.appendChild(this.emptyEl);

    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) this.dismiss(); });
    document.body.appendChild(overlay);
    this.overlay = overlay;
    window.__robinMediaView = this; // E2E 探测句柄

    // 空格：媒体视图聚焦时播放/暂停（capture 阶段消费——stopImmediatePropagation
    // 同时压制同节点先注册的 app.js 空格处理，阅读器/列表空格语义不受影响）
    this._space = (event) => {
      if (event.key !== ' ' && event.code !== 'Space') return;
      const target = event.target;
      if (target instanceof HTMLElement
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this._spaceToggle();
    };
    document.addEventListener('keydown', this._space, true);
    // Esc 关闭（与知识中心等浮层一致）
    this._esc = (event) => { if (event.key === 'Escape' && !event.defaultPrevented) this.dismiss(); };
    document.addEventListener('keydown', this._esc);
    // 下载进度推送（主进程 → 渲染层）：单行补丁 + 终态轻刷新
    this._unsubscribeProgress = window.robin.onMediaDownloadProgress((p) => {
      if (!p || !p.itemID) return;
      this._downloadProgress.set(p.itemID, p);
      this._patchRow(p.itemID);
      if (p.state === 'done' || p.state === 'failed') this._load({ silent: true });
    });
    this._syncFilterButtons();
    this._load();
  }

  dismiss() {
    if (!this.overlay) return;
    document.removeEventListener('keydown', this._space, true);
    document.removeEventListener('keydown', this._esc);
    if (this._unsubscribeProgress) {
      this._unsubscribeProgress();
      this._unsubscribeProgress = null;
    }
    this.overlay.remove();
    this.overlay = null;
    if (window.__robinMediaView === this) window.__robinMediaView = null;
  }

  /** 空格播放/暂停：有在播条目 → 切换；否则播列表第一条音频。 */
  _spaceToggle() {
    const player = this.deps.player || window.__robinMedia;
    if (player && player.hasCurrent()) {
      player.toggle();
      return;
    }
    const first = this.items.find((m) => m.kind === 'audio');
    if (first) this._play(first);
  }

  _syncFilterButtons() {
    const counts = this._counts || {};
    const labelOf = { all: t('全部'), unfinished: t('未播完'), finished: t('已播完') };
    for (const [key, btn] of Object.entries(this._filterButtons || {})) {
      const n = key === 'all' ? counts.total : key === 'unfinished' ? counts.unfinished : counts.finished;
      btn.textContent = `${labelOf[key]}${n ? ` (${n})` : ''}`;
      btn.classList.toggle('active', this.filter === key);
    }
  }

  async _load({ silent = false } = {}) {
    if (!this.overlay) return;
    const result = await window.robin.mediaList(this.filter, { limit: PAGE_SIZE, offset: 0 });
    if (!this.overlay) return;
    this.items = Array.isArray(result) ? result : [];
    this._renderRows();
    if (!silent) {
      const counts = await window.robin.mediaCounts();
      if (this.overlay) {
        this._counts = counts || {};
        this._syncFilterButtons();
      }
    }
  }

  async _loadMore() {
    const result = await window.robin.mediaList(this.filter, { limit: PAGE_SIZE, offset: this.items.length });
    if (!this.overlay) return;
    const fresh = (Array.isArray(result) ? result : []).filter((m) => !this.items.some((x) => x.itemID === m.itemID));
    this.items.push(...fresh);
    for (const item of fresh) this.listEl.appendChild(this._row(item));
    this.moreBtn.hidden = this.items.length < PAGE_SIZE || fresh.length === 0;
  }

  _renderRows() {
    this.listEl.innerHTML = '';
    for (const item of this.items) this.listEl.appendChild(this._row(item));
    this.moreBtn.hidden = this.items.length < PAGE_SIZE;
    this.emptyEl.hidden = this.items.length > 0;
  }

  /** 下载进度推送 → 单行补丁（不重建列表）。 */
  _patchRow(itemID) {
    const row = this.listEl?.querySelector(`.nj-media-row[data-item-id="${attr(itemID).replace(/"/g, '')}"]`);
    if (row && row.__refreshState) row.__refreshState();
  }

  _play(item) {
    const player = this.deps.player || window.__robinMedia;
    if (item.kind === 'video') {
      // 视频：阅读器内嵌 <video controls> 播放（列表行点击打开文章）
      this.deps.onOpenArticle(item.itemID);
      return;
    }
    if (!player) return;
    player.open(item.itemID).then((ok) => {
      if (ok) this._markPlayingRow(item.itemID);
    });
  }

  _markPlayingRow(itemID) {
    [...this.listEl.querySelectorAll('.nj-media-row')].forEach((row) => {
      row.classList.toggle('playing', row.dataset.itemId === itemID);
    });
  }

  _row(item) {
    const row = el('article', 'nj-media-row');
    row.dataset.itemId = item.itemID;
    row.dataset.kind = item.kind;
    if (item.finished) row.classList.add('finished');

    const cover = el('span', 'nj-media-cover');
    if (item.feedIconURL) {
      const img = document.createElement('img');
      img.src = item.feedIconURL;
      img.referrerPolicy = 'no-referrer';
      img.loading = 'lazy';
      img.alt = '';
      cover.appendChild(img);
      img.addEventListener('error', () => img.remove(), { once: true });
    }
    cover.appendChild(el('span', 'nj-media-kind', item.kind === 'video' ? t('视频') : t('音频')));
    row.appendChild(cover);

    const body = el('div', 'nj-media-body');
    const titleEl = el('div', 'nj-media-title');
    titleEl.textContent = item.title || t('未命名文章');
    titleEl.title = titleEl.textContent;
    const meta = el('div', 'nj-media-meta');
    meta.appendChild(el('span', 'nj-media-source', item.sourceTitle || ''));
    const duration = fmtDuration(item.durationSeconds);
    if (duration) meta.appendChild(el('span', 'nj-media-duration', duration));
    if (item.playedAt) meta.appendChild(el('span', 'nj-media-played', t('听过')));
    body.append(titleEl, meta);

    // 进度条：播放过且未播完时显示（position/duration）
    const progress = el('div', 'nj-media-progress');
    const fill = el('div', 'nj-media-progress-fill');
    progress.appendChild(fill);
    const ratio = (item.durationSeconds > 0 && item.positionSeconds > 0)
      ? Math.min(1, item.positionSeconds / item.durationSeconds) : 0;
    fill.style.width = `${Math.round(ratio * 100)}%`;
    if (item.positionSeconds > 0 && !item.finished) body.appendChild(progress);

    row.appendChild(body);

    // 离线状态区：下载中进度 / 离线可播徽标 / 下载按钮 / 删除
    const stateWrap = el('div', 'nj-media-actions');
    const refreshState = () => {
      const p = this._downloadProgress.get(item.itemID);
      stateWrap.innerHTML = '';
      if (p && p.state === 'downloading') {
        const dl = el('div', 'nj-media-dl');
        const bar = el('div', 'nj-media-dl-bar');
        const inner = el('div', 'nj-media-dl-fill');
        const total = Number(p.total) || item.sizeBytes || 0;
        inner.style.width = total ? `${Math.min(100, Math.round((p.received / total) * 100))}%` : '38%';
        bar.appendChild(inner);
        dl.appendChild(bar);
        dl.appendChild(el('span', 'nj-media-dl-text', t('下载中')));
        stateWrap.appendChild(dl);
      } else {
        if (p && p.state === 'failed') {
          const retry = el('button', 'btn-text nj-media-dl-retry', t('重试下载'));
          retry.type = 'button';
          retry.title = String(p.error || t('下载失败'));
          retry.addEventListener('click', () => window.robin.mediaDownload(item.itemID));
          stateWrap.appendChild(retry);
        }
        if (item.hasLocal) {
          const offline = el('span', 'nj-media-offline', t('离线可播'));
          offline.title = t('已下载到本机，离线也能听');
          const del = el('button', 'btn-text nj-media-del');
          del.type = 'button';
          del.innerHTML = icon('trash');
          del.title = t('删除离线文件');
          del.addEventListener('click', async () => {
            await window.robin.mediaDownloadDelete(item.itemID);
            this._downloadProgress.delete(item.itemID);
            await this._load({ silent: true });
            this.deps.toast?.(t('已删除离线文件，恢复在线播放'));
          });
          stateWrap.append(offline, del);
        } else {
          const dlBtn = el('button', 'btn-text nj-media-dl');
          dlBtn.type = 'button';
          dlBtn.textContent = t('下载');
          dlBtn.title = t('下载到本机，离线收听');
          dlBtn.addEventListener('click', async () => {
            this._downloadProgress.set(item.itemID, { itemID: item.itemID, state: 'downloading', received: 0, total: item.sizeBytes ?? null });
            refreshState();
            const res = await window.robin.mediaDownload(item.itemID);
            if (res && res.ok === false) this.deps.toast?.(String(res.error || t('下载失败')));
          });
          stateWrap.appendChild(dlBtn);
        }
      }
    };
    row.__refreshState = refreshState;
    refreshState();
    // 动作区拦截冒泡：按钮 handler 内 refreshState 会重建动作区（点击目标被脱离 DOM，
    // closest 守卫失效）→ 不拦住的话 row 级点击会把「下载」误判成「播放」
    stateWrap.addEventListener('click', (event) => event.stopPropagation());
    row.appendChild(stateWrap);

    // 队列按钮
    const queueBtn = el('button', 'btn-text nj-media-queue');
    queueBtn.type = 'button';
    queueBtn.textContent = t('加入队列');
    queueBtn.title = t('加入播放队列，自动连播');
    queueBtn.addEventListener('click', async () => {
      await window.robin.mediaQueueAdd(item.itemID);
      queueBtn.textContent = t('移出队列');
      queueBtn.title = t('移出播放队列');
      queueBtn.classList.add('in-queue');
      this.deps.toast?.(t('已加入队列'));
    });
    stateWrap.appendChild(queueBtn);

    // 播放按钮
    const play = el('button', 'btn-text primary nj-media-play');
    play.type = 'button';
    play.innerHTML = `${item.kind === 'video' ? icon('playCircle') : icon('playCircle')}<span></span>`;
    play.querySelector('span').textContent = item.kind === 'video' ? t('打开播放') : t('播放');
    play.addEventListener('click', (event) => {
      event.stopPropagation();
      this._play(item);
    });
    row.appendChild(play);

    // 整行点击（音频播放 / 视频开阅读器）
    row.addEventListener('click', (event) => {
      if (event.target.closest('.nj-media-actions, .nj-media-play')) return;
      this._play(item);
    });
    return row;
  }
}
