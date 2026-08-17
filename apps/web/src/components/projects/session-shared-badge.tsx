import type { ProjectSession } from '@kortix/sdk';

import { sessionIsShared } from '@/components/projects/session-label';
import { Badge } from '@/components/ui/badge';

type SessionOwnership = Pick<ProjectSession, 'is_owner' | 'owner_name' | 'owner_email'>;

/** Visible ownership marker for every accessible session the viewer does not own. */
export function SessionSharedBadge({
  session,
  className,
}: {
  session: SessionOwnership;
  className?: string;
}) {
  if (!sessionIsShared(session)) return null;

  const owner = session.owner_name || session.owner_email;
  const label = owner ? `Shared by ${owner}` : 'Shared session';

  return (
    <Badge
      variant="kortix"
      size="xs"
      className={className}
      aria-label={label}
      title={label}
      data-session-shared="true"
    >
      Shared
    </Badge>
  );
}
