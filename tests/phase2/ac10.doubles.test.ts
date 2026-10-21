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
  replay,
  ScoringError,
  startLog,
  type CourtSide,
  type GameSetup,
  type GameState,
  type ScoringEvent,
  type TeamId,
} from '../../src/core/scoring';
import { openDatabase, type Db } from '../../src/data/db';
import { createSession } from '../../src/data/sessions';
import { listCourts } from '../../src/data/courts';
import { addNewPlayerToSession, checkInPlayer } from '../../src/data/roster';
import { createGame, getGame, listScoreEvents } from '../../src/data/games';
import { loadScoreLog, recordScoringEvent, startScoring } from '../../src/data/scoring';

const rally = (winner: TeamId): ScoringEvent => ({ type: 'rally', winner });
const seq = (s: string): ScoringEvent[] => [...s].map((c) => rally(c as TeamId));

const DOUBLES: GameSetup = { format: 'doubles', teamA: ['a1', 'a2'], teamB: ['b1', 'b2'], firstServingTeam: 'A' };

interface Row {
  A: number;
  B: number;
  serving: TeamId;
  server: string;
  n: 1 | 2;
  receiver: string;
  call: string;
  /** a1 a2 b1 b2 sides, R/L */
  pos: string;
}

const SIDE: Record<string, CourtSide> = { R: 'right', L: 'left' };

/** Full doubles state: score, serving team, server and number, receiver, all 4 positions, call. */
function expectDoubles(s: GameState, r: Row, ids: readonly string[] = ['a1', 'a2', 'b1', 'b2']): void {
  expect(s.score).toEqual({ A: r.A, B: r.B });
  expect(s.servingTeam).toBe(r.serving);
  expect(s.receivingTeam).toBe(r.serving === 'A' ? 'B' : 'A');
  expect(s.serverId).toBe(r.server);
  expect(s.serverNumber).toBe(r.n);
  expect(s.receiverId).toBe(r.receiver);
  const expected: Record<string, CourtSide> = {};
  ids.forEach((id, i) => {
    expected[id] = SIDE[r.pos.replace(/\s/g, '')[i] as string] as CourtSide;
  });
  expect(s.positions).toEqual(expected);
  expect(s.serverSide).toBe(expected[r.server]);
  expect(s.calledScore).toBe(r.call);
}

