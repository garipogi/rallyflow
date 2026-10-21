/*
 * ============================================================================
 * PHASE 4 PUBLIC API — CSV and XLSX export (pinned by the locked tests).
 * Policies: docs/DECISIONS.md D11 (export columns); brief §6 "Exporting data must not alter source
 * records"; docs/STACK.md (CSV hand-written RFC 4180, XLSX via exceljs). Builds on phase 1–3 APIs
 * and src/data/stats.ts (see ac15.stats-data.test.ts).
 *
 * src/data/export.ts  (read-only on the database: no INSERT/UPDATE/DELETE, no audit rows, no
 *                      pragma changes — the database file stays byte-identical)
 *   type CsvCell = string | number | null
 *   toCsv(rows: readonly (readonly CsvCell[])[]): string
 *       RFC 4180. Records are separated by CRLF (a CRLF after the last record is allowed). A field
 *       containing a comma, double quote, CR or LF is enclosed in double quotes and its double
 *       quotes are doubled. null -> empty field; numbers -> String(n). Text is otherwise written
 *       exactly as given (no trimming). A leading UTF-8 BOM is allowed.
 *   exportCsv(db: Db, opts: { dir: string; sessionId?: string }): string[] | Promise<string[]>
 *       Writes three UTF-8 files into the existing directory `dir` and returns their paths:
 *       sessions.csv, games.csv, player_stats.csv. Without sessionId: every retained session.
 *       With sessionId: only that session (its row, its games, its session-scope stats), plus the
 *       historical stats rows. ValidationError for an unknown session id.
 *   exportXlsx(db: Db, opts: { file: string; sessionId?: string }): Promise<void>
 *       One workbook (exceljs) with sheets named exactly 'Sessions', 'Games', 'Player Stats'.
 *       Row 1 of each sheet holds the same headers as the CSV file; following rows hold the same
 *       records. Numeric columns are numeric cells; text columns are plain string cells; time
 *       columns are ISO strings or Date cells; an empty value is an empty cell.
 *
 *   Columns (D11), in this order:
 *   sessions.csv / 'Sessions':
 *     session_id, name, status, started_at, ended_at, target_score, win_by, court_count
 *   games.csv / 'Games'  (one row per game of any status)
 *     game_id, session_id, session_name, court, format, status, team_a_players, team_b_players,
 *     team_a_player_ids, team_b_player_ids, team_a_score, team_b_score, winner, started_at, ended_at
 *       court = the court label; team_*_players = display names in starting-position order joined
 *       by " / "; team_*_player_ids = player ids joined the same way; winner = 'A' | 'B' | ''.
 *   player_stats.csv / 'Player Stats'
 *     scope, session_id, player_id, player_name, games_played, wins, losses, win_pct, points_for,
 *     points_against, point_diff, rank
 *       scope = 'session' (one row per getSessionStats row of each exported session) or
 *       'historical' (one row per getHistoricalStats row, session_id empty). win_pct is a fraction
 *       0..1 (rounding to >= 3 decimals allowed). rank = the leaderboard rank with the default D9
 *       threshold for that scope (tied players share the number), or the text 'unranked'
 *       (in XLSX a ranked player's rank may be a number cell or its decimal text).
 *   Times: the stored instant (Date.parse of the cell equals Date.parse of the stored value);
 *   empty when the stored value is null.
 * ============================================================================
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import * as ExcelJS from 'exceljs';
import { openDatabase, type Db } from '../../src/data/db';
import { createSession, finishSession, getSession } from '../../src/data/sessions';
import { addNewPlayerToSession, addPlayerToSession, checkInPlayer } from '../../src/data/roster';
import { listCourts } from '../../src/data/courts';
import { createGame, listGames, markGameIncomplete } from '../../src/data/games';
import { ValidationError } from '../../src/data/errors';
import { finalizeGame, recordScoringEvent, startScoring } from '../../src/data/scoring';
import type { GameState, TeamId } from '../../src/core/scoring';
import type { Game, Session } from '../../src/data/types';
import { getHistoricalLeaderboard, getSessionLeaderboard } from '../../src/data/stats';
import { exportCsv, exportXlsx, toCsv } from '../../src/data/export';

const SESSION_COLUMNS = ['session_id', 'name', 'status', 'started_at', 'ended_at', 'target_score', 'win_by', 'court_count'];
const GAME_COLUMNS = [
  'game_id', 'session_id', 'session_name', 'court', 'format', 'status', 'team_a_players', 'team_b_players',
  'team_a_player_ids', 'team_b_player_ids', 'team_a_score', 'team_b_score', 'winner', 'started_at', 'ended_at',
];
const STATS_COLUMNS = [
  'scope', 'session_id', 'player_id', 'player_name', 'games_played', 'wins', 'losses', 'win_pct', 'points_for',
  'points_against', 'point_diff', 'rank',
];
const NUMERIC = new Set([
  'target_score', 'win_by', 'court_count', 'team_a_score', 'team_b_score', 'games_played', 'wins', 'losses',
  'win_pct', 'points_for', 'points_against', 'point_diff',
]);
const TIMES = new Set(['started_at', 'ended_at']);

/** Independent strict RFC 4180 parser (CRLF record separators, quoted fields). */
function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inRecord = false;
  let quoted = false;
  let afterQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else field += ch;
      continue;
    }
    if (afterQuote && ch !== ',' && ch !== '\r') throw new Error(`character after closing quote at ${i}`);
    afterQuote = false;
    if (ch === '"') {
      if (field !== '') throw new Error(`quote inside an unquoted field at ${i}`);
      quoted = true;
      inRecord = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      inRecord = true;
    } else if (ch === '\r') {
      if (text[i + 1] !== '\n') throw new Error(`bare CR at ${i}`);
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      inRecord = false;
      i++;
    } else if (ch === '\n') {
      throw new Error(`bare LF outside quotes at ${i} (records must be separated by CRLF)`);
    } else {
      field += ch;
      inRecord = true;
    }
  }
  if (quoted) throw new Error('unterminated quoted field');
  if (inRecord) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

