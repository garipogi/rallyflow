import { useState, type KeyboardEvent } from 'react';
import type { TeamId } from '../core/scoring';
import {
  alignScoresToWinner,
  checkQuickScore,
  chipScores,
  quickChips,
  resultLabel,
  scoreLine,
  type GameRules,
  type QuickChip,
} from '../core/scoring/quickResult';

/**
 * Games finished with a quick result in this window. The session room's "result recorded" toast
 * skips them, because the quick result already shows its own toast with Undo.
 */
const quickGames = new Set<string>();
export const markQuickResult = (gameId: string): void => {
  quickGames.add(gameId);
};
export const isQuickResult = (gameId: string): boolean => quickGames.has(gameId);

/** Records a result; resolves to an error message, or null when it was saved. */
export type RecordResult = (winner: TeamId, scoreA?: number, scoreB?: number) => Promise<string | null>;

interface TeamInfo {
  name: (id: TeamId) => string;
}

const other = (t: TeamId): TeamId => (t === 'A' ? 'B' : 'A');

/** Letter keys pick a team; ignored with modifiers so shortcuts like Cmd+A still work in the inputs. */
function keyTeam(e: KeyboardEvent): TeamId | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const k = e.key.toLowerCase();
  return k === 'a' ? 'A' : k === 'b' ? 'B' : null;
}

function WinnerButton({
  team,
  name,
  disabled,
  leading,
  big,
  onClick,
}: {
  team: TeamId;
  name: string;
  disabled: boolean;
  leading: boolean;
  big: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`winner-btn winner-${team.toLowerCase()}${leading ? ' leading' : ''}${big ? ' big' : ''}`}
      aria-label={`${name} won`}
      aria-pressed={leading}
      data-team={team}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="winner-trophy" aria-hidden="true">
        🏆
      </span>
      <span className="winner-text">{name} won</span>
    </button>
  );
}

function ScoreBox({
  team,
  name,
  value,
  leading,
  disabled,
  onChange,
}: {
  team: TeamId;
  name: string;
  value: string;
  leading: boolean;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className={`qr-side qr-${team.toLowerCase()}${leading ? ' leading' : ''}`}>
      <span className="qr-name">
        {name}
        {leading ? <span className="qr-ahead">ahead</span> : null}
      </span>
      <input
        className="qr-score"
        aria-label={`${name} final score`}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        maxLength={2}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
      />
    </label>
  );
}

interface CardProps extends TeamInfo {
  mode: 'final_score' | 'winner_only';
  rules: GameRules;
  disabled: boolean;
  onRecord: RecordResult;
}

/**
 * The quick-result card that replaces rally scoring in "Final score only" and "Winner only"
 * sessions. Winner only: one tap on the team that won. Final score: type the score (the leader
 * lights up and the winner is inferred), or tap a common finish and the team that won, in any order.
 * Keys while focus is in the card: A / B pick the team, Enter saves.
 */
