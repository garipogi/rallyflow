import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session as electronSession, shell, type MenuItemConstructorOptions, type Session } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND, DISPLAY_TITLE, ORGANIZER_TITLE } from '../shared/brand';
import { openDatabase, type Db } from '../data/db';
import { loadSessionState } from '../data/sessions';
import { createApiHandlers, type DbStore, type HostServices } from './handlers';
import { readCourtExtras, readDisplayModel } from './displayModel';
import { API_METHODS, type DisplayMode, type DisplayPayload } from '../shared/api';
import { getAppearance } from '../data/appearance';
import { DEFAULT_APPEARANCE, tokensFor, type Appearance } from '../shared/themes';
import { getAwards, type AwardsScope } from '../data/awards';

// Portable data folder: the test harness (and a portable install) point userData somewhere explicit.
// This must run before anything reads userData.
if (process.env.PBOP_USER_DATA) app.setPath('userData', process.env.PBOP_USER_DATA);

// The app is fully offline: switch off every Chromium feature that would phone home.
for (const flag of ['disable-background-networking', 'disable-component-update', 'disable-sync', 'no-pings', 'disable-domain-reliability', 'no-default-browser-check']) {
  app.commandLine.appendSwitch(flag);
}
app.commandLine.appendSwitch(
  'disable-features',
  'NetworkTimeServiceQuerying,OptimizationHints,Translate,MediaRouter,AutofillServerCommunication,CertificateTransparencyComponentUpdater',
);

let db: Db | null = null;
let organizerWindow: BrowserWindow | null = null;
let displayWindow: BrowserWindow | null = null;
let displaySessionId: string | null = null;
/** What the display shows; kept in memory only, so every app start (and Open display) begins on the courts. */
let displayMode: DisplayMode = { kind: 'courts' };
/** Off-screen windows rendering the awards for "Save as image", keyed by webContents id. */
const captureScopes = new Map<number, AwardsScope>();

/** URL schemes that never leave the machine. Everything else (http, https, ws, ftp, ...) is cancelled. */
const LOCAL_SCHEMES = /^(file|data|blob|devtools|chrome|chrome-extension|about):/i;

