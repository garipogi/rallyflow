/**
 * The award lineup: which awards are given, in which order (the ceremony order, building to the
 * champion), under which names, and the organizer's manual ("people's choice") winners.
 * Pure: validation, defaults and the final list of awards to show. Persisted as versioned JSON by
 * src/data/awards.ts.
 */
import { NOMINEE_COUNT, type AwardId, type AwardsResult, type AwardWinner } from './index';
import {
  buildTemplateContext,
  evaluateTemplate,
  resolveParams,
  templateById,
  unavailableReason,
  type AwardCategory,
  type TemplateInput,
} from './templates';

export const LINEUP_VERSION = 1;
export const PICKS_VERSION = 1;
export const MAX_LINEUP = 60;
export const MAX_TITLE = 40;
export const MAX_DESCRIPTION = 200;
export const MAX_ICON_CHARS = 4;
export const MAX_NOTE = 140;
export const MAX_PICK_WINNERS = 4;
export const MAX_SHORTLIST = 8;

export interface LineupEntry {
  /** Stable id of this lineup slot; also keys the manual winners. */
  key: string;
  kind: 'builtin' | 'template';
  /** A built-in award id, or a library template id. */
  id: string;
  enabled: boolean;
  title?: string;
  icon?: string;
  description?: string;
  params?: Record<string, number>;
}

export interface AwardLineup {
  version: typeof LINEUP_VERSION;
  entries: LineupEntry[];
}

export interface AwardPick {
  /** Player ids of the winner(s). */
  winners: string[];
  /** Optional nominees for the suspense phase (player ids). */
  shortlist: string[];
  note: string;
}

export interface AwardPicks {
  version: typeof PICKS_VERSION;
  picks: Record<string, AwardPick>;
}

export class LineupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineupError';
  }
}

/** Built-in awards in the default ceremony order: least prestigious first, champion last. */
export const BUILTIN_ORDER: readonly AwardId[] = [
  'social_butterfly',
  'iron_player',
  'rising_star',
  'clutch',
  'dynamic_duo',
  'hot_streak',
  'point_machine',
  'most_wins',
  'champion',
];

export const BUILTIN_INFO: Readonly<Record<AwardId, { title: string; icon: string; description: string }>> = {
  champion: {
    title: 'Player of the Session',
    icon: '🏆',
    description: 'Top of the leaderboard: win %, then wins, then point difference. Needs 3 games in a session or 10 overall; before that the podium is provisional.',
  },
  most_wins: { title: 'Most Wins', icon: '🥇', description: 'The most games won.' },
  point_machine: { title: 'Point Machine', icon: '🎯', description: 'Best point difference. Only games with a final score count.' },
  hot_streak: { title: 'Hot Streak', icon: '🔥', description: 'Longest run of wins in a row (at least 2), in the order games ended.' },
  dynamic_duo: { title: 'Dynamic Duo', icon: '🤝', description: 'Best doubles pair with at least 2 games together: win %, then wins, then point difference together.' },
  clutch: { title: 'Clutch Player', icon: '💪', description: 'Most wins in close games decided by 2 points or fewer.' },
  iron_player: { title: 'Iron Player', icon: '⚡', description: 'Played the most games (shown when not everyone played the same number).' },
  social_butterfly: { title: 'Social Butterfly', icon: '🦋', description: 'Teamed up with the most different partners (at least 3).' },
  rising_star: { title: 'Rising Star', icon: '🌟', description: 'All time only: biggest jump in win rate in a player’s latest session compared with before.' },
};

