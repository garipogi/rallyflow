/**
 * Small pure helpers behind the lively bits of the UI (avatars, game point, elapsed time), shared by
 * the organizer window, the display window and the main process.
 */

/** Two-letter initials for an avatar chip: first letters of the first two words, or the first two letters. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] as string).slice(0, 2).toUpperCase();
  return `${(words[0] as string)[0] ?? ''}${(words[1] as string)[0] ?? ''}`.toUpperCase();
}

/** A stable hue (0-359) per player id, so a player keeps the same avatar colour everywhere. */
export function playerHue(playerId: string): number {
  let h = 2166136261;
  for (let i = 0; i < playerId.length; i += 1) {
    h ^= playerId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Golden-angle spread keeps neighbouring ids visually distinct.
  return Math.round(((h >>> 0) % 360) * 137.508) % 360;
}

export interface GamePointInput {
  score: { A: number; B: number };
  servingTeam: 'A' | 'B' | null;
  targetScore: number;
  winBy: number;
  isOver: boolean;
}

/**
 * Side-out scoring: only the serving team can score, so a team is on game point when it serves and
 * one more point would reach the target with the required lead.
 */
export function gamePointTeam(state: GamePointInput): 'A' | 'B' | null {
  if (state.isOver || state.servingTeam === null) return null;
  const team = state.servingTeam;
  const other = team === 'A' ? 'B' : 'A';
  const next = state.score[team] + 1;
  return next >= state.targetScore && next - state.score[other] >= state.winBy ? team : null;
}

/** "mm:ss" (or "h:mm:ss") since an ISO start time. */
export function formatElapsed(startIso: string | null, now: number): string {
  if (!startIso) return '0:00';
  const started = Date.parse(startIso);
  if (!Number.isFinite(started)) return '0:00';
  const total = Math.max(0, Math.floor((now - started) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