type Rec = Record<string, string>;

function readCsv(file: string, columns: string[]): Rec[] {
  const rows = parseCsv(readFileSync(file, 'utf8'));
  expect(rows[0]).toEqual(columns);
  return rows.slice(1).map((r) => {
    expect(r).toHaveLength(columns.length);
    return Object.fromEntries(columns.map((c, i) => [c, r[i] as string]));
  });
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

let dir: string;
let dbFile: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbop-p4-export-'));
  dbFile = join(dir, 'app.db');
  db = openDatabase(dbFile);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true });
});

function scorePoint(gameId: string, state: GameState, team: TeamId): GameState {
  let s = state;
  const target = s.score[team] + 1;
  for (let i = 0; i < 10 && s.score[team] < target; i++) s = recordScoringEvent(db, gameId, { type: 'rally', winner: team });
  if (s.score[team] !== target) throw new Error('could not score a point');
  return s;
}

function playGame(sessionId: string, courtId: string, teamA: string[], teamB: string[], finalA: number, finalB: number): Game {
  const game = createGame(db, { sessionId, courtId, format: teamA.length === 2 ? 'doubles' : 'singles', teamA, teamB });
  let s = startScoring(db, game.id, { firstServingTeam: 'A' });
  const [loser, winner]: [TeamId, TeamId] = finalA > finalB ? ['B', 'A'] : ['A', 'B'];
  while (s.score[loser] < (loser === 'A' ? finalA : finalB)) s = scorePoint(game.id, s, loser);
  while (s.score[winner] < (winner === 'A' ? finalA : finalB)) s = scorePoint(game.id, s, winner);
  return finalizeGame(db, game.id);
}

const TRICKY_SESSION = 'Thursday, "late"\nnight';
const NAMES = ['Smith, John', 'Ann "Ace" Lee', 'José Ñúñez', 'Bo'];

interface Fixture {
  s1: Session;
  s2: Session;
  ids: string[]; // player ids in NAMES order
  names: Map<string, string>;
  games1: Game[];
  games2: Game[];
}

