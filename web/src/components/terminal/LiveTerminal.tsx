import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Terminal,
  Search,
  Copy,
  Check,
  ArrowDown,
  Sparkles,
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
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [copied, setCopied] = useState<boolean>(false);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
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
  }, [logs, filterType, searchQuery]);

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
            placeholder="Filter logs (e.g. error, test, npm)..."
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
              title={autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll paused'}
            >
              <ArrowDown size={12} />
            </motion.button>

            <motion.button
              whileTap={{ scale: 0.9 }}
              className="terminal-tool-btn"
              onClick={handleCopyLogs}
              title="Copy visible logs"
            >
              {copied ? <Check size={12} className="text-emerald" /> : <Copy size={12} />}
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
            <p>Listening for orchestrator events & telemetry...</p>
          </div>
        ) : (
          filteredLogs.map((log, index) => {
            const isRecent = index >= filteredLogs.length - 3;
            return (
              <div
                key={log.id || `${log.timestamp}-${index}`}
                className={`log-line ${isRecent ? 'log-line-fresh' : ''}`}
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
