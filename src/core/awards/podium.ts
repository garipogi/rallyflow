/**
 * Podium placement for display: the gold, silver and bronze steps.
 *
 * The official standing uses standard competition ranking (D9): two players tied for first are both
 * "1" and the next player is "3". A podium drawn straight from those numbers leaves the silver step
 * empty, so the display uses dense placement instead: every group of tied players shares one step,
 * and the next group takes the next step. Gold, silver and bronze are always filled in order while
 * there are players left. Each step keeps the official rank, so the screen can say "Rank 3" when the
 * silver step is not the official second place. Pure: no I/O.
 */

export type PodiumStepNo = 1 | 2 | 3;

export interface PodiumPlayer {
  playerId: string;
  name: string;
  wins: number;
  losses: number;
  winPct: number;
  pointDiff: number;
  gamesPlayed: number;
}

export interface PodiumStep {
  /** The step on screen: 1 = gold (centre), 2 = silver (left), 3 = bronze (right). */
  step: PodiumStepNo;
  /** The official D9 rank of everyone on this step (competition ranking, e.g. 1, 1, 3). */
  rank: number;
  /** True when more than one player shares this step. */
  tied: boolean;
  players: PodiumPlayer[];
  /** Win-loss record shared by the players on the step, e.g. "4-1". */
  record: string;
}

/**
 * Places ranked players on the three steps. `rows` must be in standing order (best first) with their
 * official rank; players with the same rank share a step. Returns at most three steps, fewer only
 * when there are fewer distinct ranks.
 */
export function placePodium(rows: ReadonlyArray<PodiumPlayer & { rank: number }>): PodiumStep[] {
  const ordered = [...rows].sort((a, b) => a.rank - b.rank);
  const groups: Array<Array<PodiumPlayer & { rank: number }>> = [];
  for (const row of ordered) {
    const last = groups[groups.length - 1];
    if (last && (last[0] as { rank: number }).rank === row.rank) last.push(row);
    else if (groups.length < 3) groups.push([row]);
    else break;
  }
  return groups.map((group, i) => {
    const lead = group[0] as PodiumPlayer & { rank: number };
    return {
      step: (i + 1) as PodiumStepNo,
      rank: lead.rank,
      tied: group.length > 1,
      players: group.map(({ rank: _rank, ...player }) => player),
      record: `${lead.wins}-${lead.losses}`,
    };
  });
}

const ORDINAL: Record<number, string> = { 1: '1st', 2: '2nd', 3: '3rd' };
export const ordinal = (n: number): string => {
  if (ORDINAL[n]) return ORDINAL[n] as string;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
};

/**
 * A short honest caption for a step, or null when the step number already says it all.
 * "Tied for 1st" (a shared official place), "Tied · Rank 3" (a shared place below its step) or
 * "Rank 3" (one player whose official rank differs from the step).
 */
export function podiumCaption(step: Pick<PodiumStep, 'step' | 'rank' | 'tied'>): string | null {
  if (step.tied) return step.rank === step.step ? `Tied for ${ordinal(step.rank)}` : `Tied · Rank ${step.rank}`;
  return step.rank === step.step ? null : `Rank ${step.rank}`;
}

/** The step to show in each podium position, left to right: silver, gold, bronze (undefined = vacant). */
export function podiumLayout(steps: readonly PodiumStep[]): Array<{ step: PodiumStepNo; spot: PodiumStep | undefined }> {
  return ([2, 1, 3] as const).map((step) => ({ step, spot: steps.find((s) => s.step === step) }));
}
