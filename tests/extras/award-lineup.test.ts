/*
 * Award lineup and manual winners (src/core/awards/lineup.ts), the ceremony state machine
 * (src/shared/ceremony.ts), their persistence in the settings table (src/data/awards.ts) and the
 * API handlers, including the ceremony mirrored on the display.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeAwards, type AwardGame } from '../../src/core/awards';
import {
  addToLineup,
  BUILTIN_ORDER,
  buildManualAward,
  buildShow,
  defaultLineup,
  normalizeLineup,
  normalizePicks,
  restoreDefaultLineup,
  seededShuffle,
  validateLineup,
  validatePick,
  type AwardLineup,
} from '../../src/core/awards/lineup';
import {
  autoAdvanceAfter,
  backState,
  buildSteps,
  displayOrder,
  jumpTo,
  nextState,
  phaseElapsed,
  skipToReveal,
  spotlightIndex,
  startState,
  SUSPENSE_MS,
  togglePause,
  validateCeremonyState,
} from '../../src/shared/ceremony';
import { openDatabase, type Db } from '../../src/data/db';
import { createSession } from '../../src/data/sessions';
import { addNewPlayerToSession, checkInPlayer } from '../../src/data/roster';
import { listCourts } from '../../src/data/courts';
import { createGame } from '../../src/data/games';
import { finalizeGame, recordGameResult, recordScoringEvent, startScoring } from '../../src/data/scoring';
import { getAwardLibrary, getAwardLineup, getAwards, setAwardLineup, setAwardPick } from '../../src/data/awards';
import { raw } from '../../src/data/sqlite';
import { createApiHandlers, type DbStore, type HostServices } from '../../src/main/handlers';
import type { DisplayMode } from '../../src/shared/api';

const NAMES = { a: 'Ana', b: 'Ben', c: 'Cy', d: 'Dee' };
let seq = 0;
function game(teamA: string[], teamB: string[], winner: 'A' | 'B', score: [number, number] = winner === 'A' ? [11, 5] : [5, 11]): AwardGame {
  seq++;
  return {
    id: `g${seq}`,
    sessionId: 's1',
    format: teamA.length === 2 ? 'doubles' : 'singles',
    status: 'completed',
    teamAScore: score[0],
    teamBScore: score[1],
    winner,
    endedAt: `2026-10-21T18:${String(seq % 60).padStart(2, '0')}:00.000Z`,
    participants: [...teamA.map((playerId) => ({ playerId, team: 'A' as const })), ...teamB.map((playerId) => ({ playerId, team: 'B' as const }))],
  };
}
const ROSTER = Object.entries(NAMES).map(([playerId, name]) => ({ playerId, name }));
const GAMES = [game(['a'], ['b'], 'A', [11, 0]), game(['a'], ['c'], 'A'), game(['a'], ['d'], 'A'), game(['b'], ['c'], 'A'), game(['c'], ['d'], 'B')];

function show(lineup: AwardLineup, picks = normalizePicks(null)) {
  return buildShow({
    lineup,
    builtins: computeAwards({ scope: 'session', games: GAMES, names: NAMES }),
    template: { scope: 'session', games: GAMES, names: NAMES },
    picks,
    roster: ROSTER,
    seed: 's1',
  });
}

describe('award lineup', () => {
  it('defaults to every built-in, least prestigious first and the champion last', () => {
    const l = defaultLineup();
    expect(l.entries.map((e) => e.id)).toEqual([...BUILTIN_ORDER]);
    expect(l.entries.at(-1)?.id).toBe('champion');
    expect(l.entries.every((e) => e.enabled && e.kind === 'builtin')).toBe(true);
  });

  it('validates strictly with friendly messages', () => {
    const ok = defaultLineup();
    expect(() => validateLineup({ ...ok, version: 2 })).toThrow(/version/);
    expect(() => validateLineup({ version: 1 })).toThrow(/list/);
    expect(() => validateLineup({ ...ok, entries: [...ok.entries, { ...ok.entries[0] }] })).toThrow(/repeats the key/);
    expect(() => validateLineup({ ...ok, entries: [{ key: 'x', kind: 'template', id: 'nope', enabled: true }] })).toThrow(/library/);
    expect(() => validateLineup({ ...ok, entries: [{ key: 'x', kind: 'builtin', id: 'most_wins', enabled: true }, { key: 'y', kind: 'builtin', id: 'most_wins', enabled: true }] })).toThrow(/twice/);
    expect(() => validateLineup({ ...ok, entries: [{ key: 'u', kind: 'template', id: 'undefeated', enabled: true, params: { minGames: 99 } }] })).toThrow(/from 1 to 30/);
    expect(() => validateLineup({ ...ok, entries: [{ key: 'u', kind: 'template', id: 'undefeated', enabled: true, params: { bogus: 2 } }] })).toThrow(/unknown setting/);
    expect(() => validateLineup({ ...ok, entries: [{ key: 'u', kind: 'builtin', id: 'clutch', enabled: true, title: 'x'.repeat(41) }] })).toThrow(/at most 40/);
    expect(() => validateLineup({ ...ok, entries: [{ key: 'u', kind: 'builtin', id: 'clutch', enabled: 'yes' }] })).toThrow(/shown/);
    expect(() => validateLineup({ ...ok, entries: [{ key: 'Bad Key!', kind: 'builtin', id: 'clutch', enabled: true }] })).toThrow(/invalid key/);
  });

  it('cannot delete built-ins: missing ones come back hidden before the champion', () => {
    const l = validateLineup({ version: 1, entries: [{ key: 'champion', kind: 'builtin', id: 'champion', enabled: true }, { key: 'u', kind: 'template', id: 'undefeated', enabled: true }] });
    expect(l.entries).toHaveLength(BUILTIN_ORDER.length + 1);
    expect(l.entries.filter((e) => e.kind === 'builtin' && e.id !== 'champion').every((e) => !e.enabled)).toBe(true);
    const champion = l.entries.findIndex((e) => e.id === 'champion');
    expect(l.entries.slice(champion + 1).map((e) => e.id)).toEqual(['undefeated']); // user moved it after the champion
  });

  it('trims names, drops empty overrides, and reads broken stored JSON as the default', () => {
    const l = validateLineup({ version: 1, entries: [{ key: 'clutch', kind: 'builtin', id: 'clutch', enabled: true, title: '  Ice   Cold  ', icon: '', description: null }] });
    expect(l.entries[0]).toEqual({ key: 'clutch', kind: 'builtin', id: 'clutch', enabled: true, title: 'Ice Cold' });
    expect(normalizeLineup('garbage')).toEqual(defaultLineup());
    expect(normalizeLineup({ version: 1, entries: [{ key: 'x', kind: 'alien', id: 'x', enabled: true }] })).toEqual(defaultLineup());
  });

  it('adds library awards before the champion with unique keys, and restores defaults keeping them', () => {
    const one = addToLineup(defaultLineup(), 'shutout_king');
    const two = addToLineup(one.lineup, 'shutout_king');
    expect([one.key, two.key]).toEqual(['shutout_king', 'shutout_king-2']);
    expect(two.lineup.entries.slice(-3).map((e) => e.key)).toEqual(['shutout_king', 'shutout_king-2', 'champion']);
    expect(() => addToLineup(defaultLineup(), 'nope')).toThrow(/library/);
    const moved: AwardLineup = { ...two.lineup, entries: [...two.lineup.entries].reverse().map((e) => (e.id === 'clutch' ? { ...e, enabled: false, title: 'X' } : e)) };
    expect(addToLineup(moved, 'mixer').lineup.entries.at(-1)?.id).toBe('mixer'); // champion no longer last
    const restored = restoreDefaultLineup(moved);
    expect(restored.entries.map((e) => e.key)).toEqual([...BUILTIN_ORDER.slice(0, -1), 'shutout_king-2', 'shutout_king', 'champion']);
    expect(restored.entries.find((e) => e.id === 'clutch')).toEqual({ key: 'clutch', kind: 'builtin', id: 'clutch', enabled: true });
  });

  it('builds the show in lineup order: hidden left out, renamed, library awards computed, the rest skipped', () => {
    let lineup = addToLineup(defaultLineup(), 'shutout_king').lineup;
    lineup = addToLineup(lineup, 'serve_machine').lineup;
    lineup = {
      ...lineup,
      entries: lineup.entries.map((e) => (e.id === 'most_wins' ? { ...e, title: 'Win Machine', icon: '🤖' } : e.id === 'clutch' ? { ...e, enabled: false } : e)),
    };
    const { awards, skipped } = show(lineup);
    const keys = awards.map((a) => a.key);
    expect(keys).not.toContain('clutch');
    expect(keys.at(-1)).toBe('champion');
    expect(keys.indexOf('shutout_king')).toBe(keys.length - 2);
    expect(awards.find((a) => a.key === 'most_wins')).toMatchObject({ title: 'Win Machine', icon: '🤖', source: 'builtin' });
    expect(awards.find((a) => a.key === 'shutout_king')).toMatchObject({ source: 'computed', category: 'performance', groups: [[{ playerId: 'a', name: 'Ana' }]] });
    expect(skipped.find((s) => s.key === 'serve_machine')?.reason).toMatch(/rally-by-rally/);
    expect(skipped.find((s) => s.key === 'rising_star')?.reason).toBe('All-time awards only.');
  });
});

describe('manual (host pick) awards', () => {
  const eligible = new Set(Object.keys(NAMES));

  it('validates picks against the roster', () => {
    expect(validatePick({ winners: ['a'], shortlist: ['b', 'b'], note: '  Great   calls ' }, eligible)).toEqual({ winners: ['a'], shortlist: ['b'], note: 'Great calls' });
    expect(validatePick(null, eligible)).toBeNull();
    expect(validatePick({ winners: [], shortlist: [], note: '' }, eligible)).toBeNull();
    expect(() => validatePick({ winners: ['zed'] }, eligible)).toThrow(/roster/);
    expect(() => validatePick({ winners: ['a', 'b', 'c', 'd', 'a'].concat(['x']) }, new Set(['a', 'b', 'c', 'd', 'x']))).toThrow(/at most 4/);
    expect(() => validatePick({ winners: 'a' }, eligible)).toThrow(/list/);
    expect(() => validatePick({ note: 'x'.repeat(141) }, eligible)).toThrow(/140/);
  });

  it('is pending without a winner, uses the shortlist as nominees, else random roster names', () => {
    const entry = { key: 'spirit', kind: 'template' as const, id: 'spirit_of_the_night', enabled: true };
    const base = { title: 'Spirit', icon: '✨', description: 'Pick', category: 'peoples_choice' as const };
    const pending = buildManualAward(entry, base, undefined, ROSTER, 's1');
    expect(pending).toMatchObject({ pending: true, groups: [], decoys: true });
    const picked = buildManualAward(entry, base, { winners: ['c'], shortlist: ['a', 'd'], note: 'Loud!' }, ROSTER, 's1');
    expect(picked).toMatchObject({ pending: false, decoys: false, explanation: 'Loud!', note: 'Loud!' });
    expect(picked.nominees.map((u) => u[0]?.playerId)).toEqual(['c', 'a', 'd']);
    const random = buildManualAward(entry, base, { winners: ['c'], shortlist: [], note: '' }, ROSTER, 's1');
    expect(random.decoys).toBe(true);
    expect(random.nominees).toHaveLength(3);
    expect(random.nominees[0]?.[0]?.playerId).toBe('c');
    expect(new Set(random.nominees.map((u) => u[0]?.playerId)).size).toBe(3);
    expect(buildManualAward(entry, base, { winners: ['c'], shortlist: [], note: '' }, ROSTER, 's1').nominees).toEqual(random.nominees); // deterministic
    expect(random.explanation).toBe('Chosen by the host.');
  });

  it('shows picks in the lineup and ignores picks of players no longer on the roster', () => {
    const { lineup, key } = addToLineup(defaultLineup(), 'best_sportsmanship');
    const s = show(lineup, { version: 1, picks: { [key]: { winners: ['b', 'ghost'], shortlist: [], note: '' } } });
    expect(s.awards.find((a) => a.key === key)?.groups).toEqual([[{ playerId: 'b', name: 'Ben' }]]);
  });

  it('seeded shuffles are deterministic and keep every item', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    expect(seededShuffle(items, 'x')).toEqual(seededShuffle(items, 'x'));
    expect([...seededShuffle(items, 'x')].sort()).toEqual(items);
  });
});

describe('ceremony state machine', () => {
  const steps = buildSteps([
    { key: 'clutch', templateId: 'clutch' },
    { key: 'champion', templateId: 'champion' },
  ]);

  it('has an intro, one step per award (the champion is the finale) and an outro', () => {
    expect(steps).toEqual([{ kind: 'intro' }, { kind: 'award', key: 'clutch', finale: false }, { kind: 'award', key: 'champion', finale: true }, { kind: 'outro' }]);
  });

  it('moves title -> suspense -> reveal -> next award, back one phase at a time, and stops at the ends', () => {
    let s = startState(1000);
    expect(backState(s, steps, 1001)).toBe(s);
    const walk: string[] = [];
    for (let i = 0; i < 9; i++) {
      walk.push(`${s.step}:${s.phase}`);
      s = nextState(s, steps, 1000 + i);
    }
    expect(walk).toEqual(['0:title', '1:title', '1:suspense', '1:reveal', '2:title', '2:suspense', '2:reveal', '3:title', '3:title']);
    s = backState(s, steps, 2000);
    expect([s.step, s.phase, s.startedAt]).toEqual([2, 'reveal', 2000]);
    s = backState(backState(backState(s, steps, 2001), steps, 2002), steps, 2003);
    expect([s.step, s.phase]).toEqual([1, 'reveal']);
  });

  it('skips the suspense, jumps to any step, and pauses without losing time', () => {
    let s = jumpTo(startState(0), steps, 2, 100);
    expect([s.step, s.phase]).toEqual([2, 'title']);
    expect(jumpTo(s, steps, 9, 100)).toBe(s);
    s = skipToReveal(s, steps, 200);
    expect(s.phase).toBe('reveal');
    expect(skipToReveal(startState(0), steps, 1)).toEqual(startState(0)); // the intro has no suspense
    const paused = togglePause(s, 1200);
    expect(phaseElapsed(paused, 99999)).toBe(1000);
    const resumed = togglePause(paused, 5000);
    expect(phaseElapsed(resumed, 5500)).toBe(1500);
  });

  it('auto-advances only when switched on, using the suspense length', () => {
    const s = { ...startState(0, 'long', true), step: 1, phase: 'suspense' as const };
    expect(autoAdvanceAfter(s, steps)).toBe(SUSPENSE_MS.long);
    expect(autoAdvanceAfter({ ...s, auto: false }, steps)).toBeNull();
    expect(autoAdvanceAfter({ ...s, step: 3, phase: 'title' }, steps)).toBeNull();
    expect(autoAdvanceAfter({ ...s, step: 2, phase: 'reveal' }, steps)).toBeGreaterThan(autoAdvanceAfter({ ...s, phase: 'reveal' }, steps) ?? 0);
  });

  it('sweeps the spotlight fast then slow, deterministically, always on a nominee', () => {
    const early: number[] = [];
    for (let t = 0; t < 1000; t += 10) early.push(spotlightIndex(t, 3, 7000));
    const late: number[] = [];
    for (let t = 9000; t < 10000; t += 10) late.push(spotlightIndex(t, 3, 7000));
    const changes = (xs: number[]) => xs.filter((x, i) => i > 0 && x !== xs[i - 1]).length;
    expect(changes(early)).toBeGreaterThan(changes(late));
    expect(spotlightIndex(4321, 4, 7000)).toBe(spotlightIndex(4321, 4, 7000));
    for (let t = 0; t < 20000; t += 777) expect(spotlightIndex(t, 4, 7000)).toBeLessThan(4);
    expect(spotlightIndex(5000, 1, 7000)).toBe(0);
  });

  it('shuffles nominees per award so the winner is not always first', () => {
    const noms = [[{ playerId: 'a', name: 'Ana' }], [{ playerId: 'b', name: 'Ben' }], [{ playerId: 'c', name: 'Cy' }]];
    const firsts = new Set(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'].map((k) => displayOrder(noms, k)[0]?.[0]?.playerId));
    expect(firsts.size).toBeGreaterThan(1);
  });

  it('validates a state sent over IPC', () => {
    const ok = startState(5);
    expect(validateCeremonyState(ok, 4)).toEqual(ok);
    expect(() => validateCeremonyState({ ...ok, step: 4 }, 4)).toThrow(/step/);
    expect(() => validateCeremonyState({ ...ok, phase: 'party' }, 4)).toThrow(/phase/);
    expect(() => validateCeremonyState({ ...ok, suspense: 'forever' }, 4)).toThrow(/suspense/);
    expect(() => validateCeremonyState({ ...ok, startedAt: 'now' }, 4)).toThrow(/timing/);
  });
});

describe('lineup and picks in the database and through the API', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pbop-lineup-'));
    db = openDatabase(join(dir, 'app.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function night() {
    const s = createSession(db, { name: 'Night', courtCount: 2, startedAt: '2026-10-21T18:00:00.000Z' });
    const ids = ['Ana', 'Ben', 'Cy', 'Dee'].map((displayName) => addNewPlayerToSession(db, s.id, { displayName }).playerId);
    for (const id of ids) checkInPlayer(db, s.id, id);
    const court = (listCourts(db, s.id)[0] as { id: string }).id;
    const play = (a: number, b: number, scoreA: number, scoreB: number) => {
      const g = createGame(db, { sessionId: s.id, courtId: court, format: 'singles', teamA: [ids[a] as string], teamB: [ids[b] as string] });
      return recordGameResult(db, g.id, { winner: scoreA > scoreB ? 'A' : 'B', scoreA, scoreB });
    };
    return { s, ids, court, play };
  }

  it('persists the lineup as versioned JSON in settings and applies it to the awards', () => {
    const { s, play } = night();
    play(0, 1, 11, 0);
    play(0, 2, 11, 5);
    play(1, 2, 11, 9);
    expect(getAwardLineup(db)).toEqual(defaultLineup());
    const lineup = addToLineup(defaultLineup(), 'shutout_king').lineup;
    lineup.entries = lineup.entries.map((e) => (e.id === 'most_wins' ? { ...e, enabled: false } : e));
    setAwardLineup(db, lineup);
    const stored = raw(db).prepare("SELECT value FROM settings WHERE key = 'awards_lineup'").get() as { value: string };
    expect(JSON.parse(stored.value).version).toBe(1);
    const r = getAwards(db, { kind: 'session', sessionId: s.id });
    expect(r.lineup.map((a) => a.key)).not.toContain('most_wins');
    expect(r.awards.map((a) => a.id)).toContain('most_wins'); // the raw built-ins are unchanged
    expect(r.lineup.find((a) => a.key === 'shutout_king')?.groups.flat().map((w) => w.name)).toEqual(['Ana']);
    expect(() => setAwardLineup(db, { version: 9, entries: [] })).toThrow(/version/);
    raw(db).prepare("UPDATE settings SET value = '{broken' WHERE key = 'awards_lineup'").run();
    expect(getAwardLineup(db)).toEqual(defaultLineup());
  });

  it('keeps host picks per session, checks them against the roster, and clears them with null', () => {
    const { s, ids, play } = night();
    play(0, 1, 11, 3);
    const { lineup, key } = addToLineup(defaultLineup(), 'best_sportsmanship');
    setAwardLineup(db, lineup);
    const scope = { kind: 'session' as const, sessionId: s.id };
    expect(getAwards(db, scope).lineup.find((a) => a.key === key)?.pending).toBe(true);
    setAwardPick(db, scope, key, { winners: [ids[3]], shortlist: [ids[0]], note: 'Kind words' });
    const award = getAwards(db, scope).lineup.find((a) => a.key === key);
    expect(award).toMatchObject({ pending: false, explanation: 'Kind words', groups: [[{ name: 'Dee' }]] });
    expect(getAwards(db, { kind: 'historical' }).lineup.find((a) => a.key === key)?.pending).toBe(true); // other scope, own picks
    expect(() => setAwardPick(db, scope, key, { winners: ['stranger'] })).toThrow(/roster/);
    expect(() => setAwardPick(db, scope, 'champion', { winners: [ids[0]] })).toThrow(/host pick/);
    setAwardPick(db, scope, key, null);
    expect(getAwards(db, scope).lineup.find((a) => a.key === key)?.pending).toBe(true);
  });

  it('feeds rally logs, check-ins and first-timers to the library and recommendations', () => {
    const { s, ids, court, play } = night();
    const g = createGame(db, { sessionId: s.id, courtId: court, format: 'singles', teamA: [ids[0] as string], teamB: [ids[1] as string] });
    startScoring(db, g.id, { firstServingTeam: 'A' });
    for (let i = 0; i < 11; i++) recordScoringEvent(db, g.id, { type: 'rally', winner: 'A' });
    finalizeGame(db, g.id);
    // A result typed over a partial log does not count for rally awards.
    const h = createGame(db, { sessionId: s.id, courtId: court, format: 'singles', teamA: [ids[2] as string], teamB: [ids[3] as string] });
    startScoring(db, h.id, { firstServingTeam: 'A' });
    for (let i = 0; i < 9; i++) recordScoringEvent(db, h.id, { type: 'rally', winner: 'A' });
    recordGameResult(db, h.id, { winner: 'A', scoreA: 11, scoreB: 6 });
    play(1, 2, 11, 9);
    const lib = getAwardLibrary(db, { kind: 'session', sessionId: s.id });
    expect(lib.entries.find((e) => e.id === 'serve_machine')?.preview).toMatchObject({ winners: 'Ana', stat: '11' });
    expect(lib.entries.find((e) => e.id === 'early_bird')?.unavailable).toBeNull();
    const recs = lib.recommendations.map((r) => r.templateId);
    expect(recs).toContain('newcomer'); // everyone is new tonight
    expect(lib.recommendations.find((r) => r.templateId === 'newcomer')?.reason).toBe('4 first-timers tonight');
    expect(getAwards(db, { kind: 'session', sessionId: s.id }).firstTimers).toHaveLength(4);
  });

  function api() {
    const modes: Array<{ mode: DisplayMode; quiet: boolean }> = [];
    const store: DbStore = { current: () => db, close: () => undefined, open: () => undefined };
    const host: HostServices = {
      appVersion: 'test',
      dbFile: join(dir, 'app.db'),
      autoBackupDir: join(dir, 'auto'),
      chooseDirectory: async () => null,
      chooseSaveFile: async () => null,
      chooseOpenFile: async () => null,
      confirm: async () => false,
      openDisplay: () => undefined,
      showOnDisplay: (mode, opts) => modes.push({ mode, quiet: opts?.quiet === true }),
    };
    return { handlers: createApiHandlers(store, host), modes };
  }

  it('exposes the lineup, library and picks through the API with validation', async () => {
    const { s, ids, play } = night();
    play(0, 1, 11, 0);
    const { handlers } = api();
    expect(await handlers.getAwardLineup()).toMatchObject({ ok: true, value: { version: 1 } });
    const added = await handlers.addAwardToLineup('best_sportsmanship');
    expect(added).toMatchObject({ ok: true, value: { key: 'best_sportsmanship' } });
    expect(await handlers.addAwardToLineup('nope')).toMatchObject({ ok: false, code: 'validation' });
    expect(await handlers.setAwardLineup({ version: 1, entries: 'x' })).toMatchObject({ ok: false, code: 'validation' });
    const scope = { kind: 'session', sessionId: s.id };
    expect(await handlers.setAwardPick(scope, 'best_sportsmanship', { winners: [ids[1]] })).toMatchObject({ ok: true });
    expect(await handlers.setAwardPick(scope, 'best_sportsmanship', { winners: ['nobody'] })).toMatchObject({ ok: false, code: 'validation' });
    expect(await handlers.getAwardLibrary({ kind: 'bogus' })).toMatchObject({ ok: false, code: 'validation' });
    const lib = await handlers.getAwardLibrary(scope);
    expect(lib.ok && (lib.value as { entries: unknown[] }).entries.length).toBeGreaterThanOrEqual(25);
    const restored = await handlers.restoreAwardLineup();
    expect(restored.ok && (restored.value as AwardLineup).entries.some((e) => e.key === 'best_sportsmanship')).toBe(true);
  });

  it('mirrors the ceremony on the display: a snapshot on refresh, quiet steps after, then back to the board', async () => {
    const { s, play } = night();
    play(0, 1, 11, 4);
    play(0, 2, 11, 6);
    play(1, 2, 11, 9);
    const { handlers, modes } = api();
    const scope = { kind: 'session', sessionId: s.id };
    const first = startState(1000);
    expect(await handlers.runCeremonyOnDisplay(scope, first, true)).toMatchObject({ ok: true });
    expect(await handlers.runCeremonyOnDisplay(scope, { ...first, step: 1 }, false)).toMatchObject({ ok: true });
    expect(await handlers.runCeremonyOnDisplay(scope, { ...first, step: 0, phase: 'suspense' }, false)).toMatchObject({ ok: false, code: 'validation' });
    expect(await handlers.runCeremonyOnDisplay(scope, { ...first, step: 999 }, false)).toMatchObject({ ok: false, code: 'validation' });
    expect(await handlers.runCeremonyOnDisplay({ kind: 'session', sessionId: 'missing' }, first, true)).toMatchObject({ ok: false });
    expect(modes.map((m) => [m.mode.kind, m.quiet])).toEqual([
      ['ceremony', false],
      ['ceremony', true],
    ]);
    const shown = modes[1]?.mode;
    expect(shown?.kind === 'ceremony' && shown.state.step).toBe(1);
    expect(shown?.kind === 'ceremony' && shown.report.lineup.at(-1)?.templateId).toBe('champion');
    expect(await handlers.endCeremonyOnDisplay(scope)).toMatchObject({ ok: true });
    expect(modes.at(-1)).toEqual({ mode: { kind: 'awards', scope }, quiet: true });
  });
});
