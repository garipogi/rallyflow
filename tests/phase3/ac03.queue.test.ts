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
  RotationError,
  type CourtInput,
  type QueuePlayer,
  type RotationSettings,
} from '../../src/core/rotation';
import { openDatabase, type Db } from '../../src/data/db';
import { createSession } from '../../src/data/sessions';
import { listCourts } from '../../src/data/courts';
import { addNewPlayerToSession, checkInPlayer, setAvailability } from '../../src/data/roster';
import { getGame } from '../../src/data/games';
import { finalizeGame, recordScoringEvent, startScoring } from '../../src/data/scoring';
import {
  assignRecommendation,
  getQueue,
  listRotationEvents,
  recommendNextGames,
} from '../../src/data/rotation';
import type { Court, Session } from '../../src/data/types';

// ---------------------------------------------------------------- fake clock
const T0 = Date.parse('2026-10-21T18:00:00.000Z');
/** Minutes after 18:00 UTC as an ISO instant. Fractional minutes allowed. */
const at = (min: number): string => new Date(T0 + Math.round(min * 60000)).toISOString();
const MIN = 60000;

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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const ids = (entries: readonly { playerId: string }[]): string[] => entries.map((e) => e.playerId);
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

// =========================================================================
describe('AC-03 rotation: waiting time is the primary order (pure engine, D2)', () => {
  it('orders waiting players oldest eligibility first, whatever the input order or check-in order', () => {
    // check-in order is the reverse of eligibility order, so a check-in sort would fail
    const players = [
      qp('a', 30, { checkedInAt: at(0) }),
      qp('b', 10, { checkedInAt: at(5) }),
      qp('c', 20, { checkedInAt: at(3) }),
      qp('d', 5, { checkedInAt: at(4) }),
    ];
    for (let seed = 1; seed <= 5; seed++) {
      const q = orderQueue(shuffled(players, seed), at(60));
      expect(ids(q)).toEqual(['d', 'b', 'c', 'a']);
      expect(q.map((e) => e.position)).toEqual([1, 2, 3, 4]);
    }
  });

  it('D2 tie-break 1: equal eligibility → earlier session check-in wins', () => {
    const q = orderQueue(
      [qp('x', 10, { checkedInAt: at(2) }), qp('y', 10, { checkedInAt: at(1) }), qp('z', 10, { checkedInAt: at(3) })],
      at(20),
    );
    expect(ids(q)).toEqual(['y', 'x', 'z']);
  });

  it('D2 tie-break 2: equal eligibility and check-in → fewer games played this session wins', () => {
    const q = orderQueue(
      [
        qp('x', 10, { checkedInAt: at(0), gamesPlayed: 3 }),
        qp('y', 10, { checkedInAt: at(0), gamesPlayed: 1 }),
        qp('z', 10, { checkedInAt: at(0), gamesPlayed: 2 }),
      ],
      at(20),
    );
    expect(ids(q)).toEqual(['y', 'z', 'x']);
  });

  it('D2 tie-break 3: everything equal → stable player id by plain string comparison', () => {
    const tie = { checkedInAt: at(0), gamesPlayed: 1 };
    const q = orderQueue([qp('p9', 10, tie), qp('p10', 10, tie), qp('p2', 10, tie)], at(20));
    // string order, not numeric: 'p10' < 'p2' < 'p9'
    expect(ids(q)).toEqual(['p10', 'p2', 'p9']);
  });

  it('eligibility beats every tie-break key (an earlier check-in or fewer games never jump the queue)', () => {
    const q = orderQueue(
      [
        qp('veteran', 11, { checkedInAt: at(-60), gamesPlayed: 0 }),
        qp('fresh', 10, { checkedInAt: at(9), gamesPlayed: 5 }),
      ],
      at(20),
    );
    expect(ids(q)).toEqual(['fresh', 'veteran']);
  });

  it('reports waitedMs = now − eligibleSince and copies the queue facts through', () => {
    const q = orderQueue([qp('a', 0, { gamesPlayed: 2 }), qp('b', 12.5)], at(40));
    expect(q[0]).toMatchObject({
      playerId: 'a',
      displayName: 'Name-a',
      position: 1,
      eligibleSince: at(0),
      checkedInAt: at(0),
      gamesPlayed: 2,
      waitedMs: 40 * MIN,
      declinedCurrentTurn: false,
    });
    expect(must(q[1]).waitedMs).toBe(27.5 * MIN);
  });

  it('lists only waiting players: playing and unavailable players are not in the queue; declined ones keep their place', () => {
    const q = orderQueue(
      [
        qp('a', 0, { status: 'playing' }),
        qp('b', 1, { status: 'unavailable' }),
        qp('c', 2, { declinedCurrentTurn: true }),
        qp('d', 3),
      ],
      at(10),
    );
    expect(ids(q)).toEqual(['c', 'd']);
    expect(q.map((e) => e.declinedCurrentTurn)).toEqual([true, false]);
  });

  it('never mutates its input (works on deeply frozen players)', () => {
    const players = deepFreeze([qp('b', 5), qp('a', 1)]);
    expect(ids(orderQueue(players, at(10)))).toEqual(['a', 'b']);
    expect(ids(players)).toEqual(['b', 'a']);
  });

  it('time is an input: the result depends on `now`, not on the system clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2031-01-01T00:00:00.000Z'));
      const q1 = orderQueue([qp('a', 0)], at(15));
      vi.setSystemTime(new Date('1999-01-01T00:00:00.000Z'));
      const q2 = orderQueue([qp('a', 0)], at(15));
      expect(must(q1[0]).waitedMs).toBe(15 * MIN);
      expect(must(q2[0]).waitedMs).toBe(15 * MIN);
      expect(must(orderQueue([qp('a', 0)], at(25))[0]).waitedMs).toBe(25 * MIN);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects malformed input with RotationError', () => {
    expect(() => orderQueue([qp('a', 0), qp('a', 1)], at(5))).toThrow(RotationError);
    expect(() => orderQueue([qp('a', 0)], 'not a time')).toThrow(RotationError);
    expect(() =>
      recommend({ now: at(5), players: [qp('a', 0), qp('a', 1)], courts: courts(2), settings: settings() }),
    ).toThrow(RotationError);
    const dupCourts = [...courts(1), ...courts(1)];
    expect(() => recommend({ now: at(5), players: [qp('a', 0)], courts: dupCourts, settings: settings() })).toThrow(
      RotationError,
    );
  });

  it('playersNeeded: doubles 4, singles 2', () => {
    expect(playersNeeded('doubles')).toBe(4);
    expect(playersNeeded('singles')).toBe(2);
  });
});

