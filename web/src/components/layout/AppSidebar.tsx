import React, { useState, useMemo } from 'react';
import {
  Layers,
  Search,
  RefreshCw,
  GitBranch,
  FolderGit2,
  RotateCcw,
  TerminalSquare,
  LayoutDashboard,
  History,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { Task, RepoMeta } from '../../types/index.js';
import { Badge } from '../ui/Badge.js';
import { formatDateRel } from '../../lib/formatters.js';
import { springs } from '../../lib/motion.js';

interface AppSidebarProps {
  tasks: Task[];
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  onRefreshTasks: () => void;
  repoMeta: RepoMeta | null;
  className?: string;
  activeView?: 'dashboard' | 'workspace' | 'history';
  onViewChange?: (view: 'dashboard' | 'workspace' | 'history') => void;
}

export const AppSidebar: React.FC<AppSidebarProps> = ({
  tasks,
  selectedTaskId,
  onSelectTask,
  onRefreshTasks,
  repoMeta,
  className = '',
  activeView = 'workspace',
  onViewChange,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await onRefreshTasks();
    setTimeout(() => setIsRefreshing(false), 500);
  };

  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      const matchesSearch =
        searchQuery === '' ||
        t.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.prompt.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.id.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesStatus =
        statusFilter === 'ALL' ||
        (statusFilter === 'ACTIVE' &&
          [
            'discovering',
            'planning',
            'ready',
            'executing',
            'verifying',
            'diagnosing',
            'repairing',
            'awaiting_approval',
          ].includes(t.status.toLowerCase())) ||
        (statusFilter === 'COMPLETED' && t.status.toLowerCase() === 'completed') ||
        (statusFilter === 'FAILED' && ['failed', 'blocked'].includes(t.status.toLowerCase()));

      return matchesSearch && matchesStatus;
    });
  }, [tasks, searchQuery, statusFilter]);

  return (
    <aside className={`app-sidebar ${className}`}>
      {/* Mobile Navigation Drawer Links (Visible on Mobile Viewports) */}
      {onViewChange && (
        <div className="sidebar-mobile-nav">
          <button
            className={`sidebar-nav-tab ${activeView === 'workspace' ? 'active' : ''}`}
            onClick={() => onViewChange('workspace')}
          >
            <TerminalSquare size={13} />
            <span>Mission Control</span>
          </button>
          <button
            className={`sidebar-nav-tab ${activeView === 'dashboard' ? 'active' : ''}`}
            onClick={() => onViewChange('dashboard')}
          >
            <LayoutDashboard size={13} />
            <span>Observability</span>
          </button>
          <button
            className={`sidebar-nav-tab ${activeView === 'history' ? 'active' : ''}`}
            onClick={() => onViewChange('history')}
          >
            <History size={13} />
            <span>Task History</span>
          </button>
        </div>
      )}

      {/* Sidebar Header */}
      <div className="sidebar-top">
        <div className="sidebar-header-row">
          <div className="sidebar-title">
            <Layers size={14} className="text-muted" />
            <span>TASKS & RUNS</span>
            <span className="task-count-badge">{tasks.length}</span>
          </div>
          <motion.button
            whileTap={{ rotate: 180, scale: 0.88 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className={`refresh-btn ${isRefreshing ? 'spin' : ''}`}
            onClick={handleRefresh}
            title="Refresh task list"
          >
            <RefreshCw size={13} />
          </motion.button>
        </div>

        {/* Search Bar */}
        <div className="search-box">
          <Search size={13} className="search-icon" />
          <input
            type="text"
            className="search-input"
            placeholder="Search missions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="search-clear-btn" onClick={() => setSearchQuery('')}>
              ×
            </button>
          )}
        </div>

        {/* Filter Pills with Motion layoutId sliding pill */}
        <div className="filter-pills">
          {(['ALL', 'ACTIVE', 'COMPLETED', 'FAILED'] as const).map((filter) => {
            const isFilterActive = statusFilter === filter;
            return (
              <button
                key={filter}
                className={`filter-pill ${isFilterActive ? 'active' : ''}`}
                onClick={() => setStatusFilter(filter)}
                style={{ position: 'relative' }}
              >
                {isFilterActive && (
                  <motion.span
                    layoutId="activeFilterPill"
                    className="active-filter-indicator"
                    transition={springs.snappy}
                  />
                )}
                <span style={{ position: 'relative', zIndex: 1 }}>
                  {filter.charAt(0) + filter.slice(1).toLowerCase()}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Task List with Staggered Entrance & Selection Transitions */}
      <div className="sidebar-task-list">
        {filteredTasks.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="empty-tasks-state"
          >
            <p className="empty-title">
              {searchQuery || statusFilter !== 'ALL'
                ? 'No matching tasks'
                : 'No tasks initiated'}
            </p>
            <p className="empty-desc">
              {searchQuery || statusFilter !== 'ALL'
                ? 'Try adjusting your search query or filter.'
                : 'Click "New Mission" to launch an autonomous run.'}
            </p>
          </motion.div>
        ) : (
          <AnimatePresence initial={false}>
            {filteredTasks.map((task, idx) => {
              const isSelected = task.id === selectedTaskId;
              const isRetrying = task.retryCount > 0;
              const isActive = [
                'discovering',
                'planning',
                'ready',
                'executing',
                'verifying',
                'diagnosing',
                'repairing',
                'awaiting_approval',
              ].includes(task.status.toLowerCase());

              return (
                <motion.div
                  key={task.id}
                  layout="position"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{
                    duration: 0.22,
                    ease: [0.16, 1, 0.3, 1],
                    delay: Math.min(idx * 0.03, 0.2),
                  }}
                  whileHover={{ y: -2, x: 2, transition: { duration: 0.15 } }}
                  whileTap={{ scale: 0.985 }}
                  className={`task-item-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => onSelectTask(task.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      onSelectTask(task.id);
                    }
                  }}
                  style={{ position: 'relative' }}
                >
                  {/* Selected Task Animated Left Accent Indicator */}
                  {isSelected && (
                    <motion.span
                      layoutId="selectedTaskAccentBar"
                      className="selected-task-accent-bar"
                      transition={springs.snappy}
                    />
                  )}

                  <div className="task-item-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      {isActive && <span className="active-task-pulse-dot" />}
                      <Badge status={task.status} size="sm" showDot={!isActive} />
                    </div>
                    <span className="task-item-time">{formatDateRel(task.createdAt)}</span>
                  </div>

                  <div className="task-item-title" title={task.title}>
                    {task.title}
                  </div>

                  <div className="task-item-footer">
                    <span className="task-item-id">
                      <code>#{task.id.slice(0, 8)}</code>
                    </span>

                    {isRetrying && (
                      <span
                        className="retry-pill"
                        title={`Self-repair retry ${task.retryCount} of ${task.maxRetries}`}
                      >
                        <RotateCcw size={10} />
                        <span>
                          {task.retryCount}/{task.maxRetries}
                        </span>
                      </span>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>

      {/* Repository Status Card at bottom */}
      {repoMeta && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="sidebar-repo-card"
        >
          <div className="repo-card-header">
            <div className="repo-card-title">
              <FolderGit2 size={13} style={{ color: 'var(--accent-secondary)' }} />
              <span>Workspace</span>
            </div>
            {repoMeta.branch && (
              <span className="repo-branch-pill">
                <GitBranch size={11} />
                <span>{repoMeta.branch}</span>
              </span>
            )}
          </div>

          <div className="repo-meta-details">
            <div className="repo-meta-row">
              <span className="meta-label">Ecosystems:</span>
              <span className="meta-value">
                {repoMeta.ecosystems && repoMeta.ecosystems.length > 0
                  ? repoMeta.ecosystems.join(', ')
                  : 'Universal'}
              </span>
            </div>

            <div className="repo-meta-row">
              <span className="meta-label">Build / Test:</span>
              <span className="meta-value">
                {repoMeta.buildCmd ? 'Detected' : 'Standard'}
              </span>
            </div>
          </div>
        </motion.div>
      )}
    </aside>
  );
};
