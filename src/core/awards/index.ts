/**
 * Awards (organizer request after phase 5): celebrates the top players of one session or of all time.
 * Pure logic on top of src/core/stats. No I/O, no database, no mutation of inputs.
 *
 * Rules shared by every award:
 *  - Only finalized games count (status 'completed' with a winner), exactly like the statistics.
 *  - A completed game stored 0-0 is score-less: it was recorded with "Just record the result" and no
 *    final score (a rally-scored game can never end 0-0). It counts for wins, games and streaks, but
 *    never for point-based awards (Point Machine) or close-game awards (Clutch Player).
 *  - An award is hidden when nobody qualifies.
 *  - Ties: candidates are ordered by the award's own statistic first, then by the D9 standing
 *    (win % -> wins -> point differential). Candidates still equal after that share the award.
 *    Shared winners are listed by name (then id) so the output is deterministic.
 */
import {
  buildLeaderboard,
  computePartnerHistory,
  computePlayerStats,
  DEFAULT_MIN_GAMES,
  type LeaderboardScope,
  type PlayerStats,
  type StatsGame,
} from '../stats';
import { placePodium, type PodiumPlayer, type PodiumStep } from './podium';

export { placePodium, podiumCaption, podiumLayout, ordinal, type PodiumPlayer, type PodiumStep, type PodiumStepNo } from './podium';

export interface AwardGame extends StatsGame {
  /** When the game ended (ISO 8601). Orders the games for win streaks. */
  endedAt: string | null;
  /** Set when the result carries no score; a completed 0-0 game is treated as score-less anyway. */
  scoreless?: boolean;
}

export interface AwardsInput {
  scope: LeaderboardScope;
  games: readonly AwardGame[];
  /** playerId -> name shown on the awards. */
  names: Readonly<Record<string, string>>;
  /** Sessions in chronological order (oldest first); used by Rising Star in the all-time scope. */
  sessions?: ReadonlyArray<{ id: string; name: string }>;
  /** D9 threshold override; defaults to 3 (session) or 10 (historical). */
  minGames?: number;
}

export type AwardId =
  | 'champion'
  | 'most_wins'
  | 'point_machine'
  | 'hot_streak'
  | 'dynamic_duo'
  | 'clutch'
  | 'iron_player'
  | 'social_butterfly'
  | 'rising_star';

export interface AwardWinner {
  playerId: string;
  name: string;
}

export interface Award {
  id: AwardId;
  title: string;
  icon: string;
  /** Each group is one winning unit: a single player, or a pair for Dynamic Duo. Ties add groups. */
  groups: AwardWinner[][];
  /**
   * The strongest candidates, best first, for a ceremony's suspense phase: the winners followed by the
   * runners-up on the award's own order, at least NOMINEE_COUNT units when that many qualify.
   */
  nominees: AwardWinner[][];
  /** The headline number that earned the award, e.g. "86%" or "+18". */
  stat: string;
  /** Short label for the stat, e.g. "win rate". */
  statLabel: string;
  /** One human sentence, e.g. "Won 6 of 7 games (86%)". */
  explanation: string;
  /** True when the award is given on the best record so far because nobody met the D9 threshold. */
  provisional: boolean;
}

export type PodiumPlace = 1 | 2 | 3;

/** One official D9 place (competition ranking: a tie for 1st means there is no 2nd place). */
export interface PodiumSpot {
  place: PodiumPlace;
  players: PodiumPlayer[];
  record: string;
}

export interface AwardsResult {
  scope: LeaderboardScope;
  finalizedGames: number;
  threshold: number;
  /** True when nobody reached the D9 threshold and the podium shows the best records so far. */
  provisional: boolean;
  podium: PodiumSpot[];
  /** The podium as drawn: gold, silver and bronze filled in order, ties sharing a step (podium.ts). */
  podiumSteps: PodiumStep[];
  awards: Award[];
  /** A kind sentence for the organizer when the podium is provisional; null otherwise. */
  note: string | null;
}

