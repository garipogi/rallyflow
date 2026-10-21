import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { AwardsReport } from '../data/awards';
import type { AwardWinner, PodiumSpot } from '../core/awards';
import type { ShowAward } from '../core/awards/lineup';
import {
  buildSteps,
  displayOrder,
  FINALE_AT,
  phaseElapsed,
  REVEAL_AT,
  spotlightIndex,
  SUSPENSE_MS,
  type CeremonyState,
  type CeremonyStep,
} from '../shared/ceremony';
import { initialsOf, playerHue } from '../shared/engage';
import { AVATAR_LIGHTNESS, AVATAR_SATURATION, AVATAR_TEXT } from '../shared/themes';
import { BRAND } from '../shared/brand';
import { accentFor, Confetti } from './AwardsCeremony';
import { Logo } from './ui/Logo';

/**
 * The audience view of the one-award-at-a-time ceremony. Purely presentational (no controls), so the
 * display window can show it. Every animation is derived from the phase start timestamp: elements
 * that mount late (the display polls) start their CSS animations already part-way through (--late),
 * and the spotlight, count-up and podium are computed from the elapsed time.
 */

const css = (vars: Record<string, string | number>): CSSProperties => vars as CSSProperties;

/** Elapsed ms in the current phase, ticking while not paused. */
export function usePhaseElapsed(state: CeremonyState, tickMs = 50): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (state.paused) return undefined;
    const handle = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(handle);
  }, [state.paused, state.startedAt, state.step, state.phase, tickMs]);
  return phaseElapsed(state, now);
}

function CerAvatar({ winner, big = false }: { winner: AwardWinner; big?: boolean }) {
  return (
    <span
      className={`cer-avatar${big ? ' big' : ''}`}
      style={{ background: `hsl(${playerHue(winner.playerId)} ${AVATAR_SATURATION}% ${AVATAR_LIGHTNESS}%)`, color: AVATAR_TEXT }}
      aria-hidden="true"
    >
      {initialsOf(winner.name)}
    </span>
  );
}

