'use strict';
/**
 * diag-f11-obsidian.js — F11 Obsidian 知识库导出端到端探针（run-all OFFLINE 集，全程离线）
 *
 * 假 vault：临时目录（探针内经 obsidian:pickDir 的 openDirectory 对话框 mock + token
 * 授权机制授权该目录——与生产同一条授权路径，不走注入短路）。覆盖（对应 F11 探针 10 条）：
 *  1 pickDirectory 通道：dialog.showOpenDialog stub → 返回 token 授权；未授权目录直接 export 被拒
 *  2 导出结构：3 文章（含中文标题特殊字符）+ 2 高亮（1 条带笔记）+ 标签并集 → 文件树/
 *    文件名 sanitize/长度/id8/frontmatter 字段齐全且 YAML 安全（冒号标题带引号）
 *  3 正文转换：HTML→MD 段落（无残留 <p>/<script> 标签）；单文件 1MB 截断
 *  4 增量：二次导出零写入（hash 命中 mtime 全不变）；改 1 条高亮笔记 → 仅该文件重写
 *  5 永不删除：RobinRead/ 下手工加用户文件 → 再导出仍存在
 *  6 全量重导：全部重写；sync-state 坏 JSON → 全量重导容错 + 游标自愈回写
 *  7 数量护栏：3000 条高亮 → 2000 截断（第二个 store/vault 隔离验证）
 *  8 UI：设置 Obsidian 分区渲染（目录/开关/按钮/最后导出时间）+ 预览统计（真 IPC）
 *  9 范围开关：只导高亮（文章不导，buildFiles 零 Articles/ 文件）
 * 10 重启失效：新 service 实例授权态清空（导出被拒，需重新选目录）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, dialog } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f11-app-'));
app.setPath('userData', userData);
setTimeout(() => { console.error('WATCHDOG'); app.exit(3); }, 240 * 1000).unref();

let failed = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { failed += 1; console.error('FAIL ' + l); } };

app.on('window-all-closed', () => { /* 探针自行控制退出 */ });

