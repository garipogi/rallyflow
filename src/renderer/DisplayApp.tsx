import { useEffect, useRef, useState } from 'react';
import type { DisplayCourt, DisplayTeam } from '../core/display';
import type { AwardsReport } from '../data/awards';
import type { DisplayCourtExtra, DisplayPayload } from '../shared/api';
import { formatElapsed } from '../shared/engage';
import type { Appearance } from '../shared/themes';
import { AwardCard, ChampionBanner, Confetti, Podium } from './AwardsCeremony';
import { CeremonyStage } from './CeremonyStage';
import { applyThemeToPage, watchSystemMode } from './theme/appearance';
import { Avatar } from './ui/Avatar';
import { BrandLockup, IdleCourt, Logo } from './ui/Logo';
import { BRAND } from '../shared/brand';

/** "Save as image" renders this page off screen with ?still=1: no animation, no confetti. */
const STILL = new URLSearchParams(window.location.search).get('still') === '1';

/** How long a finished game's result stays on its free court. */
const LAST_RESULT_MS = 90_000;

/** The big-screen awards ceremony: champion, podium and award cards, readable across the room. */
function Ceremony({ report }: { report: AwardsReport }) {
  const others = report.lineup.filter((a) => a.templateId !== 'champion' && !a.pending);
  // Celebrate when the ceremony first appears and whenever the champion changes, not on every poll.
  const championKey = report.awards.find((a) => a.id === 'champion')?.groups.flat().map((w) => w.playerId).join(',') ?? '';
  const [burst, setBurst] = useState(0);
  useEffect(() => {
    if (!STILL && championKey !== '') setBurst((b) => b + 1);
  }, [championKey]);

  return (
    <main className={`display ceremony${STILL ? ' still' : ''}`} data-ready="awards">
      {burst > 0 ? <Confetti burst={burst} pieces={140} /> : null}
      <header className="ceremony-head">
        <div className="ceremony-title">
          <h1>
            <span className="btn-icon" aria-hidden="true">🏆</span>
            {report.club?.name ? report.club.name : 'Awards'}
          </h1>
          <span className="display-sub">
            {report.club?.name ? 'Awards · ' : ''}
            {report.scopeLabel}
            {report.finalizedGames > 0 ? ` · ${report.finalizedGames} finalized ${report.finalizedGames === 1 ? 'game' : 'games'}` : ''}
            {report.club?.tagline ? <span className="ceremony-tagline"> · {report.club.tagline}</span> : null}
          </span>
        </div>
        <span className="ceremony-brand">
          <Logo size={44} />
          <BrandLockup />
        </span>
      </header>
      {report.finalizedGames === 0 ? (
        <p className="ceremony-empty">Awards appear here after the first finalized game.</p>
      ) : (
        <div className={`ceremony-grid${others.length === 0 ? ' solo' : ''}`}>
          <section className="ceremony-stage">
            <ChampionBanner report={report} />
            <Podium steps={report.podiumSteps} still={STILL} />
            {report.note ? <p className="stage-note">{report.note}</p> : null}
          </section>
          {others.length > 0 ? (
            <section className={`ceremony-cards count-${Math.min(others.length, 8)}`}>
              {others.slice(0, 8).map((award, i) => (
                <AwardCard key={award.key} award={award} index={i} maxNames={2} />
              ))}
            </section>
          ) : null}
        </div>
      )}
    </main>
  );
}

declare global {
  interface Window {
    /** Read-only bridge of the display window; the organizer API is not available here. */
    openPlayDisplay?: { getModel(): Promise<DisplayPayload | null> };
  }
}

const POLL_MS = 1000;
/** While the ceremony runs, poll faster so each step lands on the big screen almost at once. */
const CEREMONY_POLL_MS = 200;

function useClock(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (STILL) return undefined;
    const handle = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(handle);
  }, [ms]);
  return now;
}

function Team({ team, id, serving, won, gamePoint }: { team: DisplayTeam; id: 'A' | 'B'; serving: boolean; won: boolean; gamePoint: boolean }) {
  return (
    <div className={`team team-${id.toLowerCase()}${serving ? ' serving' : ''}${won ? ' won' : ''}${gamePoint ? ' game-point' : ''}`}>
      <div className="team-names">
        <span className="team-tag">Team {id}</span>
        {team.players.map((p) => (
          <span className="player" key={p.playerId}>
            <Avatar playerId={p.playerId} name={p.name} size="3.6vh" />
            <span className="player-name">{p.name}</span>
          </span>
        ))}
      </div>
      <div className="score" data-testid={`score-${id}`}>
        <span key={team.score} className="score-num">
          {team.score}
        </span>
      </div>
      <div className="serve-mark">
        {won ? (
          <span className="mark mark-won">🏆 WINNER</span>
        ) : gamePoint ? (
          <span className="mark mark-point">GAME POINT</span>
        ) : serving ? (
          <span className="mark mark-serve">
            <span className="serve-ball" aria-hidden="true" />
            SERVING
          </span>
        ) : (
          ' '
        )}
      </div>
    </div>
  );
}

