import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play,
  Terminal,
  ShieldCheck,
  Cpu,
  GitBranch,
  RefreshCw,
  PlusCircle,
  FileCode,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Settings,
  Layers,
  ArrowRight,
  ShieldAlert,
  FolderGit2,
  Key,
  Lock,
  Unlock
} from 'lucide-react';

interface Task {
  id: string;
  title: string;
  prompt: string;
  workspacePath: string;
  status: string;
  retryCount: number;
  maxRetries: number;
  planJson?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

interface Step {
  id: string;
  taskId: string;
  stepIndex: number;
  title: string;
  instruction: string;
  status: string;
  agent: string;
  toolsUsedJson?: string;
  outputLog?: string;
  diffSummary?: string;
  exitCode?: number;
}

interface Verification {
  id: string;
  taskId: string;
  status: string;
  buildStatus: string;
  testStatus: string;
  lintStatus: string;
  diffInspection: string;
  diagnostics?: string;
  createdAt: string;
}

interface WsEvent {
  id: string;
  taskId: string;
  type: string;
  message: string;
  data?: any;
  timestamp: string;
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDetails, setTaskDetails] = useState<{
    task: Task;
    steps: Step[];
    verifications: Verification[];
    pendingApprovals: any[];
  } | null>(null);

  const [systemStatus, setSystemStatus] = useState<any>(null);
  const [repoMeta, setRepoMeta] = useState<any>(null);
  const [logs, setLogs] = useState<WsEvent[]>([]);
  const [activeTab, setActiveTab] = useState<'stream' | 'verifications' | 'diff'>('stream');

  // Authentication states
  const [apiToken, setApiToken] = useState<string>(() => {
    return localStorage.getItem('orchestrator_api_token') || '';
  });
  const [tokenInput, setTokenInput] = useState<string>('');
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string>('');

  // Modals
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  // Form states
  const [newPrompt, setNewPrompt] = useState('');
  const [newWorkspace, setNewWorkspace] = useState('');
  const [newRetries, setNewRetries] = useState(3);
  const [selectedAgent, setSelectedAgent] = useState<'builtin' | 'aider' | 'claude'>('builtin');
  const [autoMerge, setAutoMerge] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [modelInput, setModelInput] = useState('gemini-2.5-flash');

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Authenticated fetch wrapper
  const apiFetch = useCallback(
    async (url: string, options: RequestInit = {}, explicitToken?: string) => {
      const token = explicitToken ?? (apiToken || localStorage.getItem('orchestrator_api_token') || '');
      const headers: Record<string, string> = {
        ...((options.headers as Record<string, string>) || {}),
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
        headers['x-api-token'] = token;
      }

      const res = await fetch(url, { ...options, headers });
      if (res.status === 401) {
        setIsAuthenticated(false);
        setShowAuthModal(true);
        setAuthError('Authentication required or token expired. Please enter your API token.');
      } else if (res.ok) {
        setIsAuthenticated(true);
        setAuthError('');
      }
      return res;
    },
    [apiToken]
  );

