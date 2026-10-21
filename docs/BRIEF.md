# Final Project Brief: Offline Pickleball Open Play Desktop Application

Version 1.0 · Requirements Baseline · October 21, 2026

## Project requirements finalized

The application will be an offline-first desktop tool for a single organizer to manage recreational pickleball open play on Windows and macOS. It will support 16–32 players, 2–4 courts, fair waiting-time-based rotation, singles and doubles, detailed manual scoring, individual statistics, leaderboards, and durable local session history.

The initial release will require no internet connection for normal operation. No cloud accounts, online services, or multi-device synchronization will be required.

Target capacity

# 32 players

Court capacity

# 4 courts

Supported platforms

Windows + macOS

Data ownership

Local device

## 1. Project objectives

1. Simplify the administration of open play by managing players, courts, queues, and game results in one application.
2. Ensure fair participation by prioritizing players who have waited longest.
3. Provide reliable, detailed pickleball scoring, including serving order and service positions.
4. Reduce court downtime with clear next-game recommendations and fast manual court assignments.
5. Track player performance through session and historical statistics and leaderboards.
6. Preserve all session records locally and allow the organizer to back up, restore, and export data.
7. Deliver a usable, maintainable desktop application that continues to work without internet access.

## 2. Confirmed requirements

| Requirement     | Final decision                                                 |
| --------------- | -------------------------------------------------------------- |
| Platform        | Desktop application for Windows and macOS                      |
| Operating mode  | Offline, single organizer                                      |
| Players         | 16–32 per session                                              |
| Courts          | 2–4 configurable courts                                        |
| Rotation        | Waiting-time-based fair rotation                               |
| Match formats   | Singles and doubles                                            |
| Default scoring | Standard side-out scoring                                      |
| Game completion | Fixed target score, win by two                                 |
| Scorekeeping    | Full scoring, including serving sequence and service positions |
| Skill balancing | Optional per session                                           |
| Game timer      | Optional, organizer-controlled                                 |
| Leaderboards    | Session and cumulative historical                              |
| Data retention  | Keep all sessions until explicitly deleted                     |
| Backup          | Manual backup and restore                                      |
| Export          | CSV and Excel-compatible output                                |
| Recovery        | Automatic local saving and recovery                            |
| Display         | Dedicated large-screen view                                    |
| Coding status   | Brief finalized; no implementation authorized by this request  |

## 3. Scope and feature priorities

Priorities are defined as:

- P0 — Must have: required for the initial release.
- P1 — Should have: part of the initial release, subject to implementation sequencing.
- P2 — Future: explicitly outside the initial release.

The initial release must include the confirmed core requirements, including full scorekeeping and all selected additional features. P1 is an implementation priority, not permission to omit an agreed requirement.

P0 — Session and player management

- Create, reopen, finish, and review sessions.
- Add, edit, check in, mark unavailable, and remove players where safe.
- Support nicknames and duplicate-name disambiguation.
- Configure 2–4 courts and session scoring settings.
- Track player availability and arrival order.

P0 — Fair rotation and court assignment

- Maintain a waiting queue based on when each player became eligible to play.
- Suggest the next eligible group for each available court.
- Support singles and doubles.
- Prevent double assignments and invalid player counts.
- Track consecutive games and waiting time.
- Permit manual overrides with a reason recorded when appropriate.

P0 — Full scoring

- Standard side-out scoring.
- Singles and doubles serving rules.
- Serving team, server sequence, service court, and service-position tracking.
- Point entry, undo, correction, and score validation.
- Fixed score targets, normally 11, with win by two.
- Complete game records and recoverable score history.

P0 — Local data integrity

- Embedded local database.
- Automatic saving and recovery of unfinished sessions.
- Session history retained until explicit deletion.
- Manual backup and restore.
- CSV and Excel-compatible export.
- Validation before restoring a backup.

P1 — Statistics and leaderboards

- Games, wins, losses, points scored, points conceded, and win percentage.
- Session and cumulative historical rankings.
- Partner history and games played.
- Participation thresholds and transparent ranking criteria.

P1 — Court display and session tools

- Large-screen display of active courts, scores, and waiting queue.
- Optional organizer-controlled timers.
- Optional skill-balanced teams.
- Avoid repeated partnerships when feasible.
- Session summary and export workflow.

