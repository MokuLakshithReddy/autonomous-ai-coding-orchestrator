import React from 'react';
import {
  Cpu,
  ShieldCheck,
  Key,
  ShieldAlert,
  Plus,
  Settings,
  LayoutDashboard,
  TerminalSquare,
  History,
  Box,
  Menu,
  X,
} from 'lucide-react';
import type { SystemStatus } from '../../types/index.js';
import { Button } from '../ui/Button.js';
import { Badge } from '../ui/Badge.js';

interface AppHeaderProps {
  systemStatus: SystemStatus | null;
  isAuthenticated: boolean;
  activeView: 'dashboard' | 'workspace' | 'history';
  onViewChange: (view: 'dashboard' | 'workspace' | 'history') => void;
  onOpenNewTask: () => void;
  onOpenSettings: () => void;
  onOpenAuth: () => void;
  mobileMenuOpen: boolean;
  onToggleMobileMenu: () => void;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  systemStatus,
  isAuthenticated,
  activeView,
  onViewChange,
  onOpenNewTask,
  onOpenSettings,
  onOpenAuth,
  mobileMenuOpen,
  onToggleMobileMenu,
}) => {
  return (
    <header className="app-header">
      <div className="header-left">
        {/* Mobile menu toggle button */}
        <button
          className="mobile-toggle-btn"
          onClick={onToggleMobileMenu}
          aria-label="Toggle navigation menu"
        >
          {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
        </button>

        {/* Brand Identity */}
        <div className="brand-group" onClick={() => onViewChange('workspace')}>
          <div className="brand-icon">
            <Cpu size={18} />
          </div>
          <div className="brand-titles">
            <span className="brand-main">ORCHESTRATOR</span>
            <span className="brand-sub">AUTONOMOUS AGENT ENGINE</span>
          </div>
        </div>

        {/* View Switcher Tabs (Linear / Vercel style) */}
        <nav className="header-nav">
          <button
            className={`nav-tab ${activeView === 'workspace' ? 'active' : ''}`}
            onClick={() => onViewChange('workspace')}
          >
            <TerminalSquare size={14} />
            <span>Mission Control</span>
          </button>
          <button
            className={`nav-tab ${activeView === 'dashboard' ? 'active' : ''}`}
            onClick={() => onViewChange('dashboard')}
          >
            <LayoutDashboard size={14} />
            <span>Observability</span>
          </button>
          <button
            className={`nav-tab ${activeView === 'history' ? 'active' : ''}`}
            onClick={() => onViewChange('history')}
          >
            <History size={14} />
            <span>Task History</span>
          </button>
        </nav>
      </div>

      <div className="header-right">
        {/* Status Pills */}
        <div className="status-pill-group">
          {/* Brain Model Pill */}
          <div className="system-pill" title="Active LLM Brain">
            <span className="status-dot online" />
            <span className="pill-label">Brain:</span>
            <span className="pill-value">{systemStatus?.geminiModel || 'Gemini'}</span>
          </div>

          {/* Independent Verifier Pill */}
          <div className="system-pill" title="Independent Verification Gate">
            <ShieldCheck size={13} className="text-emerald" />
            <span className="pill-label">Verifier:</span>
            <span className="pill-value text-emerald">Strict</span>
          </div>

          {/* Docker Sandbox Pill */}
          <div
            className="system-pill"
            title={
              systemStatus?.containerSandboxEnabled
                ? 'Isolated Container Execution Active'
                : 'Host Process Sandbox Active'
            }
          >
            <Box size={13} className="text-sky" />
            <span className="pill-label">Sandbox:</span>
            <span className="pill-value">
              {systemStatus?.containerSandboxEnabled ? 'Docker' : 'Local'}
            </span>
          </div>
        </div>

        {/* Authentication Button */}
        <button
          className={`auth-status-btn ${isAuthenticated ? 'authenticated' : 'unauthenticated'}`}
          onClick={onOpenAuth}
          title="Click to configure API Token"
        >
          {isAuthenticated ? (
            <>
              <Key size={13} />
              <span>Token Active</span>
            </>
          ) : (
            <>
              <ShieldAlert size={13} />
              <span>Auth Required</span>
            </>
          )}
        </button>

        {/* Action Buttons */}
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={14} />}
          onClick={onOpenNewTask}
        >
          New Mission
        </Button>

        <button
          className="header-icon-btn"
          onClick={onOpenSettings}
          title="System & API Settings"
        >
          <Settings size={15} />
        </button>
      </div>
    </header>
  );
};

