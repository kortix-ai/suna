'use client';

import { notFound, useParams } from 'next/navigation';

import { useProjectSendGate } from '@/hooks/projects/use-project-send-gate';
import { useFeatureFlag } from '@kortix/sdk/react';
import { SpaceView } from '@kortix/ui/workspace';

/**
 * /projects/[id]/dm/[agent] — the caller's direct messages with one agent:
 * the same layout as a channel, visible only to the caller. It exists only
 * with the project's `project_channels` flag on.
 */
export default function ProjectDmPage() {
  const { id, agent } = useParams<{ id: string; agent: string }>();
  const channels = useFeatureFlag(id, 'project_channels');
  const beforeSend = useProjectSendGate(id);

  if (!channels.isLoading && !channels.enabled) notFound();
  if (!channels.enabled) return null;
  // A malformed escape in a hand-typed URL names no agent.
  const decoded = decodeSegment(agent);
  if (decoded === null) notFound();
  return (
    <SpaceView
      projectId={id}
      target={{ kind: 'dm', agentName: decoded }}
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
