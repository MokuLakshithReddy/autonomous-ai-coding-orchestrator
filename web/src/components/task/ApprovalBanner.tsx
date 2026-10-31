import React from 'react';
import { ShieldAlert, Check, X, AlertTriangle, Terminal } from 'lucide-react';
import type { Approval } from '../../types/index.js';
import { Button } from '../ui/Button.js';

interface ApprovalBannerProps {
  approvals: Approval[];
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
}

export const ApprovalBanner: React.FC<ApprovalBannerProps> = ({
  approvals,
  onApprove,
  onReject,
}) => {
  if (!approvals || approvals.length === 0) return null;
  const current = approvals[0];

  return (
    <div className="approval-gate-banner">
      <div className="approval-gate-main">
        <div className="approval-gate-icon">
          <ShieldAlert size={20} />
        </div>
        <div className="approval-gate-info">
          <div className="approval-gate-title">
            <span>Human Approval Required</span>
            <span className="gate-tag">Action-Level Gate</span>
          </div>
          <div className="approval-gate-desc">{current.details}</div>
          {current.command && (
            <div className="approval-gate-command">
              <Terminal size={12} className="text-muted" />
              <code>{current.command}</code>
            </div>
          )}
        </div>
      </div>

      <div className="approval-gate-actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<X size={13} />}
          onClick={() => onReject(current.id)}
        >
          Reject
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<Check size={13} />}
          style={{
            background: 'linear-gradient(180deg, #10b981 0%, #059669 100%)',
            borderColor: 'rgba(255, 255, 255, 0.2)',
          }}
          onClick={() => onApprove(current.id)}
        >
          Approve Action
        </Button>
      </div>
    </div>
  );
};

