import { motion } from 'framer-motion';
import { useRef, useState } from 'react';

import type { ConfirmationRequest } from '../hooks/useWhisperWorkspace';
import { useDialogInteraction } from '../hooks/useDialogInteraction';
import { isKeyboardInteraction } from '../hooks/useInteractionModality';
import { useReducedMotionPreference } from '../hooks/useReducedMotionPreference';
import { getOverlayVariants } from '../motion';
import Icon from './Icon';

interface ConfirmDialogProps {
  request: ConfirmationRequest;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmDialog({ request, busy, onCancel, onConfirm }: ConfirmDialogProps): React.JSX.Element {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const [keyboardMotion, setKeyboardMotion] = useState(isKeyboardInteraction);
  const reducedMotion = useReducedMotionPreference();
  const dismiss = (): void => {
    setKeyboardMotion(isKeyboardInteraction());
    onCancel();
  };
  useDialogInteraction(panelRef, { onDismiss: dismiss, canDismiss: !busy, initialFocusRef: cancelButtonRef });

  return (
    <motion.div
      animate="visible"
      className="modal-backdrop confirm-backdrop"
      exit="exit"
      initial="hidden"
      onPointerDown={(event) => {
        if (event.currentTarget === event.target && !busy) {
          dismiss();
        }
      }}
      variants={getOverlayVariants('backdrop', reducedMotion, keyboardMotion)}
    >
      <motion.section
        aria-busy={busy}
        aria-describedby="confirm-dialog-description"
        aria-labelledby="confirm-dialog-title"
        aria-modal="true"
        className={`confirm-dialog glass-float glass-dialog ${request.tone}`}
        ref={panelRef}
        role="alertdialog"
        tabIndex={-1}
        variants={getOverlayVariants('panel', reducedMotion, keyboardMotion)}
      >
        <div className="confirm-dialog-icon">
          <Icon name={request.tone === 'danger' ? 'warning' : 'info'} size={22} />
        </div>
        <div className="confirm-dialog-copy">
          <h2 id="confirm-dialog-title">{request.title}</h2>
          <p id="confirm-dialog-description">{request.message}</p>
        </div>
        <div className="confirm-dialog-actions">
          <button className="ghost-button" disabled={busy} onClick={dismiss} ref={cancelButtonRef} type="button">
            取消
          </button>
          <button
            className={request.tone === 'danger' ? 'danger-button' : 'primary-button'}
            disabled={busy}
            onClick={() => { setKeyboardMotion(isKeyboardInteraction()); onConfirm(); }}
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
