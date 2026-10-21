/**
 * Pure scoring engine for pickleball open play (no I/O, no imports from data/main/renderer).
 *
 * Rules edition: docs/RULES.md (decision D8). Rule numbers in comments are 2026 numbers.
 * The engine is a reducer, state' = applyEvent(state, event); a game is fully described by its
 * setup plus the ordered list of scoring events, so replaying the events reproduces the state.
 */

/** Must equal the "Edition:" line of docs/RULES.md. A later edition is a deliberate change (brief §11). */
export const RULES_EDITION = '2026 USA Pickleball Official Rulebook';

export type TeamId = 'A' | 'B';
export type CourtSide = 'right' | 'left';

export interface GameSetup {
  format: 'singles' | 'doubles';
  /** Player ids. Index 0 is the team's starting server (Rule 5.B.3). */
  teamA: readonly string[];
  teamB: readonly string[];
  firstServingTeam: TeamId;
  /** Game target: 11, 15, 21 or any positive integer. Default 11 (Rule 15.C.1). */
  targetScore?: number;
  /** Required winning margin. Default 2 (Rule 15.C). */
  winBy?: number;
}

export type ScoringEvent =
  | { type: 'rally'; winner: TeamId }
  | { type: 'fault'; against: TeamId; rule?: string };

export interface GameState {
  format: 'singles' | 'doubles';
  targetScore: number;
  winBy: number;
  score: { A: number; B: number };
  servingTeam: TeamId;
  receivingTeam: TeamId;
  /** Null in singles (Rule 5.A.3). */
  serverNumber: 1 | 2 | null;
  serverId: string;
  receiverId: string;
  serverSide: CourtSide;
  positions: Record<string, CourtSide>;
  /** Rule 6.B: "S-R" in singles, "S-R-N" in doubles. Not meaningful once the game is over (Q7). */
  calledScore: string;
  isOver: boolean;
  winner: TeamId | null;
  rallies: number;
  /** Players per team in setup order, kept so the reducer needs nothing but the state. */
  teams: { A: readonly string[]; B: readonly string[] };
}

export interface ScoreLog {
  readonly setup: GameSetup;
  readonly events: readonly ScoringEvent[];
}

export class ScoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoringError';
  }
}

const DEFAULT_TARGET = 11;
const DEFAULT_WIN_BY = 2;

const isTeam = (v: unknown): v is TeamId => v === 'A' || v === 'B';
const other = (t: TeamId): TeamId => (t === 'A' ? 'B' : 'A');
const sideForScore = (score: number): CourtSide => (score % 2 === 0 ? 'right' : 'left');
const opposite = (s: CourtSide): CourtSide => (s === 'right' ? 'left' : 'right');

function validateSetup(setup: GameSetup): { target: number; winBy: number } {
  if (!setup || (setup.format !== 'singles' && setup.format !== 'doubles')) {
    throw new ScoringError('The game format must be singles or doubles.');
  }
  const size = setup.format === 'doubles' ? 2 : 1;
  for (const team of [setup.teamA, setup.teamB]) {
    if (!Array.isArray(team) || team.length !== size || team.some((p) => typeof p !== 'string' || p === '')) {
      throw new ScoringError(`A ${setup.format} game needs ${size} player(s) per team.`);
    }
  }
  const everyone = [...setup.teamA, ...setup.teamB];
  if (new Set(everyone).size !== everyone.length) throw new ScoringError('A player cannot appear twice in a game.');
  if (!isTeam(setup.firstServingTeam)) throw new ScoringError('The first serving team must be A or B.');
  const target = setup.targetScore ?? DEFAULT_TARGET;
  const winBy = setup.winBy ?? DEFAULT_WIN_BY;
  if (!Number.isInteger(target) || target < 1) throw new ScoringError('The target score must be a positive whole number.');
  if (!Number.isInteger(winBy) || winBy < 1) throw new ScoringError('The win-by margin must be a positive whole number.');
  return { target, winBy };
}

/** Rebuilds everything that follows from who serves and the two scores (Rules 5.A.1, 5.B.3, 7.E, 6.B). */
function layout(
  format: 'singles' | 'doubles',
  teams: { A: readonly string[]; B: readonly string[] },
  score: { A: number; B: number },
  servingTeam: TeamId,
  serverId: string,
  serverNumber: 1 | 2 | null,
): Pick<GameState, 'positions' | 'serverSide' | 'receiverId' | 'calledScore' | 'receivingTeam'> {
  const receivingTeam = other(servingTeam);
  const positions: Record<string, CourtSide> = {};
  if (format === 'singles') {
    // Rule 5.A.1: the SERVER's score places both server and receiver.
    const side = sideForScore(score[servingTeam]);
    positions[teams.A[0] as string] = side;
    positions[teams.B[0] as string] = side;
  } else {
    // Rule 5.B.3: the starting server is on the right when the team score is even, partner opposite.
    for (const t of ['A', 'B'] as const) {
      const [starter, partner] = teams[t] as [string, string];
      const side = sideForScore(score[t]);
      positions[starter] = side;
      positions[partner] = opposite(side);
    }
  }
  const serverSide = positions[serverId] as CourtSide;
  // Rule 7.E: serve goes diagonally, to the receiver standing on the same side label.
  const receiverId = teams[receivingTeam].find((p) => positions[p] === serverSide) as string;
  const base = `${score[servingTeam]}-${score[receivingTeam]}`;
  const calledScore = serverNumber === null ? base : `${base}-${serverNumber}`;
  return { positions, serverSide, receiverId, calledScore, receivingTeam };
}

