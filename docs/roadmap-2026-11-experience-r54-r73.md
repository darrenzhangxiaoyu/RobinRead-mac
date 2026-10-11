# 体验细节 20 轮路线图（R54-R73）· 顶级体验官 × Apple 设计师视角

> 2026-10-11 立项。延续 R39-R53 细节优化-series 的三连制：**每轮 3 个细节、每轮探针断言、每批（5 轮）独立开发 agent + 只读审查 agent**。视角纪律：克制（动效只做必要）、一致（同类元素同语言）、可发现（悬停/焦点/出路）、不打扰（提示安静、错误可重试）。全程遵守：OKLCH 令牌、heredoc 禁令、IPC 信封约定、reduced-motion 全豁免、探针门禁 solo 绿。

## 批 1（R54-R58）开卷 · 秩序 · 纪律

### R54 开卷体验三连
1. **简报缓存打开落顶**（真体验 bug）：`renderInto` 缓存命中分支不再 `scrollTop = scrollHeight`——缓存读取从报头开始读，仅流式生成分支保持跟随落底（app.js digest 渲染段）
2. **文章打开微入场**：阅读区内容 160ms 淡入 + scale 0.985→1（`--dur-fast`+`--ease-out` 令牌），列表→阅读的视线引导；reduced-motion 豁免
3. **续读提示降噪**：续读 toast 时长与层级行为 audit——不打断焦点、不叠满屏（与 R18 实现对齐，安静化）

### R55 浮层秩序三连
1. **Esc 逐层裁决**：全局浮层栈（右键菜单 → popover → 模态 → 仪式）同一处裁决 Esc，一次关一层，杜绝多层同关
2. **模态关闭焦点归还**：模态家族打开时记录 `document.activeElement`，关闭时 restore（统一 util + 各视图接线）
3. **胶囊开启仪式可 Esc**：仪式 = 轻遮罩浮层，Esc 等价「先收下」（f27 原设计不响应 Esc——补齐，花园/周刊已有）

### R56 按压与悬停纪律三连
1. **全按钮 active 态**：cap-btn / btn-text / footer-nav-btn / 设置行等缺按压反馈的补 `scale(0.97)` + `--dur-instant`
2. **悬停不位移**：小控件 hover 只变亮不位移（audit 现有 hover translateY 的按钮级元素，卡片 lift 家族保留）
3. **命令面板退场**：Enter 执行后 120ms 淡出 + 0.98 缩放，替代瞬消

### R57 数字纪律三连
1. **tabular-nums 全量**：列表 meta 时间、计数徽标、进度百分比、统计数字统一等宽数字
2. **相对时间自刷新**：列表可见时每 60s 静默刷新「N 分钟前」（不整页重绘，只改文本节点）
3. **时长口径**：阅读剩余「约 N 分钟」、播客进度 HH:MM:SS、列表时长「N 分钟」三分场景固定不混用

### R58 截断与光学三连
1. **标题截断统一**：列表行 2 行 clamp、杂志卡既定行数、周刊/花园标题 1 行——全库 line-clamp 口径表
2. **截断必有出路**：截断处 title 悬停全文 audit（行标题/来源名/话题名/书名）
3. **meta 行光学对齐**：来源名 · 时间戳分隔符、间距、基线统一（dot 用 `·` 全角口径 + `--space-1` 间距）

## 批 2（R59-R63）空态 · 负载 · 暗色

### R59 空态出路三连
1. 空态主按钮三态补齐（hover/active/focus-visible）
2. 空态插画-标题-文案垂直节奏令牌化（三拍 stagger 已有，间距归 `--space-*`）
3. 列表搜索无结果态补「清空搜索」出路（对齐 R53 命令面板先例）

### R60 加载语言三连
1. 骨架屏形状令牌统一（圆角/高度/shimmer 时长归档，audit 各屏）
2. 图片 shimmer 与失败占位形状对齐（R50 基础上统一几何）
3. 动作按钮 loading 态：生成/刷新类按钮 inline spinner + 禁用原因 title

### R61 反馈语义三连
1. toast 成功/失败图标与色语义统一（绿勾 / 暖红叹号，audit 全部 toast 调用点）
2. 破坏性确认框主按钮统一警示色（dialogs audit）
3. 收藏星 / 稍后读时钟状态点亮动效对称（pop 家族补齐）

### R62 暗色 parity 三连
1. 暗色 accent 链接/按钮对比度全量审计（≥4.5:1）
2. 暗色封面图亮度曲线统一（滤镜暗色档）
3. 暗色阴影三档可见性曲线（shadow 令牌暗色映射）

