import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { defaultRoundRobinRounds, MAX_ROUND_ROBIN_ROUNDS, roundRobinCoverage, scheduleGameKey, type RoundRobinSchedule } from '../core/rotation';
import type { ApiResult, RoundRobinStatus } from '../shared/api';
import type { Court } from '../data/types';
import { Modal } from './ui/Modal';

interface Props {
  sessionId: string;
  sessionName: string;
  courts: Court[];
  names: Map<string, string>;
  /** Checked-in, available players (for the default number of rounds). */
  presentCount: number;
  format: 'singles' | 'doubles';
  readOnly: boolean;
  /** Changes whenever games or the roster change, so the progress reloads. */
  version: string;
  /** Open the schedule window (set after "Use this style" made a schedule). */
  showSchedule: boolean;
  onShowSchedule: (open: boolean) => void;
  onChanged: () => void;
}

const nameList = (ids: readonly string[], names: Map<string, string>): string => ids.map((id) => names.get(id) ?? 'Removed player').join(' & ');

function courtLabels(schedule: RoundRobinSchedule, courts: Court[]): string[] {
  const inPlay = courts.filter((c) => c.status === 'available');
  return Array.from({ length: schedule.courtCount }, (_, i) => inPlay[i]?.label ?? `Game ${i + 1}`);
}