P2 — Future enhancements

- Networked multi-device synchronization.
- Cloud storage and accounts.
- Online player registration.
- Tournament brackets and league administration.
- Advanced player rating algorithms.
- Payments and membership management.

## 4. User roles and permissions

The first release is a single-user application. It does not require authentication or role-based access control.

| Role                       | Permissions                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Session organizer          | Full control over sessions, players, courts, rotation, scoring, corrections, statistics, backups, and exports |
| Player                     | No direct application access required; player information is managed by the organizer                         |
| Spectator / display viewer | Read-only access to the large-screen display                                                                  |
| Application administrator  | No separate administrative account in v1; application settings are managed locally                            |

The large-screen display must not expose organizer controls. If the application runs on a second monitor, the organizer should retain control through the main window.

## 5. End-to-end workflows

### Workflow A — Create and start a session

Flow: Launch application → Create session → Set courts and scoring rules → Load or add players → Check in players → Configure optional skill balancing → Initialize waiting queue → Generate court recommendations → Organizer confirms assignments → Start games

Expected behavior

- The application records the session date, settings, and registered players.
- Players can be added after play starts.
- Players who are absent, resting, or unavailable cannot be assigned to a new game.
- The organizer can start with fewer players than the expected capacity.
- An incomplete court remains available rather than receiving an invalid assignment.

### Workflow B — Fair rotation

The application maintains a waiting queue and proposes eligible players for available courts.

Proposed algorithm

1. Exclude players already assigned to an active game, unavailable players, and players who have declined the current turn.
2. Order eligible players by the time they became eligible for play, oldest first.
3. Select the required number of players for the court: four for doubles or two for singles.
4. If optional skill balancing is enabled, optimize team composition among eligible players without unfairly bypassing long-waiting players.
5. If partner rotation is enabled, prefer pairings that reduce repeated partnerships, provided this does not significantly undermine queue fairness.
6. Display the recommendation and allow the organizer to confirm or override it.
7. When a game ends, release the participants and update their next eligible waiting times.

Fairness principle: Waiting time is the primary selection criterion. Skill balancing and partner variety are secondary preferences. They must not silently override the queue.

A player who declines a turn should be moved to a clearly defined position in the queue. The exact penalty or re-entry rule is a configurable policy to be confirmed during implementation.

### Workflow C — Full scoring and match completion

The scoring interface must support detailed scoring without forcing the organizer to navigate away from the active court.

Illustrative court scoreboard

### Team A

Player A1 / Player A2

# 8

### Team B

Player B1 / Player B2

# 7

Serving team: A

Target: 11

Win by 2

Illustrative layout only. Interactive scoring controls will be part of the application, not this brief.

Scoring workflow

1. Open the assigned court and verify the teams.
2. Initialize the correct serving team, server sequence, and service positions.
3. Record each point or rally outcome.
4. Update the score and relevant serving state according to the scoring rules.
5. Allow undo if the point or rally was entered incorrectly.
6. Validate whether the game has reached the winning condition.
7. Confirm the final result and complete the game.
8. Update game history, player statistics, and the rotation queue.

Important rule: In standard side-out scoring, only the serving team scores a point. A rally won by the receiving team changes service rather than automatically awarding that team a point. The application must distinguish this from rally scoring.

The detailed scorekeeping implementation must account for the official serving and position rules, including singles, doubles, the first service sequence of a doubles game, and applicable service faults. The selected rules edition should be documented and tested before release.

### Workflow D — Undo and correct results

- Undo reverses the latest scorekeeping action and restores the previous valid game state.
- A correction to an earlier action must preserve the integrity of subsequent actions.
- If a completed match is reopened, the organizer must explicitly confirm the correction.
- Statistics and leaderboards are recalculated from the corrected match data.
- Each correction records the time, affected game, previous value, new value, and reason where provided.
- Invalid edits must not create duplicate game completions or duplicate statistics.

### Workflow E — End and preserve a session

1. Stop new court assignments.
2. Complete active games or mark them as incomplete.
3. Review final scores and statistics.
4. Save the session as completed.
5. Export results if required.
6. Create a manual backup when desired.
7. Retain the session until the organizer explicitly deletes it.

