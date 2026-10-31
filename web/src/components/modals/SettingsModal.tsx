import React, { useState } from 'react';
import { X, Settings, Key, Cpu, Shield, Save } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '../ui/Button.js';
import type { SystemStatus } from '../../types/index.js';
import { modalBackdropVariants, modalDialogVariants } from '../../lib/motion.js';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  systemStatus: SystemStatus | null;
  currentApiToken: string;
  onSave: (data: { token?: string; apiKey?: string; model?: string }) => Promise<void>;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  systemStatus,
  currentApiToken,
  onSave,
}) => {
  const [token, setToken] = useState(currentApiToken);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(systemStatus?.geminiModel || 'gemini-2.5-flash');
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await onSave({
        token: token.trim(),
        apiKey: apiKey.trim() || undefined,
        model: model.trim() || undefined,
      });
      onClose();
    } catch {
      // Handled by parent
    } finally {
      setIsSaving(false);
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
                <h2 className="modal-title">Orchestrator Settings</h2>
                <p className="modal-subtitle">
                  Configure credentials, LLM model provider, and server authentication tokens.
                </p>
              </div>
              <button className="modal-close-btn" onClick={onClose} aria-label="Close dialog">
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="modal-form">
              <div className="form-field">
                <label htmlFor="serverToken" className="field-label">
                  <Key size={13} className="text-muted" />
                  <span>Orchestrator Server API Token</span>
                </label>
                <input
                  id="serverToken"
                  type="password"
                  className="field-input"
                  placeholder="Paste 48-char hex token or configured API token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
                <div className="field-hint">
                  Used to authorize all mutating API and WebSocket requests with the Orchestrator.
                </div>
              </div>

              <div className="form-field">
                <label htmlFor="geminiApiKey" className="field-label">
                  <Cpu size={13} className="text-muted" />
                  <span>Gemini API Key</span>
                </label>
                <input
                  id="geminiApiKey"
                  type="password"
                  className="field-input"
                  placeholder="AIzaSy... (leave blank to retain existing key)"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <div className="field-hint">
                  Used by the LLM Brain to decompose missions and evaluate repairs.
                </div>
              </div>

              <div className="form-field">
                <label htmlFor="geminiModel" className="field-label">
                  <span>Gemini Model Family</span>
                </label>
                <input
                  id="geminiModel"
                  type="text"
                  className="field-input"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. gemini-2.5-flash or gemini-3.8-flash"
                />
              </div>

              <div className="modal-actions">
                <Button type="button" variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  loading={isSaving}
                  icon={<Save size={14} />}
                >
                  Save Configuration
                </Button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