export function QuickResultCard({ mode, rules, disabled, name, onRecord }: CardProps) {
  const [scoreA, setScoreA] = useState('');
  const [scoreB, setScoreB] = useState('');
  const [chip, setChip] = useState<QuickChip | null>(null);
  const [picked, setPicked] = useState<TeamId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const chips = quickChips(rules);
  const check = checkQuickScore(scoreA, scoreB, rules);
  const leader: TeamId | null = check.kind === 'ok' ? check.winner : check.kind === 'empty' ? picked : null;
  const locked = disabled || saving;

  const save = async (winner: TeamId, a?: number, b?: number) => {
    setSaving(true);
    const failed = await onRecord(winner, a, b);
    setSaving(false);
    setError(failed);
  };

  const fill = (c: QuickChip, winner: TeamId) => {
    const s = chipScores(c, winner);
    setScoreA(String(s.scoreA));
    setScoreB(String(s.scoreB));
  };

  const pickTeam = (team: TeamId) => {
    setError(null);
    if (mode === 'winner_only') {
      void save(team);
      return;
    }
    if (check.kind === 'ok') {
      const swapped = alignScoresToWinner(check.scoreA, check.scoreB, team);
      if (swapped) {
        setScoreA(String(swapped.scoreA));
        setScoreB(String(swapped.scoreB));
      }
    } else if (chip) {
      fill(chip, team);
    }
    setPicked(team);
  };

  const pickChip = (c: QuickChip) => {
    setError(null);
    const same = chip !== null && chip.high === c.high && chip.low === c.low;
    if (same) {
      setChip(null);
      return;
    }
    setChip(c);
    const winner = check.kind === 'ok' ? check.winner : picked;
    if (winner) fill(c, winner);
  };

  const typed = (team: TeamId, value: string) => {
    setError(null);
    setChip(null);
    setPicked(null);
    if (team === 'A') setScoreA(value);
    else setScoreB(value);
  };

  const saveTyped = () => {
    if (check.kind === 'ok') void save(check.winner, check.scoreA, check.scoreB);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (locked) return;
    const team = keyTeam(e);
    if (team) {
      e.preventDefault();
      pickTeam(team);
      return;
    }
    if (e.key === 'Enter' && mode === 'final_score' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      saveTyped();
    }
  };

  if (mode === 'winner_only') {
    return (
      <div className="quick-card" role="group" aria-label="Record the result" onKeyDown={onKeyDown}>
        <p className="quick-ask">Who won?</p>
        <div className="winner-row">
          {(['A', 'B'] as const).map((t) => (
            <WinnerButton key={t} team={t} name={name(t)} big disabled={locked} leading={false} onClick={() => pickTeam(t)} />
          ))}
        </div>
        {error ? (
          <p className="qr-note qr-problem" role="alert">
            {error}
          </p>
        ) : null}
        <p className="hint qr-keys">One tap saves the result (no score). Undo stays available afterwards. Keys: A or B.</p>
      </div>
    );
  }

  let note: { tone: 'info' | 'ok' | 'warn' | 'problem'; text: string };
  if (check.kind === 'ok') {
    note = check.warning
      ? { tone: 'warn', text: check.warning }
      : { tone: 'ok', text: `${name(check.winner)} win ${scoreLine(Math.max(check.scoreA, check.scoreB), Math.min(check.scoreA, check.scoreB))}. Press Enter or Save result.` };
  } else if (check.kind === 'empty') {
    if (picked && chip) note = { tone: 'info', text: 'Ready.' };
    else if (picked) note = { tone: 'info', text: `${name(picked)} won: now tap a quick finish or type the score.` };
    else if (chip) note = { tone: 'info', text: `${scoreLine(chip.high, chip.low)}: now tap the team that won.` };
    else note = { tone: 'info', text: 'Type the final score, or tap a quick finish and then the team that won (either order).' };
  } else {
    note = { tone: 'problem', text: check.message };
  }

  const label = check.kind === 'ok' ? resultLabel(name(check.winner), check.winner, check.scoreA, check.scoreB) : null;
  return (
    <div className="quick-card" role="group" aria-label="Record the final score" onKeyDown={onKeyDown}>
      <div className="qr-scores">
        <ScoreBox team="A" name={name('A')} value={scoreA} leading={leader === 'A' && check.kind === 'ok'} disabled={locked} onChange={(v) => typed('A', v)} />
        <span className="qr-dash" aria-hidden="true">
          –
        </span>
        <ScoreBox team="B" name={name('B')} value={scoreB} leading={leader === 'B' && check.kind === 'ok'} disabled={locked} onChange={(v) => typed('B', v)} />
      </div>
      <div className="qr-chips" role="group" aria-label="Quick finishes">
        <span className="qr-chips-label">Quick finish</span>
        {chips.map((c) => {
          const on = chip !== null && chip.high === c.high && chip.low === c.low;
          return (
            <button
              key={`${c.high}-${c.low}`}
              type="button"
              className={`chip qr-chip${on ? ' active' : ''}`}
              aria-pressed={on}
              aria-label={`Quick finish ${c.high} to ${c.low}`}
              disabled={locked}
              onClick={() => pickChip(c)}
            >
              {scoreLine(c.high, c.low)}
            </button>
          );
        })}
      </div>
      <div className="winner-row">
        {(['A', 'B'] as const).map((t) => (
          <WinnerButton key={t} team={t} name={name(t)} big disabled={locked} leading={leader === t} onClick={() => pickTeam(t)} />
        ))}
      </div>
      <p className={`qr-note qr-${note.tone}`} role="status" aria-live="polite">
        {note.text}
      </p>
      {error ? (
        <p className="qr-note qr-problem" role="alert">
          {error}
        </p>
      ) : null}
      <div className="qr-actions">
        <button type="button" className={`qr-save${check.kind === 'ok' && check.warning ? ' warn' : ''}`} disabled={locked || check.kind !== 'ok'} onClick={saveTyped}>
          {label ? `${check.kind === 'ok' && check.warning ? 'Save anyway' : 'Save result'}: ${label}` : 'Save result'}
        </button>
        {check.kind === 'empty' && picked && !chip ? (
          <button type="button" className="secondary qr-noscore" disabled={locked} onClick={() => void save(picked)}>
            Save without a score
          </button>
        ) : null}
      </div>
      <p className="hint qr-keys">Keys: A or B picks the team that won, Enter saves.</p>
    </div>
  );
}

