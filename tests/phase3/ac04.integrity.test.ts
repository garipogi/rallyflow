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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ROTATION_SETTINGS,
  orderQueue,
  playersNeeded,
  recommend,
  type CourtInput,
  type DeclinePolicy,
  type QueuePlayer,
  type RecommendationResult,
  type RotationSettings,
} from '../../src/core/rotation';
import { openDatabase, type Db } from '../../src/data/db';
import { SessionReadOnlyError, ValidationError } from '../../src/data/errors';
import { createSession, finishSession } from '../../src/data/sessions';
import { listCourts, setCourtStatus } from '../../src/data/courts';
import {
  addNewPlayerToSession,
  checkInPlayer,
  listRoster,
  removePlayerFromSession,
  setAvailability,
} from '../../src/data/roster';
import { listActiveGames, listGames, markGameIncomplete } from '../../src/data/games';
import { finalizeGame, recordScoringEvent, startScoring } from '../../src/data/scoring';
import {
  assignManually,
  assignRecommendation,
  declineTurn,
  getQueue,
  listRotationEvents,
  recommendNextGames,
  setRotationSettings,
} from '../../src/data/rotation';
import type { Court, Game, GameFormat, Session } from '../../src/data/types';

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

function courts(n: number): CourtInput[] {
  return Array.from({ length: n }, (_, i) => ({
    courtId: `c${i + 1}`,
    label: `Court ${i + 1}`,
    status: 'available' as const,
    occupied: false,
  }));
}

const settings = (patch: Partial<RotationSettings> = {}): RotationSettings => ({ ...DEFAULT_ROTATION_SETTINGS, ...patch });
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

/** Deterministic PRNG (mulberry32) so every property run is reproducible. */
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
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

/**
 * Invariants every recommendation result must satisfy, whatever the settings:
 * no player twice, only eligible players, only free courts, right team sizes, every chosen group
 * contains the oldest-waiting eligible player still unchosen, plain mode takes the exact queue prefix.
 */
function checkResult(
  result: RecommendationResult,
  players: readonly QueuePlayer[],
  courtList: readonly CourtInput[],
  s: RotationSettings,
  now: string,
): void {
  const need = playersNeeded(s.format);
  const eligibleOrder = orderQueue(players, now)
    .filter((e) => !e.declinedCurrentTurn)
    .map((e) => e.playerId);
  const byId = new Map(players.map((p) => [p.playerId, p]));
  const seen = new Set<string>();
  const usedCourts = new Set<string>();
  const remaining = [...eligibleOrder];
  for (const rec of result.recommendations) {
    const court = must(courtList.find((c) => c.courtId === rec.courtId), `court ${rec.courtId}`);
    expect(court.status).toBe('available');
    expect(court.occupied).toBe(false);
    expect(usedCourts.has(rec.courtId)).toBe(false);
    usedCourts.add(rec.courtId);
    expect(rec.format).toBe(s.format);
    expect(rec.playerIds).toHaveLength(need);
    expect(rec.teamA).toHaveLength(need / 2);
    expect(rec.teamB).toHaveLength(need / 2);
    expect(sorted([...rec.teamA, ...rec.teamB])).toEqual(sorted(rec.playerIds));
    for (const id of rec.playerIds) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      const p = must(byId.get(id), `player ${id}`);
      expect(p.status).toBe('waiting');
      expect(p.declinedCurrentTurn ?? false).toBe(false);
    }
    // the oldest-waiting remaining player is never dropped (plain, D6 and D7 alike)
    expect(rec.playerIds).toContain(remaining[0]);
    if (!s.skillBalancing) {
      expect(rec.playerIds).toEqual(remaining.slice(0, need));
    } else {
      const window = remaining.slice(0, need + 2);
      for (const id of rec.playerIds) expect(window).toContain(id);
    }
    for (const id of rec.playerIds) remaining.splice(remaining.indexOf(id), 1);
  }
  // a court is left without a recommendation only if it is not free, or too few players remain
  for (const c of courtList) {
    if (usedCourts.has(c.courtId)) continue;
    if (c.status === 'available' && !c.occupied) {
      expect(remaining.length).toBeLessThan(need);
      expect(result.openCourts.map((o) => o.courtId)).toContain(c.courtId);
    } else {
      expect(result.skippedCourts.map((x) => x.courtId)).toContain(c.courtId);
    }
  }
}

