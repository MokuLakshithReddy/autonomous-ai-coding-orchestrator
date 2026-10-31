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
  X,
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
import { pageVariants, panelVariants, springs } from './lib/motion.js';

// Layout & Views
import { AmbientBackground } from './components/layout/AmbientBackground.js';
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
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);

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
        } catch { }
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
    } catch { }
    return false;
  };

  // Compute active diff summary across task steps (combines all step diffs cleanly)
  const activeDiff = React.useMemo(() => {
    if (!taskDetails?.steps) return '';
    const stepsWithDiff = taskDetails.steps.filter((s) => s.diffSummary && s.diffSummary.trim().length > 0);
    if (stepsWithDiff.length === 0) return '';
    if (stepsWithDiff.length === 1) return stepsWithDiff[0].diffSummary || '';
    return stepsWithDiff
      .map((s) => `# === Step ${s.stepIndex}: ${s.title} ===\n${s.diffSummary}`)
      .join('\n\n');
  }, [taskDetails?.steps]);

  return (
    <div className="orchestrator-app-shell">
      {/* Ambient Moving Lighting & Space Dust */}
      <AmbientBackground />

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
        onToggleInspectorDrawer={() => setInspectorDrawerOpen((prev) => !prev)}
        inspectorDrawerOpen={inspectorDrawerOpen}
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
              activeView={activeView}
              onViewChange={(view) => {
                setActiveView(view);
                setMobileMenuOpen(false);
              }}
            />

            {/* Center Column: Execution Workspace */}
            <section className="mission-workspace-column" role="main">
              {/* Subtle Atmospheric Light Movement in Workspace */}
              <div className="workspace-ambient-aurora" aria-hidden="true" />

              <AnimatePresence mode="wait">
                {taskDetails?.task ? (
                  <TaskDetailView
                    key={taskDetails.task.id}
                    task={taskDetails.task}
                    steps={taskDetails.steps}
                    verifications={taskDetails.verifications}
                    pendingApprovals={taskDetails.pendingApprovals}
                    onApprove={(id) => handleApprovalResponse(id, 'APPROVED')}
                    onReject={(id) => handleApprovalResponse(id, 'REJECTED')}
                    onCancelTask={handleCancelTask}
                  />
                ) : (
                  <motion.div
                    key="empty-state"
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    transition={{ duration: 0.2 }}
                    className="empty-workspace-state"
                  >
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
                  </motion.div>
                )}
              </AnimatePresence>
            </section>

            {/* Right Column: Terminal, Verifications & Diff */}
            <aside className="mission-inspector-column" aria-label="Execution Telemetry">
              {/* Inspector Navigation Tabs */}
              <div className="inspector-tabs-header">
                {[
                  {
                    key: 'stream',
                    label: 'Live Stream',
                    icon: <Terminal size={13} />,
                    pill: logs.length > 0 ? logs.length : undefined,
                  },
                  {
                    key: 'verifications',
                    label: 'Verifications',
                    icon: <ShieldCheck size={13} />,
                    pill: taskDetails?.verifications?.length || undefined,
                  },
                  {
                    key: 'diff',
                    label: 'Git Diff',
                    icon: <FileCode size={13} />,
                    hasDot: !!activeDiff,
                  },
                ].map((tab) => {
                  const isTabActive = rightPanelTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      className={`inspector-tab-btn ${isTabActive ? 'active' : ''}`}
                      onClick={() => setRightPanelTab(tab.key as any)}
                      style={{ position: 'relative' }}
                    >
                      {isTabActive && (
                        <motion.span
                          layoutId="activeInspectorTab"
                          className="active-tab-indicator"
                          transition={springs.snappy}
                        />
                      )}
                      <span
                        style={{
                          position: 'relative',
                          zIndex: 1,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                        }}
                      >
                        {tab.icon}
                        <span>{tab.label}</span>
                        {tab.pill !== undefined && <span className="tab-pill">{tab.pill}</span>}
                        {tab.hasDot && <span className="diff-active-dot" />}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Inspector Tab Content Panels */}
              <div className="inspector-tab-content">
                <AnimatePresence mode="wait">
                  {rightPanelTab === 'stream' && (
                    <motion.div
                      key="stream"
                      variants={panelVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
                    >
                      <LiveTerminal logs={logs} selectedTaskId={selectedTaskId} />
                    </motion.div>
                  )}

                  {rightPanelTab === 'verifications' && (
                    <motion.div
                      key="verifications"
                      variants={panelVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      style={{ height: '100%', overflowY: 'auto' }}
                    >
                      <VerificationReports
                        verifications={taskDetails?.verifications || []}
                      />
                    </motion.div>
                  )}

                  {rightPanelTab === 'diff' && (
                    <motion.div
                      key="diff"
                      variants={panelVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
                    >
                      <DiffViewer diffText={activeDiff} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </aside>
          </motion.main>
        )}
      </AnimatePresence>

      {/* Mobile Sidebar Backdrop */}
      {mobileMenuOpen && (
        <div
          className="sidebar-mobile-backdrop"
          style={{
            position: 'fixed',
            inset: 0,
            top: '58px',
            background: 'rgba(0, 0, 0, 0.65)',
            backdropFilter: 'blur(4px)',
            zIndex: 45,
          }}
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Responsive Inspector Drawer Sheet (Tablets & Mobile) */}
      <AnimatePresence>
        {inspectorDrawerOpen && (
          <div
            className="inspector-drawer-backdrop"
            onClick={() => setInspectorDrawerOpen(false)}
          >
            <motion.div
              className="inspector-drawer-sheet"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 26, stiffness: 280 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="inspector-drawer-header">
                <div className="inspector-tabs-header" style={{ borderBottom: 'none', padding: 0 }}>
                  {[
                    {
                      key: 'stream',
                      label: 'Live Stream',
                      icon: <Terminal size={13} />,
                      pill: logs.length > 0 ? logs.length : undefined,
                    },
                    {
                      key: 'verifications',
                      label: 'Verifications',
                      icon: <ShieldCheck size={13} />,
                      pill: taskDetails?.verifications?.length || undefined,
                    },
                    {
                      key: 'diff',
                      label: 'Git Diff',
                      icon: <FileCode size={13} />,
                      hasDot: !!activeDiff,
                    },
                  ].map((tab) => {
                    const isTabActive = rightPanelTab === tab.key;
                    return (
                      <button
                        key={tab.key}
                        className={`inspector-tab-btn ${isTabActive ? 'active' : ''}`}
                        onClick={() => setRightPanelTab(tab.key as any)}
                        style={{ position: 'relative' }}
                      >
                        {isTabActive && (
                          <motion.span
                            layoutId="activeDrawerInspectorTab"
                            className="active-tab-indicator"
                            transition={springs.snappy}
                          />
                        )}
                        <span
                          style={{
                            position: 'relative',
                            zIndex: 1,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.35rem',
                          }}
                        >
                          {tab.icon}
                          <span>{tab.label}</span>
                          {tab.pill !== undefined && <span className="tab-pill">{tab.pill}</span>}
                          {tab.hasDot && <span className="diff-active-dot" />}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <motion.button
                  whileTap={{ scale: 0.9 }}
                  className="header-icon-btn"
                  onClick={() => setInspectorDrawerOpen(false)}
                  aria-label="Close inspector drawer"
                >
                  <X size={16} />
                </motion.button>
              </div>

              <div className="inspector-tab-content">
                <AnimatePresence mode="wait">
                  {rightPanelTab === 'stream' && (
                    <motion.div
                      key="drawer-stream"
                      variants={panelVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
                    >
                      <LiveTerminal logs={logs} selectedTaskId={selectedTaskId} />
                    </motion.div>
                  )}

                  {rightPanelTab === 'verifications' && (
                    <motion.div
                      key="drawer-verifications"
                      variants={panelVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      style={{ height: '100%', overflowY: 'auto' }}
                    >
                      <VerificationReports
                        verifications={taskDetails?.verifications || []}
                      />
                    </motion.div>
                  )}

                  {rightPanelTab === 'diff' && (
                    <motion.div
                      key="drawer-diff"
                      variants={panelVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
                    >
                      <DiffViewer diffText={activeDiff} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          </div>
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