/**
 * Rally-scoring sessions keep an escape hatch for a game nobody scored: a collapsed section with the
 * optional final score on one row and the two named winner buttons side by side below it.
 */
export function SkipScoring({ rules, disabled, name, onRecord }: TeamInfo & { rules: GameRules; disabled: boolean; onRecord: RecordResult }) {
  const [scoreA, setScoreA] = useState('');
  const [scoreB, setScoreB] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const check = checkQuickScore(scoreA, scoreB, rules);
  const typed = (team: TeamId, value: string) => {
    setMessage(null);
    if (team === 'A') setScoreA(value);
    else setScoreB(value);
  };

  const record = async (winner: TeamId) => {
    if (check.kind === 'incomplete' || check.kind === 'invalid' || check.kind === 'tie') {
      setMessage(check.message);
      return;
    }
    if (check.kind === 'ok' && check.winner !== winner) {
      setMessage(`${name(winner)} has the lower score. Fix the scores, or tap ${name(other(winner))}.`);
      return;
    }
    setMessage(null);
    setSaving(true);
    const failed = check.kind === 'ok' ? await onRecord(winner, check.scoreA, check.scoreB) : await onRecord(winner);
    setSaving(false);
    setMessage(failed);
  };

  return (
    <details className="skip-scoring">
      <summary>Skip scoring — just record the result</summary>
      <div className="skip-body">
        <div className="qr-scores compact">
          <ScoreBox team="A" name={name('A')} value={scoreA} leading={check.kind === 'ok' && check.winner === 'A'} disabled={disabled || saving} onChange={(v) => typed('A', v)} />
          <span className="qr-dash" aria-hidden="true">
            –
          </span>
          <ScoreBox team="B" name={name('B')} value={scoreB} leading={check.kind === 'ok' && check.winner === 'B'} disabled={disabled || saving} onChange={(v) => typed('B', v)} />
        </div>
        <div className="winner-row">
          {(['A', 'B'] as const).map((t) => (
            <WinnerButton
              key={t}
              team={t}
              name={name(t)}
              big={false}
              disabled={disabled || saving}
              leading={check.kind === 'ok' && check.winner === t}
              onClick={() => void record(t)}
            />
          ))}
        </div>
        {message ? (
          <p className="qr-note qr-problem" role="alert">
            {message}
          </p>
        ) : null}
        <span className="hint">
          Ends the game now. The final score is optional; without it the game counts as 0-0 for points (wins and losses still count).
        </span>
      </div>
    </details>
  );
}
