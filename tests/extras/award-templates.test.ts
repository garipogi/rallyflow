/*
 * Award library (src/core/awards/templates.ts): every computed template, ties, score-less results,
 * thresholds and parameters, availability, the library description and the recommendations.
 */
import { describe, expect, it } from 'vitest';
import { replay, type GameSetup } from '../../src/core/scoring';
import { computeAwards } from '../../src/core/awards';
import {
  AWARD_TEMPLATES,
  buildTemplateContext,
  describeLibrary,
  evaluateTemplate,
  recommendTemplates,
  resolveParams,
  templateById,
  unavailableReason,
  type TemplateGame,
  type TemplateInput,
} from '../../src/core/awards/templates';

let seq = 0;
const at = (minute: number): string => `2026-10-21T18:${String(minute).padStart(2, '0')}:00.000Z`;

function game(teamA: string[], teamB: string[], winner: 'A' | 'B', score: [number, number] = winner === 'A' ? [11, 5] : [5, 11], extra: Partial<TemplateGame> = {}): TemplateGame {
  seq++;
  return {
    id: `g${seq}`,
    sessionId: 's1',
    format: teamA.length === 2 ? 'doubles' : 'singles',
    status: 'completed',
    teamAScore: score[0],
    teamBScore: score[1],
    winner,
    endedAt: `2026-10-21T${String(10 + Math.floor(seq / 60)).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}:00.000Z`,
    participants: [...teamA.map((playerId) => ({ playerId, team: 'A' as const })), ...teamB.map((playerId) => ({ playerId, team: 'B' as const }))],
    ...extra,
  };
}

/** A rally-scored game: the stored result is what replaying the rallies gives. */
function rallyGame(teamA: string[], teamB: string[], rallies: Array<'A' | 'B'>, extra: Partial<TemplateGame> = {}): TemplateGame {
  const setup: GameSetup = { format: teamA.length === 2 ? 'doubles' : 'singles', teamA, teamB, firstServingTeam: 'A' };
  const events = rallies.map((winner) => ({ type: 'rally' as const, winner }));
  const state = replay(setup, events);
  if (!state.isOver || !state.winner) throw new Error('test game must be over');
  return game(teamA, teamB, state.winner, [state.score.A, state.score.B], { log: { setup, events }, ...extra });
}

const times = (n: number, w: 'A' | 'B'): Array<'A' | 'B'> => Array(n).fill(w) as Array<'A' | 'B'>;
/** Singles: B takes the serve, goes 5-0 up, A takes it back and wins 11-5 (deficit 5, 18 rallies). */
const SINGLES_COMEBACK: Array<'A' | 'B'> = ['B', ...times(5, 'B'), 'A', ...times(11, 'A')];
/** Doubles: the same story; A needs two lost rallies to get the serve back. */
const DOUBLES_COMEBACK: Array<'A' | 'B'> = ['B', ...times(5, 'B'), 'A', 'A', ...times(11, 'A')];

const NAMES = { a: 'Ana', b: 'Ben', c: 'Cy', d: 'Dee', e: 'Eve', f: 'Flo', g: 'Gus', h: 'Hal', x: 'Xan', y: 'Yul' };

function ctx(games: TemplateGame[], extra: Partial<TemplateInput> = {}) {
  return buildTemplateContext({ scope: 'session', games, names: NAMES, ...extra });
}
function run(id: string, games: TemplateGame[], params?: Record<string, number>, extra: Partial<TemplateInput> = {}) {
  const t = templateById(id);
  if (!t) throw new Error(`no template ${id}`);
  return evaluateTemplate(t, ctx(games, extra), params);
}
const ids = (r: ReturnType<typeof run>) => r?.groups.map((g) => g.map((w) => w.playerId)) ?? null;
const noms = (r: ReturnType<typeof run>) => r?.nominees.map((g) => g.map((w) => w.playerId)) ?? null;

