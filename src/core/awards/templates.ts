/**
 * The award library: extra award templates the organizer can add to the lineup.
 * Pure logic, no I/O. Two kinds:
 *  - computed: derived from the session's data (finalized games, scores, the rally-by-rally log when
 *    rally scoring was used, game start/end times, check-in times, partners and opponents);
 *  - manual ("people's choice"): the organizer picks the winner from the roster.
 *
 * Shared rules, the same as the built-in awards (src/core/awards/index.ts):
 *  - Only finalized games count. A 0-0 (score-less) result never counts for score-based awards.
 *  - The rally log of a game is used only when replaying it ends exactly on the stored result, so a
 *    game whose result was typed in over a partial log never feeds rally awards.
 *  - Ties: the award's own numbers first, then the D9 standing for single players; units still
 *    equal share the award, listed by name. An award is hidden when nobody qualifies.
 */
import { applyEvent, initialState, type GameState, type ScoreLog, type TeamId } from '../scoring';
import { buildLeaderboard, computePlayerStats, DEFAULT_MIN_GAMES, type LeaderboardScope, type PlayerStats } from '../stats';
import { CLOSE_GAME_MARGIN, compareStanding, isScoreless, NOMINEE_COUNT, type AwardGame, type AwardWinner } from './index';

export interface TemplateGame extends AwardGame {
  /** When the game started (ISO 8601); used for durations. */
  startedAt?: string | null;
  /** The rally-by-rally log when the game was rally-scored. */
  log?: ScoreLog | null;
}

export interface TemplateInput {
  scope: LeaderboardScope;
  games: readonly TemplateGame[];
  /** playerId -> name. */
  names: Readonly<Record<string, string>>;
  /** Check-in times of the session roster (session scope). */
  checkIns?: ReadonlyArray<{ playerId: string; checkedInAt: string | null }>;
  /** Players whose first session this is. */
  firstTimers?: readonly string[];
  /** D9 threshold override; defaults to 3 (session) or 10 (historical). */
  minGames?: number;
}

export type AwardCategory = 'performance' | 'partnership' | 'drama' | 'fun' | 'community' | 'peoples_choice';

export const AWARD_CATEGORIES: ReadonlyArray<{ id: AwardCategory; label: string }> = [
  { id: 'performance', label: 'Performance' },
  { id: 'partnership', label: 'Partnership' },
  { id: 'drama', label: 'Grit & Drama' },
  { id: 'fun', label: 'Fun' },
  { id: 'community', label: 'Community' },
  { id: 'peoples_choice', label: "People's Choice" },
];

/** Data a template needs before it can find anybody. */
export type DataNeed = 'scores' | 'rallyLog' | 'checkIns' | 'times' | 'doubles';

export interface TemplateParam {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
}

export interface TemplateResult {
  groups: AwardWinner[][];
  nominees: AwardWinner[][];
  stat: string;
  statLabel: string;
  explanation: string;
}

export interface Interest {
  score: number;
  reason: string;
}

interface FinalGame extends TemplateGame {
  winner: TeamId;
}

export interface RallyStep {
  before: GameState;
  winner: TeamId;
  after: GameState;
}

export interface TemplateContext {
  scope: LeaderboardScope;
  finalized: FinalGame[];
  /** Finalized games with a real score (not 0-0). */
  scored: FinalGame[];
  /** Finalized games ordered by end time. */
  ordered: FinalGame[];
  stats: PlayerStats[];
  /** Rally-scored games whose log replays to the stored result. */
  logged: Array<{ game: FinalGame; steps: RallyStep[] }>;
  checkIns: Array<{ playerId: string; at: number }>;
  firstTimers: string[];
  /** Ids of the player(s) ranked first on the D9 standing (provisional when nobody met the threshold). */
  topIds: string[];
  name(id: string): string;
  standing(id: string): PlayerStats | null;
}

export interface AwardTemplateDef {
  id: string;
  kind: 'computed' | 'manual';
  category: AwardCategory;
  title: string;
  icon: string;
  /** How the award is earned, shown in the library and as speaker notes. */
  description: string;
  scopes: readonly LeaderboardScope[];
  /** Every need must be met. */
  needs: readonly DataNeed[];
  /** At least one of these needs must be met (when present). */
  needsOneOf?: readonly DataNeed[];
  params: readonly TemplateParam[];
  evaluate?(ctx: TemplateContext, params: Readonly<Record<string, number>>): TemplateResult | null;
  /** How interesting the template is for this data; null when it should not be recommended. */
  interest(ctx: TemplateContext, result: TemplateResult | null): Interest | null;
}

// ---------------------------------------------------------------- helpers

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));
const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
/** Duration of a game in seconds; null when either time is missing. */
const durationOf = (g: TemplateGame): number | null => {
  const start = time(g.startedAt);
  const end = time(g.endedAt);
  return start === null || end === null || end < start ? null : Math.round((end - start) / 1000);
};
/** Timed awards need games that actually ran: at least a minute. */
export const MIN_TIMED_SECONDS = 60;
const minutes = (seconds: number): number => Math.max(1, Math.round(seconds / 60));
const teamOf = (g: TemplateGame, team: TeamId): string[] => g.participants.filter((p) => p.team === team).map((p) => p.playerId);
const other = (t: TeamId): TeamId => (t === 'A' ? 'B' : 'A');
const scoreOf = (g: TemplateGame, team: TeamId): number => (team === 'A' ? g.teamAScore : g.teamBScore);
const scoreText = (g: FinalGame): string =>
  isScoreless(g) ? 'result only' : `${scoreOf(g, g.winner)}-${scoreOf(g, other(g.winner))}`;
/** "a 9-0" but "an 11-0" / "an 8-0". */
const article = (n: number): string => (n === 8 || n === 11 || n === 18 || String(n).startsWith('8') ? 'an' : 'a');
const scopeWord = (ctx: TemplateContext): string => (ctx.scope === 'session' ? 'this session' : 'across all sessions');

