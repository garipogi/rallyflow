/*
 * ============================================================================
 * PHASE 4 PUBLIC API — statistics over the database (pinned by the locked tests).
 * Builds on the locked phase 1–3 APIs (sessions, roster, games, scoring) and does not change them.
 * Pure types and leaderboard rules come from src/core/stats (see ac15.stats-core.test.ts).
 *
 * src/data/stats.ts  (read-only: never writes to the database)
 *   interface PlayerLeaderboardRow extends LeaderboardRow { displayName: string }
 *   getSessionStats(db: Db, sessionId: string): PlayerStats[]
 *       Finalized games (status 'completed') of that session only. One row per player on the
 *       session roster (zero row if they have no finalized game) plus every player who took part
 *       in a finalized game of the session. Sorted by playerId. ValidationError for an unknown session.
 *   getHistoricalStats(db: Db): PlayerStats[]
 *       Finalized games across every retained session. Includes every player who took part in at
 *       least one, even if later deactivated or removed from a roster. Sorted by playerId.
 *   getSessionLeaderboard(db: Db, sessionId: string, opts?: { minGames?: number }): PlayerLeaderboardRow[]
 *       buildLeaderboard(getSessionStats(..), { scope: 'session', minGames }) + display names
 *   getHistoricalLeaderboard(db: Db, opts?: { minGames?: number }): PlayerLeaderboardRow[]
 *       buildLeaderboard(getHistoricalStats(..), { scope: 'historical', minGames }) + display names
 *   getPartnerHistory(db: Db, opts?: { sessionId?: string }): PartnerRecord[]
 *       computePartnerHistory over the finalized games of one session, or of all sessions
 *
 *   Statistics are always consistent with the current game records: reopening a completed game
 *   removes it from the statistics until it is finalized again, and a correction is reflected
 *   after re-finalizing, with no duplicated games (brief §5 D, §6).
 * ============================================================================
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { openDatabase, type Db } from '../../src/data/db';
import { createSession, deleteSession, finishSession } from '../../src/data/sessions';
import { addNewPlayerToSession, addPlayerToSession, checkInPlayer, removePlayerFromSession } from '../../src/data/roster';
import { listCourts } from '../../src/data/courts';
import { createGame, getGame, listGames, markGameIncomplete } from '../../src/data/games';
import { deactivatePlayer } from '../../src/data/players';
import { ValidationError } from '../../src/data/errors';
import {
  correctScoringEvent,
  finalizeGame,
  loadScoreLog,
  recordScoringEvent,
  reopenGame,
  startScoring,
  undoLastScoringEvent,
} from '../../src/data/scoring';
import { correct, stateOf, type GameState, type ScoringEvent, type TeamId } from '../../src/core/scoring';
import type { Game } from '../../src/data/types';
import {
  getHistoricalLeaderboard,
  getHistoricalStats,
  getPartnerHistory,
  getSessionLeaderboard,
  getSessionStats,
} from '../../src/data/stats';
import type { PlayerStats } from '../../src/core/stats';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbop-p4-stats-'));
  db = openDatabase(join(dir, 'app.db'));
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true });
});

function newSession(name = 'Open play'): { sessionId: string; courtId: string } {
  const session = createSession(db, { name, courtCount: 2 });
  const court = listCourts(db, session.id)[0];
  if (!court) throw new Error('no court');
  return { sessionId: session.id, courtId: court.id };
}

function addPlayers(sessionId: string, names: string[]): string[] {
  return names.map((displayName) => {
    const entry = addNewPlayerToSession(db, sessionId, { displayName });
    checkInPlayer(db, sessionId, entry.playerId);
    return entry.playerId;
  });
}

function joinSession(sessionId: string, playerIds: string[]): void {
  for (const id of playerIds) {
    addPlayerToSession(db, sessionId, id);
    checkInPlayer(db, sessionId, id);
  }
}

/** Win one point for `team` through the real scoring API (side-outs / server changes as needed). */
function scorePoint(gameId: string, state: GameState, team: TeamId): GameState {
  let s = state;
  const target = s.score[team] + 1;
  for (let i = 0; i < 10 && s.score[team] < target; i++) {
    s = recordScoringEvent(db, gameId, { type: 'rally', winner: team });
  }
  if (s.score[team] !== target) throw new Error('could not score a point');
  return s;
}

