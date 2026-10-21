/**
 * D14 fairness mode: "balanced_games" keeps the number of games played level. Organizer report:
 * with 11 players on 2 courts, the earliest check-in (Gari) won every tie under the waiting-time
 * rule (D2) and ended the night with more games than everyone else.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  catchUpCredits,
  DEFAULT_ROTATION_SETTINGS,
  NEW_SESSION_ROTATION_SETTINGS,
  orderQueue,
  recommend,
  type CourtInput,
  type FairnessMode,
  type PastGame,
  type QueuePlayer,
  type Recommendation,
  type RotationSettings,
} from '../../src/core/rotation';
import { openDatabase, type Db } from '../../src/data/db';
import { createSession } from '../../src/data/sessions';
import { listCourts } from '../../src/data/courts';
import { addNewPlayerToSession, checkInPlayer, setAvailability } from '../../src/data/roster';
import { finalizeGame, recordScoringEvent, startScoring } from '../../src/data/scoring';
import {
  assignRecommendation,
  declineTurn,
  getQueue,
  getRotationSettings,
  recommendNextGames,
  setRotationSettings,
} from '../../src/data/rotation';
import { listGames } from '../../src/data/games';
import { ValidationError } from '../../src/data/errors';
import { createApiHandlers, type DbStore, type HostServices } from '../../src/main/handlers';

// ---------------------------------------------------------------- fake clock
const T0 = Date.parse('2026-10-21T18:00:00.000Z');
const at = (min: number): string => new Date(T0 + Math.round(min * 60000)).toISOString();
const SEC = 1 / 60;

const NAMES = ['Gari', 'Tristan', 'Benito', 'Karina', 'Nicole', 'Eli', 'Mara', 'Jun', 'Pia', 'Rex', 'Lou'];
const BALANCED: RotationSettings = { ...DEFAULT_ROTATION_SETTINGS, fairness: 'balanced_games', partnerRotation: true };

function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function courts(n: number): CourtInput[] {
  return Array.from({ length: n }, (_, i) => ({ courtId: `c${i + 1}`, label: `Court ${i + 1}`, status: 'available' as const, occupied: false }));
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const spread = (counts: Iterable<number>): number => {
  const xs = [...counts];
  return Math.max(...xs) - Math.min(...xs);
};

// ------------------------------------------------------- pure-engine simulator
interface SimPlayer extends QueuePlayer {
  busyUntil: number | null;
}

interface SimOptions {
  names: string[];
  courtCount: number;
  settings: RotationSettings;
  /** minutes of check-in per player (index = names index) */
  checkIn: number[];
  /** game length in minutes for a court and its n-th game */
  duration: (courtIndex: number, nth: number) => number;
  /** stop once this many games have started */
  games: number;
  seed?: string;
  /** called after every assignment round */
  onRound?: (players: SimPlayer[], recs: Recommendation[], now: number, courtStarts: (number | null)[]) => void;
  /** compute late-arrival credit with catchUpCredits before every round */
  useCredits?: boolean;
  /** skill level per player (index = names index) */
  skill?: (number | null)[];
}

/**
 * Event-driven open play on the pure engine: whenever a court frees, the four players it finished
 * become eligible at its end time (D5) and recommend() fills every free court.
 */
