import type { Db } from './db';
import { withTransaction } from './db';
import { assertSessionWritable, sessionIdOfCourt } from './guards';
import { SessionStateError, ValidationError } from './errors';
import { newId, raw } from './sqlite';
import type { Court, CourtStatus } from './types';

interface CourtRow {
  id: string;
  session_id: string;
  number: number;
  label: string;
  status: CourtStatus;
}

function toCourt(row: CourtRow): Court {
  return { id: row.id, sessionId: row.session_id, label: row.label, status: row.status };
}

/** Brief §2: a session runs on 2 to 4 courts. */
export function assertValidCourtCount(count: number): void {
  if (!Number.isInteger(count) || count < 2 || count > 4) {
    throw new ValidationError(`Court count must be a whole number from 2 to 4 (got ${String(count)}).`);
  }
}

export function insertCourt(db: Db, sessionId: string, number: number): void {
  raw(db)
    .prepare("INSERT INTO courts (id, session_id, number, label, status, removed) VALUES (?, ?, ?, ?, 'available', 0)")
    .run(newId(), sessionId, number, `Court ${number}`);
}

/** Configured courts in court-number order. */
export function listCourts(db: Db, sessionId: string): Court[] {
  const rows = raw(db)
    .prepare('SELECT * FROM courts WHERE session_id = ? AND removed = 0 ORDER BY number')
    .all(sessionId) as CourtRow[];
  return rows.map(toCourt);
}

export function setCourtCount(db: Db, sessionId: string, count: number): Court[] {
  return withTransaction(db, () => {
    assertSessionWritable(db, sessionId);
    assertValidCourtCount(count);
    const sqlite = raw(db);
    const dropped = sqlite
      .prepare('SELECT id FROM courts WHERE session_id = ? AND removed = 0 AND number > ?')
      .all(sessionId, count) as { id: string }[];
    for (const court of dropped) {
      const busy = sqlite
        .prepare("SELECT 1 FROM games WHERE court_id = ? AND status = 'in_progress' LIMIT 1")
        .get(court.id);
      if (busy) throw new SessionStateError('A court with a game in progress cannot be removed.');
    }
    // Dropped courts stay in the table (removed) so historical games keep their court id.
    sqlite.prepare('UPDATE courts SET removed = 1 WHERE session_id = ? AND number > ?').run(sessionId, count);
    for (let number = 1; number <= count; number++) {
      const existing = sqlite
        .prepare('SELECT id FROM courts WHERE session_id = ? AND number = ?')
        .get(sessionId, number) as { id: string } | undefined;
      if (!existing) insertCourt(db, sessionId, number);
      else sqlite.prepare('UPDATE courts SET removed = 0 WHERE id = ?').run(existing.id);
    }
    sqlite.prepare('UPDATE sessions SET court_count = ? WHERE id = ?').run(count, sessionId);
    return listCourts(db, sessionId);
  });
}

export function setCourtStatus(db: Db, courtId: string, status: CourtStatus): Court {
  return withTransaction(db, () => {
    assertSessionWritable(db, sessionIdOfCourt(db, courtId));
    if (status !== 'available' && status !== 'unavailable') {
      throw new ValidationError(`Unknown court status: ${String(status)}`);
    }
    raw(db).prepare('UPDATE courts SET status = ? WHERE id = ?').run(status, courtId);
    return toCourt(raw(db).prepare('SELECT * FROM courts WHERE id = ?').get(courtId) as CourtRow);
  });
}
