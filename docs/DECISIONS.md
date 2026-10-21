# Open policy decisions (brief §11) and their defaults

Each item is a default the loop builds against. Anything marked **configurable** must be a session setting, not a hard-coded rule. The organizer can change any default before or after a phase runs.

| # | Topic | Default | Status |
| --- | --- | --- | --- |
| D1 | Declined turn | Player goes to the **back of the queue**: eligibility time resets to the moment they declined, as if they had just finished a game. Configurable: back of queue / keep spot, skip once / drop N places. | Confirmed by organizer 2026-10-21 |
| D2 | Queue tie-break | Equal eligibility time → earlier session check-in wins → then fewer games played this session → then stable player id. | Default, unconfirmed |
| D3 | New arrival mid-session | Eligibility time = check-in time. Joins behind everyone already waiting. | Default, unconfirmed |
| D4 | Resting / unavailable | Unavailable players keep their original eligibility time while away and resume it on return (no penalty for a short rest). | Default, unconfirmed |
| D5 | After a game | All participants become eligible at the game's end time, winners and losers alike (no "winners stay on"). | Default, unconfirmed |
| D6 | Skill balancing window | When on, balancing may only choose among the oldest-waiting `players_needed + 2` eligible players, and must include the single oldest-waiting player. | Default, unconfirmed |
| D7 | Partner rotation | Among valid team splits of the chosen players, prefer the split with the fewest repeat partnerships this session. Never changes *who* plays, only how they're paired. | Default, unconfirmed |
| D8 | Rules edition | The current USA Pickleball Official Rulebook at the start of phase 2. The test-author records the exact edition and the rule numbers used in `docs/RULES.md`. | To be recorded in phase 2 |
| D9 | Leaderboard threshold | Ranked only with ≥ 3 completed games (session) or ≥ 10 (historical); others shown unranked. Order: win % → wins → point differential → shown as tie. | Default, unconfirmed |
| D10 | Backup format | Single `.pbbackup` file = SQLite database copy + JSON manifest (schema version, app version, created_at, SHA-256 of the DB). Restore = **replace** after validation and explicit confirmation; current data is auto-backed-up first. No merge in v1. | Default, unconfirmed |
| D11 | Export columns | Sessions, games (one row per game with players, teams, score, court, times, status), player stats (session + historical). | Default, unconfirmed |
| D12 | Supported OS versions | Windows 10 22H2+, Windows 11; macOS 13 Ventura+ (Intel and Apple silicon). | Default, unconfirmed |
| D13 | Code signing | Unsigned builds for v1 (internal use); signing is a release-time task outside the loop. | Default, unconfirmed |
| D14 | Fairness mode | Session setting `fairness`: **balanced_games** (fewest games first: games played + catch-up credit, then longest wait, then a seeded draw that changes every round; partner rotation always on, preferring fewest repeat partners, then fewest repeat opponents, then skill balance) or **wait_time** (D2). A late arrival's catch-up credit = the fewest effective games among players already checked in (and not away) at the moment they check in. Resting keeps D4. With skill balancing on, the D6 window only swaps players on the same game count. Engine default (`DEFAULT_ROTATION_SETTINGS`) stays wait_time so D1-D7 hold; **sessions created from the app start with balanced_games + partner rotation**, and Court operations -> Game settings -> Who plays next switches it. Added after the organizer saw the earliest check-in get the most games (11 players, 2 courts). | Requested by organizer 2026-10-21 |
