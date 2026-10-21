import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AwardsReport, AwardsScope } from '../data/awards';
import type { ShowAward } from '../core/awards/lineup';
import { formatWinners } from '../core/awards';
import {
  autoAdvanceAfter,
  backState,
  buildSteps,
  FINALE_AT,
  jumpTo,
  nextState,
  phaseElapsed,
  skipToReveal,
  startState,
  SUSPENSE_LENGTHS,
  SUSPENSE_MS,
  togglePause,
  type CeremonyState,
  type CeremonyStep,
  type SuspenseLength,
} from '../shared/ceremony';
import { CeremonyStage } from './CeremonyStage';
import type { CeremonySound } from './ceremonyAudio';

const PHASE_LABEL = { title: 'Title card', suspense: 'Suspense: nominees and drumroll', reveal: 'Reveal' } as const;
const LENGTH_LABEL: Record<SuspenseLength, string> = { short: 'Short', medium: 'Medium', long: 'Long' };

function stepTitle(step: CeremonyStep | undefined, awards: readonly ShowAward[]): string {
  if (!step) return '';
  if (step.kind === 'intro') return 'Welcome';
  if (step.kind === 'outro') return 'Wrap-up: all the winners';
  const a = awards.find((x) => x.key === step.key);
  return a ? `${a.icon} ${a.title}${step.finale ? ' (finale)' : ''}` : '';
}

/** Is the key event meant for a form control rather than the ceremony? */
const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
const onControl = (target: EventTarget | null): boolean => target instanceof HTMLElement && (target.tagName === 'BUTTON' || target.tagName === 'SUMMARY');

/**
 * The organizer's host view: the audience view as a live preview, speaker notes with the secret
 * winner, the next award, and the controls. Optionally mirrors every step on the display window.
 */