function Court({ court, extra, now }: { court: DisplayCourt; extra: DisplayCourtExtra | undefined; now: number }) {
  const game = court.game;
  const attrs: Record<string, string> = {
    'data-testid': 'display-court',
    'data-court-label': court.label,
    'data-court-status': court.status,
  };
  if (game?.servingTeam) attrs['data-serving-team'] = game.servingTeam;
  const last = extra?.lastResult;
  const showLast = !game && last && now - Date.parse(last.endedAt) < LAST_RESULT_MS;
  const gamePoint = game && !game.isOver ? (extra?.gamePoint ?? null) : null;
  return (
    <section className={`court court-${court.status}${game?.isOver ? ' over' : ''}`} {...attrs}>
      {game?.isOver && game.winner && !STILL ? <Confetti burst={game.teamA.score * 100 + game.teamB.score + 1} pieces={60} /> : null}
      <header className="court-head">
        <h2>
          {game ? <span className="live-dot" aria-hidden="true" /> : null}
          {court.label}
        </h2>
        {game ? (
          <span className="court-note">
            {game.isOver ? 'Game over' : game.calledScore ? `Call ${game.calledScore}` : 'Ready to start'}
            {extra?.startedAt ? <span className="court-clock"> · ⏱ {formatElapsed(extra.startedAt, now)}</span> : null}
          </span>
        ) : (
          <span className="court-note">{court.status === 'unavailable' ? 'Not in use' : 'Open'}</span>
        )}
      </header>
      {game ? (
        <div className="teams">
          <Team team={game.teamA} id="A" serving={game.servingTeam === 'A' && !game.isOver} won={game.winner === 'A'} gamePoint={gamePoint === 'A'} />
          <div className="vs-divider" aria-hidden="true">
            vs
          </div>
          <Team team={game.teamB} id="B" serving={game.servingTeam === 'B' && !game.isOver} won={game.winner === 'B'} gamePoint={gamePoint === 'B'} />
        </div>
      ) : (
        <div className="court-free">
          {court.status === 'unavailable' ? null : <IdleCourt />}
          <p className="court-free-text">{court.status === 'unavailable' ? 'Court unavailable' : 'Court free'}</p>
          {showLast && last ? (
            <p className="last-result">
              <span aria-hidden="true">🏆 </span>
              {last.names} won {last.scoreA}-{last.scoreB}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function DisplayApp() {
  const [payload, setPayload] = useState<DisplayPayload | null>(null);
  const appearance = useRef<Appearance | null>(null);
  const now = useClock(1000);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const next = (await window.openPlayDisplay?.getModel()) ?? null;
        if (!alive) return;
        if (next?.appearance) {
          const prev = appearance.current;
          if (!prev || prev.mode !== next.appearance.mode || prev.theme !== next.appearance.theme) {
            appearance.current = next.appearance;
            applyThemeToPage(next.appearance);
          }
        }
        setPayload(next);
        fast = next?.ceremony !== undefined;
      } catch {
        // The main process is gone or busy; the next poll tries again.
      }
    };
    let fast = false;
    let timer = 0;
    const loop = (): void => {
      void load().finally(() => {
        if (alive) timer = window.setTimeout(loop, fast ? CEREMONY_POLL_MS : POLL_MS);
      });
    };
    loop();
    const stop = watchSystemMode(() => appearance.current ?? { mode: 'system', theme: 'court' });
    return () => {
      alive = false;
      window.clearTimeout(timer);
      stop();
    };
  }, []);

  if (payload?.ceremony) {
    return (
      <main className="ceremony-live" data-ready="ceremony">
        <CeremonyStage report={payload.ceremony.report} state={payload.ceremony.state} />
      </main>
    );
  }
  if (payload?.awards) return <Ceremony report={payload.awards} />;

  const courts = payload?.model?.courts ?? [];
  const queue = payload?.model?.queue ?? [];
  const extras = payload?.courtExtras ?? {};
  const columns = courts.length <= 1 ? 1 : 2;
  const rows = Math.max(1, Math.ceil(courts.length / columns));
  const inPlay = courts.filter((c) => c.status === 'in_use').length;
  const allFree = courts.length > 0 && inPlay === 0;
  const clock = new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  return (
    <main className={`display${allFree ? ' all-free' : ''}`}>
      <header className="display-head">
        <Logo size={56} />
        <div className="display-title">
          <h1>{payload?.sessionName ?? BRAND.name}</h1>
          <span className="display-sub">{payload?.sessionName ? `${BRAND.name} · Courts and next up` : `${BRAND.tagline} Waiting for a session.`}</span>
        </div>
        {payload?.model ? (
          <div className="display-stats">
            <span className="dstat">
              <strong>{inPlay}</strong>/{courts.length} in play
            </span>
            <span className="dstat">
              <strong>{queue.length}</strong> waiting
            </span>
          </div>
        ) : null}
        <span className="display-clock">{clock}</span>
      </header>
      {payload?.model ? (
        <div className="display-grid">
          <div className="courts" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
            {courts.map((court) => (
              <Court key={court.courtId} court={court} extra={extras[court.courtId]} now={now} />
            ))}
          </div>
          <aside className="queue" data-testid="display-queue">
            <h2>Next up</h2>
            {queue.length === 0 ? <p className="queue-empty">Nobody waiting. Grab a paddle!</p> : null}
            <ol>
              {queue.map((entry, i) => (
                <li key={entry.playerId} data-testid="display-queue-entry" className={i < 4 ? 'up-next' : ''} style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}>
                  <span className="queue-pos">{entry.position}</span>
                  <Avatar playerId={entry.playerId} name={entry.name} size="4.2vh" />
                  <span className="queue-name">{entry.name}</span>
                </li>
              ))}
            </ol>
          </aside>
        </div>
      ) : (
        <div className="display-idle">
          <IdleCourt />
          <p>The courts appear here when the organizer opens the display from a session.</p>
        </div>
      )}
    </main>
  );
}
