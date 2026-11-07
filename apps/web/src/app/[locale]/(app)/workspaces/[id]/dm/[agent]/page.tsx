'use client';

import { notFound, useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useFeatureFlag } from '@kortix/sdk/react';
import { uiRoutes } from '@kortix/ui';

/**
 * /workspaces/[id]/dm/[agent] — an address from before Spaces were the only
 * place to work (`chat` flag). A space is never "an agent": agents are
 * members of spaces. Every old DM link opens the person's own space
 * (`/chat`, their space with My Kortix). The rows stay in the database;
 * nothing is deleted. It exists only with the `chat` flag on.
 */
export default function ProjectDmPage() {
  const { id } = useParams<{ id: string; agent: string }>();
  const router = useRouter();
  const channels = useFeatureFlag(id, 'chat');

  useEffect(() => {
    if (channels.enabled) router.replace(`${uiRoutes().project(id)}/chat`);
  }, [channels.enabled, id, router]);

  if (!channels.isLoading && !channels.enabled) notFound();
  return null;
}
