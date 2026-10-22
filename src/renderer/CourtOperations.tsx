import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_CHALLENGE_SETTINGS,
  DEFAULT_POOL_SETTINGS,
  isGroupingStyle,
  poolOfPlayer,
  POOL_NAMES,
  poolSettingsOf,
  settingsForTeamUp,
  teamUpOf,
  type PoolName,
  type PoolSettings,
  type QueueEntry,
  type Recommendation,
  type RecommendationResult,
  type RotationSettings,
  type TeamUpStyle,
} from '../core/rotation';
import { guideFor } from './teamUpOptions';
import type { ApiResult, PlayerDetails } from '../shared/api';
import type { Court, Game, Player, RosterEntry } from '../data/types';
import { Avatar } from './ui/Avatar';
import { useToast } from './ui/Toasts';
import { TeamUpPicker, type GuideContext, type RosterFix } from './TeamUpPicker';
import { RoundRobinPanel } from './RoundRobin';

interface Props {
  sessionId: string;
  sessionName: string;
  courts: Court[];
  roster: RosterEntry[];
  games: Game[];
  readOnly: boolean;
  /** D18 skill level, gender and pool by player id. */
  details: Record<string, PlayerDetails>;
  /** Opens the roster's player details editor (from the explanation window's shortcuts). */
  onEditDetails: (focus: RosterFix) => void;
  /** Called after anything changed so the parent reloads the session. */
  onChanged: () => void;
}

/** D17 skill pools: where pools come from, which courts they use and what a short pool does. */
function PoolsSettingsPanel({
  settings,
  courts,
  counts,
  readOnly,
  onSave,
}: {
  settings: PoolSettings;
  courts: Court[];
  counts: Record<PoolName, number>;
  readOnly: boolean;
  onSave: (pools: PoolSettings) => void;
}) {
  const three = settings.cutoffB !== null;
  const custom = Array.isArray(settings.courts);
  const save = (patch: Partial<PoolSettings>) => onSave({ ...settings, ...patch });
  const pools: PoolName[] = three ? ['A', 'B', 'C'] : ['A', 'B'];
  return (
    <div className="style-panel" aria-label="Skill pools settings">
      <strong>Skill pools</strong>
      <p className="hint">
        Players now: {pools.map((p) => `pool ${p} ${counts[p]}`).join(' · ')}. Players with neither a pool nor a skill level go in pool B.
      </p>
      <div className="row">
        <label>
          Pools from{' '}
          <select value={settings.source} disabled={readOnly} onChange={(e) => save({ source: e.target.value as PoolSettings['source'] })}>
            <option value="manual">Each player&apos;s pool, else skill level</option>
            <option value="skill">Skill level only</option>
          </select>
        </label>
        <label>
          Pool A from skill{' '}
          <input
            type="number"
            className="skill-input"
            min={1}
            max={8}
            step={0.25}
            value={settings.cutoffA}
            disabled={readOnly}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 1 && v <= 8 && (settings.cutoffB === null || v > settings.cutoffB)) save({ cutoffA: v });
            }}
          />
        </label>
        <label>
          <input type="checkbox" checked={three} disabled={readOnly} onChange={(e) => save({ cutoffB: e.target.checked ? Math.max(1, settings.cutoffA - 1) : null })} /> Use a third pool (C)
        </label>
        {three ? (
          <label>
            Pool B from skill{' '}
            <input
              type="number"
              className="skill-input"
              min={1}
              max={8}
              step={0.25}
              value={settings.cutoffB ?? ''}
              disabled={readOnly}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 1 && v < settings.cutoffA) save({ cutoffB: v });
              }}
            />
          </label>
        ) : null}
      </div>
      <div className="row">
        <label>
          Courts{' '}
          <select
            value={custom ? 'custom' : (settings.courts as string)}
            disabled={readOnly}
            onChange={(e) => {
              const v = e.target.value;
              save({ courts: v === 'custom' ? courts.map((_, i) => (i === 0 ? 'A' : 'B')) : (v as 'auto' | 'alternate') });
            }}
          >
            <option value="auto">Auto: by pool size, pool A on the top courts</option>
            <option value="alternate">Alternate: pools take turns</option>
            <option value="custom">Choose per court</option>
          </select>
        </label>
        {custom
          ? courts.map((c, i) => (
              <label key={c.id}>
                {c.label}{' '}
                <select
                  value={(settings.courts as PoolName[])[i] ?? 'A'}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = courts.map((_, j) => (settings.courts as PoolName[])[j] ?? 'B');
                    next[i] = e.target.value as PoolName;
                    save({ courts: next });
                  }}
                >
                  {pools.map((p) => (
                    <option key={p} value={p}>
                      Pool {p}
                    </option>
                  ))}
                </select>
              </label>
            ))
          : null}
        <label>
          When a pool is short{' '}
          <select value={settings.whenShort} disabled={readOnly} onChange={(e) => save({ whenShort: e.target.value as PoolSettings['whenShort'] })}>
            <option value="stay_open">Keep its court open (with the reason)</option>
            <option value="borrow">Borrow players from another pool</option>
          </select>
        </label>
      </div>
    </div>
  );
}