function simulate(opts: SimOptions) {
  const players: SimPlayer[] = opts.names.map((name, i) => ({
    playerId: `p${String(i + 1).padStart(2, '0')}`,
    displayName: name,
    checkedInAt: at(must(opts.checkIn[i])),
    eligibleSince: at(must(opts.checkIn[i])),
    status: 'waiting',
    gamesPlayed: 0,
    skillLevel: opts.skill?.[i] ?? null,
    busyUntil: null,
  }));
  const courtEnd: (number | null)[] = Array.from({ length: opts.courtCount }, () => null);
  const courtPlayers: string[][] = Array.from({ length: opts.courtCount }, () => []);
  const courtStart: (number | null)[] = Array.from({ length: opts.courtCount }, () => null);
  const nth = Array.from({ length: opts.courtCount }, () => 0);
  const pastGames: PastGame[] = [];
  const ended: { playerIds: string[]; endedAt: string }[] = [];
  const startTimes: Record<string, number[]> = {};
  let started = 0;
  let now = Math.max(0, Math.min(...opts.checkIn));

  while (started < opts.games) {
    // finish games ending now
    for (let c = 0; c < opts.courtCount; c++) {
      if (courtEnd[c] !== null && (courtEnd[c] as number) <= now + 1e-9) {
        for (const id of courtPlayers[c] as string[]) {
          const p = must(players.find((x) => x.playerId === id));
          p.status = 'waiting';
          p.gamesPlayed += 1;
          p.eligibleSince = at(courtEnd[c] as number);
        }
        ended.push({ playerIds: [...(courtPlayers[c] as string[])], endedAt: at(courtEnd[c] as number) });
        courtEnd[c] = null;
        courtStart[c] = null;
        courtPlayers[c] = [];
      }
    }
    const present = players.filter((p) => Date.parse(p.checkedInAt) <= Date.parse(at(now)));
    if (opts.useCredits) {
      const credits = catchUpCredits(
        present.map((p) => ({ playerId: p.playerId, checkedInAt: p.checkedInAt })),
        ended,
      );
      for (const p of present) p.gameCredit = credits.get(p.playerId) ?? 0;
    }
    const result = recommend({
      now: at(now),
      players: present,
      courts: courts(opts.courtCount).map((c, i) => ({ ...c, occupied: courtEnd[i] !== null })),
      settings: opts.settings,
      pastGames,
      seed: opts.seed ?? 'session-1',
    });
    for (const rec of result.recommendations) {
      const c = Number(rec.courtId.slice(1)) - 1;
      const length = opts.duration(c, nth[c] as number);
      nth[c] = (nth[c] as number) + 1;
      courtEnd[c] = now + length;
      courtStart[c] = now;
      courtPlayers[c] = [...rec.playerIds];
      for (const id of rec.playerIds) {
        const p = must(players.find((x) => x.playerId === id));
        expect(p.status, `${p.displayName} assigned twice`).toBe('waiting');
        p.status = 'playing';
        (startTimes[id] ??= []).push(now);
      }
      pastGames.push({ teamA: rec.teamA, teamB: rec.teamB });
      started++;
    }
    opts.onRound?.(players, result.recommendations, now, [...courtStart]);
    // advance to the next event: a court ending or a late check-in
    const nextEnd = Math.min(...courtEnd.filter((x): x is number => x !== null));
    const nextArrival = Math.min(...opts.checkIn.filter((m) => m > now + 1e-9));
    const next = Math.min(nextEnd, nextArrival);
    if (!Number.isFinite(next)) break;
    now = next;
  }

  // games started (in-progress games count, so the spread reflects who was chosen)
  const startedCount = new Map(players.map((p) => [p.displayName, (startTimes[p.playerId] ?? []).length] as const));
  return { players, pastGames, startedCount, startTimes };
}

/** The organizer's night: 11 players checked in a minute apart (Gari first), 2 courts finishing 1 s apart. */
function organizersNight(fairness: FairnessMode | undefined, rounds: number) {
  const settings: RotationSettings =
    fairness === 'balanced_games' ? BALANCED : { ...DEFAULT_ROTATION_SETTINGS };
  return simulate({
    names: NAMES,
    courtCount: 2,
    settings,
    checkIn: NAMES.map((_, i) => i - 20),
    duration: (court) => (court === 0 ? 12 : 12 + SEC),
    games: rounds * 2,
  });
}