/** Two sessions: s1 (tricky name, finished) with 4 finalized games and an incomplete one; s2 (active) with one game. */
function buildFixture(): Fixture {
  const s1 = createSession(db, { name: TRICKY_SESSION, courtCount: 2, startedAt: '2026-10-01T18:00:00.000Z' });
  const c1 = listCourts(db, s1.id);
  const ids = NAMES.map((displayName) => {
    const e = addNewPlayerToSession(db, s1.id, { displayName });
    checkInPlayer(db, s1.id, e.playerId);
    return e.playerId;
  });
  const [a, b, c, d] = ids as [string, string, string, string];
  const court1 = (c1[0] as { id: string }).id;
  const court2 = (c1[1] as { id: string }).id;
  playGame(s1.id, court1, [a, b], [c, d], 11, 4);
  playGame(s1.id, court2, [a, c], [b, d], 9, 11);
  playGame(s1.id, court1, [a, d], [b, c], 11, 7);
  playGame(s1.id, court1, [a], [b], 11, 0);
  const stopped = createGame(db, { sessionId: s1.id, courtId: court2, format: 'singles', teamA: [c], teamB: [d] });
  let st = startScoring(db, stopped.id, { firstServingTeam: 'A' });
  st = scorePoint(stopped.id, st, 'A');
  markGameIncomplete(db, stopped.id, 'injury');
  finishSession(db, s1.id, { endedAt: '2026-10-01T21:30:00.000Z' });

  const s2 = createSession(db, { name: 'Plain', courtCount: 3, targetScore: 15 });
  for (const id of ids) {
    addPlayerToSession(db, s2.id, id);
    checkInPlayer(db, s2.id, id);
  }
  const s2court = (listCourts(db, s2.id)[2] as { id: string }).id;
  playGame(s2.id, s2court, [c, d], [a, b], 15, 13);

  const names = new Map(ids.map((id, i) => [id, NAMES[i] as string]));
  return {
    s1: getSession(db, s1.id) as Session,
    s2: getSession(db, s2.id) as Session,
    ids,
    names,
    games1: listGames(db, s1.id),
    games2: listGames(db, s2.id),
  };
}

function expectSameInstant(cell: string, stored: string | null): void {
  if (stored === null) expect(cell).toBe('');
  else expect(Date.parse(cell)).toBe(Date.parse(stored));
}

function checkGameRow(r: Rec, g: Game, f: Fixture, sessionName: string): void {
  const team = (t: 'A' | 'B') =>
    g.participants.filter((p) => p.team === t).sort((x, y) => x.startingPosition - y.startingPosition).map((p) => p.playerId);
  const courts = listCourts(db, g.sessionId);
  expect(r.session_id).toBe(g.sessionId);
  expect(r.session_name).toBe(sessionName);
  expect(r.court).toBe(courts.find((c) => c.id === g.courtId)?.label);
  expect(r.format).toBe(g.format);
  expect(r.status).toBe(g.status);
  expect(r.team_a_players).toBe(team('A').map((id) => f.names.get(id)).join(' / '));
  expect(r.team_b_players).toBe(team('B').map((id) => f.names.get(id)).join(' / '));
  expect(r.team_a_player_ids).toBe(team('A').join(' / '));
  expect(r.team_b_player_ids).toBe(team('B').join(' / '));
  expect(Number(r.team_a_score)).toBe(g.teamAScore);
  expect(Number(r.team_b_score)).toBe(g.teamBScore);
  expect(r.winner).toBe(g.winner ?? '');
  expectSameInstant(r.started_at as string, g.startedAt);
  expectSameInstant(r.ended_at as string, g.endedAt);
}

