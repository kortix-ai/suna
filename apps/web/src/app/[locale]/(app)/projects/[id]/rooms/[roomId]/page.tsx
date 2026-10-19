'use client';

import { notFound, useParams } from 'next/navigation';

import { RoomPage } from '@/features/workspace/rooms/room-page';
import { useFeatureFlag } from '@kortix/sdk/react';

/** /projects/[id]/rooms/[roomId] — one conversation (flag `agent_rooms`). */
export default function ProjectRoomPage() {
  const { id, roomId } = useParams<{ id: string; roomId: string }>();
  const rooms = useFeatureFlag(id, 'agent_rooms');

  if (!rooms.isLoading && !rooms.enabled) notFound();
  if (!rooms.enabled) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <RoomPage key={roomId} projectId={id} roomId={roomId} />
    </div>
  );
}