function isFinal(g: TemplateGame): g is FinalGame {
  return g.status === 'completed' && g.winner !== null;
}

/** Replays a log; null unless it ends exactly on the stored result. */
function stepsOf(game: FinalGame): RallyStep[] | null {
  const log = game.log;
  if (!log || log.events.length === 0) return null;
  try {
    let state = initialState(log.setup);
    const steps: RallyStep[] = [];
    for (const event of log.events) {
      const after = applyEvent(state, event);
      const winner: TeamId = event.type === 'rally' ? event.winner : other(event.against);
      steps.push({ before: state, winner, after });
      state = after;
    }
    const matches = state.isOver && state.winner === game.winner && state.score.A === game.teamAScore && state.score.B === game.teamBScore;
    return matches ? steps : null;
  } catch {
    return null;
  }
}

export function buildTemplateContext(input: TemplateInput): TemplateContext {
  const finalized = input.games.filter(isFinal);
  const scored = finalized.filter((g) => !isScoreless(g));
  const ordered = finalized
    .map((g, i) => ({ g, i }))
    .sort((a, b) => byString(a.g.endedAt ?? '', b.g.endedAt ?? '') || a.i - b.i)
    .map((x) => x.g);
  const stats = computePlayerStats(finalized).filter((s) => s.gamesPlayed > 0);
  const statsOf = new Map(stats.map((s) => [s.playerId, s]));
  const logged: TemplateContext['logged'] = [];
  for (const game of finalized) {
    const steps = stepsOf(game);
    if (steps) logged.push({ game, steps });
  }
  const checkIns = (input.scope === 'session' ? (input.checkIns ?? []) : [])
    .map((c) => ({ playerId: c.playerId, at: time(c.checkedInAt) }))
    .filter((c): c is { playerId: string; at: number } => c.at !== null);
  const threshold = input.minGames ?? DEFAULT_MIN_GAMES[input.scope];
  const ranked = buildLeaderboard(stats, { scope: input.scope, minGames: threshold }).filter((r) => r.ranked && r.rank === 1);
  let topIds = ranked.map((r) => r.playerId);
  if (topIds.length === 0 && stats.length > 0) {
    const sorted = [...stats].sort((a, b) => compareStanding(a, b) || byString(a.playerId, b.playerId));
    const lead = sorted[0] as PlayerStats;
    topIds = sorted.filter((s) => compareStanding(s, lead) === 0).map((s) => s.playerId);
  }
  return {
    scope: input.scope,
    finalized,
    scored,
    ordered,
    stats,
    logged,
    checkIns,
    firstTimers: [...(input.firstTimers ?? [])],
    topIds,
    name: (id) => input.names[id] ?? id,
    standing: (id) => statsOf.get(id) ?? null,
  };
}

/** One candidate unit (a player, a pair, or a game's four players) with its ranking keys (higher first). */
interface Entry {
  ids: string[];
  keys: number[];
  stat: string;
  statLabel: string;
  explanation: string;
}

/**
 * Ranks the entries: keys first, then the D9 standing for single players. Units equal to the leader
 * share the award. Nominees are every winner, then the runners-up until NOMINEE_COUNT units.
 */
export function rankEntries(ctx: TemplateContext, entries: readonly Entry[], opts: { standing?: boolean } = {}): TemplateResult | null {
  if (entries.length === 0) return null;
  const unitName = (e: Entry): string => e.ids.map(ctx.name).sort(byString).join(' & ');
  const compare = (a: Entry, b: Entry): number => {
    const n = Math.max(a.keys.length, b.keys.length);
    for (let i = 0; i < n; i++) {
      const d = (b.keys[i] ?? 0) - (a.keys[i] ?? 0);
      if (d !== 0) return d;
    }
    if (opts.standing !== false && a.ids.length === 1 && b.ids.length === 1) {
      const sa = ctx.standing(a.ids[0] as string);
      const sb = ctx.standing(b.ids[0] as string);
      if (sa && sb) return compareStanding(sa, sb);
    }
    return 0;
  };
  const sorted = [...entries].sort((a, b) => compare(a, b) || byString(unitName(a), unitName(b)) || byString(a.ids.join(), b.ids.join()));
  const leader = sorted[0] as Entry;
  const best = sorted.filter((e) => compare(leader, e) === 0);
  const unit = (e: Entry): AwardWinner[] =>
    e.ids.map((id) => ({ playerId: id, name: ctx.name(id) })).sort((x, y) => byString(x.name, y.name) || byString(x.playerId, y.playerId));
  const groups = best.map(unit);
  const rest = sorted.slice(best.length, Math.max(NOMINEE_COUNT, best.length)).map(unit);
  return { groups, nominees: [...groups, ...rest], stat: leader.stat, statLabel: leader.statLabel, explanation: leader.explanation };
}

/** Adds n to a per-player counter for every id. */
function tally(map: Map<string, number>, ids: readonly string[], n = 1): void {
  for (const id of ids) map.set(id, (map.get(id) ?? 0) + n);
}

function countEntries(map: Map<string, number>, min: number, describe: (n: number, id: string) => Omit<Entry, 'ids' | 'keys'>): Entry[] {
  return [...map.entries()].filter(([, n]) => n >= min).map(([id, n]) => ({ ids: [id], keys: [n], ...describe(n, id) }));
}

/** Per player, in end-time order: did they win each game? */
function resultsByPlayer(ctx: TemplateContext): Map<string, boolean[]> {
  const out = new Map<string, boolean[]>();
  for (const g of ctx.ordered) {
    for (const p of g.participants) {
      const list = out.get(p.playerId) ?? [];
      out.set(p.playerId, list);
      list.push(g.winner === p.team);
    }
  }
  return out;
}

