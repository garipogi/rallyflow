/**
 * D16 team-up styles: random (sit-out wheel), paddle stacking, up & down the river and fixed
 * partners. Pure: no I/O.
 *
 * Fairness first in every style: who plays is decided by the balanced-games queue (D14: fewest games
 * first, then longest wait, then a rotating draw). The style only changes how the chosen players are
 * grouped into courts and teams, with two documented tie-break refinements that never change the
 * game counts:
 * - random puts players who have not played yet in the current cycle ahead of everyone else (the
 *   sit-out wheel), so nobody plays twice before every available player has played once;
 * - river lets winners stay ahead of losers when players are tied on games and wait, so the
 *   bottom-court losers are the ones who go to the waiting line.
 *
 * All courts free at the same moment are filled together: the first `courts x players` of the queue
 * are chosen, then grouped across those courts. Declined, resting, unavailable and playing players
 * are never chosen, unavailable and occupied courts are skipped, and a court stays open when there
 * are not enough players, exactly as in the original engine.
 */
import { tieDraw } from './fairness';
import { opponentCounts, pairKey, partnershipCounts } from './history';
import { assertUniqueIds, orderQueue, parseInstant } from './queue';
import {
  playersNeeded,
  type ClassicGroupingStyle,
  type CourtInput,
  type ExcludedPlayer,
  type GroupingStyle,
  type OpenCourt,
  type PastGame,
  type PlayerReason,
  type QueueEntry,
  type QueueOrdering,
  type Recommendation,
  type RecommendationResult,
  type RotationInput,
  type SkippedCourt,
} from './types';

/** Short names used in explanations. */
export const TEAM_UP_NAMES: Readonly<Record<GroupingStyle, string>> = {
  random: 'Random teams',
  paddle_stack: 'Paddle stacking',
  river: 'Up & Down the River',
  fixed_partners: 'Fixed partners',
  mixed: 'Mixed doubles',
  pools: 'Skill pools',
  round_robin: 'Round robin',
  mentor: 'Mentor pairing',
  challenge: 'Challenge court',
  swiss: 'Swiss pairing',
};

// ------------------------------------------------------------------ history

/** A player's standing from the session's games: their stack for paddle stacking and the river. */
export type Stack = 'winner' | 'loser' | 'neutral';

export interface PlayerStanding {
  stack: Stack;
  /** Why a player is neutral: no finished game yet, sat out since their last game, or their last game had no winner. */
  neutralReason?: 'new' | 'sat_out' | 'no_result';
  /** Court of the player's last finished game. */
  lastCourtId: string | null;
  /** Teammates in the player's most recent game. */
  lastPartners: string[];
}

export interface TimedGame {
  game: PastGame;
  players: string[];
  startedMs: number | null;
  endedMs: number | null;
}

function msOrNull(value: string | null | undefined, what: string): number | null {
  return value === null || value === undefined ? null : parseInstant(value, what);
}

/** Games in the order they started (input order when start times are missing). */
export function chronological(pastGames: readonly PastGame[]): TimedGame[] {
  const timed = pastGames.map((game, i) => ({
    game,
    players: [...game.teamA, ...game.teamB],
    startedMs: msOrNull(game.startedAt, `startedAt of past game ${i}`),
    endedMs: msOrNull(game.endedAt, `endedAt of past game ${i}`),
  }));
  if (timed.every((t) => t.startedMs !== null)) {
    return timed
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (a.t.startedMs as number) - (b.t.startedMs as number) || a.i - b.i)
      .map((x) => x.t);
  }
  return timed;
}

/**
 * Each player's standing. A player is neutral when they have no finished game, when their last game
 * ended without a winner, or when they sat out: a game they were not in started after their last
 * game ended and no later than the most recent game end in the session (games started after that
 * belong to the round being filled right now, so filling one court does not turn the players waiting
 * for the next court into sitters).
 */