// =========================================================================
describe('the reported 11-player / 2-court night', () => {
  it('default wait-time mode still favours the earliest check-in (locked D2 behaviour, shown for contrast)', () => {
    const { startedCount } = organizersNight(undefined, 11);
    expect(spread(startedCount.values())).toBeGreaterThanOrEqual(2);
    expect(startedCount.get('Gari')).toBe(Math.max(...startedCount.values()));
  });

  it('balanced_games keeps max(games) - min(games) <= 1 after every round', () => {
    let worst = 0;
    const { startedCount } = simulate({
      names: NAMES,
      courtCount: 2,
      settings: BALANCED,
      checkIn: NAMES.map((_, i) => i - 20),
      duration: (court) => (court === 0 ? 12 : 12 + SEC),
      games: 22,
      onRound: (players) => {
        const counts = players.map((p) => p.gamesPlayed + (p.status === 'playing' ? 1 : 0));
        worst = Math.max(worst, spread(counts));
      },
    });
    expect(worst).toBeLessThanOrEqual(1);
    expect(spread(startedCount.values())).toBeLessThanOrEqual(1);
    // 22 games x 4 seats = 88 = 11 x 8: everyone played exactly 8
    expect([...startedCount.values()].every((n) => n === 8)).toBe(true);
  });

  it('nobody sits out twice in a row while someone else plays twice in a row (balanced, equal-length games)', () => {
    const rounds: string[][] = [];
    simulate({
      names: NAMES,
      courtCount: 2,
      settings: BALANCED,
      checkIn: NAMES.map((_, i) => i - 20),
      duration: () => 12,
      games: 30,
      onRound: (_players, recs) => {
        if (recs.length === 2) rounds.push(recs.flatMap((r) => r.playerIds));
      },
    });
    expect(rounds.length).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < rounds.length; i++) {
      const prev = new Set(rounds[i - 1]);
      const sitters = NAMES.map((_, k) => `p${String(k + 1).padStart(2, '0')}`).filter((id) => !prev.has(id));
      // everyone who sat out the previous round plays this round
      for (const id of sitters) expect(rounds[i]).toContain(id);
    }
  });

  it('the same person does not win every tie: who sits out rotates', () => {
    const sitOuts = new Map<string, number>();
    simulate({
      names: NAMES,
      courtCount: 2,
      settings: BALANCED,
      checkIn: NAMES.map((_, i) => i - 20),
      duration: () => 12,
      games: 44,
      onRound: (players, recs) => {
        if (recs.length !== 2) return;
        for (const p of players) if (p.status === 'waiting') sitOuts.set(p.displayName, (sitOuts.get(p.displayName) ?? 0) + 1);
      },
    });
    expect(sitOuts.get('Gari') ?? 0).toBeGreaterThan(0);
    expect(spread(NAMES.map((n) => sitOuts.get(n) ?? 0))).toBeLessThanOrEqual(1);
  });
});

