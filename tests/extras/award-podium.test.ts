/*
 * Podium placement (organizer request: "the ceremony shows only 1st and 3rd"). The official standing
 * keeps D9 competition ranking (1, 1, 3), while the podium on screen fills gold, silver and bronze in
 * order with ties sharing a step (dense placement) and an honest caption when the rank differs.
 */
import { describe, expect, it } from 'vitest';
import { computeAwards, placePodium, podiumCaption, podiumLayout, ordinal, type AwardGame, type PodiumPlayer } from '../../src/core/awards';

const row = (playerId: string, rank: number, wins = 3, losses = 0): PodiumPlayer & { rank: number } => ({
  playerId,
  name: playerId.toUpperCase(),
  wins,
  losses,
  winPct: wins / Math.max(1, wins + losses),
  pointDiff: 0,
  gamesPlayed: wins + losses,
  rank,
});

const shape = (rows: Array<PodiumPlayer & { rank: number }>) =>
  placePodium(rows).map((s) => ({ step: s.step, rank: s.rank, tied: s.tied, ids: s.players.map((p) => p.playerId) }));

describe('placePodium: gold, silver and bronze are always filled in order', () => {
  it('no ties: one player per step, official rank equals the step', () => {
    expect(shape([row('a', 1), row('b', 2), row('c', 3), row('d', 4)])).toEqual([
      { step: 1, rank: 1, tied: false, ids: ['a'] },
      { step: 2, rank: 2, tied: false, ids: ['b'] },
      { step: 3, rank: 3, tied: false, ids: ['c'] },
    ]);
  });

  it('tie for 1st (ranks 1, 1, 3, 4): both share gold, silver is rank 3, bronze is rank 4', () => {
    expect(shape([row('a', 1), row('b', 1), row('c', 3), row('d', 4), row('e', 5)])).toEqual([
      { step: 1, rank: 1, tied: true, ids: ['a', 'b'] },
      { step: 2, rank: 3, tied: false, ids: ['c'] },
      { step: 3, rank: 4, tied: false, ids: ['d'] },
    ]);
  });

  it('tie for 2nd (ranks 1, 2, 2, 4): the tied pair shares silver and bronze goes to rank 4', () => {
    expect(shape([row('a', 1), row('b', 2), row('c', 2), row('d', 4)])).toEqual([
      { step: 1, rank: 1, tied: false, ids: ['a'] },
      { step: 2, rank: 2, tied: true, ids: ['b', 'c'] },
      { step: 3, rank: 4, tied: false, ids: ['d'] },
    ]);
  });

  it('three-way tie for 1st: all on gold, then the next players take silver and bronze', () => {
    expect(shape([row('a', 1), row('b', 1), row('c', 1), row('d', 4), row('e', 5)])).toEqual([
      { step: 1, rank: 1, tied: true, ids: ['a', 'b', 'c'] },
      { step: 2, rank: 4, tied: false, ids: ['d'] },
      { step: 3, rank: 5, tied: false, ids: ['e'] },
    ]);
    // Only three players, all tied: one step is filled and the other two are vacant.
    expect(shape([row('a', 1), row('b', 1), row('c', 1)])).toEqual([{ step: 1, rank: 1, tied: true, ids: ['a', 'b', 'c'] }]);
  });

  it('fewer than 3 players: only the steps that have players', () => {
    expect(shape([])).toEqual([]);
    expect(shape([row('a', 1)])).toEqual([{ step: 1, rank: 1, tied: false, ids: ['a'] }]);
    expect(shape([row('a', 1), row('b', 2)])).toEqual([
      { step: 1, rank: 1, tied: false, ids: ['a'] },
      { step: 2, rank: 2, tied: false, ids: ['b'] },
    ]);
  });

  it('accepts rows in any order and keeps the record and the stats', () => {
    const steps = placePodium([row('c', 3, 1, 2), row('a', 1, 4, 0), row('b', 2, 3, 1)]);
    expect(steps.map((s) => s.record)).toEqual(['4-0', '3-1', '1-2']);
    expect(steps[0]?.players[0]).not.toHaveProperty('rank');
    expect(steps[0]?.players[0]).toMatchObject({ playerId: 'a', wins: 4, losses: 0, winPct: 1 });
  });

  it('does not mutate its input', () => {
    const rows = [row('b', 2), row('a', 1)];
    const copy = JSON.parse(JSON.stringify(rows));
    placePodium(rows);
    expect(rows).toEqual(copy);
  });
});

