import type { Gender, PoolName, QueueEntry, Recommendation, RecommendationResult, RotationSettings, RoundRobinSchedule, TeamUpStyle } from '../core/rotation';
import type { PlayerDetails, PlayerDetailsPatch } from '../data/profiles';
import type { RoundRobinStatus } from '../data/rotation';
import type { GameState, ScoreLog, ScoringEvent, TeamId } from '../core/scoring';
import type { ScoreEntryMode } from '../core/scoring/quickResult';
import type { AwardLibrary, AwardsReport, AwardsScope } from '../data/awards';
import type { AwardLineup, AwardPick, AwardPicks } from '../core/awards/lineup';
import type { CeremonyState } from './ceremony';
import type { BackupManifest } from '../data/backup';
import type { PlayerLeaderboardRow } from '../data/stats';
import type { DisplayModel } from '../core/display';
import type { Appearance } from './themes';
import type { ClubInfo, ClubSettings } from './club';
import type {
  Availability,
  Court,
  Game,
  GameFormat,
  Player,
  CourtStatus,
  RosterEntry,
  Session,
  SessionState,
} from '../data/types';

/** Result envelope so the renderer can show the organizer a message instead of an IPC stack trace. */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string; code: string; matches?: Player[] };

export interface NewSessionInput {
  name: string;
  courtCount: number;
  targetScore?: number;
  /** D15: required to create a 1-court session (small group); without it courts must be 2 to 4. */
  allowSingleCourt?: boolean;
  /** D16: the team-up style to start with; absent = Balanced (D14). */
  teamUp?: TeamUpStyle;
  /** How results are entered on the court cards; absent = rally scoring. */
  scoreEntry?: ScoreEntryMode;
}

/** D15: pass `allowSingleCourt: true` to resize a session down to 1 court. */
export interface CourtCountOptions {
  allowSingleCourt?: boolean;
}

export interface RenamePlayerInput {
  displayName: string;
  nickname?: string | null;
  allowDuplicateName?: boolean;
}

export interface GameResultInput {
  winner: TeamId;
  scoreA?: number;
  scoreB?: number;
  reason?: string;
}

export interface NewRosterPlayerInput {
  displayName: string;
  nickname?: string | null;
  allowDuplicateName?: boolean;
  /** D18: optional skill level (1-8), gender and pool, saved with the new player. */
  skillLevel?: number | null;
  gender?: Gender | null;
  pool?: PoolName | null;
}

export type { PlayerDetails, PlayerDetailsPatch, RoundRobinStatus };