describe('balanced_games ordering (pure engine)', () => {
  const qp = (id: string, eligibleMin: number, extra: Partial<QueuePlayer> = {}): QueuePlayer => ({
    playerId: id,
    displayName: `Name-${id}`,
    checkedInAt: at(0),
    eligibleSince: at(eligibleMin),
    status: 'waiting',
    gamesPlayed: 0,
    skillLevel: null,
    ...extra,
  });

  it('fewer games first, then longer wait; check-in time is not a key', () => {
    const players = [
      qp('early', 10, { checkedInAt: at(-30), gamesPlayed: 3 }),
      qp('late', 12, { checkedInAt: at(-1), gamesPlayed: 2 }),
      qp('waited', 5, { checkedInAt: at(-2), gamesPlayed: 2 }),
    ];
    const q = orderQueue(players, at(20), { fairness: 'balanced_games', seed: 's' });
    expect(q.map((e) => e.playerId)).toEqual(['waited', 'late', 'early']);
    expect(q.map((e) => e.effectiveGames)).toEqual([2, 2, 3]);
    // the default ordering is untouched: eligibility time first
    expect(orderQueue(players, at(20)).map((e) => e.playerId)).toEqual(['waited', 'early', 'late']);
    expect(orderQueue(players, at(20))[0]).not.toHaveProperty('effectiveGames');
  });

  it('catch-up credit counts as games played when ranking', () => {
    const players = [qp('regular', 5, { gamesPlayed: 3 }), qp('newcomer', 0, { gamesPlayed: 0, gameCredit: 4 })];
    const q = orderQueue(players, at(20), { fairness: 'balanced_games' });
    expect(q.map((e) => e.playerId)).toEqual(['regular', 'newcomer']);
    expect(q[1]?.gameCredit).toBe(4);
  });

  it('equal games and equal wait: a seeded draw decides, varying with the game count and the session', () => {
    const tie = (games: number, seed: string): string =>
      must(
        orderQueue(
          ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => qp(id, 0, { gamesPlayed: games })),
          at(5),
          { fairness: 'balanced_games', seed },
        )[0],
      ).playerId;
    const firsts = new Set<string>();
    for (let g = 0; g < 12; g++) firsts.add(tie(g, 'night-1'));
    expect(firsts.size).toBeGreaterThan(1);
    const bySession = new Set<string>();
    for (let s = 0; s < 12; s++) bySession.add(tie(0, `night-${s}`));
    expect(bySession.size).toBeGreaterThan(1);
    // deterministic
    expect(tie(3, 'x')).toBe(tie(3, 'x'));
  });

  it('never picks playing, unavailable or declined players and never puts anyone in two games', () => {
    const players = [
      qp('busy', 0, { status: 'playing' }),
      qp('rest', 0, { status: 'unavailable' }),
      qp('no', 0, { declinedCurrentTurn: true }),
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((id, i) => qp(id, i, { gamesPlayed: i % 3 })),
    ];
    const r = recommend({ now: at(30), players, courts: courts(3), settings: BALANCED, seed: 's' });
    const chosen = r.recommendations.flatMap((x) => x.playerIds);
    expect(new Set(chosen).size).toBe(chosen.length);
    for (const id of ['busy', 'rest', 'no']) expect(chosen).not.toContain(id);
    expect(r.recommendations).toHaveLength(2);
    expect(r.openCourts.map((o) => o.courtId)).toEqual(['c3']);
    expect(r.openCourts[0]?.reason).toMatch(/stays open/);
  });

  it('skill balancing never passes over someone with fewer games for someone with more', () => {
    const players = [
      qp('a', 0, { gamesPlayed: 1, skillLevel: 2 }),
      qp('b', 1, { gamesPlayed: 1, skillLevel: 2 }),
      qp('c', 2, { gamesPlayed: 1, skillLevel: 2 }),
      qp('d', 3, { gamesPlayed: 1, skillLevel: 5 }),
      qp('e', 4, { gamesPlayed: 2, skillLevel: 2 }),
      qp('f', 5, { gamesPlayed: 2, skillLevel: 2 }),
    ];
    const rec = must(recommend({ now: at(30), players, courts: courts(1), settings: { ...BALANCED, skillBalancing: true } }).recommendations[0]);
    expect([...rec.playerIds].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(rec.bypassed).toEqual([]);
  });

  it('pairing prefers fewest repeat partners, then fewest repeat opponents, without changing who plays', () => {
    const players = ['a', 'b', 'c', 'd'].map((id, i) => qp(id, i, { gamesPlayed: 2 }));
    const pastGames: PastGame[] = [
      { teamA: ['a', 'd'], teamB: ['b', 'c'] },
      { teamA: ['a', 'c'], teamB: ['b', 'd'] },
    ];
    const rec = must(recommend({ now: at(30), players, courts: courts(1), settings: BALANCED, pastGames }).recommendations[0]);
    expect([...rec.playerIds].sort()).toEqual(['a', 'b', 'c', 'd']);
    const pairs = [rec.teamA, rec.teamB].map((t) => [...t].sort().join(''));
    expect(pairs.sort()).toEqual(['ab', 'cd']);
    expect(rec.repeatPartnerships).toBe(0);
    expect(rec.repeatOpponents).toBe(4);

    // every split repeats a partnership once: the one with fewer repeat opponents wins
    const history: PastGame[] = [
      { teamA: ['a', 'b'], teamB: ['x', 'y'] },
      { teamA: ['a', 'c'], teamB: ['x', 'z'] },
      { teamA: ['a', 'd'], teamB: ['b', 'c'] },
      { teamA: ['b', 'd'], teamB: ['a', 'c'] },
    ];
    // repeats per split: ab|cd = 1 (ab), ac|bd = 2 (ac, bd), ad|bc = 2 (ad, bc)
    const r2 = must(recommend({ now: at(30), players, courts: courts(1), settings: BALANCED, pastGames: history }).recommendations[0]);
    expect([r2.teamA, r2.teamB].map((t) => [...t].sort().join('')).sort()).toEqual(['ab', 'cd']);
  });

  it('explanations say why: game counts, fewest among waiting players, and the wait', () => {
    const players = [
      qp('g', 2, { displayName: 'Gari', gamesPlayed: 6 }),
      qp('e', 10, { displayName: 'Eli', gamesPlayed: 5 }),
      qp('m', 11, { displayName: 'Mara', gamesPlayed: 5 }),
      qp('j', 12, { displayName: 'Jun', gamesPlayed: 5 }),
      qp('p', 13, { displayName: 'Pia', gamesPlayed: 5 }),
    ];
    const rec = must(recommend({ now: at(14), players, courts: courts(1), settings: BALANCED }).recommendations[0]);
    expect(rec.playerIds).toEqual(['e', 'm', 'j', 'p']);
    const text = rec.explanation;
    expect(text).toContain('Court 1');
    expect(text).toContain('fewest games first');
    expect(text).toContain('Eli (#1 in the queue, 5 games played, fewest among waiting players, waited 4 min)');
    expect(text).toContain('Pia (#4 in the queue, 5 games played, fewest among waiting players, waited 1 min)');
    expect(text).toContain('Gari (6 games, waited 12 min) waits a turn: more games played than the players chosen.');
    expect(text).toMatch(/Partner rotation: no repeat partnerships, no repeat opponents\./);
    expect(rec.reasons[0]).toMatchObject({ playerId: 'e', gamesPlayed: 5, effectiveGames: 5 });
  });

  it('explanations mention catch-up credit and how a tie was settled', () => {
    const players = [
      qp('a', 0, { displayName: 'Ann', gamesPlayed: 0, gameCredit: 3 }),
      qp('b', 1, { displayName: 'Bo', gamesPlayed: 3 }),
      qp('c', 1, { displayName: 'Cy', gamesPlayed: 3 }),
      qp('d', 1, { displayName: 'Di', gamesPlayed: 3 }),
      qp('e', 1, { displayName: 'Ed', gamesPlayed: 3 }),
    ];
    const rec = must(recommend({ now: at(5), players, courts: courts(1), settings: BALANCED, seed: 's' }).recommendations[0]);
    expect(rec.explanation).toContain('0 games played + 3 catch-up for arriving late');
    expect(rec.explanation).toMatch(/Tied on 3 games with (Bo|Cy|Di|Ed): equal waits were settled by a draw/);
  });
});

