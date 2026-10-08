'use strict';
/**
 * run-all.js — 回归探针统一入口
 *
 * 用法：
 *   node scripts/run-all.js          # 本地全量（含真实网络的探针）
 *   node scripts/run-all.js --ci     # CI 精简集（仅离线可判定的探针）
 *
 * 每个探针以退出码判定（0=PASS）；全部结束后打印汇总，任一失败则整体退出 1。
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const OFFLINE = [
  { file: 'scripts/diag-db-health.js', runner: 'electron', desc: 'FTS 行映射 + 嵌套事务 + 灌文性能（离线）' },
  { file: 'scripts/diag-needs-extraction.js', runner: 'node', desc: 'needsExtraction 判定（离线单元）' },
  { file: 'scripts/diag-phase8-gate.js', runner: 'electron', desc: '会员全量释放 + 默认刷新间隔（离线）' },
  { file: 'scripts/diag-phase9-typography.js', runner: 'node', desc: '排版引擎 v2：盘古之白 + 设置链路（离线）' },
  { file: 'scripts/diag-phase12-knowledge.js', runner: 'electron', desc: '知识增强：图谱数据/问答受控路径（离线）' },
  { file: 'scripts/diag-phase13-backup.js', runner: 'electron', desc: '自动备份：首查快照/配置/开关（离线）' },
  { file: 'scripts/diag-phase9-font-smoke.js', runner: 'electron', desc: '排版引擎+每日刊头真实渲染烟雾（离线）' },
  { file: 'scripts/diag-edition-magazine.js', runner: 'electron', desc: '期刊翻页 2.0：对开版面/折页/封面/滑轨（离线）' },
  { file: 'scripts/diag-edition-typography.js', runner: 'electron', desc: 'R1 阅读排版：密度/页边/首字下沉面板（离线）' },
  { file: 'scripts/diag-edition-paper.js', runner: 'electron', desc: 'R2 纸张质感：四态循环/夜间独立偏好/牛皮变量（离线）' },
  { file: 'scripts/diag-edition-selection.js', runner: 'electron', desc: 'R3 划词工具条：胶囊/复制/弹层/选区守卫（离线）' },
  { file: 'scripts/diag-edition-progress.js', runner: 'electron', desc: 'R4 阅读进度：滑轨剩余时间/文章进度线预估（离线）' },
  { file: 'scripts/diag-edition-lightbox.js', runner: 'electron', desc: 'R5 灯箱增强：滚轮缩放/双击/键盘切图（离线）' },
  { file: 'scripts/diag-edition-micro.js', runner: 'electron', desc: 'R6 版面微交互：落页错落淡入/hover 精修（离线）' },
  { file: 'scripts/diag-edition-cover.js', runner: 'electron', desc: 'R7 封面升级：期号大字/头条大图/无图回退（离线）' },
  { file: 'scripts/diag-edition-toc.js', runner: 'electron', desc: 'R8 滑轨分段/目录树状（离线）' },
  { file: 'scripts/diag-edition-colwidth.js', runner: 'electron', desc: 'R9 栏宽舒适度：三档切换/分页联动/持久化（离线）' },
  { file: 'scripts/diag-edition-find.js', runner: 'electron', desc: 'R11 期刊内搜索：Ctrl+F/计数/跳页定位（离线）' },
  { file: 'scripts/diag-edition-quick.js', runner: 'electron', desc: 'R12 快捷收藏/稍后读：S/L 键/回调/重绘（离线）' },
  { file: 'scripts/diag-edition-export.js', runner: 'electron', desc: 'R13 当前页导出：captureRect/剪贴板/浮层收起（离线）' },
  { file: 'scripts/diag-edition-keys.js', runner: 'electron', desc: 'R14 快捷键速查：? 呼出/8 行/Esc 往复（离线）' },
  { file: 'scripts/diag-edition-session.js', runner: 'electron', desc: 'R15 会话统计：翻页/读文累计/退出小结（离线）' },
  { file: 'scripts/diag-edition-fx.js', runner: 'electron', desc: 'R16 动作音效：tick/done/开纸声/开关静默（离线）' },
  { file: 'scripts/diag-edition-accent.js', runner: 'electron', desc: 'R17 纸感联动强调色：四态日/夜档位（离线）' },
  { file: 'scripts/diag-edition-resume.js', runner: 'electron', desc: 'R18 续读提醒：落位+文案/无记忆静默（离线）' },
  { file: 'scripts/diag-edition-focus.js', runner: 'electron', desc: 'R19 段落聚焦：P 开关/点击/↑↓/翻页重聚焦（离线）' },
  { file: 'scripts/diag-edition-palette.js', runner: 'electron', desc: 'R20 命令面板接入：期刊命令/翻页执行/z 层级（离线）' },
  { file: 'scripts/diag-palette-groups.js', runner: 'electron', desc: 'R21 面板分组小节头：组头渲染/键盘跳过/组名可搜（离线）' },
  { file: 'scripts/diag-row-quick.js', runner: 'electron', desc: 'R22 行内快捷操作：三键挂载/隐藏浮现/IPC 参数（离线）' },
  { file: 'scripts/diag-list-batch.js', runner: 'electron', desc: 'R23 批量多选：Ctrl/Shift 圈选/批量条/批设通道（离线）' },
  { file: 'scripts/diag-search-history.js', runner: 'electron', desc: 'R26 搜索历史下拉：Enter 记忆/去重上限/点选即搜（离线）' },
  { file: 'scripts/diag-list-nav.js', runner: 'electron', desc: 'R28 键盘导航：J/K 光标/钳位/Enter 打开/叠态（离线）' },
  { file: 'scripts/diag-cv-auto.js', runner: 'electron', desc: 'R30 跳屏渲染：cv:auto 行卡/可达性/渲染耗时（离线）' },
  { file: 'scripts/diag-r31-polish.js', runner: 'electron', desc: 'R31 精修：摘要净化/工具栏统一/纸感融合/封面图策略（离线）' },
  { file: 'scripts/diag-palette-move.js', runner: 'electron', desc: 'R32 面板零重建导航+开合动效（离线）' },
  { file: 'scripts/diag-render-sig.js', runner: 'electron', desc: 'R33 渲染签名去重+新到高亮（离线）' },
  { file: 'scripts/diag-edition-cache.js', runner: 'electron', desc: 'R34 重排缓存/margin 折叠装箱/内容守恒/will-change（离线）' },
  { file: 'scripts/diag-tools-relocate.js', runner: 'electron', desc: 'R35 工具条迁位/零干涉/真点击命中（离线）' },
  { file: 'scripts/diag-dup-img.js', runner: 'electron', desc: 'R37 同址重复图折叠/figure 壳清理/文本守恒（离线）' },
  { file: 'scripts/diag-img-ratio.js', runner: 'electron', desc: 'R38 图片宽高占位/表情豁免/失败不塌（离线）' },
  { file: 'scripts/diag-r39-details.js', runner: 'electron', desc: 'R39 细节：时间/来源悬停全量+清除键命中区（离线）' },
  { file: 'scripts/diag-r40-details.js', runner: 'electron', desc: 'R40 细节：chips 换行/历史键盘导航/工具条 aria（离线）' },
  { file: 'scripts/diag-r41-details.js', runner: 'electron', desc: 'R41 细节：失败图点击重试/空态刷新/star 提示（离线）' },
  { file: 'scripts/diag-r42-details.js', runner: 'electron', desc: 'R42 细节：输入收起历史/外链提示/iframe 懒加载（离线）' },
  { file: 'scripts/diag-r43-details.js', runner: 'electron', desc: 'R43 细节三连：速查面板 dialog/历史 listbox/窄窗进度让位（离线）' },
  { file: 'scripts/diag-r44-details.js', runner: 'electron', desc: 'R44 细节三连：滑轨键盘翻页/刻度 title/装载呼吸点（离线）' },
  { file: 'scripts/diag-r45-details.js', runner: 'electron', desc: 'R45 细节三连：chips 卫生/清除键 aria/批量条 toolbar（离线）' },
  { file: 'scripts/diag-r46-details.js', runner: 'electron', desc: 'R46 细节三连：底部呼吸点/zoom-in 光标/分割条 hover（离线）' },
  { file: 'scripts/diag-d2-urlread.js', runner: 'electron', desc: 'R-D3 链接精读：URL 抓取渲染/合成 entry（离线）' },
  { file: 'scripts/diag-d5-cardfull.js', runner: 'electron', desc: 'R-D5 卡片弹窗全屏切换/还原（离线）' },
  { file: 'scripts/diag-r47-motion.js', runner: 'electron', desc: 'R47 微动效三连：三出场动画规则命中（离线）' },
  { file: 'scripts/diag-r48-details.js', runner: 'electron', desc: 'R48 收官：弹层出场/目录关闭/reduce-motion 覆盖（离线）' },
  { file: 'scripts/diag-kb-trendfit.js', runner: 'electron', desc: '知识中心趋势图适配：画布四缘落在卡片内容区（离线）' },
  { file: 'scripts/diag-cardx-variant.js', runner: 'electron', desc: '卡片配色变体/封面滤镜实效：自适应路径+模板覆盖（离线）' },
  { file: 'scripts/diag-cardx-ratiohard.js', runner: 'electron', desc: '卡片画幅硬合同：超长文四档画幅精确生效（离线）' },
  { file: 'scripts/diag-cardx-scenes.js', runner: 'electron', desc: '场景排版系统：六画幅专属版式+预设切换+IPC 精确（离线）' },
  { file: 'scripts/diag-r49-details.js', runner: 'electron', desc: 'R49 细节三连：cardx 滚动条/焦点环/悬停说明（离线）' },
  { file: 'scripts/diag-r50-details.js', runner: 'electron', desc: 'R50 细节三连：Esc 关弹层/关闭键焦点环/图 hover 提亮（离线）' },
  { file: 'scripts/diag-r51-details.js', runner: 'electron', desc: 'R51 细节三连：列表 hover 时间/星标回弹/书签色条（离线）' },
  { file: 'scripts/diag-r52-details.js', runner: 'electron', desc: 'R52 细节三连：设置导航可达性/图标染色/滚动条（离线）' },
  { file: 'scripts/diag-r53-details.js', runner: 'electron', desc: 'R53 收官：面板空态出路/最近徽标/滚动条（离线）' },
  { file: 'scripts/diag-auditfix-main.js', runner: 'electron', desc: '2026-10 审查修复·主进程：更新校验/缓存命中/取消链/VACUUM映射/写盘token（离线）' },
  { file: 'scripts/diag-auditfix-render.js', runner: 'electron', desc: '2026-10 审查修复·渲染层：监听器退订/灯箱/竞态/键盘单触发/搜索闭环（离线）' },
  { file: 'scripts/diag-auditfix-ui.js', runner: 'electron', desc: '2026-10 审查修复·视觉：进度条/缓动/暗色/accent-ink/衬线栈/透明阶梯（离线）' },
  { file: 'scripts/diag-r45-details.js', runner: 'electron', desc: 'R45 细节三连：chips 卫生/清除键 aria/批量条 toolbar（离线）' },
  { file: 'scripts/diag-r39-details.js', runner: 'electron', desc: 'R39 细节三连：时间/来源悬停全量+清除键命中区（离线）' },
  { file: 'scripts/diag-r40-details.js', runner: 'electron', desc: 'R40 细节三连：chips 换行/历史键盘导航/工具条 aria（离线）' },
  { file: 'scripts/diag-card-export.js', runner: 'electron', desc: '精读卡片导出：解析器+模板+离屏截图（离线）' },
  { file: 'scripts/diag-f1-fulltext.js', runner: 'electron', desc: 'F1 全文抓取：三态偏好/后台队列补抓入库/FTS/并发≤2/存量回补/徽标（离线）' },
  { file: 'scripts/diag-f2-rules.js', runner: 'electron', desc: 'F2 过滤规则：CRUD/灌文规则生效/作用域/操作符/正则安全/测试器/回放幂等/单事务/耗时回归（离线）' },
  { file: 'scripts/diag-f3-media.js', runner: 'electron', desc: 'F3 媒体中心：enclosure入库/媒体视图筛选/单实例/进度续播/倍速/队列连播/离线下载/TTS互斥/查询耗时（离线）' },
  { file: 'scripts/diag-f4-topics.js', runner: 'electron', desc: 'F4 话题盯梢：CRUD/三路聚合/AI精筛降级/滚动保留/频率/视图渲染/触点（离线）' },
  { file: 'scripts/diag-f5-platform.js', runner: 'electron', desc: 'F5 平台适配：v15迁移/B站与微博适配器(mock)/UID提取/添加UI三tab/试抓预览/刷新分派/媒体联动/去重/耗时回归（离线）' },
  { file: 'scripts/diag-f6-mail.js', runner: 'electron', desc: 'F6 邮件订阅：v16迁移/密码DPAPI不落库/IMAP客户端(mock IMAPS真TLS)/MIME解码/账户与白名单/刷新增量与幂等/正文消毒/断线恢复/并发≤2/耗时回归（离线）' },
  { file: 'scripts/diag-f7-sync.js', runner: 'electron', desc: 'F7 WebDAV 同步：客户端PROPFIND/GET/PUT/MKCOL/MOVE与错误分类/超时/快照roundtrip与8MB与5000护栏/合并幂等并集新者胜/双设备端到端假DAV/本地优先红线/自动同步节流/冲突不上传/凭据DPAPI/设置分区与命令面板/刷新不受影响（离线）' },
  { file: 'scripts/diag-f8-research.js', runner: 'electron', desc: 'F8 AI 研究：v17迁移与老库升级/gather本地FTS相关度与AIHOT注入与去重与上限/AIHOT失败降级/流式生成落库/引用编号约束提示词/取消草稿保留与再次覆盖/追问追加区段/历史重开删除/单飞锁/无Key降级/知识中心tab与命令面板与引用芯片UI（离线）' },
  { file: 'scripts/diag-f9-rag.js', runner: 'electron', desc: 'F9 全库 RAG：v18迁移与老库升级/gather四路(FTS文章+知识库+正文缓存命中段截窗+AIHOT)与去重与上限30/正文检索限集EXPLAIN与200篇10MB级耗时<300ms/ask流式落库与sources_json与引用编号约束prompt/多轮上下文同会话含首轮QA新会话隔离/无Key明确报错与纯检索不调LLM/单飞锁与取消保留已流/会话列表重开删除级联重命名/知识中心会话侧栏与消息气泡与引用芯片与素材浮层与取消按钮UI/旧kb:ask入口与tab切换清理订阅回归（离线）' },
  { file: 'scripts/diag-f10-picks.js', runner: 'electron', desc: 'F10 智能精选：标题分词画像(30天行为×词频 Top120)/评分排序(命中0.6+源打开率0.25+新鲜度0.15)与已读稍后读排除/新鲜度同分新者先/空画像降级纯新鲜度+提示态/不感兴趣24h排除注入时间过期/UI精选切换与画像摘要条Top8chips与行渲染与名次/播报文稿本地模板含TopN标题与TTS mock与媒体互斥/200篇<200ms/排除重启持久化/列表简报媒体回归（离线）' },
  { file: 'scripts/diag-f11-obsidian.js', runner: 'electron', desc: 'F11 Obsidian 导出：pickDirectory对话框mock与内存token授权(未授权拒绝/取消不变/重启实例失效)/文件树Articles+Highlights+_meta游标/文件名sanitize与id8/frontmatter字段与YAML冒号引号转义与tags并集/HTML转MD无残留标签/1MB截断/增量hash命中零写mtime不变/改1条仅重写该文件/用户文件永不删除/全量重导全重写/坏JSON游标容错自愈/3000高亮2000护栏/只导高亮范围开关/设置Obsidian分区渲染与预览统计（离线）' },
  { file: 'scripts/diag-f13-similar.js', runner: 'electron', desc: 'F13 相关文章+线索：similar 相关性/500 篇性能/reader 文末卡片/线索聚类/追踪话题（离线）' },
  { file: 'scripts/diag-f14-sort.js', runner: 'electron', desc: 'F14 智能排序+密度：画像排序/空画像降级/密度三档/四态透传/200ms（离线）' },
  { file: 'scripts/diag-f12-books.js', runner: 'electron', desc: 'F12 文集成书：v19迁移与幂等与老库无损/文集CRUD与右键加入文集菜单/60篇成书EPUB结构(mimetype/nav/3月分章/60篇/源icon封面与纯色回退)/1000篇5卷每卷200确定性/自动成书24h节流与有新文章才成与manual不自动/书架UI列表待取徽标按钮/打开目录showItemInFolder与待取清除/200篇<2s/feed_ids持久化独立连接回读/删除清理自动目录且用户pickSavePath书保留（离线）' },
  { file: 'scripts/diag-phase10-export.js', runner: 'node', desc: '导出工厂：EPUB 结构 + 对照版式/自定义CSS 链路（离线）' },
  { file: 'scripts/e2e-card-export.js', runner: 'electron', desc: '精读卡片导出 E2E：真 IPC 链路+预览弹窗（离线）' },
];
const ONLINE = [
  { file: 'scripts/selftest.js', runner: 'electron', desc: '核心自测套件（真实数据形状）' },
  { file: 'scripts/diag-phase6-node.js', runner: 'electron', desc: '主进程服务探针' },
  { file: 'scripts/diag-phase4-explore.js', runner: 'electron', desc: '探索后端（真实网络 20-60s）' },
  { file: 'scripts/diag-phase7-upstream.js', runner: 'electron', desc: '上游借鉴包端到端' },
  { file: 'scripts/diag-phase11-neural-tts.js', runner: 'electron', desc: '神经语音在线合成（真实网络）' },
];

const ci = process.argv.includes('--ci');
const suite = ci ? OFFLINE : OFFLINE.concat(ONLINE);
const results = [];

for (const probe of suite) {
  const runner = probe.runner === 'node' ? 'node' : 'npx';
  const args = probe.runner === 'node'
    ? [probe.file]
    : ['electron', probe.file];
  process.stdout.write(`\n===== ${probe.desc} (${probe.file}) =====\n`);
  const result = spawnSync(runner, args, {
    cwd: path.join(__dirname, '..'),
    // stderr 同步 inherit：失败时探针自身报错能直接出现在套件日志里（不再被丢弃）
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: probe.runner === 'node' ? 60000 : 300000,
    shell: process.platform === 'win32',
  });
  const ok = result.status === 0;
  results.push({ ...probe, ok, status: result.status });
  console.log(ok ? `>>> PASS ${probe.file}` : `>>> FAIL ${probe.file} (exit=${result.status})`);
}

console.log('\n===== SUMMARY =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file} — ${r.desc}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length}/${results.length} FAILED` : `\nALL ${results.length} PASSED`);
process.exit(failed.length ? 1 : 0);
