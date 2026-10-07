'use client';

/** Copy and the warning marker shared by every secret surface in the tab. */

import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';

/** Said wherever someone would otherwise expect this tab to affect a live run. */
export const ALLOWLIST_IS_CREATE_ONLY =
  'A session’s secret allowlist is fixed when the session is created — there is no update path for it. Adding, rotating or removing a secret here never widens or narrows what a session that is already running may read; that takes a new session.';

/**
 * True of rotation because a live process cannot have its environment rewritten:
 * the platform does push the new value out to active sandboxes, but the agent
 * there is already running with the old one. Only a session started after the
 * rotation is reliably using the new value.
 */
export const ROTATION_REACHES_RUNNING_SESSIONS_LATE =
  'Sessions already running keep the old value until they restart — their agent was started with the old environment and it cannot be replaced in place.';

export function Notice({
  tone = 'muted',
  children,
}: {
  tone?: 'muted' | 'destructive';
  children: ReactNode;
}) {
  return (
    <Marker className={tone === 'destructive' ? 'items-start text-destructive' : 'items-start'}>
      <MarkerIcon className="mt-0.5">
        <AlertTriangle />
      </MarkerIcon>
      <MarkerContent className="whitespace-normal">{children}</MarkerContent>
    </Marker>
  );
}
