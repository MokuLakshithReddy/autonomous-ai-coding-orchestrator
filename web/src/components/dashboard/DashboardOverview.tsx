import React, { useState, useEffect, useRef } from 'react';
import {
  Activity,
  CheckCircle2,
  XCircle,
  RotateCcw,
  ShieldCheck,
  Cpu,
  Layers,
  Box,
  FolderGit2,
  ArrowUpRight,
  Plus,
  Sparkles,
} from 'lucide-react';
import { motion } from 'motion/react';
import type { Task, SystemStatus, RepoMeta } from '../../types/index.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { formatDateRel } from '../../lib/formatters.js';
import { transitions, springs } from '../../lib/motion.js';

interface DashboardOverviewProps {
  tasks: Task[];
  systemStatus: SystemStatus | null;
  repoMeta: RepoMeta | null;
  onSelectTask: (id: string) => void;
  onOpenNewTask: () => void;
}

/**
 * AnimatedNumber
 * Smooth count-up integer transition when metric value genuinely changes.
 * Avoids animating if value did not change.
 */
const AnimatedNumber: React.FC<{ value: number }> = ({ value }) => {
  const [displayValue, setDisplayValue] = useState(value);
  const prevValueRef = useRef(value);

  useEffect(() => {
    const prev = prevValueRef.current;
    if (prev === value) return;
    prevValueRef.current = value;

    const start = performance.now();
    const duration = 550; // ms

    let animId: number;
    const step = (timestamp: number) => {
      const elapsed = timestamp - start;
      const progress = Math.min(elapsed / duration, 1);
      // easeOutExpo for crisp developer feeling
      const ease = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      const current = Math.round(prev + (value - prev) * ease);
      setDisplayValue(current);

      if (progress < 1) {
        animId = requestAnimationFrame(step);
      }
    };

    animId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animId);
  }, [value]);

  return <span>{displayValue}</span>;
};

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({
  tasks,
  systemStatus,
  repoMeta,
  onSelectTask,
  onOpenNewTask,
}) => {
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((t) => t.status.toLowerCase() === 'completed');
  const failedTasks = tasks.filter((t) => ['failed', 'blocked'].includes(t.status.toLowerCase()));
  const activeTasks = tasks.filter((t) =>
    [
      'discovering',
      'planning',
      'ready',
      'executing',
      'verifying',
      'diagnosing',
      'repairing',
      'awaiting_approval',
    ].includes(t.status.toLowerCase())
  );
  const repairedTasks = tasks.filter(
    (t) => t.status.toLowerCase() === 'completed' && t.retryCount > 0
  );

  // Truthful calculation: if no tasks exist, show '--' rather than 100% or 0%
  const verificationSuccessRate =
    totalTasks > 0 ? `${Math.round((completedTasks.length / totalTasks) * 100)}%` : '--';

  return (
    <div className="dashboard-overview-container">
      {/* Overview Banner with Ambient Gradient Flow */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitions.standard}
        className="overview-hero-card"
        style={{ position: 'relative', overflow: 'hidden' }}
      >
        {/* Subtle Decorative Light Beam Accent */}
        <div className="hero-light-beam" />

        <div className="hero-content">
          <div className="hero-badge">
            <span className="hero-pulse-dot" />
            <span>Autonomous Orchestration Core v1.0.0</span>
          </div>
          <h1 className="hero-title">Engineering Observability & Execution Control</h1>
          <p className="hero-description">
            Closed-loop planning, isolated container sandboxing, independent test verification, and automated failure repair.
          </p>
        </div>

        <div className="hero-actions">
          <Button
            variant="primary"
            size="md"
            icon={<Plus size={15} />}
            onClick={onOpenNewTask}
          >
            Launch Autonomous Mission
          </Button>
        </div>
      </motion.div>

      {/* Metric Cards Grid with Count-Up & Soft Elevation */}
      <div className="metrics-grid">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.04, ...transitions.standard }}
          whileHover={{ y: -3, transition: { duration: 0.16 } }}
          className="metric-card"
        >
          <div className="metric-header">
            <span className="metric-title">Active Missions</span>
            <Activity size={16} style={{ color: 'var(--accent-secondary)' }} />
          </div>
          <div className="metric-value">
            <AnimatedNumber value={activeTasks.length} />
          </div>
          <div className="metric-subtext">Currently executing in isolated worktrees</div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, ...transitions.standard }}
          whileHover={{ y: -3, transition: { duration: 0.16 } }}
          className="metric-card"
        >
          <div className="metric-header">
            <span className="metric-title">Verified Passed</span>
            <CheckCircle2 size={16} style={{ color: 'var(--status-success)' }} />
          </div>
          <div className="metric-value" style={{ color: 'var(--status-success)' }}>
            <AnimatedNumber value={completedTasks.length} />
          </div>
          <div className="metric-subtext">
            {verificationSuccessRate !== '--'
              ? `${verificationSuccessRate} verified completion rate`
              : 'No missions recorded yet'}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12, ...transitions.standard }}
          whileHover={{ y: -3, transition: { duration: 0.16 } }}
          className="metric-card"
        >
          <div className="metric-header">
            <span className="metric-title">Self-Repair Recoveries</span>
            <RotateCcw size={16} style={{ color: 'var(--status-repair)' }} />
          </div>
          <div className="metric-value" style={{ color: 'var(--status-repair)' }}>
            <AnimatedNumber value={repairedTasks.length} />
          </div>
          <div className="metric-subtext">Autonomously resolved compilation/test regressions</div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.16, ...transitions.standard }}
          whileHover={{ y: -3, transition: { duration: 0.16 } }}
          className="metric-card"
        >
          <div className="metric-header">
            <span className="metric-title">Failed / Blocked</span>
            <XCircle size={16} style={{ color: 'var(--status-danger)' }} />
          </div>
          <div className="metric-value" style={{ color: 'var(--status-danger)' }}>
            <AnimatedNumber value={failedTasks.length} />
          </div>
          <div className="metric-subtext">Failed closed with truthful reporting</div>
        </motion.div>
      </div>

      {/* Two-Column Detail Grid */}
      <div className="overview-details-grid">
        {/* Recent Execution Activity Table */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, ...transitions.standard }}
          className="overview-panel"
        >
          <div className="panel-title-bar">
            <div className="panel-title-text">
              <Layers size={15} style={{ color: 'var(--accent-primary)' }} />
              <span>Recent Orchestration Missions</span>
            </div>
            <span className="panel-count">{tasks.length} missions</span>
          </div>

          <div className="runs-table-wrapper">
            {tasks.length === 0 ? (
              <div style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                No missions recorded yet. Click "Launch Autonomous Mission" to begin.
              </div>
            ) : (
              <table className="runs-table">
                <thead>
                  <tr>
                    <th>Mission</th>
                    <th>Status</th>
                    <th>Retries</th>
                    <th>Created</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.slice(0, 8).map((task) => (
                    <motion.tr
                      key={task.id}
                      onClick={() => onSelectTask(task.id)}
                      whileHover={{ backgroundColor: 'rgba(255, 255, 255, 0.035)' }}
                      transition={{ duration: 0.12 }}
                    >
                      <td className="cell-mission">
                        <div className="mission-name">{task.title}</div>
                        <div className="mission-id">#{task.id.slice(0, 8)}</div>
                      </td>
                      <td>
                        <Badge status={task.status} size="sm" />
                      </td>
                      <td className="cell-retries">
                        {task.retryCount > 0 ? (
                          <span className="retry-chip">{task.retryCount} retries</span>
                        ) : (
                          <span className="text-muted">0</span>
                        )}
                      </td>
                      <td className="cell-time">{formatDateRel(task.createdAt)}</td>
                      <td>
                        <motion.button
                          whileHover={{ scale: 1.05, x: 2 }}
                          whileTap={{ scale: 0.95 }}
                          className="view-run-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectTask(task.id);
                          }}
                        >
                          <span>Open</span>
                          <ArrowUpRight size={12} />
                        </motion.button>
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </motion.div>

        {/* System Architecture & Health Card */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.24, ...transitions.standard }}
          className="overview-panel"
        >
          <div className="panel-title-bar">
            <div className="panel-title-text">
              <Cpu size={15} style={{ color: 'var(--accent-secondary)' }} />
              <span>Orchestrator Architecture & Gates</span>
            </div>
          </div>

          <div className="architecture-specs-list">
            <div className="spec-row">
              <div className="spec-label">
                <Cpu size={13} className="text-muted" />
                <span>LLM Cognitive Brain</span>
              </div>
              <span className="spec-value">
                {systemStatus?.geminiModel || 'Gemini 3.8 / 2.5 Flash'}
              </span>
            </div>

            <div className="spec-row">
              <div className="spec-label">
                <ShieldCheck size={13} style={{ color: 'var(--status-success)' }} />
                <span>Verification Gate</span>
              </div>
              <span className="spec-value" style={{ color: 'var(--status-success)' }}>
                Strict Independent Authority
              </span>
            </div>

            <div className="spec-row">
              <div className="spec-label">
                <Box size={13} style={{ color: 'var(--accent-secondary)' }} />
                <span>OS Container Sandbox</span>
              </div>
              <span className="spec-value">
                {systemStatus?.containerSandboxEnabled
                  ? 'Docker Isolated (--network none)'
                  : 'Host Process Sandbox'}
              </span>
            </div>

            <div className="spec-row">
              <div className="spec-label">
                <RotateCcw size={13} style={{ color: 'var(--status-repair)' }} />
                <span>Self-Repair Budget</span>
              </div>
              <span className="spec-value">
                {systemStatus?.maxRetryBudget || 3} automated attempts
              </span>
            </div>

            <div className="spec-row">
              <div className="spec-label">
                <FolderGit2 size={13} className="text-muted" />
                <span>Git Worktree Checkpoint</span>
              </div>
              <span className="spec-value">Zero Dirty Base Worktree Mutation</span>
            </div>

            {repoMeta && (
              <div className="spec-row">
                <div className="spec-label">
                  <FolderGit2 size={13} className="text-muted" />
                  <span>Active Workspace</span>
                </div>
                <span className="spec-value">
                  {repoMeta.branch ? `branch: ${repoMeta.branch}` : 'Initialized Git Workspace'}
                </span>
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
};
