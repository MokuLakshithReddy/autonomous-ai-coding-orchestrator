import React from 'react';
import { ShieldCheck, CheckCircle2, XCircle, AlertTriangle, Terminal } from 'lucide-react';
import type { Verification } from '../../types/index.js';
import { Badge } from '../ui/Badge.js';
import { formatTimestamp } from '../../lib/formatters.js';

interface VerificationReportsProps {
  verifications: Verification[];
}

export const VerificationReports: React.FC<VerificationReportsProps> = ({ verifications }) => {
  if (!verifications || verifications.length === 0) {
    return (
      <div className="verifications-empty-state">
        <ShieldCheck size={32} className="text-muted" />
        <p style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          No verification reports yet
        </p>
        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          Independent verification runs after each agent step and upon final task completion.
        </p>
      </div>
    );
  }

  return (
    <div className="verifications-list-wrapper">
      {verifications.map((v, index) => {
        const isPassed = v.status === 'PASSED';
        const isFailed = v.status === 'FAILED';

        return (
          <div
            key={v.id || index}
            className={`verification-card ${isPassed ? 'passed' : isFailed ? 'failed' : 'inconclusive'}`}
          >
            <div className="verification-card-header">
              <div className="verif-title-row">
                <span className="verif-run-num">Verification Run #{verifications.length - index}</span>
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

            {/* Compiler / Test Diagnostics */}
            {v.diagnostics && (
              <div className="verif-diagnostics-box">
                <div className="diag-header">
                  <Terminal size={11} />
                  <span>Compiler & Test Diagnostics</span>
                </div>
                <pre className="diag-pre">{v.diagnostics}</pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
