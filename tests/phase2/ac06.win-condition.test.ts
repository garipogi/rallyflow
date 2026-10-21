/*
 * ============================================================================
 * PHASE 2 PUBLIC API (pinned by the locked tests; the builder implements it).
 * Rules: docs/RULES.md, "2026 USA Pickleball Official Rulebook". Rule numbers in test titles are
 * 2026 rule numbers from that file.
 *
 * src/core/scoring/index.ts  (pure: no I/O; no imports from src/data, src/main, src/renderer,
 *                             node:* or electron)
 *   const RULES_EDITION: string       equals the "Edition:" line of docs/RULES.md
 *   type TeamId = 'A' | 'B'
 *   type CourtSide = 'right' | 'left'  always from that player's own view, facing the net
 *   interface GameSetup {
 *     format: 'singles' | 'doubles';
 *     teamA: readonly string[];       player ids: 1 per team (singles) or 2 per team (doubles), all
 *     teamB: readonly string[];       distinct. Index 0 is that team's starting server (Rule 5.B.3).
 *     firstServingTeam: TeamId;
 *     targetScore?: number;           default 11; positive integer, else ScoringError
 *     winBy?: number;                 default 2; positive integer, else ScoringError
 *   }
 *   type ScoringEvent =
 *     | { type: 'rally'; winner: TeamId }                   the team that won the rally
 *     | { type: 'fault'; against: TeamId; rule?: string }   a fault = loss of the rally (Rule 2, 9.B)
 *   interface GameState {             (extra fields allowed; these are pinned)
 *     format: 'singles' | 'doubles'; targetScore: number; winBy: number;
 *     score: { A: number; B: number };
 *     servingTeam: TeamId; receivingTeam: TeamId;
 *     serverNumber: 1 | 2 | null;     null in singles
 *     serverId: string;               who serves the NEXT rally
 *     receiverId: string;             who receives the NEXT rally (diagonal, Rule 7.E)
 *     serverSide: CourtSide;          === positions[serverId]
 *     positions: Record<string, CourtSide>;  every player's correct side for the next rally
 *     calledScore: string;            "S-R" singles (6.B.1), "S-R-N" doubles (6.B.2), digits and '-'
 *                                     only, e.g. "0-0-2"; unspecified once isOver
 *     isOver: boolean;                target reached with a lead >= winBy
 *     winner: TeamId | null;
 *     rallies: number;                scoring events applied so far
 *   }
 *   interface ScoreLog { readonly setup: GameSetup; readonly events: readonly ScoringEvent[] }
 *   class ScoringError extends Error
 *   initialState(setup: GameSetup): GameState        validates setup (ScoringError)
 *   applyEvent(state: GameState, event: ScoringEvent): GameState
 *       pure reducer: never mutates `state` (works on deeply frozen input); ScoringError when
 *       state.isOver or the event is malformed
 *   replay(setup: GameSetup, events: readonly ScoringEvent[]): GameState
 *       === events.reduce(applyEvent, initialState(setup))
 *   startLog(setup: GameSetup): ScoreLog             { setup, events: [] }; validates like initialState
 *   record(log: ScoreLog, event: ScoringEvent): ScoreLog   appends; ScoringError if illegal
 *   undo(log: ScoreLog): ScoreLog                    drops the last event; ScoringError if none
 *   correct(log: ScoreLog, index: number, event: ScoringEvent): ScoreLog
 *       replaces events[index] and replays everything after it; ScoringError if index is out of
 *       range or a later event becomes illegal (e.g. the game would now end earlier)
 *   stateOf(log: ScoreLog): GameState                === replay(log.setup, log.events)
 *   Log functions return new objects and never mutate their inputs.
 *
 * src/data/scoring.ts  (builds on phase 1: score_events via appendScoreEvent/listScoreEvents)
 *   Each call is one transaction, committed to disk before it returns; a rejected call writes
 *   nothing. Checks in order: unknown game -> ValidationError; completed session ->
 *   SessionReadOnlyError; then the call-specific errors below.
 *   startScoring(db, gameId, { firstServingTeam: TeamId; targetScore?: number; winBy?: number }): GameState
 *       Setup comes from the game: format, team A/B ids ordered by startingPosition (1 = starting
 *       server). targetScore/winBy default to the session's. SessionStateError if scoring already
 *       started or the game is not 'in_progress'.
 *   recordScoringEvent(db, gameId, event: ScoringEvent, opts?: { occurredAt?: string }): GameState
 *   undoLastScoringEvent(db, gameId): GameState
 *   correctScoringEvent(db, gameId, index: number, event: ScoringEvent, opts?: { reason?: string }): GameState
 *       index into loadScoreLog(...).events. Writes AuditEvent action 'score_correction' with
 *       details { gameId, eventIndex, previous: ScoringEvent, next: ScoringEvent, reason: string | null }.
 *   record / undo / correct: SessionStateError if scoring has not started or the game is not
 *   'in_progress' (a completed game must be reopened first); ScoringError for whatever the engine
 *   rejects.
 *   loadScoreLog(db, gameId): ScoreLog     rebuilt only from persisted score_events (so it survives
 *                                          a restart); SessionStateError if scoring has not started
 *   finalizeGame(db, gameId, opts?: { endedAt?: string }): Game
 *       ScoringError unless the engine state isOver; SessionStateError if the game is not
 *       'in_progress' (never completed twice). Sets status 'completed', winner, scores, endedAt.
 *   reopenGame(db, gameId, opts?: { confirm?: boolean; reason?: string }): Game
 *       ConfirmationRequiredError unless opts.confirm === true; SessionStateError unless the game
 *       is 'completed'. Sets status 'in_progress', winner null, endedAt null; score history kept.
 *       Writes AuditEvent action 'game_reopened' with details { gameId, reason: string | null }.
 *   score_events is append-only: undo and corrections add rows, and listScoreEvents never shrinks.
 *   After every successful call, getGame(...).teamAScore/teamBScore equal the engine score.
 * ============================================================================
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyEvent,
  initialState,
  record,
  replay,
  ScoringError,
  startLog,
  stateOf,
  type GameSetup,
  type GameState,
  type ScoringEvent,
  type TeamId,
} from '../../src/core/scoring';
import { openDatabase, type Db } from '../../src/data/db';
import { SessionStateError } from '../../src/data/errors';
import { createSession, finishSession } from '../../src/data/sessions';
import { listCourts } from '../../src/data/courts';
import { addNewPlayerToSession, checkInPlayer } from '../../src/data/roster';
import { createGame, getGame, listScoreEvents } from '../../src/data/games';
import { finalizeGame, loadScoreLog, recordScoringEvent, startScoring } from '../../src/data/scoring';

const rally = (winner: TeamId): ScoringEvent => ({ type: 'rally', winner });

const DOUBLES: GameSetup = { format: 'doubles', teamA: ['a1', 'a2'], teamB: ['b1', 'b2'], firstServingTeam: 'A' };
const SINGLES: GameSetup = { format: 'singles', teamA: ['p'], teamB: ['q'], firstServingTeam: 'A' };

/**
 * Builds the rally events that give the listed teams one point each, in order. Under side-out
 * scoring a team can only score while serving, so the helper lets it win rallies (changing server
 * or siding out, never scoring) until it serves, then lets it win the point.
 */
