'use client';

/**
 * /projects/[id]/customize — the Customize index page for a BARE visit (no
 * `?section=`), and a legacy deep-link entry for everything else.
 *
 * Two jobs, cleanly split by whether a section is named:
 *
 *  1. No section → this IS the real page now. It renders `CustomizeIndexPage`,
 *     a card grid over every top-level Customize tab (Models, Connectors,
 *     Agents, Skills, Triggers, Secrets, Members, Settings), so clicking the
 *     sidebar's Customize row lands somewhere that introduces the whole
 *     surface instead of jumping straight into whichever tab the caller could
 *     read first. `ProjectCustomizeNavItem`'s href points HERE now, not at
 *     `capabilityTabHref(projectId, tab)` — see that component.
 *  2. A section named (`?section=git`, `/customize?section=billing`, …) →
 *     unchanged legacy-bookmark behavior: resolve it through
 *     `legacySectionRedirect` (via the hook, since seven account-scoped ids
 *     resolve to `/accounts/[id]` and need an account id first) and replace
 *     straight there. An unresolvable section still falls back to the bare
 *     `/settings` route.
 */

import { useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

import { CustomizeIndexPage } from '@/features/workspace/capabilities/index/customize-index-page';
import { useLegacySectionRedirect } from '@/features/workspace/settings/use-account-section-redirect';

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

  if (!rawSection && projectId) return <CustomizeIndexPage projectId={projectId} />;
  return null;
}
