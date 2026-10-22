/**
 * D17 advanced team-up styles (mixed doubles, skill pools, round robin, mentor pairing, challenge
 * court, Swiss pairing), D18 player profile fields (gender, pool) and the team-up guide content the
 * explanation window shows. Fairness (balanced games) decides who plays unless a style documents a
 * bounded exception: challenge court holders up to the cap, round robin's schedule with fair byes,
 * and pools that are level within each pool.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyDecline,
  catchUpCredits,
  DEFAULT_ROTATION_SETTINGS,
  defaultRoundRobinRounds,
  generateRoundRobin,
  poolOfPlayer,
  poolSettingsOf,
  recommend,
  resolveCourtPools,
  roundRobinCoverage,
  scheduleGameKey,
  settingsForTeamUp,
  startNewTurn,
  swissRecords,
  TEAM_UP_STYLES,
  type AdvancedStyle,
  type CourtInput,
  type Gender,
  type PastGame,
  type PoolName,
  type QueuePlayer,
  type Recommendation,
  type RecommendationResult,
  type RotationSettings,
  type RoundRobinSchedule,
} from '../../src/core/rotation';
import { getSchemaVersion, listTables, openDatabase, SCHEMA_VERSION, type Db } from '../../src/data/db';
import { createSession } from '../../src/data/sessions';
import { addNewPlayerToSession, checkInPlayer, setAvailability } from '../../src/data/roster';
import { recordGameResult } from '../../src/data/scoring';
import {
  assignManually,
  assignRecommendation,
  declineTurn,
  generateRoundRobinSchedule,
  getQueue,
  getRotationSettings,
  getRoundRobinStatus,
  listRotationEvents,
  recommendNextGames,
  setRotationSettings,
} from '../../src/data/rotation';
import { listCourts } from '../../src/data/courts';
import { listGames } from '../../src/data/games';
import { getPlayerProfile, listPlayerDetails, listPlayerProfiles, setPlayerProfile, updatePlayerDetails } from '../../src/data/profiles';
import { getPlayer } from '../../src/data/players';
import { raw } from '../../src/data/sqlite';
import { ValidationError } from '../../src/data/errors';
import { createApiHandlers, type DbStore, type HostServices } from '../../src/main/handlers';
import { API_METHODS } from '../../src/shared/api';
import { guideFor, TEAM_UP_CHOICES, TEAM_UP_GUIDE } from '../../src/renderer/teamUpOptions';

// ---------------------------------------------------------------- helpers
const T0 = Date.parse('2026-10-22T18:00:00.000Z');
const at = (min: number): string => new Date(T0 + Math.round(min * 60000)).toISOString();
const ROUND = 15;
const GAME = 12;
const NEW_STYLES: AdvancedStyle[] = ['mixed', 'pools', 'round_robin', 'mentor', 'challenge', 'swiss'];

const pid = (i: number): string => `p${String(i + 1).padStart(2, '0')}`;
const spread = (xs: number[]): number => (xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs));

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function courts(n: number): CourtInput[] {
  return Array.from({ length: n }, (_, i) => ({ courtId: `c${i + 1}`, label: `Court ${i + 1}`, status: 'available' as const, occupied: false }));
}

function settingsFor(style: AdvancedStyle, extra: Partial<RotationSettings> = {}): RotationSettings {
  return { ...DEFAULT_ROTATION_SETTINGS, declinePolicy: { kind: 'back_of_queue' }, ...settingsForTeamUp(style), ...extra };
}

function player(i: number, extra: Partial<QueuePlayer> = {}): QueuePlayer {
  return { playerId: pid(i), displayName: `P${i + 1}`, checkedInAt: at(0), eligibleSince: at(0), status: 'waiting', gamesPlayed: 0, skillLevel: null, ...extra };
}

interface RoundView {
  round: number;
  now: string;
  players: QueuePlayer[];
  result: RecommendationResult;
  past: PastGame[];
  previous: PastGame[];
  courts: CourtInput[];
  settings: RotationSettings;
}

interface SimConfig {
  style: AdvancedStyle;
  courts: number;
  players: number;
  rounds: number;
  seed: number;
  format?: 'singles' | 'doubles';
  arrivals?: Record<number, number>;
  rests?: Record<number, [number, number]>;
  declineChance?: number;
  gender?: (i: number) => Gender | undefined;
  skill?: (i: number) => number | null;
  pool?: (i: number) => PoolName | undefined;
  extra?: Partial<RotationSettings>;
  /** Decides the winner of a game (default: a seeded coin). */
  winner?: (rec: Recommendation, round: number) => 'A' | 'B';
  onRound?: (v: RoundView) => void;
}

/**
 * Round-based open play on the pure engine: every round all courts are free, recommend() fills them,
 * games last 12 minutes, the winner scores 11 and the loser 0-9. Round robin generates its schedule
 * from the players present in round 0 and tracks started scheduled games like the data layer.
 */
function simulate(cfg: SimConfig) {
  const r = rng(cfg.seed);
  const format = cfg.format ?? 'doubles';
  let settings = settingsFor(cfg.style, { format, ...(cfg.extra ?? {}) });
  const courtList = courts(cfg.courts);
  const state = new Map<string, QueuePlayer>();
  const past: PastGame[] = [];
  const ended: { playerIds: string[]; endedAt: string }[] = [];
  const started: string[] = [];
  let previous: PastGame[] = [];
  const seed = `sim-${cfg.seed}`;
  for (let round = 0; round < cfg.rounds; round++) {
    const startMin = round * ROUND;
    const now = at(startMin);
    for (let i = 0; i < cfg.players; i++) {
      const id = pid(i);
      if ((cfg.arrivals?.[i] ?? 0) === round && !state.has(id)) {
        const checkedInAt = at(startMin - 1);
        const g = cfg.gender?.(i);
        const pl = cfg.pool?.(i);
        state.set(id, {
          playerId: id,
          displayName: `P${i + 1}`,
          checkedInAt,
          eligibleSince: checkedInAt,
          status: 'waiting',
          gamesPlayed: 0,
          skillLevel: cfg.skill?.(i) ?? null,
          ...(g ? { gender: g } : {}),
          ...(pl ? { pool: pl } : {}),
        });
      }
      const p = state.get(id);
      const span = cfg.rests?.[i];
      if (p) p.status = span !== undefined && round >= span[0] && round < span[1] ? 'unavailable' : 'waiting';
    }
    const credits = catchUpCredits(
      [...state.values()].map((p) => ({ playerId: p.playerId, checkedInAt: p.checkedInAt, countsTowardMinimum: p.status !== 'unavailable' })),
      ended,
    );
    let players: QueuePlayer[] = [...state.values()].map((p) => {
      const { gameCredit: _c, declinedCurrentTurn: _d, ...rest } = p;
      const credit = credits.get(p.playerId) ?? 0;
      return { ...rest, ...(credit > 0 ? { gameCredit: credit } : {}) };
    });
    if (cfg.style === 'round_robin' && round === 0) {
      const present = players.filter((p) => p.status !== 'unavailable').map((p) => p.playerId);
      settings = { ...settings, roundRobin: generateRoundRobin({ id: 'rr1', createdAt: now, playerIds: present, courtCount: cfg.courts, format, seed }) };
    }
    if (cfg.declineChance && r() < cfg.declineChance) {
      const waiting = players.filter((p) => p.status === 'waiting');
      const who = waiting[Math.floor(r() * waiting.length)];
      if (who) players = applyDecline(players, who.playerId, now, settings.declinePolicy, { fairness: 'balanced_games', seed });
    }
    const result = recommend({ now, players, courts: courtList, settings, pastGames: past, seed, scheduleStarted: started });
    cfg.onRound?.({ round, now, players, result, past: [...past], previous, courts: courtList, settings });
    const thisRound: PastGame[] = [];
    const endAt = at(startMin + GAME);
    for (const rec of result.recommendations) {
      const winner = cfg.winner ? cfg.winner(rec, round) : r() < 0.5 ? 'A' : 'B';
      const loserScore = Math.floor(r() * 10);
      const game: PastGame = {
        teamA: rec.teamA,
        teamB: rec.teamB,
        courtId: rec.courtId,
        startedAt: now,
        endedAt: endAt,
        winner,
        scoreA: winner === 'A' ? 11 : loserScore,
        scoreB: winner === 'B' ? 11 : loserScore,
      };
      past.push(game);
      thisRound.push(game);
      ended.push({ playerIds: rec.playerIds, endedAt: endAt });
      if (rec.schedule) started.push(scheduleGameKey(rec.schedule.scheduleId, rec.schedule.round, rec.schedule.game));
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
  return { state, past, settings, started };
}

/** Invariants for every style in every round. */
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
    expect(rec.teamUp).toBe(v.settings.teamUp);
    for (const id of rec.playerIds) {
      expect(seen.has(id), `${id} assigned twice`).toBe(false);
      seen.add(id);
      const p = byId.get(id) as QueuePlayer;
      expect(p.status).toBe('waiting');
      expect(p.declinedCurrentTurn ?? false).toBe(false);
    }
  }
  const free = v.courts.filter((c) => c.status === 'available' && !c.occupied).length;
  expect(v.result.recommendations.length + v.result.openCourts.length).toBe(free);
  const eligible = v.players.filter((p) => p.status === 'waiting' && !p.declinedCurrentTurn).length;
  for (const open of v.result.openCourts) {
    expect(open.reason).toMatch(/stays open/);
    // only pools (stay open) and round robin (keeps rounds together) may leave a court open with players waiting
    if (v.settings.teamUp !== 'pools' && v.settings.teamUp !== 'round_robin') expect(eligible - seen.size).toBeLessThan(need);
    if (v.settings.teamUp === 'pools' && eligible - seen.size >= need) expect(open.reason).toMatch(/pool/i);
    if (v.settings.teamUp === 'round_robin' && eligible - seen.size >= need) expect(open.reason).toMatch(/Round \d+/);
  }
}

