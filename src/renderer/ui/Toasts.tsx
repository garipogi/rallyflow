import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type ToastTone = 'success' | 'info' | 'celebrate';

/** A button on the toast (for example Undo). Pressing it runs the action and dismisses the toast. */
export interface ToastAction {
  label: string;
  /** Accessible name when the label alone is too short ("Undo result on Court 1"). */
  ariaLabel?: string;
  run: () => void;
}

interface Toast {
  id: number;
  tone: ToastTone;
  icon: string;
  text: string;
  action?: ToastAction;
  lifetime: number;
}

export interface NotifyOptions {
  tone?: ToastTone;
  icon?: string;
  action?: ToastAction;
  /** How long the toast stays, in ms (default 3.8 s; toasts with an action usually stay longer). */
  durationMs?: number;
}

type Notify = (text: string, opts?: NotifyOptions) => void;

const ToastContext = createContext<Notify>(() => undefined);

export const useToast = (): Notify => useContext(ToastContext);

const LIFETIME_MS = 3800;
const MAX_TOASTS = 4;

/**
 * Short, auto-dismissing confirmations ("Game started on Court 1"). The region is a polite live
 * status region, so screen readers announce each toast without moving focus.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle !== undefined) window.clearTimeout(handle);
    timers.current.delete(id);
  }, []);

  const notify = useCallback<Notify>(
    (text, opts) => {
      const id = next.current;
      next.current += 1;
      const tone = opts?.tone ?? 'success';
      const icon = opts?.icon ?? (tone === 'celebrate' ? '🎉' : tone === 'info' ? 'ℹ️' : '✓');
      const lifetime = opts?.durationMs ?? LIFETIME_MS;
      const toast: Toast = { id, tone, icon, text, lifetime, ...(opts?.action ? { action: opts.action } : {}) };
      setToasts((list) => [...list, toast].slice(-MAX_TOASTS));
      timers.current.set(id, window.setTimeout(() => dismiss(id), lifetime));
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const handle of pending.values()) window.clearTimeout(handle);
    };
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.tone}${t.action ? ' toast-has-action' : ''}`}
            style={t.lifetime !== LIFETIME_MS ? { ['--toast-out-delay' as string]: `${Math.max(0, t.lifetime - 400)}ms` } : undefined}
          >
            <span className="toast-icon" aria-hidden="true">
              {t.icon}
            </span>
            <span className="toast-text">{t.text}</span>
            {t.action ? (
              <button
                className="toast-action"
                aria-label={t.action.ariaLabel ?? t.action.label}
                onClick={() => {
                  const action = t.action;
                  dismiss(t.id);
                  action?.run();
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button className="toast-close" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