function eventsForPoints(setup: GameSetup, points: string, from?: GameState): { events: ScoringEvent[]; state: GameState } {
  let s = from ?? initialState(setup);
  const events: ScoringEvent[] = [];
  for (const c of points) {
    const t = c as TeamId;
    let guard = 0;
    while (s.servingTeam !== t) {
      const before = { ...s.score };
      s = applyEvent(s, rally(t));
      events.push(rally(t));
      expect(s.score).toEqual(before);
      if (++guard > 3) throw new Error('team never got the serve');
    }
    s = applyEvent(s, rally(t));
    events.push(rally(t));
  }
  return { events, state: s };
}

describe('AC-06 Win condition: configured target, win by two (Rules 4.B, 15.C)', () => {
  it('Rule 15.C: the default target is 11 and the default margin is 2', () => {
    const s = initialState(DOUBLES);
    expect(s.targetScore).toBe(11);
    expect(s.winBy).toBe(2);
    expect(s.isOver).toBe(false);
    expect(s.winner).toBeNull();
  });

  it('Rule 4.B: 10-0 is not over; the 11th point (11-0) wins the game for the serving team', () => {
    let s = initialState(DOUBLES);
    for (let i = 0; i < 10; i++) s = applyEvent(s, rally('A'));
    expect(s.score).toEqual({ A: 10, B: 0 });
    expect(s.isOver).toBe(false);
    s = applyEvent(s, rally('A'));
    expect(s.score).toEqual({ A: 11, B: 0 });
    expect(s.isOver).toBe(true);
    expect(s.winner).toBe('A');
  });

  it('Rule 15.C (win by two): 11-10 must not end the game; 12-10 does', () => {
    const { state: at1010 } = eventsForPoints(DOUBLES, 'ABABABABABABABABABAB');
    expect(at1010.score).toEqual({ A: 10, B: 10 });
    expect(at1010.isOver).toBe(false);
    const { state: at1110 } = eventsForPoints(DOUBLES, 'A', at1010);
    expect(at1110.score).toEqual({ A: 11, B: 10 });
    expect(at1110.isOver).toBe(false);
    expect(at1110.winner).toBeNull();
    const { state: at1210 } = eventsForPoints(DOUBLES, 'A', at1110);
    expect(at1210.score).toEqual({ A: 12, B: 10 });
    expect(at1210.isOver).toBe(true);
    expect(at1210.winner).toBe('A');
  });

  it('Rule 15.C: a deuce game keeps going (11-11, 12-11, 12-12, 13-12 …) until a two-point lead, e.g. 15-13 for B', () => {
    const { state: tied } = eventsForPoints(SINGLES, 'ABABABABABABABABABABAB'); // 11-11
    expect(tied.score).toEqual({ A: 11, B: 11 });
    let s = tied;
    for (const [pts, a, b] of [
      ['A', 12, 11],
      ['B', 12, 12],
      ['B', 12, 13],
      ['A', 13, 13],
      ['B', 13, 14],
    ] as const) {
      s = eventsForPoints(SINGLES, pts, s).state;
      expect(s.score).toEqual({ A: a, B: b });
      expect(s.isOver).toBe(false);
    }
    s = eventsForPoints(SINGLES, 'B', s).state;
    expect(s.score).toEqual({ A: 13, B: 15 });
    expect(s.isOver).toBe(true);
    expect(s.winner).toBe('B');
  });

  it('Rule 15.C.1.c: target 15 — 14-0 is not over, 15-0 is; 15-14 is not over, 16-14 is', () => {
    const setup: GameSetup = { ...DOUBLES, targetScore: 15 };
    let s = initialState(setup);
    expect(s.targetScore).toBe(15);
    for (let i = 0; i < 14; i++) s = applyEvent(s, rally('A'));
    expect(s.isOver).toBe(false);
    s = applyEvent(s, rally('A'));
    expect(s.isOver).toBe(true);
    expect(s.score).toEqual({ A: 15, B: 0 });

    const close = eventsForPoints(setup, 'AB'.repeat(14) + 'A').state;
    expect(close.score).toEqual({ A: 15, B: 14 });
    expect(close.isOver).toBe(false);
    const won = eventsForPoints(setup, 'A', close).state;
    expect(won.score).toEqual({ A: 16, B: 14 });
    expect(won.isOver).toBe(true);
  });

  it('Rule 15.C.1.c: target 21 — 11-0 and 20-19 are not over; 21-19 wins', () => {
    const setup: GameSetup = { ...SINGLES, targetScore: 21, firstServingTeam: 'B' };
    let s = initialState(setup);
    for (let i = 0; i < 11; i++) s = applyEvent(s, rally('B'));
    expect(s.score).toEqual({ A: 0, B: 11 });
    expect(s.isOver).toBe(false);
    const late = eventsForPoints({ ...setup }, 'AB'.repeat(19) + 'B').state;
    expect(late.score).toEqual({ A: 19, B: 20 });
    expect(late.isOver).toBe(false);
    const done = eventsForPoints(setup, 'B', late).state;
    expect(done.score).toEqual({ A: 19, B: 21 });
    expect(done.isOver).toBe(true);
    expect(done.winner).toBe('B');
  });

  it('Rule 4.A / 4.B: a receiving team at game point cannot win by winning the rally (no point on a side out)', () => {
    // B leads 10-3 but A is serving: B winning rallies only moves the serve.
    const { state } = eventsForPoints(DOUBLES, 'BBBBBBBBBBAAA');
    expect(state.score).toEqual({ A: 3, B: 10 });
    expect(state.servingTeam).toBe('A');
    const after = applyEvent(state, rally('B'));
    expect(after.score).toEqual({ A: 3, B: 10 });
    expect(after.isOver).toBe(false);
  });

  it('no rally can be recorded once the game is over (ScoringError); the finished state is unchanged', () => {
    let s = initialState(SINGLES);
    for (let i = 0; i < 11; i++) s = applyEvent(s, rally('A'));
    expect(s.isOver).toBe(true);
    const snapshot = JSON.parse(JSON.stringify(s)) as unknown;
    expect(() => applyEvent(s, rally('A'))).toThrow(ScoringError);
    expect(() => applyEvent(s, rally('B'))).toThrow(ScoringError);
    expect(() => applyEvent(s, { type: 'fault', against: 'A' })).toThrow(ScoringError);
    expect(JSON.parse(JSON.stringify(s))).toEqual(snapshot);
    let log = startLog(SINGLES);
    for (let i = 0; i < 11; i++) log = record(log, rally('A'));
    expect(() => record(log, rally('B'))).toThrow(ScoringError);
    expect(log.events).toHaveLength(11);
    expect(() => replay(SINGLES, [...log.events, rally('A')])).toThrow(ScoringError);
  });

  it('rejects invalid targets and margins with ScoringError', () => {
    for (const targetScore of [0, -11, 10.5, Number.NaN]) {
      expect(() => initialState({ ...DOUBLES, targetScore })).toThrow(ScoringError);
      expect(() => startLog({ ...DOUBLES, targetScore })).toThrow(ScoringError);
    }
    for (const winBy of [0, -2, 1.5]) expect(() => initialState({ ...DOUBLES, winBy })).toThrow(ScoringError);
  });

  it('honours the margin configured in the setup (winBy 2 given explicitly behaves as the default)', () => {
    const events = eventsForPoints(DOUBLES, 'AB'.repeat(10) + 'AA').events;
    expect(stateOf({ setup: { ...DOUBLES, winBy: 2 }, events })).toEqual(stateOf({ setup: DOUBLES, events }));
  });
});