/** Plays a game to finalA–finalB (the winner reaches the target, loser <= target - 2) and finalizes it. */
function playGame(sessionId: string, courtId: string, teamA: string[], teamB: string[], finalA: number, finalB: number): Game {
  const game = createGame(db, { sessionId, courtId, format: teamA.length === 2 ? 'doubles' : 'singles', teamA, teamB });
  let s = startScoring(db, game.id, { firstServingTeam: 'A' });
  const [loser, winner]: [TeamId, TeamId] = finalA > finalB ? ['B', 'A'] : ['A', 'B'];
  const loserFinal = loser === 'A' ? finalA : finalB;
  const winnerFinal = winner === 'A' ? finalA : finalB;
  while (s.score[loser] < loserFinal) s = scorePoint(game.id, s, loser);
  while (s.score[winner] < winnerFinal) s = scorePoint(game.id, s, winner);
  expect(s.isOver).toBe(true);
  return finalizeGame(db, game.id);
}

function row(stats: readonly PlayerStats[], playerId: string): PlayerStats {
  const r = stats.find((s) => s.playerId === playerId);
  if (!r) throw new Error(`no stats row for ${playerId}`);
  return r;
}

/** Independent re-derivation from the stored game records (the authoritative source). */
function expectedFromGames(games: readonly Game[], playerId: string): Omit<PlayerStats, 'winPct' | 'playerId'> {
  let gamesPlayed = 0, wins = 0, pointsFor = 0, pointsAgainst = 0;
  for (const g of games) {
    if (g.status !== 'completed' || g.winner === null) continue;
    const p = g.participants.find((x) => x.playerId === playerId);
    if (!p) continue;
    gamesPlayed++;
    if (g.winner === p.team) wins++;
    pointsFor += p.team === 'A' ? g.teamAScore : g.teamBScore;
    pointsAgainst += p.team === 'A' ? g.teamBScore : g.teamAScore;
  }
  return { gamesPlayed, wins, losses: gamesPlayed - wins, pointsFor, pointsAgainst, pointDiff: pointsFor - pointsAgainst };
}

function totalChanges(): number {
  return ((db as unknown as BetterSqlite3.Database).prepare('SELECT total_changes() AS n').get() as { n: number }).n;
}