export function initialState(setup: GameSetup): GameState {
  const { target, winBy } = validateSetup(setup);
  const teams = { A: [...setup.teamA], B: [...setup.teamB] };
  const score = { A: 0, B: 0 };
  const servingTeam = setup.firstServingTeam;
  const serverId = teams[servingTeam][0] as string;
  // Rule 5.B / 5.B.2: at the start of a doubles game the starting server is the second server.
  const serverNumber = setup.format === 'doubles' ? 2 : null;
  return {
    format: setup.format,
    targetScore: target,
    winBy,
    score,
    servingTeam,
    serverNumber,
    serverId,
    isOver: false,
    winner: null,
    rallies: 0,
    teams,
    ...layout(setup.format, teams, score, servingTeam, serverId, serverNumber),
  };
}

/** The team that won the rally; a fault is the loss of the rally (Rule 2, 9.B). */
function rallyWinner(event: ScoringEvent): TeamId {
  const e = event as { type?: unknown; winner?: unknown; against?: unknown };
  if (e && e.type === 'rally' && isTeam(e.winner)) return e.winner;
  if (e && e.type === 'fault' && isTeam(e.against)) return other(e.against);
  throw new ScoringError('That is not a valid scoring event.');
}

export function applyEvent(state: GameState, event: ScoringEvent): GameState {
  const winner = rallyWinner(event);
  if (state.isOver) throw new ScoringError('The game is over; no more rallies can be played.');
  const rallies = state.rallies + 1;

  if (winner === state.servingTeam) {
    // Rule 4.A: only the serving side scores, and the same server keeps serving.
    const score = { ...state.score, [winner]: state.score[winner] + 1 };
    const lead = score[winner] - score[other(winner)];
    // Rule 4.B / 15.C: the winning point reaches the target with the required margin.
    const isOver = score[winner] >= state.targetScore && lead >= state.winBy;
    return {
      ...state,
      score,
      rallies,
      isOver,
      winner: isOver ? winner : null,
      ...layout(state.format, state.teams, score, state.servingTeam, state.serverId, state.serverNumber),
    };
  }

  // The receiving side won the rally: no point.
  if (state.format === 'doubles' && state.serverNumber === 1) {
    // Rule 5.B.5: the first server lost the rally, so the partner serves as second server.
    const [first, second] = state.teams[state.servingTeam] as [string, string];
    const serverId = state.serverId === first ? second : first;
    return { ...state, rallies, serverNumber: 2, serverId, ...layout(state.format, state.teams, state.score, state.servingTeam, serverId, 2) };
  }
  // Rules 5.A.3 / 5.B.6: side out. The serve passes to the other team.
  const servingTeam = other(state.servingTeam);
  let serverId: string;
  let serverNumber: 1 | 2 | null = null;
  if (state.format === 'singles') {
    serverId = state.teams[servingTeam][0] as string;
  } else {
    // Rule 5.B.2: the player on the right for the new serving team's score is first server.
    const wantRight = sideForScore(state.score[servingTeam]);
    const [starter, partner] = state.teams[servingTeam] as [string, string];
    // The starter is on `wantRight`'s side when the score is even, so the right-hand player is whoever
    // the layout puts on 'right'.
    serverId = wantRight === 'right' ? starter : partner;
    serverNumber = 1;
  }
  return { ...state, rallies, servingTeam, serverNumber, serverId, ...layout(state.format, state.teams, state.score, servingTeam, serverId, serverNumber) };
}

export function replay(setup: GameSetup, events: readonly ScoringEvent[]): GameState {
  return events.reduce(applyEvent, initialState(setup));
}

export function startLog(setup: GameSetup): ScoreLog {
  validateSetup(setup);
  return { setup, events: [] };
}

export function record(log: ScoreLog, event: ScoringEvent): ScoreLog {
  // Applying the event to the current state rejects anything illegal before the log grows.
  applyEvent(stateOf(log), event);
  return { setup: log.setup, events: [...log.events, event] };
}

export function undo(log: ScoreLog): ScoreLog {
  if (log.events.length === 0) throw new ScoringError('There is nothing to undo.');
  return { setup: log.setup, events: log.events.slice(0, -1) };
}

/** Replaces events[index]; every later event is replayed and must still be legal. */
export function correct(log: ScoreLog, index: number, event: ScoringEvent): ScoreLog {
  if (!Number.isInteger(index) || index < 0 || index >= log.events.length) {
    throw new ScoringError('There is no such event to correct.');
  }
  rallyWinner(event);
  const events = log.events.map((e, i) => (i === index ? event : e));
  replay(log.setup, events);
  return { setup: log.setup, events };
}

export function stateOf(log: ScoreLog): GameState {
  return replay(log.setup, log.events);
}
