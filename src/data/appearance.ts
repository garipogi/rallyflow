import { normalizeAppearance, isThemeId, isThemeMode, type Appearance } from '../shared/themes';
import { ValidationError } from './errors';
import { raw } from './sqlite';

const KEY = 'appearance';

/** The organizer's light/dark mode and colour theme; defaults until changed. */
export function getAppearance(db: Parameters<typeof raw>[0]): Appearance {
  const row = raw(db).prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (!row) return normalizeAppearance(null);
  try {
    return normalizeAppearance(JSON.parse(row.value) as unknown);
  } catch {
    return normalizeAppearance(null);
  }
}

export function setAppearance(db: Parameters<typeof raw>[0], input: unknown): Appearance {
  const v = (input ?? {}) as { mode?: unknown; theme?: unknown };
  if (!isThemeMode(v.mode)) throw new ValidationError('Choose light, dark or system mode.');
  if (!isThemeId(v.theme)) throw new ValidationError('Choose one of the colour themes.');
  const next: Appearance = { mode: v.mode, theme: v.theme };
  raw(db)
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(KEY, JSON.stringify(next));
  return next;
}