/** Every session (default and any created later) refuses non-local requests. */
function blockRemoteRequests(session: Session): void {
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !LOCAL_SCHEMES.test(details.url) });
  });
  session.setSpellCheckerEnabled(false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

app.on('session-created', blockRemoteRequests);

/** The saved appearance (falls back to the default while the database is closed, e.g. mid-restore). */
function currentAppearance(): Appearance {
  try {
    return db ? getAppearance(db) : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Window background in the chosen theme, so nothing flashes the wrong colour while a page loads. */
const backgroundFor = (appearance: Appearance): string => tokensFor(appearance, nativeTheme.shouldUseDarkColors).bg;

/** Passed to each page in its URL so the theme is applied before the first paint. */
const themeQuery = (appearance: Appearance): Record<string, string> => ({ theme: appearance.theme, mode: appearance.mode });

function applyAppearance(appearance: Appearance): void {
  // Native dialogs, scrollbars and prefers-color-scheme in both windows follow the chosen mode.
  if (nativeTheme.themeSource !== appearance.mode) nativeTheme.themeSource = appearance.mode;
  refreshBackgrounds(appearance);
}

function refreshBackgrounds(appearance: Appearance): void {
  const bg = backgroundFor(appearance);
  for (const window of [organizerWindow, displayWindow]) {
    if (window && !window.isDestroyed()) window.setBackgroundColor(bg);
  }
}

const dbFile = (): string => join(app.getPath('userData'), 'open-play.db');

/** Restore closes the connection and reopens the replaced file, so handlers always ask the store. */
const store: DbStore = {
  current() {
    if (!db) throw new Error('The database is not open.');
    return db;
  },
  close() {
    db?.close();
    db = null;
  },
  open() {
    db = openDatabase(dbFile());
  },
};

const host: HostServices = {
  appVersion: app.getVersion(),
  dbFile: dbFile(),
  autoBackupDir: join(app.getPath('userData'), 'auto-backups'),
  async chooseDirectory(title) {
    const result = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
  async chooseSaveFile(title, defaultName, extension) {
    const result = await dialog.showSaveDialog({ title, defaultPath: defaultName, filters: [{ name: extension, extensions: [extension] }] });
    return result.canceled || !result.filePath ? null : result.filePath;
  },
  async chooseOpenFile(title, extension) {
    const result = await dialog.showOpenDialog({ title, properties: ['openFile'], filters: [{ name: extension, extensions: [extension] }] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
  openDisplay(sessionId) {
    displaySessionId = sessionId;
    displayMode = { kind: 'courts' };
    openDisplayWindow();
  },
  showOnDisplay(mode, opts) {
    displayMode = mode;
    // Awards for one session: switching back to the courts then shows that session.
    if ((mode.kind === 'awards' || mode.kind === 'ceremony') && mode.scope.kind === 'session') displaySessionId = mode.scope.sessionId;
    // The ceremony keeps the keyboard in the organizer window: the display opens without focus.
    if (!opts?.quiet) openDisplayWindow(mode.kind !== 'ceremony');
  },
  applyAppearance,
  captureAwardsImage(scope) {
    return captureAwards(scope);
  },
  async printOrganizerPdf() {
    if (!organizerWindow) throw new Error('The organizer window is closed.');
    return organizerWindow.webContents.printToPDF({ landscape: true, printBackground: true, pageSize: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 } });
  },
  async confirm(message, detail, confirmLabel = 'Replace data') {
    const result = await dialog.showMessageBox({
      type: 'warning',
      message,
      detail,
      buttons: ['Cancel', confirmLabel],
      defaultId: 0,
      cancelId: 0,
    });
    return result.response === 1;
  },
};

/** THIRD_PARTY_NOTICES.md ships in the packaged app's Resources folder (electron-builder extraResources). */
function thirdPartyNoticesFile(): string | null {
  const candidates = [join(process.resourcesPath, 'THIRD_PARTY_NOTICES.md'), join(app.getAppPath(), 'THIRD_PARTY_NOTICES.md')];
  return candidates.find((file) => existsSync(file)) ?? null;
}

const ABOUT_DETAIL = `${BRAND.descriptor}\n${BRAND.tagline}\n\nAll data stays on this computer. No network, no accounts, no tracking.\nOpen-source components: Help > Third-Party Notices.`;

function configureAbout(): void {
  app.setAboutPanelOptions({
    applicationName: BRAND.name,
    applicationVersion: app.getVersion(),
    version: '',
    copyright: BRAND.copyright,
    credits: `${BRAND.descriptor}\n${BRAND.tagline}\n\nOpen-source components: Help > Third-Party Notices.`,
  });
}

function showAbout(): void {
  if (process.platform === 'darwin') {
    app.showAboutPanel();
    return;
  }
  const options = {
    type: 'info' as const,
    title: `About ${BRAND.name}`,
    message: `${BRAND.name} ${app.getVersion()}`,
    detail: `${ABOUT_DETAIL}\n\n${BRAND.copyright}`,
    buttons: ['OK', 'Third-Party Notices'],
    defaultId: 0,
    cancelId: 0,
  };
  const shown = organizerWindow ? dialog.showMessageBox(organizerWindow, options) : dialog.showMessageBox(options);
  void shown.then((result) => {
    if (result.response === 1) openThirdPartyNotices();
  });
}

function openThirdPartyNotices(): void {
  const file = thirdPartyNoticesFile();
  if (file) {
    void shell.openPath(file);
    return;
  }
  void dialog.showMessageBox({ type: 'info', message: 'Third-party notices', detail: `The notices file is not included in this build of ${BRAND.name}.` });
}

/** The application menu, with the product name on every app-level item (the internal package name names only the data folder). */
function buildMenu(): void {
  const mac = process.platform === 'darwin';
  const help: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      ...(mac ? [] : [{ label: `About ${BRAND.name}`, click: showAbout }]),
      { label: 'Third-Party Notices', click: openThirdPartyNotices },
    ],
  };
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: BRAND.name,
            submenu: [
              { label: `About ${BRAND.name}`, click: showAbout },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide', label: `Hide ${BRAND.name}` },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: `Quit ${BRAND.name}` },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    help,
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Never open or navigate to a remote page inside the app. */
function lockNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      void shell.beep();
    }
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    title: ORGANIZER_TITLE,
    backgroundColor: backgroundFor(currentAppearance()),
    minWidth: 760,
    minHeight: 560,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  organizerWindow = window;
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    organizerWindow = null;
    displayWindow?.close();
  });
  lockNavigation(window);

  // Local React bundle produced by electron-vite (src/renderer -> out/renderer).
  void window.loadFile(join(__dirname, '../renderer/index.html'), { query: themeQuery(currentAppearance()) });
}

/** The large-screen window: read-only, no organizer API, one instance. */
function openDisplayWindow(focus = true): void {
  if (displayWindow && !displayWindow.isDestroyed()) {
    if (displayWindow.isMinimized()) displayWindow.restore();
    if (focus) displayWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    title: DISPLAY_TITLE,
    backgroundColor: backgroundFor(currentAppearance()),
    webPreferences: {
      preload: join(__dirname, '../preload/display.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  displayWindow = window;
  window.setMenuBarVisibility(false);
  window.once('ready-to-show', () => (focus ? window.show() : window.showInactive()));
  window.on('closed', () => {
    displayWindow = null;
  });
  lockNavigation(window);
  void window.loadFile(join(__dirname, '../renderer/display.html'), { query: themeQuery(currentAppearance()) });
}

/**
 * Renders the awards ceremony in a hidden 1920x1080 display window (no animations) and captures it.
 * The window has the display preload only, so it has no organizer API either.
 */
async function captureAwards(scope: AwardsScope): Promise<Uint8Array> {
  const window = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    useContentSize: true,
    enableLargerThanScreen: true,
    backgroundColor: backgroundFor(currentAppearance()),
    webPreferences: {
      preload: join(__dirname, '../preload/display.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      offscreen: true,
    },
  });
  const id = window.webContents.id;
  captureScopes.set(id, scope);
  try {
    lockNavigation(window);
    window.webContents.setFrameRate(30);
    await window.loadFile(join(__dirname, '../renderer/display.html'), { query: { still: '1', ...themeQuery(currentAppearance()) } });
    await window.webContents.executeJavaScript(
      `new Promise((resolve) => { const t0 = Date.now(); const check = () => (document.querySelector('[data-ready="awards"]') || Date.now() - t0 > 5000) ? setTimeout(resolve, 300) : setTimeout(check, 50); check(); })`,
    );
    const image = await window.webContents.capturePage();
    return image.toPNG();
  } finally {
    captureScopes.delete(id);
    window.destroy();
  }
}

function awardsPayload(scope: AwardsScope): DisplayPayload | null {
  if (!db) return null;
  const awards = getAwards(db, scope);
  return { appearance: currentAppearance(), sessionName: awards.scopeLabel, model: { courts: [], queue: [] }, awards };
}

app.whenReady().then(() => {
  configureAbout();
  buildMenu();
  // Opening the database runs migrations; the renderer then asks for unfinished sessions to resume.
  store.open();
  nativeTheme.themeSource = currentAppearance().mode;
  nativeTheme.on('updated', () => refreshBackgrounds(currentAppearance()));
  const handlers = createApiHandlers(store, host);
  for (const method of API_METHODS) {
    ipcMain.handle(`api:${method}`, (_event, ...args: unknown[]) => handlers[method](...args));
  }
  ipcMain.handle('display:model', (event): DisplayPayload => {
    const appearance = currentAppearance();
    const idle: DisplayPayload = { appearance, sessionName: null, model: null };
    try {
      const captureScope = captureScopes.get(event.sender.id);
      if (captureScope) return awardsPayload(captureScope) ?? idle;
      if (displayMode.kind === 'awards') return awardsPayload(displayMode.scope) ?? idle;
      if (displayMode.kind === 'ceremony') {
        const { report, state } = displayMode;
        return { appearance, sessionName: report.scopeLabel, model: { courts: [], queue: [] }, ceremony: { report, state } };
      }
    } catch {
      return idle;
    }
    if (!db || displaySessionId === null) return idle;
    try {
      const sessionName = loadSessionState(db, displaySessionId).session.name;
      return {
        appearance,
        sessionName,
        model: readDisplayModel(db, displaySessionId),
        courtExtras: readCourtExtras(db, displaySessionId),
      };
    } catch {
      return idle;
    }
  });
  blockRemoteRequests(electronSession.defaultSession);
  createWindow();
  app.on('activate', () => {
    if (!organizerWindow) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  db?.close();
  db = null;
});
