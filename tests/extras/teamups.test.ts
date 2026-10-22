/**
 * D15 single-court sessions and D16 team-up styles (random sit-out wheel, paddle stacking, up & down
 * the river, fixed partners, plus balanced and longest wait under their own names). The organizer
 * asked for 1-court sessions and for team-up choices; fairness (balanced games) decides who plays in
 * every grouping style.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyDecline,
  catchUpCredits,
  cyclePlayed,
  DEFAULT_ROTATION_SETTINGS,
  NEW_SESSION_ROTATION_SETTINGS,
  recommend,
  settingsForTeamUp,
  standings,
  startNewTurn,
  teamUpOf,
  type CourtInput,
  type PastGame,
  type QueuePlayer,
  type Recommendation,
  type RecommendationResult,
  type RotationSettings,
  type TeamUpStyle,
} from '../../src/core/rotation';
import { openDatabase, type Db } from '../../src/data/db';
import { createSession, getSession } from '../../src/data/sessions';
import { listCourts, setCourtCount } from '../../src/data/courts';
import { addNewPlayerToSession, checkInPlayer, setAvailability } from '../../src/data/roster';
import { recordGameResult } from '../../src/data/scoring';
import {
  assignManually,
  assignRecommendation,
  declineTurn,
  getQueue,
  getRotationSettings,
  listRotationEvents,
  recommendNextGames,
  setRotationSettings,
} from '../../src/data/rotation';
import { listGames } from '../../src/data/games';
import { getSessionLeaderboard } from '../../src/data/stats';
import { ValidationError } from '../../src/data/errors';
import { createApiHandlers, type DbStore, type HostServices } from '../../src/main/handlers';

// ---------------------------------------------------------------- helpers
const T0 = Date.parse('2026-10-22T18:00:00.000Z');
const at = (min: number): string => new Date(T0 + Math.round(min * 60000)).toISOString();
const ROUND = 15;
const GAME = 12;

const ALL_STYLES: TeamUpStyle[] = ['balanced', 'longest_wait', 'random', 'paddle_stack', 'river', 'fixed_partners'];
const GROUPING: TeamUpStyle[] = ['random', 'paddle_stack', 'river', 'fixed_partners'];

function settingsFor(style: TeamUpStyle, extra: Partial<RotationSettings> = {}): RotationSettings {
  return { ...DEFAULT_ROTATION_SETTINGS, declinePolicy: { kind: 'back_of_queue' }, ...settingsForTeamUp(style), ...extra };
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

const pid = (i: number): string => `p${String(i + 1).padStart(2, '0')}`;
const spread = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

interface SimConfig {
  style: TeamUpStyle;
  courts: number;
  players: number;
  rounds: number;
  seed: number;
  format?: 'singles' | 'doubles';
  /** player index -> round they check in (default 0) */
  arrivals?: Record<number, number>;
  /** player index -> [from, to) rounds they rest */
  rests?: Record<number, [number, number]>;
  declineChance?: number;
  fixedPairs?: [number, number][];
  onRound?: (round: RoundView) => void;
}

interface RoundView {
  round: number;
  now: string;
  players: QueuePlayer[];
  result: RecommendationResult;
  pastBefore: PastGame[];
  /** the previous round's games (teams, court, winner) */
  previous: PastGame[];
  courts: CourtInput[];
  settings: RotationSettings;
}

/**
 * Round-based open play on the pure engine: every round all courts are free, recommend() fills them,
 * every game lasts 12 minutes and a seeded coin decides the winner; the next round starts 3 minutes
 * after the games end.
 */
function simulate(cfg: SimConfig) {
  const r = rng(cfg.seed);
  const format = cfg.format ?? 'doubles';
  const settings = settingsFor(cfg.style, {
    format,
    ...(cfg.fixedPairs ? { fixedPairs: cfg.fixedPairs.map(([a, b]) => [pid(a), pid(b)]) } : {}),
  });
  const courtList = courts(cfg.courts);
  const arrivalRound = (i: number): number => cfg.arrivals?.[i] ?? 0;
  const resting = (i: number, round: number): boolean => {
    const span = cfg.rests?.[i];
    return span !== undefined && round >= span[0] && round < span[1];
  };
  const state = new Map<string, QueuePlayer>();
  const past: PastGame[] = [];
  const ended: { playerIds: string[]; endedAt: string }[] = [];
  let previous: PastGame[] = [];
  const seed = `sim-${cfg.seed}`;

  for (let round = 0; round < cfg.rounds; round++) {
    const startMin = round * ROUND;
    const now = at(startMin);
    for (let i = 0; i < cfg.players; i++) {
      const id = pid(i);
      if (arrivalRound(i) === round && !state.has(id)) {
        const checkedInAt = at(startMin - 1);
        state.set(id, { playerId: id, displayName: `P${i + 1}`, checkedInAt, eligibleSince: checkedInAt, status: 'waiting', gamesPlayed: 0, skillLevel: null });
      }
      const p = state.get(id);
      if (p) p.status = resting(i, round) ? 'unavailable' : 'waiting';
    }
    // late-arrival credit (D14), as the data layer computes it
    const credits = catchUpCredits(
      [...state.values()].map((p) => ({ playerId: p.playerId, checkedInAt: p.checkedInAt, countsTowardMinimum: p.status !== 'unavailable' })),
      ended,
    );
    let players: QueuePlayer[] = [...state.values()].map((p) => {
      const { gameCredit: _c, declinedCurrentTurn: _d, ...rest } = p;
      const credit = credits.get(p.playerId) ?? 0;
      return { ...rest, ...(credit > 0 ? { gameCredit: credit } : {}) };
    });
    if (cfg.declineChance && r() < cfg.declineChance) {
      const waiting = players.filter((p) => p.status === 'waiting');
      const who = waiting[Math.floor(r() * waiting.length)];
      if (who) players = applyDecline(players, who.playerId, now, settings.declinePolicy, { fairness: 'balanced_games', seed });
    }
    const result = recommend({ now, players, courts: courtList, settings, pastGames: past, seed });
    cfg.onRound?.({ round, now, players, result, pastBefore: [...past], previous, courts: courtList, settings });

    const thisRound: PastGame[] = [];
    const endAt = at(startMin + GAME);
    for (const rec of result.recommendations) {
      const winner = r() < 0.5 ? 'A' : 'B';
      const game: PastGame = { teamA: rec.teamA, teamB: rec.teamB, courtId: rec.courtId, startedAt: now, endedAt: endAt, winner };
      past.push(game);
      thisRound.push(game);
      ended.push({ playerIds: rec.playerIds, endedAt: endAt });
    }
    for (const p of startNewTurn(players)) {
      const s = state.get(p.playerId) as QueuePlayer;
      s.eligibleSince = p.eligibleSince;
      if (p.placeAfter !== undefined) s.placeAfter = p.placeAfter;
      else delete s.placeAfter;
    }
    for (const g of thisRound) {
      for (const id of [...g.teamA, ...g.teamB]) {
        const s = state.get(id) as QueuePlayer;
        s.gamesPlayed += 1;
        s.eligibleSince = endAt;
        delete s.placeAfter;
      }
    }
    previous = thisRound;
  }
  return { state, past };
}

