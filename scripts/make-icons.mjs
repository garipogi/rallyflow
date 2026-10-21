// Regenerates the app icons from build/icon.svg, fully offline (macOS: needs sips + iconutil).
//   build/icon.png   1024x1024, rendered by the local Electron binary (scripts/render-icon.cjs)
//   build/icon.icns  macOS icon set (16..1024)
//   build/icon.ico   Windows icon (PNG-compressed entries 16..256)
// Usage: node scripts/make-icons.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'build');
const png = join(build, 'icon.png');
const electron = createRequire(import.meta.url)('electron'); // path to the local Electron binary

execFileSync(electron, [join(root, 'scripts', 'render-icon.cjs')], { stdio: 'inherit' });

const work = mkdtempSync(join(tmpdir(), 'pbop-icons-'));
const resize = (size, out) => execFileSync('sips', ['-z', String(size), String(size), png, '--out', out], { stdio: 'ignore' });
try {
  const iconset = join(work, 'icon.iconset');
  mkdirSync(iconset);
  for (const s of [16, 32, 128, 256, 512]) {
    resize(s, join(iconset, `icon_${s}x${s}.png`));
    resize(s * 2, join(iconset, `icon_${s}x${s}@2x.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(build, 'icon.icns')]);

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map((s) => {
    const out = join(work, `ico-${s}.png`);
    resize(s, out);
    return readFileSync(out);
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((s, i) => {
    const e = i * 16;
    dir.writeUInt8(s >= 256 ? 0 : s, e);
    dir.writeUInt8(s >= 256 ? 0 : s, e + 1);
    dir.writeUInt8(0, e + 2);
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bpp
    dir.writeUInt32LE(images[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  writeFileSync(join(build, 'icon.ico'), Buffer.concat([header, dir, ...images]));
  console.log('wrote build/icon.icns and build/icon.ico');
} finally {
  rmSync(work, { recursive: true, force: true });
}
