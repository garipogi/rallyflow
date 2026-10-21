import type { Db } from './db';
import { SessionReadOnlyError, ValidationError } from './errors';
import { raw } from './sqlite';

/**
 * Brief §5 E: a completed session rejects every write until it is explicitly reopened.
 * Checked first by every write path.
 */
export function assertSessionWritable(db: Db, sessionId: string): void {
  const row = raw(db).prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as
    | { status: string }
    | undefined;
  if (!row) throw new ValidationError(`Unknown session: ${sessionId}`);
  if (row.status === 'completed') throw new SessionReadOnlyError();
}

export function sessionIdOfCourt(db: Db, courtId: string): string {
  const row = raw(db).prepare('SELECT session_id FROM courts WHERE id = ?').get(courtId) as
    | { session_id: string }
    | undefined;
  if (!row) throw new ValidationError(`Unknown court: ${courtId}`);
  return row.session_id;
}

export function sessionIdOfGame(db: Db, gameId: string): string {
  const row = raw(db).prepare('SELECT session_id FROM games WHERE id = ?').get(gameId) as
    | { session_id: string }
    | undefined;
  if (!row) throw new ValidationError(`Unknown game: ${gameId}`);
  return row.session_id;
}