function pairsOf(ctx: TemplateContext): Map<string, { a: string; b: string; games: number; wins: number }> {
  const pairs = new Map<string, { a: string; b: string; games: number; wins: number }>();
  for (const g of ctx.finalized) {
    if (g.format !== 'doubles') continue;
    for (const team of ['A', 'B'] as const) {
      const ids = teamOf(g, team).sort(byString);
      if (ids.length !== 2) continue;
      const [a, b] = ids as [string, string];
      const key = `${a}\u0000${b}`;
      const row = pairs.get(key) ?? { a, b, games: 0, wins: 0 };
      pairs.set(key, row);
      row.games++;
      if (g.winner === team) row.wins++;
    }
  }
  return pairs;
}

/** Largest deficit the eventual winner faced during a logged game. */
function maxDeficit(game: FinalGame, steps: readonly RallyStep[]): number {
  const loser = other(game.winner);
  let worst = 0;
  for (const s of steps) worst = Math.max(worst, s.after.score[loser] - s.after.score[game.winner]);
  return worst;
}

/** Longest run of unanswered points per team in a logged game. */
function longestRuns(steps: readonly RallyStep[]): { A: number; B: number } {
  const best = { A: 0, B: 0 };
  const run = { A: 0, B: 0 };
  for (const s of steps) {
    const scored = s.winner === s.before.servingTeam; // only the serving side scores
    if (!scored) continue;
    run[s.winner]++;
    run[other(s.winner)] = 0;
    best[s.winner] = Math.max(best[s.winner], run[s.winner]);
  }
  return best;
}

// ---------------------------------------------------------------- the catalogue

const manual = (
  id: string,
  title: string,
  icon: string,
  description: string,
  interest: (ctx: TemplateContext) => Interest | null,
  category: AwardCategory = 'peoples_choice',
): AwardTemplateDef => ({
  id,
  kind: 'manual',
  category,
  title,
  icon,
  description,
  scopes: ['session', 'historical'],
  needs: [],
  params: [],
  interest: (ctx) => interest(ctx),
});