const GENDER_MIX = (i: number): Gender | undefined => (i % 5 === 4 ? undefined : i % 2 === 0 ? 'female' : 'male');
const SKILLS = (i: number): number | null => (i % 6 === 5 ? null : 2 + ((i * 7) % 11) / 4);

// ------------------------------------------------------------- simulations

describe('D17 every new style: no double assignment, fairness bounds, 1-4 courts', () => {
  for (const style of NEW_STYLES) {
    for (const courtCount of [1, 2, 3, 4]) {
      for (const playerCount of [5, 8, 13, 16, 20]) {
        if (playerCount < courtCount * 2) continue;
        it(`${style}: ${courtCount} court(s), ${playerCount} players continuously available`, () => {
          const cap = 2;
          simulate({
            style,
            courts: courtCount,
            players: playerCount,
            rounds: 24,
            seed: courtCount * 100 + playerCount,
            gender: GENDER_MIX,
            skill: SKILLS,
            extra: style === 'pools' ? { pools: { source: 'skill', cutoffA: 3.5, cutoffB: null, courts: 'auto', whenShort: 'stay_open' } } : {},
            onRound: (v) => {
              checkCommon(v);
              const counts = v.players.map((p) => p.gamesPlayed);
              if (style === 'mixed' || style === 'mentor' || style === 'swiss') {
                expect(spread(counts), `round ${v.round}`).toBeLessThanOrEqual(1);
              } else if (style === 'challenge') {
                // documented exception: holders stay on for at most `cap` games in a row
                expect(spread(counts), `round ${v.round}`).toBeLessThanOrEqual(cap + 1);
              } else if (style === 'pools') {
                // fewest games first within each pool
                const pools = poolSettingsOf(v.settings);
                for (const name of ['A', 'B'] as const) {
                  expect(spread(v.players.filter((p) => poolOfPlayer(p, pools) === name).map((p) => p.gamesPlayed)), `pool ${name} round ${v.round}`).toBeLessThanOrEqual(1);
                }
              } else {
                // round robin: byes rotate fairly, so every completed round keeps games level
                expect(spread(counts), `round ${v.round}`).toBeLessThanOrEqual(1);
              }
            },
          });
        });
      }
    }
  }

  for (const style of NEW_STYLES) {
    it(`${style}: late arrivals, rests and declines never break the invariants`, () => {
      for (let seed = 1; seed <= 12; seed++) {
        const r = rng(seed * 7919);
        const courtCount = 1 + Math.floor(r() * 4);
        const playerCount = Math.max(5, courtCount * 4 - 2 + Math.floor(r() * (21 - courtCount * 4)));
        simulate({
          style,
          courts: courtCount,
          players: playerCount,
          rounds: 20,
          seed,
          arrivals: { [playerCount - 1]: 3, [playerCount - 2]: 6 },
          rests: { 0: [2, 5], 3: [8, 9] },
          declineChance: 0.4,
          gender: GENDER_MIX,
          skill: SKILLS,
          extra: style === 'pools' ? { pools: { whenShort: seed % 2 === 0 ? 'borrow' : 'stay_open', courts: seed % 3 === 0 ? 'alternate' : 'auto' } } : {},
          onRound: checkCommon,
        });
      }
    });
  }

  it('singles works in every new style, including a single court', () => {
    for (const style of NEW_STYLES) {
      for (const courtCount of [1, 2]) {
        simulate({
          style,
          courts: courtCount,
          players: 5,
          rounds: 12,
          seed: 3,
          format: 'singles',
          gender: GENDER_MIX,
          skill: SKILLS,
          onRound: (v) => {
            checkCommon(v);
            const s = spread(v.players.map((p) => p.gamesPlayed));
            if (style === 'challenge') expect(s).toBeLessThanOrEqual(3);
            else if (style !== 'pools') expect(s).toBeLessThanOrEqual(1);
          },
        });
      }
    }
  });

  it('unavailable and occupied courts are skipped in every new style', () => {
    for (const style of NEW_STYLES) {
      const players = Array.from({ length: 12 }, (_, i) => player(i, { gender: i % 2 === 0 ? 'female' : 'male', skillLevel: 2 + (i % 4) * 0.5 }));
      const list = courts(3);
      list[0] = { ...(list[0] as CourtInput), status: 'unavailable' };
      list[1] = { ...(list[1] as CourtInput), occupied: true };
      const settings = settingsFor(style, style === 'round_robin' ? { roundRobin: generateRoundRobin({ id: 'rr', createdAt: at(0), playerIds: players.map((p) => p.playerId), courtCount: 1, format: 'doubles' }) } : {});
      const res = recommend({ now: at(5), players, courts: list, settings, pastGames: [], seed: 's' });
      expect(res.recommendations.map((r) => r.courtId)).toEqual(['c3']);
      expect(res.skippedCourts).toEqual([
        { courtId: 'c1', reason: 'unavailable' },
        { courtId: 'c2', reason: 'occupied' },
      ]);
    }
  });

  it('every new style is selectable, maps to balanced games and keeps the engine defaults untouched', () => {
    for (const style of NEW_STYLES) {
      expect(TEAM_UP_STYLES).toContain(style);
      expect(settingsForTeamUp(style)).toEqual({ teamUp: style, fairness: 'balanced_games', partnerRotation: true });
    }
    expect(DEFAULT_ROTATION_SETTINGS).toEqual({ format: 'doubles', declinePolicy: { kind: 'back_of_queue' }, skillBalancing: false, partnerRotation: false });
  });
});

