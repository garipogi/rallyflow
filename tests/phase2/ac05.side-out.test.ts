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

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  applyEvent,
  initialState,
  record,
  replay,
  RULES_EDITION,
  ScoringError,
  startLog,
  stateOf,
  type GameSetup,
  type GameState,
  type ScoringEvent,
  type TeamId,
} from '../../src/core/scoring';

const ROOT = resolve(__dirname, '..', '..');

const rally = (winner: TeamId): ScoringEvent => ({ type: 'rally', winner });
const fault = (against: TeamId): ScoringEvent => ({ type: 'fault', against });
const other = (t: TeamId): TeamId => (t === 'A' ? 'B' : 'A');
const seq = (s: string): ScoringEvent[] => [...s].map((c) => rally(c as TeamId));

const DOUBLES: GameSetup = { format: 'doubles', teamA: ['a1', 'a2'], teamB: ['b1', 'b2'], firstServingTeam: 'A' };
const SINGLES: GameSetup = { format: 'singles', teamA: ['p'], teamB: ['q'], firstServingTeam: 'A' };

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/** Small seeded PRNG so the "random" games are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const teamOf = (setup: GameSetup, t: TeamId): readonly string[] => (t === 'A' ? setup.teamA : setup.teamB);

/**
 * Checks every rule-derived property of a state on its own (Rules 5.A.1, 5.B.3, 7.E, 6.B.1, 6.B.2).
 */
function checkStateInvariants(setup: GameSetup, s: GameState): void {
  expect(s.receivingTeam).toBe(other(s.servingTeam));
  expect(Object.keys(s.positions).sort()).toEqual([...setup.teamA, ...setup.teamB].sort());
  expect(s.serverSide).toBe(s.positions[s.serverId]);
  expect(teamOf(setup, s.servingTeam)).toContain(s.serverId);
  expect(teamOf(setup, s.receivingTeam)).toContain(s.receiverId);
  // Rule 7.E: the receiver stands diagonally opposite, i.e. on the same side label as the server.
  expect(s.positions[s.receiverId]).toBe(s.serverSide);
  const S = s.score[s.servingTeam];
  const R = s.score[s.receivingTeam];
  if (setup.format === 'singles') {
    // Rule 5.A.1: both server and receiver are placed by the SERVER's score.
    const side = S % 2 === 0 ? 'right' : 'left';
    expect(s.serverSide).toBe(side);
    expect(s.positions[s.receiverId]).toBe(side);
    expect(s.serverNumber).toBeNull();
    expect(s.calledScore).toBe(`${S}-${R}`);
  } else {
    // Rule 5.B.3: starting server (index 0) right on even team score, left on odd; partner opposite.
    for (const t of ['A', 'B'] as const) {
      const [starter, partner] = teamOf(setup, t) as [string, string];
      const even = s.score[t] % 2 === 0;
      expect(s.positions[starter]).toBe(even ? 'right' : 'left');
      expect(s.positions[partner]).toBe(even ? 'left' : 'right');
    }
    expect(s.serverNumber === 1 || s.serverNumber === 2).toBe(true);
    expect(s.calledScore).toBe(`${S}-${R}-${s.serverNumber}`);
  }
}

/** Checks one transition against Rules 4.A, 5.A.2, 5.A.3, 5.B.2, 5.B.5, 5.B.6. */
function checkTransition(setup: GameSetup, prev: GameState, ev: ScoringEvent, next: GameState): void {
  const winner: TeamId = ev.type === 'rally' ? ev.winner : other(ev.against);
  expect(next.rallies).toBe(prev.rallies + 1);
  if (winner === prev.servingTeam) {
    // Rule 4.A: only the serving side scores; the same server keeps serving (5.A.2 / 5.B.5 / 5.B.6).
    expect(next.score[winner]).toBe(prev.score[winner] + 1);
    expect(next.score[other(winner)]).toBe(prev.score[other(winner)]);
    expect(next.servingTeam).toBe(prev.servingTeam);
    expect(next.serverId).toBe(prev.serverId);
    expect(next.serverNumber).toBe(prev.serverNumber);
  } else {
    // Receiving side won the rally: never a point (Rule 4.A).
    expect(next.score).toEqual(prev.score);
    if (setup.format === 'doubles' && prev.serverNumber === 1) {
      // Rule 5.B.5: serve passes to the partner, same team.
      expect(next.servingTeam).toBe(prev.servingTeam);
      expect(next.serverNumber).toBe(2);
      expect(next.serverId).not.toBe(prev.serverId);
      expect(teamOf(setup, prev.servingTeam)).toContain(next.serverId);
    } else {
      // Rules 5.A.3 / 5.B.6: side out.
      expect(next.servingTeam).toBe(other(prev.servingTeam));
      if (setup.format === 'doubles') {
        // Rule 5.B.2: the player on the right for the team's score is first server.
        expect(next.serverNumber).toBe(1);
        expect(next.serverSide).toBe('right');
      } else {
        expect(next.serverNumber).toBeNull();
      }
    }
  }
}