const unitName = (unit: readonly AwardWinner[]): string => unit.map((w) => w.name).join(' & ');
const firstNames = (groups: readonly AwardWinner[][]): string => {
  const all = groups.flat().map((w) => w.name.split(/\s+/)[0] ?? w.name);
  return all.length <= 1 ? (all[0] ?? '') : `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
};
const ease = (p: number): number => 1 - (1 - Math.min(1, Math.max(0, p))) ** 3;

/** Counts a plain number up ("+18", "86%", "5"); anything else is shown as is. */
function countUp(stat: string, elapsed: number, start: number): string {
  const m = /^([+]?)(\d+)(%?)$/.exec(stat);
  if (!m) return stat;
  const target = Number(m[2]);
  return `${m[1]}${Math.round(target * ease((elapsed - start) / 900))}${m[3]}`;
}

function Fireworks({ late, at }: { late: number; at: number }) {
  const bursts = [
    { x: 22, y: 30, d: at },
    { x: 78, y: 26, d: at + 350 },
    { x: 50, y: 16, d: at + 750 },
  ];
  return (
    <div className="cer-fireworks" aria-hidden="true">
      {bursts.map((b, i) => (
        <span key={i} className="cer-burst" style={css({ '--x': `${b.x}%`, '--y': `${b.y}%`, '--d': `${b.d - late}ms`, '--hue': (i * 70 + 40) % 360 })}>
          {Array.from({ length: 16 }, (_, k) => (
            <span key={k} className="spark" style={css({ '--a': `${k * 22.5}deg` })} />
          ))}
        </span>
      ))}
    </div>
  );
}

/** Progress dots: one per award (non-interactive). */
function Dots({ steps, current }: { steps: readonly CeremonyStep[]; current: number }) {
  const awards = steps.map((s, i) => ({ s, i })).filter((x) => x.s.kind === 'award');
  if (awards.length === 0) return null;
  const at = awards.findIndex((x) => x.i === current);
  return (
    <div className="cer-dots" aria-hidden="true">
      {awards.map((x) => (
        <span key={x.i} className={`cer-dot${x.i === current ? ' now' : x.i < current ? ' done' : ''}${x.s.kind === 'award' && x.s.finale ? ' finale' : ''}`} />
      ))}
      <span className="cer-dots-label">{at >= 0 ? `Award ${at + 1} of ${awards.length}` : `${awards.length} awards`}</span>
    </div>
  );
}

function Intro({ report, count }: { report: AwardsReport; count: number }) {
  return (
    <div className="cer-center cer-intro">
      <p className="cer-kicker anim" style={css({ '--d': '0ms' })}>Welcome to the</p>
      <div className="cer-medal anim pop" style={css({ '--d': '250ms', '--hl': '#ffd54a' })}>
        <span aria-hidden="true">🏆</span>
      </div>
      <h2 className="cer-headline anim" style={css({ '--d': '600ms' })}>
        {BRAND.name} Awards
      </h2>
      <p className="cer-sub anim" style={css({ '--d': '1000ms' })}>
        {report.scopeLabel} · {count} {count === 1 ? 'award' : 'awards'} · {report.finalizedGames} {report.finalizedGames === 1 ? 'game' : 'games'}
      </p>
      <p className="cer-hint anim" style={css({ '--d': '1800ms' })}>
        The ceremony is about to begin<span className="cer-ellipsis" />
      </p>
    </div>
  );
}

function TitleCard({ award }: { award: ShowAward }) {
  return (
    <div className="cer-center cer-title">
      <p className="cer-kicker anim" style={css({ '--d': '0ms' })}>
        And the award for
      </p>
      <div className="cer-medal anim pop" style={css({ '--d': '300ms' })}>
        <span aria-hidden="true">{award.icon}</span>
      </div>
      <h2 className="cer-headline anim" style={css({ '--d': '650ms' })}>
        {award.title}
      </h2>
      <p className="cer-sub anim" style={css({ '--d': '1100ms' })}>
        {award.description}
      </p>
      <p className="cer-goes anim" style={css({ '--d': '2300ms' })}>
        goes to<span className="cer-ellipsis" />
      </p>
    </div>
  );
}

function Suspense({ award, elapsed, suspenseMs }: { award: ShowAward; elapsed: number; suspenseMs: number }) {
  const order = useMemo(() => displayOrder(award.nominees, award.key), [award.nominees, award.key]);
  const lit = spotlightIndex(elapsed, order.length, suspenseMs);
  const tension = Math.min(1, elapsed / suspenseMs);
  const holding = elapsed >= suspenseMs;
  return (
    <div className="cer-center cer-suspense">
      <p className="cer-mini anim" style={css({ '--d': '0ms' })}>
        <span aria-hidden="true">{award.icon}</span> {award.title}
      </p>
      <p className="cer-kicker anim" style={css({ '--d': '150ms' })}>
        The nominees are
      </p>
      <ol className={`cer-noms count-${Math.min(order.length, 6)}`}>
        {order.slice(0, 6).map((unit, i) => (
          <li key={unit.map((w) => w.playerId).join('-')} className={`cer-nom anim${i === lit ? ' lit' : ''}`} style={css({ '--d': `${300 + i * 140}ms` })}>
            <span className="cer-cone" aria-hidden="true" />
            <span className="cer-nom-avatars">
              {unit.slice(0, 4).map((w) => (
                <CerAvatar key={w.playerId} winner={w} />
              ))}
            </span>
            <span className="cer-nom-name">{unitName(unit)}</span>
          </li>
        ))}
      </ol>
      <div className={`cer-drum${holding ? ' holding' : ''}`}>
        <span className="cer-drum-icon" aria-hidden="true">
          🥁
        </span>
        <span>{holding ? 'And the winner is' : 'Drumroll, please'}</span>
        <span className="cer-ellipsis" />
      </div>
      <div className="cer-meter" aria-hidden="true">
        <span style={{ transform: `scaleX(${tension})` }} />
      </div>
    </div>
  );
}

function Reveal({ award, elapsed, late }: { award: ShowAward; elapsed: number; late: number }) {
  const winners = award.groups;
  const people = winners.flat();
  if (award.pending || people.length === 0) {
    return (
      <div className="cer-center">
        <p className="cer-kicker">{award.title}</p>
        <h2 className="cer-headline">The host is choosing the winner<span className="cer-ellipsis" /></h2>
      </div>
    );
  }
  const size = people.length > 4 ? 'many' : people.length > 1 ? 'few' : 'one';
  return (
    <div className="cer-center cer-reveal">
      <Fireworks late={late} at={REVEAL_AT.name} />
      <p className="cer-mini anim" style={css({ '--d': '200ms' })}>
        <span aria-hidden="true">{award.icon}</span> {award.title}
        {award.provisional ? ' · provisional' : ''}
      </p>
      <div className="cer-winner-avatars anim pop" style={css({ '--d': `${REVEAL_AT.name}ms` })}>
        {people.slice(0, 6).map((w) => (
          <CerAvatar key={w.playerId} winner={w} big />
        ))}
      </div>
      <h2 className={`cer-winner ${size} anim zoom`} style={css({ '--d': `${REVEAL_AT.name}ms` })}>
        {winners.map((g) => unitName(g)).join(people.length > 2 ? ', ' : ' and ')}
      </h2>
      <div className="cer-stat anim" style={css({ '--d': `${REVEAL_AT.stat}ms` })}>
        <span className="cer-stat-num">{countUp(award.stat, elapsed, REVEAL_AT.stat)}</span>
        <span className="cer-stat-label">{award.statLabel}</span>
      </div>
      <p className="cer-story anim" style={css({ '--d': `${REVEAL_AT.story}ms` })}>
        {award.explanation}
      </p>
      <p className="cer-applause anim bounce" style={css({ '--d': `${REVEAL_AT.applause}ms` })}>
        <span aria-hidden="true">👏</span> Give it up for {firstNames(winners)}!
      </p>
    </div>
  );
}

const PLACE_DELAY: Record<1 | 2 | 3, number> = { 3: FINALE_AT.third, 2: FINALE_AT.second, 1: FINALE_AT.first };
const MEDALS: Record<1 | 2 | 3, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

function Finale({ award, podium, late }: { award: ShowAward; podium: PodiumSpot[]; late: number }) {
  return (
    <div className="cer-finale">
      <Fireworks late={late} at={FINALE_AT.first + 150} />
      <div className="cer-finale-head">
        <p className="cer-kicker anim" style={css({ '--d': '0ms' })}>
          <span aria-hidden="true">{award.icon}</span> {award.title}
          {award.provisional ? ' · provisional' : ''}
        </p>
        <h2 className="cer-winner one anim zoom" style={css({ '--d': `${FINALE_AT.first + 250}ms` })}>
          {award.groups.map((g) => unitName(g)).join(' and ')}
        </h2>
        <p className="cer-story anim" style={css({ '--d': `${FINALE_AT.story}ms` })}>
          {award.explanation}
        </p>
      </div>
      <ol className="cer-podium" aria-label="Podium">
        {([2, 1, 3] as const).map((place) => {
          const spot = podium.find((p) => p.place === place);
          return (
            <li key={place} className={`cer-pcol p${place}${spot ? '' : ' empty'}`} style={css({ '--d': `${PLACE_DELAY[place]}ms` })}>
              {spot ? (
                <>
                  <div className="cer-pnames anim pop" style={css({ '--d': `${PLACE_DELAY[place] + 500}ms` })}>
                    <span className="cer-pmedal" aria-hidden="true">
                      {MEDALS[place]}
                    </span>
                    <span className="cer-pavatars">
                      {spot.players.slice(0, 3).map((p) => (
                        <CerAvatar key={p.playerId} winner={p} big={place === 1} />
                      ))}
                    </span>
                    <span className="cer-pname">{spot.players.map((p) => p.name).join(' & ')}</span>
                    <span className="cer-precord">{spot.record}</span>
                  </div>
                  <div className="cer-pstep anim grow" style={css({ '--d': `${PLACE_DELAY[place]}ms` })}>
                    <span>{place}</span>
                  </div>
                </>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="cer-applause anim bounce" style={css({ '--d': `${FINALE_AT.applause}ms` })}>
        <span aria-hidden="true">🎉</span> Congratulations, {firstNames(award.groups)}!
      </p>
    </div>
  );
}

function Outro({ awards }: { awards: ShowAward[] }) {
  const given = awards.filter((a) => !a.pending && a.groups.length > 0);
  return (
    <div className="cer-center cer-outro">
      <p className="cer-kicker anim" style={css({ '--d': '0ms' })}>
        That&rsquo;s a wrap!
      </p>
      <h2 className="cer-headline anim" style={css({ '--d': '250ms' })}>
        Congratulations to every player
      </h2>
      <ul className={`cer-wrap count-${Math.min(given.length, 12)}`}>
        {given.slice(0, 12).map((a, i) => (
          <li key={a.key} className="cer-wrap-item anim" style={css({ '--d': `${500 + i * 90}ms`, '--hl': accentFor(a) })}>
            <span className="cer-wrap-icon" aria-hidden="true">
              {a.icon}
            </span>
            <span className="cer-wrap-text">
              <span className="cer-wrap-title">{a.title}</span>
              <span className="cer-wrap-name">{a.groups.map((g) => unitName(g)).join(', ')}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One phase's content; captures how late it mounted so CSS animations line up with the host. */
function PhaseContent({ report, state, step, elapsed }: { report: AwardsReport; state: CeremonyState; step: CeremonyStep; elapsed: number }) {
  const [late] = useState(() => elapsed);
  const award = step.kind === 'award' ? report.lineup.find((a) => a.key === step.key) : undefined;
  let body: ReactNode = null;
  let confettiAt: number | null = null;
  if (step.kind === 'intro') body = <Intro report={report} count={report.lineup.length} />;
  else if (step.kind === 'outro') {
    body = <Outro awards={report.lineup} />;
    confettiAt = 400;
  } else if (award) {
    if (state.phase === 'title') body = <TitleCard award={award} />;
    else if (state.phase === 'suspense') body = <Suspense award={award} elapsed={elapsed} suspenseMs={SUSPENSE_MS[state.suspense]} />;
    else if (step.finale) {
      body = <Finale award={award} podium={report.podium} late={late} />;
      confettiAt = FINALE_AT.first;
    } else {
      body = <Reveal award={award} elapsed={elapsed} late={late} />;
      confettiAt = award.pending ? null : REVEAL_AT.name;
    }
  }
  const accent = award ? accentFor(award) : '#ffd54a';
  return (
    <div className="cer-content" style={css({ '--late': `${late}ms`, '--hl': accent })}>
      {state.phase === 'reveal' && step.kind === 'award' && !step.finale ? (
        <div className="cer-curtains" aria-hidden="true">
          <span className="cer-curtain left" />
          <span className="cer-curtain right" />
        </div>
      ) : null}
      {body}
      {confettiAt !== null && elapsed >= confettiAt ? <Confetti burst={state.step * 10 + 3} pieces={150} /> : null}
    </div>
  );
}

export function CeremonyStage({ report, state, preview = false }: { report: AwardsReport; state: CeremonyState; preview?: boolean }) {
  const steps = useMemo(() => buildSteps(report.lineup), [report.lineup]);
  const elapsed = usePhaseElapsed(state);
  const step = steps[Math.min(state.step, steps.length - 1)] as CeremonyStep;
  const award = step.kind === 'award' ? report.lineup.find((a) => a.key === step.key) : undefined;
  return (
    <div
      className={`cer-stage phase-${state.phase} step-${step.kind}${state.paused ? ' paused' : ''}${preview ? ' preview' : ''}`}
      data-testid="ceremony-stage"
      data-step={state.step}
      data-phase={state.phase}
      style={css({ '--hl': award ? accentFor(award) : '#ffd54a' })}
    >
      <div className="cer-bg" aria-hidden="true">
        <span className="cer-beam left" />
        <span className="cer-beam right" />
        <span className="cer-floor" />
      </div>
      <header className="cer-top">
        <span className="cer-brand">
          <Logo size={40} />
          <span>{BRAND.name} Awards</span>
        </span>
        <span className="cer-scope">{report.scopeLabel}</span>
      </header>
      <PhaseContent key={`${state.step}:${state.phase}`} report={report} state={state} step={step} elapsed={elapsed} />
      <Dots steps={steps} current={state.step} />
      {state.paused ? <p className="cer-paused">Paused</p> : null}
    </div>
  );
}
