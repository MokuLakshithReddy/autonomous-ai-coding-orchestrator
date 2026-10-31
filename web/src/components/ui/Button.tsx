import React from 'react';
import { motion } from 'motion/react';

interface ButtonProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    'onAnimationStart' | 'onDragStart' | 'onDragEnd' | 'onDrag'
  > {
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
    sm: { padding: '0.35rem 0.75rem', fontSize: '0.75rem', borderRadius: '6px', gap: '0.35rem' },
    md: { padding: '0.5rem 0.95rem', fontSize: '0.825rem', borderRadius: '7px', gap: '0.45rem' },
    lg: { padding: '0.65rem 1.35rem', fontSize: '0.9rem', borderRadius: '8px', gap: '0.55rem' },
  };

  const variantStyles: Record<string, React.CSSProperties> = {
    primary: {
      background: 'linear-gradient(135deg, #8B7CFF 0%, #7668F5 100%)',
      color: '#ffffff',
      border: '1px solid rgba(255, 255, 255, 0.22)',
      boxShadow: '0 2px 8px rgba(139, 124, 255, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.3)',
    },
    secondary: {
      background: 'rgba(255, 255, 255, 0.05)',
      color: 'var(--text-primary)',
      border: '1px solid var(--border-subtle)',
      boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
    },
    danger: {
      background: 'rgba(251, 113, 133, 0.15)',
      color: '#FB7185',
      border: '1px solid rgba(251, 113, 133, 0.35)',
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
    position: 'relative',
    overflow: 'hidden',
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
      whileHover={
        disabled || loading
          ? {}
          : { y: -1.5, transition: { duration: 0.16, ease: 'easeOut' } }
      }
      whileTap={
        disabled || loading
          ? {}
          : { scale: 0.96, y: 0, transition: { duration: 0.08 } }
      }
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
