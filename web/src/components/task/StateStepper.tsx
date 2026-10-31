import React from 'react';
import {
  Search,
  BrainCircuit,
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

interface StateStepperProps {
  currentStatus: string;
}

export const StateStepper: React.FC<StateStepperProps> = ({ currentStatus }) => {
  const norm = (currentStatus || '').toLowerCase();

  const standardPipeline = [
    { key: 'discovering', label: 'Discover', icon: <Search size={12} /> },
    { key: 'planning', label: 'Plan', icon: <BrainCircuit size={12} /> },
    { key: 'executing', label: 'Execute', icon: <Play size={12} /> },
    { key: 'verifying', label: 'Verify', icon: <ShieldCheck size={12} /> },
  ];

  const isRepairing = ['diagnosing', 'repairing'].includes(norm);
  const isAwaitingApproval = norm === 'awaiting_approval';
  const isNeedsReview = norm === 'needs_human_review';
  const isFailed = norm === 'failed';
  const isCompleted = norm === 'completed';
  const isCancelled = ['cancelling', 'cancelled'].includes(norm);

  return (
    <div className="state-stepper-container">
      <div className="stepper-track">
        {standardPipeline.map((step, idx) => {
          let state: 'completed' | 'active' | 'pending' = 'pending';

          if (isCompleted) {
            state = 'completed';
          } else if (norm === step.key) {
            state = 'active';
          } else if (
            (step.key === 'discovering' && ['planning', 'ready', 'executing', 'verifying', 'diagnosing', 'repairing'].includes(norm)) ||
            (step.key === 'planning' && ['ready', 'executing', 'verifying', 'diagnosing', 'repairing'].includes(norm)) ||
            (step.key === 'executing' && ['verifying', 'diagnosing', 'repairing'].includes(norm))
          ) {
            state = 'completed';
          }

          const isActive = state === 'active';
          const isDone = state === 'completed';

          return (
            <React.Fragment key={step.key}>
              <motion.div
                layout="position"
                animate={
                  isActive
                    ? {
                        scale: [1, 1.02, 1],
                        boxShadow: [
                          '0 0 0 rgba(99, 102, 241, 0)',
                          '0 0 14px rgba(99, 102, 241, 0.35)',
                          '0 0 0 rgba(99, 102, 241, 0)',
                        ],
                      }
                    : {}
                }
                transition={
                  isActive
                    ? {
                        repeat: Infinity,
                        duration: 2.5,
                        ease: 'easeInOut',
                      }
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
                      <CheckCircle2 size={12} className="text-emerald" />
                    </motion.span>
                  ) : (
                    step.icon
                  )}
                </span>
                <span className="node-label">{step.label}</span>
              </motion.div>

              {/* Animated Progress Connection */}
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

        {/* Dynamic Branch Nodes with Smooth Entrance */}
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
                  '0 0 0 rgba(245, 158, 11, 0)',
                  '0 0 15px rgba(245, 158, 11, 0.4)',
                  '0 0 0 rgba(245, 158, 11, 0)',
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
                  '0 0 0 rgba(236, 72, 153, 0)',
                  '0 0 16px rgba(236, 72, 153, 0.45)',
                  '0 0 0 rgba(236, 72, 153, 0)',
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
              <span className="node-label">Failed</span>
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

          {/* Final Completion Node */}
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
                    <CheckCircle2 size={12} />
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
