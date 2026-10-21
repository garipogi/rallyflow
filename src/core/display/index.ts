/**
 * Large-screen display model (brief §3, §4, AC-19). A read-only projection of the session state: the
 * display window renders this and nothing organizer-only.
 */
import type { GameState, TeamId } from '../scoring';

export type DisplayCourtStatus = 'available' | 'unavailable' | 'in_use';

export interface DisplayInput {
  courts: ReadonlyArray<{ courtId: string; label: string; status: 'available' | 'unavailable' }>;
  games: ReadonlyArray<{
    gameId: string;
    courtId: string;
    format: 'singles' | 'doubles';
    status: 'scheduled' | 'in_progress' | 'completed' | 'incomplete' | 'cancelled';
    teamA: readonly string[];
    teamB: readonly string[];
    state: GameState | null;
  }>;
  queue: ReadonlyArray<{ playerId: string; displayName: string; position: number }>;
  names: Readonly<Record<string, string>>;
}

export interface DisplayPlayer {
  playerId: string;
  name: string;
}

export interface DisplayTeam {
  players: DisplayPlayer[];
  score: number;
}

export interface DisplayGame {
  gameId: string;
  format: 'singles' | 'doubles';
  started: boolean;
  teamA: DisplayTeam;
  teamB: DisplayTeam;
  servingTeam: TeamId | null;
  serverNumber: 1 | 2 | null;
  calledScore: string | null;
  isOver: boolean;
  winner: TeamId | null;
}

export interface DisplayCourt {
  courtId: string;
  label: string;
  status: DisplayCourtStatus;
  game: DisplayGame | null;
}

export interface DisplayModel {
  courts: DisplayCourt[];
  queue: Array<{ position: number; playerId: string; name: string }>;
}

type InputGame = DisplayInput['games'][number];

const isActive = (g: InputGame): boolean => g.status === 'scheduled' || g.status === 'in_progress';

export function buildDisplayModel(input: DisplayInput): DisplayModel {
  const nameOf = (id: string): string => input.names[id] ?? id;
  const team = (ids: readonly string[], score: number): DisplayTeam => ({
    players: ids.map((playerId) => ({ playerId, name: nameOf(playerId) })),
    score,
  });

  const courts = input.courts.map((court): DisplayCourt => {
    const g = input.games.find((x) => x.courtId === court.courtId && isActive(x));
    if (!g) return { courtId: court.courtId, label: court.label, status: court.status, game: null };
    const s = g.state;
    const game: DisplayGame = {
      gameId: g.gameId,
      format: g.format,
      started: s !== null,
      teamA: team(g.teamA, s?.score.A ?? 0),
      teamB: team(g.teamB, s?.score.B ?? 0),
      servingTeam: s?.servingTeam ?? null,
      serverNumber: s?.serverNumber ?? null,
      calledScore: s && !s.isOver ? s.calledScore : null,
      isOver: s?.isOver ?? false,
      winner: s?.winner ?? null,
    };
    return { courtId: court.courtId, label: court.label, status: 'in_use', game };
  });

  const queue = input.queue
    .map((q) => ({ position: q.position, playerId: q.playerId, name: input.names[q.playerId] ?? q.displayName }))
    .sort((a, b) => a.position - b.position);

  return { courts, queue };
}
