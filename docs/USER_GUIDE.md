# RallyFlow: organizer guide

*Every game. Every player. In rhythm.* RallyFlow is the offline pickleball open play manager.

This guide walks one organizer through a full open-play night. RallyFlow works completely offline: it never needs the internet, and nothing you enter leaves the laptop.

## 1. Start or resume a session

On the first screen type a **Session name** (for example "Thursday Open Play"), choose how many **Courts** you have (1 to 4; pick **1 court (small group)** for a small group on a single court), choose a **Team-up style** (see below; Balanced is the default) and press **Start session**. You can change the number of courts later with **Number of courts** above the court board. If the app was closed unexpectedly, a yellow banner offers **Resume** for the unfinished session; everything up to your last action is restored.

Past sessions are listed below. Open one to review it. A finished session is read-only until you press **Reopen for corrections**.

**Deleting a session.** Press **Delete** next to a session in the list, or **Delete session** inside the session room. A system dialog names the session and asks you to confirm; nothing is deleted unless you press **Delete session** in that dialog. Deleting removes the session's games, scores, roster and rotation history for good (make a backup first if you might need it), but the players stay in your player list for future nights. You can delete an active session even while a game is still being played; the dialog warns you how many games are in progress, and they are deleted with it. After deleting from the session room you return to the sessions list.

## 2. Players and check-in

In the session room, type a **Player name** (and optionally a **Nickname**) and press **Add player**. If the name matches someone from an earlier night, the app asks whether this is the same person so you do not create duplicates. Press **Check in** when the player arrives; only checked-in players enter the queue, and the button is replaced by a green **Checked in** tag.

**Fixing a name.** Press **Edit** on a player's row, change the name and/or nickname, and press **Save** (or **Cancel** to leave it as it was). If the new name or nickname belongs to another player, the app shows who it matches and saves only if you press **Keep as a different person**. Editing never creates a new player, so all of their past games and statistics stay with them, and the new name shows everywhere, including earlier sessions and reports. **Rest** takes a player out of the queue for a while, **Back from rest** returns them, **Remove** takes them off the roster.

## 3. Courts and the queue

The top of the session room is the court board: each court, its current game and score. Under it, **Next up** shows the recommended games and the waiting queue in order, with how long each person has waited and how many games they have played.

- Press **Start this game** on a recommendation to put those four players (or two for singles) on the court.
- **Decline turn** skips a player who does not want to play right now, following the decline rule you chose.
- Open **Game settings and manual override** to switch singles/doubles, skill balancing or partner rotation, or to pick players yourself. A manual override needs a short reason, which is recorded.

**Who plays next (Game settings).** Choose how the queue picks players:

- **Balance games played (recommended)** is what every new session starts with. Players with the fewest games go first; among players with the same number of games, the longest wait goes first; if that is also equal (for example the four who just finished the same game), a draw that changes every round decides, so nobody always wins ties. Over a night everyone's game count stays within one game of everyone else's. Partners also rotate: the app pairs the four chosen players so repeat partners, then repeat opponents, are as rare as possible (and, with **Balance by skill** on, the teams are as even as possible after that). Pairing never changes *who* plays.
  - *Late arrivals* start level with the regulars: when someone checks in after games have been played, they are credited with the fewest games anyone already present has (shown in the queue as "+N catch-up"), so they join the rotation instead of playing many games in a row.
  - *Resting* keeps a player's place, as before. Because they missed games while away, they will usually be first back on court until they are level again.
  - *Declining* still skips the player for this turn and follows your decline rule; with balanced games the player's game count still decides their place on the next turn.
  - The explanation under each recommended game says why: each player's games played, their wait, who waits a turn because they have played more, and how a tie was settled.
- **Longest wait first** is the original rule: the longest wait goes first and ties go to whoever checked in earlier. With an odd number of waiting players and courts that finish together, this can give the earliest arrivals an extra game or two over a night.

You can switch at any time; the change applies to the next recommendation.