Completed sessions must be read-only by default. Corrections should require an explicit reopen or edit action.

## 6. Business rules

### Session and player management

- Each session has a unique identifier.
- Each player has a stable local identifier independent of their display name.
- A player can have different participation states across sessions.
- Player identity should be retained across sessions to support historical statistics.
- Deleting a player from the active roster must not automatically erase historical game records.
- The application must prevent duplicate player entries within the same session unless the organizer intentionally selects an existing player.
- The number of active courts cannot exceed the configured number of courts.

### Court and match assignment

- Doubles requires four distinct players; singles requires two.
- Every active game is associated with exactly one court.
- A player cannot be in more than one active game.
- Court assignments can be manually changed before a game starts.
- Once scoring starts, changing participants requires an explicit cancellation or administrative correction.
- A game that has started cannot be silently replaced by another game.

### Scoring rules

- The default game target is 11, with a two-point winning margin.
- Alternative fixed targets, such as 15 or 21, may be selected for a session.
- A game ends only when a team reaches the configured target and leads by at least two points.
- Service order, server number where applicable, and service court must remain valid throughout play.
- Undo and corrections must restore a valid scoring state.
- Timer expiration does not automatically declare a winner or finalize a game.
- Incomplete or abandoned games must be distinguished from completed games in history and statistics.

### Statistics and rankings

- Player statistics are derived from finalized games.
- Incomplete or cancelled games are excluded from win/loss statistics by default.
- Doubles results count toward each participating player's individual record.
- Session leaderboards use only the selected session.
- Historical leaderboards aggregate eligible completed games across retained sessions.
- Rankings must display games played and must not imply that a small sample is equivalent to sustained performance.
- Win percentage is calculated as wins divided by completed games, excluding draws unless a future format explicitly supports them.
- Ties must be resolved using documented ranking criteria or displayed as ties.

### Data integrity

- All core operations work without internet access.
- Every scoring action must be committed to local storage before being treated as saved.
- Restoring a backup must validate the file before replacing or merging data.
- Exporting data must not alter source records.
- Session deletion must be explicit and confirmed.
- The application must protect against duplicate game finalization and inconsistent derived statistics.

## 7. Proposed data model

The following logical data model is the baseline for implementation. It is technology-independent and can be translated into SQLite tables during development.

```
SESSION(session_id PK, name, started_at, ended_at, status, target_score, win_by, scoring_mode)
SESSION_PLAYER(session_id FK, player_id FK, checked_in_at, availability_status)
PLAYER(player_id PK, display_name, skill_level, active)
COURT(court_id PK, session_id FK, label, status)
GAME(game_id PK, session_id FK, court_id FK, format, status, team_a_score, team_b_score, started_at, ended_at, winner)
GAME_PARTICIPANT(game_id FK, player_id FK, team, starting_position)
SCORE_EVENT(event_id PK, game_id FK, occurred_at, event_type, event_data)
ROTATION_EVENT(event_id PK, session_id FK, occurred_at, event_data)
AUDIT_EVENT(event_id PK, session_id FK, occurred_at, action, details)
```

### Data entities and responsibilities

| Entity          | Purpose                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| Player          | Stable identity, display name, and optional skill level                       |
| Session         | Session settings, lifecycle, scoring defaults, and retention                  |
| SessionPlayer   | Check-in, availability, and session-specific participation state              |
| Court           | Court identifier, display label, and current status                           |
| Game            | Match format, court, participants, score, and outcome                         |
| GameParticipant | Player, team assignment, and starting position for each game                  |
| ScoreEvent      | Point, serve, fault, undo, and correction events needed to reconstruct a game |
| RotationEvent   | Queue changes, eligibility times, assignments, and organizer overrides        |
| AuditEvent      | Important administrative actions and corrections                              |

Additional implementation requirements:

- Use stable identifiers instead of names as database keys.
- Store timestamps consistently and display them in the computer's local time zone.
- Store detailed scorekeeping events so a match can be reconstructed after an interruption.
- Keep historical participant and team information even if a player is later removed from the roster.
- Calculate derived statistics from authoritative game records or maintain them through validated transactions.
- Store application settings and database schema version information locally.
- Define indexes for player history, sessions, active games, and event retrieval.