export function standings(pastGames: readonly PastGame[]): Map<string, PlayerStanding> {
  const games = chronological(pastGames);
  const latestEnd = Math.max(-Infinity, ...games.map((g) => g.endedMs ?? -Infinity));
  const lastGame = new Map<string, TimedGame>();
  const lastEnded = new Map<string, TimedGame>();
  for (const g of games) {
    for (const id of g.players) {
      lastGame.set(id, g);
      if (g.endedMs !== null) {
        const prev = lastEnded.get(id);
        if (!prev || (prev.endedMs as number) <= g.endedMs) lastEnded.set(id, g);
      }
    }
  }
  const result = new Map<string, PlayerStanding>();
  for (const [id, g] of lastGame) {
    const team = g.game.teamA.includes(id) ? g.game.teamA : g.game.teamB;
    const lastPartners = team.filter((x) => x !== id);
    const ended = lastEnded.get(id);
    if (!ended) {
      result.set(id, { stack: 'neutral', neutralReason: 'new', lastCourtId: null, lastPartners });
      continue;
    }
    const endMs = ended.endedMs as number;
    const lastCourtId = ended.game.courtId ?? null;
    const satOut = games.some(
      (other) =>
        other.startedMs !== null && !other.players.includes(id) && other.startedMs > endMs && other.startedMs <= latestEnd,
    );
    const winner = ended.game.winner ?? null;
    if (satOut) result.set(id, { stack: 'neutral', neutralReason: 'sat_out', lastCourtId, lastPartners });
    else if (winner === null) result.set(id, { stack: 'neutral', neutralReason: 'no_result', lastCourtId, lastPartners });
    else {
      const won = (winner === 'A' ? ended.game.teamA : ended.game.teamB).includes(id);
      result.set(id, { stack: won ? 'winner' : 'loser', lastCourtId, lastPartners });
    }
  }
  return result;
}

const NEW_STANDING: PlayerStanding = { stack: 'neutral', neutralReason: 'new', lastCourtId: null, lastPartners: [] };

/**
 * Random's sit-out wheel: the players who have already played in the current cycle. Walking the
 * games in start order, each game's players join the cycle; once every pool player who had checked
 * in by then has played, the cycle is complete and the next one starts with the players of that game
 * who were playing a second time (they were needed to fill the court, so they count as having played
 * in the new cycle, as does anyone who played twice in the old cycle because others declined). The pool is the checked-in players who are not away right now, so a late
 * arrival joins the current cycle as not yet played and a resting player is outside the wheel until
 * they return.
 */
export function cyclePlayed(
  pastGames: readonly PastGame[],
  pool: readonly { playerId: string; checkedInAt: string }[],
): Set<string> {
  const arrivals = pool.map((p) => ({ id: p.playerId, ms: parseInstant(p.checkedInAt, `checkedInAt of ${p.playerId}`) }));
  let played = new Set<string>();
  let repeats = new Set<string>();
  for (const g of chronological(pastGames)) {
    for (const id of g.players) {
      if (played.has(id)) repeats.add(id);
      else played.add(id);
    }
    const due = arrivals.filter((a) => g.startedMs === null || a.ms <= g.startedMs);
    if (due.length > 0 && due.every((a) => played.has(a.id))) {
      played = repeats;
      repeats = new Set();
    }
  }
  return played;
}

// ---------------------------------------------------------------- utilities

export function hashSeed(text: string): number {
  return tieDraw(text, '', 0);
}

