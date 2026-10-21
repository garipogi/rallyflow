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
  correct,
  record,
  replay,
  ScoringError,
  startLog,
  stateOf,
  type GameSetup,
  type ScoreLog,
  type ScoringEvent,
  type TeamId,
} from '../../src/core/scoring';
import { openDatabase, type Db } from '../../src/data/db';
import { ConfirmationRequiredError, SessionReadOnlyError, SessionStateError } from '../../src/data/errors';
import { createSession, finishSession, listAuditEvents, reopenSession } from '../../src/data/sessions';
import { listCourts } from '../../src/data/courts';
import { addNewPlayerToSession, checkInPlayer } from '../../src/data/roster';
import { createGame, getGame, getPlayerGameHistory, listGames, listScoreEvents } from '../../src/data/games';
import {
  correctScoringEvent,
  finalizeGame,
  loadScoreLog,
  recordScoringEvent,
  reopenGame,
  startScoring,
} from '../../src/data/scoring';

const rally = (winner: TeamId): ScoringEvent => ({ type: 'rally', winner });
const seq = (s: string): ScoringEvent[] => [...s].map((c) => rally(c as TeamId));
const logOf = (setup: GameSetup, events: ScoringEvent[]): ScoreLog => events.reduce(record, startLog(setup));

const DOUBLES: GameSetup = { format: 'doubles', teamA: ['a1', 'a2'], teamB: ['b1', 'b2'], firstServingTeam: 'A' };
const SINGLES: GameSetup = { format: 'singles', teamA: ['p'], teamB: ['q'], firstServingTeam: 'A' };

describe('AC-08 Correcting an earlier event replays everything after it (Rules 4.A, 5.B)', () => {
  it('correcting the first rally of a doubles game changes every later state to the replay of the corrected history', () => {
    const events = seq('ABBABBAAABABBBAABA');
    const log = logOf(DOUBLES, events);
    // Rally 0 was A's point at 0-0-2. Correct it: A actually lost it (immediate side out, Rule 5.B).
    const fixed = correct(log, 0, rally('B'));
    const expected = replay(DOUBLES, [rally('B'), ...events.slice(1)]);
    expect(stateOf(fixed)).toEqual(expected);
    expect(fixed.events[0]).toEqual(rally('B'));
    expect(fixed.events.slice(1)).toEqual(events.slice(1));
    // the corrected history really differs from the original
    expect(stateOf(fixed)).not.toEqual(stateOf(log));
    // the original log is untouched
    expect(log.events).toEqual(events);
  });

  it('correcting a middle rally keeps the earlier states and recomputes the later ones', () => {
    const events = seq('AABABBABBA');
    const log = logOf(SINGLES, events);
    const fixed = correct(log, 4, rally('A'));
    for (let i = 0; i < 4; i++) {
      expect(replay(SINGLES, fixed.events.slice(0, i))).toEqual(replay(SINGLES, events.slice(0, i)));
    }
    expect(stateOf(fixed)).toEqual(replay(SINGLES, [...events.slice(0, 4), rally('A'), ...events.slice(5)]));
  });

  it('a correction that would make a later event impossible is refused (ScoringError) and nothing changes', () => {
    // A runs 10-0 from 0-0-2; B wins the rally (side out); A wins twice (B server 1 → 2 → side out); A wins 11-0.
    const events = seq('AAAAAAAAAABAAA');
    const log = logOf(DOUBLES, events);
    expect(stateOf(log)).toMatchObject({ score: { A: 11, B: 0 }, isOver: true });
    // If rally 10 had been A's point, A wins 11-0 right there and rallies 11–13 could not have happened.
    expect(() => correct(log, 10, rally('A'))).toThrow(ScoringError);
    expect(log.events).toEqual(events);
  });

  it('corrections with an index out of range are refused (ScoringError)', () => {
    const log = logOf(DOUBLES, seq('AB'));
    expect(() => correct(log, 2, rally('A'))).toThrow(ScoringError);
    expect(() => correct(log, -1, rally('A'))).toThrow(ScoringError);
    expect(() => correct(log, 0.5, rally('A'))).toThrow(ScoringError);
    expect(() => correct(startLog(DOUBLES), 0, rally('A'))).toThrow(ScoringError);
  });

  it('a correction can turn a finished game back into an unfinished one', () => {
    const log = logOf(SINGLES, seq('AAAAAAAAAAA'));
    expect(stateOf(log).isOver).toBe(true);
    const fixed = correct(log, 10, rally('B'));
    expect(stateOf(fixed)).toMatchObject({ isOver: false, winner: null, servingTeam: 'B', score: { A: 10, B: 0 } });
  });
});

