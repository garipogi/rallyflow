import type { Db } from './db';
import { withTransaction } from './db';
import { assertValidCourtCount, insertCourt, listCourts } from './courts';
import { ConfirmationRequiredError, SessionStateError, ValidationError } from './errors';
import { listGames } from './games';
import { recordAudit } from './audit';
import { newId, nowIso, parseJson, raw } from './sqlite';
import { listRoster } from './roster';
import type { AuditEvent, Session, SessionState, SessionStatus } from './types';

interface SessionRow {
  id: string;
  name: string;
  status: SessionStatus;
  started_at: string;
  ended_at: string | null;
  target_score: number;
  win_by: number;
  scoring_mode: 'side_out';
  court_count: number;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    targetScore: row.target_score,
    winBy: row.win_by,
    scoringMode: row.scoring_mode,
    courtCount: row.court_count,
  };
}

export function getSession(db: Db, id: string): Session | null {
  const row = raw(db).prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  return row ? toSession(row) : null;
}

function requireSession(db: Db, id: string): Session {
  const session = getSession(db, id);
  if (!session) throw new ValidationError(`Unknown session: ${id}`);
  return session;
}

export function createSession(
  db: Db,
  input: { name: string; courtCount: number; targetScore?: number; winBy?: number; startedAt?: string },
): Session {
  return withTransaction(db, () => {
    assertValidCourtCount(input.courtCount);
    const name = input.name.trim();
    if (name === '') throw new ValidationError('A session needs a name.');
    const targetScore = input.targetScore ?? 11;
    const winBy = input.winBy ?? 2;
    if (!Number.isInteger(targetScore) || targetScore < 1) throw new ValidationError('Target score must be a positive whole number.');
    if (!Number.isInteger(winBy) || winBy < 1) throw new ValidationError('Win-by margin must be a positive whole number.');
    const id = newId();
    raw(db)
      .prepare(
        `INSERT INTO sessions (id, name, started_at, ended_at, status, target_score, win_by, scoring_mode, court_count)
         VALUES (?, ?, ?, NULL, 'active', ?, ?, 'side_out', ?)`,
      )
      .run(id, name, input.startedAt ?? nowIso(), targetScore, winBy, input.courtCount);
    for (let number = 1; number <= input.courtCount; number++) insertCourt(db, id, number);
    return requireSession(db, id);
  });
}

export function listSessions(db: Db): Session[] {
  const rows = raw(db).prepare('SELECT * FROM sessions ORDER BY started_at, rowid').all() as SessionRow[];
  return rows.map(toSession);
}

export function finishSession(db: Db, id: string, opts: { endedAt?: string } = {}): Session {
  return withTransaction(db, () => {
    const session = requireSession(db, id);
    if (session.status === 'completed') throw new SessionStateError('This session is already completed.');
    const open = raw(db)
      .prepare("SELECT 1 FROM games WHERE session_id = ? AND status IN ('scheduled', 'in_progress') LIMIT 1")
      .get(id);
    if (open) throw new SessionStateError('Finish or mark incomplete every game before finishing the session.');
    raw(db)
      .prepare("UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ?")
      .run(opts.endedAt ?? nowIso(), id);
    return requireSession(db, id);
  });
}

/** Completed -> active so corrections are possible again; the reopening is audited. */
export function reopenSession(db: Db, id: string): Session {
  return withTransaction(db, () => {
    const session = requireSession(db, id);
    if (session.status !== 'completed') throw new SessionStateError('Only a completed session can be reopened.');
    raw(db).prepare("UPDATE sessions SET status = 'active', ended_at = NULL WHERE id = ?").run(id);
    recordAudit(db, id, 'session_reopened', { previousEndedAt: session.endedAt });
    return requireSession(db, id);
  });
}

/** Nothing deletes implicitly: the caller must pass { confirm: true }. Players stay in the registry. */
export function deleteSession(db: Db, id: string, opts: { confirm?: boolean } = {}): void {
  if (opts.confirm !== true) throw new ConfirmationRequiredError();
  withTransaction(db, () => {
    requireSession(db, id);
    const sqlite = raw(db);
    sqlite.prepare('DELETE FROM score_events WHERE game_id IN (SELECT id FROM games WHERE session_id = ?)').run(id);
    sqlite.prepare('DELETE FROM game_participants WHERE game_id IN (SELECT id FROM games WHERE session_id = ?)').run(id);
    sqlite.prepare('DELETE FROM games WHERE session_id = ?').run(id);
    sqlite.prepare('DELETE FROM rotation_events WHERE session_id = ?').run(id);
    sqlite.prepare('DELETE FROM audit_events WHERE session_id = ?').run(id);
    sqlite.prepare('DELETE FROM session_players WHERE session_id = ?').run(id);
    sqlite.prepare('DELETE FROM courts WHERE session_id = ?').run(id);
    sqlite.prepare('DELETE FROM settings WHERE key = ?').run(`rotation_settings:${id}`);
    sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  });
}

/** Startup recovery (brief §5 E): every session that was never finished. */
export function findUnfinishedSessions(db: Db): Session[] {
  const rows = raw(db)
    .prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at, rowid")
    .all() as SessionRow[];
  return rows.map(toSession);
}

/** The committed state of a session, read in one snapshot. */
export function loadSessionState(db: Db, id: string): SessionState {
  return withTransaction(db, () => ({
    session: requireSession(db, id),
    roster: listRoster(db, id),
    courts: listCourts(db, id),
    games: listGames(db, id),
  }));
}

export function listAuditEvents(db: Db, sessionId: string): AuditEvent[] {
  const rows = raw(db)
    .prepare('SELECT * FROM audit_events WHERE session_id = ? ORDER BY seq')
    .all(sessionId) as { id: string; session_id: string; occurred_at: string; action: string; details: string | null }[];
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    occurredAt: r.occurred_at,
    action: r.action,
    details: parseJson(r.details),
  }));
}
