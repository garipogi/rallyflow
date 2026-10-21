import { useEffect, useState } from 'react';
import type { AwardsReport } from '../data/awards';
import type { AwardLineup, AwardPick, LineupEntry } from '../core/awards/lineup';
import { BUILTIN_INFO, MAX_DESCRIPTION, MAX_NOTE, MAX_TITLE } from '../core/awards/lineup';
import type { AwardId } from '../core/awards';
import type { LibraryEntry } from '../core/awards/templates';

interface Base {
  title: string;
  icon: string;
  description: string;
  kind: 'classic' | 'computed' | 'manual';
  params: LibraryEntry['params'];
}

function baseOf(entry: LineupEntry, library: readonly LibraryEntry[]): Base {
  if (entry.kind === 'builtin') {
    const info = BUILTIN_INFO[entry.id as AwardId];
    return { ...info, kind: 'classic', params: [] };
  }
  const t = library.find((x) => x.id === entry.id);
  return { title: t?.title ?? entry.id, icon: t?.icon ?? '🏅', description: t?.description ?? '', kind: t?.kind ?? 'computed', params: t?.params ?? [] };
}

/** Text fields keep a local draft and save when they lose focus (or on Enter). */
function DraftField({
  label,
  value,
  fallback,
  max,
  multiline = false,
  className = '',
  onSave,
}: {
  label: string;
  value: string;
  fallback: string;
  max: number;
  multiline?: boolean;
  className?: string;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value || fallback);
  useEffect(() => setDraft(value || fallback), [value, fallback]);
  const commit = () => {
    const text = draft.trim();
    if (text === (value || fallback)) return;
    onSave(text === fallback ? '' : text);
  };
  return (
    <label className={`field ${className}`}>
      {label}
      {multiline ? (
        <textarea value={draft} maxLength={max} rows={2} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
      ) : (
        <input
          value={draft}
          maxLength={max}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      )}
    </label>
  );
}