// =========================================================================
describe('AC-04 assignment integrity: the engine never recommends a busy player or an unusable court', () => {
  it('players already in an active game and unavailable players are never recommended', () => {
    const players = [
      qp('a', 0, { status: 'playing' }),
      qp('b', 1, { status: 'playing' }),
      qp('c', 2, { status: 'unavailable' }),
      qp('d', 3),
      qp('e', 4),
      qp('f', 5),
      qp('g', 6),
      qp('h', 7),
    ];
    const r = recommend({ now: at(20), players, courts: courts(2), settings: settings() });
    expect(r.recommendations).toHaveLength(1);
    expect(must(r.recommendations[0]).playerIds).toEqual(['d', 'e', 'f', 'g']);
  });

  it('unavailable and occupied courts are skipped (with the reason); the next free court gets the group', () => {
    const list: CourtInput[] = [
      { courtId: 'c1', label: 'Court 1', status: 'unavailable', occupied: false },
      { courtId: 'c2', label: 'Court 2', status: 'available', occupied: true },
      { courtId: 'c3', label: 'Court 3', status: 'available', occupied: false },
    ];
    const players = Array.from({ length: 12 }, (_, i) => qp(`p${i + 1}`, i));
    const r = recommend({ now: at(30), players, courts: list, settings: settings() });
    expect(r.recommendations.map((x) => x.courtId)).toEqual(['c3']);
    expect(must(r.recommendations[0]).playerIds).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect([...r.skippedCourts].sort((x, y) => (x.courtId < y.courtId ? -1 : 1))).toEqual([
      { courtId: 'c1', reason: 'unavailable' },
      { courtId: 'c2', reason: 'occupied' },
    ]);
    expect(r.openCourts).toEqual([]);
  });

  it('when every court is busy there is nothing to recommend and nothing is "open"', () => {
    const list = courts(2).map((c) => ({ ...c, occupied: true }));
    const r = recommend({ now: at(30), players: [qp('a', 0), qp('b', 1), qp('c', 2), qp('d', 3)], courts: list, settings: settings() });
    expect(r.recommendations).toEqual([]);
    expect(r.openCourts).toEqual([]);
    expect(r.skippedCourts).toHaveLength(2);
  });

  it('property: random queues, courts and settings never yield a double assignment or an invalid group', () => {
    const r = rng(20261021);
    const policies: DeclinePolicy[] = [{ kind: 'back_of_queue' }, { kind: 'keep_spot' }, { kind: 'drop_places', places: 2 }];
    for (let iter = 0; iter < 400; iter++) {
      const n = Math.floor(r() * 33); // 0..32 players
      const players: QueuePlayer[] = [];
      for (let i = 0; i < n; i++) {
        const statusRoll = r();
        const status = statusRoll < 0.2 ? ('playing' as const) : statusRoll < 0.3 ? ('unavailable' as const) : ('waiting' as const);
        const declineRoll = r();
        players.push(
          qp(`p${i}`, Math.floor(r() * 60), {
            checkedInAt: at(Math.floor(r() * 30) - 30),
            status,
            declinedCurrentTurn: status === 'waiting' && declineRoll < 0.08,
            gamesPlayed: Math.floor(r() * 4),
            skillLevel: 1 + Math.floor(r() * 5),
            displayName: `Player ${i}`,
          }),
        );
      }
      const courtCount = 2 + Math.floor(r() * 3);
      const list = courts(courtCount).map((c) => ({
        ...c,
        status: r() < 0.15 ? ('unavailable' as const) : ('available' as const),
        occupied: r() < 0.25,
      }));
      const s = settings({
        format: r() < 0.3 ? 'singles' : 'doubles',
        skillBalancing: r() < 0.5,
        partnerRotation: r() < 0.5,
        declinePolicy: pick(r, policies),
      });
      const pastGames: { teamA: string[]; teamB: string[] }[] = [];
      if (n >= 4) {
        for (let g = Math.floor(r() * 6); g > 0; g--) {
          const four: string[] = [];
          while (four.length < 4) {
            const id = `p${Math.floor(r() * n)}`;
            if (!four.includes(id)) four.push(id);
          }
          pastGames.push({ teamA: four.slice(0, 2), teamB: four.slice(2) });
        }
      }
      const now = at(60);
      const result = recommend({ now, players, courts: list, settings: s, pastGames });
      checkResult(result, players, list, s, now);
    }
  });
});

