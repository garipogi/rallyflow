/**
 * D17 round robin: schedule generation and coverage. Pure: no I/O.
 *
 * Doubles: every round the players with the fewest scheduled games play (byes rotate fairly: the
 * players with the most games sit, ties go to whoever has sat out less often, then a seeded draw),
 * and the players are paired so new partnerships come first, then new opponents. Over the default
 * number of rounds everyone partners everyone as evenly as the court count allows.
 * Singles: everyone plays everyone. When every player (or all but one) fits on court each round the
 * classic circle method gives a perfect round robin; otherwise the same greedy rule as doubles runs.
 */
import { pairKey } from './history';
import { generator, hashSeed, shuffled } from './teamups';
import { playersNeeded, RotationError, type GameFormat, type RoundRobinGame, type RoundRobinRound, type RoundRobinSchedule } from './types';

export const MAX_ROUND_ROBIN_ROUNDS = 40;

export interface RoundRobinRequest {
  id: string;
  createdAt: string;
  /** Players in roster order. */
  playerIds: readonly string[];
  /** Courts in play; games per round = min(courts, players / players per game). */
  courtCount: number;
  format: GameFormat;
  /** Number of rounds (1-40); absent = one full cycle (defaultRoundRobinRounds). */
  rounds?: number;
  seed?: string;
  /** Games each player already played this session: players with more games sit out first. */
  initialGames?: ReadonlyMap<string, number>;
}

/** Games that fit in one round. */
export function gamesPerRound(playerCount: number, courtCount: number, format: GameFormat): number {
  return Math.max(0, Math.min(courtCount, Math.floor(playerCount / playersNeeded(format))));
}

/**
 * Rounds for one full cycle: every pair of players partners once (doubles) or meets once (singles)
 * if the courts allow it. 0 when there are not enough players for one game.
 */
export function defaultRoundRobinRounds(playerCount: number, courtCount: number, format: GameFormat): number {
  const g = gamesPerRound(playerCount, courtCount, format);
  if (g === 0) return 0;
  const pairs = (playerCount * (playerCount - 1)) / 2;
  const perRound = format === 'doubles' ? 2 * g : g;
  return Math.min(MAX_ROUND_ROBIN_ROUNDS, Math.max(1, Math.ceil(pairs / perRound)));
}

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

/** Generates a schedule. Throws RotationError for too few players, bad court or round counts, or duplicate ids. */
export function generateRoundRobin(req: RoundRobinRequest): RoundRobinSchedule {
  const ids = [...req.playerIds];
  if (new Set(ids).size !== ids.length) throw new RotationError('Duplicate player id in the round robin.');
  const need = playersNeeded(req.format);
  if (ids.length < need) {
    throw new RotationError(`A ${req.format} round robin needs at least ${need} players; ${ids.length} ${ids.length === 1 ? 'is' : 'are'} here.`);
  }
  if (!Number.isInteger(req.courtCount) || req.courtCount < 1) throw new RotationError('A round robin needs at least one court.');
  const rounds = req.rounds ?? defaultRoundRobinRounds(ids.length, req.courtCount, req.format);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUND_ROBIN_ROUNDS) {
    throw new RotationError(`Choose between 1 and ${MAX_ROUND_ROBIN_ROUNDS} rounds.`);
  }
  const g = gamesPerRound(ids.length, req.courtCount, req.format);
  const seed = req.seed ?? req.id;
  const schedule =
    req.format === 'singles' && g >= Math.floor(ids.length / 2)
      ? circleRounds(ids, rounds, seed)
      : greedyRounds(ids, rounds, g, req.format, seed, req.initialGames);
  return { id: req.id, createdAt: req.createdAt, format: req.format, courtCount: g, playerIds: ids, rounds: schedule };
}