/** Everything the organizer window may ask the main process to do. */
export interface OrganizerApi {
  listSessions(): Promise<ApiResult<Session[]>>;
  findUnfinishedSessions(): Promise<ApiResult<Session[]>>;
  createSession(input: NewSessionInput): Promise<ApiResult<Session>>;
  loadSessionState(sessionId: string): Promise<ApiResult<SessionState>>;
  finishSession(sessionId: string): Promise<ApiResult<Session>>;
  reopenSession(sessionId: string): Promise<ApiResult<Session>>;
  /**
   * Asks the organizer to confirm in a native dialog that names the session (not bypassable from the
   * renderer), then deletes it. `value` is true when deleted, false when the organizer cancelled.
   */
  deleteSession(sessionId: string): Promise<ApiResult<boolean>>;
  setCourtCount(sessionId: string, count: number, opts?: CourtCountOptions): Promise<ApiResult<Court[]>>;
  setCourtStatus(courtId: string, status: CourtStatus): Promise<ApiResult<Court>>;
  listPlayers(): Promise<ApiResult<Player[]>>;
  addExistingPlayer(sessionId: string, playerId: string): Promise<ApiResult<RosterEntry>>;
  addNewPlayer(sessionId: string, input: NewRosterPlayerInput): Promise<ApiResult<RosterEntry>>;
  checkInPlayer(sessionId: string, playerId: string): Promise<ApiResult<RosterEntry>>;
  setAvailability(
    sessionId: string,
    playerId: string,
    availability: Exclude<Availability, 'absent'>,
  ): Promise<ApiResult<RosterEntry>>;
  removePlayer(sessionId: string, playerId: string): Promise<ApiResult<null>>;
  /** Edits a player's name and nickname; the id (and so all history) is unchanged. */
  renamePlayer(playerId: string, input: RenamePlayerInput): Promise<ApiResult<Player>>;
  /** D18: skill level, gender and pool of every player, by player id. */
  listPlayerDetails(): Promise<ApiResult<Record<string, PlayerDetails>>>;
  /** D18: saves a player's skill level, gender and/or pool (absent = unchanged, null = clear). */
  updatePlayerDetails(playerId: string, patch: PlayerDetailsPatch): Promise<ApiResult<PlayerDetails>>;
  startScoring(
    gameId: string,
    opts: { firstServingTeam: TeamId; targetScore?: number; winBy?: number },
  ): Promise<ApiResult<GameState>>;
  recordScoringEvent(gameId: string, event: ScoringEvent): Promise<ApiResult<GameState>>;
  undoLastScoringEvent(gameId: string): Promise<ApiResult<GameState>>;
  correctScoringEvent(gameId: string, index: number, event: ScoringEvent, reason?: string): Promise<ApiResult<GameState>>;
  loadScoreLog(gameId: string): Promise<ApiResult<ScoreLog>>;
  finalizeGame(gameId: string): Promise<ApiResult<Game>>;
  /** Finishes an in-progress game in one step by tagging the winner, optionally with the final score. */
  recordGameResult(gameId: string, input: GameResultInput): Promise<ApiResult<Game>>;
  reopenGame(gameId: string, confirm: boolean, reason?: string): Promise<ApiResult<Game>>;
  /**
   * Takes back a result just recorded (the Undo of the result toast / "Last result" line): reopens the
   * game through reopenGame (audited) and puts the court back in play. `confirm` must be true.
   */
  undoGameResult(gameId: string, confirm: boolean): Promise<ApiResult<Game>>;
  getRotationSettings(sessionId: string): Promise<ApiResult<RotationSettings>>;
  setRotationSettings(sessionId: string, patch: Partial<RotationSettings>): Promise<ApiResult<RotationSettings>>;
  getQueue(sessionId: string): Promise<ApiResult<QueueEntry[]>>;
  recommendNextGames(sessionId: string): Promise<ApiResult<RecommendationResult>>;
  assignRecommendation(sessionId: string, recommendation: Recommendation): Promise<ApiResult<Game>>;
  assignManually(sessionId: string, input: ManualAssignmentInput): Promise<ApiResult<Game>>;
  declineTurn(sessionId: string, playerId: string): Promise<ApiResult<QueueEntry[]>>;
  /** D17: generates (or regenerates) the round-robin schedule for the players and courts here now. */
  generateRoundRobin(sessionId: string, opts?: { rounds?: number }): Promise<ApiResult<RoundRobinSchedule>>;
  /** D17: the schedule, its progress and roster changes since it was made. */
  getRoundRobinStatus(sessionId: string): Promise<ApiResult<RoundRobinStatus>>;
  /** D17: saves the printable schedule shown in the organizer window as a PDF; null when cancelled. */
  saveSchedulePdf(sessionId: string): Promise<ApiResult<string | null>>;
  getSessionLeaderboard(sessionId: string): Promise<ApiResult<PlayerLeaderboardRow[]>>;
  getHistoricalLeaderboard(): Promise<ApiResult<PlayerLeaderboardRow[]>>;
  /** Asks where to save (a folder for CSV, a file for XLSX); `value` is null when the organizer cancels. */
  exportData(format: ExportFormat, sessionId?: string): Promise<ApiResult<ExportOutcome | null>>;
  /** Asks where to save the .pbbackup file; `value` is null when the organizer cancels. */
  createBackup(): Promise<ApiResult<BackupManifest & { file: string } | null>>;
  /**
   * Asks for a .pbbackup file, validates it, then asks the organizer to confirm in a native dialog
   * before the current data is backed up and replaced. `value` is null when cancelled at either step.
   */
  restoreBackup(): Promise<ApiResult<RestoreOutcome | null>>;
  /** Opens the read-only large-screen display for this session, or focuses the one already open. */
  openDisplay(sessionId: string): Promise<ApiResult<null>>;
  /** Awards for one session or all time, from finalized games only. */
  getAwards(scope: AwardsScope): Promise<ApiResult<AwardsReport>>;
  /** Switches the display window to the awards ceremony (opening it if needed). */
  showAwardsOnDisplay(scope: AwardsScope): Promise<ApiResult<null>>;
  /** Switches the display window back to the courts and queue. */
  showCourtsOnDisplay(): Promise<ApiResult<null>>;
  /** Renders the awards ceremony as a 1920x1080 PNG and asks where to save it; null when cancelled. */
  saveAwardsImage(scope: AwardsScope): Promise<ApiResult<string | null>>;
  /** Saves the award certificates shown in the organizer window as a PDF; null when cancelled. */
  saveCertificates(): Promise<ApiResult<string | null>>;
  /** The award lineup (order = ceremony order, names, shown or hidden); global for every session. */
  getAwardLineup(): Promise<ApiResult<AwardLineup>>;
  /** Saves the whole lineup after validation; built-in awards cannot be deleted, only hidden. */
  setAwardLineup(lineup: AwardLineup): Promise<ApiResult<AwardLineup>>;
  /** Shows every built-in award again with its original name and order; added awards are kept. */
  restoreAwardLineup(): Promise<ApiResult<AwardLineup>>;
  /** Adds a library award to the lineup (before the champion); `key` names the new slot. */
  addAwardToLineup(templateId: string): Promise<ApiResult<{ lineup: AwardLineup; key: string }>>;
  /** The award library with live previews for this scope and the recommended awards. */
  getAwardLibrary(scope: AwardsScope): Promise<ApiResult<AwardLibrary>>;
  /** Sets (or clears with null) the host's winner of a manual award for this scope. */
  setAwardPick(scope: AwardsScope, key: string, pick: AwardPick | null): Promise<ApiResult<AwardPicks>>;
  /**
   * Mirrors the ceremony on the display. `refresh` recomputes the awards (first call, or after a
   * manual winner was picked) and opens the display window when it is closed.
   */
  runCeremonyOnDisplay(scope: AwardsScope, state: CeremonyState, refresh?: boolean): Promise<ApiResult<null>>;
  /** Ends the ceremony on the display; it shows the awards board for this scope. */
  endCeremonyOnDisplay(scope: AwardsScope): Promise<ApiResult<null>>;
  /** Light/dark mode and colour theme, shared by the organizer and display windows. */
  getAppearance(): Promise<ApiResult<Appearance>>;
  /** Saves the appearance; both windows (and native dialogs) follow it straight away. */
  setAppearance(appearance: Appearance): Promise<ApiResult<Appearance>>;
  /** The club or group name and tagline for the awards, plus this session's name override (if any). */
  getClub(sessionId?: string | null): Promise<ApiResult<ClubInfo>>;
  /** Saves the club name and tagline (validated, up to 60 / 80 characters; '' clears). */
  setClub(club: ClubSettings): Promise<ApiResult<ClubSettings>>;
  /** Saves (or clears with '') a session's name override for its awards. */
  setSessionClubName(sessionId: string, name: string): Promise<ApiResult<ClubInfo>>;
}

