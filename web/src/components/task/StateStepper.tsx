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
import { springs } from '../../lib/motion.js';

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

  // Evaluate state conditions truthfully
  const isCompleted = norm === 'completed';
  const isFailed = norm === 'failed' || norm === 'blocked';
  const isCancelled = ['cancelling', 'cancelled'].includes(norm);
  const isRepairing = ['diagnosing', 'repairing'].includes(norm);
  const isAwaitingApproval = norm === 'awaiting_approval';
  const isNeedsReview = norm === 'needs_human_review';

  // Section 3: Respect Real Application States
  // Execution animations only run when a task is genuinely in active operation!
  const isTaskActivelyExecuting = [
    'discovering',
    'planning',
    'ready',
    'executing',
    'verifying',
    'diagnosing',
    'repairing',
    'awaiting_approval',
  ].includes(norm);

  // Helper to determine stage status truthfully based on task status & step records
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
      if (['discovering', 'planning', 'ready', 'executing'].includes(stageKey)) {
        return 'completed';
      }
    }

    if (isAwaitingApproval || isNeedsReview) {
      if (['discovering', 'planning', 'ready'].includes(stageKey)) {
        return 'completed';
      }
      if (stageKey === 'executing') return 'active';
    }

    if (isFailed || isCancelled) {
      const hasCompletedSteps = steps.some((s) => s.status === 'COMPLETED');
      if (['discovering', 'planning'].includes(stageKey)) return 'completed';
      if (stageKey === 'ready') return 'completed';
      if (stageKey === 'executing' && hasCompletedSteps) return 'completed';
    }

    return 'pending';
  };

  return (
    <div
      className="state-stepper-container"
      role="region"
      aria-label="Orchestration Execution Pipeline"
    >
      <div className="stepper-track">
        {pipeline.map((stage) => {
          const state = getStageState(stage.key);
          const isActive = state === 'active';
          const isDone = state === 'completed';
          // Strictly gate animations by genuine task execution status
          const isStageRunning = isActive && isTaskActivelyExecuting;

          return (
            <React.Fragment key={stage.key}>
              <motion.div
                layout="position"
                className={`stepper-node ${state} ${
                  isActive
                    ? stage.key === 'executing'
                      ? 'active-cyan'
                      : stage.key === 'verifying'
                      ? 'active-sky'
                      : 'active-violet'
                    : ''
                }`}
                style={{ position: 'relative' }}
              >
                {/* Active Execution Breathing Halo (GPU transform/opacity only) */}
                {isStageRunning && (
                  <motion.span
                    className={`active-pulse-halo ${
                      stage.key === 'executing'
                        ? 'halo-cyan'
                        : stage.key === 'verifying'
                        ? 'halo-sky'
                        : 'halo-violet'
                    }`}
                    animate={{
                      scale: [1, 1.25, 1],
                      opacity: [0.75, 0.2, 0.75],
                    }}
                    transition={{ repeat: Infinity, duration: 2.2, ease: 'easeInOut' }}
                  />
                )}

                <span className="node-icon">
                  {isDone ? (
                    <motion.span
                      initial={{ scale: 0.3, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={springs.pop}
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

              {/* Progress Connector Line with Flowing Beam Light */}
              <div className="stepper-line-wrapper">
                <div className="stepper-line-bg" />
                <motion.div
                  className={`stepper-line-fill ${isDone ? 'done' : isActive ? 'active' : ''}`}
                  initial={false}
                  animate={{
                    width: isDone ? '100%' : isActive ? '60%' : '0%',
                  }}
                  transition={{ duration: 0.35, ease: 'easeInOut' }}
                />
                {/* Traveling beam only active when stage is genuinely running */}
                {isStageRunning && <div className="connector-traveling-beam" />}
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
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ duration: 0.25 }}
              className="stepper-node active-amber"
              style={{ position: 'relative' }}
            >
              {isTaskActivelyExecuting && (
                <motion.span
                  className="active-pulse-halo halo-amber"
                  animate={{ scale: [1, 1.25, 1], opacity: [0.8, 0.2, 0.8] }}
                  transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
                />
              )}
              <span className="node-icon">
                <ShieldAlert size={12} />
              </span>
              <span className="node-label">Approval Gate</span>
            </motion.div>
          )}

          {isRepairing && (
            <motion.div
              key="repair"
              initial={{ opacity: 0, scale: 0.85, x: -6 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ duration: 0.25 }}
              className="stepper-node active-repair"
              style={{ position: 'relative' }}
            >
              {isTaskActivelyExecuting && (
                <motion.span
                  className="active-pulse-halo halo-repair"
                  animate={{ scale: [1, 1.25, 1], opacity: [0.8, 0.2, 0.8] }}
                  transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
                />
              )}
              <motion.span
                className="node-icon"
                animate={isTaskActivelyExecuting ? { rotate: [-8, 8, -8] } : undefined}
                transition={{ repeat: Infinity, duration: 2.4, ease: 'easeInOut' }}
              >
                <Wrench size={12} />
              </motion.span>
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
              <span className="node-icon">
                <HelpCircle size={12} />
              </span>
              <span className="node-label">Review Required</span>
            </motion.div>
          )}

          {isFailed && (
            <motion.div
              key="failed"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{
                opacity: 1,
                scale: 1,
                x: [0, -4, 4, -2, 2, 0],
              }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ duration: 0.35 }}
              className="stepper-node failed"
            >
              <span className="node-icon">
                <AlertOctagon size={12} />
              </span>
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
              <span className="node-icon">
                <XCircle size={12} />
              </span>
              <span className="node-label">Cancelled</span>
            </motion.div>
          )}

          {/* Final Verified Completion Node */}
          {!isAwaitingApproval && !isRepairing && !isNeedsReview && !isFailed && !isCancelled && (
            <motion.div
              key="final-node"
              layout="position"
              className={`stepper-node ${isCompleted ? 'completed verified-success' : 'pending'}`}
            >
              <span className="node-icon">
                {isCompleted ? (
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={springs.pop}
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