describe('late arrivals: catch-up credit', () => {
  it('credit = fewest effective games among earlier, present players at the moment of check-in', () => {
    const credits = catchUpCredits(
      [
        { playerId: 'a', checkedInAt: at(0) },
        { playerId: 'b', checkedInAt: at(0) },
        { playerId: 'away', checkedInAt: at(0), countsTowardMinimum: false },
        { playerId: 'late', checkedInAt: at(30) },
        { playerId: 'later', checkedInAt: at(50) },
      ],
      [
        { playerIds: ['a', 'b'], endedAt: at(12) },
        { playerIds: ['a', 'b'], endedAt: at(24) },
        { playerIds: ['a'], endedAt: at(36) },
        { playerIds: ['b'], endedAt: at(60) },
      ],
    );
    expect(credits.get('a')).toBe(0);
    expect(credits.get('away')).toBe(0);
    expect(credits.get('late')).toBe(2); // a and b both had 2; "away" (0 games) is ignored
    expect(credits.get('later')).toBe(2); // b: 2, late: 0 + 2 credit, a: 3
  });

  it('a late arrival joins the rotation level with the regulars instead of playing every game', () => {
    const names = [...NAMES.slice(0, 10), 'Late'];
    const checkIn = [...NAMES.slice(0, 10).map((_, i) => i - 20), 60];
    const sim = (useCredits: boolean) => {
      let worstAfter = 0;
      const result = simulate({
        names,
        courtCount: 2,
        settings: BALANCED,
        checkIn,
        duration: () => 12,
        games: 30,
        useCredits,
        onRound: (players, _recs, now) => {
          if (now < 60) return;
          worstAfter = Math.max(
            worstAfter,
            spread(players.map((p) => p.gamesPlayed + (p.status === 'playing' ? 1 : 0) + (p.gameCredit ?? 0))),
          );
        },
      });
      const late = must(result.players.find((p) => p.displayName === 'Late'));
      const lateStarts = result.startTimes[late.playerId] ?? [];
      return { worstAfter, lateStarts, late };
    };
    const withCredit = sim(true);
    expect(withCredit.late.gameCredit).toBeGreaterThan(0);
    expect(withCredit.worstAfter).toBeLessThanOrEqual(1);
    // without credit the newcomer is first in line for game after game
    const without = sim(false);
    expect(without.lateStarts.slice(0, 4).length).toBe(4);
    const consecutive = (starts: number[]): number => {
      let best = 0;
      let run = 0;
      for (let i = 0; i < starts.length; i++) {
        run = i > 0 && Math.abs((starts[i] as number) - (starts[i - 1] as number) - 12) < 1e-6 ? run + 1 : 1;
        best = Math.max(best, run);
      }
      return best;
    };
    expect(consecutive(without.lateStarts)).toBeGreaterThanOrEqual(3);
    expect(consecutive(withCredit.lateStarts)).toBeLessThan(consecutive(without.lateStarts));
  });
});

