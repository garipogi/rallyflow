# Phase 4 — Statistics and reporting

1. Stats derive only from finalized games; cancelled/incomplete are excluded; doubles counts for each player.
2. Corrections trigger recalculation; no duplicated stats.
3. Leaderboards show games played, apply D9 thresholds and tie rules, and label unranked players.
4. Session vs historical scope is correct.
5. CSV is RFC 4180 (quoting, commas, newlines in names); XLSX has the D11 sheets and headers.
6. Export is read-only on the DB.
7. Backup includes a manifest with schema version and checksum; restore validates before touching data, auto-backs-up current data, and requires explicit confirmation.
