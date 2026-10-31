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

  // Check if we are in repair loop
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

          return (
            <React.Fragment key={step.key}>
              <div className={`stepper-node ${state}`}>
                <span className="node-icon">{step.icon}</span>
                <span className="node-label">{step.label}</span>
              </div>
              <div className={`stepper-line ${state === 'completed' ? 'completed' : ''}`} />
            </React.Fragment>
          );
        })}

        {/* Dynamic State Branch: Repair / Approval / Outcome */}
        {isAwaitingApproval && (
          <div className="stepper-node active-amber">
            <span className="node-icon"><ShieldAlert size={12} /></span>
            <span className="node-label">Approval Gate</span>
          </div>
        )}

        {isRepairing && (
          <div className="stepper-node active-repair">
            <span className="node-icon"><Wrench size={12} /></span>
            <span className="node-label">{norm === 'diagnosing' ? 'Diagnosing' : 'Self-Repair'}</span>
          </div>
        )}

        {isNeedsReview && (
          <div className="stepper-node active-purple">
            <span className="node-icon"><HelpCircle size={12} /></span>
            <span className="node-label">Review Required</span>
          </div>
        )}

        {isFailed && (
          <div className="stepper-node failed">
            <span className="node-icon"><AlertOctagon size={12} /></span>
            <span className="node-label">Failed</span>
          </div>
        )}

        {isCancelled && (
          <div className="stepper-node cancelled">
            <span className="node-icon"><XCircle size={12} /></span>
            <span className="node-label">Cancelled</span>
          </div>
        )}

        {/* Final Completion Node */}
        {!isAwaitingApproval && !isRepairing && !isNeedsReview && !isFailed && !isCancelled && (
          <div className={`stepper-node ${isCompleted ? 'completed' : 'pending'}`}>
            <span className="node-icon"><CheckCircle2 size={12} /></span>
            <span className="node-label">Verified</span>
          </div>
        )}
      </div>
    </div>
  );
};