// ----------------------------------------------------------- mixed doubles

describe('Mixed doubles', () => {
  const genderOf = (players: QueuePlayer[]) => new Map(players.map((p) => [p.playerId, p.gender] as const));

  it('four men and four women on two courts: every team is mixed every round', () => {
    simulate({
      style: 'mixed',
      courts: 2,
      players: 8,
      rounds: 16,
      seed: 4,
      gender: (i) => (i % 2 === 0 ? 'female' : 'male'),
      onRound: (v) => {
        const g = genderOf(v.players);
        for (const rec of v.result.recommendations) {
          for (const team of [rec.teamA, rec.teamB]) expect(new Set(team.map((id) => g.get(id)))).toEqual(new Set(['male', 'female']));
          expect(rec.explanation).toMatch(/Both teams are mixed/);
        }
      },
    });
  });

  it('not enough women: one court is fully mixed, the other plays two men per team, and the explanation says so', () => {
    const players = Array.from({ length: 8 }, (_, i) => player(i, { gender: i < 6 ? 'male' : 'female' }));
    const res = recommend({ now: at(5), players, courts: courts(2), settings: settingsFor('mixed'), pastGames: [], seed: 's' });
    const g = genderOf(players);
    const kinds = res.recommendations.map((rec) => [rec.teamA, rec.teamB].map((t) => [...new Set(t.map((id) => g.get(id)))].sort().join('+')).sort().join(' | '));
    expect(kinds.sort()).toEqual(['female+male | female+male', 'male | male']);
    const fallback = res.recommendations.find((rec) => rec.explanation.includes('Not enough women')) as Recommendation;
    expect(fallback.explanation).toMatch(/6 men, 2 women/);
    expect(fallback.explanation).toMatch(/play as two men/);
  });

  it('swaps in the next waiting player on the same game count to make teams mixed, never someone with more games', () => {
    // queue: three men then two women, all on 0 games; waits decide the order
    const players = [0, 1, 2, 3, 4].map((i) => player(i, { gender: i < 3 ? 'male' : 'female', eligibleSince: at(i) }));
    const res = recommend({ now: at(10), players, courts: courts(1), settings: settingsFor('mixed'), pastGames: [], seed: 's' });
    const rec = res.recommendations[0] as Recommendation;
    expect(new Set(rec.playerIds)).toEqual(new Set(['p01', 'p02', 'p04', 'p05']));
    expect(rec.bypassed).toEqual(['p03']);
    expect(rec.explanation).toMatch(/P5 plays ahead of P3 \(both on 0 games\)/);
    // the woman who could make it mixed has one more game: no swap, a same-gender team instead
    const busier = players.map((p) => (p.playerId === 'p05' ? { ...p, gamesPlayed: 1 } : p));
    const res2 = recommend({ now: at(10), players: busier, courts: courts(1), settings: settingsFor('mixed'), pastGames: [], seed: 's' });
    const rec2 = res2.recommendations[0] as Recommendation;
    expect(new Set(rec2.playerIds)).toEqual(new Set(['p01', 'p02', 'p03', 'p04']));
    expect(rec2.bypassed).toEqual([]);
    expect(rec2.explanation).toMatch(/Not enough women/);
  });

  it('a bypassed player never has fewer games than the players chosen, over many rounds', () => {
    for (const courtCount of [1, 2, 3]) {
      simulate({
        style: 'mixed',
        courts: courtCount,
        players: 13,
        rounds: 20,
        seed: 17 + courtCount,
        gender: (i) => (i % 3 === 0 ? 'female' : 'male'),
        onRound: (v) => {
          const games = new Map(v.players.map((p) => [p.playerId, p.gamesPlayed + (p.gameCredit ?? 0)] as const));
          for (const rec of v.result.recommendations) {
            const most = Math.max(...rec.playerIds.map((id) => games.get(id) as number));
            for (const id of rec.bypassed) expect(games.get(id) as number).toBeGreaterThanOrEqual(most);
          }
        },
      });
    }
  });

  it('players without a gender are flexible and the explanation says how to set it', () => {
    const players = [0, 1, 2, 3].map((i) => player(i, i === 3 ? {} : { gender: i === 0 ? 'female' : 'male' }));
    const rec = recommend({ now: at(5), players, courts: courts(1), settings: settingsFor('mixed'), pastGames: [], seed: 's' }).recommendations[0] as Recommendation;
    expect(rec.explanation).toMatch(/P4 has no gender set/);
    // the woman partners a man, the unset player partners the other man
    const g = genderOf(players);
    const female = rec.teamA.includes('p01') ? rec.teamA : rec.teamB;
    expect(g.get(female.find((id) => id !== 'p01') as string)).toBe('male');
  });
});

// --------------------------------------------------------------- skill pools

describe('Skill pools', () => {
  const pools16 = Array.from({ length: 16 }, (_, i) => player(i, { skillLevel: i < 8 ? 4 : 2.5, eligibleSince: at(i * 0.1) }));

  it('assigns pools from the roster first, then from skill cutoffs; unrated players go in pool B', () => {
    const two = poolSettingsOf({ pools: { source: 'manual', cutoffA: 3.5, cutoffB: null } });
    expect(poolOfPlayer({ skillLevel: 4, pool: undefined }, two)).toBe('A');
    expect(poolOfPlayer({ skillLevel: 3, pool: undefined }, two)).toBe('B');
    expect(poolOfPlayer({ skillLevel: 2, pool: 'A' }, two)).toBe('A');
    expect(poolOfPlayer({ skillLevel: null, pool: undefined }, two)).toBe('B');
    expect(poolOfPlayer({ skillLevel: null, pool: 'C' }, two)).toBe('B'); // no C pool with two pools
    const three = poolSettingsOf({ pools: { source: 'skill', cutoffA: 4, cutoffB: 3 } });
    expect(poolOfPlayer({ skillLevel: 4.5, pool: 'C' }, three)).toBe('A'); // skill source ignores the roster pool
    expect(poolOfPlayer({ skillLevel: 3.2, pool: undefined }, three)).toBe('B');
    expect(poolOfPlayer({ skillLevel: 2.9, pool: undefined }, three)).toBe('C');
  });

  it('auto splits courts by pool size with pool A on the top courts, and alternates when courts are fewer than pools', () => {
    const p = poolSettingsOf({});
    const sizes = new Map<PoolName, number>([
      ['A', 6],
      ['B', 10],
    ]);
    expect([...resolveCourtPools(courts(3), p, sizes).values()]).toEqual(['A', 'B', 'B']);
    expect([...resolveCourtPools(courts(2), p, sizes).values()]).toEqual(['A', 'B']);
    expect([...resolveCourtPools(courts(1), p, sizes).values()]).toEqual(['alternate']);
    expect([...resolveCourtPools(courts(3), { ...p, courts: ['B', 'A'] }, sizes).values()]).toEqual(['B', 'A', 'alternate']);
  });

  it('each court plays within its pool', () => {
    const res = recommend({ now: at(5), players: pools16, courts: courts(2), settings: settingsFor('pools'), pastGames: [], seed: 's' });
    expect(res.recommendations).toHaveLength(2);
    const [c1, c2] = res.recommendations as [Recommendation, Recommendation];
    expect(c1.playerIds.every((id) => Number(id.slice(1)) <= 8)).toBe(true);
    expect(c2.playerIds.every((id) => Number(id.slice(1)) > 8)).toBe(true);
    expect(c1.explanation).toMatch(/pool A \(advanced\) court/);
  });

  it('a short pool keeps its court open with a reason by default, or borrows the most-due players when set', () => {
    const players = Array.from({ length: 12 }, (_, i) => player(i, { skillLevel: i < 6 ? 4 : 2.5, eligibleSince: at(i * 0.1) }));
    const base = { pools: { courts: ['A', 'A', 'B'] as PoolName[] } };
    const open = recommend({ now: at(5), players, courts: courts(3), settings: settingsFor('pools', base), pastGames: [], seed: 's' });
    expect(open.recommendations.map((r) => r.courtId)).toEqual(['c1', 'c3']);
    expect(open.openCourts[0]?.reason).toMatch(/Court 2 stays open: it is a pool A \(advanced\) court and pool A has only 2 players waiting/);
    const borrow = recommend({ now: at(5), players, courts: courts(3), settings: settingsFor('pools', { pools: { ...base.pools, whenShort: 'borrow' } }), pastGames: [], seed: 's' });
    expect(borrow.recommendations.map((r) => r.courtId)).toEqual(['c1', 'c3', 'c2']);
    const c2 = borrow.recommendations.find((r) => r.courtId === 'c2') as Recommendation;
    expect(c2.playerIds.filter((id) => Number(id.slice(1)) <= 6)).toHaveLength(2);
    expect(c2.explanation).toMatch(/fill in from another pool \(borrowing is on\)/);
  });

  it('one court alternates between pools and every game stays within one pool', () => {
    const seenPools = new Set<string>();
    simulate({
      style: 'pools',
      courts: 1,
      players: 10,
      rounds: 16,
      seed: 9,
      skill: (i) => (i < 5 ? 4.5 : 2),
      onRound: (v) => {
        const pools = poolSettingsOf(v.settings);
        for (const rec of v.result.recommendations) {
          const used = new Set(rec.playerIds.map((id) => poolOfPlayer(v.players.find((p) => p.playerId === id) as QueuePlayer, pools)));
          expect(used.size).toBe(1);
          seenPools.add([...used][0] as string);
          expect(rec.explanation).toMatch(/Courts alternate between pools/);
        }
      },
    });
    expect(seenPools).toEqual(new Set(['A', 'B']));
  });
});

