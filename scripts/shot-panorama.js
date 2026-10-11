'use strict';
/** 渲染 scripts/panorama.html → docs/images/panorama.jpg（2240px 宽，按内容自适应高）。 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 2240, height: 1600,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, 'panorama.html'));
  await new Promise((r) => setTimeout(r, 1800)); // 等全部 <img> 解码
  const height = await win.webContents.executeJavaScript('document.body.scrollHeight');
  await win.setBounds({ width: 2240, height: Math.min(Math.ceil(height), 16000) });
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  const out = path.join(__dirname, '..', 'docs', 'images', 'panorama.jpg');
  fs.writeFileSync(out, img.toJPEG(85));
  console.log(`PANORAMA ${Math.ceil(height)}px → ${Math.round(fs.statSync(out).size / 1024)}KB`);
  app.exit(0);
});