describe('library catalogue', () => {
  it('has at least 25 templates with unique ids in six categories, computed and manual', () => {
    expect(AWARD_TEMPLATES.length).toBeGreaterThanOrEqual(25);
    expect(new Set(AWARD_TEMPLATES.map((t) => t.id)).size).toBe(AWARD_TEMPLATES.length);
    expect(new Set(AWARD_TEMPLATES.map((t) => t.category)).size).toBe(6);
    expect(AWARD_TEMPLATES.filter((t) => t.kind === 'manual').length).toBeGreaterThanOrEqual(8);
    for (const t of AWARD_TEMPLATES) expect(t.kind === 'manual' ? t.evaluate === undefined : typeof t.evaluate).toBe(t.kind === 'manual' ? true : 'function');
  });

  it('resolves parameters with defaults and clamps them into range', () => {
    const t = templateById('undefeated');
    expect(t && resolveParams(t, undefined)).toEqual({ minGames: 3 });
    expect(t && resolveParams(t, { minGames: 999, bogus: 4 })).toEqual({ minGames: 30 });
    expect(t && resolveParams(t, { minGames: 2.5 })).toEqual({ minGames: 3 });
  });
});

describe('Performance templates', () => {
  it('Shutout King counts wins where the other side scored 0, never a score-less 0-0 result', () => {
    const games = [
      game(['a'], ['b'], 'A', [11, 0]),
      game(['a'], ['c'], 'A', [11, 0]),
      game(['c'], ['b'], 'A', [11, 0]),
      game(['a'], ['b'], 'A', [0, 0]),
      game(['d'], ['b'], 'A', [11, 0], { scoreless: true }),
    ];
    const r = run('shutout_king', games);
    expect(ids(r)).toEqual([['a']]);
    expect(r?.stat).toBe('2');
    expect(noms(r)).toEqual([['a'], ['c']]);
    expect(run('shutout_king', [game(['a'], ['b'], 'A', [11, 5])])).toBeNull();
  });

  it('Undefeated needs the minimum games and shares equal records by name', () => {
    const games = [
      game(['a'], ['e'], 'A'), game(['a'], ['f'], 'A'), game(['a'], ['e'], 'A'),
      game(['d'], ['f'], 'A'), game(['d'], ['e'], 'A'), game(['d'], ['f'], 'A'),
      game(['b'], ['e'], 'A'), game(['b'], ['f'], 'A'),
    ];
    const r = run('undefeated', games);
    expect(ids(r)).toEqual([['a'], ['d']]);
    expect(r?.stat).toBe('3-0');
    expect(run('undefeated', games, { minGames: 4 })).toBeNull();
    expect(ids(run('undefeated', games.slice(6), { minGames: 2 }))).toEqual([['b']]);
  });

  it('Giant Killer credits wins over the leaderboard leader and hides when the leader never lost', () => {
    const lost = [game(['a'], ['c'], 'A'), game(['a'], ['d'], 'A'), game(['a'], ['e'], 'A'), game(['b'], ['a'], 'A')];
    const r = run('giant_killer', lost);
    expect(ids(r)).toEqual([['b']]);
    expect(r?.explanation).toBe('Beat Ana once.');
    expect(run('giant_killer', lost.slice(0, 3))).toBeNull();
  });

  it('Steady Hands picks the lowest spread of point margins among players with a win', () => {
    const games = [
      game(['b'], ['x'], 'A', [11, 5]), game(['b'], ['x'], 'A', [11, 5]), game(['b'], ['x'], 'A', [11, 5]),
      game(['a'], ['y'], 'A', [11, 5]), game(['a'], ['y'], 'A', [11, 9]), game(['a'], ['y'], 'A', [11, 1]),
    ];
    const r = run('consistency', games);
    expect(ids(r)).toEqual([['b']]); // x is just as steady but never won
    expect(r?.stat).toBe('±0.0');
    expect(run('consistency', games, { minGames: 4 })).toBeNull();
    expect(run('consistency', games.map((g) => ({ ...g, teamAScore: 0, teamBScore: 0 })))).toBeNull();
  });

  it('Bounce-Back counts wins straight after a loss; equal counts fall back to the D9 standing', () => {
    const games = [
      game(['a'], ['b'], 'A'), game(['a'], ['b'], 'B'), game(['a'], ['b'], 'A'), game(['a'], ['b'], 'B'), game(['a'], ['b'], 'A'),
    ];
    const r = run('bounce_back', games);
    expect(ids(r)).toEqual([['a']]);
    expect(noms(r)).toEqual([['a'], ['b']]);
    expect(r?.stat).toBe('2');
  });

  it('Serve Machine credits the server of every point, only from logs that match the stored result', () => {
    const r = run('serve_machine', [rallyGame(['a'], ['b'], times(11, 'A'))]);
    expect(ids(r)).toEqual([['a']]);
    expect(r?.stat).toBe('11');
    expect(run('serve_machine', [game(['a'], ['b'], 'A', [11, 0])])).toBeNull();
    // Result typed in over a partial log: the log no longer matches, so it is ignored.
    const typed = rallyGame(['a'], ['b'], times(11, 'A'));
    expect(run('serve_machine', [{ ...typed, teamAScore: 11, teamBScore: 7 }])).toBeNull();
  });

  it('Side-Out Specialist counts return rallies that took the serve back', () => {
    const r = run('side_out_specialist', [rallyGame(['a'], ['b'], ['B', 'A', 'B', ...times(11, 'B')])]);
    expect(ids(r)).toEqual([['b']]);
    expect(r?.stat).toBe('2');
  });
});

