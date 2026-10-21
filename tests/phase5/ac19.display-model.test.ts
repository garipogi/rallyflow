/*
 * ============================================================================
 * PHASE 5 PUBLIC API — large-screen display model (brief §3 P1 "Large-screen display of active courts,
 * scores, and waiting queue", §4 "The large-screen display must not expose organizer controls",
 * §8 "A separate application view or window driven by the same local state", §9 AC-19).
 *
 * The display window renders ONLY this read-only projection, so it shows exactly what the organizer
 * state says (same courts, same scores/serving state, same queue order) and nothing organizer-only
 * (no recommendation explanations, override reasons, settings or ids beyond what is pinned here).
 *
 * src/core/display/index.ts  (pure: may import types/functions from src/core/scoring and
 *                             src/core/rotation only; no src/data, src/main, src/renderer, node:*, electron)
 *
 *   type DisplayCourtStatus = 'available' | 'unavailable' | 'in_use'
 *   interface DisplayInput {
 *     courts: ReadonlyArray<{ courtId: string; label: string; status: 'available' | 'unavailable' }>;
 *                                         in court-number order; the output keeps this order
 *     games: ReadonlyArray<{
 *       gameId: string; courtId: string; format: 'singles' | 'doubles';
 *       status: 'scheduled' | 'in_progress' | 'completed' | 'incomplete' | 'cancelled';
 *       teamA: readonly string[]; teamB: readonly string[];    player ids
 *       state: GameState | null;          src/core/scoring GameState; null until scoring has started
 *     }>;
 *     queue: ReadonlyArray<{ playerId: string; displayName: string; position: number }>;
 *                                         QueueEntry-compatible (extra fields allowed and ignored)
 *     names: Readonly<Record<string, string>>;   playerId -> name shown on the display
 *   }
 *   interface DisplayPlayer { playerId: string; name: string }
 *   interface DisplayTeam { players: DisplayPlayer[]; score: number }
 *   interface DisplayGame {
 *     gameId: string; format: 'singles' | 'doubles';
 *     started: boolean;                   state !== null
 *     teamA: DisplayTeam; teamB: DisplayTeam;   scores from state.score, 0 before scoring starts
 *     servingTeam: TeamId | null;         null before scoring starts
 *     serverNumber: 1 | 2 | null;         from state; null before start and in singles
 *     calledScore: string | null;         state.calledScore; null before start and once isOver
 *     isOver: boolean; winner: TeamId | null;
 *   }
 *   interface DisplayCourt { courtId: string; label: string; status: DisplayCourtStatus; game: DisplayGame | null }
 *                                         a court with a 'scheduled' or 'in_progress' game is 'in_use'
 *                                         and carries that game; 'completed' | 'incomplete' |
 *                                         'cancelled' games are never shown
 *   interface DisplayModel {
 *     courts: DisplayCourt[];
 *     queue: Array<{ position: number; playerId: string; name: string }>;   sorted by position
 *   }
 *   buildDisplayModel(input: DisplayInput): DisplayModel     never mutates its input
 * ============================================================================
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildDisplayModel, type DisplayInput } from '../../src/core/display';
import { applyEvent, initialState, type GameState, type ScoringEvent } from '../../src/core/scoring';

const NAMES: Record<string, string> = {
  p1: 'Ana',
  p2: 'Ben',
  p3: 'Cy',
  p4: 'Dee',
  p5: 'Eli',
  p6: 'Fay',
  p7: 'Gus',
  p8: 'Hal',
  p9: 'Ivy',
  p10: 'Jo',
};

const rally = (winner: 'A' | 'B'): ScoringEvent => ({ type: 'rally', winner });

function play(teamA: string[], teamB: string[], events: ScoringEvent[], format: 'singles' | 'doubles' = 'doubles'): GameState {
  let s = initialState({ format, teamA, teamB, firstServingTeam: 'A' });
  for (const e of events) s = applyEvent(s, e);
  return s;
}

const COURTS: DisplayInput['courts'] = [
  { courtId: 'c1', label: 'Court 1', status: 'available' },
  { courtId: 'c2', label: 'Court 2', status: 'available' },
  { courtId: 'c3', label: 'Court 3', status: 'unavailable' },
  { courtId: 'c4', label: 'Court 4', status: 'available' },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('AC-19 display model: courts', () => {
  it('lists every configured court in order with its status when nothing is playing', () => {
    const model = buildDisplayModel({ courts: COURTS, games: [], queue: [], names: NAMES });
    expect(model.courts).toEqual([
      { courtId: 'c1', label: 'Court 1', status: 'available', game: null },
      { courtId: 'c2', label: 'Court 2', status: 'available', game: null },
      { courtId: 'c3', label: 'Court 3', status: 'unavailable', game: null },
      { courtId: 'c4', label: 'Court 4', status: 'available', game: null },
    ]);
    expect(model.queue).toEqual([]);
  });

  it('shows an in-progress doubles game with current score, serving team, server number and called score', () => {
    // 0-0-2 start; A wins 3 rallies (3-0-2); B wins one: side out to B, server 1 => "0-3-1".
    const state = play(['p1', 'p2'], ['p3', 'p4'], [rally('A'), rally('A'), rally('A'), rally('B')]);
    expect(state.score).toEqual({ A: 3, B: 0 });
    expect(state.servingTeam).toBe('B');
    const model = buildDisplayModel({
      courts: COURTS,
      games: [{ gameId: 'g1', courtId: 'c2', format: 'doubles', status: 'in_progress', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], state }],
      queue: [],
      names: NAMES,
    });
    expect(model.courts[0]).toEqual({ courtId: 'c1', label: 'Court 1', status: 'available', game: null });
    expect(model.courts[1]).toEqual({
      courtId: 'c2',
      label: 'Court 2',
      status: 'in_use',
      game: {
        gameId: 'g1',
        format: 'doubles',
        started: true,
        teamA: { players: [{ playerId: 'p1', name: 'Ana' }, { playerId: 'p2', name: 'Ben' }], score: 3 },
        teamB: { players: [{ playerId: 'p3', name: 'Cy' }, { playerId: 'p4', name: 'Dee' }], score: 0 },
        servingTeam: 'B',
        serverNumber: 1,
        calledScore: state.calledScore,
        isOver: false,
        winner: null,
      },
    });
    expect(state.calledScore).toBe('0-3-1');
  });

  it('shows an assigned game that has not started scoring as in use with 0-0 and no serving state', () => {
    const model = buildDisplayModel({
      courts: COURTS,
      games: [{ gameId: 'g9', courtId: 'c1', format: 'singles', status: 'scheduled', teamA: ['p5'], teamB: ['p6'], state: null }],
      queue: [],
      names: NAMES,
    });
    expect(model.courts[0]?.status).toBe('in_use');
    expect(model.courts[0]?.game).toEqual({
      gameId: 'g9',
      format: 'singles',
      started: false,
      teamA: { players: [{ playerId: 'p5', name: 'Eli' }], score: 0 },
      teamB: { players: [{ playerId: 'p6', name: 'Fay' }], score: 0 },
      servingTeam: null,
      serverNumber: null,
      calledScore: null,
      isOver: false,
      winner: null,
    });
  });

  it('singles has no server number', () => {
    const state = play(['p1'], ['p2'], [rally('A'), rally('A')], 'singles');
    const model = buildDisplayModel({
      courts: COURTS,
      games: [{ gameId: 'g1', courtId: 'c4', format: 'singles', status: 'in_progress', teamA: ['p1'], teamB: ['p2'], state }],
      queue: [],
      names: NAMES,
    });
    const game = model.courts[3]?.game;
    expect(game?.serverNumber).toBeNull();
    expect(game?.teamA.score).toBe(2);
    expect(game?.servingTeam).toBe('A');
    expect(game?.calledScore).toBe(state.calledScore);
  });

  it('never shows completed, incomplete or cancelled games; their court is free again', () => {
    const done = play(['p1', 'p2'], ['p3', 'p4'], Array.from({ length: 11 }, () => rally('A')));
    expect(done.isOver).toBe(true);
    const model = buildDisplayModel({
      courts: COURTS,
      games: [
        { gameId: 'g1', courtId: 'c1', format: 'doubles', status: 'completed', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], state: done },
        { gameId: 'g2', courtId: 'c2', format: 'doubles', status: 'incomplete', teamA: ['p5', 'p6'], teamB: ['p7', 'p8'], state: null },
        { gameId: 'g3', courtId: 'c4', format: 'singles', status: 'cancelled', teamA: ['p9'], teamB: ['p10'], state: null },
      ],
      queue: [],
      names: NAMES,
    });
    expect(model.courts.map((c) => [c.label, c.status, c.game])).toEqual([
      ['Court 1', 'available', null],
      ['Court 2', 'available', null],
      ['Court 3', 'unavailable', null],
      ['Court 4', 'available', null],
    ]);
  });

  it('a finished-but-not-yet-finalized game is still shown, with the winner and no called score', () => {
    const over = play(['p1', 'p2'], ['p3', 'p4'], Array.from({ length: 11 }, () => rally('A')));
    const model = buildDisplayModel({
      courts: COURTS,
      games: [{ gameId: 'g1', courtId: 'c1', format: 'doubles', status: 'in_progress', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], state: over }],
      queue: [],
      names: NAMES,
    });
    const game = model.courts[0]?.game;
    expect(game?.isOver).toBe(true);
    expect(game?.winner).toBe('A');
    expect(game?.teamA.score).toBe(11);
    expect(game?.calledScore).toBeNull();
  });

  it('the active game is picked per court even when older finished games exist on the same court', () => {
    const old = play(['p1', 'p2'], ['p3', 'p4'], Array.from({ length: 11 }, () => rally('A')));
    const live = play(['p5', 'p6'], ['p7', 'p8'], [rally('A')]);
    const model = buildDisplayModel({
      courts: COURTS,
      games: [
        { gameId: 'old', courtId: 'c1', format: 'doubles', status: 'completed', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], state: old },
        { gameId: 'live', courtId: 'c1', format: 'doubles', status: 'in_progress', teamA: ['p5', 'p6'], teamB: ['p7', 'p8'], state: live },
      ],
      queue: [],
      names: NAMES,
    });
    expect(model.courts[0]?.game?.gameId).toBe('live');
    expect(model.courts[0]?.game?.teamA.score).toBe(1);
    expect(model.courts[0]?.game?.teamA.players.map((p) => p.name)).toEqual(['Eli', 'Fay']);
  });
});

describe('AC-19 display model: waiting queue', () => {
  it('lists the queue in position order with names, whatever order it arrives in', () => {
    const model = buildDisplayModel({
      courts: COURTS,
      games: [],
      queue: [
        { playerId: 'p7', displayName: 'Gus', position: 3 },
        { playerId: 'p5', displayName: 'Eli', position: 1 },
        { playerId: 'p9', displayName: 'Ivy', position: 2 },
      ],
      names: NAMES,
    });
    expect(model.queue).toEqual([
      { position: 1, playerId: 'p5', name: 'Eli' },
      { position: 2, playerId: 'p9', name: 'Ivy' },
      { position: 3, playerId: 'p7', name: 'Gus' },
    ]);
  });

  it('carries no organizer-only data from richer queue entries', () => {
    const entry = {
      playerId: 'p1',
      displayName: 'Ana',
      position: 1,
      eligibleSince: '2026-10-21T18:00:00.000Z',
      checkedInAt: '2026-10-21T17:55:00.000Z',
      gamesPlayed: 2,
      waitedMs: 120000,
      declinedCurrentTurn: false,
    };
    const model = buildDisplayModel({ courts: COURTS, games: [], queue: [entry], names: NAMES });
    expect(model.queue).toEqual([{ position: 1, playerId: 'p1', name: 'Ana' }]);
    expect(Object.keys(model).sort()).toEqual(['courts', 'queue']);
  });
});

describe('AC-19 display model: same state, pure projection', () => {
  it('tracks the score rally by rally from the same GameState the organizer uses', () => {
    const events: ScoringEvent[] = [rally('A'), rally('A'), rally('B'), rally('B'), rally('B'), rally('A')];
    let state = initialState({ format: 'doubles', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], firstServingTeam: 'A' });
    for (const e of events) {
      state = applyEvent(state, e);
      const game = buildDisplayModel({
        courts: COURTS,
        games: [{ gameId: 'g', courtId: 'c1', format: 'doubles', status: 'in_progress', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], state }],
        queue: [],
        names: NAMES,
      }).courts[0]?.game;
      expect(game?.teamA.score).toBe(state.score.A);
      expect(game?.teamB.score).toBe(state.score.B);
      expect(game?.servingTeam).toBe(state.servingTeam);
      expect(game?.serverNumber).toBe(state.serverNumber);
      expect(game?.calledScore).toBe(state.calledScore);
    }
  });

  it('does not mutate its input', () => {
    const state = play(['p1', 'p2'], ['p3', 'p4'], [rally('A')]);
    const input: DisplayInput = deepFreeze({
      courts: COURTS.map((c) => ({ ...c })),
      games: [{ gameId: 'g', courtId: 'c1', format: 'doubles' as const, status: 'in_progress' as const, teamA: ['p1', 'p2'], teamB: ['p3', 'p4'], state }],
      queue: [
        { playerId: 'p6', displayName: 'Fay', position: 2 },
        { playerId: 'p5', displayName: 'Eli', position: 1 },
      ],
      names: { ...NAMES },
    });
    const model = buildDisplayModel(input);
    expect(model.queue.map((q) => q.playerId)).toEqual(['p5', 'p6']);
    expect(input.queue.map((q) => q.playerId)).toEqual(['p6', 'p5']);
  });

  it('src/core/display stays pure (layering)', () => {
    const dir = resolve(process.cwd(), 'src/core/display');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const specs = [...src.matchAll(/from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
        (m) => m[1] ?? m[2] ?? m[3] ?? '',
      );
      for (const spec of specs) {
        expect(spec, `${f} imports ${spec}`).not.toMatch(/\/data\b|\/main\b|\/renderer\b|electron|^node:|^fs$|^path$/);
      }
    }
  });
});
