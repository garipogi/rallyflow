import { TEAM_UP_STYLES, type TeamUpStyle } from '../core/rotation';

/** D15: the court selector offers 1 to 4 courts; 1 is the explicit single-court opt-in. */
export const COURT_CHOICES: readonly { value: number; label: string }[] = [
  { value: 1, label: '1 court (small group)' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 4, label: '4' },
];

/** What a style needs from the roster or the session; the explanation window checks these live. */
export type GuideRequirement = 'genders' | 'skills' | 'courts2' | 'pairs' | 'results' | 'schedule';

export interface GuideNeed {
  requirement: GuideRequirement;
  text: string;
}

/** Which small illustration the explanation window draws. */
export type GuideDiagram =
  | 'balanced'
  | 'wait'
  | 'random'
  | 'stack'
  | 'river'
  | 'pairs'
  | 'mixed'
  | 'pools'
  | 'roundrobin'
  | 'mentor'
  | 'challenge'
  | 'swiss';

/**
 * D16/D17 team-up guide: the one source for the style selectors, the hint under them, the
 * explanation window and docs/USER_GUIDE.md ("Team-up styles").
 */
export interface TeamUpGuide {
  value: TeamUpStyle;
  /** Text in the selector. */
  label: string;
  /** Dialog title. */
  title: string;
  icon: string;
  /** One sentence. */
  summary: string;
  /** "How it works": 3-5 short bullets. */
  how: readonly string[];
  diagram: GuideDiagram;
  bestFor: string;
  needs: readonly GuideNeed[];
  /** Who plays and any bounded exception to "everyone gets equal games". */
  fairness: string;
  /** Short hint shown under the selector. */
  hint: string;
  /** A tiny example; uses the roster's players when there are enough, else sample players. */
  example: (players: readonly ExamplePlayer[]) => string;
}

/** A player for the example line: name plus the profile facts some styles use. */
export interface ExamplePlayer {
  name: string;
  gender?: 'male' | 'female' | null;
  skill?: number | null;
}

const SAMPLE: readonly ExamplePlayer[] = [
  { name: 'Ana', gender: 'female', skill: 4 },
  { name: 'Ben', gender: 'male', skill: 2.5 },
  { name: 'Cy', gender: 'male', skill: 3.5 },
  { name: 'Dee', gender: 'female', skill: 3 },
  { name: 'Eve', gender: 'female', skill: 4.5 },
  { name: 'Fay', gender: 'female', skill: 2 },
  { name: 'Gus', gender: 'male', skill: 4 },
  { name: 'Hal', gender: 'male', skill: 3 },
];

/** Eight names: the roster's players when there are at least eight, otherwise sample names. */
function eight(players: readonly ExamplePlayer[]): string[] {
  return (players.length >= 8 ? players : SAMPLE).slice(0, 8).map((p) => p.name);
}

/** Two women and two men for the mixed doubles example (roster first, else samples). */
function mixedFour(players: readonly ExamplePlayer[]): [string, string, string, string] {
  const pick = (list: readonly ExamplePlayer[]) => ({
    f: list.filter((p) => p.gender === 'female').map((p) => p.name),
    m: list.filter((p) => p.gender === 'male').map((p) => p.name),
  });
  const own = pick(players);
  const use = own.f.length >= 2 && own.m.length >= 2 ? own : pick(SAMPLE);
  return [use.f[0] as string, use.m[0] as string, use.m[1] as string, use.f[1] as string];
}

/** Two mentors and two learners with skill levels (roster first, else samples). */
function mentorFour(players: readonly ExamplePlayer[]): { name: string; skill: number }[] {
  const rated = (list: readonly ExamplePlayer[]) =>
    list.filter((p): p is ExamplePlayer & { skill: number } => typeof p.skill === 'number').sort((a, b) => b.skill - a.skill);
  let list = rated(players);
  if (list.length < 4 || (list[0] as { skill: number }).skill === (list[list.length - 1] as { skill: number }).skill) list = rated(SAMPLE);
  const top = list.slice(0, 2);
  const bottom = list.slice(-2).reverse();
  return [top[0], bottom[0], top[1], bottom[1]].map((p) => ({ name: (p as ExamplePlayer).name, skill: (p as { skill: number }).skill }));
}

