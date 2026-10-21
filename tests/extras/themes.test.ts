/*
 * Appearance: every colour theme, in light and dark, keeps WCAG AA contrast for text and controls;
 * the appearance choice is validated, persisted in the settings table and exposed over the API.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AVATAR_LIGHTNESS,
  AVATAR_SATURATION,
  AVATAR_TEXT,
  CONTRAST_PAIRS,
  DEFAULT_APPEARANCE,
  STAGE_TEXT,
  THEMES,
  THEME_IDS,
  applyAppearance,
  contrastRatio,
  cssVariables,
  hslToHex,
  normalizeAppearance,
  resolveMode,
  type ThemeTokens,
} from '../../src/shared/themes';
import { gamePointTeam, initialsOf, playerHue } from '../../src/shared/engage';
import { openDatabase, type Db } from '../../src/data/db';
import { getAppearance, setAppearance } from '../../src/data/appearance';
import { createApiHandlers, type DbStore, type HostServices } from '../../src/main/handlers';
import { API_METHODS } from '../../src/shared/api';

describe('theme catalogue', () => {
  it('offers at least 8 themes, each with a light and a dark variant', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(8);
    expect(THEMES.map((t) => t.id)).toEqual([...THEME_IDS]);
    expect(new Set(THEMES.map((t) => t.name)).size).toBe(THEMES.length);
    for (const t of THEMES) {
      expect(Object.keys(t.light).sort()).toEqual(Object.keys(t.dark).sort());
      for (const value of [...Object.values(t.light), ...Object.values(t.dark)]) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('includes a high-contrast accessibility theme with AAA body text', () => {
    const hc = THEMES.find((t) => t.id === 'contrast');
    expect(hc).toBeDefined();
    for (const tokens of [hc?.light, hc?.dark] as ThemeTokens[]) {
      expect(contrastRatio(tokens.text, tokens.surface)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(tokens.accentContrast, tokens.accent)).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('WCAG AA contrast in every theme and mode', () => {
  for (const theme of THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      it(`${theme.name} (${mode})`, () => {
        const tokens = theme[mode];
        const failures: string[] = [];
        for (const pair of CONTRAST_PAIRS) {
          const ratio = contrastRatio(tokens[pair.fg], tokens[pair.bg]);
          if (ratio < pair.min) failures.push(`${pair.fg} on ${pair.bg} (${pair.what}): ${ratio.toFixed(2)} < ${pair.min}`);
        }
        const stage = contrastRatio(STAGE_TEXT, tokens.stage);
        if (stage < 4.5) failures.push(`white on stage: ${stage.toFixed(2)}`);
        const headerAccent = contrastRatio(tokens.headerText, tokens.headerBg);
        if (headerAccent < 4.5) failures.push(`header: ${headerAccent.toFixed(2)}`);
        expect(failures).toEqual([]);
      });
    }
  }

  it('dark variants are dark and light variants are light', () => {
    for (const t of THEMES) {
      expect(contrastRatio(t.light.bg, '#000000')).toBeGreaterThan(contrastRatio(t.light.bg, '#ffffff'));
      expect(contrastRatio(t.dark.bg, '#ffffff')).toBeGreaterThan(contrastRatio(t.dark.bg, '#000000'));
    }
  });

  it('player avatar chips stay readable for every hue', () => {
    for (let hue = 0; hue < 360; hue += 5) {
      expect(contrastRatio(AVATAR_TEXT, hslToHex(hue, AVATAR_SATURATION, AVATAR_LIGHTNESS))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('computes known ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(hslToHex(0, 100, 50)).toBe('#ff0000');
  });
});

describe('appearance helpers', () => {
  it('normalizes anything into a valid appearance', () => {
    expect(normalizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({ mode: 'dark', theme: 'ocean' })).toEqual({ mode: 'dark', theme: 'ocean' });
    expect(normalizeAppearance({ mode: 'purple', theme: 'nope' })).toEqual(DEFAULT_APPEARANCE);
  });

  it('resolves the system mode from the OS preference', () => {
    expect(resolveMode('system', true)).toBe('dark');
    expect(resolveMode('system', false)).toBe('light');
    expect(resolveMode('light', true)).toBe('light');
  });

  it('applies tokens as CSS variables with data attributes', () => {
    const props = new Map<string, string>();
    const attrs = new Map<string, string>();
    const mode = applyAppearance(
      { style: { setProperty: (k, v) => props.set(k, v) }, setAttribute: (k, v) => attrs.set(k, v) },
      { mode: 'system', theme: 'grape' },
      true,
    );
    expect(mode).toBe('dark');
    expect(attrs.get('data-theme')).toBe('grape');
    expect(attrs.get('data-mode')).toBe('dark');
    expect(props.get('--accent-contrast')).toBe(THEMES.find((t) => t.id === 'grape')?.dark.accentContrast);
    expect(props.get('color-scheme')).toBe('dark');
    expect(Object.keys(cssVariables(THEMES[0]?.light as ThemeTokens))).toContain('--team-a');
  });

  it('initials, stable hues and game point', () => {
    expect(initialsOf('Ana Reyes')).toBe('AR');
    expect(initialsOf('cora')).toBe('CO');
    expect(initialsOf('  ')).toBe('?');
    expect(playerHue('p1')).toBe(playerHue('p1'));
    expect(playerHue('p1')).toBeGreaterThanOrEqual(0);
    expect(playerHue('p1')).toBeLessThan(360);
    const base = { targetScore: 11, winBy: 2, isOver: false };
    expect(gamePointTeam({ ...base, score: { A: 10, B: 3 }, servingTeam: 'A' })).toBe('A');
    expect(gamePointTeam({ ...base, score: { A: 10, B: 3 }, servingTeam: 'B' })).toBeNull();
    expect(gamePointTeam({ ...base, score: { A: 10, B: 10 }, servingTeam: 'B' })).toBeNull();
    expect(gamePointTeam({ ...base, score: { A: 10, B: 11 }, servingTeam: 'B' })).toBe('B');
    expect(gamePointTeam({ ...base, score: { A: 11, B: 3 }, servingTeam: 'A', isOver: true })).toBeNull();
  });
});

describe('appearance persistence', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pbop-theme-'));
    db = openDatabase(join(dir, 'app.db'));
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults, saves and survives reopening the database', () => {
    expect(getAppearance(db)).toEqual(DEFAULT_APPEARANCE);
    expect(setAppearance(db, { mode: 'dark', theme: 'sunset' })).toEqual({ mode: 'dark', theme: 'sunset' });
    db.close();
    db = openDatabase(join(dir, 'app.db'));
    expect(getAppearance(db)).toEqual({ mode: 'dark', theme: 'sunset' });
  });

  it('is exposed over the whitelisted API and tells the host to apply it', async () => {
    expect(API_METHODS).toContain('getAppearance');
    expect(API_METHODS).toContain('setAppearance');
    const applied: unknown[] = [];
    const store: DbStore = { current: () => db, close: () => undefined, open: () => undefined };
    const host: HostServices = {
      appVersion: 'test',
      dbFile: join(dir, 'app.db'),
      autoBackupDir: dir,
      chooseDirectory: async () => null,
      chooseSaveFile: async () => null,
      chooseOpenFile: async () => null,
      confirm: async () => false,
      openDisplay: () => undefined,
      applyAppearance: (a) => applied.push(a),
    };
    const api = createApiHandlers(store, host);
    expect(await api.setAppearance({ mode: 'light', theme: 'neon' })).toEqual({ ok: true, value: { mode: 'light', theme: 'neon' } });
    expect(applied).toEqual([{ mode: 'light', theme: 'neon' }]);
    expect(await api.getAppearance()).toEqual({ ok: true, value: { mode: 'light', theme: 'neon' } });
    expect(await api.setAppearance({ mode: 'loud', theme: 'neon' })).toMatchObject({ ok: false, code: 'validation' });
  });
});
