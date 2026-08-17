import type { ProjectSession } from '@kortix/sdk';
import { ShareNetworkIcon } from '@phosphor-icons/react';

import { sessionIsShared } from '@/components/projects/session-label';
import { cn } from '@/lib/utils';

type SessionOwnership = Pick<ProjectSession, 'is_owner' | 'owner_name' | 'owner_email'>;

/** Minimal ownership marker for every accessible session the viewer does not own. */
export function SessionSharedIcon({
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
    <span
      className={cn(
        'text-muted-foreground/70 flex size-4 shrink-0 items-center justify-center',
        className,
      )}
      role="img"
      aria-label={label}
      title={label}
      data-session-shared="true"
    >
      <ShareNetworkIcon className="size-3" />
    </span>
  );
}