// =========================================================================
// Data layer

let dir = '';
const opened: Db[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbop-p3-integrity-'));
});

afterEach(() => {
  vi.useRealTimers();
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function openDb(name = 'integrity.db'): Db {
  const db = openDatabase(join(dir, name));
  opened.push(db);
  return db;
}

interface World {
  db: Db;
  session: Session;
  courts: Court[];
  p: string[];
}

function world(n: number, courtCount = 2, name = 'integrity.db'): World {
  const db = openDb(name);
  const session = createSession(db, { name: 'Integrity night', courtCount, startedAt: at(-30) });
  const p: string[] = [];
  for (let i = 0; i < n; i++) {
    const entry = addNewPlayerToSession(db, session.id, { displayName: `P${i + 1}` });
    checkInPlayer(db, session.id, entry.playerId, at(i));
    p.push(entry.playerId);
  }
  return { db, session, courts: listCourts(db, session.id), p };
}

function playOut(db: Db, gameId: string, endedMin: number): void {
  startScoring(db, gameId, { firstServingTeam: 'A' });
  for (let i = 0; i < 11; i++) recordScoringEvent(db, gameId, { type: 'rally', winner: 'A' });
  finalizeGame(db, gameId, { endedAt: at(endedMin) });
}

/** Brief §6: a player cannot be in more than one active game; one active game per court. */
function assertNoDoubleAssignment(db: Db, sessionId: string): void {
  const active = listActiveGames(db, sessionId);
  const players = active.flatMap((g) => g.participants.map((x) => x.playerId));
  expect(new Set(players).size).toBe(players.length);
  const courtIds = active.map((g) => g.courtId);
  expect(new Set(courtIds).size).toBe(courtIds.length);
  for (const g of active) {
    expect(g.participants).toHaveLength(g.format === 'doubles' ? 4 : 2);
  }
}

function snapshot(db: Db, sessionId: string): { games: number; events: number } {
  return { games: listGames(db, sessionId).length, events: listRotationEvents(db, sessionId).length };
}

describe('AC-04 assignment integrity: persisted assignments (data layer)', () => {
  it('assigning both recommendations fills two courts with disjoint groups; nobody is recommended again while on court', () => {
    const w = world(10);
    const r = recommendNextGames(w.db, w.session.id, { at: at(20) });
    expect(r.recommendations).toHaveLength(2);
    for (const rec of r.recommendations) assignRecommendation(w.db, w.session.id, rec, { at: at(20) });
    assertNoDoubleAssignment(w.db, w.session.id);
    expect(listActiveGames(w.db, w.session.id)).toHaveLength(2);
    const after = recommendNextGames(w.db, w.session.id, { at: at(21) });
    expect(after.recommendations).toEqual([]);
    expect(after.skippedCourts.map((x) => x.reason)).toEqual(['occupied', 'occupied']);
    const excluded = after.excluded.filter((x) => x.reason === 'playing').map((x) => x.playerId);
    expect(sorted(excluded)).toEqual(sorted(w.p.slice(0, 8)));
    expect(getQueue(w.db, w.session.id, { at: at(21) }).map((e) => e.playerId)).toEqual(w.p.slice(8));
  });

  it('the same recommendation cannot be assigned twice; the second attempt writes nothing', () => {
    const w = world(8);
    const rec = must(recommendNextGames(w.db, w.session.id, { at: at(20) }).recommendations[0]);
    assignRecommendation(w.db, w.session.id, rec, { at: at(20) });
    const before = snapshot(w.db, w.session.id);
    expect(() => assignRecommendation(w.db, w.session.id, rec, { at: at(21) })).toThrow(ValidationError);
    expect(snapshot(w.db, w.session.id)).toEqual(before);
    // even moved to the other (free) court, those players are still on court 1
    const moved = { ...rec, courtId: must(w.courts[1]).id, courtLabel: must(w.courts[1]).label };
    expect(() => assignRecommendation(w.db, w.session.id, moved, { at: at(21) })).toThrow(ValidationError);
    expect(snapshot(w.db, w.session.id)).toEqual(before);
    assertNoDoubleAssignment(w.db, w.session.id);
  });

  it('a stale recommendation is refused when a chosen player has become unavailable meanwhile', () => {
    const w = world(8);
    const rec = must(recommendNextGames(w.db, w.session.id, { at: at(20) }).recommendations[0]);
    setAvailability(w.db, w.session.id, must(rec.playerIds[2]), 'unavailable');
    const before = snapshot(w.db, w.session.id);
    expect(() => assignRecommendation(w.db, w.session.id, rec, { at: at(21) })).toThrow(ValidationError);
    expect(snapshot(w.db, w.session.id)).toEqual(before);
  });

  it('an unavailable court is never recommended and cannot be assigned, even manually', () => {
    const w = world(8);
    const c1 = must(w.courts[0]);
    const c2 = must(w.courts[1]);
    setCourtStatus(w.db, c1.id, 'unavailable');
    const r = recommendNextGames(w.db, w.session.id, { at: at(20) });
    expect(r.recommendations.map((x) => x.courtId)).toEqual([c2.id]);
    expect(r.skippedCourts).toContainEqual({ courtId: c1.id, reason: 'unavailable' });
    expect(r.openCourts).toEqual([]);

    const before = snapshot(w.db, w.session.id);
    expect(() =>
      assignManually(w.db, w.session.id, {
        courtId: c1.id,
        format: 'doubles',
        teamA: w.p.slice(4, 6),
        teamB: w.p.slice(6, 8),
        reason: 'Court 1 looks dry now',
        at: at(21),
      }),
    ).toThrow(ValidationError);
    const tampered = { ...must(r.recommendations[0]), courtId: c1.id, courtLabel: c1.label };
    expect(() => assignRecommendation(w.db, w.session.id, tampered, { at: at(21) })).toThrow(ValidationError);
    expect(snapshot(w.db, w.session.id)).toEqual(before);
  });

  it('manual override needs a reason; a blank reason writes nothing', () => {
    const w = world(8);
    const input = {
      courtId: must(w.courts[0]).id,
      format: 'doubles' as GameFormat,
      teamA: w.p.slice(2, 4),
      teamB: w.p.slice(4, 6),
      at: at(20),
    };
    const before = snapshot(w.db, w.session.id);
    expect(() => assignManually(w.db, w.session.id, { ...input, reason: '' })).toThrow(ValidationError);
    expect(() => assignManually(w.db, w.session.id, { ...input, reason: '   \n\t ' })).toThrow(ValidationError);
    expect(snapshot(w.db, w.session.id)).toEqual(before);
  });

  it('manual override with a reason starts the game and records the reason and what the queue would have chosen', () => {
    const w = world(8);
    const c1 = must(w.courts[0]);
    const game = assignManually(w.db, w.session.id, {
      courtId: c1.id,
      format: 'doubles',
      teamA: [must(w.p[2]), must(w.p[3])],
      teamB: [must(w.p[4]), must(w.p[5])],
      reason: '  P1 and P2 are still warming up  ',
      at: at(20),
    });
    expect(game.status).toBe('in_progress');
    expect(game.courtId).toBe(c1.id);
    expect(game.startedAt).toBe(at(20));

    const overrides = listRotationEvents(w.db, w.session.id).filter((e) => e.type === 'override');
    expect(overrides).toHaveLength(1);
    const ev = must(overrides[0]);
    expect(ev.occurredAt).toBe(at(20));
    expect(ev.data.reason).toBe('P1 and P2 are still warming up');
    expect(ev.data.gameId).toBe(game.id);
    expect(ev.data.courtId).toBe(c1.id);
    expect(sorted(ev.data.playerIds as string[])).toEqual(sorted(w.p.slice(2, 6)));
    expect(sorted(ev.data.recommendedPlayerIds as string[])).toEqual(sorted(w.p.slice(0, 4)));
    expect(sorted(ev.data.teamA as string[])).toEqual(sorted([must(w.p[2]), must(w.p[3])]));
    // P1, P2 keep their places at the head of the queue
    expect(getQueue(w.db, w.session.id, { at: at(21) }).map((e) => e.playerId).slice(0, 2)).toEqual(w.p.slice(0, 2));
  });

  it('manual override records an empty recommendation when the queue would have left the court open', () => {
    const w = world(5);
    setAvailability(w.db, w.session.id, must(w.p[0]), 'resting');
    setAvailability(w.db, w.session.id, must(w.p[1]), 'resting');
    // only 3 waiting → the queue would leave court 1 open; the organizer runs a singles game instead
    assignManually(w.db, w.session.id, {
      courtId: must(w.courts[0]).id,
      format: 'singles',
      teamA: [must(w.p[2])],
      teamB: [must(w.p[3])],
      reason: 'Singles while we wait for more players',
      at: at(20),
    });
    const ev = must(listRotationEvents(w.db, w.session.id).find((e) => e.type === 'override'));
    expect(ev.data.recommendedPlayerIds).toEqual([]);
  });

  it('manual override cannot put a player into a second active game, or on an occupied court', () => {
    const w = world(12);
    const rec = must(recommendNextGames(w.db, w.session.id, { at: at(20) }).recommendations[0]);
    assignRecommendation(w.db, w.session.id, rec, { at: at(20) });
    const before = snapshot(w.db, w.session.id);
    expect(() =>
      assignManually(w.db, w.session.id, {
        courtId: must(w.courts[1]).id,
        format: 'doubles',
        teamA: [must(rec.playerIds[0]), must(w.p[8])],
        teamB: [must(w.p[9]), must(w.p[10])],
        reason: 'She wants to play again',
        at: at(21),
      }),
    ).toThrow(ValidationError);
    expect(() =>
      assignManually(w.db, w.session.id, {
        courtId: rec.courtId,
        format: 'doubles',
        teamA: w.p.slice(8, 10),
        teamB: w.p.slice(10, 12),
        reason: 'Replace the game on court 1',
        at: at(21),
      }),
    ).toThrow(ValidationError);
    expect(snapshot(w.db, w.session.id)).toEqual(before);
    assertNoDoubleAssignment(w.db, w.session.id);
  });

  it('invalid player counts are refused: an incomplete court is never filled with a short or padded team', () => {
    const w = world(3);
    const r = recommendNextGames(w.db, w.session.id, { at: at(20) });
    expect(r.recommendations).toEqual([]);
    expect(r.openCourts).toHaveLength(2);
    const before = snapshot(w.db, w.session.id);
    expect(() =>
      assignManually(w.db, w.session.id, {
        courtId: must(w.courts[0]).id,
        format: 'doubles',
        teamA: w.p.slice(0, 2),
        teamB: w.p.slice(2, 3),
        reason: 'Play 2 v 1',
        at: at(21),
      }),
    ).toThrow(ValidationError);
    expect(() =>
      assignManually(w.db, w.session.id, {
        courtId: must(w.courts[0]).id,
        format: 'doubles',
        teamA: w.p.slice(0, 2),
        teamB: [must(w.p[2]), must(w.p[2])],
        reason: 'Same person twice',
        at: at(21),
      }),
    ).toThrow(ValidationError);
    expect(snapshot(w.db, w.session.id)).toEqual(before);
  });

  it('singles recommendations through the data layer use two players per court', () => {
    const w = world(5);
    setRotationSettings(w.db, w.session.id, { format: 'singles' });
    const r = recommendNextGames(w.db, w.session.id, { at: at(20) });
    expect(r.recommendations.map((x) => x.playerIds)).toEqual([w.p.slice(0, 2), w.p.slice(2, 4)]);
    for (const rec of r.recommendations) {
      const g = assignRecommendation(w.db, w.session.id, rec, { at: at(20) });
      expect(g.format).toBe('singles');
      expect(g.participants).toHaveLength(2);
    }
    // the per-call format override wins over the session setting
    const asDoubles = recommendNextGames(w.db, w.session.id, { at: at(21), format: 'doubles' });
    expect(asDoubles.recommendations).toEqual([]);
    assertNoDoubleAssignment(w.db, w.session.id);
  });

  it('a completed session accepts no assignments; an unknown session is a ValidationError', () => {
    const w = world(4);
    const rec = must(recommendNextGames(w.db, w.session.id, { at: at(20) }).recommendations[0]);
    finishSession(w.db, w.session.id, { endedAt: at(30) });
    expect(() => assignRecommendation(w.db, w.session.id, rec, { at: at(31) })).toThrow(SessionReadOnlyError);
    expect(() =>
      assignManually(w.db, w.session.id, {
        courtId: rec.courtId,
        format: 'doubles',
        teamA: w.p.slice(0, 2),
        teamB: w.p.slice(2, 4),
        reason: 'After hours',
        at: at(31),
      }),
    ).toThrow(SessionReadOnlyError);
    expect(listGames(w.db, w.session.id)).toEqual([]);
    expect(() => recommendNextGames(w.db, 'no-such-session', { at: at(20) })).toThrow(ValidationError);
    expect(() => getQueue(w.db, 'no-such-session', { at: at(20) })).toThrow(ValidationError);
  });
});

// =========================================================================
describe('AC-04 property: random check-ins, games and departures never produce a double assignment', () => {
  function runScenario(seed: number, steps: number): { assigned: number; refused: number } {
    vi.useFakeTimers({ toFake: ['Date'] });
    const r = rng(seed);
    const db = openDb(`property-${seed}.db`);
    const courtCount = 2 + Math.floor(r() * 3);
    const session = createSession(db, { name: `Property ${seed}`, courtCount, startedAt: at(-1) });
    const courtIds = listCourts(db, session.id).map((c) => c.id);
    let minute = 0;
    let made = 0;
    let assigned = 0;
    let refused = 0;
    const tick = (): string => {
      minute += 1 + Math.floor(r() * 3);
      vi.setSystemTime(new Date(at(minute)));
      return at(minute);
    };
    const addPlayer = (): void => {
      if (listRoster(db, session.id).length >= 32) return;
      made += 1;
      const entry = addNewPlayerToSession(db, session.id, {
        displayName: `S${seed} Player ${made}`,
        skillLevel: 1 + Math.floor(r() * 5),
      });
      checkInPlayer(db, session.id, entry.playerId, tick());
    };
    for (let i = 0; i < 10; i++) addPlayer();

    for (let step = 0; step < steps; step++) {
      const now = tick();
      const roll = r();
      const roster = listRoster(db, session.id);
      const active = listActiveGames(db, session.id);
      const playing = new Set(active.flatMap((g) => g.participants.map((x) => x.playerId)));
      const waiting = roster.filter((e) => e.checkedInAt !== null && e.availability === 'available' && !playing.has(e.playerId));
      try {
        if (roll < 0.12) {
          addPlayer();
        } else if (roll < 0.34) {
          for (const rec of recommendNextGames(db, session.id, { at: now }).recommendations) {
            assignRecommendation(db, session.id, rec, { at: now });
            assigned += 1;
          }
        } else if (roll < 0.5 && active.length > 0) {
          const g: Game = pick(r, active);
          if (r() < 0.75) playOut(db, g.id, minute);
          else markGameIncomplete(db, g.id, 'Rain delay');
        } else if (roll < 0.6 && waiting.length > 0) {
          // departure: rest, leave for the day, or go home entirely
          const who = pick(r, waiting).playerId;
          const how = r();
          if (how < 0.4) setAvailability(db, session.id, who, 'resting');
          else if (how < 0.7) setAvailability(db, session.id, who, 'unavailable');
          else removePlayerFromSession(db, session.id, who);
        } else if (roll < 0.68) {
          const away = roster.filter((e) => e.checkedInAt !== null && e.availability !== 'available');
          if (away.length > 0) setAvailability(db, session.id, pick(r, away).playerId, 'available');
        } else if (roll < 0.74 && waiting.length > 0) {
          declineTurn(db, session.id, pick(r, waiting).playerId, { at: now });
        } else if (roll < 0.86 && roster.length >= 4) {
          // reckless manual override with arbitrary roster players; must be refused or valid
          const format: GameFormat = r() < 0.7 ? 'doubles' : 'singles';
          const need = format === 'doubles' ? 4 : 2;
          const chosen = Array.from({ length: need }, () => pick(r, roster).playerId);
          const before = snapshot(db, session.id);
          try {
            assignManually(db, session.id, {
              courtId: pick(r, courtIds),
              format,
              teamA: chosen.slice(0, need / 2),
              teamB: chosen.slice(need / 2),
              reason: 'Organizer choice',
              at: now,
            });
            assigned += 1;
          } catch (err) {
            expect(err).toBeInstanceOf(ValidationError);
            expect(snapshot(db, session.id)).toEqual(before);
            refused += 1;
          }
        } else if (roll < 0.92) {
          const busy = new Set(active.map((g) => g.courtId));
          const free = courtIds.filter((id) => !busy.has(id));
          if (free.length > 0) {
            const id = pick(r, free);
            const current = must(listCourts(db, session.id).find((c) => c.id === id));
            setCourtStatus(db, id, current.status === 'available' ? 'unavailable' : 'available');
          }
        } else {
          setRotationSettings(db, session.id, { skillBalancing: r() < 0.5, partnerRotation: r() < 0.5 }, { at: now });
        }
      } catch (err) {
        // only the deliberately reckless override above may be refused
        throw new Error(`seed ${seed} step ${step}: unexpected failure: ${String(err)}`);
      }

      assertNoDoubleAssignment(db, session.id);
      // every game in progress sits on a court that was available when it was assigned, and the
      // engine's view agrees with the database
      const result = recommendNextGames(db, session.id, { at: now });
      const nowPlaying = new Set(listActiveGames(db, session.id).flatMap((g) => g.participants.map((x) => x.playerId)));
      const queueIds = new Set(getQueue(db, session.id, { at: now }).filter((e) => !e.declinedCurrentTurn).map((e) => e.playerId));
      const courtsNow = listCourts(db, session.id);
      const busyCourts = new Set(listActiveGames(db, session.id).map((g) => g.courtId));
      const chosen = result.recommendations.flatMap((x) => x.playerIds);
      expect(new Set(chosen).size).toBe(chosen.length);
      for (const id of chosen) {
        expect(nowPlaying.has(id)).toBe(false);
        expect(queueIds.has(id)).toBe(true);
      }
      for (const rec of result.recommendations) {
        const court = must(courtsNow.find((c) => c.id === rec.courtId));
        expect(court.status).toBe('available');
        expect(busyCourts.has(rec.courtId)).toBe(false);
      }
    }
    // every 'assigned' / 'override' event points at a real game
    const gameIds = new Set(listGames(db, session.id).map((g) => g.id));
    for (const ev of listRotationEvents(db, session.id)) {
      if (ev.type === 'assigned' || ev.type === 'override') expect(gameIds.has(ev.data.gameId as string)).toBe(true);
    }
    vi.useRealTimers();
    return { assigned, refused };
  }

  it('holds for several seeded random sessions (and the scenarios really exercise assignments and refusals)', () => {
    let assigned = 0;
    let refused = 0;
    for (const seed of [1, 2, 3, 42, 2026]) {
      const res = runScenario(seed, 120);
      assigned += res.assigned;
      refused += res.refused;
    }
    expect(assigned).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(5);
  });
});
