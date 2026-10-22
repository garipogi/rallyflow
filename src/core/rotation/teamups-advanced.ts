/**
 * D17 advanced team-up styles: mixed doubles, skill pools, round robin, mentor pairing, challenge
 * court and Swiss pairing. Pure: no I/O.
 *
 * Fairness first, as in D16: who plays is the balanced-games queue (D14: fewest games first, then
 * longest wait, then a rotating draw) and the style only groups those players, with these documented,
 * bounded exceptions:
 * - mixed doubles may swap a player at the cut for one of the next two waiting players on the SAME
 *   game count to make teams mixed (like the D6 window); nobody with fewer games is ever skipped;
 * - skill pools apply fewest-games-first within each pool, so game counts stay level inside a pool
 *   but pools of different sizes can drift apart;
 * - challenge court holders (the winners of the last game on a challenge court) stay on for up to
 *   `cap` games in a row even though they have played more;
 * - round robin follows its generated schedule; byes in the schedule rotate fairly (the players
 *   with the most games sit), and a missing player is replaced by the most-due waiting player.
 *
 * Declined, resting, unavailable and playing players are never chosen, unavailable and occupied
 * courts are skipped, and a court stays open with a reason when it cannot be filled.
 */
import { pairKey } from './history';
import { assertUniqueIds, orderQueue, parseInstant } from './queue';
import {
  chooseSplit,
  chronological,
  chunk,
  contextOf,
  generator,
  hashSeed,
  historyRepeats,
  joinNames,
  lastPartnerRepeats,
  minutes,
  opponentRepeats,
  plural,
  shuffled,
  TEAM_UP_NAMES,
  type Context,
  type Score,
  type Teams,
  type TimedGame,
} from './teamups';
import {
  DEFAULT_CHALLENGE_SETTINGS,
  DEFAULT_POOL_SETTINGS,
  POOL_NAMES,
  scheduleGameKey,
  type AdvancedStyle,
  type ChallengeSettings,
  type CourtInput,
  type ExcludedPlayer,
  type Gender,
  type OpenCourt,
  type PlayerReason,
  type PoolName,
  type PoolSettings,
  type QueueEntry,
  type QueuePlayer,
  type Recommendation,
  type RecommendationResult,
  type RotationInput,
  type ScheduleRef,
  type SkippedCourt,
} from './types';

interface Plan {
  court: CourtInput;
  teams: Teams;
  chosen: QueueEntry[];
  bypassed: QueueEntry[];
  /** First sentence after the court label, e.g. "Ana & Ben vs Cy & Dee." */
  head: string;
  notes: string[];
  /** Replaces the default "Who plays" sentence. */
  who?: string;
  schedule?: ScheduleRef;
}

interface Outcome {
  plans: Plan[];
  /** Courts the style keeps open with its own reason; other unplanned free courts get the generic reason. */
  open: OpenCourt[];
}

interface Kit {
  ctx: Context;
  input: RotationInput;
  need: number;
  free: CourtInput[];
  eligible: QueueEntry[];
  player: (id: string) => QueuePlayer | undefined;
}

const gamesOf = (e: QueueEntry): number => e.effectiveGames ?? e.gamesPlayed;
const byPosition = (a: QueueEntry, b: QueueEntry): number => a.position - b.position;

/** D17 recommendations for an advanced style. Same result shape and guarantees as recommend(). */
export function recommendAdvanced(input: RotationInput, style: AdvancedStyle): RecommendationResult {
  parseInstant(input.now, 'now');
  assertUniqueIds(
    input.courts.map((c) => c.courtId),
    'court',
  );
  const ctx = contextOf(input);
  const queue = orderQueue(input.players, input.now, { fairness: 'balanced_games', seed: input.seed ?? '' }); // validates the players
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
  const byId = new Map(input.players.map((p) => [p.playerId, p] as const));
  const kit: Kit = { ctx, input, need, free, eligible, player: (id) => byId.get(id) };

  const outcome =
    style === 'mixed'
      ? planMixed(kit)
      : style === 'pools'
        ? planPools(kit)
        : style === 'round_robin'
          ? planRoundRobin(kit)
          : style === 'mentor'
            ? planMentor(kit)
            : style === 'challenge'
              ? planChallenge(kit)
              : planSwiss(kit);

  const planned = new Set(outcome.plans.map((p) => p.court.courtId));
  const used = new Set(outcome.plans.flatMap((p) => p.chosen.map((e) => e.playerId)));
  const left = eligible.filter((e) => !used.has(e.playerId)).length;
  const openCourts: OpenCourt[] = free
    .filter((c) => !planned.has(c.courtId))
    .map(
      (court) =>
        outcome.open.find((o) => o.courtId === court.courtId) ?? {
          courtId: court.courtId,
          courtLabel: court.label,
          needed: need,
          available: left,
          reason: `${court.label} stays open: ${input.settings.format} needs ${need} eligible players but only ${left} ${left === 1 ? 'is' : 'are'} waiting.`,
        },
    );

  const doubles = input.settings.format === 'doubles';
  const recommendations: Recommendation[] = outcome.plans.map((p) => {
    const chosen = [...p.chosen].sort(byPosition);
    const reasons: PlayerReason[] = chosen.map((e) => ({
      playerId: e.playerId,
      displayName: e.displayName,
      queuePosition: e.position,
      eligibleSince: e.eligibleSince,
      waitedMs: e.waitedMs,
      gamesPlayed: e.gamesPlayed,
      effectiveGames: gamesOf(e),
    }));
    const explanation = [`${p.court.label} · ${TEAM_UP_NAMES[style]}: ${p.head}`, ...p.notes, p.who ?? whoPlays(chosen)].join(' ');
    return {
      courtId: p.court.courtId,
      courtLabel: p.court.label,
      format: input.settings.format,
      playerIds: chosen.map((e) => e.playerId),
      teamA: p.teams.teamA,
      teamB: p.teams.teamB,
      reasons,
      bypassed: p.bypassed.map((e) => e.playerId),
      repeatPartnerships: doubles ? historyRepeats(ctx)(p.teams) : 0,
      ...(doubles ? { repeatOpponents: opponentRepeats(ctx)(p.teams) } : {}),
      explanation,
      teamUp: style,
      ...(p.schedule ? { schedule: p.schedule } : {}),
    };
  });
  return { recommendations, openCourts, skippedCourts, excluded };
}