/** Invariants that hold for every style in every round. */
function checkCommon(v: RoundView): void {
  const need = v.settings.format === 'singles' ? 2 : 4;
  const seen = new Set<string>();
  const byId = new Map(v.players.map((p) => [p.playerId, p] as const));
  for (const rec of v.result.recommendations) {
    expect(rec.playerIds).toHaveLength(need);
    expect(rec.teamA).toHaveLength(need / 2);
    expect(rec.teamB).toHaveLength(need / 2);
    expect(new Set([...rec.teamA, ...rec.teamB])).toEqual(new Set(rec.playerIds));
    expect(rec.explanation.length).toBeGreaterThan(20);
    for (const id of rec.playerIds) {
      expect(seen.has(id), `${id} assigned twice`).toBe(false);
      seen.add(id);
      const p = byId.get(id) as QueuePlayer;
      expect(p.status).toBe('waiting');
      expect(p.declinedCurrentTurn ?? false).toBe(false);
    }
  }
  // every free court is filled or reported open
  const free = v.courts.filter((c) => c.status === 'available' && !c.occupied).length;
  expect(v.result.recommendations.length + v.result.openCourts.length).toBe(free);
  const eligible = v.players.filter((p) => p.status === 'waiting' && !p.declinedCurrentTurn).length;
  if (v.result.openCourts.length > 0) expect(eligible - seen.size).toBeLessThan(need);
}

function lastPartnersOf(previous: readonly PastGame[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const g of previous) for (const team of [g.teamA, g.teamB]) for (const id of team) map.set(id, team.filter((x) => x !== id));
  return map;
}

function resultOf(previous: readonly PastGame[]): Map<string, 'winner' | 'loser'> {
  const map = new Map<string, 'winner' | 'loser'>();
  for (const g of previous) {
    for (const id of g.teamA) map.set(id, g.winner === 'A' ? 'winner' : 'loser');
    for (const id of g.teamB) map.set(id, g.winner === 'B' ? 'winner' : 'loser');
  }
  return map;
}

function splits(group: readonly string[]): { teamA: string[]; teamB: string[] }[] {
  return [1, 2, 3].map((y) => ({ teamA: [group[0] as string, group[y] as string], teamB: group.filter((_, i) => i !== 0 && i !== y) }));
}

// ------------------------------------------------------------- simulations