describe('AC-10 Doubles: four players and the doubles service sequence (Rules 5.B, 6.B.2)', () => {
  it('Rules 5.B / 5.B.2 / 5.B.3 / 5.B.5 / 5.B.6 / 7.E / 6.B.2: full state after every rally of the worked opening in docs/RULES.md', () => {
    const steps: [TeamId | null, Row][] = [
      [null, { A: 0, B: 0, serving: 'A', server: 'a1', n: 2, receiver: 'b1', call: '0-0-2', pos: 'RL RL' }],
      ['A', { A: 1, B: 0, serving: 'A', server: 'a1', n: 2, receiver: 'b2', call: '1-0-2', pos: 'LR RL' }],
      ['B', { A: 1, B: 0, serving: 'B', server: 'b1', n: 1, receiver: 'a2', call: '0-1-1', pos: 'LR RL' }],
      ['B', { A: 1, B: 1, serving: 'B', server: 'b1', n: 1, receiver: 'a1', call: '1-1-1', pos: 'LR LR' }],
      ['A', { A: 1, B: 1, serving: 'B', server: 'b2', n: 2, receiver: 'a2', call: '1-1-2', pos: 'LR LR' }],
      ['B', { A: 1, B: 2, serving: 'B', server: 'b2', n: 2, receiver: 'a1', call: '2-1-2', pos: 'LR RL' }],
      ['A', { A: 1, B: 2, serving: 'A', server: 'a2', n: 1, receiver: 'b1', call: '1-2-1', pos: 'LR RL' }],
      ['A', { A: 2, B: 2, serving: 'A', server: 'a2', n: 1, receiver: 'b2', call: '2-2-1', pos: 'RL RL' }],
      ['B', { A: 2, B: 2, serving: 'A', server: 'a1', n: 2, receiver: 'b1', call: '2-2-2', pos: 'RL RL' }],
      ['B', { A: 2, B: 2, serving: 'B', server: 'b1', n: 1, receiver: 'a1', call: '2-2-1', pos: 'RL RL' }],
    ];
    let s = initialState(DOUBLES);
    for (const [w, row] of steps) {
      if (w) s = applyEvent(s, rally(w));
      expectDoubles(s, row);
    }
  });

  it('Rule 5.B (first-server exception): losing the very first rally is an immediate side out, not a pass to server 2', () => {
    const s = applyEvent(initialState(DOUBLES), rally('B'));
    expectDoubles(s, { A: 0, B: 0, serving: 'B', server: 'b1', n: 1, receiver: 'a1', call: '0-0-1', pos: 'RL RL' });
  });

  it('Rule 5.B.2: when B starts, B\'s starting server is second server at "0-0-2"; after the first side out both teams get two servers', () => {
    let s = initialState({ ...DOUBLES, firstServingTeam: 'B' });
    expectDoubles(s, { A: 0, B: 0, serving: 'B', server: 'b1', n: 2, receiver: 'a1', call: '0-0-2', pos: 'RL RL' });
    s = applyEvent(s, rally('A')); // first-server exception: side out
    expectDoubles(s, { A: 0, B: 0, serving: 'A', server: 'a1', n: 1, receiver: 'b1', call: '0-0-1', pos: 'RL RL' });
    s = applyEvent(s, rally('B')); // A's first server loses: A's second server (Rule 5.B.5)
    expectDoubles(s, { A: 0, B: 0, serving: 'A', server: 'a2', n: 2, receiver: 'b2', call: '0-0-2', pos: 'RL RL' });
    s = applyEvent(s, rally('B')); // A's second server loses: side out (Rule 5.B.6)
    expectDoubles(s, { A: 0, B: 0, serving: 'B', server: 'b1', n: 1, receiver: 'a1', call: '0-0-1', pos: 'RL RL' });
    s = applyEvent(s, rally('A')); // B now has a second server too
    expectDoubles(s, { A: 0, B: 0, serving: 'B', server: 'b2', n: 2, receiver: 'a2', call: '0-0-2', pos: 'RL RL' });
  });

  it('Rule 5.B.2: after a side out the FIRST server is whoever is on the right for the team score (odd score → the partner)', () => {
    // A scores 3 (odd) at 0-0-2, loses: B serves; B sides out twice; A serves again at 3: a2 is on the right.
    const s = replay(DOUBLES, seq('AAABAA'));
    expectDoubles(s, { A: 3, B: 0, serving: 'A', server: 'a2', n: 1, receiver: 'b1', call: '3-0-1', pos: 'LR RL' });
  });

  it('Rule 5.B.3: the receiving team never changes sides while the other team serves and scores', () => {
    let s = applyEvent(initialState(DOUBLES), rally('B')); // B serving 0-0-1
    const aSides = { a1: s.positions.a1, a2: s.positions.a2 };
    for (let i = 0; i < 7; i++) {
      s = applyEvent(s, rally('B'));
      expect({ a1: s.positions.a1, a2: s.positions.a2 }).toEqual(aSides);
      expect(s.positions.b1).toBe(s.score.B % 2 === 0 ? 'right' : 'left');
      expect(s.positions.b2).toBe(s.score.B % 2 === 0 ? 'left' : 'right');
    }
    expect(s.score).toEqual({ A: 0, B: 7 });
    // b1 serves every point of the run, alternating sides (Rule 5.B.5)
    expect(s.serverId).toBe('b1');
    expect(s.serverSide).toBe('left');
  });

  it('Rule 5.B.3: the starting server is the first listed player; listing the team the other way round changes who serves first', () => {
    const s = initialState({ ...DOUBLES, teamA: ['a2', 'a1'] });
    expect(s.serverId).toBe('a2');
    expect(s.positions).toMatchObject({ a2: 'right', a1: 'left' });
    const t = replay({ ...DOUBLES, teamB: ['b2', 'b1'] }, seq('B'));
    expect(t.serverId).toBe('b2');
    expect(t.receiverId).toBe('a1');
  });

  it('Rules 5.B / 4.B / 15.C: a long scripted doubles game, checked at milestones, ends 11-9 for A', () => {
    // A runs 4 at 0-0-2, side out; B: s1 scores 3, s2 scores 2, side out; A: s1 2, s2 0, side out;
    // B: s1 3, s2 0, side out (B 8); A: s1 1, s2 2, side out (A 9); B: s1 1, s2 0, side out (B 9);
    // A: s1 0, s2 2 → 11-9.
    const script =
      'AAAAB' + 'BBBABBA' + 'AABB' + 'BBBAA' + 'ABAAB' + 'BAA' + 'BAA';
    const milestones: Record<number, Row> = {
      5: { A: 4, B: 0, serving: 'B', server: 'b1', n: 1, receiver: 'a1', call: '0-4-1', pos: 'RL RL' },
      12: { A: 4, B: 5, serving: 'A', server: 'a1', n: 1, receiver: 'b2', call: '4-5-1', pos: 'RL LR' },
      16: { A: 6, B: 5, serving: 'B', server: 'b2', n: 1, receiver: 'a1', call: '5-6-1', pos: 'RL LR' },
      21: { A: 6, B: 8, serving: 'A', server: 'a1', n: 1, receiver: 'b1', call: '6-8-1', pos: 'RL RL' },
      26: { A: 9, B: 8, serving: 'B', server: 'b1', n: 1, receiver: 'a2', call: '8-9-1', pos: 'LR RL' },
      29: { A: 9, B: 9, serving: 'A', server: 'a2', n: 1, receiver: 'b2', call: '9-9-1', pos: 'LR LR' },
    };
    let s = initialState(DOUBLES);
    [...script].forEach((c, i) => {
      expect(s.isOver).toBe(false);
      s = applyEvent(s, rally(c as TeamId));
      const m = milestones[i + 1];
      if (m) expectDoubles(s, m);
    });
    expect(s.score).toEqual({ A: 11, B: 9 });
    expect(s.isOver).toBe(true);
    expect(s.winner).toBe('A');
    expect(s.serverNumber).toBe(2);
    expect(s.serverId).toBe('a1');
  });

  it('doubles needs four distinct players, two per side (brief §6), else ScoringError', () => {
    const bad: GameSetup[] = [
      { ...DOUBLES, teamA: ['a1'] },
      { ...DOUBLES, teamB: ['b1', 'b2', 'b3'] },
      { ...DOUBLES, teamB: ['b1', 'a1'] },
      { ...DOUBLES, teamA: ['a1', 'a1'] },
      { ...DOUBLES, teamA: [], teamB: [] },
    ];
    for (const setup of bad) {
      expect(() => initialState(setup)).toThrow(ScoringError);
      expect(() => startLog(setup)).toThrow(ScoringError);
    }
  });
});

