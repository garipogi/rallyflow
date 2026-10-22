import {
  applyDecline,
  assertValidDeclinePolicy,
  catchUpCredits,
  DEFAULT_POOL_SETTINGS,
  DEFAULT_ROTATION_SETTINGS,
  FAIRNESS_MODES,
  fairnessOf,
  generateRoundRobin,
  MAX_ROUND_ROBIN_ROUNDS,
  POOL_NAMES,
  scheduleGameKey,
  isGroupingStyle,
  orderQueue,
  recommend,
  RotationError,
  TEAM_UP_STYLES,
  teamUpOf,
  teamUpQueue,
  type CourtInput,
  type DeclinePolicy,
  type GameFormat,
  type PastGame,
  type QueueEntry,
  type QueueOrdering,
  type QueuePlayer,
  type Recommendation,
  type RecommendationResult,
  type RotationSettings,
  type RoundRobinSchedule,
} from '../core/rotation';
import { isScoreEntryMode, SCORE_ENTRY_MODES } from '../core/scoring/quickResult';
import { listPlayerProfiles } from './profiles';
import type { Db } from './db';
import { withTransaction } from './db';
import { ValidationError } from './errors';
import { createGame, listActiveGames, listGames } from './games';
import { assertSessionWritable } from './guards';
import { listCourts } from './courts';
import { listRoster } from './roster';
import { newId, nowIso, raw } from './sqlite';
import type { Game } from './types';

export interface RotationEvent {
  id: string;
  sessionId: string;
  occurredAt: string;
  type: string;
  data: Record<string, unknown>;
}

interface RotationEventRow {
  id: string;
  session_id: string;
  occurred_at: string;
  event_data: string | null;
}

function requireSession(db: Db, sessionId: string): void {
  const row = raw(db).prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId);
  if (!row) throw new ValidationError(`Unknown session: ${sessionId}`);
}

function logEvent(db: Db, sessionId: string, type: string, data: Record<string, unknown>, at: string): void {
  raw(db)
    .prepare('INSERT INTO rotation_events (id, session_id, occurred_at, event_data) VALUES (?, ?, ?, ?)')
    .run(newId(), sessionId, at, JSON.stringify({ type, data }));
}

/** Rotation events of a session in insertion order. */
export function listRotationEvents(db: Db, sessionId: string): RotationEvent[] {
  const rows = raw(db)
    .prepare('SELECT id, session_id, occurred_at, event_data FROM rotation_events WHERE session_id = ? ORDER BY seq')
    .all(sessionId) as RotationEventRow[];
  return rows.map((r) => {
    const parsed = JSON.parse(r.event_data ?? '{}') as { type?: string; data?: Record<string, unknown> };
    return {
      id: r.id,
      sessionId: r.session_id,
      occurredAt: r.occurred_at,
      type: parsed.type ?? 'unknown',
      data: parsed.data ?? {},
    };
  });
}

// ------------------------------------------------------------------ settings

const settingsKey = (sessionId: string): string => `rotation_settings:${sessionId}`;

function validateSettings(settings: RotationSettings): void {
  if (settings.format !== 'singles' && settings.format !== 'doubles') {
    throw new ValidationError(`Unknown game format: ${String(settings.format)}`);
  }
  if (typeof settings.skillBalancing !== 'boolean' || typeof settings.partnerRotation !== 'boolean') {
    throw new ValidationError('Skill balancing and partner rotation are on/off settings.');
  }
  if (settings.fairness !== undefined && !FAIRNESS_MODES.includes(settings.fairness)) {
    throw new ValidationError(`Unknown fairness mode: ${String(settings.fairness)}`);
  }
  if (settings.teamUp !== undefined && !TEAM_UP_STYLES.includes(settings.teamUp)) {
    throw new ValidationError(`Unknown team-up style: ${String(settings.teamUp)}`);
  }
  if (settings.fixedPairs !== undefined) validateFixedPairs(settings.fixedPairs);
  if (settings.pools !== undefined) validatePools(settings.pools);
  if (settings.challenge !== undefined) validateChallenge(settings.challenge);
  if (settings.roundRobin !== undefined) validateRoundRobin(settings.roundRobin);
  if (settings.scoreEntry !== undefined && !isScoreEntryMode(settings.scoreEntry)) {
    throw new ValidationError(`Unknown scoring mode: ${String(settings.scoreEntry)}. Choose ${SCORE_ENTRY_MODES.join(', ')}.`);
  }
  try {
    assertValidDeclinePolicy(settings.declinePolicy);
  } catch (err) {
    if (err instanceof RotationError) throw new ValidationError(err.message);
    throw err;
  }
}