**Team-up styles (Game settings).** The **Team-up style** list replaces "Who plays next". *Balanced* and *Longest wait* are the two rules above. The other four styles always decide **who** plays with the balanced-games rule (fewest games first, then longest wait), so everyone still gets the same number of games; they change **how** those players are grouped into teams and courts. When several courts are free at once they are filled together. The explanation under each recommended game says what the style did, for example "Paddle stacking: winners Ana & Ben vs winners Cy & Dee".

- **Random.** A sit-out wheel: nobody plays a second time until every checked-in, available player has played once in the current cycle. Late arrivals join the current cycle as not yet played, so they get in soon. Teammates and opponents are drawn at random each round (repeatable for the same session and round), avoiding your partner from your last game whenever possible.
- **Paddle stacking (winners vs winners).** After games finish, winners play winners and losers play losers; partners from the last game are split up (for example the winners of Court 1 and Court 2 are shuffled into two new teams). Waiting players still get in first. Anyone with no result yet, or who sat out last round, counts as neutral and fills in after the losers. When a court mixes results, the winners are put on opposite teams so they face each other. *One court:* the two winners are split up and each partners a loser. Paddle stacking works best when courts finish at about the same time.
- **Up & Down the River (king of the court).** Court 1 is the top court. Winners move up one court and losers move down one; partners split every round so you play with someone new. Top-court winners stay on the top court. When players are waiting, bottom-court losers are the first to go to the waiting line (among players level on games), and newcomers enter at the bottom court. *One court:* winners stay on (when level on games), partners split, losers rotate out first.
- **Fixed partners.** Under **Locked pairs** pick a **First partner** and **Second partner** and press **Lock pair** ("Ana + Ben always together"); **Unlock** removes a pair. A locked pair plays as a team and takes turns as a unit; everyone else is paired by the balanced rule. If one partner is resting, playing or declined, the other plays unpaired that turn. If keeping every pair together would make the only unpaired player sit out again with fewer games, one pair is split for that game and the explanation says so. In singles, locked pairs do not apply.

In the four grouping styles **Balance by skill** and **Rotate partners** are switched off in the list because the style decides the teams. Declining a turn, resting, unavailable courts, manual override and "court stays open" work the same in every style.

*Coming later (not selectable yet):* Mixed doubles (needs a gender/division field), Skill pools / A–B divisions, Round robin schedule (everyone partners everyone once, printable), Mentor pairing (beginner + advanced), Challenge court (winners stay, max 2 games), Swiss pairing by record.
- Mark a court **unavailable** (for example wet or reserved) and it is skipped until you mark it available again.

## 4. Scoring and undo

When a game is on a court, choose the **First serving team** and press **Start scoring**. Then press **Team A wins rally** or **Team B wins rally** after each rally. One click, tap or Enter/Space press records exactly one rally and you stay on the same screen. The app applies side-out scoring: only the serving team scores, and it shows the server and the called score such as 0-0-2.

- **Undo last point** reverses the most recent entry; press it repeatedly to go further back.
- **Fault by Team A/B** records a fault against that team.
- When a team reaches the target and leads by the required margin, the game shows the winner. Press **Finalize game** to save the result; the players return to the queue and the court frees up.

**Just record the result.** If nobody keeps score rally by rally, each court card also has **Team A won** and **Team B won** buttons. Optionally type the **Final score A** and **Final score B** first (the winner must have the higher score). One press ends the game: the result is saved, the players return to the queue as of that moment, and the court frees up. Wins and losses count in the leaderboards; points only count if you entered the final score, otherwise the game counts as 0-0 for points. This also works after rally scoring has started: the result you tag replaces the rally score.

## 5. The optional timer

Each active game has a timer. Enter a **Timer length (minutes)** (fractions such as 0.5 work) and press **Start timer**. Use **Pause timer**, **Resume timer** and **Reset timer** as needed. When the time is up the timer turns red and says so, but the game is never ended or scored by the timer. You decide when to finalize. Timers are optional and independent of scoring.