/** Margin (in points) at or below which a scored game counts as a close game. */
export const CLOSE_GAME_MARGIN = 2;
/** Dynamic Duo needs at least this many games together. */
export const DUO_MIN_GAMES = 2;
/** Hot Streak needs at least this many wins in a row. */
export const STREAK_MIN = 2;
/** Social Butterfly needs at least this many different partners. */
export const BUTTERFLY_MIN_PARTNERS = 3;
/** Nominees shown in a ceremony's suspense phase (more when more winners share the award). */
export const NOMINEE_COUNT = 3;
/** Rising Star: games needed in the latest session and before it. */
export const RISING_MIN_RECENT_GAMES = 2;
export const RISING_MIN_EARLIER_GAMES = 3;

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

/** D9 order: win % desc, then wins desc, then point differential desc (0 = shown as a tie). */
export function compareStanding(a: PlayerStats, b: PlayerStats): number {
  return b.winPct - a.winPct || b.wins - a.wins || b.pointDiff - a.pointDiff;
}

function isFinalized(game: AwardGame): game is AwardGame & { winner: 'A' | 'B' } {
  return game.status === 'completed' && game.winner !== null;
}

/** A completed result without a score: flagged, or stored 0-0 (rally scoring never ends 0-0). */
export function isScoreless(game: AwardGame): boolean {
  return game.scoreless === true || (game.teamAScore === 0 && game.teamBScore === 0);
}

/**
 * Ranks the candidates. `primary` orders by the award's own statistic (negative = a first), then the
 * D9 standing breaks ties. Everyone equal to the leader on both shares the award (`best`); `sorted`
 * is the full order, used for the nominees.
 */
function rankBest<T>(
  candidates: readonly T[],
  primary: (a: T, b: T) => number,
  standing: (t: T) => PlayerStats | null,
): { best: T[]; sorted: T[] } {
  if (candidates.length === 0) return { best: [], sorted: [] };
  const compare = (a: T, b: T): number => {
    const first = primary(a, b);
    if (first !== 0) return first;
    const sa = standing(a);
    const sb = standing(b);
    return sa && sb ? compareStanding(sa, sb) : 0;
  };
  const sorted = [...candidates].sort(compare);
  const leader = sorted[0] as T;
  return { best: sorted.filter((c) => compare(leader, c) === 0), sorted };
}

/** Best-first nominee units: every winner, then runners-up until NOMINEE_COUNT units. */
function nomineeUnits<T>(ranked: { best: T[]; sorted: T[] }, unit: (t: T) => AwardWinner[], byName: (a: AwardWinner[], b: AwardWinner[]) => number): AwardWinner[][] {
  const winners = ranked.best.map(unit).sort(byName);
  const rest = ranked.sorted.slice(ranked.best.length, Math.max(NOMINEE_COUNT, ranked.best.length)).map(unit);
  return [...winners, ...rest];
}