describe('podium captions and layout', () => {
  it('says nothing extra when the step is the official place', () => {
    expect(podiumCaption({ step: 1, rank: 1, tied: false })).toBeNull();
    expect(podiumCaption({ step: 3, rank: 3, tied: false })).toBeNull();
  });

  it('labels ties and official ranks that differ from the step', () => {
    expect(podiumCaption({ step: 1, rank: 1, tied: true })).toBe('Tied for 1st');
    expect(podiumCaption({ step: 2, rank: 2, tied: true })).toBe('Tied for 2nd');
    expect(podiumCaption({ step: 2, rank: 3, tied: false })).toBe('Rank 3');
    expect(podiumCaption({ step: 3, rank: 4, tied: true })).toBe('Tied · Rank 4');
  });

  it('ordinal numbers', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st']);
  });

  it('draws three positions left to right: silver, gold, bronze, vacant ones included', () => {
    const steps = placePodium([row('a', 1), row('b', 1), row('c', 1)]);
    const layout = podiumLayout(steps);
    expect(layout.map((l) => l.step)).toEqual([2, 1, 3]);
    expect(layout.map((l) => l.spot?.players.length ?? 0)).toEqual([0, 3, 0]);
  });
});

let seq = 0;
function game(a: string, b: string, winner: 'A' | 'B', score: [number, number] = winner === 'A' ? [11, 5] : [5, 11]): AwardGame {
  seq++;
  return {
    id: `p${seq}`,
    sessionId: 's1',
    format: 'singles',
    status: 'completed',
    teamAScore: score[0],
    teamBScore: score[1],
    winner,
    endedAt: `2026-10-21T18:${String(seq % 60).padStart(2, '0')}:00.000Z`,
    participants: [
      { playerId: a, team: 'A' },
      { playerId: b, team: 'B' },
    ],
  };
}
const NAMES = { a: 'Ana', b: 'Ben', c: 'Cy', d: 'Dee', e: 'Eve', f: 'Flo' };

describe('computeAwards exposes the drawn podium next to the official one', () => {
  it('tie for 1st: official podium has no 2nd place, the drawn podium still has three steps', () => {
    // a and b: identical 3-0; c: 2-2 (+0); e: 1-3; f: 0-4 (scores keep a/b identical).
    const games = [
      game('a', 'e', 'A'),
      game('b', 'e', 'A'),
      game('a', 'f', 'A'),
      game('b', 'f', 'A'),
      game('a', 'c', 'A'),
      game('b', 'c', 'A'),
      game('c', 'e', 'A'),
      game('c', 'f', 'A'),
      game('e', 'f', 'A'),
    ];
    const r = computeAwards({ scope: 'session', games, names: NAMES });
    expect(r.podium.map((p) => p.place)).toEqual([1, 3]);
    expect(r.podiumSteps.map((s) => [s.step, s.rank, s.tied, s.players.map((p) => p.name)])).toEqual([
      [1, 1, true, ['Ana', 'Ben']],
      [2, 3, false, ['Cy']],
      [3, 4, false, ['Eve']],
    ]);
  });

  it('provisional podium (nobody at the threshold) is placed the same way', () => {
    const games = [game('a', 'c', 'A'), game('b', 'd', 'A'), game('c', 'd', 'A')];
    const r = computeAwards({ scope: 'session', games, names: NAMES });
    expect(r.provisional).toBe(true);
    // a and b both 1-0 with the same points: tied for 1st; c 1-1 is rank 3; d 0-2 is rank 4.
    expect(r.podiumSteps.map((s) => [s.step, s.rank, s.players.map((p) => p.playerId)])).toEqual([
      [1, 1, ['a', 'b']],
      [2, 3, ['c']],
      [3, 4, ['d']],
    ]);
  });

  it('no games: no steps', () => {
    expect(computeAwards({ scope: 'session', games: [], names: NAMES }).podiumSteps).toEqual([]);
  });
});
