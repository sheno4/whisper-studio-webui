export const easeOut = [0.23, 1, 0.32, 1] as const;
export const easeInOut = [0.77, 0, 0.175, 1] as const;

// Functional content and keyboard navigation stay still; motion belongs to
// occasional floating UI. Keep one timing vocabulary across the workbench.
export const quickTransition = { type: 'tween', duration: 0.12, ease: easeOut } as const;
export const smoothTransition = { type: 'tween', duration: 0.2, ease: easeOut } as const;
export const popoverTransition = { type: 'tween', duration: 0.18, ease: easeOut } as const;
export const modalTransition = { type: 'tween', duration: 0.24, ease: easeOut } as const;
export const staticTransition = { type: 'tween', duration: 0 } as const;
export const panelResizeTransition = staticTransition;
export const tabIndicatorTransition = { type: 'tween', duration: 0.16, ease: easeInOut } as const;

export function getOverlayVariants(
  kind: 'panel' | 'popover' | 'backdrop',
  reducedMotion: boolean | null = false,
  keyboard = false
) {
  const rest = kind === 'backdrop' ? {} : { transform: 'scale(1)' };
  const hidden = kind === 'backdrop' || reducedMotion || keyboard
    ? rest
    : { transform: kind === 'popover' ? 'scale(0.97)' : 'scale(0.96)' };
  const transition = keyboard
    ? staticTransition
    : reducedMotion ? quickTransition : kind === 'popover' ? popoverTransition : modalTransition;

  return {
    hidden: { opacity: 0, ...hidden },
    visible: { opacity: 1, ...rest, transition },
    exit: { opacity: 0, ...hidden, transition: keyboard ? staticTransition : quickTransition }
  };
}

export function getToastVariants(reducedMotion: boolean | null = false, keyboard = false) {
  const hiddenTransform = reducedMotion || keyboard ? 'translateY(0)' : 'translateY(8px)';
  return {
    hidden: { opacity: 0, transform: hiddenTransform },
    visible: { opacity: 1, transform: 'translateY(0)', transition: keyboard ? staticTransition : smoothTransition },
    exit: { opacity: 0, transform: hiddenTransform, transition: keyboard ? staticTransition : quickTransition }
  };
}

// Preserve legacy exports without layout animation or main-thread shorthands.
export const fadeUpVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: quickTransition },
  exit: { opacity: 0, transition: quickTransition }
} as const;

export const staggerContainerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.04 } }
} as const;

export const toastVariants = getToastVariants();
export const modalBackdropVariants = getOverlayVariants('backdrop');
export const modalPanelVariants = getOverlayVariants('panel');
export const paneSwitchVariants = {
  active: { opacity: 1, transition: staticTransition },
  inactive: { opacity: 0, transition: staticTransition }
} as const;
