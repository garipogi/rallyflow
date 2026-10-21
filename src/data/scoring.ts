import {
  correct,
  initialState,
  record,
  ScoringError,
  stateOf,
  undo,
  type GameSetup,
  type GameState,
  type ScoreLog,
  type ScoringEvent,
  type TeamId,
} from '../core/scoring';
import type { Db } from './db';
import { withTransaction } from './db';
import { recordAudit } from './audit';
import { ConfirmationRequiredError, SessionStateError, ValidationError } from './errors';
import { appendScoreEvent, getGame, listScoreEvents } from './games';
import { assertSessionWritable, sessionIdOfGame } from './guards';
import { nowIso, raw } from './sqlite';
import type { Game, ScoreEvent } from './types';

/*
 * Persistence of the scoring engine. The journal in score_events is append-only. Its rows are:
 *   scoring_started  { firstServingTeam, targetScore, winBy }
 *   rally | fault    the scoring event itself
 *   undo             drops the latest live event
 *   correction       { index, event } replaces the live event at that index
 *   result_recorded  { winner, scoreA, scoreB } the organizer tagged the result directly; it does not
 *                    change the folded rally log, it only marks where the authoritative result was set
 * Folding the rows in order rebuilds the ScoreLog, so a game survives a restart (brief §5 D).
 */

const STARTED = 'scoring_started';
const UNDO = 'undo';
const CORRECTION = 'correction';
const RESULT = 'result_recorded';

interface StartData {
  firstServingTeam: TeamId;
  targetScore: number;
  winBy: number;
}

function setupOf(db: Db, gameId: string, start: StartData): GameSetup {
  const game = getGame(db, gameId) as Game;
  const team = (t: TeamId): string[] =>
    game.participants
      .filter((p) => p.team === t)
      .sort((a, b) => a.startingPosition - b.startingPosition)
      .map((p) => p.playerId);
  return {
    format: game.format,
    teamA: team('A'),
    teamB: team('B'),
    firstServingTeam: start.firstServingTeam,
    targetScore: start.targetScore,
    winBy: start.winBy,
  };
}

/** Folds the persisted journal into the live log. Null when scoring has not started. */
function foldJournal(db: Db, gameId: string, rows: ScoreEvent[]): ScoreLog | null {
  const first = rows.find((r) => r.eventType === STARTED);
  if (!first) return null;
  const events: ScoringEvent[] = [];
  for (const row of rows) {
    if (row.eventType === 'rally' || row.eventType === 'fault') events.push(row.eventData as ScoringEvent);
    else if (row.eventType === UNDO) events.pop();
    else if (row.eventType === CORRECTION) {
      const data = row.eventData as { index: number; event: ScoringEvent };
      events[data.index] = data.event;
    }
  }
  return { setup: setupOf(db, gameId, first.eventData as StartData), events };
}

/** Common preconditions: the game exists and its session accepts writes. */
function guardGame(db: Db, gameId: string): Game {
  assertSessionWritable(db, sessionIdOfGame(db, gameId));
  return getGame(db, gameId) as Game;
}

function requireLog(db: Db, gameId: string): ScoreLog {
  const log = foldJournal(db, gameId, listScoreEvents(db, gameId));
  if (!log) throw new SessionStateError('Scoring has not started for this game.');
  return log;
}

/** Log of a game that is open for scoring: started and 'in_progress'. */
function requireOpenLog(db: Db, gameId: string): ScoreLog {
  const game = guardGame(db, gameId);
  const log = requireLog(db, gameId);
  if (game.status !== 'in_progress') {
    throw new SessionStateError('Only a game in progress can be scored. Reopen a completed game first.');
  }
  return log;
}

function syncGameScore(db: Db, gameId: string, state: GameState): void {
  raw(db).prepare('UPDATE games SET team_a_score = ?, team_b_score = ? WHERE id = ?').run(state.score.A, state.score.B, gameId);
}

export function loadScoreLog(db: Db, gameId: string): ScoreLog {
  sessionIdOfGame(db, gameId);
  return requireLog(db, gameId);
}

export function startScoring(
  db: Db,
  gameId: string,
  opts: { firstServingTeam: TeamId; targetScore?: number; winBy?: number },
): GameState {
  return withTransaction(db, () => {
    const sessionId = sessionIdOfGame(db, gameId);
    assertSessionWritable(db, sessionId);
    const game = getGame(db, gameId) as Game;
    if (game.status !== 'in_progress') throw new SessionStateError('Scoring can only start for a game in progress.');
    if (listScoreEvents(db, gameId).some((r) => r.eventType === STARTED)) {
      throw new SessionStateError('Scoring has already started for this game.');
    }
    const session = raw(db).prepare('SELECT target_score, win_by FROM sessions WHERE id = ?').get(sessionId) as {
      target_score: number;
      win_by: number;
    };
    const start: StartData = {
      firstServingTeam: opts.firstServingTeam,
      targetScore: opts.targetScore ?? session.target_score,
      winBy: opts.winBy ?? session.win_by,
    };
    const state = initialState(setupOf(db, gameId, start)); // validates before anything is written
    appendScoreEvent(db, gameId, { eventType: STARTED, eventData: start });
    syncGameScore(db, gameId, state);
    return state;
  });
}

export function recordScoringEvent(db: Db, gameId: string, event: ScoringEvent, opts: { occurredAt?: string } = {}): GameState {
  return withTransaction(db, () => {
    const log = requireOpenLog(db, gameId);
    const next = record(log, event);
    appendScoreEvent(db, gameId, { eventType: event.type, eventData: event, occurredAt: opts.occurredAt });
    const state = stateOf(next);
    syncGameScore(db, gameId, state);
    return state;
  });
}

