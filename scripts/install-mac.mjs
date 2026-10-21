// One-command install on this Mac (no sudo, no network):
//   1. electron-vite build
//   2. electron-builder --mac --dir for this Mac's architecture, using the Electron already in
//      node_modules/electron/dist (no download), no DMG, no publishing
//   3. copy "RallyFlow.app" into ~/Applications (replacing an older copy)
//   4. put a Finder alias "RallyFlow" on the Desktop (replacing an older alias)
//   5. remove the pre-rebrand "Pickleball Open Play.app" in ~/Applications and its "Pickleball Open Play"
//      Desktop alias, if present (only those two exact paths). Sessions are kept: both names use the
//      same data folder, ~/Library/Application Support/pickleball-open-play.
// Usage: npm run install-app            (add -- --no-build to reuse an existing out/ build)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_NAME = 'RallyFlow';
/** The app's name before the RallyFlow rebrand; its old install and Desktop alias are removed. */
const LEGACY_NAME = 'Pickleball Open Play';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = (name) => join(root, 'node_modules', '.bin', name);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

if (process.platform !== 'darwin') {
  console.error('install-app is for macOS. On Windows build the NSIS installer instead (see docs/INSTALL.md).');
  process.exit(1);
}
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const electronDist = join(root, 'node_modules', 'electron', 'dist');
if (!existsSync(join(electronDist, 'Electron.app'))) {
  console.error(`Electron not found at ${electronDist}. Run npm ci first.`);
  process.exit(1);
}

if (!process.argv.includes('--no-build')) {
  console.log('\n> Building the app (electron-vite build)');
  run(bin('electron-vite'), ['build']);
}

// THIRD_PARTY_NOTICES.md ships inside the app (electron-builder extraResources).
run(process.execPath, [join(root, 'scripts', 'third-party-notices.mjs')]);

// Package outside the project: an iCloud-synced Desktop keeps re-adding Finder info to
// app bundles, which makes the ad-hoc code signature fail.
const releaseDir = join(tmpdir(), 'rallyflow-release');
rmSync(releaseDir, { recursive: true, force: true });
console.log(`\n> Packaging ${APP_NAME}.app (${arch}, unpacked)`);
run(bin('electron-builder'), [
  '--mac', 'dir', `--${arch}`, '--publish', 'never',
  `-c.electronDist=${electronDist}`, `-c.directories.output=${releaseDir}`,
]);

const outDir = readdirSync(releaseDir)
  .map((d) => join(releaseDir, d))
  .find((d) => /^mac/.test(d.split('/').pop() ?? '') && existsSync(join(d, `${APP_NAME}.app`)));
if (!outDir) throw new Error(`Could not find ${APP_NAME}.app under ${releaseDir}`);
const builtApp = join(outDir, `${APP_NAME}.app`);

const appsDir = join(homedir(), 'Applications');
const installedApp = join(appsDir, `${APP_NAME}.app`);
mkdirSync(appsDir, { recursive: true });
if (existsSync(installedApp)) {
  console.log(`\n> Replacing ${installedApp}`);
  rmSync(installedApp, { recursive: true, force: true });
} else {
  console.log(`\n> Installing to ${installedApp}`);
}
cpSync(builtApp, installedApp, { recursive: true, verbatimSymlinks: true });
// Locally built and unsigned: drop any quarantine flag so Gatekeeper does not block the first launch.
try {
  execFileSync('xattr', ['-dr', 'com.apple.quarantine', installedApp], { stdio: 'ignore' });
} catch {
  /* no quarantine attribute */
}

const desktop = join(homedir(), 'Desktop');
const alias = join(desktop, APP_NAME);
if (existsSync(alias)) rmSync(alias, { recursive: true, force: true });
console.log(`> Creating Desktop alias ${alias}`);
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
execFileSync('osascript', [
  '-e',
  `tell application "Finder" to make alias file to (POSIX file "${esc(installedApp)}" as alias) at (POSIX file "${esc(desktop)}" as alias) with properties {name:"${esc(APP_NAME)}"}`,
], { stdio: 'inherit' });

// Clean up the pre-rebrand install. Only these two exact paths are touched.
const legacyApp = join(appsDir, `${LEGACY_NAME}.app`);
if (existsSync(legacyApp)) {
  console.log(`> Removing the old ${legacyApp}`);
  rmSync(legacyApp, { recursive: true, force: true });
}
const legacyAlias = join(desktop, LEGACY_NAME);
if (existsSync(legacyAlias)) {
  console.log(`> Removing the old Desktop alias ${legacyAlias}`);
  rmSync(legacyAlias, { recursive: true, force: true });
}

console.log(`\nDone. Double-click "${APP_NAME}" on your Desktop (or open it from ~/Applications).`);