// ------------------------------------------------------------------ shared

function whoPlays(chosen: readonly QueueEntry[], tag?: (e: QueueEntry) => string, rule = 'fewest games first, then longest wait'): string {
  const list = chosen
    .map((e) => {
      const credit = e.gameCredit ?? 0;
      const games = credit > 0 ? `${plural(e.gamesPlayed, 'game')} + ${credit} catch-up` : plural(gamesOf(e), 'game');
      const extra = tag ? tag(e) : '';
      return `${e.displayName} (${extra}#${e.position}, ${games}, waited ${minutes(e.waitedMs)} min)`;
    })
    .join('; ');
  return `Who plays: ${rule}. ${list}.`;
}

function teamsText(ctx: Context, teams: Teams, label?: (id: string) => string): string {
  const name = label ?? ctx.names;
  return `${teams.teamA.map(name).join(' & ')} vs ${teams.teamB.map(name).join(' & ')}`;
}

const VARIETY = (ctx: Context): Score[] => [lastPartnerRepeats(ctx), historyRepeats(ctx), opponentRepeats(ctx)];

/** How many courts can be filled from the front of the queue. */
function fillable(kit: Kit): number {
  return Math.min(kit.free.length, Math.floor(kit.eligible.length / kit.need));
}

/** The plain fair plan: the front of the queue, grouped in queue order, teams by partner variety. */
function prefixPlans(kit: Kit, notes: (court: CourtInput) => string[], criteria: Score[] = VARIETY(kit.ctx), from: QueueEntry[] = kit.eligible): Plan[] {
  const k = Math.min(kit.free.length, Math.floor(from.length / kit.need));
  return chunk(from.slice(0, k * kit.need), kit.need).map((group, i) => {
    const court = kit.free[i] as CourtInput;
    const teams = chooseSplit(
      group.map((e) => e.playerId),
      criteria,
      `${kit.ctx.roundSeed}\u0000${i}`,
    );
    return { court, teams, chosen: group, bypassed: [], head: `${teamsText(kit.ctx, teams)}.`, notes: notes(court) };
  });
}

// ------------------------------------------------------------ mixed doubles

const GENDER_SHORT: Record<Gender, string> = { male: 'M', female: 'F' };

/**
 * Mixed doubles: the front of the queue plays. When those players cannot make every team one man and
 * one woman, a player at the cut may swap with one of the next two waiting players on the SAME game
 * count (never someone with fewer games). Courts take two men and two women each while they last;
 * players without a gender are flexible; leftover players of one gender team up together, and the
 * explanation says so.
 */
function planMixed(kit: Kit): Outcome {
  const { ctx, need } = kit;
  const k = fillable(kit);
  if (k === 0) return { plans: [], open: [] };
  if (need === 2) {
    return {
      plans: prefixPlans(kit, () => ['Mixed doubles pairs teams by gender; singles has no teams, so opponents simply rotate.'], [opponentRepeats(ctx)]),
      open: [],
    };
  }
  const genderOf = (id: string): Gender | undefined => kit.player(id)?.gender;
  const cut = k * need;
  let chosen = kit.eligible.slice(0, cut);
  const cutGames = gamesOf(chosen[cut - 1] as QueueEntry);
  const window = kit.eligible.slice(cut, cut + 2);
  const swaps: { inn: QueueEntry; out: QueueEntry }[] = [];
  const counts = (list: readonly QueueEntry[]) => ({
    m: list.filter((e) => genderOf(e.playerId) === 'male').length,
    f: list.filter((e) => genderOf(e.playerId) === 'female').length,
    u: list.filter((e) => genderOf(e.playerId) === undefined).length,
  });
  for (;;) {
    const { m, f, u } = counts(chosen);
    if (Math.abs(m - f) - u <= 0) break;
    const surplus: Gender = m > f ? 'male' : 'female';
    const inn = window.find((e) => !chosen.includes(e) && gamesOf(e) === cutGames && genderOf(e.playerId) !== surplus);
    const out = [...chosen].reverse().find((e) => gamesOf(e) === cutGames && genderOf(e.playerId) === surplus && !swaps.some((s) => s.inn === e));
    if (!inn || !out) break;
    chosen = [...chosen.filter((e) => e !== out), inn].sort(byPosition);
    swaps.push({ inn, out });
  }

  const next = generator(hashSeed(`${ctx.roundSeed}\u0000mixed`));
  const men = shuffled(chosen.filter((e) => genderOf(e.playerId) === 'male'), next);
  const women = shuffled(chosen.filter((e) => genderOf(e.playerId) === 'female'), next);
  const flex = shuffled(chosen.filter((e) => genderOf(e.playerId) === undefined), next);
  const groups: QueueEntry[][] = Array.from({ length: k }, () => []);
  for (const g of groups) g.push(...men.splice(0, 2), ...women.splice(0, 2));
  const rest = [...flex, ...men, ...women];
  for (const g of groups) while (g.length < need) g.push(rest.shift() as QueueEntry);

  const teamKind = (team: readonly string[]): 'mixed' | 'flex' | 'same' => {
    const gs = team.map(genderOf);
    if (gs.includes(undefined)) return 'flex';
    return gs[0] === gs[1] ? 'same' : 'mixed';
  };
  const sameGender: Score = (t) => [t.teamA, t.teamB].filter((team) => teamKind(team) === 'same').length;
  const notMixed: Score = (t) => [t.teamA, t.teamB].filter((team) => teamKind(team) !== 'mixed').length;
  const total = counts(chosen);
  const label = (id: string): string => {
    const g = genderOf(id);
    return `${ctx.names(id)} (${g ? GENDER_SHORT[g] : 'not set'})`;
  };

  const plans = groups.map((group, i): Plan => {
    const court = kit.free[i] as CourtInput;
    const teams = chooseSplit(
      group.map((e) => e.playerId),
      [sameGender, notMixed, ...VARIETY(ctx)],
      `${ctx.roundSeed}\u0000${i}`,
    );
    const notes: string[] = [];
    const kinds = [teams.teamA, teams.teamB].map(teamKind);
    if (kinds.every((x) => x === 'mixed')) notes.push('Both teams are mixed (one man, one woman).');
    const same = [teams.teamA, teams.teamB].filter((t) => teamKind(t) === 'same');
    for (const team of same) {
      const g = genderOf(team[0] as string) as Gender;
      const short = g === 'male' ? 'women' : 'men';
      notes.push(
        `Not enough ${short} among the players due to play (${total.m} ${total.m === 1 ? 'man' : 'men'}, ${total.f} ${total.f === 1 ? 'woman' : 'women'}${
          total.u > 0 ? `, ${total.u} not set` : ''
        }), so ${team.map(ctx.names).join(' & ')} play as two ${g === 'male' ? 'men' : 'women'}. Nobody with fewer games was skipped to make teams mixed.`,
      );
    }
    const unset = group.filter((e) => genderOf(e.playerId) === undefined).map((e) => e.displayName);
    if (unset.length > 0) {
      notes.push(`${joinNames(unset)} ${unset.length === 1 ? 'has' : 'have'} no gender set, so ${unset.length === 1 ? 'fills' : 'fill'} in on either side (set genders in the roster).`);
    }
    const here = swaps.filter((s) => group.includes(s.inn));
    for (const s of here) {
      notes.push(
        `To make mixed teams ${s.inn.displayName} plays ahead of ${s.out.displayName} (both on ${plural(cutGames, 'game')}); ${s.out.displayName} stays at the front of the queue.`,
      );
    }
    return {
      court,
      teams,
      chosen: group,
      bypassed: here.map((s) => s.out),
      head: `${teamsText(ctx, teams, label)}.`,
      notes,
    };
  });
  return { plans, open: [] };
}