## 6. The display window

Press **Open display** in the session room to open a second window meant for a large screen or projector. It shows every court with player names, big scores and who is serving, plus the **Next up** queue. It updates by itself within a second or two and has no buttons or controls, so nobody can change anything from it. Drag it to the second screen and use the system full-screen shortcut. Pressing **Open display** again just brings the same window forward.

## Appearance: light, dark and colour themes

Click **Appearance** (the palette button at the top right of the organizer window).

- **Mode**: *Light*, *Dark* or *System*. System follows your computer's light/dark setting and switches by itself when that changes.
- **Colour theme**: Court Green (default), Ocean, Sunset, Grape, Citrus, Graphite, Rose, Midnight Neon and High Contrast. Each swatch shows a small preview in the current mode. High Contrast is the most readable choice in bright sun or for low vision.

Changes apply instantly and are saved on this computer, so the app opens in the same look next time. The display window follows the same theme automatically within about a second; nothing needs to be touched on the big screen. Every theme keeps text and buttons at accessible contrast in both light and dark. If your computer is set to reduce motion, the score animations, pulses and confetti are switched off.

While you run the night you will also see: a live clock per game, a pulsing **Serving** marker, a **Game point** badge when the serving team can win on the next rally, a small celebration when a game ends, short confirmations in the lower right (game started, result recorded, player added), and coloured initials for each player that stay the same everywhere.

## 7. Reports, export and backup

Choose **Reports and data** on the first screen.

- **Leaderboards** show wins, losses and points for one session or across all sessions.
- **Export** writes CSV files (choose a folder) or one Excel workbook (suggested name `RallyFlow-export-<date>.xlsx`). Export only reads your data.
- **Create backup** saves a single `.pbbackup` file (suggested name `RallyFlow-backup-<date>.pbbackup`) wherever you choose. Do this at the end of every night and keep a copy on a USB drive.
- **Restore** asks for a `.pbbackup` file, checks it, and then asks you to confirm in a system dialog. Your current data is saved to an automatic backup first, then replaced by the backup.

## 8. Awards

Press **Awards** (the trophy button) on the first screen, next to **Reports and data**, or inside a session room next to **Open display**. **Back to session** / **Back to sessions** returns you to where you were.

- **Show awards for:** **This session** (the default inside a session; pick any session from the list, finished ones included) or **All time**.
- **✏️ Club name.** Near the top of the Awards page, press **✏️ Club name** to set your club or group name (for example "CCF Sandoval Pickleball Club", up to 60 characters) and an optional short tagline (up to 80). With a session selected you can also give **this session only** a different name ("Thursday Night Crew"). Press **Save**. The name leads the ceremony (the welcome card reads "CCF Sandoval Pickleball Club proudly presents… The Awards Ceremony"), sits in the header of every title card, the finale and the wrap-up ("Thank you for playing with …"), heads the awards board on the display and the saved image, appears on the Awards page banner, and is printed on every certificate as "Presented by …". RallyFlow stays as a small credit in the corner. Leave the name empty to go back to the session name and the RallyFlow title. The same club name can also be edited under **🎨 Appearance**.
- At the top is the **Player of the Session** (or **All-time Champion** for all time) and a gold, silver and bronze podium. It follows the leaderboard: win %, then wins, then point difference. Players need 3 finalized games in a session (10 overall) to be ranked; until somebody gets there, the podium is marked **provisional** and shows the best records so far.
- **How the podium is drawn.** All three steps are always shown. The official ranking keeps shared places, so two players tied for first are both rank 1 and the next player is rank 3. On the podium, tied players stand together on one step (labelled **Tied for 1st**), and the next players fill the next steps in order: gold, silver, bronze. When a step's official rank differs from the step, a small label says so (for example **Rank 3** on the silver step after a tie for first). With fewer than three players, or a tie that uses everyone, the unused steps are shown empty.
- Below the podium are award cards. An award only shows up when somebody earns it:
  - **Most Wins**: the most games won.
  - **Point Machine**: the best point difference.
  - **Hot Streak**: the most wins in a row (at least 2), in the order the games ended.
  - **Dynamic Duo**: the best doubles pair with at least 2 games together (win %, then wins, then point difference together).
  - **Clutch Player**: the most wins in close games decided by 2 points or fewer.
  - **Iron Player**: played the most games (hidden when everyone played the same number).
  - **Social Butterfly**: teamed up with the most different partners (at least 3).
  - **Rising Star** (all time only): the biggest jump in win rate in a player's latest session compared with their earlier games.
