import type { Variants, Transition } from 'motion/react';

// Motion Design Specification Timings (Section 13)
export const timings = {
  micro: 0.15,        // 150ms
  button: 0.18,       // 180ms
  cardHover: 0.22,    // 220ms
  panel: 0.28,        // 280ms
  page: 0.35,         // 350ms
  modal: 0.32,        // 320ms
  staggerDelay: 0.05, // 50ms
};

// Physics Spring & Easing Standards
export const springs = {
  snappy: { type: 'spring', damping: 26, stiffness: 380 } as Transition,
  smooth: { type: 'spring', damping: 28, stiffness: 280 } as Transition,
  gentle: { type: 'spring', damping: 32, stiffness: 200 } as Transition,
  pop: { type: 'spring', damping: 18, stiffness: 440 } as Transition,
};

export const transitions = {
  micro: { duration: timings.micro, ease: [0.16, 1, 0.3, 1] } as Transition,
  interactive: { duration: timings.button, ease: [0.16, 1, 0.3, 1] } as Transition,
  standard: { duration: timings.cardHover, ease: [0.16, 1, 0.3, 1] } as Transition,
  panel: { duration: timings.panel, ease: [0.22, 1, 0.36, 1] } as Transition,
  page: { duration: timings.page, ease: [0.22, 1, 0.36, 1] } as Transition,
  springy: springs.snappy,
  gentleSpring: springs.smooth,
};

// Page Transition Variants
export const pageVariants: Variants = {
  initial: {
    opacity: 0,
    y: 8,
  },
  animate: {
    opacity: 1,
    y: 0,
    transition: transitions.page,
  },
  exit: {
    opacity: 0,
    y: -6,
    transition: { duration: 0.18, ease: 'easeOut' },
  },
};

// Inspector & Panel Switcher Variants
export const panelVariants: Variants = {
  initial: {
    opacity: 0,
    y: 6,
  },
  animate: {
    opacity: 1,
    y: 0,
    transition: transitions.panel,
  },
  exit: {
    opacity: 0,
    y: -4,
    transition: { duration: 0.15, ease: 'easeOut' },
  },
};

// Modal Backdrop & Content Variants
export const modalBackdropVariants: Variants = {
  hidden: { opacity: 0, backdropFilter: 'blur(0px)' },
  visible: {
    opacity: 1,
    backdropFilter: 'blur(6px)',
    transition: { duration: timings.modal },
  },
  exit: {
    opacity: 0,
    backdropFilter: 'blur(0px)',
    transition: { duration: 0.2 },
  },
};

export const modalDialogVariants: Variants = {
  hidden: {
    opacity: 0,
    scale: 0.94,
    y: 14,
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: springs.smooth,
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    y: 8,
    transition: { duration: 0.16, ease: 'easeIn' },
  },
};

// Staggered Container & Items
export const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: timings.staggerDelay,
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

// Card Pop & Hover
export const cardPopVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: {
      delay: i * timings.staggerDelay,
      duration: timings.cardHover,
      ease: [0.16, 1, 0.3, 1],
    },
  }),
};

// Section Reveal Variants
export const sectionRevealVariants: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: transitions.panel,
  },
};
