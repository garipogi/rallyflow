import type { ReactNode } from 'react';
import type { GuideDiagram } from './teamUpOptions';

/**
 * Small illustrations for the team-up explanation window. Inline SVG coloured only through theme
 * tokens (CSS classes in styles.css), so they follow light/dark and every colour theme. Decorative
 * for screen readers: the "How it works" list beside it says the same thing in words.
 */

const W = 260;
const H = 150;

function Court({ x, y, w = 92, h = 52, label }: { x: number; y: number; w?: number; h?: number; label?: string }) {
  return (
    <g>
      <rect className="dg-court" x={x} y={y} width={w} height={h} rx={6} />
      <line className="dg-line" x1={x + w / 2} y1={y + 4} x2={x + w / 2} y2={y + h - 4} />
      {label ? (
        <text className="dg-label" x={x + w / 2} y={y - 5} textAnchor="middle">
          {label}
        </text>
      ) : null}
    </g>
  );
}

function Dot({ x, y, tone = 'a', text, r = 10 }: { x: number; y: number; tone?: 'a' | 'b' | 'muted' | 'win' | 'lose' | 'accent'; text?: string; r?: number }) {
  return (
    <g>
      <circle className={`dg-dot dg-${tone}`} cx={x} cy={y} r={r} />
      {text ? (
        <text className="dg-dot-text" x={x} y={y + 4} textAnchor="middle">
          {text}
        </text>
      ) : null}
    </g>
  );
}

function Arrow({ x1, y1, x2, y2, tone = 'accent' }: { x1: number; y1: number; x2: number; y2: number; tone?: 'accent' | 'win' | 'lose' | 'muted' }) {
  return <line className={`dg-arrow dg-arrow-${tone}`} x1={x1} y1={y1} x2={x2} y2={y2} markerEnd={`url(#dg-head-${tone})`} />;
}

