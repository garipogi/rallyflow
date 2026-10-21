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
import { SessionStateError, ValidationError } from '../../src/data/errors';
import type { Court, Game, Session } from '../../src/data/types';
import { createSession, getSession, listSessions, loadSessionState } from '../../src/data/sessions';
import { listCourts, setCourtCount, setCourtStatus } from '../../src/data/courts';
import {
  addNewPlayerToSession,
  addPlayerToSession,
  checkInPlayer,
  listRoster,
  setAvailability,
} from '../../src/data/roster';
import { createGame, listActiveGames, listGames, markGameIncomplete } from '../../src/data/games';

let dir = '';
const opened: Db[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbop-p1-capacity-'));
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
  return openAt(join(dir, 'capacity.db'));
}

function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

interface Seeded {
  session: Session;
  ids: string[];
  courts: Court[];
}

function seed(db: Db, players: number, courtCount: number, checkIn = true): Seeded {
  const session = createSession(db, { name: 'Tuesday open play', courtCount });
  const ids: string[] = [];
  for (let i = 0; i < players; i++) {
    const entry = addNewPlayerToSession(db, session.id, { displayName: `Player ${i + 1}` });
    if (checkIn) checkInPlayer(db, session.id, entry.playerId);
    ids.push(entry.playerId);
  }
  return { session, ids, courts: listCourts(db, session.id) };
}

function doubles(db: Db, s: Seeded, courtIndex: number, playerIds: string[]): Game {
  return createGame(db, {
    sessionId: s.session.id,
    courtId: must(s.courts[courtIndex], `court ${courtIndex}`).id,
    format: 'doubles',
    teamA: [must(playerIds[0]), must(playerIds[1])],
    teamB: [must(playerIds[2]), must(playerIds[3])],
  });
}

