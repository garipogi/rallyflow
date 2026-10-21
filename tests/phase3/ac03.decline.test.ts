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
  applyDecline,
  DEFAULT_ROTATION_SETTINGS,
  orderQueue,
  recommend,
  RotationError,
  startNewTurn,
  type CourtInput,
  type DeclinePolicy,
  type QueuePlayer,
  type RotationSettings,
} from '../../src/core/rotation';
import { openDatabase, type Db } from '../../src/data/db';
import { SessionReadOnlyError, ValidationError } from '../../src/data/errors';
import { createSession, finishSession } from '../../src/data/sessions';
import { listCourts } from '../../src/data/courts';
import { addNewPlayerToSession, checkInPlayer, setAvailability } from '../../src/data/roster';
import {
  assignManually,
  assignRecommendation,
  declineTurn,
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

function courts(n: number): CourtInput[] {
  return Array.from({ length: n }, (_, i) => ({
    courtId: `c${i + 1}`,
    label: `Court ${i + 1}`,
    status: 'available' as const,
    occupied: false,
  }));
}

const settings = (patch: Partial<RotationSettings> = {}): RotationSettings => ({ ...DEFAULT_ROTATION_SETTINGS, ...patch });
const ids = (entries: readonly { playerId: string }[]): string[] => entries.map((e) => e.playerId);
const six = (): QueuePlayer[] => ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id, i) => qp(id, i));

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// =========================================================================
describe('AC-03 declined turn — D1 default: back of the queue (pure engine)', () => {
  it('the default policy is back_of_queue', () => {
    expect(DEFAULT_ROTATION_SETTINGS.declinePolicy).toEqual({ kind: 'back_of_queue' });
    expect(DEFAULT_ROTATION_SETTINGS.skillBalancing).toBe(false);
    expect(DEFAULT_ROTATION_SETTINGS.partnerRotation).toBe(false);
    expect(DEFAULT_ROTATION_SETTINGS.format).toBe('doubles');
  });

  it('eligibility resets to the moment they declined, as if they had just finished a game', () => {
    const after = applyDecline(six(), 'p1', at(30), { kind: 'back_of_queue' });
    const p1 = must(after.find((p) => p.playerId === 'p1'));
    expect(p1.eligibleSince).toBe(at(30));
    expect(p1.declinedCurrentTurn).toBe(true);
    const q = orderQueue(after, at(31));
    expect(ids(q)).toEqual(['p2', 'p3', 'p4', 'p5', 'p6', 'p1']);
    expect(must(q[5]).waitedMs).toBe(60000);
  });

  it('the decliner is skipped this turn and the next players fill the court', () => {
    const after = applyDecline(six(), 'p1', at(30), { kind: 'back_of_queue' });
    const r = recommend({ now: at(30), players: after, courts: courts(1), settings: settings() });
    expect(must(r.recommendations[0]).playerIds).toEqual(['p2', 'p3', 'p4', 'p5']);
    expect(r.excluded).toContainEqual({ playerId: 'p1', reason: 'declined' });
  });

  it('even when they are needed to fill a court, a decliner is not recommended this turn (the court stays open)', () => {
    const four = ['p1', 'p2', 'p3', 'p4'].map((id, i) => qp(id, i));
    const after = applyDecline(four, 'p2', at(10), { kind: 'back_of_queue' });
    const r = recommend({ now: at(10), players: after, courts: courts(1), settings: settings() });
    expect(r.recommendations).toEqual([]);
    expect(must(r.openCourts[0])).toMatchObject({ needed: 4, available: 3 });
  });

  it('next turn they are eligible again, behind those waiting when they declined but ahead of anyone who became eligible later', () => {
    const players = [...six(), qp('late', 31)];
    const after = startNewTurn(applyDecline(players, 'p1', at(30), { kind: 'back_of_queue' }));
    expect(must(after.find((p) => p.playerId === 'p1')).declinedCurrentTurn ?? false).toBe(false);
    expect(ids(orderQueue(after, at(40)))).toEqual(['p2', 'p3', 'p4', 'p5', 'p6', 'p1', 'late']);
    const r = recommend({ now: at(40), players: after, courts: courts(2), settings: settings() });
    expect(r.recommendations.map((x) => x.playerIds)).toEqual([['p2', 'p3', 'p4', 'p5']]);
    expect(must(r.openCourts[0])).toMatchObject({ courtId: 'c2', needed: 4, available: 3 });
    expect(r.excluded).toEqual([]);
  });

  it('applyDecline never mutates its input', () => {
    const players = deepFreeze(six());
    const after = applyDecline(players, 'p3', at(30), { kind: 'back_of_queue' });
    expect(must(players[2]).eligibleSince).toBe(at(2));
    expect(must(players[2]).declinedCurrentTurn).toBeUndefined();
    expect(after).not.toBe(players);
  });

  it('declining is only possible for a waiting player in the queue (RotationError otherwise)', () => {
    const players = [...six(), qp('busy', 0, { status: 'playing' }), qp('away', 0, { status: 'unavailable' })];
    expect(() => applyDecline(players, 'busy', at(30), { kind: 'back_of_queue' })).toThrow(RotationError);
    expect(() => applyDecline(players, 'away', at(30), { kind: 'back_of_queue' })).toThrow(RotationError);
    expect(() => applyDecline(players, 'ghost', at(30), { kind: 'back_of_queue' })).toThrow(RotationError);
    expect(() => applyDecline(players, 'p1', 'yesterday-ish', { kind: 'back_of_queue' })).toThrow(RotationError);
  });
});

