import { motion } from 'framer-motion';
import { useEffect, useRef } from 'react';

import type { ConfirmationRequest } from '../hooks/useWhisperWorkspace';
import { modalBackdropVariants, modalPanelVariants } from '../motion';
import Icon from './Icon';

interface ConfirmDialogProps {
  request: ConfirmationRequest;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmDialog({ request, busy, onCancel, onConfirm }: ConfirmDialogProps): React.JSX.Element {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelButtonRef.current?.focus();

    function handleEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busy) {
        onCancel();
      }
    }

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [busy, onCancel]);

  return (
    <motion.div
      animate="visible"
      className="modal-backdrop confirm-backdrop"
      exit="exit"
      initial="hidden"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !busy) {
          onCancel();
        }
      }}
      variants={modalBackdropVariants}
    >
      <motion.section
        aria-labelledby="confirm-dialog-title"
        aria-modal="true"
        className={`confirm-dialog glass-float ${request.tone}`}
        role="alertdialog"
        variants={modalPanelVariants}
      >
        <div className="confirm-dialog-icon">
          <Icon name={request.tone === 'danger' ? 'warning' : 'info'} size={22} />
        </div>
        <div className="confirm-dialog-copy">
          <h2 id="confirm-dialog-title">{request.title}</h2>
          <p>{request.message}</p>
        </div>
        <div className="confirm-dialog-actions">
          <button className="ghost-button" disabled={busy} onClick={onCancel} ref={cancelButtonRef} type="button">
            取消
          </button>
          <button
            className={request.tone === 'danger' ? 'danger-button' : 'primary-button'}
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? '处理中…' : request.confirmLabel}
          </button>
        </div>
      </motion.section>
    </motion.div>
  );
}

export default ConfirmDialog;
