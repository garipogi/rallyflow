/** Types of the pure rotation engine (docs/DECISIONS.md D1-D7). */

import type { ScoreEntryMode } from '../scoring/quickResult';

export type GameFormat = 'singles' | 'doubles';

/** D1: what happens to a player who declines the turn they were offered. */
export type DeclinePolicy =
  | { kind: 'back_of_queue' }
  | { kind: 'keep_spot' }
  | { kind: 'drop_places'; places: number };

/**
 * D14: how the next players are chosen.
 * - wait_time: longest wait first, ties by earlier check-in (D2). The engine default.
 * - balanced_games: fewest games played first (late arrivals credited with catch-up games), then
 *   longest wait, then a draw that rotates every round. Partner and opponent variety are always on.
 */
export type FairnessMode = 'wait_time' | 'balanced_games';

export const FAIRNESS_MODES: readonly FairnessMode[] = ['wait_time', 'balanced_games'];

/**
 * D16/D17 team-up style: how the players who are due to play are grouped into teams and courts.
 * Who plays is the balanced-games rule (D14) in every grouping style, except the two bounded
 * exceptions D17 documents (challenge court holders up to the cap; round robin follows its schedule
 * with fairly rotating byes); the two original behaviours stay available under their own names.
 * - balanced: D14 balanced_games with partner variety (the recommended default).
 * - longest_wait: the original D2 waiting-time queue.
 * - random: a sit-out wheel (nobody plays twice before everyone has played once this cycle) with
 *   seeded random teammates and opponents.
 * - paddle_stack: winners play winners, losers play losers; partners are split up.
 * - river: up and down the river (king of the court): winners move up a court, losers move down.
 * - fixed_partners: locked pairs always play together; everyone else is paired by the balanced rule.
 * - mixed (D17): each doubles team is one man and one woman when the players due to play allow it.
 * - pools (D17): players are in skill pools (A/B/C); courts belong to a pool or alternate.
 * - round_robin (D17): a generated, printable schedule where everyone partners everyone as evenly
 *   as possible; byes rotate fairly.
 * - mentor (D17): one higher-rated and one lower-rated player on each team.
 * - challenge (D17): winners stay on the challenge court for up to `challenge.cap` games in a row.
 * - swiss (D17): players with similar session records play each other, avoiding rematches.
 */
export type TeamUpStyle =
  | 'balanced'
  | 'longest_wait'
  | 'random'
  | 'paddle_stack'
  | 'river'
  | 'fixed_partners'
  | 'mixed'
  | 'pools'
  | 'round_robin'
  | 'mentor'
  | 'challenge'
  | 'swiss';

export const TEAM_UP_STYLES: readonly TeamUpStyle[] = [
  'balanced',
  'longest_wait',
  'random',
  'paddle_stack',
  'river',
  'fixed_partners',
  'mixed',
  'pools',
  'round_robin',
  'mentor',
  'challenge',
  'swiss',
];

/** The four D16 grouping styles handled by teamups.ts. */
export type ClassicGroupingStyle = 'random' | 'paddle_stack' | 'river' | 'fixed_partners';

/** The six D17 styles handled by teamups-advanced.ts. */
export type AdvancedStyle = 'mixed' | 'pools' | 'round_robin' | 'mentor' | 'challenge' | 'swiss';

export const ADVANCED_STYLES: readonly AdvancedStyle[] = ['mixed', 'pools', 'round_robin', 'mentor', 'challenge', 'swiss'];

/** Every style except the two original engines; who plays is balanced games (or a documented D17 exception). */
export type GroupingStyle = ClassicGroupingStyle | AdvancedStyle;

export function isGroupingStyle(style: TeamUpStyle): style is GroupingStyle {
  return style !== 'balanced' && style !== 'longest_wait';
}

export function isAdvancedStyle(style: TeamUpStyle): style is AdvancedStyle {
  return (ADVANCED_STYLES as readonly string[]).includes(style);
}

/** D18 player profile: optional gender for mixed doubles. */
export type Gender = 'male' | 'female';
export const GENDERS: readonly Gender[] = ['male', 'female'];

/** D17/D18 skill pools: A = advanced, B = developing (or intermediate when C is used), C = developing. */
export type PoolName = 'A' | 'B' | 'C';
export const POOL_NAMES: readonly PoolName[] = ['A', 'B', 'C'];

/** D17 skill pools settings (all optional on the session; DEFAULT_POOL_SETTINGS fills the gaps). */
export interface PoolSettings {
  /**
   * manual: a player's own pool from the roster, else their skill level against the cutoffs;
   * skill: only the skill level against the cutoffs. Players with neither go in pool B.
   */
  source: 'manual' | 'skill';
  /** Skill level at or above which a player is in pool A. */
  cutoffA: number;
  /** null = two pools (A and B). A number = three pools: at or above it (below cutoffA) is B, lower is C. */
  cutoffB: number | null;
  /**
   * auto: courts split by pool size with pool A on the top courts (alternate when there are fewer
   * courts than pools); alternate: every court takes the pool whose next player is most due;
   * a list: the pool of each court in court order (courts past the end of the list alternate).
   */
  courts: 'auto' | 'alternate' | PoolName[];
  /** When a pool cannot fill its court: keep the court open with a reason (default), or borrow the most-due players of another pool. */
  whenShort: 'stay_open' | 'borrow';
}

