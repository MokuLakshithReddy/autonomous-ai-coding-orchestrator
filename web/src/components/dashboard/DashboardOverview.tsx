import React from 'react';
import {
  Activity,
  CheckCircle2,
  XCircle,
  RotateCcw,
  ShieldCheck,
  Cpu,
  Layers,
  Box,
  Terminal,
  FolderGit2,
  ArrowUpRight,
  Plus,
} from 'lucide-react';
import type { Task, SystemStatus, RepoMeta } from '../../types/index.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { formatDateRel, formatDuration } from '../../lib/formatters.js';

interface DashboardOverviewProps {
  tasks: Task[];
  systemStatus: SystemStatus | null;
  repoMeta: RepoMeta | null;
  onSelectTask: (id: string) => void;
  onOpenNewTask: () => void;
}

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
    ['discovering', 'planning', 'ready', 'executing', 'verifying', 'diagnosing', 'repairing', 'awaiting_approval'].includes(
      t.status.toLowerCase()
    )
  );
  const repairedTasks = tasks.filter((t) => t.status.toLowerCase() === 'completed' && t.retryCount > 0);

  const verificationSuccessRate =
    totalTasks > 0 ? Math.round((completedTasks.length / totalTasks) * 100) : 100;
  const repairRate =
    completedTasks.length > 0 ? Math.round((repairedTasks.length / completedTasks.length) * 100) : 0;

  return (
    <div className="dashboard-overview-container">
      {/* Overview Banner */}
      <div className="overview-hero-card">
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
      </div>

      {/* Metric Cards Grid */}
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Active Missions</span>
            <Activity size={16} className="text-sky" />
          </div>
          <div className="metric-value">{activeTasks.length}</div>
          <div className="metric-subtext">Currently executing in isolated worktrees</div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Verified Passed</span>
            <CheckCircle2 size={16} className="text-emerald" />
          </div>
          <div className="metric-value text-emerald">{completedTasks.length}</div>
          <div className="metric-subtext">{verificationSuccessRate}% verified completion rate</div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Self-Repair Recoveries</span>
            <RotateCcw size={16} className="text-pink" />
          </div>
          <div className="metric-value text-pink">{repairedTasks.length}</div>
          <div className="metric-subtext">Autonomously resolved compilation/test regressions</div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Failed / Blocked</span>
            <XCircle size={16} className="text-rose" />
          </div>
          <div className="metric-value text-rose">{failedTasks.length}</div>
          <div className="metric-subtext">Failed closed with truthful reporting</div>
        </div>
      </div>

      {/* Two-Column Detail Grid */}
      <div className="overview-details-grid">
        {/* Recent Execution Activity Table */}
        <div className="overview-panel">
          <div className="panel-title-bar">
            <div className="panel-title-text">
              <Layers size={15} className="text-indigo" />
              <span>Recent Orchestration Missions</span>
            </div>
            <span className="panel-count">{tasks.length} runs</span>
          </div>

          <div className="runs-table-wrapper">
            {tasks.length === 0 ? (
              <div className="runs-empty-state">No missions recorded yet.</div>
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
                    <tr key={task.id} onClick={() => onSelectTask(task.id)}>
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
                        <button
                          className="view-run-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectTask(task.id);
                          }}
                        >
                          <span>Open</span>
                          <ArrowUpRight size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* System Architecture & Health Card */}
        <div className="overview-panel">
          <div className="panel-title-bar">
            <div className="panel-title-text">
              <Cpu size={15} className="text-sky" />
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
                <ShieldCheck size={13} className="text-emerald" />
                <span>Verification Gate</span>
              </div>
              <span className="spec-value text-emerald">Strict Independent Authority</span>
            </div>

            <div className="spec-row">
              <div className="spec-label">
                <Box size={13} className="text-sky" />
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
                <RotateCcw size={13} className="text-pink" />
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
        </div>
      </div>
    </div>
  );
};

