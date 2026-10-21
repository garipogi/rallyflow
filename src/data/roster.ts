import type { Db } from './db';
import { withTransaction } from './db';
import { DuplicatePlayerError, SessionStateError, ValidationError } from './errors';
import { assertSessionWritable } from './guards';
import { assertNoDuplicateName, getPlayer, insertPlayer, toPlayer } from './players';
import { nowIso, raw } from './sqlite';
import type { Availability, RosterEntry } from './types';

interface RosterRow {
  session_id: string;
  player_id: string;
  checked_in_at: string | null;
  availability_status: Availability;
  display_name: string;
  nickname: string | null;
  skill_level: number | null;
  active: number;
}

const ROSTER_SELECT = `
  SELECT sp.session_id, sp.player_id, sp.checked_in_at, sp.availability_status,
         p.id, p.display_name, p.nickname, p.skill_level, p.active
  FROM session_players sp JOIN players p ON p.id = sp.player_id`;

function toEntry(row: RosterRow & { id: string }): RosterEntry {
  return {
    sessionId: row.session_id,
    playerId: row.player_id,
    player: toPlayer(row),
    checkedInAt: row.checked_in_at,
    availability: row.availability_status,
  };
}

function getEntry(db: Db, sessionId: string, playerId: string): RosterEntry | null {
  const row = raw(db)
    .prepare(`${ROSTER_SELECT} WHERE sp.session_id = ? AND sp.player_id = ?`)
    .get(sessionId, playerId) as (RosterRow & { id: string }) | undefined;
  return row ? toEntry(row) : null;
}

function requireEntry(db: Db, sessionId: string, playerId: string): RosterEntry {
  const entry = getEntry(db, sessionId, playerId);
  if (!entry) throw new ValidationError(`Player ${playerId} is not on this session's roster.`);
  return entry;
}

function insertRosterRow(db: Db, sessionId: string, playerId: string): RosterEntry {
  raw(db)
    .prepare("INSERT INTO session_players (session_id, player_id, checked_in_at, availability_status) VALUES (?, ?, NULL, 'absent')")
    .run(sessionId, playerId);
  return requireEntry(db, sessionId, playerId);
}

/** Deliberately choose an existing registry player for this session. */
export function addPlayerToSession(db: Db, sessionId: string, playerId: string): RosterEntry {
  return withTransaction(db, () => {
    assertSessionWritable(db, sessionId);
    const player = getPlayer(db, playerId);
    if (!player) throw new ValidationError(`Unknown player: ${playerId}`);
    if (getEntry(db, sessionId, playerId)) {
      throw new DuplicatePlayerError(`${player.displayName} is already on this session's roster.`, [player]);
    }
    return insertRosterRow(db, sessionId, playerId);
  });
}

/** Create a registry player and add them, refusing accidental duplicates (brief §6). */
export function addNewPlayerToSession(
  db: Db,
  sessionId: string,
  input: { displayName: string; nickname?: string | null; skillLevel?: number | null; allowDuplicateName?: boolean },
): RosterEntry {
  return withTransaction(db, () => {
    assertSessionWritable(db, sessionId);
    assertNoDuplicateName(db, input);
    const player = insertPlayer(db, input);
    return insertRosterRow(db, sessionId, player.id);
  });
}

export function listRoster(db: Db, sessionId: string): RosterEntry[] {
  const rows = raw(db)
    .prepare(`${ROSTER_SELECT} WHERE sp.session_id = ? ORDER BY sp.rowid`)
    .all(sessionId) as (RosterRow & { id: string })[];
  return rows.map(toEntry);
}

export function checkInPlayer(db: Db, sessionId: string, playerId: string, at?: string): RosterEntry {
  return withTransaction(db, () => {
    assertSessionWritable(db, sessionId);
    requireEntry(db, sessionId, playerId);
    raw(db)
      .prepare("UPDATE session_players SET checked_in_at = ?, availability_status = 'available' WHERE session_id = ? AND player_id = ?")
      .run(at ?? nowIso(), sessionId, playerId);
    return requireEntry(db, sessionId, playerId);
  });
}

export function setAvailability(
  db: Db,
  sessionId: string,
  playerId: string,
  availability: 'available' | 'resting' | 'unavailable',
): RosterEntry {
  return withTransaction(db, () => {
    assertSessionWritable(db, sessionId);
    requireEntry(db, sessionId, playerId);
    if (availability !== 'available' && availability !== 'resting' && availability !== 'unavailable') {
      throw new ValidationError(`Unknown availability: ${String(availability)}`);
    }
    raw(db)
      .prepare('UPDATE session_players SET availability_status = ? WHERE session_id = ? AND player_id = ?')
      .run(availability, sessionId, playerId);
    return requireEntry(db, sessionId, playerId);
  });
}

/** Leaves the roster only; games, participants and score events are untouched (brief §6). */
export function removePlayerFromSession(db: Db, sessionId: string, playerId: string): void {
  withTransaction(db, () => {
    assertSessionWritable(db, sessionId);
    requireEntry(db, sessionId, playerId);
    const playing = raw(db)
      .prepare(
        `SELECT 1 FROM game_participants gp JOIN games g ON g.id = gp.game_id
         WHERE g.session_id = ? AND gp.player_id = ? AND g.status = 'in_progress' LIMIT 1`,
      )
      .get(sessionId, playerId);
    if (playing) throw new SessionStateError('A player in a game in progress cannot be removed from the roster.');
    raw(db).prepare('DELETE FROM session_players WHERE session_id = ? AND player_id = ?').run(sessionId, playerId);
  });
}
