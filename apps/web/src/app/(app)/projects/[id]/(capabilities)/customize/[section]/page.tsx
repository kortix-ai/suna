'use client';

/**
 * /projects/[id]/customize/[section] — legacy deep-link entry into what is
 * now the Settings overlay (e.g. `/customize/git`, `/customize/agents`). The
 * Customize overlay itself no longer exists — it was merged into Settings
 * (see `features/workspace/settings/settings-panel.tsx`) — and this route is
 * kept ONLY so bookmarks / Cmd+K deep links keep working: it resolves the
 * path segment (preferring it) or the legacy `?section=` query through
 * `legacySectionRedirect`, which folds every renamed tab (`git` ->
 * `repositories`, `commands` -> `instructions`, every `llm-*` -> `models`,
 * ...) and every graduated section (`agents`, `connectors`, `skills`, ...)
 * onto its current home, and replaces straight there. An unresolvable
 * segment falls back to the bare `/settings` route.
 *
 * `useLegacySectionRedirect` rather than `legacySectionRedirect` directly:
 * the account-scoped ids (`billing`, `api-keys`, `audit`, ...) resolve to
 * `/accounts/[id]`, which needs an account id this route does not have in
 * hand. The hook fetches one only for those ids, and reports `pending` while
 * it does — replacing early would drop the destination and fall back to the
 * bare overlay.
 */

import { useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

import { useLegacySectionRedirect } from '@/features/workspace/settings/use-account-section-redirect';

export default function ProjectCustomizeSectionRedirect() {
  const params = useParams<{ id: string; section: string }>();
  const projectId = params?.id ?? '';
  const rawSection = params?.section;
  const searchParams = useSearchParams();
  const router = useRouter();

  // The path segment wins; the legacy `?section=` query is the fallback. Both
  // go through the hook, so either one can be an account-scoped id.
  const fromSegment = useLegacySectionRedirect(projectId, rawSection);
  const fromQuery = useLegacySectionRedirect(projectId, searchParams.get('section'));

  useEffect(() => {
    if (!projectId) return;
    if (fromSegment.pending || fromQuery.pending) return;
    router.replace(fromSegment.href ?? fromQuery.href ?? `/projects/${projectId}/settings`);
  }, [projectId, fromSegment.href, fromSegment.pending, fromQuery.href, fromQuery.pending, router]);

  return null;
}
