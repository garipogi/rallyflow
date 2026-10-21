import type { Db } from './db';
import { ValidationError } from './errors';
import { listGames } from './games';
import { getSession, listSessions } from './sessions';
import { raw } from './sqlite';
import {
  buildLeaderboard,
  computePartnerHistory,
  computePlayerStats,
  type LeaderboardRow,
  type PartnerRecord,
  type PlayerStats,
  type StatsGame,
} from '../core/stats';

/**
 * Database-backed statistics. Everything here is read-only and recomputed from the stored game
 * records on every call, so corrections and reopened games are always reflected (brief §5 D, §6).
 */

export interface PlayerLeaderboardRow extends LeaderboardRow {
  displayName: string;
}

function requireSession(db: Db, sessionId: string): void {
  if (!getSession(db, sessionId)) throw new ValidationError(`Unknown session: ${sessionId}`);
}

function allGames(db: Db): StatsGame[] {
  return listSessions(db).flatMap((s) => listGames(db, s.id));
}

export function getSessionStats(db: Db, sessionId: string): PlayerStats[] {
  requireSession(db, sessionId);
  const roster = raw(db).prepare('SELECT player_id FROM session_players WHERE session_id = ?').all(sessionId) as {
    player_id: string;
  }[];
  return computePlayerStats(listGames(db, sessionId), { playerIds: roster.map((r) => r.player_id) });
}

export function getHistoricalStats(db: Db): PlayerStats[] {
  return computePlayerStats(allGames(db));
}

function withNames(db: Db, rows: LeaderboardRow[]): PlayerLeaderboardRow[] {
  const lookup = raw(db).prepare('SELECT display_name FROM players WHERE id = ?');
  return rows.map((row) => {
    const found = lookup.get(row.playerId) as { display_name: string } | undefined;
    return { ...row, displayName: found?.display_name ?? row.playerId };
  });
}

export function getSessionLeaderboard(db: Db, sessionId: string, opts: { minGames?: number } = {}): PlayerLeaderboardRow[] {
  return withNames(db, buildLeaderboard(getSessionStats(db, sessionId), { scope: 'session', minGames: opts.minGames }));
}

export function getHistoricalLeaderboard(db: Db, opts: { minGames?: number } = {}): PlayerLeaderboardRow[] {
  return withNames(db, buildLeaderboard(getHistoricalStats(db), { scope: 'historical', minGames: opts.minGames }));
}

export function getPartnerHistory(db: Db, opts: { sessionId?: string } = {}): PartnerRecord[] {
  if (opts.sessionId !== undefined) requireSession(db, opts.sessionId);
  return computePartnerHistory(opts.sessionId !== undefined ? listGames(db, opts.sessionId) : allGames(db));
}