- Only finalized games count. A game finished with **Team A won** / **Team B won** without a final score counts for wins, games played and streaks, but never for Point Machine or Clutch Player. Players still level after the award's own number, then win %, wins and point difference share the award.
- **Show on display** puts the awards ceremony (podium and cards, sized for across the room) on the display window, and opens that window if needed. **Show courts on display** switches it back. Pressing **Open display** in a session also goes back to the courts. The display still has no controls.
- **Save as image** saves the ceremony as a 1920x1080 PNG (`RallyFlow-awards-<session>-<date>.png`) wherever you choose. **Print certificates** saves a PDF (`RallyFlow-certificates-<date>.pdf`) with one landscape certificate per award winner, ready to print.
- **Celebrate** plays the confetti again. If your computer is set to reduce motion, there is no animation or confetti.

### The ceremony: one award at a time

Press **🎬 Start ceremony** to hand out the awards one by one, building to the champion. The organizer window switches to a **host view**: on the left the audience view (exactly what the room sees), on the right your speaker notes.

- **The flow.** A welcome card, then every award in the lineup order, then a wrap-up with all the winners. Each award has three beats:
  1. **Title card:** "And the award for 🔥 Hot Streak goes to…" with how it is earned.
  2. **Suspense:** the nominees (the top candidates from the games) appear and a spotlight sweeps across them, fast and then slowing like a slot machine, over a drumroll. It keeps rolling until you press **Reveal the winner**, so you can build the moment out loud.
  3. **Reveal:** the curtains open, the winner's name lands huge with their number counting up, a one-line story, fireworks and confetti, then "👏 Give it up for …!" and applause.
- **The finale.** When the champion is last (the default), the podium rises third, second, then first (about two seconds apart), and the champion is crowned with the biggest crash and fanfare. All three steps stay up at the end, ties included (see **How the podium is drawn** above).
- **Host notes.** The right-hand panel shows the real winner (keep it secret!), the line to read out, how the award is earned, the nominees, and what comes next. Awards in the lineup that nobody earned tonight are listed on the welcome card so you are not surprised.
- **Controls.** **Next** (also <kbd>Space</kbd>, <kbd>→</kbd> or <kbd>Enter</kbd>) moves title → nominees → reveal → next award. **Back** (<kbd>←</kbd>) steps back. **Skip suspense** (<kbd>S</kbd>) jumps straight to the reveal. **Pause** (<kbd>P</kbd>) freezes the animation and the sound. **Sound on / Muted** (<kbd>M</kbd>). **End ceremony** (<kbd>Esc</kbd>). The round buttons at the top jump to any award and show where you are ("Award 3 of 9").
- **Auto-advance.** Tick **Auto-advance** and choose a **Short**, **Medium** or **Long** suspense (about 4, 7 or 11 seconds); the ceremony then reveals and moves on by itself. You can still press Next, Back or Pause at any time.
- **Sound.** The drumroll, crash, fanfare and applause are made on the computer itself; there are no sound files and nothing is downloaded. Sound starts only when you press Start ceremony and is on by default; mute it with the button or <kbd>M</kbd>.
- **Run on display.** Press **📺 Run on display** to mirror the ceremony on the big screen in step with your host view. The display shows only the audience view, never the secret winner or any controls, and the keyboard stays with you. When you end the ceremony, the display shows the awards board.
- If your computer is set to reduce motion, movements become gentle fades, there is no confetti or fireworks, and the timing (and the suspense) stays the same.

