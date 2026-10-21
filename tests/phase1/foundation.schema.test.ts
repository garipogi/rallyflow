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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SCHEMA_VERSION,
  getSchemaVersion,
  listIndexes,
  listTables,
  migrate,
  openDatabase,
  type Db,
} from '../../src/data/db';
import type { IndexInfo } from '../../src/data/types';
import { createSession, listSessions, loadSessionState } from '../../src/data/sessions';
import { addNewPlayerToSession, checkInPlayer } from '../../src/data/roster';
import { listCourts } from '../../src/data/courts';
import { appendScoreEvent, createGame, listScoreEvents } from '../../src/data/games';

let dir = '';
const opened: Db[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbop-p1-schema-'));
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

function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

const REQUIRED_TABLES = [
  'sessions',
  'players',
  'session_players',
  'courts',
  'games',
  'game_participants',
  'score_events',
  'rotation_events',
  'audit_events',
  'settings',
];

function hasLeadingIndex(indexes: IndexInfo[], table: string, column: string): boolean {
  return indexes.some((ix) => ix.table === table && ix.columns[0] === column);
}

function indexSignature(indexes: IndexInfo[]): string[] {
  return indexes.map((ix) => `${ix.table}:${ix.name}:${ix.columns.join(',')}`).sort();
}

function seedSmall(db: Db): { sessionId: string; gameId: string } {
  const session = createSession(db, { name: 'Migration check', courtCount: 2 });
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const entry = addNewPlayerToSession(db, session.id, { displayName: `Migrant ${i + 1}` });
    checkInPlayer(db, session.id, entry.playerId);
    ids.push(entry.playerId);
  }
  const court = must(listCourts(db, session.id)[0], 'court');
  const game = createGame(db, {
    sessionId: session.id,
    courtId: court.id,
    format: 'doubles',
    teamA: [must(ids[0]), must(ids[1])],
    teamB: [must(ids[2]), must(ids[3])],
  });
  appendScoreEvent(db, game.id, { eventType: 'rally', eventData: { winner: 'A' } });
  return { sessionId: session.id, gameId: game.id };
}

describe('AC-11 Startup: schema version and migrations', () => {
  it('a fresh database is migrated to the current schema version, stored in the file', () => {
    const file = join(dir, 'fresh.db');
    const db = openAt(file);
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
    const again = openAt(file);
    expect(getSchemaVersion(again)).toBe(SCHEMA_VERSION);
  });

  it('the schema has a table for every brief §7 entity plus settings', () => {
    const db = openAt(join(dir, 'tables.db'));
    const tables = listTables(db);
    for (const t of REQUIRED_TABLES) expect(tables, `missing table ${t}`).toContain(t);
  });

  it('indexes exist for player history, sessions, active games and event retrieval', () => {
    const db = openAt(join(dir, 'indexes.db'));
    const ix = listIndexes(db);
    // player history: game_participants looked up by player
    expect(hasLeadingIndex(ix, 'game_participants', 'player_id')).toBe(true);
    // games of a session
    expect(hasLeadingIndex(ix, 'games', 'session_id')).toBe(true);
    // active games: some index on games covers status
    expect(ix.some((i) => i.table === 'games' && i.columns.includes('status'))).toBe(true);
    // sessions list / unfinished-session lookup
    expect(hasLeadingIndex(ix, 'sessions', 'status') || hasLeadingIndex(ix, 'sessions', 'started_at')).toBe(true);
    // event retrieval
    expect(hasLeadingIndex(ix, 'score_events', 'game_id')).toBe(true);
    expect(hasLeadingIndex(ix, 'rotation_events', 'session_id')).toBe(true);
    expect(hasLeadingIndex(ix, 'audit_events', 'session_id')).toBe(true);
  });

  it('migrate() is idempotent: running it repeatedly changes neither schema nor data', () => {
    const db = openAt(join(dir, 'idem.db'));
    const { sessionId, gameId } = seedSmall(db);
    const tablesBefore = [...listTables(db)].sort();
    const indexesBefore = indexSignature(listIndexes(db));
    const stateBefore = loadSessionState(db, sessionId);
    const eventsBefore = listScoreEvents(db, gameId);

    migrate(db);
    migrate(db);
    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect([...listTables(db)].sort()).toEqual(tablesBefore);
    expect(indexSignature(listIndexes(db))).toEqual(indexesBefore);
    expect(loadSessionState(db, sessionId)).toEqual(stateBefore);
    expect(listScoreEvents(db, gameId)).toEqual(eventsBefore);
  });

  it('reopening an existing database file repeatedly keeps version, schema and data intact', () => {
    const file = join(dir, 'reopen.db');
    const first = openAt(file);
    const { sessionId, gameId } = seedSmall(first);
    const stateBefore = loadSessionState(first, sessionId);
    const eventsBefore = listScoreEvents(first, gameId);
    const indexesBefore = indexSignature(listIndexes(first));
    first.close();

    for (let i = 0; i < 3; i++) {
      const db = openAt(file);
      expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(indexSignature(listIndexes(db))).toEqual(indexesBefore);
      expect(listSessions(db)).toHaveLength(1);
      expect(loadSessionState(db, sessionId)).toEqual(stateBefore);
      expect(listScoreEvents(db, gameId)).toEqual(eventsBefore);
      db.close();
    }
  });

  it('an existing empty database file is migrated in place', () => {
    const file = join(dir, 'empty.db');
    writeFileSync(file, '');
    const db = openAt(file);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    for (const t of REQUIRED_TABLES) expect(listTables(db)).toContain(t);
  });

  it('a file that is not an SQLite database is refused and left byte-for-byte untouched', () => {
    const file = join(dir, 'not-a-db.db');
    const junk = Buffer.from('This is a shopping list, not a database.\n'.repeat(200), 'utf8');
    writeFileSync(file, junk);
    expect(() => openAt(file)).toThrow();
    expect(readFileSync(file).equals(junk)).toBe(true);
  });
});
