import React, { useState, useMemo } from 'react';
import {
  History,
  Search,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Clock,
  ArrowUpRight,
  GitBranch,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { Task } from '../../types/index.js';
import { Badge } from '../ui/Badge.js';
import { formatDateRel, formatDuration } from '../../lib/formatters.js';
import { springs } from '../../lib/motion.js';

interface TaskHistoryViewProps {
  tasks: Task[];
  onSelectTask: (taskId: string) => void;
}

export const TaskHistoryView: React.FC<TaskHistoryViewProps> = ({ tasks, onSelectTask }) => {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'ALL' | 'COMPLETED' | 'FAILED' | 'REPAIRED'>('ALL');

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      const matchSearch =
        search === '' ||
        t.title.toLowerCase().includes(search.toLowerCase()) ||
        t.prompt.toLowerCase().includes(search.toLowerCase()) ||
        t.id.toLowerCase().includes(search.toLowerCase());

      if (!matchSearch) return false;

      if (filter === 'ALL') return true;
      if (filter === 'COMPLETED') return t.status.toLowerCase() === 'completed';
      if (filter === 'FAILED') return ['failed', 'blocked'].includes(t.status.toLowerCase());
      if (filter === 'REPAIRED') return t.status.toLowerCase() === 'completed' && t.retryCount > 0;
      return true;
    });
  }, [tasks, search, filter]);

  return (
    <div className="history-view-container">
      <div className="history-header">
        <div className="history-title-group">
          <motion.div
            className="history-icon-badge"
            whileHover={{ rotate: -15, scale: 1.08 }}
            transition={{ duration: 0.25 }}
          >
            <History size={18} />
          </motion.div>
          <div>
            <h1 className="history-heading">Task Execution History & Audit Log</h1>
            <p className="history-subheading">
              Complete historical record of all autonomous missions, independent verifications, and repair iterations.
            </p>
          </div>
        </div>

        <div className="history-filters-bar">
          <div className="history-search-input-wrapper">
            <Search size={13} className="text-muted" />
            <input
              type="text"
              className="history-search-input"
              placeholder="Filter by title, ID, or prompt..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="history-filter-chips">
            {(['ALL', 'COMPLETED', 'FAILED', 'REPAIRED'] as const).map((cat) => {
              const isChipActive = filter === cat;
              return (
                <button
                  key={cat}
                  className={`history-filter-chip ${isChipActive ? 'active' : ''}`}
                  onClick={() => setFilter(cat)}
                  style={{ position: 'relative' }}
                >
                  {isChipActive && (
                    <motion.span
                      layoutId="activeHistoryFilter"
                      className="active-filter-indicator"
                      transition={springs.snappy}
                    />
                  )}
                  <span style={{ position: 'relative', zIndex: 1 }}>
                    {cat.charAt(0) + cat.slice(1).toLowerCase()}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Desktop / Tablet Table View */}
      <div className="history-table-container">
        {filtered.length === 0 ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="history-empty">
            <p>No historical runs match the current criteria.</p>
          </motion.div>
        ) : (
          <table className="history-table">
            <thead>
              <tr>
                <th>Mission</th>
                <th>Status</th>
                <th>Worktree Branch</th>
                <th>Retries</th>
                <th>Duration</th>
                <th>Timestamp</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((task) => (
                <motion.tr
                  key={task.id}
                  onClick={() => onSelectTask(task.id)}
                  whileHover={{ backgroundColor: 'rgba(255, 255, 255, 0.035)' }}
                  transition={{ duration: 0.12 }}
                >
                  <td className="cell-task-info">
                    <div className="task-row-title">{task.title}</div>
                    <div className="task-row-prompt">{task.prompt}</div>
                  </td>
                  <td>
                    <Badge status={task.status} size="sm" />
                  </td>
                  <td>
                    <code className="branch-code">task/{task.id.slice(0, 8)}</code>
                  </td>
                  <td>
                    {task.retryCount > 0 ? (
                      <span className="retry-pill">
                        <RotateCcw size={10} />
                        <span>{task.retryCount} retries</span>
                      </span>
                    ) : (
                      <span className="text-muted">None</span>
                    )}
                  </td>
                  <td className="cell-duration">
                    {formatDuration(task.createdAt, task.updatedAt)}
                  </td>
                  <td className="cell-date">{formatDateRel(task.createdAt)}</td>
                  <td>
                    <motion.button
                      whileHover={{ scale: 1.06, x: 2 }}
                      whileTap={{ scale: 0.94 }}
                      className="open-task-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectTask(task.id);
                      }}
                    >
                      <span>Details</span>
                      <ArrowUpRight size={12} />
                    </motion.button>
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Mobile Card View (renders on screens < 768px without hiding info) */}
      <div className="history-mobile-cards">
        {filtered.length === 0 ? (
          <div className="history-empty">
            <p>No historical runs match the current criteria.</p>
          </div>
        ) : (
          filtered.map((task) => (
            <motion.div
              key={task.id}
              whileHover={{ y: -2, x: 2 }}
              whileTap={{ scale: 0.985 }}
              className="history-mobile-card"
              onClick={() => onSelectTask(task.id)}
            >
              <div className="history-mobile-header">
                <span className="history-mobile-title">{task.title}</span>
                <Badge status={task.status} size="sm" />
              </div>
              <p className="history-mobile-prompt">{task.prompt}</p>
              <div className="history-mobile-meta">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                  <GitBranch size={11} style={{ color: 'var(--accent-secondary)' }} />
                  <code>task/{task.id.slice(0, 8)}</code>
                </span>
                <span>{formatDuration(task.createdAt, task.updatedAt)}</span>
                <span>{formatDateRel(task.createdAt)}</span>
              </div>
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
};