/** D16 fixed partners: each pair is two different player ids and nobody is in two pairs. */
function validateFixedPairs(pairs: unknown): void {
  if (!Array.isArray(pairs)) throw new ValidationError('Fixed partners must be a list of pairs.');
  const seen = new Set<string>();
  for (const pair of pairs as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((id) => typeof id === 'string' && id !== '')) {
      throw new ValidationError('Each fixed pair needs exactly two players.');
    }
    const [a, b] = pair as [string, string];
    if (a === b) throw new ValidationError('A player cannot be their own fixed partner.');
    for (const id of [a, b]) {
      if (seen.has(id)) throw new ValidationError('A player can be in only one fixed pair.');
      seen.add(id);
    }
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finiteIn = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** D17 skill pools: known keys only, cutoffs 1-8 with B below A, courts auto/alternate/a list of pools. */
function validatePools(pools: unknown): void {
  if (!isObject(pools)) throw new ValidationError('Pool settings must be an object.');
  const { source, cutoffA, cutoffB, courts, whenShort } = pools;
  if (source !== undefined && source !== 'manual' && source !== 'skill') throw new ValidationError('Pools come from the roster (manual) or from skill levels (skill).');
  if (cutoffA !== undefined && !finiteIn(cutoffA, 1, 8)) throw new ValidationError('The pool A cutoff must be a skill level from 1 to 8.');
  if (cutoffB !== undefined && cutoffB !== null) {
    if (!finiteIn(cutoffB, 1, 8)) throw new ValidationError('The pool B cutoff must be a skill level from 1 to 8.');
    const a = typeof cutoffA === 'number' ? cutoffA : DEFAULT_POOL_SETTINGS.cutoffA;
    if ((cutoffB as number) >= a) throw new ValidationError('The pool B cutoff must be below the pool A cutoff.');
  }
  if (courts !== undefined && courts !== 'auto' && courts !== 'alternate') {
    if (!Array.isArray(courts) || courts.length > 8 || !courts.every((c) => (POOL_NAMES as readonly unknown[]).includes(c))) {
      throw new ValidationError('Court pools must be auto, alternate, or one pool (A, B or C) per court.');
    }
  }
  if (whenShort !== undefined && whenShort !== 'stay_open' && whenShort !== 'borrow') {
    throw new ValidationError('When a pool is short the court stays open or borrows players.');
  }
}

/** D17 challenge court: cap 1-3 games in a row, on the first court or all courts. */
function validateChallenge(challenge: unknown): void {
  if (!isObject(challenge)) throw new ValidationError('Challenge court settings must be an object.');
  const { cap, courts } = challenge;
  if (cap !== undefined && !(typeof cap === 'number' && Number.isInteger(cap) && cap >= 1 && cap <= 3)) {
    throw new ValidationError('Winners can stay on for 1, 2 or 3 games in a row.');
  }
  if (courts !== undefined && courts !== 'first' && courts !== 'all') throw new ValidationError('The challenge court is the first court or every court.');
}

/** D17 round robin schedule shape: teams of the right size, nobody twice in a round. */
function validateRoundRobin(schedule: unknown): void {
  const bad = (why: string): never => {
    throw new ValidationError(`Round-robin schedule: ${why}`);
  };
  if (!isObject(schedule)) bad('must be an object.');
  const s = schedule as Record<string, unknown>;
  if (typeof s.id !== 'string' || s.id === '' || typeof s.createdAt !== 'string') bad('missing id or creation time.');
  if (s.format !== 'singles' && s.format !== 'doubles') bad('unknown format.');
  if (!(typeof s.courtCount === 'number' && Number.isInteger(s.courtCount) && s.courtCount >= 1)) bad('needs at least one court.');
  if (!Array.isArray(s.playerIds) || !s.playerIds.every((id) => typeof id === 'string')) bad('player list is malformed.');
  if (!Array.isArray(s.rounds) || s.rounds.length > MAX_ROUND_ROBIN_ROUNDS) bad(`needs 0 to ${MAX_ROUND_ROBIN_ROUNDS} rounds.`);
  const size = s.format === 'singles' ? 1 : 2;
  for (const round of s.rounds as unknown[]) {
    if (!isObject(round) || !Array.isArray(round.games) || !Array.isArray(round.byes)) bad('a round is malformed.');
    const r = round as { games: unknown[]; byes: unknown[] };
    const seen = new Set<string>();
    const note = (id: unknown): void => {
      if (typeof id !== 'string') bad('a player id is malformed.');
      if (seen.has(id as string)) bad('a player appears twice in one round.');
      seen.add(id as string);
    };
    for (const game of r.games) {
      if (!isObject(game) || !Array.isArray(game.teamA) || !Array.isArray(game.teamB) || game.teamA.length !== size || game.teamB.length !== size) {
        bad(`every ${s.format as string} team needs ${size} ${size === 1 ? 'player' : 'players'}.`);
      }
      for (const id of [...(game as { teamA: unknown[] }).teamA, ...(game as { teamB: unknown[] }).teamB]) note(id);
    }
    for (const id of r.byes) note(id);
  }
}

/** The session's rotation settings; defaults (docs/DECISIONS.md) until changed. */
export function getRotationSettings(db: Db, sessionId: string): RotationSettings {
  requireSession(db, sessionId);
  const row = raw(db).prepare('SELECT value FROM settings WHERE key = ?').get(settingsKey(sessionId)) as
    | { value: string }
    | undefined;
  if (!row) return { ...DEFAULT_ROTATION_SETTINGS, declinePolicy: { ...DEFAULT_ROTATION_SETTINGS.declinePolicy } };
  return { ...DEFAULT_ROTATION_SETTINGS, ...(JSON.parse(row.value) as Partial<RotationSettings>) };
}

export function setRotationSettings(
  db: Db,
  sessionId: string,
  patch: Partial<RotationSettings>,
  opts: { at?: string } = {},
): RotationSettings {
  return withTransaction(db, () => {
    assertSessionWritable(db, sessionId);
    const next: RotationSettings = { ...getRotationSettings(db, sessionId), ...patch };
    validateSettings(next);
    raw(db)
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(settingsKey(sessionId), JSON.stringify(next));
    logEvent(db, sessionId, 'settings_changed', { settings: next }, opts.at ?? nowIso());
    return next;
  });
}

// --------------------------------------------------------------------- queue

interface DeclineRecord {
  occurredAt: string;
  eligibleSince: string | null;
  placeAfter: string | null;
  anchorEligibleSince: string | null;
}

/**
 * Turn state kept in the event log: each player's latest decline, and who declined during the
 * current turn (a turn ends at the next successful assignment, automatic or manual).
 */
function declineState(db: Db, sessionId: string): { latest: Map<string, DeclineRecord>; thisTurn: Set<string> } {
  const latest = new Map<string, DeclineRecord>();
  let thisTurn = new Set<string>();
  for (const ev of listRotationEvents(db, sessionId)) {
    if (ev.type === 'assigned' || ev.type === 'override') {
      thisTurn = new Set();
    } else if (ev.type === 'declined') {
      const playerId = ev.data.playerId as string;
      thisTurn.add(playerId);
      latest.set(playerId, {
        occurredAt: ev.occurredAt,
        eligibleSince: (ev.data.eligibleSince as string | null | undefined) ?? null,
        placeAfter: (ev.data.placeAfter as string | null | undefined) ?? null,
        anchorEligibleSince: (ev.data.anchorEligibleSince as string | null | undefined) ?? null,
      });
    }
  }
  return { latest, thisTurn };
}

const later = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b);

