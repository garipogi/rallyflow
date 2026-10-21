# Common rubric (every phase)

Each item is PASS or FAIL with file:line evidence.

1. **Real, general implementation.** No logic that special-cases test inputs, hard-codes expected outputs, or branches on being under test.
2. **Layering.** `src/core` has no imports from `src/data`, `src/main`, `src/renderer`, Node I/O, or Electron. Grep the imports.
3. **Brief and decisions honored.** The phase goal in `.loop/phases.json` is fully implemented, including parts the tests touch lightly. Policies follow `docs/DECISIONS.md`; configurable ones are actually configurable.
4. **Integrity.** Every multi-step write is inside a transaction. No path finalizes a game twice or derives stats from unfinalized games.
5. **No dead ends.** No functions that throw generic "unsupported" for cases the brief requires; no unreachable branches left as stubs.
6. **Offline.** No runtime network calls, CDN URLs, remote fonts, or telemetry.
7. **Readable.** Names match the brief's vocabulary (session, court, eligibility, server number …); non-obvious rules cite the brief section or rule number in a short comment.
