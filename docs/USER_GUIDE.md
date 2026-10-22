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

**Team-up styles (Game settings and the new-session form).** The **Team-up style** list replaces "Who plays next" and offers twelve styles. *Balanced* and *Longest wait* are the two rules above. In every other style **who** plays is still decided by the balanced-games rule (fewest games first, then longest wait), so everyone gets the same number of games; the style changes **how** those players are grouped into teams and courts. Two styles have a small, documented exception: *Challenge court* (winners stay on, up to the limit you set) and *Round robin* (follows its schedule; byes rotate fairly). *Skill pools* keeps games level within each pool. When several courts are free at once they are filled together, and the explanation under each recommended game says what the style did.

**The explanation window.** Whenever you pick a style from the list, a window opens first and explains it: a one-line summary, *How it works*, a small diagram, *Best for*, *What you need* (checked against your roster: for example "2 of 14 players have no gender set" with a **Set genders** button that opens Player details, or **Set skill levels**), a *Fairness* note and a short example using your players' names. Press **Use this style** to switch, or **Cancel** (or Esc) to keep the style you had. **ⓘ About this style** next to the list reopens the window for the current style without changing anything. The window works with the keyboard (Tab stays inside it, Esc closes it, focus returns to where you were) and with screen readers.

The twelve styles, exactly as the window explains them:

#### ⚖️ Balanced

Players with the fewest games go first, so everyone plays the same number of games and partners keep changing.

*How it works:*

- Fewest games played goes first; ties go to the longest wait, then a draw that changes every round.
- Late arrivals start level with the regulars (a catch-up credit), so they do not play many games in a row.
- The four chosen players are paired to avoid repeat partners, then repeat opponents.

*Best for:* Any group size; the recommended default for social open play.  
*What you need:* Nothing extra: works with 1 to 4 courts and any roster.  
*Fairness:* Everyone gets the same number of games (within one): fewest games first, then the longest wait. The style only decides who partners whom.  
*Example:* Ana, Ben, Cy and Dee have 2 games and Eve has 3, so Eve waits a turn and the other four play.

#### ⏳ Longest wait

Whoever has waited longest plays next, the classic paddle-rack order.

*How it works:*

- The longest wait goes first.
- Ties go to whoever checked in earlier.
- Optional skill balancing and partner rotation (Game settings) adjust the teams, never who plays.

*Best for:* Groups used to a paddle rack who want strict first-come, first-served.  
*What you need:* Nothing extra.  
*Fairness:* Fair by waiting time, not by games: with an odd number of waiting players, early arrivals can end the night a game or two ahead.  
*Example:* Ana has waited 14 min, Ben 12, Cy 9 and Dee 7: those four play next.

#### 🎲 Random

A sit-out wheel decides who plays and teammates and opponents are drawn at random.

*How it works:*

- Nobody plays twice before every checked-in player has played once this cycle.
- Late arrivals join the current cycle as not played yet, so they get in soon.
- Teams are a random draw each round that avoids your partner from your last game.

*Best for:* Mixers and casual nights where variety matters more than matchups.  
*What you need:* Nothing extra.  
*Fairness:* Everyone gets the same number of games (within one): fewest games first, then the longest wait. The style only decides who partners whom.  
*Example:* This round's draw: Ana & Cy vs Ben & Dee. Next round is drawn again.

#### 🏆 Paddle stacking

Winners play winners and losers play losers, with partners split up every game.

*How it works:*

- After games finish, the winners are grouped together and so are the losers.
- Partners from the last game are split, so winners face winners on opposite teams.
- Players who sat out or have no result yet count as neutral and fill in after the losers.
- One court: the two winners split up and each partners a loser.

*Best for:* Competitive groups of 8 or more on 2 or more courts that finish games together.  
*What you need:* 2 or more courts recommended. Tag each result (Team A won / Team B won).  
*Fairness:* Everyone gets the same number of games (within one): fewest games first, then the longest wait. The style only decides who partners whom.  
*Example:* Ana & Ben won on Court 1 and Cy & Dee on Court 2: next it is Ana & Cy vs Ben & Dee, while Eve, Fay, Gus and Hal (the losers) play each other.

#### 🌊 Up & Down the River

Winners move up a court and losers move down, so the top court ends up with the hottest players.

*How it works:*

- Court 1 is the top court; winners move up one court, losers down one.
- Top-court winners stay; newcomers enter at the bottom court.
- Partners split every round so you play with someone new.
- When players are waiting, bottom-court losers go to the waiting line first.

