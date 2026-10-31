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
        <p className="empty-heading">No verification reports yet</p>
        <p className="empty-subtext">
          Independent verification runs after each agent step and on completion.
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
                <span className="verif-run-num">Run #{verifications.length - index}</span>
                <Badge status={v.status} size="sm" />
              </div>
              <span className="verif-time">{formatTimestamp(v.createdAt)}</span>
            </div>

            {/* Sub-check chips */}
            <div className="verif-subchecks-grid">
              <div className="subcheck-item">
                <span className="subcheck-label">Build</span>
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
                <span className="subcheck-label">Linter</span>
                <span className={`subcheck-val val-${v.lintStatus.toLowerCase()}`}>
                  {v.lintStatus}
                </span>
              </div>
            </div>

            {/* Diff summary inspection */}
            {v.diffInspection && (
              <div className="verif-diff-inspection">
                <span className="diff-inspect-label">Diff Inspection:</span>
                <span className="diff-inspect-val">{v.diffInspection}</span>
              </div>
            )}

            {/* Diagnostics if failing */}
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

