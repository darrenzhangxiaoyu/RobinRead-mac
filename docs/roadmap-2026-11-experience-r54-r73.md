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
- **R64 toast 秩序**（a72dbaa，diag-r64-toastorder.js 29 项全绿）：堆叠上限 3 条（U13 契约 4→3，diag-u11-u15 断言随迁）+ 同类合并计数——同文案+同 tone 的在场条不重复堆叠，「×N」徽标内联升级（等宽数字+bump 弹一拍 --dur-fast/--ease-spring）并重置计时，合并先于容量护栏裁决；进度条豁免淘汰合同保留（长任务不被挤掉）；退场动画对称——.leaving 下沉 12px 与入场 toast-in 上浮 12px 镜像（原 8px 半程退役，reduced-motion 全局块兜底）；toast 动作按钮键盘可达——wireFocusHold（focus 暂停自动消退挂 hold / blur 按剩余续走，与 hover 暂停同语言）+ .toast-action:focus-visible 2px accent 环（R9/U18 量纲）；修复搁浅锚：diag-u11-15 的 app 委托断言还停在 R61 前的 `{duration, action}` 口径（R61 加 tone 后未复跑该探针），随本轮修正。复跑 u11-15/u31-35/r39/r51/r61 绿。
- **R65 设置与表单**（eff3bc8，diag-r65-forms.js 25 项全绿）：原题①「设置行热区≥40px+整行 hover」audit 已成立（.setting-row min-height 44px+:hover 底色在册）→ 换等价题「开关命中区+表格行 hover」：.toggle 视觉 22px 高经 ::before inset -9px/-6px 撑出 ≥40px 命中带（零视觉变化）、U37 .nj-settings-table-row 补与设置行同公式（55% row-hover）的悬停底色（无 scale，批 1 审查纪律）；原题②「输入 focus 环统一」audit 已成立（U18 档一 input/textarea/select :focus-visible 光环+.control 边色 accent 家族全库在册）→ 换等价题「字段级错误态」：.control.invalid 红边（--danger）+ API/口袋双端口输入落库被拒标红并 title 悬停原因、成功即摘；行内确认——flashRowCheck 工厂（设置行上下文守卫，0.5s 在位+--dur-mid 淡出，reduced-motion 全局块兜底）接进 toggleControl/selectControl 改动保存链，样板=自动备份保留份数 select（原「已开启/已关闭自动备份」toast 退役）。复跑 f36/f31/f39/phase12/phase13 绿。
- **R66 阅读排版**（56e4330，diag-r66-typo.js 21 项全绿）：断行平衡扩面——.robin-header-title 基类（主窗/独立阅读窗全实例）+ 弹窗标题三家族（modal-header/brief/media h3）+ 原文弹窗标题 + 周刊刊名 text-wrap: balance（渐进增强；reader-article 既有档为对照锚）；等宽单一事实源——--font-mono 令牌入 :root，'Cascadia Code'/Consolas/ui-monospace 四种散栈 20 处消费全量归簇（正文 code/pre/期刊纸面/hex 徽标/令牌与脚本源），pre 基类补 font-family（此前裸文本依赖内部 code 才落等宽栈）；引用块纸面统一——三卫星家族（研读简报 rendered/原文 aihot/研读面板）归 U5-③ 正典语言（accent 实条+4% 微染底+右圆角令牌），研读面板裸 8px 圆角退役；hover 零布局位移固化——程序化扫描 robin.css 全部 :hover 规则（剥注释、伪元素装饰层豁免）九类布局属性零出现。复跑 edition-typography/phase9-typography/r54/edition-micro/r59 绿。
- **R67 图标语义**（0a836b7，diag-r67-icons.js 26 项全绿）：已读勾全域同形——收敛建立「已读动作=checkAll 勾 / 未读动作=envelopeOpen 开信封」二元（原阅读胶囊 envelopeClosed、全标已读 envelopeOpen、行内快捷 checkAll 三形并存），btn-mark-all/cap-read 随二元换形，envelopeClosed 退役至状态语义（命令面板未读筛选/邮件账户）；收藏星 star/starFilled 同形双态（动作描边/状态填充）与 clock 单形多点复用审计固化，icons.js 头注文档化字形约定；stroke 归簇——全量扫描 77 枚图标 stroke-width ∈ {1.75, 1.1 窗口控制光学档}，keyboard/server 冗余 per-path stroke-width 退役；纯图标按钮 title+aria-label 双补——工具栏 set()/updateMaximizeGlyph/胶囊动态三键（star/zen/read）、行内快捷 mk()/精选移出、独立阅读窗 setBtn、AI 热点卡片 8 处接线，胶囊四键补静态兜底名（未选中文章前不再无名），真实渲染断言工具栏三家族 21 枚双补零缺。复跑 r51/row-quick/r45/f17/aihot-empty 绿。
- **R68 窗口与布局**（d993a43，diag-r68-window.js 27 项全绿）：原题①「<900px 极窄窗侧栏降级」不成立（主窗 minWidth 980 + U26 @media 1020px 三列视口钳制 + 侧栏手动折叠三重护栏）→ 换等价题「独立阅读窗 480px 下限极窄场景固化」：minWidth/标题省略号/阅读列 min-width:0/版心 min(40px,5vw) 证据链固化；分栏把手双击重置——dblclick 清行内样式+--sidebar/--list-width 归出厂 240/340（SIDEBAR_DEFAULT_WIDTH/LIST_DEFAULT_WIDTH 常量单一口径）+commitColumnWidths 与拖拽共用持久化收口，把手 title「拖拽调整栏宽，双击恢复默认」（原空串 title 退役）可发现性补齐；禅模式进出焦点与滚动守卫——进入前快照 activeElement，焦点随侧栏/列表 display:none 蒸发则落到 #reader，退出归还原位（快照归还消费后才清账），reader-scroll scrollTop 进出零位移探针实证。探针工程注记：隐藏窗 rAF 停摆（探针实证 probeRaf=false）——禅守卫断言窗改 showInactive 产帧；diag-u36-40 read() 归一 CRLF（68b172c 同款）修 U40 七视图锚点行尾敏感（本仓 robin.css 现 EOL 全 CRLF）。复跑 r46/u36-40（53/0）/u26-30 绿（U28 拖入收藏 1 项为 R62 起预存，stash 实锤不在因果链）。
- **R69 手势与滚动**（b078cba，diag-r69-gesture.js 26 项全绿）：滚轮过滚动不冒泡——.reader-scroll overscroll-behavior: contain（contain 而非 none：保留端点 overscroll 提示只断祖先链；主窗/独立阅读窗同基类），audit 锚点固化翻页视图滚轮自管（er-stage passive:false 翻页/字号步进、灯箱开启不翻页、正文灯箱缩放独立）；双击正文空白回顶——scrollEl dblclick 守卫链（触发面收敛滚动容器/正文容器/文章容器/报头容器四空白面，closest 让位段落图片链接按钮批注锚等一切交互面，有选区不动作、空态不响应，reduced-motion 降级 instant），与划词双击选词/灯箱双击缩放天然互斥；列表↔杂志互切保持滚动位置——setViewMode 形态真变化时布防（记录 scrollTop+代际快照，同值重复调用不布防），四条渲染分支统一收口 restoreFor()（常规=R63 高度差回补、互切=_restoreSwitchTop 同值钳位），恢复走 R63 同一代际守卫通道（布防与恢复间外部干预 scrollTop()/resetScroll 即让位），app.js 切换通路 resetScroll:false 不再回落顶。批 4 工程注记：切换锚代际必须在布防时捕获（render 时再取则测不到布防后干预，探针红一轮修正）；diag-r63-scroll 两静态锚随 restoreFor 收口随迁（R64 搁浅锚先例）。复跑 r63/r54/edition-lightbox 绿。
- **R70 错误与重试**（e69b76d，diag-r70-retry.js 33 项全绿）：网络失败 toast 带「重试」——R64 动作按钮合同（保底 ≥4.2s/wireFocusHold 焦点暂停）接线三处高频点：单源刷新失败 refreshThisFeed 闭包自回调可连击、链接精读失败数据/异常双分支闭包重发同一 URL、原文抓取失败闭包重跑 openOriginal；正文图片批量失败「全部重试」——≥2 张失败浮现批量条（计数 tf %lld + tabular-nums），R41 单图点击重试收口 _retryImage 单图/批量同通道（清计数/入加载态/摘失败态/换缓存戳），恢复一张计数降档、剩 <2 整条退役，批量条挂 article 容器 body 之前（不污染 _articleText/TTS 文本面），计数口径只数失败态图（重试在途不算、重试期间不谎报张数）；AI 面板 inline 重试——摘要卡失败态「重试」钮走建卡时绑定的 data-action=regenerate 委托（强制重发 generateSummary(true)），研读面板失败态错误行内「重试」钮与 openStudy 同通路（头部刷新钮纯图标小控件不承担失败出路），摘要错误文案内联裸 hex #c93b3b 退役归 --danger 语义令牌。复跑 r64/r41 绿。
- **R71 文案与国际化**（41ddfce，diag-r71-i18n.js 21 项全绿）：句读全角二期（换题记档③）——程序化扫描渲染层 t()/tf() 字面量 CJK 邻接半角句读=0，唯一残留为 3 处冻结白名单（屏蔽词/加权词/标签输入 placeholder 的「例如：OpenAI, 芯片, Rust」类格式示例——半角逗号即应用 join(', ') 解析口径，改全角会教错输入格式）+2 处文件扩展名点（.robin/.ruser 技术 token 非句读）；英文界面硬编码中文清零——渲染层 t()/tf() 实参与 I18NStrings 键表差集 160 键全量补录 en 译文（键表 2787 键），差集=0 探针固化 + 12 键 en 抽样断言；日期/数字本地化跟随界面语言——i18n.uiLocale() 单点（界面语言→BCP47），dialogs 五处 OS-locale 依赖（toLocaleTimeString([], ...) ×1 / toLocaleString([], ...) ×3 / 裸 toLocaleDateString() ×1）+ 话题命中 Intl.DateTimeFormat(undefined) + AI 热点导出时间戳全部改道，configure({lang}) 翻转 uiLocale/t()/Intl 格式运行时实证，数字审计锚（计数走 %lld 占位、tf 直替无 locale 分组——当前量纲无千分位面）。复跑 r59/u11-15 绿。
- **R72 性能感知**（ac276c8，diag-r72-perceive.js 18 项全绿）：冷启动侧栏/列表骨架先行——index.html 直出静态骨架（侧栏 5 行+列表 6 行，U11 .nj-sk-row 同族同几何=真实首帧零跳变），绝对定位覆盖层（两滚动容器皆 relative；列表 inset 46px 让出 sticky 头、侧栏 34px 让出上 padding，DOM 顺序无关 sticky 在上层），bootstrap 首次 reloadAll 后摘除、失败路径 .catch 同摘（不挂死白板），端到端探针实证摘除生效+几何同族（padding 12/16 gap 12=--space-3/--space-4/--space-3、线条 11px/--radius-sm=R60 口径）；长文分叶渐进渲染平滑——本叶新行即时入渐显观察（_observeReveal(scope) 复用同一 observer 不掐断既有观察，边界行淡入而非瞬现），edge 淡出遮随叶同步（首叶落地即可滚暗示即现，非完成才亮），reveal-pending 高度预留合同固化（no-preference 档内只动 opacity/transform 零布局属性=行保持全高边界零跳动）；视图互切滚动保持与 R69-③ 合并验收（切换保位复验）。探针工程注记：diag-r63-scroll 渐进完成等待改轮询（_renderingPages 轮询+滚动类翻转轮询）——固定 sleep(500/700) 对隐藏窗 rAF 叶距（≈250-600ms/叶）敏感，R72 逐叶同步后旧预算失准（stash 实锤因果链：原代码同跑绿）；探针 host 须 fixed 定位进视口——流式追加在真实 app body 末尾落在视口下方页外，IntersectionObserver 永不相交（渐显永不派发的假阴性）。复跑 r63/render-sig/f2-rules/r69/u1-u5 绿。
- **R73 收官一致性**（aa6d231，diag-r73-consistency.js 20 项全绿）：z-index 谱表文档化——robin.css 头注冻结三段谱系（局部层叠 0-120 组件内元素/工具栏/阅读区浮动小件/窗口暗示层/期刊面板件；全局浮层底座 240-1200 自测验→复习→批量条→搜索历史→引导 780→模态 800→播放器→期刊 900→命令面板 920→期刊划词 950→状态条 980→灯箱 999→toast 1000→右键菜单 1200；划词批注强占位 45/46/47 上限三档），探针固化三样式表全量 z-index 值域 ⊆ 谱表 40 档零越界 + 九点层序链单调实测（菜单>toast>灯箱>命令面板>期刊>模态>引导>搜索历史>批量条）+ 渲染层 JS 零 zIndex 直写；三件套 accent 终检——::selection 两处硬编码缺省 rgba(116,137,100) 退役归 color-mix(in srgb, var(--accent))（主题设计器换色选区同步，CSSOM 实扫 3 条+换色跟随实证），纸感期刊 .er-overlay ::selection rgba(97,115,87,0.34) 冻结为例外（--erp 纸面系统独立 accent 档，R17 记档口径），:focus-visible outline 全量 accent 零离群（--focus-ring 光环族 accent 派生在册），滚动条 thumb accent 家族（正文/列表 hover、浮层内滚 5px accent 24%）；reduced-motion 全量断言——全局收敛块四声明锚（animation-duration/iteration-count/transition-duration/scroll-behavior 全压制）+ @keyframes 52 帧定义与 51 处 animation 引用闭包零悬空（剥注释防 "animation: none" 字样误报）+ reveal 渐显 CSS no-preference 档与观察器 JS 双门 + 双击回顶滚动 reduced 降级 + 本批新件（批量重试条/inline 重试钮）纯 transition 零 keyframes（自动被全局块覆盖）。复跑 r56/u1-u5 绿。