describe('AC-15 statistics from finalized games in the database', () => {
  it('a finalized doubles game counts once for each of its four players', () => {
    const { sessionId, courtId } = newSession();
    const [a, b, c, d] = addPlayers(sessionId, ['Ana', 'Ben', 'Cy', 'Dee']) as [string, string, string, string];
    playGame(sessionId, courtId, [a, b], [c, d], 11, 4);
    const stats = getSessionStats(db, sessionId);
    expect(stats.map((s) => s.playerId)).toEqual([a, b, c, d].sort());
    for (const id of [a, b]) expect(row(stats, id)).toMatchObject({ gamesPlayed: 1, wins: 1, losses: 0, winPct: 1, pointsFor: 11, pointsAgainst: 4, pointDiff: 7 });
    for (const id of [c, d]) expect(row(stats, id)).toMatchObject({ gamesPlayed: 1, wins: 0, losses: 1, winPct: 0, pointsFor: 4, pointsAgainst: 11, pointDiff: -7 });
  });

  it('in-progress and incomplete games are excluded; roster players without games get zero rows', () => {
    const { sessionId, courtId } = newSession();
    const [a, b, c, d, e] = addPlayers(sessionId, ['Ana', 'Ben', 'Cy', 'Dee', 'Eve']) as [string, string, string, string, string];
    playGame(sessionId, courtId, [a, b], [c, d], 5, 11);

    const stopped = createGame(db, { sessionId, courtId, format: 'doubles', teamA: [a, c], teamB: [b, d] });
    let s = startScoring(db, stopped.id, { firstServingTeam: 'A' });
    for (let i = 0; i < 6; i++) s = scorePoint(stopped.id, s, 'A');
    markGameIncomplete(db, stopped.id, 'rain');

    const running = createGame(db, { sessionId, courtId, format: 'doubles', teamA: [a, b], teamB: [c, e] });
    s = startScoring(db, running.id, { firstServingTeam: 'B' });
    for (let i = 0; i < 9; i++) s = scorePoint(running.id, s, 'B');

    const stats = getSessionStats(db, sessionId);
    expect(row(stats, a)).toMatchObject({ gamesPlayed: 1, wins: 0, losses: 1, pointsFor: 5, pointsAgainst: 11 });
    expect(row(stats, c)).toMatchObject({ gamesPlayed: 1, wins: 1, losses: 0, pointsFor: 11, pointsAgainst: 5 });
    expect(row(stats, e)).toEqual({ playerId: e, gamesPlayed: 0, wins: 0, losses: 0, winPct: 0, pointsFor: 0, pointsAgainst: 0, pointDiff: 0 });
    expect(stats).toHaveLength(5);
  });

  it('reading statistics and leaderboards writes nothing', () => {
    const { sessionId, courtId } = newSession();
    const [a, b] = addPlayers(sessionId, ['Ana', 'Ben']) as [string, string];
    playGame(sessionId, courtId, [a], [b], 11, 6);
    const before = totalChanges();
    getSessionStats(db, sessionId);
    getHistoricalStats(db);
    getSessionLeaderboard(db, sessionId);
    getHistoricalLeaderboard(db);
    getPartnerHistory(db);
    getPartnerHistory(db, { sessionId });
    expect(totalChanges()).toBe(before);
  });

  it('unknown session id is a ValidationError', () => {
    expect(() => getSessionStats(db, 'no-such-session')).toThrow(ValidationError);
    expect(() => getSessionLeaderboard(db, 'no-such-session')).toThrow(ValidationError);
  });
});

