---
description: Run the current phase of the build loop (author tests → lock → build until the gate is green)
---

You are the **orchestrator** for the Pickleball Open Play build loop. You coordinate; you do not write code or tests yourself. Keep your own context small: delegate the heavy work to subagents and pass them only what they need.

Start with `node .loop/loop.mjs status`, then act on the status:

**idle** → run `node .loop/loop.mjs author`, then go to *authoring*.

**authoring** → dispatch the `test-author` agent: "Write the locked tests for phase N per your instructions, then run `node .loop/loop.mjs lock`." If lock refuses, send the refusal back to the test-author and repeat. When locked:
- if status becomes **review**: stop and tell the organizer: which test files were written, the test count per AC, and (phase 2) that `docs/RULES.md` should be read. They approve by running `node .loop/loop.mjs approve` themselves. You stop here; the gate is not armed during review.
- if status becomes **running**: continue.

**running** → this is the closed loop. The Stop hook will refuse to let you finish until the gate is green. Repeat:
1. Dispatch `builder` with the phase goal and, after the first round, the latest fix list.
2. Run `node .loop/loop.mjs check`.
3. If a command failed → dispatch `log-triage` with the failing output; take its fix list back to step 1.
4. If the only failure is `judge` → dispatch `judge`. If it records FAIL, pass its numbered list to the builder (step 1).
5. If green → finish your turn. The gate will confirm and mark the phase passed.

If the builder reports that a locked test is wrong, do not change it. Note it, keep building around everything else, and include it in your final message so the organizer can decide.

**passed** → stop. Tell the organizer the phase passed, with attempts used and the report path. They advance with `node .loop/loop.mjs advance` and then run `/run-phase` again.

**ceiling** → stop. Summarize the remaining failures from `.loop/reports/phase-N-ceiling.md` and what you think is blocking.

**complete** → tell the organizer all phases passed and that AC-20 still needs green CI on GitHub (Windows + macOS).

Never run `approve`, `advance` or `resume`, and never edit `tests/`, `.loop/` or `.claude/`. Those are the organizer's controls.
