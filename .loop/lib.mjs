// Shared logic for the loop gate. No dependencies beyond Node itself.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const P = (...p) => join(ROOT, ...p);

export const loadConfig = () => JSON.parse(readFileSync(P('.loop/phases.json'), 'utf8'));
export const loadState = () => JSON.parse(readFileSync(P('.loop/state.json'), 'utf8'));
export const saveState = (s) => writeFileSync(P('.loop/state.json'), JSON.stringify(s, null, 2) + '\n');
export const phaseConfig = (cfg, id) => {
  const ph = cfg.phases.find((p) => p.id === Number(id));
  if (!ph) throw new Error(`Unknown phase ${id}`);
  return ph;
};

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', '.git']);

export function listFiles(dir, re = CODE_EXT) {
  const abs = P(dir);
  if (!existsSync(abs)) return [];
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (SKIP_DIRS.has(name)) continue;
      const f = join(d, name);
      if (statSync(f).isDirectory()) walk(f);
      else if (re.test(name)) out.push(relative(ROOT, f).split(sep).join('/'));
    }
  };
  walk(abs);
  return out.sort();
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const hashFile = (rel) => sha256(readFileSync(P(rel)));

// One hash for all source code, so a judge verdict is tied to an exact tree.
export function treeHash(cfg) {
  const h = createHash('sha256');
  for (const d of cfg.sourceDirs) for (const f of listFiles(d)) h.update(f + '\0' + hashFile(f) + '\0');
  return h.digest('hex');
}

export function run(cmd, timeoutMs = 15 * 60 * 1000) {
  const r = spawnSync(cmd, { cwd: ROOT, shell: true, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { ok: r.status === 0, code: r.status, output };
}

export const tail = (s, n = 60) => s.split('\n').slice(-n).join('\n');

export const lockPath = (id) => P('.loop/locks', `phase-${id}.json`);
export const verdictPath = (id) => P('.loop/verdicts', `phase-${id}.json`);

export function testFilesFor(ph) {
  return listFiles(ph.testDir, /\.(test|spec)\.(ts|tsx|js|mjs)$/);
}

// Tests for this phase must name every acceptance criterion they cover.
export function acCoverage(ph, files) {
  const text = files.map((f) => readFileSync(P(f), 'utf8')).join('\n');
  return ph.acceptance.filter((ac) => !text.includes(ac));
}

export function scan(files, pattern) {
  const re = new RegExp(pattern, 'i');
  const hits = [];
  for (const f of files) {
    readFileSync(P(f), 'utf8').split('\n').forEach((line, i) => {
      if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  return hits;
}

// The full gate. Returns { ok, failures: [{ check, detail }] }.
// It never asks a model anything: every check is a file hash, a regex, or a command's exit code.
export function checkPhase(id, { runCommands = true } = {}) {
  const cfg = loadConfig();
  const ph = phaseConfig(cfg, id);
  const failures = [];
  const fail = (check, detail) => failures.push({ check, detail });

  // 1. Tests must have been written by the test-author and locked before building.
  if (!existsSync(lockPath(id))) {
    fail('tests-locked', `No locked tests for phase ${id}. The test-author writes tests first, then run: node .loop/loop.mjs lock`);
    return { ok: false, failures };
  }
  const lock = JSON.parse(readFileSync(lockPath(id), 'utf8'));

  // 2. Locked tests (this phase and every earlier phase) must be byte-for-byte unchanged.
  const allLocks = cfg.phases.filter((p) => p.id <= id && existsSync(lockPath(p.id)))
    .map((p) => JSON.parse(readFileSync(lockPath(p.id), 'utf8')));
  for (const l of allLocks) {
    for (const [f, h] of Object.entries(l.files)) {
      if (!existsSync(P(f))) fail('tests-unchanged', `Locked test deleted: ${f}`);
      else if (hashFile(f) !== h) fail('tests-unchanged', `Locked test modified: ${f}. Revert it; fix the code, not the test.`);
    }
    // No new unlocked test files sneaking into a locked phase directory.
    const lp = phaseConfig(cfg, l.phase);
    for (const f of testFilesFor(lp)) if (!(f in l.files)) fail('tests-unchanged', `Unlocked test file added to ${lp.testDir}: ${f}`);
  }

  // 3. Every acceptance criterion is named by at least one locked test.
  const missing = acCoverage(ph, Object.keys(lock.files));
  if (missing.length) fail('ac-coverage', `Acceptance criteria with no test: ${missing.join(', ')}`);

  // 4. No skipped/focused tests anywhere, no placeholders or suppressions in source.
  const skipHits = scan(cfg.phases.flatMap((p) => testFilesFor(p)), cfg.forbiddenInTests);
  if (skipHits.length) fail('no-skips', skipHits.slice(0, 20).join('\n'));
  const srcFiles = cfg.sourceDirs.flatMap((d) => listFiles(d));
  if (srcFiles.length === 0) fail('source-exists', 'No source files in ' + cfg.sourceDirs.join(', '));
  const phHits = scan(srcFiles, cfg.forbiddenInSource);
  if (phHits.length) fail('no-placeholders', phHits.slice(0, 20).join('\n'));

  // 5. Required deliverable files.
  for (const f of ph.requiredFiles ?? []) if (!existsSync(P(f))) fail('required-files', `Missing ${f}`);

  // 6. The real commands: typecheck, full test suite (regression on all earlier phases), build, e2e.
  if (runCommands) {
    for (const cmd of ph.commands) {
      const r = run(cmd);
      if (!r.ok) { fail(`command: ${cmd}`, tail(r.output)); break; } // stop at first red; later commands depend on it
    }
  }

  // 7. Independent judge verdict, bound to the exact current source tree.
  if (ph.rubric) {
    if (!existsSync(verdictPath(id))) fail('judge', `No judge verdict yet. After all mechanical checks are green, dispatch the judge agent with rubric .loop/rubrics/${ph.rubric}.`);
    else {
      const v = JSON.parse(readFileSync(verdictPath(id), 'utf8'));
      if (v.treeHash !== treeHash(cfg)) fail('judge', 'Judge verdict is stale: source changed since it was issued. Re-dispatch the judge.');
      else if (v.verdict !== 'PASS') fail('judge', `Judge verdict FAIL:\n${v.notes}`);
    }
  }

  return { ok: failures.length === 0, failures };
}

export function writeReport(id, name, body) {
  mkdirSync(P('.loop/reports'), { recursive: true });
  const f = P('.loop/reports', `phase-${id}-${name}.md`);
  writeFileSync(f, body);
  return relative(ROOT, f);
}

export const formatFailures = (failures) =>
  failures.map((f) => `### ✗ ${f.check}\n\`\`\`\n${f.detail}\n\`\`\``).join('\n\n');