## 8. Proposed application architecture

Desktop user interface

Organizer dashboard · Scoring · Queue · Reports · Display

Application services

Rotation engine · Scoring engine · Statistics · Validation · Backup

Local data layer

SQLite · Event history · Session recovery · Local export and restore

### Recommended technology

- Desktop framework: Tauri or Electron, selected based on the developer's experience and the desired distribution model.
- User interface: A locally packaged web interface.
- Database: SQLite.
- Export: CSV plus XLSX, or a clearly documented Excel-compatible format.
- Offline delivery: Bundle all application assets and dependencies required for core operation.
- Display: A separate application view or window driven by the same local state.
- Recovery: Transactional database updates and startup recovery checks.

No framework has been mandated. The final implementation stack must be selected before coding, with Windows and macOS packaging tested independently.

## 9. Acceptance criteria and release tests

The following are release gates, not optional recommendations.

| ID    | Test                 | Passing condition                                                                                     |
| ----- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| AC-01 | Offline startup      | The installed application opens and performs all core workflows without internet                      |
| AC-02 | Capacity             | 32 players and four courts can be managed in one session                                              |
| AC-03 | Rotation             | Eligible players are prioritized by waiting time, and queue recommendations are explainable           |
| AC-04 | Assignment integrity | No player can occupy two active games or be assigned to an unavailable court                          |
| AC-05 | Standard scoring     | Side-out scoring, serving changes, server sequence, and service positions follow the documented rules |
| AC-06 | Win condition        | A game cannot be finalized without reaching the configured target and winning by two                  |
| AC-07 | Undo                 | Undo restores the previous valid score and service state                                              |
| AC-08 | Corrections          | Reopened games can be corrected without duplicating results or corrupting statistics                  |
| AC-09 | Singles              | Singles uses two players and the correct service rules                                                |
| AC-10 | Doubles              | Doubles uses four players and the correct service sequence                                            |
| AC-11 | Recovery             | An interrupted session can be reopened with its latest committed state                                |
| AC-12 | Data retention       | All sessions remain available until explicitly deleted                                                |
| AC-13 | Backup and restore   | A valid backup can be restored; an invalid backup is rejected safely                                  |
| AC-14 | Export               | Session results and statistics can be exported and opened in the selected spreadsheet format          |
| AC-15 | Statistics           | Finalized game results produce consistent player statistics and rankings                              |
| AC-16 | Skill balancing      | Optional skill balancing can be enabled or disabled without breaking rotation fairness                |
| AC-17 | Partner rotation     | Repeated partnerships are reduced where feasible without overriding the primary queue rule            |
| AC-18 | Timer                | The optional timer works independently of score completion                                            |
| AC-19 | Display              | The large-screen view reflects current courts, scores, and queue state                                |
| AC-20 | Cross-platform       | Core workflows pass on supported Windows and macOS versions                                           |

### Additional quality requirements

- Usability: Core score entry must be accessible with minimal navigation and readable court-side.
- Reliability: Database operations must be transactional, and interrupted writes must not leave partially completed games.
- Performance: Normal scoring, court assignment, and dashboard updates should feel immediate at the target capacity.
- Maintainability: Scoring, rotation, persistence, and presentation logic should be separated.
- Privacy: Player information and session records remain local; no external transmission is required.
- Accessibility: Controls should have clear labels, sufficient contrast, and keyboard support.

Exact launch-time and response-time targets can be set during technical design and verified on representative hardware.

## 10. Risks and mitigation plan

