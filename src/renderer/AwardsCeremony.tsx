import { useEffect, useState, type CSSProperties } from 'react';
import { formatWinners, podiumCaption, podiumLayout, type Award, type AwardId, type PodiumStep } from '../core/awards';
import type { AwardsReport } from '../data/awards';
import type { ShowAward } from '../core/awards/lineup';
import type { AwardCategory } from '../core/awards/templates';

/**
 * Presentational pieces shared by the organizer's Awards tab and the large-screen ceremony.
 * Nothing here is interactive, so the display window stays control-free.
 */

export const AWARD_ACCENT: Record<AwardId, string> = {
  champion: '#d4a017',
  most_wins: '#c9871a',
  point_machine: '#d0463b',
  hot_streak: '#e2662b',
  dynamic_duo: '#2f7fd1',
  clutch: '#7a4cc2',
  iron_player: '#2c8a57',
  social_butterfly: '#c2468f',
  rising_star: '#1f9aa3',
};

/** Accent per library category; built-in awards keep their own colour. */
export const CATEGORY_ACCENT: Record<AwardCategory, string> = {
  performance: '#e0533d',
  partnership: '#2f7fd1',
  drama: '#8a4fd6',
  fun: '#e28a1b',
  community: '#22a06b',
  peoples_choice: '#d6408f',
};

export function accentFor(award: Pick<ShowAward, 'source' | 'templateId' | 'category'>): string {
  if (award.source === 'builtin') return AWARD_ACCENT[award.templateId as AwardId] ?? '#d4a017';
  return award.category === 'classic' ? '#d4a017' : CATEGORY_ACCENT[award.category];
}

const MEDAL: Record<1 | 2 | 3, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };
const PLACE_NAME: Record<1 | 2 | 3, string> = { 1: 'First place', 2: 'Second place', 3: 'Third place' };

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

const style = (vars: Record<string, string | number>): CSSProperties => vars as CSSProperties;

/** Names on a podium step: everyone when few, else the first three and "+N more". */
export function podiumNames(players: ReadonlyArray<{ name: string }>, max = 3): string {
  if (players.length <= max) return players.map((p) => p.name).join(' & ');
  return `${players.slice(0, max).map((p) => p.name).join(', ')} +${players.length - max} more`;
}

/**
 * Gold in the middle, silver left, bronze right. All three steps are always drawn; tied players share
 * a step and the next players fill the next step (dense placement, see core/awards/podium.ts), with a
 * small caption when the official rank differs ("Rank 3") or is shared ("Tied for 1st").
 */
export function Podium({ steps, still = false }: { steps: PodiumStep[]; still?: boolean }) {
  return (
    <ol className={`podium${still ? ' still' : ''}`} aria-label="Podium">
      {podiumLayout(steps).map(({ step: place, spot }) => {
        const delay = style({ '--i': place === 1 ? 2 : place === 2 ? 1 : 0 });
        if (!spot) {
          return (
            <li key={place} className={`podium-col place-${place} vacant`} style={delay} aria-hidden="true">
              <div className="podium-step">
                <span className="podium-num">{place}</span>
              </div>
            </li>
          );
        }
        const lead = spot.players[0];
        const caption = podiumCaption(spot);
        return (
          <li key={place} className={`podium-col place-${place}${spot.tied ? ' tied' : ''} n${Math.min(spot.players.length, 3)}`} style={delay}>
            <span className="sr-only">
              {PLACE_NAME[place]}
              {caption ? ` (${caption})` : ''}:{' '}
            </span>
            <div className="podium-people">
              <div className="podium-avatars" aria-hidden="true">
                {spot.players.slice(0, 3).map((p) => (
                  <span className="avatar" key={p.playerId}>
                    {initials(p.name)}
                  </span>
                ))}
              </div>
              <div className="podium-medal" aria-hidden="true">
                {MEDAL[place]}
              </div>
              <div className="podium-names">{podiumNames(spot.players)}</div>
              {lead ? (
                <div className="podium-record">
                  {spot.record} · {Math.round(lead.winPct * 100)}%
                </div>
              ) : null}
              {caption ? <div className="podium-caption">{caption}</div> : null}
            </div>
            <div className="podium-step">
              <span className="podium-num" aria-hidden="true">
                {place}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** A card for a built-in award or any lineup award (renamed, library or host pick). */
export function AwardCard({ award, index, maxNames = 3 }: { award: Award | ShowAward; index: number; maxNames?: number }) {
  const id = 'key' in award ? award.templateId : award.id;
  const accent = 'key' in award ? accentFor(award) : AWARD_ACCENT[award.id];
  return (
    <article
      className="award-card"
      data-award={id}
      style={style({ '--accent': accent, '--i': index })}
      aria-label={`${award.title}: ${formatWinners(award.groups)}`}
    >
      <div className="award-icon" aria-hidden="true">
        {award.icon}
      </div>
      <div className="award-body">
        <h3 className="award-title">{award.title}</h3>
        <p className="award-winner">{formatWinners(award.groups, maxNames)}</p>
        <p className="award-explain">{award.explanation}</p>
      </div>
      <div className="award-stat">
        <span className="award-stat-num">{award.stat}</span>
        <span className="award-stat-label">{award.statLabel}</span>
      </div>
    </article>
  );
}

export function ChampionBanner({ report }: { report: AwardsReport }) {
  const champion = report.lineup.find((a) => a.templateId === 'champion');
  if (!champion) return null;
  return (
    <div className={`champion${champion.groups.length > 1 ? ' shared' : ''}`}>
      <p className="champion-kicker">
        <span className="btn-icon" aria-hidden="true">🏆</span>
        {champion.title}
        {champion.provisional ? <span className="pill">provisional</span> : null}
      </p>
      <p className="champion-name">{formatWinners(champion.groups)}</p>
      <p className="champion-line">{champion.explanation}</p>
    </div>
  );
}

const CONFETTI_COLORS = ['#ffd54a', '#5fd39b', '#ff7a59', '#7cc4ff', '#f3a6ff', '#ffffff', '#ffb23f'];

/** Deterministic pseudo-random numbers so a burst renders the same on every repaint. */
function seeded(seed: number): () => number {
  let s = seed % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** A short CSS-only confetti burst. Hidden for prefers-reduced-motion; removed after it falls. */
export function Confetti({ burst, pieces = 90 }: { burst: number; pieces?: number }) {
  const [visible, setVisible] = useState(burst > 0);
  useEffect(() => {
    if (burst <= 0) return undefined;
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 4200);
    return () => window.clearTimeout(timer);
  }, [burst]);
  if (!visible) return null;
  const rand = seeded(burst * 7919);
  return (
    <div className="confetti" aria-hidden="true" key={burst}>
      {Array.from({ length: pieces }, (_, i) => (
        <span
          key={i}
          className={i % 3 === 0 ? 'bit round' : 'bit'}
          style={style({
            '--x': `${(rand() * 100).toFixed(1)}%`,
            '--drift': `${((rand() - 0.5) * 30).toFixed(1)}vw`,
            '--delay': `${(rand() * 0.6).toFixed(2)}s`,
            '--dur': `${(2.2 + rand() * 1.4).toFixed(2)}s`,
            '--spin': `${Math.round(360 + rand() * 720)}deg`,
            '--color': CONFETTI_COLORS[i % CONFETTI_COLORS.length] as string,
          })}
        />
      ))}
    </div>
  );
}
