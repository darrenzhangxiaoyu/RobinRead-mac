'use strict';
/**
 * RobinRead Windows — Preload 桥
 *
 * 以白名单形式向渲染进程暴露类型化 API（contextIsolation 开启）。
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/** 解包 {ok, data} → 直接返回 data（失败时返回 undefined）。用于 kb/evo 等「数据即返回值」的方法。 */
const data = (channel, ...args) => invoke(channel, ...args).then((r) => (r && r.ok ? r.data : undefined));

contextBridge.exposeInMainWorld('robin', {
  // 状态
  getState: () => invoke('app:state'),
  getSidebar: () => invoke('app:sidebar'),
  getSyncStates: () => invoke('app:syncStates'),
  getList: (scope, options) => invoke('app:list', scope, options),
  getReader: (entryID) => invoke('app:reader', entryID),
  getEntry: (entryID) => invoke('app:entry', entryID),
  getAdjacent: (scope, entryID, direction) => invoke('app:adjacent', scope, entryID, direction),

  // Feeds / 文件夹
  addFeed: (url, folder) => invoke('feeds:add', url, folder),
  // 中文平台适配器（F5）：B 站/微博 试抓预览 + 平台源添加
  platformPreview: (payload) => invoke('platforms:preview', payload),
  addPlatformFeed: (payload) => invoke('feeds:addPlatform', payload),
  deleteFeeds: (ids) => invoke('feeds:delete', ids),
  setFeedFolder: (ids, folder) => invoke('feeds:setFolder', ids, folder),
  reorderFeeds: (orderedIDs) => invoke('feeds:reorder', orderedIDs),
  addFolder: (name) => invoke('folders:add', name),
  renameFolder: (folderID, name) => invoke('folders:rename', folderID, name),
  deleteFolder: (folderID) => invoke('folders:delete', folderID),

  // OPML
  importOPML: () => invoke('opml:import'),
  exportOPML: () => invoke('opml:export'),

  // 刷新
  refresh: () => invoke('refresh:run'),
  refreshFeed: (feedID) => invoke('refresh:feed', feedID),
  search: (query, options) => invoke('app:search', query, options),
  smartFolderSearch: (query, limit) => invoke('app:smartFolderSearch', query, limit),
  generateDigest: (mode) => invoke('ai:digest', mode),
  cachedDigest: (mode) => invoke('ai:digestCache', mode),
  clusterBrief: (items) => invoke('ai:clusterBrief', items),
  exportEpub: (entryID) => data('app:exportEpub', entryID),
  exportEditionEpub: (entryIDs) => data('app:exportEditionEpub', entryIDs),
  exportHtml: (entryID) => data('app:exportHtml', entryID),
  ttsNeuralVoices: () => data('tts:neuralVoices'),
  ttsGetConfig: () => data('tts:getConfig'),
  ttsSetConfig: (patch) => data('tts:setConfig', patch),
  ttsSynthesize: (payload) => data('tts:synthesize', payload),
  readerCustomCSS: () => data('prefs:readerCustomCSS'),
  setFeedTypography: (feedID, patch) => data('prefs:setFeedTypography', { feedID, patch }),

  // 阅读状态
  markRead: (entryID, read) => invoke('read:mark', entryID, read),
  toggleStar: (entryID) => invoke('read:toggleStar', entryID),
  toggleLater: (entryID, later) => invoke('read:toggleLater', entryID, later),
  markAllRead: (scope) => invoke('read:markAll', scope),
  markMany: (entryIDs, read) => invoke('read:markMany', entryIDs, read),
  starMany: (entryIDs, starred) => invoke('read:starMany', entryIDs, starred),
  laterMany: (entryIDs, later) => invoke('read:laterMany', entryIDs, later),

  // 正文提取
  extractArticle: (entryID) => invoke('extract:run', entryID),
  extractUrl: (url) => invoke('extract:url', url),

  // 存储治理
  getMaintenance: () => invoke('maintenance:get'),
  setRetentionDays: (days) => invoke('maintenance:set', days),
  cleanupNow: () => invoke('maintenance:cleanup'),

  // 每源翻译模式 + 单篇自动翻译记忆
  setTranslateFeedMode: (feedID, mode) => invoke('translate:setFeedMode', feedID, mode),
  skipArticleTranslate: (entryID) => invoke('translate:skipArticle', entryID),

  // 每源全文抓取三态（F1：off/on/newOnly）+ 每源补抓统计
  setFulltextFeedMode: (feedID, mode) => invoke('fulltext:setFeedMode', feedID, mode),
  fulltextStats: () => data('fulltext:stats'),

  // 规则过滤引擎（F2：CRUD / 顺序 / 测试器 / 回放 / 最近样本）
  rulesList: () => data('rules:list'),
  rulesSave: (payload) => invoke('rules:save', payload),
  rulesDelete: (id) => invoke('rules:delete', id),
  rulesSetEnabled: (id, enabled) => invoke('rules:setEnabled', id, enabled),
  rulesMove: (id, direction) => invoke('rules:move', id, direction),
  rulesTest: (payload, sample) => data('rules:test', payload, sample),
  rulesReplay: (opts) => data('rules:replay', opts),
  rulesSamples: (limit) => data('rules:samples', limit),

  // 媒体中心（F3：视图 / 进度 / 队列 / 下载；onMediaDownloadProgress 收下载进度推送）
  mediaList: (filter, opts) => data('media:list', filter, opts),
  mediaCounts: () => data('media:counts'),
  mediaSource: (entryID) => data('media:source', entryID),
  mediaProgress: (entryID, positionSeconds, finished) => data('media:progress', entryID, positionSeconds, finished === true),
  mediaQueueList: () => data('media:queue:list'),
  mediaQueueAdd: (entryID) => data('media:queue:add', entryID),
  mediaQueueRemove: (entryID) => data('media:queue:remove', entryID),
  mediaQueueClear: () => data('media:queue:clear'),
  mediaQueueNext: (afterID) => data('media:queue:next', afterID),
  mediaDownload: (entryID) => data('media:download', entryID),
  mediaDownloadDelete: (entryID) => data('media:download:delete', entryID),
  onMediaDownloadProgress: (listener) => subscribe('media:download-progress', listener),

  // 事件聚类去重（F21：事件模式按簇分组的事件卡摘要）
  eventSummaries: (ids) => data('events:summaries', ids),

  // 播客转文字稿（F22：发起/读回/端点配置/AI 摘要；onTranscribeProgress 收转写进度推送）
  transcribeMedia: (itemID) => data('media:transcribe', itemID),
  mediaTranscript: (itemID) => data('media:transcript', itemID),
  transcribeGetConfig: () => data('media:transcribeConfig:get'),
  transcribeSetConfig: (patch) => data('media:transcribeConfig:set', patch),
  transcribeReady: () => data('media:transcribeReady'),
  transcriptSummary: (itemID) => data('media:transcript:summary', itemID),
  onTranscribeProgress: (listener) => subscribe('media:transcribe-progress', listener),

  // 话题盯梢（F4：CRUD / 聚合 / 信息流）——写通道走 invoke（失败 reject，渲染层可回显错误）
  topicsList: () => data('topics:list'),
  topicsSave: (payload) => invoke('topics:save', payload),
  topicsDelete: (id) => invoke('topics:delete', id),
  topicsSetEnabled: (id, enabled) => invoke('topics:setEnabled', id, enabled === true),
  topicsAggregate: (id) => invoke('topics:aggregate', id),
  topicsHits: (id, opts) => data('topics:hits', id, opts),

  // Newsletter 收件（F6：邮箱账户 / 白名单发件人 / 测试连接）
  mailAccounts: () => data('mail:accounts'),
  mailAdd: (payload) => invoke('mail:add', payload),
  mailTest: (payload) => invoke('mail:test', payload),
  mailDelete: (id) => invoke('mail:delete', id),
  mailSetEnabled: (id, enabled) => invoke('mail:setEnabled', id, enabled === true),
  mailSetSelfSigned: (id, allow) => invoke('mail:setSelfSigned', id, allow === true),
  mailSenders: (accountID) => data('mail:senders', accountID),
  mailAddSender: (payload) => invoke('mail:addSender', payload),
  mailRemoveSender: (feedID) => invoke('mail:removeSender', feedID),

  // WebDAV 多设备同步（F7：配置 / 测试连接 / 立即同步 / 自动开关 / 阅读位置）
  syncGetConfig: () => data('sync:getConfig'),
  syncSaveConfig: (patch) => invoke('sync:saveConfig', patch),
  syncDisconnect: () => invoke('sync:disconnect'),
  syncTest: (payload) => invoke('sync:test', payload),
  syncSetAuto: (enabled) => invoke('sync:setAuto', enabled),
  syncNow: () => invoke('sync:now'),
  reportSyncProgress: (entries) => ipcRenderer.send('sync:reportProgress', entries),
  onSyncProgress: (listener) => subscribe('sync:progress', listener),

  // Obsidian 知识库导出（F11：目录授权 / 预览 / 增量导出 / 全量重导 / 配置读写）
  obsidianConfig: (patch) => invoke('obsidian:config', patch),
  obsidianPickDir: () => invoke('obsidian:pickDir'),
  obsidianPreview: () => invoke('obsidian:preview'),
  obsidianExport: () => invoke('obsidian:export'),
  obsidianFullExport: () => invoke('obsidian:fullExport'),

  // 个人文集自动成书（F12：书架 CRUD / 立即成书 / 打开目录 / 加入文集）
  booksList: () => invoke('books:list'),
  booksCreate: (payload) => invoke('books:create', payload),
  booksUpdate: (payload) => invoke('books:update', payload),
  booksAddFeeds: (payload) => invoke('books:addFeeds', payload),
  booksDelete: (id) => invoke('books:delete', id),
  booksBuild: (id) => invoke('books:build', id),
  booksOpenDir: (id) => invoke('books:openDir', id),

  // 相关文章 + 线索视图（F13：文末继续读 / 知识中心线索 tab）
  similarFor: (entryID, limit) => data('similar:for', entryID, limit),
  threadsList: () => data('threads:list'),
  threadsDetail: (keyword) => data('threads:detail', keyword),

  // AI 自动标签（F15：开关读写（偏好持久化）/ 立即跑一批 / 诊断快照）
  tagsAutoConfig: (patch) => data('tags:autoConfig', patch),
  tagsAutoKick: () => invoke('tags:autoKick'),
  tagsAutoSnapshot: () => data('tags:autoSnapshot'),

  // 订阅源体检仪表盘（F16：总览（60s 缓存）/ 单源详情）
  dashOverview: () => data('dash:overview'),
  dashFeed: (feedID) => data('dash:feed', feedID),

  // AI 深度研究（F8：列表 / 详情 / 删除 / 流式生成 / 追问 / 取消；onResearchDelta 收流式分片）
  researchList: () => data('research:list'),
  researchGet: (id) => data('research:get', id),
  researchDelete: (id) => invoke('research:delete', id),
  researchGenerate: (topic) => invoke('research:generate', topic),
  researchFollowUp: (id, question) => invoke('research:followUp', id, question),
  researchCancel: () => invoke('research:cancel'),
  onResearchDelta: (listener) => subscribe('research:delta', listener),
  onResearchStatus: (listener) => subscribe('research:status', listener),

  // 全库 RAG 问答（F9：会话列表/详情/流式问答/纯检索/取消/删除/重命名；onRagDelta 收流式分片）
  ragSessions: () => data('rag:sessions'),
  ragSession: (id) => data('rag:session', id),
  ragGather: (question) => data('rag:gather', question),
  ragAsk: (sessionID, question) => invoke('rag:ask', sessionID, question),
  ragCancel: () => invoke('rag:cancel'),
  ragDelete: (id) => invoke('rag:delete', id),
  ragRename: (id, title) => invoke('rag:rename', id, title),
  ragSources: (messageID) => data('rag:sources', messageID),
  onRagDelta: (listener) => subscribe('rag:delta', listener),
  onRagStatus: (listener) => subscribe('rag:status', listener),

  // 智能每日精选（F10：画像摘要 / Top N / 不感兴趣 / 播报文稿 / 数量档位）
  picksProfile: () => data('picks:profile'),
  picksGet: (opts) => data('picks:get', opts),
  picksExclude: (entryID) => data('picks:exclude', entryID),
  picksBroadcast: (opts) => data('picks:broadcast', opts),
  picksSetLimit: (n) => data('picks:setLimit', n),

  // 简报电台（F19：电台文稿 / 播放位置记忆 / 诊断快照）
  radioScript: (opts) => data('radio:script', opts),
  radioSavePosition: (sessionKey, index, meta) => data('radio:savePosition', sessionKey, index, meta),
  radioGetPosition: (sessionKey, hash) => data('radio:getPosition', sessionKey, hash),
  radioSnapshot: () => data('radio:snapshot'),

  // 阅读目标（F20：进度聚合 / 周目标 / 达标恭喜一次性）
  goalProgress: () => data('goal:progress'),
  setWeeklyGoal: (n) => data('goal:setWeekly', n),
  goalCelebrate: () => data('goal:celebrate'),

  // 图片字节抓取（深色插图反相分析）
  fetchImageBytes: (url) => invoke('net:fetchImage', url),

  // 账户
  addFreshRSSAccount: (payload) => invoke('accounts:addFreshRSS', payload),
  validateFreshRSS: (payload) => invoke('accounts:validate', payload),
  removeAccount: (accountID) => invoke('accounts:remove', accountID),
  setAccountEnabled: (accountID, enabled) => invoke('accounts:setEnabled', accountID, enabled),
  syncAccount: (accountID) => invoke('accounts:sync', accountID),

  // AI
  generateSummary: (entryID) => invoke('ai:generateSummary', entryID),
  deepRead: (entryID) => invoke('ai:deepRead', entryID),
  richSummary: (entryID) => invoke('ai:richSummary', entryID),
  existingWork: (entryID, kind) => invoke('ai:existingWork', entryID, kind),
  explainSelection: (payload) => invoke('ai:explain', payload),
  askSelection: (payload) => invoke('ai:ask', payload),
  translateSelection: (payload) => invoke('ai:translateSelection', payload),
  translateParagraphs: (entryID, html, paragraphIDs) => invoke('ai:translateParagraphs', entryID, html, paragraphIDs),
  cachedBilingual: (entryID, html) => invoke('ai:cachedBilingual', entryID, html),
  annotations: (entryID) => invoke('ai:annotations', entryID),
  cancelAI: (key) => invoke('ai:cancel', key),
  testAI: () => invoke('ai:test'),

  // 偏好
  setTheme: (theme) => invoke('prefs:setTheme', theme),
  setFontSize: (size) => invoke('prefs:setFontSize', size),
  setLanguage: (language) => invoke('prefs:setLanguage', language),
  setRefreshInterval: (raw) => invoke('prefs:setRefreshInterval', raw),
  setRefreshOnLaunch: (enabled) => invoke('prefs:setRefreshOnLaunch', enabled),
  setLLM: (patch) => invoke('prefs:setLLM', patch),
  aiPersona: () => data('ai:persona'),
  aiSetPersona: (patch) => data('ai:setPersona', patch),
  aiPersonas: () => data('ai:personas'),
  setAPIKey: (key) => invoke('prefs:setAPIKey', key),
  llmProviders: () => data('llm:providers'),
  llmAddProvider: (payload) => invoke('llm:addProvider', payload),
  llmUpdateProvider: (id, patch) => invoke('llm:updateProvider', id, patch),
  llmRemoveProvider: (id) => invoke('llm:removeProvider', id),
  llmSetActive: (id) => invoke('llm:setActive', id),
  setColumnWidths: (payload) => invoke('prefs:setColumnWidths', payload),
  setThemeTokens: (tokens) => invoke('prefs:setThemeTokens', tokens),
  setReaderLayout: (patch) => invoke('prefs:setReaderLayout', patch),
  setFilterRules: (patch) => invoke('prefs:setFilterRules', patch),
  clearThemeTokens: () => invoke('prefs:clearThemeTokens'),

  // 账号与会员（账号密码登录 / 会员状态 / AI 额度 / 订单）
  accountConfig: () => data('account:config'),
  accountLoginWechat: () => invoke('account:loginWechat'),
  accountLoginDev: (nickname) => invoke('account:loginDev', nickname),
  accountRegister: (username, password, nickname) => invoke('account:register', username, password, nickname),
  accountLoginPassword: (username, password) => invoke('account:loginPassword', username, password),
  accountRedeem: (code) => invoke('account:redeem', code),
  accountLogout: () => invoke('account:logout'),
  accountMe: (force) => invoke('account:me', force),
  accountConsumeAIQuota: () => invoke('account:consumeAIQuota'),
  accountUpdateProfile: (patch) => invoke('account:updateProfile', patch),
  accountPickAvatar: () => invoke('account:pickAvatar'),
  payCreateOrder: (plan) => invoke('pay:createOrder', plan),
  payQueryOrder: (outTradeNo) => invoke('pay:queryOrder', outTradeNo),
  onAccountChanged: (listener) => subscribe('account:changed', listener),

  // 更新
  checkUpdate: () => invoke('update:check'),
  ignoreVersion: (version) => invoke('update:ignoreVersion', version),
  updateDownload: () => invoke('update:download'),
  updateInstall: () => invoke('update:install'),
  updateCancel: () => invoke('updater:cancel'),
  onUpdateProgress: (listener) => subscribe('update:progress', listener),

  // 事件订阅
  onStateChanged: (listener) => subscribe('state:changed', listener),
  onAIDelta: (listener) => subscribe('ai:delta', listener),
  onAIStatus: (listener) => subscribe('ai:status', listener),
  onSelectionDelta: (listener) => subscribe('ai:selection-delta', listener),
  onDigestDelta: (listener) => subscribe('ai:digest-delta', listener),
  onMenu: (channel, listener) => subscribe(channel, listener),
  onThemeChanged: (listener) => subscribe('theme:changed', listener),

  // 阅读器 iframe 内链接转发
  openLink: (url) => ipcRenderer.send('reader:openLink', url),

  // 知识引擎（读操作直接解包 data，写操作保留 {ok,data} 语义）
  kbHighlights: (itemID) => data('kb:highlights', itemID),
  kbAllHighlights: () => data('kb:allHighlights'),
  kbAddHighlight: (payload) => invoke('kb:addHighlight', payload),
  kbRemoveHighlight: (id) => invoke('kb:removeHighlight', id),
  kbUpdateHighlight: (id, patch) => invoke('kb:updateHighlight', id, patch),
  kbNotes: (itemID) => data('kb:notes', itemID),
  kbAddNote: (payload) => invoke('kb:addNote', payload),
  kbUpdateNote: (id, patch) => invoke('kb:updateNote', id, patch),
  kbDeleteNote: (id) => invoke('kb:deleteNote', id),
  kbDueReviews: () => data('kb:dueReviews'),
  kbReview: (id, quality) => data('kb:review', id, quality),
  kbAddToReview: (payload) => invoke('kb:addToReview', payload),
  kbRemoveFromReview: (id) => invoke('kb:removeFromReview', id),
  kbTags: (itemID) => data('kb:tags', itemID),
  kbTagsSource: () => data('kb:tagsSource'), // F15：标签×来源计数（复核过滤 chips）
  kbEntriesForTag: (tag, limit) => data('kb:entriesForTag', tag, limit),
  kbAddTag: (itemID, tag) => invoke('kb:addTag', itemID, tag),
  kbRemoveTag: (itemID, tag) => invoke('kb:removeTag', itemID, tag),
  kbStats: (days) => data('kb:stats', days),
  kbCollections: () => data('kb:collections'),
  kbCreateCollection: (name, desc) => invoke('kb:createCollection', name, desc),
  kbUpdateCollection: (id, patch) => invoke('kb:updateCollection', id, patch),
  kbCollectionItems: (colID) => data('kb:collectionItems', colID),
  kbAddToCollection: (colID, itemID) => invoke('kb:addToCollection', colID, itemID),
  kbRemoveFromCollection: (colID, itemID) => invoke('kb:removeFromCollection', colID, itemID),
  kbDeleteCollection: (id) => invoke('kb:deleteCollection', id),
  kbSmartFolders: () => data('kb:smartFolders'),
  kbCreateSmartFolder: (name, query) => invoke('kb:createSmartFolder', name, query),
  kbDeleteSmartFolder: (id) => invoke('kb:deleteSmartFolder', id),
  kbRelated: (itemID) => data('kb:related', itemID),
  kbExportMarkdown: (itemID) => data('kb:exportMarkdown', itemID),
  kbExportNotes: () => data('kb:exportNotes'),
  kbDailyReview: (dateStr) => data('kb:dailyReview', dateStr),
  kbExportAnki: () => data('kb:exportAnki'),
  kbSearchKnowledge: (query, options) => data('kb:searchKnowledge', query, options),
  kbHeatmap: (days) => data('kb:heatmap', days),
  kbStatsExtras: () => data('kb:statsExtras'),
  statsGetGoal: () => data('stats:getGoal'),
  statsSetGoal: (n) => data('stats:setGoal', n),
  kbGraph: (limit) => data('kb:graph', limit),
  kbAsk: (question) => invoke('kb:ask', question),
  kbDashboard: () => data('kb:dashboard'),
  kbExportJSON: () => data('kb:exportJSON'),
  kbExportHTML: () => data('kb:exportHTML'),
  kbRefreshLinks: (noteID) => data('kb:refreshLinks', noteID),
  kbBacklinks: (noteID) => data('kb:backlinks', noteID),

  // 自进化引擎
  evoHealth: () => data('evo:health'),
  evoDeadFeeds: () => data('evo:deadFeeds'),
  evoProfile: () => data('evo:profile'),
  evoRecommend: (limit) => data('evo:recommend', limit),
  evoFeedback: (payload) => invoke('evo:feedback', payload),
  evoFeedbackSummary: () => data('evo:feedbackSummary'),
  evoDiagnose: () => data('evo:diagnose'),
  evoDensityByFeed: (days) => data('evo:densityByFeed', days),
  evoDensityByDay: (days) => data('evo:densityByDay', days),

  // 信息维度
  fullTextSearch: (query, options) => data('app:fullTextSearch', query, options),

  // AIHOT（热点榜 / 故事时间线 / 精选 / 日报 / 本地状态 / AI 深读）
  aihotHotTopics: () => data('aihot:hotTopics'),
  aihotStory: (publicId) => data('aihot:story', publicId),
  aihotSelected: (limit) => data('aihot:selected', limit),
  aihotDaily: () => data('aihot:daily'),
  aihotDailyIndex: (limit) => data('aihot:dailyIndex', limit),
  aihotDailyByDate: (date) => data('aihot:dailyByDate', date),
  aihotItems: (opts) => data('aihot:items', opts),
  aihotSelectedPage: (opts) => data('aihot:selectedPage', opts),
  aihotLeaderboard: () => data('aihot:leaderboard'),
  aihotExtractURL: (url) => data('aihot:extractURL', url),
  aihotSnapshot: () => data('aihot:snapshot'),
  aihotToggleFavorite: (item) => invoke('aihot:toggleFavorite', item),
  aihotMarkRead: (ids) => invoke('aihot:markRead', ids),
  aihotSetKeywords: (kw) => invoke('aihot:setKeywords', kw),
  aihotDeepRead: (payload) => invoke('aihot:deepRead', payload),
  copyText: (text) => invoke('app:copyText', text),
  translateTitlesBulk: (items) => data('titles:translateBulk', items),
  setTitleZh: (on) => invoke('prefs:setTitleZh', on),
  pickSavePath: (defaultName) => invoke('app:pickSavePath', { defaultName }),
  writeTextFile: (filePath, content) => invoke('app:writeTextFile', { filePath, content }),

  // 精读/摘要卡片导出（PNG 渲染 / 二进制写盘 / 图片进剪贴板 / 封面降采样）
  renderCardPng: (payload) => invoke('card:renderPng', payload),
  renderAllTemplates: (payload) => invoke('card:renderAllTemplates', payload),
  writeBinaryFile: (filePath, base64) => invoke('app:writeBinaryFile', { filePath, base64 }),
  copyImage: (base64) => invoke('app:copyImage', { base64 }),
  captureRect: (rect) => invoke('app:captureRect', rect),
  fetchCardCover: (url) => invoke('net:fetchCardCover', url),

  // 商店健康 + AI 探索（订阅源发现）
  storeHealth: () => invoke('store:health'),
  exploreRun: (payload) => invoke('explore:run', payload),
  exploreExplain: (payload) => invoke('explore:explain', payload),
  exploreDismiss: (payload) => invoke('explore:dismiss', payload),

  // 无边框窗口控制
  winMinimize: () => ipcRenderer.send('window:minimize'),
  winToggleMaximize: () => ipcRenderer.send('window:maximize'),
  winClose: () => ipcRenderer.send('window:close'),
  winIsMaximized: () => invoke('window:isMaximized'),
  onWindowMaxChanged: (listener) => subscribe('window:maximized-changed', listener),

  // 多窗并读（F17：弹出独立阅读窗口；同 entryID 聚焦既有窗口 / 上限 4 窗）
  openReaderWindow: (entryID) => invoke('readerWindow:open', entryID),

  // 网页追更（F18：试抓预览 / 添加 / 更改选择器 / 停止追更）
  monitorPreview: (payload) => invoke('monitor:preview', payload),
  monitorAdd: (payload) => invoke('monitor:add', payload),
  monitorSetSelector: (feedID, selector) => invoke('monitor:setSelector', feedID, selector),
  monitorStop: (feedID) => invoke('monitor:stop', feedID),

  // 桌面通用（关闭到托盘 / 新文章通知 / 开机自启）
  getGeneral: () => data('prefs:getGeneral'),
  setGeneral: (patch) => invoke('prefs:setGeneral', patch),
  loginItem: (enabled) => data('app:loginItem', enabled),

  // 备份与恢复（导出对话框 / 导入校验+暂存 / alertBox 确认后重启恢复）
  backupExport: () => invoke('backup:export'),
  backupImport: () => invoke('backup:import'),
  backupGetConfig: () => data('backup:getConfig'),
  backupSetConfig: (patch) => data('backup:setConfig', patch),
  backupAutoNow: () => data('backup:autoNow'),
  backupOpenFolder: () => data('backup:openFolder'),
  quitForRestore: () => ipcRenderer.send('backup:relaunch'),

  // 存储管理（体积统计 / 立即清理 / 打开数据目录）
  storageStats: () => data('storage:stats'),
  storageCleanup: () => data('storage:cleanup'),
  openDataDir: () => invoke('storage:openDataDir'),
});

function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}
