'use client';

/**
 * Legacy route — kept ONLY so existing links and bookmarks keep working.
 *
 * A group's detail is no longer a page of its own: it renders inside the
 * account hub as `?tab=groups&group=<id>` (see
 * `components/iam/group-access-panel.tsx`), so the left rail and the
 * breadcrumb behave exactly like the project access panel's. This file
 * forwards to that URL and renders nothing.
 */

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function GroupDetailRedirectPage() {
  const router = useRouter();
  const params = useParams<{ id: string; groupId: string }>();
  const accountId = params?.id;
  const groupId = params?.groupId;

  useEffect(() => {
    if (!accountId || !groupId) return;
    router.replace(
      `/accounts/${accountId}?tab=groups&group=${encodeURIComponent(groupId)}`,
    );
  }, [accountId, groupId, router]);

  return null;
}