export function undoLastScoringEvent(db: Db, gameId: string): GameState {
  return withTransaction(db, () => {
    const log = requireOpenLog(db, gameId);
    const state = stateOf(undo(log));
    appendScoreEvent(db, gameId, { eventType: UNDO, eventData: { index: log.events.length - 1 } });
    syncGameScore(db, gameId, state);
    return state;
  });
}

export function correctScoringEvent(
  db: Db,
  gameId: string,
  index: number,
  event: ScoringEvent,
  opts: { reason?: string } = {},
): GameState {
  return withTransaction(db, () => {
    const log = requireOpenLog(db, gameId);
    const state = stateOf(correct(log, index, event));
    const previous = log.events[index] as ScoringEvent;
    appendScoreEvent(db, gameId, { eventType: CORRECTION, eventData: { index, event } });
    recordAudit(db, sessionIdOfGame(db, gameId), 'score_correction', {
      gameId,
      eventIndex: index,
      previous,
      next: event,
      reason: opts.reason ?? null,
    });
    syncGameScore(db, gameId, state);
    return state;
  });
}

/** Completes a won game exactly once; the stored scores and winner come from the engine. */
export function finalizeGame(db: Db, gameId: string, opts: { endedAt?: string } = {}): Game {
  return withTransaction(db, () => {
    const game = guardGame(db, gameId);
    if (game.status !== 'in_progress') throw new SessionStateError(`A ${game.status} game cannot be completed.`);
    const state = stateOf(requireLog(db, gameId));
    if (!state.isOver || state.winner === null) throw new ScoringError('The game has not reached its winning score yet.');
    raw(db)
      .prepare("UPDATE games SET status = 'completed', winner = ?, team_a_score = ?, team_b_score = ?, ended_at = ? WHERE id = ?")
      .run(state.winner, state.score.A, state.score.B, opts.endedAt ?? nowIso(), gameId);
    return getGame(db, gameId) as Game;
  });
}

export interface GameResultInput {
  winner: TeamId;
  /** Final score; give both or neither. Without scores the game is stored 0-0. */
  scoreA?: number;
  scoreB?: number;
  reason?: string;
}

function checkScore(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${label} must be a whole number of 0 or more.`);
  }
  return value;
}

/**
 * Finish an in-progress game in one step by tagging the winner (optionally with the final score),
 * instead of scoring rally by rally. The recorded result is authoritative even if rally scoring had
 * started; the journal gets a result_recorded row so the history shows where the result was set.
 * Ends the game exactly like finalizeGame: status completed, winner, scores, ended_at (rotation D5).
 */
export function recordGameResult(db: Db, gameId: string, input: GameResultInput, opts: { at?: string } = {}): Game {
  return withTransaction(db, () => {
    const sessionId = sessionIdOfGame(db, gameId);
    assertSessionWritable(db, sessionId);
    const game = getGame(db, gameId) as Game;
    if (game.status !== 'in_progress') throw new SessionStateError(`A ${game.status} game cannot be completed.`);
    if (input.winner !== 'A' && input.winner !== 'B') throw new ValidationError('The winner must be team A or team B.');
    const hasA = input.scoreA !== undefined && input.scoreA !== null;
    const hasB = input.scoreB !== undefined && input.scoreB !== null;
    if (hasA !== hasB) throw new ValidationError('Enter both final scores, or neither.');
    let scoreA = 0;
    let scoreB = 0;
    if (hasA && hasB) {
      scoreA = checkScore(input.scoreA, 'Team A score');
      scoreB = checkScore(input.scoreB, 'Team B score');
      const winnerScore = input.winner === 'A' ? scoreA : scoreB;
      const loserScore = input.winner === 'A' ? scoreB : scoreA;
      if (winnerScore <= loserScore) throw new ValidationError(`Team ${input.winner} won, so its score must be higher.`);
    }
    const at = opts.at ?? nowIso();
    const journal = listScoreEvents(db, gameId);
    const log = foldJournal(db, gameId, journal);
    const previous = log ? stateOf(log).score : null;
    if (log) appendScoreEvent(db, gameId, { eventType: RESULT, eventData: { winner: input.winner, scoreA, scoreB }, occurredAt: at });
    raw(db)
      .prepare("UPDATE games SET status = 'completed', winner = ?, team_a_score = ?, team_b_score = ?, ended_at = ? WHERE id = ?")
      .run(input.winner, scoreA, scoreB, at, gameId);
    recordAudit(
      db,
      sessionId,
      'game_result_recorded',
      {
        gameId,
        winner: input.winner,
        scoreA: hasA ? scoreA : null,
        scoreB: hasB ? scoreB : null,
        rallyScoreBefore: previous,
        reason: input.reason ?? null,
      },
      at,
    );
    return getGame(db, gameId) as Game;
  });
}

/** Brief §5 D: a completed game can be reopened to fix the score; its score history is kept. */
export function reopenGame(db: Db, gameId: string, opts: { confirm?: boolean; reason?: string } = {}): Game {
  return withTransaction(db, () => {
    const game = guardGame(db, gameId);
    if (opts.confirm !== true) throw new ConfirmationRequiredError('Reopening a completed game needs explicit confirmation ({ confirm: true }).');
    if (game.status !== 'completed') throw new SessionStateError('Only a completed game can be reopened.');
    raw(db).prepare("UPDATE games SET status = 'in_progress', winner = NULL, ended_at = NULL WHERE id = ?").run(gameId);
    recordAudit(db, sessionIdOfGame(db, gameId), 'game_reopened', { gameId, reason: opts.reason ?? null });
    return getGame(db, gameId) as Game;
  });
}