export const AWARD_TEMPLATES: readonly AwardTemplateDef[] = [
  // ---------------- Performance
  {
    id: 'shutout_king',
    kind: 'computed',
    category: 'performance',
    title: 'Shutout King',
    icon: '🛡️',
    description: 'Most wins where the other side did not score a single point (11-0 and friends). Games without a final score do not count.',
    scopes: ['session', 'historical'],
    needs: ['scores'],
    params: [],
    evaluate(ctx) {
      const wins = new Map<string, number>();
      for (const g of ctx.scored) if (scoreOf(g, other(g.winner)) === 0) tally(wins, teamOf(g, g.winner));
      return rankEntries(
        ctx,
        countEntries(wins, 1, (n) => ({ stat: String(n), statLabel: n === 1 ? 'shutout' : 'shutouts', explanation: `Won ${plural(n, 'game')} without the other side scoring.` })),
      );
    },
    interest(ctx, result) {
      if (!result) return null;
      const shutouts = ctx.scored.filter((g) => scoreOf(g, other(g.winner)) === 0);
      const first = shutouts[0];
      const reason =
        shutouts.length === 1 && first ? `There was ${article(scoreOf(first, first.winner))} ${scoreOf(first, first.winner)}-0 shutout ${scopeWord(ctx)}` : `${shutouts.length} shutouts ${scopeWord(ctx)}`;
      return { score: 55 + 10 * shutouts.length, reason };
    },
  },
  {
    id: 'undefeated',
    kind: 'computed',
    category: 'performance',
    title: 'Undefeated',
    icon: '💯',
    description: 'Won every game played, with a minimum number of games. The most wins takes it.',
    scopes: ['session', 'historical'],
    needs: [],
    params: [{ key: 'minGames', label: 'Minimum games', min: 1, max: 30, default: 3 }],
    evaluate(ctx, params) {
      const min = params.minGames ?? 3;
      const entries = ctx.stats
        .filter((s) => s.losses === 0 && s.gamesPlayed >= min)
        .map((s) => ({ ids: [s.playerId], keys: [s.wins], stat: `${s.wins}-0`, statLabel: 'perfect record', explanation: `Won all ${s.wins} games.` }));
      return rankEntries(ctx, entries);
    },
    interest(ctx, result) {
      if (!result) return null;
      const lead = result.groups[0]?.[0];
      const wins = lead ? (ctx.standing(lead.playerId)?.wins ?? 0) : 0;
      return { score: 75 + 3 * wins, reason: `${lead?.name ?? 'Someone'} has not lost in ${plural(wins, 'game')}` };
    },
  },
  {
    id: 'giant_killer',
    kind: 'computed',
    category: 'performance',
    title: 'Giant Killer',
    icon: '🗡️',
    description: 'Beat the top-ranked player (the leaderboard leader) the most times.',
    scopes: ['session', 'historical'],
    needs: [],
    params: [],
    evaluate(ctx) {
      const top = new Set(ctx.topIds);
      const beats = new Map<string, number>();
      for (const g of ctx.finalized) {
        const losers = teamOf(g, other(g.winner));
        if (!losers.some((id) => top.has(id))) continue;
        tally(beats, teamOf(g, g.winner).filter((id) => !top.has(id)));
      }
      const giant = ctx.topIds.length === 1 ? ctx.name(ctx.topIds[0] as string) : 'the top-ranked players';
      return rankEntries(
        ctx,
        countEntries(beats, 1, (n) => ({ stat: String(n), statLabel: n === 1 ? 'win over the leader' : 'wins over the leader', explanation: `Beat ${giant} ${n === 1 ? 'once' : `${n} times`}.` })),
      );
    },
    interest(ctx, result) {
      if (!result) return null;
      const giant = ctx.topIds.length === 1 ? ctx.name(ctx.topIds[0] as string) : 'The leader';
      return { score: 50, reason: `${giant} was beaten ${scopeWord(ctx)}` };
    },
  },
  {
    id: 'consistency',
    kind: 'computed',
    category: 'performance',
    title: 'Steady Hands',
    icon: '📏',
    description: 'The steadiest point margin from game to game (lowest spread), with at least one win and a minimum number of scored games.',
    scopes: ['session', 'historical'],
    needs: ['scores'],
    params: [{ key: 'minGames', label: 'Minimum scored games', min: 2, max: 30, default: 3 }],
    evaluate(ctx, params) {
      const min = params.minGames ?? 3;
      const margins = new Map<string, number[]>();
      const wins = new Map<string, number>();
      for (const g of ctx.scored) {
        for (const p of g.participants) {
          const list = margins.get(p.playerId) ?? [];
          margins.set(p.playerId, list);
          list.push(scoreOf(g, p.team) - scoreOf(g, other(p.team)));
          if (g.winner === p.team) tally(wins, [p.playerId]);
        }
      }
      const entries: Entry[] = [];
      for (const [id, list] of margins) {
        if (list.length < min || (wins.get(id) ?? 0) === 0) continue;
        const mean = list.reduce((a, b) => a + b, 0) / list.length;
        const spread = Math.sqrt(list.reduce((a, m) => a + (m - mean) ** 2, 0) / list.length);
        const shown = spread.toFixed(1);
        entries.push({
          ids: [id],
          keys: [-Math.round(spread * 100), Math.round(mean * 100)],
          stat: `±${shown}`,
          statLabel: 'point spread',
          explanation: `Point margin stayed within ±${shown} across ${list.length} scored games (average ${signed(Number(mean.toFixed(1)))}).`,
        });
      }
      return rankEntries(ctx, entries);
    },
    interest: (_ctx, result) => (result ? { score: 22, reason: 'Rewards the steadiest player, not just the winner' } : null),
  },
  {
    id: 'bounce_back',
    kind: 'computed',
    category: 'performance',
    title: 'Bounce-Back',
    icon: '🔁',
    description: 'Most wins straight after a loss, in the order games ended.',
    scopes: ['session', 'historical'],
    needs: [],
    params: [],
    evaluate(ctx) {
      const counts = new Map<string, number>();
      for (const [id, results] of resultsByPlayer(ctx)) {
        let n = 0;
        for (let i = 1; i < results.length; i++) if (results[i] && !results[i - 1]) n++;
        if (n > 0) counts.set(id, n);
      }
      return rankEntries(
        ctx,
        countEntries(counts, 1, (n) => ({ stat: String(n), statLabel: n === 1 ? 'bounce-back win' : 'bounce-back wins', explanation: `Won straight after a loss ${n === 1 ? 'once' : `${n} times`}.` })),
      );
    },
    interest(_ctx, result) {
      if (!result) return null;
      const n = Number(result.stat);
      return { score: 26 + 4 * n, reason: `${result.groups[0]?.[0]?.name ?? 'Someone'} answered a loss with a win ${n === 1 ? 'once' : `${n} times`}` };
    },
  },
  {
    id: 'serve_machine',
    kind: 'computed',
    category: 'performance',
    title: 'Serve Machine',
    icon: '🎾',
    description: 'Most points won while serving. Uses rally-by-rally scoring, so games finished with just the result do not count.',
    scopes: ['session', 'historical'],
    needs: ['rallyLog'],
    params: [],
    evaluate(ctx) {
      const points = new Map<string, number>();
      const games = new Map<string, Set<string>>();
      for (const { game, steps } of ctx.logged) {
        for (const s of steps) {
          if (s.winner !== s.before.servingTeam) continue;
          tally(points, [s.before.serverId]);
          const set = games.get(s.before.serverId) ?? new Set<string>();
          games.set(s.before.serverId, set);
          set.add(game.id);
        }
      }
      return rankEntries(
        ctx,
        countEntries(points, 1, (n, id) => ({
          stat: String(n),
          statLabel: n === 1 ? 'point on serve' : 'points on serve',
          explanation: `Won ${plural(n, 'point')} on their own serve across ${plural(games.get(id)?.size ?? 0, 'rally-scored game')}.`,
        })),
      );
    },
    interest: (ctx, result) => (result ? { score: 42 + 2 * Math.min(ctx.logged.length, 10), reason: `Rally scoring was used in ${plural(ctx.logged.length, 'game')}` } : null),
  },
  {
    id: 'side_out_specialist',
    kind: 'computed',
    category: 'performance',
    title: 'Side-Out Specialist',
    icon: '🔄',
    description: 'Most side-outs forced while receiving: rallies won on return that took the serve back. Uses rally-by-rally scoring.',
    scopes: ['session', 'historical'],
    needs: ['rallyLog'],
    params: [],
    evaluate(ctx) {
      const counts = new Map<string, number>();
      for (const { steps } of ctx.logged) {
        for (const s of steps) {
          if (s.winner === s.before.servingTeam || s.after.servingTeam === s.before.servingTeam) continue;
          tally(counts, s.before.teams[s.winner]);
        }
      }
      return rankEntries(
        ctx,
        countEntries(counts, 1, (n) => ({ stat: String(n), statLabel: n === 1 ? 'side-out forced' : 'side-outs forced', explanation: `Won ${plural(n, 'return rally', 'return rallies')} that took the serve back.` })),
      );
    },
    interest: (ctx, result) => (result ? { score: 38 + Math.min(ctx.logged.length, 10), reason: `Rally scoring shows who broke serve in ${plural(ctx.logged.length, 'game')}` } : null),
  },
  // ---------------- Partnership
  {
    id: 'iron_partner',
    kind: 'computed',
    category: 'partnership',
    title: 'Iron Partners',
    icon: '🔗',
    description: 'The doubles pair that played the most games together (at least 2). Wins break a tie.',
    scopes: ['session', 'historical'],
    needs: ['doubles'],
    params: [],
    evaluate(ctx) {
      const entries = [...pairsOf(ctx).values()]
        .filter((p) => p.games >= 2)
        .map((p) => ({ ids: [p.a, p.b], keys: [p.games, p.wins], stat: String(p.games), statLabel: 'games together', explanation: `Played ${p.games} games side by side and won ${p.wins}.` }));
      return rankEntries(ctx, entries);
    },
    interest: (_ctx, result) => (result ? { score: 22 + 3 * Number(result.stat), reason: `${result.groups[0]?.map((w) => w.name).join(' & ') ?? 'A pair'} played ${result.stat} games together` } : null),
  },
  {
    id: 'lucky_charm',
    kind: 'computed',
    category: 'partnership',
    title: 'Lucky Charm',
    icon: '🍀',
    description: 'Partners win more often with this player than without them: the biggest partner win-rate boost over a minimum number of doubles games.',
    scopes: ['session', 'historical'],
    needs: ['doubles'],
    params: [{ key: 'minGames', label: 'Minimum doubles games', min: 2, max: 30, default: 3 }],
    evaluate(ctx, params) {
      const min = params.minGames ?? 3;
      // Every player's record in each game, to compute a partner's win rate without the player.
      const games = ctx.finalized.map((g) => ({ g, ids: new Set(g.participants.map((p) => p.playerId)) }));
      const recordWithout = (partner: string, without: string): { wins: number; games: number } => {
        let wins = 0;
        let played = 0;
        for (const { g, ids } of games) {
          if (!ids.has(partner) || ids.has(without)) continue;
          played++;
          const team = g.participants.find((p) => p.playerId === partner)?.team;
          if (team === g.winner) wins++;
        }
        return { wins, games: played };
      };
      const entries: Entry[] = [];
      for (const s of ctx.stats) {
        let n = 0;
        let actual = 0;
        let expected = 0;
        for (const { g } of games) {
          if (g.format !== 'doubles') continue;
          const me = g.participants.find((p) => p.playerId === s.playerId);
          if (!me) continue;
          const partner = g.participants.find((p) => p.team === me.team && p.playerId !== s.playerId);
          if (!partner) continue;
          const base = recordWithout(partner.playerId, s.playerId);
          if (base.games === 0) continue;
          n++;
          if (g.winner === me.team) actual++;
          expected += base.wins / base.games;
        }
        if (n < min) continue;
        const boost = (actual - expected) / n;
        if (boost <= 0) continue;
        entries.push({
          ids: [s.playerId],
          keys: [Math.round(boost * 1000), n],
          stat: `+${Math.round(boost * 100)}`,
          statLabel: 'partner win-rate points',
          explanation: `Partners won ${pct(actual / n)} of games with them, against ${pct(expected / n)} without them.`,
        });
      }
      return rankEntries(ctx, entries);
    },
    interest: (_ctx, result) => (result ? { score: 28 + Number(result.stat.replace('+', '')) / 4, reason: `${result.groups[0]?.[0]?.name ?? 'Someone'} lifts every partner they play with` } : null),
  },
  {
    id: 'mixer',
    kind: 'computed',
    category: 'partnership',
    title: 'The Mixer',
    icon: '🎲',
    description: 'Faced the most different opponents, with a minimum number of opponents.',
    scopes: ['session', 'historical'],
    needs: [],
    params: [{ key: 'minOpponents', label: 'Minimum opponents', min: 2, max: 40, default: 4 }],
    evaluate(ctx, params) {
      const min = params.minOpponents ?? 4;
      const opponents = new Map<string, Set<string>>();
      for (const g of ctx.finalized) {
        for (const p of g.participants) {
          const set = opponents.get(p.playerId) ?? new Set<string>();
          opponents.set(p.playerId, set);
          for (const q of g.participants) if (q.team !== p.team) set.add(q.playerId);
        }
      }
      const entries = [...opponents.entries()]
        .filter(([, set]) => set.size >= min)
        .map(([id, set]) => ({ ids: [id], keys: [set.size], stat: String(set.size), statLabel: 'different opponents', explanation: `Faced ${set.size} different opponents.` }));
      return rankEntries(ctx, entries);
    },
    interest: (_ctx, result) => (result ? { score: 18 + Number(result.stat), reason: `${result.groups[0]?.[0]?.name ?? 'Someone'} met ${result.stat} different opponents` } : null),
  },
  // ---------------- Grit & Drama
  {
    id: 'comeback_kid',
    kind: 'computed',
    category: 'drama',
    title: 'Comeback Kid',
    icon: '🧗',
    description: 'The team that won a game after trailing by several points. The biggest deficit overcome wins; uses rally-by-rally scoring.',
    scopes: ['session', 'historical'],
    needs: ['rallyLog'],
    params: [{ key: 'minDeficit', label: 'Minimum deficit (points)', min: 2, max: 15, default: 5 }],
    evaluate(ctx, params) {
      const min = params.minDeficit ?? 5;
      // The comeback belongs to the team that made it: partners share it as one unit.
      const best = new Map<string, { ids: string[]; deficit: number; count: number }>();
      for (const { game, steps } of ctx.logged) {
        const deficit = maxDeficit(game, steps);
        if (deficit < min) continue;
        const ids = teamOf(game, game.winner).sort(byString);
        const key = ids.join('\u0000');
        const row = best.get(key) ?? { ids, deficit: 0, count: 0 };
        best.set(key, row);
        row.deficit = Math.max(row.deficit, deficit);
        row.count++;
      }
      const entries = [...best.values()].map((r) => ({
        ids: r.ids,
        keys: [r.deficit, r.count],
        stat: String(r.deficit),
        statLabel: 'points down, then won',
        explanation: `Came back from ${r.deficit} points down to win${r.count > 1 ? ` (${r.count} comebacks)` : ''}.`,
      }));
      return rankEntries(ctx, entries);
    },
    interest: (_ctx, result) => (result ? { score: 66 + 4 * Number(result.stat), reason: `A team came back from ${result.stat} points down` } : null),
  },
  {
    id: 'run_maker',
    kind: 'computed',
    category: 'drama',
    title: 'On a Roll',
    icon: '🌊',
    description: 'The team with the longest run of unanswered points in one game (at least 4). Uses rally-by-rally scoring.',
    scopes: ['session', 'historical'],
    needs: ['rallyLog'],
    params: [],
    evaluate(ctx) {
      // A run belongs to the team that made it: partners share it as one unit.
      const best = new Map<string, { ids: string[]; run: number }>();
      for (const { game, steps } of ctx.logged) {
        const runs = longestRuns(steps);
        for (const team of ['A', 'B'] as const) {
          if (runs[team] < 4) continue;
          const ids = teamOf(game, team).sort(byString);
          const key = ids.join('\u0000');
          const row = best.get(key) ?? { ids, run: 0 };
          best.set(key, row);
          row.run = Math.max(row.run, runs[team]);
        }
      }
      return rankEntries(
        ctx,
        [...best.values()].map((r) => ({
          ids: r.ids,
          keys: [r.run],
          stat: `${r.run}-0`,
          statLabel: 'run of points',
          explanation: `Went on a ${r.run}-0 run of unanswered points in one game.`,
        })),
      );
    },
    interest: (_ctx, result) => (result ? { score: 32 + 3 * Number.parseInt(result.stat, 10), reason: `A team scored ${Number.parseInt(result.stat, 10)} points in a row` } : null),
  },
  {
    id: 'the_closer',
    kind: 'computed',
    category: 'drama',
    title: 'The Closer',
    icon: '🔒',
    description: 'Served the game-winning point the most times. Uses rally-by-rally scoring.',
    scopes: ['session', 'historical'],
    needs: ['rallyLog'],
    params: [],
    evaluate(ctx) {
      const counts = new Map<string, number>();
      for (const { steps } of ctx.logged) {
        const last = steps[steps.length - 1];
        if (last) tally(counts, [last.before.serverId]);
      }
      return rankEntries(
        ctx,
        countEntries(counts, 1, (n) => ({ stat: String(n), statLabel: n === 1 ? 'winning serve' : 'winning serves', explanation: `Served the game-winning point ${n === 1 ? 'once' : `${n} times`}.` })),
      );
    },
    interest: (ctx, result) => (result && ctx.logged.length >= 2 ? { score: 30, reason: `${plural(ctx.logged.length, 'game')} ended on a served point` } : null),
  },
  {
    id: 'nail_biter',
    kind: 'computed',
    category: 'drama',
    title: 'Nail-Biter',
    icon: '😬',
    description: `Played the most games decided by ${CLOSE_GAME_MARGIN} points or fewer, won or lost. Games without a final score do not count.`,
    scopes: ['session', 'historical'],
    needs: ['scores'],
    params: [],
    evaluate(ctx) {
      const counts = new Map<string, number>();
      for (const g of ctx.scored) {
        if (Math.abs(g.teamAScore - g.teamBScore) > CLOSE_GAME_MARGIN) continue;
        tally(counts, g.participants.map((p) => p.playerId));
      }
      return rankEntries(
        ctx,
        countEntries(counts, 1, (n) => ({ stat: String(n), statLabel: n === 1 ? 'close game' : 'close games', explanation: `Played ${plural(n, 'game')} decided by ${CLOSE_GAME_MARGIN} points or fewer.` })),
      );
    },
    interest(ctx, result) {
      if (!result) return null;
      const close = ctx.scored.filter((g) => Math.abs(g.teamAScore - g.teamBScore) <= CLOSE_GAME_MARGIN).length;
      return { score: 28 + 5 * Math.min(close, 10), reason: `${plural(close, 'game was', 'games were')} decided by ${CLOSE_GAME_MARGIN} points or fewer` };
    },
  },
  {
    id: 'marathon_match',
    kind: 'computed',
    category: 'drama',
    title: 'Marathon Match',
    icon: '⏳',
    description: 'All four players of the longest game: by rallies when rally scoring was used, otherwise by time on court.',
    scopes: ['session', 'historical'],
    needs: [],
    needsOneOf: ['rallyLog', 'times'],
    params: [],
    evaluate(ctx) {
      const byRallies = ctx.logged.length >= 2;
      const candidates: Entry[] = byRallies
        ? ctx.logged.map(({ game, steps }) => ({
            ids: game.participants.map((p) => p.playerId),
            keys: [steps.length],
            stat: String(steps.length),
            statLabel: 'rallies',
            explanation: `The longest game: ${steps.length} rallies, won ${scoreText(game)}.`,
          }))
        : ctx.finalized
            .map((game) => ({ game, seconds: durationOf(game) }))
            .filter((x): x is { game: FinalGame; seconds: number } => x.seconds !== null && x.seconds >= MIN_TIMED_SECONDS)
            .map(({ game, seconds }) => ({
              ids: game.participants.map((p) => p.playerId),
              keys: [seconds],
              stat: `${minutes(seconds)} min`,
              statLabel: 'longest game',
              explanation: `The longest game lasted ${minutes(seconds)} minutes (${scoreText(game)}).`,
            }));
      return candidates.length >= 2 ? rankEntries(ctx, candidates) : null;
    },
    interest: (_ctx, result) =>
      result ? { score: 36, reason: result.statLabel === 'rallies' ? `The longest game went ${result.stat} rallies` : `The longest game lasted ${result.stat}` } : null,
  },
  // ---------------- Fun
  {
    id: 'rally_rhythm',
    kind: 'computed',
    category: 'fun',
    title: 'Rally Rhythm',
    icon: '🥁',
    description: 'Played the most rallies. Uses rally-by-rally scoring.',
    scopes: ['session', 'historical'],
    needs: ['rallyLog'],
    params: [],
    evaluate(ctx) {
      const counts = new Map<string, number>();
      const games = new Map<string, number>();
      for (const { game, steps } of ctx.logged) {
        const ids = game.participants.map((p) => p.playerId);
        tally(counts, ids, steps.length);
        tally(games, ids);
      }
      return rankEntries(
        ctx,
        countEntries(counts, 1, (n, id) => ({ stat: String(n), statLabel: 'rallies played', explanation: `Played ${plural(n, 'rally', 'rallies')} across ${plural(games.get(id) ?? 0, 'rally-scored game')}.` })),
      );
    },
    interest: (ctx, result) => (result ? { score: 26 + Math.min(ctx.logged.length, 10), reason: 'Rally scoring counted every rally' } : null),
  },
  {
    id: 'speed_demon',
    kind: 'computed',
    category: 'fun',
    title: 'Speed Demon',
    icon: '🏎️',
    description: 'The quickest win, from the game starting to it ending (games of at least a minute).',
    scopes: ['session', 'historical'],
    needs: ['times'],
    params: [],
    evaluate(ctx) {
      const timed = ctx.finalized
        .map((game) => ({ game, seconds: durationOf(game) }))
        .filter((x): x is { game: FinalGame; seconds: number } => x.seconds !== null && x.seconds >= MIN_TIMED_SECONDS);
      if (timed.length < 2) return null;
      return rankEntries(
        ctx,
        timed.map(({ game, seconds }) => ({
          ids: teamOf(game, game.winner),
          keys: [-seconds],
          stat: `${minutes(seconds)} min`,
          statLabel: 'fastest win',
          explanation: `Won a game in just ${plural(minutes(seconds), 'minute')} (${scoreText(game)}).`,
        })),
      );
    },
    interest: (_ctx, result) => (result ? { score: 24, reason: `One game was over in ${result.stat}` } : null),
  },
  {
    id: 'last_one_standing',
    kind: 'computed',
    category: 'fun',
    title: 'Last One Standing',
    icon: '🌙',
    description: 'Played in the final game of the session.',
    scopes: ['session'],
    needs: [],
    params: [],
    evaluate(ctx) {
      if (ctx.ordered.length < 2 || ctx.ordered.some((g) => !g.endedAt)) return null;
      const lastIndex = new Map<string, number>();
      ctx.ordered.forEach((g, i) => {
        for (const p of g.participants) lastIndex.set(p.playerId, i);
      });
      const final = ctx.ordered[ctx.ordered.length - 1] as FinalGame;
      return rankEntries(
        ctx,
        [...lastIndex.entries()].map(([id, i]) => ({
          ids: [id],
          keys: [i],
          stat: 'Final',
          statLabel: 'game of the night',
          explanation: `Played the final game of the session (${scoreText(final) === 'result only' ? 'result only' : `won ${scoreText(final)}`}).`,
        })),
        { standing: false }, // everyone in the final game shares it
      );
    },
    interest: (ctx, result) => (result && ctx.ordered.length >= 4 ? { score: 18, reason: 'Celebrates the players who closed the night' } : null),
  },
  // ---------------- Community
  {
    id: 'early_bird',
    kind: 'computed',
    category: 'community',
    title: 'Early Bird',
    icon: '🐦',
    description: 'First to check in for the session.',
    scopes: ['session'],
    needs: ['checkIns'],
    params: [],
    evaluate(ctx) {
      if (ctx.checkIns.length === 0) return null;
      const sorted = [...ctx.checkIns].sort((a, b) => a.at - b.at);
      const first = (sorted[0] as { at: number }).at;
      const next = sorted.find((c) => c.at > first);
      const gap = next ? Math.round((next.at - first) / 60000) : 0;
      const explanation = gap >= 1 ? `Checked in first, ${plural(gap, 'minute')} before the next player.` : 'Checked in first.';
      return rankEntries(
        ctx,
        ctx.checkIns.map((c) => ({ ids: [c.playerId], keys: [-Math.floor(c.at / 1000)], stat: '1st', statLabel: 'to check in', explanation })),
      );
    },
    interest: (ctx, result) => (result ? { score: 20 + Math.min(ctx.checkIns.length, 16) / 2, reason: `${plural(ctx.checkIns.length, 'player')} checked in` } : null),
  },
  manual(
    'newcomer',
    'Newcomer of the Night',
    '🌱',
    'Host pick: welcome a first-timer. Players whose first session this is are suggested.',
    (ctx) =>
      ctx.firstTimers.length > 0
        ? { score: 48 + 6 * Math.min(ctx.firstTimers.length, 6), reason: `${plural(ctx.firstTimers.length, 'first-timer')} ${ctx.scope === 'session' ? 'tonight' : 'recently'}` }
        : null,
    'community',
  ),
  // ---------------- People's Choice
  manual('best_sportsmanship', 'Best Sportsmanship', '🎖️', 'Host or crowd pick: fair calls, kind words, great attitude.', () => ({ score: 44, reason: 'A crowd favourite on any night' })),
  manual('spirit_of_the_night', 'Spirit of the Night', '✨', 'Host or crowd pick: the energy everybody fed off.', () => ({ score: 40, reason: 'Celebrates energy, not just results' })),
  manual('loudest_cheer', 'Loudest Cheer', '📣', 'Host or crowd pick: the biggest voice on the sideline.', () => ({ score: 24, reason: 'A fun one to vote on out loud' })),
  manual('most_improved', 'Most Improved', '📈', 'Host pick: the player whose game grew the most.', (ctx) =>
    ctx.scope === 'historical' ? { score: 34, reason: 'All-time view: reward progress' } : { score: 26, reason: 'Recognise effort and progress' },
  ),
  manual('best_dressed', 'Best Dressed', '👟', 'Host or crowd pick: the sharpest court style.', () => ({ score: 20, reason: 'Light-hearted and quick to pick' })),
  manual('paddle_personality', 'Paddle Personality', '🎭', 'Host pick: the most entertaining presence on court.', () => ({ score: 21, reason: 'Every group has one' })),
  manual('kitchen_commander', 'Kitchen Commander', '🍳', 'Host pick: owned the non-volley zone with soft dinks and resets.', (ctx) =>
    ctx.finalized.length >= 6 ? { score: 23, reason: 'For the dink-rally master' } : null,
  ),
  manual('host_pick', "Host's Pick", '🎁', 'Your own award: rename it and pick the winner.', () => null),
];