describe('Partnership templates', () => {
  it('Iron Partners is the pair with the most games together (at least 2)', () => {
    const games = [game(['a', 'b'], ['c', 'd'], 'A'), game(['a', 'b'], ['c', 'd'], 'B'), game(['a', 'b'], ['e', 'f'], 'A')];
    const r = run('iron_partner', games);
    expect(ids(r)).toEqual([['a', 'b']]);
    expect(noms(r)).toEqual([['a', 'b'], ['c', 'd']]);
    expect(r?.stat).toBe('3');
    expect(run('iron_partner', [game(['a'], ['b'], 'A')])).toBeNull();
  });

  it('Lucky Charm measures how much more often partners win with the player than without', () => {
    // Without Ana (games she is not in at all): Ben 0 of 2, Cy 1 of 2, Dee 1 of 2. With her, they won all 3.
    const games = [
      game(['a', 'b'], ['c', 'd'], 'A'),
      game(['a', 'c'], ['b', 'd'], 'A'),
      game(['a', 'd'], ['b', 'c'], 'A'),
      game(['b', 'c'], ['d', 'e'], 'B'),
      game(['b', 'd'], ['c', 'e'], 'B'),
    ];
    const r = run('lucky_charm', games);
    expect(ids(r)).toEqual([['a']]);
    expect(r?.stat).toBe('+67');
    expect(r?.explanation).toBe('Partners won 100% of games with them, against 33% without them.');
    expect(run('lucky_charm', games, { minGames: 4 })).toBeNull();
  });

  it('The Mixer needs the minimum number of different opponents', () => {
    const games = [game(['a'], ['b'], 'A'), game(['a'], ['c'], 'A'), game(['a'], ['d'], 'A'), game(['a'], ['e'], 'B')];
    expect(ids(run('mixer', games))).toEqual([['a']]);
    expect(run('mixer', games, { minOpponents: 5 })).toBeNull();
  });
});

