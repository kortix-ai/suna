'use client';

/**
 * Legacy route — kept ONLY so existing links and bookmarks keep working.
 *
 * A member's detail is no longer a page of its own: it renders inside the
 * account hub as `?tab=members&member=<id>` (see
 * `components/iam/member-access-panel.tsx`), so the left rail and the
 * breadcrumb behave exactly like the project access panel's. This file
 * forwards to that URL and renders nothing.
 */

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function MemberDetailRedirectPage() {
  const router = useRouter();
  const params = useParams<{ id: string; userId: string }>();
  const accountId = params?.id;
  const userId = params?.userId;

  useEffect(() => {
    if (!accountId || !userId) return;
    router.replace(`/accounts/${accountId}?tab=members&member=${encodeURIComponent(userId)}`);
  }, [accountId, userId, router]);

  return null;
}