export const DEFAULT_POOL_SETTINGS: Readonly<PoolSettings> = {
  source: 'manual',
  cutoffA: 3.5,
  cutoffB: null,
  courts: 'auto',
  whenShort: 'stay_open',
};

/** D17 challenge court settings. */
export interface ChallengeSettings {
  /** The most games in a row a winning team may stay on for (1-3). */
  cap: number;
  /** first: only the first court in play is the challenge court; all: every court. */
  courts: 'first' | 'all';
}

export const DEFAULT_CHALLENGE_SETTINGS: Readonly<ChallengeSettings> = { cap: 2, courts: 'first' };

/** D17 round robin: one scheduled game (team A plays team B). */
export interface RoundRobinGame {
  teamA: string[];
  teamB: string[];
}

export interface RoundRobinRound {
  games: RoundRobinGame[];
  /** Players who sit out this round. */
  byes: string[];
}

/** D17 round robin schedule, generated for the players present and stored with the session's settings. */
export interface RoundRobinSchedule {
  id: string;
  createdAt: string;
  format: GameFormat;
  /** Games per round = the courts in play when it was generated (fewer when players are short). */
  courtCount: number;
  /** The players it was generated for, in roster order. */
  playerIds: string[];
  rounds: RoundRobinRound[];
}

export interface RotationSettings {
  format: GameFormat;
  declinePolicy: DeclinePolicy;
  skillBalancing: boolean;
  partnerRotation: boolean;
  /** Absent means 'wait_time' (D2), so the engine defaults stay exactly as decided in D1-D7. */
  fairness?: FairnessMode;
  /** D16. Absent means the style follows `fairness` (balanced_games = 'balanced', else 'longest_wait'). */
  teamUp?: TeamUpStyle;
  /** D16 fixed_partners: locked pairs of player ids. A player is in at most one pair. */
  fixedPairs?: string[][];
  /** D17 pools: how players are put in pools and courts in pools. Absent = DEFAULT_POOL_SETTINGS. */
  pools?: Partial<PoolSettings>;
  /** D17 challenge court: the stay-on cap and which courts. Absent = DEFAULT_CHALLENGE_SETTINGS. */
  challenge?: Partial<ChallengeSettings>;
  /** D17 round robin: the current schedule (generated on request). */
  roundRobin?: RoundRobinSchedule;
  /** How results are entered on the court cards. Absent = rally scoring (the original flow). */
  scoreEntry?: ScoreEntryMode;
}

export const DEFAULT_ROTATION_SETTINGS: RotationSettings = {
  format: 'doubles',
  declinePolicy: { kind: 'back_of_queue' },
  skillBalancing: false,
  partnerRotation: false,
};

/** What sessions created from the organizer app start with (D14): balanced games and partner rotation. */
export const NEW_SESSION_ROTATION_SETTINGS: Readonly<Partial<RotationSettings>> = {
  fairness: 'balanced_games',
  partnerRotation: true,
};

export function fairnessOf(settings: Pick<RotationSettings, 'fairness'>): FairnessMode {
  return settings.fairness === 'balanced_games' ? 'balanced_games' : 'wait_time';
}

/** D16: the team-up style in effect; sessions saved before D16 map their fairness mode to a style. */
export function teamUpOf(settings: Pick<RotationSettings, 'fairness' | 'teamUp'>): TeamUpStyle {
  if (settings.teamUp !== undefined && TEAM_UP_STYLES.includes(settings.teamUp)) return settings.teamUp;
  return fairnessOf(settings) === 'balanced_games' ? 'balanced' : 'longest_wait';
}

/**
 * D16: the settings patch that selects a team-up style. Longest wait is the D2 queue; every other
 * style decides who plays by balanced games (D14) with partner rotation on.
 */
export function settingsForTeamUp(style: TeamUpStyle): Partial<RotationSettings> {
  return style === 'longest_wait'
    ? { teamUp: style, fairness: 'wait_time' }
    : { teamUp: style, fairness: 'balanced_games', partnerRotation: true };
}

/** How orderQueue sorts the waiting players. `seed` (the session id) varies the balanced-mode draw between sessions. */
export interface QueueOrdering {
  fairness?: FairnessMode;
  seed?: string;
  /** balanced_games only (D16 random): compared before games played, lower first (the sit-out wheel). */
  firstKey?: ReadonlyMap<string, number>;
  /** balanced_games only (D16 river): compared after games and wait, before the draw, lower first. */
  tieKey?: ReadonlyMap<string, number>;
}

/** Bad engine input: duplicate ids, unparseable times, a decline by someone who is not waiting. */
export class RotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RotationError';
  }
}

