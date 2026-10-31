import React from 'react';
import { ShieldAlert, Check, X, AlertTriangle, Terminal } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { Approval } from '../../types/index.js';
import { Button } from '../ui/Button.js';
import { springs } from '../../lib/motion.js';

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
    <AnimatePresence mode="wait">
      <motion.div
        key={current.id}
        initial={{ opacity: 0, y: -8, scale: 0.98 }}
        animate={{
          opacity: 1,
          y: 0,
          scale: 1,
          boxShadow: [
            '0 0 0 rgba(251, 191, 36, 0)',
            '0 0 18px rgba(251, 191, 36, 0.25)',
            '0 0 0 rgba(251, 191, 36, 0)',
          ],
        }}
        exit={{ opacity: 0, y: -6, scale: 0.98 }}
        transition={{
          boxShadow: { repeat: Infinity, duration: 2.2, ease: 'easeInOut' },
          duration: 0.25,
        }}
        className="approval-gate-banner"
      >
        <div className="approval-gate-main">
          <motion.div
            className="approval-gate-icon"
            animate={{ scale: [1, 1.1, 1] }}
            transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
          >
            <ShieldAlert size={20} />
          </motion.div>
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
              background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
              borderColor: 'rgba(255, 255, 255, 0.2)',
            }}
            onClick={() => onApprove(current.id)}
          >
            Approve Action
          </Button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