### Edit awards: your own lineup

Press **✏️ Edit awards** to choose which awards are given and in what order. Every change saves straight away and applies to every session.

- **Order.** Drag a row, or use the **↑ ↓** buttons. The order is the ceremony order, from the first award to the last; the champion stays last unless you move it.
- **Show or hide.** Untick **Shown** to leave an award out. Built-in awards can only be hidden, not deleted.
- **Rename.** Change the icon, the title and the description (your speaker notes). **Reset name and settings** goes back to the original. Some library awards have settings too, such as the minimum number of games.
- **Delete** removes an award you added from the library.
- **Restore defaults** shows every built-in award again with its original name and order. Awards you added stay in the lineup.
- **Host picks (people's choice).** Awards such as Best Sportsmanship have no formula: press **Choose winner**, tick the winner (up to 4), optionally tick a few **Nominees** for the drumroll and add a note to read at the reveal. Without nominees, the ceremony shows a few random roster names for drama, and the host view makes clear who really won. You can also pick the winner during the ceremony: the host view asks for it before the reveal. Winners are kept per session (and separately for all time).

### The award library

Press **📚 Award library** to browse more awards. Search by name, or filter by **Performance**, **Partnership**, **Grit & Drama**, **Fun**, **Community** and **People's Choice**. Each card shows who would win right now, or why it cannot be given yet (for example "Needs rally-by-rally scoring"). **Add to lineup** puts it just before the champion.

**Recommended for this session** at the top suggests the awards that make the best story tonight, with a live preview: an 11-0 game suggests **Shutout King**, rally scoring suggests **Serve Machine** and **Comeback Kid**, first-timers suggest **Newcomer of the Night**, and so on.

Computed awards (worked out from finalized games; results without a score never count for score-based awards; ties are shared like the built-in awards):

- **Performance:** Shutout King (most wins where the other side scored 0), Undefeated (won every game; minimum games, default 3), Giant Killer (beat the leaderboard leader most often), Steady Hands (steadiest point margin; minimum scored games, default 3), Bounce-Back (most wins straight after a loss), Serve Machine (most points won on their own serve), Side-Out Specialist (most return rallies that took the serve back).
- **Partnership:** Iron Partners (pair with the most games together), Lucky Charm (partners win more often with them than without; minimum doubles games, default 3), The Mixer (most different opponents; minimum 4).
- **Grit & Drama:** Comeback Kid (won after trailing; minimum deficit, default 5), On a Roll (longest run of unanswered points, at least 4), The Closer (served the game-winning point most often), Nail-Biter (most games decided by 2 points or fewer), Marathon Match (all four players of the longest game, by rallies or by time).
- **Fun:** Rally Rhythm (most rallies played), Speed Demon (quickest win of at least a minute), Last One Standing (played in the final game; session only).
- **Community:** Early Bird (first to check in; session only).

Serve Machine, Side-Out Specialist, Comeback Kid, On a Roll, The Closer and Rally Rhythm need games scored rally by rally (**Start scoring**); a game finished with just the result does not count for them.

Host picks: Newcomer of the Night, Best Sportsmanship, Spirit of the Night, Loudest Cheer, Most Improved, Best Dressed, Paddle Personality, Kitchen Commander, and Host's Pick (rename it to anything you like).

## 9. Finish the night

Press **Finish session**. The results stay available for reports and export.

## 10. Working offline

There is no sign-in, no sync and no update check. The app blocks every network request, so Wi-Fi can be off the whole time. If something looks wrong, the data folder and automatic backups are described in `INSTALL.md`.

## About RallyFlow

**RallyFlow › About RallyFlow** (macOS) or **Help › About RallyFlow** (Windows) shows the version. **Help › Third-Party Notices** opens the licences of the open-source components RallyFlow is built with. Backups made before the rename (by "Pickleball Open Play") restore normally, and the app keeps using the same data folder, so your existing sessions carry over.