describe('AC-02 Capacity: 32 players and four courts can be managed in one session', () => {
  it('one session holds 32 checked-in players with distinct ids and 4 distinct courts', () => {
    const db = openDb();
    const s = seed(db, 32, 4);
    const roster = listRoster(db, s.session.id);
    expect(roster).toHaveLength(32);
    expect(new Set(roster.map((r) => r.playerId)).size).toBe(32);
    expect(roster.every((r) => r.availability === 'available')).toBe(true);
    expect(roster.every((r) => typeof r.checkedInAt === 'string' && r.checkedInAt.length > 0)).toBe(true);
    expect(roster.every((r) => r.player.id === r.playerId)).toBe(true);

    expect(s.courts).toHaveLength(4);
    expect(new Set(s.courts.map((c) => c.id)).size).toBe(4);
    expect(new Set(s.courts.map((c) => c.label)).size).toBe(4);
    expect(s.courts.every((c) => c.sessionId === s.session.id && c.status === 'available')).toBe(true);
    expect(must(getSession(db, s.session.id)).courtCount).toBe(4);
  });

  it('four doubles games run at once on four courts with 16 distinct players; 16 remain waiting', () => {
    const db = openDb();
    const s = seed(db, 32, 4);
    const games: Game[] = [];
    for (let c = 0; c < 4; c++) games.push(doubles(db, s, c, s.ids.slice(c * 4, c * 4 + 4)));

    const active = listActiveGames(db, s.session.id);
    expect(active).toHaveLength(4);
    expect(new Set(active.map((g) => g.courtId))).toEqual(new Set(s.courts.map((c) => c.id)));
    for (const g of active) {
      expect(g.status).toBe('in_progress');
      expect(g.format).toBe('doubles');
      expect(g.teamAScore).toBe(0);
      expect(g.teamBScore).toBe(0);
      expect(g.participants).toHaveLength(4);
      expect(g.participants.filter((p) => p.team === 'A')).toHaveLength(2);
      expect(g.participants.filter((p) => p.team === 'B')).toHaveLength(2);
    }
    const playing = new Set(active.flatMap((g) => g.participants.map((p) => p.playerId)));
    expect(playing.size).toBe(16);
    expect(playing).toEqual(new Set(s.ids.slice(0, 16)));
    expect(listRoster(db, s.session.id)).toHaveLength(32);

    // participants are recorded on the right team
    const first = must(games[0]);
    const teamA = first.participants.filter((p) => p.team === 'A').map((p) => p.playerId).sort();
    expect(teamA).toEqual([must(s.ids[0]), must(s.ids[1])].sort());
    expect(first.participants.every((p) => Number.isInteger(p.startingPosition))).toBe(true);
  });

  it('a fifth simultaneous game is rejected: active games never exceed the configured courts', () => {
    const db = openDb();
    const s = seed(db, 32, 4);
    for (let c = 0; c < 4; c++) doubles(db, s, c, s.ids.slice(c * 4, c * 4 + 4));
    const free = s.ids.slice(16, 20);
    for (let c = 0; c < 4; c++) expect(() => doubles(db, s, c, free)).toThrow();
    expect(listActiveGames(db, s.session.id)).toHaveLength(4);
    expect(listGames(db, s.session.id)).toHaveLength(4);
  });

  it('a court that frees up can take the next game (waiting players get on)', () => {
    const db = openDb();
    const s = seed(db, 32, 4);
    const games: Game[] = [];
    for (let c = 0; c < 4; c++) games.push(doubles(db, s, c, s.ids.slice(c * 4, c * 4 + 4)));
    markGameIncomplete(db, must(games[2]).id, 'rain');
    const next = doubles(db, s, 2, s.ids.slice(16, 20));
    expect(next.courtId).toBe(must(s.courts[2]).id);
    expect(listActiveGames(db, s.session.id)).toHaveLength(4);
    expect(listGames(db, s.session.id)).toHaveLength(5);
  });

  it('four singles games run at once on four courts with 8 players', () => {
    const db = openDb();
    const s = seed(db, 32, 4);
    for (let c = 0; c < 4; c++) {
      const g = createGame(db, {
        sessionId: s.session.id,
        courtId: must(s.courts[c]).id,
        format: 'singles',
        teamA: [must(s.ids[c * 2])],
        teamB: [must(s.ids[c * 2 + 1])],
      });
      expect(g.participants).toHaveLength(2);
      expect(g.format).toBe('singles');
    }
    expect(listActiveGames(db, s.session.id)).toHaveLength(4);
  });

  it('the full 32-player, 4-court state survives closing and reopening the database', () => {
    const file = join(dir, 'capacity-reopen.db');
    const db = openAt(file);
    const s = seed(db, 32, 4);
    for (let c = 0; c < 4; c++) doubles(db, s, c, s.ids.slice(c * 4, c * 4 + 4));
    db.close();
    const again = openAt(file);
    const state = loadSessionState(again, s.session.id);
    expect(state.roster).toHaveLength(32);
    expect(state.courts).toHaveLength(4);
    expect(state.games.filter((g) => g.status === 'in_progress')).toHaveLength(4);
  });

  it('a player cannot be in two active games, and a court cannot host two active games', () => {
    const db = openDb();
    const s = seed(db, 12, 3);
    doubles(db, s, 0, s.ids.slice(0, 4));
    // player 1 again, on another court
    expect(() => doubles(db, s, 1, [must(s.ids[0]), must(s.ids[4]), must(s.ids[5]), must(s.ids[6])])).toThrow();
    // same court, all-new players
    expect(() => doubles(db, s, 0, s.ids.slice(8, 12))).toThrow();
    expect(listGames(db, s.session.id)).toHaveLength(1);
  });

  it('team sizes and distinct players are enforced', () => {
    const db = openDb();
    const s = seed(db, 8, 2);
    const base = { sessionId: s.session.id, courtId: must(s.courts[0]).id };
    const [a, b, c, d, e] = [must(s.ids[0]), must(s.ids[1]), must(s.ids[2]), must(s.ids[3]), must(s.ids[4])];
    expect(() => createGame(db, { ...base, format: 'doubles', teamA: [a, b], teamB: [c] })).toThrow();
    expect(() => createGame(db, { ...base, format: 'doubles', teamA: [a, b, e], teamB: [c, d] })).toThrow();
    expect(() => createGame(db, { ...base, format: 'singles', teamA: [a, b], teamB: [c, d] })).toThrow();
    expect(() => createGame(db, { ...base, format: 'singles', teamA: [a], teamB: [] })).toThrow();
    expect(() => createGame(db, { ...base, format: 'doubles', teamA: [a, b], teamB: [c, a] })).toThrow();
    expect(() => createGame(db, { ...base, format: 'singles', teamA: [a], teamB: [a] })).toThrow();
    expect(() => createGame(db, { ...base, format: 'doubles', teamA: [a, b], teamB: [c, 'no-such-player'] })).toThrow();
    expect(listGames(db, s.session.id)).toHaveLength(0);
  });

  it('a player from another session who is not on this roster cannot be assigned here', () => {
    const db = openDb();
    const s = seed(db, 3, 2);
    const other = createSession(db, { name: 'Other night', courtCount: 2 });
    const outsider = addNewPlayerToSession(db, other.id, { displayName: 'Outsider' });
    checkInPlayer(db, other.id, outsider.playerId);
    expect(() => doubles(db, s, 0, [...s.ids, outsider.playerId])).toThrow();
    expect(listGames(db, s.session.id)).toHaveLength(0);
  });

  it('players can be added and checked in after play has started', () => {
    const db = openDb();
    const s = seed(db, 8, 2);
    doubles(db, s, 0, s.ids.slice(0, 4));
    const late = addNewPlayerToSession(db, s.session.id, { displayName: 'Late Arrival' });
    expect(late.availability).toBe('absent');
    expect(late.checkedInAt).toBeNull();
    const checked = checkInPlayer(db, s.session.id, late.playerId, '2026-10-21T19:45:00.000Z');
    expect(checked.availability).toBe('available');
    expect(checked.checkedInAt).not.toBeNull();
    expect(listRoster(db, s.session.id)).toHaveLength(9);
    const g = doubles(db, s, 1, [late.playerId, ...s.ids.slice(4, 7)]);
    expect(g.participants.map((p) => p.playerId)).toContain(late.playerId);
  });
});

