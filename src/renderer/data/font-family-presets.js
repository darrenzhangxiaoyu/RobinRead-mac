'use strict';
/**
 * font-family-presets.js — 正文字体族套装单一数据源（U21）
 *
 * 四套版式皮肤（宋体系 / 黑体系 / 仿宋 / 楷体）+ 自定义字体：
 * - 设置 → 外观「正文字体族」选择器与本模块共用，避免 app.js / reader-window.js /
 *   reader.js（每源排版）三处 fontMap 漂移（照 typography-presets.js R7 手法）。
 * - 自定义字体 = 用户系统已装字体名输入（不落盘字体文件），名称经
 *   sanitizeCustomFontName 消毒后才可进 font-family（防 CSS 注入）。
 * - 消费通道：applyReaderLayout 把解析后的具体字体栈写入
 *   --reader-font（既有合同，每源排版可 article 级覆盖）与
 *   --reader-font-family（U21 新变量）；robin.css 内的 --reader-font-family
 *   缺省值与本文件 serif 栈保持同步（注释互指）。
 */

/** 四档预设 + 内置楷体（wenkai 兼容键）+ custom（自定义输入）。 */
export const READER_FONT_KEYS = ['serif', 'sans', 'wenkai', 'fangsong', 'kaiti', 'custom'];

/** 选择器展示名（键 → i18n 中文原文；en 文案在 I18NStrings.js）。 */
export const READER_FONT_LABELS = {
  serif: '宋体系（默认）',
  sans: '黑体系',
  wenkai: '霞鹜文楷（内置）',
  fangsong: '仿宋',
  kaiti: '楷体',
  custom: '自定义…',
};

/** 具体字体栈（与 robin.css --reader-font-family 缺省同步；引号内为已装字体名）。 */
const FONT_STACKS = {
  serif: '"Songti SC", "STSong", "Source Han Serif SC", "Noto Serif SC", "SimSun", Georgia, serif',
  sans: '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif',
  // wenkai（既有键）与 kaiti（U21 楷体皮肤）同栈：霞鹜文楷为内置离线兜底（OFL 授权）
  wenkai: '"LXGW WenKai Screen", "Kaiti SC", "STKaiti", "KaiTi", "SimSun", Georgia, serif',
  kaiti: '"LXGW WenKai Screen", "Kaiti SC", "STKaiti", "KaiTi", "SimSun", Georgia, serif',
  fangsong: '"FangSong", "STFangsong", "FangSong_GB2312", "SimSun", Georgia, serif',
};

/**
 * 自定义字体名消毒：剥除引号/分号/花括号/反斜杠/控制字符等 font-family 语法字符，
 * 防止把任意 CSS 注入进 --reader-font；空名返回空串（调用方回退预设）。
 */
export function sanitizeCustomFontName(raw) {
  return String(raw ?? '')
    .replace(/["';{}\\]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * 解析版式皮肤 → 具体 font-family 栈。
 * @param {{fontFamily?:string, customFont?:string}} layout
 * @returns {string} 可直接进 style.setProperty 的字体栈
 */
export function resolveReaderFontStack(layout) {
  const fam = layout?.fontFamily;
  if (fam === 'custom') {
    const name = sanitizeCustomFontName(layout?.customFont);
    if (name) return `"${name}", ${FONT_STACKS.serif}`;
    return FONT_STACKS.serif; // 自定义名为空：回退宋体系（不半生效）
  }
  return FONT_STACKS[fam] || FONT_STACKS.serif;
}

/** 每源排版（reader.js 旧 fontMap）沿用同一解析：非法键回退宋体系。 */
export function feedFontStack(fam) {
  return FONT_STACKS[fam] || null; // null = 该源未指定，跟随全局
}
