/**
 * The product's public name and copy, shared by the main process (window titles, About panel,
 * default file names) and both renderer windows (header lockup, display header, certificates).
 *
 * The internal package name stays "pickleball-open-play": it names the data folder
 * (~/Library/Application Support/pickleball-open-play, %APPDATA%\pickleball-open-play), so existing
 * sessions keep working after the rename.
 */
export const BRAND = {
  name: 'RallyFlow',
  tagline: 'Every game. Every player. In rhythm.',
  descriptor: 'Offline Pickleball Open Play Manager',
  copyright: '© 2026 RallyFlow',
} as const;

/** Organizer window title. It keeps "Pickleball Open Play" so people searching their windows find it. */
export const ORGANIZER_TITLE = `${BRAND.name} — Pickleball Open Play`;

/** Large-screen window title. */
export const DISPLAY_TITLE = `${BRAND.name} Display — Pickleball Open Play`;

/** Prefix for files the app suggests when saving (exports, backups, images, certificates). */
export const FILE_PREFIX = BRAND.name;
