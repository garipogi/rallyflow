import { useId, useRef, useState } from 'react';
import type { TeamUpStyle } from '../core/rotation';
import { Modal } from './ui/Modal';
import { TeamUpDiagram } from './TeamUpDiagram';
import { guideFor, TEAM_UP_CHOICES, type ExamplePlayer, type GuideNeed } from './teamUpOptions';

/** What the explanation window knows about the session, to check "What you need" live. */
export interface GuideContext {
  /** Players for the example (checked-in players first). */
  players: ExamplePlayer[];
  /** Players the counts below refer to (checked in, or the whole roster before check-in). */
  playerCount: number;
  missingGender: string[];
  missingSkill: string[];
  courtCount: number;
  pairCount: number;
  /** Checked-in, available players (round robin schedules are made for them). */
  checkedInCount: number;
}

export type RosterFix = 'genders' | 'skills';

type Tone = 'ok' | 'warn' | 'info';

const ONE_COURT: Partial<Record<TeamUpStyle, string>> = {
  paddle_stack: 'with 1 court the two winners split up and each partners a loser.',
  river: 'with 1 court the winners stay on when level on games and partners split.',
  pools: 'with 1 court the pools take turns on it.',
};

function listNames(names: readonly string[]): string {
  const shown = names.slice(0, 4).join(', ');
  return names.length > 4 ? `${shown} and ${names.length - 4} more` : shown;
}

function needStatus(need: GuideNeed, style: TeamUpStyle, ctx: GuideContext | null, mode: 'choose' | 'about'): { tone: Tone; text: string; fix?: RosterFix } {
  if (!ctx) return { tone: 'info', text: need.text };
  const n = ctx.playerCount;
  switch (need.requirement) {
    case 'genders': {
      if (n === 0) return { tone: 'info', text: need.text };
      const k = ctx.missingGender.length;
      return k === 0
        ? { tone: 'ok', text: `All ${n} players have a gender set.` }
        : { tone: 'warn', text: `${k} of ${n} players have no gender set (${listNames(ctx.missingGender)}); they fill in on either side.`, fix: 'genders' };
    }
    case 'skills': {
      if (n === 0) return { tone: 'info', text: need.text };
      const k = ctx.missingSkill.length;
      const fallback = style === 'pools' ? 'they go in pool B unless you set their pool' : 'they count as the middle level';
      return k === 0
        ? { tone: 'ok', text: `All ${n} players have a skill level.` }
        : { tone: 'warn', text: `${k} of ${n} players have no skill level (${listNames(ctx.missingSkill)}); ${fallback}.`, fix: 'skills' };
    }
    case 'courts2': {
      if (ctx.courtCount >= 2) return { tone: 'ok', text: `${ctx.courtCount} courts in play.` };
      const fallback = ONE_COURT[style];
      return fallback ? { tone: 'warn', text: `You have 1 court: ${fallback}` } : { tone: 'ok', text: 'Works on 1 court too.' };
    }
    case 'pairs':
      return ctx.pairCount > 0
        ? { tone: 'ok', text: `${ctx.pairCount} ${ctx.pairCount === 1 ? 'pair is' : 'pairs are'} locked.` }
        : { tone: 'info', text: 'No pairs locked yet: lock them under Game settings after choosing this style.' };
    case 'schedule':
      return scheduleStatus(ctx.checkedInCount, mode);
    case 'results':
      return { tone: 'info', text: need.text };
  }
}

function scheduleStatus(n: number, mode: 'choose' | 'about'): { tone: Tone; text: string } {
  if (n < 4) return { tone: 'warn', text: `Only ${n} ${n === 1 ? 'player is' : 'players are'} checked in: check in at least 4 (2 for singles), then generate the schedule.` };
  return {
    tone: 'ok',
    text: mode === 'choose' ? `${n} players checked in: Use this style generates the schedule for them.` : `${n} players checked in. View, print or regenerate it under Game settings.`,
  };
}

const TONE_ICON: Record<Tone, string> = { ok: '✓', warn: '!', info: 'i' };
const TONE_WORD: Record<Tone, string> = { ok: 'Ready', warn: 'Check', info: 'Note' };

interface DialogProps {
  style: TeamUpStyle;
  mode: 'choose' | 'about';
  context: GuideContext | null;
  onUse: () => void;
  onClose: () => void;
  onFixRoster?: (what: RosterFix) => void;
  busy?: boolean;
  /** On the new-session form: no roster yet. */
  newSession?: boolean;
}