describe('AC-02 Check-in and availability: absent, resting or unavailable players cannot play', () => {
  it('a player who has not checked in cannot be assigned', () => {
    const db = openDb();
    const s = seed(db, 4, 2, false);
    checkInPlayer(db, s.session.id, must(s.ids[0]));
    checkInPlayer(db, s.session.id, must(s.ids[1]));
    checkInPlayer(db, s.session.id, must(s.ids[2]));
    expect(() => doubles(db, s, 0, s.ids)).toThrow();
    checkInPlayer(db, s.session.id, must(s.ids[3]));
    expect(doubles(db, s, 0, s.ids).status).toBe('in_progress');
  });

  it('resting and unavailable players are skipped until they are available again', () => {
    const db = openDb();
    const s = seed(db, 4, 2);
    const resting = setAvailability(db, s.session.id, must(s.ids[1]), 'resting');
    expect(resting.availability).toBe('resting');
    expect(() => doubles(db, s, 0, s.ids)).toThrow();

    setAvailability(db, s.session.id, must(s.ids[1]), 'available');
    setAvailability(db, s.session.id, must(s.ids[3]), 'unavailable');
    expect(() => doubles(db, s, 0, s.ids)).toThrow();
    expect(listGames(db, s.session.id)).toHaveLength(0);

    setAvailability(db, s.session.id, must(s.ids[3]), 'available');
    expect(doubles(db, s, 0, s.ids).status).toBe('in_progress');
  });

  it('availability is per session: the same player can rest in one session and play in another', () => {
    const db = openDb();
    const s1 = seed(db, 4, 2);
    const s2 = createSession(db, { name: 'Thursday', courtCount: 2 });
    for (const id of s1.ids) {
      addPlayerToSession(db, s2.id, id);
      checkInPlayer(db, s2.id, id);
    }
    setAvailability(db, s1.session.id, must(s1.ids[0]), 'resting');
    const inS1 = listRoster(db, s1.session.id).find((r) => r.playerId === s1.ids[0]);
    const inS2 = listRoster(db, s2.id).find((r) => r.playerId === s1.ids[0]);
    expect(must(inS1).availability).toBe('resting');
    expect(must(inS2).availability).toBe('available');
    const g = createGame(db, {
      sessionId: s2.id,
      courtId: must(listCourts(db, s2.id)[0]).id,
      format: 'doubles',
      teamA: [must(s1.ids[0]), must(s1.ids[1])],
      teamB: [must(s1.ids[2]), must(s1.ids[3])],
    });
    expect(g.sessionId).toBe(s2.id);
  });
});

