import type { Db } from './db';
import { withTransaction } from './db';
import { DuplicatePlayerError, ValidationError } from './errors';
import { newId, raw } from './sqlite';
import type { Player } from './types';

interface PlayerRow {
  id: string;
  display_name: string;
  nickname: string | null;
  skill_level: number | null;
  active: number;
}

export function toPlayer(row: PlayerRow): Player {
  return {
    id: row.id,
    displayName: row.display_name,
    nickname: row.nickname,
    skillLevel: row.skill_level,
    active: row.active === 1,
  };
}

/** Trim, collapse inner whitespace, ignore case (brief §6 duplicate entries). */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function cleanName(name: string): string {
  const cleaned = name.trim().replace(/\s+/g, ' ');
  if (cleaned === '') throw new ValidationError('A player needs a name.');
  return cleaned;
}

function cleanNickname(nickname: string | null | undefined): string | null {
  if (nickname === null || nickname === undefined) return null;
  const cleaned = nickname.trim().replace(/\s+/g, ' ');
  return cleaned === '' ? null : cleaned;
}

function checkSkill(skill: number | null | undefined): number | null {
  if (skill === null || skill === undefined) return null;
  if (!Number.isFinite(skill)) throw new ValidationError('Skill level must be a number.');
  return skill;
}

export function getPlayer(db: Db, id: string): Player | null {
  const row = raw(db).prepare('SELECT * FROM players WHERE id = ?').get(id) as PlayerRow | undefined;
  return row ? toPlayer(row) : null;
}

export function listPlayers(db: Db, opts: { includeInactive?: boolean } = {}): Player[] {
  const where = opts.includeInactive ? '' : 'WHERE active = 1';
  const rows = raw(db).prepare(`SELECT * FROM players ${where} ORDER BY rowid`).all() as PlayerRow[];
  return rows.map(toPlayer);
}

/** Active players whose display name or nickname equals `name` (normalized). */
export function findPlayersByName(db: Db, name: string): Player[] {
  const wanted = normalizeName(name);
  if (wanted === '') return [];
  return listPlayers(db).filter(
    (p) => normalizeName(p.displayName) === wanted || (p.nickname !== null && normalizeName(p.nickname) === wanted),
  );
}

export interface NewPlayerInput {
  displayName: string;
  nickname?: string | null;
  skillLevel?: number | null;
  allowDuplicateName?: boolean;
}

/** Insert without the duplicate check; callers that already checked use this inside their transaction. */
export function insertPlayer(db: Db, input: NewPlayerInput): Player {
  const player: Player = {
    id: newId(),
    displayName: cleanName(input.displayName),
    nickname: cleanNickname(input.nickname),
    skillLevel: checkSkill(input.skillLevel),
    active: true,
  };
  raw(db)
    .prepare('INSERT INTO players (id, display_name, nickname, skill_level, active) VALUES (?, ?, ?, ?, 1)')
    .run(player.id, player.displayName, player.nickname, player.skillLevel);
  return player;
}

export function assertNoDuplicateName(db: Db, input: NewPlayerInput): void {
  if (input.allowDuplicateName) return;
  const matches = findPlayersByName(db, input.displayName);
  if (matches.length > 0) {
    throw new DuplicatePlayerError(
      `"${input.displayName.trim()}" matches an existing player. Choose that player, or confirm they are a different person.`,
      matches,
    );
  }
}

export function createPlayer(db: Db, input: NewPlayerInput): Player {
  return withTransaction(db, () => {
    assertNoDuplicateName(db, input);
    return insertPlayer(db, input);
  });
}

export function updatePlayer(
  db: Db,
  id: string,
  patch: { displayName?: string; nickname?: string | null; skillLevel?: number | null },
): Player {
  return withTransaction(db, () => {
    const current = getPlayer(db, id);
    if (!current) throw new ValidationError(`Unknown player: ${id}`);
    const next: Player = {
      ...current,
      displayName: patch.displayName === undefined ? current.displayName : cleanName(patch.displayName),
      nickname: patch.nickname === undefined ? current.nickname : cleanNickname(patch.nickname),
      skillLevel: patch.skillLevel === undefined ? current.skillLevel : checkSkill(patch.skillLevel),
    };
    raw(db)
      .prepare('UPDATE players SET display_name = ?, nickname = ?, skill_level = ? WHERE id = ?')
      .run(next.displayName, next.nickname, next.skillLevel, id);
    return next;
  });
}

export interface RenamePlayerInput {
  displayName: string;
  nickname?: string | null;
  /** The organizer deliberately keeps this player as a different person with the same name. */
  allowDuplicateName?: boolean;
}

/**
 * Change a player's display name and nickname. The id never changes, so every game, roster entry
 * and statistic stays linked. A new name or nickname that matches another active player is refused
 * with DuplicatePlayerError unless allowDuplicateName is set (brief §6 duplicate entries).
 * Only names that actually change are checked, so re-saving an accepted duplicate is not refused again.
 */
export function renamePlayer(db: Db, id: string, input: RenamePlayerInput): Player {
  return withTransaction(db, () => {
    const current = getPlayer(db, id);
    if (!current) throw new ValidationError(`Unknown player: ${id}`);
    const displayName = cleanName(input.displayName);
    const nickname = input.nickname === undefined ? current.nickname : cleanNickname(input.nickname);
    if (!input.allowDuplicateName) {
      const changed: string[] = [];
      if (normalizeName(displayName) !== normalizeName(current.displayName)) changed.push(displayName);
      if (nickname !== null && normalizeName(nickname) !== normalizeName(current.nickname ?? '')) changed.push(nickname);
      const matches = new Map<string, Player>();
      for (const name of changed) {
        for (const p of findPlayersByName(db, name)) if (p.id !== id) matches.set(p.id, p);
      }
      if (matches.size > 0) {
        throw new DuplicatePlayerError(
          `"${changed.join('" / "')}" matches an existing player. Keep the old name, or confirm this is a different person.`,
          [...matches.values()],
        );
      }
    }
    raw(db).prepare('UPDATE players SET display_name = ?, nickname = ? WHERE id = ?').run(displayName, nickname, id);
    return { ...current, displayName, nickname };
  });
}

/** The player leaves the active registry; every game, participant and event is kept. */
export function deactivatePlayer(db: Db, id: string): Player {
  return withTransaction(db, () => {
    const current = getPlayer(db, id);
    if (!current) throw new ValidationError(`Unknown player: ${id}`);
    raw(db).prepare('UPDATE players SET active = 0 WHERE id = ?').run(id);
    return { ...current, active: false };
  });
}
