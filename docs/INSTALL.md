# Installing RallyFlow

RallyFlow (*Every game. Every player. In rhythm.*) is the offline pickleball open play manager: a desktop app for one organizer. It never connects to the internet, so there is nothing to sign in to and no updater. Install it on the laptop you will use courtside.

## Supported systems (decision D12)

| Platform | Supported versions | Installer |
| --- | --- | --- |
| Windows | Windows 10 version 22H2 and later, Windows 11 | NSIS installer (`RallyFlow-Setup-<version>.exe`) |
| macOS | macOS 13 Ventura and later (Apple silicon and Intel) | Disk image (`RallyFlow-<version>-arm64.dmg` for Apple silicon, `RallyFlow-<version>-x64.dmg` for Intel; a `.zip` of the app is also published) |

## Windows (NSIS installer)

1. Copy the `.exe` installer to the laptop (USB drive is fine).
2. Double-click it. The installers are unsigned (decision D13), so Windows SmartScreen shows "Windows protected your PC". Choose **More info**, then **Run anyway**.
3. Pick an install folder, or keep the default, and finish the wizard.
4. Start **RallyFlow** from the Start menu or the desktop shortcut.

## macOS (DMG)

1. Copy the `.dmg` to the Mac and double-click it.
2. Drag **RallyFlow** into **Applications**.
3. The app is not code signed or notarized (decision D13), so the first launch is blocked by Gatekeeper. Control-click (right-click) the app in Applications, choose **Open**, then **Open** again in the dialog. If macOS still refuses, open **System Settings > Privacy & Security** and choose **Open Anyway** next to the app's name. You only do this once.

## Install on this Mac (from the source folder)

If you have the project folder on the Mac you will use (with `npm ci` already run), one command builds the app and installs it, with no sudo and no internet:

```
npm run install-app
```

It builds the app, packages `RallyFlow.app` for this Mac using the Electron already in `node_modules` (no DMG, nothing published), copies it into `~/Applications` (replacing an older copy), and puts a **RallyFlow** alias on your Desktop. It also removes the pre-rename `~/Applications/Pickleball Open Play.app` and the **Pickleball Open Play** Desktop alias if they exist (only those two exact paths). Double-click the alias to start the app. Run the same command again to update after pulling changes; your sessions are kept, because the installed app uses the same data folder as `npm run dev`.

To change the icon, edit `build/icon.svg` and run `npm run icons` (regenerates `build/icon.png`, `build/icon.icns` and `build/icon.ico`).

## Unsigned builds

The installers carry no publisher signature, so Windows and macOS warn you the first time. That is expected. Only install files you built yourself or received from the project owner, and compare the file name and size with what you were given.

## Where your data lives

All sessions, players and scores are stored in one local database in the app's data folder:

- Windows: `%APPDATA%\pickleball-open-play`
- macOS: `~/Library/Application Support/pickleball-open-play`

The installed app and the development build (`npm run dev`) share this folder. The folder keeps its original name after the rename to RallyFlow, so sessions from earlier "Pickleball Open Play" installs carry over unchanged.

Automatic safety backups are written to the `auto-backups` folder inside it. Use **Create backup** in the app to copy your data somewhere else (see the user guide).

## Uninstalling

Windows: Settings > Apps > RallyFlow > Uninstall. macOS: drag the app from Applications to the Trash. Your data folder is left alone; delete it too if you want everything gone.

## Building the installers yourself

```
npm ci
npm run build
npm run notices               # THIRD_PARTY_NOTICES.md, shipped inside the app
npx electron-builder --win    # on Windows
npx electron-builder --mac    # on macOS
npm run dist:mac              # Apple silicon DMG + zip, offline, using node_modules/electron/dist
```

Installers appear in `release/`. Tagged releases are built for all three targets by `.github/workflows/release.yml` (see `docs/RELEASING.md`). The GitHub Actions workflow in `.github/workflows/ci.yml` runs the full test suite on `windows-latest` and `macos-latest` for every push.