describe('Grit & Drama templates', () => {
  it('Comeback Kid needs the deficit from the rally log; partners share the comeback', () => {
    const singles = run('comeback_kid', [rallyGame(['a'], ['b'], SINGLES_COMEBACK)]);
    expect(ids(singles)).toEqual([['a']]);
    expect(singles?.stat).toBe('5');
    expect(run('comeback_kid', [rallyGame(['a'], ['b'], SINGLES_COMEBACK)], { minDeficit: 6 })).toBeNull();
    expect(ids(run('comeback_kid', [rallyGame(['a', 'b'], ['c', 'd'], DOUBLES_COMEBACK)]))).toEqual([['a', 'b']]);
    expect(run('comeback_kid', [game(['a'], ['b'], 'A', [11, 5])])).toBeNull();
  });

  it('On a Roll is the longest run of unanswered points, credited to the team', () => {
    const r = run('run_maker', [rallyGame(['a'], ['b'], times(11, 'A')), rallyGame(['c'], ['d'], SINGLES_COMEBACK)]);
    // Both made an 11-0 run; the D9 standing breaks the tie (Ana won 11-0, Cy 11-5).
    expect(ids(r)).toEqual([['a']]);
    expect(noms(r)).toEqual([['a'], ['c'], ['d']]); // Dee's 5-0 run is the runner-up
    expect(r?.stat).toBe('11-0');
    expect(ids(run('run_maker', [rallyGame(['a', 'b'], ['c', 'd'], DOUBLES_COMEBACK)]))).toEqual([['a', 'b']]);
  });

  it('The Closer served the winning point; equal records share the award by name', () => {
    const r = run('the_closer', [rallyGame(['a'], ['b'], times(11, 'A')), rallyGame(['a'], ['b'], ['B', ...times(11, 'B')])]);
    expect(ids(r)).toEqual([['a'], ['b']]);
  });

  it('Nail-Biter counts close scored games, won or lost, never 0-0 results', () => {
    const games = [
      game(['a'], ['b'], 'A', [11, 9]),
      game(['a'], ['b'], 'B', [9, 11]),
      game(['a'], ['c'], 'A', [12, 10]),
      game(['c'], ['d'], 'A', [11, 3]),
      game(['a'], ['d'], 'A', [0, 0]),
    ];
    const r = run('nail_biter', games);
    expect(ids(r)).toEqual([['a']]);
    expect(r?.stat).toBe('3');
    expect(noms(r)).toEqual([['a'], ['b'], ['c']]);
  });

  it('Marathon Match goes to all four players of the longest game: rallies first, otherwise time', () => {
    const byRallies = run('marathon_match', [rallyGame(['a'], ['c'], times(11, 'A')), rallyGame(['a', 'b'], ['c', 'd'], DOUBLES_COMEBACK)]);
    expect(ids(byRallies)).toEqual([['a', 'b', 'c', 'd']]);
    expect(byRallies?.stat).toBe('19');
    const timed = [
      game(['a'], ['b'], 'A', [11, 5], { startedAt: at(0), endedAt: at(10) }),
      game(['c', 'd'], ['e', 'f'], 'B', [9, 11], { startedAt: at(10), endedAt: at(35) }),
      game(['g'], ['h'], 'A', [11, 2], { startedAt: '2026-10-21T18:40:00.000Z', endedAt: '2026-10-21T18:40:30.000Z' }),
    ];
    const r = run('marathon_match', timed);
    expect(ids(r)).toEqual([['c', 'd', 'e', 'f']]);
    expect(r?.stat).toBe('25 min');
    expect(run('marathon_match', timed.slice(0, 1))).toBeNull();
  });
});

describe('Fun and Community templates', () => {
  it('Rally Rhythm adds up rallies across logged games', () => {
    const r = run('rally_rhythm', [rallyGame(['a'], ['c'], times(11, 'A')), rallyGame(['a'], ['b'], SINGLES_COMEBACK)]);
    expect(ids(r)).toEqual([['a']]);
    expect(r?.stat).toBe('29');
  });

  it('Speed Demon is the quickest win of at least a minute, credited to the winning side', () => {
    const timed = [
      game(['a', 'b'], ['c', 'd'], 'A', [11, 5], { startedAt: at(0), endedAt: at(10) }),
      game(['e', 'f'], ['g', 'h'], 'B', [9, 11], { startedAt: at(10), endedAt: at(35) }),
    ];
    const r = run('speed_demon', timed);
    expect(ids(r)).toEqual([['a', 'b']]);
    expect(r?.stat).toBe('10 min');
    expect(run('speed_demon', timed.slice(1))).toBeNull();
  });

  it('Last One Standing is everyone in the final game; session awards only', () => {
    const games = [game(['a'], ['b'], 'A'), game(['c'], ['d'], 'B')];
    expect(ids(run('last_one_standing', games))).toEqual([['c'], ['d']]);
    expect(run('last_one_standing', games, undefined, { scope: 'historical' })).toBeNull();
  });

  it('Early Bird is the first check-in; it needs check-in times and the session scope', () => {
    const games = [game(['a'], ['b'], 'A')];
    const checkIns = [
      { playerId: 'a', checkedInAt: at(5) },
      { playerId: 'b', checkedInAt: at(0) },
      { playerId: 'c', checkedInAt: null },
    ];
    const r = run('early_bird', games, undefined, { checkIns });
    expect(ids(r)).toEqual([['b']]);
    expect(r?.explanation).toBe('Checked in first, 5 minutes before the next player.');
    expect(noms(r)).toEqual([['b'], ['a']]);
    expect(run('early_bird', games)).toBeNull();
    expect(run('early_bird', games, undefined, { checkIns, scope: 'historical' })).toBeNull();
  });
});

