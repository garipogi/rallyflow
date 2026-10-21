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
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, withTransaction, type Db } from '../../src/data/db';
import type { Court, Game, Session, SessionState } from '../../src/data/types';
import {
  createSession,
  findUnfinishedSessions,
  finishSession,
  getSession,
  listSessions,
  loadSessionState,
} from '../../src/data/sessions';
import { listCourts, setCourtStatus } from '../../src/data/courts';
import { addNewPlayerToSession, checkInPlayer, listRoster, setAvailability } from '../../src/data/roster';
import {
  appendScoreEvent,
  createGame,
  getGame,
  listActiveGames,
  listGames,
  listScoreEvents,
  markGameIncomplete,
} from '../../src/data/games';

let dir = '';
const opened: Db[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbop-p1-recovery-'));
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

interface Seeded {
  session: Session;
  ids: string[];
  courts: Court[];
}

function seed(db: Db, players: number, courtCount: number): Seeded {
  const session = createSession(db, { name: 'Recovery night', courtCount, startedAt: '2026-10-21T18:00:00.000Z' });
  const ids: string[] = [];
  for (let i = 0; i < players; i++) {
    const entry = addNewPlayerToSession(db, session.id, { displayName: `Player ${i + 1}` });
    checkInPlayer(db, session.id, entry.playerId, '2026-10-21T18:05:00.000Z');
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

/** Order-insensitive view of a session state, so the comparison is about content, not row order. */
function normalize(state: SessionState): SessionState {
  return {
    session: state.session,
    roster: [...state.roster].sort((a, b) => a.playerId.localeCompare(b.playerId)),
    courts: [...state.courts].sort((a, b) => a.id.localeCompare(b.id)),
    games: [...state.games]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((g) => ({ ...g, participants: [...g.participants].sort((a, b) => a.playerId.localeCompare(b.playerId)) })),
  };
}

/** Copy the database file plus any journal/WAL exactly as they are on disk right now (a crash snapshot). */
function snapshotFiles(from: string, to: string): void {
  for (const suffix of ['', '-wal', '-journal']) {
    if (existsSync(from + suffix)) copyFileSync(from + suffix, to + suffix);
  }
}

describe('AC-11 Recovery: an interrupted session reopens with its latest committed state', () => {
  it('after the app closes, startup finds the unfinished session and restores roster, courts, games and score events', () => {
    const file = join(dir, 'night.db');
    const db = openAt(file);
    const s = seed(db, 10, 3);
    setAvailability(db, s.session.id, must(s.ids[9]), 'resting');
    setCourtStatus(db, must(s.courts[2]).id, 'unavailable');
    const g1 = doubles(db, s, 0, s.ids.slice(0, 4));
    const g2 = doubles(db, s, 1, s.ids.slice(4, 8));
    appendScoreEvent(db, g1.id, { eventType: 'rally', eventData: { winner: 'A' }, occurredAt: '2026-10-21T18:10:00.000Z' });
    appendScoreEvent(db, g1.id, { eventType: 'rally', eventData: { winner: 'B' }, occurredAt: '2026-10-21T18:10:30.000Z' });
    appendScoreEvent(db, g1.id, { eventType: 'fault', eventData: { team: 'B', kind: 'foot' }, occurredAt: '2026-10-21T18:11:00.000Z' });
    markGameIncomplete(db, g2.id, 'player injured');

    // a second, completed session must not be reported as unfinished
    const done = createSession(db, { name: 'Last week', courtCount: 2 });
    finishSession(db, done.id);

    const before = normalize(loadSessionState(db, s.session.id));
    const eventsBefore = listScoreEvents(db, g1.id);
    db.close();

    const again = openAt(file);
    const unfinished = findUnfinishedSessions(again);
    expect(unfinished.map((x) => x.id)).toEqual([s.session.id]);
    const after = normalize(loadSessionState(again, s.session.id));
    expect(after).toEqual(before);
    expect(after.roster).toHaveLength(10);
    expect(after.roster.find((r) => r.playerId === s.ids[9])?.availability).toBe('resting');
    expect(after.courts.find((c) => c.id === must(s.courts[2]).id)?.status).toBe('unavailable');
    expect(listActiveGames(again, s.session.id).map((g) => g.id)).toEqual([g1.id]);
    expect(must(getGame(again, g2.id)).status).toBe('incomplete');

    const eventsAfter = listScoreEvents(again, g1.id);
    expect(eventsAfter).toEqual(eventsBefore);
    expect(eventsAfter.map((e) => e.eventType)).toEqual(['rally', 'rally', 'fault']);
    expect(eventsAfter.map((e) => e.eventData)).toEqual([{ winner: 'A' }, { winner: 'B' }, { team: 'B', kind: 'foot' }]);
  });

  it('every committed write is visible to a fresh connection immediately, without closing the first one', () => {
    const file = join(dir, 'live.db');
    const db = openAt(file);
    const s = seed(db, 4, 2);
    const g = doubles(db, s, 0, s.ids);
    appendScoreEvent(db, g.id, { eventType: 'rally', eventData: { winner: 'A' } });

    // The app "dies" here: the first handle is never closed cleanly.
    const fresh = openAt(file);
    expect(findUnfinishedSessions(fresh).map((x) => x.id)).toEqual([s.session.id]);
    expect(listActiveGames(fresh, s.session.id).map((x) => x.id)).toEqual([g.id]);
    expect(listScoreEvents(fresh, g.id)).toHaveLength(1);
  });

  it('a committed score event is already in the files on disk when the call returns', () => {
    const file = join(dir, 'disk.db');
    const db = openAt(file);
    const s = seed(db, 4, 2);
    const g = doubles(db, s, 0, s.ids);
    appendScoreEvent(db, g.id, { eventType: 'rally', eventData: { n: 1 } });
    appendScoreEvent(db, g.id, { eventType: 'rally', eventData: { n: 2 } });

    const snap = join(dir, 'disk-snapshot.db');
    snapshotFiles(file, snap);
    const copy = openAt(snap);
    expect(listScoreEvents(copy, g.id).map((e) => e.eventData)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(must(getGame(copy, g.id)).status).toBe('in_progress');
  });

  it('an error thrown mid-transaction leaves no partial game, no orphan score events and no busy players', () => {
    const file = join(dir, 'rollback.db');
    const db = openAt(file);
    const s = seed(db, 8, 2);
    const g1 = doubles(db, s, 0, s.ids.slice(0, 4));
    appendScoreEvent(db, g1.id, { eventType: 'rally', eventData: { winner: 'A' } });
    const before = normalize(loadSessionState(db, s.session.id));

    let phantomId = '';
    expect(() =>
      withTransaction(db, () => {
        const g2 = doubles(db, s, 1, s.ids.slice(4, 8));
        phantomId = g2.id;
        appendScoreEvent(db, g2.id, { eventType: 'rally', eventData: { winner: 'B' } });
        appendScoreEvent(db, g1.id, { eventType: 'rally', eventData: { winner: 'B' } });
        markGameIncomplete(db, g1.id, 'about to crash');
        throw new Error('simulated crash');
      }),
    ).toThrow('simulated crash');

    expect(phantomId).not.toBe('');
    expect(getGame(db, phantomId)).toBeNull();
    expect(listScoreEvents(db, phantomId)).toEqual([]);
    expect(listScoreEvents(db, g1.id)).toHaveLength(1);
    expect(must(getGame(db, g1.id)).status).toBe('in_progress');
    expect(normalize(loadSessionState(db, s.session.id))).toEqual(before);

    // the rolled-back game's players and court are free again
    const retry = doubles(db, s, 1, s.ids.slice(4, 8));
    expect(retry.status).toBe('in_progress');
    expect(listGames(db, s.session.id)).toHaveLength(2);

    // and the same holds after reopening the file
    db.close();
    const again = openAt(file);
    expect(getGame(again, phantomId)).toBeNull();
    expect(listGames(again, s.session.id).map((g) => g.id).sort()).toEqual([g1.id, retry.id].sort());
  });

  it('withTransaction commits and returns the callback result when nothing throws', () => {
    const db = openAt(join(dir, 'commit.db'));
    const s = seed(db, 8, 2);
    const ids = withTransaction(db, () => {
      const a = doubles(db, s, 0, s.ids.slice(0, 4));
      const b = doubles(db, s, 1, s.ids.slice(4, 8));
      return [a.id, b.id];
    });
    expect(ids).toHaveLength(2);
    expect(listActiveGames(db, s.session.id).map((g) => g.id).sort()).toEqual([...ids].sort());
  });

  it('a game rejected half-way (bad participant) writes nothing at all', () => {
    const db = openAt(join(dir, 'reject.db'));
    const s = seed(db, 8, 2);
    const busy = doubles(db, s, 0, s.ids.slice(0, 4));
    const before = normalize(loadSessionState(db, s.session.id));

    // valid court and three valid players, but the fourth is already playing
    expect(() => doubles(db, s, 1, [must(s.ids[4]), must(s.ids[5]), must(s.ids[6]), must(s.ids[0])])).toThrow();
    // valid players, but one id does not exist at all
    expect(() => doubles(db, s, 1, [must(s.ids[4]), must(s.ids[5]), must(s.ids[6]), 'ghost-player'])).toThrow();

    expect(normalize(loadSessionState(db, s.session.id))).toEqual(before);
    expect(listGames(db, s.session.id).map((g) => g.id)).toEqual([busy.id]);
    // players 5–8 were not left half-assigned
    expect(doubles(db, s, 1, s.ids.slice(4, 8)).status).toBe('in_progress');
  });

  it('a crash snapshot taken mid-write reopens at the last committed state', () => {
    const file = join(dir, 'crash.db');
    const db = openAt(file);
    const s = seed(db, 8, 2);
    const g1 = doubles(db, s, 0, s.ids.slice(0, 4));
    appendScoreEvent(db, g1.id, { eventType: 'rally', eventData: { winner: 'A' } });
    const committed = normalize(loadSessionState(db, s.session.id));

    const snap = join(dir, 'crash-snapshot.db');
    expect(() =>
      withTransaction(db, () => {
        doubles(db, s, 1, s.ids.slice(4, 8));
        appendScoreEvent(db, g1.id, { eventType: 'rally', eventData: { winner: 'B' } });
        // power is cut here: whatever is on disk is all that survives
        snapshotFiles(file, snap);
        throw new Error('power cut');
      }),
    ).toThrow('power cut');

    const recovered = openAt(snap);
    expect(findUnfinishedSessions(recovered).map((x) => x.id)).toEqual([s.session.id]);
    expect(normalize(loadSessionState(recovered, s.session.id))).toEqual(committed);
    expect(listGames(recovered, s.session.id).map((g) => g.id)).toEqual([g1.id]);
    expect(listScoreEvents(recovered, g1.id).map((e) => e.eventData)).toEqual([{ winner: 'A' }]);
    // the recovered session is usable: the "lost" game can be started again
    const replay = createGame(recovered, {
      sessionId: s.session.id,
      courtId: must(listCourts(recovered, s.session.id)[1]).id,
      format: 'doubles',
      teamA: [must(s.ids[4]), must(s.ids[5])],
      teamB: [must(s.ids[6]), must(s.ids[7])],
    });
    expect(replay.status).toBe('in_progress');
  });

  it('startup recovery reports only active sessions and keeps every session readable', () => {
    const file = join(dir, 'many.db');
    const db = openAt(file);
    const a = createSession(db, { name: 'A', courtCount: 2 });
    const b = createSession(db, { name: 'B', courtCount: 3 });
    const c = createSession(db, { name: 'C', courtCount: 4 });
    finishSession(db, b.id);
    db.close();
    const again = openAt(file);
    expect(findUnfinishedSessions(again).map((x) => x.id).sort()).toEqual([a.id, c.id].sort());
    expect(listSessions(again)).toHaveLength(3);
    expect(must(getSession(again, b.id)).status).toBe('completed');
    expect(listRoster(again, a.id)).toEqual([]);
  });
});
