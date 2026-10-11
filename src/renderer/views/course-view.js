'use strict';
/**
 * RobinRead（知更）— 自学课程浮层（F30 自学课程引擎）
 *
 * 进行中课程卡（目标 + 进度条 N/14 + 今日课按钮）→ 今日课面板（当日要点 +
 * 文章列表 + 完成本日）→ 历史课程（放弃/毕业留档）。创建 = 「+ 新目标」表单
 * （目标 ≤120 字 + 7/14 天选择；无 AI Key 时按钮灰置——大纲质量是功能核心，
 * 不做纯检索降级）。文章点击直达阅读，读完回来 isRead 自动勾选。
 */
import { t, tf } from '../i18n.js';
import { icon } from '../icons.js';
import { staggerEmptyHTML } from './empty-art.js'; // U31 空态二期：插画空态统一壳
import { registerEscapeLayer, isTopEscapeLayer, releaseEscapeLayer } from './overlay-stack.js'; // R55 浮层秩序

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class CourseView {
  constructor(deps = {}) {
    this.deps = { toast: deps.toast || null, onOpenArticle: deps.onOpenArticle || null };
    this.overlay = null;
    this.courses = [];
    this.active = null;   // 当前展开的课程（今日课面板）
    this.today = null;    // 今日课载荷 { course, finished, today }
    this.hasAI = true;
    this.creating = false;
    this.showForm = false;
  }

  present() {
    if (this.overlay) return;
    const overlay = el('div', 'modal-overlay nj-course-overlay');
    const modal = el('div', 'modal nj-course-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', t('自学课程'));
    const head = el('div', 'modal-header nj-course-head');
    head.appendChild(el('h3', null, t('自学课程')));
    const newBtn = el('button', 'btn-text bordered nj-course-new');
    newBtn.type = 'button';
    newBtn.innerHTML = `${icon('spark')}<span></span>`;
    newBtn.querySelector('span').textContent = t('+ 新目标');
    newBtn.addEventListener('click', () => {
      this.showForm = !this.showForm;
      this._render();
    });
    head.appendChild(newBtn);
    const close = el('button', 'btn icon-only nj-course-close');
    close.type = 'button';
    close.innerHTML = icon('close');
    close.title = t('关闭');
    close.addEventListener('click', () => this.dismiss());
    head.appendChild(close);
    modal.appendChild(head);

    this.bodyEl = el('div', 'nj-course-body');
    modal.appendChild(this.bodyEl);
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) this.dismiss(); });
    document.body.appendChild(overlay);
    this.overlay = overlay;
    window.__robinCourseView = this; // E2E 探测句柄

    this._esc = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!isTopEscapeLayer(this._escLayer)) return; // R55：顶层先关（一次 Esc 只关一层）
      event.preventDefault();
      this.dismiss();
    };
    document.addEventListener('keydown', this._esc);
    this._escLayer = registerEscapeLayer({ id: 'course-overlay', isAlive: () => Boolean(this.overlay) }); // R55 浮层栈挂账

    this._load();
  }

  dismiss() {
    if (!this.overlay) return;
    document.removeEventListener('keydown', this._esc);
    releaseEscapeLayer(this._escLayer);
    this._escLayer = null;
    this.overlay.remove();
    this.overlay = null;
    if (window.__robinCourseView === this) window.__robinCourseView = null;
  }

  async _load() {
    try {
      this.hasAI = await window.robin.courseAvailable().catch(() => false);
      const { courses } = (await window.robin.courseList()) || {};
      this.courses = Array.isArray(courses) ? courses : [];
      if (!this.active) {
        this.active = this.courses.find((c) => c.status === 'active') || null;
      } else {
        const fresh = await window.robin.courseGet(this.active.id).catch(() => null);
        if (fresh) this.active = fresh;
      }
      this.today = this.active ? await window.robin.courseToday(this.active.id).catch(() => null) : null;
      this._render();
    } catch (_) {
      this._render();
    }
  }

  async _create() {
    if (this.creating) return;
    const input = this.overlay?.querySelector('.nj-course-goal-input');
    const goal = String(input?.value || '').trim();
    if (!goal) { this.deps.toast?.(t('先写下你的学习目标。')); return; }
    if (goal.length > 120) { this.deps.toast?.(t('目标最多 120 字，精炼一点更好。')); return; }
    const days = Number(this.overlay?.querySelector('.nj-course-days input:checked')?.value || 14);
    this.creating = true;
    this._render();
    try {
      const result = await window.robin.courseCreate(goal, days);
      if (!result?.ok) throw new Error(String(result?.error || t('创建失败')));
      const created = result.data;
      this.active = created || null;
      this.showForm = false;
      this.deps.toast?.(t('课程排好了，今天开始第一课。'));
    } catch (err) {
      this.deps.toast?.(String(err.message || err).slice(0, 140));
    } finally {
      this.creating = false;
      await this._load();
    }
  }

  async _openCourse(courseID) {
    this.active = await window.robin.courseGet(courseID).catch(() => null);
    this.today = this.active ? await window.robin.courseToday(courseID).catch(() => null) : null;
    this._render();
  }

  async _completeDay() {
    if (!this.today?.today) return;
    const day = this.today.today.day;
    try {
      const result = await window.robin.courseCompleteDay(this.active.id, day);
      if (!result?.ok) throw new Error(String(result?.error || t('打卡失败')));
      const data = result.data || {};
      this.deps.toast?.(data.courseDone
        ? t('课程毕业！全部课程读完，恭喜。')
        : tf('第 %lld 天完成，下一天已解锁。', day));
    } catch (err) {
      this.deps.toast?.(String(err.message || err).slice(0, 140));
    }
    await this._load();
  }

  async _abandon(courseID) {
    try {
      const result = await window.robin.courseAbandon(courseID);
      if (!result?.ok) throw new Error(String(result?.error || t('操作失败')));
      this.deps.toast?.(t('课程已放弃，随时可以立新目标。'));
      if (this.active?.id === courseID) { this.active = null; this.today = null; }
    } catch (err) {
      this.deps.toast?.(String(err.message || err).slice(0, 140));
    }
    await this._load();
  }

  _render() {
    if (!this.bodyEl || !this.overlay) return;
    const newBtn = this.overlay.querySelector('.nj-course-new');
    if (newBtn) {
      // 入口按钮保持可点（点开表单看说明/灰置的创建键），只有提交键灰置——课程引擎需要 AI Key
      newBtn.disabled = this.creating;
      newBtn.title = this.hasAI ? '' : t('课程引擎需要 AI Key');
    }
    this.bodyEl.innerHTML = '';
    if (this.showForm) this.bodyEl.appendChild(this._form());
    if (!this.courses.length && !this.showForm) {
      this.bodyEl.innerHTML = `
        <div class="nj-course-empty list-empty stagger">
          ${staggerEmptyHTML('books')}
        </div>`; // U31 空态二期：书架插画 + 错峰入场
      this.bodyEl.querySelector('h3').textContent = t('还没有课程');
      this.bodyEl.querySelector('p').textContent = t('给一个学习目标，AI 从你的订阅库里排出 7 或 14 天课程，每天读几篇刚好。');
      return;
    }
    for (const course of this.courses) {
      if (this.active && course.id === this.active.id && this.today && !this.today.finished) {
        this.bodyEl.appendChild(this._courseCard(this.today));
        this.bodyEl.appendChild(this._todayPanel(this.today));
      } else {
        this.bodyEl.appendChild(this._courseRow(course));
      }
    }
  }

  /** 创建表单：目标文本（≤120 字）+ 时长 7/14 + 提交（无 Key 灰置）。 */
  _form() {
    const form = el('div', 'nj-course-form');
    const label = el('label', 'nj-course-form-label', t('学习目标'));
    const input = el('input', 'nj-course-goal-input');
    input.type = 'text';
    input.maxLength = 120;
    input.placeholder = t('例如：三个月读懂机器学习基础');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this._create(); } });
    const daysRow = el('div', 'nj-course-days');
    for (const d of [7, 14]) {
      const opt = el('label', 'nj-course-day-opt');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'nj-course-days';
      radio.value = String(d);
      if (d === 14) radio.checked = true;
      opt.appendChild(radio);
      opt.appendChild(el('span', null, tf('%lld 天', d)));
      daysRow.appendChild(opt);
    }
    const submit = el('button', 'btn-text primary nj-course-create');
    submit.type = 'button';
    submit.textContent = this.creating ? t('正在排课…') : t('生成课程');
    submit.disabled = this.creating || !this.hasAI;
    if (!this.hasAI) submit.title = t('课程引擎需要 AI Key');
    submit.addEventListener('click', () => this._create());
    form.append(label, input, daysRow, submit);
    if (!this.hasAI) {
      const warn = el('p', 'nj-course-warn', t('课程引擎需要 AI Key：大纲质量是课程的核心，暂无纯检索降级。'));
      form.appendChild(warn);
    }
    return form;
  }

  /** 进行中课程卡：目标 + 进度条 N/14。 */
  _courseCard(payload) {
    const course = payload.course;
    const card = el('div', 'nj-course-card');
    const goal = el('div', 'nj-course-goal', course.goal);
    const progress = el('div', 'nj-course-progress');
    const bar = el('div', 'nj-course-progress-bar');
    const fill = el('div', 'nj-course-progress-fill');
    fill.style.width = `${Math.min(100, Math.max(0, course.progress.pct))}%`;
    bar.appendChild(fill);
    const nums = el('span', 'nj-course-progress-nums', tf('%lld / %lld 天', course.progress.completed, course.progress.total));
    progress.append(bar, nums);
    card.append(goal, progress);
    return card;
  }

  /** 今日课面板：当日要点 + 文章列表（已读自动勾选）+ 完成本日。 */
  _todayPanel(payload) {
    const today = payload.today;
    const panel = el('section', 'nj-course-today');
    const head = el('div', 'nj-course-today-head');
    head.appendChild(el('span', 'nj-course-today-kicker', t('今日课')));
    head.appendChild(el('b', null, tf('第 %lld 天', today.day)));
    panel.appendChild(head);
    if (today.point) panel.appendChild(el('p', 'nj-course-point', today.point));
    const list = el('div', 'nj-course-entries');
    for (const entry of (today.entries || [])) {
      const row = el('button', `nj-course-entry${entry.isRead ? ' is-read' : ''}`);
      row.type = 'button';
      row.innerHTML = `
        <span class="nj-course-entry-check">${entry.isRead ? icon('checkCircle') : icon('circle')}</span>
        <span class="nj-course-entry-main"><span class="nj-course-entry-title"></span><span class="nj-course-entry-src"></span></span>
        <span class="nj-course-entry-go"></span>`;
      row.querySelector('.nj-course-entry-title').textContent = entry.title || entry.entryID;
      row.querySelector('.nj-course-entry-src').textContent = entry.sourceTitle || '';
      row.querySelector('.nj-course-entry-go').textContent = entry.isRead ? t('已读') : t('去读');
      row.addEventListener('click', () => {
        if (this.deps.onOpenArticle && entry.entryID) this.deps.onOpenArticle(entry.entryID);
      });
      list.appendChild(row);
    }
    panel.appendChild(list);
    const actions = el('div', 'nj-course-actions');
    const done = el('button', 'btn-text primary nj-course-done');
    done.type = 'button';
    done.textContent = t('完成本日');
    done.addEventListener('click', () => this._completeDay());
    actions.appendChild(done);
    const allRead = (today.entries || []).every((e) => e.isRead);
    if (!allRead) {
      actions.appendChild(el('span', 'nj-course-hint', t('读完本日全部文章才能打卡解锁下一天。')));
    }
    panel.appendChild(actions);
    return panel;
  }

  /** 历史/未展开课程行：点击展开为今日课。 */
  _courseRow(course) {
    const row = el('button', 'nj-course-card nj-course-row');
    row.type = 'button';
    const goal = el('span', 'nj-course-goal', course.goal);
    const meta = el('span', 'nj-course-progress-nums');
    meta.textContent = course.status === 'done' ? t('已毕业')
      : course.status === 'abandoned' ? t('已放弃')
        : tf('%lld / %lld 天', course.progress.completed, course.progress.total);
    row.append(goal, meta);
    if (course.status === 'active') {
      row.addEventListener('click', () => this._openCourse(course.id));
    } else {
      row.classList.add('is-history');
      row.disabled = true;
    }
    if (course.status === 'active') {
      const stop = el('span', 'nj-course-abandon', t('放弃'));
      stop.addEventListener('click', (event) => {
        event.stopPropagation();
        this._abandon(course.id);
      });
      row.appendChild(stop);
    }
    return row;
  }
}
