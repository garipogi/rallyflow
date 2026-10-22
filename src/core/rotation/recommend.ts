import { opponentCounts, pairKey, partnershipCounts } from './history';
import { assertUniqueIds, orderQueue, parseInstant } from './queue';
import { recommendTeamUps } from './teamups';
import {
  fairnessOf,
  isGroupingStyle,
  teamUpOf,
  playersNeeded,
  type CourtInput,
  type ExcludedPlayer,
  type OpenCourt,
  type PlayerReason,
  type QueueEntry,
  type QueuePlayer,
  type Recommendation,
  type RecommendationResult,
  type RotationInput,
  type RotationSettings,
  type SkippedCourt,
  type TeamUpStyle,
} from './types';

/**
 * Index of the first player's partner within the group (queue order), in order of preference when nothing else decides: the first
 * and last of the group together, so each team has one longer and one shorter waiter.
 * Singles has only one split.
 */
const PARTNER_OF_FIRST: readonly number[] = [3, 2, 1];

interface Split {
  teamA: string[];
  teamB: string[];
  skillDiff: number;
  repeats: number;
  opponentRepeats: number;
}

interface History {
  partners: Map<string, number>;
  opponents: Map<string, number>;
}

function skillDiffRounded(diff: number): number {
  return Math.round(diff * 1e9);
}

/** All splits of a group (ids in queue order) with their skill difference and repeat partnerships. */
function splitsOf(group: readonly string[], skill: (id: string) => number, history: History): Split[] {
  const sum = (ids: readonly string[]): number => ids.reduce((acc, id) => acc + skill(id), 0);
  const faced = (teamA: readonly string[], teamB: readonly string[]): number =>
    teamA.reduce((acc, a) => acc + teamB.reduce((inner, b) => inner + (history.opponents.get(pairKey(a, b)) ?? 0), 0), 0);
  if (group.length === 2) {
    const [a, b] = group as [string, string];
    return [
      {
        teamA: [a],
        teamB: [b],
        skillDiff: skillDiffRounded(Math.abs(skill(a) - skill(b))),
        repeats: 0,
        opponentRepeats: faced([a], [b]),
      },
    ];
  }
  return PARTNER_OF_FIRST.map((y) => {
    const teamA = [group[0] as string, group[y] as string];
    const teamB = group.filter((_, i) => i !== 0 && i !== y);
    const repeats =
      (history.partners.get(pairKey(teamA[0] as string, teamA[1] as string)) ?? 0) +
      (history.partners.get(pairKey(teamB[0] as string, teamB[1] as string)) ?? 0);
    return {
      teamA,
      teamB,
      skillDiff: skillDiffRounded(Math.abs(sum(teamA) - sum(teamB))),
      repeats,
      opponentRepeats: faced(teamA, teamB),
    };
  });
}

function keepBest(candidates: Split[], score: (s: Split) => number): Split[] {
  const best = Math.min(...candidates.map(score));
  return candidates.filter((s) => score(s) === best);
}

/** Subsets of `items` of size k in lexicographic index order. */
function combinations<T>(items: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...rest] = items as [T, ...T[]];
  return [...combinations(rest, k - 1).map((c) => [head, ...c]), ...combinations(rest, k)];
}

/**
 * The split to play for a chosen group. wait_time: best balanced (if enabled), then fewest repeat
 * partnerships (if enabled). balanced_games (D14): fewest repeat partnerships, then fewest repeat
 * opponents, then best balanced (if enabled). Only the pairing changes, never who plays.
 */