/** Everyone checked in, with the facts the engine needs. Playing/unavailable players are included with that status. */
function loadPlayers(db: Db, sessionId: string): QueuePlayer[] {
  const roster = listRoster(db, sessionId).filter((e) => e.checkedInAt !== null);
  const playing = new Set(listActiveGames(db, sessionId).flatMap((g) => g.participants.map((p) => p.playerId)));

  const lastEnd = new Map<string, string>();
  const played = new Map<string, number>();
  const ended = raw(db)
    .prepare(
      `SELECT gp.player_id AS player_id, g.ended_at AS ended_at
       FROM game_participants gp JOIN games g ON g.id = gp.game_id
       WHERE g.session_id = ? AND g.status IN ('completed', 'incomplete')`,
    )
    .all(sessionId) as { player_id: string; ended_at: string | null }[];
  for (const row of ended) {
    played.set(row.player_id, (played.get(row.player_id) ?? 0) + 1);
    if (row.ended_at !== null) lastEnd.set(row.player_id, later(lastEnd.get(row.player_id) ?? row.ended_at, row.ended_at));
  }
  // D14 catch-up credit for late arrivals (only ranked by the balanced_games queue)
  const credits = catchUpCredits(
    roster.map((e) => ({
      playerId: e.playerId,
      checkedInAt: e.checkedInAt as string,
      countsTowardMinimum: e.availability === 'available',
    })),
    ended.filter((r) => r.ended_at !== null).map((r) => ({ playerIds: [r.player_id], endedAt: r.ended_at as string })),
  );

  const { latest, thisTurn } = declineState(db, sessionId);
  // D18 gender and pool for mixed doubles and skill pools
  const profiles = listPlayerProfiles(db);
  // eligibility time: latest of check-in (D3), end of their last game (D5) and a decline that came after both (D1)
  const eligible = new Map<string, string>();
  const placeAfter = new Map<string, string>();
  for (const entry of roster) {
    const checkedInAt = entry.checkedInAt as string;
    let since = later(checkedInAt, lastEnd.get(entry.playerId) ?? checkedInAt);
    const decline = latest.get(entry.playerId);
    if (decline && Date.parse(decline.occurredAt) >= Date.parse(since) && decline.eligibleSince !== null) {
      since = later(since, decline.eligibleSince);
      if (decline.placeAfter !== null) placeAfter.set(entry.playerId, decline.placeAfter);
    }
    eligible.set(entry.playerId, since);
  }

  return roster.map((entry): QueuePlayer => {
    const id = entry.playerId;
    const status = entry.availability !== 'available' ? 'unavailable' : playing.has(id) ? 'playing' : 'waiting';
    const decline = latest.get(id);
    const anchor = placeAfter.get(id);
    // the anchor only holds while it is where it was when the player declined
    const anchorStillThere = anchor !== undefined && eligible.get(anchor) === decline?.anchorEligibleSince;
    return {
      playerId: id,
      displayName: entry.player.displayName,
      checkedInAt: entry.checkedInAt as string,
      eligibleSince: eligible.get(id) as string,
      status,
      gamesPlayed: played.get(id) ?? 0,
      skillLevel: entry.player.skillLevel,
      declinedCurrentTurn: status === 'waiting' && thisTurn.has(id),
      ...(anchorStillThere ? { placeAfter: anchor } : {}),
      ...((credits.get(id) ?? 0) > 0 ? { gameCredit: credits.get(id) as number } : {}),
      ...(profiles[id]?.gender ? { gender: profiles[id]?.gender ?? undefined } : {}),
      ...(profiles[id]?.pool ? { pool: profiles[id]?.pool ?? undefined } : {}),
    };
  });
}

