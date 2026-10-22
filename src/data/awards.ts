import type { Db } from './db';
import { ValidationError } from './errors';
import { getClubBranding } from './club';
import { listGames } from './games';
import { listRoster } from './roster';
import { loadScoreLog } from './scoring';
import { getSession, listSessions } from './sessions';
import { raw } from './sqlite';
import type { ClubBranding } from '../shared/club';
import { computeAwards, type AwardGame, type AwardsResult, type AwardWinner } from '../core/awards';
import {
  addToLineup,
  buildShow,
  defaultLineup,
  LineupError,
  normalizeLineup,
  normalizePicks,
  restoreDefaultLineup,
  validateLineup,
  validatePick,
  type AwardLineup,
  type AwardPick,
  type AwardPicks,
  type ShowAward,
  type SkippedAward,
} from '../core/awards/lineup';
import {
  buildTemplateContext,
  describeLibrary,
  recommendTemplates,
  type LibraryEntry,
  type Recommendation,
  type TemplateGame,
  type TemplateInput,
} from '../core/awards/templates';
import type { ScoreLog } from '../core/scoring';
import { scoreEntryOf, type ScoreEntryMode } from '../core/scoring/quickResult';
import { getRotationSettings } from './rotation';

/**
 * Database-backed awards. Read-only and recomputed from the stored games on every call, so
 * corrections and reopened games are always reflected (same rules as src/data/stats.ts).
 * The award lineup (global) and the manual winners (per session, or all time) live in the
 * settings table as versioned JSON.
 */

export type AwardsScope = { kind: 'session'; sessionId: string } | { kind: 'historical' };

export interface AwardsReport extends AwardsResult {
  /** What the awards cover: the session's name, or "All sessions". */
  scopeLabel: string;
  sessionId: string | null;
  /** Date of the session (or of the latest session for all time), ISO 8601; null when there is none. */
  date: string | null;
  /** The lineup applied: awards to show, in ceremony order (champion usually last). */
  lineup: ShowAward[];
  /** Lineup awards that are switched on but nobody qualifies for (or the data is missing). */
  skipped: SkippedAward[];
  /** Everyone who can win a manual award. */
  roster: AwardWinner[];
  /** Players whose first session this is (session scope). */
  firstTimers: string[];
  /** The club or group name (and tagline) shown on the ceremony; name '' when not set. */
  club: ClubBranding;
  /** Session scope: how results were entered (point awards need scores); null for all time. */
  scoreEntry: ScoreEntryMode | null;
}

export interface AwardLibrary {
  entries: LibraryEntry[];
  recommendations: Recommendation[];
  /** Session scope: the session's scoring mode (Winner only ranks no-score awards first); null for all time. */
  scoreEntry: ScoreEntryMode | null;
}

/** The scoring mode of the scope's session, or null for all time. */
function scopeScoreEntry(db: Db, scope: AwardsScope): ScoreEntryMode | null {
  return scope.kind === 'session' ? scoreEntryOf(getRotationSettings(db, scope.sessionId)) : null;
}

const LINEUP_KEY = 'awards_lineup';
const picksKey = (scope: AwardsScope): string => (scope.kind === 'session' ? `award_picks:session:${scope.sessionId}` : 'award_picks:historical');

function readSetting(db: Db, key: string): unknown {
  const row = raw(db).prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

function writeSetting(db: Db, key: string, value: unknown): void {
  raw(db)
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

/** Lineup errors become validation errors so the organizer sees the message. */
function checked<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof LineupError) throw new ValidationError(err.message);
    throw err;
  }
}

function names(db: Db): Record<string, string> {
  const rows = raw(db).prepare('SELECT id, display_name FROM players').all() as { id: string; display_name: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.id] = r.display_name;
  return out;
}

/** Completed results recorded with "Just record the result" and no score are flagged score-less. */
function toAwardGame(game: ReturnType<typeof listGames>[number]): AwardGame {
  return {
    id: game.id,
    sessionId: game.sessionId,
    format: game.format,
    status: game.status,
    teamAScore: game.teamAScore,
    teamBScore: game.teamBScore,
    winner: game.winner,
    endedAt: game.endedAt,
    scoreless: game.status === 'completed' && game.teamAScore === 0 && game.teamBScore === 0,
    participants: game.participants.map((p) => ({ playerId: p.playerId, team: p.team })),
  };
}

/** Adds start time and the rally log (when rally scoring was used) for the library awards. */
function toTemplateGame(db: Db, game: ReturnType<typeof listGames>[number]): TemplateGame {
  let log: ScoreLog | null = null;
  if (game.status === 'completed') {
    try {
      log = loadScoreLog(db, game.id);
    } catch {
      log = null; // the result was recorded without rally scoring
    }
  }
  return { ...toAwardGame(game), startedAt: game.startedAt, log };
}

export function getAwardLineup(db: Db): AwardLineup {
  return normalizeLineup(readSetting(db, LINEUP_KEY));
}

export function setAwardLineup(db: Db, value: unknown): AwardLineup {
  const lineup = checked(() => validateLineup(value));
  writeSetting(db, LINEUP_KEY, lineup);
  return lineup;
}

/** Shows every built-in again with its original name and order; added awards are kept. */
export function restoreAwardLineup(db: Db): AwardLineup {
  return setAwardLineup(db, restoreDefaultLineup(getAwardLineup(db)));
}

export function addAwardToLineup(db: Db, templateId: unknown): { lineup: AwardLineup; key: string } {
  if (typeof templateId !== 'string') throw new ValidationError('Choose an award from the library.');
  const added = checked(() => addToLineup(getAwardLineup(db), templateId));
  return { lineup: setAwardLineup(db, added.lineup), key: added.key };
}

