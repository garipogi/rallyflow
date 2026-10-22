import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createTimer,
  formatClock,
  pauseTimer,
  remainingMs,
  resetTimer,
  resumeTimer,
  startTimer,
  tick,
  type TimerState,
} from '../core/timer';
import { replay, type GameState, type ScoringEvent, type TeamId } from '../core/scoring';
import type { ApiResult } from '../shared/api';
import type { Court, Game, RosterEntry } from '../data/types';
import { formatElapsed, gamePointTeam } from '../shared/engage';
import { Confetti } from './AwardsCeremony';
import { Avatar } from './ui/Avatar';
import { IdleCourt } from './ui/Logo';
import { COURT_CHOICES } from './teamUpOptions';
import { isQuickMode, scoreLine, type GameRules, type ScoreEntryMode } from '../core/scoring/quickResult';
import { useToast } from './ui/Toasts';
import { markQuickResult, QuickResultCard, SkipScoring, type RecordResult } from './QuickResult';

/** Re-renders the caller every `ms` while mounted. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(handle);
  }, [ms]);
  return now;
}

/** Live game clock since the game was put on court. Not the optional countdown timer. */
function Elapsed({ startedAt }: { startedAt: string | null }) {
  const now = useNow(1000);
  return (
    <span className="elapsed" title="Time since this game started">
      <span aria-hidden="true">⏱ </span>
      {formatElapsed(startedAt, now)}
    </span>
  );
}

const CELEBRATE_MS = 9000;
/** How long the result toast (with Undo) stays. */
const UNDO_TOAST_MS = 10_000;

type Notify = ReturnType<typeof useToast>;

/** Undo of a just-recorded result: reopens the game (audited in the data layer) and frees nothing else. */
async function undoResult(gameId: string, courtLabel: string, notify: Notify, onChanged: () => void): Promise<void> {
  const res = await window.openPlay.undoGameResult(gameId, true);
  if (res.ok) notify(`Result undone: ${courtLabel} is back in play.`, { tone: 'info', icon: '↩️' });
  else notify(res.error, { tone: 'info', icon: '⚠️' });
  onChanged();
}

const winnersOf = (game: Game, nameOf: (id: string) => string): string =>
  game.participants
    .filter((p) => p.team === game.winner)
    .map((p) => nameOf(p.playerId))
    .join(' & ');

/** "won 11-7", or just "won" for a score-less (winner only) result. */
const wonText = (game: Game): string => {
  if (game.teamAScore === 0 && game.teamBScore === 0) return 'won';
  const high = Math.max(game.teamAScore, game.teamBScore);
  const low = Math.min(game.teamAScore, game.teamBScore);
  return `won ${scoreLine(high, low)}`;
};

/**
 * The court's last result, until the next game starts there: a short celebration first, then a
 * compact "Last result: … · Undo" line. Undo reopens the game and puts the court back in play.
 */
function LastResult({ game, courtLabel, nameOf, readOnly, onUndo }: { game: Game; courtLabel: string; nameOf: (id: string) => string; readOnly: boolean; onUndo: () => void }) {
  const now = useNow(1000);
  const endedAt = game.endedAt ? Date.parse(game.endedAt) : 0;
  if (!game.winner) return null;
  const celebrating = now - endedAt <= CELEBRATE_MS;
  const undo = readOnly ? null : (
    <button className="link-btn undo-btn" aria-label={`Undo last result on ${courtLabel}`} onClick={onUndo}>
      Undo
    </button>
  );
  if (celebrating) {
    return (
      <div className="recent-win">
        <Confetti burst={endedAt % 100000 || 1} pieces={36} />
        <span className="recent-win-icon" aria-hidden="true">
          🏆
        </span>
        <span className="recent-win-text">
          <strong>{winnersOf(game, nameOf)}</strong> {wonText(game)}
        </span>
        {undo}
      </div>
    );
  }
  return (
    <p className="last-result-line">
      <span className="muted">Last result:</span> <strong>{winnersOf(game, nameOf)}</strong> {wonText(game)}
      {undo ? <> · {undo}</> : null}
    </p>
  );
}

interface BoardProps {
  sessionId: string;
  courts: Court[];
  roster: RosterEntry[];
  games: Game[];
  readOnly: boolean;
  courtCount: number;
  /** How results are entered on the court cards (the session's scoring mode). */
  scoreEntry: ScoreEntryMode;
  /** The session's target score and win-by, for the quick-result hints and chips. */
  rules: GameRules;
  onChanged: () => void;
}

const DEFAULT_TIMER_MINUTES = '12';

