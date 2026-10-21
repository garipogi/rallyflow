/*
 * ============================================================================
 * PHASE 4 PUBLIC API — pure statistics (pinned by the locked tests; the builder implements it).
 * Policies: docs/DECISIONS.md D9 (leaderboard thresholds and tie rules); brief §6 "Statistics and
 * rankings". Builds on the locked phase 1–3 APIs and does not change them.
 *
 * src/core/stats/index.ts  (pure: no I/O; no imports from src/data, src/main, src/renderer,
 *                           node:*, electron or better-sqlite3; never mutates its inputs)
 *   type StatsGameStatus = 'scheduled' | 'in_progress' | 'completed' | 'incomplete' | 'cancelled'
 *   interface StatsGame {             a phase 1 `Game` (src/data/types) satisfies this structurally
 *     id: string; sessionId: string; format: 'singles' | 'doubles'; status: StatsGameStatus;
 *     teamAScore: number; teamBScore: number; winner: 'A' | 'B' | null;
 *     participants: readonly { playerId: string; team: 'A' | 'B' }[];
 *   }
 *   interface PlayerStats {
 *     playerId: string;
 *     gamesPlayed: number;            finalized games only (status 'completed' with a winner)
 *     wins: number; losses: number;   wins + losses === gamesPlayed (no draws, brief §6)
 *     winPct: number;                 wins / gamesPlayed, 0 when gamesPlayed is 0
 *     pointsFor: number;              sum of the player's TEAM score over finalized games
 *     pointsAgainst: number;          sum of the opposing team's score
 *     pointDiff: number;              pointsFor - pointsAgainst
 *   }
 *   interface PartnerRecord { playerId: string; partnerId: string; games: number; wins: number; losses: number }
 *   type LeaderboardScope = 'session' | 'historical'
 *   const DEFAULT_MIN_GAMES: { session: 3; historical: 10 }          D9
 *   interface LeaderboardRow extends PlayerStats {
 *     ranked: boolean;                gamesPlayed >= threshold
 *     rank: number | null;            null when unranked
 *     tied: boolean;                  true when another ranked row has the same rank; false when unranked
 *   }
 *   class StatsError extends Error
 *
 *   computePlayerStats(games: readonly StatsGame[], opts?: { playerIds?: readonly string[] }): PlayerStats[]
 *       Counts ONLY games with status 'completed' and winner !== null. Scheduled, in-progress,
 *       incomplete and cancelled games are ignored. Doubles results count for each of the two
 *       players on a team. One row per player in a counted game, plus a zero row for every id in
 *       opts.playerIds. Sorted ascending by playerId (plain string comparison).
 *       StatsError if two input games share an id (never double-count a game).
 *   computePartnerHistory(games: readonly StatsGame[]): PartnerRecord[]
 *       Finalized doubles games only. One record per ordered (player, partner) pair, so each
 *       partnership appears twice (once from each side). Sorted by playerId, then partnerId.
 *   buildLeaderboard(stats: readonly PlayerStats[],
 *                    opts: { scope: LeaderboardScope; minGames?: number }): LeaderboardRow[]
 *       threshold = opts.minGames ?? DEFAULT_MIN_GAMES[scope]; StatsError unless it is a
 *       non-negative integer. Ranked rows first, ordered by winPct desc, then wins desc, then
 *       pointDiff desc. Rows equal on all three are a tie: they share a rank and have tied = true,
 *       and the next rank skips (standard competition ranking: 1, 1, 3). Ties are listed by
 *       playerId ascending. Unranked rows (rank null, ranked false) come after every ranked row.
 *       Every input row appears exactly once in the output.
 *
 * Data-layer statistics (src/data/stats.ts), export (src/data/export.ts) and backup/restore
 * (src/data/backup.ts) are pinned in the headers of the other phase 4 test files.
 * ============================================================================
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLeaderboard,
  computePartnerHistory,
  computePlayerStats,
  DEFAULT_MIN_GAMES,
  StatsError,
  type LeaderboardRow,
  type PlayerStats,
  type StatsGame,
  type StatsGameStatus,
} from '../../src/core/stats';

let seq = 0;

/** A game between two teams; the winner is derived from the score unless the status says otherwise. */
function game(
  teamA: string[],
  teamB: string[],
  a: number,
  b: number,
  opts: { status?: StatsGameStatus; sessionId?: string; id?: string } = {},
): StatsGame {
  const status = opts.status ?? 'completed';
  return {
    id: opts.id ?? `g${++seq}`,
    sessionId: opts.sessionId ?? 's1',
    format: teamA.length === 2 ? 'doubles' : 'singles',
    status,
    teamAScore: a,
    teamBScore: b,
    winner: status === 'completed' ? (a > b ? 'A' : 'B') : null,
    participants: [
      ...teamA.map((playerId) => ({ playerId, team: 'A' as const })),
      ...teamB.map((playerId) => ({ playerId, team: 'B' as const })),
    ],
  };
}

