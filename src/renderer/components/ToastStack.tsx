import { AnimatePresence, motion } from 'framer-motion';

import type { ToastEvent } from '../../shared/types';
import { isKeyboardInteraction } from '../hooks/useInteractionModality';
import { useReducedMotionPreference } from '../hooks/useReducedMotionPreference';
import { getToastVariants } from '../motion';
import { normalizeUiText } from '../utils';
import Icon, { type IconName } from './Icon';

interface ToastStackProps {
  toasts: ToastEvent[];
}

function getToastIcon(tone: ToastEvent['tone']): IconName {
  switch (tone) {
    case 'success':
      return 'check';
    case 'warning':
    case 'error':
      return 'warning';
    default:
      return 'info';
  }
}

function ToastStack({ toasts }: ToastStackProps): React.JSX.Element {
  const reducedMotion = useReducedMotionPreference();
  return (
    <div aria-atomic="false" aria-live="polite" className="toast-viewport">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.article
            animate="visible"
            className={`toast glass-float ${toast.tone}`}
            exit="exit"
            initial="hidden"
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            variants={getToastVariants(reducedMotion, isKeyboardInteraction())}
          >
            <span className="toast-icon" aria-hidden="true">
              <Icon name={getToastIcon(toast.tone)} size={17} />
            </span>
            <span className="toast-copy">
              <strong>{normalizeUiText(toast.title)}</strong>
              <p>{normalizeUiText(toast.message)}</p>
            </span>
          </motion.article>
        ))}
      </AnimatePresence>
    </div>
  );
}

export default ToastStack;
