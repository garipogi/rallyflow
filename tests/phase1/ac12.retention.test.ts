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
import { ConfirmationRequiredError, SessionReadOnlyError, SessionStateError } from '../../src/data/errors';
import type { Court, Game, Session } from '../../src/data/types';
import {
  createSession,
  deleteSession,
  findUnfinishedSessions,
  finishSession,
  getSession,
  listAuditEvents,
  listSessions,
  loadSessionState,
  reopenSession,
} from '../../src/data/sessions';
import { createPlayer, deactivatePlayer, getPlayer, listPlayers } from '../../src/data/players';
import { listCourts, setCourtCount, setCourtStatus } from '../../src/data/courts';
import {
  addNewPlayerToSession,
  addPlayerToSession,
  checkInPlayer,
  listRoster,
  removePlayerFromSession,
  setAvailability,
} from '../../src/data/roster';
import {
  appendScoreEvent,
  createGame,
  getGame,
  getPlayerGameHistory,
  listGames,
  listScoreEvents,
  markGameIncomplete,
} from '../../src/data/games';

let dir = '';
const opened: Db[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbop-p1-retention-'));
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
  return openAt(join(dir, 'retention.db'));
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

/** A session whose players come from a shared registry (so the same people can play many sessions). */
function seedWith(db: Db, name: string, playerIds: string[], courtCount = 2): Seeded {
  const session = createSession(db, { name, courtCount });
  for (const id of playerIds) {
    addPlayerToSession(db, session.id, id);
    checkInPlayer(db, session.id, id);
  }
  return { session, ids: playerIds, courts: listCourts(db, session.id) };
}

function registry(db: Db, n: number, prefix = 'Member'): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(createPlayer(db, { displayName: `${prefix} ${i + 1}` }).id);
  return ids;
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

/** A session with one finished-as-incomplete game and score events, then completed. */
function playedAndFinished(db: Db, name: string, playerIds: string[]): { s: Seeded; game: Game } {
  const s = seedWith(db, name, playerIds);
  const game = doubles(db, s, 0, playerIds);
  appendScoreEvent(db, game.id, { eventType: 'rally', eventData: { winner: 'A' } });
  markGameIncomplete(db, game.id, 'time');
  finishSession(db, s.session.id);
  return { s, game };
}

describe('AC-12 Data retention: sessions remain available until explicitly deleted', () => {
  it('a dozen completed sessions, with their games and events, are all still there after restarts', () => {
    const file = join(dir, 'season.db');
    const db = openAt(file);
    const people = registry(db, 4);
    const made: { id: string; gameId: string }[] = [];
    for (let week = 1; week <= 12; week++) {
      const { s, game } = playedAndFinished(db, `Week ${week}`, people);
      made.push({ id: s.session.id, gameId: game.id });
    }
    db.close();

    for (let restart = 0; restart < 2; restart++) {
      const again = openAt(file);
      const sessions = listSessions(again);
      expect(sessions).toHaveLength(12);
      expect(new Set(sessions.map((x) => x.id))).toEqual(new Set(made.map((m) => m.id)));
      expect(sessions.every((x) => x.status === 'completed' && x.endedAt !== null)).toBe(true);
      for (const m of made) {
        const state = loadSessionState(again, m.id);
        expect(state.games.map((g) => g.id)).toEqual([m.gameId]);
        expect(state.roster).toHaveLength(4);
        expect(listScoreEvents(again, m.gameId)).toHaveLength(1);
      }
      expect(getPlayerGameHistory(again, must(people[0]))).toHaveLength(12);
      again.close();
    }
  });

  it('deleteSession without explicit confirmation is refused and deletes nothing', () => {
    const file = join(dir, 'confirm.db');
    const db = openAt(file);
    const people = registry(db, 4);
    const { s, game } = playedAndFinished(db, 'Keep me', people);

    expect(() => deleteSession(db, s.session.id)).toThrow(ConfirmationRequiredError);
    expect(() => deleteSession(db, s.session.id, {})).toThrow(ConfirmationRequiredError);
    expect(() => deleteSession(db, s.session.id, { confirm: false })).toThrow(ConfirmationRequiredError);
    // only the literal `true` counts as confirmation
    const truthy = { confirm: 'yes' } as unknown as { confirm?: boolean };
    expect(() => deleteSession(db, s.session.id, truthy)).toThrow(ConfirmationRequiredError);
    const one = { confirm: 1 } as unknown as { confirm?: boolean };
    expect(() => deleteSession(db, s.session.id, one)).toThrow(ConfirmationRequiredError);

    db.close();
    const again = openAt(file);
    expect(must(getSession(again, s.session.id)).name).toBe('Keep me');
    expect(must(getGame(again, game.id)).sessionId).toBe(s.session.id);
    expect(listScoreEvents(again, game.id)).toHaveLength(1);
    expect(listRoster(again, s.session.id)).toHaveLength(4);
  });

  it('an active (unfinished) session also cannot be deleted without confirmation', () => {
    const db = openDb();
    const s = createSession(db, { name: 'In progress', courtCount: 2 });
    expect(() => deleteSession(db, s.id)).toThrow(ConfirmationRequiredError);
    expect(findUnfinishedSessions(db).map((x) => x.id)).toEqual([s.id]);
  });

  it('confirmed deletion removes exactly that session and its records; players and other sessions stay', () => {
    const db = openDb();
    const people = registry(db, 4);
    const keep = playedAndFinished(db, 'Keep', people);
    const drop = playedAndFinished(db, 'Drop', people);

    deleteSession(db, drop.s.session.id, { confirm: true });

    expect(getSession(db, drop.s.session.id)).toBeNull();
    expect(listSessions(db).map((x) => x.id)).toEqual([keep.s.session.id]);
    expect(getGame(db, drop.game.id)).toBeNull();
    expect(listGames(db, drop.s.session.id)).toEqual([]);
    expect(listScoreEvents(db, drop.game.id)).toEqual([]);
    expect(listRoster(db, drop.s.session.id)).toEqual([]);
    expect(listCourts(db, drop.s.session.id)).toEqual([]);
    expect(listAuditEvents(db, drop.s.session.id)).toEqual([]);

    // the kept session is untouched
    expect(must(getGame(db, keep.game.id)).sessionId).toBe(keep.s.session.id);
    expect(listScoreEvents(db, keep.game.id)).toHaveLength(1);
    expect(listRoster(db, keep.s.session.id)).toHaveLength(4);
    // players remain in the registry with their other history
    expect(listPlayers(db).map((p) => p.id).sort()).toEqual([...people].sort());
    expect(getPlayerGameHistory(db, must(people[0])).map((g) => g.id)).toEqual([keep.game.id]);
  });

  it('nothing deletes a session implicitly: finishing, reopening, roster and court changes keep it', () => {
    const file = join(dir, 'implicit.db');
    const db = openAt(file);
    const people = registry(db, 6);
    const s = seedWith(db, 'Busy night', people, 4);
    const g = doubles(db, s, 3, people.slice(0, 4));
    markGameIncomplete(db, g.id);
    setCourtCount(db, s.session.id, 2);
    removePlayerFromSession(db, s.session.id, must(people[5]));
    deactivatePlayer(db, must(people[4]));
    finishSession(db, s.session.id);
    reopenSession(db, s.session.id);
    finishSession(db, s.session.id);
    db.close();

    const again = openAt(file);
    expect(listSessions(again).map((x) => x.id)).toEqual([s.session.id]);
    const game = must(getGame(again, g.id));
    expect(game.courtId).toBe(must(s.courts[3]).id);
    expect(game.participants).toHaveLength(4);
  });
});

describe('AC-12 Session lifecycle: create, finish, review, read-only until reopened', () => {
  it('finishing marks the session completed with an end time; it stays reviewable', () => {
    const db = openDb();
    const people = registry(db, 4);
    const s = seedWith(db, 'Review me', people);
    const g = doubles(db, s, 0, people);
    markGameIncomplete(db, g.id);
    const done = finishSession(db, s.session.id, { endedAt: '2026-10-21T22:00:00.000Z' });
    expect(done.status).toBe('completed');
    expect(done.endedAt).not.toBeNull();
    expect(new Date(must(done.endedAt)).getTime()).toBe(new Date('2026-10-21T22:00:00.000Z').getTime());

    const review = loadSessionState(db, s.session.id);
    expect(review.session.status).toBe('completed');
    expect(review.roster).toHaveLength(4);
    expect(review.courts).toHaveLength(2);
    expect(review.games.map((x) => x.id)).toEqual([g.id]);
    expect(findUnfinishedSessions(db)).toEqual([]);
  });

  it('a session with a game still in progress cannot be finished', () => {
    const db = openDb();
    const people = registry(db, 4);
    const s = seedWith(db, 'Not yet', people);
    doubles(db, s, 0, people);
    expect(() => finishSession(db, s.session.id)).toThrow(SessionStateError);
    expect(must(getSession(db, s.session.id)).status).toBe('active');
  });

  it('finishing twice or reopening an active session is an illegal transition', () => {
    const db = openDb();
    const s = createSession(db, { name: 'Twice', courtCount: 2 });
    expect(() => reopenSession(db, s.id)).toThrow(SessionStateError);
    finishSession(db, s.id);
    expect(() => finishSession(db, s.id)).toThrow(SessionStateError);
    expect(must(getSession(db, s.id)).status).toBe('completed');
  });

  it('a completed session rejects every write and its data is unchanged', () => {
    const db = openDb();
    const people = registry(db, 6);
    const s = seedWith(db, 'Locked', people.slice(0, 4));
    const outsider = must(people[4]);
    const g = doubles(db, s, 0, people.slice(0, 4));
    appendScoreEvent(db, g.id, { eventType: 'rally', eventData: { winner: 'A' } });
    markGameIncomplete(db, g.id);
    finishSession(db, s.session.id);
    const before = loadSessionState(db, s.session.id);
    const eventsBefore = listScoreEvents(db, g.id);
    const sid = s.session.id;
    const p1 = must(people[0]);

    expect(() => addPlayerToSession(db, sid, outsider)).toThrow(SessionReadOnlyError);
    expect(() => addNewPlayerToSession(db, sid, { displayName: 'Walk-in' })).toThrow(SessionReadOnlyError);
    expect(() => checkInPlayer(db, sid, p1)).toThrow(SessionReadOnlyError);
    expect(() => setAvailability(db, sid, p1, 'resting')).toThrow(SessionReadOnlyError);
    expect(() => removePlayerFromSession(db, sid, p1)).toThrow(SessionReadOnlyError);
    expect(() => setCourtCount(db, sid, 3)).toThrow(SessionReadOnlyError);
    expect(() => setCourtStatus(db, must(s.courts[1]).id, 'unavailable')).toThrow(SessionReadOnlyError);
    expect(() => doubles(db, s, 1, people.slice(0, 4))).toThrow(SessionReadOnlyError);
    expect(() => appendScoreEvent(db, g.id, { eventType: 'rally', eventData: { winner: 'B' } })).toThrow();

    expect(loadSessionState(db, sid)).toEqual(before);
    expect(listScoreEvents(db, g.id)).toEqual(eventsBefore);
    // the walk-in must not have leaked into the registry either
    expect(listPlayers(db)).toHaveLength(6);
  });

  it('read-only status survives a restart', () => {
    const file = join(dir, 'ro-restart.db');
    const db = openAt(file);
    const s = createSession(db, { name: 'Closed', courtCount: 2 });
    finishSession(db, s.id);
    db.close();
    const again = openAt(file);
    expect(() => addNewPlayerToSession(again, s.id, { displayName: 'Too late' })).toThrow(SessionReadOnlyError);
    expect(listRoster(again, s.id)).toEqual([]);
  });

  it('reopening a completed session allows corrections again and is recorded in the audit log', () => {
    const db = openDb();
    const people = registry(db, 5);
    const s = seedWith(db, 'Fix me', people.slice(0, 4));
    finishSession(db, s.session.id);
    const reopened = reopenSession(db, s.session.id);
    expect(reopened.status).toBe('active');
    expect(must(getSession(db, s.session.id)).status).toBe('active');
    expect(listAuditEvents(db, s.session.id).map((e) => e.action)).toContain('session_reopened');

    addPlayerToSession(db, s.session.id, must(people[4]));
    expect(listRoster(db, s.session.id)).toHaveLength(5);
    const g = doubles(db, s, 0, people.slice(0, 4));
    expect(g.status).toBe('in_progress');
  });
});

describe('AC-12 Player removal keeps history', () => {
  it('removing a player from the roster keeps their games, participants and score events', () => {
    const db = openDb();
    const people = registry(db, 4);
    const s = seedWith(db, 'Removal', people);
    const g = doubles(db, s, 0, people);
    appendScoreEvent(db, g.id, { eventType: 'rally', eventData: { winner: 'A' } });
    markGameIncomplete(db, g.id);
    const leaving = must(people[2]);

    removePlayerFromSession(db, s.session.id, leaving);

    expect(listRoster(db, s.session.id).map((r) => r.playerId)).not.toContain(leaving);
    expect(listRoster(db, s.session.id)).toHaveLength(3);
    const game = must(getGame(db, g.id));
    expect(game.participants.map((p) => p.playerId)).toContain(leaving);
    expect(game.participants.find((p) => p.playerId === leaving)?.team).toBe('B');
    expect(getPlayerGameHistory(db, leaving).map((x) => x.id)).toEqual([g.id]);
    expect(listScoreEvents(db, g.id)).toHaveLength(1);
    expect(must(getPlayer(db, leaving)).active).toBe(true);
    expect(loadSessionState(db, s.session.id).games.map((x) => x.id)).toEqual([g.id]);
  });

  it('a player in a game that is still in progress cannot be removed from the roster', () => {
    const db = openDb();
    const people = registry(db, 4);
    const s = seedWith(db, 'Mid-game', people);
    doubles(db, s, 0, people);
    expect(() => removePlayerFromSession(db, s.session.id, must(people[0]))).toThrow(SessionStateError);
    expect(listRoster(db, s.session.id)).toHaveLength(4);
  });

  it('deactivating a player keeps their history in every session', () => {
    const db = openDb();
    const people = registry(db, 4);
    const a = playedAndFinished(db, 'Week A', people);
    const b = playedAndFinished(db, 'Week B', people);
    const gone = must(people[1]);
    deactivatePlayer(db, gone);
    expect(getPlayerGameHistory(db, gone).map((g) => g.id).sort()).toEqual([a.game.id, b.game.id].sort());
    expect(must(getGame(db, a.game.id)).participants.map((p) => p.playerId)).toContain(gone);
    expect(loadSessionState(db, b.s.session.id).roster.map((r) => r.playerId)).toContain(gone);
  });

  it('a removed player can be deliberately re-added later with the same id', () => {
    const db = openDb();
    const people = registry(db, 4);
    const s = seedWith(db, 'Comeback', people);
    const p = must(people[3]);
    removePlayerFromSession(db, s.session.id, p);
    const back = addPlayerToSession(db, s.session.id, p);
    expect(back.playerId).toBe(p);
    expect(listRoster(db, s.session.id)).toHaveLength(4);
  });
});
