import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  THEMES,
  cssVariables,
  resolveMode,
  type Appearance,
  type ThemeDef,
  type ThemeMode,
} from '../shared/themes';
import { applyThemeToPage, systemPrefersDark, watchSystemMode } from './theme/appearance';

const MODE_LABEL: Record<ThemeMode, { label: string; icon: string }> = {
  light: { label: 'Light', icon: '☀️' },
  dark: { label: 'Dark', icon: '🌙' },
  system: { label: 'System', icon: '💻' },
};

/**
 * Loads the saved appearance, applies it, and saves changes in the main process (which also moves
 * the display window and native dialogs to the same theme).
 */
export function useAppearance(initial: Appearance) {
  const [appearance, setLocal] = useState<Appearance>(initial);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const current = useRef(appearance);
  current.current = appearance;

  useEffect(() => {
    let alive = true;
    void window.openPlay.getAppearance().then((res) => {
      if (alive && res.ok) {
        setLocal(res.value);
        applyThemeToPage(res.value);
      }
    });
    const stop = watchSystemMode(
      () => current.current,
      () => setSystemDark(systemPrefersDark()),
    );
    return () => {
      alive = false;
      stop();
    };
  }, []);

  const change = useCallback(async (next: Appearance) => {
    setLocal(next);
    applyThemeToPage(next); // instant, before the round trip
    const res = await window.openPlay.setAppearance(next);
    if (res.ok) {
      // The main process may have changed nativeTheme; re-resolve "system" against it.
      applyThemeToPage(res.value);
      setSystemDark(systemPrefersDark());
    }
  }, []);

  return { appearance, change, systemDark };
}

function ThemePreview({ theme, dark }: { theme: ThemeDef; dark: boolean }) {
  const vars = cssVariables(dark ? theme.dark : theme.light) as CSSProperties;
  return (
    <span className="theme-preview" style={vars} aria-hidden="true">
      <span className="tp-header">
        <span className="tp-dot" />
        <span className="tp-bar" />
      </span>
      <span className="tp-body">
        <span className="tp-card">
          <span className="tp-score tp-a">7</span>
          <span className="tp-score tp-b">4</span>
        </span>
        <span className="tp-button" />
      </span>
    </span>
  );
}

/** Header control: a palette button that opens the mode switch and the colour theme swatches. */
export function AppearancePicker({ appearance, systemDark, onChange }: { appearance: Appearance; systemDark: boolean; onChange: (a: Appearance) => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const dark = resolveMode(appearance.mode, systemDark) === 'dark';

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    panel.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, close]);

  const current = THEMES.find((t) => t.id === appearance.theme) ?? THEMES[0];

  return (
    <div className="appearance">
      <button
        ref={button}
        className="appearance-toggle"
        aria-expanded={open}
        aria-controls="appearance-panel"
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="appearance-icon" aria-hidden="true">
          🎨
        </span>
        Appearance
      </button>
      {open ? (
        <div ref={panel} id="appearance-panel" className="appearance-panel" role="dialog" aria-label="Appearance settings">
          <div className="ap-head">
            <strong>Appearance</strong>
            <span className="hint">
              {current?.name} · {dark ? 'dark' : 'light'}
            </span>
          </div>
          <fieldset className="ap-modes">
            <legend>Mode</legend>
            <div className="seg-radio">
              {(Object.keys(MODE_LABEL) as ThemeMode[]).map((mode) => (
                <label key={mode} className={appearance.mode === mode ? 'checked' : ''}>
                  <input
                    type="radio"
                    name="appearance-mode"
                    value={mode}
                    checked={appearance.mode === mode}
                    onChange={() => onChange({ ...appearance, mode })}
                  />
                  <span aria-hidden="true">{MODE_LABEL[mode].icon}</span> {MODE_LABEL[mode].label}
                </label>
              ))}
            </div>
            {appearance.mode === 'system' ? <p className="hint ap-note">Follows your computer: {systemDark ? 'dark' : 'light'} right now.</p> : null}
          </fieldset>
          <fieldset className="ap-themes">
            <legend>Colour theme</legend>
            <div className="swatches">
              {THEMES.map((theme) => (
                <label key={theme.id} className={`swatch${appearance.theme === theme.id ? ' checked' : ''}`}>
                  <input
                    type="radio"
                    name="appearance-theme"
                    value={theme.id}
                    checked={appearance.theme === theme.id}
                    onChange={() => onChange({ ...appearance, theme: theme.id })}
                  />
                  <ThemePreview theme={theme} dark={dark} />
                  <span className="swatch-name">{theme.name}</span>
                  <span className="swatch-desc">{theme.description}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="hint ap-note">The display window switches to the same theme within a second.</p>
        </div>
      ) : null}
    </div>
  );
}
