'use client';

/**
 * /workspaces/[id]/members — a legacy link (bookmarks, emails, the palette's
 * older rows). Members is a section of the one Settings panel:
 * `/workspaces/<id>/admin/members`. The query (`?member=<id>`) survives.
 */

import { workspaceSettingsPath } from '@kortix/shared/workspace-settings';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

export default function WorkspaceMembersRedirect() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const projectId = params?.id ?? '';

  useEffect(() => {
    if (!projectId) return;
    const query = searchParams?.toString();
    router.replace(`${workspaceSettingsPath(projectId, 'members')}${query ? `?${query}` : ''}`);
  }, [projectId, router, searchParams]);

  return null;
}
