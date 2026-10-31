import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Terminal,
  Search,
  Copy,
  Check,
  ArrowDown,
  Layers,
  Globe,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { WsEvent } from '../../types/index.js';
import { formatTimestamp } from '../../lib/formatters.js';

interface LiveTerminalProps {
  logs: WsEvent[];
  selectedTaskId: string | null;
}

export const LiveTerminal: React.FC<LiveTerminalProps> = ({ logs, selectedTaskId }) => {
  const [filterType, setFilterType] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [scope, setScope] = useState<'task' | 'all'>('task');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [copied, setCopied] = useState<boolean>(false);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  // State-driven fresh event tracking (fixes ref re-render bug)
  const knownEventIdsRef = useRef<Set<string>>(new Set());
  const [freshEventIds, setFreshEventIds] = useState<Set<string>>(() => new Set());
  const isFirstRender = useRef(true);
  const activeTimeoutsRef = useRef<number[]>([]);

  useEffect(() => {
    // Initial mount: record all historical logs so they never flash as fresh
    if (isFirstRender.current) {
      logs.forEach((l, idx) => knownEventIdsRef.current.add(l.id || `${l.timestamp}-${idx}`));
      isFirstRender.current = false;
      return;
    }

    // Identify genuinely new events received since last render
    const brandNewKeys: string[] = [];
    logs.forEach((l, idx) => {
      const key = l.id || `${l.timestamp}-${idx}`;
      if (!knownEventIdsRef.current.has(key)) {
        knownEventIdsRef.current.add(key);
        brandNewKeys.push(key);
      }
    });

    if (brandNewKeys.length > 0) {
      setFreshEventIds((prev) => {
        const next = new Set(prev);
        brandNewKeys.forEach((k) => next.add(k));
        return next;
      });

      // Expire fresh highlight after 1.8s
      const timerId = window.setTimeout(() => {
        setFreshEventIds((prev) => {
          const next = new Set(prev);
          brandNewKeys.forEach((k) => next.delete(k));
          return next;
        });
      }, 1800);

      activeTimeoutsRef.current.push(timerId);
    }
  }, [logs]);

  // Clean up all pending highlight timeouts on unmount
  useEffect(() => {
    return () => {
      activeTimeoutsRef.current.forEach((t) => clearTimeout(t));
      activeTimeoutsRef.current = [];
    };
  }, []);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (scope === 'task' && selectedTaskId && log.taskId && log.taskId !== selectedTaskId) {
        return false;
      }

      const matchesSearch =
        searchQuery === '' ||
        log.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
        log.type.toLowerCase().includes(searchQuery.toLowerCase());

      if (!matchesSearch) return false;

      if (filterType === 'ALL') return true;
      if (filterType === 'STEPS') return log.type.includes('STEP');
      if (filterType === 'VERIFY') return log.type.includes('VERIF');
      if (filterType === 'REPAIR') return log.type.includes('REPAIR') || log.type.includes('DIAGNOS');
      if (filterType === 'APPROVAL') return log.type.includes('APPROVAL');
      if (filterType === 'ERROR') return log.type.includes('FAIL') || log.type.includes('ERROR');
      return true;
    });
  }, [logs, scope, selectedTaskId, filterType, searchQuery]);

  useEffect(() => {
    if (autoScroll) {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredLogs, autoScroll]);

  const handleCopyLogs = () => {
    const text = filteredLogs
      .map((l) => `[${formatTimestamp(l.timestamp)}] [${l.type}] ${l.message}`)
      .join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const getBadgeClass = (type: string) => {
    if (type.includes('COMPLETED') || type.includes('PASSED')) return 'badge-passed';
    if (type.includes('FAILED') || type.includes('ERROR')) return 'badge-failed';
    if (type.includes('REPAIR') || type.includes('DIAGNOS')) return 'badge-repair';
    if (type.includes('STEP')) return 'badge-step';
    if (type.includes('PLAN')) return 'badge-plan';
    return 'badge-info';
  };

  return (
    <div className="terminal-panel-wrapper">
      {/* Terminal Toolbar */}
      <div className="terminal-toolbar">
        <div className="terminal-search-row">
          <Search size={12} className="text-muted" />
          <input
            type="text"
            className="terminal-search-input"
            placeholder="Search logs (grep errors, tests, cmds)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="clear-btn" onClick={() => setSearchQuery('')}>
              ×
            </button>
          )}
        </div>

        <div className="terminal-actions-row">
          {/* Scope Toggle: Task vs System */}
          <div className="terminal-scope-toggle">
            <button
              className={`terminal-scope-btn ${scope === 'task' ? 'active' : ''}`}
              onClick={() => setScope('task')}
              title="Filter to currently selected mission events"
            >
              Mission
            </button>
            <button
              className={`terminal-scope-btn ${scope === 'all' ? 'active' : ''}`}
              onClick={() => setScope('all')}
              title="Show all system events"
            >
              All Events
            </button>
          </div>

          {/* Filter Pills */}
          <div className="terminal-filters">
            {(['ALL', 'STEPS', 'VERIFY', 'REPAIR', 'APPROVAL', 'ERROR'] as const).map(
              (f) => (
                <button
                  key={f}
                  className={`term-filter-pill ${filterType === f ? 'active' : ''}`}
                  onClick={() => setFilterType(f)}
                >
                  {f}
                </button>
              )
            )}
          </div>

          {/* Toolbar Utilities */}
          <div className="terminal-utils">
            <motion.button
              whileTap={{ scale: 0.9 }}
              className={`terminal-tool-btn ${autoScroll ? 'active' : ''}`}
              onClick={() => setAutoScroll(!autoScroll)}
              title={autoScroll ? 'Auto-scroll ON' : 'Auto-scroll PAUSED'}
            >
              <ArrowDown size={12} />
            </motion.button>

            <motion.button
              whileTap={{ scale: 0.9 }}
              className="terminal-tool-btn"
              onClick={handleCopyLogs}
              title="Copy visible logs"
            >
              {copied ? (
                <Check size={12} style={{ color: 'var(--status-success)' }} />
              ) : (
                <Copy size={12} />
              )}
            </motion.button>
          </div>
        </div>
      </div>

      {/* Terminal Log Output */}
      <div className="terminal-feed" role="region" aria-label="Live logs terminal">
        {filteredLogs.length === 0 ? (
          <div className="terminal-empty-state">
            <div className="terminal-waiting-pulse">
              <span className="waiting-dot dot-1" />
              <span className="waiting-dot dot-2" />
              <span className="waiting-dot dot-3" />
            </div>
            <p>
              {scope === 'task'
                ? 'No telemetry logs recorded for this mission yet...'
                : 'Listening for live orchestrator events...'}
            </p>
          </div>
        ) : (
          filteredLogs.map((log, index) => {
            const key = log.id || `${log.timestamp}-${index}`;
            const isFresh = freshEventIds.has(key);
            const isError = log.type.includes('FAIL') || log.type.includes('ERROR');
            const isPassed = log.type.includes('PASSED') || log.type.includes('VERIF_PASS');

            return (
              <motion.div
                key={key}
                initial={isFresh ? { opacity: 0, x: -8 } : false}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className={`log-line ${isFresh ? 'log-line-fresh' : ''} ${
                  isError ? 'log-line-error' : isPassed ? 'log-line-verified' : ''
                }`}
              >
                <span className="log-timestamp">{formatTimestamp(log.timestamp)}</span>
                <span className={`log-event-tag ${getBadgeClass(log.type)}`}>
                  {log.type}
                </span>
                <span className="log-message-text">{log.message}</span>
              </motion.div>
            );
          })
        )}
        <div ref={terminalEndRef} />
      </div>
    </div>
  );
};