*Best for:* Ladder nights with 2 to 4 courts and a competitive crowd.  
*What you need:* 2 or more courts recommended (1 court: winners stay on). Tag each result.  
*Fairness:* Everyone gets the same number of games (within one): fewest games first, then the longest wait. The style only decides who partners whom.  
*Example:* Ana & Ben win on Court 2: both move up to Court 1 with new partners; Cy & Dee lose and move down to Court 3.

#### 🤝 Fixed partners

Locked pairs always play together and take turns as a unit; everyone else rotates.

*How it works:*

- Lock pairs in Game settings (for example a couple or a doubles team).
- A locked pair plays together and is as due as its later member.
- Unpaired players are teamed by the balanced rule.
- If a partner is resting, playing or declined, the other plays unpaired that turn.

*Best for:* Groups with couples or practice partners who want to stay together.  
*What you need:* Lock at least one pair after choosing this style.  
*Fairness:* Fewest games first by pair; a pair is split for one game only when keeping it together would make someone with fewer games sit out again.  
*Example:* Ana + Ben are locked: they play as a team, here against Cy & Dee.

#### 👫 Mixed doubles

Every team is one man and one woman whenever the players due to play allow it.

*How it works:*

- Who plays is still fewest games first, then the longest wait.
- Each court takes two men and two women while they last, and each team is one of each.
- To make teams mixed, a player may swap with one of the next two waiting players on the same game count.
- Short of one gender? Those players team up together and the explanation says so; players with no gender set fill either side.

*Best for:* Mixed groups with a similar number of men and women.  
*What you need:* Set Male / Female for players in the roster (Edit or Player details).  
*Fairness:* Everyone gets the same number of games (within one). The only swap allowed is between players on the same game count, so nobody with fewer games is ever skipped.  
*Example:* Ana (F) & Ben (M) vs Cy (M) & Dee (F): both teams are mixed.

#### 🏅 Skill pools

Players are split into pools (A advanced, B developing, optional C) and each court plays within one pool.

*How it works:*

- Pools come from each player’s pool in the roster, or from skill-level cutoffs you set.
- Courts belong to a pool (auto: by pool size, pool A on the top courts) or alternate between pools.
- Within a pool it is fewest games first, then the longest wait.
- A pool that cannot fill its court leaves it open with a reason, or borrows players if you allow it.

*Best for:* Bigger groups (12+) with clearly different levels and 2 or more courts.  
*What you need:* Set skill levels (or a pool) for players in the roster. 2 or more courts recommended (1 court: pools take turns).  
*Fairness:* Games stay level within each pool (fewest games first inside the pool). Pools of different sizes can drift apart; borrowing evens them out.  
*Example:* Court 1 (pool A): Ana & Ben vs Cy & Dee. Court 2 (pool B): Eve & Fay vs Gus & Hal.

#### 🔄 Round robin

A printable schedule where everyone partners everyone as evenly as possible, round by round.

*How it works:*

- Generate the schedule for the players and courts here; print it or save it as a PDF.
- Each round lists the games per court and who sits out (byes rotate fairly).
- Start this game follows the schedule; a missing player is replaced by the most-due waiting player.
- If the roster changes, regenerate to include new arrivals (the app reminds you).

*Best for:* Leagues, ladders and socials of 5 to 20 players who like a plan they can see.  
*What you need:* Check players in first, then generate the schedule (Game settings).  
*Fairness:* Follows the schedule instead of the live queue; byes rotate so scheduled games stay within one of each other. When the schedule ends, games follow the Balanced rule.  
*Example:* Round 1: Court 1 Ana & Ben vs Cy & Dee; bye: Eve. Round 2 mixes everyone again.

#### 🎓 Mentor pairing

Each team pairs a higher-rated player with a lower-rated one, so newer players learn on court.

*How it works:*

- Who plays is still fewest games first, then the longest wait.
- Among them, the strongest partners the weakest, the next strongest the next weakest, and so on.
- Teams with similar combined levels face each other.
- Players without a skill level count as the middle level and show as unrated.

*Best for:* Clinics, beginner nights and groups welcoming new players.  
*What you need:* Set skill levels for players in the roster.  
*Fairness:* Everyone gets the same number of games (within one): fewest games first, then the longest wait. The style only decides who partners whom.  
*Example:* Mentor Eve (4.5) with Fay (2.0) vs mentor Ana (4.0) with Ben (2.5).

#### 👑 Challenge court