export function computeAwards(input: AwardsInput): AwardsResult {
  const threshold = input.minGames ?? DEFAULT_MIN_GAMES[input.scope];
  const finalized = input.games.filter(isFinalized);
  const nameOf = (id: string): string => input.names[id] ?? id;
  const winner = (id: string): AwardWinner => ({ playerId: id, name: nameOf(id) });
  const byName = (a: AwardWinner, b: AwardWinner): number => byString(a.name, b.name) || byString(a.playerId, b.playerId);
  const singles = (ids: readonly string[]): AwardWinner[][] => ids.map(winner).sort(byName).map((w) => [w]);
  const byUnit = (x: AwardWinner[], y: AwardWinner[]): number => byName(x[0] as AwardWinner, y[0] as AwardWinner) || byName(x[1] ?? (x[0] as AwardWinner), y[1] ?? (y[0] as AwardWinner));
  const nominate = <T,>(ranked: { best: T[]; sorted: T[] }, id: (t: T) => string): AwardWinner[][] => nomineeUnits(ranked, (t) => [winner(id(t))], byUnit);

  if (finalized.length === 0) {
    return { scope: input.scope, finalizedGames: 0, threshold, provisional: false, podium: [], podiumSteps: [], awards: [], note: null };
  }

  const stats = computePlayerStats(finalized).filter((s) => s.gamesPlayed > 0);
  const statsOf = new Map(stats.map((s) => [s.playerId, s]));
  const standingOf = (id: string): PlayerStats | null => statsOf.get(id) ?? null;
  const scored = finalized.filter((g) => !isScoreless(g));
  const awards: Award[] = [];

  // ---- Podium and champion (D9) ----
  const board = buildLeaderboard(stats, { scope: input.scope, minGames: threshold });
  const rankedRows = board.filter((r) => r.ranked);
  const provisional = rankedRows.length === 0;
  const standings: Array<PlayerStats & { rank: number }> = provisional
    ? (() => {
        // Nobody met the threshold: rank everyone who played on the same D9 order, marked provisional.
        const rows = [...stats].sort((a, b) => compareStanding(a, b) || byString(a.playerId, b.playerId));
        return rows.map((row) => ({ ...row, rank: rows.findIndex((r) => compareStanding(r, row) === 0) + 1 }));
      })()
    : rankedRows.map((r) => ({ ...r, rank: r.rank as number }));

  const record = (s: PlayerStats): string => `${s.wins}-${s.losses}`;
  const podium: PodiumSpot[] = [];
  for (const place of [1, 2, 3] as const) {
    const rows = standings.filter((s) => s.rank === place);
    if (rows.length === 0) continue;
    const players = rows
      .map((s) => ({ ...winner(s.playerId), wins: s.wins, losses: s.losses, winPct: s.winPct, pointDiff: s.pointDiff, gamesPlayed: s.gamesPlayed }))
      .sort(byName);
    podium.push({ place, players, record: record(rows[0] as PlayerStats) });
  }
  const podiumSteps = placePodium(
    standings.map((s) => ({ ...winner(s.playerId), wins: s.wins, losses: s.losses, winPct: s.winPct, pointDiff: s.pointDiff, gamesPlayed: s.gamesPlayed, rank: s.rank })),
  ).map((step) => ({ ...step, players: [...step.players].sort(byName) }));

  const top = standings.filter((s) => s.rank === 1);
  const champ = top[0] as PlayerStats;
  const championTitle = input.scope === 'session' ? 'Player of the Session' : 'All-time Champion';
  awards.push({
    id: 'champion',
    title: championTitle,
    icon: '🏆',
    groups: singles(top.map((s) => s.playerId)),
    nominees: nomineeUnits({ best: top, sorted: standings }, (s) => [winner(s.playerId)], byUnit),
    stat: pct(champ.winPct),
    statLabel: 'win rate',
    explanation:
      `Won ${champ.wins} of ${plural(champ.gamesPlayed, 'game')} (${pct(champ.winPct)})` +
      (scored.length > 0 ? `, point difference ${signed(champ.pointDiff)}` : '') +
      (provisional ? '. Provisional: best record so far.' : top.length > 1 ? `, shared by ${top.length} players.` : '.'),
    provisional,
  });

  // ---- Most Wins ----
  const winners = stats.filter((s) => s.wins > 0);
  const mostWinsRanked = rankBest(winners, (a, b) => b.wins - a.wins, (s) => s);
  const mostWins = mostWinsRanked.best;
  if (mostWins.length > 0) {
    const best = mostWins[0] as PlayerStats;
    awards.push({
      id: 'most_wins',
      title: 'Most Wins',
      icon: '🥇',
      groups: singles(mostWins.map((s) => s.playerId)),
      nominees: nominate(mostWinsRanked, (s) => s.playerId),
      stat: String(best.wins),
      statLabel: best.wins === 1 ? 'win' : 'wins',
      explanation: `Won ${best.wins} of ${plural(best.gamesPlayed, 'game')} (${pct(best.winPct)}).`,
      provisional: false,
    });
  }

  // ---- Point Machine: best point differential over scored games only ----
  if (scored.length > 0) {
    const pointStats = computePlayerStats(scored).filter((s) => s.gamesPlayed > 0 && s.pointDiff > 0);
    const machineRanked = rankBest(pointStats, (a, b) => b.pointDiff - a.pointDiff, (s) => standingOf(s.playerId));
    const machine = machineRanked.best;
    if (machine.length > 0) {
      const best = machine[0] as PlayerStats;
      awards.push({
        id: 'point_machine',
        title: 'Point Machine',
        icon: '🎯',
        groups: singles(machine.map((s) => s.playerId)),
        nominees: nominate(machineRanked, (s) => s.playerId),
        stat: signed(best.pointDiff),
        statLabel: 'point difference',
        explanation: `Scored ${best.pointsFor} and gave up ${best.pointsAgainst} across ${plural(best.gamesPlayed, 'scored game')} (${signed(best.pointDiff)}).`,
        provisional: false,
      });
    }
  }

  // ---- Hot Streak: longest run of consecutive wins, games ordered by end time ----
  const ordered = finalized
    .map((g, i) => ({ g, i }))
    .sort((a, b) => byString(a.g.endedAt ?? '', b.g.endedAt ?? '') || a.i - b.i)
    .map((x) => x.g);
  const current = new Map<string, number>();
  const longest = new Map<string, number>();
  for (const game of ordered) {
    for (const p of game.participants) {
      const run = game.winner === p.team ? (current.get(p.playerId) ?? 0) + 1 : 0;
      current.set(p.playerId, run);
      longest.set(p.playerId, Math.max(longest.get(p.playerId) ?? 0, run));
    }
  }
  const streakers = [...longest.entries()].filter(([, n]) => n >= STREAK_MIN).map(([id, n]) => ({ id, n }));
  const hotRanked = rankBest(streakers, (a, b) => b.n - a.n, (s) => standingOf(s.id));
  const hot = hotRanked.best;
  if (hot.length > 0) {
    const best = (hot[0] as { n: number }).n;
    awards.push({
      id: 'hot_streak',
      title: 'Hot Streak',
      icon: '🔥',
      groups: singles(hot.map((s) => s.id)),
      nominees: nominate(hotRanked, (s) => s.id),
      stat: String(best),
      statLabel: 'wins in a row',
      explanation: `Won ${best} games in a row.`,
      provisional: false,
    });
  }

  // ---- Dynamic Duo: best partnership, at least DUO_MIN_GAMES together; win % -> wins -> point diff together ----
  const pairMap = new Map<string, { a: string; b: string; games: number; wins: number; pointDiff: number }>();
  for (const game of finalized) {
    if (game.format !== 'doubles') continue;
    for (const team of ['A', 'B'] as const) {
      const ids = game.participants.filter((p) => p.team === team).map((p) => p.playerId).sort(byString);
      if (ids.length !== 2) continue;
      const [a, b] = ids as [string, string];
      const key = `${a}\u0000${b}`;
      const row = pairMap.get(key) ?? { a, b, games: 0, wins: 0, pointDiff: 0 };
      pairMap.set(key, row);
      row.games++;
      if (game.winner === team) row.wins++;
      if (!isScoreless(game)) row.pointDiff += team === 'A' ? game.teamAScore - game.teamBScore : game.teamBScore - game.teamAScore;
    }
  }
  const pairs = [...pairMap.values()].filter((r) => r.games >= DUO_MIN_GAMES && r.wins > 0);
  const duoRanked = rankBest(pairs, (x, y) => y.wins / y.games - x.wins / x.games || y.wins - x.wins || y.pointDiff - x.pointDiff, () => null);
  const duo = duoRanked.best;
  if (duo.length > 0) {
    const best = duo[0] as (typeof pairs)[number];
    const groups = duo
      .map((r) => [winner(r.a), winner(r.b)].sort(byName))
      .sort((x, y) => byName(x[0] as AwardWinner, y[0] as AwardWinner) || byName(x[1] as AwardWinner, y[1] as AwardWinner));
    awards.push({
      id: 'dynamic_duo',
      title: 'Dynamic Duo',
      icon: '🤝',
      groups,
      nominees: nomineeUnits(duoRanked, (r) => [winner(r.a), winner(r.b)].sort(byName), byUnit),
      stat: pct(best.wins / best.games),
      statLabel: 'together',
      explanation: `Won ${best.wins} of ${plural(best.games, 'game')} together (${pct(best.wins / best.games)})${best.pointDiff !== 0 ? `, ${signed(best.pointDiff)} points` : ''}.`,
      provisional: false,
    });
  }

  // ---- Clutch Player: most wins in close scored games (margin <= CLOSE_GAME_MARGIN) ----
  const close = new Map<string, { wins: number; games: number }>();
  for (const game of scored) {
    if (Math.abs(game.teamAScore - game.teamBScore) > CLOSE_GAME_MARGIN) continue;
    for (const p of game.participants) {
      const row = close.get(p.playerId) ?? { wins: 0, games: 0 };
      close.set(p.playerId, row);
      row.games++;
      if (game.winner === p.team) row.wins++;
    }
  }
  const clutchCandidates = [...close.entries()].filter(([, r]) => r.wins > 0).map(([id, r]) => ({ id, ...r }));
  const clutchRanked = rankBest(
    clutchCandidates,
    (a, b) => b.wins - a.wins || b.wins / b.games - a.wins / a.games,
    (c) => standingOf(c.id),
  );
  const clutch = clutchRanked.best;
  if (clutch.length > 0) {
    const best = clutch[0] as (typeof clutchCandidates)[number];
    awards.push({
      id: 'clutch',
      title: 'Clutch Player',
      icon: '💪',
      groups: singles(clutch.map((c) => c.id)),
      nominees: nominate(clutchRanked, (c) => c.id),
      stat: String(best.wins),
      statLabel: best.wins === 1 ? 'close win' : 'close wins',
      explanation: `Won ${best.wins} of ${plural(best.games, 'close game')} (decided by ${CLOSE_GAME_MARGIN} points or fewer).`,
      provisional: false,
    });
  }

  // ---- Iron Player: most games played; only meaningful when not everyone played the same amount ----
  const maxGames = Math.max(...stats.map((s) => s.gamesPlayed));
  const allEqual = stats.every((s) => s.gamesPlayed === maxGames);
  if (maxGames >= 2 && !allEqual) {
    const ironRanked = rankBest(stats, (a, b) => b.gamesPlayed - a.gamesPlayed, (s) => s);
    const iron = ironRanked.best;
    awards.push({
      id: 'iron_player',
      title: 'Iron Player',
      icon: '⚡',
      groups: singles(iron.map((s) => s.playerId)),
      nominees: nominate(ironRanked, (s) => s.playerId),
      stat: String(maxGames),
      statLabel: 'games played',
      explanation: `Played ${plural(maxGames, 'game')}, more than anyone else.`,
      provisional: false,
    });
  }

  // ---- Social Butterfly: most different doubles partners ----
  const partners = new Map<string, Set<string>>();
  for (const r of computePartnerHistory(finalized)) {
    const set = partners.get(r.playerId) ?? new Set<string>();
    partners.set(r.playerId, set);
    set.add(r.partnerId);
  }
  const social = [...partners.entries()].filter(([, s]) => s.size >= BUTTERFLY_MIN_PARTNERS).map(([id, s]) => ({ id, n: s.size }));
  const butterflyRanked = rankBest(social, (a, b) => b.n - a.n, (s) => standingOf(s.id));
  const butterfly = butterflyRanked.best;
  if (butterfly.length > 0) {
    const best = (butterfly[0] as { n: number }).n;
    awards.push({
      id: 'social_butterfly',
      title: 'Social Butterfly',
      icon: '🦋',
      groups: singles(butterfly.map((s) => s.id)),
      nominees: nominate(butterflyRanked, (s) => s.id),
      stat: String(best),
      statLabel: 'different partners',
      explanation: `Teamed up with ${best} different partners.`,
      provisional: false,
    });
  }

  // ---- Rising Star (all-time only): biggest win-rate jump in a player's latest session ----
  if (input.scope === 'historical' && input.sessions && input.sessions.length >= 2) {
    const order = new Map(input.sessions.map((s, i) => [s.id, i]));
    const perPlayer = new Map<string, Map<number, { wins: number; games: number }>>();
    for (const game of finalized) {
      const index = order.get(game.sessionId);
      if (index === undefined) continue;
      for (const p of game.participants) {
        const bySession = perPlayer.get(p.playerId) ?? new Map<number, { wins: number; games: number }>();
        perPlayer.set(p.playerId, bySession);
        const row = bySession.get(index) ?? { wins: 0, games: 0 };
        bySession.set(index, row);
        row.games++;
        if (game.winner === p.team) row.wins++;
      }
    }
    const rising: Array<{ id: string; gain: number; before: number; after: number; session: string }> = [];
    for (const [id, bySession] of perPlayer) {
      const latest = Math.max(...bySession.keys());
      const recent = bySession.get(latest) as { wins: number; games: number };
      let earlierWins = 0;
      let earlierGames = 0;
      for (const [index, row] of bySession) {
        if (index === latest) continue;
        earlierWins += row.wins;
        earlierGames += row.games;
      }
      if (recent.games < RISING_MIN_RECENT_GAMES || earlierGames < RISING_MIN_EARLIER_GAMES) continue;
      const before = earlierWins / earlierGames;
      const after = recent.wins / recent.games;
      if (after > before) {
        rising.push({ id, gain: after - before, before, after, session: input.sessions[latest]?.name ?? '' });
      }
    }
    const starRanked = rankBest(rising, (a, b) => b.gain - a.gain, (r) => standingOf(r.id));
    const star = starRanked.best;
    if (star.length > 0) {
      const best = star[0] as (typeof rising)[number];
      awards.push({
        id: 'rising_star',
        title: 'Rising Star',
        icon: '🌟',
        groups: singles(star.map((r) => r.id)),
        nominees: nominate(starRanked, (r) => r.id),
        stat: `+${Math.round(best.gain * 100)}`,
        statLabel: 'win-rate points',
        explanation: `Win rate up from ${pct(best.before)} to ${pct(best.after)} in ${best.session}.`,
        provisional: false,
      });
    }
  }

  const note = provisional
    ? `Nobody has played ${plural(threshold, 'finalized game')} yet, so the podium is provisional and based on the best record so far.`
    : null;
  return { scope: input.scope, finalizedGames: finalized.length, threshold, provisional, podium, podiumSteps, awards, note };
}

/**
 * "Ana", "Ana and Ben", "Ana, Ben and Cy"; a pair is joined with "&". With `max`, longer lists end
 * with "and N more" so a card stays readable.
 */
export function formatWinners(groups: readonly (readonly AwardWinner[])[], max = Infinity): string {
  const units = groups.map((g) => g.map((w) => w.name).join(' & '));
  if (units.length <= 1) return units[0] ?? '';
  if (units.length > max) {
    const rest = units.length - max;
    const kind = groups.every((g) => g.length === 2) ? (rest === 1 ? ' pair' : ' pairs') : '';
    return `${units.slice(0, max).join(', ')} and ${rest} more${kind}`;
  }
  return `${units.slice(0, -1).join(', ')} and ${units[units.length - 1]}`;
}
