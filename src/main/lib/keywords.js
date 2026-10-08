'use strict';
/**
 * lib/keywords（知更）— 显著词提取共享模块（F13 抽取自 F9 RAGService）
 *
 * 抽取目的：相似引擎（F13 SimilarService）与线索聚类需要与 F9 完全同源的
 * 「显著检索词」口径——分隔符切词、停用词剔除、按长度取显著——单一实现避免
 * 两处漂移。RAGService 仍从本模块引用并原样再导出（diag-f9-rag 探针的既有
 * 导入面不变）；SmartPicksService 的画像分词（CJK 滑窗）另有侧重，本轮不合并。
 */

/** 中英停用词/口语词（关键词提取时剔除——它们在正文里高频出现，LIKE 命中无意义）。 */
const STOPWORDS = new Set([
  '什么', '怎么', '怎样', '如何', '为什么', '为何', '请问', '哪些', '多少', '是不是',
  '关于', '还是', '以及', '而且', '但是', '这个', '那个', '一下', '一些', '可以',
  '应该', '需要', '有没有', '告诉我', '介绍', '总结', '帮我', '我想', '知道', '看看',
  'the', 'and', 'for', 'with', 'what', 'how', 'why', 'that', 'this', 'are', 'was',
]);

function isCJK(text) {
  return /[\u4e00-\u9fff]/.test(text);
}

/** 标题归一（无 entryID 素材的去重口径）：小写 + 去全部空白。 */
function normalizeTitle(title) {
  return String(title || '').toLowerCase().replace(/\s+/g, '');
}

/**
 * 问题/文本 → 2-3 个显著检索词：按分隔符切词、剔停用词与单字符、按长度降序取显著词。
 * 中文长段截前 8 字（LIKE 键过长会零命中）；西文词截前 24 字。
 */
function extractKeywords(question, max = 3) {
  const segments = String(question || '')
    .split(/[\s，。！？、；：,.!?;:()（）\[\]【】{}"'“”《》<>\-—–\/\\|@#$%^&*+=~`…·]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  const scored = segments
    .filter((s) => s.length >= 2 && !STOPWORDS.has(s.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  for (let seg of scored) {
    if (isCJK(seg) && seg.length > 8) seg = seg.slice(0, 8);
    else if (!isCJK(seg) && seg.length > 24) seg = seg.slice(0, 24);
    const key = seg.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(seg);
    if (out.length >= max) break;
  }
  return out;
}

module.exports = { STOPWORDS, isCJK, normalizeTitle, extractKeywords };
