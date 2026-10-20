'use client';

import { notFound, useParams } from 'next/navigation';

import { useProjectSendGate } from '@/hooks/projects/use-project-send-gate';
import { useFeatureFlag } from '@kortix/sdk/react';
import { SpaceView } from '@kortix/ui/workspace';

/**
 * /projects/[id]/c/[slug] — a channel: its timeline of threads, the composer
 * that starts a new thread per message, and the open thread beside it. It
 * exists only with the project's `project_channels` flag on.
 */
export default function ProjectChannelPage() {
  const { id, slug } = useParams<{ id: string; slug: string }>();
  const channels = useFeatureFlag(id, 'project_channels');
  const beforeSend = useProjectSendGate(id);

  if (!channels.isLoading && !channels.enabled) notFound();
  if (!channels.enabled) return null;
  // A malformed escape in a hand-typed URL names no channel.
  const decoded = decodeSegment(slug);
  if (decoded === null) notFound();
  return (
    <SpaceView
      projectId={id}
      target={{ kind: 'channel', slug: decoded }}
      beforeSend={beforeSend}
    />
  );
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
