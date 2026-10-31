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
        bg: 'rgba(52, 211, 153, 0.12)',
        text: '#34D399',
        border: 'rgba(52, 211, 153, 0.28)',
        dot: '#34D399',
      };
    case 'executing':
    case 'running':
    case 'ready':
      return {
        bg: 'rgba(56, 189, 248, 0.12)',
        text: '#38BDF8',
        border: 'rgba(56, 189, 248, 0.28)',
        dot: '#38BDF8',
      };
    case 'verifying':
      return {
        bg: 'rgba(56, 189, 248, 0.14)',
        text: '#38BDF8',
        border: 'rgba(56, 189, 248, 0.32)',
        dot: '#38BDF8',
      };
    case 'diagnosing':
      return {
        bg: 'rgba(251, 191, 36, 0.12)',
        text: '#FBBF24',
        border: 'rgba(251, 191, 36, 0.28)',
        dot: '#FBBF24',
      };
    case 'repairing':
      return {
        bg: 'rgba(167, 139, 250, 0.14)',
        text: '#A78BFA',
        border: 'rgba(167, 139, 250, 0.32)',
        dot: '#A78BFA',
      };
    case 'planning':
    case 'discovering':
      return {
        bg: 'rgba(139, 124, 255, 0.12)',
        text: '#8B7CFF',
        border: 'rgba(139, 124, 255, 0.28)',
        dot: '#8B7CFF',
      };
    case 'awaiting_approval':
    case 'needs_human_review':
    case 'blocked':
      return {
        bg: 'rgba(251, 191, 36, 0.12)',
        text: '#FBBF24',
        border: 'rgba(251, 191, 36, 0.28)',
        dot: '#FBBF24',
      };
    case 'failed':
      return {
        bg: 'rgba(251, 113, 133, 0.12)',
        text: '#FB7185',
        border: 'rgba(251, 113, 133, 0.28)',
        dot: '#FB7185',
      };
    case 'cancelled':
    case 'cancelling':
      return {
        bg: 'rgba(148, 163, 184, 0.12)',
        text: '#94A3B8',
        border: 'rgba(148, 163, 184, 0.24)',
        dot: '#94A3B8',
      };
    default:
      return {
        bg: 'rgba(148, 163, 184, 0.08)',
        text: '#A7B4C7',
        border: 'rgba(148, 163, 184, 0.18)',
        dot: '#94A3B8',
      };
  }
}