## 换题记档

（实现中发现不成立/已存在的细节，记档换题，不硬凑）

- **R57-2 列表「N 分钟前」60s 刷新**：主列表时间实为 HH:MM（当日）/日期桶口径，并无「N 分钟前」相对文案（相对时间仅存在于热点/知识/设置等视图，且各有热刷新）——换等价题「跨日时间桶翻转静默刷新」（refreshEntryTimes，60s 心跳 + 只改文本节点，机制与意图不变：可见时间恒新鲜、不整页重绘）。
- **R59-1 空态主按钮三态**：audit 发现三态已齐——.list-empty-refresh 自 R41 起有 hover/active/focus-visible、.btn-text 家族 active 归 U12 按压家族、focus-visible 由 R9 全局 button:focus-visible 铺底——换等价题「三态归簇收口」：裸 0.96 按压退役归 --press-scale、focus 环归 --focus-w/--focus-off 量纲、过渡补 transform 路径，并把新增「清空搜索」出路按钮入组同语言（探针逐态断言+计算样式实证）。
- **R62-3 暗色阴影三档映射**：--shadow-1/2/3 暗色覆盖 U6-② 已落地（纯黑重墨三档+表面三档派生），映射本体无需重造——换等价题「三档可见性曲线探针固化」：亮暗双档在册断言+暗档不透明度单调递增（靠更深不靠更浓）+33 处消费点走令牌+弹层/模态暗色覆盖真实 UI 实证。
- **R65-1 设置行点击热区 ≥40px + 整行 hover**：audit 发现 .setting-row 早已 min-height 44px + :hover 底色（55% row-hover）在册——换等价题「开关命中区扩展 + 表格行 hover 同语言」：.toggle 视觉 22px 高经透明 ::before 把可点带撑到 ≥40px 高（零视觉变化），U37 设置表格行（含启停开关等交互控件）补与设置行同公式的悬停底色（不给行加 scale，批 1 审查纪律）。
- **R65-2 输入框 focus 环统一**：audit 发现 U18 三档焦点环家族已建立——input/textarea/select :focus-visible 走 --focus-ring 光环叠加 .control 系 border-color accent，搜索框家族 ：focus-within 变色，全库表单字段均在家族内——换等价题「字段级错误态补位」：.control.invalid 红边（--danger 语义令牌）+ 双端口输入落库被拒标红并 title 悬停原因、成功即摘（对勾管成功确认、.invalid 管失败反馈，表单反馈两端闭环）。
- **R68-1 极窄窗优雅降级（<900px 侧栏）**：不成立——主窗 minWidth 980（ipc.js）使 <900px 主窗视口不可达，980-1020 窄带由 U26 @media 视口钳制家族覆盖（min(240px,24vw) 等三列），侧栏另有手动折叠+工具栏按钮迁移；真实存在的极窄场景是独立阅读窗（下限 480px），其标题省略号/阅读列 min-width:0/版心 min(40px,5vw) 均已成立——换等价题「极窄窗护栏证据链探针固化」，顺带把分栏把手（原空串 title）补上可发现性提示。
- **R71-1 标点全角审计二期（toast/空态/按钮半角逗号句号清零）**：audit 发现句读级半角标点已清零（t()/tf() 字面量程序化扫描 CJK 邻接半角逗号句号问叹分冒=0）——唯一残留两类均属合法字面量：①3 处输入格式示例（「逗号分隔，例如：OpenAI, 芯片, Rust」类，placeholder 教的就是应用 join(', ') 解析口径的半角逗号，改全角会教错格式）②2 处文件扩展名点（.robin/.ruser，技术 token 非句读）——换等价题「句读口径探针固化」：白名单冻结 + 白名单外残留恒零断言，防新文案回流半角句读。