// =========================================================================
describe('AC-03 declined turn — D1 alternatives (pure engine)', () => {
  it('keep_spot: eligibility is unchanged, they are skipped once, and next turn they are first again', () => {
    const after = applyDecline(six(), 'p1', at(30), { kind: 'keep_spot' });
    const p1 = must(after.find((p) => p.playerId === 'p1'));
    expect(p1.eligibleSince).toBe(at(0));
    expect(ids(orderQueue(after, at(30)))).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);

    const thisTurn = recommend({ now: at(30), players: after, courts: courts(1), settings: settings() });
    expect(must(thisTurn.recommendations[0]).playerIds).toEqual(['p2', 'p3', 'p4', 'p5']);
    expect(thisTurn.excluded).toContainEqual({ playerId: 'p1', reason: 'declined' });

    const nextTurn = recommend({ now: at(31), players: startNewTurn(after), courts: courts(1), settings: settings() });
    expect(must(nextTurn.recommendations[0]).playerIds).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('drop_places N: exactly N places further back, skipped this turn, and the new place holds next turn', () => {
    const after = applyDecline(six(), 'p1', at(30), { kind: 'drop_places', places: 2 });
    expect(ids(orderQueue(after, at(30)))).toEqual(['p2', 'p3', 'p1', 'p4', 'p5', 'p6']);
    const thisTurn = recommend({ now: at(30), players: after, courts: courts(1), settings: settings() });
    expect(must(thisTurn.recommendations[0]).playerIds).toEqual(['p2', 'p3', 'p4', 'p5']);

    const next = startNewTurn(after);
    expect(ids(orderQueue(next, at(31)))).toEqual(['p2', 'p3', 'p1', 'p4', 'p5', 'p6']);
    const nextTurn = recommend({ now: at(31), players: next, courts: courts(1), settings: settings() });
    expect(must(nextTurn.recommendations[0]).playerIds).toEqual(['p2', 'p3', 'p1', 'p4']);
  });

  it('drop_places from the middle of the queue moves only that player', () => {
    const after = startNewTurn(applyDecline(six(), 'p3', at(30), { kind: 'drop_places', places: 1 }));
    expect(ids(orderQueue(after, at(31)))).toEqual(['p1', 'p2', 'p4', 'p3', 'p5', 'p6']);
  });

  it('drop_places beyond the end puts the player last', () => {
    const after = startNewTurn(applyDecline(six(), 'p2', at(30), { kind: 'drop_places', places: 10 }));
    expect(ids(orderQueue(after, at(31)))).toEqual(['p1', 'p3', 'p4', 'p5', 'p6', 'p2']);
  });

  it('drop_places needs a positive whole number of places', () => {
    for (const places of [0, -1, 1.5, Number.NaN]) {
      expect(() => applyDecline(six(), 'p1', at(30), { kind: 'drop_places', places })).toThrow(RotationError);
    }
  });

  it('the three policies give three different outcomes for the same decline', () => {
    const policies: DeclinePolicy[] = [{ kind: 'back_of_queue' }, { kind: 'keep_spot' }, { kind: 'drop_places', places: 3 }];
    const orders = policies.map((policy) => ids(orderQueue(startNewTurn(applyDecline(six(), 'p1', at(30), policy)), at(31))));
    expect(orders).toEqual([
      ['p2', 'p3', 'p4', 'p5', 'p6', 'p1'],
      ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      ['p2', 'p3', 'p4', 'p1', 'p5', 'p6'],
    ]);
  });
});

// =========================================================================
// Data layer

let dir = '';
const opened: Db[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbop-p3-decline-'));
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

function world(n: number, courtCount = 2): World {
  const file = join(dir, 'decline.db');
  const db = openAt(file);
  const session = createSession(db, { name: 'Decline night', courtCount, startedAt: at(-30) });
  const p: string[] = [];
  for (let i = 0; i < n; i++) {
    const entry = addNewPlayerToSession(db, session.id, { displayName: `P${i + 1}` });
    checkInPlayer(db, session.id, entry.playerId, at(i));
    p.push(entry.playerId);
  }
  return { db, file, session, courts: listCourts(db, session.id), p };
}

describe('AC-03 declined turn — persisted per session (data layer)', () => {
  it('default back_of_queue: logged, moved to the back, skipped this turn, eligible again after the next assignment', () => {
    const w = world(8);
    expect(getRotationSettings(w.db, w.session.id)).toEqual(DEFAULT_ROTATION_SETTINGS);
    const p1 = must(w.p[0]);

    const q = declineTurn(w.db, w.session.id, p1, { at: at(10) });
    expect(ids(q)).toEqual([...w.p.slice(1), p1]);
    expect(must(q[7]).eligibleSince).toBe(at(10));
    expect(must(q[7]).declinedCurrentTurn).toBe(true);

    const events = listRotationEvents(w.db, w.session.id).filter((e) => e.type === 'declined');
    expect(events).toHaveLength(1);
    expect(must(events[0]).occurredAt).toBe(at(10));
    expect(must(events[0]).data.playerId).toBe(p1);
    expect(must(events[0]).data.policy).toEqual({ kind: 'back_of_queue' });

    const r = recommendNextGames(w.db, w.session.id, { at: at(10) });
    expect(r.recommendations).toHaveLength(1);
    expect(must(r.recommendations[0]).playerIds).toEqual(w.p.slice(1, 5));
    expect(r.excluded).toContainEqual({ playerId: p1, reason: 'declined' });
    expect(must(r.openCourts[0])).toMatchObject({ courtId: must(w.courts[1]).id, available: 3 });

    assignRecommendation(w.db, w.session.id, must(r.recommendations[0]), { at: at(11) });
    // the turn is over: P1 is eligible again, behind P6..P8 (eligible since 10)
    const next = must(recommendNextGames(w.db, w.session.id, { at: at(12) }).recommendations[0]);
    expect(next.courtId).toBe(must(w.courts[1]).id);
    expect(next.playerIds).toEqual([...w.p.slice(5, 8), p1]);
    expect(getQueue(w.db, w.session.id, { at: at(12) }).every((e) => !e.declinedCurrentTurn)).toBe(true);
  });

  it('keep_spot is selectable per session and persists; the decliner keeps first place and plays next turn', () => {
    const w = world(8);
    const chosen = setRotationSettings(w.db, w.session.id, { declinePolicy: { kind: 'keep_spot' } }, { at: at(1) });
    expect(chosen.declinePolicy).toEqual({ kind: 'keep_spot' });
    w.db.close();
    const db = openAt(w.file);
    expect(getRotationSettings(db, w.session.id)).toEqual({ ...DEFAULT_ROTATION_SETTINGS, declinePolicy: { kind: 'keep_spot' } });

    const p1 = must(w.p[0]);
    const q = declineTurn(db, w.session.id, p1, { at: at(10) });
    expect(must(q[0]).playerId).toBe(p1);
    expect(must(q[0]).eligibleSince).toBe(at(0));
    const r = recommendNextGames(db, w.session.id, { at: at(10) });
    expect(must(r.recommendations[0]).playerIds).toEqual(w.p.slice(1, 5));
    assignRecommendation(db, w.session.id, must(r.recommendations[0]), { at: at(10) });

    const next = must(recommendNextGames(db, w.session.id, { at: at(11) }).recommendations[0]);
    expect(next.playerIds).toEqual([p1, ...w.p.slice(5, 8)]);
    expect(must(listRotationEvents(db, w.session.id).find((e) => e.type === 'declined')).data.policy).toEqual({
      kind: 'keep_spot',
    });
  });

  it('drop_places is selectable per session: the decliner moves exactly N places back', () => {
    const w = world(8, 3);
    setRotationSettings(w.db, w.session.id, { declinePolicy: { kind: 'drop_places', places: 2 } });
    const p1 = must(w.p[0]);
    const q = declineTurn(w.db, w.session.id, p1, { at: at(10) });
    expect(ids(q)).toEqual([w.p[1], w.p[2], p1, ...w.p.slice(3)]);
    const r = recommendNextGames(w.db, w.session.id, { at: at(10) });
    expect(must(r.recommendations[0]).playerIds).toEqual(w.p.slice(1, 5));
    assignManually(w.db, w.session.id, {
      courtId: must(w.courts[2]).id,
      format: 'doubles',
      teamA: [must(w.p[4]), must(w.p[5])],
      teamB: [must(w.p[6]), must(w.p[7])],
      reason: 'Group asked to play together',
      at: at(11),
    });
    // a manual assignment also ends the turn; P1 is eligible again at their new place
    const queue = getQueue(w.db, w.session.id, { at: at(12) });
    expect(ids(queue)).toEqual([w.p[1], w.p[2], p1, w.p[3]]);
    expect(must(recommendNextGames(w.db, w.session.id, { at: at(12) }).recommendations[0]).playerIds).toEqual([
      w.p[1],
      w.p[2],
      p1,
      w.p[3],
    ]);
  });

  it('a pending decline survives closing and reopening the database file', () => {
    const w = world(8);
    const p1 = must(w.p[0]);
    declineTurn(w.db, w.session.id, p1, { at: at(10) });
    w.db.close();
    const db = openAt(w.file);
    const r = recommendNextGames(db, w.session.id, { at: at(10) });
    expect(must(r.recommendations[0]).playerIds).not.toContain(p1);
    expect(r.excluded).toContainEqual({ playerId: p1, reason: 'declined' });
  });

  it('an invalid policy is refused and nothing changes', () => {
    const w = world(4);
    const before = listRotationEvents(w.db, w.session.id).length;
    for (const places of [0, 1.5, -2]) {
      expect(() => setRotationSettings(w.db, w.session.id, { declinePolicy: { kind: 'drop_places', places } })).toThrow(
        ValidationError,
      );
    }
    expect(getRotationSettings(w.db, w.session.id)).toEqual(DEFAULT_ROTATION_SETTINGS);
    expect(listRotationEvents(w.db, w.session.id)).toHaveLength(before);
  });

  it('settings changes are logged as RotationEvents', () => {
    const w = world(4);
    setRotationSettings(w.db, w.session.id, { declinePolicy: { kind: 'drop_places', places: 3 } }, { at: at(5) });
    const ev = must(listRotationEvents(w.db, w.session.id).find((e) => e.type === 'settings_changed'));
    expect(ev.occurredAt).toBe(at(5));
    expect(ev.data.settings).toEqual({ ...DEFAULT_ROTATION_SETTINGS, declinePolicy: { kind: 'drop_places', places: 3 } });
  });

  it('only a waiting player can decline; a refused decline writes nothing', () => {
    const w = world(9);
    const game = assignRecommendation(
      w.db,
      w.session.id,
      must(recommendNextGames(w.db, w.session.id, { at: at(10) }).recommendations[0]),
      { at: at(10) },
    );
    expect(game.participants).toHaveLength(4);
    setAvailability(w.db, w.session.id, must(w.p[8]), 'resting');
    const notHere = addNewPlayerToSession(w.db, w.session.id, { displayName: 'Absent' }).playerId;
    const before = listRotationEvents(w.db, w.session.id).length;
    expect(() => declineTurn(w.db, w.session.id, must(w.p[0]), { at: at(11) })).toThrow(ValidationError);
    expect(() => declineTurn(w.db, w.session.id, must(w.p[8]), { at: at(11) })).toThrow(ValidationError);
    expect(() => declineTurn(w.db, w.session.id, notHere, { at: at(11) })).toThrow(ValidationError);
    expect(listRotationEvents(w.db, w.session.id)).toHaveLength(before);
  });

  it('a completed session is read-only for declines and settings', () => {
    const w = world(4);
    finishSession(w.db, w.session.id, { endedAt: at(60) });
    expect(() => declineTurn(w.db, w.session.id, must(w.p[0]), { at: at(61) })).toThrow(SessionReadOnlyError);
    expect(() => setRotationSettings(w.db, w.session.id, { skillBalancing: true })).toThrow(SessionReadOnlyError);
    expect(listRotationEvents(w.db, w.session.id)).toEqual([]);
  });
});