/** Timers live for the app session, keyed by game, so a refresh of the court list never resets one. */
const timers = new Map<string, TimerState>();

const isActive = (g: Game): boolean => g.status === 'scheduled' || g.status === 'in_progress';

/** Optional, organizer-controlled game timer. Expiry is only a signal; it never touches the score. */
function GameTimer({ gameId, disabled }: { gameId: string; disabled: boolean }) {
  const [timer, setTimerState] = useState<TimerState | null>(() => timers.get(gameId) ?? null);
  const [minutes, setMinutes] = useState(DEFAULT_TIMER_MINUTES);
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState<string | null>(null);

  const setTimer = useCallback(
    (next: TimerState | null) => {
      if (next) timers.set(gameId, next);
      else timers.delete(gameId);
      setTimerState(next);
    },
    [gameId],
  );

  const running = timer?.status === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const handle = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      setTimerState((current) => {
        if (!current) return current;
        const next = tick(current, at).timer;
        if (next !== current) timers.set(gameId, next);
        return next;
      });
    }, 200);
    return () => window.clearInterval(handle);
  }, [running, gameId]);

  const status = timer?.status ?? 'idle';
  const shown = timer ? remainingMs(timer, now) : Math.round((Number.parseFloat(minutes) || 0) * 60000);

  const start = () => {
    const durationMs = Math.round(Number.parseFloat(minutes) * 60000);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      setMessage('Enter a timer length above zero minutes.');
      return;
    }
    setMessage(null);
    const at = Date.now();
    setNow(at);
    setTimer(startTimer(createTimer(durationMs), at));
  };

  return (
    <div className="timer-box">
      <label>
        Timer length (minutes){' '}
        <input
          type="number"
          min="0"
          step="any"
          className="timer-length"
          value={minutes}
          disabled={disabled || status !== 'idle'}
          onChange={(e) => setMinutes(e.target.value)}
        />
      </label>
      <div className={`timer-clock timer-${status}`} data-testid="timer" data-timer-status={status} role="timer">
        {formatClock(shown)}
      </div>
      {status === 'expired' ? <strong className="timer-alert">Time is up. The game continues until you finalize it.</strong> : null}
      {message ? <span className="error">{message}</span> : null}
      <div className="row">
        <button className="secondary" disabled={disabled || status !== 'idle'} onClick={start}>
          Start timer
        </button>
        <button
          className="secondary"
          disabled={disabled || status !== 'running'}
          onClick={() => timer && setTimer(pauseTimer(timer, Date.now()))}
        >
          Pause timer
        </button>
        <button
          className="secondary"
          disabled={disabled || status !== 'paused'}
          onClick={() => {
            const at = Date.now();
            setNow(at);
            if (timer) setTimer(resumeTimer(timer, at));
          }}
        >
          Resume timer
        </button>
        <button className="secondary" disabled={disabled || status === 'idle'} onClick={() => timer && setTimer(resetTimer(timer))}>
          Reset timer
        </button>
      </div>
    </div>
  );
}

interface ScoringProps {
  court: Court;
  game: Game;
  nameOf: (id: string) => string;
  readOnly: boolean;
  scoreEntry: ScoreEntryMode;
  rules: GameRules;
  onChanged: () => void;
}

