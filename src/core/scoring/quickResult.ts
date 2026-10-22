/**
 * Quick results: finishing a game without rally scoring. Pure helpers shared by the court card,
 * the data layer and the tests (no I/O).
 *
 *  - The session's scoring mode decides what the court card offers:
 *      rally        rally-by-rally scoring (the original flow; also the default when nothing is stored)
 *      final_score  type (or tap) the final score, the winner is inferred
 *      winner_only  one tap on the team that won; the game is stored 0-0 (score-less)
 *  - checkQuickScore turns what the organizer typed into a winner, or a friendly message.
 *  - finishWarning is a gentle hint when a score is not a finished game under the session's target
 *    and win-by. Organizers often play short or timed games, so it never blocks saving.
 */

import type { TeamId } from './index';

export type ScoreEntryMode = 'rally' | 'final_score' | 'winner_only';

export const SCORE_ENTRY_MODES: readonly ScoreEntryMode[] = ['rally', 'final_score', 'winner_only'];

/** Absent from the stored settings = rally scoring, exactly as before scoring modes existed. */
export const DEFAULT_SCORE_ENTRY: ScoreEntryMode = 'rally';

/** The highest score a quick result accepts; anything above is almost certainly a typo. */
export const MAX_QUICK_SCORE = 99;

export const isScoreEntryMode = (value: unknown): value is ScoreEntryMode =>
  typeof value === 'string' && (SCORE_ENTRY_MODES as readonly string[]).includes(value);

/** The mode in effect for stored settings; unknown or missing values fall back to rally scoring. */
export function scoreEntryOf(settings: { scoreEntry?: unknown } | null | undefined): ScoreEntryMode {
  return settings && isScoreEntryMode(settings.scoreEntry) ? settings.scoreEntry : DEFAULT_SCORE_ENTRY;
}

/** Whether the court card should show the quick-result card instead of rally scoring. */
export const isQuickMode = (mode: ScoreEntryMode): boolean => mode !== 'rally';

export interface GameRules {
  targetScore: number;
  winBy: number;
}

export type QuickScoreCheck =
  | { kind: 'empty' }
  | { kind: 'incomplete'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'tie'; message: string }
  | { kind: 'ok'; winner: TeamId; scoreA: number; scoreB: number; warning: string | null };

/** "11–7": winner's score first, with an en dash. */
export const scoreLine = (high: number, low: number): string => `${high}–${low}`;

/** Parses one typed score: whole numbers 0..MAX_QUICK_SCORE only. */
export function parseQuickScore(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n <= MAX_QUICK_SCORE ? n : null;
}

/**
 * A gentle hint when the score is not a finished game under these rules, else null.
 * Finished = the winner reached the target with the required lead, and the game stopped there
 * (exactly the target, or past it only as far as the lead required in a deuce game).
 */
export function finishWarning(winnerScore: number, loserScore: number, rules: GameRules): string | null {
  const { targetScore: target, winBy } = rules;
  const line = scoreLine(winnerScore, loserScore);
  if (winnerScore < target) return `${line} is below the target of ${target}. Save anyway?`;
  if (winnerScore - loserScore < winBy) return `${line} isn't a finished game at win-by-${winBy}. Save anyway?`;
  if (winnerScore > target && winnerScore - loserScore > winBy) {
    return `${line} goes past ${target} by more than a deuce game would. Save anyway?`;
  }
  return null;
}

/**
 * Turns the two typed scores into a result. Empty + empty is "empty" (no score given); one empty is
 * "incomplete"; non-numbers are "invalid"; equal scores are a "tie". Otherwise the higher score wins.
 */
export function checkQuickScore(textA: string, textB: string, rules: GameRules): QuickScoreCheck {
  const a = textA.trim();
  const b = textB.trim();
  if (a === '' && b === '') return { kind: 'empty' };
  if (a === '' || b === '') return { kind: 'incomplete', message: 'Enter both scores to save the result.' };
  const scoreA = parseQuickScore(a);
  const scoreB = parseQuickScore(b);
  if (scoreA === null || scoreB === null) {
    return { kind: 'invalid', message: `Scores are whole numbers from 0 to ${MAX_QUICK_SCORE}.` };
  }
  if (scoreA === scoreB) {
    return { kind: 'tie', message: `It's tied ${scoreLine(scoreA, scoreB)}. A game needs a winner: fix a score, or tap the team that won.` };
  }
  const winner: TeamId = scoreA > scoreB ? 'A' : 'B';
  const high = Math.max(scoreA, scoreB);
  const low = Math.min(scoreA, scoreB);
  return { kind: 'ok', winner, scoreA, scoreB, warning: finishWarning(high, low, rules) };
}