const TEMPLATE_MAP = new Map(AWARD_TEMPLATES.map((t) => [t.id, t]));

export function templateById(id: string): AwardTemplateDef | null {
  return TEMPLATE_MAP.get(id) ?? null;
}

/** Fills in defaults and clamps each known parameter into range; unknown keys are dropped. */
export function resolveParams(template: AwardTemplateDef, params: Readonly<Record<string, number>> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of template.params) {
    const v = params?.[p.key];
    out[p.key] = typeof v === 'number' && Number.isInteger(v) ? Math.min(p.max, Math.max(p.min, v)) : p.default;
  }
  return out;
}

/** Whether each kind of data exists in this context. */
export function dataAvailability(ctx: TemplateContext): Record<DataNeed, boolean> {
  return {
    scores: ctx.scored.length > 0,
    rallyLog: ctx.logged.length > 0,
    checkIns: ctx.checkIns.length > 0,
    times: ctx.finalized.some((g) => (durationOf(g) ?? 0) >= MIN_TIMED_SECONDS),
    doubles: ctx.finalized.some((g) => g.format === 'doubles'),
  };
}

const NEED_TEXT: Record<DataNeed, string> = {
  scores: 'Needs games finished with a final score.',
  rallyLog: 'Needs rally-by-rally scoring (Start scoring on a court).',
  checkIns: 'Needs check-in times; session awards only.',
  times: 'Needs games that ran at least a minute.',
  doubles: 'Needs doubles games.',
};