/** Small deterministic generator (mulberry32). */
export function generator(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] as string}`;
}

export interface Teams {
  teamA: string[];
  teamB: string[];
}

/** Every way to split a group into two teams (the first player's partner varies). */
function splitsOf(group: readonly string[]): Teams[] {
  if (group.length === 2) return [{ teamA: [group[0] as string], teamB: [group[1] as string] }];
  return [1, 2, 3].map((y) => ({
    teamA: [group[0] as string, group[y] as string],
    teamB: group.filter((_, i) => i !== 0 && i !== y),
  }));
}

export type Score = (t: Teams) => number;

/** Keeps the splits best on each criterion in turn; the seeded draw settles what is left. */
export function chooseSplit(group: readonly string[], criteria: readonly Score[], seed: string): Teams {
  let candidates = splitsOf(group);
  for (const score of criteria) {
    const best = Math.min(...candidates.map(score));
    candidates = candidates.filter((c) => score(c) === best);
  }
  const draw = (t: Teams): number => hashSeed(`${seed}\u0000${[...t.teamA].sort().join(',')}`);
  return [...candidates].sort((a, b) => draw(a) - draw(b))[0] as Teams;
}

// ------------------------------------------------------------------- engine

export interface Context {
  input: RotationInput;
  need: number;
  names: (id: string) => string;
  standing: (id: string) => PlayerStanding;
  partners: Map<string, number>;
  opponents: Map<string, number>;
  /** All courts that are not unavailable, in court order: the river ladder. */
  ladder: CourtInput[];
  courtLabel: (courtId: string | null) => string;
  /** Seed for this round's draws: the session seed plus the number of games so far. */
  roundSeed: string;
}

export function lastPartnerRepeats(ctx: Context): Score {
  return (t) =>
    [t.teamA, t.teamB].reduce(
      (acc, team) => acc + (team.length === 2 && ctx.standing(team[0] as string).lastPartners.includes(team[1] as string) ? 1 : 0),
      0,
    );
}

export function historyRepeats(ctx: Context): Score {
  return (t) =>
    [t.teamA, t.teamB].reduce(
      (acc, team) => acc + (team.length === 2 ? (ctx.partners.get(pairKey(team[0] as string, team[1] as string)) ?? 0) : 0),
      0,
    );
}

export function opponentRepeats(ctx: Context): Score {
  return (t) => t.teamA.reduce((acc, a) => acc + t.teamB.reduce((inner, b) => inner + (ctx.opponents.get(pairKey(a, b)) ?? 0), 0), 0);
}

function stackImbalance(ctx: Context): Score {
  return (t) =>
    (['winner', 'loser', 'neutral'] as const).reduce((acc, stack) => {
      const a = t.teamA.filter((id) => ctx.standing(id).stack === stack).length;
      const b = t.teamB.filter((id) => ctx.standing(id).stack === stack).length;
      return acc + Math.abs(a - b);
    }, 0);
}

/** Ladder rank of a court (0 = top). A court that is out of play ranks with the next court below it. */
export function rankOf(ctx: Context, courtId: string | null): number | null {
  if (courtId === null) return null;
  const at = ctx.input.courts.findIndex((c) => c.courtId === courtId);
  if (at < 0 || ctx.ladder.length === 0) return null;
  const before = ctx.input.courts.slice(0, at).filter((c) => c.status !== 'unavailable').length;
  return Math.min(before, ctx.ladder.length - 1);
}

interface RiverPlace {
  target: number;
  /** 0 winner, 1 loser moving down, 2 coming in from the waiting line, 3 bottom-court loser. */
  order: number;
}

function riverPlace(ctx: Context, id: string): RiverPlace {
  const bottom = Math.max(0, ctx.ladder.length - 1);
  const s = ctx.standing(id);
  const rank = rankOf(ctx, s.lastCourtId);
  if (s.stack === 'neutral' || rank === null) return { target: bottom, order: 2 };
  if (s.stack === 'winner') return { target: Math.max(0, rank - 1), order: 0 };
  if (rank + 1 > bottom) return { target: bottom, order: 3 };
  return { target: rank + 1, order: 1 };
}

/** The queue order each style uses (balanced games plus the style's documented tie refinements). */
function orderingFor(ctx: Context, style: GroupingStyle): QueueOrdering {
  const ordering: QueueOrdering = { fairness: 'balanced_games', seed: ctx.input.seed ?? '' };
  if (style === 'random') {
    const pool = ctx.input.players.filter((p) => p.status !== 'unavailable');
    const played = cyclePlayed(ctx.input.pastGames ?? [], pool);
    ordering.firstKey = new Map(pool.map((p) => [p.playerId, played.has(p.playerId) ? 1 : 0] as const));
  } else if (style === 'river') {
    ordering.tieKey = new Map(ctx.input.players.map((p) => [p.playerId, riverPlace(ctx, p.playerId).order] as const));
  }
  return ordering;
}

export function contextOf(input: RotationInput): Context {
  const pastGames = input.pastGames ?? [];
  const table = standings(pastGames);
  const nameMap = new Map(input.players.map((p) => [p.playerId, p.displayName] as const));
  const labels = new Map(input.courts.map((c) => [c.courtId, c.label] as const));
  return {
    input,
    need: playersNeeded(input.settings.format),
    names: (id) => nameMap.get(id) ?? id,
    standing: (id) => table.get(id) ?? NEW_STANDING,
    partners: partnershipCounts(pastGames),
    opponents: opponentCounts(pastGames),
    ladder: input.courts.filter((c) => c.status !== 'unavailable'),
    courtLabel: (courtId) => (courtId === null ? 'a court' : (labels.get(courtId) ?? 'a removed court')),
    roundSeed: `${input.seed ?? ''}\u0000round ${pastGames.length}`,
  };
}

/** D16: the waiting queue in the order a grouping style uses. */
export function teamUpQueue(input: RotationInput, style: GroupingStyle): QueueEntry[] {
  const ctx = contextOf(input);
  return orderQueue(input.players, input.now, orderingFor(ctx, style));
}

interface Planned {
  court: CourtInput;
  teams: Teams;
  chosen: QueueEntry[];
  bypassed: QueueEntry[];
  notes: string[];
}

/** D16 recommendations for a grouping style. Same result shape and guarantees as recommend(). */
export function recommendTeamUps(input: RotationInput, style: ClassicGroupingStyle): RecommendationResult {
  parseInstant(input.now, 'now');
  assertUniqueIds(
    input.courts.map((c) => c.courtId),
    'court',
  );
  const ctx = contextOf(input);
  const queue = orderQueue(input.players, input.now, orderingFor(ctx, style)); // also validates the players
  const { settings } = input;
  const need = ctx.need;

  const excluded: ExcludedPlayer[] = [];
  for (const p of input.players) {
    if (p.status === 'playing') excluded.push({ playerId: p.playerId, reason: 'playing' });
    else if (p.status === 'unavailable') excluded.push({ playerId: p.playerId, reason: 'unavailable' });
    else if (p.declinedCurrentTurn === true) excluded.push({ playerId: p.playerId, reason: 'declined' });
  }

  const skippedCourts: SkippedCourt[] = [];
  const free: CourtInput[] = [];
  for (const court of input.courts) {
    if (court.status === 'unavailable') skippedCourts.push({ courtId: court.courtId, reason: 'unavailable' });
    else if (court.occupied) skippedCourts.push({ courtId: court.courtId, reason: 'occupied' });
    else free.push(court);
  }

  const eligible = queue.filter((e) => !e.declinedCurrentTurn);
  const planned =
    style === 'fixed_partners' && settings.format === 'doubles'
      ? planFixedPartners(ctx, free, eligible)
      : planGrouped(ctx, style, free, eligible);

  const used = new Set(planned.flatMap((p) => p.chosen.map((e) => e.playerId)));
  const left = eligible.filter((e) => !used.has(e.playerId)).length;
  const openCourts: OpenCourt[] = free.slice(planned.length).map((court) => ({
    courtId: court.courtId,
    courtLabel: court.label,
    needed: need,
    available: left,
    reason: `${court.label} stays open: ${settings.format} needs ${need} eligible players but only ${left} ${left === 1 ? 'is' : 'are'} waiting.`,
  }));

  const recommendations: Recommendation[] = planned.map((p) => {
    const reasons: PlayerReason[] = p.chosen.map((e) => ({
      playerId: e.playerId,
      displayName: e.displayName,
      queuePosition: e.position,
      eligibleSince: e.eligibleSince,
      waitedMs: e.waitedMs,
      gamesPlayed: e.gamesPlayed,
      effectiveGames: e.effectiveGames ?? e.gamesPlayed,
    }));
    const doubles = settings.format === 'doubles';
    return {
      courtId: p.court.courtId,
      courtLabel: p.court.label,
      format: settings.format,
      playerIds: p.chosen.map((e) => e.playerId),
      teamA: p.teams.teamA,
      teamB: p.teams.teamB,
      reasons,
      bypassed: p.bypassed.map((e) => e.playerId),
      repeatPartnerships: doubles ? historyRepeats(ctx)(p.teams) : 0,
      ...(doubles ? { repeatOpponents: opponentRepeats(ctx)(p.teams) } : {}),
      explanation: explainPlan(ctx, style, p),
      teamUp: style,
    };
  });

  return { recommendations, openCourts, skippedCourts, excluded };
}

/** Random, paddle stacking, river (and fixed partners in singles): choose by the queue, then group. */
function planGrouped(ctx: Context, style: ClassicGroupingStyle, free: readonly CourtInput[], eligible: readonly QueueEntry[]): Planned[] {
  const need = ctx.need;
  const k = Math.min(free.length, Math.floor(eligible.length / need));
  if (k === 0) return [];
  const chosen = eligible.slice(0, k * need);
  const entryOf = new Map(chosen.map((e) => [e.playerId, e] as const));
  const ids = chosen.map((e) => e.playerId);
  const courts = free.slice(0, k);

  let groups: string[][];
  let criteria: Score[];
  if (style === 'random') {
    groups = randomGroups(ctx, ids, k);
    criteria = [];
  } else if (style === 'paddle_stack') {
    groups = chunk(stackOrder(ctx, chosen), need);
    criteria = [stackImbalance(ctx), lastPartnerRepeats(ctx), historyRepeats(ctx), opponentRepeats(ctx)];
  } else if (style === 'river') {
    groups = chunk(riverOrder(ctx, chosen), need);
    criteria = [lastPartnerRepeats(ctx), stackImbalance(ctx), historyRepeats(ctx), opponentRepeats(ctx)];
  } else {
    // fixed partners in singles: there are no partners, so the balanced pairing applies
    groups = chunk(ids, need);
    criteria = [opponentRepeats(ctx)];
  }

  return groups.map((group, i) => {
    const teams =
      style === 'random'
        ? { teamA: group.slice(0, need / 2), teamB: group.slice(need / 2) }
        : chooseSplit(group, criteria, `${ctx.roundSeed}\u0000${i}`);
    return {
      court: courts[i] as CourtInput,
      teams,
      chosen: group.map((id) => entryOf.get(id) as QueueEntry),
      bypassed: [],
      notes: style === 'fixed_partners' ? ['Singles has no partners, so locked pairs do not apply; opponents rotate.'] : [],
    };
  });
}

/** Seeded shuffles of the chosen players; the first one without a last-game partner repeat wins (else the fewest). */
function randomGroups(ctx: Context, ids: readonly string[], k: number): string[][] {
  const next = generator(hashSeed(ctx.roundSeed));
  const half = ctx.need / 2;
  const repeatsOf = (order: readonly string[]): number =>
    chunk(order, ctx.need).reduce(
      (acc, g) => acc + lastPartnerRepeats(ctx)({ teamA: g.slice(0, half), teamB: g.slice(half) }),
      0,
    );
  let best: string[] | null = null;
  let bestRepeats = Infinity;
  for (let attempt = 0; attempt < 64 && bestRepeats > 0; attempt++) {
    const order = shuffled(ids, next);
    const repeats = repeatsOf(order);
    if (repeats < bestRepeats) {
      best = order;
      bestRepeats = repeats;
    }
  }
  return chunk(best ?? [...ids], ctx.need).slice(0, k);
}

/** Paddle stacking order: winners (top court first), then losers (top court first), then neutral players. */
function stackOrder(ctx: Context, chosen: readonly QueueEntry[]): string[] {
  const rank = (id: string): number => rankOf(ctx, ctx.standing(id).lastCourtId) ?? Number.MAX_SAFE_INTEGER;
  const draw = (id: string): number => hashSeed(`${ctx.roundSeed}\u0000${id}`);
  const of = (stack: Stack): string[] =>
    chosen
      .filter((e) => ctx.standing(e.playerId).stack === stack)
      .map((e) => e.playerId)
      .sort((a, b) => rank(a) - rank(b) || draw(a) - draw(b));
  const neutral = chosen.filter((e) => ctx.standing(e.playerId).stack === 'neutral').map((e) => e.playerId);
  return [...of('winner'), ...of('loser'), ...neutral];
}

/** River order: by target court (top first), winners before losers before newcomers, then queue order. */
function riverOrder(ctx: Context, chosen: readonly QueueEntry[]): string[] {
  return chosen
    .map((e, i) => ({ id: e.playerId, i, place: riverPlace(ctx, e.playerId) }))
    .sort((a, b) => a.place.target - b.place.target || a.place.order - b.place.order || a.i - b.i)
    .map((x) => x.id);
}

interface Unit {
  ids: string[];
  entries: QueueEntry[];
  /** Index of the unit's least-due member in the eligible queue. */
  at: number;
  note?: string;
}

const gamesOfEntry = (e: QueueEntry): number => e.effectiveGames ?? e.gamesPlayed;

/**
 * The units for one court: of every combination of the first 16 units that adds up to `need`
 * players, the one whose busiest player has the fewest games, then the fewest games in total, then
 * the earliest queue places.
 */
function bestFit(units: readonly Unit[], need: number): number[] | null {
  const limit = Math.min(units.length, 16);
  let best: { pick: number[]; max: number; sum: number } | null = null;
  const better = (pick: number[], max: number, sum: number): boolean => {
    if (best === null) return true;
    if (max !== best.max) return max < best.max;
    if (sum !== best.sum) return sum < best.sum;
    for (let i = 0; i < Math.min(pick.length, best.pick.length); i++) {
      if (pick[i] !== best.pick[i]) return (pick[i] as number) < (best.pick[i] as number);
    }
    return pick.length < best.pick.length;
  };
  const walk = (start: number, left: number, picked: number[]): void => {
    if (left === 0) {
      const games = picked.flatMap((i) => (units[i] as Unit).entries.map(gamesOfEntry));
      const max = Math.max(...games);
      const sum = games.reduce((x, y) => x + y, 0);
      if (better(picked, max, sum)) best = { pick: picked, max, sum };
      return;
    }
    for (let i = start; i < limit; i++) {
      const size = (units[i] as Unit).ids.length;
      if (size <= left) walk(i + 1, left - size, [...picked, i]);
    }
  };
  walk(0, need, []);
  return best === null ? null : (best as { pick: number[] }).pick;
}

/** True when the pick leaves out a player with fewer games than someone it includes. */
function unfair(units: readonly Unit[], pick: readonly number[] | null): boolean {
  if (pick === null) return units.reduce((n, u) => n + u.ids.length, 0) >= 4;
  const inPick = units.filter((_, i) => pick.includes(i)).flatMap((u) => u.entries.map(gamesOfEntry));
  const out = units.filter((_, i) => !pick.includes(i)).flatMap((u) => u.entries.map(gamesOfEntry));
  return out.length > 0 && Math.min(...out) < Math.max(...inPick);
}

/**
 * Fixed partners (doubles): a locked pair whose players are both waiting is one unit, queued as due
 * as its least-due member (fairness by games per pair); everyone else is a unit of one. Each court
 * takes the earliest units that add up to four players, so a pair waits only when one seat is left.
 * A locked player whose partner is away, playing or declined plays unpaired for that turn.
 */
function planFixedPartners(ctx: Context, free: readonly CourtInput[], eligible: readonly QueueEntry[]): Planned[] {
  const partnerOf = new Map<string, string>();
  for (const pair of ctx.input.settings.fixedPairs ?? []) {
    const [a, b] = pair;
    if (pair.length === 2 && typeof a === 'string' && typeof b === 'string' && a !== b) {
      partnerOf.set(a, b);
      partnerOf.set(b, a);
    }
  }
  const index = new Map(eligible.map((e, i) => [e.playerId, i] as const));
  const units: Unit[] = [];
  const placed = new Set<string>();
  for (const [i, e] of eligible.entries()) {
    if (placed.has(e.playerId)) continue;
    const partner = partnerOf.get(e.playerId);
    const partnerAt = partner === undefined ? undefined : index.get(partner);
    if (partner !== undefined && partnerAt !== undefined) {
      const mate = eligible[partnerAt] as QueueEntry;
      units.push({ ids: [e.playerId, partner], entries: [e, mate], at: Math.max(i, partnerAt) });
      placed.add(partner);
    } else {
      units.push({
        ids: [e.playerId],
        entries: [e],
        at: i,
        ...(partner !== undefined
          ? { note: `${e.displayName}'s locked partner ${ctx.names(partner)} is not waiting, so ${e.displayName} plays unpaired this turn.` }
          : {}),
      });
    }
    placed.add(e.playerId);
  }
  units.sort((a, b) => a.at - b.at);

  const planned: Planned[] = [];
  let pool = units;
  const lockedApart: Score = (t) =>
    [...partnerOf.entries()].filter(([a, b]) => a < b && ((t.teamA.includes(a) && t.teamB.includes(b)) || (t.teamB.includes(a) && t.teamA.includes(b)))).length;
  for (const [ci, court] of free.entries()) {
    let pick = bestFit(pool, ctx.need);
    // Fairness first: when keeping every pair together would leave out someone with fewer games
    // (typically the only unpaired player), the least-due pairs are split for this game.
    const splitNotes: string[] = [];
    let trial = pool;
    while (unfair(trial, pick)) {
      const pairAt = trial.map((u, i) => ({ u, i })).filter((x) => x.u.ids.length === 2).at(-1);
      if (!pairAt) break;
      const singles: Unit[] = pairAt.u.entries.map((e) => ({ ids: [e.playerId], entries: [e], at: index.get(e.playerId) as number }));
      trial = [...trial.slice(0, pairAt.i), ...trial.slice(pairAt.i + 1), ...singles].sort((x, y) => x.at - y.at);
      const next = bestFit(trial, ctx.need);
      splitNotes.push(
        `Locked pair ${pairAt.u.entries.map((e) => e.displayName).join(' & ')} is split for this game so that nobody with fewer games sits out again.`,
      );
      pick = next;
      if (!unfair(trial, next)) {
        pool = trial;
        break;
      }
    }
    if (splitNotes.length > 0 && pool !== trial) {
      // splitting did not help: keep the pairs together
      splitNotes.length = 0;
      pick = bestFit(pool, ctx.need);
    }
    if (!pick) break;
    const taken = pick.map((i) => pool[i] as Unit);
    const pairs = taken.filter((u) => u.ids.length === 2);
    const singles = taken.filter((u) => u.ids.length === 1).flatMap((u) => u.ids);
    let teams: Teams;
    if (pairs.length === 2) teams = { teamA: [...(pairs[0] as Unit).ids], teamB: [...(pairs[1] as Unit).ids] };
    else if (pairs.length === 1) teams = { teamA: [...(pairs[0] as Unit).ids], teamB: singles };
    else teams = chooseSplit(singles, [lockedApart, historyRepeats(ctx), opponentRepeats(ctx)], `${ctx.roundSeed}\u0000${ci}`);
    const chosen = taken.flatMap((u) => u.entries).sort((a, b) => a.position - b.position);
    const last = Math.max(...chosen.map((e) => index.get(e.playerId) as number));
    const chosenIds = new Set(chosen.map((e) => e.playerId));
    const bypassed = pool
      .filter((u) => !taken.includes(u))
      .flatMap((u) => u.entries)
      .filter((e) => (index.get(e.playerId) as number) < last && !chosenIds.has(e.playerId));
    const notes = [...splitNotes, ...taken.flatMap((u) => (u.note ? [u.note] : []))];
    if (bypassed.length > 0) {
      notes.push(
        `${joinNames(bypassed.map((e) => e.displayName))} ${bypassed.length === 1 ? 'stays' : 'stay'} near the front of the queue: locked pairs go on together, so this court took the earliest full game.`,
      );
    }
    planned.push({ court, teams, chosen, bypassed, notes });
    pool = pool.filter((u) => !taken.includes(u));
  }
  return planned;
}

