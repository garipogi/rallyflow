/*
 * ============================================================================
 * PHASE 3 PUBLIC API (pinned by the locked tests; the builder implements it).
 * Policies: docs/DECISIONS.md D1–D7 (brief §5 B, §6 "Court and match assignment").
 * Builds on the locked phase 1/2 APIs (src/data/sessions, roster, courts, games, scoring) and
 * does not change them. Times are ISO-8601 instants; "now" is always an input (fake clock).
 *
 * src/core/rotation/index.ts  (pure: no I/O, no Date.now()/new Date() for "now", no imports from
 *                              src/data, src/main, src/renderer, node:* or electron)
 *   type GameFormat = 'singles' | 'doubles'
 *   type DeclinePolicy =                              D1
 *     | { kind: 'back_of_queue' }                     default: eligibleSince := time of declining
 *     | { kind: 'keep_spot' }                         keep eligibleSince, skip this turn only
 *     | { kind: 'drop_places'; places: number }       move exactly `places` positions further back
 *                                                    in the queue (or to the end); positive integer
 *   interface RotationSettings {
 *     format: GameFormat; declinePolicy: DeclinePolicy; skillBalancing: boolean; partnerRotation: boolean }
 *   const DEFAULT_ROTATION_SETTINGS: RotationSettings
 *       = { format: 'doubles', declinePolicy: { kind: 'back_of_queue' }, skillBalancing: false,
 *           partnerRotation: false }
 *   playersNeeded(format: GameFormat): number        doubles 4, singles 2
 *   class RotationError extends Error
 *       duplicate player or court ids in the input, unparseable `now`/`at`, applyDecline on a player
 *       who is unknown or not 'waiting', drop_places whose `places` is not a positive integer
 *   interface QueuePlayer {                           extra OPTIONAL fields are allowed
 *     playerId: string; displayName: string;
 *     checkedInAt: string;                            session check-in (D2 second key, D3)
 *     eligibleSince: string;                          when the player became eligible (D3/D4/D5/D1)
 *     status: 'waiting' | 'playing' | 'unavailable';  playing = in an active game;
 *                                                    unavailable = resting/unavailable/away
 *     gamesPlayed: number;                            games played this session (D2 third key)
 *     skillLevel: number | null;
 *     declinedCurrentTurn?: boolean;                  true = excluded from recommendations this turn
 *   }
 *   interface QueueEntry { playerId: string; displayName: string; position: number;   1-based
 *     eligibleSince: string; checkedInAt: string; gamesPlayed: number;
 *     waitedMs: number;                               now - eligibleSince
 *     declinedCurrentTurn: boolean }
 *   orderQueue(players: readonly QueuePlayer[], now: string): QueueEntry[]
 *       every 'waiting' player (declined ones included, at their queue position), ordered by
 *       eligibleSince (oldest first) → earlier checkedInAt → fewer gamesPlayed → playerId
 *       (plain string comparison, '<'). D2. Never mutates its input.
 *   applyDecline(players, playerId: string, at: string, policy: DeclinePolicy): QueuePlayer[]
 *       new array (input untouched); the player gets declinedCurrentTurn: true and the queue
 *       position the policy defines (back_of_queue: eligibleSince = at).
 *   startNewTurn(players): QueuePlayer[]               clears declinedCurrentTurn; positions kept
 *   interface CourtInput { courtId: string; label: string; status: 'available' | 'unavailable';
 *                          occupied: boolean }        occupied = has an active game
 *   interface PastGame { teamA: readonly string[]; teamB: readonly string[] }
 *   interface RotationInput { now: string; players: readonly QueuePlayer[];
 *     courts: readonly CourtInput[];                  in court-number order
 *     settings: RotationSettings; pastGames?: readonly PastGame[] }   pastGames: this session's games
 *   interface PlayerReason { playerId: string; displayName: string; queuePosition: number;
 *                            eligibleSince: string; waitedMs: number }
 *   interface Recommendation {
 *     courtId: string; courtLabel: string; format: GameFormat;
 *     playerIds: string[];                            the chosen players, in queue order
 *     teamA: string[]; teamB: string[];               a split of playerIds (2+2 or 1+1)
 *     reasons: PlayerReason[];                        one per chosen player, same order as playerIds;
 *                                                    queuePosition = position in orderQueue(players, now)
 *     bypassed: string[];                             eligible players still waiting (not chosen for
 *                                                    this or an earlier court) whose queue position is
 *                                                    ahead of a chosen player; [] without skill balancing
 *     repeatPartnerships: number;                     sum over the two teams of how often that pair
 *                                                    were partners in pastGames (0 for singles)
 *     explanation: string;                            human-readable: contains courtLabel, every chosen
 *                                                    player's displayName and, for each, the text
 *                                                    `${Math.floor(waitedMs / 60000)} min`, and the word
 *                                                    "wait"; names every bypassed player and the word
 *                                                    "skill" when bypassed is non-empty; contains
 *                                                    "partner" when partnerRotation is on (doubles)
 *   }
 *   interface OpenCourt { courtId: string; courtLabel: string; needed: number; available: number;
 *                         reason: string }            a free court left open: too few eligible players
 *   interface SkippedCourt { courtId: string; reason: 'unavailable' | 'occupied' }
 *   interface ExcludedPlayer { playerId: string; reason: 'playing' | 'unavailable' | 'declined' }
 *   interface RecommendationResult { recommendations: Recommendation[]; openCourts: OpenCourt[];
 *                                    skippedCourts: SkippedCourt[]; excluded: ExcludedPlayer[] }
 *   recommend(input: RotationInput): RecommendationResult
 *       Eligible = status 'waiting' and not declinedCurrentTurn. Free courts (available, not
 *       occupied) are filled one at a time in the given order, each from the eligible players not
 *       already chosen for an earlier court. A court that cannot get playersNeeded players is left
 *       open (brief §5 A) and later courts are open too. No player appears twice in one result.
 *       Plain queue (skillBalancing off): the first playersNeeded remaining eligible players.
 *       D6 skill balancing on: window = the first playersNeeded + 2 remaining eligible players; the
 *         chosen players must include window[0] (the oldest-waiting remaining player) and come only
 *         from the window; choose players + split minimising |sum skill A − sum skill B|; among equally
 *         balanced choices prefer the set whose sorted queue positions are lexicographically smallest.
 *       D7 partner rotation on: never changes who plays; among the splits of the chosen players
 *         (only those equally best-balanced when skill balancing is also on) choose one with the
 *         fewest repeatPartnerships.
 *       excluded lists every input player who is not eligible, with the reason.
 *
 * src/data/rotation.ts  (writes are one transaction each; a rejected call writes nothing; unknown
 *   session → ValidationError; writes on a completed session → SessionReadOnlyError)
 *   interface RotationEvent { id: string; sessionId: string; occurredAt: string;
 *                             type: string; data: Record<string, unknown> }
 *   getRotationSettings(db, sessionId): RotationSettings     DEFAULT_ROTATION_SETTINGS until changed
 *   setRotationSettings(db, sessionId, patch: Partial<RotationSettings>, opts?: { at?: string }): RotationSettings
 *       persisted per session (survives closing/reopening the DB file); ValidationError for an
 *       invalid policy (e.g. drop_places with places 0 or 1.5); logs RotationEvent
 *       type 'settings_changed', data { settings: RotationSettings } (the new settings)
 *   getQueue(db, sessionId, opts?: { at?: string }): QueueEntry[]
 *       orderQueue over the roster players who are checked in, 'available' and not in an
 *       'in_progress' game, with
 *         eligibleSince = the latest of: checkedInAt (D3); endedAt of the player's latest ended
 *           ('completed' or 'incomplete') game in this session (D5, winners and losers alike); the
 *           time of their latest back_of_queue decline (D1). Resting/unavailable time changes
 *           nothing (D4).
 *         gamesPlayed = the player's 'completed' + 'incomplete' games in this session.
 *   recommendNextGames(db, sessionId, opts?: { at?: string; format?: GameFormat }): RecommendationResult
 *       recommend() over the session: courts from listCourts, occupied = has an 'in_progress' game;
 *       players = checked-in roster players (status from availability / active games); settings
 *       from getRotationSettings (format overridable per call); pastGames = the session's games
 *       that are not 'cancelled'; skillLevel from the player. Read-only: writes nothing.
 *   assignRecommendation(db, sessionId, rec: Recommendation, opts?: { at?: string }): Game
 *       starts the game via phase-1 createGame rules (startedAt = at) and logs RotationEvent
 *       type 'assigned', data { gameId, courtId, playerIds, teamA, teamB, explanation }.
 *       ValidationError (nothing written) when a player is not available, is already in an
 *       'in_progress' game, or the court is unavailable or occupied.
 *   assignManually(db, sessionId, { courtId: string; format: GameFormat; teamA: string[];
 *                  teamB: string[]; reason: string; at?: string }): Game
 *       organizer override. ValidationError (nothing written) if reason is blank after trim or
 *       createGame would reject. Logs RotationEvent type 'override', data { gameId, courtId,
 *       playerIds, teamA, teamB, reason (trimmed), recommendedPlayerIds } where
 *       recommendedPlayerIds = what recommendNextGames (session settings, no format override)
 *       would have chosen for that court just before ([] if it would have stayed open).
 *   declineTurn(db, sessionId, playerId, opts?: { at?: string }): QueueEntry[]
 *       applies the session's declinePolicy; returns getQueue right after. ValidationError if the
 *       player is not waiting (not checked in, not available, or in a game). Logs RotationEvent
 *       type 'declined', data { playerId, policy: DeclinePolicy }. The declined player is excluded
 *       from recommendations until the turn ends: the next successful assignRecommendation or
 *       assignManually in that session. Persisted (survives reopening the DB file).
 *   listRotationEvents(db, sessionId): RotationEvent[]       insertion order
 * ============================================================================
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ROTATION_SETTINGS,
  orderQueue,
  recommend,
  type CourtInput,
  type QueuePlayer,
  type Recommendation,
  type RotationSettings,
} from '../../src/core/rotation';
import { openDatabase, type Db } from '../../src/data/db';
import { createSession } from '../../src/data/sessions';
import { listCourts, setCourtStatus } from '../../src/data/courts';
import { addNewPlayerToSession, checkInPlayer } from '../../src/data/roster';
import { finalizeGame, recordScoringEvent, startScoring } from '../../src/data/scoring';
import {
  assignRecommendation,
  getQueue,
  getRotationSettings,
  listRotationEvents,
  recommendNextGames,
  setRotationSettings,
} from '../../src/data/rotation';
import type { Court, Session } from '../../src/data/types';

// ---------------------------------------------------------------- fake clock
const T0 = Date.parse('2026-10-21T18:00:00.000Z');
const at = (min: number): string => new Date(T0 + Math.round(min * 60000)).toISOString();

function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function qp(id: string, eligibleMin: number, extra: Partial<QueuePlayer> = {}): QueuePlayer {
  return {
    playerId: id,
    displayName: `Name-${id}`,
    checkedInAt: at(eligibleMin),
    eligibleSince: at(eligibleMin),
    status: 'waiting',
    gamesPlayed: 0,
    skillLevel: null,
    ...extra,
  };
}

/** Players p1..pn in queue order with the given skill levels. */
function skilled(levels: number[]): QueuePlayer[] {
  return levels.map((skill, i) => qp(`p${i + 1}`, i, { skillLevel: skill }));
}