### R63 滚动细节三连
1. 浮层内滚动条全量主题化（media/garden/weekly/store 内滚 audit）
2. 列表顶/底 edge 淡出遮（暗示可滚）
3. 新文章到达不打断阅读位置（增量插入滚动锚定）

## 批 3（R64-R68）通知 · 表单 · 排版

### R64 toast 秩序三连
1. 堆叠上限 3 条 + 同类合并计数
2. 退场动画对称（滑出方向与入场镜像）
3. toast 内按钮键盘可达（Tab 焦点环）

### R65 设置与表单三连
1. 设置行点击热区 ≥40px + 整行 hover
2. 输入框 focus 环统一 2px accent（audit 搜索框/表单）
3. 开关/下拉改动即时保存的行内确认（0.5s 对勾淡出，不打 toast）

### R66 阅读排版三连
1. 标题断行平衡（`text-wrap: balance` 渐进增强：文章标题/刊头/弹窗标题）
2. 引用块与代码块纸面样式统一（blockquote 竖线+底色、code 字体令牌）
3. 段落 hover 零布局位移（audit 划词锚点/边注 hover）

### R67 图标语义三连
1. 收藏星 / 稍后读时钟 / 已读勾 全域同形审计
2. 图标 stroke 统一 1.75（icons.js 偏差归簇）
3. 纯图标按钮 title + aria-label 双补

### R68 窗口与布局三连
1. 极窄窗优雅降级（900px 以下侧栏自动折叠为图标态或提示条）
2. 分栏把手双击重置默认宽
3. 全屏进出保持焦点与滚动位置

## 批 4（R69-R73）手势 · 错误 · 收官

### R69 手势与滚动三连
1. 滚轮阅读器顶/底过滚动不冒泡（不误触列表切换）
2. 双击正文空白回顶
3. 列表↔杂志互切保持滚动位置

### R70 错误与重试三连
1. 网络类错误 toast 统一「原因 + 重试」按钮
2. 正文图片批量失败时的「全部重试」入口
3. AI 面板内 inline 重试（研读/摘要/翻译失败态）

### R71 文案与国际化三连
1. 标点全角审计二期（toast/空态/按钮）
2. 英文界面硬编码中文清零（I18N 键 audit）
3. 日期与数字本地化跟随界面语言

### R72 性能感知三连
1. 冷启动侧栏/列表骨架先行
2. 视图互切保留滚动位置（与 R69-3 合并验收）
3. 长文首次打开的分段渐进渲染平滑度（audit 分叶边界闪烁）

### R73 收官一致性三连
1. z-index 谱表文档化 + 探针固化（600/780/900/960/980）
2. 焦点环 / 选区色 / 滚动条三件套跟随 accent 终检
3. reduced-motion 全量断言（每个新动画都有豁免锚点，探针扫尾）

## 执行记录

（每轮完成后记：commit + 探针数 + 审查发现）