describe('every style: no double assignment, games stay level, one court works', () => {
  for (const style of ALL_STYLES) {
    for (const courtCount of [1, 2, 3, 4]) {
      for (const playerCount of [5, 8, 11, 14, 20]) {
        if (playerCount < courtCount * 2) continue;
        it(`${style}: ${courtCount} court(s), ${playerCount} players, continuously available -> spread <= 1 every round`, () => {
          const pairs: [number, number][] = style === 'fixed_partners' ? [[0, 1], [2, 3]] : [];
          simulate({
            style,
            courts: courtCount,
            players: playerCount,
            rounds: 24,
            seed: courtCount * 100 + playerCount,
            fixedPairs: pairs,
            onRound: (v) => {
              checkCommon(v);
              const counts = v.players.map((p) => p.gamesPlayed);
              // longest wait (D2) can drift by one more over a night; every other style keeps games level
              if (style !== 'longest_wait') expect(spread(counts), `round ${v.round}`).toBeLessThanOrEqual(1);
            },
          });
        });
      }
    }
  }

  for (const style of ALL_STYLES) {
    it(`${style}: late arrivals, rests and declines never break the invariants (1-4 courts, 5-20 players)`, () => {
      for (let seed = 1; seed <= 12; seed++) {
        const r = rng(seed * 7919);
        const courtCount = 1 + Math.floor(r() * 4);
        const playerCount = Math.max(5, courtCount * 4 - 2 + Math.floor(r() * (21 - courtCount * 4)));
        const arrivals: Record<number, number> = { [playerCount - 1]: 3, [playerCount - 2]: 6 };
        const rests: Record<number, [number, number]> = { 0: [2, 5], 3: [8, 9] };
        simulate({
          style,
          courts: courtCount,
          players: playerCount,
          rounds: 20,
          seed,
          arrivals,
          rests,
          declineChance: 0.4,
          fixedPairs: style === 'fixed_partners' ? [[1, 2], [4, 5]] : [],
          onRound: checkCommon,
        });
      }
    });
  }

  it('singles works in every style, including a single court', () => {
    for (const style of ALL_STYLES) {
      for (const courtCount of [1, 2]) {
        simulate({
          style,
          courts: courtCount,
          players: 5,
          rounds: 12,
          seed: 3,
          format: 'singles',
          onRound: (v) => {
            checkCommon(v);
            if (style !== 'longest_wait') expect(spread(v.players.map((p) => p.gamesPlayed))).toBeLessThanOrEqual(1);
          },
        });
      }
    }
  });

  it('a court stays open with an explanation when there are not enough players, in every style', () => {
    for (const style of GROUPING) {
      const players: QueuePlayer[] = [0, 1, 2, 3, 4, 5].map((i) => ({
        playerId: pid(i),
        displayName: `P${i + 1}`,
        checkedInAt: at(0),
        eligibleSince: at(0),
        status: 'waiting',
        gamesPlayed: 0,
        skillLevel: null,
      }));
      const res = recommend({ now: at(5), players, courts: courts(2), settings: settingsFor(style), pastGames: [], seed: 's' });
      expect(res.recommendations).toHaveLength(1);
      expect(res.openCourts).toHaveLength(1);
      expect(res.openCourts[0]?.reason).toMatch(/Court 2 stays open: doubles needs 4 eligible players but only 2 are waiting/);
    }
  });

  it('unavailable and occupied courts are skipped in every style', () => {
    for (const style of GROUPING) {
      const players: QueuePlayer[] = Array.from({ length: 12 }, (_, i) => ({
        playerId: pid(i),
        displayName: `P${i + 1}`,
        checkedInAt: at(0),
        eligibleSince: at(0),
        status: 'waiting' as const,
        gamesPlayed: 0,
        skillLevel: null,
      }));
      const list = courts(3);
      list[0] = { ...(list[0] as CourtInput), status: 'unavailable' };
      list[1] = { ...(list[1] as CourtInput), occupied: true };
      const res = recommend({ now: at(5), players, courts: list, settings: settingsFor(style), pastGames: [], seed: 's' });
      expect(res.recommendations.map((r) => r.courtId)).toEqual(['c3']);
      expect(res.skippedCourts).toEqual([
        { courtId: 'c1', reason: 'unavailable' },
        { courtId: 'c2', reason: 'occupied' },
      ]);
    }
  });

  it('settings without teamUp behave exactly as before; balanced / longest_wait name the original engines', () => {
    const players: QueuePlayer[] = Array.from({ length: 9 }, (_, i) => ({
      playerId: pid(i),
      displayName: `P${i + 1}`,
      checkedInAt: at(i),
      eligibleSince: at(i),
      status: 'waiting' as const,
      gamesPlayed: i % 3,
      skillLevel: null,
    }));
    const base = { now: at(20), players, courts: courts(2), pastGames: [], seed: 'x' };
    const strip = (res: RecommendationResult) =>
      res.recommendations.map(({ teamUp: _t, ...rest }) => rest);
    const oldBalanced = recommend({ ...base, settings: { ...DEFAULT_ROTATION_SETTINGS, fairness: 'balanced_games', partnerRotation: true } });
    const newBalanced = recommend({ ...base, settings: settingsFor('balanced') });
    expect(strip(newBalanced)).toEqual(strip(oldBalanced));
    expect(newBalanced.recommendations[0]?.teamUp).toBe('balanced');
    expect(oldBalanced.recommendations[0]?.teamUp).toBeUndefined();
    const oldWait = recommend({ ...base, settings: DEFAULT_ROTATION_SETTINGS });
    const newWait = recommend({ ...base, settings: settingsFor('longest_wait') });
    expect(strip(newWait)).toEqual(strip(oldWait));
    expect(teamUpOf(DEFAULT_ROTATION_SETTINGS)).toBe('longest_wait');
    expect(teamUpOf({ fairness: 'balanced_games' })).toBe('balanced');
    expect(DEFAULT_ROTATION_SETTINGS).not.toHaveProperty('teamUp');
  });
});

// ------------------------------------------------------------------ random

