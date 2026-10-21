import { applyAppearance, normalizeAppearance, type Appearance, type ResolvedMode } from '../../shared/themes';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export const systemPrefersDark = (): boolean => window.matchMedia(DARK_QUERY).matches;

/** Applies an appearance to <html>; returns the resolved light/dark mode. */
export function applyThemeToPage(appearance: Appearance): ResolvedMode {
  return applyAppearance(document.documentElement, appearance, systemPrefersDark());
}

/**
 * Runs before React renders: the main process passes the saved theme in the page URL, so the first
 * paint is already in the right colours.
 */
export function bootAppearance(): Appearance {
  const query = new URLSearchParams(window.location.search);
  const appearance = normalizeAppearance({ mode: query.get('mode'), theme: query.get('theme') });
  applyThemeToPage(appearance);
  return appearance;
}

/** Re-applies when the OS (or nativeTheme) flips light/dark; matters for "system" mode. */
export function watchSystemMode(current: () => Appearance, onChange?: (mode: ResolvedMode) => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  const listener = () => {
    const mode = applyThemeToPage(current());
    onChange?.(mode);
  };
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
