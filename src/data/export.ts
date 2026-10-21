import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ExcelJS from 'exceljs';
import type { Db } from './db';
import { ValidationError } from './errors';
import { listGames } from './games';
import { getSession, listSessions } from './sessions';
import { raw } from './sqlite';
import { getHistoricalLeaderboard, getSessionLeaderboard, type PlayerLeaderboardRow } from './stats';
import type { Session } from './types';

/**
 * CSV (hand-written RFC 4180) and XLSX (exceljs) export, columns per docs/DECISIONS.md D11.
 * Export only reads: nothing here writes to the database (brief §6).
 */

export type CsvCell = string | number | null;

const SESSION_COLUMNS = ['session_id', 'name', 'status', 'started_at', 'ended_at', 'target_score', 'win_by', 'court_count'] as const;
const GAME_COLUMNS = [
  'game_id', 'session_id', 'session_name', 'court', 'format', 'status', 'team_a_players', 'team_b_players',
  'team_a_player_ids', 'team_b_player_ids', 'team_a_score', 'team_b_score', 'winner', 'started_at', 'ended_at',
] as const;
const STATS_COLUMNS = [
  'scope', 'session_id', 'player_id', 'player_name', 'games_played', 'wins', 'losses', 'win_pct', 'points_for',
  'points_against', 'point_diff', 'rank',
] as const;

/** Columns written as numbers in XLSX (everything else is text). `rank` is numeric only when ranked. */
const NUMERIC_COLUMNS: ReadonlySet<string> = new Set([
  'target_score', 'win_by', 'court_count', 'team_a_score', 'team_b_score', 'games_played', 'wins', 'losses',
  'win_pct', 'points_for', 'points_against', 'point_diff', 'rank',
]);

/** RFC 4180: CRLF between records; fields with comma, quote, CR or LF are quoted, quotes doubled. */
export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  const field = (cell: CsvCell): string => {
    const text = cell === null ? '' : String(cell);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(field).join(',') + '\r\n').join('');
}

interface ExportSheet {
  name: string;
  file: string;
  columns: readonly string[];
  rows: CsvCell[][];
}

function exportSheets(db: Db, sessionId?: string): ExportSheet[] {
  let sessions: Session[];
  if (sessionId === undefined) sessions = listSessions(db);
  else {
    const one = getSession(db, sessionId);
    if (!one) throw new ValidationError(`Unknown session: ${sessionId}`);
    sessions = [one];
  }

  const sqlite = raw(db);
  const playerName = new Map(
    (sqlite.prepare('SELECT id, display_name FROM players').all() as { id: string; display_name: string }[]).map((p) => [p.id, p.display_name]),
  );
  const courtLabel = new Map(
    (sqlite.prepare('SELECT id, label FROM courts').all() as { id: string; label: string }[]).map((c) => [c.id, c.label]),
  );
  const nameOf = (id: string): string => playerName.get(id) ?? id;

  const sessionRows = sessions.map((s): CsvCell[] => [s.id, s.name, s.status, s.startedAt, s.endedAt, s.targetScore, s.winBy, s.courtCount]);

  const gameRows: CsvCell[][] = [];
  for (const s of sessions) {
    for (const g of listGames(db, s.id)) {
      const team = (t: 'A' | 'B'): string[] =>
        g.participants.filter((p) => p.team === t).sort((a, b) => a.startingPosition - b.startingPosition).map((p) => p.playerId);
      const a = team('A');
      const b = team('B');
      gameRows.push([
        g.id, s.id, s.name, courtLabel.get(g.courtId) ?? '', g.format, g.status,
        a.map(nameOf).join(' / '), b.map(nameOf).join(' / '), a.join(' / '), b.join(' / '),
        g.teamAScore, g.teamBScore, g.winner ?? '', g.startedAt, g.endedAt,
      ]);
    }
  }

  const statsRow = (scope: 'session' | 'historical', sid: string, r: PlayerLeaderboardRow): CsvCell[] => [
    scope, sid, r.playerId, r.displayName, r.gamesPlayed, r.wins, r.losses, r.winPct, r.pointsFor, r.pointsAgainst,
    r.pointDiff, r.ranked && r.rank !== null ? r.rank : 'unranked',
  ];
  const statsRows: CsvCell[][] = [];
  for (const s of sessions) for (const r of getSessionLeaderboard(db, s.id)) statsRows.push(statsRow('session', s.id, r));
  for (const r of getHistoricalLeaderboard(db)) statsRows.push(statsRow('historical', '', r));

  return [
    { name: 'Sessions', file: 'sessions.csv', columns: SESSION_COLUMNS, rows: sessionRows },
    { name: 'Games', file: 'games.csv', columns: GAME_COLUMNS, rows: gameRows },
    { name: 'Player Stats', file: 'player_stats.csv', columns: STATS_COLUMNS, rows: statsRows },
  ];
}

/** Writes sessions.csv, games.csv and player_stats.csv into the existing directory `dir`. */
export function exportCsv(db: Db, opts: { dir: string; sessionId?: string }): string[] {
  const sheets = exportSheets(db, opts.sessionId);
  return sheets.map((sheet) => {
    const path = join(opts.dir, sheet.file);
    writeFileSync(path, toCsv([sheet.columns, ...sheet.rows]), 'utf8');
    return path;
  });
}

/** One workbook with the sheets Sessions, Games and Player Stats. */
export async function exportXlsx(db: Db, opts: { file: string; sessionId?: string }): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of exportSheets(db, opts.sessionId)) {
    const ws = workbook.addWorksheet(sheet.name);
    ws.addRow([...sheet.columns]);
    for (const row of sheet.rows) {
      ws.addRow(
        row.map((cell, i) => {
          const column = sheet.columns[i] as string;
          if (cell === null || cell === '') return null;
          return NUMERIC_COLUMNS.has(column) && typeof cell === 'number' ? cell : String(cell);
        }),
      );
    }
    ws.getRow(1).font = { bold: true };
  }
  await workbook.xlsx.writeFile(opts.file);
}
