import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiResult, PlayerDetails } from '../shared/api';
import type { Appearance } from '../shared/themes';
import { AppearancePicker, useAppearance } from './AppearancePicker';
import { Avatar } from './ui/Avatar';
import { Logo } from './ui/Logo';
import { BRAND } from '../shared/brand';
import { ToastProvider, useToast } from './ui/Toasts';
import { CourtBoard } from './CourtBoard';
import { CourtOperations } from './CourtOperations';
import { Reports } from './Reports';
import { Awards } from './Awards';
import { COURT_CHOICES } from './teamUpOptions';
import type { Gender, PoolName, TeamUpStyle } from '../core/rotation';
import { TeamUpPicker, type RosterFix } from './TeamUpPicker';
import { ScoringModePicker } from './ScoringModePicker';
import { isQuickResult } from './QuickResult';
import { DEFAULT_SCORE_ENTRY, scoreEntryOf, scoreLine, type ScoreEntryMode } from '../core/scoring/quickResult';
import { GENDER_OPTIONS, levelText, parseSkill, PlayerDetailsEditor, POOL_OPTIONS } from './PlayerDetails';
import type { Player, RosterEntry, Session, SessionState } from '../data/types';

interface AppearanceControl {
  appearance: Appearance;
  systemDark: boolean;
  onChange: (a: Appearance) => void;
}

/** The app bar: logo, what is going on right now, and the appearance control. */
function AppHeader({ look, subtitle, chips }: { look: AppearanceControl; subtitle?: string; chips?: ReactNode }) {
  return (
    <header className="app-header">
      <div className="brand">
        <Logo size={44} />
        <div className="brand-text">
          <h1 className="brand-name">{BRAND.name}</h1>
          <span className="brand-tagline">{BRAND.tagline}</span>
        </div>
        {subtitle ? <span className="brand-sub">{subtitle}</span> : null}
      </div>
      {chips ? <div className="header-chips">{chips}</div> : <div className="header-chips" />}
      <AppearancePicker appearance={look.appearance} systemDark={look.systemDark} onChange={look.onChange} />
    </header>
  );
}

function Chip({ icon, children, tone }: { icon: string; children: ReactNode; tone?: 'live' | 'done' | 'plain' }) {
  return (
    <span className={`hchip${tone ? ` hchip-${tone}` : ''}`}>
      <span className="hchip-icon" aria-hidden="true">
        {icon}
      </span>
      {children}
    </span>
  );
}

/** Turns "what changed since the last load" into friendly toasts. */
function useChangeToasts(state: SessionState | null) {
  const notify = useToast();
  const previous = useRef<SessionState | null>(null);
  useEffect(() => {
    const prev = previous.current;
    previous.current = state;
    if (!state || !prev || prev.session.id !== state.session.id) return;
    const nameOf = new Map(state.roster.map((r) => [r.playerId, r.player.displayName]));
    const courtLabel = new Map(state.courts.map((c) => [c.id, c.label]));
    const before = new Map(prev.roster.map((r) => [r.playerId, r]));
    for (const entry of state.roster) {
      const old = before.get(entry.playerId);
      if (!old) notify(`Player added: ${entry.player.displayName}`, { icon: '👋' });
      else if (old.checkedInAt === null && entry.checkedInAt !== null) notify(`${entry.player.displayName} checked in`, { icon: '✅' });
    }
    const prevGames = new Map(prev.games.map((g) => [g.id, g]));
    for (const game of state.games) {
      const old = prevGames.get(game.id);
      const court = courtLabel.get(game.courtId) ?? 'court';
      if (!old && (game.status === 'scheduled' || game.status === 'in_progress')) {
        notify(`Game started on ${court}`, { icon: '🏓', tone: 'info' });
      } else if (old && old.status !== 'completed' && game.status === 'completed' && game.winner && !isQuickResult(game.id)) {
        const winners = game.participants
          .filter((p) => p.team === game.winner)
          .map((p) => nameOf.get(p.playerId) ?? '')
          .join(' & ');
        const scoreless = game.teamAScore === 0 && game.teamBScore === 0;
        const score = scoreless ? '' : ` ${scoreLine(Math.max(game.teamAScore, game.teamBScore), Math.min(game.teamAScore, game.teamBScore))}`;
        notify(`Result recorded on ${court}: ${winners} win${score}`, { tone: 'celebrate' });
      }
    }
  }, [state, notify]);
}

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<Player[]>([]);
  const call = useCallback(async <T,>(promise: Promise<ApiResult<T>>): Promise<T | null> => {
    const result = await promise;
    if (result.ok) {
      setError(null);
      setMatches([]);
      return result.value;
    }
    setError(result.error);
    setMatches(result.matches ?? []);
    return null;
  }, []);
  const clear = useCallback(() => {
    setError(null);
    setMatches([]);
  }, []);
  return { error, matches, call, clear };
}

