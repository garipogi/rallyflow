import { useEffect, useId, useState } from 'react';
import { BRAND } from '../shared/brand';
import { CLUB_NAME_MAX, CLUB_TAGLINE_MAX, type ClubInfo } from '../shared/club';

/**
 * Inline editor for the club or group name shown on the awards ceremony ("✏️ Club name").
 * `sessionId` adds the optional name for this session only. `onSaved` runs after a successful save
 * so the page can reload the awards. Used on the Awards page and in the Appearance panel.
 */
export function ClubNameEditor({
  sessionId = null,
  sessionLabel = '',
  compact = false,
  onSaved,
}: {
  sessionId?: string | null;
  sessionLabel?: string;
  compact?: boolean;
  onSaved?: (club: ClubInfo) => void;
}) {
  const id = useId();
  const [club, setClubState] = useState<ClubInfo | null>(null);
  const [open, setOpen] = useState(compact);
  const [name, setName] = useState('');
  const [tagline, setTagline] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.openPlay.getClub(sessionId).then((result) => {
      if (!alive) return;
      if (result.ok) {
        setClubState(result.value);
        setName(result.value.name);
        setTagline(result.value.tagline);
        setSessionName(result.value.sessionName);
      } else setError(result.error);
    });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const save = async () => {
    setBusy(true);
    setSaved(null);
    try {
      const global = await window.openPlay.setClub({ name, tagline });
      if (!global.ok) {
        setError(global.error);
        return;
      }
      let next: ClubInfo = { ...global.value, sessionName: club?.sessionName ?? '' };
      if (sessionId) {
        const local = await window.openPlay.setSessionClubName(sessionId, sessionName);
        if (!local.ok) {
          setError(local.error);
          return;
        }
        next = local.value;
      }
      setError(null);
      setClubState(next);
      setName(next.name);
      setTagline(next.tagline);
      setSessionName(next.sessionName);
      setSaved(next.name || next.sessionName ? 'Saved. The ceremony, board, image and certificates use it.' : 'Cleared. The awards show the session name and RallyFlow.');
      if (!compact) setOpen(false);
      onSaved?.(next);
    } finally {
      setBusy(false);
    }
  };

  const shown = club ? club.sessionName || club.name : '';

  if (!open) {
    return (
      <div className="club-bar">
        <span className="club-current">
          <span className="club-label">Club / group</span>
          <strong className={shown ? 'club-value' : 'club-value unset'}>{shown || 'Not set'}</strong>
          {club?.sessionName ? <span className="club-note">(this session only)</span> : null}
        </span>
        <button className="secondary" onClick={() => setOpen(true)} disabled={!club}>
          <span className="btn-icon" aria-hidden="true">✏️</span>Club name
        </button>
        {saved ? (
          <span className="club-saved" role="status">
            {saved}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className={`club-editor${compact ? ' compact' : ''}`}
      aria-label="Club name"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="field" htmlFor={`${id}-name`}>
        Club / group name
        <input id={`${id}-name`} value={name} maxLength={CLUB_NAME_MAX} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </label>
      <label className="field" htmlFor={`${id}-tag`}>
        Short tagline (optional)
        <input id={`${id}-tag`} value={tagline} maxLength={CLUB_TAGLINE_MAX} onChange={(e) => setTagline(e.target.value)} autoComplete="off" />
      </label>
      {sessionId ? (
        <label className="field" htmlFor={`${id}-session`}>
          Name for {sessionLabel ? `“${sessionLabel}”` : 'this session'} only (optional)
          <input id={`${id}-session`} value={sessionName} maxLength={CLUB_NAME_MAX} onChange={(e) => setSessionName(e.target.value)} autoComplete="off" />
        </label>
      ) : null}
      <p className="hint club-hint">
        For example “CCF Sandoval Pickleball Club”. It leads the ceremony, the awards board, the saved image and the certificates. Leave it
        empty to show the session name and {BRAND.name} instead.
      </p>
      {error ? <p className="error">{error}</p> : null}
      <div className="club-actions">
        <button type="submit" disabled={busy || !club}>
          Save
        </button>
        {compact ? null : (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setOpen(false);
              setError(null);
              if (club) {
                setName(club.name);
                setTagline(club.tagline);
                setSessionName(club.sessionName);
              }
            }}
          >
            Cancel
          </button>
        )}
        {compact && saved ? (
          <span className="club-saved" role="status">
            {saved}
          </span>
        ) : null}
      </div>
    </form>
  );
}
