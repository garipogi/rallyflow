# How to run the build loop

The loop is set up but **not running**. Nothing has been built and no tests have been written yet. State: phase 1, `idle`.

## One-time setup on your computer

1. Unzip this folder somewhere, e.g. `Documents/pickleball-open-play`.
2. Install Node.js 20 or newer, and Claude Code.
3. In the folder, run `npm install`.
4. Open Claude Code in the folder. The hooks in `.claude/settings.json` load automatically. Accept them if Claude Code asks you to trust the project's hooks.

## Running a phase

In Claude Code, type:

```
/run-phase
```

What happens:

| Step | Who | What |
| --- | --- | --- |
| 1 | orchestrator | `author` opens phase for test writing; `src/` becomes read-only |
| 2 | **test-author** (Opus) | Writes tests for every acceptance criterion in the phase, then `lock` |
| 3 | lock script | Refuses tests that already pass (vacuous); hashes the rest |
| 4 | *you* (phase 2 only) | Read `docs/RULES.md` and the tests, then run `node .loop/loop.mjs approve` |
| 5 | **builder** (Sonnet) | Implements; can't touch tests or the loop |
| 6 | **Stop hook gate** (script, 0 tokens) | Blocks the stop while anything is red |
| 7 | **log-triage** (Haiku) | Turns failure output into a short fix list for the builder |
| 8 | **judge** (Sonnet) | Grades against the rubric once mechanics are green; never writes code |
| 9 | gate | Green → phase `passed`; 30 blocked stops → `ceiling` with a report |

When a phase passes, you check it and run:

```
node .loop/loop.mjs advance
```

then `/run-phase` again for the next phase. The advance between phases is deliberately yours. Agents are denied `approve`, `advance` and `resume` in `.claude/settings.json`.

## What the gate checks (all mechanical)

1. Tests for this phase were written and locked before building.
2. Every locked test, this phase and all earlier ones, is byte-for-byte unchanged, and no new test files were added.
3. Every acceptance criterion (AC-xx) is named by a test.
4. No skipped/focused tests; no TODO/FIXME/placeholder/`@ts-ignore` in `src/`.
5. Required deliverables exist (phase 5: CI workflow, builder config, user guide, install guide).
6. `typecheck` and the **full** test suite pass (so earlier phases can't regress); phase 5 also `build` and `e2e`.
7. A judge PASS exists **and** matches the exact current source. Any code change after the verdict makes it stale.

## Phases

| # | Phase | Acceptance criteria | Human checkpoint |
| --- | --- | --- | --- |
| 1 | Foundation | AC-02, AC-11, AC-12 | advance |
| 2 | Scoring engine | AC-05–AC-10 | **approve tests + RULES.md**, advance |
| 3 | Rotation | AC-03, AC-04, AC-16, AC-17 | advance |
| 4 | Stats & reporting | AC-13, AC-14, AC-15 | advance |
| 5 | Display & release | AC-01, AC-18, AC-19, AC-20 | advance; confirm CI green on Windows + macOS |

## If it stops at the ceiling

Read `.loop/reports/phase-N-ceiling.md`. Usually it's one of: a test the builder thinks is wrong (decide, then fix the test yourself with `node .loop/loop.mjs pause` first and re-lock), a missing dependency, or an unclear policy in `docs/DECISIONS.md`. Then:

```
node .loop/loop.mjs resume
```

## Controls

```
node .loop/loop.mjs status      # where are we
node .loop/loop.mjs check       # run the gate by hand (doesn't count as an attempt)
node .loop/loop.mjs pause       # disarm the gate; Claude can stop normally
node .loop/loop.mjs resume      # re-arm after a pause or ceiling (you only)
node .loop/loop.mjs approve     # approve reviewed tests (you only)
node .loop/loop.mjs advance     # move to the next phase after a pass (you only)
```

Settings to change: ceiling and per-phase commands in `.loop/phases.json`; policies in `docs/DECISIONS.md` (change these *before* the phase that uses them; phase 3 for D1–D7, phase 4 for D9–D11).

## Honest limits

- The test lock is mechanical. The PreToolUse guard and the judge-verdict command are protected by convention and the permission deny list. A determined agent could still call `verdict` through the shell. The verdict is tied to the source hash, so a stale or self-issued pass on changed code still fails.
- Correct pickleball rules depend on the test-author reading the rulebook correctly. That's why phase 2 stops for your review.
- AC-20 (Windows + macOS) can't be proven from one machine. The loop produces the CI workflow; you push it to GitHub and confirm it's green.
- UX quality (readability court-side, contrast) is judged from screenshots by an LLM with a rubric. Look at the app yourself before your first real session.
