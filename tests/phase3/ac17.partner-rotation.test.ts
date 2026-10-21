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
  recommend,
  type CourtInput,
  type PastGame,
  type QueuePlayer,
  type Recommendation,
  type RotationSettings,
} from '../../src/core/rotation';
import { openDatabase, type Db } from '../../src/data/db';
import { createSession } from '../../src/data/sessions';
import { listCourts } from '../../src/data/courts';
import { addNewPlayerToSession, checkInPlayer } from '../../src/data/roster';
import { markGameIncomplete } from '../../src/data/games';
import { finalizeGame, recordScoringEvent, startScoring } from '../../src/data/scoring';
import {
  assignRecommendation,
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
const PARTNER = settings({ partnerRotation: true });
const four = (): QueuePlayer[] => ['p1', 'p2', 'p3', 'p4'].map((id, i) => qp(id, i));

/** Partnerships as a canonical, order-free string: "p1+p4|p2+p3". */
function pairing(rec: { teamA: readonly string[]; teamB: readonly string[] }): string {
  return [[...rec.teamA].sort().join('+'), [...rec.teamB].sort().join('+')].sort().join('|');
}

/** n past games in which `a` and `b` were partners (against two outsiders). */
function together(a: string, b: string, n: number): PastGame[] {
  return Array.from({ length: n }, () => ({ teamA: [a, b], teamB: ['x1', 'x2'] }));
}

function repeatsOf(rec: Recommendation, past: readonly PastGame[]): number {
  const count = (x: string, y: string): number =>
    past.filter((g) => [g.teamA, g.teamB].some((t) => t.includes(x) && t.includes(y))).length;
  const [a1, a2] = rec.teamA as [string, string];
  const [b1, b2] = rec.teamB as [string, string];
  return count(a1, a2) + count(b1, b2);
}

// =========================================================================
describe('AC-17 partner rotation (D7): fewer repeat partnerships, never a different set of players (pure engine)', () => {
  it('is off by default', () => {
    expect(DEFAULT_ROTATION_SETTINGS.partnerRotation).toBe(false);
  });

  it('picks the split with the fewest repeat partnerships', () => {
    // 12|34 → 3 + 2 = 5 ; 13|24 → 1 + 1 = 2 ; 14|23 → 0
    const past = [...together('p1', 'p2', 3), ...together('p3', 'p4', 2), ...together('p1', 'p3', 1), ...together('p2', 'p4', 1)];
    const rec = must(recommend({ now: at(30), players: four(), courts: courts(1), settings: PARTNER, pastGames: past }).recommendations[0]);
    expect(pairing(rec)).toBe('p1+p4|p2+p3');
    expect(rec.repeatPartnerships).toBe(0);
  });

  it('when every split repeats someone, it takes the least-repeated one', () => {
    // 12|34 → 2 + 0 = 2 ; 13|24 → 1 + 0 = 1 ; 14|23 → 1 + 1 = 2
    const past = [...together('p1', 'p2', 2), ...together('p1', 'p3', 1), ...together('p1', 'p4', 1), ...together('p2', 'p3', 1)];
    const rec = must(recommend({ now: at(30), players: four(), courts: courts(1), settings: PARTNER, pastGames: past }).recommendations[0]);
    expect(pairing(rec)).toBe('p1+p3|p2+p4');
    expect(rec.repeatPartnerships).toBe(1);
  });

  it('counts partnerships on either team of a past game, regardless of the order ids were listed', () => {
    const past: PastGame[] = [
      { teamA: ['x1', 'x2'], teamB: ['p4', 'p1'] },
      { teamA: ['p3', 'p2'], teamB: ['x1', 'x2'] },
      { teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] },
    ];
    // 14|23 → 1 + 1 = 2 ; 12|34 → 1 + 1 = 2 ; 13|24 → 0
    const rec = must(recommend({ now: at(30), players: four(), courts: courts(1), settings: PARTNER, pastGames: past }).recommendations[0]);
    expect(pairing(rec)).toBe('p1+p3|p2+p4');
    expect(rec.repeatPartnerships).toBe(0);
  });

  it('never changes who plays: the chosen players are exactly the queue\'s, however heavy the history', () => {
    const players = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'].map((id, i) => qp(id, i));
    // p1..p4 have partnered each other constantly; p5..p8 never
    const past = [
      ...together('p1', 'p2', 5),
      ...together('p3', 'p4', 5),
      ...together('p1', 'p3', 5),
      ...together('p2', 'p4', 5),
      ...together('p1', 'p4', 5),
      ...together('p2', 'p3', 5),
    ];
    const off = recommend({ now: at(30), players, courts: courts(2), settings: settings(), pastGames: past });
    const on = recommend({ now: at(30), players, courts: courts(2), settings: PARTNER, pastGames: past });
    expect(on.recommendations.map((x) => x.playerIds)).toEqual(off.recommendations.map((x) => x.playerIds));
    expect(must(on.recommendations[0]).playerIds).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(must(on.recommendations[0]).bypassed).toEqual([]);
  });

  it('repeatPartnerships always reports the chosen split\'s repeats, even with partner rotation off', () => {
    const past = [...together('p1', 'p2', 2), ...together('p3', 'p4', 1), ...together('p1', 'p4', 1)];
    const rec = must(recommend({ now: at(30), players: four(), courts: courts(1), settings: settings(), pastGames: past }).recommendations[0]);
    expect(rec.repeatPartnerships).toBe(repeatsOf(rec, past));
    const none = must(recommend({ now: at(30), players: four(), courts: courts(1), settings: PARTNER }).recommendations[0]);
    expect(none.repeatPartnerships).toBe(0);
  });

  it('the explanation mentions partner rotation when it is on', () => {
    const past = together('p1', 'p2', 1);
    const rec = must(recommend({ now: at(30), players: four(), courts: courts(1), settings: PARTNER, pastGames: past }).recommendations[0]);
    expect(rec.explanation.toLowerCase()).toContain('partner');
  });

  it('singles has no partners: same players, no repeats', () => {
    const players = four();
    const s = settings({ format: 'singles', partnerRotation: true });
    const past = [{ teamA: ['p1'], teamB: ['p2'] }];
    const r = recommend({ now: at(30), players, courts: courts(2), settings: s, pastGames: past });
    expect(r.recommendations.map((x) => x.playerIds)).toEqual([
      ['p1', 'p2'],
      ['p3', 'p4'],
    ]);
    for (const rec of r.recommendations) expect(rec.repeatPartnerships).toBe(0);
  });

  it('with skill balancing on too, partner rotation chooses among the equally balanced splits only', () => {
    // skills 5,5,1,1: balanced splits are 13|24 and 14|23 (6 v 6); 12|34 is 10 v 2
    const players = four().map((p, i) => ({ ...p, skillLevel: [5, 5, 1, 1][i] ?? 0 }));
    const both = settings({ skillBalancing: true, partnerRotation: true });
    const pastA = [...together('p1', 'p3', 3), ...together('p2', 'p4', 3)];
    const recA = must(recommend({ now: at(30), players, courts: courts(1), settings: both, pastGames: pastA }).recommendations[0]);
    expect(pairing(recA)).toBe('p1+p4|p2+p3');

    // partner rotation alone would pick 12|34 (no repeats) but that split is badly unbalanced
    const pastB = [...together('p1', 'p3', 5), ...together('p2', 'p4', 5), ...together('p1', 'p4', 5), ...together('p2', 'p3', 5)];
    const recB = must(recommend({ now: at(30), players, courts: courts(1), settings: both, pastGames: pastB }).recommendations[0]);
    expect(['p1+p3|p2+p4', 'p1+p4|p2+p3']).toContain(pairing(recB));
    const alone = must(recommend({ now: at(30), players, courts: courts(1), settings: PARTNER, pastGames: pastB }).recommendations[0]);
    expect(pairing(alone)).toBe('p1+p2|p3+p4');
  });

  it('the oldest-waiting player is never dropped by partner rotation (with or without skill balancing)', () => {
    const players = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id, i) => qp(id, i, { skillLevel: [9, 1, 1, 1, 1, 9][i] ?? 1 }));
    const past = [...together('p1', 'p2', 9), ...together('p1', 'p3', 9), ...together('p1', 'p4', 9), ...together('p1', 'p5', 9)];
    for (const s of [PARTNER, settings({ partnerRotation: true, skillBalancing: true })]) {
      const rec = must(recommend({ now: at(30), players, courts: courts(1), settings: s, pastGames: past }).recommendations[0]);
      expect(rec.playerIds).toContain('p1');
    }
  });
});

