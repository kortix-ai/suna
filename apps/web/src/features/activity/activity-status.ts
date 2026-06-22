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
