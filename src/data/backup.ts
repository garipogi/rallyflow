import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDatabase, listTables, SCHEMA_VERSION, type Db } from './db';
import { ConfirmationRequiredError } from './errors';
import { raw } from './sqlite';

/**
 * Manual backup and validated restore (docs/DECISIONS.md D10; brief §6).
 *
 * A `.pbbackup` file is: MAGIC | uint32 big-endian manifest length | manifest JSON (UTF-8) | database bytes.
 * Restore replaces the database after validation and explicit confirmation; the current data is
 * saved to a new automatic backup first. There is no merge.
 */

export interface BackupManifest {
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  dbSha256: string;
  [extra: string]: unknown;
}

export type BackupRejectReason = 'not_a_backup' | 'checksum_mismatch' | 'unsupported_schema' | 'invalid_database';

export class BackupValidationError extends Error {
  readonly reason: BackupRejectReason;
  constructor(reason: BackupRejectReason, message: string) {
    super(message);
    this.name = 'BackupValidationError';
    this.reason = reason;
  }
}

export type BackupValidation =
  | { ok: true; manifest: BackupManifest }
  | { ok: false; reason: BackupRejectReason; message: string };

export const DEFAULT_APP_VERSION = '1.0.0';

const MAGIC = Buffer.from('PBOPBACKUP\u0001\n', 'latin1');
const MAX_MANIFEST_BYTES = 64 * 1024;
const SQLITE_HEADER = 'SQLite format 3\u0000';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function encodeBackup(manifest: BackupManifest, dbBytes: Uint8Array): Buffer {
  const json = Buffer.from(JSON.stringify(manifest), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length, 0);
  return Buffer.concat([MAGIC, length, json, dbBytes]);
}

export function decodeBackup(bytes: Uint8Array): { manifest: BackupManifest; dbBytes: Buffer } {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const notABackup = (why: string): BackupValidationError => new BackupValidationError('not_a_backup', `This is not a RallyFlow backup file (${why}).`);
  const head = MAGIC.length + 4;
  if (buf.length < head || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw notABackup('unrecognised file header');
  const manifestLength = buf.readUInt32BE(MAGIC.length);
  if (manifestLength === 0 || manifestLength > MAX_MANIFEST_BYTES || head + manifestLength > buf.length) {
    throw notABackup('the manifest is cut off');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(buf.subarray(head, head + manifestLength).toString('utf8'));
  } catch {
    throw notABackup('the manifest is unreadable');
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) throw notABackup('the manifest is unreadable');
  return { manifest: manifest as BackupManifest, dbBytes: buf.subarray(head + manifestLength) };
}

function manifestShapeError(m: BackupManifest): string | null {
  if (typeof m.schemaVersion !== 'number') return 'the manifest has no schema version';
  if (typeof m.appVersion !== 'string' || m.appVersion === '') return 'the manifest has no app version';
  if (typeof m.createdAt !== 'string' || Number.isNaN(Date.parse(m.createdAt))) return 'the manifest has no valid creation time';
  if (typeof m.dbSha256 !== 'string') return 'the manifest has no checksum';
  return null;
}

/** Tables a healthy database of this app must contain. */
function requiredTables(): string[] {
  const fresh = openDatabase(':memory:');
  try {
    return listTables(fresh);
  } finally {
    fresh.close();
  }
}

/**
 * A database image whose header says "WAL mode" cannot be opened in memory without its -wal file.
 * Return a copy with the journal-mode bytes (offsets 18 and 19) set to rollback mode.
 */
function rollbackModeImage(image: Buffer): Buffer {
  const copy = Buffer.from(image);
  if (copy.length > 19 && (copy[18] === 2 || copy[19] === 2)) {
    copy[18] = 1;
    copy[19] = 1;
  }
  return copy;
}

function checkDatabaseBytes(dbBytes: Buffer): void {
  const bad = (message: string): BackupValidationError => new BackupValidationError('invalid_database', message);
  if (dbBytes.subarray(0, SQLITE_HEADER.length).toString('latin1') !== SQLITE_HEADER) {
    throw bad('The database inside the backup is not an SQLite database.');
  }
  let conn: Database.Database | null = null;
  try {
    conn = new Database(rollbackModeImage(dbBytes));
    const version = conn.pragma('user_version', { simple: true }) as number;
    if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) {
      throw new BackupValidationError('unsupported_schema', `The database inside the backup has schema version ${version}; this app supports 1 to ${SCHEMA_VERSION}.`);
    }
    const integrity = conn.pragma('integrity_check') as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw bad('The database inside the backup failed its integrity check.');
    const tables = new Set(
      (conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name),
    );
    const missing = requiredTables().filter((t) => !tables.has(t));
    if (missing.length > 0) throw bad(`The database inside the backup is missing tables: ${missing.join(', ')}.`);
  } catch (err) {
    if (err instanceof BackupValidationError) throw err;
    throw bad(`The database inside the backup cannot be read: ${String(err)}`);
  } finally {
    conn?.close();
  }
}

