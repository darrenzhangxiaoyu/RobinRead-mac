'use strict';
/**
 * _probe-bootstrap.js — 探针统一引导（run-all 注入，CI 环境修复）
 *
 * 背景：GitHub Actions 运行器镜像（windows-latest / macos-latest）默认开启系统级
 * 「减弱动态效果」，Chromium 因而向渲染进程回报 prefers-reduced-motion: reduce。
 * 应用 CSS 在该媒体特性下按设计关闭动画（@media prefers-reduced-motion: reduce），
 * 于是动画类探针读到 animation-name: none 而批量误报 FAIL——与代码正确性无关。
 *
 * 本引导在每次创建 BrowserWindow 时把该媒体特性钉回 no-preference，
 * 只作用于探针进程内部（Emulation 覆盖），不触碰宿主机系统设置。
 * 上游仓库同一批探针在 CI 亦全数红（见 suzike/RobinRead 近期运行记录）。
 */
const path = require('node:path');
const { app } = require('electron');

// CI 运行器无真实显示输出：窗口被判定「被遮挡」→ Chromium 冻结动画、延迟图片解码、
// 节流定时器，探针因此读到 animation 1e-05s / 图片 0px / 布局不刷新等系统性误报。
// 这三个开关是 Electron/Chromium 无头 CI 的标准做法（只影响探针进程）。
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.on('browser-window-created', (_event, win) => {
  try {
    win.webContents.setEmulatedMedia({
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
  } catch (_) { /* 旧版 Electron 无 setEmulatedMedia：静默回退，不影响探针运行 */ }
});

// run-all 以 `electron _probe-bootstrap.js <probe>` 调用；probe 为相对仓库根的路径。
// 取引导脚本之后第一个 .js 参数（容忍探针附带的额外 flag，如 --ci）
const probe = process.argv.slice(2).find((a) => String(a).endsWith('.js'));
if (!probe) {
  console.error('usage: electron _probe-bootstrap.js <probe-script> [flags]');
  app.exit(2);
}
require(path.resolve(process.cwd(), probe));