function PickEditor({
  report,
  title,
  current,
  onSave,
  onDone,
}: {
  report: AwardsReport;
  title: string;
  current: { winners: string[]; shortlist: string[]; note: string };
  onSave: (pick: AwardPick | null) => Promise<boolean>;
  onDone: () => void;
}) {
  const [winners, setWinners] = useState<string[]>(current.winners);
  const [shortlist, setShortlist] = useState<string[]>(current.shortlist);
  const [note, setNote] = useState(current.note);
  const toggle = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  if (report.roster.length === 0) return <p className="hint">Add players to the session to pick a winner.</p>;
  return (
    <div className="pick-editor">
      <p className="hint">
        Tick the winner of <strong>{title}</strong> (up to 4). Optionally tick a few nominees for the drumroll; without nominees, the ceremony
        shows random roster names for drama.
      </p>
      <div className="pick-grid" role="group" aria-label={`Choose the winner of ${title}`}>
        {report.roster.map((p) => (
          <div className={`pick-row${winners.includes(p.playerId) ? ' chosen' : ''}`} key={p.playerId}>
            <span className="pick-name">{p.name}</span>
            <label className="pick-check">
              <input type="checkbox" checked={winners.includes(p.playerId)} disabled={!winners.includes(p.playerId) && winners.length >= 4} onChange={() => setWinners((w) => toggle(w, p.playerId))} />
              Winner
            </label>
            <label className="pick-check">
              <input type="checkbox" checked={shortlist.includes(p.playerId)} disabled={!shortlist.includes(p.playerId) && shortlist.length >= 8} onChange={() => setShortlist((w) => toggle(w, p.playerId))} />
              Nominee
            </label>
          </div>
        ))}
      </div>
      <label className="field">
        Note read out at the reveal (optional)
        <input value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="row">
        <button
          onClick={() =>
            void onSave(winners.length === 0 && shortlist.length === 0 && note.trim() === '' ? null : { winners, shortlist, note }).then((ok) => ok && onDone())
          }
        >
          Save winner
        </button>
        <button
          className="secondary"
          onClick={() => {
            setWinners([]);
            setShortlist([]);
            setNote('');
            void onSave(null).then((ok) => ok && onDone());
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

/**
 * Edit awards: show or hide, rename, reorder (drag or buttons), settings, delete added awards,
 * restore the defaults, and choose host-pick winners. Every change saves straight away.
 */
export function AwardsEditor({
  lineup,
  report,
  library,
  busy,
  onChange,
  onRestore,
  onOpenLibrary,
  onPick,
  openPickKey,
}: {
  lineup: AwardLineup;
  report: AwardsReport | null;
  library: readonly LibraryEntry[];
  busy: boolean;
  onChange: (lineup: AwardLineup) => void;
  onRestore: () => void;
  onOpenLibrary: () => void;
  onPick: (key: string, pick: AwardPick | null) => Promise<boolean>;
  openPickKey: string | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(openPickKey);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  useEffect(() => setPicking(openPickKey), [openPickKey]);

  const entries = lineup.entries;
  const save = (next: LineupEntry[]) => onChange({ ...lineup, entries: next });
  const patch = (key: string, change: Partial<LineupEntry>) =>
    save(
      entries.map((e) => {
        if (e.key !== key) return e;
        const out: LineupEntry = { ...e, ...change };
        for (const field of ['title', 'icon', 'description'] as const) if (out[field] === '') delete out[field];
        return out;
      }),
    );
  const move = (from: number, to: number) => {
    if (to < 0 || to >= entries.length || from === to) return;
    const next = [...entries];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item as LineupEntry);
    save(next);
  };
  const skippedOf = new Map((report?.skipped ?? []).map((s) => [s.key, s.reason]));
  const showOf = new Map((report?.lineup ?? []).map((a) => [a.key, a]));
  const shown = entries.filter((e) => e.enabled).length;

  return (
    <section className="awards-panel editor-panel" aria-labelledby="edit-awards-heading">
      <div className="panel-head">
        <h3 id="edit-awards-heading">
          <span className="btn-icon" aria-hidden="true">✏️</span>Edit awards
        </h3>
        <p className="hint">
          {shown} of {entries.length} shown. The order is the ceremony order: it builds from the top to the last award, usually the champion. Drag a row
          or use the arrows.
        </p>
      </div>
      <ol className="lineup-list">
        {entries.map((entry, i) => {
          const base = baseOf(entry, library);
          const title = entry.title ?? base.title;
          const icon = entry.icon ?? base.icon;
          const show = showOf.get(entry.key);
          const kindLabel = base.kind === 'classic' ? 'Built-in' : base.kind === 'manual' ? 'Host pick' : 'Library';
          const status = !entry.enabled
            ? 'Hidden'
            : base.kind === 'manual'
              ? show && !show.pending
                ? `Winner: ${show.groups.flat().map((w) => w.name).join(', ')}`
                : 'Needs a winner'
              : skippedOf.get(entry.key) ?? (show ? `${show.groups.flat().map((w) => w.name).slice(0, 3).join(', ')}${show.groups.flat().length > 3 ? '…' : ''}` : '');
          return (
            <li
              key={entry.key}
              className={`lineup-row${entry.enabled ? '' : ' off'}${dragKey === entry.key ? ' dragging' : ''}${overKey === entry.key && dragKey !== entry.key ? ' over' : ''}`}
              draggable
              onDragStart={(e) => {
                setDragKey(entry.key);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOverKey(entry.key);
              }}
              onDragLeave={() => setOverKey((k) => (k === entry.key ? null : k))}
              onDrop={(e) => {
                e.preventDefault();
                const from = entries.findIndex((x) => x.key === dragKey);
                if (from >= 0) move(from, i);
                setDragKey(null);
                setOverKey(null);
              }}
              onDragEnd={() => {
                setDragKey(null);
                setOverKey(null);
              }}
            >
              <div className="lineup-main">
                <span className="drag-handle" aria-hidden="true" title="Drag to reorder">
                  ⋮⋮
                </span>
                <span className="lineup-pos">{i + 1}</span>
                <span className="lineup-icon" aria-hidden="true">
                  {icon}
                </span>
                <span className="lineup-text">
                  <span className="lineup-title">{title}</span>
                  <span className="lineup-meta">
                    <span className={`kind-badge kind-${base.kind}`}>{kindLabel}</span>
                    {status ? <span className={`lineup-status${status === 'Needs a winner' ? ' warn' : ''}`}>{status}</span> : null}
                  </span>
                </span>
                <label className="switch">
                  <input type="checkbox" checked={entry.enabled} disabled={busy} onChange={(e) => patch(entry.key, { enabled: e.target.checked })} />
                  <span className="sr-only">Show {title}</span>
                  <span aria-hidden="true">{entry.enabled ? 'Shown' : 'Hidden'}</span>
                </label>
                <div className="lineup-actions">
                  <button className="secondary icon-btn" aria-label={`Move ${title} up`} disabled={busy || i === 0} onClick={() => move(i, i - 1)}>
                    ↑
                  </button>
                  <button className="secondary icon-btn" aria-label={`Move ${title} down`} disabled={busy || i === entries.length - 1} onClick={() => move(i, i + 1)}>
                    ↓
                  </button>
                  {base.kind === 'manual' && report ? (
                    <button className="secondary" aria-expanded={picking === entry.key} onClick={() => setPicking((k) => (k === entry.key ? null : entry.key))}>
                      Choose winner
                    </button>
                  ) : null}
                  <button className="secondary" aria-expanded={expanded === entry.key} aria-label={`Rename ${title}`} onClick={() => setExpanded((k) => (k === entry.key ? null : entry.key))}>
                    Rename
                  </button>
                  {entry.kind === 'template' ? (
                    <button className="secondary danger-outline" aria-label={`Delete ${title}`} disabled={busy} onClick={() => save(entries.filter((e) => e.key !== entry.key))}>
                      Delete
                    </button>
                  ) : null}
                </div>
              </div>
              {expanded === entry.key ? (
                <div className="lineup-edit">
                  <DraftField label="Icon" className="icon-field" value={entry.icon ?? ''} fallback={base.icon} max={8} onSave={(t) => patch(entry.key, { icon: t })} />
                  <DraftField label="Title" value={entry.title ?? ''} fallback={base.title} max={MAX_TITLE} onSave={(t) => patch(entry.key, { title: t })} />
                  <DraftField
                    label="Description (speaker notes)"
                    className="wide"
                    multiline
                    value={entry.description ?? ''}
                    fallback={base.description}
                    max={MAX_DESCRIPTION}
                    onSave={(t) => patch(entry.key, { description: t })}
                  />
                  {base.params.map((p) => (
                    <label className="field" key={p.key}>
                      {p.label} ({p.min}–{p.max})
                      <input
                        type="number"
                        min={p.min}
                        max={p.max}
                        step={1}
                        defaultValue={entry.params?.[p.key] ?? p.default}
                        onBlur={(e) => {
                          const v = Math.round(Number(e.target.value));
                          if (!Number.isFinite(v)) return;
                          const clamped = Math.min(p.max, Math.max(p.min, v));
                          e.target.value = String(clamped);
                          patch(entry.key, { params: { ...(entry.params ?? {}), [p.key]: clamped } });
                        }}
                      />
                    </label>
                  ))}
                  <button
                    className="secondary"
                    onClick={() => {
                      const out: LineupEntry = { key: entry.key, kind: entry.kind, id: entry.id, enabled: entry.enabled };
                      save(entries.map((e) => (e.key === entry.key ? out : e)));
                    }}
                  >
                    Reset name and settings
                  </button>
                </div>
              ) : null}
              {picking === entry.key && report && base.kind === 'manual' ? (
                <PickEditor
                  report={report}
                  title={title}
                  current={{
                    winners: show?.groups.flat().map((w) => w.playerId) ?? [],
                    shortlist: show && !show.decoys ? show.nominees.flat().map((w) => w.playerId).filter((id) => !show.groups.flat().some((w) => w.playerId === id)) : [],
                    note: show?.note ?? '',
                  }}
                  onSave={(pick) => onPick(entry.key, pick)}
                  onDone={() => setPicking(null)}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className="row panel-foot">
        <button onClick={onOpenLibrary}>
          <span className="btn-icon" aria-hidden="true">＋</span>Add award
        </button>
        <button className="secondary" disabled={busy} onClick={onRestore}>
          Restore defaults
        </button>
        <span className="hint">Restore defaults shows every built-in award again with its original name and order; awards you added stay.</span>
      </div>
    </section>
  );
}