/** Scoring controls for one court. A rally is one click or one key press; nothing navigates away. */
function CourtScoring({ court, game, nameOf, readOnly, scoreEntry, rules, onChanged }: ScoringProps) {
  const notify = useToast();
  const quick = isQuickMode(scoreEntry);
  const [state, setState] = useState<GameState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [firstServer, setFirstServer] = useState<TeamId>('A');
  // Taps run strictly one after another, so fast scoring never loses or reorders a rally.
  const chain = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let alive = true;
    if (quick) {
      setLoaded(true);
      return undefined;
    }
    void (async () => {
      const res = await window.openPlay.loadScoreLog(game.id);
      if (!alive) return;
      setState(res.ok ? replay(res.value.setup, res.value.events) : null);
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [game.id, quick]);

  const apply = (call: () => Promise<ApiResult<GameState>>, after?: () => void) => {
    chain.current = chain.current.then(async () => {
      const res = await call();
      if (res.ok) {
        setState(res.value);
        setError(null);
        after?.();
      } else {
        setError(res.error);
      }
    });
  };

  const members = (id: TeamId) =>
    game.participants.filter((p) => p.team === id).sort((a, b) => a.startingPosition - b.startingPosition);
  const team = (id: TeamId): string =>
    members(id)
      .map((p) => nameOf(p.playerId))
      .join(' & ');
  const avatars = (id: TeamId) => (
    <span className="avatars">
      {members(id).map((p) => (
        <Avatar key={p.playerId} playerId={p.playerId} name={nameOf(p.playerId)} />
      ))}
    </span>
  );

  const rally = (winner: TeamId) => apply(() => window.openPlay.recordScoringEvent(game.id, { type: 'rally', winner } satisfies ScoringEvent));
  const fault = (against: TeamId) => apply(() => window.openPlay.recordScoringEvent(game.id, { type: 'fault', against }));
  const finalize = () => {
    chain.current = chain.current.then(async () => {
      const res = await window.openPlay.finalizeGame(game.id);
      if (res.ok) {
        setError(null);
        onChanged();
      } else {
        setError(res.error);
      }
    });
  };

  /** A quick result: saved in one step, then a toast with Undo (the court card keeps an Undo line too). */
  const recordResult: RecordResult = (winner, scoreA, scoreB) =>
    new Promise((resolve) => {
      chain.current = chain.current.then(async () => {
        const res = await window.openPlay.recordGameResult(game.id, { winner, scoreA, scoreB });
        if (!res.ok) {
          resolve(res.error);
          return;
        }
        setError(null);
        markQuickResult(game.id);
        const scored = scoreA !== undefined && scoreB !== undefined;
        const scorePart = scored ? ` ${scoreLine(Math.max(scoreA, scoreB), Math.min(scoreA, scoreB))}` : '';
        const gameId = game.id;
        notify(`${court.label}: ${team(winner)} won${scorePart}`, {
          tone: 'celebrate',
          icon: '🏆',
          durationMs: UNDO_TOAST_MS,
          action: { label: 'Undo', ariaLabel: `Undo result on ${court.label}`, run: () => void undoResult(gameId, court.label, notify, onChanged) },
        });
        resolve(null);
        onChanged();
      });
    });

  const over = state?.isOver ?? false;
  const locked = readOnly || over;
  const gamePoint = state ? gamePointTeam(state) : null;

  return (
    <article
      className={`court-card active${over ? ' is-over' : ''}${quick ? ' quick-mode' : ''}`}
      data-testid="court-scoring"
      data-court-label={court.label}
      data-score-entry={scoreEntry}
    >
      {over && state?.winner ? <Confetti burst={state.rallies + 1} pieces={48} /> : null}
      <div className="court-title">
        <h4>
          <span className="live-dot" aria-hidden="true" />
          {court.label}
        </h4>
        <span className="matchup">
          <span className="team-a-text">{team('A')}</span> <span className="vs">vs</span> <span className="team-b-text">{team('B')}</span>
        </span>
        <Elapsed startedAt={game.startedAt} />
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}

      {quick ? (
        <>
          <QuickResultCard mode={scoreEntry === 'winner_only' ? 'winner_only' : 'final_score'} rules={rules} disabled={readOnly} name={team} onRecord={recordResult} />
          <GameTimer gameId={game.id} disabled={readOnly} />
        </>
      ) : !loaded ? (
        <p>Loading score...</p>
      ) : state === null ? (
        <div className="row">
          <label>
            First serving team{' '}
            <select value={firstServer} disabled={readOnly} onChange={(e) => setFirstServer(e.target.value as TeamId)}>
              <option value="A">Team A</option>
              <option value="B">Team B</option>
            </select>
          </label>
          <button disabled={readOnly} onClick={() => apply(() => window.openPlay.startScoring(game.id, { firstServingTeam: firstServer }))}>
            Start scoring
          </button>
        </div>
      ) : (
        <>
          <div className="scoreboard">
            {(['A', 'B'] as const).map((id) => (
              <div
                key={id}
                className={`scorebox team-${id.toLowerCase()}${state.servingTeam === id && !over ? ' serving' : ''}${
                  over && state.winner === id ? ' winner' : ''
                }${gamePoint === id ? ' game-point' : ''}`}
              >
                <div className="scorebox-name">
                  <span className="team-label">Team {id}</span>
                  {avatars(id)}
                  <span className="team-names">{team(id)}</span>
                </div>
                <div className="scorebox-score" data-testid={`score-${id}`}>
                  <span key={state.score[id]} className="score-num">
                    {state.score[id]}
                  </span>
                </div>
                <div className="scorebox-tags">
                  {over && state.winner === id ? (
                    <span className="winner-tag">
                      <span aria-hidden="true">🏆 </span>Winner
                    </span>
                  ) : null}
                  {!over && state.servingTeam === id ? (
                    <span className="serve-tag">
                      <span className="serve-ball" aria-hidden="true" />
                      Serving
                    </span>
                  ) : null}
                  {gamePoint === id ? <span className="point-tag">Game point</span> : null}
                </div>
              </div>
            ))}
            <div className="called">
              {over ? (
                <span>Game over</span>
              ) : (
                <>
                  Call{' '}
                  <strong data-testid="called-score">{state.calledScore}</strong>
                </>
              )}
            </div>
          </div>
          <div className="rally-row">
            <button className="rally rally-a" disabled={locked} onClick={() => rally('A')}>
              Team A wins rally
            </button>
            <button className="rally rally-b" disabled={locked} onClick={() => rally('B')}>
              Team B wins rally
            </button>
          </div>
          <div className="row score-tools">
            <button className="secondary" disabled={readOnly} onClick={() => apply(() => window.openPlay.undoLastScoringEvent(game.id))}>
              Undo last point
            </button>
            <button className="secondary" disabled={locked} onClick={() => fault('A')}>
              Fault by Team A
            </button>
            <button className="secondary" disabled={locked} onClick={() => fault('B')}>
              Fault by Team B
            </button>
            <button className={over ? 'finalize ready' : 'finalize'} disabled={readOnly || !over} onClick={finalize}>
              Finalize game
            </button>
            {!over ? <span className="hint">Finalize unlocks when a team reaches {state.targetScore}, winning by {state.winBy}.</span> : null}
          </div>
          <GameTimer gameId={game.id} disabled={readOnly} />
        </>
      )}
      {loaded && !quick ? <SkipScoring rules={rules} disabled={readOnly} name={team} onRecord={recordResult} /> : null}
    </article>
  );
}

