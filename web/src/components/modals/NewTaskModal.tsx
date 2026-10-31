import React, { useState } from 'react';
import { Plus, X, Sparkles, FolderGit2, Bot, Layers, RotateCcw, GitMerge } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '../ui/Button.js';
import { modalBackdropVariants, modalDialogVariants } from '../../lib/motion.js';

interface NewTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (taskData: {
    prompt: string;
    workspacePath: string;
    agent: 'builtin' | 'aider' | 'claude';
    autoMerge: boolean;
    maxRetries: number;
  }) => Promise<void>;
  defaultWorkspace: string;
}

const TEMPLATES = [
  {
    label: 'Fix Failing Test',
    prompt: 'Diagnose the failing unit tests, identify the regression or bug, modify the code cleanly to pass all tests, and verify zero side effects.',
  },
  {
    label: 'Add Unit Test Suite',
    prompt: 'Inspect the primary service module, author a comprehensive unit test suite covering edge cases, invalid inputs, and error handling.',
  },
  {
    label: 'Security Audit & Fix',
    prompt: 'Audit all input validation and file operations for path traversal and secret leakage vulnerabilities. Apply strict validation guards.',
  },
  {
    label: 'Refactor & Type Safety',
    prompt: 'Refactor legacy untyped functions with strict TypeScript interfaces, eliminate any type casts, and verify full build typechecking passes.',
  },
];

export const NewTaskModal: React.FC<NewTaskModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  defaultWorkspace,
}) => {
  const [prompt, setPrompt] = useState('');
  const [workspacePath, setWorkspacePath] = useState(defaultWorkspace);
  const [agent, setAgent] = useState<'builtin' | 'aider' | 'claude'>('builtin');
  const [autoMerge, setAutoMerge] = useState(false);
  const [maxRetries, setMaxRetries] = useState(3);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    setIsSubmitting(true);
    try {
      await onSubmit({
        prompt,
        workspacePath,
        agent,
        autoMerge,
        maxRetries,
      });
      onClose();
    } catch {
      // Handled by parent
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
            className="modal-dialog modal-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <div className="modal-title-group">
                <h2 className="modal-title">Launch Autonomous Mission</h2>
                <p className="modal-subtitle">
                  Declare your objective once. The Orchestrator plans, executes, verifies, and self-repairs in an isolated worktree.
                </p>
              </div>
              <button className="modal-close-btn" onClick={onClose} aria-label="Close dialog">
                <X size={16} />
              </button>
            </div>

            {/* Quick Objective Templates */}
            <div className="templates-section">
              <span className="templates-label">
                <Sparkles size={12} className="text-indigo" />
                <span>Preset Objectives:</span>
              </span>
              <div className="templates-list">
                {TEMPLATES.map((tmpl) => (
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    key={tmpl.label}
                    type="button"
                    className="template-chip"
                    onClick={() => setPrompt(tmpl.prompt)}
                  >
                    {tmpl.label}
                  </motion.button>
                ))}
              </div>
            </div>

            <form onSubmit={handleSubmit} className="modal-form">
              <div className="form-field">
                <label htmlFor="missionPrompt" className="field-label">
                  Mission Objective / Prompt *
                </label>
                <textarea
                  id="missionPrompt"
                  className="field-textarea"
                  rows={4}
                  required
                  placeholder="e.g. Build an authentication middleware and write unit tests for token expiration..."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
                <div className="field-hint">
                  Be specific about expected behaviors and testing requirements. The verifier will construct criteria from this prompt.
                </div>
              </div>

              <div className="form-field">
                <label htmlFor="workspacePath" className="field-label">
                  Workspace Repository Path
                </label>
                <input
                  id="workspacePath"
                  type="text"
                  className="field-input"
                  placeholder="Leave blank for project workspace or enter Git repository path"
                  value={workspacePath}
                  onChange={(e) => setWorkspacePath(e.target.value)}
                />
                <div className="field-hint">
                  Must be an initialized Git repository within authorized workspace boundaries.
                </div>
              </div>

              <div className="form-grid-2">
                <div className="form-field">
                  <label htmlFor="agentSelect" className="field-label">
                    Coding Agent Adapter
                  </label>
                  <select
                    id="agentSelect"
                    className="field-select"
                    value={agent}
                    onChange={(e) => setAgent(e.target.value as any)}
                  >
                    <option value="builtin">Built-in Autonomous Agent (Gemini / Multi-Tool)</option>
                    <option value="claude">Claude Code CLI Adapter</option>
                    <option value="aider">Aider CLI Adapter</option>
                  </select>
                </div>

                <div className="form-field">
                  <label htmlFor="retryCount" className="field-label">
                    Self-Repair Retry Budget
                  </label>
                  <input
                    id="retryCount"
                    type="number"
                    min={1}
                    max={10}
                    className="field-input"
                    value={maxRetries}
                    onChange={(e) => setMaxRetries(parseInt(e.target.value, 10))}
                  />
                </div>
              </div>

              <div className="checkbox-field">
                <input
                  type="checkbox"
                  id="autoMergeCheck"
                  checked={autoMerge}
                  onChange={(e) => setAutoMerge(e.target.checked)}
                  className="custom-checkbox"
                />
                <label htmlFor="autoMergeCheck" className="checkbox-label">
                  <span className="checkbox-title">Auto-merge on verified completion</span>
                  <span className="checkbox-desc">
                    If enabled, automatically merges <code>task/branch</code> into base branch only after all independent verifications pass 100%.
                  </span>
                </label>
              </div>

              <div className="modal-actions">
                <Button type="button" variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  loading={isSubmitting}
                  icon={<Plus size={14} />}
                >
                  Start Autonomous Run
                </Button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