  // Load system status & task list
  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/system/status');
      const data = await res.json();
      setSystemStatus(data);
      if (!newWorkspace && data.defaultWorkspace) {
        setNewWorkspace(data.defaultWorkspace);
      }
    } catch {}
  };

  const fetchTasks = async (overrideToken?: string) => {
    try {
      const res = await apiFetch('/api/tasks', {}, overrideToken);
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
        if (data.tasks?.length > 0 && !selectedTaskId) {
          setSelectedTaskId(data.tasks[0].id);
        }
      }
    } catch {}
  };

  const fetchTaskDetails = async (id: string, overrideToken?: string) => {
    try {
      const res = await apiFetch(`/api/tasks/${id}`, {}, overrideToken);
      if (res.ok) {
        const data = await res.json();
        setTaskDetails(data);
      }
    } catch {}
  };

  const inspectRepo = async (workspacePath: string, overrideToken?: string) => {
    try {
      const res = await apiFetch(
        '/api/repo/inspect',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspacePath }),
        },
        overrideToken
      );
      if (res.ok) {
        const data = await res.json();
        setRepoMeta(data.meta);
      }
    } catch {}
  };

  // Authenticated WebSocket Connection
  const connectWs = useCallback(
    async (tokenToUse?: string) => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      const token = tokenToUse ?? (apiToken || localStorage.getItem('orchestrator_api_token') || '');
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      let wsUrl = `${protocol}//${window.location.host}/ws`;

      if (token) {
        try {
          const ticketRes = await fetch('/api/auth/ws-ticket', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'x-api-token': token,
            },
          });
          if (ticketRes.ok) {
            const { ticket } = await ticketRes.json();
            if (ticket) {
              wsUrl += `?ticket=${encodeURIComponent(ticket)}`;
            }
          }
        } catch (err) {
          console.warn('Could not acquire WS ticket pre-handshake:', err);
        }
      }

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (token) {
          ws.send(JSON.stringify({ type: 'AUTH', token }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const parsed: WsEvent = JSON.parse(event.data);
          setLogs((prev) => [...prev.slice(-300), parsed]);

          if (parsed.taskId) {
            fetchTasks(token);
            if (parsed.taskId === selectedTaskId) {
              fetchTaskDetails(parsed.taskId, token);
            }
          }
        } catch {}
      };

      ws.onclose = (event) => {
        if (event.code === 1008) {
          setIsAuthenticated(false);
          console.warn('WebSocket closed due to auth failure (1008)');
        }
      };
    },
    [apiToken, selectedTaskId, apiFetch]
  );

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get('token');
    let effectiveToken = localStorage.getItem('orchestrator_api_token') || '';

    if (tokenFromUrl) {
      effectiveToken = tokenFromUrl.trim();
      localStorage.setItem('orchestrator_api_token', effectiveToken);
      urlParams.delete('token');
      const cleanUrl = window.location.pathname + (urlParams.toString() ? `?${urlParams.toString()}` : '');
      window.history.replaceState({}, '', cleanUrl);
    }

    setApiToken(effectiveToken);
    setTokenInput(effectiveToken);

    fetchStatus();
    if (effectiveToken) {
      fetchTasks(effectiveToken);
      connectWs(effectiveToken);
    } else {
      setShowAuthModal(true);
    }

    return () => {
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (selectedTaskId) {
      fetchTaskDetails(selectedTaskId);
    }
  }, [selectedTaskId]);

  useEffect(() => {
    if (newWorkspace) {
      inspectRepo(newWorkspace);
    }
  }, [newWorkspace]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPrompt.trim()) return;

    try {
      const res = await apiFetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: newPrompt,
          workspacePath: newWorkspace,
          maxRetries: newRetries,
          agent: selectedAgent,
          autoMerge,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setShowNewTaskModal(false);
        setNewPrompt('');
        fetchTasks();
        setSelectedTaskId(data.task.id);
      } else {
        const errData = await res.json().catch(() => ({}));
        alert(`Failed to launch task: ${errData.error || errData.message || res.statusText || 'Unauthorized'}`);
      }
    } catch (err) {
      alert('Failed to launch task.');
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (apiKeyInput) {
        const res = await apiFetch('/api/config/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: apiKeyInput, model: modelInput }),
        });
        if (!res.ok) {
          throw new Error('Failed to update Gemini config');
        }
      }

      if (tokenInput.trim()) {
        const trimmed = tokenInput.trim();
        localStorage.setItem('orchestrator_api_token', trimmed);
        setApiToken(trimmed);
        fetchTasks(trimmed);
        connectWs(trimmed);
      }

      setShowSettingsModal(false);
      fetchStatus();
      alert('Settings updated successfully!');
    } catch {
      alert('Failed to update settings');
    }
  };

  const handleConnectAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    const candidate = tokenInput.trim();
    if (!candidate) {
      setAuthError('Please enter a valid API token');
      return;
    }

    try {
      const testRes = await fetch('/api/tasks', {
        headers: {
          'Authorization': `Bearer ${candidate}`,
          'x-api-token': candidate,
        },
      });

      if (testRes.ok) {
        localStorage.setItem('orchestrator_api_token', candidate);
        setApiToken(candidate);
        setIsAuthenticated(true);
        setShowAuthModal(false);
        setAuthError('');
        const data = await testRes.json();
        setTasks(data.tasks || []);
        if (data.tasks?.length > 0 && !selectedTaskId) {
          setSelectedTaskId(data.tasks[0].id);
        }
        connectWs(candidate);
      } else {
        setAuthError('Authentication failed: Invalid API token.');
      }
    } catch (err: any) {
      setAuthError(`Connection error: ${err.message || 'Cannot reach server'}`);
    }
  };

  const handleApprove = async (approvalId: string, status: 'APPROVED' | 'REJECTED') => {
    try {
      await apiFetch(`/api/approvals/${approvalId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (selectedTaskId) fetchTaskDetails(selectedTaskId);
    } catch {}
  };

  const selectedTask = taskDetails?.task;
  const plan = selectedTask?.planJson ? JSON.parse(selectedTask.planJson) : null;

  return (
    <div className="app-container">
      {/* Top Navigation */}
      <header className="top-navbar">
        <div className="brand-section">
          <div className="brand-logo">
            <Cpu size={22} color="#fff" />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span className="brand-title">AUTONOMOUS ORCHESTRATOR</span>
              <span className="brand-badge">Local-First</span>
            </div>
          </div>
        </div>

        <div className="nav-actions">
          <div className="status-indicator">
            <span className="pulse-dot" />
            <span>Brain: <strong>{systemStatus?.geminiModel || 'Gemini 3.8 / 2.5 Flash'}</strong></span>
          </div>

          <div className="status-indicator">
            <ShieldCheck size={14} color="#10b981" />
            <span>Independent Verifier: <strong>Enforcing</strong></span>
          </div>

          <button
            className="status-indicator"
            style={{
              cursor: 'pointer',
              background: isAuthenticated ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)',
              border: `1px solid ${isAuthenticated ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
              borderRadius: 20,
              padding: '0.35rem 0.75rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
            }}
            onClick={() => {
              setTokenInput(apiToken);
              setShowAuthModal(true);
            }}
            title="Click to manage Orchestrator Server API Token"
          >
            {isAuthenticated ? (
              <>
                <Key size={14} color="#10b981" />
                <span style={{ color: '#10b981' }}>API Connected</span>
              </>
            ) : (
              <>
                <ShieldAlert size={14} color="#f59e0b" />
                <span style={{ color: '#f59e0b' }}>Auth Required</span>
              </>
            )}
          </button>

          <button className="new-task-btn" onClick={() => setShowNewTaskModal(true)}>
            <PlusCircle size={15} />
            <span>New Task</span>
          </button>

          <button className="btn-secondary" style={{ padding: '0.45rem 0.75rem' }} onClick={() => setShowSettingsModal(true)}>
            <Settings size={15} />
          </button>
        </div>
      </header>

      {/* Main Grid */}
      <main className="dashboard-grid">
        {/* Left Sidebar */}
        <section className="sidebar-panel">
          <div className="panel-header">
            <span className="panel-title">
              <Layers size={14} />
              Tasks & Missions
            </span>
            <button
              onClick={() => fetchTasks()}
              style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer' }}
            >
              <RefreshCw size={14} />
            </button>
          </div>

          <div className="task-list">
            {tasks.length === 0 ? (
              <div style={{ padding: '2rem 1rem', textAlign: 'center', color: '#64748b', fontSize: '0.85rem' }}>
                No active tasks found.<br />Click <strong>New Task</strong> to begin an autonomous run.
              </div>
            ) : (
              tasks.map((t) => (
                <div
                  key={t.id}
                  className={`task-card ${t.id === selectedTaskId ? 'active' : ''}`}
                  onClick={() => setSelectedTaskId(t.id)}
                >
                  <div className="task-card-header">
                    <span className={`task-badge badge-${t.status.toLowerCase()}`}>
                      {t.status}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: '#64748b' }}>
                      {new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="task-card-title">{t.title}</div>
                  <div className="task-card-meta">
                    <span>Retries: {t.retryCount} / {t.maxRetries}</span>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Repo Quick Status Card */}
          {repoMeta && (
            <div style={{ padding: '1rem', borderTop: '1px solid var(--border-subtle)', background: 'rgba(0,0,0,0.2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.4rem' }}>
                <FolderGit2 size={13} color="#06b6d4" />
                <span>Repo: <strong>{repoMeta.branch || 'detached'}</strong></span>
              </div>
              <div style={{ fontSize: '0.72rem', color: '#64748b' }}>
                Ecosystem: {repoMeta.ecosystems?.join(', ') || 'general'} | Build: {repoMeta.buildCmd ? 'Detected' : 'None'}
              </div>
            </div>
          )}
        </section>

        {/* Center Panel: Task Execution Workspace */}
        <section className="center-panel">
          {selectedTask ? (
            <>
              <div className="center-header">
                <div className="task-headline">
                  <h1>{selectedTask.title}</h1>
                  <p>{selectedTask.prompt}</p>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <span className={`task-badge badge-${selectedTask.status.toLowerCase()}`} style={{ fontSize: '0.8rem', padding: '4px 10px' }}>
                    {selectedTask.status}
                  </span>
                </div>
              </div>

              {/* State Transition Flow */}
              <div className="state-stepper">
                {['discovering', 'planning', 'ready', 'executing', 'verifying', 'completed'].map((st, i, arr) => {
                  const currentNorm = selectedTask.status.toLowerCase();
                  const isCurrent = currentNorm === st;
                  const isDone = ['completed'].includes(currentNorm) || (currentNorm !== 'failed' && currentNorm !== 'blocked' && i < arr.indexOf(currentNorm));
                  return (
                    <React.Fragment key={st}>
                      <div className={`step-node ${isCurrent ? 'active' : ''} ${isDone ? 'completed' : ''}`}>
                        {isDone ? <CheckCircle2 size={13} /> : <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />}
                        <span style={{ textTransform: 'uppercase' }}>{st}</span>
                      </div>
                      {i < arr.length - 1 && <div className="step-connector" />}
                    </React.Fragment>
                  );
                })}
              </div>

              <div className="center-content">
                {/* Pending Human Approval Gate */}
                {taskDetails?.pendingApprovals && taskDetails.pendingApprovals.length > 0 && (
                  <div className="approval-banner">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <ShieldAlert size={24} color="#f59e0b" />
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#fbbf24' }}>
                          Human Approval Required
                        </div>
                        <div style={{ fontSize: '0.8rem', color: '#cbd5e1' }}>
                          {taskDetails.pendingApprovals[0].details}
                        </div>
                      </div>
                    </div>
                    <div className="approval-actions">
                      <button
                        className="btn-approve"
                        onClick={() => handleApprove(taskDetails.pendingApprovals[0].id, 'APPROVED')}
                      >
                        Approve Action
                      </button>
                      <button
                        className="btn-reject"
                        onClick={() => handleApprove(taskDetails.pendingApprovals[0].id, 'REJECTED')}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )}

                {/* Plan & Milestones */}
                {plan && (
                  <div className="card-section">
                    <div className="section-title">
                      <Layers size={16} color="#6366f1" />
                      Implementation Plan & Milestones ({plan.steps?.length || 0})
                    </div>
                    <p style={{ fontSize: '0.825rem', color: '#94a3b8', marginBottom: '1rem' }}>
                      {plan.analysis || plan.summary}
                    </p>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {plan.steps?.map((step: any, idx: number) => {
                        const stepRecord = taskDetails?.steps?.find((s) => s.stepIndex === step.index);
                        const isDone = stepRecord?.status === 'COMPLETED';
                        const isFailed = stepRecord?.status === 'FAILED';
                        const isRunning = stepRecord?.status === 'RUNNING';

                        return (
                          <div key={idx} className="milestone-item">
                            <div className="milestone-index">{step.index}</div>
                            <div className="milestone-content">
                              <div className="milestone-header">
                                <span className="milestone-title">{step.title}</span>
                                <span className={`task-badge ${isDone ? 'badge-completed' : isFailed ? 'badge-failed' : isRunning ? 'badge-executing' : 'badge-pending'}`}>
                                  {stepRecord?.status || 'PENDING'}
                                </span>
                              </div>
                              <div className="milestone-desc">{step.instruction}</div>
                              {step.targetFiles?.length > 0 && (
                                <div style={{ marginTop: '0.4rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                  {step.targetFiles.map((tf: string) => (
                                    <span key={tf} style={{ fontSize: '0.7rem', padding: '2px 6px', background: 'rgba(255,255,255,0.05)', borderRadius: 4, color: '#38bdf8' }}>
                                      {tf}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Acceptance Criteria Checklist */}
                {plan?.acceptanceCriteria && (
                  <div className="card-section">
                    <div className="section-title">
                      <ShieldCheck size={16} color="#10b981" />
                      Independent Acceptance Criteria
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {plan.acceptanceCriteria.map((crit: string, i: number) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.825rem', color: '#cbd5e1' }}>
                          <CheckCircle2 size={15} color={selectedTask.status === 'COMPLETED' ? '#10b981' : '#64748b'} />
                          <span>{crit}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Task Outcome Summary if Completed */}
                {selectedTask.summary && (
                  <div className="card-section" style={{ borderColor: 'rgba(16, 185, 129, 0.3)', background: 'rgba(16, 185, 129, 0.05)' }}>
                    <div className="section-title" style={{ color: '#34d399' }}>
                      <CheckCircle2 size={16} />
                      Verified Outcome Summary
                    </div>
                    <p style={{ fontSize: '0.875rem', color: '#e2e8f0', lineHeight: 1.6 }}>
                      {selectedTask.summary}
                    </p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: '#64748b', gap: '0.75rem' }}>
              <Cpu size={40} color="#334155" />
              <p>Select a task from the sidebar or launch a new autonomous mission.</p>
            </div>
          )}
        </section>

        {/* Right Panel: Live Terminal Stream & Verification Reports */}
        <section className="right-panel">
          <div className="tabs-header">
            <button
              className={`tab-btn ${activeTab === 'stream' ? 'active' : ''}`}
              onClick={() => setActiveTab('stream')}
            >
              <Terminal size={14} />
              <span>Live Stream</span>
            </button>
            <button
              className={`tab-btn ${activeTab === 'verifications' ? 'active' : ''}`}
              onClick={() => setActiveTab('verifications')}
            >
              <ShieldCheck size={14} />
              <span>Verifications ({taskDetails?.verifications?.length || 0})</span>
            </button>
            <button
              className={`tab-btn ${activeTab === 'diff' ? 'active' : ''}`}
              onClick={() => setActiveTab('diff')}
            >
              <FileCode size={14} />
              <span>Git Diff</span>
            </button>
          </div>

          {activeTab === 'stream' && (
            <div className="terminal-container">
              {logs.length === 0 ? (
                <div style={{ color: '#475569', textAlign: 'center', marginTop: '2rem' }}>
                  Waiting for orchestrator events...
                </div>
              ) : (
                logs.map((log) => (
                  <div key={log.id} className="log-entry">
                    <span className="log-time">{new Date(log.timestamp).toLocaleTimeString()}</span>
                    <span className={`log-badge ${log.type}`}>[{log.type}]</span>
                    <span>{log.message}</span>
                  </div>
                ))
              )}
              <div ref={terminalEndRef} />
            </div>
          )}

          {activeTab === 'verifications' && (
            <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {taskDetails?.verifications?.length === 0 ? (
                <div style={{ color: '#64748b', textAlign: 'center', marginTop: '2rem', fontSize: '0.85rem' }}>
                  No verification reports filed yet.
                </div>
              ) : (
                taskDetails?.verifications?.map((v) => (
                  <div key={v.id} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '0.85rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                      <span className={`task-badge ${v.status === 'PASSED' ? 'badge-completed' : 'badge-failed'}`}>
                        {v.status}
                      </span>
                      <span style={{ fontSize: '0.7rem', color: '#64748b' }}>
                        {new Date(v.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.775rem', color: '#cbd5e1', display: 'flex', gap: '1rem', marginBottom: '0.4rem' }}>
                      <span>Build: <strong>{v.buildStatus}</strong></span>
                      <span>Tests: <strong>{v.testStatus}</strong></span>
                      <span>Lint: <strong>{v.lintStatus}</strong></span>
                    </div>
                    <div style={{ fontSize: '0.725rem', color: '#94a3b8' }}>
                      Diff: {v.diffInspection}
                    </div>
                    {v.diagnostics && (
                      <pre style={{ marginTop: '0.5rem', padding: '0.5rem', background: '#000', borderRadius: 4, fontSize: '0.7rem', color: '#f87171', overflowX: 'auto' }}>
                        {v.diagnostics}
                      </pre>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'diff' && (
            <div style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
              <div className="diff-container">
                {taskDetails?.steps?.find((s) => s.diffSummary)?.diffSummary ||
                  'No active diff recorded for this task.'}
              </div>
            </div>
          )}
        </section>
      </main>

      {/* New Task Modal */}
      {showNewTaskModal && (
        <div className="modal-overlay" onClick={() => setShowNewTaskModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">Launch Autonomous Coding Task</h2>
            <p style={{ fontSize: '0.825rem', color: '#94a3b8' }}>
              Provide your objective once. The Orchestrator will plan, execute, verify, and repair autonomously.
            </p>

            <form onSubmit={handleCreateTask}>
              <div className="form-group">
                <label>Task Prompt / Objective *</label>
                <textarea
                  className="form-textarea"
                  rows={4}
                  required
                  placeholder="e.g. Build an authentication middleware and write unit tests for token expiration..."
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Workspace Path</label>
                <input
                  type="text"
                  className="form-input"
                  value={newWorkspace}
                  onChange={(e) => setNewWorkspace(e.target.value)}
                />
                <small style={{ color: '#64748b', fontSize: '0.75rem', marginTop: '0.25rem', display: 'block' }}>
                  Must be within authorized workspace roots (configured in .env under ALLOWED_DIRECTORIES).
                </small>
              </div>

              <div className="form-group">
                <label>Coding Agent Adapter</label>
                <select
                  className="form-input"
                  value={selectedAgent}
                  onChange={(e) => setSelectedAgent(e.target.value as any)}
                  style={{ background: '#0f172a', color: '#f8fafc' }}
                >
                  <option value="builtin">Built-in Autonomous Agent (Gemini / Multi-Tool)</option>
                  <option value="claude">Claude Code CLI Adapter</option>
                  <option value="aider">Aider CLI Adapter</option>
                </select>
              </div>

              <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.4rem' }}>
                <input
                  type="checkbox"
                  id="autoMergeCheck"
                  checked={autoMerge}
                  onChange={(e) => setAutoMerge(e.target.checked)}
                  style={{ width: '1.1rem', height: '1.1rem', cursor: 'pointer' }}
                />
                <label htmlFor="autoMergeCheck" style={{ cursor: 'pointer', marginBottom: 0 }}>
                  Auto-merge verified task branch into base branch upon completion
                </label>
              </div>

              <div className="form-group">
                <label>Max Self-Repair Retry Budget</label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  className="form-input"
                  value={newRetries}
                  onChange={(e) => setNewRetries(parseInt(e.target.value, 10))}
                />
              </div>

              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowNewTaskModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Start Autonomous Run
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Auth Modal */}
      {showAuthModal && (
        <div className="modal-overlay" onClick={() => setShowAuthModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.5rem' }}>
              <div style={{ padding: '0.5rem', background: 'rgba(99, 102, 241, 0.15)', borderRadius: 8 }}>
                <Key size={20} color="#6366f1" />
              </div>
              <h2 className="modal-title" style={{ margin: 0 }}>API Authentication Required</h2>
            </div>
            <p style={{ fontSize: '0.825rem', color: '#94a3b8', marginBottom: '1rem' }}>
              The Orchestrator protects execution endpoints with an API Token. Enter your server's token (found in your startup terminal or <code>API_TOKEN</code> in your environment) to connect.
            </p>

            {authError && (
              <div style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid #ef4444', borderRadius: 8, padding: '0.6rem 0.8rem', fontSize: '0.8rem', color: '#fca5a5', marginBottom: '1rem' }}>
                {authError}
              </div>
            )}

            <form onSubmit={handleConnectAuth}>
              <div className="form-group">
                <label>Orchestrator Server API Token *</label>
                <input
                  type="password"
                  className="form-input"
                  required
                  placeholder="Paste 48-char hex token or configured API token"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                />
              </div>

              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowAuthModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Connect & Authenticate
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettingsModal && (
        <div className="modal-overlay" onClick={() => setShowSettingsModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">Orchestrator & Brain Settings</h2>
            <p style={{ fontSize: '0.825rem', color: '#94a3b8', marginBottom: '1rem' }}>
              Configure your server API token, Gemini credentials, and model.
            </p>

            <form onSubmit={handleSaveSettings}>
              <div className="form-group">
                <label>Orchestrator Server API Token</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="Paste API token..."
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Gemini API Key</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="AIzaSy..."
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Gemini Model</label>
                <input
                  type="text"
                  className="form-input"
                  value={modelInput}
                  onChange={(e) => setModelInput(e.target.value)}
                />
              </div>

              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setShowSettingsModal(false)}>
                  Close
                </button>
                <button type="submit" className="btn-primary">
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
