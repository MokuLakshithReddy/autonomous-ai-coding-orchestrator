import type { Variants, Transition } from 'motion/react';

// Transition standards
export const transitions = {
  micro: { duration: 0.15, ease: [0.16, 1, 0.3, 1] } as Transition,
  interactive: { duration: 0.2, ease: [0.16, 1, 0.3, 1] } as Transition,
  standard: { duration: 0.25, ease: [0.16, 1, 0.3, 1] } as Transition,
  page: { duration: 0.28, ease: [0.22, 1, 0.36, 1] } as Transition,
  springy: { type: 'spring', damping: 25, stiffness: 350 } as Transition,
  gentleSpring: { type: 'spring', damping: 30, stiffness: 200 } as Transition,
};

// Page transition variant
export const pageVariants: Variants = {
  initial: {
    opacity: 0,
    y: 6,
  },
  animate: {
    opacity: 1,
    y: 0,
    transition: transitions.page,
  },
  exit: {
    opacity: 0,
    y: -4,
    transition: { duration: 0.18, ease: 'easeOut' },
  },
};

// Modal backdrop & content variants
export const modalBackdropVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.2 },
  },
  exit: {
    opacity: 0,
    transition: { duration: 0.15 },
  },
};

export const modalDialogVariants: Variants = {
  hidden: {
    opacity: 0,
    scale: 0.96,
    y: 10,
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: 'spring',
      damping: 28,
      stiffness: 340,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.97,
    y: 6,
    transition: { duration: 0.15, ease: 'easeIn' },
  },
};

// Staggered list container & items
export const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.04,
      delayChildren: 0.02,
    },
  },
};

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: transitions.standard,
  },
};

// Card pop & hover
export const cardPopVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: {
      delay: i * 0.05,
      duration: 0.28,
      ease: [0.16, 1, 0.3, 1],
    },
  }),
};

