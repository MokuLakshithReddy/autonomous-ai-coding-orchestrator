import React from 'react';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'elevated' | 'glass' | 'subtle';
  interactive?: boolean;
}

export const Card: React.FC<CardProps> = ({
  variant = 'default',
  interactive = false,
  children,
  className = '',
  style = {},
  ...props
}) => {
  const variantStyles: Record<string, React.CSSProperties> = {
    default: {
      background: 'var(--bg-surface)',
      border: '1px solid var(--border-subtle)',
    },
    elevated: {
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-subtle)',
      boxShadow: 'var(--shadow-card)',
    },
    glass: {
      background: 'rgba(19, 24, 34, 0.7)',
      border: '1px solid var(--border-subtle)',
      backdropFilter: 'blur(12px)',
    },
    subtle: {
      background: 'rgba(255, 255, 255, 0.02)',
      border: '1px solid var(--border-subtle)',
    },
  };

  const baseStyle: React.CSSProperties = {
    borderRadius: 'var(--radius-md)',
    transition: 'all 0.15s ease',
    ...(variantStyles[variant] || variantStyles.default),
    ...style,
  };

  return (
    <div
      style={baseStyle}
      className={`card-primitive ${interactive ? 'card-interactive' : ''} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
};

