/*
 * Organizer requests after phase 5: delete a session (native confirmation only), record a game
 * result by tagging the winner, and rename players with duplicate detection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../../src/data/db';
import { createSession, finishSession, getSession, listAuditEvents, reopenSession } from '../../src/data/sessions';
import { addNewPlayerToSession, checkInPlayer } from '../../src/data/roster';
import { listCourts } from '../../src/data/courts';
import { createGame, getGame, getPlayerGameHistory, listScoreEvents } from '../../src/data/games';
import { createPlayer, getPlayer, renamePlayer } from '../../src/data/players';
import { finalizeGame, loadScoreLog, recordGameResult, recordScoringEvent, reopenGame, startScoring } from '../../src/data/scoring';
import { getSessionLeaderboard, getSessionStats } from '../../src/data/stats';
import { getQueue } from '../../src/data/rotation';
import { DuplicatePlayerError, SessionReadOnlyError, SessionStateError, ValidationError } from '../../src/data/errors';
import { createApiHandlers, type DbStore, type HostServices } from '../../src/main/handlers';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbop-extras-'));
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

function setup(names = ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Flo']) {
  const session = createSession(db, { name: 'Thursday', courtCount: 2 });
  const courts = listCourts(db, session.id);
  const ids = names.map((displayName) => {
    const entry = addNewPlayerToSession(db, session.id, { displayName });
    checkInPlayer(db, session.id, entry.playerId, '2026-10-21T18:00:00.000Z');
    return entry.playerId;
  });
  return { sessionId: session.id, courtId: (courts[0] as { id: string }).id, ids };
}

function startGame(sessionId: string, courtId: string, ids: string[]) {
  return createGame(db, {
    sessionId,
    courtId,
    format: 'doubles',
    teamA: [ids[0] as string, ids[1] as string],
    teamB: [ids[2] as string, ids[3] as string],
    startedAt: '2026-10-21T18:05:00.000Z',
  });
}

describe('recordGameResult', () => {
  it('completes an in-progress game with a winner and scores, and stats count it', () => {
    const { sessionId, courtId, ids } = setup();
    const game = startGame(sessionId, courtId, ids);
    const done = recordGameResult(db, game.id, { winner: 'B', scoreA: 7, scoreB: 11 }, { at: '2026-10-21T18:20:00.000Z' });
    expect(done.status).toBe('completed');
    expect(done.winner).toBe('B');
    expect([done.teamAScore, done.teamBScore]).toEqual([7, 11]);
    expect(done.endedAt).toBe('2026-10-21T18:20:00.000Z');

    const stats = getSessionStats(db, sessionId);
    const of = (id: string) => stats.find((s) => s.playerId === id);
    expect(of(ids[2] as string)?.wins).toBe(1);
    expect(of(ids[2] as string)?.pointsFor).toBe(11);
    expect(of(ids[0] as string)?.losses).toBe(1);
    expect(of(ids[0] as string)?.pointsAgainst).toBe(11);
    expect(getSessionLeaderboard(db, sessionId).filter((r) => r.gamesPlayed === 1)).toHaveLength(4);

    const audit = listAuditEvents(db, sessionId).find((e) => e.action === 'game_result_recorded');
    expect(audit?.details).toMatchObject({ gameId: game.id, winner: 'B', scoreA: 7, scoreB: 11 });
  });

  it('without scores stores 0-0 and still counts the win and loss', () => {
    const { sessionId, courtId, ids } = setup();
    const game = startGame(sessionId, courtId, ids);
    const done = recordGameResult(db, game.id, { winner: 'A' });
    expect([done.teamAScore, done.teamBScore, done.winner]).toEqual([0, 0, 'A']);
    const winner = getSessionStats(db, sessionId).find((s) => s.playerId === ids[0]);
    expect(winner?.wins).toBe(1);
    expect(winner?.pointsFor).toBe(0);
  });

  it('makes the players eligible again from the game end time (D5)', () => {
    const { sessionId, courtId, ids } = setup();
    const game = startGame(sessionId, courtId, ids);
    expect(getQueue(db, sessionId).map((q) => q.playerId)).not.toContain(ids[0]);
    recordGameResult(db, game.id, { winner: 'A' }, { at: '2026-10-21T18:30:00.000Z' });
    const queue = getQueue(db, sessionId, { at: '2026-10-21T18:31:00.000Z' });
    expect(queue).toHaveLength(6);
    const ana = queue.find((q) => q.playerId === ids[0]);
    expect(ana?.eligibleSince).toBe('2026-10-21T18:30:00.000Z');
    expect(ana?.gamesPlayed).toBe(1);
    // players who never played wait ahead of the ones who just finished
    expect(queue.slice(0, 2).map((q) => q.playerId).sort()).toEqual([ids[4], ids[5]].sort());
  });

  it('validates the winner and scores and leaves the game untouched on rejection', () => {
    const { sessionId, courtId, ids } = setup();
    const game = startGame(sessionId, courtId, ids);
    expect(() => recordGameResult(db, game.id, { winner: 'A', scoreA: 5, scoreB: 11 })).toThrow(ValidationError);
    expect(() => recordGameResult(db, game.id, { winner: 'A', scoreA: 9, scoreB: 9 })).toThrow(ValidationError);
    expect(() => recordGameResult(db, game.id, { winner: 'A', scoreA: 11 })).toThrow(ValidationError);
    expect(() => recordGameResult(db, game.id, { winner: 'A', scoreA: -1, scoreB: -3 })).toThrow(ValidationError);
    expect(() => recordGameResult(db, game.id, { winner: 'A', scoreA: 2.5, scoreB: 1 })).toThrow(ValidationError);
    expect(() => recordGameResult(db, game.id, { winner: 'C' as 'A' })).toThrow(ValidationError);
    expect(getGame(db, game.id)?.status).toBe('in_progress');
    expect(listAuditEvents(db, sessionId).some((e) => e.action === 'game_result_recorded')).toBe(false);
  });

  it('refuses a game that is not in progress (no double finalize) and a completed session', () => {
    const { sessionId, courtId, ids } = setup();
    const game = startGame(sessionId, courtId, ids);
    recordGameResult(db, game.id, { winner: 'A', scoreA: 11, scoreB: 4 });
    expect(() => recordGameResult(db, game.id, { winner: 'B' })).toThrow(SessionStateError);
    expect(() => recordGameResult(db, 'nope', { winner: 'B' })).toThrow(ValidationError);
    const second = createGame(db, {
      sessionId,
      courtId,
      format: 'doubles',
      teamA: [ids[0] as string, ids[1] as string],
      teamB: [ids[4] as string, ids[5] as string],
    });
    recordGameResult(db, second.id, { winner: 'B' });
    finishSession(db, sessionId);
    // a completed session is read-only, even after the game is reopened elsewhere
    expect(() => recordGameResult(db, second.id, { winner: 'A' })).toThrow(SessionReadOnlyError);
    reopenSession(db, sessionId);
    reopenGame(db, second.id, { confirm: true });
    expect(recordGameResult(db, second.id, { winner: 'A' }).winner).toBe('A');
  });

  it('is authoritative over rally scoring that had started, and the game can be reopened and rescored', () => {
    const { sessionId, courtId, ids } = setup();
    const game = startGame(sessionId, courtId, ids);
    startScoring(db, game.id, { firstServingTeam: 'A' });
    recordScoringEvent(db, game.id, { type: 'rally', winner: 'A' });
    recordScoringEvent(db, game.id, { type: 'rally', winner: 'A' });
    const done = recordGameResult(db, game.id, { winner: 'B', scoreA: 8, scoreB: 11 });
    expect([done.teamAScore, done.teamBScore, done.winner]).toEqual([8, 11, 'B']);
    expect(listScoreEvents(db, game.id).at(-1)?.eventType).toBe('result_recorded');
    // the rally log itself is unchanged: two rallies
    expect(loadScoreLog(db, game.id).events).toHaveLength(2);
    expect(() => finalizeGame(db, game.id)).toThrow(SessionStateError);
    const audit = listAuditEvents(db, sessionId).find((e) => e.action === 'game_result_recorded');
    expect(audit?.details).toMatchObject({ rallyScoreBefore: { A: 2, B: 0 } });

    const reopened = reopenGame(db, game.id, { confirm: true, reason: 'wrong team tagged' });
    expect(reopened.status).toBe('in_progress');
    expect(getSessionStats(db, sessionId).every((s) => s.gamesPlayed === 0)).toBe(true);
    const state = recordScoringEvent(db, game.id, { type: 'rally', winner: 'A' });
    expect(state.score.A).toBe(3);
    expect(recordGameResult(db, game.id, { winner: 'A' }).winner).toBe('A');
    expect(getPlayerGameHistory(db, ids[0] as string)).toHaveLength(1);
  });
});

describe('renamePlayer', () => {
  it('changes name and nickname but never the id, so history stays linked', () => {
    const { sessionId, courtId, ids } = setup();
    const game = startGame(sessionId, courtId, ids);
    recordGameResult(db, game.id, { winner: 'A' });
    const renamed = renamePlayer(db, ids[0] as string, { displayName: '  Ana   Maria ', nickname: 'AM' });
    expect(renamed).toMatchObject({ id: ids[0], displayName: 'Ana Maria', nickname: 'AM' });
    expect(getPlayer(db, ids[0] as string)?.displayName).toBe('Ana Maria');
    expect(getPlayerGameHistory(db, ids[0] as string)).toHaveLength(1);
    expect(getSessionLeaderboard(db, sessionId).find((r) => r.playerId === ids[0])?.displayName).toBe('Ana Maria');
    expect(renamePlayer(db, ids[0] as string, { displayName: 'Ana Maria', nickname: null }).nickname).toBeNull();
  });

  it('refuses a name or nickname that matches another player unless kept as a different person', () => {
    const { ids } = setup();
    const other = createPlayer(db, { displayName: 'Gus', nickname: 'Goose' });
    expect(() => renamePlayer(db, ids[0] as string, { displayName: 'ben' })).toThrow(DuplicatePlayerError);
    expect(() => renamePlayer(db, ids[0] as string, { displayName: 'Ana', nickname: 'goose' })).toThrow(DuplicatePlayerError);
    try {
      renamePlayer(db, ids[0] as string, { displayName: 'GOOSE' });
    } catch (err) {
      expect((err as DuplicatePlayerError).matches.map((p) => p.id)).toEqual([other.id]);
    }
    expect(getPlayer(db, ids[0] as string)?.displayName).toBe('Ana');
    const kept = renamePlayer(db, ids[0] as string, { displayName: 'Ben', allowDuplicateName: true });
    expect(kept.displayName).toBe('Ben');
    // re-saving the accepted name is not refused again; the player's own name never counts as a duplicate
    expect(renamePlayer(db, ids[0] as string, { displayName: 'Ben', nickname: 'B2' }).nickname).toBe('B2');
    expect(renamePlayer(db, ids[2] as string, { displayName: 'cy' }).displayName).toBe('cy');
  });

  it('rejects an empty name and an unknown player', () => {
    const { ids } = setup();
    expect(() => renamePlayer(db, ids[0] as string, { displayName: '   ' })).toThrow(ValidationError);
    expect(() => renamePlayer(db, 'missing', { displayName: 'X' })).toThrow(ValidationError);
  });
});

describe('deleteSession through the API handlers', () => {
  function handlersWith(answer: boolean) {
    const asked: { message: string; detail: string; label?: string }[] = [];
    const store: DbStore = { current: () => db, close: () => undefined, open: () => undefined };
    const host: HostServices = {
      appVersion: 'test',
      dbFile: join(dir, 'app.db'),
      autoBackupDir: join(dir, 'auto'),
      chooseDirectory: async () => null,
      chooseSaveFile: async () => null,
      chooseOpenFile: async () => null,
      confirm: async (message, detail, label) => {
        asked.push({ message, detail, label });
        return answer;
      },
      openDisplay: () => undefined,
    };
    return { handlers: createApiHandlers(store, host), asked };
  }

  it('asks in a native dialog naming the session and keeps everything when cancelled', async () => {
    const { sessionId, courtId, ids } = setup();
    startGame(sessionId, courtId, ids);
    const { handlers, asked } = handlersWith(false);
    // a renderer passing an extra "confirm" flag cannot skip the dialog
    const result = await handlers.deleteSession(sessionId, true);
    expect(result).toEqual({ ok: true, value: false });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.message).toContain('Thursday');
    expect(asked[0]?.detail).toMatch(/in progress/);
    expect(asked[0]?.label).toBe('Delete session');
    expect(getSession(db, sessionId)).not.toBeNull();
  });

  it('deletes the session (even with a game in progress) once confirmed; players stay', async () => {
    const { sessionId, courtId, ids } = setup();
    const game = startGame(sessionId, courtId, ids);
    const { handlers } = handlersWith(true);
    expect(await handlers.deleteSession(sessionId)).toEqual({ ok: true, value: true });
    expect(getSession(db, sessionId)).toBeNull();
    expect(getGame(db, game.id)).toBeNull();
    expect(getPlayer(db, ids[0] as string)).not.toBeNull();
    const missing = await handlers.deleteSession(sessionId);
    expect(missing.ok).toBe(false);
  });

  it('exposes recordGameResult and renamePlayer with the duplicate prompt data', async () => {
    const { sessionId, courtId, ids } = setup();
    const game = startGame(sessionId, courtId, ids);
    const { handlers } = handlersWith(true);
    const dup = await handlers.renamePlayer(ids[0], { displayName: 'Ben' });
    expect(dup).toMatchObject({ ok: false, code: 'duplicate_player' });
    expect(dup.ok ? [] : dup.matches?.map((p) => p.id)).toEqual([ids[1]]);
    const bad = await handlers.recordGameResult(game.id, { winner: 'A', scoreA: 1, scoreB: 4 });
    expect(bad).toMatchObject({ ok: false, code: 'validation' });
    const ok = await handlers.recordGameResult(game.id, { winner: 'A', scoreA: 11, scoreB: 4 });
    expect(ok.ok).toBe(true);
    expect(getGame(db, game.id)?.status).toBe('completed');
    expect(sessionId).toBeTruthy();
  });
});
