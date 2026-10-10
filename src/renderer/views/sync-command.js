'use strict';
/**
 * sync-command.js — F7 WebDAV 同步的命令面板入口（独立小模块，便于离线探针直测）
 *
 * 命令 = { label, keywords, icon, action }（command-palette 既有契约）。
 * action：调 syncNow → 成功 toast 合并统计；失败 alertBox 明确提示（认证/超时/网络分类文案由主进程给出）。
 */
import { t, tf } from '../i18n.js';
import { alertBox } from '../ui-prompt.js';
import { Toast } from './toast.js'; // U32 统一进度语言：不确定式长任务呼吸点

/** 同步统计 → 人类可读结果（上行 / 下行合并 / 合并后上行三态）。 */
export function syncResultText(stats) {
  if (!stats) return t('同步完成');
  const feeds = Number(stats.feedsAddedFromRemote) || 0;
  const ann = Number(stats.annotationsAddedFromRemote) || 0;
  const progress = Number(stats.progressUpdatedFromRemote) || 0;
  const prefs = Number(stats.prefsApplied) || 0;
  if (stats.direction === 'upload') {
    const up = stats.uploadedEntries || {};
    return tf('已上行快照：订阅 %lld · 批注 %lld · 进度 %lld',
      Number(up.feeds) || 0, Number(up.annotations) || 0, Number(up.progress) || 0);
  }
  if (stats.direction === 'merge-upload') {
    return tf('已合并并上行：新订阅 %lld · 新批注 %lld · 进度 %lld · 偏好 %lld', feeds, ann, progress, prefs);
  }
  return tf('已下行合并：新订阅 %lld · 新批注 %lld · 进度 %lld · 偏好 %lld', feeds, ann, progress, prefs);
}

/**
 * 「立即同步」命令（命令面板 + 设置页共用动作语义）。
 * @param {{ notify?: Function, silentError?: boolean }} hooks
 */
export function syncPaletteCommand({ notify = null, silentError = false } = {}) {
  return {
    label: t('立即同步'),
    keywords: 'sync webdav 立即同步 多设备 同步坚果云 dav',
    icon: 'cloud',
    action: async () => {
      // U32 统一进度语言：同步无百分比 → 不确定式呼吸点进度通知（done/fail 收口换态）。
      // 成功路径 breathe.done 即收口提示；notify 仅在调用方需要旁路展示（如设置页状态行）时保留。
      const breathe = Toast.breathe(t('正在同步…'), { note: t('与 WebDAV 交换快照') });
      try {
        const result = await window.robin.syncNow();
        if (result && result.ok) {
          breathe.done(syncResultText(result.data));
          if (notify) notify(syncResultText(result.data));
        } else {
          const message = String((result && result.error) || t('同步失败'));
          breathe.fail(message);
          if (silentError) notify?.(message);
          else await alertBox(t('同步失败'), message);
        }
      } catch (err) {
        const message = String((err && err.message) || err || t('同步失败'));
        breathe.fail(message);
        if (silentError) notify?.(message);
        else await alertBox(t('同步失败'), message);
      }
    },
  };
}
