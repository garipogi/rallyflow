import { tieDraw } from './fairness';
import {
  assertValidDeclinePolicy,
  RotationError,
  type DeclinePolicy,
  type QueueEntry,
  type QueueOrdering,
  type QueuePlayer,
} from './types';

export function parseInstant(value: string, what: string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) throw new RotationError(`${what} is not a valid time: ${String(value)}`);
  return ms;
}

export function assertUniqueIds(ids: readonly string[], what: string): void {
  if (new Set(ids).size !== ids.length) throw new RotationError(`Duplicate ${what} id in the input.`);
}

interface Keyed {
  player: QueuePlayer;
  eligibleMs: number;
  checkedInMs: number;
  effectiveGames: number;
  draw: number;
  first: number;
  tie: number;
}

const byId = (a: Keyed, b: Keyed): number =>
  a.player.playerId === b.player.playerId ? 0 : a.player.playerId < b.player.playerId ? -1 : 1;

/** D2: eligibility time, then earlier check-in, then fewer games played, then player id. */
function compareKeyed(a: Keyed, b: Keyed): number {
  if (a.eligibleMs !== b.eligibleMs) return a.eligibleMs - b.eligibleMs;
  if (a.checkedInMs !== b.checkedInMs) return a.checkedInMs - b.checkedInMs;
  if (a.player.gamesPlayed !== b.player.gamesPlayed) return a.player.gamesPlayed - b.player.gamesPlayed;
  return byId(a, b);
}

/**
 * D14 balanced_games: fewer effective games (played + catch-up credit), then longer wait, then the
 * rotating draw, then player id. Check-in time is deliberately not a key: it made the earliest
 * arrival win every tie among players who finished the same game.
 */
function compareBalanced(a: Keyed, b: Keyed): number {
  if (a.first !== b.first) return a.first - b.first;
  if (a.effectiveGames !== b.effectiveGames) return a.effectiveGames - b.effectiveGames;
  if (a.eligibleMs !== b.eligibleMs) return a.eligibleMs - b.eligibleMs;
  if (a.tie !== b.tie) return a.tie - b.tie;
  if (a.draw !== b.draw) return a.draw - b.draw;
  return byId(a, b);
}

function creditOf(player: QueuePlayer): number {
  const credit = player.gameCredit;
  return typeof credit === 'number' && Number.isFinite(credit) && credit > 0 ? credit : 0;
}

/**
 * Every waiting player in queue order (declined players keep their place). Players carrying a
 * `placeAfter` anchor are slotted in directly behind the anchor when it is still waiting; if it is
 * not, they fall back to their own eligibility time.
 */
export function orderQueue(players: readonly QueuePlayer[], now: string, ordering: QueueOrdering = {}): QueueEntry[] {
  const nowMs = parseInstant(now, 'now');
  const balanced = ordering.fairness === 'balanced_games';
  const seed = ordering.seed ?? '';
  const compare = balanced ? compareBalanced : compareKeyed;
  assertUniqueIds(
    players.map((p) => p.playerId),
    'player',
  );
  const waiting: Keyed[] = players
    .filter((p) => p.status === 'waiting')
    .map((player) => {
      const effectiveGames = player.gamesPlayed + creditOf(player);
      return {
        player,
        eligibleMs: parseInstant(player.eligibleSince, `eligibleSince of ${player.playerId}`),
        checkedInMs: parseInstant(player.checkedInAt, `checkedInAt of ${player.playerId}`),
        effectiveGames,
        draw: balanced ? tieDraw(seed, player.playerId, effectiveGames) : 0,
        first: balanced ? (ordering.firstKey?.get(player.playerId) ?? 0) : 0,
        tie: balanced ? (ordering.tieKey?.get(player.playerId) ?? 0) : 0,
      };
    });
  const waitingIds = new Set(waiting.map((k) => k.player.playerId));
  const isAnchored = (k: Keyed): boolean =>
    k.player.placeAfter !== undefined &&
    k.player.placeAfter !== k.player.playerId &&
    waitingIds.has(k.player.placeAfter);

  const ordered = waiting.filter((k) => !isAnchored(k)).sort(compare);
  let pending = waiting.filter(isAnchored).sort(compare);
  while (pending.length > 0) {
    const stillPending: Keyed[] = [];
    for (const k of pending) {
      const anchorAt = ordered.findIndex((o) => o.player.playerId === k.player.placeAfter);
      if (anchorAt < 0) {
        stillPending.push(k);
        continue;
      }
      // keep earlier-declined players that share this anchor ahead of later ones
      let at = anchorAt + 1;
      while (at < ordered.length && (ordered[at] as Keyed).player.placeAfter === k.player.placeAfter) at++;
      ordered.splice(at, 0, k);
    }
    if (stillPending.length === pending.length) {
      // anchors form a cycle: fall back to plain D2 order for the rest
      ordered.push(...stillPending);
      break;
    }
    pending = stillPending;
  }

  return ordered.map((k, i) => ({
    playerId: k.player.playerId,
    displayName: k.player.displayName,
    position: i + 1,
    eligibleSince: k.player.eligibleSince,
    checkedInAt: k.player.checkedInAt,
    gamesPlayed: k.player.gamesPlayed,
    waitedMs: nowMs - k.eligibleMs,
    declinedCurrentTurn: k.player.declinedCurrentTurn === true,
    ...(balanced ? { effectiveGames: k.effectiveGames, gameCredit: creditOf(k.player) } : {}),
  }));
}

/**
 * D1. Returns a new array; the decliner is flagged for this turn and moved as the policy says:
 * back_of_queue resets eligibility to `at`; keep_spot keeps the place; drop_places moves exactly
 * N places further back (or to the end).
 */
export function applyDecline(
  players: readonly QueuePlayer[],
  playerId: string,
  at: string,
  policy: DeclinePolicy,
  ordering: QueueOrdering = {},
): QueuePlayer[] {
  parseInstant(at, 'at');
  assertValidDeclinePolicy(policy);
  const target = players.find((p) => p.playerId === playerId);
  if (!target) throw new RotationError(`Unknown player: ${playerId}`);
  if (target.status !== 'waiting') throw new RotationError(`${target.displayName} is not waiting, so cannot decline.`);

  let moved: QueuePlayer = { ...target, declinedCurrentTurn: true };
  if (policy.kind === 'back_of_queue') {
    const { placeAfter: _dropped, ...rest } = moved;
    moved = { ...rest, eligibleSince: at };
  } else if (policy.kind === 'drop_places') {
    const queue = orderQueue(players, at, ordering);
    const index = queue.findIndex((e) => e.playerId === playerId);
    const others = queue.filter((e) => e.playerId !== playerId);
    const newIndex = Math.min(index + policy.places, others.length);
    const anchor = others[newIndex - 1];
    if (anchor) moved = { ...moved, eligibleSince: anchor.eligibleSince, placeAfter: anchor.playerId };
  }
  return players.map((p) => (p.playerId === playerId ? moved : { ...p }));
}

/** A turn ends when a game is assigned: declined players become eligible again, places kept. */
export function startNewTurn(players: readonly QueuePlayer[]): QueuePlayer[] {
  return players.map((p) => {
    const { declinedCurrentTurn: _cleared, ...rest } = p;
    return rest;
  });
}