/** The dashboard: every court with its game and score controls, ahead of everything else. */
export function CourtBoard({ sessionId, courts, roster, games, readOnly, courtCount, scoreEntry, rules, onChanged }: BoardProps) {
  const [error, setError] = useState<string | null>(null);
  const notify = useToast();
  const names = new Map(roster.map((e) => [e.playerId, e.player.displayName]));
  const nameOf = (id: string): string => names.get(id) ?? id;

  const run = async <T,>(promise: Promise<ApiResult<T>>): Promise<void> => {
    const res = await promise;
    setError(res.ok ? null : res.error);
    if (res.ok) onChanged();
  };

  return (
    <section aria-label="Courts" className="board">
      <div className="section-head">
        <h3>
          <span aria-hidden="true">🏟️ </span>Courts
        </h3>
        <label className="inline-field">
          Number of courts{' '}
          <select
            value={courtCount}
            disabled={readOnly}
            onChange={(e) => {
              const count = Number(e.target.value);
              // D15: 1 court is the explicit single-court opt-in
              void run(window.openPlay.setCourtCount(sessionId, count, count === 1 ? { allowSingleCourt: true } : undefined));
            }}
          >
            {COURT_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="court-grid">
        {courts.map((court) => {
          const game = games.find((g) => g.courtId === court.id && isActive(g));
          if (game) {
            return (
              <CourtScoring
                key={`${court.id}:${game.id}`}
                court={court}
                game={game}
                nameOf={nameOf}
                readOnly={readOnly}
                scoreEntry={scoreEntry}
                rules={rules}
                onChanged={onChanged}
              />
            );
          }
          const last = games
            .filter((g) => g.courtId === court.id && g.status === 'completed' && g.endedAt !== null)
            .sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? ''))
            .at(-1);
          return (
            <article key={court.id} className={`court-card free ${court.status}`}>
              <div className="court-title">
                <h4>{court.label}</h4>
                <span className={`badge ${court.status === 'available' ? 'badge-free' : 'badge-off'}`}>
                  {court.status === 'available' ? 'Free' : 'Unavailable'}
                </span>
              </div>
              {last ? (
                <LastResult
                  key={last.id}
                  game={last}
                  courtLabel={court.label}
                  nameOf={nameOf}
                  readOnly={readOnly}
                  onUndo={() => void undoResult(last.id, court.label, notify, onChanged)}
                />
              ) : null}
              {court.status === 'available' ? (
                <div className="free-court">
                  <IdleCourt />
                  <p className="hint">Ready for the next game. Start one from Next up below.</p>
                </div>
              ) : (
                <p className="hint free-court">Out of play. Mark it available when it is ready again.</p>
              )}
              <button
                className="secondary"
                disabled={readOnly}
                onClick={() => void run(window.openPlay.setCourtStatus(court.id, court.status === 'available' ? 'unavailable' : 'available'))}
              >
                {court.status === 'available' ? `Mark ${court.label} unavailable` : `Mark ${court.label} available`}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
