import type { StatusTone } from '@/components/ui/status';
import type { ProjectSessionStatus } from '@/lib/projects-client';

const LIVE_STATUSES: readonly ProjectSessionStatus[] = [
  'queued',
  'branching',
  'provisioning',
  'running',
];

/** A run that is still booting or working — drives polling + the pulsing dot. */
export function isLiveRun(status: ProjectSessionStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

/** Map a run's status to a design-system status tone (StatusBadge / StatusDot). */
export function runStatusTone(status: ProjectSessionStatus): StatusTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'destructive';
    case 'running':
      return 'info';
    case 'queued':
    case 'branching':
    case 'provisioning':
      return 'warning';
    case 'stopped':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function runStatusLabel(status: ProjectSessionStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'branching':
      return 'Branching';
    case 'provisioning':
      return 'Provisioning';
    case 'running':
      return 'Running';
    case 'stopped':
      return 'Stopped';
    case 'failed':
      return 'Failed';
    case 'completed':
      return 'Completed';
    default:
      return status;
  }
}

export type RunStatusFilter = 'all' | 'running' | 'failed' | 'completed';

export const RUN_STATUS_FILTERS: ReadonlyArray<{ value: RunStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'failed', label: 'Failed' },
  { value: 'completed', label: 'Completed' },
];

/** Outcome filter for the Activity list. `running` = any still-live run. */
export function matchesRunStatus(status: ProjectSessionStatus, filter: RunStatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'running':
      return isLiveRun(status);
    case 'failed':
      return status === 'failed';
    case 'completed':
      return status === 'completed';
    default:
      return true;
  }
}

/**
 * Human duration between two ISO timestamps — "45s", "1m 23s", "2h 5m".
 * Pure + deterministic (no wall-clock); returns null for an invalid or
 * non-positive span, so it's only meaningful for a finished run.
 */
export function formatRunDuration(startIso: string, endIso: string): string | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const ms = end - start;
  if (ms <= 0) return null;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Compact USD for a per-run cost — more precision for cheap runs. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
