// Renders build/icon.svg to build/icon.png (1024x1024) offline using the local Electron binary.
// Usage: npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const svg = readFileSync(join(root, 'build', 'icon.svg'), 'utf8');
const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    useContentSize: true, webPreferences: { offscreen: true, zoomFactor: 1 },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const sized = img.getSize().width === 1024 ? img : img.resize({ width: 1024, height: 1024, quality: 'best' });
  writeFileSync(join(root, 'build', 'icon.png'), sized.toPNG());
  console.log('wrote build/icon.png', sized.getSize());
  app.quit();
});