describe('AC-06 Finalizing a persisted game requires the win condition (Rule 15.C)', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pb-p2-ac06-'));
    db = openDatabase(join(dir, 'app.db'));
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function newGame(format: 'singles' | 'doubles', session: { targetScore?: number } = {}) {
    const s = createSession(db, { name: 'Open play', courtCount: 2, ...session });
    const n = format === 'doubles' ? 4 : 2;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const e = addNewPlayerToSession(db, s.id, { displayName: `Player ${i + 1}` });
      checkInPlayer(db, s.id, e.playerId);
      ids.push(e.playerId);
    }
    const court = listCourts(db, s.id)[0];
    if (!court) throw new Error('no court');
    const game = createGame(db, { sessionId: s.id, courtId: court.id, format, teamA: ids.slice(0, n / 2), teamB: ids.slice(n / 2) });
    return { session: s, game };
  }

  function score(gameId: string, events: ScoringEvent[]): GameState {
    let last: GameState | undefined;
    for (const e of events) last = recordScoringEvent(db, gameId, e);
    if (!last) throw new Error('no events');
    return last;
  }

  it('startScoring takes target and margin from the session by default (session target 15)', () => {
    const { game } = newGame('doubles', { targetScore: 15 });
    const s = startScoring(db, game.id, { firstServingTeam: 'A' });
    expect(s.targetScore).toBe(15);
    expect(s.winBy).toBe(2);
    expect(loadScoreLog(db, game.id).setup.format).toBe('doubles');
  });

  it('startScoring can override the target for one game (21)', () => {
    const { game } = newGame('singles');
    expect(startScoring(db, game.id, { firstServingTeam: 'B', targetScore: 21 }).targetScore).toBe(21);
    expect(stateOf(loadScoreLog(db, game.id)).targetScore).toBe(21);
  });

  it('finalizeGame is refused (ScoringError) at 10-8 and at 11-10, and the game stays in progress', () => {
    const { game } = newGame('doubles');
    startScoring(db, game.id, { firstServingTeam: 'A' });
    const setup = loadScoreLog(db, game.id).setup;
    const toTen8 = eventsForPoints(setup, 'AB'.repeat(8) + 'AA');
    expect(score(game.id, toTen8.events).score).toEqual({ A: 10, B: 8 });
    expect(() => finalizeGame(db, game.id)).toThrow(ScoringError);
    const more = eventsForPoints(setup, 'BB' + 'A', toTen8.state);
    expect(score(game.id, more.events).score).toEqual({ A: 11, B: 10 });
    const eventsBefore = listScoreEvents(db, game.id).length;
    expect(() => finalizeGame(db, game.id)).toThrow(ScoringError);
    const g = getGame(db, game.id);
    expect(g?.status).toBe('in_progress');
    expect(g?.winner).toBeNull();
    expect(g?.endedAt).toBeNull();
    expect(listScoreEvents(db, game.id)).toHaveLength(eventsBefore);
  });

  it('finalizeGame completes a won game once (12-10): status, winner, scores and end time are stored', () => {
    const { game } = newGame('doubles');
    startScoring(db, game.id, { firstServingTeam: 'A' });
    const setup = loadScoreLog(db, game.id).setup;
    const { events, state } = eventsForPoints(setup, 'AB'.repeat(10) + 'AA');
    expect(state.score).toEqual({ A: 12, B: 10 });
    const live = score(game.id, events);
    expect(live.isOver).toBe(true);
    expect(getGame(db, game.id)?.teamAScore).toBe(12);
    expect(getGame(db, game.id)?.teamBScore).toBe(10);
    const done = finalizeGame(db, game.id, { endedAt: '2026-10-21T20:00:00.000Z' });
    expect(done.status).toBe('completed');
    expect(done.winner).toBe('A');
    expect(done.teamAScore).toBe(12);
    expect(done.teamBScore).toBe(10);
    expect(done.endedAt).toBe('2026-10-21T20:00:00.000Z');
    expect(() => finalizeGame(db, game.id)).toThrow(SessionStateError);
    expect(getGame(db, game.id)?.endedAt).toBe('2026-10-21T20:00:00.000Z');
  });

  it('a finalized game accepts no more rallies (SessionStateError), and the session can then be finished', () => {
    const { session, game } = newGame('singles');
    startScoring(db, game.id, { firstServingTeam: 'A' });
    for (let i = 0; i < 11; i++) recordScoringEvent(db, game.id, rally('A'));
    finalizeGame(db, game.id);
    const n = listScoreEvents(db, game.id).length;
    expect(() => recordScoringEvent(db, game.id, rally('B'))).toThrow(SessionStateError);
    expect(listScoreEvents(db, game.id)).toHaveLength(n);
    expect(finishSession(db, session.id).status).toBe('completed');
  });

  it('a rally after the win condition (before finalizing) is rejected with ScoringError and not persisted', () => {
    const { game } = newGame('singles');
    startScoring(db, game.id, { firstServingTeam: 'B' });
    for (let i = 0; i < 11; i++) recordScoringEvent(db, game.id, rally('B'));
    const n = listScoreEvents(db, game.id).length;
    expect(() => recordScoringEvent(db, game.id, rally('A'))).toThrow(ScoringError);
    expect(listScoreEvents(db, game.id)).toHaveLength(n);
    expect(stateOf(loadScoreLog(db, game.id)).score).toEqual({ A: 0, B: 11 });
  });
});
