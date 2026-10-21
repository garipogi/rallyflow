/**
 * The one-award-at-a-time ceremony: steps, phases and timing. Pure, shared by the organizer window
 * (which drives it), the main process (which holds it for the display) and the display window
 * (which mirrors it). Both screens derive every animation from the same phase start timestamp, so
 * they stay in step.
 */
import { seededShuffle, type ShowAward } from '../core/awards/lineup';
import type { AwardWinner } from '../core/awards';

export type CeremonyPhase = 'title' | 'suspense' | 'reveal';
export type SuspenseLength = 'short' | 'medium' | 'long';

export const SUSPENSE_MS: Readonly<Record<SuspenseLength, number>> = { short: 4000, medium: 7000, long: 11000 };
export const SUSPENSE_LENGTHS: readonly SuspenseLength[] = ['short', 'medium', 'long'];

/** How long auto-advance holds each phase before moving on (the suspense uses SUSPENSE_MS). */
export const AUTO_HOLD_MS = { intro: 4500, title: 3800, reveal: 7000, finale: 11000, outro: 0 } as const;

/** Reveal timeline (ms after the reveal starts). */
export const REVEAL_AT = { curtain: 0, name: 450, stat: 900, story: 1500, applause: 2100 } as const;
/** Finale timeline: the podium rises third, second, then first with the champion. */
export const FINALE_AT = { third: 400, second: 2100, first: 3900, story: 5200, applause: 5600 } as const;

export type CeremonyStep = { kind: 'intro' } | { kind: 'award'; key: string; finale: boolean } | { kind: 'outro' };

export interface CeremonyState {
  step: number;
  phase: CeremonyPhase;
  /** Epoch ms when the current phase started (shifted forward by pauses). */
  startedAt: number;
  paused: boolean;
  /** Elapsed ms of the phase at the moment it was paused. */
  pausedElapsed: number;
  suspense: SuspenseLength;
  /** Auto-advance: reveal after the suspense length and move on by itself. */
  auto: boolean;
}

export function buildSteps(awards: ReadonlyArray<Pick<ShowAward, 'key' | 'templateId'>>): CeremonyStep[] {
  return [
    { kind: 'intro' },
    ...awards.map((a): CeremonyStep => ({ kind: 'award', key: a.key, finale: a.templateId === 'champion' })),
    { kind: 'outro' },
  ];
}

export function phasesOf(step: CeremonyStep | undefined): CeremonyPhase[] {
  return step?.kind === 'award' ? ['title', 'suspense', 'reveal'] : ['title'];
}

export function startState(now: number, suspense: SuspenseLength = 'medium', auto = false): CeremonyState {
  return { step: 0, phase: 'title', startedAt: now, paused: false, pausedElapsed: 0, suspense, auto };
}

/** Elapsed ms in the current phase. */
export function phaseElapsed(state: CeremonyState, now: number): number {
  return state.paused ? state.pausedElapsed : Math.max(0, now - state.startedAt);
}

const enter = (state: CeremonyState, step: number, phase: CeremonyPhase, now: number): CeremonyState => ({
  ...state,
  step,
  phase,
  startedAt: now,
  paused: false,
  pausedElapsed: 0,
});

/** Next: title -> suspense -> reveal -> the next award's title. Stays on the last step. */
export function nextState(state: CeremonyState, steps: readonly CeremonyStep[], now: number): CeremonyState {
  const phases = phasesOf(steps[state.step]);
  const i = phases.indexOf(state.phase);
  if (i >= 0 && i < phases.length - 1) return enter(state, state.step, phases[i + 1] as CeremonyPhase, now);
  if (state.step >= steps.length - 1) return state;
  return enter(state, state.step + 1, 'title', now);
}

