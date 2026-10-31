import React, { useState } from 'react';
import { Copy, Check, FileDiff, GitCommit } from 'lucide-react';
import { Button } from '../ui/Button.js';

interface DiffViewerProps {
  diffText?: string;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ diffText }) => {
  const [copied, setCopied] = useState(false);

  if (!diffText || diffText.trim() === '') {
    return (
      <div className="diff-empty-state">
        <FileDiff size={32} className="text-muted" />
        <p className="empty-heading">No active diff recorded</p>
        <p className="empty-subtext">
          Once the agent modifies files in the isolated worktree, the verified git diff will appear here.
        </p>
      </div>
    );
  }

  const lines = diffText.split('\n');
  const additions = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const deletions = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

  const handleCopy = () => {
    navigator.clipboard.writeText(diffText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="diff-viewer-wrapper">
      {/* Diff Toolbar */}
      <div className="diff-toolbar">
        <div className="diff-stats">
          <span className="diff-stat-add" title="Lines added">+{additions}</span>
          <span className="diff-stat-del" title="Lines removed">-{deletions}</span>
          <span className="diff-total-lines">{lines.length} lines</span>
        </div>

        <button className="diff-copy-btn" onClick={handleCopy}>
          {copied ? (
            <>
              <Check size={12} className="text-emerald" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy size={12} />
              <span>Copy Diff</span>
            </>
          )}
        </button>
      </div>

      {/* Diff Content View */}
      <div className="diff-content-feed">
        {lines.map((line, idx) => {
          let lineType = 'normal';
          if (line.startsWith('diff --git') || line.startsWith('index ')) {
            lineType = 'meta';
          } else if (line.startsWith('---') || line.startsWith('+++')) {
            lineType = 'header';
          } else if (line.startsWith('@@')) {
            lineType = 'hunk';
          } else if (line.startsWith('+')) {
            lineType = 'addition';
          } else if (line.startsWith('-')) {
            lineType = 'deletion';
          }

          return (
            <div key={idx} className={`diff-line-row line-${lineType}`}>
              <span className="diff-line-num">{idx + 1}</span>
              <span className="diff-line-content">{line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