describe('partner variety over a night', () => {
  it('balanced mode repeats partnerships far less than plain wait-time order', () => {
    const repeats = (settings: RotationSettings): number => {
      const { pastGames } = simulate({
        names: NAMES,
        courtCount: 2,
        settings,
        checkIn: NAMES.map((_, i) => i - 20),
        duration: (court) => (court === 0 ? 12 : 12 + SEC),
        games: 22,
      });
      const seen = new Map<string, number>();
      let total = 0;
      for (const g of pastGames) {
        for (const team of [g.teamA, g.teamB]) {
          const key = [...team].sort().join('|');
          const n = seen.get(key) ?? 0;
          if (n > 0) total++;
          seen.set(key, n + 1);
        }
      }
      return total;
    };
    const balanced = repeats(BALANCED);
    const plain = repeats({ ...DEFAULT_ROTATION_SETTINGS });
    const waitTimeWithRotation = repeats({ ...DEFAULT_ROTATION_SETTINGS, partnerRotation: true });
    // measured: balanced 7, wait time + partner rotation 16, plain wait time 30 (44 partnerships, 55 possible pairs)
    expect(balanced * 3).toBeLessThan(plain);
    expect(balanced).toBeLessThan(waitTimeWithRotation);
    expect(balanced).toBeLessThanOrEqual(8);
  });
});

describe('property: everyone continuously available keeps the spread <= 1', () => {
  const randomNight = (seed: number, duration: (rand: () => number) => (court: number, k: number) => number) => {
    const rand = rng(seed);
    const courtCount = 2 + Math.floor(rand() * 3);
    const n = courtCount * 4 + 1 + Math.floor(rand() * (32 - courtCount * 4));
    const names = Array.from({ length: n }, (_, i) => `N${i}`);
    return {
      courtCount,
      n,
      names,
      checkIn: names.map(() => -30 + Math.floor(rand() * 25)),
      skill: names.map(() => (rand() < 0.2 ? null : 2 + Math.round(rand() * 6) / 2)),
      settings: { ...BALANCED, skillBalancing: rand() < 0.5 } as RotationSettings,
      duration: duration(rand),
    };
  };

  it('holds over many random nights (players, courts, check-in order, round lengths, court offsets, skill balancing)', () => {
    // every round has its own random length (9-15 min); courts finish a few seconds apart in a
    // random order each round, like the reported night
    for (let seed = 1; seed <= 200; seed++) {
      const night = randomNight(seed, (rand) => {
        const roundLength = Array.from({ length: 64 }, () => 9 + rand() * 6);
        const offset = Array.from({ length: 4 * 64 }, () => rand() * 5 * SEC);
        return (court, k) => (roundLength[k] as number) + (offset[court * 64 + k] as number) - (k > 0 ? (offset[court * 64 + k - 1] as number) : 0);
      });
      let worst = 0;
      let checked = 0;
      simulate({
        ...night,
        games: night.courtCount * 12,
        seed: `seed-${seed}`,
        onRound: (ps, _recs, _now, starts) => {
          // measured once every court has been refilled in this round (between two courts finishing
          // seconds apart, one court's players are briefly a game ahead)
          if (starts.some((x) => x === null)) return;
          const s = starts as number[];
          if (Math.max(...s) - Math.min(...s) > 10 * SEC) return;
          checked++;
          worst = Math.max(worst, spread(ps.map((p) => p.gamesPlayed + (p.status === 'playing' ? 1 : 0))));
        },
      });
      expect(checked, `seed ${seed}`).toBeGreaterThan(5);
      expect(worst, `seed ${seed}: ${night.n} players on ${night.courtCount} courts`).toBeLessThanOrEqual(1);
    }
  });

  it('whatever the game lengths, nobody waiting is passed over for someone with more games', () => {
    // very uneven courts (8 to 20 minute games) can physically pull counts apart while players are on
    // court, but every assignment still takes the fewest-games waiting players first
    for (let seed = 1; seed <= 100; seed++) {
      const night = randomNight(seed, (rand) => () => 8 + rand() * 12);
      simulate({
        ...night,
        games: night.courtCount * 10,
        seed: `seed-${seed}`,
        onRound: (ps, recs) => {
          if (recs.length === 0) return;
          const chosenMax = Math.max(...recs.flatMap((r) => r.reasons.map((x) => must(x.effectiveGames))));
          const stillWaiting = ps.filter((p) => p.status === 'waiting').map((p) => p.gamesPlayed);
          if (stillWaiting.length > 0) expect(chosenMax, `seed ${seed}`).toBeLessThanOrEqual(Math.min(...stillWaiting));
        },
      });
    }
  });
});

// ------------------------------------------------------------ data layer
let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbop-balance-'));
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

