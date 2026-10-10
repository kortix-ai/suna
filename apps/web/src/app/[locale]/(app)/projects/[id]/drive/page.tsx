'use client';

import { notFound, useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { useFeatureFlag } from '@kortix/sdk/react';

/**
 * Files moved under Customize; `/drive` links and bookmarks land there. The
 * route exists only with Volumes on (the project's derived `drives` flag):
 * off, it is not found, as before volumes.
 */
export default function ProjectFilesDrivePage() {
  const { id } = useParams<{ id: string }>();
  const volumes = useFeatureFlag(id, 'drives');
  const router = useRouter();

  useEffect(() => {
    if (volumes.enabled && id) router.replace(capabilityTabHref(id, 'files'));
  }, [volumes.enabled, id, router]);

  if (!volumes.isLoading && !volumes.enabled) notFound();
  return null;
}
