import { useEffect, useRef, type RefObject } from 'react';

import { registerDialog } from './dialog-interactions';

interface DialogInteractionOptions {
  onDismiss: () => void;
  canDismiss?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function useDialogInteraction(
  panelRef: RefObject<HTMLElement | null>,
  { onDismiss, canDismiss = true, initialFocusRef }: DialogInteractionOptions
): void {
  const currentOptions = useRef({ onDismiss, canDismiss, initialFocusRef });
  currentOptions.current = { onDismiss, canDismiss, initialFocusRef };

  useEffect(() => {
    if (!panelRef.current) return;
    return registerDialog(panelRef.current, {
      onEscape: () => currentOptions.current.onDismiss(),
      canDismiss: () => currentOptions.current.canDismiss,
      initialFocus: () => currentOptions.current.initialFocusRef?.current ?? null
    });
  }, [panelRef]);
}