function courts(n: number): CourtInput[] {
  return Array.from({ length: n }, (_, i) => ({
    courtId: `c${i + 1}`,
    label: `Court ${i + 1}`,
    status: 'available' as const,
    occupied: false,
  }));
}

const settings = (patch: Partial<RotationSettings> = {}): RotationSettings => ({ ...DEFAULT_ROTATION_SETTINGS, ...patch });
const BAL = settings({ skillBalancing: true });
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function skillOf(players: readonly QueuePlayer[], id: string): number {
  return must(must(players.find((p) => p.playerId === id)).skillLevel);
}

function teamDiff(players: readonly QueuePlayer[], rec: Recommendation): number {
  const sum = (team: readonly string[]): number => team.reduce((acc, id) => acc + skillOf(players, id), 0);
  return Math.abs(sum(rec.teamA) - sum(rec.teamB));
}

function combinations<T>(items: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...rest] = items as [T, ...T[]];
  return [...combinations(rest, k - 1).map((c) => [head, ...c]), ...combinations(rest, k)];
}

/** Best |A − B| over all 2+2 (or 1+1) splits of a set of skills. */
function bestSplitDiff(skills: number[]): number {
  if (skills.length === 2) return Math.abs(must(skills[0]) - must(skills[1]));
  const [a, b, c, d] = skills as [number, number, number, number];
  return Math.min(Math.abs(a + b - c - d), Math.abs(a + c - b - d), Math.abs(a + d - b - c));
}