function pickSplit(group: readonly string[], skill: (id: string) => number, settings: RotationSettings, history: History): Split {
  let candidates = splitsOf(group, skill, history);
  if (fairnessOf(settings) === 'balanced_games') {
    candidates = keepBest(candidates, (s) => s.repeats);
    candidates = keepBest(candidates, (s) => s.opponentRepeats);
    if (settings.skillBalancing) candidates = keepBest(candidates, (s) => s.skillDiff);
    return candidates[0] as Split;
  }
  if (settings.skillBalancing) candidates = keepBest(candidates, (s) => s.skillDiff);
  if (settings.partnerRotation) candidates = keepBest(candidates, (s) => s.repeats);
  return candidates[0] as Split;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function minutes(waitedMs: number): number {
  return Math.floor(waitedMs / 60000);
}

function describeSplit(names: (id: string) => string, teamA: readonly string[], teamB: readonly string[]): string {
  return `${teamA.map(names).join(' & ')} vs ${teamB.map(names).join(' & ')}`;
}

/**
 * Fill the free courts, in court order, from the waiting queue (D2). Skill balancing (D6) and
 * partner rotation (D7) are optional and never drop the oldest-waiting player.
 *
 * Choices the decisions leave open: a player without a skill level counts as the average of the
 * rated players in the window (or 0 if nobody is rated), so unrated players neither help nor hurt
 * a balance; with both toggles off the split pairs the first and last of the group in queue order.
 */
export function recommend(input: RotationInput): RecommendationResult {
  // D16: the grouping styles have their own engine; 'balanced' and 'longest_wait' pin the fairness
  // mode they stand for. Without a teamUp setting nothing changes (D1-D7, D14).
  const style = teamUpOf(input.settings);
  if (isGroupingStyle(style)) return recommendTeamUps(input, style);
  if (input.settings.teamUp !== undefined) {
    const fairness = style === 'balanced' ? 'balanced_games' : 'wait_time';
    return recommendOriginal({ ...input, settings: { ...input.settings, fairness } }, style);
  }
  return recommendOriginal(input);
}

function recommendOriginal(input: RotationInput, style?: TeamUpStyle): RecommendationResult {
  const { now, players, courts, settings } = input;
  parseInstant(now, 'now');
  assertUniqueIds(
    courts.map((c) => c.courtId),
    'court',
  );
  const balanced = fairnessOf(settings) === 'balanced_games';
  const queue = orderQueue(players, now, { fairness: fairnessOf(settings), seed: input.seed ?? '' }); // also validates the players
  const positionOf = new Map(queue.map((e) => [e.playerId, e] as const));
  const byId = new Map(players.map((p) => [p.playerId, p] as const));
  const need = playersNeeded(settings.format);
  const history: History = {
    partners: partnershipCounts(input.pastGames ?? []),
    opponents: opponentCounts(input.pastGames ?? []),
  };

  const excluded: ExcludedPlayer[] = [];
  for (const p of players) {
    if (p.status === 'playing') excluded.push({ playerId: p.playerId, reason: 'playing' });
    else if (p.status === 'unavailable') excluded.push({ playerId: p.playerId, reason: 'unavailable' });
    else if (p.declinedCurrentTurn === true) excluded.push({ playerId: p.playerId, reason: 'declined' });
  }

  let remaining: QueueEntry[] = queue.filter((e) => !e.declinedCurrentTurn);
  const recommendations: Recommendation[] = [];
  const openCourts: OpenCourt[] = [];
  const skippedCourts: SkippedCourt[] = [];

  for (const court of courts) {
    if (court.status === 'unavailable') {
      skippedCourts.push({ courtId: court.courtId, reason: 'unavailable' });
      continue;
    }
    if (court.occupied) {
      skippedCourts.push({ courtId: court.courtId, reason: 'occupied' });
      continue;
    }
    if (remaining.length < need) {
      openCourts.push({
        courtId: court.courtId,
        courtLabel: court.label,
        needed: need,
        available: remaining.length,
        reason: `${court.label} stays open: ${settings.format} needs ${need} eligible players but only ${remaining.length} ${
          remaining.length === 1 ? 'is' : 'are'
        } waiting.`,
      });
      continue;
    }

    // D6 window; in balanced_games it only reaches players on the same game count as the cut, and
    // players below that count always play, so skill balancing never passes over someone with fewer
    // games for someone with more.
    const cutGames = gamesOf(remaining[need - 1] as QueueEntry);
    const window = settings.skillBalancing
      ? remaining.slice(0, need + 2).filter((e, i) => !balanced || i < need || gamesOf(e) <= cutGames)
      : remaining.slice(0, need);
    const rated = window
      .map((e) => (byId.get(e.playerId) as QueuePlayer).skillLevel)
      .filter((s): s is number => s !== null && Number.isFinite(s));
    const fallback = rated.length === 0 ? 0 : rated.reduce((a, b) => a + b, 0) / rated.length;
    const skill = (id: string): number => {
      const level = (byId.get(id) as QueuePlayer).skillLevel;
      return level !== null && Number.isFinite(level) ? level : fallback;
    };

    let chosen: QueueEntry[];
    let split: Split;
    if (!settings.skillBalancing) {
      chosen = window;
      split = pickSplit(
        chosen.map((e) => e.playerId),
        skill,
        settings,
        history,
      );
    } else {
      // D6: the oldest-waiting player plays; the rest come from the window; best balance wins and
      // ties go to the group with the smallest queue positions (combinations arrive in that order).
      const [oldest, ...others] = window as [QueueEntry, ...QueueEntry[]];
      let best: { group: QueueEntry[]; split: Split } | null = null;
      // balanced_games: everyone below the cut's game count must play; only players on the cut's
      // count are interchangeable.
      const mustPlay = balanced ? others.filter((e) => gamesOf(e) < cutGames) : [];
      for (const rest of combinations(others, need - 1)) {
        if (!mustPlay.every((e) => rest.includes(e))) continue;
        const group = [oldest, ...rest];
        const candidate = pickSplit(
          group.map((e) => e.playerId),
          skill,
          { ...settings, partnerRotation: false, fairness: 'wait_time' },
          history,
        );
        if (best === null || candidate.skillDiff < best.split.skillDiff) best = { group, split: candidate };
      }
      const winner = best as { group: QueueEntry[]; split: Split };
      chosen = winner.group;
      split = pickSplit(
        chosen.map((e) => e.playerId),
        skill,
        settings,
        history,
      );
    }

    const chosenIds = new Set(chosen.map((e) => e.playerId));
    const lastChosenAt = Math.max(...chosen.map((e) => remaining.indexOf(e)));
    const bypassed = remaining.filter((e, i) => i < lastChosenAt && !chosenIds.has(e.playerId));
    const reasons: PlayerReason[] = chosen.map((e) => ({
      playerId: e.playerId,
      displayName: e.displayName,
      queuePosition: (positionOf.get(e.playerId) as QueueEntry).position,
      eligibleSince: e.eligibleSince,
      waitedMs: e.waitedMs,
      ...(balanced ? { gamesPlayed: e.gamesPlayed, effectiveGames: gamesOf(e) } : {}),
    }));

    recommendations.push({
      courtId: court.courtId,
      courtLabel: court.label,
      format: settings.format,
      playerIds: chosen.map((e) => e.playerId),
      teamA: split.teamA,
      teamB: split.teamB,
      reasons,
      bypassed: bypassed.map((e) => e.playerId),
      repeatPartnerships: settings.format === 'doubles' ? split.repeats : 0,
      ...(balanced && settings.format === 'doubles' ? { repeatOpponents: split.opponentRepeats } : {}),
      explanation: balanced
        ? explainBalanced(court, settings, reasons, bypassed, split, chosen, remaining)
        : explain(court, settings, reasons, bypassed, split, chosen),
      ...(style !== undefined ? { teamUp: style } : {}),
    });
    remaining = remaining.filter((e) => !chosenIds.has(e.playerId));
  }

  return { recommendations, openCourts, skippedCourts, excluded };
}

function gamesOf(entry: QueueEntry): number {
  return entry.effectiveGames ?? entry.gamesPlayed;
}

/** D14 explanation: says why each player was chosen (games first, then wait) and who waits a turn and why. */
function explainBalanced(
  court: CourtInput,
  settings: RotationSettings,
  reasons: readonly PlayerReason[],
  bypassed: readonly QueueEntry[],
  split: Split,
  chosen: readonly QueueEntry[],
  waiting: readonly QueueEntry[],
): string {
  const nameOf = (id: string): string => (chosen.find((e) => e.playerId === id) as QueueEntry).displayName;
  const gamesText = (e: QueueEntry): string => {
    const credit = e.gameCredit ?? 0;
    return credit > 0
      ? `${plural(e.gamesPlayed, 'game')} played + ${credit} catch-up for arriving late`
      : `${plural(e.gamesPlayed, 'game')} played`;
  };
  const fewest = Math.min(...waiting.map(gamesOf));
  const who = chosen
    .map((e) => {
      const r = reasons.find((x) => x.playerId === e.playerId) as PlayerReason;
      const tag = gamesOf(e) === fewest ? ', fewest among waiting players' : '';
      return `${e.displayName} (#${r.queuePosition} in the queue, ${gamesText(e)}${tag}, waited ${minutes(e.waitedMs)} min)`;
    })
    .join('; ');
  const parts = [`${court.label}: chosen to balance games played, fewest games first, then longest wait. ${who}.`];

  const chosenIds = new Set(chosen.map((e) => e.playerId));
  const most = Math.max(...chosen.map(gamesOf));
  const shortestChosenWait = Math.min(...chosen.map((e) => e.waitedMs));
  const bypassedIds = new Set(bypassed.map((e) => e.playerId));
  const sitting = waiting.filter((e) => !chosenIds.has(e.playerId) && !bypassedIds.has(e.playerId));
  const longerWaiters = sitting.filter((e) => e.waitedMs > shortestChosenWait && gamesOf(e) > most);
  if (longerWaiters.length > 0) {
    parts.push(
      `${longerWaiters.map((e) => `${e.displayName} (${plural(gamesOf(e), 'game')}, waited ${minutes(e.waitedMs)} min)`).join(', ')} ` +
        `${longerWaiters.length === 1 ? 'waits' : 'wait'} a turn: more games played than the players chosen.`,
    );
  }
  const tied = sitting.filter((e) => gamesOf(e) === most);
  if (tied.length > 0) {
    const lastAtCut = chosen.filter((e) => gamesOf(e) === most);
    const sameWait = tied.some((t) => lastAtCut.some((c) => c.eligibleSince === t.eligibleSince));
    parts.push(
      `Tied on ${plural(most, 'game')} with ${tied.map((e) => e.displayName).join(', ')}: ` +
        (sameWait
          ? 'equal waits were settled by a draw that changes every round, so nobody always wins ties.'
          : 'the longer wait went first.'),
    );
  }

  parts.push(`Teams: ${describeSplit(nameOf, split.teamA, split.teamB)}.`);
  if (bypassed.length > 0) {
    parts.push(
      `Skill balancing passed over ${bypassed.map((e) => `${e.displayName} (${plural(gamesOf(e), 'game')}, waited ${minutes(e.waitedMs)} min)`).join(', ')} ` +
        `to even out the teams; they have the same number of games as the players chosen and stay at the front of the queue.`,
    );
  } else if (settings.skillBalancing) {
    parts.push('Skill balancing is on and kept the queue order.');
  }
  if (settings.format === 'doubles') {
    const partnerText =
      split.repeats === 0
        ? 'no repeat partnerships'
        : `${plural(split.repeats, 'repeat partnership')} (the fewest available)`;
    const opponentText =
      split.opponentRepeats === 0 ? 'no repeat opponents' : `${plural(split.opponentRepeats, 'repeat opponent pairing')}`;
    parts.push(`Partner rotation: ${partnerText}, ${opponentText}.`);
  }
  return parts.join(' ');
}

function explain(
  court: CourtInput,
  settings: RotationSettings,
  reasons: readonly PlayerReason[],
  bypassed: readonly QueueEntry[],
  split: Split,
  chosen: readonly QueueEntry[],
): string {
  const nameOf = (id: string): string => (chosen.find((e) => e.playerId === id) as QueueEntry).displayName;
  const waits = reasons
    .map((r) => `${r.displayName} (#${r.queuePosition} in the queue, waited ${minutes(r.waitedMs)} min)`)
    .join('; ');
  const parts = [`${court.label}: chosen by waiting time, longest wait first. ${waits}.`];
  parts.push(`Teams: ${describeSplit(nameOf, split.teamA, split.teamB)}.`);
  if (bypassed.length > 0) {
    parts.push(
      `Skill balancing passed over ${bypassed.map((e) => `${e.displayName} (waited ${minutes(e.waitedMs)} min)`).join(', ')} ` +
        `to even out the teams; the longest-waiting player still plays and the passed-over players stay at the front of the queue.`,
    );
  } else if (settings.skillBalancing) {
    parts.push('Skill balancing is on and kept the queue order.');
  }
  if (settings.partnerRotation && settings.format === 'doubles') {
    parts.push(
      split.repeats === 0
        ? 'Partner rotation: no repeat partnerships in this pairing.'
        : `Partner rotation: ${split.repeats} repeat partnership${split.repeats === 1 ? '' : 's'} was the fewest available.`,
    );
  }
  return parts.join(' ');
}