/** The schedule as a table: one row per round, one column per court, plus the byes. */
function ScheduleTable({ schedule, status, courts, names, printable }: { schedule: RoundRobinSchedule; status: RoundRobinStatus | null; courts: Court[]; names: Map<string, string>; printable?: boolean }) {
  const labels = courtLabels(schedule, courts);
  const started = new Set(status?.started ?? []);
  return (
    <table className={`rr-table${printable ? ' rr-table-print' : ''}`}>
      <caption className="sr-only">Round-robin schedule: rounds by court, with the players who sit out</caption>
      <thead>
        <tr>
          <th scope="col">Round</th>
          {labels.map((l) => (
            <th scope="col" key={l}>
              {l}
            </th>
          ))}
          <th scope="col">Sits out</th>
        </tr>
      </thead>
      <tbody>
        {schedule.rounds.map((round, r) => {
          const current = !printable && status !== null && status.currentRound === r;
          return (
            <tr key={r} className={current ? 'rr-current' : undefined} aria-current={current ? 'step' : undefined}>
              <th scope="row">
                {r + 1}
                {current ? <span className="rr-now">now</span> : null}
              </th>
              {labels.map((_, g) => {
                const game = round.games[g];
                const done = started.has(scheduleGameKey(schedule.id, r, g));
                return (
                  <td key={g} className={done && !printable ? 'rr-done' : undefined}>
                    {game ? (
                      <>
                        {done && !printable ? (
                          <span className="rr-tick" aria-label="started">
                            ✓{' '}
                          </span>
                        ) : null}
                        <span className="rr-team">{nameList(game.teamA, names)}</span>
                        <span className="rr-vs"> vs </span>
                        <span className="rr-team">{nameList(game.teamB, names)}</span>
                      </>
                    ) : (
                      <span className="muted">-</span>
                    )}
                  </td>
                );
              })}
              <td className="rr-byes">{round.byes.length > 0 ? round.byes.map((id) => names.get(id) ?? 'Removed player').join(', ') : <span className="muted">nobody</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * D17 round robin: generate / regenerate, progress, roster changes since it was made, and the
 * printable schedule (Print, or Save as PDF through the main process).
 */
export function RoundRobinPanel({ sessionId, sessionName, courts, names, presentCount, format, readOnly, version, showSchedule, onShowSchedule, onChanged }: Props) {
  const [status, setStatus] = useState<RoundRobinStatus | null>(null);
  const [rounds, setRounds] = useState<string>('');
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const unwrap = useCallback(async <T,>(promise: Promise<ApiResult<T>>): Promise<T | null> => {
    const res = await promise;
    if (res.ok) return res.value;
    setMessage({ tone: 'error', text: res.error });
    return null;
  }, []);

  const load = useCallback(async () => {
    const s = await unwrap(window.openPlay.getRoundRobinStatus(sessionId));
    if (s) setStatus(s);
  }, [sessionId, unwrap]);

  useEffect(() => {
    void load();
  }, [load, version, showSchedule]);

  const courtsInPlay = Math.max(1, courts.filter((c) => c.status === 'available').length);
  const suggested = defaultRoundRobinRounds(presentCount, courtsInPlay, format);
  const generate = async () => {
    setBusy(true);
    setMessage(null);
    const n = rounds.trim() === '' ? undefined : Number(rounds);
    const made = await unwrap(window.openPlay.generateRoundRobin(sessionId, n === undefined ? {} : { rounds: n }));
    setBusy(false);
    if (made) {
      setMessage({ tone: 'ok', text: `Schedule ready: ${made.rounds.length} rounds for ${made.playerIds.length} players on ${made.courtCount} ${made.courtCount === 1 ? 'court' : 'courts'}.` });
      await load();
      onChanged();
      onShowSchedule(true);
    }
  };

  const withPrintLayout = async (action: () => Promise<void> | void) => {
    document.body.classList.add('print-schedule');
    try {
      await action();
    } finally {
      document.body.classList.remove('print-schedule');
    }
  };
  const print = () => {
    document.body.classList.add('print-schedule');
    const done = () => {
      document.body.classList.remove('print-schedule');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  };
  const savePdf = () =>
    withPrintLayout(async () => {
      const file = await unwrap(window.openPlay.saveSchedulePdf(sessionId));
      if (file) setMessage({ tone: 'ok', text: `Schedule saved to ${file}.` });
    });

  const schedule = status?.schedule ?? null;
  const coverage = schedule ? roundRobinCoverage(schedule) : null;
  const late = status?.notInSchedule ?? [];
  const away = status?.away ?? [];
  const done = schedule !== null && status !== null && status.currentRound >= schedule.rounds.length;

  return (
    <div className="rr-panel" aria-label="Round-robin schedule">
      <strong>Round-robin schedule</strong>
      {schedule ? (
        <p className="rr-progress">
          {done ? 'All rounds started.' : `Round ${Math.min((status?.currentRound ?? 0) + 1, schedule.rounds.length)} of ${schedule.rounds.length}`} · {schedule.playerIds.length} players ·{' '}
          {schedule.courtCount} {schedule.courtCount === 1 ? 'court' : 'courts'}
          {coverage ? ` · ${format === 'doubles' ? 'partner pairs covered' : 'matchups covered'}: ${coverage.pairsCovered} of ${coverage.pairsTotal}` : ''}
        </p>
      ) : (
        <p className="hint">No schedule yet. Check players in, then generate it; Start this game will follow it round by round.</p>
      )}
      {late.length > 0 && schedule ? (
        <p className="banner rr-warn" role="status">
          {late.map((id) => names.get(id) ?? 'A player').join(', ')} {late.length === 1 ? 'checked in' : 'checked in'} after this schedule was made and only fill in for missing players. Regenerate to include{' '}
          {late.length === 1 ? 'them' : 'them all'} (the new schedule starts again at round 1).
        </p>
      ) : null}
      {away.length > 0 && schedule ? (
        <p className="hint">
          {away.map((id) => names.get(id) ?? 'A removed player').join(', ')} {away.length === 1 ? 'is' : 'are'} not available: the most-due waiting player fills in for{' '}
          {away.length === 1 ? 'them' : 'each of them'}.
        </p>
      ) : null}
      <div className="row">
        <label>
          Rounds{' '}
          <input
            type="number"
            className="rr-rounds"
            min={1}
            max={MAX_ROUND_ROBIN_ROUNDS}
            inputMode="numeric"
            value={rounds}
            disabled={readOnly}
            aria-describedby="rr-rounds-hint"
            onChange={(e) => setRounds(e.target.value)}
          />
        </label>
        <span id="rr-rounds-hint" className="hint">
          {suggested > 0 ? `Leave empty for one full cycle (${suggested} rounds for ${presentCount} players).` : 'Check in more players for a schedule.'}
        </span>
        <button disabled={readOnly || busy} onClick={() => void generate()}>
          {schedule ? 'Regenerate schedule' : 'Generate schedule'}
        </button>
        {schedule ? (
          <button className="secondary" onClick={() => onShowSchedule(true)}>
            View and print schedule
          </button>
        ) : null}
      </div>
      {message ? (
        <p className={message.tone === 'error' ? 'error' : 'hint'} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      ) : null}
      {showSchedule && schedule ? (
        <Modal
          title="Round-robin schedule"
          icon="🔄"
          className="modal-wide"
          onClose={() => onShowSchedule(false)}
          footer={
            <>
              <button type="button" className="secondary" onClick={() => onShowSchedule(false)}>
                Close
              </button>
              <button type="button" className="secondary" onClick={print}>
                <span className="btn-icon" aria-hidden="true">🖨️</span>Print
              </button>
              <button type="button" onClick={() => void savePdf()}>
                <span className="btn-icon" aria-hidden="true">📄</span>Save as PDF
              </button>
            </>
          }
        >
          <p className="hint">
            {sessionName} · {schedule.rounds.length} rounds · {schedule.playerIds.length} players. Byes rotate fairly; Start this game follows this schedule and ✓ marks games already started.
          </p>
          <div className="rr-scroll">
            <ScheduleTable schedule={schedule} status={status} courts={courts} names={names} />
          </div>
          {message ? <p className={message.tone === 'error' ? 'error' : 'hint'}>{message.text}</p> : null}
        </Modal>
      ) : null}
      {schedule
        ? createPortal(
            <div className="rr-print" aria-hidden="true">
              <h1>Round-robin schedule</h1>
              <p className="rr-print-sub">
                {sessionName} · {schedule.rounds.length} rounds · {schedule.playerIds.length} players · {schedule.format} · made {new Date(schedule.createdAt).toLocaleString()}
              </p>
              <ScheduleTable schedule={schedule} status={null} courts={courts} names={names} printable />
              <p className="rr-print-foot">Everyone partners everyone as evenly as the courts allow; byes rotate fairly. RallyFlow</p>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
