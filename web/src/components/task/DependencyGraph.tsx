import React from 'react';
import { GitCommit, CheckCircle2, Clock } from 'lucide-react';
import { motion } from 'motion/react';
import type { PlanStep, Step } from '../../types/index.js';
import { springs } from '../../lib/motion.js';

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
      transition={{ duration: 0.28, ease: 'easeOut' }}
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
                initial={{ opacity: 0, scale: 0.92, y: 6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{
                  opacity: { delay: idx * 0.04, duration: 0.2 },
                  scale: { delay: idx * 0.04, duration: 0.2 },
                }}
                whileHover={{ y: -3, scale: 1.02, transition: { duration: 0.15 } }}
                className={`graph-node ${isDone ? 'done' : ''} ${isRunning ? 'running' : ''}`}
                title={`${step.title} (${status})`}
              >
                <div className="graph-node-header">
                  <span className="node-num">#{step.index}</span>
                  {isDone ? (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={springs.pop}
                    >
                      <CheckCircle2 size={11} style={{ color: 'var(--status-success)' }} />
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
                  <svg width="32" height="14" viewBox="0 0 32 14" className="connector-svg">
                    <line
                      x1="0"
                      y1="7"
                      x2="24"
                      y2="7"
                      stroke={
                        isDone
                          ? 'var(--status-success)'
                          : isRunning
                          ? 'var(--accent-secondary)'
                          : 'rgba(255, 255, 255, 0.14)'
                      }
                      strokeWidth="2"
                      strokeDasharray={isDone ? 'none' : '4 3'}
                      className={isRunning ? 'flowing-line' : ''}
                    />
                    <polygon
                      points="24,4 30,7 24,10"
                      fill={
                        isDone
                          ? 'var(--status-success)'
                          : isRunning
                          ? 'var(--accent-secondary)'
                          : 'rgba(255, 255, 255, 0.2)'
                      }
                    />
                    {/* Flowing photon particle along active running line */}
                    {isRunning && (
                      <circle r="2.5" fill="#38BDF8" className="flowing-photon">
                        <animateMotion
                          path="M 0 7 L 24 7"
                          dur="1.4s"
                          repeatCount="indefinite"
                        />
                      </circle>
                    )}
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
