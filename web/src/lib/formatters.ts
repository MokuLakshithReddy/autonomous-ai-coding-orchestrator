export function formatTimestamp(isoString?: string): string {
  if (!isoString) return '--:--';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '--:--';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '--:--';
  }
}

export function formatDateRel(isoString?: string): string {
  if (!isoString) return 'recently';
  try {
    const diffMs = Date.now() - new Date(isoString).getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 45) return 'just now';
    if (diffSec < 90) return '1m ago';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return new Date(isoString).toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return 'recently';
  }
}

export function formatDuration(startIso?: string, endIso?: string): string {
  if (!startIso) return '-';
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (isNaN(start)) return '-';
  const totalSec = Math.max(0, Math.floor((end - start) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  return `${mins}m ${remSec}s`;
}

export function getStatusColor(status?: string): {
  bg: string;
  text: string;
  border: string;
  dot: string;
} {
  const norm = (status || '').toLowerCase();
  switch (norm) {
    case 'completed':
    case 'passed':
      return {
        bg: 'rgba(16, 185, 129, 0.12)',
        text: '#34d399',
        border: 'rgba(16, 185, 129, 0.25)',
        dot: '#10b981',
      };
    case 'executing':
    case 'running':
      return {
        bg: 'rgba(59, 130, 246, 0.12)',
        text: '#60a5fa',
        border: 'rgba(59, 130, 246, 0.25)',
        dot: '#3b82f6',
      };
    case 'verifying':
      return {
        bg: 'rgba(14, 165, 233, 0.12)',
        text: '#38bdf8',
        border: 'rgba(14, 165, 233, 0.25)',
        dot: '#0ea5e9',
      };
    case 'diagnosing':
      return {
        bg: 'rgba(245, 158, 11, 0.12)',
        text: '#fbbf24',
        border: 'rgba(245, 158, 11, 0.25)',
        dot: '#f59e0b',
      };
    case 'repairing':
      return {
        bg: 'rgba(236, 72, 153, 0.12)',
        text: '#f472b6',
        border: 'rgba(236, 72, 153, 0.25)',
        dot: '#ec4899',
      };
    case 'planning':
    case 'discovering':
      return {
        bg: 'rgba(168, 85, 247, 0.12)',
        text: '#c084fc',
        border: 'rgba(168, 85, 247, 0.25)',
        dot: '#a855f7',
      };
    case 'awaiting_approval':
    case 'needs_human_review':
    case 'blocked':
      return {
        bg: 'rgba(249, 115, 22, 0.12)',
        text: '#fb923c',
        border: 'rgba(249, 115, 22, 0.25)',
        dot: '#f97316',
      };
    case 'failed':
      return {
        bg: 'rgba(244, 63, 94, 0.12)',
        text: '#fb7185',
        border: 'rgba(244, 63, 94, 0.25)',
        dot: '#f43f5e',
      };
    case 'cancelled':
    case 'cancelling':
      return {
        bg: 'rgba(100, 116, 139, 0.12)',
        text: '#94a3b8',
        border: 'rgba(100, 116, 139, 0.25)',
        dot: '#64748b',
      };
    default:
      return {
        bg: 'rgba(148, 163, 184, 0.08)',
        text: '#cbd5e1',
        border: 'rgba(148, 163, 184, 0.2)',
        dot: '#94a3b8',
      };
  }
}

