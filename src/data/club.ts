import type { Db } from './db';
import { ValidationError } from './errors';
import { raw } from './sqlite';
import { getSession } from './sessions';
import {
  ClubNameError,
  normalizeClub,
  resolveClub,
  validateClub,
  validateSessionClubName,
  type ClubBranding,
  type ClubInfo,
  type ClubSettings,
} from '../shared/club';

/**
 * The club or group name for the awards (settings table): one global name and tagline, plus an
 * optional per-session name override stored as its own small JSON setting.
 */

const KEY = 'club_name';
const sessionKey = (sessionId: string): string => `club_name:session:${sessionId}`;

function read(db: Db, key: string): unknown {
  const row = raw(db).prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

function write(db: Db, key: string, value: unknown): void {
  raw(db)
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function checked<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ClubNameError) throw new ValidationError(err.message);
    throw err;
  }
}

export function getClubSettings(db: Db): ClubSettings {
  return normalizeClub(read(db, KEY));
}

function sessionOverride(db: Db, sessionId: string | null): string {
  if (!sessionId) return '';
  const stored = read(db, sessionKey(sessionId)) as { name?: unknown } | null;
  try {
    return validateSessionClubName(stored?.name);
  } catch {
    return '';
  }
}

/** The club settings plus this session's override (for the editor). */
export function getClub(db: Db, sessionId: unknown = null): ClubInfo {
  const id = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
  return { ...getClubSettings(db), sessionName: sessionOverride(db, id) };
}

/** Saves the global club name and tagline ('' clears them). */
export function setClub(db: Db, value: unknown): ClubSettings {
  const club = checked(() => validateClub(value));
  write(db, KEY, club);
  return club;
}

/** Saves (or clears with '') one session's name override. */
export function setSessionClubName(db: Db, sessionId: unknown, name: unknown): ClubInfo {
  if (typeof sessionId !== 'string' || !getSession(db, sessionId)) {
    throw new ValidationError('Choose a session for the name override.');
  }
  const clean = checked(() => validateSessionClubName(name));
  if (clean === '') raw(db).prepare('DELETE FROM settings WHERE key = ?').run(sessionKey(sessionId));
  else write(db, sessionKey(sessionId), { name: clean });
  return getClub(db, sessionId);
}

/** The name and tagline in effect for a session (or all time when null). */
export function getClubBranding(db: Db, sessionId: string | null): ClubBranding {
  return resolveClub(getClubSettings(db), sessionOverride(db, sessionId));
}