function statsRow(p: Partial<PlayerStats> & { playerId: string; wins: number; losses: number }): PlayerStats {
  const gamesPlayed = p.wins + p.losses;
  const pointsFor = p.pointsFor ?? 0;
  const pointsAgainst = p.pointsAgainst ?? 0;
  return {
    playerId: p.playerId,
    gamesPlayed,
    wins: p.wins,
    losses: p.losses,
    winPct: gamesPlayed === 0 ? 0 : p.wins / gamesPlayed,
    pointsFor,
    pointsAgainst,
    pointDiff: p.pointDiff ?? pointsFor - pointsAgainst,
  };
}

function byId<T extends { playerId: string }>(rows: readonly T[], id: string): T {
  const row = rows.find((r) => r.playerId === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('AC-15 statistics: derived only from finalized games (brief §6)', () => {
  it('counts a finalized doubles game for each of the four players, with team points', () => {
    const stats = computePlayerStats([game(['p1', 'p2'], ['p3', 'p4'], 11, 7)]);
    expect(stats.map((s) => s.playerId)).toEqual(['p1', 'p2', 'p3', 'p4']);
    for (const id of ['p1', 'p2']) {
      expect(byId(stats, id)).toEqual({
        playerId: id, gamesPlayed: 1, wins: 1, losses: 0, winPct: 1, pointsFor: 11, pointsAgainst: 7, pointDiff: 4,
      });
    }
    for (const id of ['p3', 'p4']) {
      expect(byId(stats, id)).toEqual({
        playerId: id, gamesPlayed: 1, wins: 0, losses: 1, winPct: 0, pointsFor: 7, pointsAgainst: 11, pointDiff: -4,
      });
    }
  });

  it('ignores scheduled, in-progress, incomplete and cancelled games entirely', () => {
    const games = [
      game(['p1', 'p2'], ['p3', 'p4'], 11, 3),
      game(['p1', 'p2'], ['p3', 'p4'], 9, 4, { status: 'in_progress' }),
      game(['p1', 'p3'], ['p2', 'p4'], 6, 2, { status: 'incomplete' }),
      game(['p1', 'p4'], ['p2', 'p3'], 0, 0, { status: 'scheduled' }),
      game(['p5', 'p1'], ['p2', 'p3'], 5, 5, { status: 'cancelled' }),
      // A cancelled game that somehow carries a winner still does not count.
      { ...game(['p1', 'p2'], ['p3', 'p4'], 11, 0), status: 'cancelled' as const },
    ];
    const stats = computePlayerStats(games);
    expect(stats.map((s) => s.playerId)).toEqual(['p1', 'p2', 'p3', 'p4']); // p5 only played a cancelled game
    expect(byId(stats, 'p1')).toMatchObject({ gamesPlayed: 1, wins: 1, losses: 0, pointsFor: 11, pointsAgainst: 3 });
    expect(byId(stats, 'p4')).toMatchObject({ gamesPlayed: 1, wins: 0, losses: 1, pointsFor: 3, pointsAgainst: 11 });
  });

  it('a "completed" game without a winner is not counted', () => {
    const odd: StatsGame = { ...game(['a'], ['b'], 11, 4), winner: null };
    expect(computePlayerStats([odd])).toEqual([]);
  });

  it('aggregates singles and doubles across many games; wins + losses = games played', () => {
    const games = [
      game(['p1'], ['p2'], 11, 9),
      game(['p2'], ['p1'], 11, 2),
      game(['p1', 'p3'], ['p2', 'p4'], 15, 13),
      game(['p4', 'p2'], ['p3', 'p1'], 11, 0),
      game(['p3'], ['p4'], 4, 11),
    ];
    const stats = computePlayerStats(games);
    expect(byId(stats, 'p1')).toEqual({
      playerId: 'p1', gamesPlayed: 4, wins: 2, losses: 2, winPct: 0.5,
      pointsFor: 11 + 2 + 15 + 0, pointsAgainst: 9 + 11 + 13 + 11, pointDiff: 28 - 44,
    });
    expect(byId(stats, 'p2')).toMatchObject({ gamesPlayed: 4, wins: 2, losses: 2, pointsFor: 9 + 11 + 13 + 11, pointsAgainst: 11 + 2 + 15 + 0 });
    expect(byId(stats, 'p3')).toMatchObject({ gamesPlayed: 3, wins: 1, losses: 2, pointsFor: 15 + 0 + 4, pointsAgainst: 13 + 11 + 11 });
    expect(byId(stats, 'p4')).toMatchObject({ gamesPlayed: 3, wins: 2, losses: 1, pointsFor: 13 + 11 + 11, pointsAgainst: 15 + 0 + 4 });
    expect(byId(stats, 'p3').winPct).toBeCloseTo(1 / 3, 12);
    for (const s of stats) {
      expect(s.wins + s.losses).toBe(s.gamesPlayed);
      expect(s.pointDiff).toBe(s.pointsFor - s.pointsAgainst);
    }
  });

  it('includes zero rows for requested players and keeps rows sorted by playerId', () => {
    const stats = computePlayerStats([game(['zed'], ['amy'], 11, 5)], { playerIds: ['mia', 'amy'] });
    expect(stats.map((s) => s.playerId)).toEqual(['amy', 'mia', 'zed']);
    expect(byId(stats, 'mia')).toEqual({
      playerId: 'mia', gamesPlayed: 0, wins: 0, losses: 0, winPct: 0, pointsFor: 0, pointsAgainst: 0, pointDiff: 0,
    });
    expect(byId(stats, 'amy')).toMatchObject({ gamesPlayed: 1, losses: 1 });
  });

  it('refuses to count the same game twice', () => {
    const g = game(['p1'], ['p2'], 11, 1, { id: 'same' });
    expect(() => computePlayerStats([g, { ...g }])).toThrow(StatsError);
  });

  it('is pure: same input gives the same output and frozen input is not mutated', () => {
    const games = deepFreeze([
      game(['p1', 'p2'], ['p3', 'p4'], 11, 6),
      game(['p1', 'p3'], ['p2', 'p4'], 8, 11),
    ]);
    const first = computePlayerStats(games);
    const second = computePlayerStats(games);
    expect(second).toEqual(first);
    expect(first).not.toBe(second);
  });

  it('src/core/stats imports nothing from data/main/renderer, Node built-ins, Electron or SQLite', () => {
    const root = fileURLToPath(new URL('../../src/core/stats', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
      for (const spec of specs) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/(^|\/)(data|main|renderer)(\/|$)|^node:|^(fs|path|os|crypto|electron|better-sqlite3|exceljs)$/);
      }
    }
  });
});

describe('AC-15 statistics: partner history', () => {
  it('records each partnership from both sides, finalized doubles only', () => {
    const games = [
      game(['p1', 'p2'], ['p3', 'p4'], 11, 5),
      game(['p2', 'p1'], ['p3', 'p4'], 7, 11),
      game(['p1', 'p3'], ['p2', 'p4'], 11, 9),
      game(['p1', 'p2'], ['p3', 'p4'], 4, 2, { status: 'incomplete' }),
      game(['p1', 'p2'], ['p3', 'p4'], 0, 0, { status: 'cancelled' }),
      game(['p1'], ['p2'], 11, 3), // singles: no partner
    ];
    const history = computePartnerHistory(games);
    expect(history).toEqual([
      { playerId: 'p1', partnerId: 'p2', games: 2, wins: 1, losses: 1 },
      { playerId: 'p1', partnerId: 'p3', games: 1, wins: 1, losses: 0 },
      { playerId: 'p2', partnerId: 'p1', games: 2, wins: 1, losses: 1 },
      { playerId: 'p2', partnerId: 'p4', games: 1, wins: 0, losses: 1 },
      { playerId: 'p3', partnerId: 'p1', games: 1, wins: 1, losses: 0 },
      { playerId: 'p3', partnerId: 'p4', games: 2, wins: 1, losses: 1 },
      { playerId: 'p4', partnerId: 'p2', games: 1, wins: 0, losses: 1 },
      { playerId: 'p4', partnerId: 'p3', games: 2, wins: 1, losses: 1 },
    ]);
  });

  it('is empty when there are no finalized doubles games', () => {
    expect(computePartnerHistory([game(['a'], ['b'], 11, 2), game(['a', 'b'], ['c', 'd'], 3, 1, { status: 'in_progress' })])).toEqual([]);
  });
});

describe('AC-15 leaderboards: D9 thresholds', () => {
  it('defaults are 3 games for a session and 10 for historical', () => {
    expect(DEFAULT_MIN_GAMES.session).toBe(3);
    expect(DEFAULT_MIN_GAMES.historical).toBe(10);
  });

  it('session scope: 3+ completed games are ranked, fewer are shown unranked with games played', () => {
    const stats = [
      statsRow({ playerId: 'twoWins', wins: 2, losses: 0, pointsFor: 22, pointsAgainst: 2 }), // 100% but only 2 games
      statsRow({ playerId: 'three', wins: 1, losses: 2, pointsFor: 20, pointsAgainst: 30 }),
      statsRow({ playerId: 'four', wins: 2, losses: 2, pointsFor: 40, pointsAgainst: 40 }),
      statsRow({ playerId: 'none', wins: 0, losses: 0 }),
    ];
    const board = buildLeaderboard(stats, { scope: 'session' });
    expect(board.map((r) => r.playerId)).toEqual(['four', 'three', expect.any(String), expect.any(String)]);
    expect(byId(board, 'four')).toMatchObject({ ranked: true, rank: 1, tied: false, gamesPlayed: 4 });
    expect(byId(board, 'three')).toMatchObject({ ranked: true, rank: 2, tied: false, gamesPlayed: 3 });
    expect(byId(board, 'twoWins')).toMatchObject({ ranked: false, rank: null, tied: false, gamesPlayed: 2, winPct: 1 });
    expect(byId(board, 'none')).toMatchObject({ ranked: false, rank: null, tied: false, gamesPlayed: 0 });
    expect(new Set(board.slice(2).map((r) => r.playerId))).toEqual(new Set(['twoWins', 'none']));
  });

  it('historical scope: needs 10 games; 9 games is unranked even with a perfect record', () => {
    const stats = [
      statsRow({ playerId: 'nine', wins: 9, losses: 0, pointsFor: 99, pointsAgainst: 0 }),
      statsRow({ playerId: 'ten', wins: 1, losses: 9, pointsFor: 50, pointsAgainst: 110 }),
      statsRow({ playerId: 'twenty', wins: 12, losses: 8, pointsFor: 200, pointsAgainst: 180 }),
    ];
    const board = buildLeaderboard(stats, { scope: 'historical' });
    expect(board.map((r) => [r.playerId, r.rank, r.ranked])).toEqual([
      ['twenty', 1, true],
      ['ten', 2, true],
      ['nine', null, false],
    ]);
    // The same numbers in session scope rank everybody, best percentage first.
    const session = buildLeaderboard(stats, { scope: 'session' });
    expect(session.map((r) => [r.playerId, r.rank])).toEqual([['nine', 1], ['twenty', 2], ['ten', 3]]);
  });

  it('the threshold is configurable per call and validated', () => {
    const stats = [
      statsRow({ playerId: 'a', wins: 1, losses: 0 }),
      statsRow({ playerId: 'b', wins: 0, losses: 1 }),
      statsRow({ playerId: 'c', wins: 0, losses: 0 }),
    ];
    const board = buildLeaderboard(stats, { scope: 'session', minGames: 1 });
    expect(board.map((r) => [r.playerId, r.rank])).toEqual([['a', 1], ['b', 2], ['c', null]]);
    const all = buildLeaderboard(stats, { scope: 'historical', minGames: 0 });
    expect(all.every((r) => r.ranked)).toBe(true);
    expect(() => buildLeaderboard(stats, { scope: 'session', minGames: -1 })).toThrow(StatsError);
    expect(() => buildLeaderboard(stats, { scope: 'session', minGames: 2.5 })).toThrow(StatsError);
  });
});

describe('AC-15 leaderboards: D9 ordering and ties', () => {
  it('win % comes first, ahead of total wins', () => {
    const board = buildLeaderboard(
      [
        statsRow({ playerId: 'manyWins', wins: 8, losses: 2, pointsFor: 100, pointsAgainst: 60 }),
        statsRow({ playerId: 'perfect', wins: 3, losses: 0, pointsFor: 33, pointsAgainst: 20 }),
      ],
      { scope: 'session' },
    );
    expect(board.map((r) => [r.playerId, r.rank])).toEqual([['perfect', 1], ['manyWins', 2]]);
  });

  it('equal win % is broken by wins (6/8 above 3/4)', () => {
    const board = buildLeaderboard(
      [
        statsRow({ playerId: 'threeOfFour', wins: 3, losses: 1, pointsFor: 80, pointsAgainst: 10 }),
        statsRow({ playerId: 'sixOfEight', wins: 6, losses: 2, pointsFor: 50, pointsAgainst: 49 }),
      ],
      { scope: 'session' },
    );
    expect(board.map((r) => [r.playerId, r.rank, r.tied])).toEqual([['sixOfEight', 1, false], ['threeOfFour', 2, false]]);
  });

  it('equal win % and wins is broken by point differential', () => {
    const board = buildLeaderboard(
      [
        statsRow({ playerId: 'plus4', wins: 2, losses: 1, pointsFor: 30, pointsAgainst: 26 }),
        statsRow({ playerId: 'plus10', wins: 2, losses: 1, pointsFor: 31, pointsAgainst: 21 }),
        statsRow({ playerId: 'minus3', wins: 2, losses: 1, pointsFor: 25, pointsAgainst: 28 }),
      ],
      { scope: 'session' },
    );
    expect(board.map((r) => [r.playerId, r.rank, r.tied])).toEqual([
      ['plus10', 1, false],
      ['plus4', 2, false],
      ['minus3', 3, false],
    ]);
  });

  it('rows equal on win %, wins and point differential are shown as a tie (1, 1, 3)', () => {
    const board = buildLeaderboard(
      [
        statsRow({ playerId: 'zoe', wins: 2, losses: 1, pointsFor: 30, pointsAgainst: 25 }),
        statsRow({ playerId: 'last', wins: 0, losses: 3, pointsFor: 10, pointsAgainst: 33 }),
        statsRow({ playerId: 'adam', wins: 2, losses: 1, pointsFor: 28, pointsAgainst: 23 }), // same diff +5
        statsRow({ playerId: 'top', wins: 3, losses: 0, pointsFor: 33, pointsAgainst: 0 }),
        statsRow({ playerId: 'mid', wins: 2, losses: 1, pointsFor: 29, pointsAgainst: 25 }), // diff +4
      ],
      { scope: 'session' },
    );
    expect(board.map((r) => [r.playerId, r.rank, r.tied])).toEqual([
      ['top', 1, false],
      ['adam', 2, true],
      ['zoe', 2, true],
      ['mid', 4, false],
      ['last', 5, false],
    ]);
  });

  it('a three-way tie for first shares rank 1 and the next rank is 4', () => {
    const rows = ['c', 'a', 'b'].map((id) => statsRow({ playerId: id, wins: 3, losses: 3, pointsFor: 50, pointsAgainst: 50 }));
    rows.push(statsRow({ playerId: 'd', wins: 1, losses: 5, pointsFor: 40, pointsAgainst: 60 }));
    const board = buildLeaderboard(rows, { scope: 'session' });
    expect(board.map((r) => [r.playerId, r.rank, r.tied])).toEqual([
      ['a', 1, true],
      ['b', 1, true],
      ['c', 1, true],
      ['d', 4, false],
    ]);
  });

  it('unranked players never take a rank, even when their record is better', () => {
    const board = buildLeaderboard(
      [
        statsRow({ playerId: 'u1', wins: 2, losses: 0, pointsFor: 22, pointsAgainst: 0 }),
        statsRow({ playerId: 'r1', wins: 0, losses: 3, pointsFor: 5, pointsAgainst: 33 }),
        statsRow({ playerId: 'u2', wins: 1, losses: 0, pointsFor: 11, pointsAgainst: 9 }),
      ],
      { scope: 'session' },
    );
    expect(board[0]).toMatchObject({ playerId: 'r1', rank: 1, ranked: true });
    const ranks = board.filter((r) => r.ranked).map((r) => r.rank);
    expect(ranks).toEqual([1]);
    expect(board.slice(1).every((r: LeaderboardRow) => !r.ranked && r.rank === null && !r.tied)).toBe(true);
  });

  it('keeps every stats field, never mutates its input and outputs each row once', () => {
    const stats = deepFreeze([
      statsRow({ playerId: 'x', wins: 4, losses: 1, pointsFor: 50, pointsAgainst: 30 }),
      statsRow({ playerId: 'y', wins: 1, losses: 4, pointsFor: 30, pointsAgainst: 50 }),
      statsRow({ playerId: 'z', wins: 1, losses: 0, pointsFor: 11, pointsAgainst: 3 }),
    ]);
    const board = buildLeaderboard(stats, { scope: 'session' });
    expect(board).toHaveLength(3);
    expect(new Set(board.map((r) => r.playerId))).toEqual(new Set(['x', 'y', 'z']));
    for (const s of stats) expect(byId(board, s.playerId)).toMatchObject(s);
  });

  it('an empty input gives an empty leaderboard', () => {
    expect(buildLeaderboard([], { scope: 'historical' })).toEqual([]);
  });

  it('stats feed straight into a consistent leaderboard', () => {
    const games: StatsGame[] = [];
    // p1 beats p2 three times, p2 beats p3 three times, p3 beats p1 three times: a cycle.
    for (let i = 0; i < 3; i++) {
      games.push(game(['p1'], ['p2'], 11, 5));
      games.push(game(['p2'], ['p3'], 11, 5));
      games.push(game(['p3'], ['p1'], 11, 5));
    }
    games.push(game(['p4'], ['p1'], 11, 0)); // p4 has a single win: unranked in session scope
    const board = buildLeaderboard(computePlayerStats(games), { scope: 'session' });
    // p1: 3-4, points 48-59; p2: 3-3, diff 0; p3: 3-3, diff 0 -> p2 and p3 tie for 1st, p1 3rd.
    expect(board.map((r) => [r.playerId, r.rank, r.tied, r.gamesPlayed])).toEqual([
      ['p2', 1, true, 6],
      ['p3', 1, true, 6],
      ['p1', 3, false, 7],
      ['p4', null, false, 1],
    ]);
  });
});
