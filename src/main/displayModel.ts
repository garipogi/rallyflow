import { buildDisplayModel, type DisplayModel } from '../core/display';
import { stateOf, type GameState } from '../core/scoring';
import type { Db } from '../data/db';
import { getQueue } from '../data/rotation';
import { loadScoreLog } from '../data/scoring';
import { loadSessionState } from '../data/sessions';
import { gamePointTeam } from '../shared/engage';
import type { DisplayCourtExtra } from '../shared/api';

/** Reads the session from the database and projects it for the large-screen display. */
export function readDisplayModel(db: Db, sessionId: string): DisplayModel {
  const { roster, courts, games } = loadSessionState(db, sessionId);
  const names: Record<string, string> = {};
  for (const entry of roster) names[entry.playerId] = entry.player.displayName;

  const active = games.filter((g) => g.status === 'scheduled' || g.status === 'in_progress');
  const stateOfGame = (gameId: string): GameState | null => {
    try {
      return stateOf(loadScoreLog(db, gameId));
    } catch {
      return null; // scoring has not started yet
    }
  };

  return buildDisplayModel({
    courts: courts.map((c) => ({ courtId: c.id, label: c.label, status: c.status })),
    games: active.map((g) => ({
      gameId: g.id,
      courtId: g.courtId,
      format: g.format,
      status: g.status,
      teamA: g.participants.filter((p) => p.team === 'A').sort((a, b) => a.startingPosition - b.startingPosition).map((p) => p.playerId),
      teamB: g.participants.filter((p) => p.team === 'B').sort((a, b) => a.startingPosition - b.startingPosition).map((p) => p.playerId),
      state: stateOfGame(g.id),
    })),
    queue: getQueue(db, sessionId),
    names,
  });
}

/** Extras the large screen uses to feel alive: game clock, game point badge, the last result per court. */
export function readCourtExtras(db: Db, sessionId: string): Record<string, DisplayCourtExtra> {
  const { roster, courts, games } = loadSessionState(db, sessionId);
  const names = new Map(roster.map((e) => [e.playerId, e.player.displayName]));
  const out: Record<string, DisplayCourtExtra> = {};
  for (const court of courts) {
    const active = games.find((g) => g.courtId === court.id && (g.status === 'scheduled' || g.status === 'in_progress'));
    let gamePoint: 'A' | 'B' | null = null;
    if (active) {
      try {
        gamePoint = gamePointTeam(stateOf(loadScoreLog(db, active.id)));
      } catch {
        gamePoint = null; // scoring has not started yet
      }
    }
    const last = games
      .filter((g) => g.courtId === court.id && g.status === 'completed' && g.endedAt !== null && g.winner !== null)
      .sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? ''))
      .at(-1);
    out[court.id] = {
      startedAt: active?.startedAt ?? null,
      gamePoint,
      lastResult:
        last && last.winner
          ? {
              winner: last.winner,
              scoreA: last.teamAScore,
              scoreB: last.teamBScore,
              names: last.participants
                .filter((p) => p.team === last.winner)
                .map((p) => names.get(p.playerId) ?? '')
                .join(' & '),
              endedAt: last.endedAt ?? '',
            }
          : null,
    };
  }
  return out;
}
