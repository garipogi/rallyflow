# Changelog

All notable changes to RallyFlow are listed here. Versions follow [Semantic Versioning](https://semver.org).

## 1.2.0 (unreleased)

### Courts and team-ups
- **1 court (small group):** sessions can now run on a single court. Choose "1 court (small group)" when starting a session or under Number of courts. Rotation, recommendations, the display (one big court card), stats and awards all work with one court. The 2-4 court rule still applies unless the app explicitly opts in to one court (D15).
- **Team-up style** (on the new-session form and in Game settings): **Balanced (recommended)**, **Longest wait**, **Random** (a sit-out wheel: nobody plays twice before everyone has played once; random teammates and opponents), **Paddle stacking** (winners play winners, losers play losers), **Up & Down the River** (king of the court: winners move up, losers move down) and **Fixed partners** (lock pairs who always play together). Who plays is still decided by the balanced-games rule in every grouping style, so game counts stay level; each recommendation explains the grouping (D16).
- **Six more team-up styles** (D17): **Mixed doubles** (one man + one woman per team when the players due to play allow it; same-gender fallback explained), **Skill pools** (A/B/optional C pools from the roster or skill cutoffs; courts by pool, auto or alternating; a short pool keeps its court open with a reason or borrows players), **Round robin schedule** (everyone partners everyone as evenly as possible, fair byes, printable / Save as PDF, Start this game follows it, regenerate when the roster changes), **Mentor pairing** (higher-rated with lower-rated, unrated = middle), **Challenge court** (winners stay on for up to 1-3 games, Court 1 or every court) and **Swiss pairing** (similar records play each other, avoiding rematches). Who plays stays fewest games first except the documented bounded exceptions (challenge holders, the round-robin schedule); every style works on 1 court.
- **Explanation window:** choosing a team-up style (new-session form or Game settings) opens a window with a summary, how it works, a small diagram, best for, what you need (checked against your roster, with Set genders / Set skill levels shortcuts), the fairness rule and an example with your players. **Use this style** applies it, **Cancel** keeps the old one; **ⓘ About this style** reopens it anytime. Keyboard and screen-reader friendly, light and dark.
- **Player details** (D18): optional skill level (1-8) and gender when adding a player, skill/gender/pool in the roster's Edit row, and a Player details table for everyone at once. Stored without a database schema change.

### Awards
- **✏️ Club name:** set your club or group name (and an optional tagline) on the Awards page or under Appearance, with an optional name for one session only. It leads the ceremony welcome card, every title card header, the finale and wrap-up, the awards board on the display, the saved image, the Awards page banner and the certificates ("Presented by …"). Empty falls back to the session name and RallyFlow.
- Fixed: the podium could show only 1st and 3rd. After a tie for first (official ranks 1, 1, 3) the silver step was left empty and hidden. The podium now always draws gold, silver and bronze: tied players share a step ("Tied for 1st") and the next players fill the next steps, with a small "Rank N" label when the official rank differs. Same on the ceremony finale, the awards board, the saved image and the Awards page.

## 1.1.1

- Fixed: on Apple-silicon Macs a downloaded copy could be refused as "damaged". Mac builds are now ad-hoc signed (free, no Apple account), so macOS shows the normal first-open prompt.
- Local Mac builds (`npm run dist:mac`, `npm run install-app`) now package outside the project folder, because an iCloud-synced Desktop breaks code signing.

## [1.1.0] — 2026-10-22

### Awards ceremony
- **🎬 Start ceremony:** hand out the awards one at a time, building to the champion. Each award gets a title card, a suspense phase where a spotlight sweeps over the nominees to a drumroll, and a reveal with curtains, a count-up, fireworks, confetti and applause. The finale raises the podium third, second, then first.
- Host view with the live audience view, the secret winner, the line to read out and what comes next. Next / Back / Skip suspense / Pause / Sound / End, keyboard shortcuts (Space, arrows, Enter, S, P, M, Esc), progress buttons, and optional auto-advance with a short, medium or long suspense.
- **Run on display:** the big screen mirrors each step in sync (shared phase timestamps), stays control-free and never shows the secret winner.
- Drumroll, crash, fanfare and applause synthesized on the computer (no audio files); sound starts only on the organizer's click and can be muted.
- Reduced motion: movement becomes fades, the timing and suspense are kept.

### Edit awards
- Show or hide, rename (icon, title, description), reorder by drag or buttons, delete added awards, and restore the defaults. The lineup order is the ceremony order; saved for every session.
- Host picks (people's choice): choose the winner, optional nominees and a note, before or during the ceremony; kept per session.

### Award library
- 28 awards in six categories: 19 computed from the games (Shutout King, Comeback Kid, Serve Machine, Lucky Charm, Marathon Match, Early Bird and more) and 9 host picks (Best Sportsmanship, Newcomer of the Night, ...), with search, categories and a live preview of who would win.
- **Recommended for this session:** suggestions based on what happened tonight, one click to add.

## [1.0.0] — 2026-10-21

First public release of **RallyFlow — Every game. Every player. In rhythm.**, the offline pickleball open play manager (previously developed as "Pickleball Open Play").

### Sessions and players
- Create a session with a name and 2–4 courts; resume an unfinished session after an unexpected close.
- Add players (with optional nickname), duplicate-name check against earlier nights, check-in, rest / back from rest, remove.
- Rename players without losing their history; delete sessions with a native confirmation.

### Rotation
- Fair next-game recommendations for every free court: longest wait first, mixed partners and opponents, no back-to-back sit-outs, with the reason each player was chosen.
- Manual assignment, declining a turn, court availability and changing the number of courts mid-session.

### Scoring
- Rally-by-rally scoring under the official rules: side-outs, server number, called score, faults.
- One-tap undo, audited score corrections, finalize at game point, or record just the final result.
- Per-court game timer (start, pause, resume, reset) that never ends a game by itself.

### Big-screen display
- Read-only second window with every court, score, serving team, elapsed time and the next-up queue; updates live; readable from the baseline.

### Awards
- Player of the Session, podium and award cards (Most Wins, Point Machine, Hot Streak, Clutch Player, Dynamic Duo, Social Butterfly, Iron Player and more), per session or all time.
- Show the ceremony on the display, save it as a 1920×1080 image, print certificates as PDF.

### Reports, export and backup
- Session and all-time leaderboards.
- CSV and Excel export; one-file `.pbbackup` backups with validated restore and automatic safety backups.

### Look and feel
- RallyFlow brand: new app icon, header lockup with tagline, branded display, ceremony and certificates.
- Nine colour themes in light, dark or system mode, mirrored on the display.
- About panel with version and copyright, and Help › Third-Party Notices.

### Privacy and platform
- Fully offline: no accounts, no telemetry, every network request blocked.
- macOS 13+ (Apple silicon and Intel) DMG and zip; Windows 10 22H2+ / 11 NSIS installer. Unsigned builds.
- Existing data from "Pickleball Open Play" installs is kept (same data folder).
