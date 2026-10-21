# Pickleball rules implemented by the scoring engine

Decision D8. Written at the start of phase 2 (2026-10-21) by the test-author.

## Edition

Edition: 2026 USA Pickleball Official Rulebook

- Publisher: USA Pickleball Association. The copyright page reads "2010©; revised 2026©". The running footer on every page reads "2026 USA Pickleball Official Rulebook".
- Official source: https://usapickleball.org/what-is-pickleball/official-rules/ (the rules link in brief §11).
- Text actually read: the 2026 Official Rulebook PDF that USA Pickleball distributes through Pickleball Canada, https://pickleballcanada.org/wp-content/uploads/2026/03/2026-Official-Rulebook-EN.pdf (96 pages). The 2026 Rulebook Change Document was also checked, https://pickleballcanada.org/wp-content/uploads/2026/04/2026-Rulebook-Change-Document-EN.pdf. usapickleball.org returned a bot-check page to automated requests, so the organizer should compare the rule numbers below with the copy on usapickleball.org (open question Q1).
- The 2026 edition renumbered the rulebook. Part II (Sections 4–14) covers standard play and Part III (Sections 15–24) covers tournaments. Every rule number below is a 2026 number. 2025 numbers are not interchangeable with them.
- The engine exports this exact edition string as `RULES_EDITION` from `src/core/scoring`. A later edition must not change scoring behaviour silently (brief §11). Changing it means updating this file, the constant and the locked tests together.

## Scope

The app implements standard (side-out) scoring for singles and doubles (Part II), plus the game target and win-by-two from Part III. It does not implement rally scoring (Rule 14.A, provisional), mini-singles (14.B), end changes (21.B), time-outs, technical fouls, or anything in Part IV.

## Rules relied on

### Scoring and winning

| Rule | Text (summary) | Engine behaviour |
| --- | --- | --- |
| §1 The Game | Points are scored only when the serving side wins the rally. The server alternates service courts and keeps serving until they lose a rally. "Typically" a game goes to 11 with a 2-point margin. | Default target 11, win by 2. |
| 4.A Standard Scoring | A point is scored by serving the ball and winning the rally. | Only the serving team's score changes. A rally won by the receiving team never adds a point. |
| 4.B Winning the Game | The first player or team to score the winning point wins the game. | The game is over when the serving team scores a point that brings it to ≥ target with a lead ≥ win-by. |
| 15.C Tournament Match and Scoring Options | All scoring options are win by two points. 15.C.1.a–d: games to 11, 15 or 21. | Targets 11, 15 and 21 are supported, each win by 2. 11-10 does not end a game; play continues until someone leads by 2. |
| §2 Fault | A rules violation that results in a dead ball and the loss of a rally. | A fault against a team has exactly the same effect as the other team winning the rally. |
| §2 Side Out | The serve is awarded to the opposing team after a singles player or doubles team loses its serve. | See the serving rules below. |
| §2 Replay | The restart of a rally without awarding a point or changing the server. | Replays and hinders (5.C.1.a, 6.F.1, 9.C.2) change nothing, so they are not scoring events. |

### Singles (Rule 5.A)

| Rule | Text (summary) | Engine behaviour |
| --- | --- | --- |
| 5.A | The server's score determines where the server and receiver stand. | |
| 5.A.1 Server Position | Server's score zero or even: serve from the right serving area into the opponent's right service court. Odd: serve from the left into the opponent's left service court. | Server side = right if the server's score is even, else left. The receiver is on the same side, set by the **server's** score, not the receiver's. |
| 5.A.2 Holding Serve | The server keeps serving, alternating right and left after each point won, until they lose a rally. | |
| 5.A.3 Side Out | A side out occurs after the server loses a rally. | Singles has no server number. |
| 6.B.1 Singles score call | Two numbers: server's score, then receiver's score. Each game starts "zero – zero". | `calledScore` = `"<server>-<receiver>"`, e.g. `"0-0"`. |

### Doubles (Rule 5.B)

