'use client';

import { notFound, useParams } from 'next/navigation';

import { SpaceFileView } from '@/features/drives/space-file-view';
import { SpaceFolderView } from '@/features/drives/space-folder-view';
import { useProjectSendGate } from '@/hooks/projects/use-project-send-gate';
import { useFeatureFlag } from '@kortix/sdk/react';
import { decodeSpaceSegment } from '@kortix/ui';
import { SpaceView } from '@kortix/ui/workspace';

/**
 * /workspaces/[id]/c/[slug] — a space: its timeline of threads, the composer
 * that starts a new thread per message, its own tabs, and the open thread beside it. It
 * exists only with the project's `chat` flag on.
 */
export default function ProjectChannelPage() {
  const { id, slug } = useParams<{ id: string; slug: string }>();
  const channels = useFeatureFlag(id, 'chat');
  const beforeSend = useProjectSendGate(id);

  if (!channels.isLoading && !channels.enabled) notFound();
  if (!channels.enabled) return null;
  // A malformed escape in a hand-typed URL names no channel.
  const decoded = decodeSpaceSegment(slug);
  if (decoded === null) notFound();
  return (
    <SpaceView
      projectId={id}
      target={{ kind: 'channel', slug: decoded }}
      beforeSend={beforeSend}
      renderFolder={(folder) => <SpaceFolderView projectId={id} {...folder} />}
      renderFile={(file) => <SpaceFileView projectId={id} {...file} />}
    />
  );
}