// =========================================================================
// Data layer: partnerships come from the session's games

let dir = '';
const opened: Db[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbop-p3-partner-'));
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

function openDb(): Db {
  const db = openDatabase(join(dir, 'partner.db'));
  opened.push(db);
  return db;
}

interface World {
  db: Db;
  session: Session;
  courts: Court[];
  p: string[];
}

function world(n: number, courtCount = 2): World {
  const db = openDb();
  const session = createSession(db, { name: 'Mixer night', courtCount, startedAt: at(-30) });
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

describe('AC-17 partner rotation reduces repeated partnerships across a session (data layer)', () => {
  it('four players with partner rotation on play three games with three different pairings', () => {
    const w = world(4);
    expect(getRotationSettings(w.db, w.session.id).partnerRotation).toBe(false);
    setRotationSettings(w.db, w.session.id, { partnerRotation: true });
    const seen: string[] = [];
    let minute = 10;
    for (let game = 0; game < 3; game++) {
      const rec = must(recommendNextGames(w.db, w.session.id, { at: at(minute) }).recommendations[0]);
      expect([...rec.playerIds].sort()).toEqual([...w.p].sort());
      expect(rec.repeatPartnerships).toBe(0);
      seen.push(pairing(rec));
      const g = assignRecommendation(w.db, w.session.id, rec, { at: at(minute) });
      minute += 12;
      playOut(w.db, g.id, minute);
      minute += 1;
    }
    expect(new Set(seen).size).toBe(3);
    // the fourth game must repeat something, and repeats exactly 2 partnerships (each split was used once)
    const fourth = must(recommendNextGames(w.db, w.session.id, { at: at(minute) }).recommendations[0]);
    expect(fourth.repeatPartnerships).toBe(2);
    // the assigned events carry the teams that were actually used
    const assigned = listRotationEvents(w.db, w.session.id).filter((e) => e.type === 'assigned');
    expect(assigned.map((e) => pairing({ teamA: e.data.teamA as string[], teamB: e.data.teamB as string[] }))).toEqual(seen);
  });

  it('partnerships from incomplete games count too', () => {
    const w = world(4);
    setRotationSettings(w.db, w.session.id, { partnerRotation: true });
    const firstRec = must(recommendNextGames(w.db, w.session.id, { at: at(10) }).recommendations[0]);
    const g1 = assignRecommendation(w.db, w.session.id, firstRec, { at: at(10) });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(at(20)));
      markGameIncomplete(w.db, g1.id, 'Injury timeout');
    } finally {
      vi.useRealTimers();
    }
    const next = must(recommendNextGames(w.db, w.session.id, { at: at(21) }).recommendations[0]);
    expect([...next.playerIds].sort()).toEqual([...w.p].sort());
    expect(next.repeatPartnerships).toBe(0);
    expect(pairing(next)).not.toBe(pairing(firstRec));
  });

  it('turning partner rotation on never changes which players the queue picks', () => {
    const w = world(11, 2);
    // play one round so there is history
    const first = recommendNextGames(w.db, w.session.id, { at: at(15) });
    const games = first.recommendations.map((rec) => assignRecommendation(w.db, w.session.id, rec, { at: at(15) }));
    games.forEach((g, i) => playOut(w.db, g.id, 30 + i));

    const off = recommendNextGames(w.db, w.session.id, { at: at(40) });
    setRotationSettings(w.db, w.session.id, { partnerRotation: true });
    const on = recommendNextGames(w.db, w.session.id, { at: at(40) });
    expect(on.recommendations.map((x) => x.playerIds)).toEqual(off.recommendations.map((x) => x.playerIds));
    expect(must(on.recommendations[0]).playerIds).toEqual([w.p[8], w.p[9], w.p[10], w.p[0]]);
  });
});