- **R54 开卷**（06c8328，diag-r54-openfeed.js 21 项全绿）：真 bug 修复——简报缓存命中 renderInto 无条件 `scrollTop=scrollHeight` 落底 → 仅流式生成分支跟随落底，非流式（缓存/终稿）重绘保位（缓存首帧 prevTop=0 即报头）；文章微入场 nj-article-enter（淡入+scale 0.985，--dur-fast+--ease-out 令牌，翻页动效在场时让位不叠两场）；续读提示降噪 audit = 延迟窗口内已先行翻页不再补过时提示（er-notice 本就 pointer-events:none/z85/单实例计时器，audit 锚点固化）。复跑 f36/f20 绿。
- **R55 浮层秩序**（eb599a7，diag-r55-escorder.js 19 项全绿）：新增 views/overlay-stack.js 浮层栈（registerEscapeLayer 入栈 / isTopEscapeLayer 顶层先关 / captureFocusReturn 焦点归还），15 个浮层家族挂账（右键菜单/设置/知识中心/周刊/花园/媒体/课程/重访/存档馆/热点/命令面板/主题设计器/订阅源管理/专注面板/自进化）；裁决模型 = 各浮层保留自身 Esc 监听、关窗前问 isTop + 消费即 preventDefault（polite 约定全库统一），右键菜单补 Esc 关闭（capture 独占，此前不响应 Esc 会关到底下浮层）；胶囊开启仪式 Esc=先收下（onEsc→close 同通路）；设置/知识中心/周刊/媒体四模态焦点归还（dismiss 先 remove 再 restore，焦点已回落 body 才归还）。复跑 f23/f27/f29/f20 绿。
- **R56 按压纪律**（c036c3d，diag-r56-press.js 19 项全绿）：U12 按压家族补 footer-nav-btn / dg-mode-seg button / nj-garden-tab（roadmap 写 scale(0.97)，归簇进既有 --press-scale=0.96 令牌，零新量纲）；悬停去位移四处按钮级小控件（批注图标/传统色 chip/笔记锚点/语音浮球——提亮或微放大替代 translateY），卡片 lift 家族（prov/td/kb/mag）保留；命令面板执行（Enter/点选）退场 120ms 淡出+0.98 缩放（--dur-instant，与 cmd-in 入场镜像，leave 计时器防退场途中重开误删），Esc/点外部保持即时收。复跑 edition-palette/palette-groups/palette-move 绿。审查发现：设置行非按钮级容器（行内开关/下拉已有按压态），整行 scale 反而失真——按压补齐落在真实按钮家族。
- **R57 数字纪律**（1f81121，diag-r57-numeric.js 16 项全绿）：tabular-nums 全量——程序化审计（类名时间/计数暗示 × 规则块扫描）后 38 个缺口类入组（播放器时间/媒体时长/阅读剩余/批处理计数/各视图统计数字），15 关键样本复扫零缺口；相对时间静默刷新 refreshEntryTimes（60s 心跳挂 rowsHost、data-ts 定位、只改文本节点不重绘、幂等、formatTime 可注入时钟）；时长口径 audit 三场景各归各位固化锚点（阅读「约 N 分钟」/播客进度 H:MM:SS/列表时长「N 分钟」，文字稿时间戳与播放器同族）。复跑 u1-u5 绿。
- **R58 截断与光学**（91cb262，diag-r58-truncate.js 18 项全绿）：line-clamp 口径表冻结 11 处逐一断言（列表行 2/无摘要 4/摘要 2/杂志卡 3/aihot 3/批注 3+2/话题 2/胶囊引文 2×2/订阅卡 2）+ 周刊条目 1 行 nowrap；截断必有出路七处补 title 悬停全文（列表行标题/杂志卡标题/杂志卡来源/聚簇行标题/话题命中标题/收藏集名/周刊条目——周刊由泛提示「打开这篇文章」升级为全文）；meta 行光学——entry-meta 裸 6px 间距退役归 --space-1，字符串点分隔 meta（话题/文字稿/书架/胶囊）统一「 · 」全角口径锚点固化。复跑 f29/r39/r51/u26-30 绿。
- **R59 空态出路**（a8e16f3，diag-r59-emptyout.js 29 项全绿）：空态 CTA 三态 audit 发现 hover/active/focus-visible 已被 R41+U12+R9 齐备（换题记档①）→ 收口为归簇——list-empty-refresh 裸 0.96 按压退役归 U12 --press-scale 家族、focus 环归 U18 --focus-w/--focus-off 量纲、过渡补 transform 路径；垂直节奏令牌化——空态壳 gap 8px/10px、padding 30px、CTA 6px 18px/14px 裸值全退役归 --space-2/--space-8/--space-6/--space-2/--space-5/--space-4（计算样式实证 8/32/8/16px），与 U31 stagger 四拍对齐；搜索无结果出路——列表空态补 kind:'search' 分支（镜中山野插画 + 「没有匹配的文章」+「清空搜索」按钮入 list-empty-refresh 家族），点击清输入/has-value/onSearch('')/焦点归还搜索框，i18n 四键补录（含 R53 面板漏键「清空搜索，显示全部命令」）。复跑 u31-35 绿（89/89）。
- **R60 加载语言**（bb4e6c0，diag-r60-loading.js 23 项全绿）：--dur-shimmer=1.4s 单一事实源（列表骨架/杂志封面/正文图三屏 1.4s/1.5s 混拍归簇，裸秒退役）；骨架形状归档——aihot 圆点 50%→--radius-full（顺带修掉 U11 组规则长期覆盖圆点半径的级联伤：组规则只管线条）、骨架条 5px→--radius-sm、列表骨架行 10/13/16/7px 归 --space-3/--space-3 --space-4/--space-2（计算样式实证）；图片几何统一——失败占位图 radius-md→radius-lg 与基础正文图同档（loading→failed→loaded 三态零跳变）；动作按钮 loading 态——.btn-text.spinning 家族（与 .btn.spinning 同 13px 双环同拍，标签 color:transparent 隐去兼容纯文本按钮）+ 周刊生成/媒体 AI 摘要接线（生成中 spinner+disabled+禁用原因 title）。复跑 r41 绿。
- **R61 反馈语义**（76cafad，diag-r61-feedback.js 25 项全绿）：toast 三态语义冻结——失败图标叉形→暖红叹号、失败色与 warn 同族的 warm-accent 混色退役归 --danger 语义令牌（成功绿勾/警告暖赭三角保持），双兼容包装（app/dialogs）支持 { tone } 选项对象；全库失败路径 audit——失败关键词 toast 裸调用清零（tone:'error' 45 处落地：操作/复制/刷新/打包/导入导出/转写下载/聚合/语音指令等 error，前置条件「先打开一篇文章/未配置 Key/需要会员」等 warn），修复中途发现的真坏味道：话题删除 confirmBox 用幽灵键 confirmLabel（不被读取，按钮实为「确定」无警示）→ okLabel+danger；破坏性确认警示色——.modal-footer .btn-text.danger 升级警示填充（danger 14% 底+52% 边，仅确认框脚部不影响他处文字链），停止追更/重新生成令牌补 danger:true，删除类确认 danger 覆盖 11/11；pop 对称——later-pop 关键帧与 star-pop 逐字一致（0.4→1.3→1 同节奏 --dur-mid），稍后读时钟点亮与收藏星同拍。复跑 r51/u31-35/r39 绿。
- **R62 暗色 parity**（24cf738，diag-r62-darkparity.js 32 项全绿）：accent 对比度全量审计=探针实算 WCAG（sRGB→相对亮度）——暗色 accent/warm-accent/danger vs 全部 7 档暗纸面（page/list/sidebar/note+surface-1/2/3 按 color-mix 声明百分比实算）全部 ≥4.5:1（最紧 danger@note=4.91），accent-ink vs accent 底 5.53:1，真实 UI 断言暗色 accent 令牌落地（链接/CTA 消费面）；封面亮度曲线——--cover-filter 单一事实源（亮色 none/暗色 brightness(.86) saturate(.92)），杂志卡/周刊刊头/媒体缩略图三家族消费（暗色 UI 实证滤镜生效、亮色零滤镜、无家族私有暗色滤镜残留）；阴影三档=U6-② 映射固化（换题记档②）——亮暗双档在册+暗档不透明度单调递增（0.32<0.42<0.52）+33 处消费令牌+弹层/模态暗色覆盖 UI 实证。复跑 u1-u5 绿。
- **R63 滚动细节**（546563c，diag-r63-scroll.js 30 项全绿）：浮层内滚动条全量主题化——media/garden/weekly/挑战/订阅源网格五内滚容器入 5px 悬停主题色家族（默认隐藏/容器悬停浮现 accent 24% 细条/scrollbar-width thin/--dur-mid 过渡，与 modal-scroll/cmd-palette-list/cardx 同语言）；列表顶/底 edge 淡出遮——sticky 双条零布局占位（负 margin 抵消，顶遮贴 inset 46px 下缘），渐变自 --article-list-background 派生暗色自动跟随，滚出顶部/未到底浮现、在位即隐（nj-can-scroll-* 类随滚动/重绘 rAF 同步）；新文章到达滚动锚定——重绘前记 scrollTop/scrollHeight 基线，行插入后按高度差回补（增量载荷顶部插入不再顶走阅读位置；常规/杂志/事件路径即时回补、渐进渲染路径完成后回补保证高度有代表性；在顶部不介入=新文章自然到顶），探针实证同一行视口位移 0.3px、顶部对照 scrollTop 恒 0。复跑 f2-rules/list-nav/render-sig 绿；u26-30 的 U28「拖入收藏批量加入」1 项失败经 git stash 实锤为 HEAD（R62）上即预存（本批五项改动不在因果链，见执行记录外说明）。

