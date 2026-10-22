import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  /** Title shown in the header and used as the dialog's accessible name. */
  title: ReactNode;
  icon?: string;
  /** Called on Esc, the close button and a click on the backdrop. */
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Extra class for sizing (for example "modal-wide"). */
  className?: string;
  /** Element id of a short description (aria-describedby). */
  describedBy?: string;
  /** Selector of the element to focus first (default: the first focusable element in the footer, else the dialog). */
  initialFocus?: string;
  closeLabel?: string;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog: role="dialog" with aria-modal, labelled by its title, focus moved inside
 * and trapped (Tab / Shift+Tab wrap), Esc closes, and focus returns to the element that opened it.
 * The page behind is inert while it is open.
 */
export function Modal({ title, icon, onClose, children, footer, className, describedBy, initialFocus, closeLabel = 'Close window' }: ModalProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById('root');
    const dialog = ref.current;
    if (root && dialog && !root.contains(dialog)) root.setAttribute('inert', '');
    const first =
      (initialFocus ? dialog?.querySelector<HTMLElement>(initialFocus) : null) ??
      dialog?.querySelector<HTMLElement>('.modal-footer button:not([disabled])') ??
      dialog;
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const firstItem = items[0] as HTMLElement;
      const lastItem = items[items.length - 1] as HTMLElement;
      if (e.shiftKey && (document.activeElement === firstItem || document.activeElement === dialog)) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      root?.removeAttribute('inert');
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [initialFocus]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`modal${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        tabIndex={-1}
      >
        <header className="modal-header">
          {icon ? (
            <span className="modal-icon" aria-hidden="true">
              {icon}
            </span>
          ) : null}
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          <button type="button" className="modal-close secondary" aria-label={closeLabel} onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
