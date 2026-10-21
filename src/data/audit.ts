import type { Db } from './db';
import { newId, nowIso, raw } from './sqlite';

export function recordAudit(db: Db, sessionId: string, action: string, details: unknown, at?: string): void {
  raw(db)
    .prepare('INSERT INTO audit_events (id, session_id, occurred_at, action, details) VALUES (?, ?, ?, ?, ?)')
    .run(newId(), sessionId, at ?? nowIso(), action, JSON.stringify(details ?? null));
}