// -------------------------------------------------------------- explanations

export function minutes(ms: number): number {
  return Math.floor(ms / 60000);
}

const STACK_WORD: Record<Stack, [string, string]> = {
  winner: ['winner', 'winners'],
  loser: ['loser', 'losers'],
  neutral: ['sat out / new', 'sat out / new'],
};

function stackWordFor(ctx: Context, id: string): string {
  const s = ctx.standing(id);
  if (s.stack === 'winner') return 'winner';
  if (s.stack === 'loser') return 'loser';
  if (s.neutralReason === 'sat_out') return 'sat out';
  if (s.neutralReason === 'no_result') return 'no result';
  return 'new';
}

function describeTeamWithStacks(ctx: Context, team: readonly string[]): string {
  const stacks = new Set(team.map((id) => ctx.standing(id).stack));
  const only = stacks.size === 1 ? [...stacks][0] : undefined;
  if (only !== undefined && only !== 'neutral') {
    return `${STACK_WORD[only][team.length === 1 ? 0 : 1]} ${team.map(ctx.names).join(' & ')}`;
  }
  return team.map((id) => `${ctx.names(id)} (${stackWordFor(ctx, id)})`).join(' & ');
}

function teamsText(ctx: Context, teams: Teams): string {
  return `${teams.teamA.map(ctx.names).join(' & ')} vs ${teams.teamB.map(ctx.names).join(' & ')}`;
}

