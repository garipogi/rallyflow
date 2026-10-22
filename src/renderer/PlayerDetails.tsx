import { useEffect, useRef, useState } from 'react';
import type { Gender, PoolName } from '../core/rotation';
import type { PlayerDetails, PlayerDetailsPatch } from '../shared/api';
import type { RosterEntry } from '../data/types';
import { Avatar } from './ui/Avatar';

export const GENDER_OPTIONS: readonly { value: '' | Gender; label: string }[] = [
  { value: '', label: 'Not set' },
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
];

export const POOL_OPTIONS: readonly { value: '' | PoolName; label: string }[] = [
  { value: '', label: 'From skill' },
  { value: 'A', label: 'A (advanced)' },
  { value: 'B', label: 'B (developing)' },
  { value: 'C', label: 'C' },
];

export const GENDER_SHORT: Record<Gender, string> = { female: 'F', male: 'M' };

/** Parses the skill text box: '' = not set, otherwise a number (validated by the data layer). */
export function parseSkill(text: string): number | null | 'invalid' {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : 'invalid';
}

/** One-line summary of a player's level for the roster: "3.5 · F · Pool A". */
export function levelText(details: PlayerDetails | undefined): string {
  if (!details) return '';
  return [details.skillLevel !== null ? String(details.skillLevel) : '', details.gender ? GENDER_SHORT[details.gender] : '', details.pool ? `Pool ${details.pool}` : '']
    .filter((x) => x !== '')
    .join(' · ');
}

interface Props {
  roster: RosterEntry[];
  details: Record<string, PlayerDetails>;
  readOnly: boolean;
  /** Which column to focus when opened from the explanation window. */
  focus: 'genders' | 'skills' | null;
  onSave: (playerId: string, patch: PlayerDetailsPatch) => Promise<boolean>;
  onClose: () => void;
}

/**
 * D18 quick editor: skill level, gender and pool for everyone on the roster in one table (opened
 * from the players card or the explanation window's "Set genders" / "Set skill levels").
 */
export function PlayerDetailsEditor({ roster, details, readOnly, focus, onSave, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [skillDrafts, setSkillDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    box.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const target = focus === 'skills' ? 'input[data-field="skill"]' : focus === 'genders' ? 'select[data-field="gender"]' : null;
    // after the explanation window has returned focus to its opener
    const timer = window.setTimeout(() => (target ? box.querySelector<HTMLElement>(target) : box.querySelector<HTMLElement>('h4'))?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [focus]);

  const missingGender = roster.filter((e) => !details[e.playerId]?.gender).length;
  const missingSkill = roster.filter((e) => (details[e.playerId]?.skillLevel ?? null) === null).length;

  const saveSkill = async (playerId: string) => {
    const draft = skillDrafts[playerId];
    if (draft === undefined) return;
    const parsed = parseSkill(draft);
    if (parsed === 'invalid') {
      setError('Skill level must be a number from 1 to 8, or empty.');
      return;
    }
    if (parsed === (details[playerId]?.skillLevel ?? null)) return;
    if (await onSave(playerId, { skillLevel: parsed })) {
      setError(null);
      setSkillDrafts((d) => {
        const { [playerId]: _done, ...rest } = d;
        return rest;
      });
    }
  };

  return (
    <div className="player-details" id="player-details" ref={ref}>
      <div className="section-head">
        <h4 tabIndex={-1}>Player details: skill, gender, pool</h4>
        <button className="secondary" onClick={onClose}>
          Done
        </button>
      </div>
      <p className="hint">
        Used by Mixed doubles (gender), Mentor pairing and Skill pools (skill level 1 to 8, or a pool). Changes save as you go.{' '}
        {missingGender > 0 ? `${missingGender} without a gender. ` : ''}
        {missingSkill > 0 ? `${missingSkill} without a skill level.` : ''}
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <table className="details-table">
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col">Skill level</th>
            <th scope="col">Gender</th>
            <th scope="col">Pool</th>
          </tr>
        </thead>
        <tbody>
          {roster.map((e) => {
            const d = details[e.playerId];
            const name = e.player.displayName;
            return (
              <tr key={e.playerId}>
                <td>
                  <span className="who">
                    <Avatar playerId={e.playerId} name={name} />
                    <span>{name}</span>
                  </span>
                </td>
                <td>
                  <input
                    data-field="skill"
                    className="skill-input"
                    aria-label={`Skill level for ${name}`}
                    inputMode="decimal"
                    disabled={readOnly}
                    value={skillDrafts[e.playerId] ?? (d?.skillLevel !== null && d?.skillLevel !== undefined ? String(d.skillLevel) : '')}
                    onChange={(ev) => setSkillDrafts({ ...skillDrafts, [e.playerId]: ev.target.value })}
                    onBlur={() => void saveSkill(e.playerId)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') void saveSkill(e.playerId);
                    }}
                  />
                </td>
                <td>
                  <select
                    data-field="gender"
                    aria-label={`Gender for ${name}`}
                    disabled={readOnly}
                    value={d?.gender ?? ''}
                    onChange={(ev) => void onSave(e.playerId, { gender: ev.target.value === '' ? null : (ev.target.value as Gender) })}
                  >
                    {GENDER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    aria-label={`Pool for ${name}`}
                    disabled={readOnly}
                    value={d?.pool ?? ''}
                    onChange={(ev) => void onSave(e.playerId, { pool: ev.target.value === '' ? null : (ev.target.value as PoolName) })}
                  >
                    {POOL_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