export interface QueuePlayer {
  playerId: string;
  displayName: string;
  /** Session check-in: second tie-break key (D2) and the start of the wait for new arrivals (D3). */
  checkedInAt: string;
  /** When the player became eligible (D3 arrival, D5 game end, D1 decline). */
  eligibleSince: string;
  status: 'waiting' | 'playing' | 'unavailable';
  /** Games played this session: third tie-break key (D2). */
  gamesPlayed: number;
  skillLevel: number | null;
  /** True = skipped by recommendations until the turn ends. */
  declinedCurrentTurn?: boolean;
  /**
   * Set by a drop_places decline: the player sits immediately behind this player while that player
   * is still waiting. (Exact placement is not expressible with timestamps alone, because several
   * players can share one eligibility time, e.g. the four who finished the same game.)
   */
  placeAfter?: string;
  /**
   * balanced_games only: catch-up games credited to a late arrival (see catchUpCredits), added to
   * gamesPlayed when ranking so they do not play many games in a row on arrival.
   */
  gameCredit?: number;
  /** D18 mixed doubles: absent = not set (counts as flexible). */
  gender?: Gender;
  /** D18 skill pools: the pool set by the organizer (absent = derived from the skill level). */
  pool?: PoolName;
}

export interface QueueEntry {
  playerId: string;
  displayName: string;
  position: number;
  eligibleSince: string;
  checkedInAt: string;
  gamesPlayed: number;
  waitedMs: number;
  declinedCurrentTurn: boolean;
  /** balanced_games only: gamesPlayed + gameCredit, the number the queue is ranked by. */
  effectiveGames?: number;
  /** balanced_games only: catch-up games credited on a late arrival. */
  gameCredit?: number;
}

export interface CourtInput {
  courtId: string;
  label: string;
  status: 'available' | 'unavailable';
  occupied: boolean;
}

export interface PastGame {
  teamA: readonly string[];
  teamB: readonly string[];
  /** Optional facts used by the D16 team-up styles (results, court ladder, sit-out wheel). */
  winner?: 'A' | 'B' | null;
  courtId?: string;
  startedAt?: string | null;
  endedAt?: string | null;
  /** D17 Swiss: final scores when known (point difference). */
  scoreA?: number | null;
  scoreB?: number | null;
}

export interface RotationInput {
  now: string;
  players: readonly QueuePlayer[];
  courts: readonly CourtInput[];
  settings: RotationSettings;
  pastGames?: readonly PastGame[];
  /** Varies the balanced_games tie draw between sessions (the data layer passes the session id). */
  seed?: string;
  /** D17 round robin: scheduled games already started, as scheduleGameKey(scheduleId, round, game). */
  scheduleStarted?: readonly string[];
  /** D17 round robin: started scheduled games that are still being played (same keys). */
  scheduleInProgress?: readonly string[];
}

/** D17 round robin: the key of one scheduled game, used to track which games have started. */
export function scheduleGameKey(scheduleId: string, round: number, game: number): string {
  return `${scheduleId}:${round}:${game}`;
}

/** D17 round robin: which scheduled game a recommendation plays (round and game are 0-based). */
export interface ScheduleRef {
  scheduleId: string;
  round: number;
  game: number;
}

export interface PlayerReason {
  playerId: string;
  displayName: string;
  queuePosition: number;
  eligibleSince: string;
  waitedMs: number;
  /** balanced_games only. */
  gamesPlayed?: number;
  /** balanced_games only: gamesPlayed + catch-up credit. */
  effectiveGames?: number;
}

export interface Recommendation {
  courtId: string;
  courtLabel: string;
  format: GameFormat;
  playerIds: string[];
  teamA: string[];
  teamB: string[];
  reasons: PlayerReason[];
  bypassed: string[];
  repeatPartnerships: number;
  /** balanced_games doubles only: times the chosen opponents have already faced each other. */
  repeatOpponents?: number;
  explanation: string;
  /** D16: the team-up style that grouped this game (absent for games from the original engine). */
  teamUp?: TeamUpStyle;
  /** D17 round robin: the scheduled game this recommendation plays. */
  schedule?: ScheduleRef;
}

export interface OpenCourt {
  courtId: string;
  courtLabel: string;
  needed: number;
  available: number;
  reason: string;
}

export interface SkippedCourt {
  courtId: string;
  reason: 'unavailable' | 'occupied';
}

export interface ExcludedPlayer {
  playerId: string;
  reason: 'playing' | 'unavailable' | 'declined';
}

export interface RecommendationResult {
  recommendations: Recommendation[];
  openCourts: OpenCourt[];
  skippedCourts: SkippedCourt[];
  excluded: ExcludedPlayer[];
}

export function playersNeeded(format: GameFormat): number {
  return format === 'singles' ? 2 : 4;
}

/** Throws RotationError unless the policy is well formed (drop_places needs a positive whole number). */
export function assertValidDeclinePolicy(policy: DeclinePolicy): void {
  const kind = (policy as { kind?: unknown } | null)?.kind;
  if (kind === 'back_of_queue' || kind === 'keep_spot') return;
  if (kind === 'drop_places') {
    const places = (policy as { places: unknown }).places;
    if (typeof places === 'number' && Number.isInteger(places) && places > 0) return;
    throw new RotationError('drop_places needs a positive whole number of places.');
  }
  throw new RotationError(`Unknown decline policy: ${String(kind)}`);
}
