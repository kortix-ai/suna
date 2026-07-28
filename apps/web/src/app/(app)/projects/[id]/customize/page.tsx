'use client';

/**
 * /projects/[id]/customize — compatibility entry for old links.
 *
 * Customize's 24 sections are real routes now. This page resolves the legacy
 * section to its new home and replaces, so bookmarks, Cmd+K entries and Slack
 * links keep working. The resolution lives in lib/project-nav, which is
 * exhaustive over every section and tested there.
 */

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import { resolveLegacyCustomizeHref } from '@/lib/project-nav';

export default function ProjectCustomizeRedirect() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (!projectId) return;
    const href = resolveLegacyCustomizeHref(projectId, searchParams.get('section'));
    router.replace(href ?? `/projects/${projectId}`);
  }, [projectId, searchParams, router]);

  return null;
}
