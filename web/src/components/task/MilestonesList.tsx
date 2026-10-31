import React from 'react';
import {
  Layers,
  FileCode,
  CheckCircle2,
  AlertCircle,
  Clock,
  Play,
  RotateCcw,
  Sparkles,
  ArrowRight,
} from 'lucide-react';
import type { PlanStep, Step } from '../../types/index.js';
import { Badge } from '../ui/Badge.js';

interface MilestonesListProps {
  planSteps: PlanStep[];
  stepRecords: Step[];
  summary?: string;
  analysis?: string;
}

export const MilestonesList: React.FC<MilestonesListProps> = ({
  planSteps,
  stepRecords,
  summary,
  analysis,
}) => {
  if (!planSteps || planSteps.length === 0) {
    return null;
  }

  return (
    <div className="milestones-card">
      <div className="card-section-header">
        <div className="section-heading">
          <Layers size={15} className="text-indigo" />
          <span>Execution Plan & Decomposed Milestones</span>
          <span className="count-pill">{planSteps.length} steps</span>
        </div>
      </div>

      {(analysis || summary) && (
        <div className="plan-analysis-box">
          <Sparkles size={14} className="text-indigo-light" />
          <p>{analysis || summary}</p>
        </div>
      )}

      <div className="milestone-steps-list">
        {planSteps.map((step) => {
          const record = stepRecords?.find((s) => s.stepIndex === step.index);
          const status = record?.status || 'PENDING';
          const isCompleted = status === 'COMPLETED';
          const isRunning = status === 'RUNNING';
          const isFailed = status === 'FAILED';

          return (
            <div
              key={step.index}
              className={`milestone-step-item ${isRunning ? 'running' : ''} ${
                isCompleted ? 'completed' : ''
              } ${isFailed ? 'failed' : ''}`}
            >
              <div className="step-index-badge">
                {isCompleted ? (
                  <CheckCircle2 size={13} className="text-emerald" />
                ) : (
                  <span>{step.index}</span>
                )}
              </div>

              <div className="step-body">
                <div className="step-header-line">
                  <span className="step-title">{step.title}</span>
                  <Badge status={status} size="sm" />
                </div>

                <div className="step-instruction">{step.instruction}</div>

                {/* Target Files & Dependencies */}
                <div className="step-tags-row">
                  {step.targetFiles && step.targetFiles.length > 0 && (
                    <div className="file-tags-group">
                      {step.targetFiles.map((file) => (
                        <span key={file} className="file-tag" title={`Target file: ${file}`}>
                          <FileCode size={11} />
                          <span>{file}</span>
                        </span>
                      ))}
                    </div>
                  )}

                  {step.dependencies && step.dependencies.length > 0 && (
                    <div className="dependency-tag" title="Step dependencies">
                      <span>Depends on: {step.dependencies.map((d) => `#${d}`).join(', ')}</span>
                    </div>
                  )}

                  {record?.agent && (
                    <span className="agent-tag" title="Agent assigned">
                      Agent: {record.agent}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

