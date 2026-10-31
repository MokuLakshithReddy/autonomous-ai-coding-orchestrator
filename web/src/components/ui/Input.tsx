import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helperText?: string;
  error?: string;
}

export const Input: React.FC<InputProps> = ({
  label,
  helperText,
  error,
  id,
  className = '',
  style = {},
  ...props
}) => {
  const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', width: '100%' }}>
      {label && (
        <label
          htmlFor={inputId}
          style={{
            fontSize: '0.8rem',
            fontWeight: 600,
            color: 'var(--text-secondary)',
            letterSpacing: '0.01em',
          }}
        >
          {label}
        </label>
      )}
      <input
        id={inputId}
        style={{
          background: 'var(--bg-input)',
          border: `1px solid ${error ? 'var(--status-failed)' : 'var(--border-subtle)'}`,
          borderRadius: 'var(--radius-sm)',
          padding: '0.55rem 0.85rem',
          color: 'var(--text-primary)',
          fontSize: '0.85rem',
          fontFamily: 'inherit',
          outline: 'none',
          transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
          ...style,
        }}
        className={`input-primitive ${className}`}
        {...props}
      />
      {error ? (
        <span style={{ fontSize: '0.75rem', color: '#f87171' }}>{error}</span>
      ) : helperText ? (
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{helperText}</span>
      ) : null}
    </div>
  );
};

