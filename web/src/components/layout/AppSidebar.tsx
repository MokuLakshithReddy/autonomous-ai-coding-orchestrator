import React, { useState, useMemo } from 'react';
import {
  Layers,
  Search,
  RefreshCw,
  GitBranch,
  FolderGit2,
  CheckCircle2,
  AlertCircle,
  Clock,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react';
import type { Task, RepoMeta } from '../../types/index.js';
import { Badge } from '../ui/Badge.js';
import { formatDateRel } from '../../lib/formatters.js';

interface AppSidebarProps {
  tasks: Task[];
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  onRefreshTasks: () => void;
  repoMeta: RepoMeta | null;
  className?: string;
}

export const AppSidebar: React.FC<AppSidebarProps> = ({
  tasks,
  selectedTaskId,
  onSelectTask,
  onRefreshTasks,
  repoMeta,
  className = '',
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
          ['planning', 'ready', 'executing', 'verifying', 'diagnosing', 'repairing', 'awaiting_approval'].includes(
            t.status.toLowerCase()
          )) ||
        (statusFilter === 'COMPLETED' && t.status.toLowerCase() === 'completed') ||
        (statusFilter === 'FAILED' && ['failed', 'blocked'].includes(t.status.toLowerCase()));

      return matchesSearch && matchesStatus;
    });
  }, [tasks, searchQuery, statusFilter]);

  return (
    <aside className={`app-sidebar ${className}`}>
      {/* Sidebar Header */}
      <div className="sidebar-top">
        <div className="sidebar-header-row">
          <div className="sidebar-title">
            <Layers size={14} className="text-muted" />
            <span>TASKS & RUNS</span>
            <span className="task-count-badge">{tasks.length}</span>
          </div>
          <button
            className={`refresh-btn ${isRefreshing ? 'spin' : ''}`}
            onClick={handleRefresh}
            title="Refresh task list"
          >
            <RefreshCw size={13} />
          </button>
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

        {/* Filter Pills */}
        <div className="filter-pills">
          {(['ALL', 'ACTIVE', 'COMPLETED', 'FAILED'] as const).map((filter) => (
            <button
              key={filter}
              className={`filter-pill ${statusFilter === filter ? 'active' : ''}`}
              onClick={() => setStatusFilter(filter)}
            >
              {filter.charAt(0) + filter.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Task List */}
      <div className="sidebar-task-list">
        {filteredTasks.length === 0 ? (
          <div className="empty-tasks-state">
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
          </div>
        ) : (
          filteredTasks.map((task) => {
            const isSelected = task.id === selectedTaskId;
            const isRetrying = task.retryCount > 0;

            return (
              <div
                key={task.id}
                className={`task-item-card ${isSelected ? 'selected' : ''}`}
                onClick={() => onSelectTask(task.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    onSelectTask(task.id);
                  }
                }}
              >
                <div className="task-item-header">
                  <Badge status={task.status} size="sm" />
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
                    <span className="retry-pill" title={`Self-repair retry ${task.retryCount} of ${task.maxRetries}`}>
                      <RotateCcw size={10} />
                      <span>{task.retryCount}/{task.maxRetries}</span>
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Repository Status Card at bottom */}
      {repoMeta && (
        <div className="sidebar-repo-card">
          <div className="repo-card-header">
            <div className="repo-card-title">
              <FolderGit2 size={13} className="text-sky" />
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
        </div>
      )}
    </aside>
  );
};