describe('AC-08 Reopened games are corrected without duplicate results (brief §5 D)', () => {
  let dir: string;
  let file: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pb-p2-ac08-'));
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

  /** Singles game won 11-2 by A: B scores 2 early, then A runs 11 points. */
  const SINGLES_11_2 = seq('BBBA' + 'A'.repeat(11)); // B wins the serve, scores 2, loses the serve; A scores 11

  function playFinished(format: 'singles' | 'doubles' = 'singles') {
    const g = newGame(format);
    startScoring(db, g.game.id, { firstServingTeam: 'A' });
    for (const e of SINGLES_11_2) recordScoringEvent(db, g.game.id, e);
    const done = finalizeGame(db, g.game.id);
    return { ...g, done };
  }

  it('the scripted game is the expected 11-2 win (sanity check of the fixture)', () => {
    const { done } = playFinished();
    expect(done).toMatchObject({ status: 'completed', winner: 'A', teamAScore: 11, teamBScore: 2 });
  });

  it('correcting a completed game without reopening it is refused (SessionStateError) and writes nothing', () => {
    const { session, game } = playFinished();
    const events = listScoreEvents(db, game.id).length;
    const audits = listAuditEvents(db, session.id).length;
    expect(() => correctScoringEvent(db, game.id, 1, rally('A'), { reason: 'misheard' })).toThrow(SessionStateError);
    expect(listScoreEvents(db, game.id)).toHaveLength(events);
    expect(listAuditEvents(db, session.id)).toHaveLength(audits);
    expect(getGame(db, game.id)).toMatchObject({ status: 'completed', teamAScore: 11, teamBScore: 2 });
  });

  it('reopening needs explicit confirmation (ConfirmationRequiredError); the game stays completed', () => {
    const { game } = playFinished();
    expect(() => reopenGame(db, game.id)).toThrow(ConfirmationRequiredError);
    expect(() => reopenGame(db, game.id, { reason: 'wrong score' })).toThrow(ConfirmationRequiredError);
    expect(() => reopenGame(db, game.id, { confirm: 'yes' as unknown as boolean })).toThrow(ConfirmationRequiredError);
    expect(getGame(db, game.id)).toMatchObject({ status: 'completed', winner: 'A' });
  });

  it('reopen → correct → finalize: one game, corrected score, audit with previous value, new value, time and reason', () => {
    const { session, game, ids } = playFinished();
    const reopened = reopenGame(db, game.id, { confirm: true, reason: 'score dispute' });
    expect(reopened).toMatchObject({ status: 'in_progress', winner: null, endedAt: null });
    const reopenAudit = listAuditEvents(db, session.id).filter((a) => a.action === 'game_reopened');
    expect(reopenAudit).toHaveLength(1);
    expect(reopenAudit[0]?.details).toEqual({ gameId: game.id, reason: 'score dispute' });

    // Rally 1 (B's first point) was really won by A: a side out, so B never scored.
    const before = loadScoreLog(db, game.id);
    expect(before.events[1]).toEqual(rally('B'));
    const t0 = Date.now();
    const corrected = correctScoringEvent(db, game.id, 1, rally('A'), { reason: 'ball was out' });
    expect(corrected).toEqual(replay(before.setup, [before.events[0] as ScoringEvent, rally('A'), ...before.events.slice(2)]));
    expect(corrected.isOver).toBe(true);
    expect(corrected.score).toEqual({ A: 11, B: 0 });
    expect(getGame(db, game.id)).toMatchObject({ teamAScore: 11, teamBScore: 0, status: 'in_progress' });

    const audits = listAuditEvents(db, session.id).filter((a) => a.action === 'score_correction');
    expect(audits).toHaveLength(1);
    const audit = audits[0];
    expect(audit?.details).toEqual({ gameId: game.id, eventIndex: 1, previous: rally('B'), next: rally('A'), reason: 'ball was out' });
    const at = Date.parse(audit?.occurredAt ?? '');
    expect(Number.isNaN(at)).toBe(false);
    expect(at).toBeGreaterThanOrEqual(t0 - 60_000);

    const final = finalizeGame(db, game.id);
    expect(final).toMatchObject({ status: 'completed', winner: 'A', teamAScore: 11, teamBScore: 0 });
    expect(() => finalizeGame(db, game.id)).toThrow(SessionStateError);

    // no duplicated result anywhere
    const games = listGames(db, session.id);
    expect(games).toHaveLength(1);
    expect(games.filter((g) => g.status === 'completed')).toHaveLength(1);
    for (const p of ids) expect(getPlayerGameHistory(db, p).filter((g) => g.id === game.id)).toHaveLength(1);
  });

  it('reopen then finalize again with no change does not create a second completion', () => {
    const { session, game } = playFinished();
    reopenGame(db, game.id, { confirm: true });
    expect(listAuditEvents(db, session.id).filter((a) => a.action === 'game_reopened')[0]?.details).toEqual({ gameId: game.id, reason: null });
    expect(() => reopenGame(db, game.id, { confirm: true })).toThrow(SessionStateError);
    const again = finalizeGame(db, game.id);
    expect(again).toMatchObject({ status: 'completed', winner: 'A', teamAScore: 11, teamBScore: 2 });
    expect(listGames(db, session.id)).toHaveLength(1);
    expect(() => finalizeGame(db, game.id)).toThrow(SessionStateError);
  });

  it('a correction that turns the win into an unfinished game blocks finalizing until play resumes', () => {
    const { game } = playFinished();
    reopenGame(db, game.id, { confirm: true });
    const last = loadScoreLog(db, game.id).events.length - 1;
    const s = correctScoringEvent(db, game.id, last, rally('B'), { reason: 'last rally went to B' });
    expect(s).toMatchObject({ isOver: false, score: { A: 10, B: 2 }, servingTeam: 'B' });
    expect(() => finalizeGame(db, game.id)).toThrow(ScoringError);
    expect(getGame(db, game.id)?.status).toBe('in_progress');
    expect(getGame(db, game.id)?.winner).toBeNull();
    // play resumes: B serves, loses, A serves and wins 11-2
    recordScoringEvent(db, game.id, rally('A'));
    recordScoringEvent(db, game.id, rally('A'));
    expect(finalizeGame(db, game.id)).toMatchObject({ status: 'completed', teamAScore: 11, teamBScore: 2 });
  });

  it('an impossible correction is refused (ScoringError) and writes no score event and no audit', () => {
    const { session, game } = newGame('doubles');
    startScoring(db, game.id, { firstServingTeam: 'A' });
    for (const e of seq('AAAAAAAAAABAA')) recordScoringEvent(db, game.id, e);
    const events = listScoreEvents(db, game.id).length;
    const audits = listAuditEvents(db, session.id).length;
    expect(() => correctScoringEvent(db, game.id, 10, rally('A'), { reason: 'x' })).toThrow(ScoringError);
    expect(listScoreEvents(db, game.id)).toHaveLength(events);
    expect(listAuditEvents(db, session.id)).toHaveLength(audits);
  });

  it('corrections of an in-progress game are audited too, with reason null when none is given', () => {
    const { session, game } = newGame('doubles');
    startScoring(db, game.id, { firstServingTeam: 'A' });
    for (const e of seq('AAB')) recordScoringEvent(db, game.id, e);
    const rows = listScoreEvents(db, game.id).length;
    const s = correctScoringEvent(db, game.id, 1, { type: 'fault', against: 'A', rule: '7.A.2.a' });
    expect(listScoreEvents(db, game.id).length).toBeGreaterThan(rows);
    // A's second point became a side out (first-server exception), so B served and won the last rally.
    expect(s.score).toEqual({ A: 1, B: 1 });
    expect(s.servingTeam).toBe('B');
    const audit = listAuditEvents(db, session.id).filter((a) => a.action === 'score_correction');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toEqual({
      gameId: game.id,
      eventIndex: 1,
      previous: rally('A'),
      next: { type: 'fault', against: 'A', rule: '7.A.2.a' },
      reason: null,
    });
  });

  it('a corrected, re-finalized game reconstructs identically after a restart', () => {
    const { game } = playFinished();
    reopenGame(db, game.id, { confirm: true, reason: 'fix' });
    const fixed = correctScoringEvent(db, game.id, 1, rally('A'), { reason: 'fix' });
    finalizeGame(db, game.id);
    const log = loadScoreLog(db, game.id);
    db.close();
    db = openDatabase(file);
    expect(loadScoreLog(db, game.id)).toEqual(log);
    expect(stateOf(loadScoreLog(db, game.id))).toEqual(fixed);
    expect(getGame(db, game.id)).toMatchObject({ status: 'completed', teamAScore: 11, teamBScore: 0, winner: 'A' });
  });

  it('every scoring action is committed before it returns: a second connection sees it immediately', () => {
    const { game } = newGame('doubles');
    startScoring(db, game.id, { firstServingTeam: 'B' });
    const other = openDatabase(file);
    try {
      const s1 = recordScoringEvent(db, game.id, rally('B'));
      expect(stateOf(loadScoreLog(other, game.id))).toEqual(s1);
      const s2 = recordScoringEvent(db, game.id, rally('A'));
      expect(stateOf(loadScoreLog(other, game.id))).toEqual(s2);
      expect(getGame(other, game.id)?.teamBScore).toBe(1);
    } finally {
      other.close();
    }
  });

  it('a completed session protects its games: reopenGame and corrections throw SessionReadOnlyError until the session is reopened', () => {
    const { session, game } = playFinished();
    finishSession(db, session.id);
    expect(() => reopenGame(db, game.id, { confirm: true })).toThrow(SessionReadOnlyError);
    expect(() => correctScoringEvent(db, game.id, 0, rally('B'))).toThrow(SessionReadOnlyError);
    expect(getGame(db, game.id)?.status).toBe('completed');
    reopenSession(db, session.id);
    expect(reopenGame(db, game.id, { confirm: true }).status).toBe('in_progress');
  });

  it('reopenGame is refused for a game that is not completed (SessionStateError)', () => {
    const { game } = newGame('singles');
    startScoring(db, game.id, { firstServingTeam: 'A' });
    expect(() => reopenGame(db, game.id, { confirm: true })).toThrow(SessionStateError);
  });

  it('startScoring twice is refused (SessionStateError); recording before startScoring is refused (SessionStateError)', () => {
    const { game } = newGame('singles');
    expect(() => recordScoringEvent(db, game.id, rally('A'))).toThrow(SessionStateError);
    expect(() => loadScoreLog(db, game.id)).toThrow(SessionStateError);
    startScoring(db, game.id, { firstServingTeam: 'A' });
    const n = listScoreEvents(db, game.id).length;
    expect(() => startScoring(db, game.id, { firstServingTeam: 'B' })).toThrow(SessionStateError);
    expect(listScoreEvents(db, game.id)).toHaveLength(n);
    expect(loadScoreLog(db, game.id).setup.firstServingTeam).toBe('A');
  });
});
