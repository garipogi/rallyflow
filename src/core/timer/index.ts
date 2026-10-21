/**
 * Optional game timer (brief §2, §6, AC-18). Pure state machine: time is always an input in epoch
 * milliseconds. Expiry is only a signal to the organizer; nothing here knows about games or scores.
 */

export type TimerStatus = 'idle' | 'running' | 'paused' | 'expired';

export interface TimerState {
  /** Configured length, positive integer milliseconds. */
  readonly durationMs: number;
  readonly status: TimerStatus;
  /** Run time banked by earlier pauses (0 when idle). */
  readonly accumulatedMs: number;
  /** Epoch ms of the current run; null unless running. */
  readonly runningSince: number | null;
}

export class TimerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimerError';
  }
}

function checkDuration(durationMs: number): number {
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new TimerError('The timer length must be a positive whole number of milliseconds.');
  }
  return durationMs;
}

function checkNow(now: number): number {
  if (!Number.isFinite(now)) throw new TimerError('The current time must be a finite number.');
  return now;
}

export function createTimer(durationMs: number): TimerState {
  return { durationMs: checkDuration(durationMs), status: 'idle', accumulatedMs: 0, runningSince: null };
}

export function elapsedMs(timer: TimerState, now: number): number {
  const live = timer.status === 'running' && timer.runningSince !== null ? Math.max(0, now - timer.runningSince) : 0;
  const base = timer.status === 'expired' ? timer.durationMs : timer.accumulatedMs;
  return Math.min(timer.durationMs, Math.max(0, base + live));
}

export function remainingMs(timer: TimerState, now: number): number {
  return timer.durationMs - elapsedMs(timer, now);
}

export function startTimer(timer: TimerState, now: number): TimerState {
  checkNow(now);
  if (timer.status !== 'idle') throw new TimerError(`A ${timer.status} timer cannot be started.`);
  return { ...timer, status: 'running', accumulatedMs: 0, runningSince: now };
}

export function pauseTimer(timer: TimerState, now: number): TimerState {
  checkNow(now);
  if (timer.status !== 'running') throw new TimerError(`A ${timer.status} timer cannot be paused.`);
  const elapsed = elapsedMs(timer, now);
  if (elapsed >= timer.durationMs) return { ...timer, status: 'expired', accumulatedMs: timer.durationMs, runningSince: null };
  return { ...timer, status: 'paused', accumulatedMs: elapsed, runningSince: null };
}

export function resumeTimer(timer: TimerState, now: number): TimerState {
  checkNow(now);
  if (timer.status !== 'paused') throw new TimerError(`A ${timer.status} timer cannot be resumed.`);
  return { ...timer, status: 'running', runningSince: now };
}

export function resetTimer(timer: TimerState, durationMs?: number): TimerState {
  return createTimer(durationMs === undefined ? timer.durationMs : durationMs);
}

export function tick(timer: TimerState, now: number): { timer: TimerState; expired: boolean } {
  checkNow(now);
  if (timer.status === 'running' && elapsedMs(timer, now) >= timer.durationMs) {
    return { timer: { ...timer, status: 'expired', accumulatedMs: timer.durationMs, runningSince: null }, expired: true };
  }
  return { timer, expired: false };
}

/** 'm:ss', rounded up to whole seconds so a countdown never shows 0:00 while time remains. */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