function whoPlays(ctx: Context, style: ClassicGroupingStyle, chosen: readonly QueueEntry[]): string {
  const cycle =
    style === 'random' ? cyclePlayed(ctx.input.pastGames ?? [], ctx.input.players.filter((p) => p.status !== 'unavailable')) : null;
  const list = chosen
    .map((e) => {
      const games = e.effectiveGames ?? e.gamesPlayed;
      const credit = e.gameCredit ?? 0;
      const gamesText = credit > 0 ? `${plural(e.gamesPlayed, 'game')} + ${credit} catch-up` : plural(games, 'game');
      const wheel = cycle ? (cycle.has(e.playerId) ? ', already played this cycle' : ', not played yet this cycle') : '';
      return `${e.displayName} (#${e.position}${wheel}, ${gamesText}, waited ${minutes(e.waitedMs)} min)`;
    })
    .join('; ');
  const rule =
    style === 'random'
      ? 'the sit-out wheel (nobody plays twice before every available player has played once this cycle), then fewest games, then longest wait'
      : style === 'river'
        ? 'fewest games first, then longest wait; on a tie winners stay ahead of losers'
        : 'fewest games first, then longest wait';
  return `Who plays: ${rule}. ${list}.`;
}

function partnerSplitText(ctx: Context, teams: Teams): string {
  if (ctx.need !== 4) return '';
  const kept = lastPartnerRepeats(ctx)(teams);
  if (kept > 0) return ` ${plural(kept, 'last-game partnership')} could not be split with these players.`;
  const all = [...teams.teamA, ...teams.teamB];
  const hadPartners = all.some((id) => ctx.standing(id).lastPartners.some((p) => all.includes(p)));
  return hadPartners ? ' Partners from the last game are split up.' : '';
}