// -------------------------------------------------------------- round robin

describe('Round robin', () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => pid(i));

  it('singles with everyone on court: a perfect round robin (everyone plays everyone exactly once)', () => {
    for (const n of [4, 6, 7, 8]) {
      const s = generateRoundRobin({ id: 'x', createdAt: at(0), playerIds: ids(n), courtCount: 4, format: 'singles' });
      const cov = roundRobinCoverage(s);
      expect(s.rounds).toHaveLength(n % 2 === 0 ? n - 1 : n);
      expect(cov.pairsCovered).toBe(cov.pairsTotal);
      expect(cov.maxRepeat).toBe(1);
      if (n % 2 === 1) expect([...cov.byes.values()].every((b) => b === 1)).toBe(true);
    }
  });

  it('doubles: everyone partners as many different people as possible over one cycle', () => {
    for (const [n, c] of [
      [8, 2],
      [9, 2],
      [12, 3],
      [16, 4],
      [5, 1],
    ] as [number, number][]) {
      const s = generateRoundRobin({ id: 'x', createdAt: at(0), playerIds: ids(n), courtCount: c, format: 'doubles', seed: `rr-${n}` });
      expect(s.rounds).toHaveLength(defaultRoundRobinRounds(n, c, 'doubles'));
      const cov = roundRobinCoverage(s);
      expect(cov.pairsCovered / cov.pairsTotal, `${n} players`).toBeGreaterThanOrEqual(0.8);
      expect(cov.maxRepeat, `${n} players`).toBeLessThanOrEqual(2);
    }
  });

  it('byes rotate fairly: scheduled games stay within one of each other after every round', () => {
    for (const format of ['singles', 'doubles'] as const) {
      for (const n of [5, 6, 7, 9, 10, 11, 13, 17]) {
        for (const c of [1, 2, 3]) {
          if (n < (format === 'doubles' ? 4 : 2)) continue;
          const s = generateRoundRobin({ id: 'x', createdAt: at(0), playerIds: ids(n), courtCount: c, format, rounds: 12 });
          const games = new Map<string, number>(ids(n).map((id) => [id, 0]));
          for (const round of s.rounds) {
            const inRound = round.games.flatMap((g) => [...g.teamA, ...g.teamB]);
            expect(new Set([...inRound, ...round.byes]).size).toBe(n);
            expect(inRound.length + round.byes.length).toBe(n);
            for (const id of inRound) games.set(id, (games.get(id) as number) + 1);
            expect(spread([...games.values()])).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('rejects too few players and bad round counts', () => {
    expect(() => generateRoundRobin({ id: 'x', createdAt: at(0), playerIds: ids(3), courtCount: 1, format: 'doubles' })).toThrow(/at least 4 players/);
    expect(() => generateRoundRobin({ id: 'x', createdAt: at(0), playerIds: ids(8), courtCount: 2, format: 'doubles', rounds: 0 })).toThrow(/between 1 and 40/);
  });

  it('follows the schedule round by round; a missing player is replaced by the most-due waiting player', () => {
    const players = Array.from({ length: 10 }, (_, i) => player(i, { eligibleSince: at(i * 0.1) }));
    const schedule = generateRoundRobin({ id: 'rr', createdAt: at(0), playerIds: players.map((p) => p.playerId), courtCount: 2, format: 'doubles' });
    const settings = settingsFor('round_robin', { roundRobin: schedule });
    const res = recommend({ now: at(5), players, courts: courts(2), settings, pastGames: [], seed: 's' });
    const r0 = schedule.rounds[0] as RoundRobinSchedule['rounds'][number];
    expect(res.recommendations.map((r) => [r.teamA, r.teamB])).toEqual(r0.games.map((g) => [g.teamA, g.teamB]));
    expect(res.recommendations.map((r) => r.schedule)).toEqual([
      { scheduleId: 'rr', round: 0, game: 0 },
      { scheduleId: 'rr', round: 0, game: 1 },
    ]);
    expect(res.recommendations[0]?.explanation).toMatch(/Round 1 of \d+, game 1 of 2/);
    // a scheduled player rests: a bye player fills in and the explanation says so
    const missing = r0.games[0]?.teamA[0] as string;
    const resting = players.map((p) => (p.playerId === missing ? { ...p, status: 'unavailable' as const } : p));
    const sub = recommend({ now: at(5), players: resting, courts: courts(2), settings, pastGames: [], seed: 's' });
    const first = sub.recommendations[0] as Recommendation;
    expect(first.playerIds).not.toContain(missing);
    const filler = first.playerIds.find((id) => !(r0.games[0]?.teamA ?? []).concat(r0.games[0]?.teamB ?? []).includes(id)) as string;
    expect(r0.byes).toContain(filler);
    expect(first.explanation).toMatch(/fills in for P\d+ \(resting or away\)/);
    // started games move the schedule on: with round 1 started, the next free court gets round 2
    const startedKeys = [scheduleGameKey('rr', 0, 0), scheduleGameKey('rr', 0, 1)];
    const next = recommend({ now: at(20), players, courts: courts(2), settings, pastGames: [], seed: 's', scheduleStarted: startedKeys });
    expect(next.recommendations[0]?.schedule).toEqual({ scheduleId: 'rr', round: 1, game: 0 });
  });

  it('keeps rounds together: a free court waits while the round is still being played', () => {
    const players = Array.from({ length: 8 }, (_, i) => player(i));
    const schedule = generateRoundRobin({ id: 'rr', createdAt: at(0), playerIds: players.map((p) => p.playerId), courtCount: 2, format: 'doubles' });
    const r0 = schedule.rounds[0] as RoundRobinSchedule['rounds'][number];
    const busy = new Set([...(r0.games[1]?.teamA ?? []), ...(r0.games[1]?.teamB ?? [])]);
    const now = players.map((p) => (busy.has(p.playerId) ? { ...p, status: 'playing' as const } : p));
    const list = courts(2).map((c, i) => (i === 1 ? { ...c, occupied: true } : c));
    const res = recommend({ now: at(20), players: now, courts: list, settings: settingsFor('round_robin', { roundRobin: schedule }), pastGames: [], seed: 's', scheduleStarted: [scheduleGameKey('rr', 0, 0), scheduleGameKey('rr', 0, 1)], scheduleInProgress: [scheduleGameKey('rr', 0, 1)] });
    expect(res.recommendations).toHaveLength(0);
    expect(res.openCourts[0]?.reason).toMatch(/Round 1 of \d+ has no more games to start and its other games are still being played/);
  });

  it('without a schedule, or once it is complete, games follow the Balanced rule and say so', () => {
    const players = Array.from({ length: 8 }, (_, i) => player(i));
    const none = recommend({ now: at(5), players, courts: courts(2), settings: settingsFor('round_robin'), pastGames: [], seed: 's' });
    expect(none.recommendations).toHaveLength(2);
    expect(none.recommendations[0]?.explanation).toMatch(/No round-robin schedule yet/);
    const schedule = generateRoundRobin({ id: 'rr', createdAt: at(0), playerIds: players.map((p) => p.playerId), courtCount: 2, format: 'doubles', rounds: 1 });
    const done = recommend({ now: at(5), players, courts: courts(2), settings: settingsFor('round_robin', { roundRobin: schedule }), pastGames: [], seed: 's', scheduleStarted: [scheduleGameKey('rr', 0, 0), scheduleGameKey('rr', 0, 1)] });
    expect(done.recommendations[0]?.explanation).toMatch(/schedule is complete \(1 round\)/);
  });
});

// ------------------------------------------------------------ mentor pairing

describe('Mentor pairing', () => {
  it('pairs the strongest with the weakest and explains each pairing', () => {
    const skills = [4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1];
    const players = skills.map((s, i) => player(i, { skillLevel: s, displayName: ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal'][i] as string }));
    const res = recommend({ now: at(5), players, courts: courts(2), settings: settingsFor('mentor'), pastGames: [], seed: 's' });
    const level = new Map(players.map((p) => [p.playerId, p.skillLevel as number] as const));
    for (const rec of res.recommendations) {
      for (const team of [rec.teamA, rec.teamB]) {
        const [a, b] = team.map((id) => level.get(id) as number).sort((x, y) => y - x) as [number, number];
        expect(a).toBeGreaterThanOrEqual(3);
        expect(b).toBeLessThanOrEqual(2.5);
      }
    }
    expect(res.recommendations.map((r) => r.explanation).join(' ')).toMatch(/Mentor Ana \(4\.5\) with Hal \(1\)/);
  });

  it('unrated players count as the middle level and are labelled unrated', () => {
    const players = [4, 3, null, 2].map((s, i) => player(i, { skillLevel: s }));
    const rec = recommend({ now: at(5), players, courts: courts(1), settings: settingsFor('mentor'), pastGames: [], seed: 's' }).recommendations[0] as Recommendation;
    expect(rec.explanation).toMatch(/P3 \(unrated, counted as 3\)/);
    expect(rec.explanation).toMatch(/P3 is unrated and counted as the middle level/);
  });

  it('with nobody rated, partners rotate and the explanation asks for skill levels', () => {
    const players = [0, 1, 2, 3].map((i) => player(i));
    const rec = recommend({ now: at(5), players, courts: courts(1), settings: settingsFor('mentor'), pastGames: [], seed: 's' }).recommendations[0] as Recommendation;
    expect(rec.explanation).toMatch(/set skill levels in the roster/);
  });
});

// ------------------------------------------------------------ challenge court

describe('Challenge court', () => {
  for (const cap of [1, 2, 3]) {
    it(`winners stay on Court 1 for at most ${cap} game(s) in a row, then sit; challengers come from the fair queue`, () => {
      let streakTeam = '';
      let streak = 0;
      simulate({
        style: 'challenge',
        courts: 1,
        players: 7,
        rounds: 30,
        seed: cap,
        extra: { challenge: { cap, courts: 'first' } },
        winner: () => 'A', // holders (team A) always win, so the cap is what moves them off
        onRound: (v) => {
          const rec = v.result.recommendations[0] as Recommendation;
          const key = [...rec.teamA].sort().join('+');
          if (key === streakTeam) streak += 1;
          else {
            streakTeam = key;
            streak = 1;
          }
          // first game plus at most `cap` stays
          expect(streak).toBeLessThanOrEqual(cap + 1);
          if (streak > 1) expect(rec.explanation).toMatch(new RegExp(`stay ${streak - 1} of ${cap}`));
          expect(spread(v.players.map((p) => p.gamesPlayed))).toBeLessThanOrEqual(cap + 1);
        },
      });
    });
  }

  it('after the cap the winners sit out and the explanation says why', () => {
    const players = Array.from({ length: 6 }, (_, i) => player(i));
    const past: PastGame[] = [
      { teamA: ['p01', 'p02'], teamB: ['p03', 'p04'], courtId: 'c1', startedAt: at(0), endedAt: at(10), winner: 'A' },
      { teamA: ['p01', 'p02'], teamB: ['p05', 'p06'], courtId: 'c1', startedAt: at(11), endedAt: at(20), winner: 'A' },
      { teamA: ['p01', 'p02'], teamB: ['p03', 'p04'], courtId: 'c1', startedAt: at(21), endedAt: at(30), winner: 'A' },
    ];
    const withGames = players.map((p) => ({ ...p, gamesPlayed: ['p01', 'p02'].includes(p.playerId) ? 3 : p.playerId <= 'p04' ? 2 : 1, eligibleSince: at(30) }));
    const res = recommend({ now: at(31), players: withGames, courts: courts(1), settings: settingsFor('challenge'), pastGames: past, seed: 's' });
    const rec = res.recommendations[0] as Recommendation;
    expect(rec.playerIds).not.toContain('p01');
    expect(rec.explanation).toMatch(/P1 & P2 won 3 games in a row here and have stayed on the maximum 2 games, so they sit out/);
  });

  it('only Court 1 holds by default; with every court as a challenge court each court keeps its winners', () => {
    const players = Array.from({ length: 12 }, (_, i) => player(i, { eligibleSince: at(10) }));
    const past: PastGame[] = [
      { teamA: ['p01', 'p02'], teamB: ['p03', 'p04'], courtId: 'c1', startedAt: at(0), endedAt: at(10), winner: 'A' },
      { teamA: ['p05', 'p06'], teamB: ['p07', 'p08'], courtId: 'c2', startedAt: at(0), endedAt: at(10), winner: 'B' },
    ];
    const played = new Set(['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08']);
    const ps = players.map((p) => ({ ...p, gamesPlayed: played.has(p.playerId) ? 1 : 0 }));
    const first = recommend({ now: at(11), players: ps, courts: courts(2), settings: settingsFor('challenge'), pastGames: past, seed: 's' });
    expect(first.recommendations[0]?.teamA).toEqual(['p01', 'p02']);
    expect(first.recommendations[1]?.teamA).not.toEqual(['p07', 'p08']);
    expect(first.recommendations[1]?.explanation).toMatch(/Court 1 is the challenge court; Court 2 rotates normally/);
    const all = recommend({ now: at(11), players: ps, courts: courts(2), settings: settingsFor('challenge', { challenge: { courts: 'all' } }), pastGames: past, seed: 's' });
    expect(all.recommendations[1]?.teamA).toEqual(['p07', 'p08']);
  });

  it('a holding team breaks up when one of them is resting', () => {
    const players = Array.from({ length: 6 }, (_, i) => player(i, { status: i === 1 ? 'unavailable' : 'waiting' }));
    const past: PastGame[] = [{ teamA: ['p01', 'p02'], teamB: ['p03', 'p04'], courtId: 'c1', startedAt: at(0), endedAt: at(10), winner: 'A' }];
    const rec = recommend({ now: at(11), players, courts: courts(1), settings: settingsFor('challenge'), pastGames: past, seed: 's' }).recommendations[0] as Recommendation;
    expect(rec.explanation).toMatch(/P1 & P2 won the last game here, but P2 is resting, so the team does not stay on/);
  });
});

// -------------------------------------------------------------- Swiss pairing

describe('Swiss pairing', () => {
  it('records come from results and scores', () => {
    const rec = swissRecords([
      { teamA: ['a', 'b'], teamB: ['c', 'd'], winner: 'A', scoreA: 11, scoreB: 4 },
      { teamA: ['a', 'c'], teamB: ['b', 'd'], winner: 'B', scoreA: 9, scoreB: 11 },
      { teamA: ['a', 'd'], teamB: ['b', 'c'], winner: null },
    ]);
    expect(rec.get('a')).toEqual({ wins: 1, losses: 1, diff: 5, scored: true });
    expect(rec.get('d')).toEqual({ wins: 1, losses: 1, diff: -5, scored: true });
  });

  it('players with similar records share a court', () => {
    const players = Array.from({ length: 8 }, (_, i) => player(i, { gamesPlayed: 2, eligibleSince: at(30) }));
    const past: PastGame[] = [
      { teamA: ['p01', 'p02'], teamB: ['p05', 'p06'], courtId: 'c1', startedAt: at(0), endedAt: at(10), winner: 'A', scoreA: 11, scoreB: 5 },
      { teamA: ['p03', 'p04'], teamB: ['p07', 'p08'], courtId: 'c2', startedAt: at(0), endedAt: at(10), winner: 'A', scoreA: 11, scoreB: 7 },
      { teamA: ['p01', 'p03'], teamB: ['p05', 'p07'], courtId: 'c1', startedAt: at(15), endedAt: at(25), winner: 'A', scoreA: 11, scoreB: 3 },
      { teamA: ['p02', 'p04'], teamB: ['p06', 'p08'], courtId: 'c2', startedAt: at(15), endedAt: at(25), winner: 'A', scoreA: 11, scoreB: 9 },
    ];
    const res = recommend({ now: at(31), players, courts: courts(2), settings: settingsFor('swiss'), pastGames: past, seed: 's' });
    const winners = new Set(['p01', 'p02', 'p03', 'p04']);
    const groups = res.recommendations.map((r) => r.playerIds.every((id) => winners.has(id)) || r.playerIds.every((id) => !winners.has(id)));
    expect(groups).toEqual([true, true]);
    expect(res.recommendations.map((r) => r.explanation).join(' ')).toMatch(/Swiss: all four players are 2–0/);
  });

  it('singles: avoids a rematch when another opponent with a similar record is available', () => {
    const players = Array.from({ length: 4 }, (_, i) => player(i, { gamesPlayed: 1, eligibleSince: at(20) }));
    const past: PastGame[] = [
      { teamA: ['p01'], teamB: ['p03'], courtId: 'c1', startedAt: at(0), endedAt: at(10), winner: 'A', scoreA: 11, scoreB: 2 },
      { teamA: ['p02'], teamB: ['p04'], courtId: 'c2', startedAt: at(0), endedAt: at(10), winner: 'A', scoreA: 11, scoreB: 9 },
    ];
    // standings: p01 (1-0, +9), p02 (1-0, +2), p04 (0-1, -2), p03 (0-1, -9); p01 meets p02, p04 meets p03
    const res = recommend({ now: at(21), players, courts: courts(2), settings: settingsFor('swiss', { format: 'singles' }), pastGames: past, seed: 's' });
    const pairs = res.recommendations.map((r) => [...r.playerIds].sort().join('-')).sort();
    expect(pairs).toEqual(['p01-p02', 'p03-p04']);
    // p01 already met p03; with a rematch on the table the next unplayed opponent is chosen
    const past2: PastGame[] = [...past, { teamA: ['p01'], teamB: ['p02'], courtId: 'c1', startedAt: at(11), endedAt: at(19), winner: 'A', scoreA: 11, scoreB: 0 }];
    const ps2 = players.map((p) => ({ ...p, gamesPlayed: ['p01', 'p02'].includes(p.playerId) ? 2 : 1 }));
    const res2 = recommend({ now: at(21), players: ps2, courts: courts(2), settings: settingsFor('swiss', { format: 'singles' }), pastGames: past2, seed: 's' });
    for (const r of res2.recommendations) expect(r.explanation).toMatch(/No rematches/);
  });

  it('over a night, rematches are rarer than with plain record order', () => {
    let rematches = 0;
    let games = 0;
    simulate({
      style: 'swiss',
      courts: 2,
      players: 8,
      rounds: 6,
      seed: 21,
      format: 'singles',
      onRound: (v) => {
        const met = new Set(v.past.map((g) => [...g.teamA, ...g.teamB].sort().join('-')));
        for (const r of v.result.recommendations) {
          games += 1;
          if (met.has([...r.playerIds].sort().join('-'))) rematches += 1;
        }
      },
    });
    expect(games).toBeGreaterThan(0);
    expect(rematches / games).toBeLessThanOrEqual(0.2);
  });
});

// --------------------------------------------------------------- data layer

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teamups-adv-'));
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
    chooseSaveFile: async () => join(dir, 'schedule.pdf'),
    chooseOpenFile: async () => null,
    confirm: async () => true,
    openDisplay: () => undefined,
    printOrganizerPdf: async () => new Uint8Array([37, 80, 68, 70]),
  };
  return createApiHandlers(store, host);
}

describe('D18 player profile fields (gender, pool) stored without a schema change', () => {
  it('saves, validates, clears and lists gender and pool; the schema contract is unchanged', () => {
    const tablesBefore = listTables(db);
    const s = createSession(db, { name: 'Profiles', courtCount: 2 });
    const a = addNewPlayerToSession(db, s.id, { displayName: 'Ana' });
    expect(getPlayerProfile(db, a.playerId)).toEqual({ gender: null, pool: null });
    expect(setPlayerProfile(db, a.playerId, { gender: 'female' })).toEqual({ gender: 'female', pool: null });
    expect(setPlayerProfile(db, a.playerId, { pool: 'A' })).toEqual({ gender: 'female', pool: 'A' });
    expect(listPlayerProfiles(db)[a.playerId]).toEqual({ gender: 'female', pool: 'A' });
    expect(() => setPlayerProfile(db, a.playerId, { gender: 'other' as Gender })).toThrow(ValidationError);
    expect(() => setPlayerProfile(db, a.playerId, { pool: 'D' as PoolName })).toThrow(ValidationError);
    expect(() => setPlayerProfile(db, 'nobody', { gender: 'male' })).toThrow(ValidationError);
    setPlayerProfile(db, a.playerId, { gender: null, pool: null });
    expect(raw(db).prepare('SELECT count(*) AS n FROM settings WHERE key LIKE ?').get('player_profile:%')).toEqual({ n: 0 });
    expect(listTables(db)).toEqual(tablesBefore);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('a malformed stored profile reads as not set', () => {
    const s = createSession(db, { name: 'Bad', courtCount: 2 });
    const a = addNewPlayerToSession(db, s.id, { displayName: 'Ana' });
    raw(db).prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(`player_profile:${a.playerId}`, '{not json');
    expect(getPlayerProfile(db, a.playerId)).toEqual({ gender: null, pool: null });
    raw(db).prepare('UPDATE settings SET value = ? WHERE key = ?').run('{"gender":"robot","pool":"A"}', `player_profile:${a.playerId}`);
    expect(getPlayerProfile(db, a.playerId)).toEqual({ gender: null, pool: 'A' });
  });

  it('updatePlayerDetails saves skill (1-8) with gender and pool; the API adds a player with them', async () => {
    const s = createSession(db, { name: 'Details', courtCount: 2 });
    const a = addNewPlayerToSession(db, s.id, { displayName: 'Ana' });
    expect(updatePlayerDetails(db, a.playerId, { skillLevel: 3.75, gender: 'female', pool: 'B' })).toEqual({ playerId: a.playerId, skillLevel: 3.75, gender: 'female', pool: 'B' });
    expect(getPlayer(db, a.playerId)?.skillLevel).toBe(3.75);
    expect(() => updatePlayerDetails(db, a.playerId, { skillLevel: 12 })).toThrow(ValidationError);
    expect(() => updatePlayerDetails(db, a.playerId, { skillLevel: Number.NaN })).toThrow(ValidationError);
    expect(updatePlayerDetails(db, a.playerId, { skillLevel: null }).skillLevel).toBeNull();
    expect(listPlayerDetails(db)[a.playerId]).toEqual({ playerId: a.playerId, skillLevel: null, gender: 'female', pool: 'B' });

    const api = handlers();
    expect(API_METHODS).toEqual(expect.arrayContaining(['listPlayerDetails', 'updatePlayerDetails', 'generateRoundRobin', 'getRoundRobinStatus', 'saveSchedulePdf']));
    const added = await api.addNewPlayer(s.id, { displayName: 'Ben', gender: 'male', skillLevel: 4, pool: 'A' });
    expect(added.ok).toBe(true);
    const benId = added.ok ? (added.value as { playerId: string }).playerId : '';
    expect(listPlayerDetails(db)[benId]).toEqual({ playerId: benId, skillLevel: 4, gender: 'male', pool: 'A' });
    const bad = await api.addNewPlayer(s.id, { displayName: 'Cy', gender: 'x' as Gender });
    expect(bad.ok).toBe(false);
    expect(listPlayerDetails(db)).not.toHaveProperty('Cy');
    expect((await api.updatePlayerDetails(benId, { gender: null })).ok).toBe(true);
    expect(getPlayerProfile(db, benId).gender).toBeNull();
  });
});

describe('D17 new styles through the data layer', () => {
  const NAMES = ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kim', 'Lu'];

  function night(count: number, courtCount: number, style: AdvancedStyle) {
    const session = createSession(db, { name: `Night ${style}`, courtCount, allowSingleCourt: true, startedAt: at(0) });
    setRotationSettings(db, session.id, settingsForTeamUp(style), { at: at(0) });
    const ids = NAMES.slice(0, count).map((displayName, i) => {
      const entry = addNewPlayerToSession(db, session.id, { displayName });
      updatePlayerDetails(db, entry.playerId, { gender: i % 2 === 0 ? 'female' : 'male', skillLevel: 2 + (i % 5) * 0.5 });
      checkInPlayer(db, session.id, entry.playerId, at(i * 0.1));
      return entry.playerId;
    });
    return { sessionId: session.id, ids };
  }

  function playRound(sessionId: string, startMin: number, winners: ('A' | 'B')[]) {
    const recs = recommendNextGames(db, sessionId, { at: at(startMin) }).recommendations;
    const games = recs.map((rec) => assignRecommendation(db, sessionId, rec, { at: at(startMin) }));
    games.forEach((g, i) => recordGameResult(db, g.id, { winner: winners[i % winners.length] as 'A' | 'B', scoreA: winners[i % winners.length] === 'A' ? 11 : 6, scoreB: winners[i % winners.length] === 'A' ? 6 : 11 }, { at: at(startMin + GAME) }));
    return recs;
  }

  for (const style of NEW_STYLES) {
    for (const courtCount of [1, 3]) {
      it(`${style} on ${courtCount} court(s): rounds, results, log, decline, rest and override all work`, () => {
        const w = night(courtCount === 1 ? 6 : 12, courtCount, style);
        if (style === 'round_robin') generateRoundRobinSchedule(db, w.sessionId, { at: at(0.5) });
        for (let round = 0; round < 4; round++) {
          const recs = playRound(w.sessionId, 1 + round * ROUND, ['A', 'B']);
          expect(recs.length).toBeGreaterThan(0);
          for (const rec of recs) expect(rec.teamUp).toBe(style);
        }
        const games = listGames(db, w.sessionId);
        expect(games.every((g) => g.status === 'completed')).toBe(true);
        const assigned = listRotationEvents(db, w.sessionId).filter((e) => e.type === 'assigned');
        expect(assigned).toHaveLength(games.length);
        expect(assigned.every((e) => e.data.teamUp === style)).toBe(true);
        if (style === 'round_robin') expect(assigned.every((e) => typeof (e.data.schedule as { round?: unknown }).round === 'number')).toBe(true);

        const now = at(1 + 4 * ROUND);
        const queue = getQueue(db, w.sessionId, { at: now });
        const decliner = queue[0]?.playerId as string;
        declineTurn(db, w.sessionId, decliner, { at: now });
        const after = recommendNextGames(db, w.sessionId, { at: now });
        expect(after.recommendations.flatMap((r) => r.playerIds)).not.toContain(decliner);
        expect(after.excluded).toContainEqual({ playerId: decliner, reason: 'declined' });

        const rester = after.recommendations[0]?.playerIds[0];
        if (rester) {
          setAvailability(db, w.sessionId, rester, 'resting');
          expect(recommendNextGames(db, w.sessionId, { at: now }).recommendations.flatMap((r) => r.playerIds)).not.toContain(rester);
          setAvailability(db, w.sessionId, rester, 'available');
        }

        const free = listCourts(db, w.sessionId)[0]?.id as string;
        const pickable = getQueue(db, w.sessionId, { at: now }).filter((e) => !e.declinedCurrentTurn).map((e) => e.playerId);
        assignManually(db, w.sessionId, { courtId: free, format: 'doubles', teamA: pickable.slice(0, 2), teamB: pickable.slice(2, 4), reason: 'Visiting coach', at: now });
        const event = listRotationEvents(db, w.sessionId).at(-1);
        expect(event?.type).toBe('override');
        expect(event?.data.reason).toBe('Visiting coach');
      });
    }
  }

  it('round robin: status shows late arrivals, regenerating includes them and restarts from round 1', () => {
    const w = night(8, 2, 'round_robin');
    const first = generateRoundRobinSchedule(db, w.sessionId, { at: at(0.5) });
    expect(first.playerIds).toHaveLength(8);
    expect(first.courtCount).toBe(2);
    playRound(w.sessionId, 1, ['A']);
    expect(getRoundRobinStatus(db, w.sessionId).currentRound).toBe(1);
    const late = addNewPlayerToSession(db, w.sessionId, { displayName: 'Mo' });
    checkInPlayer(db, w.sessionId, late.playerId, at(14));
    const status = getRoundRobinStatus(db, w.sessionId);
    expect(status.notInSchedule).toEqual([late.playerId]);
    const second = generateRoundRobinSchedule(db, w.sessionId, { at: at(15), rounds: 5 });
    expect(second.id).not.toBe(first.id);
    expect(second.playerIds).toContain(late.playerId);
    expect(second.rounds).toHaveLength(5);
    const fresh = getRoundRobinStatus(db, w.sessionId);
    expect(fresh.currentRound).toBe(0);
    expect(fresh.notInSchedule).toEqual([]);
    const rec = recommendNextGames(db, w.sessionId, { at: at(16) }).recommendations[0] as Recommendation;
    expect(rec.schedule).toEqual({ scheduleId: second.id, round: 0, game: 0 });
    expect(listRotationEvents(db, w.sessionId).some((e) => e.type === 'schedule_generated')).toBe(true);
    expect(() => generateRoundRobinSchedule(db, w.sessionId, { rounds: 99 })).toThrow(ValidationError);
  });

  it('round robin: the next round fills every court even while its first game is already on court', () => {
    const w = night(12, 3, 'round_robin');
    generateRoundRobinSchedule(db, w.sessionId, { at: at(0.5) });
    for (let round = 0; round < 3; round++) {
      const start = 1 + round * ROUND;
      const games = [];
      for (let k = 0; k < 3; k++) {
        const rec = recommendNextGames(db, w.sessionId, { at: at(start) }).recommendations[0] as Recommendation;
        expect(rec.schedule).toEqual({ scheduleId: getRotationSettings(db, w.sessionId).roundRobin?.id, round, game: k });
        games.push(assignRecommendation(db, w.sessionId, rec, { at: at(start) }));
      }
      const waiting = recommendNextGames(db, w.sessionId, { at: at(start) });
      expect(waiting.recommendations).toHaveLength(0);
      games.forEach((g) => recordGameResult(db, g.id, { winner: 'A' }, { at: at(start + GAME) }));
    }
    expect(getRoundRobinStatus(db, w.sessionId).currentRound).toBe(3);
  });

  it('round robin through the API: generate, status and save as PDF', async () => {
    const w = night(8, 2, 'round_robin');
    const api = handlers();
    const noSchedule = await api.saveSchedulePdf(w.sessionId);
    expect(noSchedule.ok).toBe(false);
    const gen = await api.generateRoundRobin(w.sessionId, { rounds: 3 });
    expect(gen.ok).toBe(true);
    const status = await api.getRoundRobinStatus(w.sessionId);
    expect(status.ok && (status.value as { schedule: RoundRobinSchedule }).schedule.rounds.length).toBe(3);
    const saved = await api.saveSchedulePdf(w.sessionId);
    expect(saved).toEqual({ ok: true, value: join(dir, 'schedule.pdf') });
  });

  it('validates the new settings', () => {
    const s = createSession(db, { name: 'Checks', courtCount: 2 });
    expect(() => setRotationSettings(db, s.id, { pools: { cutoffA: 9 } })).toThrow(ValidationError);
    expect(() => setRotationSettings(db, s.id, { pools: { cutoffA: 3, cutoffB: 3.5 } })).toThrow(ValidationError);
    expect(() => setRotationSettings(db, s.id, { pools: { courts: ['A', 'Z' as PoolName] } })).toThrow(ValidationError);
    expect(() => setRotationSettings(db, s.id, { pools: { whenShort: 'panic' as 'borrow' } })).toThrow(ValidationError);
    expect(() => setRotationSettings(db, s.id, { challenge: { cap: 4 } })).toThrow(ValidationError);
    expect(() => setRotationSettings(db, s.id, { challenge: { courts: 'some' as 'all' } })).toThrow(ValidationError);
    expect(() => setRotationSettings(db, s.id, { roundRobin: { id: 'x' } as unknown as RoundRobinSchedule })).toThrow(ValidationError);
    const ok = setRotationSettings(db, s.id, { teamUp: 'pools', pools: { source: 'skill', cutoffA: 4, cutoffB: 3, courts: ['A', 'B'], whenShort: 'borrow' }, challenge: { cap: 3, courts: 'all' } });
    expect(ok.pools?.cutoffB).toBe(3);
    expect(getRotationSettings(db, s.id).challenge).toEqual({ cap: 3, courts: 'all' });
  });

  it('mixed doubles reads genders from the roster profiles', () => {
    const w = night(8, 2, 'mixed');
    const recs = recommendNextGames(db, w.sessionId, { at: at(2) }).recommendations;
    const details = listPlayerDetails(db);
    for (const rec of recs) for (const team of [rec.teamA, rec.teamB]) expect(new Set(team.map((id) => details[id]?.gender))).toEqual(new Set(['male', 'female']));
  });
});

// --------------------------------------------------------- explanation window

describe('Team-up guide (the explanation window content)', () => {
  it('every selectable style has a complete guide entry and a selector choice', () => {
    expect(TEAM_UP_CHOICES.map((c) => c.value)).toEqual([...TEAM_UP_STYLES]);
    for (const style of TEAM_UP_STYLES) {
      const g = guideFor(style);
      expect(g, style).toBe(TEAM_UP_GUIDE[style]);
      expect(g.title.length).toBeGreaterThan(3);
      expect(g.icon.length).toBeGreaterThan(0);
      expect(g.summary).toMatch(/\.$/);
      expect(g.how.length).toBeGreaterThanOrEqual(3);
      expect(g.how.length).toBeLessThanOrEqual(5);
      for (const line of g.how) expect(line.length).toBeGreaterThan(10);
      expect(g.bestFor.length).toBeGreaterThan(10);
      expect(g.fairness.length).toBeGreaterThan(10);
      expect(g.needs.length).toBeGreaterThanOrEqual(1);
      expect(g.diagram.length).toBeGreaterThan(0);
      expect(g.hint.length).toBeGreaterThan(10);
      expect(typeof g.example).toBe('function');
      expect(g.example(['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal'].map((name, i) => ({ name, gender: i % 2 === 0 ? 'female' : 'male', skill: 2 + i * 0.25 }))).length).toBeGreaterThan(10);
      expect(g.example([]).length).toBeGreaterThan(10);
    }
  });

  it('the fairness note names the bounded exceptions', () => {
    expect(guideFor('challenge').fairness).toMatch(/exception/i);
    expect(guideFor('round_robin').fairness).toMatch(/bye/i);
    expect(guideFor('pools').fairness).toMatch(/within each pool/i);
    expect(guideFor('mixed').needs.some((n) => n.requirement === 'genders')).toBe(true);
    expect(guideFor('mentor').needs.some((n) => n.requirement === 'skills')).toBe(true);
  });

  it('examples use the roster: real genders for mixed doubles and real skill levels for mentor pairing', () => {
    const roster = [
      { name: 'Kai', gender: 'male' as const, skill: 4.5 },
      { name: 'Lena', gender: 'female' as const, skill: 2 },
      { name: 'Max', gender: 'male' as const, skill: 2.5 },
      { name: 'Noor', gender: 'female' as const, skill: 4 },
    ];
    expect(guideFor('mixed').example(roster)).toBe('Lena (F) & Kai (M) vs Max (M) & Noor (F): both teams are mixed.');
    expect(guideFor('mentor').example(roster)).toBe('Mentor Kai (4.5) with Lena (2.0) vs mentor Noor (4.0) with Max (2.5).');
  });
});