const lvl = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));

const BALANCED_FAIRNESS = 'Everyone gets the same number of games (within one): fewest games first, then the longest wait. The style only decides who partners whom.';

export const TEAM_UP_GUIDE: Readonly<Record<TeamUpStyle, TeamUpGuide>> = {
  balanced: {
    value: 'balanced',
    label: 'Balanced (recommended)',
    title: 'Balanced',
    icon: '⚖️',
    summary: 'Players with the fewest games go first, so everyone plays the same number of games and partners keep changing.',
    how: [
      'Fewest games played goes first; ties go to the longest wait, then a draw that changes every round.',
      'Late arrivals start level with the regulars (a catch-up credit), so they do not play many games in a row.',
      'The four chosen players are paired to avoid repeat partners, then repeat opponents.',
    ],
    diagram: 'balanced',
    bestFor: 'Any group size; the recommended default for social open play.',
    needs: [{ requirement: 'courts2', text: 'Nothing extra: works with 1 to 4 courts and any roster.' }],
    fairness: BALANCED_FAIRNESS,
    hint: 'Players with the fewest games go first, then the longest wait; late arrivals start level with the regulars and partners rotate.',
    example: (players) => {
      const [a, b, c, d, e] = eight(players);
      return `${a}, ${b}, ${c} and ${d} have 2 games and ${e} has 3, so ${e} waits a turn and the other four play.`;
    },
  },
  longest_wait: {
    value: 'longest_wait',
    label: 'Longest wait',
    title: 'Longest wait',
    icon: '⏳',
    summary: 'Whoever has waited longest plays next, the classic paddle-rack order.',
    how: [
      'The longest wait goes first.',
      'Ties go to whoever checked in earlier.',
      'Optional skill balancing and partner rotation (Game settings) adjust the teams, never who plays.',
    ],
    diagram: 'wait',
    bestFor: 'Groups used to a paddle rack who want strict first-come, first-served.',
    needs: [{ requirement: 'courts2', text: 'Nothing extra.' }],
    fairness: 'Fair by waiting time, not by games: with an odd number of waiting players, early arrivals can end the night a game or two ahead.',
    hint: 'Longest wait goes first; ties go to whoever checked in earlier, which can give early arrivals extra games.',
    example: (players) => {
      const [a, b, c, d] = eight(players);
      return `${a} has waited 14 min, ${b} 12, ${c} 9 and ${d} 7: those four play next.`;
    },
  },
  random: {
    value: 'random',
    label: 'Random',
    title: 'Random',
    icon: '🎲',
    summary: 'A sit-out wheel decides who plays and teammates and opponents are drawn at random.',
    how: [
      'Nobody plays twice before every checked-in player has played once this cycle.',
      'Late arrivals join the current cycle as not played yet, so they get in soon.',
      'Teams are a random draw each round that avoids your partner from your last game.',
    ],
    diagram: 'random',
    bestFor: 'Mixers and casual nights where variety matters more than matchups.',
    needs: [{ requirement: 'courts2', text: 'Nothing extra.' }],
    fairness: BALANCED_FAIRNESS,
    hint: 'A sit-out wheel: nobody plays twice before every checked-in player has played once this cycle (late arrivals join as not yet played). Teammates and opponents are drawn at random each round, avoiding your last partner.',
    example: (players) => {
      const [a, b, c, d] = eight(players);
      return `This round's draw: ${a} & ${c} vs ${b} & ${d}. Next round is drawn again.`;
    },
  },
  paddle_stack: {
    value: 'paddle_stack',
    label: 'Paddle stacking (winners vs winners)',
    title: 'Paddle stacking',
    icon: '🏆',
    summary: 'Winners play winners and losers play losers, with partners split up every game.',
    how: [
      'After games finish, the winners are grouped together and so are the losers.',
      'Partners from the last game are split, so winners face winners on opposite teams.',
      'Players who sat out or have no result yet count as neutral and fill in after the losers.',
      'One court: the two winners split up and each partners a loser.',
    ],
    diagram: 'stack',
    bestFor: 'Competitive groups of 8 or more on 2 or more courts that finish games together.',
    needs: [
      { requirement: 'courts2', text: '2 or more courts recommended.' },
      { requirement: 'results', text: 'Tag each result (Team A won / Team B won).' },
    ],
    fairness: BALANCED_FAIRNESS,
    hint: 'Winners play winners and losers play losers; partners are split up. Waiting players get in first and count as neutral, filling in after the losers. Works best when courts finish together.',
    example: (players) => {
      const [a, b, c, d, e, f, g, h] = eight(players);
      return `${a} & ${b} won on Court 1 and ${c} & ${d} on Court 2: next it is ${a} & ${c} vs ${b} & ${d}, while ${e}, ${f}, ${g} and ${h} (the losers) play each other.`;
    },
  },
  river: {
    value: 'river',
    label: 'Up & Down the River (king of the court)',
    title: 'Up & Down the River',
    icon: '🌊',
    summary: 'Winners move up a court and losers move down, so the top court ends up with the hottest players.',
    how: [
      'Court 1 is the top court; winners move up one court, losers down one.',
      'Top-court winners stay; newcomers enter at the bottom court.',
      'Partners split every round so you play with someone new.',
      'When players are waiting, bottom-court losers go to the waiting line first.',
    ],
    diagram: 'river',
    bestFor: 'Ladder nights with 2 to 4 courts and a competitive crowd.',
    needs: [
      { requirement: 'courts2', text: '2 or more courts recommended (1 court: winners stay on).' },
      { requirement: 'results', text: 'Tag each result.' },
    ],
    fairness: BALANCED_FAIRNESS,
    hint: 'Court 1 is the top court. Winners move up a court, losers move down, partners split each round; top-court winners stay and bottom-court losers go to the waiting line first when players are waiting.',
    example: (players) => {
      const [a, b, c, d] = eight(players);
      return `${a} & ${b} win on Court 2: both move up to Court 1 with new partners; ${c} & ${d} lose and move down to Court 3.`;
    },
  },
  fixed_partners: {
    value: 'fixed_partners',
    label: 'Fixed partners',
    title: 'Fixed partners',
    icon: '🤝',
    summary: 'Locked pairs always play together and take turns as a unit; everyone else rotates.',
    how: [
      'Lock pairs in Game settings (for example a couple or a doubles team).',
      'A locked pair plays together and is as due as its later member.',
      'Unpaired players are teamed by the balanced rule.',
      'If a partner is resting, playing or declined, the other plays unpaired that turn.',
    ],
    diagram: 'pairs',
    bestFor: 'Groups with couples or practice partners who want to stay together.',
    needs: [{ requirement: 'pairs', text: 'Lock at least one pair after choosing this style.' }],
    fairness: 'Fewest games first by pair; a pair is split for one game only when keeping it together would make someone with fewer games sit out again.',
    hint: 'Lock pairs below: a locked pair always plays together and takes turns as a unit; everyone else is paired by the balanced rule.',
    example: (players) => {
      const [a, b, c, d] = eight(players);
      return `${a} + ${b} are locked: they play as a team, here against ${c} & ${d}.`;
    },
  },
  mixed: {
    value: 'mixed',
    label: 'Mixed doubles',
    title: 'Mixed doubles',
    icon: '👫',
    summary: 'Every team is one man and one woman whenever the players due to play allow it.',
    how: [
      'Who plays is still fewest games first, then the longest wait.',
      'Each court takes two men and two women while they last, and each team is one of each.',
      'To make teams mixed, a player may swap with one of the next two waiting players on the same game count.',
      'Short of one gender? Those players team up together and the explanation says so; players with no gender set fill either side.',
    ],
    diagram: 'mixed',
    bestFor: 'Mixed groups with a similar number of men and women.',
    needs: [{ requirement: 'genders', text: 'Set Male / Female for players in the roster (Edit or Player details).' }],
    fairness: 'Everyone gets the same number of games (within one). The only swap allowed is between players on the same game count, so nobody with fewer games is ever skipped.',
    hint: 'Each team is one man and one woman when the players due to play allow it; otherwise same-gender teams, explained. Set genders in the roster.',
    example: (players) => {
      const [a, b, c, d] = mixedFour(players);
      return `${a} (F) & ${b} (M) vs ${c} (M) & ${d} (F): both teams are mixed.`;
    },
  },
  pools: {
    value: 'pools',
    label: 'Skill pools (A / B divisions)',
    title: 'Skill pools',
    icon: '🏅',
    summary: 'Players are split into pools (A advanced, B developing, optional C) and each court plays within one pool.',
    how: [
      'Pools come from each player’s pool in the roster, or from skill-level cutoffs you set.',
      'Courts belong to a pool (auto: by pool size, pool A on the top courts) or alternate between pools.',
      'Within a pool it is fewest games first, then the longest wait.',
      'A pool that cannot fill its court leaves it open with a reason, or borrows players if you allow it.',
    ],
    diagram: 'pools',
    bestFor: 'Bigger groups (12+) with clearly different levels and 2 or more courts.',
    needs: [
      { requirement: 'skills', text: 'Set skill levels (or a pool) for players in the roster.' },
      { requirement: 'courts2', text: '2 or more courts recommended (1 court: pools take turns).' },
    ],
    fairness: 'Games stay level within each pool (fewest games first inside the pool). Pools of different sizes can drift apart; borrowing evens them out.',
    hint: 'Players play within their pool (A advanced, B developing); courts belong to a pool or alternate. Set skill levels or pools in the roster.',
    example: (players) => {
      const [a, b, c, d, e, f, g, h] = eight(players);
      return `Court 1 (pool A): ${a} & ${b} vs ${c} & ${d}. Court 2 (pool B): ${e} & ${f} vs ${g} & ${h}.`;
    },
  },
  round_robin: {
    value: 'round_robin',
    label: 'Round robin schedule',
    title: 'Round robin',
    icon: '🔄',
    summary: 'A printable schedule where everyone partners everyone as evenly as possible, round by round.',
    how: [
      'Generate the schedule for the players and courts here; print it or save it as a PDF.',
      'Each round lists the games per court and who sits out (byes rotate fairly).',
      'Start this game follows the schedule; a missing player is replaced by the most-due waiting player.',
      'If the roster changes, regenerate to include new arrivals (the app reminds you).',
    ],
    diagram: 'roundrobin',
    bestFor: 'Leagues, ladders and socials of 5 to 20 players who like a plan they can see.',
    needs: [
      { requirement: 'schedule', text: 'Check players in first, then generate the schedule (Game settings).' },
    ],
    fairness: 'Follows the schedule instead of the live queue; byes rotate so scheduled games stay within one of each other. When the schedule ends, games follow the Balanced rule.',
    hint: 'Generates a printable schedule where everyone partners everyone as evenly as possible; byes rotate fairly and Start this game follows the schedule.',
    example: (players) => {
      const [a, b, c, d, e] = eight(players);
      return `Round 1: Court 1 ${a} & ${b} vs ${c} & ${d}; bye: ${e}. Round 2 mixes everyone again.`;
    },
  },
  mentor: {
    value: 'mentor',
    label: 'Mentor pairing',
    title: 'Mentor pairing',
    icon: '🎓',
    summary: 'Each team pairs a higher-rated player with a lower-rated one, so newer players learn on court.',
    how: [
      'Who plays is still fewest games first, then the longest wait.',
      'Among them, the strongest partners the weakest, the next strongest the next weakest, and so on.',
      'Teams with similar combined levels face each other.',
      'Players without a skill level count as the middle level and show as unrated.',
    ],
    diagram: 'mentor',
    bestFor: 'Clinics, beginner nights and groups welcoming new players.',
    needs: [{ requirement: 'skills', text: 'Set skill levels for players in the roster.' }],
    fairness: BALANCED_FAIRNESS,
    hint: 'Each team pairs a higher-rated player with a lower-rated one (unrated players count as the middle). Set skill levels in the roster.',
    example: (players) => {
      const [a, b, c, d] = mentorFour(players) as [{ name: string; skill: number }, { name: string; skill: number }, { name: string; skill: number }, { name: string; skill: number }];
      return `Mentor ${a.name} (${lvl(a.skill)}) with ${b.name} (${lvl(b.skill)}) vs mentor ${c.name} (${lvl(c.skill)}) with ${d.name} (${lvl(d.skill)}).`;
    },
  },
  challenge: {
    value: 'challenge',
    label: 'Challenge court (winners stay)',
    title: 'Challenge court',
    icon: '👑',
    summary: 'Winners hold the challenge court and face new challengers, up to a limit, then sit.',
    how: [
      'Court 1 is the challenge court (or every court, if you choose).',
      'Winners stay on for up to 2 games in a row (1 to 3, your choice), then sit out a turn.',
      'Challengers come from the front of the fair queue.',
      'The other courts rotate normally; a holder who is resting or declines breaks up the team.',
    ],
    diagram: 'challenge',
    bestFor: 'Competitive groups who enjoy defending a court; any number of courts.',
    needs: [{ requirement: 'results', text: 'Tag each result (Team A won / Team B won).' }],
    fairness: 'One bounded exception: holders keep playing even with more games, for at most the stay-on limit; everyone else is fewest games first, so the gap stays small.',
    hint: 'Winners hold the challenge court for up to N games in a row, then sit; challengers come from the fair queue.',
    example: (players) => {
      const [a, b, c, d] = eight(players);
      return `${a} & ${b} won on Court 1 and stay on (stay 1 of 2) against challengers ${c} & ${d}.`;
    },
  },
  swiss: {
    value: 'swiss',
    label: 'Swiss pairing (by record)',
    title: 'Swiss pairing',
    icon: '📊',
    summary: 'Players with similar records tonight play each other, avoiding rematches.',
    how: [
      'Who plays is still fewest games first, then the longest wait.',
      'Those players are ranked by tonight’s record: win %, then point difference.',
      'Neighbours in that ranking share a court; a swap between courts avoids a rematch when possible.',
      'Players with no results yet count as 0–0 and slot in the middle.',
    ],
    diagram: 'swiss',
    bestFor: 'Groups of 8+ who want close, competitive games as the night goes on.',
    needs: [{ requirement: 'results', text: 'Tag results, ideally with the final score for point difference.' }],
    fairness: BALANCED_FAIRNESS,
    hint: 'Players with similar records tonight (win %, then point difference) play each other, avoiding rematches.',
    example: (players) => {
      const [a, b, c, d] = eight(players);
      return `Swiss: ${a} (3–1) & ${d} (2–2) vs ${b} (3–1) & ${c} (2–2).`;
    },
  },
};

/** The style selectors, in TEAM_UP_STYLES order. */
export const TEAM_UP_CHOICES: readonly { value: TeamUpStyle; label: string; hint: string }[] = TEAM_UP_STYLES.map((value) => ({
  value,
  label: TEAM_UP_GUIDE[value].label,
  hint: TEAM_UP_GUIDE[value].hint,
}));

export function guideFor(style: TeamUpStyle): TeamUpGuide {
  return TEAM_UP_GUIDE[style];
}