function playOut(gameId: string, endedMin: number): void {
  startScoring(db, gameId, { firstServingTeam: 'A' });
  for (let i = 0; i < 11; i++) recordScoringEvent(db, gameId, { type: 'rally', winner: 'A' });
  finalizeGame(db, gameId, { endedAt: at(endedMin) });
}

let nightNo = 0;
function night(names: string[], fairness?: FairnessMode) {
  nightNo++;
  const session = createSession(db, { name: `CCF night ${nightNo}`, courtCount: 2, startedAt: at(-60) });
  if (fairness) setRotationSettings(db, session.id, { fairness, partnerRotation: fairness === 'balanced_games' }, { at: at(-59) });
  const ids = names.map((displayName, i) => {
    const entry = addNewPlayerToSession(db, session.id, { displayName, allowDuplicateName: true });
    checkInPlayer(db, session.id, entry.playerId, at(i - 30));
    return entry.playerId;
  });
  return { sessionId: session.id, ids, courts: listCourts(db, session.id) };
}

function gamesPerPlayer(sessionId: string, names: Map<string, string>): Map<string, number> {
  const counts = new Map<string, number>([...names.values()].map((n) => [n, 0]));
  for (const g of listGames(db, sessionId)) {
    for (const p of g.participants) {
      const name = must(names.get(p.playerId));
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

/** Rounds of the reported night through the data layer: court 1 ends, then court 2 one second later. */
function runRounds(sessionId: string, rounds: number): void {
  let t = 0;
  for (const rec of recommendNextGames(db, sessionId, { at: at(t) }).recommendations) assignRecommendation(db, sessionId, rec, { at: at(t) });
  for (let r = 0; r < rounds - 1; r++) {
    t += 12;
    for (const offset of [0, SEC]) {
      const active = listGames(db, sessionId).filter((g) => g.status === 'scheduled' || g.status === 'in_progress');
      const courtsInOrder = listCourts(db, sessionId);
      const court = must(courtsInOrder[offset === 0 ? 0 : 1]);
      const game = must(active.find((g) => g.courtId === court.id), 'active game');
      playOut(game.id, t + offset);
      for (const rec of recommendNextGames(db, sessionId, { at: at(t + offset) }).recommendations) {
        assignRecommendation(db, sessionId, rec, { at: at(t + offset) });
      }
    }
  }
}

describe('data layer: balanced_games through recommendNextGames and getQueue', () => {
  it('reproduces the report in default mode and fixes it in balanced mode (11 rounds)', () => {
    const plain = night(NAMES);
    const plainNames = new Map(plain.ids.map((id, i) => [id, NAMES[i] as string]));
    runRounds(plain.sessionId, 11);
    const before = gamesPerPlayer(plain.sessionId, plainNames);
    expect(spread(before.values())).toBeGreaterThanOrEqual(2);
    expect(before.get('Gari')).toBe(Math.max(...before.values()));

    const fair = night(NAMES, 'balanced_games');
    const fairNames = new Map(fair.ids.map((id, i) => [id, NAMES[i] as string]));
    runRounds(fair.sessionId, 11);
    const after = gamesPerPlayer(fair.sessionId, fairNames);
    expect(spread(after.values())).toBeLessThanOrEqual(1);
    expect([...after.values()].reduce((a, b) => a + b, 0)).toBe(88);
  });

  it('a late check-in gets catch-up credit in the queue', () => {
    const w = night(NAMES.slice(0, 8), 'balanced_games');
    runRounds(w.sessionId, 3); // everyone has played 2, 2 games in progress
    const late = addNewPlayerToSession(db, w.sessionId, { displayName: 'Late', allowDuplicateName: true });
    checkInPlayer(db, w.sessionId, late.playerId, at(25));
    const q = getQueue(db, w.sessionId, { at: at(26) });
    const entry = must(q.find((e) => e.playerId === late.playerId));
    expect(entry.gamesPlayed).toBe(0);
    expect(entry.gameCredit).toBe(2);
    expect(entry.effectiveGames).toBe(2);
  });

  it('a resting player keeps their place (D4) and catches up on return; away players do not shrink credits', () => {
    const w = night(NAMES.slice(0, 9), 'balanced_games');
    const rester = must(w.ids[8]);
    setAvailability(db, w.sessionId, rester, 'resting');
    runRounds(w.sessionId, 3);
    const late = addNewPlayerToSession(db, w.sessionId, { displayName: 'Late', allowDuplicateName: true });
    checkInPlayer(db, w.sessionId, late.playerId, at(25));
    expect(must(getQueue(db, w.sessionId, { at: at(26) }).find((e) => e.playerId === late.playerId)).gameCredit).toBe(2);
    setAvailability(db, w.sessionId, rester, 'available');
    const q = getQueue(db, w.sessionId, { at: at(26) });
    expect(q[0]?.playerId).toBe(rester);
    expect(q[0]?.effectiveGames).toBe(0);
  });

  it('declines still work: the decliner sits out this turn; drop_places drops places in the balanced queue', () => {
    const w = night(NAMES.slice(0, 6), 'balanced_games');
    const first = must(getQueue(db, w.sessionId, { at: at(0) })[0]).playerId;
    declineTurn(db, w.sessionId, first, { at: at(0) });
    const r = recommendNextGames(db, w.sessionId, { at: at(0) });
    expect(r.recommendations[0]?.playerIds).not.toContain(first);
    expect(r.recommendations[0]?.playerIds).toHaveLength(4);

    const w2 = night(NAMES.slice(0, 6), 'balanced_games');
    setRotationSettings(db, w2.sessionId, { declinePolicy: { kind: 'drop_places', places: 2 } });
    const before = getQueue(db, w2.sessionId, { at: at(0) }).map((e) => e.playerId);
    const after = declineTurn(db, w2.sessionId, must(before[0]), { at: at(0) }).map((e) => e.playerId);
    expect(after).toEqual([before[1], before[2], before[0], ...before.slice(3)]);
  });

  it('settings: absent by default, validated, persisted', () => {
    const w = night(NAMES.slice(0, 4));
    expect(getRotationSettings(db, w.sessionId)).toEqual(DEFAULT_ROTATION_SETTINGS);
    expect(getRotationSettings(db, w.sessionId)).not.toHaveProperty('fairness');
    expect(() => setRotationSettings(db, w.sessionId, { fairness: 'random' as FairnessMode })).toThrow(ValidationError);
    expect(setRotationSettings(db, w.sessionId, { fairness: 'balanced_games' }).fairness).toBe('balanced_games');
    expect(getRotationSettings(db, w.sessionId).fairness).toBe('balanced_games');
    expect(setRotationSettings(db, w.sessionId, { fairness: 'wait_time' }).fairness).toBe('wait_time');
  });

  it('balanced recommendation explanations from the data layer carry game counts', () => {
    const w = night(NAMES.slice(0, 9), 'balanced_games');
    runRounds(w.sessionId, 2);
    const recs = recommendNextGames(db, w.sessionId, { at: at(12) }).recommendations;
    for (const rec of recs) {
      expect(rec.explanation).toMatch(/\d+ games? played/);
      expect(rec.explanation).toMatch(/waited \d+ min/);
    }
  });
});

describe('new sessions from the organizer app start in balanced mode', () => {
  function handlers() {
    const store: DbStore = { current: () => db, close: () => undefined, open: () => undefined };
    const host: HostServices = {
      appVersion: 'test',
      dbFile: join(dir, 'app.db'),
      autoBackupDir: join(dir, 'auto'),
      chooseDirectory: async () => null,
      chooseSaveFile: async () => null,
      chooseOpenFile: async () => null,
      confirm: async () => true,
      openDisplay: () => undefined,
    };
    return createApiHandlers(store, host);
  }

  it('createSession through the API turns on balanced games and partner rotation', async () => {
    const api = handlers();
    const created = await api.createSession({ name: 'Friday', courtCount: 2 });
    expect(created.ok).toBe(true);
    const id = created.ok ? (created.value as { id: string }).id : '';
    const settings = getRotationSettings(db, id);
    expect(settings).toEqual({ ...DEFAULT_ROTATION_SETTINGS, ...NEW_SESSION_ROTATION_SETTINGS });
    expect(settings.fairness).toBe('balanced_games');
    expect(settings.partnerRotation).toBe(true);
  });

  it('the data-layer createSession keeps the engine defaults (locked phase 3 behaviour)', () => {
    const s = createSession(db, { name: 'Plain', courtCount: 2 });
    expect(getRotationSettings(db, s.id)).toEqual(DEFAULT_ROTATION_SETTINGS);
  });

  it('a failed create writes nothing', async () => {
    const api = handlers();
    const bad = await api.createSession({ name: '  ', courtCount: 2 });
    expect(bad.ok).toBe(false);
    expect((await api.listSessions()).ok).toBe(true);
  });
});
