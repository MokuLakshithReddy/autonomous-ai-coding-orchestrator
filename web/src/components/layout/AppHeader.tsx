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
  SlidersHorizontal,
} from 'lucide-react';
import { motion } from 'motion/react';
import type { SystemStatus } from '../../types/index.js';
import { Button } from '../ui/Button.js';
import { springs } from '../../lib/motion.js';

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
  onToggleInspectorDrawer?: () => void;
  inspectorDrawerOpen?: boolean;
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
  onToggleInspectorDrawer,
  inspectorDrawerOpen,
}) => {
  const isOnline = systemStatus?.status === 'online';

  const navTabs = [
    { key: 'workspace' as const, label: 'Mission Control', icon: <TerminalSquare size={14} /> },
    { key: 'dashboard' as const, label: 'Observability', icon: <LayoutDashboard size={14} /> },
    { key: 'history' as const, label: 'Task History', icon: <History size={14} /> },
  ];

  return (
    <header className="app-header">
      <div className="header-left">
        {/* Mobile Menu Toggle Button */}
        <motion.button
          whileTap={{ scale: 0.9 }}
          className="mobile-toggle-btn"
          onClick={onToggleMobileMenu}
          aria-label="Toggle navigation menu"
        >
          {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
        </motion.button>

        {/* Brand Identity with Animated Glow & Micro-interaction */}
        <motion.div
          className="brand-group"
          onClick={() => onViewChange('workspace')}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          <motion.div
            className="brand-icon"
            whileHover={{ rotate: [0, -6, 6, 0], scale: 1.08 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
          >
            <Cpu size={18} />
          </motion.div>
          <div className="brand-titles">
            <span className="brand-main">ORCHESTRATOR</span>
            <span className="brand-sub">AUTONOMOUS AGENT ENGINE</span>
          </div>
        </motion.div>

        {/* View Switcher Tabs with Motion layoutId Sliding Indicator */}
        <nav className="header-nav">
          {navTabs.map((tab) => {
            const isActive = activeView === tab.key;
            return (
              <button
                key={tab.key}
                className={`nav-tab ${isActive ? 'active' : ''}`}
                onClick={() => onViewChange(tab.key)}
                style={{ position: 'relative' }}
              >
                {isActive && (
                  <motion.span
                    layoutId="activeNavIndicator"
                    className="active-nav-indicator"
                    transition={springs.snappy}
                  />
                )}
                <span
                  style={{
                    position: 'relative',
                    zIndex: 1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.45rem',
                  }}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="header-right">
        {/* Status Pills */}
        <div className="status-pill-group">
          {/* Brain Model Pill with Online Radar Ping */}
          <div className="system-pill" title="Active LLM Brain">
            <span className="status-dot-wrapper">
              <span className={`status-dot ${isOnline ? 'online' : 'offline'}`} />
              {isOnline && <span className="status-dot-ping" />}
            </span>
            <span className="pill-label">Brain:</span>
            <span className="pill-value">{systemStatus?.geminiModel || 'Gemini'}</span>
          </div>

          {/* Independent Verifier Pill */}
          <div className="system-pill" title="Independent Verification Gate">
            <ShieldCheck size={13} style={{ color: 'var(--status-success)' }} />
            <span className="pill-label">Verifier:</span>
            <span className="pill-value" style={{ color: 'var(--status-success)' }}>
              Strict
            </span>
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
            <Box size={13} style={{ color: 'var(--accent-secondary)' }} />
            <span className="pill-label">Sandbox:</span>
            <span className="pill-value">
              {systemStatus?.containerSandboxEnabled ? 'Docker' : 'Local'}
            </span>
          </div>
        </div>

        {/* Tablet Inspector Toggle Button */}
        {onToggleInspectorDrawer && (
          <motion.button
            whileTap={{ scale: 0.92 }}
            className={`header-icon-btn mobile-inspector-toggle-btn ${
              inspectorDrawerOpen ? 'active' : ''
            }`}
            onClick={onToggleInspectorDrawer}
            title="Toggle Telemetry Inspector"
            aria-label="Toggle Telemetry Inspector"
          >
            <SlidersHorizontal size={15} />
          </motion.button>
        )}

        {/* Authentication Button */}
        <motion.button
          whileHover={{ y: -1 }}
          whileTap={{ scale: 0.96 }}
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
        </motion.button>

        {/* Primary Action Button */}
        <Button
          variant="primary"
          size="sm"
          icon={<Plus size={14} />}
          onClick={onOpenNewTask}
        >
          New Mission
        </Button>

        {/* Settings Button with Gear Rotation Feedback */}
        <motion.button
          whileHover={{ rotate: 60 }}
          whileTap={{ scale: 0.92 }}
          transition={{ type: 'spring', damping: 14, stiffness: 260 }}
          className="header-icon-btn"
          onClick={onOpenSettings}
          title="System & API Settings"
        >
          <Settings size={15} />
        </motion.button>
      </div>
    </header>
  );
};