const isBuiltin = (id: string): id is AwardId => (BUILTIN_ORDER as readonly string[]).includes(id);
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function defaultLineup(): AwardLineup {
  return { version: LINEUP_VERSION, entries: BUILTIN_ORDER.map((id) => ({ key: id, kind: 'builtin', id, enabled: true })) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const chars = (s: string): number => [...s].length;

function cleanText(value: unknown, field: string, max: number, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new LineupError(`${label}: the ${field} must be text.`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '') return undefined;
  if (chars(text) > max) throw new LineupError(`${label}: the ${field} can be at most ${max} characters.`);
  return text;
}

/**
 * Strict check of a lineup sent by the organizer. Throws LineupError with a friendly message.
 * Built-in awards cannot be deleted: any left out come back hidden, just before the champion.
 */
export function validateLineup(value: unknown): AwardLineup {
  if (!isRecord(value)) throw new LineupError('The award lineup is not valid.');
  if (value.version !== LINEUP_VERSION) throw new LineupError(`Unknown award lineup version: ${String(value.version)}.`);
  if (!Array.isArray(value.entries)) throw new LineupError('The award lineup has no list of awards.');
  if (value.entries.length > MAX_LINEUP) throw new LineupError(`The lineup can hold at most ${MAX_LINEUP} awards.`);
  const keys = new Set<string>();
  const builtins = new Set<string>();
  const entries: LineupEntry[] = [];
  value.entries.forEach((raw, i) => {
    const where = `Award ${i + 1}`;
    if (!isRecord(raw)) throw new LineupError(`${where} is not valid.`);
    const { key, kind, id, enabled } = raw;
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new LineupError(`${where} has an invalid key.`);
    if (keys.has(key)) throw new LineupError(`${where} repeats the key "${key}".`);
    keys.add(key);
    if (typeof enabled !== 'boolean') throw new LineupError(`${where}: say whether it is shown.`);
    if (kind === 'builtin') {
      if (typeof id !== 'string' || !isBuiltin(id)) throw new LineupError(`${where} is not a known built-in award.`);
      if (builtins.has(id)) throw new LineupError(`${where}: "${BUILTIN_INFO[id].title}" is listed twice.`);
      builtins.add(id);
    } else if (kind === 'template') {
      if (typeof id !== 'string' || !templateById(id)) throw new LineupError(`${where} is not an award from the library.`);
    } else {
      throw new LineupError(`${where} has an unknown kind.`);
    }
    const label = kind === 'builtin' ? BUILTIN_INFO[id as AwardId].title : (templateById(id as string)?.title ?? where);
    const entry: LineupEntry = { key, kind, id: id as string, enabled };
    const title = cleanText(raw.title, 'title', MAX_TITLE, label);
    const icon = cleanText(raw.icon, 'icon', MAX_ICON_CHARS, label);
    const description = cleanText(raw.description, 'description', MAX_DESCRIPTION, label);
    if (title !== undefined) entry.title = title;
    if (icon !== undefined) entry.icon = icon;
    if (description !== undefined) entry.description = description;
    if (raw.params !== undefined && raw.params !== null) {
      const template = kind === 'template' ? templateById(id as string) : null;
      if (!isRecord(raw.params) || !template) throw new LineupError(`${label}: this award has no settings.`);
      const params: Record<string, number> = {};
      for (const [name, v] of Object.entries(raw.params)) {
        const def = template.params.find((p) => p.key === name);
        if (!def) throw new LineupError(`${label}: unknown setting "${name}".`);
        if (typeof v !== 'number' || !Number.isInteger(v) || v < def.min || v > def.max) {
          throw new LineupError(`${label}: ${def.label.toLowerCase()} must be a whole number from ${def.min} to ${def.max}.`);
        }
        params[name] = v;
      }
      if (Object.keys(params).length > 0) entry.params = params;
    }
    entries.push(entry);
  });
  const missing = BUILTIN_ORDER.filter((id) => !builtins.has(id));
  if (missing.length > 0) {
    const championAt = entries.findIndex((e) => e.kind === 'builtin' && e.id === 'champion');
    const insertAt = championAt === -1 ? entries.length : championAt;
    const restored = missing.map((id): LineupEntry => ({ key: uniqueKey(id, keys), kind: 'builtin', id, enabled: id === 'champion' }));
    entries.splice(insertAt, 0, ...restored.filter((e) => e.id !== 'champion'));
    const champ = restored.find((e) => e.id === 'champion');
    if (champ) entries.push(champ);
  }
  return { version: LINEUP_VERSION, entries };
}

/**
 * Default titles that were renamed in a later version, per library template id. A stored lineup
 * entry whose title is exactly the old default was never renamed by the organizer (or was renamed
 * to the same text), so it follows the new default; any other custom title is kept.
 */
export const RETIRED_DEFAULT_TITLES: Readonly<Record<string, readonly string[]>> = {
  speed_demon: ['Speed Demon'],
};

function dropRetiredTitles(lineup: AwardLineup): AwardLineup {
  for (const entry of lineup.entries) {
    if (entry.kind === 'template' && entry.title !== undefined && (RETIRED_DEFAULT_TITLES[entry.id] ?? []).includes(entry.title)) {
      delete entry.title;
    }
  }
  return lineup;
}

/** Tolerant read of stored JSON: anything invalid falls back to the default lineup. */
export function normalizeLineup(value: unknown): AwardLineup {
  try {
    return dropRetiredTitles(validateLineup(value));
  } catch {
    return defaultLineup();
  }
}

function uniqueKey(base: string, taken: Set<string>): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40) || 'award';
  let key = clean;
  for (let n = 2; taken.has(key); n++) key = `${clean}-${n}`;
  taken.add(key);
  return key;
}

/**
 * Adds a library template. It goes just before the champion when the champion closes the
 * ceremony (the usual case), otherwise at the end.
 */
