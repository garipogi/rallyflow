import type { Db } from './db';
import { withTransaction } from './db';
import { SessionStateError, ValidationError } from './errors';
import { assertSessionWritable, sessionIdOfGame } from './guards';
import { newId, nowIso, parseJson, raw } from './sqlite';
import { recordAudit } from './audit';
import type { Game, GameFormat, GameParticipant, GameStatus, ScoreEvent } from './types';

interface GameRow {
  id: string;
  session_id: string;
  court_id: string;
  format: GameFormat;
  status: GameStatus;
  team_a_score: number;
  team_b_score: number;
  started_at: string | null;
  ended_at: string | null;
  winner: 'A' | 'B' | null;
}

function participantsOf(db: Db, gameId: string): GameParticipant[] {
  const rows = raw(db)
    .prepare('SELECT player_id, team, starting_position FROM game_participants WHERE game_id = ? ORDER BY team, starting_position')
    .all(gameId) as { player_id: string; team: 'A' | 'B'; starting_position: number }[];
  return rows.map((r) => ({ playerId: r.player_id, team: r.team, startingPosition: r.starting_position }));
}

function toGame(db: Db, row: GameRow): Game {
  return {
    id: row.id,
    sessionId: row.session_id,
    courtId: row.court_id,
    format: row.format,
    status: row.status,
    teamAScore: row.team_a_score,
    teamBScore: row.team_b_score,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    winner: row.winner,
    participants: participantsOf(db, row.id),
  };
}

export function getGame(db: Db, id: string): Game | null {
  const row = raw(db).prepare('SELECT * FROM games WHERE id = ?').get(id) as GameRow | undefined;
  return row ? toGame(db, row) : null;
}

export function listGames(db: Db, sessionId: string): Game[] {
  const rows = raw(db).prepare('SELECT * FROM games WHERE session_id = ? ORDER BY rowid').all(sessionId) as GameRow[];
  return rows.map((r) => toGame(db, r));
}

export function listActiveGames(db: Db, sessionId: string): Game[] {
  const rows = raw(db)
    .prepare("SELECT * FROM games WHERE session_id = ? AND status = 'in_progress' ORDER BY rowid")
    .all(sessionId) as GameRow[];
  return rows.map((r) => toGame(db, r));
}

/** Every game a player took part in, across sessions and statuses. */
export function getPlayerGameHistory(db: Db, playerId: string): Game[] {
  const rows = raw(db)
    .prepare(
      `SELECT g.* FROM games g JOIN game_participants gp ON gp.game_id = g.id
       WHERE gp.player_id = ? ORDER BY g.rowid`,
    )
    .all(playerId) as GameRow[];
  return rows.map((r) => toGame(db, r));
}

export interface NewGameInput {
  sessionId: string;
  courtId: string;
  format: GameFormat;
  teamA: string[];
  teamB: string[];
  startedAt?: string;
}

/**
 * Start a game. Everything is validated first and written in one transaction, so a
 * rejection leaves nothing behind (assignment integrity, brief §5 B/E).
 */
