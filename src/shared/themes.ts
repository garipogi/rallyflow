/**
 * Colour themes and light/dark modes, shared by the organizer window, the display window and the
 * main process (which persists the choice and colours native window backgrounds).
 *
 * Pure data and pure helpers only: no DOM access unless a function is handed an element.
 * tests/extras/themes.test.ts checks every token pair below against WCAG AA contrast.
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedMode = 'light' | 'dark';

export const THEME_IDS = ['court', 'ocean', 'sunset', 'grape', 'citrus', 'graphite', 'rose', 'neon', 'contrast'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

/** The organizer's appearance choice, stored in the main process and mirrored to the display. */
export interface Appearance {
  mode: ThemeMode;
  theme: ThemeId;
}

export const DEFAULT_APPEARANCE: Appearance = { mode: 'system', theme: 'court' };

/** Design tokens. Every value is a #rrggbb colour so contrast can be computed. */
export interface ThemeTokens {
  /** Page background. */
  bg: string;
  /** Cards and panels. */
  surface: string;
  /** Subtle raised or inset areas (table stripes, court board). */
  surface2: string;
  /** Hairline borders. */
  border: string;
  /** Borders of inputs and controls (non-text contrast 3:1). */
  borderStrong: string;
  text: string;
  muted: string;
  accent: string;
  /** Text and icons placed on the accent colour. */
  accentContrast: string;
  /** Tinted background for chips and highlights; body text sits on it. */
  accentSoft: string;
  success: string;
  warn: string;
  danger: string;
  dangerContrast: string;
  /** Serving indicator ring and pulse. */
  serve: string;
  /** Background of the serving team's score box. */
  serveSoft: string;
  teamA: string;
  teamB: string;
  /** Court surface used for decorative court art. */
  court: string;
  courtLine: string;
  focus: string;
  /** App header bar. */
  headerBg: string;
  headerText: string;
  /** Deep celebratory stage behind the awards podium (always carries white text). */
  stage: string;
  /** Shadow tint (used with alpha in CSS). */
  shadow: string;
}

export interface ThemeDef {
  id: ThemeId;
  name: string;
  description: string;
  light: ThemeTokens;
  dark: ThemeTokens;
}