/** The explanation window: what a team-up style does, what it needs and how fair it is. */
export function TeamUpGuideDialog({ style, mode, context, onUse, onClose, onFixRoster, busy = false, newSession = false }: DialogProps) {
  const g = guideFor(style);
  const summaryId = useId();
  const statuses = g.needs.map((need) => needStatus(need, style, context, mode));
  const usingRosterNames = (context?.players.length ?? 0) >= 8;
  return (
    <Modal
      title={mode === 'about' ? `About: ${g.title}` : g.title}
      icon={g.icon}
      onClose={onClose}
      className="guide-modal"
      describedBy={summaryId}
      closeLabel={mode === 'about' ? 'Close window' : 'Cancel and keep the current style'}
      footer={
        mode === 'choose' ? (
          <>
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="guide-use" disabled={busy} onClick={onUse}>
              {busy ? 'Applying…' : style === 'round_robin' && !newSession ? 'Use this style and make the schedule' : 'Use this style'}
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
      <div className="guide-grid">
        <TeamUpDiagram kind={g.diagram} />
        <div className="guide-how">
          <h3>How it works</h3>
          <ul>
            {g.how.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className="guide-cards">
        <section className="guide-card" aria-label="Best for">
          <h3>
            <span className="h-icon" aria-hidden="true">👥</span>Best for
          </h3>
          <p>{g.bestFor}</p>
        </section>
        <section className="guide-card" aria-label="What you need">
          <h3>
            <span className="h-icon" aria-hidden="true">🧰</span>What you need
          </h3>
          <ul className="guide-needs">
            {statuses.map((s, i) => (
              <li key={i} className={`need need-${s.tone}`}>
                <span className="need-icon" aria-hidden="true">
                  {TONE_ICON[s.tone]}
                </span>
                <span className="sr-only">{TONE_WORD[s.tone]}: </span>
                <span className="need-text">{s.text}</span>
                {s.fix && onFixRoster ? (
                  <button type="button" className="secondary need-fix" onClick={() => onFixRoster(s.fix as RosterFix)}>
                    {s.fix === 'genders' ? 'Set genders' : 'Set skill levels'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
        <section className="guide-card guide-fair" aria-label="Fairness">
          <h3>
            <span className="h-icon" aria-hidden="true">⚖️</span>Fairness
          </h3>
          <p>{g.fairness}</p>
        </section>
        <section className="guide-card guide-example" aria-label="Example">
          <h3>
            <span className="h-icon" aria-hidden="true">💬</span>Example{usingRosterNames ? ' with your players' : ''}
          </h3>
          <p>{g.example(context?.players ?? [])}</p>
        </section>
      </div>
      {mode === 'choose' && newSession && style === 'round_robin' ? (
        <p className="hint">The schedule is made in the session (Game settings) once players have checked in.</p>
      ) : null}
      {mode === 'choose' ? <p className="hint guide-foot">Cancel keeps your current style. You can switch styles at any time; the change applies to the next recommendation.</p> : null}
    </Modal>
  );
}

interface PickerProps {
  value: TeamUpStyle;
  /** Applies the confirmed style; resolve false to keep the window open (for example on an error). */
  onApply: (style: TeamUpStyle) => Promise<boolean> | boolean;
  disabled?: boolean;
  context: GuideContext | null;
  onFixRoster?: (what: RosterFix) => void;
  /** field: label above (forms); inline: label beside (Game settings). */
  layout?: 'field' | 'inline';
  newSession?: boolean;
}

/**
 * Team-up style selector. Choosing a style opens the explanation window first; "Use this style"
 * applies it and Cancel keeps the previous one. "About this style" reopens the window for the
 * current style without changing anything.
 */
export function TeamUpPicker({ value, onApply, disabled = false, context, onFixRoster, layout = 'inline', newSession = false }: PickerProps) {
  const [dialog, setDialog] = useState<{ style: TeamUpStyle; mode: 'choose' | 'about' } | null>(null);
  const [busy, setBusy] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const current = guideFor(value);
  /** Closes the window; focus goes back to the selector when nothing else took it. */
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
      const ok = await onApply(dialog.style);
      if (ok) close();
    } finally {
      setBusy(false);
    }
  };
  const select = (
    <select ref={selectRef} value={value} disabled={disabled} onChange={(e) => setDialog({ style: e.target.value as TeamUpStyle, mode: 'choose' })}>
      {TEAM_UP_CHOICES.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
  return (
    <div className={`teamup-picker teamup-${layout}`}>
      {layout === 'field' ? (
        <label className="field">
          Team-up style
          {select}
        </label>
      ) : (
        <label>Team-up style {select}</label>
      )}
      <button type="button" className="about-style" aria-label={`About this style: ${current.title}`} onClick={() => setDialog({ style: value, mode: 'about' })}>
        <span aria-hidden="true">ⓘ</span> About this style
      </button>
      {dialog ? (
        <TeamUpGuideDialog
          style={dialog.style}
          mode={dialog.mode}
          context={context}
          busy={busy}
          newSession={newSession}
          onUse={() => void use()}
          onClose={close}
          {...(onFixRoster
            ? {
                onFixRoster: (what: RosterFix) => {
                  setDialog(null);
                  onFixRoster(what);
                },
              }
            : {})}
        />
      ) : null}
    </div>
  );
}