function lexLess(x: number[], y: number[]): boolean {
  for (let i = 0; i < x.length; i++) {
    if (must(x[i]) !== must(y[i])) return must(x[i]) < must(y[i]);
  }
  return false;
}

// =========================================================================
describe('AC-16 skill balancing (D6): off by default, never bypasses the queue unfairly (pure engine)', () => {
  it('is off by default: the plain queue decides, whatever the skill levels', () => {
    const players = skilled([5, 5, 5, 1, 1, 5]);
    const rec = must(recommend({ now: at(30), players, courts: courts(1), settings: DEFAULT_ROTATION_SETTINGS }).recommendations[0]);
    expect(rec.playerIds).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(rec.bypassed).toEqual([]);
  });

  it('with equal skills, turning it on changes nothing about who plays', () => {
    const players = skilled([3, 3, 3, 3, 3, 3, 3, 3, 3]);
    const off = recommend({ now: at(30), players, courts: courts(2), settings: settings() });
    const on = recommend({ now: at(30), players, courts: courts(2), settings: BAL });
    expect(on.recommendations.map((x) => x.playerIds)).toEqual(off.recommendations.map((x) => x.playerIds));
    for (const rec of on.recommendations) expect(rec.bypassed).toEqual([]);
  });

  it('chooses the best-balanced group from the window, preferring queue order among equally balanced groups', () => {
    // top four (5,5,5,1) can only be split 6 v 10. Inside the window of 6:
    //   {p1,p2,p3,p6} = 5,5,5,5 → 0, positions [1,2,3,6]
    //   {p1,p2,p4,p5} = 5,5,1,1 → 0, positions [1,2,4,5]   ([1,2,3,6] is lexicographically smaller)
    const players = skilled([5, 5, 5, 1, 1, 5]);
    const rec = must(recommend({ now: at(30), players, courts: courts(1), settings: BAL }).recommendations[0]);
    expect(rec.playerIds).toEqual(['p1', 'p2', 'p3', 'p6']);
    expect(teamDiff(players, rec)).toBe(0);
    expect(rec.bypassed).toEqual(['p4', 'p5']);
  });

  it('a bypass is never silent: the explanation names who was passed over and says it was for skill balance', () => {
    const players = skilled([5, 5, 5, 1, 1, 5]).map((p, i) => ({ ...p, displayName: ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay'][i] ?? 'x' }));
    const rec = must(recommend({ now: at(30), players, courts: courts(1), settings: BAL }).recommendations[0]);
    expect(rec.explanation).toContain('Dee');
    expect(rec.explanation).toContain('Eve');
    expect(rec.explanation.toLowerCase()).toContain('skill');
    for (const name of ['Ana', 'Ben', 'Cy', 'Fay']) expect(rec.explanation).toContain(name);
  });

  it('never looks beyond the window of playersNeeded + 2, even when a later player would balance perfectly', () => {
    // with p7 (9) the game would be 9+1 v 9+1; but p7 is 7th, outside the window of 6
    const players = skilled([9, 1, 1, 1, 1, 1, 9]);
    const rec = must(recommend({ now: at(30), players, courts: courts(1), settings: BAL }).recommendations[0]);
    expect(rec.playerIds).not.toContain('p7');
    expect(rec.playerIds).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(teamDiff(players, rec)).toBe(8);
    expect(rec.bypassed).toEqual([]);
  });

  it('always includes the single oldest-waiting player, even when leaving them out would balance better', () => {
    const players = skilled([10, 3, 3, 3, 3, 3]);
    const rec = must(recommend({ now: at(30), players, courts: courts(1), settings: BAL }).recommendations[0]);
    expect(rec.playerIds).toContain('p1');
    expect(rec.playerIds).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('the oldest-waiting rule uses the real queue order, not the order players were passed in', () => {
    const players = [
      qp('late-strong', 20, { skillLevel: 10 }),
      qp('early', 0, { skillLevel: 3 }),
      qp('b', 1, { skillLevel: 3 }),
      qp('c', 2, { skillLevel: 3 }),
      qp('d', 3, { skillLevel: 3 }),
      qp('e', 4, { skillLevel: 3 }),
    ];
    const rec = must(recommend({ now: at(30), players, courts: courts(1), settings: BAL }).recommendations[0]);
    expect(rec.playerIds).toContain('early');
    expect(rec.playerIds).not.toContain('late-strong');
  });

  it('singles: window of 4, oldest included, best balance', () => {
    // {p1,p4}: 5 v 5 → 0 ; {p1,p3}: 5 v 4 → 1 ; {p1,p2}: 5 v 2 → 3
    const players = skilled([5, 2, 4, 5, 5]);
    const rec = must(recommend({ now: at(30), players, courts: courts(1), settings: settings({ format: 'singles', skillBalancing: true }) })
      .recommendations[0]);
    expect(rec.playerIds).toEqual(['p1', 'p4']);
    expect(rec.bypassed).toEqual(['p2', 'p3']);
  });

  it('with several courts, each later court balances within the window of the players still waiting and includes the oldest of them', () => {
    // court 1: window p1..p6 → {p1,p2,p3,p6} (all 5s). Remaining queue: p4,p5,p7,p8,p9,p10,p11
    // court 2: window p4,p5,p7,p8,p9,p10 must contain p4.
    const players = skilled([5, 5, 5, 1, 1, 5, 2, 4, 3, 2, 1]);
    const r = recommend({ now: at(60), players, courts: courts(2), settings: BAL });
    expect(must(r.recommendations[0]).playerIds).toEqual(['p1', 'p2', 'p3', 'p6']);
    const second = must(r.recommendations[1]);
    expect(second.playerIds).toContain('p4');
    for (const id of second.playerIds) expect(['p4', 'p5', 'p7', 'p8', 'p9', 'p10']).toContain(id);
    expect(teamDiff(players, second)).toBe(0);
    for (const id of second.playerIds) expect(must(r.recommendations[0]).playerIds).not.toContain(id);
  });

  it('property: the chosen group is always optimally balanced within the window and as queue-fair as possible', () => {
    const r = rng(16);
    for (let iter = 0; iter < 300; iter++) {
      const format = r() < 0.25 ? ('singles' as const) : ('doubles' as const);
      const need = format === 'doubles' ? 4 : 2;
      const n = need + Math.floor(r() * 8);
      const players = Array.from({ length: n }, (_, i) =>
        qp(`p${i}`, Math.floor(r() * 40), { checkedInAt: at(-i), skillLevel: 1 + Math.floor(r() * 7) }),
      );
      const s = settings({ format, skillBalancing: true });
      const rec = must(recommend({ now: at(50), players, courts: courts(1), settings: s }).recommendations[0]);
      const order = orderQueue(players, at(50)).map((e) => e.playerId);
      const window = order.slice(0, need + 2);
      expect(rec.playerIds).toContain(window[0]);
      for (const id of rec.playerIds) expect(window).toContain(id);

      // brute-force optimum over every allowed group (contains window[0], drawn from the window)
      const groups = combinations(window.slice(1), need - 1).map((rest) => [must(window[0]), ...rest]);
      let best = Number.POSITIVE_INFINITY;
      let bestPositions: number[] = [];
      for (const g of groups) {
        const d = bestSplitDiff(g.map((id) => skillOf(players, id)));
        const positions = g.map((id) => order.indexOf(id) + 1).sort((x, y) => x - y);
        if (d < best || (d === best && lexLess(positions, bestPositions))) {
          best = d;
          bestPositions = positions;
        }
      }
      expect(teamDiff(players, rec)).toBe(best);
      expect(rec.playerIds.map((id) => order.indexOf(id) + 1).sort((x, y) => x - y)).toEqual(bestPositions);
      // bypassed = window players ahead of a chosen player who were not chosen
      const lastChosen = Math.max(...rec.playerIds.map((id) => order.indexOf(id)));
      const expectedBypassed = order.slice(0, lastChosen).filter((id) => !rec.playerIds.includes(id));
      expect(sorted(rec.bypassed)).toEqual(sorted(expectedBypassed));
    }
  });
});

// =========================================================================
// Data layer: enabling and disabling per session

let dir = '';
const opened: Db[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbop-p3-skill-'));
});

afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function openAt(file: string): Db {
  const db = openDatabase(file);
  opened.push(db);
  return db;
}

interface World {
  db: Db;
  file: string;
  session: Session;
  courts: Court[];
  p: string[];
}

function world(levels: number[], courtCount = 2): World {
  const file = join(dir, 'skill.db');
  const db = openAt(file);
  const session = createSession(db, { name: 'Balanced night', courtCount, startedAt: at(-30) });
  const p: string[] = [];
  levels.forEach((skillLevel, i) => {
    const entry = addNewPlayerToSession(db, session.id, { displayName: `P${i + 1}`, skillLevel });
    checkInPlayer(db, session.id, entry.playerId, at(i));
    p.push(entry.playerId);
  });
  return { db, file, session, courts: listCourts(db, session.id), p };
}

function playOut(db: Db, gameId: string, endedMin: number): void {
  startScoring(db, gameId, { firstServingTeam: 'A' });
  for (let i = 0; i < 11; i++) recordScoringEvent(db, gameId, { type: 'rally', winner: 'A' });
  finalizeGame(db, gameId, { endedAt: at(endedMin) });
}

describe('AC-16 skill balancing can be enabled and disabled per session without breaking fairness (data layer)', () => {
  it('toggling it on and off switches between balanced and plain recommendations, using players\' skill levels', () => {
    const w = world([5, 5, 5, 1, 1, 5]);
    expect(getRotationSettings(w.db, w.session.id).skillBalancing).toBe(false);
    expect(must(recommendNextGames(w.db, w.session.id, { at: at(30) }).recommendations[0]).playerIds).toEqual(w.p.slice(0, 4));

    expect(setRotationSettings(w.db, w.session.id, { skillBalancing: true }, { at: at(30) }).skillBalancing).toBe(true);
    const on = must(recommendNextGames(w.db, w.session.id, { at: at(30) }).recommendations[0]);
    expect(on.playerIds).toEqual([w.p[0], w.p[1], w.p[2], w.p[5]]);
    expect(on.bypassed).toEqual([w.p[3], w.p[4]]);
    expect(on.explanation.toLowerCase()).toContain('skill');

    setRotationSettings(w.db, w.session.id, { skillBalancing: false }, { at: at(31) });
    const off = must(recommendNextGames(w.db, w.session.id, { at: at(31) }).recommendations[0]);
    expect(off.playerIds).toEqual(w.p.slice(0, 4));
    expect(off.bypassed).toEqual([]);

    const changes = listRotationEvents(w.db, w.session.id).filter((e) => e.type === 'settings_changed');
    expect(changes.map((e) => (e.data.settings as RotationSettings).skillBalancing)).toEqual([true, false]);
  });

  it('the setting is per session and survives reopening the database', () => {
    const w = world([5, 5, 5, 1, 1, 5]);
    const other = createSession(w.db, { name: 'Other night', courtCount: 2 });
    setRotationSettings(w.db, w.session.id, { skillBalancing: true });
    expect(getRotationSettings(w.db, other.id).skillBalancing).toBe(false);
    w.db.close();
    const db = openAt(w.file);
    expect(getRotationSettings(db, w.session.id)).toEqual({ ...DEFAULT_ROTATION_SETTINGS, skillBalancing: true });
    expect(must(recommendNextGames(db, w.session.id, { at: at(30) }).recommendations[0]).playerIds).toEqual([
      w.p[0],
      w.p[1],
      w.p[2],
      w.p[5],
    ]);
  });

  it('over a run of games with balancing on, every game contains the oldest-waiting player and bypassed players are not left behind', () => {
    // one court in use; 6 players of mixed skill play 6 games in a row
    const w = world([5, 1, 4, 2, 5, 3], 2);
    setCourtStatus(w.db, must(w.courts[1]).id, 'unavailable');
    setRotationSettings(w.db, w.session.id, { skillBalancing: true });
    const sitOuts = new Map<string, number>(w.p.map((id) => [id, 0]));
    let minute = 10;
    for (let game = 0; game < 6; game++) {
      const queue = getQueue(w.db, w.session.id, { at: at(minute) });
      const rec = must(recommendNextGames(w.db, w.session.id, { at: at(minute) }).recommendations[0]);
      expect(rec.playerIds).toContain(must(queue[0]).playerId);
      for (const id of rec.playerIds) expect(queue.slice(0, 6).map((e) => e.playerId)).toContain(id);
      for (const id of w.p) {
        if (rec.playerIds.includes(id)) sitOuts.set(id, 0);
        else sitOuts.set(id, (sitOuts.get(id) ?? 0) + 1);
        // with 6 players and 4 places, nobody can be passed over three games running when they are
        // the oldest-waiting player at the start of the next game
        expect(sitOuts.get(id) ?? 0).toBeLessThanOrEqual(2);
      }
      const g = assignRecommendation(w.db, w.session.id, rec, { at: at(minute) });
      minute += 15;
      playOut(w.db, g.id, minute);
      minute += 1;
    }
  });
});