Winners hold the challenge court and face new challengers, up to a limit, then sit.

*How it works:*

- Court 1 is the challenge court (or every court, if you choose).
- Winners stay on for up to 2 games in a row (1 to 3, your choice), then sit out a turn.
- Challengers come from the front of the fair queue.
- The other courts rotate normally; a holder who is resting or declines breaks up the team.

*Best for:* Competitive groups who enjoy defending a court; any number of courts.  
*What you need:* Tag each result (Team A won / Team B won).  
*Fairness:* One bounded exception: holders keep playing even with more games, for at most the stay-on limit; everyone else is fewest games first, so the gap stays small.  
*Example:* Ana & Ben won on Court 1 and stay on (stay 1 of 2) against challengers Cy & Dee.

#### 📊 Swiss pairing

Players with similar records tonight play each other, avoiding rematches.

*How it works:*

- Who plays is still fewest games first, then the longest wait.
- Those players are ranked by tonight’s record: win %, then point difference.
- Neighbours in that ranking share a court; a swap between courts avoids a rematch when possible.
- Players with no results yet count as 0–0 and slot in the middle.

*Best for:* Groups of 8+ who want close, competitive games as the night goes on.  
*What you need:* Tag results, ideally with the final score for point difference.  
*Fairness:* Everyone gets the same number of games (within one): fewest games first, then the longest wait. The style only decides who partners whom.  
*Example:* Swiss: Ana (3–1) & Dee (2–2) vs Ben (3–1) & Cy (2–2).

**Style settings.** Some styles add a small panel under the list:

- *Fixed partners:* under **Locked pairs** pick a **First partner** and **Second partner** and press **Lock pair**; **Unlock** removes a pair. In singles, locked pairs do not apply.
- *Mixed doubles:* shows how many checked-in players are women, men or not set, with **Set genders**. Players with no gender fill in on either side. If there are not enough of one gender among the players due to play, those players team up together and the explanation says so; a player at the cut may swap with one of the next two waiting players only when both have the same number of games. Singles has no teams, so opponents simply rotate.
- *Skill pools:* **Pools from** (each player's pool from the roster, else skill level; or skill level only), **Pool A from skill** (default 3.5), **Use a third pool (C)** with **Pool B from skill**, **Courts** (*Auto*: split by how many players each pool has, pool A on the top courts; *Alternate*: the pool whose next player is most due takes each free court; or choose a pool per court) and **When a pool is short** (*Keep its court open*, the default, with the reason shown; or *Borrow players from another pool*, taking the most-due players). Players with neither a pool nor a skill level go in pool B. With 1 court (or fewer courts than pools) the pools take turns.
- *Round robin:* **Generate schedule** makes it for the checked-in players and the courts that are available (leave **Rounds** empty for one full cycle, or choose 1 to 40). **View and print schedule** shows rounds by court with who sits out, the current round and ✓ for games already started; **Print** or **Save as PDF** gives a clean page. **Start this game** follows the schedule; a free court waits while the current round is still being played, so rounds stay together. A scheduled player who is resting, playing elsewhere or declined is replaced by the most-due waiting player who is not in that round, and the explanation says so; a round that cannot be played at all is skipped. Players who check in after the schedule was made are listed with a reminder to **Regenerate schedule** (the new schedule starts again at round 1). When the schedule is finished, games follow the Balanced rule until you generate another.
- *Mentor pairing:* shows how many checked-in players have a skill level, with **Set skill levels**. Unrated players count as the middle level (the median of the rated players present). In singles a higher-rated player plays a lower-rated one.
- *Challenge court:* **Winners stay on for up to** 1, 2 (default) or 3 games in a row, and **Challenge court**: *Court 1 only* (default) or *Every court*. After the limit the winners sit out a turn (they only play if a court would otherwise stay open). If one of the winners is resting or declines, the team does not stay on.
- *Swiss pairing:* records count tagged results this session (win %, then point difference when you entered the final score). Players with no results are 0–0.

**Player details: skill level, gender and pool.** When adding a player you can enter an optional **Skill** (1 to 8) and **Gender**. **Edit** on a player's row now also changes skill level, gender and pool. **Player details (skill, gender, pool)** above the roster opens a quick table for everyone at once; changes save as you go. These details belong to the player, so they carry over to future sessions.

Declining a turn, resting, unavailable courts, manual override (with a reason, recorded in the log) and "court stays open" work the same in every style, and every assignment in the rotation log records the style used.
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