/** Container, schema version, checksum, then database health. Throws BackupValidationError. */
function validateBytes(bytes: Buffer): BackupManifest {
  const { manifest, dbBytes } = decodeBackup(bytes);
  const shape = manifestShapeError(manifest);
  if (shape) throw new BackupValidationError('not_a_backup', `This is not a RallyFlow backup file (${shape}).`);
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1 || manifest.schemaVersion > SCHEMA_VERSION) {
    throw new BackupValidationError('unsupported_schema', `The backup has schema version ${manifest.schemaVersion}; this app supports 1 to ${SCHEMA_VERSION}.`);
  }
  if (sha256(dbBytes) !== manifest.dbSha256) {
    throw new BackupValidationError('checksum_mismatch', 'The backup file is damaged or was changed: its checksum does not match.');
  }
  checkDatabaseBytes(dbBytes);
  return manifest;
}

function readBackupFile(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch {
    throw new BackupValidationError('not_a_backup', 'The backup file could not be read.');
  }
}

function newManifest(schemaVersion: number, dbBytes: Buffer, appVersion: string | undefined): BackupManifest {
  return {
    schemaVersion,
    appVersion: appVersion && appVersion !== '' ? appVersion : DEFAULT_APP_VERSION,
    createdAt: new Date().toISOString(),
    dbSha256: sha256(dbBytes),
  };
}

function writeFileDurably(file: string, bytes: Uint8Array, flag: 'w' | 'wx'): void {
  const fd = openSync(file, flag);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A consistent snapshot of the open database (WAL content included); the database is not changed. */
export function createBackup(db: Db, file: string, opts: { appVersion?: string } = {}): BackupManifest {
  const sqlite = raw(db);
  // serialize() already merges the WAL into the image; the rollback-mode header keeps the copy self-contained.
  const dbBytes = rollbackModeImage(sqlite.serialize());
  const manifest = newManifest(sqlite.pragma('user_version', { simple: true }) as number, dbBytes, opts.appVersion);
  writeFileDurably(file, encodeBackup(manifest, dbBytes), 'w');
  return manifest;
}

export function validateBackup(file: string): BackupValidation {
  try {
    return { ok: true, manifest: validateBytes(readBackupFile(file)) };
  } catch (err) {
    if (err instanceof BackupValidationError) return { ok: false, reason: err.reason, message: err.message };
    throw err;
  }
}

/** Snapshot of the current database file (or an empty current-schema database when none exists yet). */
function snapshotCurrent(dbFile: string): { bytes: Buffer; schemaVersion: number } {
  const source = existsSync(dbFile) ? new Database(dbFile, { fileMustExist: true }) : (openDatabase(':memory:') as unknown as Database.Database);
  try {
    return { bytes: rollbackModeImage(source.serialize()), schemaVersion: source.pragma('user_version', { simple: true }) as number };
  } finally {
    source.close();
  }
}

/**
 * Order: validate, require confirmation, back up the current data, replace.
 * The caller closes every connection to `dbFile` first and reopens it afterwards.
 */
export function restoreBackup(
  file: string,
  opts: { dbFile: string; autoBackupDir: string; confirm?: boolean; appVersion?: string },
): { manifest: BackupManifest; autoBackupFile: string } {
  const bytes = readBackupFile(file);
  const manifest = validateBytes(bytes);
  if (opts.confirm !== true) {
    throw new ConfirmationRequiredError('Restoring a backup replaces all current data. Confirm explicitly to continue.');
  }
  const { dbBytes } = decodeBackup(bytes);

  const current = snapshotCurrent(opts.dbFile);
  mkdirSync(opts.autoBackupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let autoBackupFile = join(opts.autoBackupDir, `pre-restore-${stamp}.pbbackup`);
  for (let n = 2; existsSync(autoBackupFile); n++) autoBackupFile = join(opts.autoBackupDir, `pre-restore-${stamp}-${n}.pbbackup`);
  writeFileDurably(autoBackupFile, encodeBackup(newManifest(current.schemaVersion, current.bytes, opts.appVersion), current.bytes), 'wx');

  // Write the new database beside the target, drop the old -wal/-shm so stale WAL frames can never
  // be replayed onto the restored file, then swap it in with a rename.
  const staged = join(dirname(opts.dbFile), `.restore-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileDurably(staged, dbBytes, 'w');
    rmSync(`${opts.dbFile}-wal`, { force: true });
    rmSync(`${opts.dbFile}-shm`, { force: true });
    renameSync(staged, opts.dbFile);
  } finally {
    rmSync(staged, { force: true });
  }
  return { manifest, autoBackupFile };
}
