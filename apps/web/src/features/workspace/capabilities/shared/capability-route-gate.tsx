'use client';

/**
 * Closes the direct route into a standalone capability page while #6054 is
 * flagged off.
 *
 * Gating the navigation (`capabilityTabHref`) stops the product LINKING here,
 * but not a bookmark, a pasted URL, a command-palette entry with a literal
 * href, or a browser-history entry from before the flag was turned off. Those
 * would otherwise land on the regressed page that is supposed to be hidden, so
 * the route itself has to bounce.
 *
 * Sends you to the Customize overlay on the same section — the surface these
 * pages replaced — so the destination still answers what you came for.
 */
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';

import { CapabilitiesSkeleton } from '@/features/workspace/capabilities/shared/capability-skeleton';
import { type CapabilitySection, capabilityPagesEnabled } from '@/lib/capability-pages';

export function CapabilityRouteGate({
  projectId,
  section,
  children,
}: {
  projectId: string;
  section: CapabilitySection;
  children: ReactNode;
}) {
  const router = useRouter();
  const enabled = capabilityPagesEnabled();

  useEffect(() => {
    if (enabled) return;
    // `replace`, not `push`: the hidden page must not sit in history where Back
    // would return to it.
    router.replace(`/projects/${projectId}/customize/${section}`);
  }, [enabled, projectId, section, router]);

  // Render the skeleton rather than the page during the redirect — mounting the
  // real page would fire its queries and flash the surface we are hiding.
  if (!enabled) return <CapabilitiesSkeleton />;

  return <>{children}</>;
}
