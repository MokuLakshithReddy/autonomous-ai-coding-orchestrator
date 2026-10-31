import React, { useState } from 'react';
import { Key, ShieldAlert, X, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '../ui/Button.js';
import { modalBackdropVariants, modalDialogVariants } from '../../lib/motion.js';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthenticate: (token: string) => Promise<boolean>;
  currentError?: string;
  initialToken?: string;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  onClose,
  onAuthenticate,
  currentError,
  initialToken = '',
}) => {
  const [token, setToken] = useState(initialToken);
  const [error, setError] = useState(currentError || '');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = token.trim();
    if (!clean) {
      setError('Please provide a valid API token');
      return;
    }

    setIsSubmitting(true);
    setError('');
    try {
      const ok = await onAuthenticate(clean);
      if (ok) {
        onClose();
      } else {
        setError('Authentication failed: Invalid API token.');
      }
    } catch (err: any) {
      setError(`Connection error: ${err.message || 'Cannot reach server'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          variants={modalBackdropVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="modal-backdrop"
          onClick={onClose}
          role="dialog"
          aria-modal="true"
        >
          <motion.div
            variants={modalDialogVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="modal-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <div className="modal-title-group">
                <div className="auth-icon-badge">
                  <Key size={18} />
                </div>
                <div>
                  <h2 className="modal-title">API Authentication Required</h2>
                  <p className="modal-subtitle">
                    The Orchestrator protects mutation endpoints and live events with an API Token.
                  </p>
                </div>
              </div>
              <button className="modal-close-btn" onClick={onClose} aria-label="Close dialog">
                <X size={16} />
              </button>
            </div>

            {error && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="auth-error-banner"
              >
                <ShieldAlert size={15} />
                <span>{error}</span>
              </motion.div>
            )}

            <form onSubmit={handleSubmit} className="modal-form">
              <div className="form-field">
                <label htmlFor="authTokenInput" className="field-label">
                  Orchestrator Server API Token *
                </label>
                <input
                  id="authTokenInput"
                  type="password"
                  className="field-input"
                  required
                  placeholder="Paste token (generated on startup or set in API_TOKEN)"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
                <div className="field-hint">
                  You can find your token in the terminal logs when starting the orchestrator server.
                </div>
              </div>

              <div className="modal-actions">
                <Button type="button" variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  loading={isSubmitting}
                  icon={<ArrowRight size={14} />}
                >
                  Connect & Verify
                </Button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