| Rule | Text (summary) | Engine behaviour |
| --- | --- | --- |
| §2 Starting Server | For each doubles team, the player designated to serve first at the start of a game. | Each team's starting server is that team's first listed player, which is `startingPosition` 1 in `game_participants`. |
| 5.B | Both players serve before a side out, except at the start of each game, when only the starting server serves (as second server) before a side out. | First-server exception: the opening service turn has one server only. |
| 5.B.2 First and Second Servers | After each side out, service begins with the player correctly positioned on the right according to the team's score. That player is first server for the turn and the partner is second server. The starting server of the team that starts the game is the second server for that team's first service turn. | After a side out, server = the player whose correct position is right for the team's current score, server number 1. At the start of the game, server = the first serving team's starting server, server number 2. |
| 5.B.3 Correct Serving and Receiving Positions | Positions come from the team's score. The starting server is on the right when their team's score is zero or even, and on the left when it is odd. The partner is on the opposite side. This holds while serving and while receiving. | For each team: the starting server is right if the team score is even, else left, and the partner takes the other side. Positions only change when that team scores. |
| 5.B.5 Duration of First Server | The first server serves, alternating right and left after each point won, until the serving team loses a rally. The serve then passes to the second server. | Server 1 loses the rally → server number 2, the partner serves, no point scored. |
| 5.B.6 Duration of Second Server | The second server serves the same way until the serving team loses a rally, which is a side out. | Server 2 loses the rally → side out. |
| 7.E Serve Placement | The server serves to the service court diagonally opposite their correct position. | Receiver = the receiving-team player on the same side label (right/left) as the server. Sides are always given from each player's own view facing the net. |
| 6.B.2 Doubles score call | Three numbers: serving team's score, receiving team's score, server number. Each game starts "zero – zero – two". | `calledScore` = `"<serving>-<receiving>-<serverNumber>"`, e.g. `"0-0-2"`. |
| 17.D.4 / 17.D.5 | The referee calls "second server" after the first server's team loses a rally, and "side out" when a singles player or second server loses the serve. | Confirms the sequence above. |

### Faults that end a service turn

Every fault is the loss of a rally (§2, 9.B). When the serving side commits a fault, the server loses the rally: a singles side out (5.A.3), first server → second server (5.B.5), or second server → side out (5.B.6). Faults the rulebook lists against the server or serving side include:

- 6.C.1 early serve (serving while the score is being called)
- 6.D.1 10-second violation
- 7.A.1.a not grounded, 7.A.2.a contacting the court, 7.A.3.a outside the serving area (service foot faults)
- 7.E.1 serve lands out of bounds
- 10.A.2 the serving side does not let the return bounce

Faults against the receiving side, such as 10.A.1 (the receiver does not let the serve bounce) and 5.C.1.c (incorrect receiver), lose the rally for the receiving side. The serving team therefore scores a point (4.A).

The engine does not need the specific fault. A fault event names the team it is against, and an optional label is kept for the record.

### Worked doubles opening (5.B, 5.B.2, 5.B.3, 6.B.2)

Team A (a1 = starting server, a2) serves first against Team B (b1 = starting server, b2).

| After | Score A–B | Serving | Server (#) | Server side | Receiver | Call |
| --- | --- | --- | --- | --- | --- | --- |
| start | 0–0 | A | a1 (2) | right | b1 | 0-0-2 |
| A wins rally | 1–0 | A | a1 (2) | left | b2 | 1-0-2 |
| B wins rally | 1–0 | B (side out) | b1 (1) | right | a2 | 0-1-1 |
| B wins rally | 1–1 | B | b1 (1) | left | a1 | 1-1-1 |
| A wins rally | 1–1 | B | b2 (2) | right | a2 | 1-1-2 |
| B wins rally | 1–2 | B | b2 (2) | left | a1 | 2-1-2 |
| A wins rally | 1–2 | A (side out) | a2 (1) | right | b1 | 1-2-1 |

## Open questions (organizer to decide; not guessed)

- **Q1. Source check.** The text was read from USA Pickleball's 2026 rulebook PDF as distributed by Pickleball Canada, because usapickleball.org blocked automated access. Please confirm the rule numbers against the copy on usapickleball.org.
- **Q2. Win-by-two in standard play.** Part II only says "the winning point" (4.B), and §1 says "typically" 11 by 2. The explicit win-by-two rule is in Part III (15.C, tournaments). The app follows brief §6: session target (default 11) and win-by (default 2). Please confirm that applying win-by-two to open play is intended.
- **Q3. Penalty points.** The 2026 Change Document (item 2135) notes that a technical foul can award a point to the receiving team and even end a game. Technical fouls are tournament conduct penalties (Section 22) and are not modelled. Confirm they are out of scope for open play.
- **Q4. Who serves first and who is starting server.** In tournaments this is chosen by a fair method (17.C.4) and starting servers are identified (18.C). The app takes the first serving team and each team's starting server as input when scoring starts and does not decide them. Confirm.
- **Q5. Replays and hinders.** These change nothing (§2 Replay), so they are not recorded as scoring events. Say if you want them logged for the record anyway.
- **Q6. Positions shown are the correct positions.** If players stand in the wrong place and the rally finishes, the result stands (5.C.2). The engine always shows the positions the rules require, not where players actually stood, and has no "wrong server" event.
- **Q7. Score call once the game is over.** The rulebook does not define a call after the winning point. The engine's `calledScore` for a finished game is unspecified and not tested.
- **Q8. Rally scoring (14.A).** Provisional in 2026 and excluded by the brief (`scoringMode: 'side_out'`). Confirm it stays out of v1.