export const THEMES: readonly ThemeDef[] = [
  {
    id: 'court',
    name: 'Court Green',
    description: 'The classic outdoor court',
    light: {
      bg: '#eef4f0', surface: '#ffffff', surface2: '#e3eee7', border: '#c9d8cf', borderStrong: '#6b8577',
      text: '#12241a', muted: '#475a4f', accent: '#1f6b47', accentContrast: '#ffffff', accentSoft: '#d9eee2',
      success: '#1b6a3a', warn: '#855600', danger: '#a32121', dangerContrast: '#ffffff',
      serve: '#a87800', serveSoft: '#fff3c7', teamA: '#1d5fae', teamB: '#b0441a',
      court: '#2f7d57', courtLine: '#ffffff', focus: '#0b57d0', headerBg: '#14402c', headerText: '#ffffff', stage: '#143626', shadow: '#0f2a1d',
    },
    dark: {
      bg: '#0a130f', surface: '#13211a', surface2: '#192b22', border: '#2a4638', borderStrong: '#6f8f7f',
      text: '#eef5f0', muted: '#a8bdb1', accent: '#5fd39b', accentContrast: '#04210f', accentSoft: '#1c3a2b',
      success: '#6fdc9a', warn: '#ffd54a', danger: '#ff8a80', dangerContrast: '#2a0505',
      serve: '#ffd54a', serveSoft: '#2c2a12', teamA: '#7cb8ff', teamB: '#ffab7a',
      court: '#1b4a34', courtLine: '#d9efe3', focus: '#8ab4ff', headerBg: '#0f1d16', headerText: '#eef5f0', stage: '#10291d', shadow: '#000000',
    },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'Cool blues, calm and crisp',
    light: {
      bg: '#edf4f9', surface: '#ffffff', surface2: '#e1edf5', border: '#c5d7e4', borderStrong: '#5f7d93',
      text: '#0e2233', muted: '#465b6c', accent: '#0b5f8a', accentContrast: '#ffffff', accentSoft: '#d6eaf6',
      success: '#17683f', warn: '#835400', danger: '#a32121', dangerContrast: '#ffffff',
      serve: '#a87800', serveSoft: '#fff3c7', teamA: '#1546a0', teamB: '#ad3f17',
      court: '#1f6f9a', courtLine: '#ffffff', focus: '#7a2bd9', headerBg: '#0c3550', headerText: '#ffffff', stage: '#0c2c44', shadow: '#0b2233',
    },
    dark: {
      bg: '#08111a', surface: '#0f1c29', surface2: '#152636', border: '#25405a', borderStrong: '#6a8aa6',
      text: '#ecf4fa', muted: '#a3b8c9', accent: '#4fc3f7', accentContrast: '#03202f', accentSoft: '#163852',
      success: '#6fdc9a', warn: '#ffd54a', danger: '#ff8a80', dangerContrast: '#2a0505',
      serve: '#ffd54a', serveSoft: '#2b2913', teamA: '#8cc8ff', teamB: '#ffb27f',
      court: '#14476a', courtLine: '#d6ebf8', focus: '#ffd54a', headerBg: '#0a1824', headerText: '#ecf4fa', stage: '#0b2335', shadow: '#000000',
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Warm oranges for evening play',
    light: {
      bg: '#fbf2ec', surface: '#ffffff', surface2: '#f6e6dc', border: '#e6cdbf', borderStrong: '#8d6a59',
      text: '#2a150c', muted: '#62483c', accent: '#b03f0e', accentContrast: '#ffffff', accentSoft: '#fbe0d2',
      success: '#1b6a3a', warn: '#7d5000', danger: '#a11a3a', dangerContrast: '#ffffff',
      serve: '#a87800', serveSoft: '#fff1c4', teamA: '#5b2fa6', teamB: '#a8370c',
      court: '#c4562a', courtLine: '#ffffff', focus: '#1d4fd8', headerBg: '#5a1f0b', headerText: '#ffffff', stage: '#4a1a0b', shadow: '#3a1406',
    },
    dark: {
      bg: '#170d09', surface: '#24150f', surface2: '#2e1c14', border: '#4d3124', borderStrong: '#9c7563',
      text: '#fbefe8', muted: '#d0b3a5', accent: '#ff9e5e', accentContrast: '#2a1003', accentSoft: '#45251a',
      success: '#7fe0a5', warn: '#ffd54a', danger: '#ff8fa6', dangerContrast: '#2a0510',
      serve: '#ffd54a', serveSoft: '#33290f', teamA: '#c4a6ff', teamB: '#ffb07a',
      court: '#6a2e16', courtLine: '#ffe2d2', focus: '#8ab4ff', headerBg: '#1f110b', headerText: '#fbefe8', stage: '#3a170a', shadow: '#000000',
    },
  },
  {
    id: 'grape',
    name: 'Grape',
    description: 'Rich purples with a pop',
    light: {
      bg: '#f4f0fa', surface: '#ffffff', surface2: '#ebe3f6', border: '#d6c9e8', borderStrong: '#776791',
      text: '#1d1230', muted: '#54476a', accent: '#6a2fb0', accentContrast: '#ffffff', accentSoft: '#e9dcf8',
      success: '#1b6a3a', warn: '#7d5000', danger: '#a32121', dangerContrast: '#ffffff',
      serve: '#a87800', serveSoft: '#fff3c7', teamA: '#1d5fae', teamB: '#a8370c',
      court: '#6b3fae', courtLine: '#ffffff', focus: '#c2185b', headerBg: '#33145c', headerText: '#ffffff', stage: '#2b1250', shadow: '#1d0b36',
    },
    dark: {
      bg: '#0f0a18', surface: '#1a1228', surface2: '#221834', border: '#3c2d57', borderStrong: '#8a7aa8',
      text: '#f3eefb', muted: '#bcadd3', accent: '#c39bff', accentContrast: '#1d0938', accentSoft: '#33224f',
      success: '#7fe0a5', warn: '#ffd54a', danger: '#ff8a80', dangerContrast: '#2a0505',
      serve: '#ffd54a', serveSoft: '#2e2814', teamA: '#8cc8ff', teamB: '#ffb07a',
      court: '#3d2468', courtLine: '#e7dcfa', focus: '#ffd54a', headerBg: '#150e22', headerText: '#f3eefb', stage: '#241044', shadow: '#000000',
    },
  },
  {
    id: 'citrus',
    name: 'Citrus',
    description: 'Fresh lime, bright and zesty',
    light: {
      bg: '#f5f8e9', surface: '#ffffff', surface2: '#ecf1d6', border: '#d4ddb3', borderStrong: '#73804d',
      text: '#1b2208', muted: '#4f5935', accent: '#4a6800', accentContrast: '#ffffff', accentSoft: '#e5f0c2',
      success: '#1b6a3a', warn: '#7d5000', danger: '#a32121', dangerContrast: '#ffffff',
      serve: '#a06c00', serveSoft: '#fff0bf', teamA: '#1d55a8', teamB: '#a8370c',
      court: '#6a8f12', courtLine: '#ffffff', focus: '#1d4fd8', headerBg: '#2e4000', headerText: '#ffffff', stage: '#243300', shadow: '#1b2208',
    },
    dark: {
      bg: '#0e1106', surface: '#181d0b', surface2: '#202711', border: '#38441d', borderStrong: '#8a9a5e',
      text: '#f4f8e6', muted: '#bac59a', accent: '#d4f04a', accentContrast: '#1d2600', accentSoft: '#2e3a12',
      success: '#7fe0a5', warn: '#ffcf70', danger: '#ff8a80', dangerContrast: '#2a0505',
      serve: '#ffcf4a', serveSoft: '#2f2a10', teamA: '#8cc8ff', teamB: '#ffa97a',
      court: '#3d5210', courtLine: '#eef7cf', focus: '#8ab4ff', headerBg: '#13170a', headerText: '#f4f8e6', stage: '#1f2a05', shadow: '#000000',
    },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Quiet slate greys, no fuss',
    light: {
      bg: '#f1f3f6', surface: '#ffffff', surface2: '#e7eaef', border: '#cfd5de', borderStrong: '#6b7686',
      text: '#111827', muted: '#4b5563', accent: '#334155', accentContrast: '#ffffff', accentSoft: '#e2e8f0',
      success: '#166534', warn: '#7d5000', danger: '#a32121', dangerContrast: '#ffffff',
      serve: '#a16207', serveSoft: '#fef3c7', teamA: '#1d4ed8', teamB: '#b43c12',
      court: '#475569', courtLine: '#ffffff', focus: '#2563eb', headerBg: '#1e293b', headerText: '#ffffff', stage: '#1e293b', shadow: '#0f172a',
    },
    dark: {
      bg: '#0b0e13', surface: '#151a22', surface2: '#1c222c', border: '#323b48', borderStrong: '#7b8696',
      text: '#f1f5f9', muted: '#b0bac7', accent: '#cbd5e1', accentContrast: '#0f172a', accentSoft: '#273140',
      success: '#86efac', warn: '#fcd34d', danger: '#fca5a5', dangerContrast: '#2a0505',
      serve: '#fcd34d', serveSoft: '#2d2a17', teamA: '#93c5fd', teamB: '#fdba74',
      court: '#334155', courtLine: '#e2e8f0', focus: '#60a5fa', headerBg: '#10141a', headerText: '#f1f5f9', stage: '#1a2230', shadow: '#000000',
    },
  },
  {
    id: 'rose',
    name: 'Rose',
    description: 'Soft pinks with bold accents',
    light: {
      bg: '#fbf0f4', surface: '#ffffff', surface2: '#f6e3ea', border: '#e8cbd6', borderStrong: '#8e6474',
      text: '#2b0f19', muted: '#64414f', accent: '#ad1650', accentContrast: '#ffffff', accentSoft: '#fadbe6',
      success: '#1b6a3a', warn: '#7d5000', danger: '#9b1c1c', dangerContrast: '#ffffff',
      serve: '#a87800', serveSoft: '#fff3c7', teamA: '#1d55a8', teamB: '#a8370c',
      court: '#b53a68', courtLine: '#ffffff', focus: '#1d4fd8', headerBg: '#561029', headerText: '#ffffff', stage: '#4a0e24', shadow: '#33091a',
    },
    dark: {
      bg: '#170a0f', surface: '#241219', surface2: '#2e1820', border: '#4d2c39', borderStrong: '#a07484',
      text: '#fcf0f4', muted: '#d4b0bd', accent: '#ff8fb5', accentContrast: '#3a0418', accentSoft: '#47202e',
      success: '#7fe0a5', warn: '#ffd54a', danger: '#ffab91', dangerContrast: '#2a0a05',
      serve: '#ffd54a', serveSoft: '#332a12', teamA: '#8cc8ff', teamB: '#ffc07a',
      court: '#5e1f37', courtLine: '#ffe0eb', focus: '#8ab4ff', headerBg: '#1f0d14', headerText: '#fcf0f4', stage: '#3d0c20', shadow: '#000000',
    },
  },
  {
    id: 'neon',
    name: 'Midnight Neon',
    description: 'Electric glow for night sessions',
    light: {
      bg: '#f3f2fd', surface: '#ffffff', surface2: '#e8e6fa', border: '#cfcbef', borderStrong: '#6c66a3',
      text: '#14112e', muted: '#4c4775', accent: '#4b23c8', accentContrast: '#ffffff', accentSoft: '#e2dcfb',
      success: '#0f6b55', warn: '#7d5000', danger: '#a3123f', dangerContrast: '#ffffff',
      serve: '#0b7a6c', serveSoft: '#d6f7f1', teamA: '#a1127e', teamB: '#0b6a8a',
      court: '#2e1f8f', courtLine: '#7ff5e2', focus: '#d4127e', headerBg: '#120c3a', headerText: '#ffffff', stage: '#120c3a', shadow: '#120c3a',
    },
    dark: {
      bg: '#06051a', surface: '#100e2a', surface2: '#171438', border: '#2e2a62', borderStrong: '#7a74c4',
      text: '#f2f0ff', muted: '#b9b4e6', accent: '#22e6c8', accentContrast: '#021b17', accentSoft: '#1b2652',
      success: '#5ff0b0', warn: '#ffe14f', danger: '#ff7aa8', dangerContrast: '#2a0514',
      serve: '#22e6c8', serveSoft: '#0e2c3a', teamA: '#ff7ae1', teamB: '#ffe14f',
      court: '#1c1660', courtLine: '#22e6c8', focus: '#ffe14f', headerBg: '#0a0822', headerText: '#f2f0ff', stage: '#150f45', shadow: '#000000',
    },
  },
  {
    id: 'contrast',
    name: 'High Contrast',
    description: 'Maximum legibility, bright sun or low vision',
    light: {
      bg: '#ffffff', surface: '#ffffff', surface2: '#f2f2f2', border: '#000000', borderStrong: '#000000',
      text: '#000000', muted: '#1f1f1f', accent: '#0033a0', accentContrast: '#ffffff', accentSoft: '#e6ecff',
      success: '#005a1e', warn: '#5c3b00', danger: '#a00000', dangerContrast: '#ffffff',
      serve: '#000000', serveSoft: '#fff2a8', teamA: '#0033a0', teamB: '#8a1500',
      court: '#00502a', courtLine: '#ffffff', focus: '#c00000', headerBg: '#000000', headerText: '#ffffff', stage: '#000000', shadow: '#000000',
    },
    dark: {
      bg: '#000000', surface: '#000000', surface2: '#141414', border: '#ffffff', borderStrong: '#ffffff',
      text: '#ffffff', muted: '#f0f0f0', accent: '#ffd400', accentContrast: '#000000', accentSoft: '#2e2700',
      success: '#7dff9b', warn: '#ffd400', danger: '#ff8080', dangerContrast: '#000000',
      serve: '#ffd400', serveSoft: '#262000', teamA: '#6fd3ff', teamB: '#ffb000',
      court: '#003d20', courtLine: '#ffffff', focus: '#00e5ff', headerBg: '#000000', headerText: '#ffffff', stage: '#000000', shadow: '#000000',
    },
  },
];

const BY_ID = new Map<string, ThemeDef>(THEMES.map((t) => [t.id, t]));

export function getTheme(id: ThemeId): ThemeDef {
  return BY_ID.get(id) ?? (THEMES[0] as ThemeDef);
}

export const isThemeId = (value: unknown): value is ThemeId => typeof value === 'string' && BY_ID.has(value);
export const isThemeMode = (value: unknown): value is ThemeMode =>
  value === 'light' || value === 'dark' || value === 'system';

/** Accepts anything (IPC input, stored JSON, query string) and returns a valid appearance. */
export function normalizeAppearance(value: unknown): Appearance {
  const v = (value ?? {}) as { mode?: unknown; theme?: unknown };
  return {
    mode: isThemeMode(v.mode) ? v.mode : DEFAULT_APPEARANCE.mode,
    theme: isThemeId(v.theme) ? v.theme : DEFAULT_APPEARANCE.theme,
  };
}

export function resolveMode(mode: ThemeMode, systemPrefersDark: boolean): ResolvedMode {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
}

export function tokensFor(appearance: Appearance, systemPrefersDark: boolean): ThemeTokens {
  const theme = getTheme(appearance.theme);
  return resolveMode(appearance.mode, systemPrefersDark) === 'dark' ? theme.dark : theme.light;
}

const kebab = (key: string): string => key.replace(/[A-Z0-9]+/g, (m) => `-${m.toLowerCase()}`);

/** CSS custom properties for a token set, e.g. { '--accent-contrast': '#fff', ... }. */
export function cssVariables(tokens: ThemeTokens): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) out[`--${kebab(key)}`] = value;
  return out;
}

