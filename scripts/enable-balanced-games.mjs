#!/usr/bin/env node
// Switches an existing session to "Balance games played" (D14) through the app's own data layer.
// Close the app first. A copy of the database is saved next to it before anything is written.
//
//   node scripts/enable-balanced-games.mjs                      # session "CCF Sandoval", default DB
//   node scripts/enable-balanced-games.mjs --session "Name" --db /path/to/open-play.db
//   node scripts/enable-balanced-games.mjs --dry-run            # show what would change
//
// The same switch is in the app: Court operations -> Game settings -> Who plays next.
import { copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
}

const dbFile = resolve(arg('--db', join(homedir(), 'Library', 'Application Support', 'pickleball-open-play', 'open-play.db')));
const sessionName = arg('--session', 'CCF Sandoval');
const dryRun = process.argv.includes('--dry-run');

if (!existsSync(dbFile)) {
  console.error(`No database at ${dbFile}`);
  process.exit(1);
}

const server = await createServer({ root, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false } });
let db;
try {
  const { openDatabase } = await server.ssrLoadModule('/src/data/db.ts');
  const { listSessions } = await server.ssrLoadModule('/src/data/sessions.ts');
  const { getRotationSettings, setRotationSettings } = await server.ssrLoadModule('/src/data/rotation.ts');
  const { NEW_SESSION_ROTATION_SETTINGS } = await server.ssrLoadModule('/src/core/rotation/index.ts');

  if (!dryRun) {
    const backup = `${dbFile}.before-balanced-games-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    copyFileSync(dbFile, backup);
    console.log(`Saved a copy of the database to ${backup}`);
  }
  db = openDatabase(dbFile);
  const matches = listSessions(db).filter((s) => s.name.trim().toLowerCase() === sessionName.trim().toLowerCase());
  if (matches.length === 0) {
    console.error(`No session named "${sessionName}". Sessions: ${listSessions(db).map((s) => s.name).join(', ') || 'none'}`);
    process.exitCode = 1;
  }
  for (const session of matches) {
    const before = getRotationSettings(db, session.id);
    console.log(`${session.name} (${session.status}, started ${session.startedAt}): fairness=${before.fairness ?? 'wait_time'}, partnerRotation=${before.partnerRotation}`);
    if (session.status !== 'active') {
      console.log('  skipped: only an active session can be changed (reopen it in the app first).');
      continue;
    }
    if (before.fairness === 'balanced_games' && before.partnerRotation) {
      console.log('  already balancing games played; nothing to change.');
      continue;
    }
    if (dryRun) {
      console.log('  dry run: would switch to balanced games with partner rotation.');
      continue;
    }
    const after = setRotationSettings(db, session.id, { ...NEW_SESSION_ROTATION_SETTINGS });
    console.log(`  now: fairness=${after.fairness}, partnerRotation=${after.partnerRotation}`);
  }
} finally {
  db?.close();
  await server.close();
}
