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
 */

import { useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

import { legacySectionRedirect } from '@/features/workspace/settings/settings-tabs';

export default function ProjectCustomizeSectionRedirect() {
  const params = useParams<{ id: string; section: string }>();
  const projectId = params?.id ?? '';
  const rawSection = params?.section;
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (!projectId) return;
    const redirect =
      legacySectionRedirect(projectId, rawSection) ??
      legacySectionRedirect(projectId, searchParams.get('section')) ??
      `/projects/${projectId}/settings`;
    router.replace(redirect);
  }, [projectId, rawSection, searchParams, router]);

  return null;
}
