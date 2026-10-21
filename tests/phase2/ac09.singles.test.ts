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
import { createGame, getGame } from '../../src/data/games';
import { loadScoreLog, recordScoringEvent, startScoring } from '../../src/data/scoring';

const rally = (winner: TeamId): ScoringEvent => ({ type: 'rally', winner });
const seq = (s: string): ScoringEvent[] => [...s].map((c) => rally(c as TeamId));

const SINGLES: GameSetup = { format: 'singles', teamA: ['p'], teamB: ['q'], firstServingTeam: 'A' };

interface Row {
  A: number;
  B: number;
  serving: TeamId;
  server: string;
  receiver: string;
  side: CourtSide;
  call: string;
}

/** Full singles state: score, serving team, server, receiver, both positions, call (Rules 5.A.1, 6.B.1). */
function expectSingles(s: GameState, r: Row): void {
  expect(s.score).toEqual({ A: r.A, B: r.B });
  expect(s.servingTeam).toBe(r.serving);
  expect(s.receivingTeam).toBe(r.serving === 'A' ? 'B' : 'A');
  expect(s.serverId).toBe(r.server);
  expect(s.receiverId).toBe(r.receiver);
  expect(s.serverNumber).toBeNull();
  expect(s.serverSide).toBe(r.side);
  expect(s.positions).toEqual({ [r.server]: r.side, [r.receiver]: r.side });
  expect(s.calledScore).toBe(r.call);
}

describe('AC-09 Singles: two players and the singles service rules (Rules 5.A, 6.B.1)', () => {
  it('Rules 5.A.1 / 5.A.2 / 5.A.3 / 6.B.1: full state after every rally of a scripted singles opening', () => {
    const steps: [ScoringEvent | null, Row][] = [
      [null, { A: 0, B: 0, serving: 'A', server: 'p', receiver: 'q', side: 'right', call: '0-0' }],
      [rally('A'), { A: 1, B: 0, serving: 'A', server: 'p', receiver: 'q', side: 'left', call: '1-0' }],
      [rally('A'), { A: 2, B: 0, serving: 'A', server: 'p', receiver: 'q', side: 'right', call: '2-0' }],
      [rally('B'), { A: 2, B: 0, serving: 'B', server: 'q', receiver: 'p', side: 'right', call: '0-2' }],
      [rally('B'), { A: 2, B: 1, serving: 'B', server: 'q', receiver: 'p', side: 'left', call: '1-2' }],
      [rally('A'), { A: 2, B: 1, serving: 'A', server: 'p', receiver: 'q', side: 'right', call: '2-1' }],
      [rally('A'), { A: 3, B: 1, serving: 'A', server: 'p', receiver: 'q', side: 'left', call: '3-1' }],
      [rally('B'), { A: 3, B: 1, serving: 'B', server: 'q', receiver: 'p', side: 'left', call: '1-3' }],
      [rally('B'), { A: 3, B: 2, serving: 'B', server: 'q', receiver: 'p', side: 'right', call: '2-3' }],
      [{ type: 'fault', against: 'B', rule: '7.E.1' }, { A: 3, B: 2, serving: 'A', server: 'p', receiver: 'q', side: 'left', call: '3-2' }],
      [{ type: 'fault', against: 'B', rule: '10.A.1' }, { A: 4, B: 2, serving: 'A', server: 'p', receiver: 'q', side: 'right', call: '4-2' }],
    ];
    let s = initialState(SINGLES);
    for (const [ev, row] of steps) {
      if (ev) s = applyEvent(s, ev);
      expectSingles(s, row);
    }
    expect(s.rallies).toBe(steps.length - 1);
  });

  it("Rule 5.A.1: the receiver's side follows the SERVER's score, not the receiver's own score", () => {
    // B serves at 1 (odd) while A has 2 (even): both stand on the left.
    const s1 = replay(SINGLES, seq('AABB'));
    expect(s1.score).toEqual({ A: 2, B: 1 });
    expect(s1.servingTeam).toBe('B');
    expect(s1.positions).toEqual({ q: 'left', p: 'left' });
    // A serves at 2 (even) while B has 1 (odd): both stand on the right.
    const s2 = applyEvent(s1, rally('A'));
    expect(s2.servingTeam).toBe('A');
    expect(s2.positions).toEqual({ p: 'right', q: 'right' });
  });

  it('Rule 5.A.3: in singles one lost rally is a side out (there is no second server)', () => {
    let s = initialState({ ...SINGLES, firstServingTeam: 'B' });
    expectSingles(s, { A: 0, B: 0, serving: 'B', server: 'q', receiver: 'p', side: 'right', call: '0-0' });
    s = applyEvent(s, rally('A'));
    expectSingles(s, { A: 0, B: 0, serving: 'A', server: 'p', receiver: 'q', side: 'right', call: '0-0' });
    s = applyEvent(s, rally('B'));
    expect(s.servingTeam).toBe('B');
  });

  it('Rules 5.A / 4.B: a long scripted singles game, checked at milestones, ends 11-7 for B', () => {
    // A: 3 points, side out; B: 5 points, side out; A: 2, side out; B: 1, side out; A: 2, side out;
    // B: 4, side out; A: 0 (immediate side out); B: 1 to win.
    const script = 'AAAB' + 'BBBBBA' + 'AAB' + 'BA' + 'AAB' + 'BBBBA' + 'B' + 'B';
    let s = initialState(SINGLES);
    const milestones: Record<number, Row> = {
      4: { A: 3, B: 0, serving: 'B', server: 'q', receiver: 'p', side: 'right', call: '0-3' },
      9: { A: 3, B: 5, serving: 'B', server: 'q', receiver: 'p', side: 'left', call: '5-3' },
      10: { A: 3, B: 5, serving: 'A', server: 'p', receiver: 'q', side: 'left', call: '3-5' },
      13: { A: 5, B: 5, serving: 'B', server: 'q', receiver: 'p', side: 'left', call: '5-5' },
      15: { A: 5, B: 6, serving: 'A', server: 'p', receiver: 'q', side: 'left', call: '5-6' },
      18: { A: 7, B: 6, serving: 'B', server: 'q', receiver: 'p', side: 'right', call: '6-7' },
      22: { A: 7, B: 10, serving: 'B', server: 'q', receiver: 'p', side: 'right', call: '10-7' },
      23: { A: 7, B: 10, serving: 'A', server: 'p', receiver: 'q', side: 'left', call: '7-10' },
      24: { A: 7, B: 10, serving: 'B', server: 'q', receiver: 'p', side: 'right', call: '10-7' },
    };
    [...script].forEach((c, i) => {
      expect(s.isOver).toBe(false);
      s = applyEvent(s, rally(c as TeamId));
      const m = milestones[i + 1];
      if (m) expectSingles(s, m);
    });
    expect(s.score).toEqual({ A: 7, B: 11 });
    expect(s.isOver).toBe(true);
    expect(s.winner).toBe('B');
    expect(s.rallies).toBe(script.length);
  });

  it('singles needs exactly one player per side and distinct players (brief §6), else ScoringError', () => {
    const bad: GameSetup[] = [
      { ...SINGLES, teamA: ['p', 'r'] },
      { ...SINGLES, teamB: [] },
      { ...SINGLES, teamA: ['p'], teamB: ['p'] },
      { ...SINGLES, teamA: [''], teamB: ['q'] },
      { ...SINGLES, firstServingTeam: 'C' as unknown as TeamId },
      { ...SINGLES, format: 'triples' as unknown as 'singles' },
    ];
    for (const setup of bad) {
      expect(() => initialState(setup)).toThrow(ScoringError);
      expect(() => startLog(setup)).toThrow(ScoringError);
    }
  });
});