function Defs() {
  return (
    <defs>
      {(['accent', 'win', 'lose', 'muted'] as const).map((tone) => (
        <marker key={tone} id={`dg-head-${tone}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path className={`dg-head dg-head-${tone}`} d="M0,0 L10,5 L0,10 z" />
        </marker>
      ))}
    </defs>
  );
}

function Text({ x, y, children, anchor = 'middle', className = 'dg-label' }: { x: number; y: number; children: ReactNode; anchor?: 'start' | 'middle' | 'end'; className?: string }) {
  return (
    <text className={className} x={x} y={y} textAnchor={anchor}>
      {children}
    </text>
  );
}

/** Four players on one court: two per side. */
function Four({ x, y, a, b, toneA = 'a', toneB = 'b' }: { x: number; y: number; a: [string, string]; b: [string, string]; toneA?: 'a' | 'win' | 'lose' | 'muted'; toneB?: 'b' | 'win' | 'lose' | 'muted' }) {
  return (
    <g>
      <Court x={x} y={y} />
      <Dot x={x + 23} y={y + 16} tone={toneA} text={a[0]} />
      <Dot x={x + 23} y={y + 37} tone={toneA} text={a[1]} />
      <Dot x={x + 69} y={y + 16} tone={toneB} text={b[0]} />
      <Dot x={x + 69} y={y + 37} tone={toneB} text={b[1]} />
    </g>
  );
}

function body(kind: GuideDiagram): ReactNode {
  switch (kind) {
    case 'balanced':
      return (
        <>
          {[0, 1, 2, 3, 4].map((i) => (
            <Dot key={i} x={24 + i * 24} y={40} tone={i === 4 ? 'muted' : 'accent'} text={i === 4 ? '3' : '2'} />
          ))}
          <Text x={72} y={18}>games played</Text>
          <Arrow x1={60} y1={58} x2={150} y2={92} />
          <Four x={150} y={74} a={['', '']} b={['', '']} />
          <Text x={120} y={132} anchor="middle">fewest games play</Text>
          <Text x={120} y={68} anchor="middle" className="dg-small">
            3 waits
          </Text>
        </>
      );
    case 'wait':
      return (
        <>
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <rect className="dg-bar" x={14 + i * 26} y={70 - (5 - i) * 9} width={14} height={(5 - i) * 9} rx={3} />
              <Dot x={21 + i * 26} y={84} tone={i < 4 ? 'accent' : 'muted'} r={9} />
            </g>
          ))}
          <Text x={74} y={112}>longest wait first</Text>
          <Arrow x1={128} y1={60} x2={158} y2={60} />
          <Four x={160} y={34} a={['', '']} b={['', '']} />
        </>
      );
    case 'random':
      return (
        <>
          <rect className="dg-die" x={18} y={40} width={44} height={44} rx={9} />
          {[
            [30, 52],
            [50, 52],
            [40, 62],
            [30, 72],
            [50, 72],
          ].map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} className="dg-pip" cx={cx} cy={cy} r={3.4} />
          ))}
          <Arrow x1={72} y1={62} x2={140} y2={62} />
          <Four x={150} y={36} a={['?', '?']} b={['?', '?']} />
          <Text x={130} y={124}>new random teams every round</Text>
        </>
      );
    case 'stack':
      return (
        <>
          <Four x={20} y={22} a={['W', 'L']} b={['W', 'L']} toneA="muted" toneB="muted" />
          <Four x={20} y={86} a={['W', 'L']} b={['W', 'L']} toneA="muted" toneB="muted" />
          <Arrow x1={118} y1={48} x2={148} y2={48} tone="win" />
          <Arrow x1={118} y1={112} x2={148} y2={112} tone="lose" />
          <Four x={150} y={22} a={['W', 'W']} b={['W', 'W']} toneA="win" toneB="win" />
          <Four x={150} y={86} a={['L', 'L']} b={['L', 'L']} toneA="lose" toneB="lose" />
          <Text x={196} y={16}>winners vs winners</Text>
          <Text x={196} y={80}>losers vs losers</Text>
        </>
      );
    case 'river':
      return (
        <>
          {[0, 1, 2].map((i) => (
            <Court key={i} x={60} y={10 + i * 46} w={110} h={36} />
          ))}
          <Text x={52} y={32} anchor="end">Court 1</Text>
          <Text x={52} y={78} anchor="end">Court 2</Text>
          <Text x={52} y={124} anchor="end">Court 3</Text>
          <Arrow x1={196} y1={112} x2={196} y2={30} tone="win" />
          <Arrow x1={226} y1={30} x2={226} y2={112} tone="lose" />
          <Text x={196} y={136} className="dg-small dg-win-text">W up</Text>
          <Text x={226} y={136} className="dg-small dg-lose-text">L down</Text>
          <Dot x={100} y={28} tone="win" text="W" r={9} />
          <Dot x={130} y={120} tone="lose" text="L" r={9} />
        </>
      );
    case 'pairs':
      return (
        <>
          <Court x={70} y={40} w={120} h={64} />
          <line className="dg-link" x1={100} y1={58} x2={100} y2={86} />
          <Dot x={100} y={56} tone="a" text="A" />
          <Dot x={100} y={88} tone="a" text="B" />
          <Dot x={160} y={56} tone="b" />
          <Dot x={160} y={88} tone="b" />
          <Text x={130} y={28}>locked pair stays together</Text>
        </>
      );
    case 'mixed':
      return (
        <>
          <Court x={50} y={30} w={160} h={84} />
          <Dot x={90} y={52} tone="a" text="F" r={12} />
          <Dot x={90} y={92} tone="a" text="M" r={12} />
          <Dot x={170} y={52} tone="b" text="M" r={12} />
          <Dot x={170} y={92} tone="b" text="F" r={12} />
          <Text x={130} y={134}>one man + one woman per team</Text>
        </>
      );
    case 'pools':
      return (
        <>
          <Four x={22} y={40} a={['A', 'A']} b={['A', 'A']} toneA="win" toneB="win" />
          <Four x={146} y={40} a={['B', 'B']} b={['B', 'B']} toneA="muted" toneB="muted" />
          <Text x={68} y={30}>Court 1 · pool A</Text>
          <Text x={192} y={30}>Court 2 · pool B</Text>
          <Text x={130} y={124}>fewest games first within each pool</Text>
        </>
      );
    case 'roundrobin': {
      const cells = [
        ['AB·CD', 'EF·GH'],
        ['AC·EG', 'BD·FH'],
        ['AD·FG', 'BC·EH'],
      ];
      return (
        <>
          <Text x={52} y={20} className="dg-small">Court 1</Text>
          <Text x={122} y={20} className="dg-small">Court 2</Text>
          <Text x={196} y={20} className="dg-small">Bye</Text>
          {cells.map((row, r) => (
            <g key={r}>
              <Text x={12} y={44 + r * 34} anchor="start" className="dg-small">
                R{r + 1}
              </Text>
              {row.map((cell, c) => (
                <g key={c}>
                  <rect className="dg-cell" x={24 + c * 70} y={28 + r * 34} width={62} height={26} rx={5} />
                  <Text x={55 + c * 70} y={45 + r * 34} className="dg-cell-text">
                    {cell}
                  </Text>
                </g>
              ))}
              <rect className="dg-cell dg-cell-bye" x={172} y={28 + r * 34} width={48} height={26} rx={5} />
              <Text x={196} y={45 + r * 34} className="dg-cell-text">
                {['I', 'J', 'K'][r]}
              </Text>
            </g>
          ))}
        </>
      );
    }
    case 'mentor':
      return (
        <>
          <Court x={50} y={30} w={160} h={84} />
          <Dot x={92} y={52} tone="win" text="4.0" r={15} />
          <Dot x={92} y={94} tone="muted" text="2.5" r={11} />
          <line className="dg-link" x1={92} y1={67} x2={92} y2={83} />
          <Dot x={168} y={52} tone="win" text="3.5" r={14} />
          <Dot x={168} y={94} tone="muted" text="3.0" r={12} />
          <line className="dg-link" x1={168} y1={66} x2={168} y2={82} />
          <Text x={130} y={136}>higher-rated + lower-rated</Text>
        </>
      );
    case 'challenge':
      return (
        <>
          <Court x={70} y={44} w={120} h={64} />
          <path className="dg-crown" d="M84,40 L90,24 L98,34 L106,20 L114,34 L122,24 L128,40 Z" />
          <Dot x={100} y={62} tone="win" text="W" />
          <Dot x={100} y={92} tone="win" text="W" />
          <Dot x={160} y={62} tone="b" />
          <Dot x={160} y={92} tone="b" />
          {[0, 1, 2].map((i) => (
            <Dot key={i} x={222} y={44 + i * 26} tone="muted" r={8} />
          ))}
          <Arrow x1={210} y1={78} x2={180} y2={78} />
          <Text x={130} y={134}>winners stay (max 2), challengers come in</Text>
        </>
      );
    case 'swiss':
      return (
        <>
          {[
            ['3–1', '3–1'],
            ['2–2', '2–2'],
            ['1–3', '1–3'],
          ].map(([a, b], i) => (
            <g key={i}>
              <rect className="dg-cell" x={40} y={16 + i * 40} width={70} height={28} rx={6} />
              <rect className="dg-cell" x={150} y={16 + i * 40} width={70} height={28} rx={6} />
              <Text x={75} y={35 + i * 40} className="dg-cell-text">
                {a}
              </Text>
              <Text x={185} y={35 + i * 40} className="dg-cell-text">
                {b}
              </Text>
              <Text x={130} y={35 + i * 40} className="dg-small">
                vs
              </Text>
            </g>
          ))}
        </>
      );
  }
}

export function TeamUpDiagram({ kind }: { kind: GuideDiagram }) {
  return (
    <figure className="dg">
      <svg className="dg-svg" viewBox={`0 0 ${W} ${H}`} role="presentation" aria-hidden="true" focusable="false">
        <Defs />
        {body(kind)}
      </svg>
    </figure>
  );
}