## 换题记档

（实现中发现不成立/已存在的细节，记档换题，不硬凑）

- **R57-2 列表「N 分钟前」60s 刷新**：主列表时间实为 HH:MM（当日）/日期桶口径，并无「N 分钟前」相对文案（相对时间仅存在于热点/知识/设置等视图，且各有热刷新）——换等价题「跨日时间桶翻转静默刷新」（refreshEntryTimes，60s 心跳 + 只改文本节点，机制与意图不变：可见时间恒新鲜、不整页重绘）。
- **R59-1 空态主按钮三态**：audit 发现三态已齐——.list-empty-refresh 自 R41 起有 hover/active/focus-visible、.btn-text 家族 active 归 U12 按压家族、focus-visible 由 R9 全局 button:focus-visible 铺底——换等价题「三态归簇收口」：裸 0.96 按压退役归 --press-scale、focus 环归 --focus-w/--focus-off 量纲、过渡补 transform 路径，并把新增「清空搜索」出路按钮入组同语言（探针逐态断言+计算样式实证）。
- **R62-3 暗色阴影三档映射**：--shadow-1/2/3 暗色覆盖 U6-② 已落地（纯黑重墨三档+表面三档派生），映射本体无需重造——换等价题「三档可见性曲线探针固化」：亮暗双档在册断言+暗档不透明度单调递增（靠更深不靠更浓）+33 处消费点走令牌+弹层/模态暗色覆盖真实 UI 实证。
