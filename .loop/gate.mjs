#!/usr/bin/env node
// Stop hook. Runs every time Claude tries to end its turn.
// While a phase is "running", Claude cannot stop until the gate is green,
// or until the ceiling is hit (then it stops and writes a report for the organizer).
// Costs zero model tokens: it is a script, not a judge.
import { loadConfig, loadState, saveState, checkPhase, writeReport, formatFailures } from './lib.mjs';

try { await new Promise((r) => { process.stdin.on('data', () => {}); process.stdin.on('end', r); setTimeout(r, 500); }); } catch {}

const cfg = loadConfig();
const state = loadState();

// Gate only engages during a running phase. Ordinary sessions stop normally.
if (state.status !== 'running') process.exit(0);

state.attempts += 1;
const id = state.phase;

if (state.attempts > cfg.ceiling) {
  state.status = 'ceiling';
  saveState(state);
  const res = checkPhase(id, { runCommands: true });
  const report = writeReport(id, 'ceiling', `# Phase ${id}: ceiling reached (${cfg.ceiling} attempts)\n\nThe loop stopped without a green gate. Remaining failures:\n\n${formatFailures(res.failures)}\n\nTo continue: review, then \`node .loop/loop.mjs resume\`.\n`);
  console.log(JSON.stringify({ systemMessage: `Phase ${id} hit the ${cfg.ceiling}-attempt ceiling. Stopping. See ${report}.` }));
  process.exit(0);
}

const res = checkPhase(id);
if (res.ok) {
  state.status = 'passed';
  state.history.push({ phase: id, passedAt: new Date().toISOString(), attempts: state.attempts });
  saveState(state);
  const report = writeReport(id, 'passed', `# Phase ${id}: gate passed\n\nAttempts: ${state.attempts}\nPassed: ${new Date().toISOString()}\n\nAll checks green: locked tests unchanged, acceptance criteria covered, no placeholders, commands green, judge PASS.\n`);
  console.log(JSON.stringify({ systemMessage: `Phase ${id} gate passed in ${state.attempts} attempt(s). Report: ${report}` }));
  process.exit(0);
}

saveState(state);
const reason = `GATE RED — phase ${id}, attempt ${state.attempts}/${cfg.ceiling}. You may not stop yet.\n\n${formatFailures(res.failures)}\n\nNext: if a command failed, dispatch log-triage on the output, then the builder with its summary. If only the judge check is open, dispatch the judge. Do not edit tests/, .loop/ or .claude/.`;
console.log(JSON.stringify({ decision: 'block', reason: reason.slice(0, 9000) }));
process.exit(0);
