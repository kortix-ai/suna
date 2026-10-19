'use client';

import { notFound, useParams } from 'next/navigation';

import { RoomsPage } from '@/features/workspace/rooms/rooms-page';
import { useFeatureFlag } from '@kortix/sdk/react';

/**
 * /projects/[id]/rooms — conversations between agent sessions and people.
 * It exists only with the project's `agent_rooms` flag on.
 */
export default function ProjectRoomsPage() {
  const { id } = useParams<{ id: string }>();
  const rooms = useFeatureFlag(id, 'agent_rooms');

  if (!rooms.isLoading && !rooms.enabled) notFound();
  if (!rooms.enabled) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <RoomsPage projectId={id} />
    </div>
  );
}
