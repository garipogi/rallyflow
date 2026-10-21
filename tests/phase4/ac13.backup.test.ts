/*
 * ============================================================================
 * PHASE 4 PUBLIC API — manual backup and validated restore (pinned by the locked tests).
 * Policy: docs/DECISIONS.md D10. A backup is ONE `.pbbackup` file holding a copy of the SQLite
 * database plus a JSON manifest (schema version, app version, created_at, SHA-256 of the database
 * copy). Restore REPLACES the database after validation and explicit confirmation; the current
 * data is backed up automatically first. No merge in v1. Brief §6: "Restoring a backup must
 * validate the file before replacing or merging data."
 *
 * src/data/backup.ts
 *   interface BackupManifest {        extra fields are allowed and must survive encode/decode
 *     schemaVersion: number;          SCHEMA_VERSION of the database inside
 *     appVersion: string;             non-empty
 *     createdAt: string;              ISO-8601 instant
 *     dbSha256: string;               lowercase hex SHA-256 of exactly the database bytes in the file
 *   }
 *   type BackupRejectReason =
 *     | 'not_a_backup'                not a .pbbackup container at all (empty, text, JSON, a raw
 *                                     SQLite file, random bytes, unreadable manifest)
 *     | 'checksum_mismatch'           database bytes do not hash to manifest.dbSha256
 *     | 'unsupported_schema'          manifest.schemaVersion (or the database's own user_version)
 *                                     is not an integer in 1..SCHEMA_VERSION
 *     | 'invalid_database'            checksum fine but the bytes are not a healthy database of
 *                                     this app (not SQLite, failed integrity check, missing tables)
 *   class BackupValidationError extends Error { readonly reason: BackupRejectReason }
 *   type BackupValidation =
 *     | { ok: true; manifest: BackupManifest }
 *     | { ok: false; reason: BackupRejectReason; message: string }
 *
 *   encodeBackup(manifest: BackupManifest, dbBytes: Uint8Array): Buffer
 *       Builds the container bytes. Does no validation (tests use it to craft bad files).
 *   decodeBackup(bytes: Uint8Array): { manifest: BackupManifest; dbBytes: Buffer }
 *       Parses the container only (no checksum or database checks). Inverse of encodeBackup.
 *       Throws BackupValidationError with reason 'not_a_backup' when the bytes are not a container.
 *   createBackup(db: Db, file: string, opts?: { appVersion?: string }): BackupManifest | Promise<BackupManifest>
 *       Writes a consistent copy of the open database to `file` (exact path) while the app keeps
 *       running. Makes no changes to the database. Returns the manifest written into the file.
 *   validateBackup(file: string): BackupValidation | Promise<BackupValidation>
 *       Full validation (container, checksum, schema version, database health and tables).
 *       Never throws for bad content and never modifies the file.
 *   restoreBackup(file: string, opts: { dbFile: string; autoBackupDir: string; confirm?: boolean;
 *                                       appVersion?: string })
 *       : { manifest: BackupManifest; autoBackupFile: string } | Promise<same>
 *       The caller closes every connection to dbFile first and reopens it afterwards.
 *       Order: (1) validate -> BackupValidationError(reason); (2) confirm !== true ->
 *       ConfirmationRequiredError (src/data/errors); (3) back up the current dbFile into a NEW
 *       file ending in '.pbbackup' inside autoBackupDir; (4) replace dbFile with the backup's
 *       database. When (1) or (2) fails, dbFile is byte-identical afterwards and nothing is written
 *       into autoBackupDir.
 * ============================================================================
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getSchemaVersion, listTables, openDatabase, SCHEMA_VERSION, type Db } from '../../src/data/db';
import { createSession, getSession, listSessions } from '../../src/data/sessions';
import { addNewPlayerToSession, checkInPlayer } from '../../src/data/roster';
import { listCourts } from '../../src/data/courts';
import { createGame, getGame } from '../../src/data/games';
import { ConfirmationRequiredError } from '../../src/data/errors';
import { finalizeGame, loadScoreLog, recordScoringEvent, startScoring } from '../../src/data/scoring';
import type { GameState, TeamId } from '../../src/core/scoring';
import {
  BackupValidationError,
  createBackup,
  decodeBackup,
  encodeBackup,
  restoreBackup,
  validateBackup,
  type BackupManifest,
  type BackupRejectReason,
} from '../../src/data/backup';

let dir: string;
let dbFile: string;
let autoDir: string;
let db: Db;
let open = false;
let crafted = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbop-p4-backup-'));
  dbFile = join(dir, 'app.db');
  autoDir = join(dir, 'auto');
  mkdirSync(autoDir);
  db = openDatabase(dbFile);
  open = true;
});

afterEach(() => {
  if (open) db.close();
  open = false;
  rmSync(dir, { recursive: true, force: true });
});

function closeDb(): void {
  if (open) db.close();
  open = false;
}

function reopenDb(): void {
  closeDb();
  db = openDatabase(dbFile);
  open = true;
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fileSha = (file: string): string => sha(readFileSync(file));

/** Every row of every table, in rowid order: the full logical content of a database. */
function dumpConnection(conn: Database.Database): Record<string, unknown[]> {
  const tables = (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  return Object.fromEntries(tables.map((t) => [t, conn.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]));
}

const dumpDb = (): Record<string, unknown[]> => dumpConnection(db as unknown as Database.Database);

function dumpBytes(bytes: Uint8Array): Record<string, unknown[]> {
  const f = join(dir, `inspect-${++crafted}.db`);
  writeFileSync(f, bytes);
  const conn = new Database(f);
  try {
    return dumpConnection(conn);
  } finally {
    conn.close();
  }
}

/** Raw SQLite file bytes built by `setup` (for foreign / wrong-version databases). */
function sqliteBytes(setup: (conn: Database.Database) => void, from?: Uint8Array): Buffer {
  const f = join(dir, `craft-${++crafted}.db`);
  if (from) writeFileSync(f, from);
  const conn = new Database(f);
  setup(conn);
  conn.close();
  return readFileSync(f);
}

function scorePoint(gameId: string, state: GameState, team: TeamId): GameState {
  let s = state;
  const target = s.score[team] + 1;
  for (let i = 0; i < 10 && s.score[team] < target; i++) s = recordScoringEvent(db, gameId, { type: 'rally', winner: team });
  if (s.score[team] !== target) throw new Error('could not score a point');
  return s;
}

interface Seed {
  sessionId: string;
  liveGameId: string;
  finishedGameId: string;
}

/** A session with a finalized doubles game and a doubles game in progress at 4-2. */
function seed(name = 'Backup night'): Seed {
  const session = createSession(db, { name, courtCount: 2 });
  const courts = listCourts(db, session.id);
  const c1 = courts[0];
  const c2 = courts[1];
  if (!c1 || !c2) throw new Error("expected two courts");
  const ids = ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal'].map((displayName) => {
    const e = addNewPlayerToSession(db, session.id, { displayName: `${displayName} ${name}` });
    checkInPlayer(db, session.id, e.playerId);
    return e.playerId;
  });
  const done = createGame(db, { sessionId: session.id, courtId: c1.id, format: 'doubles', teamA: ids.slice(0, 2), teamB: ids.slice(2, 4) });
  let s = startScoring(db, done.id, { firstServingTeam: 'A' });
  while (s.score.B < 5) s = scorePoint(done.id, s, 'B');
  while (s.score.A < 11) s = scorePoint(done.id, s, 'A');
  finalizeGame(db, done.id);
  const live = createGame(db, { sessionId: session.id, courtId: c2.id, format: 'doubles', teamA: ids.slice(4, 6), teamB: ids.slice(6, 8) });
  s = startScoring(db, live.id, { firstServingTeam: 'B' });
  while (s.score.B < 4) s = scorePoint(live.id, s, 'B');
  while (s.score.A < 2) s = scorePoint(live.id, s, 'A');
  return { sessionId: session.id, liveGameId: live.id, finishedGameId: done.id };
}