const N = () => Math.floor(Date.now() / 1000);
const walkFiles = (dir) => {
  const out = [];
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
};
const FILENAME_BAD = /[\\/:*?"<>|]/;

app.whenReady().then(async () => {
  const cleanup = [userData];
  const realShowOpenDialog = dialog.showOpenDialog;
  try {
    const { AppStore } = require('../src/main/AppStore');
    const { ObsidianExportService, TRUNCATION_MARKER, MAX_FILES_PER_EXPORT } = require('../src/main/ObsidianExportService');
    const { LOCAL_ACCOUNT_ID } = require('../src/main/Models');
    const { BrowserWindow } = require('electron');

    const store = new AppStore(userData);
    await new Promise((r) => setTimeout(r, 1500)); // 等启动自愈批处理落地

    // ── 灌数：3 文章（1 条中文标题带冒号/引号）+ 标签（手动/笔记）+ 2 高亮（1 条带笔记）──
    const feed = store.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F11 周刊', feedURL: 'https://f11.test/feed.xml' });
    const mkEntry = (suffix, title, contentHTML, publishedAt) => store.articlesRepo.upsertEntry({
      id: `local:${feed.id}:${suffix}`, accountID: LOCAL_ACCOUNT_ID, externalID: `local:${feed.id}:${suffix}`, feedID: feed.id,
      title, url: `https://f11.test/${suffix}`, publishedAt, summary: '', contentHTML,
    });
    const entryA = mkEntry('a1', '标题: "带冒号" 的文章', '<p>第一段正文，讲清一个观点。</p><p>第二段正文，补充细节。</p><script>alert(1)</script>', N() - 900);
    const entryB = mkEntry('a2', 'B 篇：普通文章', '<p>B 的正文。</p>', N() - 800);
    const entryC = mkEntry('a3', 'C 篇', '<p>C 的正文。</p>', N() - 700);
    store.knowledge.addManualTag(entryA, 'AI');
    store.knowledge.addManualTag(entryA, '科技');
    store.knowledge.addNote({ itemID: entryA, content: '独立笔记：这篇文章值得重读。', tags: ['笔记标签'] });
    const hl1 = store.knowledge.addHighlight({ itemID: entryA, text: '高亮句子一：值得反复咀嚼。', note: '我的批注：与另一篇互证。' });
    const hl2 = store.knowledge.addHighlight({ itemID: entryB, text: '高亮句子二：没有笔记。', note: null });

    // 隐藏窗口 + 真 IPC（preload），与 F7 UI 探针同构
    const win = new BrowserWindow({
      show: false, width: 1100, height: 820,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
    });
    const { registerIPCHandlers } = require('../src/main/ipc');
    registerIPCHandlers(store, win);
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    await new Promise((r) => setTimeout(r, 900));
    const ipc = (expr) => win.webContents.executeJavaScript(expr);

    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f11-vault-'));
    cleanup.push(vault);
    const rootDir = path.join(vault, 'RobinRead');
    const articlesDir = path.join(rootDir, 'Articles');
    const highlightsDir = path.join(rootDir, 'Highlights');
    const statePath = path.join(rootDir, '_meta', 'sync-state.json');
    const mdFiles = () => walkFiles(rootDir).filter((p) => p.endsWith('.md'));

    // ══ 1. pickDirectory 通道：对话框 mock → token 授权；未授权 export 被拒 ══
    {
      const cfg0 = await ipc(`window.robin.obsidianConfig()`);
      ok(cfg0 && cfg0.ok === true && cfg0.data.authorized === false && !cfg0.data.dir, '1 初始配置：未授权、无目录（IPC 信封）');
      const denied = await ipc(`window.robin.obsidianExport()`);
      ok(denied && denied.ok === false && /未授权|授权/.test(String(denied.error)), `1 未授权直接 export → 信封拒绝（${denied && denied.error}）`);
      // openDirectory 对话框 mock：只 mock 对话框，授权登记走生产 pickDir 通道
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] });
      const picked = await ipc(`window.robin.obsidianPickDir()`);
      ok(picked && picked.ok === true && picked.data && picked.data.dir === vault, `1 pickDir（openDirectory mock）→ token 授权（${picked && picked.data && picked.data.dir === vault}）`);
      const cfg1 = await ipc(`window.robin.obsidianConfig()`);
      ok(cfg1.data.authorized === true && cfg1.data.dir === vault, '1 授权后 config 回显内存态目录');
      // cancel 路径不改变授权态
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      const pickedCancel = await ipc(`window.robin.obsidianPickDir()`);
      const cfg2 = await ipc(`window.robin.obsidianConfig()`);
      ok(pickedCancel && pickedCancel.ok === true && pickedCancel.data === null && cfg2.data.authorized === true, '1 对话框取消 → 授权态保持不变');
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [vault] });
    }

    // ══ 2. 导出结构 / 文件名 sanitize / frontmatter YAML 安全 ══
    {
      const pv = await ipc(`window.robin.obsidianPreview()`);
      ok(pv && pv.ok && pv.data.counts.articles === 3 && pv.data.counts.highlights === 2 && pv.data.newFiles === 5,
        `2 预览统计（articles=${pv && pv.data && pv.data.counts.articles} highlights=${pv && pv.data && pv.data.counts.highlights} new=${pv && pv.data && pv.data.newFiles}）`);
      const st = await ipc(`window.robin.obsidianExport()`);
      ok(st && st.ok && st.data.added === 5 && st.data.skipped === 0 && st.data.totalFiles === 5,
        `2 首次导出 5 新增（added=${st && st.data && st.data.added}）`);
      ok(fs.existsSync(articlesDir) && fs.existsSync(highlightsDir) && fs.existsSync(statePath), '2 文件树：Articles/ Highlights/ _meta/sync-state.json 就位');
      const articles = fs.readdirSync(articlesDir);
      const highlights = fs.readdirSync(highlightsDir);
      ok(articles.length === 3 && highlights.length === 2, `2 文件数（Articles 3=${articles.length}，Highlights 2=${highlights.length}）`);
      ok(articles.every((n) => !FILENAME_BAD.test(n) && n.endsWith('.md')), '2 文章文件名无非法字符');
      ok(articles.every((n) => n.length <= 84 && / [0-9a-f]{8}\.md$/.test(n)), `2 文章文件名 ≤80 主干 + 尾部 id8（${JSON.stringify(articles)}）`);
      const colonFile = articles.find((n) => n.includes('标题'));
      ok(!!colonFile && !FILENAME_BAD.test(colonFile), `2 中文特殊字符标题已 sanitize（${colonFile}）`);
      const colonContent = fs.readFileSync(path.join(articlesDir, colonFile), 'utf8');
      ok(/title: "标题: \\"带冒号\\" 的文章"/.test(colonContent), '2 冒号/引号标题 YAML 双引号包裹并转义');
      ok(colonContent.includes('source: F11 周刊') && colonContent.includes('url: "https://f11.test/a1"')
        && /published: "20\d\d-/.test(colonContent) && /robinId: "local:/.test(colonContent), '2 文章 frontmatter 字段齐全（title/source/url/published/robinId）');
      ok(colonContent.includes('tags: [AI, 科技, 笔记标签]'), `2 tags = article_tags ∪ 知识笔记标签（${(colonContent.match(/tags: .*/) || [''])[0]}）`);
      ok(!/<p>|<\/p>|<script/i.test(colonContent) && colonContent.includes('第一段正文') && colonContent.includes('第二段正文'), '3 HTML 正文 → MD 段落（无残留标签，段落保留）');
      ok(colonContent.includes('## Notes') && colonContent.includes('独立笔记'), '2 独立知识笔记随文章导出（## Notes 区段）');
      const hlFiles = highlights.map((n) => fs.readFileSync(path.join(highlightsDir, n), 'utf8'));
      const withNote = hlFiles.find((c) => c.includes('高亮句子一'));
      const noNote = hlFiles.find((c) => c.includes('高亮句子二'));
      ok(!!withNote && withNote.includes('> 高亮句子一') && withNote.includes('我的批注'), '2 高亮文件 = 引用块 + 笔记段');
      ok(!!withNote && /title: "标题: /.test(withNote) && withNote.includes('source: F11 周刊')
        && /date: 20\d\d-\d\d-\d\d/.test(withNote) && /robinId: "?hl-/.test(withNote)
        && withNote.includes('entryUrl: "https://f11.test/a1"'), '2 高亮 frontmatter 字段齐全（title/source/date/robinId/entryUrl）');
      ok(!!noNote && noNote.includes('> 高亮句子二') && !noNote.includes('我的批注'), '2 无笔记高亮只有引用块');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      ok(state && state.version === 1 && typeof state.files === 'object'
        && Object.keys(state.files).length === 5
        && Object.keys(state.files).every((k) => /^[^/]+\/[^/]+\.md$/.test(k) && /^[0-9a-f]{12}$/.test(state.files[k])),
        `2 sync-state 游标：5 条 hash 短码（${Object.keys(state.files).length}）`);
    }

    // ══ 3. 单文件 1MB 截断 ══
    {
      const bigBody = '这是一段很长的中文正文，用来撑爆单文件上限。'.repeat(30000); // ≈ 1.98MB UTF-8
      mkEntry('big', '超长文章', `<p>${bigBody}</p>`, N() - 600);
      const st = await ipc(`window.robin.obsidianExport()`);
      ok(st && st.ok && st.data.added === 1 && st.data.totalFiles === 6, `3 追加超长文章导出（added=${st && st.data && st.data.added}）`);
      const bigFile = fs.readdirSync(articlesDir).find((n) => / [0-9a-f]{8}\.md$/.test(n) && n.includes('超长'));
      const size = fs.statSync(path.join(articlesDir, bigFile)).size;
      const content = fs.readFileSync(path.join(articlesDir, bigFile), 'utf8');
      ok(size <= 1024 * 1024 + 256 && content.includes(TRUNCATION_MARKER), `3 单文件 1MB 截断（${size} bytes ≤ 1MB，含标注）`);
    }

    // ══ 4. 增量：二次零写入；改 1 条高亮 → 仅该文件重写 ══
    const mtimeOf = (p) => fs.statSync(p).mtimeMs;
    {
      const before = new Map(mdFiles().map((p) => [p, mtimeOf(p)]));
      const st1 = await ipc(`window.robin.obsidianExport()`);
      const after1 = new Map(mdFiles().map((p) => [p, mtimeOf(p)]));
      const untouched1 = [...before].every(([p, m]) => after1.get(p) === m);
      ok(st1.data.added === 0 && st1.data.updated === 0 && st1.data.skipped === 6 && untouched1,
        `4 二次导出零写入（added=${st1.data.added} updated=${st1.data.updated} skipped=${st1.data.skipped}，mtime 全不变）`);
      store.knowledge.updateHighlight(hl1.id, { note: '改过的批注：结论反转了。' });
      const st2 = await ipc(`window.robin.obsidianExport()`);
      const after2 = new Map(mdFiles().map((p) => [p, mtimeOf(p)]));
      const changed = [...after1].filter(([p, m]) => after2.get(p) !== m).map(([p]) => p);
      const articleUntouched = [...before.keys()].filter((p) => p.includes('Articles')).every((p) => after2.get(p) === before.get(p));
      ok(st2.data.updated === 1 && st2.data.skipped === 5 && changed.length === 1 && changed[0].includes('Highlights') && articleUntouched,
        `4 改 1 条高亮 → 仅该文件重写（updated=${st2.data.updated}，changed=${changed.length}，文章 mtime 不变）`);
      ok(changed[0] && fs.readFileSync(changed[0], 'utf8').includes('结论反转了'), '4 重写文件携带新内容');
    }

    // ══ 5. 永不删除：用户在 Obsidian 侧加的文件原样保留 ══
    {
      const userFile = path.join(articlesDir, '我的手写笔记.md');
      fs.writeFileSync(userFile, '用户自己在 Obsidian 里写的内容。', 'utf8');
      const userHL = path.join(highlightsDir, 'user-note.md');
      fs.writeFileSync(userHL, 'user added', 'utf8');
      const st = await ipc(`window.robin.obsidianExport()`);
      ok(st.data.skipped === 6 && fs.existsSync(userFile) && fs.readFileSync(userFile, 'utf8') === '用户自己在 Obsidian 里写的内容。'
        && fs.existsSync(userHL), '5 再导出后用户文件仍存在且未被改写（只管自己命名空间）');
    }

    // ══ 6. 全量重导 + sync-state 坏 JSON 容错 ══
    {
      const before = new Map(mdFiles().map((p) => [p, mtimeOf(p)]));
      await new Promise((r) => setTimeout(r, 30)); // mtime 粒度保护
      const st = await ipc(`window.robin.obsidianFullExport()`);
      const after = new Map(mdFiles().map((p) => [p, mtimeOf(p)]));
      const rewritten = [...before].filter(([p]) => !p.endsWith('我的手写笔记.md') && !p.endsWith('user-note.md'));
      ok(st.data.force === true && st.data.updated === 6 && st.data.skipped === 0
        && rewritten.every(([p]) => after.get(p) !== before.get(p)),
        `6 全量重导：6 文件全部重写（updated=${st.data.updated}），用户文件不动`);
      fs.writeFileSync(statePath, '{broken json!! 不是合法 JSON', 'utf8');
      const before2 = new Map(mdFiles().map((p) => [p, mtimeOf(p)]));
      await new Promise((r) => setTimeout(r, 30));
      const st2 = await ipc(`window.robin.obsidianExport()`);
      const after2 = new Map(mdFiles().map((p) => [p, mtimeOf(p)]));
      const rewritten2 = [...before2].filter(([p]) => !p.endsWith('我的手写笔记.md') && !p.endsWith('user-note.md'));
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      ok(st2.data.added === 6 && rewritten2.every(([p]) => after2.get(p) !== before2.get(p)),
        `6 坏 JSON 游标 → 等效全量重导（added=${st2.data.added}）`);
      ok(state && typeof state.files === 'object' && Object.keys(state.files).length === 6, '6 游标自愈回写（6 条）');
    }

    // ══ 8. UI：设置「Obsidian」分区渲染 + 预览统计（真 IPC）══
    {
      const result = await ipc(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const waitFor = async (fn, ms = 8000) => {
          const t0 = Date.now();
          for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(120); }
        };
        try {
          const { SettingsView } = await import('./views/dialogs.js');
          const view = new SettingsView({ state: {}, views: {}, onAddFreshRSS: () => {}, onReload: () => {}, onRefreshState: () => {} });
          view.present('obsidian');
          const navOk = [...document.querySelectorAll('.modal-nav-item')].some((el) => el.textContent.includes('Obsidian'));
          await waitFor(() => (document.querySelector('.modal-scroll')?.textContent || '').includes('导出目录') ? true : null, 8000);
          const body = document.querySelector('.modal-scroll')?.textContent || '';
          const hasScope = body.includes('导出文章') && body.includes('导出高亮与批注') && body.includes('标签写入 frontmatter');
          const hasButtons = body.includes('立即导出') && body.includes('全量重导') && body.includes('预览统计');
          const hasLast = body.includes('最后导出');
          const hasDir = body.includes('更改目录') && body.includes(vaultPath);
          const hasSecurity = body.includes('本次会话');
          // 预览统计：点按钮 → 状态行出现统计数字
          const pvBtn = [...document.querySelectorAll('.modal-scroll button')].find((b) => b.textContent === '预览统计');
          pvBtn.click();
          const statsShown = await waitFor(() => {
            const t = document.querySelector('.modal-scroll')?.textContent || '';
            return /预览：4 篇文章 · 2 条高亮 · 新增 0 · 变更 0 · 不变 6/.test(t) ? true : null;
          }, 8000);
          view.dismiss();
          return { navOk, hasScope, hasButtons, hasLast, hasDir, hasSecurity, statsShown };
        } catch (e) { return { __err: String(e && e.stack || e) }; }
      })()`.replace('vaultPath', JSON.stringify(vault)));
      if (result.__err) { ok(false, 'UI 探针异常 — ' + result.__err); } else {
        ok(result.navOk, '8 设置导航含「Obsidian」分区');
        ok(result.hasDir, '8 目录行渲染（已授权目录 + 更改按钮）');
        ok(result.hasScope, '8 范围三开关渲染（文章/高亮/标签）');
        ok(result.hasButtons, '8 立即导出/全量重导/预览统计按钮渲染');
        ok(result.hasLast, '8 最后导出时间行渲染');
        ok(result.hasSecurity, '8 会话级授权安全提示渲染');
        ok(result.statsShown, '8 预览统计（4 文章 · 2 高亮 · 不变 6，真 IPC）');
      }
    }

    win.destroy();

    // ══ 7 + 9. 第二 store：范围开关（只导高亮）+ 3000 条高亮 → 2000 截断 ══
    {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f11-app2-'));
      const vault2 = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-f11-vault2-'));
      cleanup.push(dir2, vault2);
      const store2 = new AppStore(dir2);
      await new Promise((r) => setTimeout(r, 1200));
      const feed2 = store2.feedsRepo.insertFeed({ accountID: LOCAL_ACCOUNT_ID, title: 'F11 高亮海', feedURL: 'https://f11b.test/feed.xml' });
      const entryB1 = store2.articlesRepo.upsertEntry({
        id: `local:${feed2.id}:b1`, accountID: LOCAL_ACCOUNT_ID, externalID: `local:${feed2.id}:b1`, feedID: feed2.id,
        title: '海量高亮的文章', url: 'https://f11b.test/b1', publishedAt: N() - 500, summary: '', contentHTML: '<p>正文。</p>',
      });
      for (let i = 0; i < 3000; i += 1) store2.knowledge.addHighlight({ itemID: entryB1, text: `高亮第 ${i} 句。` });

      // 9 范围开关：只导高亮（文章不导）
      store2.obsidian.authorizeDirectory(vault2);
      store2.obsidian.saveConfig({ scope: { articles: false, highlights: true, tags: true } });
      const onlyHL = store2.obsidian.buildFiles(); // 用偏好里的 scope
      ok(onlyHL.files.length > 0 && onlyHL.files.every((f) => f.kind === 'highlight') && onlyHL.files.every((f) => f.relPath.startsWith('Highlights/')),
        `9 只导高亮：${onlyHL.files.length} 个文件全在 Highlights/（0 文章）`);
      const pvHL = await store2.obsidian.preview();
      ok(pvHL.counts.articles === 0 && pvHL.counts.highlights === onlyHL.files.length, `9 预览口径一致（articles=${pvHL.counts.articles}）`);
      store2.obsidian.saveConfig({ scope: { articles: true, highlights: true, tags: true } });

      // 7 数量护栏：3001 源（1 文章 + 3000 高亮）→ 2000 截断
      const st = await store2.obsidian.exportOrchestrate();
      const mdCount = walkFiles(path.join(vault2, 'RobinRead')).filter((p) => p.endsWith('.md')).length;
      ok(st.totalFiles === MAX_FILES_PER_EXPORT && st.truncated === true && st.added === MAX_FILES_PER_EXPORT
        && st.dropped.highlights >= 1000,
        `7 数量护栏：totalFiles=${st.totalFiles}/2000 truncated=${st.truncated} dropped=${st.dropped.highlights}`);
      ok(mdCount === MAX_FILES_PER_EXPORT, `7 磁盘文件数 = 2000（${mdCount}）`);
      const st2b = await store2.obsidian.exportOrchestrate();
      ok(st2b.added === 0 && st2b.updated === 0 && st2b.skipped === MAX_FILES_PER_EXPORT && st2b.truncated === true,
        '7 截断后二次导出仍幂等（跳过 2000、仍提示截断）');
    }

    // ══ 10. 重启失效：新 service 实例授权态清空 ══
    {
      const fresh = new ObsidianExportService(store);
      ok(fresh.authorizedDir() === null && fresh.getConfig().authorized === false, '10 新实例（模拟重启）：授权态清空');
      let rejected = null;
      await fresh.exportOrchestrate().catch((e) => { rejected = e; });
      ok(rejected && rejected.code === 'OBSIDIAN_NOT_AUTHORIZED', `10 新实例导出被拒（${rejected && rejected.code}）`);
      ok(store.obsidian.authorizedDir() === vault, '10 既有实例授权态不受影响（会话内仍有效）');
      const cfg = store.obsidian.getConfig();
      ok(cfg.lastExportAt > 0 && cfg.lastDir === vault && cfg.scope.articles === true && cfg.scope.highlights === true && cfg.scope.tags === true,
        '10 偏好（最后导出时间/目录回显/范围开关）持久化正常');
    }

    console.log(failed === 0 ? 'ALL PASSED' : `${failed} 项失败`);
    app.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  } finally {
    dialog.showOpenDialog = realShowOpenDialog;
    for (const dir of cleanup) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  }
});
