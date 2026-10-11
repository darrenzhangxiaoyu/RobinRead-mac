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
import { emptyArtSVG } from './empty-art.js';
import { progressElement } from './toast.js'; // U32 统一进度语言：双形态令牌组件
import { registerEscapeLayer, isTopEscapeLayer, releaseEscapeLayer, captureFocusReturn } from './overlay-stack.js'; // R55 浮层秩序

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

/** 文字稿时间戳（F22）：秒 → mm:ss（超 1 小时 h:mm:ss）。 */
function fmtTimestamp(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
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
    // 转写（F22）：端点就绪态 + 转写进度推送缓存 + 文字稿关键字过滤词
    this._transcribeReady = false;
    this._transcribeProgress = new Map(); // itemID -> {state, phase, pct, error}
    this._unsubscribeTranscribe = null;
    this._query = '';
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

    // 文字稿关键字过滤（F22）：媒体视图内按转写全文检索过滤行（主进程 FTS/LIKE 旁路）
    const search = el('div', 'nj-media-search');
    search.innerHTML = `${icon('search')}<input type="text" spellcheck="false"/>`;
    this._searchInput = search.querySelector('input');
    this._searchInput.placeholder = t('搜索文字稿…');
    let searchTimer = null;
    this._searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        this._query = this._searchInput.value.trim();
        this._load();
      }, 260);
    });
    head.appendChild(search);

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
    const mediaArt = emptyArtSVG('playCircle'); // U11 插画空态
    this.emptyEl.innerHTML = `${mediaArt ? `<div class="empty-art">${mediaArt}</div>` : `<div class="glyph">${icon('playCircle')}</div>`}<h3></h3><p></p>`;
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
    // Esc 关闭（与知识中心等浮层一致）；文字稿面板在场时让位（面板自带 Esc 自关）；
    // 搜索框有词时先清词不关窗（批 A 审查 P2-3：同设置弹窗「Esc 先清搜索、再按才关」约定）
    this._esc = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!isTopEscapeLayer(this._escLayer)) return; // R55：顶层先关（一次 Esc 只关一层）
      if (document.querySelector('.nj-transcript-overlay')) return;
      if (this._searchInput && document.activeElement === this._searchInput && this._searchInput.value) {
        event.preventDefault();
        event.stopPropagation();
        this._searchInput.value = '';
        this._query = '';
        this._load();
        return;
      }
      event.preventDefault();
      this.dismiss();
    };
    document.addEventListener('keydown', this._esc);
    this._escLayer = registerEscapeLayer({ id: 'media-overlay', isAlive: () => Boolean(this.overlay) }); // R55 浮层栈挂账
    this._restoreFocus = captureFocusReturn(); // R55：关闭时焦点归还打开者
    // 下载进度推送（主进程 → 渲染层）：单行补丁 + 终态轻刷新
    this._unsubscribeProgress = window.robin.onMediaDownloadProgress((p) => {
      if (!p || !p.itemID) return;
      this._downloadProgress.set(p.itemID, p);
      this._patchRow(p.itemID);
      if (p.state === 'done' || p.state === 'failed') this._load({ silent: true });
    });
    // 转写进度推送（F22）：排队/转写中%/完成/失败 → 单行补丁；终态轻刷新行集（徽标）
    this._unsubscribeTranscribe = window.robin.onTranscribeProgress((p) => {
      if (!p || !p.itemID) return;
      this._transcribeProgress.set(p.itemID, p);
      this._patchRow(p.itemID);
      if (p.state === 'done' || p.state === 'error') this._load({ silent: true });
    });
    window.robin.transcribeReady().then((ready) => {
      this._transcribeReady = ready === true;
      if (this.overlay) for (const item of this.items) this._patchRow(item.itemID);
    }).catch(() => {});
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
    if (this._unsubscribeTranscribe) {
      this._unsubscribeTranscribe();
      this._unsubscribeTranscribe = null;
    }
    releaseEscapeLayer(this._escLayer);
    this._escLayer = null;
    this.overlay.remove();
    this.overlay = null;
    this._restoreFocus?.(); // R55：浮层退场后焦点归还打开者
    this._restoreFocus = null;
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
    const result = await window.robin.mediaList(this.filter, { limit: PAGE_SIZE, offset: 0, query: this._query || null });
    if (!this.overlay) return;
    this.items = Array.isArray(result) ? result : [];
    await this._syncQueueSet();
    this._renderRows();
    if (!silent) {
      const counts = await window.robin.mediaCounts();
      if (this.overlay) {
        this._counts = counts || {};
        this._syncFilterButtons();
      }
    }
  }

  /** 队列归属缓存（行内队列按钮回显用）；增删后调用一次即可。 */
  async _syncQueueSet() {
    try {
      const queue = await window.robin.mediaQueueList();
      this._queueIDs = new Set((Array.isArray(queue) ? queue : []).map((m) => m.itemID));
    } catch (_) {
      this._queueIDs = new Set();
    }
  }

  /** 队列按钮（在 refreshState 重建的动作区内创建——否则下载进度补丁会把它冲掉）。 */
  _appendQueueBtn(stateWrap, item) {
    const sync = () => {
      const inQueue = this._queueIDs?.has(item.itemID);
      queueBtn.textContent = inQueue ? t('移出队列') : t('加入队列');
      queueBtn.title = inQueue ? t('移出播放队列') : t('加入播放队列，自动连播');
      queueBtn.classList.toggle('in-queue', !!inQueue);
    };
    const queueBtn = el('button', 'btn-text nj-media-queue');
    queueBtn.type = 'button';
    queueBtn.addEventListener('click', async () => {
      if (this._queueIDs?.has(item.itemID)) {
        await window.robin.mediaQueueRemove(item.itemID);
        this._queueIDs.delete(item.itemID);
        this.deps.toast?.(t('已移出队列'));
      } else {
        await window.robin.mediaQueueAdd(item.itemID);
        this._queueIDs.add(item.itemID);
        this.deps.toast?.(t('已加入队列'));
      }
      sync();
    });
    sync();
    stateWrap.appendChild(queueBtn);
  }

  /**
   * 转写按钮/状态徽标（F22，仅音频行）：
   * running → 「转写中 N%」/「转写中…」；queued → 「排队中」；error → 「失败」+「重试转写」；
   * done → 「文字稿」开面板按钮；未转写 → 「转写」按钮（端点未配置灰置 + tooltip 指路设置）。
   */
  _appendTranscribeBtn(stateWrap, item) {
    if (item.kind !== 'audio') return;
    const live = this._transcribeProgress.get(item.itemID);
    const state = live?.state || item.transcriptStatus || 'none';
    const start = (btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const tx = await window.robin.transcribeMedia(item.itemID);
          this._transcribeProgress.set(item.itemID, { itemID: item.itemID, state: tx?.status || 'queued' });
        } catch (e) {
          this.deps.toast?.(String(e && e.message || e) || t('转写失败'));
        }
        this._patchRow(item.itemID); // 整行动作区重建：徽标随最新状态切换（排队中/转写中）
      });
    };
    const refreshStateTx = () => {
      stateWrap.querySelectorAll('.nj-media-tx, .nj-media-tx-status, .nj-media-tx-open, .nj-media-tx-retry').forEach((n) => n.remove());
      const fresh = this.items.find((x) => x.itemID === item.itemID) || item;
      const wrap = document.createDocumentFragment();
      if (state === 'running' || state === 'queued') {
        const pct = state === 'running' && live && live.pct != null ? Math.max(1, Math.min(99, live.pct)) : null;
        // U32 统一进度语言：确定式（有百分比→进度条+百分比）/ 不确定式（无→呼吸点）
        const prog = progressElement({ percent: pct, note: state === 'queued' ? t('排队中') : (pct != null ? t('转写中') : t('转写中…')) });
        prog.el.classList.add('nj-media-tx-status');
        wrap.appendChild(prog.el);
      } else if (state === 'error') {
        const badge = el('span', 'nj-media-tx-status failed', t('失败'));
        badge.title = String(live?.error || fresh.transcriptError || t('转写失败'));
        const retry = el('button', 'btn-text nj-media-tx-retry', t('重试转写'));
        retry.type = 'button';
        retry.title = badge.title;
        start(retry);
        wrap.append(badge, retry);
      } else if (fresh.hasTranscript || state === 'done') {
        const open = el('button', 'btn-text nj-media-tx-open', t('文字稿'));
        open.type = 'button';
        open.title = t('查看文字稿');
        open.addEventListener('click', () => this._openTranscript(item.itemID));
        wrap.appendChild(open);
      } else {
        const btn = el('button', 'btn-text nj-media-tx', t('转写'));
        btn.type = 'button';
        if (!this._transcribeReady) {
          btn.disabled = true;
          btn.title = t('未配置转写端点：在 设置 → 转写 中开启并填写本地 ASR 服务地址');
        } else {
          btn.title = t('用本地 ASR 服务把音频转成可搜索的文字稿');
          start(btn);
        }
        wrap.appendChild(btn);
      }
      stateWrap.appendChild(wrap);
    };
    refreshStateTx();
  }

  /**
   * 文字稿面板（F22）：AI 摘要（若有）置顶 + 可滚动全文（segments 在场渲染时间戳，
   * 否则纯文本）+ 一键复制 + AI 摘要按钮（无 Key 灰置）。
   */
  async _openTranscript(itemID) {
    const tx = await window.robin.mediaTranscript(itemID);
    if (!tx || tx.status !== 'done') {
      this.deps.toast?.(t('文字稿还没有完成'));
      return;
    }
    document.querySelector('.nj-transcript-overlay')?.remove();
    const overlay = el('div', 'modal-overlay nj-transcript-overlay');
    const panel = el('div', 'modal nj-transcript-modal');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t('文字稿'));
    const head = el('div', 'nj-transcript-head');
    const title = el('h3', null, t('文字稿'));
    const metaBits = [];
    if (tx.language) metaBits.push(tx.language);
    if (tx.durationSeconds > 0) metaBits.push(fmtDuration(tx.durationSeconds));
    const sub = el('span', 'nj-transcript-sub', metaBits.join(' · '));
    const closeBtn = el('button', 'btn icon-only nj-transcript-close');
    closeBtn.type = 'button';
    closeBtn.innerHTML = icon('close');
    closeBtn.title = t('关闭');
    head.append(title, sub, closeBtn);
    panel.appendChild(head);

    const body = el('div', 'nj-transcript-body');
    // 摘要置顶（已生成时）
    if (tx.summary) {
      const sumBox = el('div', 'nj-transcript-summary');
      sumBox.appendChild(el('div', 'nj-transcript-summary-title', t('AI 摘要')));
      sumBox.appendChild(el('div', 'nj-transcript-summary-text', tx.summary));
      body.appendChild(sumBox);
    }
    const content = el('div', 'nj-transcript-content');
    if (Array.isArray(tx.segments) && tx.segments.length) {
      for (const seg of tx.segments) {
        const row = el('div', 'nj-transcript-seg');
        const ts = el('span', 'nj-transcript-ts', fmtTimestamp(seg.start));
        const text = el('span', 'nj-transcript-seg-text', seg.text || '');
        row.append(ts, text);
        content.appendChild(row);
      }
    } else {
      content.appendChild(el('p', 'nj-transcript-plain', tx.text || t('（空文字稿）')));
    }
    body.appendChild(content);
    panel.appendChild(body);

    const foot = el('div', 'nj-transcript-foot');
    const copyBtn = el('button', 'btn-text bordered', t('复制文字稿'));
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', async () => {
      const plain = Array.isArray(tx.segments) && tx.segments.length
        ? tx.segments.map((s) => `[${fmtTimestamp(s.start)}] ${s.text || ''}`).join('\n')
        : tx.text;
      try { await window.robin.copyText(plain); this.deps.toast?.(t('已复制文字稿')); }
      catch (_) { this.deps.toast?.(t('复制失败')); }
    });
    const aiBtn = el('button', 'btn-text primary', tx.summary ? t('重新生成 AI 摘要') : t('AI 摘要'));
    aiBtn.type = 'button';
    if (window.__robinLLM?.__hasKey === false) {
      aiBtn.disabled = true;
      aiBtn.title = t('尚未配置 AI API Key：在 设置 → AI 功能 中配置后可用');
    }
    aiBtn.addEventListener('click', async () => {
      aiBtn.disabled = true;
      aiBtn.textContent = t('正在生成摘要…');
      try {
        const res = await window.robin.transcriptSummary(itemID);
        const sumBox = body.querySelector('.nj-transcript-summary');
        if (sumBox) sumBox.querySelector('.nj-transcript-summary-text').textContent = res.summary || '';
        else {
          const box = el('div', 'nj-transcript-summary');
          box.appendChild(el('div', 'nj-transcript-summary-title', t('AI 摘要')));
          box.appendChild(el('div', 'nj-transcript-summary-text', res.summary || ''));
          body.insertBefore(box, body.firstChild);
        }
        this.deps.toast?.(t('摘要已生成'));
        aiBtn.textContent = t('重新生成 AI 摘要');
      } catch (e) {
        this.deps.toast?.(String(e && e.message || e) || t('摘要生成失败'));
        aiBtn.textContent = tx.summary ? t('重新生成 AI 摘要') : t('AI 摘要');
      }
      aiBtn.disabled = window.__robinLLM?.__hasKey === false;
    });
    foot.append(copyBtn, aiBtn);
    panel.appendChild(foot);

    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) closePanel(); });
    const closePanel = () => {
      document.removeEventListener('keydown', escClose);
      overlay.remove();
    };
    const escClose = (event) => { if (event.key === 'Escape' && !event.defaultPrevented) closePanel(); };
    document.addEventListener('keydown', escClose);
    closeBtn.addEventListener('click', () => closePanel());
    document.body.appendChild(overlay);
  }

  async _loadMore() {
    // 携带与 _load 相同的文字稿过滤词（批 A 审查 P1-3：否则搜索态翻页混入未过滤行）
    const result = await window.robin.mediaList(this.filter, { limit: PAGE_SIZE, offset: this.items.length, query: this._query || null });
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
    if (item.hasTranscript) {
      // 「稿」徽标（F22）：该条目已有完成文字稿（可搜索/可看）
      const badge = el('span', 'nj-media-transcript-badge', t('稿'));
      badge.title = t('已有文字稿，点右侧「文字稿」查看');
      meta.appendChild(badge);
    }
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
        this._appendQueueBtn(stateWrap, item);
        this._appendTranscribeBtn(stateWrap, item); // 转写按钮（F22：仅音频行）
      }
    };
    row.__refreshState = refreshState;
    refreshState();
    // 动作区拦截冒泡：按钮 handler 内 refreshState 会重建动作区（点击目标被脱离 DOM，
    // closest 守卫失效）→ 不拦住的话 row 级点击会把「下载」误判成「播放」
    stateWrap.addEventListener('click', (event) => event.stopPropagation());
    row.appendChild(stateWrap);

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
