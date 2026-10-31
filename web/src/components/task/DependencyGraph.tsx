import React from 'react';
import { GitCommit, ArrowRight, CheckCircle2, Clock } from 'lucide-react';
import { motion } from 'motion/react';
import type { PlanStep, Step } from '../../types/index.js';

interface DependencyGraphProps {
  steps: PlanStep[];
  stepRecords: Step[];
}

export const DependencyGraph: React.FC<DependencyGraphProps> = ({ steps, stepRecords }) => {
  if (!steps || steps.length <= 1) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="dependency-graph-card"
    >
      <div className="graph-title-row">
        <GitCommit size={14} className="text-sky" />
        <span>Execution Graph & Dependencies</span>
      </div>

      <div className="graph-flow-container">
        {steps.map((step, idx) => {
          const record = stepRecords?.find((s) => s.stepIndex === step.index);
          const status = record?.status || 'PENDING';
          const isDone = status === 'COMPLETED';
          const isRunning = status === 'RUNNING';

          return (
            <div key={step.index} className="graph-node-wrapper">
              <motion.div
                whileHover={{ y: -2, transition: { duration: 0.15 } }}
                animate={
                  isRunning
                    ? {
                        boxShadow: [
                          '0 0 0 rgba(14, 165, 233, 0)',
                          '0 0 12px rgba(14, 165, 233, 0.4)',
                          '0 0 0 rgba(14, 165, 233, 0)',
                        ],
                      }
                    : {}
                }
                transition={
                  isRunning
                    ? { repeat: Infinity, duration: 2, ease: 'easeInOut' }
                    : { duration: 0.2 }
                }
                className={`graph-node ${isDone ? 'done' : ''} ${isRunning ? 'running' : ''}`}
                title={`${step.title} (${status})`}
              >
                <div className="graph-node-header">
                  <span className="node-num">#{step.index}</span>
                  {isDone ? (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                    >
                      <CheckCircle2 size={11} className="text-emerald" />
                    </motion.span>
                  ) : isRunning ? (
                    <span className="mini-pulse-dot" />
                  ) : (
                    <Clock size={11} className="text-muted" />
                  )}
                </div>
                <div className="graph-node-label">{step.title}</div>
              </motion.div>

              {idx < steps.length - 1 && (
                <div className="graph-arrow-connector">
                  <svg width="28" height="12" viewBox="0 0 28 12" className="connector-svg">
                    <line
                      x1="0"
                      y1="6"
                      x2="22"
                      y2="6"
                      stroke={isDone ? 'var(--accent-emerald)' : 'rgba(255, 255, 255, 0.12)'}
                      strokeWidth="2"
                      strokeDasharray={isDone ? 'none' : '4 3'}
                      className={isRunning ? 'flowing-line' : ''}
                    />
                    <polygon
                      points="22,3 27,6 22,9"
                      fill={isDone ? 'var(--accent-emerald)' : 'rgba(255, 255, 255, 0.18)'}
                    />
                  </svg>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </motion.div>
  );
};
