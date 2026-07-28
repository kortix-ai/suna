'use client';

/**
 * /projects/[id]/customize/[section] — compatibility entry for old links
 * (e.g. `/customize/skills`, `/customize/llm-logs`).
 *
 * Resolves the legacy section to its new route via lib/project-nav, which is
 * exhaustive over all 24 and tested there. The path segment wins; the legacy
 * `?section=` query is the fallback.
 */

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import { resolveLegacyCustomizeHref } from '@/lib/project-nav';

export default function ProjectCustomizeSectionRedirect() {
  const params = useParams<{ id: string; section: string }>();
  const projectId = params?.id ?? '';
  const rawSection = params?.section;
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (!projectId) return;
    const href =
      resolveLegacyCustomizeHref(projectId, rawSection) ??
      resolveLegacyCustomizeHref(projectId, searchParams.get('section'));
    router.replace(href ?? `/projects/${projectId}`);
  }, [projectId, rawSection, searchParams, router]);

  return null;
}
