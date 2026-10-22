import { useId, useRef, useState } from 'react';
import { SCORE_ENTRY_GUIDES, scoreEntryGuide, type ScoreEntryMode } from '../core/scoring/quickResult';
import { Modal } from './ui/Modal';

/** A tiny picture of the court card in each mode, drawn with the theme colours. */
function ModePreview({ mode }: { mode: ScoreEntryMode }) {
  return (
    <div className={`sm-preview sm-${mode}`} aria-hidden="true">
      {mode === 'rally' ? (
        <>
          <div className="sm-boxes">
            <span className="sm-box sm-a">7</span>
            <span className="sm-box sm-b">4</span>
          </div>
          <div className="sm-buttons">
            <span className="sm-btn sm-a" />
            <span className="sm-btn sm-b" />
          </div>
        </>
      ) : mode === 'final_score' ? (
        <>
          <div className="sm-boxes">
            <span className="sm-input">11</span>
            <span className="sm-input">7</span>
          </div>
          <div className="sm-chips">
            <span />
            <span />
            <span />
          </div>
          <div className="sm-save" />
        </>
      ) : (
        <div className="sm-buttons tall">
          <span className="sm-btn sm-a">🏆</span>
          <span className="sm-btn sm-b">🏆</span>
        </div>
      )}
    </div>
  );
}

/** The light explanation window: what the mode does, a small picture of the court card, best for. */
function ScoringModeDialog({ mode, choose, busy, onUse, onClose }: { mode: ScoreEntryMode; choose: boolean; busy: boolean; onUse: () => void; onClose: () => void }) {
  const g = scoreEntryGuide(mode);
  const summaryId = useId();
  return (
    <Modal
      title={choose ? g.label : `About: ${g.label}`}
      icon={g.icon}
      onClose={onClose}
      className="scoring-modal"
      describedBy={summaryId}
      closeLabel={choose ? 'Cancel and keep the current scoring mode' : 'Close window'}
      footer={
        choose ? (
          <>
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="guide-use" disabled={busy} onClick={onUse}>
              {busy ? 'Applying…' : 'Use this mode'}
            </button>
          </>
        ) : (
          <button type="button" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      <p id={summaryId} className="guide-summary">
        {g.summary}
      </p>
      <div className="sm-grid">
        <ModePreview mode={mode} />
        <div className="guide-how">
          <h3>On each court</h3>
          <ul>
            {g.how.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="sm-best">
        <strong>Best for:</strong> {g.bestFor}
      </p>
      {choose ? <p className="hint guide-foot">You can switch at any time; games already on court switch straight away.</p> : null}
    </Modal>
  );
}

interface PickerProps {
  value: ScoreEntryMode;
  /** Applies the confirmed mode; resolve false to keep the window open. */
  onApply: (mode: ScoreEntryMode) => Promise<boolean> | boolean;
  disabled?: boolean;
  /** field: label above (new-session form); inline: label beside (Game settings). */
  layout?: 'field' | 'inline';
}

/**
 * Scoring mode selector: Rally scoring, Final score only or Winner only. Like the team-up picker,
 * choosing a mode opens a short explanation first; "Use this mode" applies it, Cancel keeps the old one.
 */
export function ScoringModePicker({ value, onApply, disabled = false, layout = 'inline' }: PickerProps) {
  const [dialog, setDialog] = useState<{ mode: ScoreEntryMode; choose: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const current = scoreEntryGuide(value);
  const close = () => {
    setDialog(null);
    window.setTimeout(() => {
      if (document.activeElement === document.body || document.activeElement === null) selectRef.current?.focus();
    }, 0);
  };
  const use = async () => {
    if (!dialog) return;
    setBusy(true);
    try {
      if (await onApply(dialog.mode)) close();
    } finally {
      setBusy(false);
    }
  };
  const select = (
    <select ref={selectRef} value={value} disabled={disabled} onChange={(e) => setDialog({ mode: e.target.value as ScoreEntryMode, choose: true })}>
      {SCORE_ENTRY_GUIDES.map((g) => (
        <option key={g.value} value={g.value}>
          {g.label}
        </option>
      ))}
    </select>
  );
  return (
    <div className={`teamup-picker scoring-picker teamup-${layout}`}>
      {layout === 'field' ? (
        <label className="field">
          Scoring mode
          {select}
        </label>
      ) : (
        <label>Scoring mode {select}</label>
      )}
      <button type="button" className="about-style" aria-label={`About this scoring mode: ${current.label}`} onClick={() => setDialog({ mode: value, choose: false })}>
        <span aria-hidden="true">ⓘ</span> About
      </button>
      {dialog ? <ScoringModeDialog mode={dialog.mode} choose={dialog.choose} busy={busy} onUse={() => void use()} onClose={close} /> : null}
    </div>
  );
}
