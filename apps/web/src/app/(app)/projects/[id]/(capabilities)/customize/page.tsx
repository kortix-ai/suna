'use client';

/**
 * /projects/[id]/customize — a redirect, in two directions.
 *
 *  1. No `?section=` → the first capability tab the caller may open, through
 *     the same `TAB_PREFERENCE` the sidebar's Customize row uses. That is
 *     Agents for anyone who can read them: Customize is agent-centric (Marko,
 *     2026-09-01) and the agent list IS the landing page. This route used to
 *     render `CustomizeIndexPage`, a seven-band chooser over every tab; the
 *     chooser is gone, but the URL is not — the command palette
 *     (`lib/menu-registry.ts`), the project-shell shortcut and the close-tab
 *     fallback all still name it, and so do bookmarks.
 *  2. A section named (`?section=git`, `?section=billing`, …) → unchanged
 *     legacy-bookmark behavior: resolve it through `legacySectionRedirect`
 *     (via the hook, since seven account-scoped ids resolve to
 *     `/accounts/[id]` and need an account id first) and replace straight
 *     there. An unresolvable section still falls back to the bare `/settings`
 *     route.
 *
 * The skeleton it paints while the probe resolves is the same one the
 * capability routes' `loading.tsx` paints, so the handover into the Agents
 * page fills placeholders in place instead of flashing a blank.
 */

import { useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

import { CapabilitiesSkeleton } from '@/features/workspace/capabilities/shared/capability-skeleton';
import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { TAB_PREFERENCE } from '@/features/workspace/project-sidebar/project-settings-nav';
import { useLegacySectionRedirect } from '@/features/workspace/settings/use-account-section-redirect';
import { useProjectPageCans } from '@/lib/use-project-can';

export default function ProjectCustomizePage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  const searchParams = useSearchParams();
  const router = useRouter();
  const rawSection = searchParams.get('section');

  // The hook, not `legacySectionRedirect`: `?section=billing` and its seven
  // account-scoped siblings resolve to `/accounts/[id]`, which needs an
  // account id. It reports `pending` while it resolves one; replacing early
  // would fall back to the bare overlay and lose the destination.
  const legacy = useLegacySectionRedirect(projectId, rawSection);

  useEffect(() => {
    if (!projectId || !rawSection) return;
    if (legacy.pending) return;
    router.replace(legacy.href ?? `/projects/${projectId}/settings`);
  }, [projectId, rawSection, legacy.href, legacy.pending, router]);

  // Same batch and same preference order as the sidebar row, so the two can
  // never land a person on different tabs. Waits for the probes to settle
  // rather than jumping on the optimistic answer: a redirect is a commitment,
  // and landing on a tab that then 403s is worse than a beat of skeleton.
  const caps = useProjectPageCans(projectId || undefined);
  const settled = TAB_PREFERENCE.every((tab) => !caps[tab.action]?.isLoading);
  const landing = TAB_PREFERENCE.find((tab) => caps[tab.action]?.allowed)?.key ?? null;

  useEffect(() => {
    if (!projectId || rawSection) return;
    if (!settled) return;
    // Denied every tab: `ProjectCustomizeNavItem` never rendered a row for
    // this caller, so this is a typed URL. The project home is the honest
    // place to send them — nothing under Customize would open.
    router.replace(landing ? capabilityTabHref(projectId, landing) : `/projects/${projectId}`);
  }, [projectId, rawSection, settled, landing, router]);

  if (!rawSection && projectId) return <CapabilitiesSkeleton />;
  return null;
}