export function addToLineup(lineup: AwardLineup, templateId: string): { lineup: AwardLineup; key: string } {
  const template = templateById(templateId);
  if (!template) throw new LineupError('That award is not in the library.');
  if (lineup.entries.length >= MAX_LINEUP) throw new LineupError(`The lineup can hold at most ${MAX_LINEUP} awards.`);
  const taken = new Set(lineup.entries.map((e) => e.key));
  const key = uniqueKey(templateId, taken);
  const entries = [...lineup.entries];
  const last = entries[entries.length - 1];
  const entry: LineupEntry = { key, kind: 'template', id: templateId, enabled: true };
  if (last && last.kind === 'builtin' && last.id === 'champion') entries.splice(entries.length - 1, 0, entry);
  else entries.push(entry);
  return { lineup: { version: LINEUP_VERSION, entries }, key };
}

/** Brings every built-in back (shown, original name, default order) and keeps the added awards before the champion. */
export function restoreDefaultLineup(lineup: AwardLineup): AwardLineup {
  const added = lineup.entries.filter((e) => e.kind === 'template');
  const builtins = defaultLineup().entries;
  const champion = builtins.pop() as LineupEntry;
  return { version: LINEUP_VERSION, entries: [...builtins, ...added, champion] };
}

/** Strict check of one manual pick against the people who can win it. */
export function validatePick(value: unknown, eligible: ReadonlySet<string>): AwardPick | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new LineupError('The winner choice is not valid.');
  const ids = (list: unknown, what: string, max: number): string[] => {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) throw new LineupError(`The ${what} must be a list of players.`);
    const unique = [...new Set(list as string[])];
    if (unique.length > max) throw new LineupError(`Choose at most ${max} ${what}.`);
    const unknown = unique.find((id) => !eligible.has(id));
    if (unknown) throw new LineupError(`Only players from this roster can be chosen.`);
    return unique;
  };
  const winners = ids(value.winners, 'winners', MAX_PICK_WINNERS);
  const shortlist = ids(value.shortlist, 'nominees', MAX_SHORTLIST);
  let note = '';
  if (value.note !== undefined && value.note !== null) {
    if (typeof value.note !== 'string') throw new LineupError('The note must be text.');
    note = value.note.replace(/\s+/g, ' ').trim();
    if (chars(note) > MAX_NOTE) throw new LineupError(`The note can be at most ${MAX_NOTE} characters.`);
  }
  if (winners.length === 0 && shortlist.length === 0 && note === '') return null;
  return { winners, shortlist, note };
}

/** Tolerant read of stored picks; unknown or broken entries are dropped. */
export function normalizePicks(value: unknown): AwardPicks {
  const out: AwardPicks = { version: PICKS_VERSION, picks: {} };
  if (!isRecord(value) || value.version !== PICKS_VERSION || !isRecord(value.picks)) return out;
  for (const [key, raw] of Object.entries(value.picks)) {
    if (!KEY_RE.test(key) || !isRecord(raw)) continue;
    const list = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : []);
    out.picks[key] = {
      winners: list(raw.winners).slice(0, MAX_PICK_WINNERS),
      shortlist: list(raw.shortlist).slice(0, MAX_SHORTLIST),
      note: typeof raw.note === 'string' ? raw.note.slice(0, MAX_NOTE) : '',
    };
  }
  return out;
}

// ---------------------------------------------------------------- the awards to show

export type ShowSource = 'builtin' | 'computed' | 'manual';

export interface ShowAward {
  key: string;
  source: ShowSource;
  /** Built-in award id or library template id. */
  templateId: string;
  category: AwardCategory | 'classic';
  title: string;
  icon: string;
  /** How the award is earned (speaker notes). */
  description: string;
  groups: AwardWinner[][];
  /** Best-first candidates for the suspense phase (manual: shortlist or random roster names). */
  nominees: AwardWinner[][];
  stat: string;
  statLabel: string;
  explanation: string;
  provisional: boolean;
  /** Manual award whose nominees were drawn at random from the roster, for drama only. */
  decoys: boolean;
  /** Manual award still waiting for the organizer to choose a winner. */
  pending: boolean;
  note: string | null;
}

export interface SkippedAward {
  key: string;
  title: string;
  icon: string;
  reason: string;
}

export interface ShowInput {
  lineup: AwardLineup;
  builtins: AwardsResult;
  template: TemplateInput;
  picks: AwardPicks;
  /** Everyone who can win a manual award (the session roster, or all players for all time). */
  roster: readonly AwardWinner[];
  /** Seeds the random nominees of manual awards, e.g. the session id. */
  seed: string;
}

/** Small deterministic hash (FNV-1a) so random nominees are the same on every screen and every call. */
export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic shuffle seeded by a string. */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  let s = hashString(seed) || 1;
  const next = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const byName = (a: AwardWinner, b: AwardWinner): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0);

