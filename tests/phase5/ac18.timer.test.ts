/*
 * ============================================================================
 * PHASE 5 PUBLIC API — optional game timer (brief §2 "Game timer: optional, organizer-controlled",
 * §3 P1, §6 Scoring rules: "Timer expiration does not automatically declare a winner or finalize a
 * game", §9 AC-18 "The optional timer works independently of score completion").
 *
 * src/core/timer/index.ts   (pure: no I/O, no Date.now()/new Date()/setTimeout for "now"; time is
 *                            always an input in epoch milliseconds (fake clock). Must NOT import from
 *                            src/core/scoring, src/data, src/main, src/renderer, node:* or electron.)
 *
 *   type TimerStatus = 'idle' | 'running' | 'paused' | 'expired'
 *   interface TimerState {                  exactly these four fields (plain data, serialisable)
 *     readonly durationMs: number;          configured length, positive integer ms
 *     readonly status: TimerStatus;
 *     readonly accumulatedMs: number;       run time banked by earlier pauses (0 when idle)
 *     readonly runningSince: number | null; epoch ms of the current run; null unless 'running'
 *   }
 *   class TimerError extends Error          invalid duration, non-finite `now`, illegal transition
 *
 *   createTimer(durationMs: number): TimerState
 *       idle, accumulatedMs 0, runningSince null. durationMs must be a positive integer, else TimerError.
 *   startTimer(t, now): TimerState          idle -> running (runningSince = now). Any other status: TimerError.
 *   pauseTimer(t, now): TimerState          running -> paused, banking the run time. If the duration has
 *                                           already elapsed at `now`, the result is 'expired' instead.
 *                                           Any other status: TimerError.
 *   resumeTimer(t, now): TimerState         paused -> running from where it stopped. Other: TimerError.
 *   resetTimer(t, durationMs?): TimerState  any status -> idle with 0 elapsed; optional new duration
 *                                           (validated like createTimer). Keeps the old duration if omitted.
 *   elapsedMs(t, now): number               run time so far, clamped to [0, durationMs]. Never negative
 *                                           even if `now` is earlier than runningSince (clock went back).
 *   remainingMs(t, now): number             durationMs - elapsedMs(t, now)  (so 0 when expired)
 *   tick(t, now): { timer: TimerState; expired: boolean }
 *       If running and the duration has elapsed at `now`: timer becomes 'expired' and expired === true
 *       (the signal fires exactly once). Otherwise the timer is returned unchanged and expired === false.
 *       Expiry is only a signal: the result carries nothing about games, winners or finalization.
 *   formatClock(ms: number): string         'm:ss', rounding UP to whole seconds (a countdown never
 *                                           shows 0:00 while time remains): 0 -> '0:00', 1 -> '0:01',
 *                                           59001 -> '1:00', 61000 -> '1:01', 600000 -> '10:00'.
 *
 * Every function returns a new object and never mutates its input.
 * ============================================================================
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as timerModule from '../../src/core/timer';
import {
  TimerError,
  createTimer,
  elapsedMs,
  formatClock,
  pauseTimer,
  remainingMs,
  resetTimer,
  resumeTimer,
  startTimer,
  tick,
  type TimerState,
} from '../../src/core/timer';

const T0 = Date.UTC(2026, 9, 21, 18, 0, 0);
const MIN = 60_000;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe('AC-18 timer: creation and validation', () => {
  it('creates an idle timer with the configured duration and nothing elapsed', () => {
    const t = createTimer(12 * MIN);
    expect(t).toEqual({ durationMs: 12 * MIN, status: 'idle', accumulatedMs: 0, runningSince: null });
    expect(elapsedMs(t, T0)).toBe(0);
    expect(remainingMs(t, T0)).toBe(12 * MIN);
  });

  it('has exactly the four pinned fields (no game, score or winner data)', () => {
    expect(Object.keys(createTimer(MIN)).sort()).toEqual(['accumulatedMs', 'durationMs', 'runningSince', 'status']);
  });

  it.each([0, -1000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects duration %s', (d) => {
    expect(() => createTimer(d)).toThrow(TimerError);
  });

  it('TimerError is an Error subclass', () => {
    let caught: unknown;
    try {
      createTimer(0);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TimerError);
    expect(caught).toBeInstanceOf(Error);
  });
});

describe('AC-18 timer: start / pause / resume with a fake clock', () => {
  it('counts down only while running', () => {
    const t = startTimer(createTimer(10 * MIN), T0);
    expect(t.status).toBe('running');
    expect(t.runningSince).toBe(T0);
    expect(elapsedMs(t, T0 + 90_000)).toBe(90_000);
    expect(remainingMs(t, T0 + 90_000)).toBe(10 * MIN - 90_000);
  });

  it('a paused timer does not advance however much time passes', () => {
    const running = startTimer(createTimer(10 * MIN), T0);
    const paused = pauseTimer(running, T0 + 2 * MIN);
    expect(paused.status).toBe('paused');
    expect(paused.runningSince).toBeNull();
    expect(paused.accumulatedMs).toBe(2 * MIN);
    expect(elapsedMs(paused, T0 + 2 * MIN)).toBe(2 * MIN);
    expect(elapsedMs(paused, T0 + 500 * MIN)).toBe(2 * MIN);
    expect(tick(paused, T0 + 500 * MIN)).toEqual({ timer: paused, expired: false });
  });

  it('resume continues from where it was paused, across several pause/resume cycles', () => {
    let t = startTimer(createTimer(10 * MIN), T0);
    t = pauseTimer(t, T0 + 1 * MIN); // 1 min run
    t = resumeTimer(t, T0 + 5 * MIN); // 4 min break
    expect(t.status).toBe('running');
    expect(t.runningSince).toBe(T0 + 5 * MIN);
    expect(elapsedMs(t, T0 + 7 * MIN)).toBe(3 * MIN);
    t = pauseTimer(t, T0 + 8 * MIN); // +3 min run => 4 min
    expect(t.accumulatedMs).toBe(4 * MIN);
    t = resumeTimer(t, T0 + 20 * MIN);
    expect(remainingMs(t, T0 + 21 * MIN)).toBe(5 * MIN);
  });

  it('elapsed time never goes negative if the clock goes backwards', () => {
    const t = startTimer(createTimer(MIN), T0);
    expect(elapsedMs(t, T0 - 5_000)).toBe(0);
    expect(remainingMs(t, T0 - 5_000)).toBe(MIN);
  });

  it('elapsed is clamped to the duration and remaining to 0', () => {
    const t = startTimer(createTimer(MIN), T0);
    expect(elapsedMs(t, T0 + 10 * MIN)).toBe(MIN);
    expect(remainingMs(t, T0 + 10 * MIN)).toBe(0);
  });

  it('rejects illegal transitions', () => {
    const idle = createTimer(MIN);
    const running = startTimer(idle, T0);
    const paused = pauseTimer(running, T0 + 1000);
    expect(() => startTimer(running, T0)).toThrow(TimerError);
    expect(() => startTimer(paused, T0)).toThrow(TimerError);
    expect(() => pauseTimer(idle, T0)).toThrow(TimerError);
    expect(() => pauseTimer(paused, T0)).toThrow(TimerError);
    expect(() => resumeTimer(idle, T0)).toThrow(TimerError);
    expect(() => resumeTimer(running, T0)).toThrow(TimerError);
    const expired = tick(running, T0 + MIN).timer;
    expect(() => startTimer(expired, T0)).toThrow(TimerError);
    expect(() => pauseTimer(expired, T0)).toThrow(TimerError);
    expect(() => resumeTimer(expired, T0)).toThrow(TimerError);
  });

  it('rejects a non-finite now', () => {
    const idle = createTimer(MIN);
    expect(() => startTimer(idle, Number.NaN)).toThrow(TimerError);
    const running = startTimer(idle, T0);
    expect(() => pauseTimer(running, Number.POSITIVE_INFINITY)).toThrow(TimerError);
    expect(() => tick(running, Number.NaN)).toThrow(TimerError);
  });

  it('never mutates its input', () => {
    const idle = deepFreeze(createTimer(5 * MIN));
    const running = deepFreeze(startTimer(idle, T0));
    const paused = deepFreeze(pauseTimer(running, T0 + MIN));
    const resumed = deepFreeze(resumeTimer(paused, T0 + 2 * MIN));
    deepFreeze(tick(resumed, T0 + 100 * MIN));
    deepFreeze(resetTimer(resumed));
    expect(idle).toEqual({ durationMs: 5 * MIN, status: 'idle', accumulatedMs: 0, runningSince: null });
    expect(running.status).toBe('running');
    expect(paused.accumulatedMs).toBe(MIN);
    expect(resumed.runningSince).toBe(T0 + 2 * MIN);
  });
});

describe('AC-18 timer: expiry signals but never finalizes', () => {
  it('tick before the duration elapses changes nothing', () => {
    const t = startTimer(createTimer(MIN), T0);
    const r = tick(t, T0 + MIN - 1);
    expect(r.expired).toBe(false);
    expect(r.timer).toEqual(t);
  });

  it('tick at exactly the duration expires the timer and signals once', () => {
    const t = startTimer(createTimer(MIN), T0);
    const first = tick(t, T0 + MIN);
    expect(first.expired).toBe(true);
    expect(first.timer.status).toBe('expired');
    expect(remainingMs(first.timer, T0 + MIN)).toBe(0);
    const second = tick(first.timer, T0 + 2 * MIN);
    expect(second.expired).toBe(false);
    expect(second.timer.status).toBe('expired');
  });

  it('expiry accounts for banked time from earlier pauses', () => {
    let t = startTimer(createTimer(3 * MIN), T0);
    t = pauseTimer(t, T0 + 2 * MIN);
    t = resumeTimer(t, T0 + 30 * MIN);
    expect(tick(t, T0 + 30 * MIN + MIN - 1).expired).toBe(false);
    expect(tick(t, T0 + 31 * MIN).expired).toBe(true);
  });

  it('pausing after the duration has already run out yields an expired timer', () => {
    const t = startTimer(createTimer(MIN), T0);
    const p = pauseTimer(t, T0 + 5 * MIN);
    expect(p.status).toBe('expired');
    expect(remainingMs(p, T0 + 5 * MIN)).toBe(0);
  });

  it('the expiry result carries only the timer and the signal — nothing about games or winners', () => {
    const r = tick(startTimer(createTimer(1000), T0), T0 + 1000);
    expect(Object.keys(r).sort()).toEqual(['expired', 'timer']);
    expect(Object.keys(r.timer).sort()).toEqual(['accumulatedMs', 'durationMs', 'runningSince', 'status']);
    expect(JSON.stringify(r)).not.toMatch(/winner|final|complete|score|game/i);
  });

  it('the timer module exposes no way to finalize, complete or decide a game', () => {
    const names = Object.keys(timerModule);
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const name of names) expect(name).not.toMatch(/final|winner|complete|score|game/i);
  });

  it('the timer module is pure and independent of the scoring engine and persistence (layering)', () => {
    const dir = resolve(process.cwd(), 'src/core/timer');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const imports = [...src.matchAll(/(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
        (m) => m[1] ?? m[2] ?? m[3] ?? '',
      );
      for (const spec of imports) {
        expect(spec, `${f} imports ${spec}`).not.toMatch(/scoring|data|main|renderer|electron|^node:|^fs$|^path$/);
      }
      expect(src, `${f} reads the real clock`).not.toMatch(/Date\.now\(|new Date\(|performance\.now\(|setTimeout\(|setInterval\(/);
    }
  });
});

describe('AC-18 timer: reset and duration changes', () => {
  it('reset from any state returns to idle with nothing elapsed and the same duration', () => {
    const idle = createTimer(4 * MIN);
    const running = startTimer(idle, T0);
    const paused = pauseTimer(running, T0 + MIN);
    const expired = tick(running, T0 + 4 * MIN).timer;
    for (const t of [idle, running, paused, expired] as TimerState[]) {
      expect(resetTimer(t)).toEqual({ durationMs: 4 * MIN, status: 'idle', accumulatedMs: 0, runningSince: null });
    }
  });

  it('reset can set a new duration, validated like createTimer', () => {
    const t = resetTimer(startTimer(createTimer(MIN), T0), 15 * MIN);
    expect(t.durationMs).toBe(15 * MIN);
    expect(t.status).toBe('idle');
    expect(() => resetTimer(t, 0)).toThrow(TimerError);
    expect(() => resetTimer(t, -5)).toThrow(TimerError);
  });

  it('a reset timer can be started again and runs the full new duration', () => {
    const expired = tick(startTimer(createTimer(1000), T0), T0 + 1000).timer;
    const again = startTimer(resetTimer(expired, 2000), T0 + 5000);
    expect(tick(again, T0 + 6999).expired).toBe(false);
    expect(tick(again, T0 + 7000).expired).toBe(true);
  });
});

describe('AC-18 timer: clock formatting', () => {
  it.each<[number, string]>([
    [0, '0:00'],
    [1, '0:01'],
    [999, '0:01'],
    [1000, '0:01'],
    [59_001, '1:00'],
    [60_000, '1:00'],
    [61_000, '1:01'],
    [9 * MIN + 59_500, '10:00'],
    [600_000, '10:00'],
    [75 * MIN, '75:00'],
  ])('formatClock(%i) === %s', (ms, text) => {
    expect(formatClock(ms)).toBe(text);
  });

  it('formatClock of a negative value is 0:00', () => {
    expect(formatClock(-5000)).toBe('0:00');
  });
});
