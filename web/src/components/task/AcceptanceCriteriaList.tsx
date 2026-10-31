import React from 'react';
import { ShieldCheck, CheckCircle2, Clock, AlertTriangle } from 'lucide-react';

interface AcceptanceCriteriaListProps {
  criteria: string[];
  taskStatus: string;
}

export const AcceptanceCriteriaList: React.FC<AcceptanceCriteriaListProps> = ({
  criteria,
  taskStatus,
}) => {
  if (!criteria || criteria.length === 0) return null;

  const isCompleted = taskStatus.toLowerCase() === 'completed';
  const isFailed = taskStatus.toLowerCase() === 'failed';

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
          return (
            <div
              key={idx}
              className={`criteria-item ${isCompleted ? 'verified' : isFailed ? 'unverified' : 'pending'}`}
            >
              <div className="criteria-check-icon">
                {isCompleted ? (
                  <CheckCircle2 size={15} className="text-emerald" />
                ) : isFailed ? (
                  <AlertTriangle size={15} className="text-rose" />
                ) : (
                  <Clock size={15} className="text-muted" />
                )}
              </div>
              <span className="criteria-text">{item}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

