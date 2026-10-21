/*
 * ============================================================================
 * PHASE 1 PUBLIC API (pinned by the locked tests; the builder implements it).
 * Everything is synchronous (better-sqlite3 style). Ids are opaque, stable,
 * non-empty strings that never derive from names. Timestamps are ISO-8601
 * strings; every `at` / `startedAt` / `endedAt` / `occurredAt` argument is
 * optional and defaults to "now".
 *
 * For a completed session every write listed below throws SessionReadOnlyError (checked first).
 *
 * src/data/errors.ts
 *   class ValidationError extends Error            bad input: court count, team sizes, unknown ids …
 *   class DuplicatePlayerError extends Error       brief §6 duplicate entries; has `matches: Player[]`
 *   class SessionReadOnlyError extends Error       write attempted on a completed session (brief §5 E)
 *   class SessionStateError extends Error          illegal lifecycle step (finish twice, reopen an
 *                                                  active session, finish with a game in progress,
 *                                                  remove a court/player that is in an active game)
 *   class ConfirmationRequiredError extends Error  deleteSession without { confirm: true }
 *
 * src/data/types.ts
 *   Player       = { id: string; displayName: string; nickname: string | null;
 *                    skillLevel: number | null; active: boolean }
 *   Session      = { id: string; name: string; status: 'active' | 'completed'; startedAt: string;
 *                    endedAt: string | null; targetScore: number; winBy: number;
 *                    scoringMode: 'side_out'; courtCount: number }
 *   Availability = 'absent' | 'available' | 'resting' | 'unavailable'
 *   RosterEntry  = { sessionId: string; playerId: string; player: Player;
 *                    checkedInAt: string | null; availability: Availability }
 *   Court        = { id: string; sessionId: string; label: string; status: 'available' | 'unavailable' }
 *   GameFormat   = 'singles' | 'doubles'
 *   GameStatus   = 'scheduled' | 'in_progress' | 'completed' | 'incomplete' | 'cancelled'
 *   GameParticipant = { playerId: string; team: 'A' | 'B'; startingPosition: number }
 *   Game         = { id: string; sessionId: string; courtId: string; format: GameFormat;
 *                    status: GameStatus; teamAScore: number; teamBScore: number;
 *                    startedAt: string | null; endedAt: string | null; winner: 'A' | 'B' | null;
 *                    participants: GameParticipant[] }
 *   ScoreEvent   = { id: string; gameId: string; occurredAt: string; eventType: string; eventData: unknown }
 *   AuditEvent   = { id: string; sessionId: string; occurredAt: string; action: string; details: unknown }
 *   SessionState = { session: Session; roster: RosterEntry[]; courts: Court[]; games: Game[] }
 *   IndexInfo    = { name: string; table: string; columns: string[] }   columns in index order
 *
 * src/data/db.ts
 *   interface Db { close(): void }                 (a better-sqlite3 Database satisfies this)
 *   const SCHEMA_VERSION: number                   integer >= 1
 *   openDatabase(file: string): Db                 creates the file if missing, runs migrate();
 *                                                  throws (and leaves the file untouched) if the
 *                                                  file is not an SQLite database
 *   migrate(db: Db): void                          idempotent
 *   getSchemaVersion(db: Db): number               version stored inside the DB file
 *   listTables(db: Db): string[]
 *   listIndexes(db: Db): IndexInfo[]
 *   withTransaction<T>(db: Db, fn: () => T): T     all-or-nothing, rethrows; repository calls made
 *                                                  inside fn join the same transaction
 *   Required tables: sessions, players, session_players, courts, games, game_participants,
 *                    score_events, rotation_events, audit_events, settings
 *
 * src/data/players.ts
 *   createPlayer(db, { displayName: string; nickname?: string | null; skillLevel?: number | null;
 *                      allowDuplicateName?: boolean }): Player
 *       DuplicatePlayerError if findPlayersByName(displayName) is non-empty, unless allowDuplicateName
 *   getPlayer(db, id: string): Player | null
 *   listPlayers(db, opts?: { includeInactive?: boolean }): Player[]     default: active only
 *   updatePlayer(db, id: string, patch: { displayName?: string; nickname?: string | null;
 *                                         skillLevel?: number | null }): Player   id never changes
 *   findPlayersByName(db, name: string): Player[]
 *       active players whose displayName OR nickname equals `name` after trimming, collapsing
 *       inner whitespace and ignoring case
 *   deactivatePlayer(db, id: string): Player        active = false; no history is erased
 *
 * src/data/sessions.ts
 *   createSession(db, { name: string; courtCount: number; targetScore?: number; winBy?: number;
 *                       startedAt?: string }): Session
 *       courtCount must be an integer 2..4 (else ValidationError, nothing written); defaults
 *       targetScore 11, winBy 2, scoringMode 'side_out'; status 'active'; creates courtCount courts
 *   getSession(db, id: string): Session | null
 *   listSessions(db): Session[]                     every retained session, any status
 *   finishSession(db, id: string, opts?: { endedAt?: string }): Session
 *       -> 'completed' with endedAt; SessionStateError if already completed or a game is
 *          'scheduled'/'in_progress'
 *   reopenSession(db, id: string): Session          completed -> active; records AuditEvent with
 *                                                   action 'session_reopened'; SessionStateError if
 *                                                   the session is not completed
 *   deleteSession(db, id: string, opts?: { confirm?: boolean }): void
 *       ConfirmationRequiredError unless opts.confirm === true (strictly). Removes the session and
 *       its courts, roster, games, participants, score/rotation/audit events. Players remain.
 *   findUnfinishedSessions(db): Session[]           startup recovery: sessions with status 'active'
 *   loadSessionState(db, id: string): SessionState  committed state for review / recovery
 *   listAuditEvents(db, sessionId: string): AuditEvent[]
 *
 * src/data/courts.ts
 *   listCourts(db, sessionId: string): Court[]      configured courts in court-number order;
 *                                                   length === session.courtCount
 *   setCourtCount(db, sessionId: string, count: number): Court[]
 *       integer 2..4 else ValidationError. Growing keeps existing court ids; shrinking drops the
 *       highest-numbered courts; SessionStateError if a dropped court has an 'in_progress' game.
 *       Games played on a dropped court keep their courtId (history is never rewritten).
 *   setCourtStatus(db, courtId: string, status: 'available' | 'unavailable'): Court
 *
 * src/data/roster.ts
 *   addPlayerToSession(db, sessionId: string, playerId: string): RosterEntry
 *       deliberate choice of an existing player; availability 'absent', checkedInAt null;
 *       DuplicatePlayerError if that player is already on the roster
 *   addNewPlayerToSession(db, sessionId: string, { displayName: string; nickname?: string | null;
 *                         skillLevel?: number | null; allowDuplicateName?: boolean }): RosterEntry
 *       creates the player and adds them; DuplicatePlayerError (matches filled) if
 *       findPlayersByName(displayName) is non-empty, unless allowDuplicateName
 *   listRoster(db, sessionId: string): RosterEntry[]      players currently on the roster
 *   checkInPlayer(db, sessionId: string, playerId: string, at?: string): RosterEntry
 *       availability 'available', checkedInAt set
 *   setAvailability(db, sessionId: string, playerId: string,
 *                   availability: 'available' | 'resting' | 'unavailable'): RosterEntry
 *   removePlayerFromSession(db, sessionId: string, playerId: string): void
 *       SessionStateError if the player is in an 'in_progress' game; game history is kept
 *
 * src/data/games.ts
 *   createGame(db, { sessionId: string; courtId: string; format: GameFormat; teamA: string[];
 *                    teamB: string[]; startedAt?: string }): Game
 *       status 'in_progress', score 0-0, one participant per player. Atomic: on any rejection
 *       nothing is written. Rejects when: the session is completed (SessionReadOnlyError); the
 *       court is not in the session, is 'unavailable' or already hosts an 'in_progress' game;
 *       team sizes are wrong (doubles 2+2, singles 1+1); a player is repeated; a player is not
 *       on the roster, not checked in or not 'available'; a player is already in an
 *       'in_progress' game.
 *   getGame(db, id: string): Game | null
 *   listGames(db, sessionId: string): Game[]
 *   listActiveGames(db, sessionId: string): Game[]       status 'in_progress'
 *   markGameIncomplete(db, gameId: string, reason?: string): Game   'incomplete', endedAt set
 *   getPlayerGameHistory(db, playerId: string): Game[]   all games, all sessions, any status
 *   appendScoreEvent(db, gameId: string, { eventType: string; eventData?: unknown;
 *                                          occurredAt?: string }): ScoreEvent
 *       committed to disk before it returns; rejected for games of completed sessions
 *   listScoreEvents(db, gameId: string): ScoreEvent[]    in insertion order
 * ============================================================================
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, type Db } from '../../src/data/db';
import { DuplicatePlayerError } from '../../src/data/errors';
import {
  createPlayer,
  deactivatePlayer,
  findPlayersByName,
  getPlayer,
  listPlayers,
  updatePlayer,
} from '../../src/data/players';
import { createSession } from '../../src/data/sessions';
import { addNewPlayerToSession, addPlayerToSession, listRoster } from '../../src/data/roster';

let dir = '';
const opened: Db[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbop-p1-players-'));
});

afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function openAt(file: string): Db {
  const db = openDatabase(file);
  opened.push(db);
  return db;
}

function openDb(): Db {
  return openAt(join(dir, 'players.db'));
}

function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}

describe('AC-02 Player registry: stable ids, nicknames and duplicate handling', () => {
  it('each player gets a unique, non-empty id that is not derived from the name', () => {
    const db = openDb();
    const a = createPlayer(db, { displayName: 'Maria Santos' });
    const b = createPlayer(db, { displayName: 'Jun Reyes', nickname: 'JR', skillLevel: 3.5 });
    expect(typeof a.id).toBe('string');
    expect(a.id.length).toBeGreaterThan(0);
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toContain('Maria');
    expect(a.id.toLowerCase()).not.toContain('maria');
    expect(b).toMatchObject({ displayName: 'Jun Reyes', nickname: 'JR', skillLevel: 3.5, active: true });
    expect(a.nickname).toBeNull();
    expect(a.skillLevel).toBeNull();
  });

  it('renaming a player keeps the same id, and the id survives reopening the database', () => {
    const file = join(dir, 'stable.db');
    const db = openAt(file);
    const p = createPlayer(db, { displayName: 'Rob Lim' });
    const renamed = updatePlayer(db, p.id, { displayName: 'Robert Lim', nickname: 'Bobby' });
    expect(renamed.id).toBe(p.id);
    expect(renamed.displayName).toBe('Robert Lim');
    expect(renamed.nickname).toBe('Bobby');
    db.close();
    const again = openAt(file);
    expect(must(getPlayer(again, p.id))).toMatchObject({ id: p.id, displayName: 'Robert Lim', nickname: 'Bobby' });
    expect(listPlayers(again).map((x) => x.id)).toEqual([p.id]);
  });

  it('nicknames are stored, editable, clearable and searchable', () => {
    const db = openDb();
    const p = createPlayer(db, { displayName: 'Katherine Uy', nickname: 'Kat' });
    expect(findPlayersByName(db, 'kat').map((x) => x.id)).toEqual([p.id]);
    expect(findPlayersByName(db, '  KATHERINE   uy ').map((x) => x.id)).toEqual([p.id]);
    updatePlayer(db, p.id, { nickname: null });
    expect(must(getPlayer(db, p.id)).nickname).toBeNull();
    expect(findPlayersByName(db, 'Kat')).toEqual([]);
    expect(findPlayersByName(db, 'Katherine')).toEqual([]);
  });

  it('adding a new player whose name is already on the session roster is prevented', () => {
    const db = openDb();
    const s = createSession(db, { name: 'Open play', courtCount: 2 });
    const first = addNewPlayerToSession(db, s.id, { displayName: 'Alex Cruz' });
    const err = catchError(() => addNewPlayerToSession(db, s.id, { displayName: '  alex   CRUZ ' }));
    expect(err).toBeInstanceOf(DuplicatePlayerError);
    expect((err as DuplicatePlayerError).matches.map((m) => m.id)).toEqual([first.playerId]);
    expect(listRoster(db, s.id)).toHaveLength(1);
    expect(listPlayers(db)).toHaveLength(1);
  });

  it('a name that matches an existing registry player is flagged; choosing that player deliberately works', () => {
    const db = openDb();
    const existing = createPlayer(db, { displayName: 'Bea Tan', nickname: 'B' });
    const s = createSession(db, { name: 'Open play', courtCount: 2 });
    const err = catchError(() => addNewPlayerToSession(db, s.id, { displayName: 'bea tan' }));
    expect(err).toBeInstanceOf(DuplicatePlayerError);
    expect((err as DuplicatePlayerError).matches.map((m) => m.id)).toEqual([existing.id]);
    expect(listRoster(db, s.id)).toHaveLength(0);

    const entry = addPlayerToSession(db, s.id, existing.id);
    expect(entry.playerId).toBe(existing.id);
    expect(entry.player.displayName).toBe('Bea Tan');
    expect(listPlayers(db)).toHaveLength(1);
    expect(listRoster(db, s.id).map((r) => r.playerId)).toEqual([existing.id]);
  });

  it('a duplicate name is matched against nicknames too', () => {
    const db = openDb();
    const existing = createPlayer(db, { displayName: 'Alexander Go', nickname: 'Xander' });
    const s = createSession(db, { name: 'Open play', courtCount: 2 });
    expect(() => addNewPlayerToSession(db, s.id, { displayName: 'xander' })).toThrow(DuplicatePlayerError);
    expect(findPlayersByName(db, 'XANDER').map((p) => p.id)).toEqual([existing.id]);
  });

  it('the same player cannot be added to one session twice', () => {
    const db = openDb();
    const p = createPlayer(db, { displayName: 'Carlo Diaz' });
    const s = createSession(db, { name: 'Open play', courtCount: 2 });
    addPlayerToSession(db, s.id, p.id);
    expect(() => addPlayerToSession(db, s.id, p.id)).toThrow(DuplicatePlayerError);
    expect(listRoster(db, s.id)).toHaveLength(1);
  });

  it('two genuinely different people with the same name can be registered when the organizer says so', () => {
    const db = openDb();
    const s = createSession(db, { name: 'Open play', courtCount: 2 });
    const one = addNewPlayerToSession(db, s.id, { displayName: 'Dan Lee', nickname: 'Dan L (tall)' });
    const two = addNewPlayerToSession(db, s.id, {
      displayName: 'Dan Lee',
      nickname: 'Dan L (lefty)',
      allowDuplicateName: true,
    });
    expect(two.playerId).not.toBe(one.playerId);
    expect(listRoster(db, s.id)).toHaveLength(2);
    expect(findPlayersByName(db, 'dan lee').map((p) => p.id).sort()).toEqual([one.playerId, two.playerId].sort());
  });

  it('createPlayer also refuses an accidental duplicate unless allowDuplicateName is set', () => {
    const db = openDb();
    const a = createPlayer(db, { displayName: 'Ella Ong' });
    expect(() => createPlayer(db, { displayName: 'ELLA ONG' })).toThrow(DuplicatePlayerError);
    expect(listPlayers(db)).toHaveLength(1);
    const b = createPlayer(db, { displayName: 'Ella Ong', allowDuplicateName: true });
    expect(b.id).not.toBe(a.id);
    expect(listPlayers(db)).toHaveLength(2);
  });

  it('one player keeps one identity across sessions', () => {
    const db = openDb();
    const p = createPlayer(db, { displayName: 'Faye Sy' });
    const s1 = createSession(db, { name: 'Week 1', courtCount: 2 });
    const s2 = createSession(db, { name: 'Week 2', courtCount: 3 });
    addPlayerToSession(db, s1.id, p.id);
    addPlayerToSession(db, s2.id, p.id);
    expect(must(listRoster(db, s1.id)[0]).playerId).toBe(p.id);
    expect(must(listRoster(db, s2.id)[0]).playerId).toBe(p.id);
    expect(listPlayers(db)).toHaveLength(1);
  });

  it('deactivating a player hides them from the active registry without deleting them', () => {
    const db = openDb();
    const p = createPlayer(db, { displayName: 'Gus Yap' });
    const q = createPlayer(db, { displayName: 'Hana Lu' });
    const off = deactivatePlayer(db, p.id);
    expect(off.active).toBe(false);
    expect(off.id).toBe(p.id);
    expect(listPlayers(db).map((x) => x.id)).toEqual([q.id]);
    expect(listPlayers(db, { includeInactive: true }).map((x) => x.id).sort()).toEqual([p.id, q.id].sort());
    expect(must(getPlayer(db, p.id))).toMatchObject({ id: p.id, displayName: 'Gus Yap', active: false });
  });
});
