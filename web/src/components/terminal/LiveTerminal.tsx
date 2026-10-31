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
import { motion } from 'motion/react';
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

  // Track initial events so historical logs don't flash as fresh on mount
  const knownEventIdsRef = useRef<Set<string>>(new Set());
  const freshEventIdsRef = useRef<Set<string>>(new Set());
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      logs.forEach((l, idx) => knownEventIdsRef.current.add(l.id || `${l.timestamp}-${idx}`));
      isFirstRender.current = false;
      return;
    }

    logs.forEach((l, idx) => {
      const key = l.id || `${l.timestamp}-${idx}`;
      if (!knownEventIdsRef.current.has(key)) {
        knownEventIdsRef.current.add(key);
        freshEventIdsRef.current.add(key);
        setTimeout(() => {
          freshEventIdsRef.current.delete(key);
        }, 2000);
      }
    });
  }, [logs]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      // Meaningful task-level filtering vs system-wide
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
            {(['ALL', 'STEPS', 'VERIFY', 'REPAIR', 'ERROR'] as const).map((cat) => (
              <button
                key={cat}
                className={`terminal-filter-pill ${filterType === cat ? 'active' : ''}`}
                onClick={() => setFilterType(cat)}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="terminal-btn-group">
            <motion.button
              whileTap={{ scale: 0.9 }}
              className={`terminal-tool-btn ${autoScroll ? 'active' : ''}`}
              onClick={() => setAutoScroll(!autoScroll)}
              title={autoScroll ? 'Auto-scroll active' : 'Auto-scroll paused'}
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
            const isFresh = freshEventIdsRef.current.has(key);

            return (
              <div
                key={key}
                className={`log-line ${isFresh ? 'log-line-fresh' : ''}`}
              >
                <span className="log-timestamp">{formatTimestamp(log.timestamp)}</span>
                <span className={`log-event-tag ${getBadgeClass(log.type)}`}>
                  {log.type}
                </span>
                <span className="log-message-text">{log.message}</span>
              </div>
            );
          })
        )}
        <div ref={terminalEndRef} />
      </div>
    </div>
  );
};
