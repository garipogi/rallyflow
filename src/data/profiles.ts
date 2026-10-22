/**
 * D18 player profile fields: optional gender (mixed doubles) and skill pool (skill pools).
 *
 * Stored in the settings table as validated JSON under `player_profile:<playerId>` instead of new
 * columns, so the locked schema contract (SCHEMA_VERSION, tables, indexes, migrations and the backup
 * schema-version checks) is unchanged. Backups copy the whole database, so profiles travel with them.
 * The skill level stays in the players table (players.skill_level).
 */
import { GENDERS, POOL_NAMES, type Gender, type PoolName } from '../core/rotation';
import type { Db } from './db';
import { withTransaction } from './db';
import { ValidationError } from './errors';
import { getPlayer, updatePlayer } from './players';
import { raw } from './sqlite';
import type { Player } from './types';

export interface PlayerProfile {
  gender: Gender | null;
  pool: PoolName | null;
}

export interface PlayerDetails extends PlayerProfile {
  playerId: string;
  skillLevel: number | null;
}

/** Patch for updatePlayerDetails: absent = unchanged, null = clear. */
export interface PlayerDetailsPatch {
  skillLevel?: number | null;
  gender?: Gender | null;
  pool?: PoolName | null;
}

const PREFIX = 'player_profile:';
const keyOf = (playerId: string): string => `${PREFIX}${playerId}`;
const EMPTY: PlayerProfile = { gender: null, pool: null };

/** Lowest and highest skill level accepted from the organizer (DUPR-style 1.0-8.0). */
export const SKILL_MIN = 1;
export const SKILL_MAX = 8;

function checkGender(value: unknown): Gender | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !(GENDERS as readonly string[]).includes(value)) {
    throw new ValidationError(`Gender must be male, female or not set; got ${String(value)}.`);
  }
  return value as Gender;
}

function checkPool(value: unknown): PoolName | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !(POOL_NAMES as readonly string[]).includes(value)) {
    throw new ValidationError(`Pool must be A, B, C or not set; got ${String(value)}.`);
  }
  return value as PoolName;
}

function checkSkill(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < SKILL_MIN || value > SKILL_MAX) {
    throw new ValidationError(`Skill level must be a number from ${SKILL_MIN} to ${SKILL_MAX}, or not set.`);
  }
  return Math.round(value * 100) / 100;
}

/** Parses a stored profile; anything malformed (hand-edited or from a future version) reads as not set. */
function parse(value: string): PlayerProfile {
  try {
    const data = JSON.parse(value) as { gender?: unknown; pool?: unknown };
    return {
      gender: (GENDERS as readonly unknown[]).includes(data.gender) ? (data.gender as Gender) : null,
      pool: (POOL_NAMES as readonly unknown[]).includes(data.pool) ? (data.pool as PoolName) : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function getPlayerProfile(db: Db, playerId: string): PlayerProfile {
  const row = raw(db).prepare('SELECT value FROM settings WHERE key = ?').get(keyOf(playerId)) as { value: string } | undefined;
  return row ? parse(row.value) : { ...EMPTY };
}

/** Every stored profile, by player id (players without one are absent). */
export function listPlayerProfiles(db: Db): Record<string, PlayerProfile> {
  const rows = raw(db).prepare('SELECT key, value FROM settings WHERE key LIKE ?').all(`${PREFIX}%`) as { key: string; value: string }[];
  const out: Record<string, PlayerProfile> = {};
  for (const r of rows) out[r.key.slice(PREFIX.length)] = parse(r.value);
  return out;
}

/** Sets gender and/or pool (validated); a profile with nothing set is removed. */
export function setPlayerProfile(db: Db, playerId: string, patch: { gender?: Gender | null; pool?: PoolName | null }): PlayerProfile {
  return withTransaction(db, () => {
    if (!getPlayer(db, playerId)) throw new ValidationError(`Unknown player: ${playerId}`);
    const current = getPlayerProfile(db, playerId);
    const next: PlayerProfile = {
      gender: patch.gender === undefined ? current.gender : checkGender(patch.gender),
      pool: patch.pool === undefined ? current.pool : checkPool(patch.pool),
    };
    if (next.gender === null && next.pool === null) {
      raw(db).prepare('DELETE FROM settings WHERE key = ?').run(keyOf(playerId));
    } else {
      raw(db)
        .prepare(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .run(keyOf(playerId), JSON.stringify(next));
    }
    return next;
  });
}

/** Skill level (players table) plus gender and pool (profile), validated and saved together. */
export function updatePlayerDetails(db: Db, playerId: string, patch: PlayerDetailsPatch): PlayerDetails {
  return withTransaction(db, () => {
    const current = getPlayer(db, playerId);
    if (!current) throw new ValidationError(`Unknown player: ${playerId}`);
    let player: Player = current;
    if (patch.skillLevel !== undefined) player = updatePlayer(db, playerId, { skillLevel: checkSkill(patch.skillLevel) });
    const profile = setPlayerProfile(db, playerId, {
      ...(patch.gender !== undefined ? { gender: patch.gender } : {}),
      ...(patch.pool !== undefined ? { pool: patch.pool } : {}),
    });
    return { playerId, skillLevel: player.skillLevel, ...profile };
  });
}

/** Skill level, gender and pool of every player, for the roster and the team-up guide. */
export function listPlayerDetails(db: Db): Record<string, PlayerDetails> {
  const profiles = listPlayerProfiles(db);
  const rows = raw(db).prepare('SELECT id, skill_level FROM players').all() as { id: string; skill_level: number | null }[];
  const out: Record<string, PlayerDetails> = {};
  for (const r of rows) out[r.id] = { playerId: r.id, skillLevel: r.skill_level, ...(profiles[r.id] ?? EMPTY) };
  return out;
}
