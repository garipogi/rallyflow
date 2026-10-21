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
  initialState,
  record,
  ScoringError,
  startLog,
  stateOf,
  undo,
  type GameSetup,
  type GameState,
  type ScoreLog,
  type ScoringEvent,
  type TeamId,
} from '../../src/core/scoring';
import { openDatabase, type Db } from '../../src/data/db';
import { SessionReadOnlyError, SessionStateError, ValidationError } from '../../src/data/errors';
import { createSession, finishSession } from '../../src/data/sessions';
import { listCourts } from '../../src/data/courts';
import { addNewPlayerToSession, checkInPlayer } from '../../src/data/roster';
import { createGame, getGame, listScoreEvents } from '../../src/data/games';
import {
  finalizeGame,
  loadScoreLog,
  recordScoringEvent,
  startScoring,
  undoLastScoringEvent,
} from '../../src/data/scoring';

const rally = (winner: TeamId): ScoringEvent => ({ type: 'rally', winner });
const seq = (s: string): ScoringEvent[] => [...s].map((c) => (c === 'a' || c === 'b' ? { type: 'fault', against: c.toUpperCase() as TeamId } : rally(c as TeamId)));

const DOUBLES: GameSetup = { format: 'doubles', teamA: ['a1', 'a2'], teamB: ['b1', 'b2'], firstServingTeam: 'A' };
const SINGLES: GameSetup = { format: 'singles', teamA: ['p'], teamB: ['q'], firstServingTeam: 'B' };

// Mixes points, server changes, side outs and faults ('a'/'b' = fault against A/B).
const SCRIPT = 'AABAbBBAABaBAAABBBABAAbBAB';

describe('AC-07 Undo restores the previous score and service state (Rules 5.A, 5.B, 6.B)', () => {
  it('after every action in a doubles script, undo gives back exactly the previous state (score, serving team, server number, positions, call)', () => {
    let log: ScoreLog = startLog(DOUBLES);
    for (const e of seq(SCRIPT)) {
      const before = stateOf(log);
      const after = record(log, e);
      const undone = undo(after);
      expect(undone.events).toEqual(log.events);
      expect(stateOf(undone)).toEqual(before);
      log = after;
    }
    expect(log.events).toHaveLength(SCRIPT.length);
  });

  it('after every action in a singles script, undo gives back exactly the previous state', () => {
    let log: ScoreLog = startLog(SINGLES);
    const states: GameState[] = [stateOf(log)];
    for (const e of seq(SCRIPT)) {
      log = record(log, e);
      states.push(stateOf(log));
    }
    for (let i = states.length - 1; i > 0; i--) {
      log = undo(log);
      expect(stateOf(log)).toEqual(states[i - 1]);
    }
  });

  it('undo all the way back to the start equals a fresh game, including the 0-0-2 first-server exception (Rule 5.B)', () => {
    let log: ScoreLog = startLog(DOUBLES);
    for (const e of seq(SCRIPT)) log = record(log, e);
    while (log.events.length > 0) log = undo(log);
    const s = stateOf(log);
    expect(s).toEqual(initialState(DOUBLES));
    expect(s).toMatchObject({ servingTeam: 'A', serverNumber: 2, serverId: 'a1', calledScore: '0-0-2', score: { A: 0, B: 0 }, rallies: 0 });
    expect(s.positions).toEqual({ a1: 'right', a2: 'left', b1: 'right', b2: 'left' });
  });

  it('Rule 5.B.6: undoing a side out returns the serve, server number and positions to the team that lost it', () => {
    // A: 0-0-2 → A scores (1-0-2) → A loses the rally: side out to B (0-1-1). Undo that side out.
    let log = startLog(DOUBLES);
    log = record(log, rally('A'));
    log = record(log, rally('B'));
    expect(stateOf(log)).toMatchObject({ servingTeam: 'B', serverNumber: 1, serverId: 'b1', calledScore: '0-1-1' });
    const s = stateOf(undo(log));
    expect(s).toMatchObject({ servingTeam: 'A', serverNumber: 2, serverId: 'a1', serverSide: 'left', receiverId: 'b2', calledScore: '1-0-2' });
    expect(s.positions).toEqual({ a1: 'left', a2: 'right', b1: 'right', b2: 'left' });
  });

  it('undo of the winning point re-opens play: isOver false, winner null, and the game can continue', () => {
    let log = startLog(SINGLES);
    for (let i = 0; i < 11; i++) log = record(log, rally('B'));
    expect(stateOf(log).isOver).toBe(true);
    log = undo(log);
    const s = stateOf(log);
    expect(s.isOver).toBe(false);
    expect(s.winner).toBeNull();
    expect(s.score).toEqual({ A: 0, B: 10 });
    log = record(log, rally('A')); // side out instead
    expect(stateOf(log)).toMatchObject({ servingTeam: 'A', score: { A: 0, B: 10 }, isOver: false });
  });

  it('undo with nothing to undo throws ScoringError; undo never mutates the log it is given', () => {
    expect(() => undo(startLog(DOUBLES))).toThrow(ScoringError);
    const log = record(record(startLog(DOUBLES), rally('A')), rally('A'));
    const frozen = Object.freeze({ setup: log.setup, events: Object.freeze([...log.events]) });
    const undone = undo(frozen);
    expect(frozen.events).toHaveLength(2);
    expect(undone.events).toHaveLength(1);
  });
});

