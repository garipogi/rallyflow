// Build the shareable macOS installers (DMG + zip) for this Mac's architecture, signed
// ad-hoc, without downloading Electron. Packaging happens in a temp folder outside the
// project because an iCloud-synced Desktop keeps re-adding Finder info to app bundles,
// which makes codesign fail; the finished .dmg/.zip/.blockmap files are copied to release/.
// Usage: npm run dist:mac
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = (name) => join(root, 'node_modules', '.bin', name);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

if (process.platform !== 'darwin') {
  console.error('dist:mac builds macOS installers and must run on a Mac.');
  process.exit(1);
}
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const outDir = join(tmpdir(), 'rallyflow-dist');
rmSync(outDir, { recursive: true, force: true });

run(process.execPath, [join(root, 'scripts', 'third-party-notices.mjs')]);
run(bin('electron-vite'), ['build']);
run(bin('electron-builder'), [
  '--mac', 'dmg', 'zip', `--${arch}`, '--publish', 'never',
  `-c.electronDist=${join(root, 'node_modules', 'electron', 'dist')}`,
  `-c.directories.output=${outDir}`,
]);

const releaseDir = join(root, 'release');
mkdirSync(releaseDir, { recursive: true });
for (const name of readdirSync(outDir)) {
  if (/\.(dmg|zip|blockmap)$/.test(name)) {
    copyFileSync(join(outDir, name), join(releaseDir, name));
    console.log(`> release/${name}`);
  }
}
