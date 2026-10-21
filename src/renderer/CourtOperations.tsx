import { useCallback, useEffect, useState } from 'react';
import type { QueueEntry, Recommendation, RecommendationResult, RotationSettings } from '../core/rotation';
import type { ApiResult } from '../shared/api';
import type { Court, Game, Player, RosterEntry } from '../data/types';
import { Avatar } from './ui/Avatar';

interface Props {
  sessionId: string;
  courts: Court[];
  roster: RosterEntry[];
  games: Game[];
  readOnly: boolean;
  /** Called after anything changed so the parent reloads the session. */
  onChanged: () => void;
}

const minutesWaited = (ms: number): number => Math.floor(ms / 60000);

/** Queue, per-court recommendations with their explanations, assign / override / decline. */
export function CourtOperations({ sessionId, courts, roster, games, readOnly, onChanged }: Props) {
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [result, setResult] = useState<RecommendationResult | null>(null);
  const [settings, setSettings] = useState<RotationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrideCourt, setOverrideCourt] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState('');

  const names = new Map<string, Player['displayName']>(roster.map((e) => [e.playerId, e.player.displayName]));
  const nameOf = (id: string): string => names.get(id) ?? id;
  const busyCourts = new Set(games.filter((g) => g.status === 'in_progress').map((g) => g.courtId));

  const unwrap = useCallback(async <T,>(promise: Promise<ApiResult<T>>): Promise<T | null> => {
    const res = await promise;
    if (res.ok) {
      setError(null);
      return res.value;
    }
    setError(res.error);
    return null;
  }, []);

  const load = useCallback(async () => {
    const [q, r, s] = await Promise.all([
      unwrap(window.openPlay.getQueue(sessionId)),
      unwrap(window.openPlay.recommendNextGames(sessionId)),
      unwrap(window.openPlay.getRotationSettings(sessionId)),
    ]);
    if (q) setQueue(q);
    if (r) setResult(r);
    if (s) setSettings(s);
  }, [sessionId, unwrap]);

  useEffect(() => {
    void load();
  }, [load, courts, roster, games]);

  const changed = async () => {
    await load();
    onChanged();
  };

  const assign = async (rec: Recommendation) => {
    if (await unwrap(window.openPlay.assignRecommendation(sessionId, rec))) await changed();
  };

  const decline = async (playerId: string) => {
    if (await unwrap(window.openPlay.declineTurn(sessionId, playerId))) await changed();
  };

  const toggleSetting = async (patch: Partial<RotationSettings>) => {
    if (await unwrap(window.openPlay.setRotationSettings(sessionId, patch))) await load();
  };

  const balanced = settings?.fairness === 'balanced_games';
  const format = settings?.format ?? 'doubles';
  const needed = format === 'doubles' ? 4 : 2;
  const override = async () => {
    const half = needed / 2;
    const ok = await unwrap(
      window.openPlay.assignManually(sessionId, {
        courtId: overrideCourt,
        format,
        teamA: picked.slice(0, half),
        teamB: picked.slice(half),
        reason,
      }),
    );
    if (ok) {
      setPicked([]);
      setReason('');
      await changed();
    }
  };

  const onDeck = new Set([...(result?.recommendations[0]?.teamA ?? []), ...(result?.recommendations[0]?.teamB ?? [])]);
  const longestWait = Math.max(60000, ...queue.map((e) => e.waitedMs));
  const freeCourts = courts.filter((c) => c.status === 'available' && !busyCourts.has(c.id));
  const waiting = new Set(queue.map((e) => e.playerId));

  return (
    <div className="next-up">
      <h3>
        <span aria-hidden="true">⏭️ </span>Next up
      </h3>
      {error ? <p className="error">{error}</p> : null}
      <h4>Recommended games</h4>
      {result && result.recommendations.length === 0 && result.openCourts.length === 0 ? (
        <p className="hint">No free court right now. Recommendations appear here as soon as a court frees up.</p>
      ) : null}
      {result?.recommendations.map((rec, i) => (
        <div className={`rec-card${i === 0 ? ' on-deck' : ''}`} key={rec.courtId}>
          <div className="rec-head">
            {i === 0 ? <span className="on-deck-tag">On deck</span> : null}
            <strong>{rec.courtLabel}</strong>
          </div>
          <div className="rec-teams">
            <span className="rec-team">
              <span className="avatars">
                {rec.teamA.map((id) => (
                  <Avatar key={id} playerId={id} name={nameOf(id)} />
                ))}
              </span>
              {rec.teamA.map(nameOf).join(' & ')}
            </span>
            <span className="vs">vs</span>
            <span className="rec-team">
              <span className="avatars">
                {rec.teamB.map((id) => (
                  <Avatar key={id} playerId={id} name={nameOf(id)} />
                ))}
              </span>
              {rec.teamB.map(nameOf).join(' & ')}
            </span>
          </div>
          <p>{rec.explanation}</p>
          <div>
            <button disabled={readOnly} onClick={() => void assign(rec)}>
              Start this game
            </button>
          </div>
        </div>
      ))}
      {result?.openCourts.map((open) => (
        <p key={open.courtId}>{open.reason}</p>
      ))}

      <h4>Waiting queue ({queue.length})</h4>
      {queue.length === 0 ? <p className="hint">Nobody is waiting. Checked-in players who are not on a court line up here.</p> : null}
      <table className="queue-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Waited</th>
            <th>Games</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {queue.map((entry) => (
            <tr key={entry.playerId} className={onDeck.has(entry.playerId) ? 'on-deck-row' : undefined}>
              <td>
                <span className="queue-pos">{entry.position}</span>
              </td>
              <td>
                <span className="who">
                  <Avatar playerId={entry.playerId} name={entry.displayName} />
                  <span>
                    {entry.displayName}
                    {entry.declinedCurrentTurn ? ' (declined this turn)' : ''}
                  </span>
                </span>
              </td>
              <td>
                <span className="wait">
                  <span className="wait-bar" aria-hidden="true">
                    <span className="wait-fill" style={{ width: `${Math.round((entry.waitedMs / longestWait) * 100)}%` }} />
                  </span>
                  {minutesWaited(entry.waitedMs)} min
                </span>
              </td>
              <td>
                <span className="games-count">{entry.gamesPlayed}</span>
                {entry.gameCredit ? <span className="hint"> (+{entry.gameCredit} catch-up)</span> : null}
              </td>
              <td>
                <button className="secondary" disabled={readOnly || entry.declinedCurrentTurn} onClick={() => void decline(entry.playerId)}>
                  Decline turn
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <details className="more">
        <summary>Game settings and manual override</summary>
      {settings ? (
        <div>
          <label>
            Who plays next{' '}
            <select
              value={balanced ? 'balanced_games' : 'wait_time'}
              disabled={readOnly}
              onChange={(e) =>
                void toggleSetting(
                  e.target.value === 'balanced_games'
                    ? { fairness: 'balanced_games', partnerRotation: true }
                    : { fairness: 'wait_time' },
                )
              }
            >
              <option value="balanced_games">Balance games played (recommended)</option>
              <option value="wait_time">Longest wait first</option>
            </select>
          </label>
          <p className="hint">
            {balanced
              ? 'Players with the fewest games go first, then the longest wait; late arrivals start level with the regulars and partners rotate.'
              : 'Longest wait goes first; ties go to whoever checked in earlier, which can give early arrivals extra games.'}
          </p>
        </div>
      ) : null}
      {settings ? (
        <div className="row">
          <label>
            Format{' '}
            <select
              value={settings.format}
              disabled={readOnly}
              onChange={(e) => void toggleSetting({ format: e.target.value as RotationSettings['format'] })}
            >
              <option value="doubles">Doubles</option>
              <option value="singles">Singles</option>
            </select>
          </label>
          <label>
            Declined turn{' '}
            <select
              value={settings.declinePolicy.kind}
              disabled={readOnly}
              onChange={(e) => {
                const kind = e.target.value;
                void toggleSetting({
                  declinePolicy:
                    kind === 'drop_places'
                      ? { kind: 'drop_places', places: 2 }
                      : { kind: kind as 'back_of_queue' | 'keep_spot' },
                });
              }}
            >
              <option value="back_of_queue">Back of the queue</option>
              <option value="keep_spot">Keep spot, skip once</option>
              <option value="drop_places">Drop 2 places</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.skillBalancing}
              disabled={readOnly}
              onChange={(e) => void toggleSetting({ skillBalancing: e.target.checked })}
            />{' '}
            Balance by skill
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.partnerRotation || balanced}
              disabled={readOnly || balanced}
              title={balanced ? 'Always on while balancing games played' : undefined}
              onChange={(e) => void toggleSetting({ partnerRotation: e.target.checked })}
            />{' '}
            Rotate partners{balanced ? ' (always on when balancing games)' : ''}
          </label>
        </div>
      ) : null}

      <h4>Manual override</h4>
      <p>Pick a free court and {needed} waiting players (first {needed / 2} form team A), then say why you are overriding the queue.</p>
      <div className="row">
        <select aria-label="Court" value={overrideCourt} disabled={readOnly} onChange={(e) => setOverrideCourt(e.target.value)}>
          <option value="">Court…</option>
          {freeCourts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        {roster
          .filter((e) => waiting.has(e.playerId))
          .map((e) => (
            <label key={e.playerId}>
              <input
                type="checkbox"
                checked={picked.includes(e.playerId)}
                disabled={readOnly || (!picked.includes(e.playerId) && picked.length >= needed)}
                onChange={(ev) =>
                  setPicked(ev.target.checked ? [...picked, e.playerId] : picked.filter((id) => id !== e.playerId))
                }
              />{' '}
              {e.player.displayName}
            </label>
          ))}
      </div>
      <div className="row">
        <input aria-label="Reason for override" value={reason} disabled={readOnly} onChange={(e) => setReason(e.target.value)} />
        <button
          disabled={readOnly || overrideCourt === '' || picked.length !== needed || reason.trim() === ''}
          onClick={() => void override()}
        >
          Start with override
        </button>
      </div>
      </details>
    </div>
  );
}