export function CeremonyHost({
  initialReport,
  scope,
  sound,
  onPick,
  onClose,
}: {
  initialReport: AwardsReport;
  scope: AwardsScope;
  sound: CeremonySound;
  /** Saves a host pick and returns the refreshed report. */
  onPick: (key: string, winnerIds: string[]) => Promise<AwardsReport | null>;
  onClose: () => void;
}) {
  const [report, setReport] = useState(initialReport);
  const steps = useMemo(() => buildSteps(report.lineup), [report.lineup]);
  const [state, setState] = useState<CeremonyState>(() => startState(Date.now()));
  const [soundOn, setSoundOn] = useState(true);
  const [onDisplay, setOnDisplay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickId, setPickId] = useState('');
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const step = steps[state.step];
  const award = step?.kind === 'award' ? report.lineup.find((a) => a.key === step.key) : undefined;
  const awardSteps = steps.map((s, i) => ({ s, i })).filter((x) => x.s.kind === 'award');
  const awardIndex = awardSteps.findIndex((x) => x.i === state.step);
  const nextStep = steps[state.step + 1];
  const pending = award?.pending === true;

  const update = useCallback((fn: (s: CeremonyState, now: number) => CeremonyState) => setState((s) => fn(s, Date.now())), []);
  const next = useCallback(() => {
    const s = stateRef.current;
    const st = steps[s.step];
    const a = st?.kind === 'award' ? report.lineup.find((x) => x.key === st.key) : undefined;
    if (a?.pending && s.phase === 'suspense') {
      setError(`Choose the winner of ${a.title} before the reveal.`);
      return;
    }
    if (st?.kind === 'outro') return;
    update((x, now) => nextState(x, steps, now));
  }, [steps, report.lineup, update]);
  const back = useCallback(() => update((x, now) => backState(x, steps, now)), [steps, update]);
  const skip = useCallback(() => {
    if (pending) {
      setError(`Choose the winner of ${award?.title ?? 'this award'} before the reveal.`);
      return;
    }
    update((x, now) => skipToReveal(x, steps, now));
  }, [steps, update, pending, award]);
  const pause = useCallback(() => update((x, now) => togglePause(x, now)), [update]);

  const end = useCallback(() => {
    sound.close();
    if (onDisplay) void window.openPlay.endCeremonyOnDisplay(scope);
    onClose();
  }, [sound, onDisplay, scope, onClose]);

  // Sounds follow the phases (the organizer's click started the audio, so nothing is blocked).
  useEffect(() => {
    const timers: number[] = [];
    const st = steps[state.step];
    if (state.phase === 'title' && st?.kind !== 'outro') sound.whoosh();
    if (state.phase === 'suspense') sound.drumroll(SUSPENSE_MS[state.suspense]);
    if (state.phase === 'reveal' && st?.kind === 'award') {
      if (st.finale) {
        timers.push(window.setTimeout(() => sound.thump(0.8), FINALE_AT.third));
        timers.push(window.setTimeout(() => sound.thump(1), FINALE_AT.second));
        timers.push(window.setTimeout(() => sound.reveal(true), FINALE_AT.first));
      } else {
        sound.reveal(false);
      }
    }
    if (st?.kind === 'outro') sound.applause(0, 3.5);
    return () => {
      for (const t of timers) window.clearTimeout(t);
      sound.stopRoll();
    };
    // Re-run only when the phase itself changes; pausing suspends the audio clock instead.
  }, [state.step, state.phase, state.suspense, steps, sound]);

  useEffect(() => {
    if (state.paused) sound.pause();
    else sound.resume();
  }, [state.paused, sound]);

  useEffect(() => sound.setMuted(!soundOn), [soundOn, sound]);

  // Auto-advance.
  useEffect(() => {
    const after = autoAdvanceAfter(state, steps);
    if (after === null || state.paused || (pending && state.phase === 'suspense')) return undefined;
    const wait = Math.max(0, after - phaseElapsed(state, Date.now()));
    const handle = window.setTimeout(() => update((x, now) => nextState(x, steps, now)), wait);
    return () => window.clearTimeout(handle);
  }, [state, steps, pending, update]);

  // Mirror on the display.
  useEffect(() => {
    if (!onDisplay) return;
    void window.openPlay.runCeremonyOnDisplay(scope, state, false).then((r) => {
      if (!r.ok) setError(r.error);
    });
  }, [state, onDisplay, scope]);

  const toggleDisplay = async () => {
    if (onDisplay) {
      await window.openPlay.endCeremonyOnDisplay(scope);
      setOnDisplay(false);
      return;
    }
    const r = await window.openPlay.runCeremonyOnDisplay(scope, stateRef.current, true);
    if (r.ok) setOnDisplay(true);
    else setError(r.error);
  };

  // Keyboard: Space / Right / Enter next, Left back, P pause, M mute, S skip suspense, Esc end.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      if ((key === ' ' || key === 'Enter') && onControl(e.target)) return; // the focused button handles it
      if (key === ' ' || key === 'Enter' || key === 'ArrowRight' || key === 'PageDown') {
        e.preventDefault();
        next();
      } else if (key === 'ArrowLeft' || key === 'PageUp') {
        e.preventDefault();
        back();
      } else if (key === 'p' || key === 'P') pause();
      else if (key === 'm' || key === 'M') setSoundOn((v) => !v);
      else if (key === 's' || key === 'S') skip();
      else if (key === 'Escape') end();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back, pause, skip, end]);

  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  useEffect(() => {
    setError(null);
    setPickId('');
  }, [state.step]);

  const confirmPick = async () => {
    if (!award || pickId === '') return;
    const fresh = await onPick(award.key, [pickId]);
    if (!fresh) return;
    setReport(fresh);
    setError(null);
    if (onDisplay) {
      const r = await window.openPlay.runCeremonyOnDisplay(scope, stateRef.current, true);
      if (!r.ok) setError(r.error);
    }
  };

  const primaryLabel =
    step?.kind === 'intro'
      ? 'Begin the ceremony'
      : step?.kind === 'outro'
        ? 'End ceremony'
        : state.phase === 'title'
          ? 'Show the nominees'
          : state.phase === 'suspense'
            ? 'Reveal the winner'
            : nextStep?.kind === 'outro'
              ? 'Wrap up'
              : nextStep?.kind === 'award' && nextStep.finale
                ? 'On to the finale'
                : 'Next award';
  const primaryIcon = state.phase === 'suspense' ? '🎉' : step?.kind === 'outro' ? '✕' : '→';

  return (
    <div className="host-overlay" role="dialog" aria-modal="true" aria-label="Awards ceremony host view">
      <header className="host-bar">
        <h2 className="host-title">
          <span aria-hidden="true">🎬</span> Ceremony <span className="host-scope">{report.scopeLabel}</span>
        </h2>
        <nav className="host-dots" aria-label="Ceremony progress">
          {awardSteps.map((x, n) => {
            const st = x.s;
            const a = st.kind === 'award' ? report.lineup.find((y) => y.key === st.key) : undefined;
            return (
              <button
                key={x.i}
                className={`host-dot${x.i === state.step ? ' now' : x.i < state.step ? ' done' : ''}`}
                aria-label={`Go to award ${n + 1}: ${a?.title ?? ''}`}
                aria-current={x.i === state.step ? 'step' : undefined}
                onClick={() => update((s, now) => jumpTo(s, steps, x.i, now))}
              >
                <span aria-hidden="true">{a?.icon}</span>
              </button>
            );
          })}
          <span className="host-count" role="status">
            {awardIndex >= 0 ? `Award ${awardIndex + 1} of ${awardSteps.length}` : step?.kind === 'intro' ? `${awardSteps.length} awards` : 'Wrap-up'}
          </span>
        </nav>
        <div className="host-toggles">
          <button className="secondary" aria-pressed={soundOn} onClick={() => setSoundOn((v) => !v)}>
            <span className="btn-icon" aria-hidden="true">{soundOn ? '🔊' : '🔇'}</span>
            {soundOn ? 'Sound on' : 'Muted'}
          </button>
          <button className={onDisplay ? '' : 'secondary'} aria-pressed={onDisplay} onClick={() => void toggleDisplay()}>
            <span className="btn-icon" aria-hidden="true">📺</span>
            {onDisplay ? 'On the display' : 'Run on display'}
          </button>
          <button className="secondary danger-outline" onClick={end}>
            End ceremony
          </button>
        </div>
      </header>

      <div className="host-main">
        <section className="host-preview" aria-label="Audience view preview">
          <p className="host-label">
            Audience view{onDisplay ? ' · live on the display' : ' · preview'}
          </p>
          <div className="host-screen">
            <CeremonyStage report={report} state={state} preview />
          </div>
        </section>

        <aside className="host-notes" aria-label="Host notes">
          <p className="host-label">Now · {step?.kind === 'award' ? PHASE_LABEL[state.phase] : stepTitle(step, report.lineup)}</p>
          {award ? (
            <>
              <h3 className="host-award">
                <span aria-hidden="true">{award.icon}</span> {award.title}
              </h3>
              {award.pending ? (
                <div className="host-pick">
                  <p className="host-secret pending">
                    <strong>Host pick:</strong> choose the winner before the reveal.
                  </p>
                  <label className="field">
                    Winner of {award.title}
                    <select value={pickId} onChange={(e) => setPickId(e.target.value)}>
                      <option value="">Choose a player…</option>
                      {report.roster.map((p) => (
                        <option key={p.playerId} value={p.playerId}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button disabled={pickId === ''} onClick={() => void confirmPick()}>
                    Confirm winner
                  </button>
                </div>
              ) : (
                <p className="host-secret">
                  <span aria-hidden="true">🔒</span> <strong>Winner (keep it secret):</strong> {formatWinners(award.groups)}
                  {award.source !== 'manual' ? (
                    <>
                      {' '}
                      · {award.stat} {award.statLabel}
                    </>
                  ) : null}
                </p>
              )}
              {award.decoys ? (
                <p className="host-note-small">The other names on screen are random roster picks for drama; the real winner is the one above.</p>
              ) : null}
              <p className="host-script">
                <strong>Say:</strong> {award.pending ? award.description : award.explanation}
              </p>
              <p className="host-note-small">
                <strong>How it is earned:</strong> {award.description}
              </p>
              {award.nominees.length > 1 && !award.decoys ? (
                <p className="host-note-small">
                  <strong>Nominees:</strong> {award.nominees.map((u) => u.map((w) => w.name).join(' & ')).join(', ')}
                </p>
              ) : null}
            </>
          ) : step?.kind === 'intro' ? (
            <>
              <p className="host-script">
                <strong>Say:</strong> Welcome to the awards for {report.scopeLabel}! {report.finalizedGames} games were played. Let&rsquo;s celebrate {awardSteps.length}{' '}
                {awardSteps.length === 1 ? 'award' : 'awards'}.
              </p>
              {report.skipped.length > 0 ? (
                <p className="host-note-small">
                  <strong>Not in tonight&rsquo;s show:</strong> {report.skipped.map((s) => `${s.icon} ${s.title} (${s.reason.replace(/\.$/, '')})`).join('; ')}.
                </p>
              ) : null}
            </>
          ) : (
            <p className="host-script">
              <strong>Say:</strong> Congratulations to every winner, and thank you all for playing!
            </p>
          )}
          <div className="host-next">
            <span className="host-label">Up next</span>
            <span>{nextStep ? stepTitle(nextStep, report.lineup) : 'The end'}</span>
          </div>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
        </aside>
      </div>

      <footer className="host-controls">
        <button className="secondary" onClick={back} disabled={state.step === 0 && state.phase === 'title'}>
          <span className="btn-icon" aria-hidden="true">←</span>Back
        </button>
        <button className="secondary" onClick={skip} disabled={step?.kind !== 'award' || state.phase === 'reveal'}>
          <span className="btn-icon" aria-hidden="true">⏭</span>Skip suspense
        </button>
        <button className="secondary" aria-pressed={state.paused} onClick={pause}>
          <span className="btn-icon" aria-hidden="true">{state.paused ? '▶' : '⏸'}</span>
          {state.paused ? 'Resume' : 'Pause'}
        </button>
        <button
          ref={primaryRef}
          className={`host-primary${state.phase === 'suspense' ? ' reveal' : ''}`}
          disabled={state.phase === 'suspense' && pending}
          onClick={step?.kind === 'outro' ? end : next}
        >
          <span className="btn-icon" aria-hidden="true">{primaryIcon}</span>
          {primaryLabel}
        </button>
        <div className="host-auto">
          <label className="switch">
            <input type="checkbox" checked={state.auto} onChange={(e) => setState((s) => ({ ...s, auto: e.target.checked }))} />
            Auto-advance
          </label>
          <div className="host-length" role="group" aria-label="Suspense length">
            {SUSPENSE_LENGTHS.map((len) => (
              <button
                key={len}
                className={state.suspense === len ? 'seg active' : 'seg'}
                aria-pressed={state.suspense === len}
                onClick={() => setState((s) => ({ ...s, suspense: len }))}
              >
                {LENGTH_LABEL[len]}
              </button>
            ))}
          </div>
        </div>
        <p className="host-keys">
          <kbd>Space</kbd>/<kbd>→</kbd> next · <kbd>←</kbd> back · <kbd>S</kbd> skip · <kbd>P</kbd> pause · <kbd>M</kbd> mute · <kbd>Esc</kbd> end
        </p>
      </footer>
    </div>
  );
}