describe('Random: sit-out wheel and random teams', () => {
  /**
   * Checker: nobody plays a second time in a cycle while a waiting, not-declined player has not
   * played yet in it (late arrivals join the pool, and the cycle, when they check in).
   */
  function wheelChecker() {
    let played = new Set<string>();
    let repeats = new Set<string>();
    return (v: RoundView) => {
      const pool = v.players.filter((p) => p.status !== 'unavailable').map((p) => p.playerId);
      const eligibleFresh = v.players
        .filter((p) => p.status === 'waiting' && !p.declinedCurrentTurn && !played.has(p.playerId))
        .map((p) => p.playerId);
      const chosen = v.result.recommendations.flatMap((r) => r.playerIds);
      const again = chosen.filter((id) => played.has(id));
      if (again.length > 0) {
        for (const id of eligibleFresh) expect(chosen, `round ${v.round}: ${again.join(',')} play again before ${id}`).toContain(id);
      }
      // games are counted one at a time in court order; a game that completes the cycle seeds the
      // next cycle with everyone who played more than once in it
      for (const rec of v.result.recommendations) {
        for (const id of rec.playerIds) {
          if (played.has(id)) repeats.add(id);
          else played.add(id);
        }
        if (pool.every((id) => played.has(id))) {
          played = repeats;
          repeats = new Set();
        }
      }
    };
  }

  for (const courtCount of [1, 2, 3, 4]) {
    for (const playerCount of [5, 7, 10, 13, 18, 20]) {
      if (playerCount < courtCount * 4) continue;
      it(`${courtCount} court(s), ${playerCount} players with late arrivals and declines: nobody plays twice before all have played once`, () => {
        const check = wheelChecker();
        simulate({
          style: 'random',
          courts: courtCount,
          players: playerCount,
          rounds: 30,
          seed: playerCount * 13 + courtCount,
          arrivals: { [playerCount - 1]: 4, [playerCount - 2]: 9 },
          declineChance: 0.3,
          onRound: (v) => {
            checkCommon(v);
            check(v);
          },
        });
      });
    }
  }

  it('a late arrival joins the current cycle as not yet played and gets in ahead of players who already played', () => {
    const pool = [0, 1, 2, 3, 4, 5].map((i) => ({ playerId: pid(i), checkedInAt: at(i === 5 ? 20 : 0) }));
    const past: PastGame[] = [{ teamA: [pid(0), pid(1)], teamB: [pid(2), pid(3)], startedAt: at(1), endedAt: at(13), winner: 'A', courtId: 'c1' }];
    // p05 has not played; p06 arrived after the game: both not yet played in this cycle
    const played = cyclePlayed(past, pool);
    expect([...played].sort()).toEqual([pid(0), pid(1), pid(2), pid(3)]);
  });

  it('is reproducible for the same session and round, and varies between rounds', () => {
    const teams: string[] = [];
    const run = () =>
      simulate({
        style: 'random',
        courts: 2,
        players: 8,
        rounds: 10,
        seed: 42,
        onRound: (v) => teams.push(v.result.recommendations.map((r) => `${[...r.teamA].sort()}|${[...r.teamB].sort()}`).join(' ; ')),
      });
    run();
    const first = [...teams];
    teams.length = 0;
    run();
    expect(teams).toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(5);
  });

  it('with exactly four players on one court it never repeats a partner from the last game', () => {
    simulate({
      style: 'random',
      courts: 1,
      players: 4,
      rounds: 20,
      seed: 9,
      onRound: (v) => {
        const last = lastPartnersOf(v.previous);
        for (const rec of v.result.recommendations) {
          for (const team of [rec.teamA, rec.teamB]) expect(last.get(team[0] as string) ?? []).not.toContain(team[1]);
          expect(rec.explanation).toMatch(/Random teams/);
          expect(rec.explanation).toMatch(/sit-out wheel/);
        }
      },
    });
  });
});

// -------------------------------------------------------------- paddle stack

