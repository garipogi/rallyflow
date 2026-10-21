import type { CSSProperties } from 'react';
import { initialsOf, playerHue } from '../../shared/engage';
import { AVATAR_LIGHTNESS, AVATAR_SATURATION, AVATAR_TEXT } from '../../shared/themes';

/** Initials chip in a colour that stays the same for a player in every list and on the display. */
export function Avatar({ playerId, name, size }: { playerId: string; name: string; size?: string }) {
  const style = {
    background: `hsl(${playerHue(playerId)} ${AVATAR_SATURATION}% ${AVATAR_LIGHTNESS}%)`,
    color: AVATAR_TEXT,
    ...(size ? { '--chip': size } : {}),
  } as CSSProperties;
  return (
    <span className="chip-avatar" style={style} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
