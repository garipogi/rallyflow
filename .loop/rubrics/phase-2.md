# Phase 2 — Scoring engine

1. Engine is a pure reducer: `(state, event) → state`. Replaying stored events reproduces the exact state.
2. Side-out: receiving team winning a rally never scores; it changes server or causes side-out exactly as `docs/RULES.md` says.
3. Doubles: server 1 → server 2 → side-out, with the first-server exception at game start.
4. Singles: server's side follows their score parity.
5. Every player's court position is tracked and correct after each rally.
6. Win condition checks target and two-point margin; targets 11/15/21 supported.
7. Undo restores score, serving team, server number and positions; correction of an earlier event replays everything after it.
8. Reopening a completed game cannot produce a second completion; corrections write an AuditEvent with previous value, new value, time and reason.
9. ScoreEvents are persisted before the action is treated as saved.
10. Rules edition is recorded in `docs/RULES.md` and referenced by the engine.