describe('AC-15 recalculation after corrections (brief §5 D)', () => {
  it('a reopened game leaves the statistics until it is finalized again, and is never counted twice', () => {
    const { sessionId, courtId } = newSession();
    const [a, b, c, d] = addPlayers(sessionId, ['Ana', 'Ben', 'Cy', 'Dee']) as [string, string, string, string];
    const g = playGame(sessionId, courtId, [a, b], [c, d], 11, 3);
    expect(row(getSessionStats(db, sessionId), a).gamesPlayed).toBe(1);

    reopenGame(db, g.id, { confirm: true, reason: 'check the score' });
    const whileOpen = getSessionStats(db, sessionId);
    expect(row(whileOpen, a)).toMatchObject({ gamesPlayed: 0, wins: 0 });
    expect(getHistoricalStats(db).find((r) => r.playerId === a)?.gamesPlayed ?? 0).toBe(0);
    expect(getSessionLeaderboard(db, sessionId, { minGames: 0 }).find((r) => r.playerId === a)).toMatchObject({ gamesPlayed: 0, wins: 0 });

    finalizeGame(db, g.id);
    const after = getSessionStats(db, sessionId);
    for (const id of [a, b]) expect(row(after, id)).toMatchObject({ gamesPlayed: 1, wins: 1, losses: 0, pointsFor: 11, pointsAgainst: 3 });
    for (const id of [c, d]) expect(row(after, id)).toMatchObject({ gamesPlayed: 1, wins: 0, losses: 1 });
    expect(row(getHistoricalStats(db), a).gamesPlayed).toBe(1);
  });

  it('flipping the result through undo + rescoring moves the win to the other team', () => {
    const { sessionId, courtId } = newSession();
    const [a, b, c, d] = addPlayers(sessionId, ['Ana', 'Ben', 'Cy', 'Dee']) as [string, string, string, string];
    const other = playGame(sessionId, courtId, [a, c], [b, d], 11, 7);
    const g = playGame(sessionId, courtId, [a, b], [c, d], 11, 3);
    expect(row(getSessionStats(db, sessionId), a)).toMatchObject({ gamesPlayed: 2, wins: 2 });

    reopenGame(db, g.id, { confirm: true, reason: 'last rally was wrong' });
    let s = undoLastScoringEvent(db, g.id); // A back to 10
    expect(s.score).toEqual({ A: 10, B: 3 });
    while (s.score.B < 12) s = scorePoint(g.id, s, 'B'); // B wins 12-10
    expect(s.isOver).toBe(true);
    const fixed = finalizeGame(db, g.id);
    expect(fixed).toMatchObject({ status: 'completed', winner: 'B', teamAScore: 10, teamBScore: 12 });

    const stats = getSessionStats(db, sessionId);
    expect(row(stats, a)).toMatchObject({ gamesPlayed: 2, wins: 1, losses: 1, pointsFor: 11 + 10, pointsAgainst: 7 + 12 });
    expect(row(stats, b)).toMatchObject({ gamesPlayed: 2, wins: 0, losses: 2, pointsFor: 7 + 10, pointsAgainst: 11 + 12 });
    expect(row(stats, c)).toMatchObject({ gamesPlayed: 2, wins: 2, losses: 0, pointsFor: 11 + 12, pointsAgainst: 7 + 10 });
    expect(row(stats, d)).toMatchObject({ gamesPlayed: 2, wins: 1, losses: 1, pointsFor: 7 + 12, pointsAgainst: 11 + 10 });
    expect(getGame(db, other.id)?.status).toBe('completed');

    const board = getSessionLeaderboard(db, sessionId, { minGames: 1 });
    expect(board.find((r) => r.playerId === c)).toMatchObject({ rank: 1, ranked: true, gamesPlayed: 2, displayName: 'Cy' });
  });

  it('correcting an earlier rally of a completed game recalculates the statistics from the corrected record', () => {
    const { sessionId, courtId } = newSession();
    const [a, b, c, d] = addPlayers(sessionId, ['Ana', 'Ben', 'Cy', 'Dee']) as [string, string, string, string];
    const g = playGame(sessionId, courtId, [a, b], [c, d], 11, 6);
    const beforeA = row(getSessionStats(db, sessionId), a);
    expect(beforeA).toMatchObject({ pointsFor: 11, pointsAgainst: 6 });

    // Find the earliest rally whose correction is legal (no later event becomes impossible) and
    // changes the score; after the correction the remaining rallies are re-entered until A wins.
    const log = loadScoreLog(db, g.id);
    let fix: { index: number; event: ScoringEvent; state: GameState } | null = null;
    for (let index = 0; index < log.events.length - 1 && !fix; index++) {
      const ev = log.events[index] as ScoringEvent;
      if (ev.type !== 'rally') continue;
      const flipped: ScoringEvent = { type: 'rally', winner: ev.winner === 'A' ? 'B' : 'A' };
      try {
        const state = stateOf(correct(log, index, flipped));
        if (state.score.A !== 11 || state.score.B !== 6) fix = { index, event: flipped, state };
      } catch {
        // this correction would make a later event illegal; try the next one
      }
    }
    if (!fix) throw new Error('test script has no legal score-changing correction');

    reopenGame(db, g.id, { confirm: true, reason: 'scorer mistake' });
    let s = correctScoringEvent(db, g.id, fix.index, fix.event, { reason: 'wrong team credited' });
    expect(s.score).toEqual(fix.state.score);
    while (!s.isOver) s = scorePoint(g.id, s, 'A');
    expect(s.score).not.toEqual({ A: 11, B: 6 });
    const refinal = finalizeGame(db, g.id);
    expect([refinal.teamAScore, refinal.teamBScore]).toEqual([s.score.A, s.score.B]);

    const stats = getSessionStats(db, sessionId);
    const games = listGames(db, sessionId);
    for (const id of [a, b, c, d]) {
      expect(row(stats, id)).toMatchObject(expectedFromGames(games, id));
      expect(row(stats, id).gamesPlayed).toBe(1);
    }
    expect(row(stats, a).pointsFor - row(stats, a).pointsAgainst).toBe(s.score.A - s.score.B);
    expect(row(stats, a).pointsAgainst).not.toBe(beforeA.pointsAgainst);
    expect(row(getHistoricalStats(db), c)).toMatchObject(expectedFromGames(games, c));
  });
});

