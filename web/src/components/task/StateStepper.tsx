import React from 'react';
import {
  Search,
  BrainCircuit,
  Layers,
  Play,
  ShieldCheck,
  Wrench,
  CheckCircle2,
  AlertOctagon,
  ShieldAlert,
  XCircle,
  HelpCircle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { Step } from '../../types/index.js';

interface StateStepperProps {
  currentStatus: string;
  steps?: Step[];
}

export const StateStepper: React.FC<StateStepperProps> = ({ currentStatus, steps = [] }) => {
  const norm = (currentStatus || '').toLowerCase();

  // Core pipeline sequence
  const pipeline = [
    { key: 'discovering', label: 'Discover', icon: <Search size={12} /> },
    { key: 'planning', label: 'Plan', icon: <BrainCircuit size={12} /> },
    { key: 'ready', label: 'Ready', icon: <Layers size={12} /> },
    { key: 'executing', label: 'Execute', icon: <Play size={12} /> },
    { key: 'verifying', label: 'Verify', icon: <ShieldCheck size={12} /> },
  ];

  // Evaluate state conditions
  const isCompleted = norm === 'completed';
  const isFailed = norm === 'failed' || norm === 'blocked';
  const isCancelled = ['cancelling', 'cancelled'].includes(norm);
  const isRepairing = ['diagnosing', 'repairing'].includes(norm);
  const isAwaitingApproval = norm === 'awaiting_approval';
  const isNeedsReview = norm === 'needs_human_review';

  // Helper to determine stage status truthfully based on task status & steps evidence
  const getStageState = (stageKey: string): 'completed' | 'active' | 'pending' => {
    if (isCompleted) return 'completed';

    // If currently on this stage:
    if (norm === stageKey) return 'active';

    // Hierarchy of stages:
    // 0: discovering, 1: planning, 2: ready, 3: executing, 4: verifying
    const stageOrder: Record<string, number> = {
      discovering: 0,
      planning: 1,
      ready: 2,
      executing: 3,
      verifying: 4,
    };

    const currentOrder = stageOrder[norm];

    if (currentOrder !== undefined && currentOrder > stageOrder[stageKey]) {
      return 'completed';
    }

    // For branch states (repairing, awaiting_approval, needs_review, failed, cancelled),
    // retain known completed progress rather than wiping it!
    if (isRepairing) {
      // In repair/diagnosis: Discover, Plan, Ready, Execute have completed at least one cycle
      if (['discovering', 'planning', 'ready', 'executing'].includes(stageKey)) {
        return 'completed';
      }
    }

    if (isAwaitingApproval || isNeedsReview) {
      // Approval happens during execution: Discover, Plan, Ready are completed
      if (['discovering', 'planning', 'ready'].includes(stageKey)) {
        return 'completed';
      }
      if (stageKey === 'executing') return 'active';
    }

    if (isFailed || isCancelled) {
      // If we have completed steps in the records, preserve them!
      const hasCompletedSteps = steps.some((s) => s.status === 'COMPLETED');
      if (['discovering', 'planning'].includes(stageKey)) return 'completed';
      if (stageKey === 'ready') return 'completed';
      if (stageKey === 'executing' && hasCompletedSteps) return 'completed';
    }

    return 'pending';
  };

  return (
    <div className="state-stepper-container" role="region" aria-label="Orchestration Execution Pipeline">
      <div className="stepper-track">
        {pipeline.map((stage, idx) => {
          const state = getStageState(stage.key);
          const isActive = state === 'active';
          const isDone = state === 'completed';

          return (
            <React.Fragment key={stage.key}>
              <motion.div
                layout="position"
                animate={
                  isActive
                    ? {
                        scale: [1, 1.025, 1],
                        boxShadow: [
                          '0 0 0 rgba(139, 124, 255, 0)',
                          '0 0 14px rgba(139, 124, 255, 0.35)',
                          '0 0 0 rgba(139, 124, 255, 0)',
                        ],
                      }
                    : {}
                }
                transition={
                  isActive
                    ? { repeat: Infinity, duration: 2.4, ease: 'easeInOut' }
                    : { duration: 0.2 }
                }
                className={`stepper-node ${state}`}
              >
                <span className="node-icon">
                  {isDone ? (
                    <motion.span
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                      style={{ display: 'inline-flex' }}
                    >
                      <CheckCircle2 size={12} style={{ color: 'var(--status-success)' }} />
                    </motion.span>
                  ) : (
                    stage.icon
                  )}
                </span>
                <span className="node-label">{stage.label}</span>
              </motion.div>

              {/* Progress Connector Line */}
              <div className="stepper-line-wrapper">
                <div className="stepper-line-bg" />
                <motion.div
                  className="stepper-line-fill"
                  initial={false}
                  animate={{
                    width: isDone ? '100%' : isActive ? '50%' : '0%',
                  }}
                  transition={{ duration: 0.35, ease: 'easeInOut' }}
                />
              </div>
            </React.Fragment>
          );
        })}

        {/* Dynamic Branch Nodes: Approval / Repair / Review / Failed / Cancelled */}
        <AnimatePresence mode="popLayout">
          {isAwaitingApproval && (
            <motion.div
              key="approval"
              initial={{ opacity: 0, scale: 0.85, x: -6 }}
              animate={{
                opacity: 1,
                scale: 1,
                x: 0,
                boxShadow: [
                  '0 0 0 rgba(251, 191, 36, 0)',
                  '0 0 15px rgba(251, 191, 36, 0.4)',
                  '0 0 0 rgba(251, 191, 36, 0)',
                ],
              }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{
                boxShadow: { repeat: Infinity, duration: 1.8, ease: 'easeInOut' },
                duration: 0.25,
              }}
              className="stepper-node active-amber"
            >
              <span className="node-icon"><ShieldAlert size={12} /></span>
              <span className="node-label">Approval Gate</span>
            </motion.div>
          )}

          {isRepairing && (
            <motion.div
              key="repair"
              initial={{ opacity: 0, scale: 0.85, x: -6 }}
              animate={{
                opacity: 1,
                scale: 1,
                x: 0,
                boxShadow: [
                  '0 0 0 rgba(167, 139, 250, 0)',
                  '0 0 16px rgba(167, 139, 250, 0.45)',
                  '0 0 0 rgba(167, 139, 250, 0)',
                ],
              }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{
                boxShadow: { repeat: Infinity, duration: 2, ease: 'easeInOut' },
                duration: 0.25,
              }}
              className="stepper-node active-repair"
            >
              <span className="node-icon"><Wrench size={12} /></span>
              <span className="node-label">
                {norm === 'diagnosing' ? 'Diagnosing' : 'Self-Repair'}
              </span>
            </motion.div>
          )}

          {isNeedsReview && (
            <motion.div
              key="review"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              className="stepper-node active-purple"
            >
              <span className="node-icon"><HelpCircle size={12} /></span>
              <span className="node-label">Review Required</span>
            </motion.div>
          )}

          {isFailed && (
            <motion.div
              key="failed"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              className="stepper-node failed"
            >
              <span className="node-icon"><AlertOctagon size={12} /></span>
              <span className="node-label">Failed Closed</span>
            </motion.div>
          )}

          {isCancelled && (
            <motion.div
              key="cancelled"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              className="stepper-node cancelled"
            >
              <span className="node-icon"><XCircle size={12} /></span>
              <span className="node-label">Cancelled</span>
            </motion.div>
          )}

          {/* Final Verified Completion Node */}
          {!isAwaitingApproval && !isRepairing && !isNeedsReview && !isFailed && !isCancelled && (
            <motion.div
              key="final-node"
              layout="position"
              className={`stepper-node ${isCompleted ? 'completed' : 'pending'}`}
            >
              <span className="node-icon">
                {isCompleted ? (
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 22 }}
                    style={{ display: 'inline-flex' }}
                  >
                    <CheckCircle2 size={12} style={{ color: 'var(--status-success)' }} />
                  </motion.span>
                ) : (
                  <CheckCircle2 size={12} />
                )}
              </span>
              <span className="node-label">Verified</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