describe('AC-09 Singles games persisted through src/data/scoring', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pb-p2-ac09-'));
    db = openDatabase(join(dir, 'app.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a two-player game scores with singles rules: no server number, two-number call, both players positioned', () => {
    const s = createSession(db, { name: 'Singles night', courtCount: 2 });
    const ids: string[] = [];
    for (const name of ['Rae', 'Sam']) {
      const e = addNewPlayerToSession(db, s.id, { displayName: name });
      checkInPlayer(db, s.id, e.playerId);
      ids.push(e.playerId);
    }
    const [rae, sam] = ids as [string, string];
    const court = listCourts(db, s.id)[1];
    if (!court) throw new Error('no court');
    const game = createGame(db, { sessionId: s.id, courtId: court.id, format: 'singles', teamA: [rae], teamB: [sam] });

    const st = startScoring(db, game.id, { firstServingTeam: 'B' });
    expectSingles(st, { A: 0, B: 0, serving: 'B', server: sam, receiver: rae, side: 'right', call: '0-0' });
    expect(loadScoreLog(db, game.id).setup).toMatchObject({ format: 'singles', teamA: [rae], teamB: [sam], firstServingTeam: 'B' });

    expectSingles(recordScoringEvent(db, game.id, rally('B')), { A: 0, B: 1, serving: 'B', server: sam, receiver: rae, side: 'left', call: '1-0' });
    expectSingles(recordScoringEvent(db, game.id, rally('A')), { A: 0, B: 1, serving: 'A', server: rae, receiver: sam, side: 'right', call: '0-1' });
    expectSingles(recordScoringEvent(db, game.id, { type: 'fault', against: 'B' }), { A: 1, B: 1, serving: 'A', server: rae, receiver: sam, side: 'left', call: '1-1' });
    expect(getGame(db, game.id)).toMatchObject({ teamAScore: 1, teamBScore: 1, format: 'singles' });
  });
});