describe('AC-15 session vs historical scope and leaderboards (D9)', () => {
  it('session stats use only the selected session; historical aggregates every retained session', () => {
    const s1 = newSession('Monday');
    const [a, b, c, d] = addPlayers(s1.sessionId, ['Ana', 'Ben', 'Cy', 'Dee']) as [string, string, string, string];
    playGame(s1.sessionId, s1.courtId, [a, b], [c, d], 11, 2);
    playGame(s1.sessionId, s1.courtId, [a, c], [b, d], 11, 9);
    finishSession(db, s1.sessionId);

    const s2 = newSession('Thursday');
    joinSession(s2.sessionId, [a, b, c, d]);
    playGame(s2.sessionId, s2.courtId, [b, d], [a, c], 11, 5);
    finishSession(db, s2.sessionId);

    const one = getSessionStats(db, s1.sessionId);
    const two = getSessionStats(db, s2.sessionId);
    const all = getHistoricalStats(db);
    expect(row(one, a)).toMatchObject({ gamesPlayed: 2, wins: 2, losses: 0, pointsFor: 22, pointsAgainst: 11 });
    expect(row(two, a)).toMatchObject({ gamesPlayed: 1, wins: 0, losses: 1, pointsFor: 5, pointsAgainst: 11 });
    expect(row(all, a)).toMatchObject({ gamesPlayed: 3, wins: 2, losses: 1, pointsFor: 27, pointsAgainst: 22, pointDiff: 5 });
    expect(row(all, d)).toMatchObject({ gamesPlayed: 3, wins: 1, losses: 2, pointsFor: 2 + 9 + 11, pointsAgainst: 11 + 11 + 5 });
    expect(row(all, a).winPct).toBeCloseTo(2 / 3, 12);
  });

  it('historical stats keep deactivated and removed players, and drop deleted sessions', () => {
    const s1 = newSession('Monday');
    const [a, b] = addPlayers(s1.sessionId, ['Ana', 'Ben']) as [string, string];
    playGame(s1.sessionId, s1.courtId, [a], [b], 11, 1);
    removePlayerFromSession(db, s1.sessionId, b);
    deactivatePlayer(db, b);

    expect(row(getSessionStats(db, s1.sessionId), b)).toMatchObject({ gamesPlayed: 1, losses: 1 });
    expect(row(getHistoricalStats(db), b)).toMatchObject({ gamesPlayed: 1, losses: 1 });

    const s2 = newSession('Tuesday');
    const [c] = addPlayers(s2.sessionId, ['Cy']) as [string];
    joinSession(s2.sessionId, [a]);
    playGame(s2.sessionId, s2.courtId, [c], [a], 11, 8);
    expect(row(getHistoricalStats(db), a).gamesPlayed).toBe(2);

    deleteSession(db, s2.sessionId, { confirm: true });
    const after = getHistoricalStats(db);
    expect(row(after, a)).toMatchObject({ gamesPlayed: 1, wins: 1 });
    expect(after.find((r) => r.playerId === c)).toBeUndefined();
  });

  it('session leaderboard: 3+ games ranked, fewer unranked, display names and games played shown', () => {
    const { sessionId, courtId } = newSession();
    const [p1, p2, p3, p4, p5] = addPlayers(sessionId, ['Pat', 'Quinn', 'Rae', 'Sam', 'Tao']) as [string, string, string, string, string];
    playGame(sessionId, courtId, [p1, p2], [p3, p4], 11, 6);
    playGame(sessionId, courtId, [p1, p2], [p3, p4], 11, 8);
    playGame(sessionId, courtId, [p1, p5], [p3, p4], 4, 11);
    // p1: 3 games 2-1; p3, p4: 3 games 1-2; p2: 2 games 2-0 (unranked); p5: 1 game (unranked)
    const board = getSessionLeaderboard(db, sessionId);
    expect(board).toHaveLength(5);
    expect(board[0]).toMatchObject({ playerId: p1, displayName: 'Pat', rank: 1, ranked: true, tied: false, gamesPlayed: 3, wins: 2 });
    const second = board.slice(1, 3);
    expect(new Set(second.map((r) => r.playerId))).toEqual(new Set([p3, p4]));
    for (const r of second) expect(r).toMatchObject({ rank: 2, ranked: true, tied: true, gamesPlayed: 3 });
    const rest = board.slice(3);
    expect(rest.find((r) => r.playerId === p2)).toMatchObject({ displayName: 'Quinn', ranked: false, rank: null, gamesPlayed: 2, wins: 2 });
    expect(rest.find((r) => r.playerId === p5)).toMatchObject({ displayName: 'Tao', ranked: false, rank: null, gamesPlayed: 1 });

    const loose = getSessionLeaderboard(db, sessionId, { minGames: 1 });
    expect(loose[0]).toMatchObject({ playerId: p2, rank: 1, ranked: true });
  });

  it('historical leaderboard needs 10 games; a player ranked in a session can be unranked historically', () => {
    const s1 = newSession('Week 1');
    const [x, y, z] = addPlayers(s1.sessionId, ['Xia', 'Yuri', 'Zoe']) as [string, string, string];
    for (let i = 0; i < 5; i++) playGame(s1.sessionId, s1.courtId, [x], [y], 11, i);
    for (let i = 0; i < 4; i++) playGame(s1.sessionId, s1.courtId, [z], [x], 11, 0);
    finishSession(db, s1.sessionId);
    const s2 = newSession('Week 2');
    joinSession(s2.sessionId, [x, y]);
    for (let i = 0; i < 5; i++) playGame(s2.sessionId, s2.courtId, [y], [x], 11, 9);
    finishSession(db, s2.sessionId);

    // Historical: x 14 games (5-9), y 10 games (5-5), z 4 games (4-0, unranked).
    const hist = getHistoricalLeaderboard(db);
    expect(hist.map((r) => [r.displayName, r.rank, r.ranked, r.gamesPlayed])).toEqual([
      ['Yuri', 1, true, 10],
      ['Xia', 2, true, 14],
      ['Zoe', null, false, 4],
    ]);
    // Session 1: z 4-0 is ranked first there.
    const sess = getSessionLeaderboard(db, s1.sessionId);
    expect(sess[0]).toMatchObject({ playerId: z, rank: 1, ranked: true, gamesPlayed: 4 });
    expect(sess.find((r) => r.playerId === y)).toMatchObject({ ranked: true, gamesPlayed: 5, wins: 0 });
    const relaxed = getHistoricalLeaderboard(db, { minGames: 4 });
    expect(relaxed[0]).toMatchObject({ playerId: z, rank: 1 });
  });

  it('partner history per session and across sessions', () => {
    const s1 = newSession('Monday');
    const [a, b, c, d] = addPlayers(s1.sessionId, ['Ana', 'Ben', 'Cy', 'Dee']) as [string, string, string, string];
    playGame(s1.sessionId, s1.courtId, [a, b], [c, d], 11, 2);
    playGame(s1.sessionId, s1.courtId, [b, a], [c, d], 3, 11);
    const s2 = newSession('Tuesday');
    joinSession(s2.sessionId, [a, b, c, d]);
    playGame(s2.sessionId, s2.courtId, [a, b], [d, c], 11, 7);

    const pair = (rows: ReturnType<typeof getPartnerHistory>, p: string, q: string) =>
      rows.find((r) => r.playerId === p && r.partnerId === q);
    const one = getPartnerHistory(db, { sessionId: s1.sessionId });
    expect(pair(one, a, b)).toEqual({ playerId: a, partnerId: b, games: 2, wins: 1, losses: 1 });
    expect(pair(one, d, c)).toEqual({ playerId: d, partnerId: c, games: 2, wins: 1, losses: 1 });
    expect(pair(one, a, c)).toBeUndefined();
    const all = getPartnerHistory(db);
    expect(pair(all, b, a)).toEqual({ playerId: b, partnerId: a, games: 3, wins: 2, losses: 1 });
    expect(pair(all, c, d)).toEqual({ playerId: c, partnerId: d, games: 3, wins: 1, losses: 2 });
    expect(all).toHaveLength(4);
  });
});
