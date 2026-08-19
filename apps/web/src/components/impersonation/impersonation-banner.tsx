'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import Loading from '@/components/ui/loading';
import { clearLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { useImpersonation, useStopImpersonation } from '@kortix/sdk/react';
import { EyeIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

/**
 * The act-as banner: while a platform admin is inside a customer's account,
 * this says so, everywhere, until they leave.
 *
 * Three deliberate properties:
 *
 *  - **Not dismissible.** Every request from this tab carries the grant, so a
 *    banner the operator can hide would be a lie. The only way to remove it is
 *    to actually stop acting as the account.
 *  - **Mounted app-wide**, not per route. The operator navigates the whole
 *    product inside the session; a banner that only exists on one page is a
 *    banner that isn't there when it matters.
 *  - **Floating, bottom-centre**, not a top bar. Every app surface already
 *    owns `top-0` for its own sticky header, so a full-width top bar would
 *    push or overlap chrome on every page in the product. This sits above
 *    everything (z-120, one step over the maintenance banner) without moving a
 *    single pixel of layout.
 *
 * All state lives in the SDK (`useImpersonation` / `useStopImpersonation`).
 * This file is markup and a countdown.
 */

/** "expires in 42m" / "expires in 38s". Coarse on purpose — the exact second
 *  is noise, and the only decision it drives is "do I re-open the account?". */
function formatRemaining(expiresAt: string, now: number): string {
  const remainingMs = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'expired';
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `expires in ${hours}h ${minutes % 60}m`;
  }
  if (minutes >= 1) return `expires in ${minutes}m`;
  return `expires in ${Math.max(1, Math.floor(remainingMs / 1000))}s`;
}

export function ImpersonationBanner() {
  const session = useImpersonation();
  const stop = useStopImpersonation();
  const [now, setNow] = useState(() => Date.now());

  // Ticks every 15s: fine enough that the minute countdown never looks stuck,
  // coarse enough to be free. The store drops the session by itself once the
  // grant lapses, so this only has to keep the label honest.
  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(interval);
  }, [session]);

  if (!session) return null;

  const exit = () => {
    // Revoke server-side, then reload. The reload is what clears every piece of
    // in-memory state that was fetched as the customer — a soft state reset
    // would leave stale account data behind the operator's own identity.
    stop.mutate(
      { grantId: session.grantId },
      {
        onSettled: () => {
          // Leave nothing pointing into the customer's account behind.
          clearLastProjectId();
          // Hard load on purpose: this is a full identity change back to the
          // operator, and a soft transition would keep cached customer data.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign('/admin/accounts');
        },
      },
    );
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-4 z-[120] flex justify-center px-4"
    >
      <div
        className={cn(
          'bg-background border-kortix-orange/30 pointer-events-auto flex max-w-[calc(100vw-2rem)]',
          'items-center gap-3 rounded-[0.64rem] border py-2 pr-2 pl-3 shadow-lg',
        )}
      >
        <span className="bg-kortix-orange/10 text-kortix-orange flex size-7 shrink-0 items-center justify-center rounded-sm">
          <EyeIcon className="size-4" weight="bold" />
        </span>
        <span className="min-w-0 text-sm">
          <span className="text-muted-foreground">Acting as </span>
          <span className="text-foreground font-medium">
            {session.accountName || session.accountId}
          </span>
          <span className="text-muted-foreground tabular-nums">
            {' · '}
            {formatRemaining(session.expiresAt, now)}
          </span>
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={exit}
          disabled={stop.isPending}
          className="shrink-0"
        >
          {stop.isPending && <Loading variant="spokes" className="size-3.5" />}
          Exit
        </Button>
      </div>
    </div>
  );
}