describe('Paddle stacking: winners vs winners, losers vs losers', () => {
  const rank = { winner: 0, loser: 1, neutral: 2 } as const;

  function checkStacks(v: RoundView): void {
    if (v.round === 0) return;
    const results = resultOf(v.previous);
    const stackOf = (id: string): 'winner' | 'loser' | 'neutral' => results.get(id) ?? 'neutral';
    const last = lastPartnersOf(v.previous);
    // across courts (court order): winners first, then losers, then players who sat out
    let floor = 0;
    for (const rec of v.result.recommendations) {
      const ranks = rec.playerIds.map((id) => rank[stackOf(id)]);
      expect(Math.min(...ranks), `round ${v.round} ${rec.courtLabel}`).toBeGreaterThanOrEqual(floor);
      floor = Math.max(...ranks);
      // within a court: each stack split evenly across the teams where possible, so winners face winners
      for (const stack of ['winner', 'loser'] as const) {
        const a = rec.teamA.filter((id) => stackOf(id) === stack).length;
        const b = rec.teamB.filter((id) => stackOf(id) === stack).length;
        const n = a + b;
        if (n === 2 || n === 4) expect(a, `${stack} split on ${rec.courtLabel}`).toBe(b);
      }
      // last-game partners split up whenever an evenly stacked split allows it
      if (rec.playerIds.length === 4) {
        const imbalance = (t: { teamA: string[]; teamB: string[] }) =>
          (['winner', 'loser', 'neutral'] as const).reduce(
            (acc, s) => acc + Math.abs(t.teamA.filter((id) => stackOf(id) === s).length - t.teamB.filter((id) => stackOf(id) === s).length),
            0,
          );
        const keeps = (t: { teamA: string[]; teamB: string[] }) =>
          [t.teamA, t.teamB].filter((team) => (last.get(team[0] as string) ?? []).includes(team[1] as string)).length;
        const options = splits(rec.playerIds);
        const best = Math.min(...options.map(imbalance));
        const fewestKeeps = Math.min(...options.filter((o) => imbalance(o) === best).map(keeps));
        expect(keeps({ teamA: rec.teamA, teamB: rec.teamB })).toBe(fewestKeeps);
      }
      expect(rec.explanation).toMatch(/Paddle stacking/);
    }
  }

  for (const courtCount of [1, 2, 3, 4]) {
    for (const playerCount of [4, 6, 8, 10, 12, 16, 20]) {
      if (playerCount < courtCount * 4) continue;
      it(`${courtCount} court(s), ${playerCount} players: stacks, neutral sitters after the losers, partners split`, () => {
        simulate({
          style: 'paddle_stack',
          courts: courtCount,
          players: playerCount,
          rounds: 20,
          seed: courtCount * 31 + playerCount,
          onRound: (v) => {
            checkCommon(v);
            checkStacks(v);
          },
        });
      });
    }
  }

  it('two courts finishing together: winners of both courts are shuffled into the top game, losers into the next', () => {
    const players: QueuePlayer[] = Array.from({ length: 8 }, (_, i) => ({
      playerId: pid(i),
      displayName: ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal'][i] as string,
      checkedInAt: at(0),
      eligibleSince: at(13),
      status: 'waiting' as const,
      gamesPlayed: 1,
      skillLevel: null,
    }));
    const past: PastGame[] = [
      { teamA: [pid(0), pid(1)], teamB: [pid(4), pid(5)], winner: 'A', courtId: 'c1', startedAt: at(1), endedAt: at(13) },
      { teamA: [pid(2), pid(3)], teamB: [pid(6), pid(7)], winner: 'A', courtId: 'c2', startedAt: at(1), endedAt: at(13) },
    ];
    const res = recommend({ now: at(15), players, courts: courts(2), settings: settingsFor('paddle_stack'), pastGames: past, seed: 's' });
    const [top, next] = res.recommendations as [Recommendation, Recommendation];
    expect(new Set(top.playerIds)).toEqual(new Set([pid(0), pid(1), pid(2), pid(3)]));
    expect(new Set(next.playerIds)).toEqual(new Set([pid(4), pid(5), pid(6), pid(7)]));
    for (const rec of [top, next]) {
      // partners from the last game are split: each new team has one player from each court
      for (const team of [rec.teamA, rec.teamB]) {
        const fromC1 = team.filter((id) => past[0]?.teamA.includes(id) || past[0]?.teamB.includes(id)).length;
        expect(fromC1).toBe(1);
      }
    }
    expect(top.explanation).toMatch(/Paddle stacking: winners \w+ & \w+ vs winners \w+ & \w+/);
    expect(next.explanation).toMatch(/losers \w+ & \w+ vs losers \w+ & \w+/);
  });

  it('players who sat out are neutral and fill in after the losers', () => {
    const names = ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kim', 'Lu'];
    const players: QueuePlayer[] = names.map((displayName, i) => ({
      playerId: pid(i),
      displayName,
      checkedInAt: at(0),
      eligibleSince: i < 8 ? at(13) : at(0),
      status: 'waiting' as const,
      gamesPlayed: i < 8 ? 1 : 0,
      skillLevel: null,
    }));
    const past: PastGame[] = [
      { teamA: [pid(0), pid(1)], teamB: [pid(4), pid(5)], winner: 'A', courtId: 'c1', startedAt: at(1), endedAt: at(13) },
      { teamA: [pid(2), pid(3)], teamB: [pid(6), pid(7)], winner: 'B', courtId: 'c2', startedAt: at(1), endedAt: at(13) },
    ];
    // 2 courts, 12 players: the 4 who sat out (0 games) play first by fairness; 4 of the 8 finishers join
    const res = recommend({ now: at(15), players, courts: courts(2), settings: settingsFor('paddle_stack'), pastGames: past, seed: 's' });
    const chosen = res.recommendations.flatMap((r) => r.playerIds);
    for (const id of [pid(8), pid(9), pid(10), pid(11)]) expect(chosen).toContain(id);
    const second = res.recommendations[1] as Recommendation;
    // the sitters are on the last court (with losers if any), never above a winner
    expect(second.playerIds.filter((id) => [pid(8), pid(9), pid(10), pid(11)].includes(id)).length).toBeGreaterThan(0);
    expect(second.explanation).toMatch(/no result yet|sat out/);
    const st = standings(past);
    expect(st.get(pid(0))?.stack).toBe('winner');
    expect(st.get(pid(4))?.stack).toBe('loser');
  });

  it('one court: the winners are split up and each partners a loser', () => {
    simulate({
      style: 'paddle_stack',
      courts: 1,
      players: 4,
      rounds: 10,
      seed: 5,
      onRound: (v) => {
        if (v.round === 0) return;
        const results = resultOf(v.previous);
        const rec = v.result.recommendations[0] as Recommendation;
        for (const team of [rec.teamA, rec.teamB]) {
          expect(team.map((id) => results.get(id)).sort()).toEqual(['loser', 'winner']);
        }
        expect(rec.explanation).toMatch(/With one court the winners are split up and each partners a loser/);
      },
    });
  });

  it('a player is neutral once a game started without them after their last game ended', () => {
    const past: PastGame[] = [
      { teamA: ['a', 'b'], teamB: ['c', 'd'], winner: 'A', courtId: 'c1', startedAt: at(0), endedAt: at(10) },
      { teamA: ['e', 'f'], teamB: ['g', 'h'], winner: 'B', courtId: 'c1', startedAt: at(11), endedAt: at(20) },
      // started after the latest end: part of the round being filled, so it does not make anyone a sitter
      { teamA: ['i', 'j'], teamB: ['k', 'l'], winner: null, courtId: 'c2', startedAt: at(21), endedAt: null },
    ];
    const st = standings(past);
    expect(st.get('a')).toMatchObject({ stack: 'neutral', neutralReason: 'sat_out' });
    expect(st.get('e')).toMatchObject({ stack: 'loser', lastCourtId: 'c1' });
    expect(st.get('g')).toMatchObject({ stack: 'winner' });
    expect(st.get('i')).toMatchObject({ stack: 'neutral', neutralReason: 'new' });
  });
});

// -------------------------------------------------------------------- river