/** D16: every grouping style decides who plays by balanced games, so its declines use that queue too. */
function orderingOf(settings: RotationSettings, sessionId: string): QueueOrdering {
  return { fairness: isGroupingStyle(teamUpOf(settings)) ? 'balanced_games' : fairnessOf(settings), seed: sessionId };
}

function courtInputs(db: Db, sessionId: string): CourtInput[] {
  const busyCourts = new Set(listActiveGames(db, sessionId).map((g) => g.courtId));
  return listCourts(db, sessionId).map((c) => ({
    courtId: c.id,
    label: c.label,
    status: c.status,
    occupied: busyCourts.has(c.id),
  }));
}

/**
 * The waiting queue in order (D2, D14 when the session balances games, or the D16 team-up style's
 * order), with waits measured at `opts.at` (default: now).
 */
export function getQueue(db: Db, sessionId: string, opts: { at?: string } = {}): QueueEntry[] {
  const settings = getRotationSettings(db, sessionId);
  const now = opts.at ?? nowIso();
  const style = teamUpOf(settings);
  if (isGroupingStyle(style)) {
    return teamUpQueue(
      { now, players: loadPlayers(db, sessionId), courts: courtInputs(db, sessionId), settings, pastGames: pastGamesOf(db, sessionId), seed: sessionId },
      style,
    );
  }
  return orderQueue(loadPlayers(db, sessionId), now, orderingOf(settings, sessionId));
}

