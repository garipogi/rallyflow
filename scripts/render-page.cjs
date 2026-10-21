// Renders a local HTML or SVG file to a PNG of an exact size, offline, using the local Electron binary.
// Used for the brand images (site/assets/og-image.png, logo previews).
// Usage: npx electron scripts/render-page.cjs <input.html|.svg> <width> <height> <output.png>
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const [input, w, h, output] = process.argv.slice(-4);
const width = Number(w);
const height = Number(h);
if (!input || !output || !width || !height) {
  console.error('usage: electron scripts/render-page.cjs <input> <width> <height> <output.png>');
  process.exit(1);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width, height, show: false, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL(pathToFileURL(resolve(input)).href);
  await new Promise((r) => setTimeout(r, 700));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  const sized = img.getSize().width === width ? img : img.resize({ width, height, quality: 'best' });
  writeFileSync(resolve(output), sized.toPNG());
  console.log('wrote', output, sized.getSize());
  app.quit();
});