describe('Up & Down the River', () => {
  /** Expected ladder court index for a player coming off the previous round with no waiting players. */
  function expectedCourt(v: RoundView, id: string): number {
    const n = v.courts.length;
    for (const g of v.previous) {
      const court = v.courts.findIndex((c) => c.courtId === g.courtId);
      const won = (g.winner === 'A' ? g.teamA : g.teamB).includes(id);
      const lost = (g.winner === 'A' ? g.teamB : g.teamA).includes(id);
      if (won) return Math.max(0, court - 1);
      if (lost) return Math.min(n - 1, court + 1);
    }
    return n - 1;
  }

  for (const courtCount of [1, 2, 3, 4]) {
    it(`${courtCount} court(s), exactly ${courtCount * 4} players: winners up, losers down, top stays, partners split`, () => {
      simulate({
        style: 'river',
        courts: courtCount,
        players: courtCount * 4,
        rounds: 16,
        seed: courtCount,
        onRound: (v) => {
          checkCommon(v);
          if (v.round === 0) return;
          const last = lastPartnersOf(v.previous);
          for (const rec of v.result.recommendations) {
            const here = v.courts.findIndex((c) => c.courtId === rec.courtId);
            for (const id of rec.playerIds) expect(here, `${id} in round ${v.round}`).toBe(expectedCourt(v, id));
            for (const team of [rec.teamA, rec.teamB]) expect(last.get(team[0] as string) ?? []).not.toContain(team[1]);
            expect(rec.explanation).toMatch(/Up & Down the River/);
            expect(rec.explanation).toMatch(/top court/);
          }
        },
      });
    });
  }

  for (const courtCount of [1, 2, 3, 4]) {
    for (const extra of [1, 2, 3, 5]) {
      it(`${courtCount} court(s) with ${extra} waiting: on a tie the bottom-court losers go to the waiting line first`, () => {
        simulate({
          style: 'river',
          courts: courtCount,
          players: courtCount * 4 + extra,
          rounds: 20,
          seed: courtCount * 10 + extra,
          onRound: (v) => {
            checkCommon(v);
            if (v.round === 0) return;
            const results = resultOf(v.previous);
            const bottom = v.courts[v.courts.length - 1]?.courtId;
            const key = (id: string): number => {
              const res = results.get(id);
              if (res === undefined) return 2;
              if (res === 'winner') return 0;
              const g = v.previous.find((x) => x.teamA.includes(id) || x.teamB.includes(id)) as PastGame;
              return g.courtId === bottom ? 3 : 1;
            };
            const chosen = new Set(v.result.recommendations.flatMap((r) => r.playerIds));
            const waiting = v.players.filter((p) => p.status === 'waiting' && !p.declinedCurrentTurn);
            for (const sitter of waiting.filter((p) => !chosen.has(p.playerId))) {
              for (const player of waiting.filter((p) => chosen.has(p.playerId))) {
                if (player.gamesPlayed + (player.gameCredit ?? 0) !== sitter.gamesPlayed + (sitter.gameCredit ?? 0)) continue;
                if (player.eligibleSince !== sitter.eligibleSince) continue;
                expect(key(sitter.playerId), `round ${v.round}: ${sitter.playerId} sits while ${player.playerId} plays`).toBeGreaterThanOrEqual(key(player.playerId));
              }
            }
          },
        });
      });
    }
  }

  it('one court, five players: winners stay on (level on games), split up, and a loser rotates out for the waiting player', () => {
    simulate({
      style: 'river',
      courts: 1,
      players: 5,
      rounds: 15,
      seed: 77,
      onRound: (v) => {
        if (v.round === 0) return;
        const results = resultOf(v.previous);
        const rec = v.result.recommendations[0] as Recommendation;
        const games = (id: string): number => (v.players.find((p) => p.playerId === id) as QueuePlayer).gamesPlayed;
        const winners = [...results.entries()].filter(([, r]) => r === 'winner').map(([id]) => id);
        const losers = [...results.entries()].filter(([, r]) => r === 'loser').map(([id]) => id);
        const sitter = v.players.find((p) => !rec.playerIds.includes(p.playerId)) as QueuePlayer;
        // the sitter is a loser, unless that winner has played more games than every loser who plays
        if (results.get(sitter.playerId) === 'winner') {
          for (const l of losers.filter((id) => rec.playerIds.includes(id))) expect(games(l)).toBeLessThan(sitter.gamesPlayed);
        }
        // winners on court are split: never both on one team
        const both = winners.filter((id) => rec.playerIds.includes(id));
        if (both.length === 2) expect(rec.teamA.filter((id) => both.includes(id))).toHaveLength(1);
        expect(rec.explanation).toMatch(/With one court the winners stay on/);
      },
    });
  });
});

// ------------------------------------------------------------ fixed partners