const minutesWaited = (ms: number): number => Math.floor(ms / 60000);

/** Queue, per-court recommendations with their explanations, assign / override / decline. */
export function CourtOperations({ sessionId, sessionName, courts, roster, games, readOnly, details, onEditDetails, onChanged }: Props) {
  const notify = useToast();
  const [showSchedule, setShowSchedule] = useState(false);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [result, setResult] = useState<RecommendationResult | null>(null);
  const [settings, setSettings] = useState<RotationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrideCourt, setOverrideCourt] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [pairA, setPairA] = useState('');
  const [pairB, setPairB] = useState('');

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

  const style: TeamUpStyle = settings ? teamUpOf(settings) : 'balanced';
  const grouping = isGroupingStyle(style);
  const balanced = settings?.fairness === 'balanced_games' || grouping;
  const fixedPairs = settings?.fixedPairs ?? [];
  const paired = new Set(fixedPairs.flat());
  const lockPair = async () => {
    if (await unwrap(window.openPlay.setRotationSettings(sessionId, { fixedPairs: [...fixedPairs, [pairA, pairB]] }))) {
      setPairA('');
      setPairB('');
      await load();
    }
  };
  const format = settings?.format ?? 'doubles';
  const needed = format === 'doubles' ? 4 : 2;
  const guide = guideFor(style);

  // D17/D18: what the explanation window and the style panels know about the roster
  const present = roster.filter((e) => e.checkedInAt !== null && e.availability === 'available');
  const basis = present.length > 0 ? present : roster;
  const skillOf = (e: RosterEntry): number | null => details[e.playerId]?.skillLevel ?? e.player.skillLevel;
  const missingSkill = basis.filter((e) => skillOf(e) === null);
  const guideContext: GuideContext = {
    players: basis.map((e) => ({ name: e.player.displayName, gender: details[e.playerId]?.gender ?? null, skill: skillOf(e) })),
    playerCount: basis.length,
    missingGender: basis.filter((e) => !details[e.playerId]?.gender).map((e) => e.player.displayName),
    missingSkill: missingSkill.map((e) => e.player.displayName),
    courtCount: courts.filter((c) => c.status === 'available').length,
    pairCount: fixedPairs.length,
    checkedInCount: present.length,
  };
  const genderCounts = {
    female: present.filter((e) => details[e.playerId]?.gender === 'female').length,
    male: present.filter((e) => details[e.playerId]?.gender === 'male').length,
    unset: present.filter((e) => !details[e.playerId]?.gender).length,
  };
  const poolSettings: PoolSettings = settings ? poolSettingsOf(settings) : { ...DEFAULT_POOL_SETTINGS };
  const poolCounts = Object.fromEntries(POOL_NAMES.map((p) => [p, 0])) as Record<PoolName, number>;
  for (const e of present) {
    const pool = details[e.playerId]?.pool;
    poolCounts[poolOfPlayer({ skillLevel: skillOf(e), ...(pool ? { pool } : {}) }, poolSettings)] += 1;
  }
  const challenge = { ...DEFAULT_CHALLENGE_SETTINGS, ...(settings?.challenge ?? {}) };

  /** Applies a style confirmed in the explanation window; round robin also makes the schedule and shows it. */
  const applyStyle = async (next: TeamUpStyle): Promise<boolean> => {
    const saved = await unwrap(window.openPlay.setRotationSettings(sessionId, settingsForTeamUp(next)));
    if (!saved) return false;
    let note = '';
    if (next === 'round_robin') {
      const made = await unwrap(window.openPlay.generateRoundRobin(sessionId));
      if (made) {
        note = ` Schedule ready: ${made.rounds.length} rounds.`;
        setShowSchedule(true);
      }
    }
    notify(`Team-up style: ${guideFor(next).title}.${note}`, { icon: guideFor(next).icon });
    await changed();
    return true;
  };
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
          <TeamUpPicker value={style} disabled={readOnly} context={guideContext} onFixRoster={onEditDetails} onApply={applyStyle} />
          <p className="hint">
            {guide.hint}
            {grouping ? ` ${guide.fairness}` : ''}
          </p>
          {style === 'fixed_partners' ? (
            <div className="fixed-pairs">
              <strong>Locked pairs</strong>
              {fixedPairs.length === 0 ? <p className="hint">No pairs locked yet. Players without a pair are teamed by the balanced rule.</p> : null}
              <ul>
                {fixedPairs.map((pair) => (
                  <li key={pair.join('+')}>
                    {pair.map(nameOf).join(' + ')}{' '}
                    <button
                      className="secondary"
                      disabled={readOnly}
                      onClick={() => void toggleSetting({ fixedPairs: fixedPairs.filter((p) => p !== pair) })}
                    >
                      Unlock {pair.map(nameOf).join(' + ')}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="row">
                {[
                  { value: pairA, set: setPairA, other: pairB, label: 'First partner' },
                  { value: pairB, set: setPairB, other: pairA, label: 'Second partner' },
                ].map((f) => (
                  <select key={f.label} aria-label={f.label} value={f.value} disabled={readOnly} onChange={(e) => f.set(e.target.value)}>
                    <option value="">{f.label}…</option>
                    {roster
                      .filter((e) => !paired.has(e.playerId) && e.playerId !== f.other)
                      .map((e) => (
                        <option key={e.playerId} value={e.playerId}>
                          {e.player.displayName}
                        </option>
                      ))}
                  </select>
                ))}
                <button disabled={readOnly || pairA === '' || pairB === '' || pairA === pairB} onClick={() => void lockPair()}>
                  Lock pair
                </button>
              </div>
            </div>
          ) : null}
          {style === 'mixed' ? (
            <div className="style-panel" aria-label="Mixed doubles players">
              <strong>Mixed doubles</strong>
              <p className="hint">
                Checked in: {genderCounts.female} women · {genderCounts.male} men · {genderCounts.unset} not set.
                {genderCounts.unset > 0 ? ' Players without a gender fill in on either side.' : ''}
              </p>
              {genderCounts.unset > 0 ? (
                <button className="secondary" onClick={() => onEditDetails('genders')}>
                  Set genders
                </button>
              ) : null}
            </div>
          ) : null}
          {style === 'mentor' ? (
            <div className="style-panel" aria-label="Mentor pairing players">
              <strong>Mentor pairing</strong>
              <p className="hint">
                {present.length - missingSkill.length} of {present.length} checked-in players have a skill level; unrated players count as the middle level.
              </p>
              {missingSkill.length > 0 ? (
                <button className="secondary" onClick={() => onEditDetails('skills')}>
                  Set skill levels
                </button>
              ) : null}
            </div>
          ) : null}
          {style === 'pools' ? (
            <PoolsSettingsPanel settings={poolSettings} courts={courts} counts={poolCounts} readOnly={readOnly} onSave={(pools) => void toggleSetting({ pools })} />
          ) : null}
          {style === 'challenge' ? (
            <div className="style-panel" aria-label="Challenge court settings">
              <strong>Challenge court</strong>
              <div className="row">
                <label>
                  Winners stay on for up to{' '}
                  <select
                    value={challenge.cap}
                    disabled={readOnly}
                    onChange={(e) => void toggleSetting({ challenge: { ...challenge, cap: Number(e.target.value) } })}
                  >
                    {[1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        {n} {n === 1 ? 'game' : 'games'} in a row
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Challenge court{' '}
                  <select
                    value={challenge.courts}
                    disabled={readOnly}
                    onChange={(e) => void toggleSetting({ challenge: { ...challenge, courts: e.target.value as 'first' | 'all' } })}
                  >
                    <option value="first">{courts[0]?.label ?? 'Court 1'} only</option>
                    <option value="all">Every court</option>
                  </select>
                </label>
              </div>
            </div>
          ) : null}
          {style === 'round_robin' ? (
            <RoundRobinPanel
              sessionId={sessionId}
              sessionName={sessionName}
              courts={courts}
              names={names}
              presentCount={present.length}
              format={format}
              readOnly={readOnly}
              version={`${games.length}:${games.filter((g) => g.status === 'in_progress').length}:${roster.length}:${present.length}`}
              showSchedule={showSchedule}
              onShowSchedule={setShowSchedule}
              onChanged={() => void changed()}
            />
          ) : null}
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
              checked={settings.skillBalancing && !grouping}
              disabled={readOnly || grouping}
              title={grouping ? 'The team-up style decides the teams' : undefined}
              onChange={(e) => void toggleSetting({ skillBalancing: e.target.checked })}
            />{' '}
            Balance by skill{grouping ? ' (off: the team-up style decides the teams)' : ''}
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.partnerRotation || balanced}
              disabled={readOnly || balanced}
              title={balanced ? 'Always on while balancing games played' : undefined}
              onChange={(e) => void toggleSetting({ partnerRotation: e.target.checked })}
            />{' '}
            Rotate partners{grouping ? ' (the team-up style splits partners)' : balanced ? ' (always on when balancing games)' : ''}
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
