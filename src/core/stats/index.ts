/**
 * Pure statistics (brief §6 "Statistics and rankings"; docs/DECISIONS.md D9).
 * Statistics are derived only from finalized games: status 'completed' with a recorded winner.
 * No I/O, no database, no mutation of inputs.
 */

export type StatsGameStatus = 'scheduled' | 'in_progress' | 'completed' | 'incomplete' | 'cancelled';

export interface StatsGame {
  id: string;
  sessionId: string;
  format: 'singles' | 'doubles';
  status: StatsGameStatus;
  teamAScore: number;
  teamBScore: number;
  winner: 'A' | 'B' | null;
  participants: readonly { playerId: string; team: 'A' | 'B' }[];
}

export interface PlayerStats {
  playerId: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  winPct: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDiff: number;
}

export interface PartnerRecord {
  playerId: string;
  partnerId: string;
  games: number;
  wins: number;
  losses: number;
}

export type LeaderboardScope = 'session' | 'historical';

/** D9: ranked only with at least this many completed games. */
export const DEFAULT_MIN_GAMES: { readonly session: 3; readonly historical: 10 } = { session: 3, historical: 10 };

export interface LeaderboardRow extends PlayerStats {
  ranked: boolean;
  rank: number | null;
  tied: boolean;
}

export class StatsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatsError';
  }
}

function isFinalized(game: StatsGame): game is StatsGame & { winner: 'A' | 'B' } {
  return game.status === 'completed' && game.winner !== null;
}

function assertUniqueIds(games: readonly StatsGame[]): void {
  const seen = new Set<string>();
  for (const game of games) {
    if (seen.has(game.id)) throw new StatsError(`Game ${game.id} appears more than once; a game is never counted twice.`);
    seen.add(game.id);
  }
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function emptyStats(playerId: string): PlayerStats {
  return { playerId, gamesPlayed: 0, wins: 0, losses: 0, winPct: 0, pointsFor: 0, pointsAgainst: 0, pointDiff: 0 };
}

export function computePlayerStats(games: readonly StatsGame[], opts: { playerIds?: readonly string[] } = {}): PlayerStats[] {
  assertUniqueIds(games);
  const rows = new Map<string, PlayerStats>();
  for (const id of opts.playerIds ?? []) rows.set(id, emptyStats(id));
  for (const game of games) {
    if (!isFinalized(game)) continue;
    for (const p of game.participants) {
      const row = rows.get(p.playerId) ?? emptyStats(p.playerId);
      rows.set(p.playerId, row);
      row.gamesPlayed++;
      if (game.winner === p.team) row.wins++;
      else row.losses++;
      row.pointsFor += p.team === 'A' ? game.teamAScore : game.teamBScore;
      row.pointsAgainst += p.team === 'A' ? game.teamBScore : game.teamAScore;
    }
  }
  for (const row of rows.values()) {
    row.winPct = row.gamesPlayed === 0 ? 0 : row.wins / row.gamesPlayed;
    row.pointDiff = row.pointsFor - row.pointsAgainst;
  }
  return [...rows.values()].sort((a, b) => byString(a.playerId, b.playerId));
}

export function computePartnerHistory(games: readonly StatsGame[]): PartnerRecord[] {
  assertUniqueIds(games);
  const records = new Map<string, PartnerRecord>();
  for (const game of games) {
    if (!isFinalized(game) || game.format !== 'doubles') continue;
    for (const team of ['A', 'B'] as const) {
      const members = game.participants.filter((p) => p.team === team);
      for (const p of members) {
        for (const q of members) {
          if (p.playerId === q.playerId) continue;
          const key = `${p.playerId}\u0000${q.playerId}`;
          const record = records.get(key) ?? { playerId: p.playerId, partnerId: q.playerId, games: 0, wins: 0, losses: 0 };
          records.set(key, record);
          record.games++;
          if (game.winner === team) record.wins++;
          else record.losses++;
        }
      }
    }
  }
  return [...records.values()].sort((a, b) => byString(a.playerId, b.playerId) || byString(a.partnerId, b.partnerId));
}

/** D9 order: win % desc, then wins desc, then point differential desc. */
function compareStanding(a: PlayerStats, b: PlayerStats): number {
  return b.winPct - a.winPct || b.wins - a.wins || b.pointDiff - a.pointDiff;
}

export function buildLeaderboard(
  stats: readonly PlayerStats[],
  opts: { scope: LeaderboardScope; minGames?: number },
): LeaderboardRow[] {
  const threshold = opts.minGames ?? DEFAULT_MIN_GAMES[opts.scope];
  if (!Number.isInteger(threshold) || threshold < 0) {
    throw new StatsError('The minimum number of games must be a non-negative whole number.');
  }
  const ranked = stats
    .filter((s) => s.gamesPlayed >= threshold)
    .sort((a, b) => compareStanding(a, b) || byString(a.playerId, b.playerId));
  const unranked = stats
    .filter((s) => s.gamesPlayed < threshold)
    .sort((a, b) => b.gamesPlayed - a.gamesPlayed || byString(a.playerId, b.playerId));

  const rows: LeaderboardRow[] = [];
  let start = 0;
  while (start < ranked.length) {
    let end = start + 1;
    while (end < ranked.length && compareStanding(ranked[start] as PlayerStats, ranked[end] as PlayerStats) === 0) end++;
    // Standard competition ranking (1, 1, 3): the rank is one more than the rows strictly ahead.
    for (let i = start; i < end; i++) {
      rows.push({ ...(ranked[i] as PlayerStats), ranked: true, rank: start + 1, tied: end - start > 1 });
    }
    start = end;
  }
  for (const s of unranked) rows.push({ ...s, ranked: false, rank: null, tied: false });
  return rows;
}
