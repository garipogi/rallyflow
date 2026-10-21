import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Db } from './db';

/** The concrete better-sqlite3 handle behind the narrow `Db` interface. */
export type Sqlite = BetterSqlite3.Database;

export function raw(db: Db): Sqlite {
  return db as unknown as Sqlite;
}

/** Opaque, stable identifier. Never derived from a name. */
export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseJson(text: string | null): unknown {
  return text === null ? null : (JSON.parse(text) as unknown);
}