/** Minimal element surface so the helper is testable without a DOM. */
export interface ThemeTarget {
  style: { setProperty(name: string, value: string): void };
  setAttribute(name: string, value: string): void;
}

/** Applies the appearance to an element (normally <html>): tokens, data attributes and color-scheme. */
export function applyAppearance(target: ThemeTarget, appearance: Appearance, systemPrefersDark: boolean): ResolvedMode {
  const mode = resolveMode(appearance.mode, systemPrefersDark);
  const tokens = tokensFor(appearance, systemPrefersDark);
  for (const [name, value] of Object.entries(cssVariables(tokens))) target.style.setProperty(name, value);
  target.style.setProperty('color-scheme', mode);
  target.setAttribute('data-theme', appearance.theme);
  target.setAttribute('data-mode', mode);
  return mode;
}

// ---------------------------------------------------------------------- WCAG contrast

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const n = Number.parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Token pairs that carry text or controls, with the WCAG AA minimum each must meet. */
export const CONTRAST_PAIRS: ReadonlyArray<{ fg: keyof ThemeTokens; bg: keyof ThemeTokens; min: number; what: string }> = [
  { fg: 'text', bg: 'surface', min: 4.5, what: 'body text on cards' },
  { fg: 'text', bg: 'bg', min: 4.5, what: 'body text on the page' },
  { fg: 'text', bg: 'surface2', min: 4.5, what: 'body text on raised areas' },
  { fg: 'text', bg: 'accentSoft', min: 4.5, what: 'text on tinted chips' },
  { fg: 'muted', bg: 'surface', min: 4.5, what: 'secondary text on cards' },
  { fg: 'muted', bg: 'bg', min: 4.5, what: 'secondary text on the page' },
  { fg: 'muted', bg: 'surface2', min: 4.5, what: 'secondary text on raised areas' },
  { fg: 'accentContrast', bg: 'accent', min: 4.5, what: 'primary button label' },
  { fg: 'accent', bg: 'surface', min: 4.5, what: 'secondary button label and links' },
  { fg: 'accent', bg: 'bg', min: 3, what: 'accent icons on the page' },
  { fg: 'dangerContrast', bg: 'danger', min: 4.5, what: 'danger button label' },
  { fg: 'danger', bg: 'surface', min: 4.5, what: 'error messages' },
  { fg: 'success', bg: 'surface', min: 4.5, what: 'success text' },
  { fg: 'warn', bg: 'surface', min: 4.5, what: 'warning text' },
  { fg: 'teamA', bg: 'surface', min: 4.5, what: 'Team A labels' },
  { fg: 'teamB', bg: 'surface', min: 4.5, what: 'Team B labels' },
  { fg: 'text', bg: 'serveSoft', min: 4.5, what: 'text in the serving box' },
  { fg: 'text', bg: 'surface', min: 3, what: 'large score digits' },
  { fg: 'headerText', bg: 'headerBg', min: 4.5, what: 'header text' },
  { fg: 'serve', bg: 'surface', min: 3, what: 'serving indicator (non-text)' },
  { fg: 'borderStrong', bg: 'surface', min: 3, what: 'control borders (non-text)' },
  { fg: 'focus', bg: 'surface', min: 3, what: 'focus ring on cards' },
  { fg: 'focus', bg: 'bg', min: 3, what: 'focus ring on the page' },
];

/** Stage backgrounds always carry white text and the gold award colour. */
export const STAGE_TEXT = '#ffffff';

// ---------------------------------------------------------------------- player avatars

/** Saturation / lightness of avatar chips; with AVATAR_TEXT they pass AA for every hue. */
export const AVATAR_SATURATION = 70;
export const AVATAR_LIGHTNESS = 80;
export const AVATAR_TEXT = '#111111';

export function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}