describe('Fixed partners', () => {
  for (const courtCount of [1, 2, 3, 4]) {
    for (const playerCount of [5, 8, 11, 16, 20]) {
      if (playerCount < courtCount * 4) continue;
      it(`${courtCount} court(s), ${playerCount} players: locked pairs always play together`, () => {
        const pairs: [number, number][] = [
          [0, 1],
          [2, 3],
          [4, 6],
        ];
        let splits = 0;
        simulate({
          style: 'fixed_partners',
          courts: courtCount,
          players: playerCount,
          rounds: 20,
          seed: courtCount * 3 + playerCount,
          fixedPairs: pairs,
          onRound: (v) => {
            checkCommon(v);
            for (const rec of v.result.recommendations) {
              for (const [a, b] of pairs) {
                const inA = rec.playerIds.includes(pid(a));
                const inB = rec.playerIds.includes(pid(b));
                if (inA !== inB) {
                  // only the fairness fallback may split a pair, and the explanation says so
                  expect(rec.explanation, `pair ${a}+${b} split in round ${v.round}`).toMatch(/is split for this game/);
                  splits += 1;
                } else if (inA && inB) {
                  const team = rec.teamA.includes(pid(a)) ? rec.teamA : rec.teamB;
                  expect(team).toContain(pid(b));
                }
              }
            }
            expect(spread(v.players.map((p) => p.gamesPlayed))).toBeLessThanOrEqual(1);
          },
        });
        // with an even number of unpaired players the pairs never need splitting
        const unpaired = playerCount - pairs.filter(([, b]) => b < playerCount).length * 2;
        if (unpaired % 2 === 0) expect(splits).toBe(0);
      });
    }
  }

  it('a locked player whose partner is resting plays unpaired, and says so', () => {
    const players: QueuePlayer[] = Array.from({ length: 6 }, (_, i) => ({
      playerId: pid(i),
      displayName: `P${i + 1}`,
      checkedInAt: at(0),
      eligibleSince: at(i === 0 ? 0 : 1),
      status: i === 1 ? ('unavailable' as const) : ('waiting' as const),
      gamesPlayed: 0,
      skillLevel: null,
    }));
    const res = recommend({
      now: at(5),
      players,
      courts: courts(1),
      settings: settingsFor('fixed_partners', { fixedPairs: [[pid(0), pid(1)]] }),
      pastGames: [],
      seed: 's',
    });
    const rec = res.recommendations[0] as Recommendation;
    expect(rec.playerIds).toContain(pid(0));
    expect(rec.explanation).toMatch(/P1's locked partner P2 is not waiting, so P1 plays unpaired/);
  });

  it('a pair is never split to fill a single seat; the court takes the earliest full game', () => {
    const players: QueuePlayer[] = Array.from({ length: 5 }, (_, i) => ({
      playerId: pid(i),
      displayName: `P${i + 1}`,
      checkedInAt: at(i),
      eligibleSince: at(i),
      status: 'waiting' as const,
      gamesPlayed: 0,
      skillLevel: null,
    }));
    // queue: p1, p2, p3 (single), pair p4+p5 — p1..p3 + one seat left: the pair cannot split
    const res = recommend({
      now: at(10),
      players,
      courts: courts(1),
      settings: settingsFor('fixed_partners', { fixedPairs: [[pid(1), pid(4)]] }),
      pastGames: [],
      seed: 's',
    });
    const rec = res.recommendations[0] as Recommendation;
    const team = rec.teamA.includes(pid(1)) ? rec.teamA : rec.teamB;
    expect(team).toEqual(expect.arrayContaining([pid(1), pid(4)]));
    expect(rec.explanation).toMatch(/Locked pair P2 & P5 plays together/);
  });
});

// ------------------------------------------------------------- data layer

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teamups-'));
  db = openDatabase(join(dir, 'app.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

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

describe('D15 single-court opt-in (data layer)', () => {
  it('the default contract still rejects 1 court for createSession and setCourtCount', () => {
    expect(() => createSession(db, { name: 'Solo', courtCount: 1 })).toThrow(ValidationError);
    const s = createSession(db, { name: 'Two', courtCount: 2 });
    expect(() => setCourtCount(db, s.id, 1)).toThrow(ValidationError);
    expect(() => setCourtCount(db, s.id, 1, { allowSingleCourt: false })).toThrow(ValidationError);
    expect(listCourts(db, s.id)).toHaveLength(2);
    expect(() => createSession(db, { name: 'Zero', courtCount: 0, allowSingleCourt: true })).toThrow(ValidationError);
    expect(() => createSession(db, { name: 'Five', courtCount: 5, allowSingleCourt: true })).toThrow(ValidationError);
  });

  it('with allowSingleCourt a session runs on one court, and can grow and shrink back', () => {
    const s = createSession(db, { name: 'Small group', courtCount: 1, allowSingleCourt: true });
    expect(getSession(db, s.id)?.courtCount).toBe(1);
    expect(listCourts(db, s.id).map((c) => c.label)).toEqual(['Court 1']);
    expect(setCourtCount(db, s.id, 3)).toHaveLength(3);
    expect(setCourtCount(db, s.id, 1, { allowSingleCourt: true })).toHaveLength(1);
    expect(getSession(db, s.id)?.courtCount).toBe(1);
  });

  it('the API passes the opt-in and the starting team-up style; without them nothing changes', async () => {
    const api = handlers();
    const rejected = await api.createSession({ name: 'Solo', courtCount: 1 });
    expect(rejected.ok).toBe(false);
    const plain = await api.createSession({ name: 'Plain', courtCount: 2 });
    const plainId = plain.ok ? (plain.value as { id: string }).id : '';
    expect(getRotationSettings(db, plainId)).toEqual({ ...DEFAULT_ROTATION_SETTINGS, ...NEW_SESSION_ROTATION_SETTINGS });
    const solo = await api.createSession({ name: 'Solo', courtCount: 1, allowSingleCourt: true, teamUp: 'river' });
    expect(solo.ok).toBe(true);
    const soloId = solo.ok ? (solo.value as { id: string }).id : '';
    expect(listCourts(db, soloId)).toHaveLength(1);
    expect(getRotationSettings(db, soloId).teamUp).toBe('river');
    expect(getRotationSettings(db, soloId).fairness).toBe('balanced_games');
    const bad = await api.createSession({ name: 'Bad', courtCount: 2, teamUp: 'chaos' });
    expect(bad.ok).toBe(false);
    expect((await api.setCourtCount(plainId, 1)).ok).toBe(false);
    expect((await api.setCourtCount(plainId, 1, { allowSingleCourt: true })).ok).toBe(true);
    expect(listCourts(db, plainId)).toHaveLength(1);
  });
});

describe('D16 team-up styles through the data layer', () => {
  function night(names: string[], courtCount: number, style: TeamUpStyle) {
    const session = createSession(db, { name: `Night ${style}`, courtCount, allowSingleCourt: true, startedAt: at(0) });
    setRotationSettings(db, session.id, settingsForTeamUp(style), { at: at(0) });
    const ids = names.map((displayName, i) => {
      const entry = addNewPlayerToSession(db, session.id, { displayName });
      checkInPlayer(db, session.id, entry.playerId, at(i * 0.1));
      return entry.playerId;
    });
    return { sessionId: session.id, ids };
  }

  /** Assigns every recommendation, then tags the winners ("Team A won" / "Team B won"). */
  function playRound(sessionId: string, startMin: number, winners: ('A' | 'B')[]) {
    const recs = recommendNextGames(db, sessionId, { at: at(startMin) }).recommendations;
    const games = recs.map((rec) => assignRecommendation(db, sessionId, rec, { at: at(startMin) }));
    games.forEach((g, i) => recordGameResult(db, g.id, { winner: winners[i % winners.length] as 'A' | 'B' }, { at: at(startMin + GAME) }));
    return recs;
  }

  const NAMES = ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kim', 'Lu'];

  for (const style of ALL_STYLES) {
    for (const courtCount of [1, 3]) {
      it(`${style} on ${courtCount} court(s): rounds, results, log, stats, decline and override all work`, () => {
        const w = night(NAMES.slice(0, courtCount === 1 ? 6 : 12), courtCount, style);
        if (style === 'fixed_partners') setRotationSettings(db, w.sessionId, { fixedPairs: [[w.ids[0] as string, w.ids[1] as string]] }, { at: at(0) });
        for (let round = 0; round < 4; round++) {
          const recs = playRound(w.sessionId, 1 + round * ROUND, ['A', 'B']);
          expect(recs.length).toBeGreaterThan(0);
          for (const rec of recs) if (GROUPING.includes(style)) expect(rec.teamUp).toBe(style);
        }
        const games = listGames(db, w.sessionId);
        expect(games.every((g) => g.status === 'completed' && g.winner !== null)).toBe(true);
        const assigned = listRotationEvents(db, w.sessionId).filter((e) => e.type === 'assigned');
        expect(assigned).toHaveLength(games.length);
        if (GROUPING.includes(style)) expect(assigned.every((e) => e.data.teamUp === style)).toBe(true);
        expect(getSessionLeaderboard(db, w.sessionId).length).toBeGreaterThan(0);

        // the queue shows the order the style uses: the first recommendation takes the front of the queue
        const now = at(1 + 4 * ROUND);
        const queue = getQueue(db, w.sessionId, { at: now });
        const recs = recommendNextGames(db, w.sessionId, { at: now }).recommendations;
        if (style === 'random' || style === 'paddle_stack' || style === 'river') {
          // all free courts are filled together from the front of the queue, then grouped
          const taken = recs.flatMap((r) => r.playerIds);
          expect(new Set(taken)).toEqual(new Set(queue.slice(0, taken.length).map((e) => e.playerId)));
        }

        // decline (D1): the decliner is skipped this turn
        const decliner = queue[0]?.playerId as string;
        declineTurn(db, w.sessionId, decliner, { at: now });
        const after = recommendNextGames(db, w.sessionId, { at: now });
        expect(after.recommendations.flatMap((r) => r.playerIds)).not.toContain(decliner);
        expect(after.excluded).toContainEqual({ playerId: decliner, reason: 'declined' });

        // a resting player is never recommended
        const rester = after.recommendations[0]?.playerIds[0] as string;
        setAvailability(db, w.sessionId, rester, 'resting');
        const rested = recommendNextGames(db, w.sessionId, { at: now });
        expect(rested.recommendations.flatMap((r) => r.playerIds)).not.toContain(rester);
        setAvailability(db, w.sessionId, rester, 'available');

        // manual override with a reason, logged with what the style wanted
        const free = listCourts(db, w.sessionId)[0]?.id as string;
        const pickable = getQueue(db, w.sessionId, { at: now }).filter((e) => !e.declinedCurrentTurn).map((e) => e.playerId);
        const override = assignManually(db, w.sessionId, {
          courtId: free,
          format: 'doubles',
          teamA: pickable.slice(0, 2),
          teamB: pickable.slice(2, 4),
          reason: 'Birthday game',
          at: now,
        });
        expect(override.status).toBe('in_progress');
        const event = listRotationEvents(db, w.sessionId).at(-1);
        expect(event?.type).toBe('override');
        expect(event?.data.reason).toBe('Birthday game');
      });
    }
  }

  it('rejects unknown styles and malformed fixed pairs; settings without teamUp keep the defaults', () => {
    const s = createSession(db, { name: 'Checks', courtCount: 2 });
    expect(getRotationSettings(db, s.id)).toEqual(DEFAULT_ROTATION_SETTINGS);
    expect(() => setRotationSettings(db, s.id, { teamUp: 'chaos' as TeamUpStyle })).toThrow(ValidationError);
    expect(() => setRotationSettings(db, s.id, { fixedPairs: [['a']] })).toThrow(ValidationError);
    expect(() => setRotationSettings(db, s.id, { fixedPairs: [['a', 'a']] })).toThrow(ValidationError);
    expect(() => setRotationSettings(db, s.id, { fixedPairs: [['a', 'b'], ['b', 'c']] })).toThrow(ValidationError);
    expect(setRotationSettings(db, s.id, { teamUp: 'random', fixedPairs: [['a', 'b']] }).teamUp).toBe('random');
    expect(getRotationSettings(db, s.id).fixedPairs).toEqual([['a', 'b']]);
  });

  it('paddle stacking from tagged results: one court splits the winners, each partnering a loser', () => {
    const w = night(NAMES.slice(0, 4), 1, 'paddle_stack');
    playRound(w.sessionId, 1, ['A']);
    const first = listGames(db, w.sessionId)[0];
    const winners = first?.participants.filter((p) => p.team === 'A').map((p) => p.playerId) ?? [];
    const rec = recommendNextGames(db, w.sessionId, { at: at(1 + ROUND) }).recommendations[0] as Recommendation;
    expect(rec.teamA.filter((id) => winners.includes(id))).toHaveLength(1);
    expect(rec.teamB.filter((id) => winners.includes(id))).toHaveLength(1);
    expect(rec.explanation).toMatch(/Paddle stacking/);
  });
});