/** Classic circle method (singles, everyone on court each round apart from one bye when odd). */
function circleRounds(ids: readonly string[], rounds: number, seed: string): RoundRobinRound[] {
  const order: (string | null)[] = shuffled(ids, generator(hashSeed(`${seed}\u0000circle`)));
  if (order.length % 2 === 1) order.push(null);
  const m = order.length;
  const out: RoundRobinRound[] = [];
  for (let r = 0; r < rounds; r++) {
    const shift = r % (m - 1);
    const rest = order.slice(1);
    const rotated = [order[0] as string | null, ...rest.slice(rest.length - shift), ...rest.slice(0, rest.length - shift)];
    const games: RoundRobinGame[] = [];
    const byes: string[] = [];
    for (let i = 0; i < m / 2; i++) {
      const a = rotated[i] ?? null;
      const b = rotated[m - 1 - i] ?? null;
      if (a !== null && b !== null) games.push({ teamA: [a], teamB: [b] });
      else if (a !== null) byes.push(a);
      else if (b !== null) byes.push(b);
    }
    out.push({ games, byes });
  }
  return out;
}

interface Tally {
  games: Map<string, number>;
  byes: Map<string, number>;
  partners: Map<string, number>;
  opponents: Map<string, number>;
}

function greedyRounds(
  ids: readonly string[],
  rounds: number,
  g: number,
  format: GameFormat,
  seed: string,
  initialGames: ReadonlyMap<string, number> | undefined,
): RoundRobinRound[] {
  const need = playersNeeded(format);
  const tally: Tally = {
    games: new Map(ids.map((id) => [id, initialGames?.get(id) ?? 0] as const)),
    byes: new Map(ids.map((id) => [id, 0] as const)),
    partners: new Map(),
    opponents: new Map(),
  };
  const out: RoundRobinRound[] = [];
  for (let r = 0; r < rounds; r++) {
    const next = generator(hashSeed(`${seed}\u0000round robin ${r}`));
    const draw = new Map(ids.map((id) => [id, next()] as const));
    const order = [...ids].sort(
      (a, b) =>
        (tally.games.get(a) as number) - (tally.games.get(b) as number) ||
        (tally.byes.get(b) as number) - (tally.byes.get(a) as number) ||
        (draw.get(a) as number) - (draw.get(b) as number),
    );
    const playing = order.slice(0, g * need);
    const byes = ids.filter((id) => !playing.includes(id));
    const games = format === 'doubles' ? bestDoubles(playing, tally, next) : bestSingles(playing, tally, next);
    for (const game of games) {
      for (const team of [game.teamA, game.teamB]) {
        for (const id of team) bump(tally.games, id);
        if (team.length === 2) bump(tally.partners, pairKey(team[0] as string, team[1] as string));
      }
      for (const a of game.teamA) for (const b of game.teamB) bump(tally.opponents, pairKey(a, b));
    }
    for (const id of byes) bump(tally.byes, id);
    out.push({ games, byes });
  }
  return out;
}

const ATTEMPTS = 60;

function count(map: ReadonlyMap<string, number>, a: string, b: string): number {
  return map.get(pairKey(a, b)) ?? 0;
}