// --------------------------------------------------------------- skill pools

export function poolSettingsOf(settings: { pools?: Partial<PoolSettings> }): PoolSettings {
  return { ...DEFAULT_POOL_SETTINGS, ...(settings.pools ?? {}) } as PoolSettings;
}

/** D17: the pool a player plays in. Players with neither a pool nor a skill level go in pool B. */
export function poolOfPlayer(player: Pick<QueuePlayer, 'pool' | 'skillLevel'>, pools: PoolSettings): PoolName {
  if (pools.source === 'manual' && player.pool !== undefined && POOL_NAMES.includes(player.pool)) {
    return pools.cutoffB === null && player.pool === 'C' ? 'B' : player.pool;
  }
  const skill = player.skillLevel;
  if (skill === null || !Number.isFinite(skill)) return 'B';
  if (skill >= pools.cutoffA) return 'A';
  if (pools.cutoffB === null) return 'B';
  return skill >= pools.cutoffB ? 'B' : 'C';
}

export function poolLabel(pool: PoolName, threePools: boolean): string {
  if (pool === 'A') return 'A (advanced)';
  if (pool === 'B') return threePools ? 'B (intermediate)' : 'B (developing)';
  return 'C (developing)';
}

/**
 * Which pool each court plays: auto splits the courts in play by pool size (largest remainder, at
 * least one court per pool, pool A on the top courts) and alternates when there are fewer courts
 * than pools; a list maps courts in court order. 'alternate' = the most-due pool takes the court.
 */