export interface QuickChip {
  /** The winning team's score. */
  high: number;
  /** The losing team's score. */
  low: number;
}

/**
 * Common finishes for the target: a close game first, then wider margins. Target 11 gives
 * 11–9, 11–7, 11–5, 11–3; 15 gives 15–13, 15–10, 15–7, 15–4; 21 gives 21–19, 21–13, 21–9, 21–6.
 */
export function quickChips(rules: GameRules): QuickChip[] {
  const { targetScore: target, winBy } = rules;
  const closest = target - Math.max(2, winBy);
  const raw = [closest, Math.round(target * 0.64), Math.round(target * 0.45), Math.round(target * 0.27)];
  const lows: number[] = [];
  for (const low of raw) {
    if (low >= 0 && target - low >= winBy && !lows.includes(low)) lows.push(low);
  }
  return lows.map((low) => ({ high: target, low }));
}

/** The two team scores for a chip once the winner is known. */
export function chipScores(chip: QuickChip, winner: TeamId): { scoreA: number; scoreB: number } {
  return winner === 'A' ? { scoreA: chip.high, scoreB: chip.low } : { scoreA: chip.low, scoreB: chip.high };
}

/** "Tofu & Tabi 11–7" (winner's score first); just the name when the result has no score. */
export function resultLabel(winnerName: string, winner: TeamId, scoreA: number | null, scoreB: number | null): string {
  if (scoreA === null || scoreB === null) return winnerName;
  const high = winner === 'A' ? scoreA : scoreB;
  const low = winner === 'A' ? scoreB : scoreA;
  return `${winnerName} ${scoreLine(high, low)}`;
}

/**
 * When the organizer taps a team as the winner after typing valid scores, the higher score goes to
 * that team (a typed 7 and 11 with "Team A won" becomes 11–7 for Team A). Null when nothing to fix.
 */
export function alignScoresToWinner(scoreA: number, scoreB: number, winner: TeamId): { scoreA: number; scoreB: number } | null {
  if (scoreA === scoreB) return null;
  const winnerAhead = winner === 'A' ? scoreA > scoreB : scoreB > scoreA;
  return winnerAhead ? null : { scoreA: scoreB, scoreB: scoreA };
}

/** Short names and explanations for the scoring-mode selectors and docs/USER_GUIDE.md. */
export interface ScoreEntryGuide {
  value: ScoreEntryMode;
  label: string;
  icon: string;
  summary: string;
  how: readonly string[];
  bestFor: string;
}

export const SCORE_ENTRY_GUIDES: readonly ScoreEntryGuide[] = [
  {
    value: 'rally',
    label: 'Rally scoring',
    icon: '🎾',
    summary: 'Score every rally on the court card: the app calls the score, tracks the server and unlocks Finalize at game point.',
    how: [
      'Choose the first serving team, press Start scoring, then tap who won each rally.',
      'The display shows big live scores and the called score.',
      'Skip scoring — just record the result is still there for a game you did not score.',
    ],
    bestFor: 'Leagues, ladders and anyone who wants every award, including rally awards like Serve Machine.',
  },
  {
    value: 'final_score',
    label: 'Final score only',
    icon: '✍️',
    summary: 'Type the final score when the game ends (or tap a common finish like 11–7) and the winner is worked out for you.',
    how: [
      'Each court shows the two score boxes, quick finishes and the two teams by name.',
      'The leading team lights up as you type; Save result names the winner and the score.',
      'Points still count, so Point Machine and the close-game awards work.',
    ],
    bestFor: 'Busy open play where players call their own score and tell you the result.',
  },
  {
    value: 'winner_only',
    label: 'Winner only',
    icon: '🏆',
    summary: 'One tap on the team that won. No scores at all.',
    how: [
      'Each court shows two big buttons with the team names.',
      'Games count for wins, games played and streaks; they are stored 0-0, so point awards are skipped.',
      'Undo stays available for a few seconds after every result.',
    ],
    bestFor: 'Social nights, timed games and beginners, when nobody wants to keep score.',
  },
];

export function scoreEntryGuide(mode: ScoreEntryMode): ScoreEntryGuide {
  return SCORE_ENTRY_GUIDES.find((g) => g.value === mode) ?? (SCORE_ENTRY_GUIDES[0] as ScoreEntryGuide);
}