| Risk                           | Impact                         | Mitigation                                                                                    |
| ------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------- |
| Incorrect serving logic        | Invalid scores or disputes     | Implement a rules-based scoring engine and test singles, doubles, faults, and service changes |
| Unfair queue behavior          | Player dissatisfaction         | Prioritize waiting time, expose selection reasons, and allow controlled overrides             |
| Corrupted local data           | Lost sessions or results       | Use SQLite transactions, manual backups, integrity checks, and recovery tests                 |
| Accidental score changes       | Incorrect statistics           | Provide undo, explicit correction workflows, and score-event history                          |
| Misleading leaderboards        | Unfair player comparisons      | Display games played, define ranking rules, and set minimum participation thresholds          |
| Windows/macOS differences      | Installation or display issues | Package and test both platforms independently                                                 |
| Excessive interface complexity | Slower game turnover           | Prioritize active courts, scores, and next-up queue on the main dashboard                     |
| Backup restores overwrite data | Irrecoverable records          | Validate backups and require confirmation before destructive replacement                      |
| Skill balancing delays play    | Longer waiting times           | Make balancing optional and subordinate to waiting-time fairness                              |
| Incomplete game recovery       | Incorrect match outcomes       | Persist score events and active-game state; distinguish incomplete games from finalized games |

## 11. Dependencies and prerequisites

Before development begins, the project needs:

1. Development environment: A confirmed framework, language, build process, and target operating system versions.
2. Rules specification: A documented version of the official pickleball rules used to implement serving, faults, positions, and scoring.
3. Rotation specification: Agreed tie-breaking, declined-turn, arrival, rest, and re-entry behavior.
4. Data model: Agreement on player identity, session lifecycle, game history, and event storage.
5. Export formats: Confirmation of CSV and XLSX expectations, including the required columns.
6. Backup policy: Definition of the backup file format, validation process, and replacement-versus-merge behavior.
7. Test data: Representative sessions with uneven attendance, mixed skill levels, singles and doubles, and interrupted matches.
8. Distribution: A decision on installer packaging, application updates, and code signing for Windows and macOS.

### Rules reference

The implementation should use the current applicable rules published by USA Pickleball as its primary reference.

- [Official USA Pickleball rules](https://usapickleball.org/rules/)
- [Official rules and resources](https://usapickleball.org/what-is-pickleball/official-rules/)

The application should document which rules edition it implements and avoid silently changing scoring behavior when a later rules edition is released.

## 12. Implementation boundaries

### Included in v1

- Windows and macOS desktop application.
- One local organizer.
- 16–32 players and 2–4 courts.
- Singles and doubles.
- Fair, waiting-time-based rotation.
- Full manual scorekeeping with serving sequence and service positions.
- Fixed-target scoring and win-by-two validation.
- Undo, correction, and score history.
- Optional skill balancing, partner rotation, and timers.
- Session and historical leaderboards.
- Large-screen display.
- Persistent local records, backup, restore, and export.
- Offline operation and interruption recovery.

### Excluded from v1

- Cloud synchronization and online accounts.
- Multiple organizers controlling a shared session from different devices.
- Online registration and remote player access.
- Automatic scoring from cameras or sensors.
- Tournament brackets, payments, and membership administration.
- Mandatory skill-rating calculations or advanced matchmaking.
- Internet-dependent analytics or external services.

## 13. Suggested implementation phases

1. Phase 1 — Foundation

   Establish the desktop framework, database, session lifecycle, player registration, court management, and recovery mechanism.
2. Phase 2 — Scoring engine

   Implement singles and doubles scoring, serving order, service positions, faults, undo, correction, and game completion. Validate this independently before integrating the rotation engine.
3. Phase 3 — Rotation and court operations

   Implement waiting-time prioritization, next-game recommendations, manual overrides, availability handling, skill preferences, and partner rotation.
4. Phase 4 — Statistics and reporting

   Implement session and historical leaderboards, player statistics, CSV/XLSX export, and manual backup/restore.
5. Phase 5 — Display and release validation

   Add the large-screen display and optional timer, test interruption recovery, verify offline operation, and complete Windows/macOS release testing.

## 14. Definition of done

The project is complete when:

- All P0 and P1 features in the agreed scope are implemented.
- All acceptance criteria pass on both supported operating systems.
- Standard singles and doubles scoring has passed rule-based tests.
- Rotation behavior has passed fairness and edge-case tests.
- A session can be interrupted, recovered, corrected, exported, and backed up without losing committed results.
- The app operates without internet access after installation.
- The organizer can manage a complete open play session without relying on external tools for player queues, scoring, or results.
- Installation and user instructions are documented.

Final status: The project brief is finalized as the requirements baseline for development. No code has been written as part of this step. The remaining work is technical stack selection, detailed scoring and rotation test cases, and implementation planning.
