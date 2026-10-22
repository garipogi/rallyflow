/** Pure rotation engine: waiting-time queue, recommendations, decline policy (D1-D7, D14), team-up styles (D16, D17). No I/O. */
export * from './types';
export { applyDecline, orderQueue, startNewTurn } from './queue';
export { recommend } from './recommend';
export { cyclePlayed, recommendTeamUps, standings, teamUpQueue, TEAM_UP_NAMES, type PlayerStanding, type Stack } from './teamups';
export { catchUpCredits, tieDraw, type ArrivalRecord, type EndedGameRecord } from './fairness';
export {
  challengeSettingsOf,
  poolLabel,
  poolOfPlayer,
  poolSettingsOf,
  recommendAdvanced,
  resolveCourtPools,
  swissRecords,
} from './teamups-advanced';
export {
  defaultRoundRobinRounds,
  gamesPerRound,
  generateRoundRobin,
  MAX_ROUND_ROBIN_ROUNDS,
  roundRobinCoverage,
  type RoundRobinCoverage,
  type RoundRobinRequest,
} from './roundrobin';
