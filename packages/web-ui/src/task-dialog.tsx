import type { ReactNode } from 'react';
import { Modal } from './modal.js';

export function TaskDialog({
  title,
  busy,
  message,
  error = false,
  onClose,
  children,
}: {
  title: string;
  busy: boolean;
  message: string;
  error?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal title={title} busy={busy} onClose={onClose}>
      <fieldset className="task-detail" disabled={busy}>
        {message && (
          <p className={`notice ${error ? 'task-error' : ''}`} role={error ? 'alert' : 'status'}>
            {message}
          </p>
        )}
        {children}
      </fieldset>
    </Modal>
  );
}
