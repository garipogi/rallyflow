import type { TeamUpStyle } from '../core/rotation';

/** D15: the court selector offers 1 to 4 courts; 1 is the explicit single-court opt-in. */
export const COURT_CHOICES: readonly { value: number; label: string }[] = [
  { value: 1, label: '1 court (small group)' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 4, label: '4' },
];

/** D16 team-up styles, in the order the selectors list them. */
export const TEAM_UP_CHOICES: readonly { value: TeamUpStyle; label: string; hint: string }[] = [
  {
    value: 'balanced',
    label: 'Balanced (recommended)',
    hint: 'Players with the fewest games go first, then the longest wait; late arrivals start level with the regulars and partners rotate.',
  },
  {
    value: 'longest_wait',
    label: 'Longest wait',
    hint: 'Longest wait goes first; ties go to whoever checked in earlier, which can give early arrivals extra games.',
  },
  {
    value: 'random',
    label: 'Random',
    hint: 'A sit-out wheel: nobody plays twice before every checked-in player has played once this cycle (late arrivals join as not yet played). Teammates and opponents are drawn at random each round, avoiding your last partner.',
  },
  {
    value: 'paddle_stack',
    label: 'Paddle stacking (winners vs winners)',
    hint: 'Winners play winners and losers play losers; partners are split up. Waiting players get in first and count as neutral, filling in after the losers. Works best when courts finish together.',
  },
  {
    value: 'river',
    label: 'Up & Down the River (king of the court)',
    hint: 'Court 1 is the top court. Winners move up a court, losers move down, partners split each round; top-court winners stay and bottom-court losers go to the waiting line first when players are waiting.',
  },
  {
    value: 'fixed_partners',
    label: 'Fixed partners',
    hint: 'Lock pairs below: a locked pair always plays together and takes turns as a unit; everyone else is paired by the balanced rule.',
  },
];

/** Recommended future styles, shown as information only (not selectable). */
export const FUTURE_TEAM_UPS: readonly string[] = [
  'Mixed doubles (needs a gender/division field)',
  'Skill pools / A–B divisions',
  'Round robin schedule (everyone partners everyone once, printable)',
  'Mentor pairing (beginner + advanced)',
  'Challenge court (winners stay, max 2 games)',
  'Swiss pairing by record',
];
