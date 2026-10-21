export interface Player {
  id: string;
  displayName: string;
  nickname: string | null;
  skillLevel: number | null;
  active: boolean;
}

export type SessionStatus = 'active' | 'completed';

export interface Session {
  id: string;
  name: string;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
  targetScore: number;
  winBy: number;
  scoringMode: 'side_out';
  courtCount: number;
}

export type Availability = 'absent' | 'available' | 'resting' | 'unavailable';

export interface RosterEntry {
  sessionId: string;
  playerId: string;
  player: Player;
  checkedInAt: string | null;
  availability: Availability;
}

export type CourtStatus = 'available' | 'unavailable';

export interface Court {
  id: string;
  sessionId: string;
  label: string;
  status: CourtStatus;
}

export type GameFormat = 'singles' | 'doubles';
export type GameStatus = 'scheduled' | 'in_progress' | 'completed' | 'incomplete' | 'cancelled';

export interface GameParticipant {
  playerId: string;
  team: 'A' | 'B';
  startingPosition: number;
}

export interface Game {
  id: string;
  sessionId: string;
  courtId: string;
  format: GameFormat;
  status: GameStatus;
  teamAScore: number;
  teamBScore: number;
  startedAt: string | null;
  endedAt: string | null;
  winner: 'A' | 'B' | null;
  participants: GameParticipant[];
}

export interface ScoreEvent {
  id: string;
  gameId: string;
  occurredAt: string;
  eventType: string;
  eventData: unknown;
}

export interface AuditEvent {
  id: string;
  sessionId: string;
  occurredAt: string;
  action: string;
  details: unknown;
}

export interface SessionState {
  session: Session;
  roster: RosterEntry[];
  courts: Court[];
  games: Game[];
}

/** columns are listed in index order */
export interface IndexInfo {
  name: string;
  table: string;
  columns: string[];
}
