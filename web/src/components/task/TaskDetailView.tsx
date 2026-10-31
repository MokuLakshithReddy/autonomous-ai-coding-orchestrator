import React, { useState } from 'react';
import {
  GitBranch,
  ShieldCheck,
  RotateCcw,
  Clock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Cpu,
  StopCircle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { Task, Step, Verification, Approval, ExecutionPlan } from '../../types/index.js';
import { StateStepper } from './StateStepper.js';
import { ApprovalBanner } from './ApprovalBanner.js';
import { MilestonesList } from './MilestonesList.js';
import { DependencyGraph } from './DependencyGraph.js';
import { AcceptanceCriteriaList } from './AcceptanceCriteriaList.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { formatDuration } from '../../lib/formatters.js';
import { transitions, springs } from '../../lib/motion.js';

interface TaskDetailViewProps {
  task: Task;
  steps: Step[];
  verifications: Verification[];
  pendingApprovals: Approval[];
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
  onCancelTask: (taskId: string) => void;
}

export const TaskDetailView: React.FC<TaskDetailViewProps> = ({
  task,
  steps,
  verifications,
  pendingApprovals,
  onApprove,
  onReject,
  onCancelTask,
}) => {
  const [cancelling, setCancelling] = useState(false);

  let plan: ExecutionPlan | null = null;
  try {
    if (task.planJson) {
      plan = JSON.parse(task.planJson);
    }
  } catch (err) {
    console.warn('Failed to parse planJson:', err);
  }

  const isCompleted = task.status.toLowerCase() === 'completed';
  const isCancellable = [
    'discovering',
    'planning',
    'ready',
    'executing',
    'verifying',
    'diagnosing',
    'repairing',
    'awaiting_approval',
  ].includes(task.status.toLowerCase());

  const handleCancel = async () => {
    if (confirm(`Are you sure you want to cancel task "${task.title}"?`)) {
      setCancelling(true);
      await onCancelTask(task.id);
      setCancelling(false);
    }
  };

  return (
    <motion.div
      key={task.id}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      className="task-detail-container"
    >
      {/* Task Top Action Bar */}
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="task-detail-header"
      >
        <div className="task-title-area">
          <div className="task-title-row">
            <h1 className="task-headline-text">{task.title}</h1>
            <Badge status={task.status} size="md" />
          </div>

          <p className="task-prompt-text">{task.prompt}</p>

          <div className="task-metadata-bar">
            <span className="meta-item" title="Task ID">
              <span className="meta-icon">#</span>
              <code>{task.id}</code>
            </span>

            <span className="meta-item" title="Git Task Branch">
              <GitBranch
                size={12}
                className="meta-icon"
                style={{ color: 'var(--accent-secondary)' }}
              />
              <span>task/{task.id.slice(0, 8)}</span>
            </span>

            <span className="meta-item" title="Execution Duration">
              <Clock size={12} className="meta-icon" />
              <span>{formatDuration(task.createdAt, task.updatedAt)}</span>
            </span>

            {task.retryCount > 0 && (
              <span
                className="meta-item"
                style={{ color: 'var(--status-warning)' }}
                title="Self-Repair Retries"
              >
                <RotateCcw size={12} className="meta-icon" />
                <span>
                  Retries: {task.retryCount} / {task.maxRetries}
                </span>
              </span>
            )}
          </div>
        </div>

        {/* Action Controls */}
        <div className="task-header-actions">
          {isCancellable && (
            <Button
              variant="danger"
              size="sm"
              icon={<StopCircle size={13} />}
              loading={cancelling}
              onClick={handleCancel}
            >
              Cancel Run
            </Button>
          )}
        </div>
      </motion.div>

      {/* State Machine Transition Visualizer with Steps Evidence */}
      <StateStepper currentStatus={task.status} steps={steps} />

      {/* Scrollable Center Content */}
      <div className="task-detail-body">
        {/* Human-in-the-loop Approval Banner */}
        <ApprovalBanner
          approvals={pendingApprovals}
          onApprove={onApprove}
          onReject={onReject}
        />

        {/* Verified Outcome Summary (Highlighted on completion) */}
        {task.summary && (
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={transitions.standard}
            className={`verified-summary-card ${isCompleted ? 'completed' : ''}`}
          >
            <div className="summary-header">
              <CheckCircle2 size={16} style={{ color: 'var(--status-success)' }} />
              <span className="summary-title">Verified Outcome & Repair Summary</span>
            </div>
            <p className="summary-body">{task.summary}</p>
          </motion.div>
        )}

        {/* Dependency Flow Graph */}
        {plan?.steps && plan.steps.length > 1 && (
          <DependencyGraph steps={plan.steps} stepRecords={steps} />
        )}

        {/* Plan Milestones & Steps */}
        {plan?.steps && (
          <MilestonesList
            planSteps={plan.steps}
            stepRecords={steps}
            summary={plan.summary}
            analysis={plan.analysis}
          />
        )}

        {/* Independent Acceptance Criteria */}
        {plan?.acceptanceCriteria && (
          <AcceptanceCriteriaList
            criteria={plan.acceptanceCriteria}
            taskStatus={task.status}
          />
        )}
      </div>
    </motion.div>
  );
};
