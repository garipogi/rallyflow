#!/usr/bin/env node
// Phase controller. The state machine:
//
//   idle ──author──▶ authoring ──lock──▶ (review ──approve──▶) running ──gate green──▶ passed ──advance──▶ idle (next phase)
//                                                                  │
//                                                                  └─ ceiling hit ──▶ ceiling ──resume──▶ running
//
// Usage: node .loop/loop.mjs <status|author|lock|approve|check|verdict|advance|pause|resume>
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import {
  loadConfig, loadState, saveState, phaseConfig, testFilesFor, acCoverage, scan, hashFile,
  checkPhase, run, tail, lockPath, verdictPath, treeHash, formatFailures,
} from './lib.mjs';

const [cmd, ...args] = process.argv.slice(2);
const cfg = loadConfig();
const state = loadState();
const ph = () => phaseConfig(cfg, state.phase);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const need = (...allowed) => { if (!allowed.includes(state.status)) die(`Phase ${state.phase} is "${state.status}"; this needs ${allowed.join(' or ')}.`); };

switch (cmd) {
  case 'status': {
    const p = ph();
    console.log(`Phase ${p.id} — ${p.name}\nStatus: ${state.status}\nAttempts: ${state.attempts}/${cfg.ceiling}\nCovers: ${p.acceptance.join(', ')}\nLocked tests: ${existsSync(lockPath(p.id)) ? 'yes' : 'no'}\nJudge verdict: ${existsSync(verdictPath(p.id)) ? 'present' : 'none'}`);
    break;
  }

  case 'author': {
    need('idle');
    state.status = 'authoring';
    saveState(state);
    mkdirSync(ph().testDir, { recursive: true });
    console.log(`Phase ${state.phase} open for test authoring in ${ph().testDir}. src/ is now write-protected.`);
    break;
  }

  case 'lock': {
    need('authoring');
    const p = ph();
    const files = testFilesFor(p);
    if (files.length === 0) die(`No test files in ${p.testDir}.`);
    const missing = acCoverage(p, files);
    if (missing.length) die(`Tests don't name these acceptance criteria: ${missing.join(', ')}. Put the AC id in a describe() title.`);
    const skips = scan(files, cfg.forbiddenInTests);
    if (skips.length) die(`Skipped/focused tests aren't allowed:\n${skips.join('\n')}`);
    // Red-first: with no implementation for this phase, its tests must FAIL. Passing tests here are vacuous.
    const r = run(`npx vitest run ${p.testDir}`);
    if (r.ok) die(`Phase ${p.id} tests already pass before any implementation. They don't test anything real. Strengthen them.\n${tail(r.output, 20)}`);
    if (/No test files found|failed to load config/i.test(r.output) && !/FAIL|failed|Error/.test(r.output)) die(`Vitest could not run the tests:\n${tail(r.output, 20)}`);
    const lock = { phase: p.id, lockedAt: new Date().toISOString(), files: Object.fromEntries(files.map((f) => [f, hashFile(f)])) };
    mkdirSync('.loop/locks', { recursive: true });
    writeFileSync(lockPath(p.id), JSON.stringify(lock, null, 2) + '\n');
    if (existsSync(verdictPath(p.id))) rmSync(verdictPath(p.id));
    state.status = p.humanReviewTests ? 'review' : 'running';
    state.attempts = 0;
    saveState(state);
    console.log(`Locked ${files.length} test file(s) for phase ${p.id}. Red-first check: confirmed failing.`);
    console.log(p.humanReviewTests ? `Phase ${p.id} needs the organizer to review the tests. Then: node .loop/loop.mjs approve` : `Gate is armed. Building can start.`);
    break;
  }

  case 'approve': {
    need('review');
    state.status = 'running';
    saveState(state);
    console.log(`Tests approved. Gate armed for phase ${state.phase}.`);
    break;
  }

  case 'check': {
    const res = checkPhase(state.phase, { runCommands: !args.includes('--fast') });
    console.log(res.ok ? `✓ Phase ${state.phase} gate is green.` : `Phase ${state.phase} gate is red:\n\n${formatFailures(res.failures)}`);
    process.exit(res.ok ? 0 : 1);
  }

  // Only the judge agent calls this. It binds the verdict to the exact current source tree.
  case 'verdict': {
    need('running');
    const [v, ...notes] = args;
    if (!['PASS', 'FAIL'].includes(v)) die('Usage: verdict PASS|FAIL "notes"');
    if (v === 'PASS') {
      const mech = checkPhase(state.phase).failures.filter((f) => f.check !== 'judge');
      if (mech.length) die(`Can't PASS while mechanical checks are red:\n${formatFailures(mech)}`);
    }
    mkdirSync('.loop/verdicts', { recursive: true });
    writeFileSync(verdictPath(state.phase), JSON.stringify({ phase: state.phase, verdict: v, notes: notes.join(' '), treeHash: treeHash(cfg), at: new Date().toISOString() }, null, 2) + '\n');
    console.log(`Judge verdict ${v} recorded for phase ${state.phase}.`);
    break;
  }

  case 'advance': {
    need('passed');
    const next = cfg.phases.find((p) => p.id === state.phase + 1);
    if (!next) { state.status = 'complete'; saveState(state); console.log('All five phases passed. Remaining: the external gate for AC-20 (green CI on Windows and macOS).'); break; }
    state.phase = next.id; state.status = 'idle'; state.attempts = 0;
    saveState(state);
    console.log(`Advanced to phase ${next.id} — ${next.name}.`);
    break;
  }

  case 'pause': { state.status = 'idle'; saveState(state); console.log('Gate disarmed. Claude can stop normally.'); break; }
  case 'resume': { need('ceiling', 'idle'); if (!existsSync(lockPath(state.phase))) die('No locked tests; use author/lock first.'); state.status = 'running'; state.attempts = 0; saveState(state); console.log(`Gate re-armed for phase ${state.phase}, attempts reset.`); break; }

  default:
    console.log('Usage: node .loop/loop.mjs <status|author|lock|approve|check [--fast]|verdict PASS|FAIL notes|advance|pause|resume>');
}
