#!/usr/bin/env node
// PreToolUse hook on Edit/Write/MultiEdit/NotebookEdit.
// - While building ("running"/"review"): nobody may edit tests/, .loop/ or .claude/.
// - While the test-author is writing tests ("authoring"): nobody may edit src/.
// This is a speed bump; the hard guarantee is the hash lock checked by gate.mjs.
import { resolve, relative, sep } from 'node:path';
import { ROOT, loadConfig, loadState } from './lib.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input = {};
try { input = JSON.parse(raw); } catch { process.exit(0); }

const file = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
if (!file) process.exit(0);
const rel = relative(ROOT, resolve(ROOT, file)).split(sep).join('/');
if (rel.startsWith('..')) process.exit(0);

const { status } = loadState();
const cfg = loadConfig();
const under = (dirs) => dirs.some((d) => rel === d || rel.startsWith(d + '/'));

let deny = null;
if ((status === 'running' || status === 'review') && under(cfg.protectedDirs))
  deny = `${rel} is protected while a phase is being built. Fix the code in src/, not the tests or the loop.`;
if (status === 'authoring' && under(cfg.sourceDirs))
  deny = `The test-author writes tests only. ${rel} is implementation and is off-limits during authoring.`;

if (deny) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: deny } }));
}
process.exit(0);
