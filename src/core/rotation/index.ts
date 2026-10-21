/** Pure rotation engine: waiting-time queue, recommendations, decline policy (D1-D7, D14). No I/O. */
export * from './types';
export { applyDecline, orderQueue, startNewTurn } from './queue';
export { recommend } from './recommend';
export { catchUpCredits, tieDraw, type ArrivalRecord, type EndedGameRecord } from './fairness';
