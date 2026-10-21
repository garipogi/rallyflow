import { useCallback, useEffect, useState } from 'react';
import type { ApiResult } from '../shared/api';
import type { PlayerLeaderboardRow } from '../data/stats';
import type { Session } from '../data/types';

type Scope = 'session' | 'historical';

/** D9: the leaderboard shows games played for everyone and labels players below the threshold as unranked. */
function Leaderboard({ rows }: { rows: PlayerLeaderboardRow[] }) {
  if (rows.length === 0) return <p>No players yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Rank</th>
          <th>Player</th>
          <th>Games played</th>
          <th>W-L</th>
          <th>Win %</th>
          <th>Point diff</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.playerId}>
            <td>{r.ranked ? `${r.tied ? 'T' : ''}${r.rank}` : <span className="badge">unranked</span>}</td>
            <td>{r.displayName}</td>
            <td>{r.gamesPlayed}</td>
            <td>
              {r.wins}-{r.losses}
            </td>
            <td>{Math.round(r.winPct * 100)}%</td>
            <td>{r.pointDiff > 0 ? `+${r.pointDiff}` : r.pointDiff}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Leaderboards, export and backup / restore. Restore asks for confirmation in a native dialog. */
export function Reports({ sessions, onDataReplaced }: { sessions: Session[]; onDataReplaced: () => void }) {
  const [scope, setScope] = useState<Scope>('session');
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? '');
  const [rows, setRows] = useState<PlayerLeaderboardRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const unwrap = useCallback(async <T,>(promise: Promise<ApiResult<T>>): Promise<T | null> => {
    const result = await promise;
    if (result.ok) {
      setError(null);
      return result.value;
    }
    setError(result.error);
    return null;
  }, []);

  useEffect(() => {
    void (async () => {
      if (scope === 'session' && sessionId === '') {
        setRows([]);
        return;
      }
      const loaded = await unwrap(scope === 'session' ? window.openPlay.getSessionLeaderboard(sessionId) : window.openPlay.getHistoricalLeaderboard());
      if (loaded) setRows(loaded);
    })();
  }, [scope, sessionId, unwrap]);

  const exportAs = async (format: 'csv' | 'xlsx') => {
    const done = await unwrap(window.openPlay.exportData(format, scope === 'session' && sessionId !== '' ? sessionId : undefined));
    if (done) setNotice(`Exported ${done.files.length} file(s). Your session data was not changed.`);
  };

  return (
    <section>
      <h2>Reports and data</h2>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p>{notice}</p> : null}
      <div className="row">
        <label>
          Scope{' '}
          <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="session">This session (ranked from 3 games)</option>
            <option value="historical">All sessions (ranked from 10 games)</option>
          </select>
        </label>
        {scope === 'session' ? (
          <select aria-label="Session" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <Leaderboard rows={rows} />
      <div className="row">
        <button onClick={() => void exportAs('csv')}>Export CSV</button>
        <button onClick={() => void exportAs('xlsx')}>Export Excel</button>
        <button
          className="secondary"
          onClick={async () => {
            const made = await unwrap(window.openPlay.createBackup());
            if (made) setNotice(`Backup saved to ${made.file}.`);
          }}
        >
          Back up data
        </button>
        <button
          className="secondary"
          onClick={async () => {
            const restored = await unwrap(window.openPlay.restoreBackup());
            if (restored) {
              setNotice(`Backup restored. Your previous data was saved to ${restored.autoBackupFile}.`);
              onDataReplaced();
            }
          }}
        >
          Restore from backup
        </button>
      </div>
    </section>
  );
}