// =========================================================================
describe('AC-03 rotation: next-game recommendations take the oldest-waiting players (pure engine)', () => {
  it('the first free court gets the four oldest-waiting players, split 2 + 2', () => {
    const players = [qp('e', 50), qp('a', 10), qp('d', 40), qp('b', 20), qp('f', 60), qp('c', 30)];
    const r = recommend({ now: at(70), players, courts: courts(1), settings: settings() });
    expect(r.recommendations).toHaveLength(1);
    const rec = must(r.recommendations[0]);
    expect(rec.courtId).toBe('c1');
    expect(rec.courtLabel).toBe('Court 1');
    expect(rec.format).toBe('doubles');
    expect(rec.playerIds).toEqual(['a', 'b', 'c', 'd']);
    expect(rec.teamA).toHaveLength(2);
    expect(rec.teamB).toHaveLength(2);
    expect(sorted([...rec.teamA, ...rec.teamB])).toEqual(['a', 'b', 'c', 'd']);
    expect(rec.bypassed).toEqual([]);
  });

  it('several free courts are filled in court order from the remaining queue; the rest keep waiting', () => {
    const players = Array.from({ length: 9 }, (_, i) => qp(`p${i + 1}`, i));
    const r = recommend({ now: at(30), players, courts: courts(2), settings: settings() });
    expect(r.recommendations.map((x) => x.courtId)).toEqual(['c1', 'c2']);
    expect(must(r.recommendations[0]).playerIds).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(must(r.recommendations[1]).playerIds).toEqual(['p5', 'p6', 'p7', 'p8']);
    expect(r.openCourts).toEqual([]);
  });

  it('capacity: 32 waiting players and 4 courts → the 16 oldest are assigned, in queue order, nobody twice', () => {
    const players = shuffled(
      Array.from({ length: 32 }, (_, i) => qp(`p${String(i + 1).padStart(2, '0')}`, i * 0.5)),
      7,
    );
    const r = recommend({ now: at(90), players, courts: courts(4), settings: settings() });
    expect(r.recommendations).toHaveLength(4);
    const chosen = r.recommendations.flatMap((x) => x.playerIds);
    expect(chosen).toEqual(Array.from({ length: 16 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`));
    expect(new Set(chosen).size).toBe(16);
  });

  it('singles: two players per court, 1 + 1', () => {
    const players = [qp('a', 0), qp('b', 1), qp('c', 2), qp('d', 3), qp('e', 4)];
    const r = recommend({ now: at(10), players, courts: courts(2), settings: settings({ format: 'singles' }) });
    expect(r.recommendations.map((x) => x.playerIds)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    for (const rec of r.recommendations) {
      expect(rec.format).toBe('singles');
      expect(rec.teamA).toHaveLength(1);
      expect(rec.teamB).toHaveLength(1);
      expect(rec.repeatPartnerships).toBe(0);
    }
  });

  it('recommendations depend only on the queue, not on the order players were passed in', () => {
    const players = Array.from({ length: 12 }, (_, i) => qp(`p${i}`, (i * 7) % 12, { checkedInAt: at(-i) }));
    const base = recommend({ now: at(30), players, courts: courts(3), settings: settings() });
    for (let seed = 1; seed <= 4; seed++) {
      const again = recommend({ now: at(30), players: shuffled(players, seed), courts: courts(3), settings: settings() });
      expect(again.recommendations.map((x) => x.playerIds)).toEqual(base.recommendations.map((x) => x.playerIds));
    }
  });

  it('an incomplete court stays open instead of receiving an invalid assignment', () => {
    const r = recommend({ now: at(10), players: [qp('a', 0), qp('b', 1), qp('c', 2)], courts: courts(2), settings: settings() });
    expect(r.recommendations).toEqual([]);
    expect(r.openCourts.map((o) => o.courtId)).toEqual(['c1', 'c2']);
    const first = must(r.openCourts[0]);
    expect(first).toMatchObject({ courtId: 'c1', courtLabel: 'Court 1', needed: 4, available: 3 });
    expect(first.reason.trim().length).toBeGreaterThan(0);
  });

  it('with 7 waiting and 2 free courts, court 1 is filled and court 2 stays open with the 3 left', () => {
    const players = Array.from({ length: 7 }, (_, i) => qp(`p${i + 1}`, i));
    const r = recommend({ now: at(10), players, courts: courts(2), settings: settings() });
    expect(r.recommendations.map((x) => x.courtId)).toEqual(['c1']);
    expect(r.openCourts).toHaveLength(1);
    expect(must(r.openCourts[0])).toMatchObject({ courtId: 'c2', needed: 4, available: 3 });
  });
});

// =========================================================================
describe('AC-03 rotation: recommendations are explainable', () => {
  const players = [
    qp('a', 0, { displayName: 'Ana Reyes' }),
    qp('b', 4.5, { displayName: 'Ben Ocampo' }),
    qp('c', 10, { displayName: 'Cora Lim' }),
    qp('d', 21, { displayName: 'Dan Cruz' }),
    qp('e', 30, { displayName: 'Eli Tan' }),
  ];
  const now = at(37.5);

  it('each chosen player has a reason: queue position, eligibility time and exact waiting time', () => {
    const rec = must(recommend({ now, players, courts: courts(1), settings: settings() }).recommendations[0]);
    expect(rec.reasons.map((x) => x.playerId)).toEqual(rec.playerIds);
    expect(rec.reasons).toEqual([
      { playerId: 'a', displayName: 'Ana Reyes', queuePosition: 1, eligibleSince: at(0), waitedMs: 37.5 * MIN },
      { playerId: 'b', displayName: 'Ben Ocampo', queuePosition: 2, eligibleSince: at(4.5), waitedMs: 33 * MIN },
      { playerId: 'c', displayName: 'Cora Lim', queuePosition: 3, eligibleSince: at(10), waitedMs: 27.5 * MIN },
      { playerId: 'd', displayName: 'Dan Cruz', queuePosition: 4, eligibleSince: at(21), waitedMs: 16.5 * MIN },
    ]);
  });

  it('the explanation names the court, who was chosen, and how long each one waited (whole minutes)', () => {
    const rec = must(recommend({ now, players, courts: courts(1), settings: settings() }).recommendations[0]);
    const text = rec.explanation;
    expect(text).toContain('Court 1');
    for (const name of ['Ana Reyes', 'Ben Ocampo', 'Cora Lim', 'Dan Cruz']) expect(text).toContain(name);
    for (const mins of ['37 min', '33 min', '27 min', '16 min']) expect(text).toContain(mins);
    expect(text.toLowerCase()).toContain('wait');
    expect(text).not.toContain('Eli Tan');
  });

  it('the queue position in a reason is the position in the full queue (declined players still count)', () => {
    const withDecline = players.map((p) => (p.playerId === 'b' ? { ...p, declinedCurrentTurn: true } : p));
    const rec = must(recommend({ now, players: withDecline, courts: courts(1), settings: settings() }).recommendations[0]);
    expect(rec.playerIds).toEqual(['a', 'c', 'd', 'e']);
    expect(rec.reasons.map((x) => x.queuePosition)).toEqual([1, 3, 4, 5]);
  });

  it('every player who is left out for a reason is listed with that reason', () => {
    const mixed = [
      qp('a', 0, { status: 'playing' }),
      qp('b', 1, { status: 'unavailable' }),
      qp('c', 2, { declinedCurrentTurn: true }),
      qp('d', 3),
      qp('e', 4),
      qp('f', 5),
      qp('g', 6),
    ];
    const r = recommend({ now: at(20), players: mixed, courts: courts(2), settings: settings() });
    expect([...r.excluded].sort((x, y) => (x.playerId < y.playerId ? -1 : 1))).toEqual([
      { playerId: 'a', reason: 'playing' },
      { playerId: 'b', reason: 'unavailable' },
      { playerId: 'c', reason: 'declined' },
    ]);
    expect(must(r.recommendations[0]).playerIds).toEqual(['d', 'e', 'f', 'g']);
  });
});

// =========================================================================
// Data layer: eligibility times come from check-ins, game ends and rests (D3, D4, D5).

let dir = '';
const opened: Db[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbop-p3-queue-'));
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

function openDb(name = 'queue.db'): Db {
  const db = openDatabase(join(dir, name));
  opened.push(db);
  return db;
}

interface World {
  db: Db;
  session: Session;
  courts: Court[];
  p: string[]; // player ids, index 0 = "P1"
}

/** n players named P1..Pn, checked in at minutes checkInMins[i] (default i). */
function world(n: number, courtCount = 2, checkInMins?: number[]): World {
  const db = openDb();
  const session = createSession(db, { name: 'Rotation night', courtCount, startedAt: at(-30) });
  const p: string[] = [];
  for (let i = 0; i < n; i++) {
    const entry = addNewPlayerToSession(db, session.id, { displayName: `P${i + 1}` });
    checkInPlayer(db, session.id, entry.playerId, at(checkInMins?.[i] ?? i));
    p.push(entry.playerId);
  }
  return { db, session, courts: listCourts(db, session.id), p };
}

/** Score a started game to 11-0 for team A and finalize it at `endedMin`. */
function playOut(db: Db, gameId: string, endedMin: number): void {
  startScoring(db, gameId, { firstServingTeam: 'A' });
  for (let i = 0; i < 11; i++) recordScoringEvent(db, gameId, { type: 'rally', winner: 'A' });
  finalizeGame(db, gameId, { endedAt: at(endedMin) });
}

describe('AC-03 data: the queue is built from eligibility times (D3, D4, D5)', () => {
  it('D3: arrivals queue in check-in order with their waiting time measured from check-in', () => {
    const w = world(5, 2, [12, 3, 7, 20, 0]);
    const q = getQueue(w.db, w.session.id, { at: at(30) });
    expect(ids(q)).toEqual([w.p[4], w.p[1], w.p[2], w.p[0], w.p[3]]);
    expect(q.map((e) => e.eligibleSince)).toEqual([at(0), at(3), at(7), at(12), at(20)]);
    expect(q.map((e) => e.waitedMs)).toEqual([30, 27, 23, 18, 10].map((m) => m * MIN));
    expect(q.map((e) => e.displayName)).toEqual(['P5', 'P2', 'P3', 'P1', 'P4']);
  });

  it('players not checked in, resting/unavailable or on court are not in the queue', () => {
    const w = world(6, 2);
    const late = addNewPlayerToSession(w.db, w.session.id, { displayName: 'Not here yet' });
    setAvailability(w.db, w.session.id, must(w.p[1]), 'resting');
    setAvailability(w.db, w.session.id, must(w.p[2]), 'unavailable');
    const q = getQueue(w.db, w.session.id, { at: at(10) });
    expect(ids(q)).toEqual([w.p[0], w.p[3], w.p[4], w.p[5]]);
    expect(ids(q)).not.toContain(late.playerId);
  });

  it('D5: when a game ends, all four players (winners and losers) become eligible at its end time and queue behind earlier waiters', () => {
    const w = world(8, 2);
    const rec = must(recommendNextGames(w.db, w.session.id, { at: at(10) }).recommendations[0]);
    expect(rec.playerIds).toEqual(w.p.slice(0, 4));
    const game = assignRecommendation(w.db, w.session.id, rec, { at: at(10) });

    // while on court, they are not in the queue
    expect(ids(getQueue(w.db, w.session.id, { at: at(11) }))).toEqual(w.p.slice(4, 8));

    playOut(w.db, game.id, 25);
    const q = getQueue(w.db, w.session.id, { at: at(30) });
    // P5..P8 have waited since check-in (4..7); P1..P4 since 25, ordered among themselves by check-in (D2)
    expect(ids(q)).toEqual([...w.p.slice(4, 8), ...w.p.slice(0, 4)]);
    for (const e of q.slice(4)) {
      expect(e.eligibleSince).toBe(at(25));
      expect(e.waitedMs).toBe(5 * MIN);
      expect(e.gamesPlayed).toBe(1);
    }
    for (const e of q.slice(0, 4)) expect(e.gamesPlayed).toBe(0);
  });

  it('D3: a mid-session arrival joins behind everyone already waiting but ahead of players whose game ends later', () => {
    const w = world(4, 2);
    const game = assignRecommendation(
      w.db,
      w.session.id,
      must(recommendNextGames(w.db, w.session.id, { at: at(5) }).recommendations[0]),
      { at: at(5) },
    );
    const extra = [addNewPlayerToSession(w.db, w.session.id, { displayName: 'Early bird' }).playerId];
    checkInPlayer(w.db, w.session.id, must(extra[0]), at(8));
    const lateComer = addNewPlayerToSession(w.db, w.session.id, { displayName: 'Late comer' }).playerId;
    checkInPlayer(w.db, w.session.id, lateComer, at(30));
    playOut(w.db, game.id, 20);
    const q = getQueue(w.db, w.session.id, { at: at(31) });
    expect(ids(q)).toEqual([must(extra[0]), ...w.p, lateComer]);
    expect(must(q[q.length - 1]).eligibleSince).toBe(at(30));
  });

  it('D4: a resting player keeps their original eligibility time and returns to their place with no penalty', () => {
    const w = world(9, 2);
    const first = must(w.p[0]);
    setAvailability(w.db, w.session.id, first, 'resting');
    // the others play a game while P1 rests
    const rec = must(recommendNextGames(w.db, w.session.id, { at: at(10) }).recommendations[0]);
    expect(rec.playerIds).not.toContain(first);
    expect(rec.playerIds).toEqual(w.p.slice(1, 5));
    const game = assignRecommendation(w.db, w.session.id, rec, { at: at(10) });
    playOut(w.db, game.id, 20);

    setAvailability(w.db, w.session.id, first, 'available');
    const q = getQueue(w.db, w.session.id, { at: at(40) });
    expect(must(q[0]).playerId).toBe(first);
    expect(must(q[0]).eligibleSince).toBe(at(0));
    expect(must(q[0]).waitedMs).toBe(40 * MIN);
    const next = must(recommendNextGames(w.db, w.session.id, { at: at(40) }).recommendations[0]);
    expect(next.playerIds[0]).toBe(first);
  });

  it('recommendations come from the persisted queue with the same explanation rules, and are read-only', () => {
    const w = world(6, 2);
    const before = listRotationEvents(w.db, w.session.id).length;
    const r = recommendNextGames(w.db, w.session.id, { at: at(45) });
    const rec = must(r.recommendations[0]);
    expect(rec.courtId).toBe(must(w.courts[0]).id);
    expect(rec.courtLabel).toBe(must(w.courts[0]).label);
    expect(rec.playerIds).toEqual(w.p.slice(0, 4));
    expect(rec.reasons.map((x) => x.waitedMs)).toEqual([45, 44, 43, 42].map((m) => m * MIN));
    expect(rec.explanation).toContain(must(w.courts[0]).label);
    for (const name of ['P1', 'P2', 'P3', 'P4']) expect(rec.explanation).toContain(name);
    for (const mins of ['45 min', '44 min', '43 min', '42 min']) expect(rec.explanation).toContain(mins);
    expect(r.openCourts).toHaveLength(1);
    expect(must(r.openCourts[0])).toMatchObject({ courtId: must(w.courts[1]).id, needed: 4, available: 2 });
    // nothing was written
    expect(listRotationEvents(w.db, w.session.id)).toHaveLength(before);
    expect(getQueue(w.db, w.session.id, { at: at(45) })).toHaveLength(6);
  });

  it('assigning a recommendation starts that exact game and logs an "assigned" RotationEvent with the explanation', () => {
    const w = world(4, 2);
    const rec = must(recommendNextGames(w.db, w.session.id, { at: at(12) }).recommendations[0]);
    const game = assignRecommendation(w.db, w.session.id, rec, { at: at(12) });
    const stored = must(getGame(w.db, game.id));
    expect(stored.status).toBe('in_progress');
    expect(stored.courtId).toBe(rec.courtId);
    expect(stored.startedAt).toBe(at(12));
    expect(sorted(stored.participants.filter((x) => x.team === 'A').map((x) => x.playerId))).toEqual(sorted(rec.teamA));
    expect(sorted(stored.participants.filter((x) => x.team === 'B').map((x) => x.playerId))).toEqual(sorted(rec.teamB));

    const events = listRotationEvents(w.db, w.session.id);
    const assigned = events.filter((e) => e.type === 'assigned');
    expect(assigned).toHaveLength(1);
    const ev = must(assigned[0]);
    expect(ev.sessionId).toBe(w.session.id);
    expect(ev.occurredAt).toBe(at(12));
    expect(ev.data.gameId).toBe(game.id);
    expect(ev.data.courtId).toBe(rec.courtId);
    expect(sorted(ev.data.playerIds as string[])).toEqual(sorted(rec.playerIds));
    expect(ev.data.explanation).toBe(rec.explanation);
  });
});