async function makeBackup(name = 'nightly.pbbackup'): Promise<{ file: string; manifest: BackupManifest; dump: Record<string, unknown[]> }> {
  const file = join(dir, name);
  const manifest = await createBackup(db, file, { appVersion: '1.4.2-test' });
  return { file, manifest, dump: dumpDb() };
}

function writeCrafted(bytes: Uint8Array, name = `bad-${++crafted}.pbbackup`): string {
  const f = join(dir, name);
  writeFileSync(f, bytes);
  return f;
}

/**
 * The file must be refused by validateBackup and by restoreBackup (even with confirm: true), and the
 * current database must be left exactly as it was, with no auto-backup written.
 */
async function expectRejected(file: string, reasons?: BackupRejectReason[]): Promise<void> {
  const fileBefore = fileSha(file);
  const v = await validateBackup(file);
  expect(v.ok).toBe(false);
  if (!v.ok) {
    if (reasons) expect(reasons).toContain(v.reason);
    expect(typeof v.message).toBe('string');
    expect(v.message.length).toBeGreaterThan(0);
  }
  expect(fileSha(file)).toBe(fileBefore);

  const dumpBefore = dumpDb();
  closeDb();
  const dbBefore = fileSha(dbFile);
  let thrown: unknown = null;
  try {
    await restoreBackup(file, { dbFile, autoBackupDir: autoDir, confirm: true });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(BackupValidationError);
  if (reasons) expect(reasons).toContain((thrown as BackupValidationError).reason);
  if (!v.ok) expect((thrown as BackupValidationError).reason).toBe(v.reason);
  expect(fileSha(dbFile)).toBe(dbBefore);
  expect(readdirSync(autoDir)).toEqual([]);
  reopenDb();
  expect(dumpDb()).toEqual(dumpBefore);
}

/** Deterministic pseudo-random bytes. */
function noise(length: number, seedValue = 12345): Buffer {
  const out = Buffer.alloc(length);
  let x = seedValue >>> 0;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

describe('AC-13 backup file (D10): one .pbbackup with database copy and manifest', () => {
  it('createBackup writes a manifest with schema version, app version, created_at and the SHA-256 of the database', async () => {
    seed();
    const t0 = Date.now();
    const { file, manifest } = await makeBackup();
    const t1 = Date.now();
    expect(existsSync(file)).toBe(true);
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(manifest.appVersion).toBe('1.4.2-test');
    const created = Date.parse(manifest.createdAt);
    expect(Number.isFinite(created)).toBe(true);
    expect(created).toBeGreaterThanOrEqual(t0 - 1000);
    expect(created).toBeLessThanOrEqual(t1 + 1000);
    expect(manifest.dbSha256).toMatch(/^[0-9a-f]{64}$/);

    const decoded = decodeBackup(readFileSync(file));
    expect(decoded.manifest).toEqual(manifest);
    expect(sha(decoded.dbBytes)).toBe(manifest.dbSha256);
    // The database copy is a real SQLite database (header) of the current schema.
    expect(decoded.dbBytes.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\u0000');

    const v = await validateBackup(file);
    expect(v).toEqual({ ok: true, manifest });
  });

  it('the database inside holds exactly the current data, and making the backup changes nothing', async () => {
    seed();
    const conn = db as unknown as Database.Database;
    const changes = (): number => (conn.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const before = changes();
    const { file, dump } = await makeBackup();
    expect(changes()).toBe(before);
    const inside = dumpBytes(decodeBackup(readFileSync(file)).dbBytes);
    expect(inside).toEqual(dump);
    expect(Object.keys(inside)).toEqual(expect.arrayContaining(listTables(db)));
  });

  it('appVersion defaults to a non-empty string', async () => {
    seed();
    const file = join(dir, 'default.pbbackup');
    const manifest = await createBackup(db, file);
    expect(typeof manifest.appVersion).toBe('string');
    expect(manifest.appVersion.length).toBeGreaterThan(0);
    expect((await validateBackup(file)).ok).toBe(true);
  });

  it('encodeBackup / decodeBackup are inverses and keep extra manifest fields', () => {
    const bytes = noise(10000, 7);
    const manifest = { schemaVersion: 3, appVersion: '9.9.9', createdAt: '2026-10-21T10:00:00.000Z', dbSha256: sha(bytes), note: 'extra' };
    const decoded = decodeBackup(encodeBackup(manifest, bytes));
    expect(decoded.manifest).toEqual(manifest);
    expect(Buffer.compare(decoded.dbBytes, bytes)).toBe(0);
  });
});

describe('AC-13 restore round-trips a valid backup', () => {
  it('replaces the database with the backup after confirmation; later changes are gone', async () => {
    const first = seed('Monday');
    const { file, manifest, dump } = await makeBackup();
    const logAtBackup = loadScoreLog(db, first.liveGameId);

    // Changes after the backup: more scoring, a new session.
    const s = recordScoringEvent(db, first.liveGameId, { type: 'rally', winner: 'B' });
    expect(s.rallies).toBeGreaterThan(logAtBackup.events.length);
    const later = seed('Tuesday');
    expect(listSessions(db)).toHaveLength(2);

    closeDb();
    const result = await restoreBackup(file, { dbFile, autoBackupDir: autoDir, confirm: true });
    expect(result.manifest).toEqual(manifest);
    reopenDb();

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(dumpDb()).toEqual(dump);
    expect(getSession(db, later.sessionId)).toBeNull();
    expect(listSessions(db).map((x) => x.id)).toEqual([first.sessionId]);
    expect(getGame(db, first.finishedGameId)).toMatchObject({ status: 'completed', winner: 'A', teamAScore: 11, teamBScore: 5 });
    // The in-progress game reconstructs from its restored score events and can be scored on.
    expect(loadScoreLog(db, first.liveGameId)).toEqual(logAtBackup);
    const resumed = recordScoringEvent(db, first.liveGameId, { type: 'rally', winner: 'A' });
    expect(resumed.rallies).toBe(logAtBackup.events.length + 1);
    // The backup file itself is untouched by the restore.
    expect((await validateBackup(file)).ok).toBe(true);
  });

  it('backs up the current data first; that automatic backup is valid and restores the pre-restore state', async () => {
    seed('Monday');
    const { file } = await makeBackup();
    seed('Tuesday');
    const preRestore = dumpDb();

    closeDb();
    const { autoBackupFile } = await restoreBackup(file, { dbFile, autoBackupDir: autoDir, confirm: true, appVersion: '1.4.2-test' });
    expect(autoBackupFile.startsWith(autoDir)).toBe(true);
    expect(autoBackupFile.endsWith('.pbbackup')).toBe(true);
    expect(readdirSync(autoDir)).toHaveLength(1);
    const v = await validateBackup(autoBackupFile);
    expect(v.ok).toBe(true);
    expect(dumpBytes(decodeBackup(readFileSync(autoBackupFile)).dbBytes)).toEqual(preRestore);

    // Undo the restore by restoring the automatic backup.
    const undoDir = join(dir, 'auto2');
    mkdirSync(undoDir);
    await restoreBackup(autoBackupFile, { dbFile, autoBackupDir: undoDir, confirm: true });
    reopenDb();
    expect(dumpDb()).toEqual(preRestore);
    expect(listSessions(db)).toHaveLength(2);
  });

  it('requires explicit confirmation and touches nothing without it', async () => {
    seed();
    const { file } = await makeBackup();
    seed('Later');
    const dumpBefore = dumpDb();
    closeDb();
    const before = fileSha(dbFile);
    for (const confirm of [undefined, false]) {
      let thrown: unknown = null;
      try {
        await restoreBackup(file, { dbFile, autoBackupDir: autoDir, confirm });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConfirmationRequiredError);
      expect(fileSha(dbFile)).toBe(before);
      expect(readdirSync(autoDir)).toEqual([]);
    }
    reopenDb();
    expect(dumpDb()).toEqual(dumpBefore);
  });
});

describe('AC-13 invalid backups are rejected safely: truncated files', () => {
  it('rejects a backup cut in half, cut to 16 bytes, missing its last byte, or empty', async () => {
    seed();
    const { file } = await makeBackup();
    const bytes = readFileSync(file);
    await expectRejected(writeCrafted(bytes.subarray(0, Math.floor(bytes.length / 2))));
    await expectRejected(writeCrafted(bytes.subarray(0, 16)));
    await expectRejected(writeCrafted(bytes.subarray(0, bytes.length - 1)));
    await expectRejected(writeCrafted(Buffer.alloc(0)), ['not_a_backup']);
  });
});

describe('AC-13 invalid backups are rejected safely: tampered files', () => {
  it('a changed byte in the database copy fails the checksum', async () => {
    seed();
    const { file } = await makeBackup();
    const { manifest, dbBytes } = decodeBackup(readFileSync(file));
    const changed = Buffer.from(dbBytes);
    const at = Math.floor(changed.length / 2);
    changed[at] = (changed[at] as number) ^ 0xff;
    await expectRejected(writeCrafted(encodeBackup(manifest, changed)), ['checksum_mismatch']);
  });

  it('a manifest whose checksum was edited fails the checksum', async () => {
    seed();
    const { file } = await makeBackup();
    const { manifest, dbBytes } = decodeBackup(readFileSync(file));
    const edited = { ...manifest, dbSha256: sha(Buffer.from('something else')) };
    await expectRejected(writeCrafted(encodeBackup(edited, dbBytes)), ['checksum_mismatch']);
  });

  it('a flipped byte in the middle of the file, or a changed last byte, is rejected', async () => {
    seed();
    const { file } = await makeBackup();
    const middle = Buffer.from(readFileSync(file));
    const at = Math.floor(middle.length / 2);
    middle[at] = (middle[at] as number) ^ 0x5a;
    await expectRejected(writeCrafted(middle));
    const last = Buffer.from(readFileSync(file));
    last[last.length - 1] = (last[last.length - 1] as number) ^ 0x5a;
    await expectRejected(writeCrafted(last));
  });
});

describe('AC-13 invalid backups are rejected safely: wrong schema', () => {
  it('a manifest claiming a newer or zero schema version is unsupported', async () => {
    seed();
    const { file } = await makeBackup();
    const { manifest, dbBytes } = decodeBackup(readFileSync(file));
    await expectRejected(writeCrafted(encodeBackup({ ...manifest, schemaVersion: SCHEMA_VERSION + 1 }, dbBytes)), ['unsupported_schema']);
    await expectRejected(writeCrafted(encodeBackup({ ...manifest, schemaVersion: 0 }, dbBytes)), ['unsupported_schema']);
  });

  it('a database from a newer app version is unsupported even with a consistent manifest', async () => {
    seed();
    const { file } = await makeBackup();
    const { manifest, dbBytes } = decodeBackup(readFileSync(file));
    const newer = sqliteBytes((c) => c.pragma(`user_version = ${SCHEMA_VERSION + 1}`), dbBytes);
    await expectRejected(
      writeCrafted(encodeBackup({ ...manifest, schemaVersion: SCHEMA_VERSION + 1, dbSha256: sha(newer) }, newer)),
      ['unsupported_schema'],
    );
    // Manifest says current version but the database inside disagrees.
    await expectRejected(
      writeCrafted(encodeBackup({ ...manifest, dbSha256: sha(newer) }, newer)),
      ['unsupported_schema', 'invalid_database'],
    );
  });
});

describe('AC-13 invalid backups are rejected safely: foreign and non-backup files', () => {
  it('rejects plain text, JSON, random bytes and a raw SQLite database file as not a backup', async () => {
    seed();
    await expectRejected(writeCrafted(Buffer.from('player,score\r\nAna,11\r\n', 'utf8'), 'results.pbbackup'), ['not_a_backup']);
    await expectRejected(writeCrafted(Buffer.from(JSON.stringify({ hello: 'world', schemaVersion: SCHEMA_VERSION }), 'utf8')), ['not_a_backup']);
    await expectRejected(writeCrafted(noise(50000)), ['not_a_backup']);
    closeDb();
    const rawCopy = join(dir, 'copy-of-db.pbbackup');
    copyFileSync(dbFile, rawCopy);
    reopenDb();
    await expectRejected(rawCopy, ['not_a_backup']);
  });

  it('rejects a well-formed container whose database belongs to another app or is garbage', async () => {
    seed();
    const { file } = await makeBackup();
    const { manifest } = decodeBackup(readFileSync(file));
    const foreign = sqliteBytes((c) => {
      c.exec('CREATE TABLE recipes (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO recipes (title) VALUES (\'soup\');');
      c.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
    await expectRejected(writeCrafted(encodeBackup({ ...manifest, dbSha256: sha(foreign) }, foreign)), ['invalid_database']);
    const garbage = noise(8192, 99);
    await expectRejected(writeCrafted(encodeBackup({ ...manifest, dbSha256: sha(garbage) }, garbage)), ['invalid_database']);
  });

  it('rejects a database missing one of the app tables', async () => {
    seed();
    const { file } = await makeBackup();
    const { manifest, dbBytes } = decodeBackup(readFileSync(file));
    const partial = sqliteBytes((c) => c.exec('DROP TABLE audit_events'), dbBytes);
    await expectRejected(writeCrafted(encodeBackup({ ...manifest, dbSha256: sha(partial) }, partial)), ['invalid_database']);
  });

  it('decodeBackup refuses non-container bytes with reason not_a_backup', () => {
    let thrown: unknown = null;
    try {
      decodeBackup(Buffer.from('definitely not a backup'));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BackupValidationError);
    expect((thrown as BackupValidationError).reason).toBe('not_a_backup');
  });

  it('after any number of rejected restores, a valid restore still works', async () => {
    const s = seed();
    const { file, dump } = await makeBackup();
    seed('Extra');
    await expectRejected(writeCrafted(noise(1000, 3)));
    await expectRejected(writeCrafted(readFileSync(file).subarray(0, 100)));
    closeDb();
    await restoreBackup(file, { dbFile, autoBackupDir: autoDir, confirm: true });
    reopenDb();
    expect(dumpDb()).toEqual(dump);
    expect(listSessions(db).map((x) => x.id)).toEqual([s.sessionId]);
  });
});
