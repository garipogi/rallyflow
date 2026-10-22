/** Partner and opponent history of a session's games (D7, D14, D16). Pure. */
import type { PastGame } from './types';

/** How many times each pair of players has been partners (same team) in past games. */
export function partnershipCounts(pastGames: readonly PastGame[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const game of pastGames) {
    for (const team of [game.teamA, game.teamB]) {
      for (let i = 0; i < team.length; i++) {
        for (let j = i + 1; j < team.length; j++) {
          const key = pairKey(team[i] as string, team[j] as string);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
  }
  return counts;
}

/** How many times each pair of players has faced each other (opposite teams) in past games. */
export function opponentCounts(pastGames: readonly PastGame[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const game of pastGames) {
    for (const a of game.teamA) {
      for (const b of game.teamB) {
        const key = pairKey(a, b);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}