// ----------------------------------------------------------- recommendations

function pastGamesOf(db: Db, sessionId: string): PastGame[] {
  return listGames(db, sessionId)
    .filter((g) => g.status !== 'cancelled')
    .map((g) => ({
      teamA: g.participants.filter((p) => p.team === 'A').map((p) => p.playerId),
      teamB: g.participants.filter((p) => p.team === 'B').map((p) => p.playerId),
      // D16: results, courts and times for paddle stacking, the river and the sit-out wheel
      winner: g.status === 'completed' ? g.winner : null,
      courtId: g.courtId,
      startedAt: g.startedAt,
      endedAt: g.status === 'completed' || g.status === 'incomplete' ? g.endedAt : null,
      // D17 Swiss: point difference
      ...(g.status === 'completed' ? { scoreA: g.teamAScore, scoreB: g.teamBScore } : {}),
    }));
}

/** D17 round robin: scheduled games of the current schedule that have started (and were not cancelled). */
function scheduleStartedOf(db: Db, sessionId: string, settings: RotationSettings): string[] {
  return scheduleProgressOf(db, sessionId, settings).started;
}

/** D17 round robin: started scheduled games, and those of them still being played. */
function scheduleProgressOf(db: Db, sessionId: string, settings: RotationSettings): { started: string[]; inProgress: string[] } {
  const schedule = settings.roundRobin;
  if (!schedule) return { started: [], inProgress: [] };
  const games = listGames(db, sessionId);
  const cancelled = new Set(games.filter((g) => g.status === 'cancelled').map((g) => g.id));
  const running = new Set(games.filter((g) => g.status === 'in_progress' || g.status === 'scheduled').map((g) => g.id));
  const keys: string[] = [];
  const inProgress: string[] = [];
  for (const ev of listRotationEvents(db, sessionId)) {
    if (ev.type !== 'assigned') continue;
    const ref = ev.data.schedule as { scheduleId?: unknown; round?: unknown; game?: unknown } | undefined;
    if (!ref || ref.scheduleId !== schedule.id || typeof ref.round !== 'number' || typeof ref.game !== 'number') continue;
    if (cancelled.has(ev.data.gameId as string)) continue;
    const key = scheduleGameKey(schedule.id, ref.round, ref.game);
    keys.push(key);
    if (running.has(ev.data.gameId as string)) inProgress.push(key);
  }
  return { started: keys, inProgress };
}