export function createGame(db: Db, input: NewGameInput): Game {
  return withTransaction(db, () => {
    const sqlite = raw(db);
    assertSessionWritable(db, input.sessionId);

    const court = sqlite.prepare('SELECT session_id, status, removed FROM courts WHERE id = ?').get(input.courtId) as
      | { session_id: string; status: string; removed: number }
      | undefined;
    if (!court || court.session_id !== input.sessionId || court.removed === 1) {
      throw new ValidationError('That court is not part of this session.');
    }
    if (court.status !== 'available') throw new ValidationError('That court is unavailable.');
    if (sqlite.prepare("SELECT 1 FROM games WHERE court_id = ? AND status = 'in_progress' LIMIT 1").get(input.courtId)) {
      throw new ValidationError('That court already has a game in progress.');
    }

    if (input.format !== 'singles' && input.format !== 'doubles') {
      throw new ValidationError(`Unknown game format: ${String(input.format)}`);
    }
    const teamSize = input.format === 'doubles' ? 2 : 1;
    if (input.teamA.length !== teamSize || input.teamB.length !== teamSize) {
      throw new ValidationError(`A ${input.format} game needs ${teamSize} player(s) per team.`);
    }
    const everyone = [...input.teamA, ...input.teamB];
    if (new Set(everyone).size !== everyone.length) throw new ValidationError('A player cannot appear twice in a game.');

    for (const playerId of everyone) {
      const entry = sqlite
        .prepare('SELECT checked_in_at, availability_status FROM session_players WHERE session_id = ? AND player_id = ?')
        .get(input.sessionId, playerId) as { checked_in_at: string | null; availability_status: string } | undefined;
      if (!entry) throw new ValidationError(`Player ${playerId} is not on this session's roster.`);
      if (entry.checked_in_at === null) throw new ValidationError(`Player ${playerId} has not checked in.`);
      if (entry.availability_status !== 'available') throw new ValidationError(`Player ${playerId} is not available.`);
      const playing = sqlite
        .prepare(
          `SELECT 1 FROM game_participants gp JOIN games g ON g.id = gp.game_id
           WHERE gp.player_id = ? AND g.status = 'in_progress' LIMIT 1`,
        )
        .get(playerId);
      if (playing) throw new ValidationError(`Player ${playerId} is already in a game in progress.`);
    }

    const id = newId();
    sqlite
      .prepare(
        `INSERT INTO games (id, session_id, court_id, format, status, team_a_score, team_b_score, started_at, ended_at, winner)
         VALUES (?, ?, ?, ?, 'in_progress', 0, 0, ?, NULL, NULL)`,
      )
      .run(id, input.sessionId, input.courtId, input.format, input.startedAt ?? nowIso());
    const insert = sqlite.prepare(
      'INSERT INTO game_participants (game_id, player_id, team, starting_position) VALUES (?, ?, ?, ?)',
    );
    input.teamA.forEach((playerId, i) => insert.run(id, playerId, 'A', i + 1));
    input.teamB.forEach((playerId, i) => insert.run(id, playerId, 'B', i + 1));
    return getGame(db, id) as Game;
  });
}

/** A game that stopped without a result (injury, time). The reason is kept in the audit log. */
export function markGameIncomplete(db: Db, gameId: string, reason?: string): Game {
  return withTransaction(db, () => {
    const sessionId = sessionIdOfGame(db, gameId);
    assertSessionWritable(db, sessionId);
    const game = getGame(db, gameId) as Game;
    if (game.status !== 'in_progress' && game.status !== 'scheduled') {
      throw new SessionStateError(`A ${game.status} game cannot be marked incomplete.`);
    }
    raw(db).prepare("UPDATE games SET status = 'incomplete', ended_at = ? WHERE id = ?").run(nowIso(), gameId);
    recordAudit(db, sessionId, 'game_incomplete', { gameId, reason: reason ?? null });
    return getGame(db, gameId) as Game;
  });
}

/** Append to the scorekeeping history so a game can be rebuilt after an interruption. */
export function appendScoreEvent(
  db: Db,
  gameId: string,
  input: { eventType: string; eventData?: unknown; occurredAt?: string },
): ScoreEvent {
  return withTransaction(db, () => {
    assertSessionWritable(db, sessionIdOfGame(db, gameId));
    if (input.eventType.trim() === '') throw new ValidationError('A score event needs a type.');
    const event: ScoreEvent = {
      id: newId(),
      gameId,
      occurredAt: input.occurredAt ?? nowIso(),
      eventType: input.eventType,
      eventData: input.eventData ?? null,
    };
    raw(db)
      .prepare('INSERT INTO score_events (id, game_id, occurred_at, event_type, event_data) VALUES (?, ?, ?, ?, ?)')
      .run(event.id, gameId, event.occurredAt, event.eventType, JSON.stringify(event.eventData));
    return event;
  });
}

export function listScoreEvents(db: Db, gameId: string): ScoreEvent[] {
  const rows = raw(db)
    .prepare('SELECT * FROM score_events WHERE game_id = ? ORDER BY seq')
    .all(gameId) as { id: string; game_id: string; occurred_at: string; event_type: string; event_data: string | null }[];
  return rows.map((r) => ({
    id: r.id,
    gameId: r.game_id,
    occurredAt: r.occurred_at,
    eventType: r.event_type,
    eventData: parseJson(r.event_data),
  }));
}