/** Null when the template can work with this data; otherwise a short reason. */
export function unavailableReason(template: AwardTemplateDef, ctx: TemplateContext): string | null {
  if (!template.scopes.includes(ctx.scope)) return ctx.scope === 'historical' ? 'Session awards only.' : 'All-time awards only.';
  const have = dataAvailability(ctx);
  const missing = template.needs.find((n) => !have[n]);
  if (missing) return NEED_TEXT[missing];
  if (template.needsOneOf && !template.needsOneOf.some((n) => have[n])) {
    const options = template.needsOneOf.map((n) => NEED_TEXT[n].replace(/^Needs /, '').replace(/\.$/, ''));
    return `Needs ${options.join(', or ')}.`;
  }
  return null;
}

/** Evaluates a computed template; null for manual templates, unavailable data or nobody qualifying. */
export function evaluateTemplate(template: AwardTemplateDef, ctx: TemplateContext, params?: Readonly<Record<string, number>>): TemplateResult | null {
  if (template.kind !== 'computed' || !template.evaluate) return null;
  if (unavailableReason(template, ctx) !== null) return null;
  return template.evaluate(ctx, resolveParams(template, params));
}

export interface LibraryEntry {
  id: string;
  kind: 'computed' | 'manual';
  category: AwardCategory;
  title: string;
  icon: string;
  description: string;
  params: TemplateParam[];
  /** Null when the template can find a winner from this data (or is a manual pick). */
  unavailable: string | null;
  /** Who would win right now with default parameters (computed templates). */
  preview: { winners: string; stat: string; statLabel: string; explanation: string } | null;
}

