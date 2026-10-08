'use strict';
/**
 * RobinRead（知更）— 书架 / 文集共享 UI（F12）
 *
 * - bookMenuItems：右键「加入文集」子菜单项（订阅源右键 + 文章行右键共用；
 *   列出既有文集 + 「新建文集…」入口）
 * - showCreateBookDialog：新建文集浮层（命名 + 多选订阅源 checkbox 列表）
 * - bookMetaLine：书架行元信息文案（纯函数，可单测）
 *
 * 文集可含多源：右键加入 = 把当前源并入文集的 feed_ids（幂等去重）。
 */
import { t, tf } from '../i18n.js';
import { icon } from '../icons.js';
import { promptBox } from '../ui-prompt.js';

/** 书架行元信息：绑定源数 · 上次成书篇数 · 上次成书时间。 */
export function bookMetaLine(book) {
  const parts = [tf('%lld 个订阅源', book.feedCount ?? (book.feedIDs || []).length)];
  if (book.lastBuiltAt) {
    parts.push(tf('上次成书 %lld 篇', book.lastEntryCount ?? 0));
    const d = new Date(book.lastBuiltAt * 1000);
    if (!Number.isNaN(d.getTime())) parts.push(d.toISOString().slice(0, 10));
  } else {
    parts.push(t('尚未成书'));
  }
  return parts.join(' · ');
}

/**
 * 右键「加入文集」子菜单项。
 * params: { books: [{id,title}], feedIDs: string[], onAddToBook(bookID, feedIDs), onCreateBook(feedIDs) }
 */
export function bookMenuItems({ books, feedIDs, onAddToBook, onCreateBook }) {
  const items = [];
  for (const book of Array.isArray(books) ? books : []) {
    items.push({
      label: book.title,
      icon: 'books',
      onClick: () => onAddToBook?.(book.id, feedIDs),
    });
  }
  if (items.length) items.push({ type: 'separator' });
  items.push({
    label: t('新建文集…'),
    icon: 'books',
    onClick: () => onCreateBook?.(feedIDs),
  });
  return items;
}

/**
 * 新建文集浮层：命名（promptBox）→ 多选订阅源（checkbox 列表浮层）→ onCreate({ title, feedIDs })。
 * 返回 Promise<boolean>（是否完成创建）。
 */
export async function showCreateBookDialog({ feeds, preselectedFeedIDs = [], onCreate }) {
  const name = await promptBox(t('新建文集'), { placeholder: t('文集名称'), initial: '' });
  if (name == null) return false;
  const title = String(name).trim();
  if (!title) return false;

  const allFeeds = (Array.isArray(feeds) ? feeds : []).slice().sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'));
  const pre = new Set((preselectedFeedIDs || []).map(String));
  const checked = new Set(allFeeds.filter((f) => pre.has(String(f.id))).map((f) => f.id));

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) { overlay.remove(); resolve(false); }
    });
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.style.cssText = 'max-width:520px;min-width:440px;max-height:70vh;display:flex;flex-direction:column;';
    const esc = (event) => { if (event.key === 'Escape') { cleanup(false); } };
    const cleanup = (result) => {
      document.removeEventListener('keydown', esc);
      overlay.remove();
      resolve(result);
    };
    document.addEventListener('keydown', esc);

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = '<h3></h3>';
    header.querySelector('h3').textContent = tf('新建文集「%@」', title);
    const close = document.createElement('button');
    close.className = 'btn icon-only';
    close.innerHTML = icon('close');
    close.addEventListener('click', () => cleanup(false));
    header.appendChild(close);

    const body = document.createElement('div');
    body.className = 'modal-scroll';
    body.style.cssText = 'flex:1;overflow-y:auto;padding:4px 18px;';
    if (!allFeeds.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:18px 4px;color:var(--text-secondary);font-size:13px;';
      empty.textContent = t('还没有订阅源，先添加订阅再建文集。');
      body.appendChild(empty);
    }
    for (const feed of allFeeds) {
      const labelEl = document.createElement('label');
      labelEl.style.cssText = 'display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid var(--separator);cursor:pointer;';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = checked.has(feed.id);
      box.addEventListener('change', () => {
        if (box.checked) checked.add(feed.id); else checked.delete(feed.id);
        updateCount();
      });
      const text = document.createElement('span');
      text.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      text.textContent = feed.title || feed.feedURL || feed.id;
      labelEl.append(box, text);
      body.appendChild(labelEl);
    }

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 18px;border-top:1px solid var(--separator);';
    const countEl = document.createElement('span');
    countEl.style.cssText = 'font-size:12px;color:var(--text-secondary);';
    const updateCount = () => { countEl.textContent = tf('已选 %lld 个订阅源', checked.size); };
    updateCount();
    const createBtn = document.createElement('button');
    createBtn.className = 'btn-text primary';
    createBtn.textContent = t('创建文集');
    createBtn.addEventListener('click', async () => {
      const feedIDs = allFeeds.filter((f) => checked.has(f.id)).map((f) => f.id);
      createBtn.disabled = true;
      try { await onCreate?.({ title, feedIDs }); } finally { createBtn.disabled = false; }
      cleanup(true);
    });
    footer.append(countEl, createBtn);

    modal.append(header, body, footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  });
}