/** A manual award from the organizer's pick. */
export function buildManualAward(
  entry: LineupEntry,
  base: { title: string; icon: string; description: string; category: AwardCategory },
  pick: AwardPick | undefined,
  roster: readonly AwardWinner[],
  seed: string,
): ShowAward {
  const byId = new Map(roster.map((w) => [w.playerId, w]));
  const winners = (pick?.winners ?? []).map((id) => byId.get(id)).filter((w): w is AwardWinner => w !== undefined).sort(byName);
  const shortlist = (pick?.shortlist ?? []).map((id) => byId.get(id)).filter((w): w is AwardWinner => w !== undefined);
  const winnerIds = new Set(winners.map((w) => w.playerId));
  let nominees: AwardWinner[];
  let decoys = false;
  if (shortlist.length > 0) {
    nominees = [...winners, ...shortlist.filter((w) => !winnerIds.has(w.playerId)).sort(byName)];
  } else {
    const pool = seededShuffle(
      roster.filter((w) => !winnerIds.has(w.playerId)),
      `${seed}:${entry.key}`,
    );
    const extra = Math.max(NOMINEE_COUNT - winners.length, 1);
    nominees = [...winners, ...pool.slice(0, extra)];
    decoys = pool.length > 0;
  }
  const pending = winners.length === 0;
  const note = pick?.note ? pick.note : null;
  return {
    key: entry.key,
    source: 'manual',
    templateId: entry.id,
    category: base.category,
    title: entry.title ?? base.title,
    icon: entry.icon ?? base.icon,
    description: entry.description ?? base.description,
    groups: winners.map((w) => [w]),
    nominees: nominees.map((w) => [w]),
    stat: winners.length > 1 ? `${winners.length}` : '★',
    statLabel: winners.length > 1 ? 'winners' : base.category === 'peoples_choice' ? "people's choice" : "host's pick",
    explanation: note ?? (pending ? 'The host has not chosen a winner yet.' : 'Chosen by the host.'),
    provisional: false,
    decoys,
    pending,
    note,
  };
}

/**
 * Applies the lineup: hidden awards are left out, names and icons are overridden, library awards are
 * computed with their settings, and manual awards take the organizer's pick. The order is the lineup
 * order, which is the ceremony order. Computed awards nobody qualifies for are reported as skipped.
 */
export function buildShow(input: ShowInput): { awards: ShowAward[]; skipped: SkippedAward[] } {
  const ctx = buildTemplateContext(input.template);
  const builtinById = new Map(input.builtins.awards.map((a) => [a.id as string, a]));
  const awards: ShowAward[] = [];
  const skipped: SkippedAward[] = [];
  for (const entry of input.lineup.entries) {
    if (!entry.enabled) continue;
    if (entry.kind === 'builtin') {
      const id = entry.id as AwardId;
      const info = BUILTIN_INFO[id];
      const award = builtinById.get(id);
      const title = entry.title ?? award?.title ?? info.title;
      const icon = entry.icon ?? info.icon;
      if (!award) {
        if (input.builtins.finalizedGames > 0) skipped.push({ key: entry.key, title, icon, reason: id === 'rising_star' && input.template.scope === 'session' ? 'All-time awards only.' : 'Nobody qualifies yet.' });
        continue;
      }
      awards.push({
        key: entry.key,
        source: 'builtin',
        templateId: id,
        category: 'classic',
        title,
        icon,
        description: entry.description ?? info.description,
        groups: award.groups,
        nominees: award.nominees,
        stat: award.stat,
        statLabel: award.statLabel,
        explanation: award.explanation,
        provisional: award.provisional,
        decoys: false,
        pending: false,
        note: null,
      });
      continue;
    }
    const template = templateById(entry.id);
    if (!template) continue;
    const title = entry.title ?? template.title;
    const icon = entry.icon ?? template.icon;
    if (template.kind === 'manual') {
      if (input.builtins.finalizedGames === 0 && input.roster.length === 0) continue;
      awards.push(buildManualAward(entry, template, input.picks.picks[entry.key], input.roster, input.seed));
      continue;
    }
    const reason = unavailableReason(template, ctx);
    const result = reason === null ? evaluateTemplate(template, ctx, resolveParams(template, entry.params)) : null;
    if (!result) {
      if (input.builtins.finalizedGames > 0) skipped.push({ key: entry.key, title, icon, reason: reason ?? 'Nobody qualifies yet.' });
      continue;
    }
    awards.push({
      key: entry.key,
      source: 'computed',
      templateId: template.id,
      category: template.category,
      title,
      icon,
      description: entry.description ?? template.description,
      groups: result.groups,
      nominees: result.nominees,
      stat: result.stat,
      statLabel: result.statLabel,
      explanation: result.explanation,
      provisional: false,
      decoys: false,
      pending: false,
      note: null,
    });
  }
  return { awards, skipped };
}
