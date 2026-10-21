/**
 * D14 balanced_games helpers: catch-up credit for late arrivals and the rotating tie draw. Pure.
 */
import { parseInstant } from './queue';

export interface ArrivalRecord {
  playerId: string;
  checkedInAt: string;
  /**
   * False for a player who is currently away (resting or gone home): their low game count would
   * otherwise make every later arrival's credit too small. Default true.
   */
  countsTowardMinimum?: boolean;
}

export interface EndedGameRecord {
  playerIds: readonly string[];
  endedAt: string;
}

/**
 * Catch-up credit for each checked-in player: the fewest effective games (games ended at or before
 * the moment they checked in, plus that player's own credit) among the players who had checked in
 * strictly earlier and are not currently away. Nobody like that, or nobody has finished a game yet,
 * means a credit of 0.
 *
 * With the credit a late arrival ranks level with the least-played regulars instead of jumping to
 * the front for several games in a row; from then on they rotate with everyone else.
 */
export function catchUpCredits(arrivals: readonly ArrivalRecord[], endedGames: readonly EndedGameRecord[]): Map<string, number> {
  const ends = new Map<string, number[]>();
  for (const game of endedGames) {
    const endMs = parseInstant(game.endedAt, 'endedAt');
    for (const id of game.playerIds) {
      const list = ends.get(id) ?? [];
      list.push(endMs);
      ends.set(id, list);
    }
  }
  const ordered = arrivals
    .map((a) => ({
      id: a.playerId,
      ms: parseInstant(a.checkedInAt, `checkedInAt of ${a.playerId}`),
      counts: a.countsTowardMinimum !== false,
    }))
    .sort((a, b) => a.ms - b.ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const credit = new Map<string, number>();
  for (const arrival of ordered) {
    let fewest: number | null = null;
    for (const earlier of ordered) {
      if (earlier.ms >= arrival.ms) break;
      if (!earlier.counts) continue;
      const played = (ends.get(earlier.id) ?? []).filter((ms) => ms <= arrival.ms).length;
      const effective = played + (credit.get(earlier.id) ?? 0);
      if (fewest === null || effective < fewest) fewest = effective;
    }
    credit.set(arrival.id, fewest ?? 0);
  }
  return credit;
}

/**
 * Deterministic 32-bit FNV-1a draw for players tied on games and wait. The game count is part of
 * the key, so who wins a tie changes from one round to the next instead of favouring one person.
 */
export function tieDraw(seed: string, playerId: string, effectiveGames: number): number {
  const text = `${seed}\u0000${effectiveGames}\u0000${playerId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