describe('availability, library and recommendations', () => {
  const night = [
    game(['a'], ['b'], 'A', [11, 0]),
    rallyGame(['a'], ['c'], SINGLES_COMEBACK),
    game(['b'], ['c'], 'B', [9, 11]),
    game(['a'], ['d'], 'A', [11, 9]),
  ];

  it('explains missing data instead of guessing', () => {
    const plain = ctx([game(['a'], ['b'], 'A')]);
    expect(unavailableReason(templateById('serve_machine')!, plain)).toMatch(/rally-by-rally/);
    expect(unavailableReason(templateById('early_bird')!, plain)).toMatch(/check-in/);
    expect(unavailableReason(templateById('last_one_standing')!, ctx([], { scope: 'historical' }))).toBe('Session awards only.');
    expect(unavailableReason(templateById('marathon_match')!, plain)).toMatch(/rally-by-rally.*or games that ran/);
    expect(unavailableReason(templateById('serve_machine')!, ctx(night))).toBeNull();
  });

  it('describes every template with a live preview for computed ones', () => {
    const lib = describeLibrary(ctx(night));
    expect(lib).toHaveLength(AWARD_TEMPLATES.length);
    const shutout = lib.find((e) => e.id === 'shutout_king');
    expect(shutout?.preview).toMatchObject({ winners: 'Ana', stat: '1' });
    const manual = lib.find((e) => e.id === 'best_sportsmanship');
    expect(manual).toMatchObject({ kind: 'manual', unavailable: null, preview: null });
    expect(lib.find((e) => e.id === 'early_bird')?.unavailable).toMatch(/check-in/);
  });

  it('recommends what this data makes interesting, best first, and skips the lineup', () => {
    const c = ctx(night, { firstTimers: ['d', 'c'] });
    const recs = recommendTemplates(c, new Set(), 30);
    const idsOf = recs.map((r) => r.templateId);
    expect(idsOf).toContain('shutout_king');
    expect(idsOf).toContain('comeback_kid');
    expect(idsOf).toContain('serve_machine');
    expect(idsOf).toContain('newcomer');
    expect(idsOf).not.toContain('host_pick');
    expect(idsOf).not.toContain('early_bird'); // no check-ins: no winner
    expect(recs.find((r) => r.templateId === 'shutout_king')?.reason).toBe('There was an 11-0 shutout this session');
    expect(recs.find((r) => r.templateId === 'newcomer')?.reason).toBe('2 first-timers tonight');
    for (let i = 1; i < recs.length; i++) expect((recs[i - 1] as { score: number }).score).toBeGreaterThanOrEqual((recs[i] as { score: number }).score);
    expect(recommendTemplates(c, new Set(['shutout_king']), 30).map((r) => r.templateId)).not.toContain('shutout_king');
    expect(recommendTemplates(c, new Set(), 3)).toHaveLength(3);
    expect(recommendTemplates(ctx([game(['a'], ['b'], 'A')]), new Set(), 30).map((r) => r.templateId)).not.toContain('newcomer');
  });
});

describe('nominees of the built-in awards', () => {
  it('lists the winners first, then runners-up, at least three units', () => {
    const games = [
      game(['a'], ['b'], 'A'), game(['a'], ['c'], 'A'), game(['a'], ['d'], 'A'),
      game(['b'], ['c'], 'A'), game(['b'], ['d'], 'A'), game(['c'], ['d'], 'A'),
    ];
    const r = computeAwards({ scope: 'session', games, names: NAMES });
    const champ = r.awards.find((x) => x.id === 'champion');
    expect(champ?.nominees.map((g) => g.map((w) => w.playerId))).toEqual([['a'], ['b'], ['c']]);
    const most = r.awards.find((x) => x.id === 'most_wins');
    expect(most?.nominees.map((g) => g.map((w) => w.playerId))).toEqual([['a'], ['b'], ['c']]);
    for (const award of r.awards) expect(award.nominees.slice(0, award.groups.length)).toEqual(award.groups);
  });
});