/** Read-only: what the queue says should play next on each free court, with explanations. */
export function recommendNextGames(
  db: Db,
  sessionId: string,
  opts: { at?: string; format?: GameFormat } = {},
): RecommendationResult {
  const settings = getRotationSettings(db, sessionId);
  if (opts.format !== undefined) settings.format = opts.format;
  validateSettings(settings);
  return recommend({
    now: opts.at ?? nowIso(),
    players: loadPlayers(db, sessionId),
    courts: courtInputs(db, sessionId),
    settings,
    pastGames: pastGamesOf(db, sessionId),
    seed: sessionId,
    ...(() => {
      const progress = scheduleProgressOf(db, sessionId, settings);
      return { scheduleStarted: progress.started, scheduleInProgress: progress.inProgress };
    })(),
  });
}

// --------------------------------------------------------------- round robin

export interface RoundRobinStatus {
  schedule: RoundRobinSchedule | null;
  /** Started scheduled games (scheduleGameKey). */
  started: string[];
  /** 0-based index of the first round with a game not started yet; equals rounds.length when done. */
  currentRound: number;
  /** Checked-in, available players who are not in the schedule (arrived after it was made). */
  notInSchedule: string[];
  /** Scheduled players who are no longer checked in and available (resting, gone, removed). */
  away: string[];
}

/** D17: the schedule with its progress and how the roster differs from the players it was made for. */
export function getRoundRobinStatus(db: Db, sessionId: string): RoundRobinStatus {
  const settings = getRotationSettings(db, sessionId);
  const schedule = settings.roundRobin ?? null;
  const players = loadPlayers(db, sessionId);
  const present = players.filter((p) => p.status !== 'unavailable').map((p) => p.playerId);
  if (!schedule) return { schedule: null, started: [], currentRound: 0, notInSchedule: present, away: [] };
  const started = scheduleStartedOf(db, sessionId, settings);
  const done = new Set(started);
  let currentRound = schedule.rounds.findIndex((round, r) => round.games.some((_, g) => !done.has(scheduleGameKey(schedule.id, r, g))));
  if (currentRound < 0) currentRound = schedule.rounds.length;
  const inSchedule = new Set(schedule.playerIds);
  return {
    schedule,
    started,
    currentRound,
    notInSchedule: present.filter((id) => !inSchedule.has(id)),
    away: schedule.playerIds.filter((id) => !present.includes(id)),
  };
}

/**
 * D17: generates (or regenerates) the round-robin schedule for the checked-in, available players
 * (including those on court) and the courts that are available now. Byes favour players with fewer
 * games this session. Replaces any earlier schedule; progress starts again from round 1.
 */
export function generateRoundRobinSchedule(db: Db, sessionId: string, opts: { rounds?: number; at?: string } = {}): RoundRobinSchedule {
  return withTransaction(db, () => {
    assertSessionWritable(db, sessionId);
    const at = opts.at ?? nowIso();
    const settings = getRotationSettings(db, sessionId);
    const players = loadPlayers(db, sessionId).filter((p) => p.status !== 'unavailable');
    const courtCount = listCourts(db, sessionId).filter((c) => c.status === 'available').length;
    if (courtCount === 0) throw new ValidationError('Mark at least one court available before generating a schedule.');
    if (opts.rounds !== undefined && !(Number.isInteger(opts.rounds) && opts.rounds >= 1 && opts.rounds <= MAX_ROUND_ROBIN_ROUNDS)) {
      throw new ValidationError(`Choose between 1 and ${MAX_ROUND_ROBIN_ROUNDS} rounds.`);
    }
    let schedule: RoundRobinSchedule;
    try {
      schedule = generateRoundRobin({
        id: newId(),
        createdAt: at,
        playerIds: players.map((p) => p.playerId),
        courtCount,
        format: settings.format,
        ...(opts.rounds !== undefined ? { rounds: opts.rounds } : {}),
        seed: `${sessionId}\u0000${at}`,
        initialGames: new Map(players.map((p) => [p.playerId, p.gamesPlayed + (p.gameCredit ?? 0)] as const)),
      });
    } catch (err) {
      if (err instanceof RotationError) throw new ValidationError(err.message);
      throw err;
    }
    setRotationSettings(db, sessionId, { roundRobin: schedule }, { at });
    logEvent(db, sessionId, 'schedule_generated', { scheduleId: schedule.id, rounds: schedule.rounds.length, playerIds: [...schedule.playerIds], courtCount: schedule.courtCount }, at);
    return schedule;
  });
}