interface ScopeData {
  label: string;
  sessionId: string | null;
  date: string | null;
  rawGames: ReturnType<typeof listGames>;
  sessions?: Array<{ id: string; name: string }>;
  roster: AwardWinner[];
  checkIns: TemplateInput['checkIns'];
  firstTimers: string[];
}

function scopeData(db: Db, scope: AwardsScope, nameOf: Record<string, string>): ScopeData {
  if (scope.kind === 'session') {
    const session = getSession(db, scope.sessionId);
    if (!session) throw new ValidationError(`Unknown session: ${scope.sessionId}`);
    const roster = listRoster(db, session.id);
    const earlier = new Set(
      (
        raw(db)
          .prepare('SELECT DISTINCT sp.player_id AS id FROM session_players sp JOIN sessions s ON s.id = sp.session_id WHERE s.started_at < ? AND s.id <> ?')
          .all(session.startedAt, session.id) as { id: string }[]
      ).map((r) => r.id),
    );
    return {
      label: session.name,
      sessionId: session.id,
      date: session.startedAt,
      rawGames: listGames(db, session.id),
      roster: roster.map((r) => ({ playerId: r.playerId, name: r.player.displayName })),
      checkIns: roster.map((r) => ({ playerId: r.playerId, checkedInAt: r.checkedInAt })),
      firstTimers: roster.filter((r) => r.checkedInAt !== null && !earlier.has(r.playerId)).map((r) => r.playerId),
    };
  }
  if (scope.kind !== 'historical') throw new ValidationError('Choose a session or all time for the awards.');
  const sessions = listSessions(db);
  const rawGames = sessions.flatMap((s) => listGames(db, s.id));
  const played = new Set(rawGames.filter((g) => g.status === 'completed').flatMap((g) => g.participants.map((p) => p.playerId)));
  return {
    label: 'All sessions',
    sessionId: null,
    date: sessions[sessions.length - 1]?.startedAt ?? null,
    rawGames,
    sessions: sessions.map((s) => ({ id: s.id, name: s.name })),
    roster: [...played].map((id) => ({ playerId: id, name: nameOf[id] ?? id })).sort((a, b) => a.name.localeCompare(b.name)),
    checkIns: [],
    firstTimers: [],
  };
}

function templateInput(db: Db, scope: AwardsScope, data: ScopeData, nameOf: Record<string, string>): TemplateInput {
  return {
    scope: scope.kind === 'session' ? 'session' : 'historical',
    games: data.rawGames.map((g) => toTemplateGame(db, g)),
    names: nameOf,
    checkIns: data.checkIns,
    firstTimers: data.firstTimers,
  };
}

export function getAwardPicks(db: Db, scope: AwardsScope): AwardPicks {
  return normalizePicks(readSetting(db, picksKey(scope)));
}

/** Sets (or clears, with null) the organizer's winner for one manual award in the lineup. */
export function setAwardPick(db: Db, scope: AwardsScope, key: unknown, pick: unknown): AwardPicks {
  if (typeof key !== 'string') throw new ValidationError('Choose an award to pick a winner for.');
  const entry = getAwardLineup(db).entries.find((e) => e.key === key);
  if (!entry || entry.kind !== 'template') throw new ValidationError('That award is not a host pick in the lineup.');
  const nameOf = names(db);
  const eligible = new Set(scopeData(db, scope, nameOf).roster.map((w) => w.playerId));
  const clean: AwardPick | null = checked(() => validatePick(pick, eligible));
  const picks = getAwardPicks(db, scope);
  if (clean) picks.picks[key] = clean;
  else delete picks.picks[key];
  writeSetting(db, picksKey(scope), picks);
  return picks;
}

export function getAwards(db: Db, scope: AwardsScope): AwardsReport {
  const nameOf = names(db);
  const data = scopeData(db, scope, nameOf);
  const result = computeAwards(
    scope.kind === 'session'
      ? { scope: 'session', games: data.rawGames.map(toAwardGame), names: nameOf }
      : { scope: 'historical', games: data.rawGames.map(toAwardGame), names: nameOf, sessions: data.sessions },
  );
  const show = buildShow({
    lineup: getAwardLineup(db),
    builtins: result,
    template: templateInput(db, scope, data, nameOf),
    picks: getAwardPicks(db, scope),
    roster: data.roster,
    seed: data.sessionId ?? 'all-time',
  });
  return {
    ...result,
    scopeLabel: data.label,
    sessionId: data.sessionId,
    date: data.date,
    lineup: result.finalizedGames > 0 ? show.awards : [],
    skipped: show.skipped,
    roster: data.roster,
    firstTimers: data.firstTimers,
    club: getClubBranding(db, data.sessionId),
    scoreEntry: scopeScoreEntry(db, scope),
  };
}

/** The award library with availability and live previews for this scope, plus recommendations. */
export function getAwardLibrary(db: Db, scope: AwardsScope): AwardLibrary {
  const nameOf = names(db);
  const data = scopeData(db, scope, nameOf);
  const ctx = buildTemplateContext(templateInput(db, scope, data, nameOf));
  const inLineup = new Set(getAwardLineup(db).entries.filter((e) => e.kind === 'template').map((e) => e.id));
  const scoreEntry = scopeScoreEntry(db, scope);
  return {
    entries: describeLibrary(ctx),
    recommendations: ctx.finalized.length > 0 ? recommendTemplates(ctx, inLineup, 6, { preferScoreless: scoreEntry === 'winner_only' }) : [],
    scoreEntry,
  };
}

export { defaultLineup };
