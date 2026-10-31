import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Terminal,
  ShieldCheck,
  FileCode,
  Layers,
  Cpu,
  RefreshCw,
  Plus,
  Settings,
  FolderGit2,
  AlertCircle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type {
  Task,
  Step,
  Verification,
  Approval,
  TaskDetailsData,
  WsEvent,
  SystemStatus,
  RepoMeta,
} from './types/index.js';
import {
  apiFetch,
  requestWsTicket,
  getStoredApiToken,
  setStoredApiToken,
} from './lib/api.js';
import { pageVariants } from './lib/motion.js';

// Layout & Views
import { AppHeader } from './components/layout/AppHeader.js';
import { AppSidebar } from './components/layout/AppSidebar.js';
import { DashboardOverview } from './components/dashboard/DashboardOverview.js';
import { TaskDetailView } from './components/task/TaskDetailView.js';
import { TaskHistoryView } from './components/history/TaskHistoryView.js';

// Terminal & Inspector
import { LiveTerminal } from './components/terminal/LiveTerminal.js';
import { VerificationReports } from './components/terminal/VerificationReports.js';
import { DiffViewer } from './components/terminal/DiffViewer.js';

// Modals
import { NewTaskModal } from './components/modals/NewTaskModal.js';
import { SettingsModal } from './components/modals/SettingsModal.js';
import { AuthModal } from './components/modals/AuthModal.js';

