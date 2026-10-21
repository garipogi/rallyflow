# Phase 1 — Foundation

1. Schema covers every entity in brief §7 with stable ids as keys, schema version stored, and indexes for player history, sessions, active games and events.
2. Migrations run idempotently on an existing DB.
3. Session lifecycle: create, reopen, finish, review; a completed session rejects writes until explicitly reopened.
4. Removing a player from a roster keeps all historical game records.
5. Duplicate names within a session are prevented unless an existing player is deliberately chosen; nicknames supported.
6. Startup recovery detects unfinished sessions and restores the last committed state.
7. Session deletion requires an explicit confirmation parameter; nothing deletes implicitly.
8. Electron shell starts and loads the local React bundle (no remote URLs).