/** Back: one phase back; from a title, the previous step's last phase. */
export function backState(state: CeremonyState, steps: readonly CeremonyStep[], now: number): CeremonyState {
  const phases = phasesOf(steps[state.step]);
  const i = phases.indexOf(state.phase);
  if (i > 0) return enter(state, state.step, phases[i - 1] as CeremonyPhase, now);
  if (state.step <= 0) return state;
  const prev = phasesOf(steps[state.step - 1]);
  return enter(state, state.step - 1, prev[prev.length - 1] as CeremonyPhase, now);
}

/** Skip suspense: from an award's title or suspense straight to the reveal. */
export function skipToReveal(state: CeremonyState, steps: readonly CeremonyStep[], now: number): CeremonyState {
  if (steps[state.step]?.kind !== 'award' || state.phase === 'reveal') return state;
  return enter(state, state.step, 'reveal', now);
}

/** Jump to the title of any step. */
export function jumpTo(state: CeremonyState, steps: readonly CeremonyStep[], step: number, now: number): CeremonyState {
  if (!Number.isInteger(step) || step < 0 || step >= steps.length) return state;
  return enter(state, step, 'title', now);
}

export function togglePause(state: CeremonyState, now: number): CeremonyState {
  if (state.paused) return { ...state, paused: false, startedAt: now - state.pausedElapsed, pausedElapsed: 0 };
  return { ...state, paused: true, pausedElapsed: phaseElapsed(state, now) };
}

/** When auto-advance should move on from the current phase (ms into it); null = wait for the host. */
export function autoAdvanceAfter(state: CeremonyState, steps: readonly CeremonyStep[]): number | null {
  if (!state.auto) return null;
  const step = steps[state.step];
  if (!step) return null;
  if (step.kind === 'intro') return AUTO_HOLD_MS.intro;
  if (step.kind === 'outro') return null;
  if (state.phase === 'title') return AUTO_HOLD_MS.title;
  if (state.phase === 'suspense') return SUSPENSE_MS[state.suspense];
  return step.finale ? AUTO_HOLD_MS.finale : AUTO_HOLD_MS.reveal;
}

/**
 * The spotlight sweep over the nominees: fast hops that slow down like a slot machine over the
 * suspense length, then a slow sweep while the host builds the moment. Returns the lit nominee.
 */
export function spotlightIndex(elapsed: number, count: number, suspenseMs: number): number {
  if (count <= 1) return 0;
  let t = 0;
  let hop = 0;
  let interval = 70;
  while (t + interval <= elapsed) {
    t += interval;
    hop++;
    interval = t < suspenseMs ? Math.min(700, interval * 1.13) : 900;
    if (hop > 10000) break;
  }
  return hop % count;
}

/** Nominee order on screen: shuffled per award so the winner is not always first. */
export function displayOrder(nominees: readonly AwardWinner[][], key: string): AwardWinner[][] {
  return seededShuffle(nominees, `order:${key}`);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validates a state sent over IPC; throws a plain Error with a friendly message. */
export function validateCeremonyState(value: unknown, stepCount: number): CeremonyState {
  const v = (value ?? {}) as Record<string, unknown>;
  if (!isNum(v.step) || !Number.isInteger(v.step) || v.step < 0 || v.step >= Math.max(1, stepCount)) throw new Error('The ceremony step is not valid.');
  if (v.phase !== 'title' && v.phase !== 'suspense' && v.phase !== 'reveal') throw new Error('The ceremony phase is not valid.');
  if (!isNum(v.startedAt) || !isNum(v.pausedElapsed) || v.pausedElapsed < 0) throw new Error('The ceremony timing is not valid.');
  if (typeof v.paused !== 'boolean' || typeof v.auto !== 'boolean') throw new Error('The ceremony state is not valid.');
  if (v.suspense !== 'short' && v.suspense !== 'medium' && v.suspense !== 'long') throw new Error('Choose a short, medium or long suspense.');
  return { step: v.step, phase: v.phase, startedAt: v.startedAt, paused: v.paused, pausedElapsed: v.pausedElapsed, suspense: v.suspense, auto: v.auto };
}
