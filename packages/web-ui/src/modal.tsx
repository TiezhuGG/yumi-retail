import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
export function Modal({
  title,
  onClose,
  children,
  busy = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!opener.current && document.activeElement instanceof HTMLElement)
      opener.current = document.activeElement;
    d?.showModal();
    return () => {
      d?.close();
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="form-dialog"
      onKeyDown={(e) => {
        if (e.key !== 'Tab') return;
        const controls = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]',
          ),
        ).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first || !last) {
          e.preventDefault();
          return;
        }
        if (
          e.shiftKey &&
          (document.activeElement === first || document.activeElement === e.currentTarget)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (busy || e.target !== e.currentTarget) return;
        // Dialog padding also targets <dialog>; only an actual backdrop click closes it.
        const rect = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < rect.left ||
          e.clientX > rect.right ||
          e.clientY < rect.top ||
          e.clientY > rect.bottom
        )
          onClose();
      }}
      aria-label={title}
    >
      <div className="dialog-heading">
        <div>
          <small>玉米百货 / 业务办理</small>
          <h2>{title}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭表单"
          onClick={onClose}
          disabled={busy}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
