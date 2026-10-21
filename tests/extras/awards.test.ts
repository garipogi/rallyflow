/*
 * Awards (organizer request after phase 5): pure rules in src/core/awards and the database-backed
 * src/data/awards. Covers thresholds (D9), ties, streak ordering, the Dynamic Duo minimum, score-less
 * results, empty data, and the API handlers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { computeAwards, formatWinners, isScoreless, type AwardGame, type AwardId, type AwardsResult } from '../../src/core/awards';
import { openDatabase, type Db } from '../../src/data/db';
import { createSession, finishSession } from '../../src/data/sessions';
import { addNewPlayerToSession, addPlayerToSession, checkInPlayer } from '../../src/data/roster';
import { listCourts } from '../../src/data/courts';
import { createGame } from '../../src/data/games';
import { finalizeGame, recordGameResult, recordScoringEvent, startScoring } from '../../src/data/scoring';
import { getAwards } from '../../src/data/awards';
import { createApiHandlers, type DbStore, type HostServices } from '../../src/main/handlers';
import type { DisplayMode } from '../../src/shared/api';

let seq = 0;
function game(
  teamA: string[],
  teamB: string[],
  winner: 'A' | 'B',
  score: [number, number] = winner === 'A' ? [11, 5] : [5, 11],
  extra: Partial<AwardGame> = {},
): AwardGame {
  seq++;
  return {
    id: `g${seq}`,
    sessionId: 's1',
    format: teamA.length === 2 ? 'doubles' : 'singles',
    status: 'completed',
    teamAScore: score[0],
    teamBScore: score[1],
    winner,
    endedAt: `2026-10-21T18:${String(seq % 60).padStart(2, '0')}:00.000Z`,
    participants: [...teamA.map((playerId) => ({ playerId, team: 'A' as const })), ...teamB.map((playerId) => ({ playerId, team: 'B' as const }))],
    ...extra,
  };
}

const NAMES = { a: 'Ana', b: 'Ben', c: 'Cy', d: 'Dee', e: 'Eve', f: 'Flo' };
const award = (r: AwardsResult, id: AwardId) => r.awards.find((x) => x.id === id);
const winnersOf = (r: AwardsResult, id: AwardId) => award(r, id)?.groups.map((g) => g.map((w) => w.playerId));

describe('computeAwards: empty and unfinished data', () => {
  it('no games gives no awards and no podium', () => {
    const r = computeAwards({ scope: 'session', games: [], names: NAMES });
    expect(r).toMatchObject({ finalizedGames: 0, awards: [], podium: [], provisional: false, note: null, threshold: 3 });
  });

  it('ignores games that are not finalized', () => {
    const games = [
      { ...game(['a'], ['b'], 'A'), status: 'in_progress' as const, winner: null },
      { ...game(['a'], ['b'], 'A'), status: 'incomplete' as const, winner: null },
      { ...game(['a'], ['b'], 'A'), status: 'cancelled' as const },
    ];
    expect(computeAwards({ scope: 'session', games, names: NAMES }).finalizedGames).toBe(0);
  });

  it('does not mutate its input', () => {
    const games = [game(['a', 'b'], ['c', 'd'], 'A'), game(['a', 'c'], ['b', 'd'], 'B')];
    const copy = JSON.parse(JSON.stringify(games));
    computeAwards({ scope: 'session', games, names: NAMES });
    expect(games).toEqual(copy);
  });
});

describe('computeAwards: champion and podium follow D9', () => {
  it('ranks only players at the session threshold (3 games)', () => {
    // a: 3-0, b: 2-1, c: 1-2 (all ranked); d: 2-0 in two games (unranked despite 100%).
    const games = [
      game(['a'], ['b'], 'A'),
      game(['a'], ['c'], 'A'),
      game(['a'], ['c'], 'A'),
      game(['b'], ['c'], 'A'),
      game(['b'], ['c'], 'B'),
      game(['d'], ['e'], 'A'),
      game(['d'], ['e'], 'A'),
    ];
    const r = computeAwards({ scope: 'session', games, names: NAMES });
    expect(r.provisional).toBe(false);
    expect(r.note).toBeNull();
    expect(winnersOf(r, 'champion')).toEqual([['a']]);
    expect(award(r, 'champion')?.title).toBe('Player of the Session');
    expect(award(r, 'champion')?.explanation).toMatch(/^Won 3 of 3 games \(100%\)/);
    expect(r.podium.map((p) => [p.place, p.players.map((x) => x.playerId)])).toEqual([
      [1, ['a']],
      [2, ['b']],
      [3, ['c']],
    ]);
  });

  it('uses the historical threshold of 10 and the all-time title', () => {
    const games = Array.from({ length: 10 }, (_, i) => game(['a'], ['b'], i < 7 ? 'A' : 'B'));
    const r = computeAwards({ scope: 'historical', games, names: NAMES });
    expect(r.threshold).toBe(10);
    expect(r.provisional).toBe(false);
    expect(award(r, 'champion')?.title).toBe('All-time Champion');
    expect(winnersOf(r, 'champion')).toEqual([['a']]);
    const nine = computeAwards({ scope: 'historical', games: games.slice(0, 9), names: NAMES });
    expect(nine.provisional).toBe(true);
  });

  it('when nobody meets the threshold, the podium is provisional on best record with a kind note', () => {
    const games = [game(['a'], ['b'], 'A'), game(['a'], ['c'], 'A'), game(['b'], ['c'], 'A')];
    const r = computeAwards({ scope: 'session', games, names: NAMES });
    expect(r.provisional).toBe(true);
    expect(r.note).toMatch(/Nobody has played 3 finalized games yet.*provisional/);
    expect(award(r, 'champion')).toMatchObject({ provisional: true });
    expect(winnersOf(r, 'champion')).toEqual([['a']]);
    expect(r.podium.map((p) => p.players.map((x) => x.playerId))).toEqual([['a'], ['b'], ['c']]);
  });

  it('ties after win %, wins and point difference share the place (standard competition ranking)', () => {
    // a and b: identical 3-0 with identical points; c 1-2.
    const games = [
      game(['a'], ['c'], 'A', [11, 5]),
      game(['b'], ['c'], 'A', [11, 5]),
      game(['a'], ['e'], 'A', [11, 5]),
      game(['b'], ['e'], 'A', [11, 5]),
      game(['a'], ['f'], 'A', [11, 5]),
      game(['b'], ['f'], 'A', [11, 5]),
      game(['c'], ['e'], 'A', [11, 5]),
    ];
    const r = computeAwards({ scope: 'session', games, names: NAMES });
    expect(winnersOf(r, 'champion')).toEqual([['a'], ['b']]);
    expect(r.podium[0]).toMatchObject({ place: 1 });
    expect(r.podium[0]?.players.map((p) => p.playerId)).toEqual(['a', 'b']);
    expect(r.podium.some((p) => p.place === 2)).toBe(false); // two golds, no silver
    expect(award(r, 'champion')?.explanation).toMatch(/shared by 2 players/);
  });

  it('point difference breaks a win % and wins tie', () => {
    const games = [
      game(['a'], ['c'], 'A', [11, 1]),
      game(['b'], ['c'], 'A', [11, 9]),
      game(['a'], ['e'], 'A', [11, 1]),
      game(['b'], ['e'], 'A', [11, 9]),
      game(['a'], ['f'], 'A', [11, 1]),
      game(['b'], ['f'], 'A', [11, 9]),
    ];
    const r = computeAwards({ scope: 'session', games, names: NAMES });
    expect(winnersOf(r, 'champion')).toEqual([['a']]);
  });
});

describe('computeAwards: individual awards', () => {
  it('Most Wins uses wins, then the D9 order, and explains the record', () => {
    // a: 3 wins of 4; b: 3 wins of 3 -> b wins the tie on win %.
    const games = [
      game(['a'], ['c'], 'A'),
      game(['a'], ['c'], 'A'),
      game(['a'], ['c'], 'A'),
      game(['a'], ['b'], 'B'),
      game(['b'], ['d'], 'A'),
      game(['b'], ['d'], 'A'),
    ];
    const r = computeAwards({ scope: 'session', games, names: NAMES });
    expect(winnersOf(r, 'most_wins')).toEqual([['b']]);
    expect(award(r, 'most_wins')?.explanation).toBe('Won 3 of 3 games (100%).');
  });

  it('Hot Streak orders games by end time, not by input order', () => {
    // Listed out of order: by end time a goes W, W, W, L, so the streak is 3.
    const w1 = game(['a'], ['b'], 'A', [11, 3], { endedAt: '2026-10-21T18:01:00.000Z' });
    const w2 = game(['a'], ['b'], 'A', [11, 3], { endedAt: '2026-10-21T18:02:00.000Z' });
    const w3 = game(['a'], ['b'], 'A', [11, 3], { endedAt: '2026-10-21T18:03:00.000Z' });
    const l4 = game(['a'], ['b'], 'B', [3, 11], { endedAt: '2026-10-21T18:04:00.000Z' });
    const r = computeAwards({ scope: 'session', games: [w3, l4, w1, w2], names: NAMES });
    expect(winnersOf(r, 'hot_streak')).toEqual([['a']]);
    expect(award(r, 'hot_streak')?.stat).toBe('3');
    // Interleaving the loss breaks the run.
    const broken = computeAwards({
      scope: 'session',
      games: [w1, { ...l4, endedAt: '2026-10-21T18:01:30.000Z' }, w2, { ...game(['a'], ['c'], 'B', [3, 11]), endedAt: '2026-10-21T18:02:30.000Z' }],
      names: NAMES,
    });
    expect(winnersOf(broken, 'hot_streak')).toBeUndefined();
  });

  it('Dynamic Duo needs at least 2 games together and ranks by win % then wins', () => {
    const once = computeAwards({ scope: 'session', games: [game(['a', 'b'], ['c', 'd'], 'A')], names: NAMES });
    expect(award(once, 'dynamic_duo')).toBeUndefined();

    const games = [
      // a+b: 2-0 together; c+d: 2-1 together; e+f: 3-0 together (best).
      game(['a', 'b'], ['c', 'e'], 'A'),
      game(['a', 'b'], ['d', 'f'], 'A'),
      game(['c', 'd'], ['a', 'e'], 'A'),
      game(['c', 'd'], ['b', 'f'], 'A'),
      game(['c', 'd'], ['a', 'f'], 'B'),
      game(['e', 'f'], ['a', 'c'], 'A'),
      game(['e', 'f'], ['b', 'd'], 'A'),
      game(['e', 'f'], ['a', 'd'], 'A'),
    ];
    const r = computeAwards({ scope: 'session', games, names: NAMES });
    expect(winnersOf(r, 'dynamic_duo')).toEqual([['e', 'f']]);
    expect(award(r, 'dynamic_duo')?.explanation).toBe('Won 3 of 3 games together (100%), +18 points.');
    expect(formatWinners(award(r, 'dynamic_duo')?.groups ?? [])).toBe('Eve & Flo');
  });

  it('Dynamic Duo breaks a win % and wins tie on point difference together', () => {
    const games = [
      game(['a', 'b'], ['e', 'f'], 'A', [11, 9]),
      game(['a', 'b'], ['e', 'f'], 'A', [11, 9]),
      game(['c', 'd'], ['e', 'f'], 'A', [11, 2]),
      game(['c', 'd'], ['e', 'f'], 'A', [11, 2]),
    ];
    const r = computeAwards({ scope: 'session', games, names: NAMES });
    expect(winnersOf(r, 'dynamic_duo')).toEqual([['c', 'd']]);
  });

  it('formatWinners shortens long tie lists', () => {
    const w = (n: string) => [{ playerId: n, name: n }];
    expect(formatWinners([w('A'), w('B'), w('C'), w('D')], 2)).toBe('A, B and 2 more');
    expect(formatWinners([w('A'), w('B'), w('C')], 2)).toBe('A, B and 1 more');
    const pair = (x: string, y: string) => [{ playerId: x, name: x }, { playerId: y, name: y }];
    expect(formatWinners([pair('A', 'B'), pair('C', 'D'), pair('E', 'F')], 2)).toBe('A & B, C & D and 1 more pair');
    expect(formatWinners([w('A'), w('B')])).toBe('A and B');
  });

  it('Dynamic Duo is shared between pairs that are equal on win %, wins and point difference', () => {
    const games = [
      game(['a', 'b'], ['e', 'f'], 'A'),
      game(['a', 'b'], ['e', 'f'], 'A'),
      game(['c', 'd'], ['e', 'f'], 'A'),
      game(['c', 'd'], ['e', 'f'], 'A'),
    ];
    const r = computeAwards({ scope: 'session', games, names: NAMES });
    expect(winnersOf(r, 'dynamic_duo')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(formatWinners(award(r, 'dynamic_duo')?.groups ?? [])).toBe('Ana & Ben and Cy & Dee');
  });

  it('Clutch Player counts wins in games decided by 2 points or fewer', () => {
    const games = [
      game(['a'], ['b'], 'A', [12, 10]),
      game(['a'], ['c'], 'A', [11, 9]),
      game(['b'], ['c'], 'A', [11, 2]),
      game(['c'], ['b'], 'A', [13, 11]),
    ];
    const r = computeAwards({ scope: 'session', games, names: NAMES });
    expect(winnersOf(r, 'clutch')).toEqual([['a']]);
    expect(award(r, 'clutch')?.explanation).toBe('Won 2 of 2 close games (decided by 2 points or fewer).');
  });

  it('Iron Player is hidden when everyone played the same number of games', () => {
    const even = computeAwards({ scope: 'session', games: [game(['a'], ['b'], 'A'), game(['a'], ['b'], 'B')], names: NAMES });
    expect(award(even, 'iron_player')).toBeUndefined();
    const uneven = computeAwards({
      scope: 'session',
      games: [game(['a'], ['b'], 'A'), game(['a'], ['c'], 'B'), game(['a'], ['d'], 'A')],
      names: NAMES,
    });
    expect(winnersOf(uneven, 'iron_player')).toEqual([['a']]);
    expect(award(uneven, 'iron_player')?.stat).toBe('3');
  });

  it('Social Butterfly needs at least 3 different partners', () => {
    const games = [
      game(['a', 'b'], ['c', 'd'], 'A'),
      game(['a', 'c'], ['b', 'd'], 'A'),
      game(['a', 'd'], ['b', 'c'], 'A'),
    ];
    const r = computeAwards({ scope: 'session', games, names: NAMES });
    // Everyone partnered all three others; a is ahead on the D9 order (3-0).
    expect(winnersOf(r, 'social_butterfly')).toEqual([['a']]);
    const two = computeAwards({ scope: 'session', games: games.slice(0, 2), names: NAMES });
    expect(award(two, 'social_butterfly')).toBeUndefined();
  });

  it('Rising Star appears only in the all-time scope with enough history', () => {
    const s1 = (g: AwardGame): AwardGame => ({ ...g, sessionId: 's1' });
    const s2 = (g: AwardGame): AwardGame => ({ ...g, sessionId: 's2' });
    const games = [
      s1(game(['a'], ['b'], 'B')),
      s1(game(['a'], ['b'], 'B')),
      s1(game(['a'], ['b'], 'A')),
      s2(game(['a'], ['b'], 'A')),
      s2(game(['a'], ['b'], 'A')),
    ];
    const sessions = [
      { id: 's1', name: 'Week 1' },
      { id: 's2', name: 'Week 2' },
    ];
    const r = computeAwards({ scope: 'historical', games, names: NAMES, sessions });
    expect(winnersOf(r, 'rising_star')).toEqual([['a']]);
    expect(award(r, 'rising_star')?.explanation).toBe('Win rate up from 33% to 100% in Week 2.');
    expect(award(computeAwards({ scope: 'session', games, names: NAMES, sessions }), 'rising_star')).toBeUndefined();
    expect(award(computeAwards({ scope: 'historical', games: games.slice(1), names: NAMES, sessions }), 'rising_star')).toBeUndefined();
  });
});

describe('computeAwards: score-less results', () => {
  it('a completed 0-0 game is score-less', () => {
    expect(isScoreless(game(['a'], ['b'], 'A', [0, 0]))).toBe(true);
    expect(isScoreless(game(['a'], ['b'], 'A', [11, 4]))).toBe(false);
  });

  it('0-0 results count for wins and streaks but never for Point Machine or Clutch Player', () => {
    // a wins three score-less games; b wins one close scored game by a big point difference.
    const games = [
      game(['a'], ['c'], 'A', [0, 0]),
      game(['a'], ['c'], 'A', [0, 0]),
      game(['a'], ['c'], 'A', [0, 0]),
      game(['b'], ['d'], 'A', [11, 9]),
    ];
    const r = computeAwards({ scope: 'session', games, names: NAMES });
    expect(winnersOf(r, 'most_wins')).toEqual([['a']]);
    expect(winnersOf(r, 'hot_streak')).toEqual([['a']]);
    expect(winnersOf(r, 'point_machine')).toEqual([['b']]);
    expect(award(r, 'point_machine')?.explanation).toMatch(/across 1 scored game /);
    expect(winnersOf(r, 'clutch')).toEqual([['b']]);
  });

  it('only score-less games: no point or close-game awards at all', () => {
    const games = [game(['a'], ['b'], 'A', [0, 0]), game(['a'], ['b'], 'A', [0, 0])];
    const r = computeAwards({ scope: 'session', games, names: NAMES });
    expect(award(r, 'point_machine')).toBeUndefined();
    expect(award(r, 'clutch')).toBeUndefined();
    expect(award(r, 'champion')?.explanation).not.toMatch(/point/);
  });

  it('a game flagged score-less is excluded from close games even with a score', () => {
    const r = computeAwards({ scope: 'session', games: [game(['a'], ['b'], 'A', [11, 10], { scoreless: true })], names: NAMES });
    expect(award(r, 'clutch')).toBeUndefined();
  });
});

describe('src/core/awards stays pure', () => {
  it('imports nothing from data, main, renderer or Node', () => {
    const dir = resolve(process.cwd(), 'src/core/awards');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src).not.toMatch(/from\s+['"](\.\.\/)+(data|main|renderer|preload)/);
      expect(src).not.toMatch(/from\s+['"](node:|fs|path|electron|better-sqlite3)/);
    }
  });
});

describe('getAwards (database)', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pbop-awards-'));
    db = openDatabase(join(dir, 'app.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function session(name: string, startedAt: string, playerIds?: string[]) {
    const s = createSession(db, { name, courtCount: 2, startedAt });
    const ids =
      playerIds ??
      ['Ana', 'Ben', 'Cy', 'Dee'].map((displayName) => addNewPlayerToSession(db, s.id, { displayName }).playerId);
    if (playerIds) for (const id of playerIds) addPlayerToSession(db, s.id, id);
    for (const id of ids) checkInPlayer(db, s.id, id);
    const court = (listCourts(db, s.id)[0] as { id: string }).id;
    return { id: s.id, ids, court };
  }

  function play(s: { id: string; ids: string[]; court: string }, teams: [number, number, number, number], winner: 'A' | 'B', score?: [number, number]) {
    const g = createGame(db, {
      sessionId: s.id,
      courtId: s.court,
      format: 'doubles',
      teamA: [s.ids[teams[0]] as string, s.ids[teams[1]] as string],
      teamB: [s.ids[teams[2]] as string, s.ids[teams[3]] as string],
    });
    return recordGameResult(db, g.id, score ? { winner, scoreA: score[0], scoreB: score[1] } : { winner });
  }

  it('builds session awards from finalized games with player names', () => {
    const s = session('Thursday', '2026-10-21T18:00:00.000Z');
    play(s, [0, 1, 2, 3], 'A', [11, 9]);
    play(s, [0, 1, 2, 3], 'A', [11, 4]);
    play(s, [0, 2, 1, 3], 'A'); // score-less
    const r = getAwards(db, { kind: 'session', sessionId: s.id });
    expect(r.scopeLabel).toBe('Thursday');
    expect(r.sessionId).toBe(s.id);
    expect(r.finalizedGames).toBe(3);
    expect(award(r, 'champion')?.groups).toEqual([[{ playerId: s.ids[0], name: 'Ana' }]]);
    expect(formatWinners(award(r, 'dynamic_duo')?.groups ?? [])).toBe('Ana & Ben');
    // Point Machine is from the two scored games only: Ana and Ben +9 each -> shared, Ana first on D9.
    expect(award(r, 'point_machine')?.groups.flat().map((w) => w.name)).toEqual(['Ana']);
    expect(award(r, 'point_machine')?.stat).toBe('+9');
  });

  it('rally-scored games count with their real score', () => {
    const s = session('Rally night', '2026-10-21T18:00:00.000Z');
    const g = createGame(db, { sessionId: s.id, courtId: s.court, format: 'doubles', teamA: [s.ids[0] as string, s.ids[1] as string], teamB: [s.ids[2] as string, s.ids[3] as string] });
    startScoring(db, g.id, { firstServingTeam: 'A', targetScore: 3, winBy: 1 });
    for (let i = 0; i < 20; i++) {
      const state = recordScoringEvent(db, g.id, { type: 'rally', winner: 'A' });
      if (state.isOver) break;
    }
    finalizeGame(db, g.id);
    const r = getAwards(db, { kind: 'session', sessionId: s.id });
    expect(r.finalizedGames).toBe(1);
    expect(award(r, 'point_machine')?.stat).toBe('+3');
  });

  it('a session with no finalized games has no awards; unknown sessions are refused', () => {
    const s = session('Empty', '2026-10-21T18:00:00.000Z');
    expect(getAwards(db, { kind: 'session', sessionId: s.id })).toMatchObject({ finalizedGames: 0, awards: [], podium: [] });
    expect(() => getAwards(db, { kind: 'session', sessionId: 'nope' })).toThrow(/Unknown session/);
  });

  it('all time combines sessions (completed ones too) in chronological order', () => {
    const first = session('Week 1', '2026-10-07T18:00:00.000Z');
    play(first, [0, 1, 2, 3], 'B', [5, 11]);
    play(first, [0, 2, 1, 3], 'B', [5, 11]);
    play(first, [0, 3, 1, 2], 'A', [11, 5]);
    finishSession(db, first.id);
    const second = session('Week 2', '2026-10-14T18:00:00.000Z', first.ids);
    play(second, [0, 1, 2, 3], 'A', [11, 6]);
    play(second, [0, 2, 1, 3], 'A', [11, 6]);
    const r = getAwards(db, { kind: 'historical' });
    expect(r.scopeLabel).toBe('All sessions');
    expect(r.finalizedGames).toBe(5);
    expect(r.provisional).toBe(true); // nobody has 10 games
    expect(award(r, 'rising_star')?.groups.flat().map((w) => w.name)).toEqual(['Ana']);
    expect(award(r, 'rising_star')?.explanation).toBe('Win rate up from 33% to 100% in Week 2.');
  });
});

describe('awards through the API handlers', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pbop-awards-api-'));
    db = openDatabase(join(dir, 'app.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function handlers(extra: Partial<HostServices> = {}) {
    const modes: DisplayMode[] = [];
    const store: DbStore = { current: () => db, close: () => undefined, open: () => undefined };
    const host: HostServices = {
      appVersion: 'test',
      dbFile: join(dir, 'app.db'),
      autoBackupDir: join(dir, 'auto'),
      chooseDirectory: async () => null,
      chooseSaveFile: async () => null,
      chooseOpenFile: async () => null,
      confirm: async () => false,
      openDisplay: () => undefined,
      showOnDisplay: (mode) => modes.push(mode),
      ...extra,
    };
    return { api: createApiHandlers(store, host), modes };
  }

  it('getAwards validates the scope shape', async () => {
    const { api } = handlers();
    expect(await api.getAwards({ kind: 'historical' })).toMatchObject({ ok: true, value: { finalizedGames: 0 } });
    expect(await api.getAwards({ kind: 'bogus' })).toMatchObject({ ok: false, code: 'validation' });
    expect(await api.getAwards({ kind: 'session', sessionId: 'missing' })).toMatchObject({ ok: false, code: 'validation' });
  });

  it('switches the display between the awards ceremony and the courts', async () => {
    const { api, modes } = handlers();
    const s = createSession(db, { name: 'Night', courtCount: 2 });
    expect(await api.showAwardsOnDisplay({ kind: 'session', sessionId: s.id })).toMatchObject({ ok: true });
    expect(await api.showCourtsOnDisplay()).toMatchObject({ ok: true });
    expect(await api.showAwardsOnDisplay({ kind: 'session', sessionId: 'missing' })).toMatchObject({ ok: false });
    expect(modes).toEqual([{ kind: 'awards', scope: { kind: 'session', sessionId: s.id } }, { kind: 'courts' }]);
  });

  it('saving an image needs finalized games and returns null when the save dialog is cancelled', async () => {
    let captured = 0;
    const { api } = handlers({
      captureAwardsImage: async () => {
        captured++;
        return new Uint8Array([137, 80, 78, 71]);
      },
    });
    expect(await api.saveAwardsImage({ kind: 'historical' })).toMatchObject({ ok: false, code: 'validation' });
    const s = createSession(db, { name: 'Night', courtCount: 2 });
    const ids = ['A1', 'B1'].map((displayName) => addNewPlayerToSession(db, s.id, { displayName }).playerId);
    for (const id of ids) checkInPlayer(db, s.id, id);
    const g = createGame(db, { sessionId: s.id, courtId: (listCourts(db, s.id)[0] as { id: string }).id, format: 'singles', teamA: [ids[0] as string], teamB: [ids[1] as string] });
    recordGameResult(db, g.id, { winner: 'A', scoreA: 11, scoreB: 3 });
    expect(await api.saveAwardsImage({ kind: 'session', sessionId: s.id })).toEqual({ ok: true, value: null });
    expect(captured).toBe(1);
  });
});
