'use strict';
/** 底栏收敛实拍：收起态 + 展开态两帧（挑剔官验收用，非 README 配图）。 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'robinread-footshot-'));
app.setPath('userData', userData);
setTimeout(() => app.exit(3), 4 * 60 * 1000).unref();
app.whenReady().then(async () => {
  const { AppStore } = require('../src/main/AppStore');
  const store = new AppStore(userData);
  const win = new BrowserWindow({
    show: false, width: 1440, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  const { registerIPCHandlers } = require('../src/main/ipc');
  registerIPCHandlers(store, win);
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await win.webContents.executeJavaScript(`localStorage.setItem('robinread.onboardingSeen', '1'); true`);
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  win.show();
  win.webContents.debugger.attach();
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await new Promise((r) => setTimeout(r, 2600));
  const OUT = path.join(__dirname, '..', 'docs', 'images');
  let img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'footer-collapsed.jpg'), img.toJPEG(90));
  await win.webContents.executeJavaScript(`(() => { const w = document.querySelector('.footer-more-wrap'); if (w && !w.classList.contains('open')) document.querySelector('.footer-more-btn')?.click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 700));
  img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'footer-expanded.jpg'), img.toJPEG(90));
  console.log('SHOTS DONE');
  app.exit(0);
});
