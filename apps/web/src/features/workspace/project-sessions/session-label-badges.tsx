'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ProjectSession } from '@kortix/sdk';

/** A session's labels as outline badges: the first `max`, then `+N` with the rest in its title. */
export function SessionLabelBadges({
  session,
  max = 3,
  className,
}: {
  session: Pick<ProjectSession, 'labels'>;
  max?: number;
  className?: string;
}) {
  const labels = session.labels ?? [];
  if (labels.length === 0) return null;
  const shown = labels.slice(0, max);
  const rest = labels.slice(max);
  return (
    <span className={cn('flex min-w-0 shrink items-center gap-1', className)} data-session-labels="true">
      {shown.map((label) => (
        <Badge key={label} variant="outline" size="sm" className="max-w-32" title={label}>
          <span className="truncate">{label}</span>
        </Badge>
      ))}
      {rest.length > 0 ? (
        <Badge variant="muted" size="sm" title={rest.join(', ')}>
          +{rest.length}
        </Badge>
      ) : null}
    </span>
  );
}