describe('AC-05 Standard side-out scoring (Rules 4.A, 4.B, 5.A, 5.B, 6.B)', () => {
  it('Rule 4.A: a rally won by the receiving team never scores a point (doubles and singles)', () => {
    for (const setup of [DOUBLES, SINGLES]) {
      let s = initialState(setup);
      for (let i = 0; i < 12; i++) {
        const receiving = s.receivingTeam;
        const before = { ...s.score };
        s = applyEvent(s, rally(receiving));
        expect(s.score).toEqual(before);
      }
      expect(s.score).toEqual({ A: 0, B: 0 });
      expect(s.rallies).toBe(12);
    }
  });

  it('Rule 4.A: a rally won by the serving team scores exactly one point for that team', () => {
    let s = initialState({ ...DOUBLES, firstServingTeam: 'B' });
    s = applyEvent(s, rally('B'));
    expect(s.score).toEqual({ A: 0, B: 1 });
    s = applyEvent(s, rally('B'));
    expect(s.score).toEqual({ A: 0, B: 2 });
    expect(s.servingTeam).toBe('B');
  });

  it('Rule 6.B.2 / 6.B.1: the opening score call is "0-0-2" in doubles and "0-0" in singles', () => {
    expect(initialState(DOUBLES).calledScore).toBe('0-0-2');
    expect(initialState(SINGLES).calledScore).toBe('0-0');
  });

  it('Rule 6.B.2: the call is serving score first, then receiving score, then server number', () => {
    // A scores 3, then the side out and B scores 1: B is serving, so B's score is called first.
    const s = replay(DOUBLES, seq('AAABB'));
    expect(s.servingTeam).toBe('B');
    expect(s.score).toEqual({ A: 3, B: 1 });
    expect(s.calledScore).toBe('1-3-1');
  });

  it('Rule 2 (Fault) / 9.B: a fault against a team has exactly the same effect as the other team winning the rally', () => {
    const rallies = seq('AABABBBAABBABAAB');
    const faults = rallies.map((e) => (e.type === 'rally' ? fault(other(e.winner)) : e));
    expect(replay(DOUBLES, faults)).toEqual(replay(DOUBLES, rallies));
    expect(replay(SINGLES, faults)).toEqual(replay(SINGLES, rallies));
  });

  it('Rules 5.A.3 / 5.B.6 / 7.E.1: a service fault by the serving side ends the service turn without a point', () => {
    // Doubles opening: first-server exception, so one service fault is a side out (Rule 5.B).
    let s = initialState(DOUBLES);
    s = applyEvent(s, { type: 'fault', against: 'A', rule: '7.E.1' });
    expect(s.servingTeam).toBe('B');
    expect(s.serverNumber).toBe(1);
    expect(s.score).toEqual({ A: 0, B: 0 });
    // Server 1 faults (Rule 6.D.1): passes to server 2 (Rule 5.B.5), then server 2 faults: side out.
    s = applyEvent(s, { type: 'fault', against: 'B', rule: '6.D.1' });
    expect(s.servingTeam).toBe('B');
    expect(s.serverNumber).toBe(2);
    s = applyEvent(s, { type: 'fault', against: 'B', rule: '7.A.3.a' });
    expect(s.servingTeam).toBe('A');
    expect(s.score).toEqual({ A: 0, B: 0 });
  });

  it('Rule 4.A: a fault by the receiving side (Rule 10.A.1) gives the serving team a point', () => {
    const s = applyEvent(initialState(SINGLES), { type: 'fault', against: 'B', rule: '10.A.1' });
    expect(s.score).toEqual({ A: 1, B: 0 });
    expect(s.servingTeam).toBe('A');
  });

  it('Rules 4.A, 5.A, 5.B, 7.E, 6.B: every transition and state in 40 seeded random games obeys the rules', () => {
    const setups: GameSetup[] = [
      DOUBLES,
      { ...DOUBLES, firstServingTeam: 'B' },
      { ...DOUBLES, targetScore: 15 },
      SINGLES,
      { ...SINGLES, firstServingTeam: 'B', targetScore: 21 },
    ];
    let games = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const setup = setups[seed % setups.length] as GameSetup;
      const rnd = mulberry32(seed);
      let s = initialState(setup);
      checkStateInvariants(setup, s);
      let steps = 0;
      while (!s.isOver && steps < 3000) {
        const r = rnd();
        const ev: ScoringEvent =
          r < 0.25 ? fault(rnd() < 0.5 ? 'A' : 'B') : rally(r < 0.25 + 0.75 * 0.55 ? s.servingTeam : s.receivingTeam);
        const next = applyEvent(s, ev);
        checkTransition(setup, s, ev, next);
        checkStateInvariants(setup, next);
        s = next;
        steps++;
      }
      expect(s.isOver).toBe(true);
      games++;
    }
    expect(games).toBe(40);
  });

  it('the engine is a pure, deterministic reducer: frozen input is not mutated and replay is reproducible', () => {
    const events = seq('AABBBAABABBAAAB');
    const s0 = deepFreeze(initialState(DOUBLES));
    const snapshot = JSON.parse(JSON.stringify(s0)) as unknown;
    let s: GameState = s0;
    for (const e of events) s = applyEvent(deepFreeze(s), deepFreeze({ ...e }));
    expect(JSON.parse(JSON.stringify(s0))).toEqual(snapshot);
    expect(replay(DOUBLES, events)).toEqual(s);
    expect(replay(DOUBLES, events)).toEqual(replay(DOUBLES, events));
    // the log form gives the same state as the reducer
    let log = startLog(DOUBLES);
    for (const e of events) log = record(log, e);
    expect(stateOf(log)).toEqual(s);
    expect(log.events).toHaveLength(events.length);
  });

  it('rejects malformed events with ScoringError', () => {
    const s = initialState(DOUBLES);
    expect(() => applyEvent(s, { type: 'rally', winner: 'C' } as unknown as ScoringEvent)).toThrow(ScoringError);
    expect(() => applyEvent(s, { type: 'serve' } as unknown as ScoringEvent)).toThrow(ScoringError);
    expect(() => applyEvent(s, { type: 'fault', against: 'X' } as unknown as ScoringEvent)).toThrow(ScoringError);
  });

  it('records the rules edition (D8): RULES_EDITION matches the Edition line of docs/RULES.md', () => {
    const md = readFileSync(join(ROOT, 'docs', 'RULES.md'), 'utf8');
    const m = /^Edition:\s*(.+?)\s*$/m.exec(md);
    expect(m).not.toBeNull();
    expect(RULES_EDITION).toBe((m as RegExpExecArray)[1]);
    expect(RULES_EDITION).toContain('2026');
    expect(RULES_EDITION).toContain('USA Pickleball');
  });

  it('src/core/scoring stays pure: no imports from src/data, src/main, src/renderer, node: or electron', () => {
    const dir = join(ROOT, 'src', 'core', 'scoring');
    expect(existsSync(dir)).toBe(true);
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.(ts|tsx|js|mjs)$/.test(n)) files.push(f);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(0);
    const bad = /(from|import|require\()\s*['"]((\.\.\/)+(data|main|renderer|preload)\b|node:|fs['"]|path['"]|electron|better-sqlite3)/;
    for (const f of files) expect(bad.test(readFileSync(f, 'utf8')), f).toBe(false);
  });
});