const describePlayer = (p: Player) => (p.nickname ? `${p.displayName} (${p.nickname})` : p.displayName);

interface RosterRowProps {
  sessionId: string;
  entry: RosterEntry;
  readOnly: boolean;
  /** D18 skill level, gender and pool. */
  details: PlayerDetails | undefined;
  onChanged: () => Promise<void>;
}

/** One roster line: check-in status, availability, inline name editing and removal. */
function RosterRow({ sessionId, entry, readOnly, details, onChanged }: RosterRowProps) {
  const { error, matches, call, clear } = useAction();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(entry.player.displayName);
  const [draftNickname, setDraftNickname] = useState(entry.player.nickname ?? '');
  const [draftSkill, setDraftSkill] = useState('');
  const [draftGender, setDraftGender] = useState<'' | Gender>('');
  const [draftPool, setDraftPool] = useState<'' | PoolName>('');
  const [skillError, setSkillError] = useState<string | null>(null);
  const shownName = entry.player.displayName;
  const skill = details?.skillLevel ?? entry.player.skillLevel;
  const level = levelText(details ? { ...details, skillLevel: skill } : undefined);

  const act = async <T,>(promise: Promise<ApiResult<T>>) => {
    await call(promise);
    await onChanged();
  };

  const startEdit = () => {
    setDraftName(entry.player.displayName);
    setDraftNickname(entry.player.nickname ?? '');
    setDraftSkill(skill !== null ? String(skill) : '');
    setDraftGender(details?.gender ?? '');
    setDraftPool(details?.pool ?? '');
    setSkillError(null);
    setEditing(true);
  };

  const save = async (allowDuplicateName: boolean) => {
    const parsedSkill = parseSkill(draftSkill);
    if (parsedSkill === 'invalid') {
      setSkillError('Skill level must be a number from 1 to 8, or empty.');
      return;
    }
    const saved = await call(
      window.openPlay.renamePlayer(entry.playerId, {
        displayName: draftName,
        nickname: draftNickname.trim() === '' ? null : draftNickname,
        allowDuplicateName,
      }),
    );
    if (!saved) return;
    const detailsSaved = await call(
      window.openPlay.updatePlayerDetails(entry.playerId, {
        skillLevel: parsedSkill,
        gender: draftGender === '' ? null : draftGender,
        pool: draftPool === '' ? null : draftPool,
      }),
    );
    if (detailsSaved) {
      setSkillError(null);
      setEditing(false);
    }
    await onChanged();
  };

  const cancel = () => {
    setEditing(false);
    setSkillError(null);
    clear();
  };

  return (
    <>
      <tr>
        {editing ? (
          <>
            <td>
              <input aria-label={`New name for ${shownName}`} value={draftName} onChange={(e) => setDraftName(e.target.value)} />
            </td>
            <td>
              <input
                aria-label={`New nickname for ${shownName}`}
                value={draftNickname}
                onChange={(e) => setDraftNickname(e.target.value)}
              />
            </td>
          </>
        ) : (
          <>
            <td>
              <span className="who">
                <Avatar playerId={entry.playerId} name={shownName} />
                <span className="who-name">{shownName}</span>
              </span>
            </td>
            <td className="muted-cell">{entry.player.nickname ?? ''}</td>
          </>
        )}
        <td className="level-cell">
          {editing ? (
            <div className="level-edit">
              <input
                className="skill-input"
                aria-label={`Skill level for ${shownName}`}
                inputMode="decimal"
                value={draftSkill}
                onChange={(e) => setDraftSkill(e.target.value)}
              />
              <select aria-label={`Gender for ${shownName}`} value={draftGender} onChange={(e) => setDraftGender(e.target.value as '' | Gender)}>
                {GENDER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select aria-label={`Pool for ${shownName}`} value={draftPool} onChange={(e) => setDraftPool(e.target.value as '' | PoolName)}>
                {POOL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          ) : level !== '' ? (
            <span className="level-chip">{level}</span>
          ) : (
            <span className="muted">-</span>
          )}
        </td>
        <td>
          {entry.checkedInAt === null ? (
            <span className="badge pending">not checked in</span>
          ) : (
            <>
              <span className="badge checked-in">Checked in</span>{' '}
              <span className={`avail avail-${entry.availability}`}>{entry.availability}</span>
            </>
          )}
        </td>
        <td className="row row-actions">
          {editing ? (
            <>
              <button disabled={draftName.trim() === ''} onClick={() => void save(false)}>
                Save
              </button>
              <button className="secondary" onClick={cancel}>
                Cancel
              </button>
            </>
          ) : (
            <>
              {entry.checkedInAt === null ? (
                <button disabled={readOnly} onClick={() => void act(window.openPlay.checkInPlayer(sessionId, entry.playerId))}>
                  Check in
                </button>
              ) : null}
              <button
                className="secondary"
                disabled={readOnly || entry.checkedInAt === null}
                onClick={() =>
                  void act(
                    window.openPlay.setAvailability(
                      sessionId,
                      entry.playerId,
                      entry.availability === 'resting' ? 'available' : 'resting',
                    ),
                  )
                }
              >
                {entry.availability === 'resting' ? 'Back from rest' : 'Rest'}
              </button>
              <button className="secondary" aria-label={`Edit name and details of ${shownName}`} onClick={startEdit}>
                Edit
              </button>
              <button
                className="secondary"
                disabled={readOnly}
                onClick={() => void act(window.openPlay.removePlayer(sessionId, entry.playerId))}
              >
                Remove
              </button>
            </>
          )}
        </td>
      </tr>
      {skillError ? (
        <tr>
          <td colSpan={5}>
            <p className="error">{skillError}</p>
          </td>
        </tr>
      ) : null}
      {error ? (
        <tr>
          <td colSpan={5}>
            <p className="error">{error}</p>
            {editing && matches.length > 0 ? (
              <div className="banner">
                <strong>Already in the player list:</strong>
                {matches.map((p) => (
                  <div key={p.id}>{describePlayer(p)}</div>
                ))}
                <div className="row">
                  <button onClick={() => void save(true)}>Keep as a different person</button>
                  <button className="secondary" onClick={cancel}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function SessionRoom({
  sessionId,
  look,
  onClose,
  onOpenAwards,
}: {
  sessionId: string;
  look: AppearanceControl;
  onClose: () => void;
  onOpenAwards: () => void;
}) {
  const { error, matches, call } = useAction();
  const [registry, setRegistry] = useState<Player[]>([]);
  const [state, setState] = useState<SessionState | null>(null);
  const [name, setName] = useState('');
  const [nickname, setNickname] = useState('');
  const [newSkill, setNewSkill] = useState('');
  const [newGender, setNewGender] = useState<'' | Gender>('');
  const [details, setDetails] = useState<Record<string, PlayerDetails>>({});
  const [detailsEditor, setDetailsEditor] = useState<{ focus: RosterFix | null } | null>(null);
  const [scoreEntry, setScoreEntry] = useState<ScoreEntryMode>(DEFAULT_SCORE_ENTRY);

  const refresh = useCallback(async () => {
    const loaded = await call(window.openPlay.loadSessionState(sessionId));
    if (loaded) setState(loaded);
    const settings = await call(window.openPlay.getRotationSettings(sessionId));
    if (settings) setScoreEntry(scoreEntryOf(settings));
    const players = await call(window.openPlay.listPlayers());
    if (players) setRegistry(players);
    const profile = await call(window.openPlay.listPlayerDetails());
    if (profile) setDetails(profile);
  }, [call, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useChangeToasts(state);

  if (!state) {
    return (
      <>
        <AppHeader look={look} subtitle="Opening session" />
        <main>
          <section className="skeleton-card" aria-busy="true">
            Loading session…
            <div className="skeleton-line" />
            <div className="skeleton-line short" />
            {error ? <p className="error">{error}</p> : null}
          </section>
        </main>
      </>
    );
  }
  const { session, roster, courts, games } = state;
  const readOnly = session.status === 'completed';
  const activeGames = games.filter((g) => g.status === 'scheduled' || g.status === 'in_progress');
  const playing = new Set(activeGames.flatMap((g) => g.participants.map((p) => p.playerId)));
  const checkedIn = roster.filter((r) => r.checkedInAt !== null).length;
  const waitingCount = roster.filter((r) => r.checkedInAt !== null && r.availability === 'available' && !playing.has(r.playerId)).length;
  const finished = games.filter((g) => g.status === 'completed').length;
  const chips = (
    <>
      <Chip icon={readOnly ? '🏁' : '●'} tone={readOnly ? 'done' : 'live'}>
        {readOnly ? 'Completed' : 'Live'}
      </Chip>
      <Chip icon="🏟️">
        {activeGames.length}/{courts.length} in play
      </Chip>
      <Chip icon="✅">{checkedIn} checked in</Chip>
      <Chip icon="⏳">{waitingCount} waiting</Chip>
      <Chip icon="🏓">
        {finished} {finished === 1 ? 'game' : 'games'} done
      </Chip>
    </>
  );

  const newSkillParsed = parseSkill(newSkill);
  const addPlayer = async (allowDuplicateName: boolean) => {
    if (newSkillParsed === 'invalid') return;
    const entry = await call(
      window.openPlay.addNewPlayer(sessionId, {
        displayName: name,
        nickname: nickname.trim() === '' ? null : nickname,
        allowDuplicateName,
        ...(newSkillParsed !== null ? { skillLevel: newSkillParsed } : {}),
        ...(newGender !== '' ? { gender: newGender } : {}),
      }),
    );
    if (entry) {
      setName('');
      setNickname('');
      setNewSkill('');
      setNewGender('');
      await refresh();
    }
  };

  const saveDetails = async (playerId: string, patch: Parameters<typeof window.openPlay.updatePlayerDetails>[1]): Promise<boolean> => {
    const saved = await call(window.openPlay.updatePlayerDetails(playerId, patch));
    if (saved) setDetails((d) => ({ ...d, [playerId]: saved }));
    return saved !== null;
  };

  const addExisting = async (playerId: string) => {
    const entry = await call(window.openPlay.addExistingPlayer(sessionId, playerId));
    if (entry) {
      setName('');
      setNickname('');
      await refresh();
    }
  };

  const onRoster = new Set(roster.map((entry) => entry.playerId));
  const query = name.trim().toLowerCase();
  const registryHits =
    query === ''
      ? []
      : registry.filter(
          (p) =>
            !onRoster.has(p.id) &&
            (p.displayName.toLowerCase().includes(query) || (p.nickname ?? '').toLowerCase().includes(query)),
        );
  const describe = describePlayer;

  return (
    <>
    <AppHeader look={look} subtitle={session.name} chips={chips} />
    <main>
    <section className="session-room">
      <div className="session-bar">
        <button className="secondary back" onClick={onClose}>
          <span className="btn-icon" aria-hidden="true">←</span>Back to sessions
        </button>
        <div className="session-title">
          <h2>{session.name}</h2>
          <span className={`badge ${readOnly ? 'badge-done' : 'badge-live'}`}>{readOnly ? 'Completed (read-only)' : 'Active'}</span>
        </div>
        <div className="session-actions">
          <button className="secondary" onClick={() => void call(window.openPlay.openDisplay(sessionId))}>
            <span className="btn-icon" aria-hidden="true">📺</span>Open display
          </button>
          <button className="awards-nav" onClick={onOpenAwards}>
            <span className="btn-icon" aria-hidden="true">🏆</span>Awards
          </button>
          {readOnly ? (
            <button
              onClick={async () => {
                await call(window.openPlay.reopenSession(sessionId));
                await refresh();
              }}
            >
              Reopen for corrections
            </button>
          ) : (
            <button
              className="finish"
              onClick={async () => {
                await call(window.openPlay.finishSession(sessionId));
                await refresh();
              }}
            >
              <span className="btn-icon" aria-hidden="true">🏁</span>Finish session
            </button>
          )}
          <button
            className="danger"
            onClick={async () => {
              if ((await call(window.openPlay.deleteSession(sessionId))) === true) onClose();
            }}
          >
            Delete session
          </button>
        </div>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}

      <CourtBoard
        sessionId={sessionId}
        courts={courts}
        roster={roster}
        games={games}
        readOnly={readOnly}
        courtCount={session.courtCount}
        scoreEntry={scoreEntry}
        rules={{ targetScore: session.targetScore, winBy: session.winBy }}
        onChanged={() => void refresh()}
      />

      <CourtOperations
        sessionId={sessionId}
        sessionName={session.name}
        courts={courts}
        roster={roster}
        games={games}
        readOnly={readOnly}
        details={details}
        onEditDetails={(focus) => setDetailsEditor({ focus })}
        onChanged={() => void refresh()}
      />

      <div className="players-card">
      <div className="section-head">
        <h3>
          <span aria-hidden="true">👥 </span>Players ({roster.length})
        </h3>
        <span className="hint">
          {checkedIn} checked in · {roster.length - checkedIn} still to arrive
        </span>
        {roster.length > 0 && !detailsEditor ? (
          <button className="secondary" onClick={() => setDetailsEditor({ focus: null })}>
            Player details (skill, gender, pool)
          </button>
        ) : null}
      </div>
      {newSkillParsed === 'invalid' ? <p className="error">Skill level must be a number from 1 to 8, or empty.</p> : null}
      {detailsEditor ? (
        <PlayerDetailsEditor
          roster={roster}
          details={details}
          readOnly={readOnly}
          focus={detailsEditor.focus}
          onSave={saveDetails}
          onClose={() => setDetailsEditor(null)}
        />
      ) : null}
      <div className="row add-player">
        <label className="field">
          Player name
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} />
        </label>
        <label className="field">
          Nickname <span className="hint">(optional)</span>
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} disabled={readOnly} />
        </label>
        <label className="field field-narrow">
          Skill <span className="hint">(1-8, optional)</span>
          <input
            className="skill-input"
            inputMode="decimal"
            value={newSkill}
            onChange={(e) => setNewSkill(e.target.value)}
            disabled={readOnly}
            aria-invalid={newSkillParsed === 'invalid'}
          />
        </label>
        <label className="field field-narrow">
          Gender <span className="hint">(optional)</span>
          <select value={newGender} onChange={(e) => setNewGender(e.target.value as '' | Gender)} disabled={readOnly}>
            {GENDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button disabled={readOnly || name.trim() === '' || newSkillParsed === 'invalid'} onClick={() => void addPlayer(false)}>
          Add player
        </button>
        <button className="secondary" disabled={readOnly || name.trim() === '' || newSkillParsed === 'invalid'} onClick={() => void addPlayer(true)}>
          Add as a different person with the same name
        </button>
      </div>
      {matches.length > 0 ? (
        <div className="banner">
          <strong>Is this a returning player?</strong>
          {matches.map((p) => (
            <div className="row" key={p.id}>
              <span>{describe(p)}</span>
              <button disabled={readOnly || onRoster.has(p.id)} onClick={() => void addExisting(p.id)}>
                Add this existing player
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {registryHits.length > 0 ? (
        <div>
          <strong>Returning players</strong>
          {registryHits.map((p) => (
            <div className="row" key={p.id}>
              <span>{describe(p)}</span>
              <button className="secondary" disabled={readOnly} onClick={() => void addExisting(p.id)}>
                Add existing player
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {roster.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon" aria-hidden="true">
            🏓
          </span>
          <p>
            <strong>No players yet.</strong> Type a name above and press Add player. Returning players pop up as you type.
          </p>
        </div>
      ) : (
        <table className="roster">
          <thead>
            <tr>
              <th>Player</th>
              <th>Nickname</th>
              <th>Level</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {roster.map((entry) => (
              <RosterRow key={entry.playerId} sessionId={sessionId} entry={entry} readOnly={readOnly} details={details[entry.playerId]} onChanged={refresh} />
            ))}
          </tbody>
        </table>
      )}
      </div>
    </section>
    </main>
    </>
  );
}

export function App({ initialAppearance }: { initialAppearance: Appearance }) {
  return (
    <ToastProvider>
      <AppBody initialAppearance={initialAppearance} />
    </ToastProvider>
  );
}

function AppBody({ initialAppearance }: { initialAppearance: Appearance }) {
  const { error, call } = useAction();
  const { appearance, change, systemDark } = useAppearance(initialAppearance);
  const look: AppearanceControl = { appearance, systemDark, onChange: (a) => void change(a) };
  const notify = useToast();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [unfinished, setUnfinished] = useState<Session[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [courtCount, setCourtCount] = useState(4);
  const [teamUp, setTeamUp] = useState<TeamUpStyle>('balanced');
  const [scoreEntry, setScoreEntry] = useState<ScoreEntryMode>(DEFAULT_SCORE_ENTRY);
  const [showReports, setShowReports] = useState(false);
  const [awardsFor, setAwardsFor] = useState<{ sessionId: string | null } | null>(null);

  const refresh = useCallback(async () => {
    const all = await call(window.openPlay.listSessions());
    const open = await call(window.openPlay.findUnfinishedSessions());
    if (all) setSessions(all);
    if (open) setUnfinished(open);
  }, [call]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openAwards = async (sessionId: string | null) => {
    await refresh();
    setAwardsFor({ sessionId });
  };

  if (awardsFor) {
    return (
      <>
      <AppHeader look={look} subtitle="Awards" />
      <main>
        <Awards
          sessions={sessions}
          initialSessionId={awardsFor.sessionId}
          backLabel={openId ? 'Back to session' : 'Back to sessions'}
          onBack={() => setAwardsFor(null)}
        />
      </main>
      </>
    );
  }

  if (openId) {
    return (
        <SessionRoom
          sessionId={openId}
          look={look}
          onClose={() => {
            setOpenId(null);
            void refresh();
          }}
          onOpenAwards={() => void openAwards(openId)}
        />
    );
  }

  const live = sessions.filter((s) => s.status !== 'completed').length;
  return (
    <>
    <AppHeader
      look={look}
      chips={
        sessions.length > 0 ? (
          <>
            <Chip icon="📅">
              {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}
            </Chip>
            {live > 0 ? (
              <Chip icon="●" tone="live">
                {live} live
              </Chip>
            ) : null}
          </>
        ) : null
      }
    />
    <main>
      {unfinished.length > 0 ? (
        <section className="banner resume-banner">
          <strong>Unfinished session found.</strong> The last saved state was restored.
          {unfinished.map((s) => (
            <div className="row" key={s.id}>
              <span className="resume-name">{s.name}</span>
              <button onClick={() => setOpenId(s.id)}>Resume</button>
            </div>
          ))}
        </section>
      ) : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <section className="hero">
        <div className="hero-copy">
          <h2>New session</h2>
          <p className="hint">Name tonight&apos;s open play, pick how many courts you have, and {BRAND.name} keeps every game flowing.</p>
        </div>
        <div className="row hero-form">
          <label className="field grow">
            Session name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            Courts
            <select value={courtCount} onChange={(e) => setCourtCount(Number(e.target.value))}>
              {COURT_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <TeamUpPicker
            value={teamUp}
            layout="field"
            newSession
            context={null}
            onApply={(style) => {
              setTeamUp(style);
              return true;
            }}
          />
          <ScoringModePicker
            value={scoreEntry}
            layout="field"
            onApply={(mode) => {
              setScoreEntry(mode);
              return true;
            }}
          />
          <button
            className="cta"
            disabled={name.trim() === ''}
            onClick={async () => {
              // D15: 1 court is an explicit opt-in; D16: Balanced is the default, so only other styles are sent
              const created = await call(
                window.openPlay.createSession({
                  name,
                  courtCount,
                  ...(courtCount === 1 ? { allowSingleCourt: true } : {}),
                  ...(teamUp !== 'balanced' ? { teamUp } : {}),
                  // Rally scoring is the default, so only the other modes are stored
                  ...(scoreEntry !== DEFAULT_SCORE_ENTRY ? { scoreEntry } : {}),
                }),
              );
              if (created) {
                setName('');
                notify(`Session "${created.name}" started. Let the rallies flow!`, { icon: '🎾' });
                setOpenId(created.id);
              }
            }}
          >
            Start session
          </button>
        </div>
      </section>
      <section>
        <div className="section-head">
          <h2>Sessions</h2>
        </div>
        {sessions.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">
              🎾
            </span>
            <p>
              <strong>Welcome to {BRAND.name}.</strong> Start your first session above; everything is saved on this computer as you go, no internet needed.
            </p>
          </div>
        ) : null}
        <div className="session-list">
          {sessions.map((s) => (
            <div className="session-item" key={s.id}>
              <span className="session-item-name">
                {s.name} <span className={`badge ${s.status === 'completed' ? 'badge-done' : 'badge-live'}`}>{s.status}</span>
              </span>
              <span className="session-item-date hint">{new Date(s.startedAt).toLocaleDateString()}</span>
              <div className="session-item-actions">
                <button className="secondary" onClick={() => setOpenId(s.id)}>
                  {s.status === 'completed' ? 'Review' : 'Open'}
                </button>
                <button
                  className="secondary danger-outline"
                  aria-label={`Delete session ${s.name}`}
                  onClick={async () => {
                    if ((await call(window.openPlay.deleteSession(s.id))) === true) await refresh();
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
      <div className="row footer-actions">
        <button className="secondary" onClick={() => setShowReports(!showReports)}>
          <span className="btn-icon" aria-hidden="true">📊</span>
          {showReports ? 'Hide reports and data' : 'Reports and data'}
        </button>
        <button className="awards-nav" onClick={() => void openAwards(null)}>
          <span className="btn-icon" aria-hidden="true">🏆</span>Awards
        </button>
      </div>
      {showReports ? <Reports key={sessions.length} sessions={sessions} onDataReplaced={() => void refresh()} /> : null}
    </main>
    </>
  );
}
