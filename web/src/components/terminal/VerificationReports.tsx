import React, { useState } from 'react';
import { ShieldCheck, CheckCircle2, XCircle, AlertTriangle, Terminal, ChevronDown, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { Verification } from '../../types/index.js';
import { Badge } from '../ui/Badge.js';
import { formatTimestamp } from '../../lib/formatters.js';
import { springs } from '../../lib/motion.js';

interface VerificationReportsProps {
  verifications: Verification[];
}

export const VerificationReports: React.FC<VerificationReportsProps> = ({ verifications }) => {
  const [expandedDiags, setExpandedDiags] = useState<Record<string, boolean>>({});

  const toggleDiag = (key: string) => {
    setExpandedDiags((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  if (!verifications || verifications.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="verifications-empty-state"
      >
        <ShieldCheck size={32} className="text-muted" />
        <p style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          No verification reports yet
        </p>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          Independent verification runs after each agent step and upon final task completion.
        </p>
      </motion.div>
    );
  }

  return (
    <div className="verifications-list-wrapper">
      {verifications.map((v, index) => {
        const isPassed = v.status === 'PASSED';
        const isFailed = v.status === 'FAILED';
        const itemKey = v.id || `verif-${index}`;
        const isDiagOpen = expandedDiags[itemKey] !== false; // Default open for readability

        return (
          <motion.div
            key={itemKey}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              delay: Math.min(index * 0.05, 0.25),
              duration: 0.24,
              ease: [0.16, 1, 0.3, 1],
            }}
            whileHover={{ y: -2, transition: { duration: 0.15 } }}
            className={`verification-card ${
              isPassed ? 'passed' : isFailed ? 'failed' : 'inconclusive'
            }`}
          >
            <div className="verification-card-header">
              <div className="verif-title-row">
                <span className="verif-run-num">
                  Verification Run #{verifications.length - index}
                </span>
                <Badge status={v.status} size="sm" />
              </div>
              <span className="verif-time">{formatTimestamp(v.createdAt)}</span>
            </div>

            {/* Sub-checks: Build, Test Suite, Linter */}
            <div className="verif-subchecks-grid">
              <div className="subcheck-item">
                <span className="subcheck-label">Build Gate</span>
                <span className={`subcheck-val val-${v.buildStatus.toLowerCase()}`}>
                  {v.buildStatus}
                </span>
              </div>
              <div className="subcheck-item">
                <span className="subcheck-label">Test Suite</span>
                <span className={`subcheck-val val-${v.testStatus.toLowerCase()}`}>
                  {v.testStatus}
                </span>
              </div>
              <div className="subcheck-item">
                <span className="subcheck-label">Static Analysis</span>
                <span className={`subcheck-val val-${v.lintStatus.toLowerCase()}`}>
                  {v.lintStatus}
                </span>
              </div>
            </div>

            {/* Diff Inspection Evidence */}
            {v.diffInspection && (
              <div className="verif-diff-inspection">
                <span className="diff-inspect-label">Diff Inspection:</span>
                <span style={{ color: 'var(--text-primary)' }}>{v.diffInspection}</span>
              </div>
            )}

            {/* Compiler / Test Diagnostics with Animated Collapse */}
            {v.diagnostics && (
              <div className="verif-diagnostics-box">
                <div
                  className="diag-header"
                  onClick={() => toggleDiag(itemKey)}
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <Terminal size={11} />
                    <span>Compiler & Test Diagnostics</span>
                  </div>
                  {isDiagOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </div>

                <AnimatePresence initial={false}>
                  {isDiagOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: 'easeInOut' }}
                      style={{ overflow: 'hidden' }}
                    >
                      <pre className="diag-pre">{v.diagnostics}</pre>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </motion.div>
        );
      })}
    </div>
  );
};