describe('AC-10 Doubles games persisted through src/data/scoring', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pb-p2-ac10-'));
    db = openDatabase(join(dir, 'app.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function newDoubles(names: string[]) {
    const s = createSession(db, { name: 'Doubles night', courtCount: 3 });
    const ids: string[] = [];
    for (const name of names) {
      const e = addNewPlayerToSession(db, s.id, { displayName: name });
      checkInPlayer(db, s.id, e.playerId);
      ids.push(e.playerId);
    }
    const [w, x, y, z] = ids as [string, string, string, string];
    const court = listCourts(db, s.id)[2];
    if (!court) throw new Error('no court');
    // team A = [x, w]: x has startingPosition 1, so x is A's starting server
    const game = createGame(db, { sessionId: s.id, courtId: court.id, format: 'doubles', teamA: [x, w], teamB: [z, y] });
    return { game, w, x, y, z };
  }

  it('the starting servers come from startingPosition 1 and the opening is 0-0-2', () => {
    const { game, w, x, y, z } = newDoubles(['Wen', 'Xia', 'Yul', 'Zed']);
    const st = startScoring(db, game.id, { firstServingTeam: 'A' });
    expect(loadScoreLog(db, game.id).setup).toMatchObject({ format: 'doubles', teamA: [x, w], teamB: [z, y], firstServingTeam: 'A' });
    expectDoubles(st, { A: 0, B: 0, serving: 'A', server: x, n: 2, receiver: z, call: '0-0-2', pos: 'RL RL' }, [x, w, z, y]);
  });

  it('records the worked opening rally by rally, persisting each step and keeping the game row in sync', () => {
    const { game, w, x, y, z } = newDoubles(['Wen', 'Xia', 'Yul', 'Zed']);
    startScoring(db, game.id, { firstServingTeam: 'B' });
    const ids = [x, w, z, y];
    const rows = listScoreEvents(db, game.id).length;
    expectDoubles(recordScoringEvent(db, game.id, rally('B')), { A: 0, B: 1, serving: 'B', server: z, n: 2, receiver: w, call: '1-0-2', pos: 'RL LR' }, ids);
    expectDoubles(recordScoringEvent(db, game.id, rally('A')), { A: 0, B: 1, serving: 'A', server: x, n: 1, receiver: y, call: '0-1-1', pos: 'RL LR' }, ids);
    expectDoubles(recordScoringEvent(db, game.id, rally('B')), { A: 0, B: 1, serving: 'A', server: w, n: 2, receiver: z, call: '0-1-2', pos: 'RL LR' }, ids);
    expect(listScoreEvents(db, game.id).length).toBeGreaterThanOrEqual(rows + 3);
    expect(getGame(db, game.id)).toMatchObject({ teamAScore: 0, teamBScore: 1, status: 'in_progress' });
  });
});