function explainPlan(ctx: Context, style: ClassicGroupingStyle, p: Planned): string {
  const label = `${p.court.label} · ${TEAM_UP_NAMES[style]}`;
  const parts: string[] = [];
  const all = [...p.teams.teamA, ...p.teams.teamB];
  if (style === 'random') {
    parts.push(`${label}: ${teamsText(ctx, p.teams)}.`);
    const repeats = lastPartnerRepeats(ctx)(p.teams);
    parts.push(
      `Teammates and opponents drawn at random for this round${
        ctx.need === 2 ? '.' : repeats === 0 ? '; nobody is with their partner from their last game.' : `; ${plural(repeats, 'last-game partnership')} could not be avoided.`
      }`,
    );
  } else if (style === 'paddle_stack') {
    parts.push(`${label}: ${describeTeamWithStacks(ctx, p.teams.teamA)} vs ${describeTeamWithStacks(ctx, p.teams.teamB)}.`);
    const count = (team: readonly string[], stack: Stack): number => team.filter((id) => ctx.standing(id).stack === stack).length;
    const stacks = new Set(all.map((id) => ctx.standing(id).stack));
    let rule = 'Winners play winners and losers play losers.';
    const winnersFace = count(p.teams.teamA, 'winner') === 1 && count(p.teams.teamB, 'winner') === 1;
    const losersFace = count(p.teams.teamA, 'loser') === 1 && count(p.teams.teamB, 'loser') === 1;
    if (stacks.size > 1 && winnersFace && losersFace) {
      rule +=
        ctx.input.courts.length === 1
          ? ' With one court the winners are split up and each partners a loser, so winners face winners and losers face losers.'
          : ' This court mixes results, so the winners are split up and each partners a loser: winners face winners, losers face losers.';
    } else if (stacks.size > 1 && (winnersFace || losersFace)) {
      rule += ` This court mixes results, so the ${winnersFace ? 'winners' : 'losers'} are split up and face each other.`;
    } else if (stacks.size > 1) {
      rule += ' This court mixes results, so the teams are stacked as evenly as possible.';
    }
    const neutral = all.filter((id) => ctx.standing(id).stack === 'neutral');
    if (neutral.length > 0) {
      const sat = neutral.filter((id) => ctx.standing(id).neutralReason === 'sat_out').map(ctx.names);
      const fresh = neutral.filter((id) => ctx.standing(id).neutralReason !== 'sat_out').map(ctx.names);
      const bits = [
        sat.length > 0 ? `${joinNames(sat)} sat out last round` : '',
        fresh.length > 0 ? `${joinNames(fresh)} ${fresh.length === 1 ? 'has' : 'have'} no result yet` : '',
      ].filter((b) => b !== '');
      rule += ` ${bits.join('; ')}, so they count as neutral and fill in after the losers.`;
    }
    parts.push(rule + partnerSplitText(ctx, p.teams));
  } else if (style === 'river') {
    parts.push(`${label}: ${teamsText(ctx, p.teams)}.`);
    const top = ctx.ladder[0]?.label ?? 'Court 1';
    const here = rankOf(ctx, p.court.courtId) ?? 0;
    const moves = all.map((id) => {
      const s = ctx.standing(id);
      const name = ctx.names(id);
      const from = rankOf(ctx, s.lastCourtId);
      if (s.stack === 'neutral' || from === null) {
        return s.neutralReason === 'sat_out' ? `${name} comes back in after sitting out` : `${name} comes in from the waiting line`;
      }
      const result = s.stack === 'winner' ? 'won' : s.stack === 'loser' ? 'lost' : 'played';
      const fromLabel = ctx.courtLabel(s.lastCourtId);
      if (here < from) return `${name} ${result} on ${fromLabel} and moves up`;
      if (here > from) return `${name} ${result} on ${fromLabel} and moves down`;
      return s.stack === 'winner' && here === 0
        ? `${name} won on the top court and stays`
        : `${name} ${result} on ${fromLabel} and stays`;
    });
    parts.push(`${top} is the top court; winners move up a court, losers move down. ${moves.join('; ')}.${partnerSplitText(ctx, p.teams)}`);
    if (ctx.ladder.length === 1) parts.push('With one court the winners stay on (when level on games with the losers), partners split, and losers rotate out first when players are waiting.');
  } else {
    parts.push(`${label}: ${teamsText(ctx, p.teams)}.`);
    const locked = [p.teams.teamA, p.teams.teamB].filter((team) => {
      const pairs = ctx.input.settings.fixedPairs ?? [];
      return team.length === 2 && pairs.some((pair) => pair.includes(team[0] as string) && pair.includes(team[1] as string));
    });
    if (locked.length > 0) parts.push(`Locked ${locked.length === 1 ? 'pair' : 'pairs'} ${locked.map((t) => t.map(ctx.names).join(' & ')).join(' and ')} ${locked.length === 1 ? 'plays' : 'play'} together.`);
    if (locked.length < 2 && ctx.need === 4) {
      const others = [p.teams.teamA, p.teams.teamB].filter((t) => !locked.includes(t));
      if (others.length > 0) parts.push(`Unpaired players are teamed to avoid repeat partners: ${others.map((t) => t.map(ctx.names).join(' & ')).join(' and ')}.`);
    }
  }
  parts.push(...p.notes);
  parts.push(whoPlays(ctx, style, p.chosen));
  return parts.join(' ');
}
