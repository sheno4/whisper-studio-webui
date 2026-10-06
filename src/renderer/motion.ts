export const smoothTransition = {
  type: 'tween',
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1]
} as const;

export const quickTransition = {
  type: 'tween',
  duration: 0.16,
  ease: [0.22, 1, 0.36, 1]
} as const;

export const panelResizeTransition = {
  type: 'tween',
  duration: 0.3,
  ease: [0.16, 1, 0.3, 1]
} as const;

export const tabIndicatorTransition = {
  type: 'tween',
  duration: 0.24,
  ease: [0.2, 0.9, 0.2, 1]
} as const;

export const fadeUpVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: smoothTransition },
  exit: { opacity: 0, y: 6, transition: quickTransition }
} as const;

export const staggerContainerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      delayChildren: 0.02,
      staggerChildren: 0.025
    }
  }
} as const;

export const toastVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: smoothTransition },
  exit: { opacity: 0, y: 8, transition: quickTransition }
} as const;

export const modalBackdropVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: quickTransition },
  exit: { opacity: 0, transition: quickTransition }
} as const;

export const modalPanelVariants = {
  hidden: { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: smoothTransition },
  exit: { opacity: 0, y: 10, transition: quickTransition }
} as const;

export const paneSwitchVariants = {
  active: {
    opacity: 1,
    y: 0,
    transition: smoothTransition
  },
  inactive: {
    opacity: 0,
    y: 6,
    transition: quickTransition
  }
} as const;