/** Pairs the playing players into teams (new partners first) and teams into games (new opponents next). */
function bestDoubles(playing: readonly string[], tally: Tally, next: () => number): RoundRobinGame[] {
  const partnerCost = (p: string, q: string): number => {
    const c = count(tally.partners, p, q);
    return c * c;
  };
  const oppCost = (t: readonly string[], u: readonly string[]): number =>
    t.reduce((acc, a) => acc + u.reduce((inner, b) => inner + count(tally.opponents, a, b) ** 2, 0), 0);
  let best: { games: RoundRobinGame[]; cost: number } | null = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const pool = shuffled(playing, next);
    const teams: string[][] = [];
    while (pool.length > 0) {
      const p = pool.shift() as string;
      let at = 0;
      for (let i = 1; i < pool.length; i++) if (partnerCost(p, pool[i] as string) < partnerCost(p, pool[at] as string)) at = i;
      teams.push([p, pool.splice(at, 1)[0] as string]);
    }
    // local improvement: swap partners between two teams while it lowers the partner cost
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          const [a, b] = teams[i] as [string, string];
          const [c, d] = teams[j] as [string, string];
          const now = partnerCost(a, b) + partnerCost(c, d);
          if (partnerCost(a, c) + partnerCost(b, d) < now) {
            teams[i] = [a, c];
            teams[j] = [b, d];
            improved = true;
          } else if (partnerCost(a, d) + partnerCost(b, c) < now) {
            teams[i] = [a, d];
            teams[j] = [b, c];
            improved = true;
          }
        }
      }
    }
    const tpool = shuffled(teams, next);
    const games: RoundRobinGame[] = [];
    let cost = teams.reduce((acc, t) => acc + partnerCost(t[0] as string, t[1] as string), 0) * 1000;
    while (tpool.length > 0) {
      const t = tpool.shift() as string[];
      let at = 0;
      for (let i = 1; i < tpool.length; i++) if (oppCost(t, tpool[i] as string[]) < oppCost(t, tpool[at] as string[])) at = i;
      const u = tpool.splice(at, 1)[0] as string[];
      cost += oppCost(t, u);
      games.push({ teamA: t, teamB: u });
    }
    if (best === null || cost < best.cost) best = { games, cost };
    if (cost === 0) break;
  }
  return (best as { games: RoundRobinGame[] }).games;
}

/** Pairs the playing players into singles games, new opponents first. */
function bestSingles(playing: readonly string[], tally: Tally, next: () => number): RoundRobinGame[] {
  let best: { games: RoundRobinGame[]; cost: number } | null = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const pool = shuffled(playing, next);
    const games: RoundRobinGame[] = [];
    let cost = 0;
    while (pool.length > 0) {
      const p = pool.shift() as string;
      let at = 0;
      for (let i = 1; i < pool.length; i++) if (count(tally.opponents, p, pool[i] as string) < count(tally.opponents, p, pool[at] as string)) at = i;
      const q = pool.splice(at, 1)[0] as string;
      cost += count(tally.opponents, p, q) ** 2;
      games.push({ teamA: [p], teamB: [q] });
    }
    if (best === null || cost < best.cost) best = { games, cost };
    if (cost === 0) break;
  }
  return (best as { games: RoundRobinGame[] }).games;
}

export interface RoundRobinCoverage {
  /** Different pairs who partner (doubles) or meet (singles) at least once. */
  pairsCovered: number;
  /** Every possible pair of players. */
  pairsTotal: number;
  /** Most times one pair partners (doubles) or meets (singles). */
  maxRepeat: number;
  games: Map<string, number>;
  byes: Map<string, number>;
}

/** How evenly a schedule mixes the players. */
export function roundRobinCoverage(schedule: RoundRobinSchedule): RoundRobinCoverage {
  const pairs = new Map<string, number>();
  const games = new Map(schedule.playerIds.map((id) => [id, 0] as const));
  const byes = new Map(schedule.playerIds.map((id) => [id, 0] as const));
  for (const round of schedule.rounds) {
    for (const game of round.games) {
      for (const id of [...game.teamA, ...game.teamB]) bump(games, id);
      if (schedule.format === 'doubles') {
        for (const team of [game.teamA, game.teamB]) if (team.length === 2) bump(pairs, pairKey(team[0] as string, team[1] as string));
      } else {
        for (const a of game.teamA) for (const b of game.teamB) bump(pairs, pairKey(a, b));
      }
    }
    for (const id of round.byes) bump(byes, id);
  }
  const n = schedule.playerIds.length;
  return {
    pairsCovered: pairs.size,
    pairsTotal: (n * (n - 1)) / 2,
    maxRepeat: Math.max(0, ...pairs.values()),
    games,
    byes,
  };
}