export function resolveCourtPools(
  courts: readonly CourtInput[],
  pools: PoolSettings,
  sizes: ReadonlyMap<PoolName, number>,
): Map<string, PoolName | 'alternate'> {
  const result = new Map<string, PoolName | 'alternate'>();
  if (Array.isArray(pools.courts)) {
    courts.forEach((c, i) => result.set(c.courtId, (pools.courts as PoolName[])[i] ?? 'alternate'));
    return result;
  }
  const ladder = courts.filter((c) => c.status !== 'unavailable');
  const inUse = POOL_NAMES.filter((p) => (sizes.get(p) ?? 0) > 0);
  if (pools.courts === 'alternate' || inUse.length === 0 || ladder.length < inUse.length) {
    for (const c of courts) result.set(c.courtId, 'alternate');
    return result;
  }
  const total = inUse.reduce((acc, p) => acc + (sizes.get(p) as number), 0);
  const spare = ladder.length - inUse.length;
  const shares = inUse.map((p) => {
    const exact = (spare * (sizes.get(p) as number)) / total;
    return { p, n: 1 + Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let leftover = ladder.length - shares.reduce((acc, s) => acc + s.n, 0);
  for (const s of [...shares].sort((a, b) => b.frac - a.frac || POOL_NAMES.indexOf(a.p) - POOL_NAMES.indexOf(b.p))) {
    if (leftover <= 0) break;
    s.n += 1;
    leftover -= 1;
  }
  let at = 0;
  for (const s of shares) {
    for (let i = 0; i < s.n; i++) result.set((ladder[at++] as CourtInput).courtId, s.p);
  }
  for (const c of courts) if (!result.has(c.courtId)) result.set(c.courtId, 'alternate');
  return result;
}

/**
 * Skill pools: each court belongs to a pool (or alternates). A pool court takes the front of that
 * pool's queue (fewest games first within the pool). A court whose pool is short either stays open
 * with a reason (default) or, with borrowing on, takes the pool's waiting players plus the most-due
 * players of the other pools.
 */
function planPools(kit: Kit): Outcome {
  const { ctx, need, input } = kit;
  const pools = poolSettingsOf(input.settings);
  const three = pools.cutoffB !== null;
  const poolOf = (id: string): PoolName => {
    const p = kit.player(id);
    return p ? poolOfPlayer(p, pools) : 'B';
  };
  const sizes = new Map<PoolName, number>();
  for (const p of input.players) if (p.status !== 'unavailable') sizes.set(poolOfPlayer(p, pools), (sizes.get(poolOfPlayer(p, pools)) ?? 0) + 1);
  const assignment = resolveCourtPools(input.courts, pools, sizes);
  const remaining = new Map<PoolName, QueueEntry[]>(POOL_NAMES.map((p) => [p, kit.eligible.filter((e) => poolOf(e.playerId) === p)] as const));
  const take = (pool: PoolName, n: number): QueueEntry[] => {
    const list = remaining.get(pool) as QueueEntry[];
    const out = list.slice(0, n);
    remaining.set(pool, list.slice(n));
    return out;
  };
  const tag = (e: QueueEntry): string => {
    const skill = kit.player(e.playerId)?.skillLevel;
    return `pool ${poolOf(e.playerId)}${skill !== null && skill !== undefined && Number.isFinite(skill) ? `, ${skill}` : ''}, `;
  };
  const label = (id: string): string => `${ctx.names(id)} (${poolOf(id)})`;
  const rule = 'fewest games first within the pool, then longest wait';

  const plans: Plan[] = [];
  const short: { court: CourtInput; pool: PoolName | null }[] = [];
  const build = (court: CourtInput, group: QueueEntry[], notes: string[]): void => {
    const teams = chooseSplit(
      group.map((e) => e.playerId),
      VARIETY(ctx),
      `${ctx.roundSeed}\u0000${court.courtId}`,
    );
    plans.push({ court, teams, chosen: group, bypassed: [], head: `${teamsText(ctx, teams, label)}.`, notes, who: whoPlays(group, tag, rule) });
  };
  for (const court of kit.free) {
    const target = assignment.get(court.courtId) ?? 'alternate';
    if (target !== 'alternate') {
      if ((remaining.get(target) as QueueEntry[]).length >= need) {
        build(court, take(target, need), [`${court.label} is a pool ${poolLabel(target, three)} court.`]);
      } else short.push({ court, pool: target });
      continue;
    }
    const ready = POOL_NAMES.filter((p) => (remaining.get(p) as QueueEntry[]).length >= need);
    if (ready.length === 0) {
      short.push({ court, pool: null });
      continue;
    }
    const pick = ready.reduce((best, p) => (((remaining.get(p) as QueueEntry[])[0] as QueueEntry).position < ((remaining.get(best) as QueueEntry[])[0] as QueueEntry).position ? p : best));
    build(court, take(pick, need), [
      `Courts alternate between pools: pool ${poolLabel(pick, three)} has the most-due player waiting (fewest games, then longest wait), so it takes ${court.label}.`,
    ]);
  }

  const open: OpenCourt[] = [];
  for (const { court, pool } of short) {
    const waitingIn = pool === null ? 0 : (remaining.get(pool) as QueueEntry[]).length;
    const everyone = POOL_NAMES.flatMap((p) => remaining.get(p) as QueueEntry[]).sort(byPosition);
    if (pools.whenShort === 'borrow' && everyone.length >= need) {
      const own = pool === null ? [] : take(pool, waitingIn);
      const others = POOL_NAMES.filter((p) => p !== pool)
        .flatMap((p) => remaining.get(p) as QueueEntry[])
        .sort(byPosition)
        .slice(0, need - own.length);
      for (const e of others) remaining.set(poolOf(e.playerId), (remaining.get(poolOf(e.playerId)) as QueueEntry[]).filter((x) => x !== e));
      const group = [...own, ...others].sort(byPosition);
      const note =
        pool === null
          ? `No single pool has ${need} players waiting, so the most-due players of every pool share ${court.label} (borrowing is on).`
          : `Pool ${poolLabel(pool, three)} has only ${waitingIn} ${waitingIn === 1 ? 'player' : 'players'} waiting, so ${joinNames(others.map((e) => `${e.displayName} (pool ${poolOf(e.playerId)})`))} ${others.length === 1 ? 'fills' : 'fill'} in from another pool (borrowing is on).`;
      build(court, group, [note]);
      continue;
    }
    const reason =
      pool === null
        ? `${court.label} stays open: no pool has ${need} players waiting (${POOL_NAMES.filter((p) => (sizes.get(p) ?? 0) > 0)
            .map((p) => `pool ${p}: ${(remaining.get(p) as QueueEntry[]).length}`)
            .join(', ')}), and pools are not mixed (turn on borrowing in Game settings to mix them).`
        : `${court.label} stays open: it is a pool ${poolLabel(pool, three)} court and pool ${pool} has only ${waitingIn} ${waitingIn === 1 ? 'player' : 'players'} waiting (${need} needed); players from other pools are not borrowed (turn on borrowing in Game settings).`;
    open.push({ courtId: court.courtId, courtLabel: court.label, needed: need, available: waitingIn, reason });
  }
  return { plans, open };
}

// ------------------------------------------------------------- round robin

/**
 * Round robin: free courts take the current round's games that have not started yet, in schedule
 * order. A scheduled player who is away, playing elsewhere or declined is replaced by the most-due
 * waiting player who is not in this round's games. A round finishes when all its games have started
 * (unplayable games are skipped once nothing of the round is still being played). Without a schedule,
 * or after the last round, games follow the Balanced rule until a schedule is generated.
 */
function planRoundRobin(kit: Kit): Outcome {
  const { ctx, need, input } = kit;
  const schedule = input.settings.roundRobin;
  if (!schedule || schedule.rounds.length === 0) {
    return {
      plans: prefixPlans(kit, () => ['No round-robin schedule yet: press Generate schedule in Game settings. Until then games follow the Balanced rule.']),
      open: [],
    };
  }
  if (schedule.format !== input.settings.format) {
    return {
      plans: prefixPlans(kit, () => [`The schedule was made for ${schedule.format} and the session now plays ${input.settings.format}: generate a new schedule. Until then games follow the Balanced rule.`]),
      open: [],
    };
  }
  const started = new Set(input.scheduleStarted ?? []);
  const running = new Set(input.scheduleInProgress ?? []);
  const isStarted = (r: number, g: number): boolean => started.has(scheduleGameKey(schedule.id, r, g));
  const eligibleIds = new Set(kit.eligible.map((e) => e.playerId));
  const entryOf = new Map(kit.eligible.map((e) => [e.playerId, e] as const));
  const statusText = (id: string): string => {
    const p = kit.player(id);
    if (!p) return 'not checked in';
    if (p.status === 'playing') return 'playing on another court';
    if (p.status === 'unavailable') return 'resting or away';
    if (p.declinedCurrentTurn === true) return 'declined this turn';
    return 'waiting';
  };
  const skipped: number[] = [];
  const total = schedule.rounds.length;

  for (let r = 0; r < total; r++) {
    const round = schedule.rounds[r] as (typeof schedule.rounds)[number];
    const pending = round.games.map((_, g) => g).filter((g) => !isStarted(r, g));
    const inProgress = round.games.some((_, g) => running.has(scheduleGameKey(schedule.id, r, g)));
    if (pending.length === 0 && !inProgress) continue;
    const inRound = new Set(round.games.flatMap((g) => [...g.teamA, ...g.teamB]));
    const subsPool = kit.eligible.filter((e) => !inRound.has(e.playerId));
    const usedSubs = new Set<string>();
    const playable: { g: number; teams: Teams; subs: { sub: QueueEntry; for: string }[] }[] = [];
    const blocked: { g: number; missing: string[] }[] = [];
    for (const g of pending) {
      const game = round.games[g] as (typeof round.games)[number];
      const missing = [...game.teamA, ...game.teamB].filter((id) => !eligibleIds.has(id));
      const free = subsPool.filter((e) => !usedSubs.has(e.playerId));
      if (missing.length > free.length) {
        blocked.push({ g, missing });
        continue;
      }
      const subs = missing.map((id, i) => ({ sub: free[i] as QueueEntry, for: id }));
      for (const s of subs) usedSubs.add(s.sub.playerId);
      const swap = (id: string): string => subs.find((s) => s.for === id)?.sub.playerId ?? id;
      playable.push({ g, teams: { teamA: game.teamA.map(swap), teamB: game.teamB.map(swap) }, subs });
    }
    if (playable.length === 0 && !inProgress) {
      skipped.push(r);
      continue;
    }
    const roundText = `Round ${r + 1} of ${total}`;
    const byes = round.byes.map(ctx.names);
    const skippedText =
      skipped.length > 0
        ? ` ${skipped.length === 1 ? 'Round' : 'Rounds'} ${skipped.map((x) => x + 1).join(', ')} could not be played (not enough of the scheduled players here) and ${skipped.length === 1 ? 'was' : 'were'} skipped.`
        : '';
    const plans: Plan[] = playable.slice(0, kit.free.length).map((p, i): Plan => {
      const court = kit.free[i] as CourtInput;
      const ids = [...p.teams.teamA, ...p.teams.teamB];
      const notes = [`${roundText}, game ${p.g + 1} of ${round.games.length}: everyone partners everyone as evenly as the courts allow.`];
      for (const s of p.subs) {
        notes.push(`${s.sub.displayName} fills in for ${ctx.names(s.for)} (${statusText(s.for)}): the most-due waiting player who is not in this round.`);
      }
      return {
        court,
        teams: p.teams,
        chosen: ids.map((id) => entryOf.get(id) as QueueEntry),
        bypassed: [],
        head: `${teamsText(ctx, p.teams)}.`,
        notes,
        who: `Who plays: the schedule (byes rotate fairly: whoever has played most sits).${byes.length > 0 ? ` Byes this round: ${joinNames(byes)}.` : ' Nobody sits out this round.'}${skippedText}`,
        schedule: { scheduleId: schedule.id, round: r, game: p.g },
      };
    });
    const open: OpenCourt[] = kit.free.slice(plans.length).map((court) => {
      const block = blocked[0];
      const reason = block
        ? `${court.label} stays open: ${roundText}'s game ${block.g + 1} needs ${joinNames(block.missing.map((id) => `${ctx.names(id)} (${statusText(id)})`))} and nobody outside this round is free to fill in. It starts when they are back, or the round moves on once its other games finish.`
        : `${court.label} stays open: ${roundText} has no more games to start${inProgress ? ' and its other games are still being played' : ''}; round robin keeps rounds together, so round ${Math.min(r + 2, total)} starts when this round is finished.${
            round.games.length < kit.free.length ? ' (The schedule has fewer games per round than courts free: generate a new one to use every court.)' : ''
          }`;
      return { courtId: court.courtId, courtLabel: court.label, needed: need, available: 0, reason };
    });
    return { plans, open };
  }
  return {
    plans: prefixPlans(kit, () => [`The round-robin schedule is complete (${plural(total, 'round')}). Generate a new schedule for another cycle; until then games follow the Balanced rule.`]),
    open: [],
  };
}

// ------------------------------------------------------------ mentor pairing

/**
 * Mentor pairing: the front of the queue plays. Players are ranked by skill level (unrated players
 * count as the middle: the median of the rated players present); the top half mentor the bottom
 * half, strongest with weakest, preferring a mentor/learner pair that has not partnered before.
 * Teams with similar combined levels face each other. Singles: higher-rated vs lower-rated.
 */
function planMentor(kit: Kit): Outcome {
  const { ctx, need, input } = kit;
  const k = fillable(kit);
  if (k === 0) return { plans: [], open: [] };
  const rated = input.players
    .filter((p) => p.status !== 'unavailable' && p.skillLevel !== null && Number.isFinite(p.skillLevel))
    .map((p) => p.skillLevel as number)
    .sort((a, b) => a - b);
  const middle = rated.length === 0 ? 0 : rated.length % 2 === 1 ? (rated[(rated.length - 1) / 2] as number) : ((rated[rated.length / 2 - 1] as number) + (rated[rated.length / 2] as number)) / 2;
  const isRated = (id: string): boolean => {
    const s = kit.player(id)?.skillLevel;
    return s !== null && s !== undefined && Number.isFinite(s);
  };
  const skill = (id: string): number => (isRated(id) ? (kit.player(id)?.skillLevel as number) : middle);
  const skillText = (id: string): string => (isRated(id) ? String(kit.player(id)?.skillLevel) : `unrated, counted as ${Math.round(middle * 100) / 100}`);
  const chosen = kit.eligible.slice(0, k * need);
  const sorted = [...chosen].sort((a, b) => skill(b.playerId) - skill(a.playerId) || a.position - b.position);
  const allSame = new Set(sorted.map((e) => skill(e.playerId))).size === 1;
  const rule = 'fewest games first, then longest wait (skill only decides the pairing)';

  if (need === 2) {
    const plans = Array.from({ length: k }, (_, i): Plan => {
      const hi = sorted[i] as QueueEntry;
      const lo = sorted[2 * k - 1 - i] as QueueEntry;
      const teams = { teamA: [hi.playerId], teamB: [lo.playerId] };
      return {
        court: kit.free[i] as CourtInput,
        teams,
        chosen: [hi, lo],
        bypassed: [],
        head: `${hi.displayName} (${skillText(hi.playerId)}) vs ${lo.displayName} (${skillText(lo.playerId)}).`,
        notes: [allSame ? 'Everyone here has the same level (set skill levels in the roster), so opponents simply rotate.' : 'Singles mentor match: a higher-rated player plays a lower-rated player.'],
        who: whoPlays([hi, lo], undefined, rule),
      };
    });
    return { plans, open: [] };
  }

  const mentors = sorted.slice(0, 2 * k);
  let learners = sorted.slice(2 * k);
  const pairs: { mentor: QueueEntry; learner: QueueEntry }[] = [];
  for (const mentor of mentors) {
    // strongest mentor with the weakest learner (learners are strongest first, so the weakest is
    // last), preferring someone they have not partnered recently
    const ranked = learners
      .map((l, j) => ({
        l,
        last: ctx.standing(mentor.playerId).lastPartners.includes(l.playerId) ? 1 : 0,
        times: ctx.partners.get(pairKey(mentor.playerId, l.playerId)) ?? 0,
        dist: learners.length - 1 - j,
      }))
      .sort((a, b) => a.last - b.last || a.times - b.times || a.dist - b.dist || a.l.position - b.l.position);
    const learner = (ranked[0] as { l: QueueEntry }).l;
    learners = learners.filter((l) => l !== learner);
    pairs.push({ mentor, learner });
  }
  const teamsSorted = pairs
    .map((p) => ({ ...p, sum: skill(p.mentor.playerId) + skill(p.learner.playerId) }))
    .sort((a, b) => b.sum - a.sum || skill(b.mentor.playerId) - skill(a.mentor.playerId) || a.mentor.position - b.mentor.position);
  const plans = chunk(teamsSorted, 2).map((game, i): Plan => {
    const [x, y] = game as [(typeof teamsSorted)[number], (typeof teamsSorted)[number]];
    const teams = { teamA: [x.mentor.playerId, x.learner.playerId], teamB: [y.mentor.playerId, y.learner.playerId] };
    const describe = (t: typeof x, first: boolean): string =>
      allSame || skill(t.mentor.playerId) === skill(t.learner.playerId)
        ? `${t.mentor.displayName} (${skillText(t.mentor.playerId)}) & ${t.learner.displayName} (${skillText(t.learner.playerId)})`
        : `${first ? 'Mentor' : 'mentor'} ${t.mentor.displayName} (${skillText(t.mentor.playerId)}) with ${t.learner.displayName} (${skillText(t.learner.playerId)})`;
    const notes = allSame
      ? ['Everyone here has the same level (set skill levels in the roster to pair mentors with newer players), so partners rotate instead.']
      : ['Each team pairs a higher-rated player with a lower-rated one, and teams with similar combined levels face each other.'];
    const unrated = [...teams.teamA, ...teams.teamB].filter((id) => !isRated(id)).map(ctx.names);
    if (unrated.length > 0 && !allSame) notes.push(`${joinNames(unrated)} ${unrated.length === 1 ? 'is' : 'are'} unrated and counted as the middle level.`);
    return {
      court: kit.free[i] as CourtInput,
      teams,
      chosen: [x.mentor, x.learner, y.mentor, y.learner],
      bypassed: [],
      head: `${describe(x, true)} vs ${describe(y, false)}.`,
      notes,
      who: whoPlays([x.mentor, x.learner, y.mentor, y.learner].sort(byPosition), undefined, rule),
    };
  });
  return { plans, open: [] };
}

// ------------------------------------------------------------ challenge court

export function challengeSettingsOf(settings: { challenge?: Partial<ChallengeSettings> }): ChallengeSettings {
  const merged = { ...DEFAULT_CHALLENGE_SETTINGS, ...(settings.challenge ?? {}) };
  const cap = Number.isInteger(merged.cap) ? Math.min(3, Math.max(1, merged.cap)) : DEFAULT_CHALLENGE_SETTINGS.cap;
  return { cap, courts: merged.courts === 'all' ? 'all' : 'first' };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

interface Holder {
  team: string[];
  /** Wins in a row on this court by exactly this team. */
  streak: number;
}

/** The team that won the last game on this court and has not played anywhere since. */
function holderOf(courtId: string, timed: readonly TimedGame[]): Holder | null {
  const here = timed.filter((t) => t.game.courtId === courtId);
  const last = here.at(-1);
  if (!last || last.endedMs === null || (last.game.winner !== 'A' && last.game.winner !== 'B')) return null;
  const team = [...(last.game.winner === 'A' ? last.game.teamA : last.game.teamB)];
  let streak = 0;
  for (let i = here.length - 1; i >= 0; i--) {
    const t = here[i] as TimedGame;
    const w = t.game.winner;
    if (t.endedMs === null || (w !== 'A' && w !== 'B') || !sameSet(w === 'A' ? t.game.teamA : t.game.teamB, team)) break;
    streak += 1;
  }
  const endedMs = last.endedMs;
  const movedOn = timed.some((t) => t !== last && t.startedMs !== null && t.startedMs >= endedMs && t.players.some((id) => team.includes(id)));
  return movedOn ? null : { team, streak };
}

/**
 * Challenge court: the winners of the last game on a challenge court stay on as holders while they
 * have stayed fewer than `cap` games in a row (wins in a row - 1 < cap); then they sit out this turn.
 * Challengers, and everyone on the other courts, come from the front of the fair queue. Capped
 * winners play this turn only if a court would otherwise stay open. A holding team breaks up when
 * one of them is resting, playing or declined.
 */
function planChallenge(kit: Kit): Outcome {
  const { ctx, need, input } = kit;
  const settings = challengeSettingsOf(input.settings);
  const firstInPlay = input.courts.find((c) => c.status !== 'unavailable');
  const isChallenge = (c: CourtInput): boolean => (settings.courts === 'all' ? true : c.courtId === firstInPlay?.courtId);
  const timed = chronological(input.pastGames ?? []);
  const eligibleIds = new Set(kit.eligible.map((e) => e.playerId));
  const entryOf = new Map(kit.eligible.map((e) => [e.playerId, e] as const));
  const holders = new Map<string, Holder>();
  const sitters: { team: string[]; streak: number; court: CourtInput }[] = [];
  const notes = new Map<string, string[]>();
  const addNote = (courtId: string, text: string): void => {
    notes.set(courtId, [...(notes.get(courtId) ?? []), text]);
  };
  const why = (id: string): string => {
    const p = kit.player(id);
    if (!p || p.status === 'unavailable') return 'resting';
    if (p.status === 'playing') return 'playing elsewhere';
    return 'declined this turn';
  };
  for (const court of kit.free.filter(isChallenge)) {
    const h = holderOf(court.courtId, timed);
    if (!h) continue;
    const names = h.team.map(ctx.names).join(' & ');
    const away = h.team.filter((id) => !eligibleIds.has(id));
    if (away.length > 0) {
      addNote(court.courtId, `${names} won the last game here, but ${joinNames(away.map((id) => `${ctx.names(id)} is ${why(id)}`))}, so the team does not stay on.`);
      continue;
    }
    if (h.streak - 1 < settings.cap) holders.set(court.courtId, h);
    else {
      sitters.push({ team: h.team, streak: h.streak, court });
      addNote(
        court.courtId,
        `${names} won ${plural(h.streak, 'game')} in a row here and have stayed on the maximum ${plural(settings.cap, 'game')}, so they sit out this turn and new challengers take the court.`,
      );
    }
  }
  const reserved = new Set([...holders.values()].flatMap((h) => h.team));
  const sitting = new Set(sitters.flatMap((s) => s.team));
  let pool = kit.eligible.filter((e) => !reserved.has(e.playerId) && !sitting.has(e.playerId));
  let held = kit.eligible.filter((e) => sitting.has(e.playerId));
  const plans: Plan[] = [];
  const challengeLabel = firstInPlay?.label ?? 'Court 1';

  for (const court of kit.free) {
    let h = holders.get(court.courtId) ?? null;
    let fromQueue = need - (h ? h.team.length : 0);
    if (pool.length < fromQueue && held.length > 0) {
      pool = [...pool, ...held].sort(byPosition);
      addNote(court.courtId, `So that ${court.label} is not left open, ${joinNames(held.map((e) => e.displayName))} ${held.length === 1 ? 'plays' : 'play'} this turn after all.`);
      held = [];
    }
    if (h && pool.length < fromQueue) {
      // not enough challengers: the holders go back into the queue
      pool = [...pool, ...h.team.map((id) => entryOf.get(id) as QueueEntry)].sort(byPosition);
      h = null;
      fromQueue = need;
    }
    if (pool.length < fromQueue) continue;
    const challengers = pool.slice(0, fromQueue);
    pool = pool.slice(fromQueue);
    const courtNotes = notes.get(court.courtId) ?? [];
    if (h) {
      const teams = { teamA: [...h.team], teamB: challengers.map((e) => e.playerId) };
      const names = h.team.map(ctx.names).join(' & ');
      plans.push({
        court,
        teams,
        chosen: [...h.team.map((id) => entryOf.get(id) as QueueEntry), ...challengers],
        bypassed: [],
        head: `${names} (holders) vs ${challengers.map((e) => e.displayName).join(' & ')} (challengers).`,
        notes: [
          `${names} won the last game here and stay on: stay ${h.streak} of ${settings.cap}. Holders are the one exception to fewest games first, for at most ${plural(settings.cap, 'game')} in a row.`,
          ...courtNotes,
        ],
        who: whoPlays(challengers, undefined, 'challengers come from the front of the fair queue: fewest games first, then longest wait'),
      });
      continue;
    }
    const teams = chooseSplit(
      challengers.map((e) => e.playerId),
      VARIETY(ctx),
      `${ctx.roundSeed}\u0000${court.courtId}`,
    );
    const role = isChallenge(court)
      ? `${court.label} is a challenge court: the winners of this game may stay on for up to ${plural(settings.cap, 'game')} in a row.`
      : `${challengeLabel} is the challenge court; ${court.label} rotates normally.`;
    plans.push({ court, teams, chosen: challengers, bypassed: [], head: `${teamsText(ctx, teams)}.`, notes: [role, ...courtNotes] });
  }
  return { plans, open: [] };
}

// -------------------------------------------------------------- Swiss pairing

interface SwissRecord {
  wins: number;
  losses: number;
  diff: number;
  scored: boolean;
}

/** Each player's session record from finished games with a winner (point difference when scores are known). */
export function swissRecords(pastGames: RotationInput['pastGames']): Map<string, SwissRecord> {
  const out = new Map<string, SwissRecord>();
  const rec = (id: string): SwissRecord => {
    let r = out.get(id);
    if (!r) {
      r = { wins: 0, losses: 0, diff: 0, scored: false };
      out.set(id, r);
    }
    return r;
  };
  for (const g of pastGames ?? []) {
    if (g.winner !== 'A' && g.winner !== 'B') continue;
    const scored = typeof g.scoreA === 'number' && typeof g.scoreB === 'number' && (g.scoreA > 0 || g.scoreB > 0);
    for (const [team, side] of [
      [g.teamA, 'A'],
      [g.teamB, 'B'],
    ] as const) {
      for (const id of team) {
        const r = rec(id);
        if (g.winner === side) r.wins += 1;
        else r.losses += 1;
        if (scored) {
          r.scored = true;
          const own = side === 'A' ? (g.scoreA as number) : (g.scoreB as number);
          const opp = side === 'A' ? (g.scoreB as number) : (g.scoreA as number);
          r.diff += own - opp;
        }
      }
    }
  }
  return out;
}

/**
 * Swiss pairing: the front of the queue plays; those players are sorted by session record (win %,
 * then point difference, then wins) and players next to each other in that order share a court.
 * Neighbouring courts may swap a player when that avoids a rematch of opponents. Within a court the
 * split with the fewest rematches wins, then the fewest repeat partners, then the most even teams.
 * Singles: each player meets the next player in the standings they have not played yet.
 */
function planSwiss(kit: Kit): Outcome {
  const { ctx, need, input } = kit;
  const k = fillable(kit);
  if (k === 0) return { plans: [], open: [] };
  const records = swissRecords(input.pastGames);
  const recOf = (id: string): SwissRecord => records.get(id) ?? { wins: 0, losses: 0, diff: 0, scored: false };
  const pct = (id: string): number => {
    const r = recOf(id);
    return r.wins + r.losses === 0 ? 0.5 : r.wins / (r.wins + r.losses);
  };
  const recordText = (id: string): string => {
    const r = recOf(id);
    const diff = r.scored ? `, ${r.diff >= 0 ? '+' : '−'}${Math.abs(r.diff)}` : '';
    return `${r.wins}–${r.losses}${diff}`;
  };
  const chosen = kit.eligible.slice(0, k * need);
  const sorted = [...chosen].sort(
    (a, b) => pct(b.playerId) - pct(a.playerId) || recOf(b.playerId).diff - recOf(a.playerId).diff || recOf(b.playerId).wins - recOf(a.playerId).wins || a.position - b.position,
  );
  const rankOf = new Map(sorted.map((e, i) => [e.playerId, i] as const));
  const met = (a: string, b: string): number => ctx.opponents.get(pairKey(a, b)) ?? 0;
  const label = (id: string): string => `${ctx.names(id)} (${recordText(id)})`;
  const rule = 'fewest games first, then longest wait (records only decide who plays whom)';

  let groups: QueueEntry[][];
  if (need === 2) {
    const left = [...sorted];
    groups = [];
    while (left.length > 0) {
      const p = left.shift() as QueueEntry;
      const at = left.findIndex((q) => met(p.playerId, q.playerId) === 0);
      const q = left.splice(at >= 0 ? at : 0, 1)[0] as QueueEntry;
      groups.push([p, q]);
    }
  } else {
    groups = chunk(sorted, 4);
    const rematches = (g: readonly QueueEntry[]): number =>
      Math.min(
        ...[1, 2, 3].map((y) => {
          const ids = g.map((e) => e.playerId);
          const a = [ids[0] as string, ids[y] as string];
          const b = ids.filter((_, i) => i !== 0 && i !== y);
          return a.reduce((acc, x) => acc + b.reduce((inner, z) => inner + (met(x, z) > 0 ? 1 : 0), 0), 0);
        }),
      );
    for (let b = 0; b + 1 < groups.length; b++) {
      const g1 = groups[b] as QueueEntry[];
      const g2 = groups[b + 1] as QueueEntry[];
      let best = { gain: 0, i: -1, j: -1 };
      const now = rematches(g1) + rematches(g2);
      for (const i of [3, 2]) {
        for (const j of [0, 1]) {
          const n1 = g1.map((e, x) => (x === i ? (g2[j] as QueueEntry) : e));
          const n2 = g2.map((e, x) => (x === j ? (g1[i] as QueueEntry) : e));
          const gain = now - (rematches(n1) + rematches(n2));
          if (gain > best.gain) best = { gain, i, j };
        }
      }
      if (best.i >= 0) {
        const tmp = g1[best.i] as QueueEntry;
        g1[best.i] = g2[best.j] as QueueEntry;
        g2[best.j] = tmp;
        g1.sort((x, y) => (rankOf.get(x.playerId) as number) - (rankOf.get(y.playerId) as number));
        g2.sort((x, y) => (rankOf.get(x.playerId) as number) - (rankOf.get(y.playerId) as number));
      }
    }
  }

  const rematchScore: Score = (t) => t.teamA.reduce((acc, a) => acc + t.teamB.reduce((inner, b) => inner + (met(a, b) > 0 ? 1 : 0), 0), 0);
  const evenness: Score = (t) =>
    Math.abs(t.teamA.reduce((acc, id) => acc + (rankOf.get(id) as number), 0) - t.teamB.reduce((acc, id) => acc + (rankOf.get(id) as number), 0));
  const plans = groups.map((group, i): Plan => {
    const teams =
      need === 2
        ? { teamA: [(group[0] as QueueEntry).playerId], teamB: [(group[1] as QueueEntry).playerId] }
        : chooseSplit(
            group.map((e) => e.playerId),
            [rematchScore, historyRepeats(ctx), evenness, opponentRepeats(ctx)],
            `${ctx.roundSeed}\u0000${i}`,
          );
    const recs = group.map((e) => recordText(e.playerId).split(',')[0] as string);
    const summary = new Set(recs).size === 1 ? `Swiss: all ${group.length === 2 ? 'both' : 'four'} players are ${recs[0]}.` : `Swiss: similar records play each other (${recs.join(', ')}; win %, then point difference).`;
    const repeats = rematchScore(teams);
    const notes = [summary, repeats === 0 ? 'No rematches of earlier opponents.' : `${repeats} ${repeats === 1 ? 'rematch' : 'rematches'} could not be avoided with these players.`];
    return { court: kit.free[i] as CourtInput, teams, chosen: group, bypassed: [], head: `${teamsText(ctx, teams, label)}.`, notes, who: whoPlays([...group].sort(byPosition), undefined, rule) };
  });
  return { plans, open: [] };
}
