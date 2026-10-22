import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResult } from '../shared/api';
import type { AwardLibrary as Library, AwardsReport, AwardsScope } from '../data/awards';
import type { Session } from '../data/types';
import { BUILTIN_INFO, BUILTIN_ORDER, type AwardLineup, type AwardPick, type ShowAward } from '../core/awards/lineup';
import { AwardCard, ChampionBanner, Confetti, Podium } from './AwardsCeremony';
import { AwardsEditor } from './AwardsEditor';
import { AwardLibrary } from './AwardLibrary';
import { CeremonyHost } from './CeremonyHost';
import { CeremonySound } from './ceremonyAudio';
import { BRAND } from '../shared/brand';
import { presentedBy } from '../shared/club';
import { ClubNameEditor } from './ClubNameEditor';

type ScopeKind = 'session' | 'historical';

const longDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';

/** One printable page per award (and per shared winner), shown only when printing. */
function Certificates({ report }: { report: AwardsReport }) {
  const pages: Array<{ award: ShowAward; name: string; key: string }> = [];
  for (const award of report.lineup) {
    if (award.pending) continue;
    for (const group of award.groups) {
      pages.push({ award, name: group.map((w) => w.name).join(' & '), key: `${award.key}-${group.map((w) => w.playerId).join('-')}` });
    }
  }
  return (
    <div className="certificates" aria-hidden="true">
      {pages.map(({ award, name, key }) => (
        <div className="certificate" key={key}>
          <div className="cert-frame">
            <p className="cert-kicker">Certificate of achievement</p>
            <div className="cert-icon">{award.icon}</div>
            <p className="cert-title">{award.title}{award.provisional ? ' (provisional)' : ''}</p>
            <p className="cert-presented">is proudly presented to</p>
            <p className="cert-name">{name}</p>
            <p className="cert-explain">{award.explanation}</p>
            {presentedBy(report.club) ? <p className="cert-club">{presentedBy(report.club)}</p> : null}
            <p className="cert-foot">
              {report.scopeLabel}
              {report.sessionId && report.date ? ` · ${longDate(report.date)}` : ''} · {BRAND.name} — {BRAND.tagline}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ scopeKind }: { scopeKind: ScopeKind }) {
  return (
    <div className="awards-empty">
      <div className="awards-empty-icon" aria-hidden="true">
        🏆
      </div>
      <h3>No awards yet</h3>
      <p>
        Awards are earned from finalized games{scopeKind === 'session' ? ' in this session' : ''}. Finish a game with{' '}
        <strong>Finalize game</strong>, or press <strong>Team A won</strong> / <strong>Team B won</strong>, and the trophies appear
        here straight away.
      </p>
      <p className="hint">Enter the final score when you can: points decide Point Machine and Clutch Player.</p>
    </div>
  );
}

type Panel = 'none' | 'edit' | 'library';

/** The Awards tab: scope picker, podium, award cards, the ceremony, the lineup editor and the library. */
export function Awards({
  sessions,
  initialSessionId,
  onBack,
  backLabel,
}: {
  sessions: Session[];
  initialSessionId: string | null;
  onBack: () => void;
  backLabel: string;
}) {
  const latest = sessions[sessions.length - 1]?.id ?? '';
  const [scopeKind, setScopeKind] = useState<ScopeKind>(initialSessionId || latest ? 'session' : 'historical');
  const [sessionId, setSessionId] = useState(initialSessionId ?? latest);
  const [report, setReport] = useState<AwardsReport | null>(null);
  const [lineup, setLineup] = useState<AwardLineup | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [panel, setPanel] = useState<Panel>('none');
  const [pickKey, setPickKey] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<AwardsReport | null>(null);
  const soundRef = useRef<CeremonySound | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [burst, setBurst] = useState(0);
  const [busy, setBusy] = useState(false);

  const scope: AwardsScope | null =
    scopeKind === 'historical' ? { kind: 'historical' } : sessionId !== '' ? { kind: 'session', sessionId } : null;
  const scopeKey = scope ? JSON.stringify(scope) : '';

  const unwrap = useCallback(async <T,>(promise: Promise<ApiResult<T>>): Promise<T | null> => {
    const result = await promise;
    if (result.ok) {
      setError(null);
      return result.value;
    }
    setError(result.error);
    return null;
  }, []);

  /** Reloads the report and the library for the current scope (after any lineup or pick change). */
  const reload = useCallback(async (): Promise<AwardsReport | null> => {
    if (scopeKey === '') return null;
    const current = JSON.parse(scopeKey) as AwardsScope;
    const [loaded, lib] = await Promise.all([unwrap(window.openPlay.getAwards(current)), unwrap(window.openPlay.getAwardLibrary(current))]);
    setReport(loaded);
    setLibrary(lib);
    return loaded;
  }, [scopeKey, unwrap]);

  useEffect(() => {
    void unwrap(window.openPlay.getAwardLineup()).then((l) => l && setLineup(l));
  }, [unwrap]);

  useEffect(() => {
    if (scopeKey === '') {
      setReport(null);
      setLibrary(null);
      return;
    }
    let alive = true;
    void (async () => {
      const current = JSON.parse(scopeKey) as AwardsScope;
      const [loaded, lib] = await Promise.all([unwrap(window.openPlay.getAwards(current)), unwrap(window.openPlay.getAwardLibrary(current))]);
      if (!alive) return;
      setReport(loaded);
      setLibrary(lib);
      setNotice(null);
      if (loaded && loaded.finalizedGames > 0) setBurst((b) => b + 1);
    })();
    return () => {
      alive = false;
    };
  }, [scopeKey, unwrap]);

  const act = async <T,>(promise: Promise<ApiResult<T>>, message: (value: T) => string | null) => {
    setBusy(true);
    try {
      const value = await unwrap(promise);
      if (value !== null) setNotice(message(value));
    } finally {
      setBusy(false);
    }
  };

  const saveLineup = async (promise: Promise<ApiResult<AwardLineup>>, message: string | null = null) => {
    setBusy(true);
    try {
      const saved = await unwrap(promise);
      if (saved) {
        setLineup(saved);
        if (message) setNotice(message);
        await reload();
      }
    } finally {
      setBusy(false);
    }
  };

  const addAward = async (templateId: string) => {
    setBusy(true);
    try {
      const added = await unwrap(window.openPlay.addAwardToLineup(templateId));
      if (!added) return;
      setLineup(added.lineup);
      const entry = added.lineup.entries.find((e) => e.key === added.key);
      const lib = library?.entries.find((e) => e.id === templateId);
      setNotice(`${lib?.icon ?? ''} ${lib?.title ?? 'The award'} was added to the lineup${lib?.kind === 'manual' ? '. Choose its winner in Edit awards.' : '.'}`.trim());
      if (lib?.kind === 'manual' && entry) setPickKey(entry.key);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const savePick = async (key: string, pick: AwardPick | null): Promise<boolean> => {
    if (!scope) return false;
    const saved = await unwrap(window.openPlay.setAwardPick(scope, key, pick));
    if (!saved) return false;
    await reload();
    return true;
  };

  const startCeremony = async () => {
    if (!scope) return;
    // Created inside the click, so the browser allows the sound; nothing plays before this.
    const sound = new CeremonySound();
    sound.start();
    soundRef.current = sound;
    const fresh = await reload();
    if (fresh && fresh.lineup.length > 0) setCeremony(fresh);
    else sound.close();
  };

  const hasAwards = report !== null && report.finalizedGames > 0;
  const others = report ? report.lineup.filter((a) => a.templateId !== 'champion') : [];
  const descriptions: Array<{ key: string; icon: string; title: string; rule: string }> = report
    ? [...report.lineup].reverse().map((a) => ({ key: a.key, icon: a.icon, title: a.title, rule: a.description }))
    : [...BUILTIN_ORDER].reverse().map((id) => ({ key: id, icon: BUILTIN_INFO[id].icon, title: BUILTIN_INFO[id].title, rule: BUILTIN_INFO[id].description }));

  return (
    <section className="awards-page" aria-labelledby="awards-heading">
      <div className="awards-top">
        <button className="secondary" onClick={onBack}>
          <span className="btn-icon" aria-hidden="true">←</span>
          {backLabel}
        </button>
        <h2 id="awards-heading">
          <span className="btn-icon" aria-hidden="true">🏆</span>Awards
        </h2>
      </div>

      <ClubNameEditor
        key={scope?.kind === 'session' ? scope.sessionId : 'all-time'}
        sessionId={scope?.kind === 'session' ? scope.sessionId : null}
        sessionLabel={scope?.kind === 'session' ? (sessions.find((s) => s.id === scope.sessionId)?.name ?? '') : ''}
        onSaved={() => void reload()}
      />

      <div className="awards-controls">
        <div className="scope-picker" role="group" aria-label="Show awards for">
          <span className="scope-label">Show awards for</span>
          <div className="segmented">
            <button
              className={scopeKind === 'session' ? 'seg active' : 'seg'}
              aria-pressed={scopeKind === 'session'}
              disabled={sessions.length === 0}
              onClick={() => setScopeKind('session')}
            >
              This session
            </button>
            <button
              className={scopeKind === 'historical' ? 'seg active' : 'seg'}
              aria-pressed={scopeKind === 'historical'}
              onClick={() => setScopeKind('historical')}
            >
              All time
            </button>
          </div>
          {scopeKind === 'session' && sessions.length > 0 ? (
            <label className="field">
              Session
              <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                {[...sessions].reverse().map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.status === 'completed' ? ' (finished)' : ' (active)'}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <div className="awards-actions">
          <button disabled={!scope || busy} onClick={() => scope && void act(window.openPlay.showAwardsOnDisplay(scope), () => 'The awards are on the display. Press "Show courts on display" to switch back.')}>
            <span className="btn-icon" aria-hidden="true">📺</span>Show on display
          </button>
          <button className="secondary" disabled={busy} onClick={() => void act(window.openPlay.showCourtsOnDisplay(), () => 'The display shows the courts again.')}>
            Show courts on display
          </button>
          <button
            className="secondary"
            disabled={!scope || !hasAwards || busy}
            onClick={() => scope && void act(window.openPlay.saveAwardsImage(scope), (file) => (file ? `Image saved to ${file}.` : null))}
          >
            <span className="btn-icon" aria-hidden="true">🖼️</span>Save as image
          </button>
          <button
            className="secondary"
            disabled={!hasAwards || busy}
            onClick={() => void act(window.openPlay.saveCertificates(), (file) => (file ? `Certificates saved to ${file}.` : null))}
          >
            <span className="btn-icon" aria-hidden="true">📜</span>Print certificates
          </button>
        </div>
      </div>

      <div className="awards-toolbar" role="toolbar" aria-label="Ceremony and lineup">
        <button className="ceremony-start" disabled={!hasAwards || busy || !report || report.lineup.length === 0} onClick={() => void startCeremony()}>
          <span className="btn-icon" aria-hidden="true">🎬</span>Start ceremony
        </button>
        <button className={panel === 'edit' ? '' : 'secondary'} aria-pressed={panel === 'edit'} aria-controls="awards-panel" onClick={() => setPanel((p) => (p === 'edit' ? 'none' : 'edit'))}>
          <span className="btn-icon" aria-hidden="true">✏️</span>Edit awards
        </button>
        <button className={panel === 'library' ? '' : 'secondary'} aria-pressed={panel === 'library'} aria-controls="awards-panel" onClick={() => setPanel((p) => (p === 'library' ? 'none' : 'library'))}>
          <span className="btn-icon" aria-hidden="true">📚</span>Award library
          {library && library.recommendations.length > 0 ? <span className="count-pill">{library.recommendations.length} ideas</span> : null}
        </button>
        <span className="hint toolbar-hint">One award at a time with nominees, a drumroll and a big reveal, building to the champion.</span>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {notice ? (
        <p className="awards-notice" role="status">
          {notice}
        </p>
      ) : null}

      <div id="awards-panel">
        {panel === 'edit' && lineup ? (
          <AwardsEditor
            lineup={lineup}
            report={report}
            library={library?.entries ?? []}
            busy={busy}
            onChange={(next) => {
              setLineup(next); // optimistic: the row moves or toggles at once, then the saved lineup replaces it
              void saveLineup(window.openPlay.setAwardLineup(next)).then(async () => {
                const current = await unwrap(window.openPlay.getAwardLineup());
                if (current) setLineup(current);
              });
            }}
            onRestore={() => void saveLineup(window.openPlay.restoreAwardLineup(), 'Built-in awards restored. Awards you added are still in the lineup.')}
            onOpenLibrary={() => setPanel('library')}
            onPick={savePick}
            openPickKey={pickKey}
          />
        ) : null}
        {panel === 'library' && lineup ? <AwardLibrary library={library} lineup={lineup} busy={busy} onAdd={(id) => void addAward(id)} /> : null}
      </div>

      {report === null ? (
        scope === null ? <EmptyState scopeKind="historical" /> : <p>Loading awards…</p>
      ) : !hasAwards ? (
        <EmptyState scopeKind={scopeKind} />
      ) : (
        <>
          <div className="awards-stage" data-testid="awards-stage">
            <Confetti burst={burst} />
            <div className="stage-head">
              <div className="stage-title">
                {report.club.name ? (
                  <p className="stage-club">
                    {report.club.name}
                    {report.club.tagline ? <span className="stage-tagline">{report.club.tagline}</span> : null}
                  </p>
                ) : null}
                <p className="stage-scope">
                  {report.scopeLabel} · {report.finalizedGames} finalized {report.finalizedGames === 1 ? 'game' : 'games'}
                </p>
              </div>
              <button className="celebrate" onClick={() => setBurst((b) => b + 1)}>
                <span className="btn-icon" aria-hidden="true">🎉</span>Celebrate
              </button>
            </div>
            <ChampionBanner report={report} />
            <Podium steps={report.podiumSteps} />
            {report.note ? <p className="stage-note">{report.note}</p> : null}
          </div>

          {others.length > 0 ? (
            <div className="award-grid">
              {others.map((award, i) =>
                award.pending ? (
                  <article className="award-card pending-card" key={award.key} aria-label={`${award.title}: needs a winner`}>
                    <div className="award-icon" aria-hidden="true">
                      {award.icon}
                    </div>
                    <div className="award-body">
                      <h3 className="award-title">{award.title}</h3>
                      <p className="award-winner">Needs a winner</p>
                      <p className="award-explain">A host pick: choose the winner before or during the ceremony.</p>
                    </div>
                    <div className="award-stat">
                      <button
                        className="secondary"
                        onClick={() => {
                          setPickKey(award.key);
                          setPanel('edit');
                        }}
                      >
                        Choose winner
                      </button>
                    </div>
                  </article>
                ) : (
                  <AwardCard key={award.key} award={award} index={i} />
                ),
              )}
            </div>
          ) : (
            <p className="hint">More awards unlock as more games are played.</p>
          )}
          <Certificates report={report} />
        </>
      )}

      <details className="more how-awards">
        <summary>How awards are earned</summary>
        <ul className="rules">
          {descriptions.map((r) => (
            <li key={r.key}>
              <span aria-hidden="true">{r.icon}</span> <strong>{r.title}:</strong> {r.rule}
            </li>
          ))}
          <li>
            Only finalized games count. Results recorded without a score count for wins, games and streaks, not for points. Ties share
            the award after the award&rsquo;s own number, then win %, wins and point difference.
          </li>
        </ul>
      </details>

      {ceremony && scope && soundRef.current ? (
        <CeremonyHost
          initialReport={ceremony}
          scope={scope}
          sound={soundRef.current}
          onPick={async (key, winnerIds) => {
            // Keep the nominees and note the host may already have chosen.
            const before = report?.lineup.find((a) => a.key === key);
            const shortlist = before && !before.decoys ? before.nominees.flat().map((w) => w.playerId).filter((id) => !winnerIds.includes(id)) : [];
            return (await savePick(key, { winners: winnerIds, shortlist, note: before?.note ?? '' })) ? await reload() : null;
          }}
          onClose={() => {
            setCeremony(null);
            soundRef.current = null;
          }}
        />
      ) : null}
    </section>
  );
}