export default function App() {
  // Navigation & View
  const [activeView, setActiveView] = useState<'workspace' | 'dashboard' | 'history'>('workspace');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Tasks state
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDetails, setTaskDetails] = useState<TaskDetailsData | null>(null);
  const [isLoadingTask, setIsLoadingTask] = useState(false);

  // System & Repo metadata
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [repoMeta, setRepoMeta] = useState<RepoMeta | null>(null);
  const [defaultWorkspace, setDefaultWorkspace] = useState<string>('');

  // Right Panel Tabs
  const [rightPanelTab, setRightPanelTab] = useState<'stream' | 'verifications' | 'diff'>('stream');

  // Logs stream
  const [logs, setLogs] = useState<WsEvent[]>([]);

  // Authentication state
  const [apiToken, setApiToken] = useState<string>(getStoredApiToken);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string>('');

  // Modals state
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  // WebSocket reference
  const wsRef = useRef<WebSocket | null>(null);

  // Fetch system status
  const fetchSystemStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/system/status');
      if (res.ok) {
        const data = await res.json();
        setSystemStatus(data);
        if (data.defaultWorkspace) {
          setDefaultWorkspace(data.defaultWorkspace);
        }
      }
    } catch (err) {
      console.warn('Failed to fetch system status:', err);
    }
  }, []);

  // Fetch task list
  const fetchTasks = useCallback(
    async (tokenOverride?: string) => {
      try {
        const res = await apiFetch('/api/tasks', {
          explicitToken: tokenOverride,
          onUnauthorized: () => {
            setIsAuthenticated(false);
            setShowAuthModal(true);
            setAuthError('Authentication required to access tasks.');
          },
        });

        if (res.ok) {
          const data = await res.json();
          setTasks(data.tasks || []);
          setIsAuthenticated(true);
          setAuthError('');

          // Select first task if none selected
          if (data.tasks?.length > 0 && !selectedTaskId) {
            setSelectedTaskId(data.tasks[0].id);
          }
        }
      } catch (err) {
        console.warn('Failed to fetch tasks:', err);
      }
    },
    [selectedTaskId]
  );

  // Fetch task details
  const fetchTaskDetails = useCallback(
    async (id: string, tokenOverride?: string) => {
      setIsLoadingTask(true);
      try {
        const res = await apiFetch(`/api/tasks/${id}`, {
          explicitToken: tokenOverride,
          onUnauthorized: () => {
            setIsAuthenticated(false);
            setShowAuthModal(true);
          },
        });

        if (res.ok) {
          const data = await res.json();
          setTaskDetails(data);
          setIsAuthenticated(true);

          if (data.task?.workspacePath) {
            inspectWorkspace(data.task.workspacePath, tokenOverride);
          }
        }
      } catch (err) {
        console.warn(`Failed to fetch task details for ${id}:`, err);
      } finally {
        setIsLoadingTask(false);
      }
    },
    []
  );

  // Inspect repository workspace
  const inspectWorkspace = useCallback(async (workspacePath: string, tokenOverride?: string) => {
    try {
      const res = await apiFetch('/api/repo/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath }),
        explicitToken: tokenOverride,
      });

      if (res.ok) {
        const data = await res.json();
        setRepoMeta(data.meta || null);
      }
    } catch (err) {
      console.warn('Workspace inspection skipped:', err);
    }
  }, []);

  // WebSocket Connection Handler
  const connectWebSocket = useCallback(
    async (tokenToUse?: string) => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      const activeTok = tokenToUse ?? apiToken;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      let wsUrl = `${protocol}//${window.location.host}/ws`;

      if (activeTok) {
        const ticket = await requestWsTicket(activeTok);
        if (ticket) {
          wsUrl += `?ticket=${encodeURIComponent(ticket)}`;
        }
      }

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (activeTok) {
          ws.send(JSON.stringify({ type: 'AUTH', token: activeTok }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const parsed: WsEvent = JSON.parse(event.data);
          setLogs((prev) => [...prev.slice(-400), parsed]);

          if (parsed.taskId) {
            fetchTasks(activeTok);
            if (parsed.taskId === selectedTaskId) {
              fetchTaskDetails(parsed.taskId, activeTok);
            }
          }
        } catch {}
      };

      ws.onclose = (event) => {
        if (event.code === 1008) {
          setIsAuthenticated(false);
          console.warn('WebSocket closed due to authentication failure (1008)');
        }
      };
    },
    [apiToken, selectedTaskId, fetchTasks, fetchTaskDetails]
  );

  // Initialize on mount
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get('token');
    let effectiveToken = getStoredApiToken();

    if (tokenFromUrl) {
      effectiveToken = tokenFromUrl.trim();
      setStoredApiToken(effectiveToken);
      urlParams.delete('token');
      const cleanUrl =
        window.location.pathname + (urlParams.toString() ? `?${urlParams.toString()}` : '');
      window.history.replaceState({}, '', cleanUrl);
    }

    setApiToken(effectiveToken);
    fetchSystemStatus();

    if (effectiveToken) {
      fetchTasks(effectiveToken);
      connectWebSocket(effectiveToken);
    } else {
      setShowAuthModal(true);
    }

    return () => {
      wsRef.current?.close();
    };
  }, []);

  // When selected task changes
  useEffect(() => {
    if (selectedTaskId) {
      fetchTaskDetails(selectedTaskId);
    }
  }, [selectedTaskId, fetchTaskDetails]);

  // Handle task selection
  const handleSelectTask = (id: string) => {
    setSelectedTaskId(id);
    setActiveView('workspace');
    setMobileMenuOpen(false);
  };

  // Handle task launch
  const handleCreateTask = async (taskData: {
    prompt: string;
    workspacePath: string;
    agent: 'builtin' | 'aider' | 'claude';
    autoMerge: boolean;
    maxRetries: number;
  }) => {
    const res = await apiFetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskData),
      onUnauthorized: () => {
        setIsAuthenticated(false);
        setShowAuthModal(true);
      },
    });

    if (res.ok) {
      const data = await res.json();
      setShowNewTaskModal(false);
      await fetchTasks();
      if (data.task?.id) {
        setSelectedTaskId(data.task.id);
        setActiveView('workspace');
      }
    } else {
      const err = await res.json().catch(() => ({}));
      const msg = err.message || err.error || res.statusText || 'Failed to create task';
      alert(`Could not launch autonomous mission:\n\n${msg}`);
      throw new Error(msg);
    }
  };

  // Handle task cancellation
  const handleCancelTask = async (id: string) => {
    try {
      const res = await apiFetch(`/api/tasks/${id}/cancel`, {
        method: 'POST',
      });
      if (res.ok) {
        await fetchTaskDetails(id);
        await fetchTasks();
      }
    } catch (err: any) {
      alert(`Failed to cancel task: ${err.message || 'Error'}`);
    }
  };

  // Handle approval response
  const handleApprovalResponse = async (approvalId: string, status: 'APPROVED' | 'REJECTED') => {
    try {
      const res = await apiFetch(`/api/approvals/${approvalId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });

      if (res.ok) {
        if (selectedTaskId) {
          fetchTaskDetails(selectedTaskId);
        }
      } else if (res.status === 409) {
        alert('This approval was already resolved or has expired.');
        if (selectedTaskId) fetchTaskDetails(selectedTaskId);
      }
    } catch (err: any) {
      alert(`Approval error: ${err.message || 'Network error'}`);
    }
  };

  // Handle settings update
  const handleSaveSettings = async (data: {
    token?: string;
    apiKey?: string;
    model?: string;
  }) => {
    if (data.apiKey || data.model) {
      await apiFetch('/api/config/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: data.apiKey,
          model: data.model,
        }),
      });
    }

    if (data.token !== undefined) {
      setStoredApiToken(data.token);
      setApiToken(data.token);
      fetchTasks(data.token);
      connectWebSocket(data.token);
    }

    fetchSystemStatus();
  };

  // Handle explicit authentication
  const handleAuthenticate = async (candidateToken: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/tasks', {
        headers: {
          'Authorization': `Bearer ${candidateToken}`,
          'x-api-token': candidateToken,
        },
      });

      if (res.ok) {
        setStoredApiToken(candidateToken);
        setApiToken(candidateToken);
        setIsAuthenticated(true);
        setAuthError('');
        const data = await res.json();
        setTasks(data.tasks || []);
        if (data.tasks?.length > 0 && !selectedTaskId) {
          setSelectedTaskId(data.tasks[0].id);
        }
        connectWebSocket(candidateToken);
        return true;
      }
    } catch {}
    return false;
  };

  // Compute active diff summary across task steps
  const activeDiff = taskDetails?.steps?.find((s) => s.diffSummary)?.diffSummary || '';

  return (
    <div className="orchestrator-app-shell">
      {/* Top Application Header */}
      <AppHeader
        systemStatus={systemStatus}
        isAuthenticated={isAuthenticated}
        activeView={activeView}
        onViewChange={setActiveView}
        onOpenNewTask={() => setShowNewTaskModal(true)}
        onOpenSettings={() => setShowSettingsModal(true)}
        onOpenAuth={() => setShowAuthModal(true)}
        mobileMenuOpen={mobileMenuOpen}
        onToggleMobileMenu={() => setMobileMenuOpen(!mobileMenuOpen)}
      />

      {/* Main View Router with Smooth Motion Transitions */}
      <AnimatePresence mode="wait">
        {activeView === 'dashboard' ? (
          <motion.main
            key="dashboard"
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="dashboard-fullscreen-view"
          >
            <DashboardOverview
              tasks={tasks}
              systemStatus={systemStatus}
              repoMeta={repoMeta}
              onSelectTask={handleSelectTask}
              onOpenNewTask={() => setShowNewTaskModal(true)}
            />
          </motion.main>
        ) : activeView === 'history' ? (
          <motion.main
            key="history"
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="history-fullscreen-view"
          >
            <TaskHistoryView tasks={tasks} onSelectTask={handleSelectTask} />
          </motion.main>
        ) : (
          /* Mission Control Workspace (3-Column Layout) */
          <motion.main
            key="workspace"
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="mission-control-grid"
          >
            {/* Left Column: Tasks & Repository Sidebar */}
            <AppSidebar
              tasks={tasks}
              selectedTaskId={selectedTaskId}
              onSelectTask={handleSelectTask}
              onRefreshTasks={fetchTasks}
              repoMeta={repoMeta}
              className={mobileMenuOpen ? 'mobile-open' : ''}
            />

            {/* Center Column: Execution Workspace */}
            <section className="mission-workspace-column" role="main">
              {taskDetails?.task ? (
                <TaskDetailView
                  task={taskDetails.task}
                  steps={taskDetails.steps}
                  verifications={taskDetails.verifications}
                  pendingApprovals={taskDetails.pendingApprovals}
                  onApprove={(id) => handleApprovalResponse(id, 'APPROVED')}
                  onReject={(id) => handleApprovalResponse(id, 'REJECTED')}
                  onCancelTask={handleCancelTask}
                />
              ) : (
                <div className="empty-workspace-state">
                  <div className="empty-workspace-icon">
                    <Cpu size={44} />
                  </div>
                  <h2 className="empty-state-heading">No Task Selected</h2>
                  <p className="empty-state-text">
                    Select an existing mission from the sidebar or launch a new autonomous run.
                  </p>
                  <button
                    className="empty-state-cta-btn"
                    onClick={() => setShowNewTaskModal(true)}
                  >
                    <Plus size={15} />
                    <span>Launch Autonomous Mission</span>
                  </button>
                </div>
              )}
            </section>

            {/* Right Column: Terminal, Verifications & Diff */}
            <aside className="mission-inspector-column" aria-label="Execution Telemetry">
              {/* Inspector Navigation Tabs */}
              <div className="inspector-tabs-header">
                <button
                  className={`inspector-tab-btn ${rightPanelTab === 'stream' ? 'active' : ''}`}
                  onClick={() => setRightPanelTab('stream')}
                >
                  <Terminal size={13} />
                  <span>Live Stream</span>
                  {logs.length > 0 && <span className="tab-pill">{logs.length}</span>}
                </button>

                <button
                  className={`inspector-tab-btn ${rightPanelTab === 'verifications' ? 'active' : ''}`}
                  onClick={() => setRightPanelTab('verifications')}
                >
                  <ShieldCheck size={13} />
                  <span>Verifications</span>
                  {taskDetails?.verifications && taskDetails.verifications.length > 0 && (
                    <span className="tab-pill">{taskDetails.verifications.length}</span>
                  )}
                </button>

                <button
                  className={`inspector-tab-btn ${rightPanelTab === 'diff' ? 'active' : ''}`}
                  onClick={() => setRightPanelTab('diff')}
                >
                  <FileCode size={13} />
                  <span>Git Diff</span>
                  {activeDiff && <span className="diff-active-dot" />}
                </button>
              </div>

              {/* Inspector Tab Content Panels */}
              <div className="inspector-tab-content">
                {rightPanelTab === 'stream' && (
                  <LiveTerminal logs={logs} selectedTaskId={selectedTaskId} />
                )}

                {rightPanelTab === 'verifications' && (
                  <VerificationReports
                    verifications={taskDetails?.verifications || []}
                  />
                )}

                {rightPanelTab === 'diff' && <DiffViewer diffText={activeDiff} />}
              </div>
            </aside>
          </motion.main>
        )}
      </AnimatePresence>

      {/* Modals */}
      <NewTaskModal
        isOpen={showNewTaskModal}
        onClose={() => setShowNewTaskModal(false)}
        onSubmit={handleCreateTask}
        defaultWorkspace={defaultWorkspace}
      />

      <SettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        systemStatus={systemStatus}
        currentApiToken={apiToken}
        onSave={handleSaveSettings}
      />

      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onAuthenticate={handleAuthenticate}
        currentError={authError}
        initialToken={apiToken}
      />
    </div>
  );
}
