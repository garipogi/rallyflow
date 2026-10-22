/*
 * Scoring modes (Rally scoring / Final score only / Winner only), the quick-result helpers
 * (src/core/scoring/quickResult.ts), the Undo of a recorded result (undoGameResult), the
 * Speed Demon -> Speed Master rename and award recommendations in Winner-only sessions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  alignScoresToWinner,
  checkQuickScore,
  chipScores,
  DEFAULT_SCORE_ENTRY,
  finishWarning,
  isQuickMode,
  isScoreEntryMode,
  parseQuickScore,
  quickChips,
  resultLabel,
  SCORE_ENTRY_GUIDES,
  SCORE_ENTRY_MODES,
  scoreEntryOf,
} from '../../src/core/scoring/quickResult';
import { DEFAULT_ROTATION_SETTINGS } from '../../src/core/rotation';
import { addToLineup, defaultLineup, normalizeLineup, RETIRED_DEFAULT_TITLES, validateLineup } from '../../src/core/awards/lineup';
import { AWARD_TEMPLATES, buildTemplateContext, needsScores, recommendTemplates, templateById, type TemplateGame } from '../../src/core/awards/templates';
import { openDatabase, type Db } from '../../src/data/db';
import { createSession, listAuditEvents } from '../../src/data/sessions';
import { addNewPlayerToSession, checkInPlayer } from '../../src/data/roster';
import { listCourts } from '../../src/data/courts';
import { createGame, getGame } from '../../src/data/games';
import { loadScoreLog, recordGameResult, recordScoringEvent, startScoring, undoGameResult } from '../../src/data/scoring';
import { getRotationSettings, setRotationSettings } from '../../src/data/rotation';
import { getAwardLibrary, getAwardLineup, getAwards, setAwardLineup } from '../../src/data/awards';
import { raw } from '../../src/data/sqlite';
import { createApiHandlers, type DbStore, type HostServices } from '../../src/main/handlers';
import { API_METHODS } from '../../src/shared/api';

const RULES_11 = { targetScore: 11, winBy: 2 };

describe('scoring mode values and defaults', () => {
  it('has three modes; anything missing or unknown means rally scoring', () => {
    expect(SCORE_ENTRY_MODES).toEqual(['rally', 'final_score', 'winner_only']);
    expect(DEFAULT_SCORE_ENTRY).toBe('rally');
    expect(scoreEntryOf(undefined)).toBe('rally');
    expect(scoreEntryOf({})).toBe('rally');
    expect(scoreEntryOf({ scoreEntry: 'nonsense' })).toBe('rally');
    expect(scoreEntryOf({ scoreEntry: 'winner_only' })).toBe('winner_only');
    expect(isScoreEntryMode('final_score')).toBe(true);
    expect(isScoreEntryMode(3)).toBe(false);
    expect(isQuickMode('rally')).toBe(false);
    expect(isQuickMode('final_score')).toBe(true);
    expect(isQuickMode('winner_only')).toBe(true);
    expect(SCORE_ENTRY_GUIDES.map((g) => g.value)).toEqual(SCORE_ENTRY_MODES);
  });

  it('the default rotation settings carry no scoring mode (absent = rally)', () => {
    expect('scoreEntry' in DEFAULT_ROTATION_SETTINGS).toBe(false);
  });
});

describe('quick result helpers', () => {
  it('parses whole scores 0-99 only', () => {
    expect(parseQuickScore('11')).toBe(11);
    expect(parseQuickScore(' 0 ')).toBe(0);
    expect(parseQuickScore('100')).toBeNull();
    expect(parseQuickScore('-1')).toBeNull();
    expect(parseQuickScore('7.5')).toBeNull();
    expect(parseQuickScore('x')).toBeNull();
  });

  it('infers the winner from the higher score', () => {
    expect(checkQuickScore('11', '7', RULES_11)).toEqual({ kind: 'ok', winner: 'A', scoreA: 11, scoreB: 7, warning: null });
    expect(checkQuickScore('4', '11', RULES_11)).toMatchObject({ kind: 'ok', winner: 'B', scoreA: 4, scoreB: 11, warning: null });
  });

  it('empty, incomplete, invalid and tied scores give friendly messages, not errors', () => {
    expect(checkQuickScore('', ' ', RULES_11)).toEqual({ kind: 'empty' });
    expect(checkQuickScore('11', '', RULES_11)).toMatchObject({ kind: 'incomplete' });
    expect(checkQuickScore('11', 'abc', RULES_11)).toMatchObject({ kind: 'invalid', message: expect.stringContaining('whole numbers') });
    const tie = checkQuickScore('9', '9', RULES_11);
    expect(tie).toMatchObject({ kind: 'tie' });
    expect(tie.kind === 'tie' && tie.message).toContain('tied 9–9');
  });

  it('warns gently (never blocks) when the score is not a finished game', () => {
    expect(finishWarning(11, 10, RULES_11)).toBe("11–10 isn't a finished game at win-by-2. Save anyway?");
    expect(finishWarning(9, 7, RULES_11)).toBe('9–7 is below the target of 11. Save anyway?');
    expect(finishWarning(15, 3, RULES_11)).toContain('goes past 11');
    expect(finishWarning(11, 9, RULES_11)).toBeNull();
    expect(finishWarning(13, 11, RULES_11)).toBeNull(); // deuce game
    expect(finishWarning(11, 10, { targetScore: 11, winBy: 1 })).toBeNull();
    const short = checkQuickScore('7', '5', RULES_11);
    expect(short).toMatchObject({ kind: 'ok', winner: 'A', warning: '7–5 is below the target of 11. Save anyway?' });
  });

  it('offers common finishes for the target and maps a chip to the winning team', () => {
    const lows = (target: number) => quickChips({ targetScore: target, winBy: 2 }).map((c) => `${c.high}-${c.low}`);
    expect(lows(11)).toEqual(['11-9', '11-7', '11-5', '11-3']);
    expect(lows(15)).toEqual(['15-13', '15-10', '15-7', '15-4']);
    expect(lows(21)).toEqual(['21-19', '21-13', '21-9', '21-6']);
    for (const c of quickChips({ targetScore: 11, winBy: 2 })) expect(finishWarning(c.high, c.low, RULES_11)).toBeNull();
    expect(chipScores({ high: 11, low: 7 }, 'A')).toEqual({ scoreA: 11, scoreB: 7 });
    expect(chipScores({ high: 11, low: 7 }, 'B')).toEqual({ scoreA: 7, scoreB: 11 });
  });

  it('labels results and aligns typed scores to the tapped winner', () => {
    expect(resultLabel('Tofu & Tabi', 'A', 11, 7)).toBe('Tofu & Tabi 11–7');
    expect(resultLabel('Jake & Yumi', 'B', 7, 11)).toBe('Jake & Yumi 11–7');
    expect(resultLabel('Jake & Yumi', 'B', null, null)).toBe('Jake & Yumi');
    expect(alignScoresToWinner(7, 11, 'A')).toEqual({ scoreA: 11, scoreB: 7 });
    expect(alignScoresToWinner(11, 7, 'A')).toBeNull();
    expect(alignScoresToWinner(5, 5, 'B')).toBeNull();
  });
});

function host(dir: string): HostServices {
  return {
    appVersion: 'test',
    dbFile: join(dir, 'app.db'),
    autoBackupDir: join(dir, 'auto'),
    chooseDirectory: async () => null,
    chooseSaveFile: async () => null,
    chooseOpenFile: async () => null,
    confirm: async () => false,
    openDisplay: () => undefined,
    showOnDisplay: () => undefined,
  };
}

describe('scoring mode storage, undo and awards (database)', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pbop-scoring-modes-'));
    db = openDatabase(join(dir, 'app.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const handlers = () => createApiHandlers({ current: () => db, close: () => undefined, open: () => undefined } satisfies DbStore, host(dir));

  function night(name = 'Night') {
    const s = createSession(db, { name, courtCount: 2, startedAt: '2026-10-21T18:00:00.000Z' });
    const ids = ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay'].map((displayName) => addNewPlayerToSession(db, s.id, { displayName, allowDuplicateName: true }).playerId);
    for (const id of ids) checkInPlayer(db, s.id, id);
    const courts = listCourts(db, s.id).map((c) => c.id);
    const start = (court: number, a: number[], b: number[]) =>
      createGame(db, { sessionId: s.id, courtId: courts[court] as string, format: 'doubles', teamA: a.map((i) => ids[i] as string), teamB: b.map((i) => ids[i] as string) });
    return { s, ids, courts, start };
  }

  it('stores the mode in the session settings JSON, validates it and leaves it absent by default', () => {
    const { s } = night();
    expect(getRotationSettings(db, s.id).scoreEntry).toBeUndefined();
    expect(setRotationSettings(db, s.id, { scoreEntry: 'winner_only' }).scoreEntry).toBe('winner_only');
    const stored = raw(db).prepare('SELECT value FROM settings WHERE key = ?').get(`rotation_settings:${s.id}`) as { value: string };
    expect(JSON.parse(stored.value).scoreEntry).toBe('winner_only');
    expect(() => setRotationSettings(db, s.id, { scoreEntry: 'shouting' as never })).toThrow(/Unknown scoring mode/);
    expect(getRotationSettings(db, s.id).scoreEntry).toBe('winner_only');
    expect(setRotationSettings(db, s.id, { scoreEntry: 'rally' }).scoreEntry).toBe('rally');
  });

  it('createSession takes an optional scoring mode; without one nothing is stored', async () => {
    const h = handlers();
    const plain = await h.createSession({ name: 'Plain', courtCount: 2 });
    const quick = await h.createSession({ name: 'Quick', courtCount: 2, scoreEntry: 'final_score' });
    const bad = await h.createSession({ name: 'Bad', courtCount: 2, scoreEntry: 'nope' });
    expect(plain.ok && quick.ok).toBe(true);
    if (!plain.ok || !quick.ok) return;
    const id = (r: typeof plain) => (r.ok ? (r.value as { id: string }).id : '');
    expect(getRotationSettings(db, id(plain)).scoreEntry).toBeUndefined();
    expect(getRotationSettings(db, id(quick)).scoreEntry).toBe('final_score');
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('Unknown scoring mode') });
    expect(API_METHODS).toContain('undoGameResult');
  });

  it('undo re-opens a quick result through reopenGame, audited, and puts the court back (0-0, no winner)', () => {
    const { s, start } = night();
    const g = start(0, [0, 1], [2, 3]);
    recordGameResult(db, g.id, { winner: 'A', scoreA: 11, scoreB: 7 });
    expect(() => undoGameResult(db, g.id)).toThrow(/confirmation/);
    const back = undoGameResult(db, g.id, { confirm: true });
    expect(back).toMatchObject({ status: 'in_progress', winner: null, endedAt: null, teamAScore: 0, teamBScore: 0 });
    const actions = listAuditEvents(db, s.id).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['game_result_recorded', 'game_reopened', 'game_result_undone']));
    const reopened = listAuditEvents(db, s.id).find((a) => a.action === 'game_reopened');
    expect(reopened?.details).toMatchObject({ gameId: g.id, reason: 'Undo result' });
    const undone = listAuditEvents(db, s.id).find((a) => a.action === 'game_result_undone');
    expect(undone?.details).toMatchObject({ gameId: g.id, undone: { winner: 'A', scoreA: 11, scoreB: 7 } });
    // a completed game only
    expect(() => undoGameResult(db, g.id, { confirm: true })).toThrow(/Only a completed game/);
  });

  it('undo keeps the rally score when rally scoring had started', () => {
    const { start } = night();
    const g = start(0, [0, 1], [2, 3]);
    startScoring(db, g.id, { firstServingTeam: 'A' });
    recordScoringEvent(db, g.id, { type: 'rally', winner: 'A' });
    recordScoringEvent(db, g.id, { type: 'rally', winner: 'A' });
    recordGameResult(db, g.id, { winner: 'B' });
    const back = undoGameResult(db, g.id, { confirm: true });
    expect(back).toMatchObject({ status: 'in_progress', teamAScore: 2, teamBScore: 0 });
    expect(loadScoreLog(db, g.id).events).toHaveLength(2);
  });

  it('undo is refused once the court or a player is in a newer game', () => {
    const { start } = night();
    const g = start(0, [0, 1], [2, 3]);
    recordGameResult(db, g.id, { winner: 'A' });
    const next = start(0, [4, 5], [2, 3]);
    expect(() => undoGameResult(db, g.id, { confirm: true })).toThrow(/court already has a new game/);
    recordGameResult(db, next.id, { winner: 'A' });
    const elsewhere = start(1, [0, 4], [5, 2]);
    expect(() => undoGameResult(db, g.id, { confirm: true })).toThrow(/player from this game/);
    expect(getGame(db, g.id)?.status).toBe('completed');
    expect(elsewhere.status).toBe('in_progress');
  });

  it('undo works through the API with an explicit confirm', async () => {
    const { start } = night();
    const g = start(0, [0, 1], [2, 3]);
    recordGameResult(db, g.id, { winner: 'B' });
    const h = handlers();
    expect(await h.undoGameResult(g.id, false)).toMatchObject({ ok: false });
    expect(await h.undoGameResult(g.id, true)).toMatchObject({ ok: true, value: { status: 'in_progress' } });
  });

  it('awards report the scoring mode and recommendations favour no-score awards in Winner-only sessions', () => {
    const { s, start } = night();
    setRotationSettings(db, s.id, { scoreEntry: 'winner_only' });
    for (const [a, b, w] of [
      [[0, 1], [2, 3], 'A'],
      [[4, 5], [0, 2], 'B'],
      [[1, 3], [4, 5], 'A'],
    ] as const) {
      const g = start(0, [...a], [...b]);
      recordGameResult(db, g.id, { winner: w });
    }
    const scope = { kind: 'session', sessionId: s.id } as const;
    expect(getAwards(db, scope).scoreEntry).toBe('winner_only');
    const lib = getAwardLibrary(db, scope);
    expect(lib.scoreEntry).toBe('winner_only');
    expect(lib.recommendations.length).toBeGreaterThan(0);
    for (const r of lib.recommendations) expect(needsScores(templateById(r.templateId) as NonNullable<ReturnType<typeof templateById>>)).toBe(false);
    expect(getAwards(db, { kind: 'historical' }).scoreEntry).toBeNull();
  });
});

describe('recommendTemplates with preferScoreless', () => {
  it('ranks score-based awards after every award that works without scores', () => {
    const t = (n: number) => `2026-10-21T18:${String(n).padStart(2, '0')}:00.000Z`;
    const games: TemplateGame[] = [];
    const pairs: Array<[string[], string[], 'A' | 'B', number, number]> = [
      [['a', 'b'], ['c', 'd'], 'A', 11, 0],
      [['a', 'c'], ['b', 'd'], 'A', 11, 10],
      [['a', 'd'], ['b', 'c'], 'B', 12, 14],
      [['a', 'b'], ['c', 'd'], 'A', 11, 9],
    ];
    pairs.forEach(([A, B, winner, sa, sb], i) =>
      games.push({
        id: `g${i}`,
        sessionId: 's',
        format: 'doubles',
        status: 'completed',
        teamAScore: sa,
        teamBScore: sb,
        winner,
        startedAt: t(i * 10),
        endedAt: t(i * 10 + 8),
        scoreless: false,
        participants: [...A.map((playerId) => ({ playerId, team: 'A' as const })), ...B.map((playerId) => ({ playerId, team: 'B' as const }))],
      }),
    );
    const ctx = buildTemplateContext({ scope: 'session', games, names: { a: 'Ana', b: 'Ben', c: 'Cy', d: 'Dee' }, checkIns: [], firstTimers: [] });
    const all = recommendTemplates(ctx, new Set(), 50);
    const preferred = recommendTemplates(ctx, new Set(), 50, { preferScoreless: true });
    expect(preferred.map((r) => r.templateId).sort()).toEqual(all.map((r) => r.templateId).sort());
    const scored = preferred.map((r) => needsScores(templateById(r.templateId) as NonNullable<ReturnType<typeof templateById>>));
    expect(scored).toContain(true);
    expect(scored).toContain(false);
    expect(scored.indexOf(true)).toBeGreaterThan(scored.lastIndexOf(false));
  });
});

describe('Speed Demon is now Speed Master', () => {
  it('keeps the template id and changes the default title', () => {
    const t = templateById('speed_demon');
    expect(t?.title).toBe('Speed Master');
    expect(AWARD_TEMPLATES.some((x) => x.title === 'Speed Demon')).toBe(false);
    expect(RETIRED_DEFAULT_TITLES.speed_demon).toEqual(['Speed Demon']);
  });

  it('a stored lineup with the old default title picks up the new one; custom titles stay', () => {
    const base = addToLineup(defaultLineup(), 'speed_demon');
    const withOld = { ...base.lineup, entries: base.lineup.entries.map((e) => (e.key === base.key ? { ...e, title: 'Speed Demon' } : e)) };
    const read = normalizeLineup(JSON.parse(JSON.stringify(withOld)));
    expect(read.entries.find((e) => e.key === base.key)?.title).toBeUndefined();
    const withCustom = { ...base.lineup, entries: base.lineup.entries.map((e) => (e.key === base.key ? { ...e, title: 'Lightning Lap' } : e)) };
    expect(normalizeLineup(withCustom).entries.find((e) => e.key === base.key)?.title).toBe('Lightning Lap');
    // an organizer can still save the old words on purpose through validation
    expect(validateLineup(withOld).entries.find((e) => e.key === base.key)?.title).toBe('Speed Demon');
  });

  it('existing stored lineups in the database show Speed Master in the awards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pbop-speed-'));
    const db = openDatabase(join(dir, 'app.db'));
    try {
      const base = addToLineup(defaultLineup(), 'speed_demon');
      const old = { ...base.lineup, entries: base.lineup.entries.map((e) => (e.key === base.key ? { ...e, title: 'Speed Demon' } : e)) };
      raw(db).prepare("INSERT INTO settings (key, value) VALUES ('awards_lineup', ?)").run(JSON.stringify(old));
      expect(getAwardLineup(db).entries.find((e) => e.key === base.key)?.title).toBeUndefined();
      setAwardLineup(db, { ...old, entries: old.entries.map((e) => (e.key === base.key ? { ...e, title: 'Zoomer' } : e)) });
      expect(getAwardLineup(db).entries.find((e) => e.key === base.key)?.title).toBe('Zoomer');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