export interface Recommendation {
  templateId: string;
  score: number;
  reason: string;
}

const previewOf = (result: TemplateResult | null): LibraryEntry['preview'] =>
  result
    ? { winners: result.groups.map((g) => g.map((w) => w.name).join(' & ')).join(', '), stat: result.stat, statLabel: result.statLabel, explanation: result.explanation }
    : null;

/** The whole library, serializable, with availability and a live preview for this data. */
export function describeLibrary(ctx: TemplateContext): LibraryEntry[] {
  return AWARD_TEMPLATES.map((t) => {
    const unavailable = t.kind === 'manual' ? null : unavailableReason(t, ctx);
    return {
      id: t.id,
      kind: t.kind,
      category: t.category,
      title: t.title,
      icon: t.icon,
      description: t.description,
      params: t.params.map((p) => ({ ...p })),
      unavailable,
      preview: t.kind === 'computed' && unavailable === null ? previewOf(evaluateTemplate(t, ctx)) : null,
    };
  });
}

/**
 * "Recommended for this session": scores every template that is not in the lineup yet by how
 * interesting it is with this data. Computed templates need a winner; best first, then by title.
 */
export function recommendTemplates(ctx: TemplateContext, inLineup: ReadonlySet<string>, limit = 6): Recommendation[] {
  const out: Array<Recommendation & { title: string }> = [];
  for (const t of AWARD_TEMPLATES) {
    if (inLineup.has(t.id)) continue;
    let result: TemplateResult | null = null;
    if (t.kind === 'computed') {
      result = evaluateTemplate(t, ctx);
      if (!result) continue;
    }
    const interest = t.interest(ctx, result);
    if (!interest) continue;
    out.push({ templateId: t.id, score: Math.round(interest.score * 10) / 10, reason: interest.reason, title: t.title });
  }
  return out
    .sort((a, b) => b.score - a.score || byString(a.title, b.title))
    .slice(0, Math.max(0, limit))
    .map(({ templateId, score, reason }) => ({ templateId, score, reason }));
}