// --------------------------------------------------------------- assignments

/** Start the recommended game. Phase-1 createGame rules decide whether the players and court are usable. */
export function assignRecommendation(
  db: Db,
  sessionId: string,
  rec: Recommendation,
  opts: { at?: string } = {},
): Game {
  return withTransaction(db, () => {
    assertSessionWritable(db, sessionId);
    const at = opts.at ?? nowIso();
    const inTeams = [...rec.teamA, ...rec.teamB];
    if (inTeams.length !== rec.playerIds.length || !inTeams.every((id) => rec.playerIds.includes(id))) {
      throw new ValidationError('The recommendation lists different players than its teams.');
    }
    const game = createGame(db, {
      sessionId,
      courtId: rec.courtId,
      format: rec.format,
      teamA: [...rec.teamA],
      teamB: [...rec.teamB],
      startedAt: at,
    });
    logEvent(
      db,
      sessionId,
      'assigned',
      {
        gameId: game.id,
        courtId: rec.courtId,
        playerIds: [...rec.playerIds],
        teamA: [...rec.teamA],
        teamB: [...rec.teamB],
        explanation: rec.explanation,
        ...(rec.teamUp !== undefined ? { teamUp: rec.teamUp } : {}),
        ...(rec.schedule !== undefined ? { schedule: { ...rec.schedule } } : {}),
      },
      at,
    );
    return game;
  });
}

/** Organizer override: any valid game, but never without a reason, which is stored with what the queue wanted. */
export function assignManually(
  db: Db,
  sessionId: string,
  input: { courtId: string; format: GameFormat; teamA: string[]; teamB: string[]; reason: string; at?: string },
): Game {
  return withTransaction(db, () => {
    assertSessionWritable(db, sessionId);
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason === '') throw new ValidationError('A manual assignment needs a reason.');
    const at = input.at ?? nowIso();
    const wanted = recommendNextGames(db, sessionId, { at }).recommendations.find((r) => r.courtId === input.courtId);
    const game = createGame(db, {
      sessionId,
      courtId: input.courtId,
      format: input.format,
      teamA: [...input.teamA],
      teamB: [...input.teamB],
      startedAt: at,
    });
    logEvent(
      db,
      sessionId,
      'override',
      {
        gameId: game.id,
        courtId: input.courtId,
        playerIds: [...input.teamA, ...input.teamB],
        teamA: [...input.teamA],
        teamB: [...input.teamB],
        reason,
        recommendedPlayerIds: wanted ? [...wanted.playerIds] : [],
      },
      at,
    );
    return game;
  });
}

/** A waiting player passes on this turn; the session's decline policy (D1) decides where they land. */
export function declineTurn(db: Db, sessionId: string, playerId: string, opts: { at?: string } = {}): QueueEntry[] {
  return withTransaction(db, () => {
    assertSessionWritable(db, sessionId);
    const at = opts.at ?? nowIso();
    const settings = getRotationSettings(db, sessionId);
    const policy: DeclinePolicy = settings.declinePolicy;
    const players = loadPlayers(db, sessionId);
    const target = players.find((p) => p.playerId === playerId);
    if (!target || target.status !== 'waiting') {
      throw new ValidationError('Only a checked-in, available player who is not in a game can decline a turn.');
    }
    const after = applyDecline(players, playerId, at, policy, orderingOf(settings, sessionId)).find((p) => p.playerId === playerId) as QueuePlayer;
    const moves = policy.kind !== 'keep_spot';
    const anchor = after.placeAfter ?? null;
    logEvent(
      db,
      sessionId,
      'declined',
      {
        playerId,
        policy,
        eligibleSince: moves ? after.eligibleSince : null,
        placeAfter: anchor,
        anchorEligibleSince: anchor === null ? null : (players.find((p) => p.playerId === anchor)?.eligibleSince ?? null),
      },
      at,
    );
    return getQueue(db, sessionId, { at });
  });
}
