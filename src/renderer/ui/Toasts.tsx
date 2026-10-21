import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type ToastTone = 'success' | 'info' | 'celebrate';

interface Toast {
  id: number;
  tone: ToastTone;
  icon: string;
  text: string;
}

type Notify = (text: string, opts?: { tone?: ToastTone; icon?: string }) => void;

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
      setToasts((list) => [...list, { id, tone, icon, text }].slice(-MAX_TOASTS));
      timers.current.set(id, window.setTimeout(() => dismiss(id), LIFETIME_MS));
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
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span className="toast-icon" aria-hidden="true">
              {t.icon}
            </span>
            <span className="toast-text">{t.text}</span>
            <button className="toast-close" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
