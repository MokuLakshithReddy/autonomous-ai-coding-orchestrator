import React from 'react';
import { motion, type HTMLMotionProps } from 'motion/react';

interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onAnimationStart' | 'onDragStart' | 'onDragEnd' | 'onDrag'> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  icon?: React.ReactNode;
  loading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  children,
  className = '',
  disabled,
  style = {},
  ...props
}) => {
  const sizeStyles: Record<string, React.CSSProperties> = {
    sm: { padding: '0.35rem 0.65rem', fontSize: '0.75rem', borderRadius: '6px', gap: '0.35rem' },
    md: { padding: '0.5rem 0.9rem', fontSize: '0.825rem', borderRadius: '7px', gap: '0.45rem' },
    lg: { padding: '0.65rem 1.25rem', fontSize: '0.9rem', borderRadius: '8px', gap: '0.55rem' },
  };

  const variantStyles: Record<string, React.CSSProperties> = {
    primary: {
      background: 'linear-gradient(180deg, #6366f1 0%, #4f46e5 100%)',
      color: '#ffffff',
      border: '1px solid rgba(255, 255, 255, 0.15)',
      boxShadow: '0 1px 3px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
    },
    secondary: {
      background: 'rgba(255, 255, 255, 0.05)',
      color: 'var(--text-primary)',
      border: '1px solid var(--border-subtle)',
      boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
    },
    danger: {
      background: 'rgba(239, 68, 68, 0.15)',
      color: '#f87171',
      border: '1px solid rgba(239, 68, 68, 0.3)',
    },
    outline: {
      background: 'transparent',
      color: 'var(--text-secondary)',
      border: '1px solid var(--border-subtle)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--text-secondary)',
      border: '1px solid transparent',
    },
  };

  const currentSize = sizeStyles[size] || sizeStyles.md;
  const currentVariant = variantStyles[variant] || variantStyles.secondary;

  const combinedStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 600,
    cursor: disabled || loading ? 'not-allowed' : 'pointer',
    opacity: disabled || loading ? 0.5 : 1,
    whiteSpace: 'nowrap',
    outline: 'none',
    userSelect: 'none',
    ...currentSize,
    ...currentVariant,
    ...style,
  };

  return (
    <motion.button
      whileHover={disabled || loading ? {} : { y: -1, transition: { duration: 0.15, ease: 'easeOut' } }}
      whileTap={disabled || loading ? {} : { scale: 0.98, y: 0, transition: { duration: 0.1 } }}
      style={combinedStyle}
      disabled={disabled || loading}
      className={`btn-interactive ${className}`}
      {...(props as any)}
    >
      {loading ? (
        <span
          style={{
            width: 12,
            height: 12,
            border: '2px solid rgba(255, 255, 255, 0.2)',
            borderTopColor: 'currentColor',
            borderRadius: '50%',
            animation: 'spin 0.6s linear infinite',
            flexShrink: 0,
          }}
        />
      ) : (
        icon && <span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span>
      )}
      {children}
    </motion.button>
  );
};