/** Per-court extras for the large screen: when the game started, game point, the last result. */
export interface DisplayCourtExtra {
  startedAt: string | null;
  gamePoint: 'A' | 'B' | null;
  lastResult: { winner: 'A' | 'B'; scoreA: number; scoreB: number; names: string; endedAt: string } | null;
}

/** What the display window polls for. The appearance is always present so the screen follows the theme. */
export interface DisplayPayload {
  appearance: Appearance;
  sessionName: string | null;
  model: DisplayModel | null;
  courtExtras?: Record<string, DisplayCourtExtra>;
  /** The session's scoring mode; winner-only and final-score sessions show teams and a clock, not 0-0. */
  scoreEntry?: ScoreEntryMode;
  /** Present when the organizer put the awards ceremony on the display. */
  awards?: AwardsReport;
  /** Present while the one-award-at-a-time ceremony runs on the display. */
  ceremony?: { report: AwardsReport; state: CeremonyState };
}

/** What the large-screen display shows. Held in main-process memory; opening the display resets it to courts. */
export type DisplayMode =
  | { kind: 'courts' }
  | { kind: 'awards'; scope: AwardsScope }
  | { kind: 'ceremony'; scope: AwardsScope; report: AwardsReport; state: CeremonyState };

export type ExportFormat = 'csv' | 'xlsx';

export interface ExportOutcome {
  files: string[];
}

export interface RestoreOutcome {
  manifest: BackupManifest;
  autoBackupFile: string;
}

/** Organizer override of the queue; the reason is mandatory and is stored in the rotation log. */
export interface ManualAssignmentInput {
  courtId: string;
  format: GameFormat;
  teamA: string[];
  teamB: string[];
  reason: string;
}

export type ApiMethod = keyof OrganizerApi;

export const API_METHODS: readonly ApiMethod[] = [
  'listSessions',
  'findUnfinishedSessions',
  'createSession',
  'loadSessionState',
  'finishSession',
  'reopenSession',
  'deleteSession',
  'setCourtCount',
  'setCourtStatus',
  'listPlayers',
  'addExistingPlayer',
  'addNewPlayer',
  'checkInPlayer',
  'setAvailability',
  'removePlayer',
  'renamePlayer',
  'listPlayerDetails',
  'updatePlayerDetails',
  'startScoring',
  'recordScoringEvent',
  'undoLastScoringEvent',
  'correctScoringEvent',
  'loadScoreLog',
  'finalizeGame',
  'recordGameResult',
  'reopenGame',
  'undoGameResult',
  'getRotationSettings',
  'setRotationSettings',
  'getQueue',
  'recommendNextGames',
  'assignRecommendation',
  'assignManually',
  'declineTurn',
  'generateRoundRobin',
  'getRoundRobinStatus',
  'saveSchedulePdf',
  'getSessionLeaderboard',
  'getHistoricalLeaderboard',
  'exportData',
  'createBackup',
  'restoreBackup',
  'openDisplay',
  'getAwards',
  'showAwardsOnDisplay',
  'showCourtsOnDisplay',
  'saveAwardsImage',
  'saveCertificates',
  'getAwardLineup',
  'setAwardLineup',
  'restoreAwardLineup',
  'addAwardToLineup',
  'getAwardLibrary',
  'setAwardPick',
  'runCeremonyOnDisplay',
  'endCeremonyOnDisplay',
  'getAppearance',
  'setAppearance',
  'getClub',
  'setClub',
  'setSessionClubName',
];
