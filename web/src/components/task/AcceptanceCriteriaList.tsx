import React from 'react';
import { ShieldCheck, CheckCircle2, Clock, AlertTriangle } from 'lucide-react';
import type { Verification } from '../../types/index.js';

interface AcceptanceCriteriaListProps {
  criteria: string[];
  taskStatus: string;
  verifications?: Verification[];
}

export const AcceptanceCriteriaList: React.FC<AcceptanceCriteriaListProps> = ({
  criteria,
  taskStatus,
  verifications = [],
}) => {
  if (!criteria || criteria.length === 0) return null;

  const statusLower = taskStatus.toLowerCase();
  const isTerminalFailed = ['failed', 'blocked', 'cancelled'].includes(statusLower);

  // Extract latest verification report details
  const latestVerif = verifications.length > 0 ? verifications[verifications.length - 1] : undefined;
  let criteriaMap: Map<string, { satisfied: boolean; evidence?: string }> = new Map();

  if (latestVerif) {
    try {
      const details = (latestVerif as any).detailsJson
        ? JSON.parse((latestVerif as any).detailsJson)
        : undefined;
      if (details?.criteriaResults && Array.isArray(details.criteriaResults)) {
        for (const cr of details.criteriaResults) {
          if (cr.criterion) {
            criteriaMap.set(cr.criterion.trim().toLowerCase(), {
              satisfied: Boolean(cr.satisfied),
              evidence: cr.evidence,
            });
          }
        }
      }
    } catch {}
  }

  return (
    <div className="criteria-card">
      <div className="card-section-header">
        <div className="section-heading">
          <ShieldCheck size={15} className="text-emerald" />
          <span>Independent Acceptance Criteria</span>
          <span className="count-pill">{criteria.length} criteria</span>
        </div>
        <span className="criteria-subtitle">
          Mandatory criteria verified by independent test suites and symbol diff inspection
        </span>
      </div>

      <div className="criteria-list">
        {criteria.map((item, idx) => {
          const matchedResult = criteriaMap.get(item.trim().toLowerCase());
          const isIndividuallyVerified = matchedResult ? matchedResult.satisfied : statusLower === 'completed';
          const isIndividuallyFailed = matchedResult ? !matchedResult.satisfied : isTerminalFailed;
          const isPending = !matchedResult && !['completed', 'failed', 'blocked', 'cancelled'].includes(statusLower);

          return (
            <div
              key={idx}
              className={`criteria-item ${
                isIndividuallyVerified ? 'verified' : isIndividuallyFailed ? 'unverified' : 'pending'
              }`}
            >
              <div className="criteria-check-icon">
                {isIndividuallyVerified ? (
                  <CheckCircle2 size={15} className="text-emerald" />
                ) : isIndividuallyFailed ? (
                  <AlertTriangle size={15} className="text-rose" />
                ) : (
                  <Clock size={15} className="text-muted" />
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
                <span className="criteria-text">{item}</span>
                {matchedResult?.evidence && (
                  <span style={{ fontSize: '0.72rem', color: isIndividuallyVerified ? 'var(--status-success)' : 'var(--status-danger)', opacity: 0.85 }}>
                    {matchedResult.evidence}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