describe('AC-14 CSV encoding is RFC 4180', () => {
  it('quotes commas, quotes, CR and LF, doubles embedded quotes and separates records with CRLF', () => {
    const rows = [
      ['plain', 'with,comma', 'with "quote"', 'line\nbreak', 'cr\rhere', 'crlf\r\nboth', '', null, 42, -1.5, ' padded '],
      ['second', 'row', '"', '""', ',', 'Ñúñez ✓', 'x', 'y', 0, 3, 'end'],
    ];
    const text = toCsv(rows);
    expect(parseCsv(text)).toEqual([
      ['plain', 'with,comma', 'with "quote"', 'line\nbreak', 'cr\rhere', 'crlf\r\nboth', '', '', '42', '-1.5', ' padded '],
      ['second', 'row', '"', '""', ',', 'Ñúñez ✓', 'x', 'y', '0', '3', 'end'],
    ]);
    expect(text).toContain('"with,comma"');
    expect(text).toContain('"with ""quote"""');
    expect(text).toContain('"line\nbreak"');
    expect(text).toContain(',"""",""""""');
    // Outside quoted fields, the only line breaks are CRLF record separators.
    const body = text.replace(/^﻿/, '').replace(/\r\n$/, '');
    expect(body.split('\r\n').length).toBeGreaterThanOrEqual(2);
  });

  it('round-trips arbitrary text exactly', () => {
    const nasty = ['', ' ', ',', '"', '\n', '\r\n', 'a,b,"c"', ' lead', 'trail ', 'tab\there', '日本語', 'emoji 🎾', 'x'.repeat(500)];
    const rows = nasty.map((v, i) => [String(i), v, `${v}|${v}`]);
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe('AC-14 CSV export files (D11)', () => {
  it('writes sessions.csv, games.csv and player_stats.csv that parse back to the stored data', async () => {
    const f = buildFixture();
    const out = join(dir, 'csv');
    mkdirSync(out);
    const paths = await exportCsv(db, { dir: out });
    expect(paths.map((p) => basename(p)).sort()).toEqual(['games.csv', 'player_stats.csv', 'sessions.csv']);
    for (const p of paths) expect(existsSync(p)).toBe(true);

    const sessions = readCsv(join(out, 'sessions.csv'), SESSION_COLUMNS);
    expect(sessions).toHaveLength(2);
    const r1 = sessions.find((r) => r.session_id === f.s1.id) as Rec;
    expect(r1.name).toBe(TRICKY_SESSION);
    expect(r1.status).toBe('completed');
    expectSameInstant(r1.started_at as string, f.s1.startedAt);
    expectSameInstant(r1.ended_at as string, f.s1.endedAt);
    expect([Number(r1.target_score), Number(r1.win_by), Number(r1.court_count)]).toEqual([11, 2, 2]);
    const r2 = sessions.find((r) => r.session_id === f.s2.id) as Rec;
    expect(r2).toMatchObject({ name: 'Plain', status: 'active', ended_at: '', target_score: '15', court_count: '3' });

    const games = readCsv(join(out, 'games.csv'), GAME_COLUMNS);
    expect(games).toHaveLength(f.games1.length + f.games2.length);
    expect(new Set(games.map((g) => g.game_id))).toEqual(new Set([...f.games1, ...f.games2].map((g) => g.id)));
    for (const g of f.games1) checkGameRow(games.find((r) => r.game_id === g.id) as Rec, g, f, TRICKY_SESSION);
    for (const g of f.games2) checkGameRow(games.find((r) => r.game_id === g.id) as Rec, g, f, 'Plain');
    const incomplete = games.filter((r) => r.status === 'incomplete');
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]?.winner).toBe('');
    // A name containing a comma and one containing quotes survive inside a joined team cell.
    expect(games.some((r) => r.team_a_players === 'Smith, John / Ann "Ace" Lee')).toBe(true);
  });

  it('player_stats.csv holds session and historical rows matching the leaderboards', async () => {
    const f = buildFixture();
    const out = join(dir, 'csv');
    mkdirSync(out);
    await exportCsv(db, { dir: out });
    const stats = readCsv(join(out, 'player_stats.csv'), STATS_COLUMNS);

    const check = (r: Rec, expected: ReturnType<typeof getSessionLeaderboard>[number]): void => {
      expect(r.player_name).toBe(f.names.get(expected.playerId));
      expect(Number(r.games_played)).toBe(expected.gamesPlayed);
      expect(Number(r.wins)).toBe(expected.wins);
      expect(Number(r.losses)).toBe(expected.losses);
      expect(Math.abs(Number(r.win_pct) - expected.winPct)).toBeLessThan(0.001);
      expect(Number(r.points_for)).toBe(expected.pointsFor);
      expect(Number(r.points_against)).toBe(expected.pointsAgainst);
      expect(Number(r.point_diff)).toBe(expected.pointDiff);
      expect(r.rank).toBe(expected.ranked ? String(expected.rank) : 'unranked');
    };

    for (const s of [f.s1, f.s2]) {
      const board = getSessionLeaderboard(db, s.id);
      const rows = stats.filter((r) => r.scope === 'session' && r.session_id === s.id);
      expect(rows).toHaveLength(board.length);
      for (const b of board) check(rows.find((r) => r.player_id === b.playerId) as Rec, b);
    }
    const hist = getHistoricalLeaderboard(db);
    const histRows = stats.filter((r) => r.scope === 'historical');
    expect(histRows).toHaveLength(hist.length);
    for (const r of histRows) expect(r.session_id).toBe('');
    for (const h of hist) check(histRows.find((r) => r.player_id === h.playerId) as Rec, h);
    expect(stats.every((r) => r.scope === 'session' || r.scope === 'historical')).toBe(true);

    // Concrete values for s1: 'Smith, John' won 3 of 4 finalized games (ranked), the incomplete game is ignored.
    const smith = stats.find((r) => r.scope === 'session' && r.session_id === f.s1.id && r.player_id === f.ids[0]) as Rec;
    expect(smith).toMatchObject({ player_name: 'Smith, John', games_played: '4', wins: '3', losses: '1', rank: '1' });
    // Historical: nobody has 10 games, so everybody is unranked.
    expect(histRows.every((r) => r.rank === 'unranked')).toBe(true);
  });

  it('with a sessionId, exports only that session and its games', async () => {
    const f = buildFixture();
    const out = join(dir, 'one');
    mkdirSync(out);
    await exportCsv(db, { dir: out, sessionId: f.s2.id });
    const sessions = readCsv(join(out, 'sessions.csv'), SESSION_COLUMNS);
    expect(sessions.map((r) => r.session_id)).toEqual([f.s2.id]);
    const games = readCsv(join(out, 'games.csv'), GAME_COLUMNS);
    expect(games.map((r) => r.game_id)).toEqual(f.games2.map((g) => g.id));
    const stats = readCsv(join(out, 'player_stats.csv'), STATS_COLUMNS);
    const sessionRows = stats.filter((r) => r.scope === 'session');
    expect(sessionRows.length).toBeGreaterThan(0);
    expect(sessionRows.every((r) => r.session_id === f.s2.id)).toBe(true);
    expect(stats.some((r) => r.scope === 'historical')).toBe(true);
  });

  it('rejects an unknown session id', async () => {
    buildFixture();
    const out = join(dir, 'bad');
    mkdirSync(out);
    await expect(Promise.resolve().then(() => exportCsv(db, { dir: out, sessionId: 'nope' }))).rejects.toThrow(ValidationError);
  });
});

function cellValue(cell: ExcelJS.CellValue): unknown {
  return cell === undefined ? null : cell;
}

function sheetRecords(ws: ExcelJS.Worksheet, columns: string[]): Record<string, unknown>[] {
  const header = (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1);
  expect(header).toEqual(columns);
  const out: Record<string, unknown>[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (!row.hasValues) continue;
    out.push(Object.fromEntries(columns.map((c, i) => [c, cellValue(row.getCell(i + 1).value)])));
  }
  return out;
}

function asText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

describe('AC-14 XLSX export opens with exceljs (D11)', () => {
  it('has Sessions, Games and Player Stats sheets with the D11 headers and typed cells', async () => {
    const f = buildFixture();
    const file = join(dir, 'results.xlsx');
    await exportXlsx(db, { file });
    expect(existsSync(file)).toBe(true);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual(expect.arrayContaining(['Sessions', 'Games', 'Player Stats']));

    const sessions = sheetRecords(wb.getWorksheet('Sessions') as ExcelJS.Worksheet, SESSION_COLUMNS);
    const games = sheetRecords(wb.getWorksheet('Games') as ExcelJS.Worksheet, GAME_COLUMNS);
    const stats = sheetRecords(wb.getWorksheet('Player Stats') as ExcelJS.Worksheet, STATS_COLUMNS);
    expect(sessions).toHaveLength(2);
    expect(games).toHaveLength(f.games1.length + f.games2.length);

    const s1 = sessions.find((r) => r.session_id === f.s1.id) as Record<string, unknown>;
    expect(s1.name).toBe(TRICKY_SESSION);
    expect(s1.target_score).toBe(11);
    expect(s1.court_count).toBe(2);
    expect(Date.parse(asText(s1.started_at))).toBe(Date.parse(f.s1.startedAt));
    const s2 = sessions.find((r) => r.session_id === f.s2.id) as Record<string, unknown>;
    expect(s2.ended_at === null || s2.ended_at === '').toBe(true);

    for (const g of [...f.games1, ...f.games2]) {
      const r = games.find((x) => x.game_id === g.id) as Record<string, unknown>;
      expect(r).toBeDefined();
      expect(r.team_a_score).toBe(g.teamAScore);
      expect(r.team_b_score).toBe(g.teamBScore);
      expect(r.status).toBe(g.status);
      expect(r.format).toBe(g.format);
      expect(asText(r.winner)).toBe(g.winner ?? '');
      if (g.startedAt) expect(Math.abs(Date.parse(asText(r.started_at)) - Date.parse(g.startedAt))).toBeLessThan(1000);
    }
    expect(games.some((r) => r.team_a_players === 'Smith, John / Ann "Ace" Lee')).toBe(true);

    for (const r of [...sessions, ...games, ...stats]) {
      for (const [k, v] of Object.entries(r)) {
        if (NUMERIC.has(k)) expect(typeof v, `${k} should be a number cell`).toBe('number');
        else if (!TIMES.has(k) && k !== 'rank' && v !== null) expect(typeof v, `${k} should be a string cell`).toBe('string');
      }
    }

    const board = getSessionLeaderboard(db, f.s1.id);
    for (const b of board) {
      const r = stats.find((x) => x.scope === 'session' && x.session_id === f.s1.id && x.player_id === b.playerId) as Record<string, unknown>;
      expect(r).toMatchObject({ player_name: f.names.get(b.playerId), games_played: b.gamesPlayed, wins: b.wins, losses: b.losses, point_diff: b.pointDiff });
      expect(asText(r.rank)).toBe(b.ranked ? String(b.rank) : 'unranked');
      expect(Math.abs((r.win_pct as number) - b.winPct)).toBeLessThan(0.001);
    }
    expect(stats.filter((x) => x.scope === 'historical')).toHaveLength(getHistoricalLeaderboard(db).length);
  });

  it('holds the same records as the CSV export', async () => {
    buildFixture();
    const out = join(dir, 'both');
    mkdirSync(out);
    await exportCsv(db, { dir: out });
    const file = join(out, 'all.xlsx');
    await exportXlsx(db, { file });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const pairs: [string, string, string[]][] = [
      ['sessions.csv', 'Sessions', SESSION_COLUMNS],
      ['games.csv', 'Games', GAME_COLUMNS],
      ['player_stats.csv', 'Player Stats', STATS_COLUMNS],
    ];
    for (const [csvName, sheet, cols] of pairs) {
      const csv = readCsv(join(out, csvName), cols);
      const xlsx = sheetRecords(wb.getWorksheet(sheet) as ExcelJS.Worksheet, cols);
      expect(xlsx).toHaveLength(csv.length);
      csv.forEach((c, i) => {
        const x = xlsx[i] as Record<string, unknown>;
        for (const col of cols) {
          if (TIMES.has(col)) {
            if (c[col] === '') expect(asText(x[col])).toBe('');
            else expect(Math.abs(Date.parse(asText(x[col])) - Date.parse(c[col] as string))).toBeLessThan(1000);
          } else if (col === 'win_pct') {
            expect(Math.abs(Number(x[col]) - Number(c[col]))).toBeLessThan(0.001);
          } else {
            expect(asText(x[col]), `${sheet} row ${i + 2} ${col}`).toBe(c[col]);
          }
        }
      });
    }
  });

  it('with a sessionId, the workbook only holds that session', async () => {
    const f = buildFixture();
    const file = join(dir, 'one.xlsx');
    await exportXlsx(db, { file, sessionId: f.s1.id });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const sessions = sheetRecords(wb.getWorksheet('Sessions') as ExcelJS.Worksheet, SESSION_COLUMNS);
    expect(sessions.map((r) => r.session_id)).toEqual([f.s1.id]);
    const games = sheetRecords(wb.getWorksheet('Games') as ExcelJS.Worksheet, GAME_COLUMNS);
    expect(games.map((r) => r.game_id).sort()).toEqual(f.games1.map((g) => g.id).sort());
  });
});

describe('AC-14 export never alters source records (brief §6 data integrity)', () => {
  it('leaves the database file byte-identical and makes no changes on the connection', async () => {
    const f = buildFixture();
    db.close();
    expect(existsSync(`${dbFile}-wal`) && readFileSync(`${dbFile}-wal`).length > 0).toBe(false);
    const before = sha256(dbFile);

    db = openDatabase(dbFile);
    const conn = db as unknown as BetterSqlite3.Database;
    const changes = (): number => (conn.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const startChanges = changes();
    const out = join(dir, 'ro');
    mkdirSync(out);
    await exportCsv(db, { dir: out });
    await exportCsv(db, { dir: out, sessionId: f.s1.id });
    await exportXlsx(db, { file: join(out, 'a.xlsx') });
    await exportXlsx(db, { file: join(out, 'b.xlsx'), sessionId: f.s2.id });
    expect(changes()).toBe(startChanges);
    db.close();

    expect(sha256(dbFile)).toBe(before);
    expect(readdirSync(dir).filter((n) => n.startsWith('app.db') && n !== 'app.db' && !n.endsWith('-wal') && !n.endsWith('-shm'))).toEqual([]);
    db = openDatabase(dbFile);
    expect(listGames(db, f.s1.id)).toEqual(f.games1);
    expect(getSession(db, f.s1.id)?.status).toBe('completed');
  });
});
