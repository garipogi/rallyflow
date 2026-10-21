# Pickleball Open Play — project rules

Offline desktop app for one organizer to run pickleball open play (16–32 players, 2–4 courts). Requirements: `docs/BRIEF.md`. Stack: `docs/STACK.md`. Policy defaults: `docs/DECISIONS.md`. Pickleball rules edition: `docs/RULES.md` (written in phase 2).

## This repo is built by a closed loop

- Work happens one phase at a time (`.loop/phases.json`). Run a phase with `/run-phase`.
- **Maker and checker are separate.** `test-author` writes the tests, which are hash-locked. `builder` makes them pass. `judge` grades against a rubric. `log-triage` reads failures. The orchestrator only coordinates.
- A `Stop` hook (`.loop/gate.mjs`) blocks the session from ending while a phase is running and the gate is red. The gate is a script: locked tests unchanged, every acceptance criterion tested, no skips or placeholders, typecheck + full test suite (+ build/e2e in phase 5) green, and a judge PASS bound to the current source.
- Ceiling: 30 blocked stops per phase, then the loop halts and writes `.loop/reports/phase-N-ceiling.md`.

## Rules for everyone in this repo

- Never edit `tests/`, `.loop/` or `.claude/` while a phase is running. If a test seems wrong, report it; the organizer decides.
- Never mark your own work done. Only the gate decides.
- No TODO/FIXME/placeholder code, no `@ts-ignore`, no skipped tests.
- `src/core` stays pure: no I/O, no Electron, no DB imports.
- Offline only: no network calls, CDNs, remote fonts or telemetry.
- `approve`, `advance` and `resume` belong to the organizer.

## Commands

```
npm run typecheck        # tsc --noEmit
npx vitest run           # all locked tests
node .loop/loop.mjs status
node .loop/loop.mjs check [--fast]
```