describe('AC-07 Undo is persisted and survives a restart', () => {
  let dir: string;
  let file: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pb-p2-ac07-'));
    file = join(dir, 'app.db');
    db = openDatabase(file);
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function newGame(format: 'singles' | 'doubles') {
    const s = createSession(db, { name: 'Open play', courtCount: 2 });
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
    return { session: s, game, ids };
  }

  it('undoLastScoringEvent returns the previous state, updates the stored score, and is append-only', () => {
    const { game } = newGame('doubles');
    const states: GameState[] = [startScoring(db, game.id, { firstServingTeam: 'A' })];
    for (const e of seq('AAAB')) states.push(recordScoringEvent(db, game.id, e));
    expect(getGame(db, game.id)?.teamAScore).toBe(3);
    const rows = listScoreEvents(db, game.id).length;
    const undone = undoLastScoringEvent(db, game.id);
    expect(undone).toEqual(states[3]);
    expect(listScoreEvents(db, game.id).length).toBeGreaterThan(rows);
    const undone2 = undoLastScoringEvent(db, game.id);
    expect(undone2).toEqual(states[2]);
    expect(getGame(db, game.id)?.teamAScore).toBe(2);
    expect(loadScoreLog(db, game.id).events).toEqual(seq('AA'));
  });

  it('a game rebuilt after closing and reopening the database has the undone state, not the pre-undo one', () => {
    const { game, ids } = newGame('doubles');
    startScoring(db, game.id, { firstServingTeam: 'B' });
    for (const e of seq('BBABAB')) recordScoringEvent(db, game.id, e);
    const expected = undoLastScoringEvent(db, game.id);
    db.close();
    db = openDatabase(file);
    const log = loadScoreLog(db, game.id);
    expect(log.events).toEqual(seq('BBABA'));
    expect(log.setup).toMatchObject({ format: 'doubles', firstServingTeam: 'B' });
    expect([...log.setup.teamA, ...log.setup.teamB]).toEqual(ids);
    expect(stateOf(log)).toEqual(expected);
    // and scoring can carry on after the restart
    const next = recordScoringEvent(db, game.id, rally(expected.servingTeam));
    expect(next.rallies).toBe(expected.rallies + 1);
  });

  it('undo back to the start, then restart: the game is at 0-0-2 again', () => {
    const { game } = newGame('doubles');
    const start = startScoring(db, game.id, { firstServingTeam: 'A' });
    for (const e of seq('ABBA')) recordScoringEvent(db, game.id, e);
    for (let i = 0; i < 4; i++) undoLastScoringEvent(db, game.id);
    db.close();
    db = openDatabase(file);
    const s = stateOf(loadScoreLog(db, game.id));
    expect(s).toEqual(start);
    expect(s.calledScore).toBe('0-0-2');
    expect(getGame(db, game.id)?.teamAScore).toBe(0);
    expect(getGame(db, game.id)?.teamBScore).toBe(0);
  });

  it('undo with nothing to undo is rejected (ScoringError) and writes nothing', () => {
    const { game } = newGame('singles');
    startScoring(db, game.id, { firstServingTeam: 'A' });
    const n = listScoreEvents(db, game.id).length;
    expect(() => undoLastScoringEvent(db, game.id)).toThrow(ScoringError);
    expect(listScoreEvents(db, game.id)).toHaveLength(n);
  });

  it('undo is refused before scoring starts and after the game is finalized (SessionStateError)', () => {
    const { game } = newGame('singles');
    expect(() => undoLastScoringEvent(db, game.id)).toThrow(SessionStateError);
    startScoring(db, game.id, { firstServingTeam: 'A' });
    for (let i = 0; i < 11; i++) recordScoringEvent(db, game.id, rally('A'));
    finalizeGame(db, game.id);
    const n = listScoreEvents(db, game.id).length;
    expect(() => undoLastScoringEvent(db, game.id)).toThrow(SessionStateError);
    expect(listScoreEvents(db, game.id)).toHaveLength(n);
    expect(getGame(db, game.id)?.status).toBe('completed');
  });

  it('undo on a game of a completed session is refused with SessionReadOnlyError; unknown game is ValidationError', () => {
    const { session, game } = newGame('singles');
    startScoring(db, game.id, { firstServingTeam: 'A' });
    for (let i = 0; i < 11; i++) recordScoringEvent(db, game.id, rally('A'));
    finalizeGame(db, game.id);
    finishSession(db, session.id);
    expect(() => undoLastScoringEvent(db, game.id)).toThrow(SessionReadOnlyError);
    expect(() => recordScoringEvent(db, game.id, rally('A'))).toThrow(SessionReadOnlyError);
    expect(() => undoLastScoringEvent(db, 'no-such-game')).toThrow(ValidationError);
  });
});
