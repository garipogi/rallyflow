/** Types of the pure rotation engine (docs/DECISIONS.md D1-D7). */

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

export interface RotationSettings {
  format: GameFormat;
  declinePolicy: DeclinePolicy;
  skillBalancing: boolean;
  partnerRotation: boolean;
  /** Absent means 'wait_time' (D2), so the engine defaults stay exactly as decided in D1-D7. */
  fairness?: FairnessMode;
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

/** How orderQueue sorts the waiting players. `seed` (the session id) varies the balanced-mode draw between sessions. */
export interface QueueOrdering {
  fairness?: FairnessMode;
  seed?: string;
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
}

export interface RotationInput {
  now: string;
  players: readonly QueuePlayer[];
  courts: readonly CourtInput[];
  settings: RotationSettings;
  pastGames?: readonly PastGame[];
  /** Varies the balanced_games tie draw between sessions (the data layer passes the session id). */
  seed?: string;
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