describe('AC-02 Court configuration: 2 to 4 courts per session', () => {
  it.each([2, 3, 4])('a session can be created with %i courts', (n) => {
    const db = openDb();
    const s = createSession(db, { name: `${n} courts`, courtCount: n });
    expect(s.courtCount).toBe(n);
    const courts = listCourts(db, s.id);
    expect(courts).toHaveLength(n);
    expect(new Set(courts.map((c) => c.id)).size).toBe(n);
  });

  it.each([0, 1, 5, 2.5, -3])('courtCount %s is rejected and nothing is written', (n) => {
    const db = openDb();
    expect(() => createSession(db, { name: 'bad', courtCount: n })).toThrow(ValidationError);
    expect(listSessions(db)).toHaveLength(0);
  });

  it('session defaults: target 11, win by 2, side-out scoring, active', () => {
    const db = openDb();
    const s = createSession(db, { name: 'Defaults', courtCount: 2 });
    expect(s.targetScore).toBe(11);
    expect(s.winBy).toBe(2);
    expect(s.scoringMode).toBe('side_out');
    expect(s.status).toBe('active');
    expect(s.endedAt).toBeNull();
    const fifteen = createSession(db, { name: 'To 15', courtCount: 3, targetScore: 15 });
    expect(must(getSession(db, fifteen.id)).targetScore).toBe(15);
  });

  it('growing the court count keeps existing court ids; shrinking drops the highest-numbered courts', () => {
    const db = openDb();
    const s = createSession(db, { name: 'Resize', courtCount: 2 });
    const original = listCourts(db, s.id).map((c) => c.id);
    const grown = setCourtCount(db, s.id, 4);
    expect(grown).toHaveLength(4);
    expect(grown.slice(0, 2).map((c) => c.id)).toEqual(original);
    expect(listCourts(db, s.id)).toHaveLength(4);
    expect(must(getSession(db, s.id)).courtCount).toBe(4);

    const shrunk = setCourtCount(db, s.id, 3);
    expect(shrunk.map((c) => c.id)).toEqual(grown.slice(0, 3).map((c) => c.id));
    expect(listCourts(db, s.id)).toHaveLength(3);
    expect(must(getSession(db, s.id)).courtCount).toBe(3);
  });

  it.each([1, 5, 0, 3.5])('setCourtCount(%s) is rejected and the configuration is unchanged', (n) => {
    const db = openDb();
    const s = createSession(db, { name: 'Resize bad', courtCount: 3 });
    expect(() => setCourtCount(db, s.id, n)).toThrow(ValidationError);
    expect(listCourts(db, s.id)).toHaveLength(3);
    expect(must(getSession(db, s.id)).courtCount).toBe(3);
  });

  it('a court with a game in progress cannot be removed by shrinking', () => {
    const db = openDb();
    const s = seed(db, 4, 4);
    doubles(db, s, 3, s.ids);
    expect(() => setCourtCount(db, s.session.id, 3)).toThrow(SessionStateError);
    expect(listCourts(db, s.session.id)).toHaveLength(4);
    expect(listActiveGames(db, s.session.id)).toHaveLength(1);
  });

  it('an unavailable court cannot be assigned until it is available again', () => {
    const db = openDb();
    const s = seed(db, 4, 2);
    const court = must(s.courts[1]);
    expect(setCourtStatus(db, court.id, 'unavailable').status).toBe('unavailable');
    expect(must(listCourts(db, s.session.id)[1]).status).toBe('unavailable');
    expect(() => doubles(db, s, 1, s.ids)).toThrow();
    expect(listGames(db, s.session.id)).toHaveLength(0);
    setCourtStatus(db, court.id, 'available');
    expect(doubles(db, s, 1, s.ids).courtId).toBe(court.id);
  });

  it('a court belonging to another session cannot be used', () => {
    const db = openDb();
    const s = seed(db, 4, 2);
    const other = createSession(db, { name: 'Elsewhere', courtCount: 2 });
    const foreignCourt = must(listCourts(db, other.id)[0]);
    expect(() =>
      createGame(db, {
        sessionId: s.session.id,
        courtId: foreignCourt.id,
        format: 'doubles',
        teamA: [must(s.ids[0]), must(s.ids[1])],
        teamB: [must(s.ids[2]), must(s.ids[3])],
      }),
    ).toThrow();
    expect(listGames(db, s.session.id)).toHaveLength(0);
    expect(listGames(db, other.id)).toHaveLength(0);
  });
});
