import Database from 'better-sqlite3';
import type { IndexInfo } from './types';
import { raw } from './sqlite';

/** Narrow handle used by every repository; a better-sqlite3 Database satisfies it. */
export interface Db {
  close(): void;
}

/** Brief §7 data model. Ids are opaque text keys; names are never keys. */
const MIGRATIONS: readonly string[] = [
  // version 1
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE players (
    id           TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    nickname     TEXT,
    skill_level  REAL,
    active       INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    status       TEXT NOT NULL CHECK (status IN ('active', 'completed')),
    target_score INTEGER NOT NULL,
    win_by       INTEGER NOT NULL,
    scoring_mode TEXT NOT NULL,
    court_count  INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_status ON sessions (status);
  CREATE INDEX idx_sessions_started_at ON sessions (started_at);

  CREATE TABLE session_players (
    session_id          TEXT NOT NULL REFERENCES sessions (id),
    player_id           TEXT NOT NULL REFERENCES players (id),
    checked_in_at       TEXT,
    availability_status TEXT NOT NULL
      CHECK (availability_status IN ('absent', 'available', 'resting', 'unavailable')),
    PRIMARY KEY (session_id, player_id)
  );
  CREATE INDEX idx_session_players_player ON session_players (player_id);

  -- Courts dropped by shrinking the court count are kept (removed = 1) so games
  -- played on them keep their court id.
  CREATE TABLE courts (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    number     INTEGER NOT NULL,
    label      TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('available', 'unavailable')),
    removed    INTEGER NOT NULL DEFAULT 0,
    UNIQUE (session_id, number)
  );

  CREATE TABLE games (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES sessions (id),
    court_id     TEXT NOT NULL REFERENCES courts (id),
    format       TEXT NOT NULL CHECK (format IN ('singles', 'doubles')),
    status       TEXT NOT NULL
      CHECK (status IN ('scheduled', 'in_progress', 'completed', 'incomplete', 'cancelled')),
    team_a_score INTEGER NOT NULL DEFAULT 0,
    team_b_score INTEGER NOT NULL DEFAULT 0,
    started_at   TEXT,
    ended_at     TEXT,
    winner       TEXT CHECK (winner IN ('A', 'B'))
  );
  CREATE INDEX idx_games_session ON games (session_id);
  CREATE INDEX idx_games_status ON games (status, court_id);
  CREATE INDEX idx_games_court ON games (court_id);

  CREATE TABLE game_participants (
    game_id           TEXT NOT NULL REFERENCES games (id),
    player_id         TEXT NOT NULL REFERENCES players (id),
    team              TEXT NOT NULL CHECK (team IN ('A', 'B')),
    starting_position INTEGER NOT NULL,
    PRIMARY KEY (game_id, player_id)
  );
  CREATE INDEX idx_game_participants_player ON game_participants (player_id);

  CREATE TABLE score_events (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    id          TEXT NOT NULL UNIQUE,
    game_id     TEXT NOT NULL REFERENCES games (id),
    occurred_at TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    event_data  TEXT
  );
  CREATE INDEX idx_score_events_game ON score_events (game_id, seq);

  CREATE TABLE rotation_events (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    id          TEXT NOT NULL UNIQUE,
    session_id  TEXT NOT NULL REFERENCES sessions (id),
    occurred_at TEXT NOT NULL,
    event_data  TEXT
  );
  CREATE INDEX idx_rotation_events_session ON rotation_events (session_id, seq);

  CREATE TABLE audit_events (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    id          TEXT NOT NULL UNIQUE,
    session_id  TEXT NOT NULL REFERENCES sessions (id),
    occurred_at TEXT NOT NULL,
    action      TEXT NOT NULL,
    details     TEXT
  );
  CREATE INDEX idx_audit_events_session ON audit_events (session_id, seq);
  `,
];

export const SCHEMA_VERSION: number = MIGRATIONS.length;

/**
 * Open (creating if needed) the database file and bring it to the current schema.
 * A file that is not an SQLite database is refused before anything is written to it.
 */
export function openDatabase(file: string): Db {
  const sqlite = new Database(file);
  try {
    // Reads the file header; throws "file is not a database" for foreign files.
    sqlite.prepare('SELECT count(*) FROM sqlite_master').get();
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = FULL'); // a committed write is on disk when the call returns
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    migrate(sqlite);
  } catch (err) {
    sqlite.close();
    throw err;
  }
  return sqlite;
}

/** Idempotent: applies only the migrations above the version stored in the file. */
export function migrate(db: Db): void {
  const sqlite = raw(db);
  withTransaction(db, () => {
    const current = sqlite.pragma('user_version', { simple: true }) as number;
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${current} is newer than this app understands (${SCHEMA_VERSION}).`,
      );
    }
    for (let v = current; v < SCHEMA_VERSION; v++) {
      sqlite.exec(MIGRATIONS[v] as string);
    }
    if (current < SCHEMA_VERSION) {
      sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
      sqlite
        .prepare(
          `INSERT INTO settings (key, value) VALUES ('schema_version', ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .run(String(SCHEMA_VERSION));
    }
  });
}

export function getSchemaVersion(db: Db): number {
  return raw(db).pragma('user_version', { simple: true }) as number;
}

export function listTables(db: Db): string[] {
  const rows = raw(db)
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

export function listIndexes(db: Db): IndexInfo[] {
  const sqlite = raw(db);
  const result: IndexInfo[] = [];
  for (const table of listTables(db)) {
    const indexes = sqlite.pragma(`index_list(${JSON.stringify(table)})`) as { name: string }[];
    for (const ix of indexes) {
      const cols = sqlite.pragma(`index_info(${JSON.stringify(ix.name)})`) as { seqno: number; name: string }[];
      result.push({
        name: ix.name,
        table,
        columns: [...cols].sort((a, b) => a.seqno - b.seqno).map((c) => c.name),
      });
    }
  }
  return result;
}

let savepointCounter = 0;

/**
 * All-or-nothing. Nested calls join the outer transaction through a savepoint, so a
 * failure inside a nested call undoes just that call and a failure outside undoes all.
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  const sqlite = raw(db);
  if (sqlite.inTransaction) {
    const name = `sp_${++savepointCounter}`;
    sqlite.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      sqlite.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      sqlite.exec(`ROLLBACK TO ${name}`);
      sqlite.exec(`RELEASE ${name}`);
      throw err;
    }
  }
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    sqlite.exec('COMMIT');
    return result;
  } catch (err) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    throw err;
  }
}
