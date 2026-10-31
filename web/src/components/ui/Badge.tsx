import React from 'react';
import { getStatusColor } from '../../lib/formatters.js';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status?: string;
  variant?: 'status' | 'outline' | 'subtle' | 'neutral';
  size?: 'sm' | 'md' | 'lg';
  showDot?: boolean;
}

export const Badge: React.FC<BadgeProps> = ({
  status,
  variant = 'status',
  size = 'md',
  showDot = true,
  children,
  className = '',
  style = {},
  ...props
}) => {
  const colors = getStatusColor(status);

  const sizeStyles: Record<string, React.CSSProperties> = {
    sm: { fontSize: '0.685rem', padding: '1px 6px', borderRadius: '5px' },
    md: { fontSize: '0.725rem', padding: '2px 8px', borderRadius: '6px' },
    lg: { fontSize: '0.8rem', padding: '4px 10px', borderRadius: '7px' },
  };

  const currentSize = sizeStyles[size] || sizeStyles.md;

  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.35rem',
    fontWeight: 600,
    letterSpacing: '0.02em',
    whiteSpace: 'nowrap',
    transition: 'all 0.15s ease',
    ...currentSize,
    ...(variant === 'status'
      ? {
          background: colors.bg,
          color: colors.text,
          border: `1px solid ${colors.border}`,
        }
      : variant === 'outline'
      ? {
          background: 'transparent',
          color: 'var(--text-secondary)',
          border: '1px solid var(--border-subtle)',
        }
      : {
          background: 'rgba(255, 255, 255, 0.04)',
          color: 'var(--text-secondary)',
          border: '1px solid var(--border-subtle)',
        }),
    ...style,
  };

  return (
    <span style={baseStyle} className={`badge-primitive ${className}`} {...props}>
      {showDot && (
        <span
          style={{
            width: size === 'sm' ? 4 : 6,
            height: size === 'sm' ? 4 : 6,
            borderRadius: '50%',
            backgroundColor: variant === 'status' ? colors.dot : 'currentColor',
            flexShrink: 0,
          }}
        />
      )}
      {children || status}
    </span>
  );
};

