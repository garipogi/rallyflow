# Changelog

All notable changes to RallyFlow are listed here. Versions follow [Semantic Versioning](https://semver.org).

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
