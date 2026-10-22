import { useMemo, useState } from 'react';
import type { AwardLibrary as Library } from '../data/awards';
import type { AwardLineup } from '../core/awards/lineup';
import { AWARD_CATEGORIES, type AwardCategory, type LibraryEntry } from '../core/awards/templates';
import { CATEGORY_ACCENT } from './AwardsCeremony';

const CATEGORY_LABEL = new Map(AWARD_CATEGORIES.map((c) => [c.id, c.label]));

/**
 * A subtle note for sessions scored with Winner only: their games have no score, so the point-based
 * awards cannot find a winner.
 */
export function ScorelessNote({ where }: { where: 'awards' | 'library' }) {
  return (
    <p className="scoreless-note" role="note">
      <span className="scoreless-icon" aria-hidden="true">
        ℹ️
      </span>
      <span>
        This session used <strong>Winner only</strong>, so awards that need scores are unavailable. Point Machine needs final scores — switch to{' '}
        <strong>Final score only</strong> (Game settings) to enable it.
        {where === 'library' ? ' The recommendations below favour awards that work without scores.' : ''}
      </span>
    </p>
  );
}

function Preview({ entry }: { entry: LibraryEntry }) {
  if (entry.kind === 'manual') return <p className="lib-preview manual">You pick the winner from the roster.</p>;
  if (entry.unavailable) return <p className="lib-preview missing">{entry.unavailable}</p>;
  if (!entry.preview) return <p className="lib-preview missing">Nobody qualifies yet.</p>;
  return (
    <p className="lib-preview">
      <span className="lib-preview-label">Would go to</span> <strong>{entry.preview.winners}</strong>
      <span className="lib-preview-stat">
        {' '}
        · {entry.preview.stat} {entry.preview.statLabel}
      </span>
    </p>
  );
}

/** The award library: recommendations for this session, search, categories, live previews. */
export function AwardLibrary({
  library,
  lineup,
  busy,
  onAdd,
}: {
  library: Library | null;
  lineup: AwardLineup;
  busy: boolean;
  onAdd: (templateId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<AwardCategory | 'all'>('all');
  const inLineup = useMemo(() => new Set(lineup.entries.filter((e) => e.kind === 'template').map((e) => e.id)), [lineup]);
  const entries = library?.entries ?? [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const q = query.trim().toLowerCase();
  const filtered = entries.filter(
    (e) =>
      (category === 'all' || e.category === category) &&
      (q === '' || `${e.title} ${e.description} ${CATEGORY_LABEL.get(e.category) ?? ''}`.toLowerCase().includes(q)),
  );
  const addButton = (e: LibraryEntry) =>
    inLineup.has(e.id) ? (
      <button className="secondary" disabled>
        <span className="btn-icon" aria-hidden="true">✓</span>In lineup
      </button>
    ) : (
      <button disabled={busy} aria-label={`Add ${e.title} to lineup`} onClick={() => onAdd(e.id)}>
        <span className="btn-icon" aria-hidden="true">＋</span>Add to lineup
      </button>
    );

  return (
    <section className="awards-panel library-panel" aria-labelledby="library-heading">
      <div className="panel-head">
        <h3 id="library-heading">
          <span className="btn-icon" aria-hidden="true">📚</span>Award library
        </h3>
        <p className="hint">
          {entries.length} awards to add. Computed awards find their winner from the games; host picks (people&rsquo;s choice) are chosen by you.
        </p>
      </div>

      {library?.scoreEntry === 'winner_only' ? <ScorelessNote where="library" /> : null}

      {library && library.recommendations.length > 0 ? (
        <div className="recs" aria-labelledby="recs-heading">
          <h4 id="recs-heading">
            <span className="btn-icon" aria-hidden="true">✨</span>Recommended for this session
          </h4>
          <ul className="rec-strip">
            {library.recommendations.map((r) => {
              const e = byId.get(r.templateId);
              if (!e) return null;
              return (
                <li key={r.templateId} className="rec-card-award" style={{ ['--cat' as string]: CATEGORY_ACCENT[e.category] }}>
                  <div className="lib-head">
                    <span className="lib-icon" aria-hidden="true">
                      {e.icon}
                    </span>
                    <span className="lib-title">{e.title}</span>
                  </div>
                  <p className="rec-reason">{r.reason}</p>
                  <Preview entry={e} />
                  {addButton(e)}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="lib-filters">
        <label className="field lib-search">
          Search the award library
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="chip-row" role="group" aria-label="Award category">
          <button className={category === 'all' ? 'chip active' : 'chip'} aria-pressed={category === 'all'} onClick={() => setCategory('all')}>
            All
          </button>
          {AWARD_CATEGORIES.map((c) => (
            <button key={c.id} className={category === c.id ? 'chip active' : 'chip'} aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? <p className="hint">No award matches “{query}”.</p> : null}
      <ul className="lib-grid">
        {filtered.map((e) => (
          <li key={e.id} className={`lib-card${e.unavailable ? ' unavailable' : ''}`} style={{ ['--cat' as string]: CATEGORY_ACCENT[e.category] }}>
            <div className="lib-head">
              <span className="lib-icon" aria-hidden="true">
                {e.icon}
              </span>
              <span className="lib-title">{e.title}</span>
              <span className={`kind-badge kind-${e.kind}`}>{e.kind === 'manual' ? 'Host pick' : 'Computed'}</span>
            </div>
            <p className="lib-cat">{CATEGORY_LABEL.get(e.category)}</p>
            <p className="lib-desc">{e.description}</p>
            <Preview entry={e} />
            {addButton(e)}
          </li>
        ))}
      </ul>
    </section>
  );
}
