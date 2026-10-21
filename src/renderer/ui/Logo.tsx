import { BRAND } from '../../shared/brand';

/** The RallyFlow mark (a simplified build/icon.svg): a paddle sends the ball along a flowing rally arc. Decorative. */
export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="60" height="60" rx="15" className="logo-tile" />
      <path d="M2 51h60M32 51v11" className="logo-lines" />
      <path d="M9.5 28 C 11.5 13, 30 6, 39.5 18.5 L 36.5 21.3 C 30 12.5, 16 15.5, 9.5 28 Z" className="logo-flow" />
      <path d="M14 32 C 17 21, 28 17, 35 25 L 33.6 26.8 C 28 20.5, 19 23, 14 32 Z" className="logo-flow2" />
      <g transform="rotate(-32 20 41)">
        <rect x="17.6" y="46" width="4.8" height="13" rx="2.2" className="logo-handle" />
        <rect x="10" y="26" width="20" height="23" rx="8.5" className="logo-paddle" />
      </g>
      <circle cx="44" cy="28" r="9.5" className="logo-ball" />
      <circle cx="41" cy="25" r="1.4" className="logo-hole" />
      <circle cx="46.5" cy="26" r="1.4" className="logo-hole" />
      <circle cx="43" cy="31" r="1.4" className="logo-hole" />
      <circle cx="48" cy="31" r="1.2" className="logo-hole" />
    </svg>
  );
}

/** Product name with tagline, used in the organizer header and the awards footer. */
export function BrandLockup({ tagline = true }: { tagline?: boolean }) {
  return (
    <span className="brand-lockup">
      <span className="brand-name">{BRAND.name}</span>
      {tagline ? <span className="brand-tagline">{BRAND.tagline}</span> : null}
    </span>
  );
}

/** A bouncing ball over a court, shown when a court is free. Decorative and motion-safe. */
export function IdleCourt() {
  return (
    <div className="idle-court" aria-hidden="true">
      <div className="idle-net" />
      <div className="idle-ball" />
      <div className="idle-shadow" />
    </div>
  );
}
