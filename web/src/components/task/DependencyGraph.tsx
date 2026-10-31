import React from 'react';
import { GitCommit, ArrowRight, CheckCircle2, Clock, AlertCircle } from 'lucide-react';
import type { PlanStep, Step } from '../../types/index.js';

interface DependencyGraphProps {
  steps: PlanStep[];
  stepRecords: Step[];
}

export const DependencyGraph: React.FC<DependencyGraphProps> = ({ steps, stepRecords }) => {
  if (!steps || steps.length <= 1) return null;

  return (
    <div className="dependency-graph-card">
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
              <div
                className={`graph-node ${isDone ? 'done' : ''} ${isRunning ? 'running' : ''}`}
                title={`${step.title} (${status})`}
              >
                <div className="graph-node-header">
                  <span className="node-num">#{step.index}</span>
                  {isDone ? (
                    <CheckCircle2 size={11} className="text-emerald" />
                  ) : isRunning ? (
                    <span className="mini-pulse-dot" />
                  ) : (
                    <Clock size={11} className="text-muted" />
                  )}
                </div>
                <div className="graph-node-label">{step.title}</div>
              </div>

              {idx < steps.length - 1 && (
                <div className="graph-arrow-connector">
                  <div className={`connector-bar ${isDone ? 'done' : ''}`} />
                  <ArrowRight size={12} className={`connector-arrow ${isDone ? 'done' : ''}`} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

