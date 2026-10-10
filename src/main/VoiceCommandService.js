'use strict';
/**
 * VoiceCommandService（知更）— 语音指挥舱（F35，有趣档；零 AI 口令匹配）
 *
 * 朗读 / 电台播放中的 hands-free 闭环：动口不动手——语音口令控制
 * （暂停/继续/下一篇/上一篇/收藏/「讲重点」/关闭浮层）。
 *
 * 职责边界：
 * - 本服务只做两件事：口令表（双语）+ 模糊匹配（纯本地字符串，零 AI）；
 *   识别本体（webkitSpeechRecognition）在渲染层 VoiceOrb（Electron 37 可用性
 *   探测后启用；不可用 → 口令按钮环降级，动作集完全一致）。
 * - 「讲重点」的 AI 摘要播报由渲染层 dispatch（generateSummary → picksTTS 链），
 *   无 Key 降级为跳到下一篇——降级决策也在渲染层（能直接拿到 hasAPIKey 与
 *   播放器实例），主进程不做第二份播放编排。
 * - 语言跟随界面语言（zh-CN / en-US）；匹配先归一化（小写/去空白/去标点），
 *   再按「最长短语优先」扫描——「收藏这篇」不会被「收藏」抢先截胡成歧义。
 */

/**
 * 口令表（zh / en 双语；顺序即同分优先级，长短语优先由 matchCommand 保证）。
 * action 语义（渲染层 dispatch）：
 * - toggle    暂停/继续/停止（同一词族：电台 toggle；朗读 stop——朗读无暂停档）
 * - next/prev 下一篇/上一篇（电台语境 = 下/上一句）
 * - star      收藏当前文章
 * - summarize 「讲重点」：AI 摘要播报（无 Key → 跳下一篇）
 * - close     关闭浮层（简报浮层等）
 */
const VOICE_COMMANDS = {
  zh: [
    { action: 'toggle', label: '暂停 / 继续', phrases: ['暂停', '继续', '停止', '播放'] },
    { action: 'next', label: '下一篇', phrases: ['下一篇', '下一条', '下一个'] },
    { action: 'prev', label: '上一篇', phrases: ['上一篇', '上一条', '上一个'] },
    { action: 'star', label: '收藏这篇', phrases: ['收藏这篇', '加入收藏', '收藏'] },
    { action: 'summarize', label: '讲重点', phrases: ['讲重点', '说重点', '讲讲重点', '总结一下', '重点内容'] },
    { action: 'close', label: '关闭浮层', phrases: ['关闭浮层', '关掉浮层', '收起浮层', '关闭简报'] },
  ],
  en: [
    { action: 'toggle', label: 'Pause / Resume', phrases: ['pause', 'resume', 'stop', 'play'] },
    { action: 'next', label: 'Next', phrases: ['next article', 'next one', 'next'] },
    { action: 'prev', label: 'Previous', phrases: ['previous article', 'previous one', 'previous'] },
    { action: 'star', label: 'Star this', phrases: ['star this', 'add to favorites', 'favorite', 'star'] },
    { action: 'summarize', label: 'Key points', phrases: ['key points', 'summarize', 'the gist', 'give me the gist'] },
    { action: 'close', label: 'Close overlay', phrases: ['close overlay', 'dismiss overlay', 'close the overlay'] },
  ],
};

/** 归一化：小写 + 去空白 + 去中英文标点（口令模糊匹配的第一步）。 */
function normalizeUtterance(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：…—·“”‘’（）【】《》,.!?;:'"()\[\]{}<>\-_/\\|~`@#$%^&*+=]+/g, '');
}

/**
 * 口令匹配（纯函数，探针直测）：
 * - 归一化后按「最长短语优先」扫描（同一短语表内构建一次排序视图）；
 * - 命中 → { action, phrase, label }；未命中 / 空串 → null（未知口令一律忽略）。
 * @param {string} text 识别出的语句（可含口语杂音）
 * @param {string} lang 'zh' | 'en'（缺省 zh）
 */
function matchCommand(text, lang = 'zh') {
  const table = VOICE_COMMANDS[lang === 'en' ? 'en' : 'zh'] || VOICE_COMMANDS.zh;
  const normalized = normalizeUtterance(text);
  if (!normalized) return null;
  const flat = [];
  for (const cmd of table) {
    for (const phrase of cmd.phrases) flat.push({ phrase: normalizeUtterance(phrase), action: cmd.action, label: cmd.label });
  }
  flat.sort((a, b) => b.phrase.length - a.phrase.length);
  for (const entry of flat) {
    if (entry.phrase && normalized.includes(entry.phrase)) {
      return { action: entry.action, phrase: entry.phrase, label: entry.label };
    }
  }
  return null;
}

class VoiceCommandService {
  constructor(store, { now = null } = {}) {
    this.store = store;
    this._now = now || (() => Date.now() / 1000);
  }

  /** 界面语言（口令表语言跟随）。 */
  lang() {
    const value = this.store.preferences.get('RobinRead.appLanguage', 'zh');
    return value === 'en' ? 'en' : 'zh';
  }

  /** 开关（默认关——麦克风是显式授权型功能）。 */
  getConfig() {
    return {
      enabled: this.store.preferences.get('RobinRead.voice.enabled', false) === true,
      lang: this.lang(),
    };
  }

  setEnabled(value) {
    this.store.preferences.set('RobinRead.voice.enabled', value === true);
    return this.getConfig();
  }

  /** 口令表（设置页/浮球长按展示用）。 */
  commands(lang = null) {
    return VOICE_COMMANDS[lang === 'en' || (lang === null && this.lang() === 'en') ? 'en' : 'zh'];
  }

  /** 口令匹配（渲染层识别回调走此通道——单一事实源，探针可 require 直测 matchCommand）。 */
  match(text, lang = null) {
    return matchCommand(text, lang === null ? this.lang() : lang);
  }

  /** 诊断快照（探针用）。 */
  snapshot() {
    return { ...this.getConfig(), commands: this.commands() };
  }
}

module.exports = {
  VoiceCommandService,
  VOICE_COMMANDS,
  matchCommand,
  normalizeUtterance,
};
