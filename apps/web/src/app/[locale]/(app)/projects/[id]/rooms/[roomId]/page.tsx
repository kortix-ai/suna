'use client';

import { useParams } from 'next/navigation';

import { RoomPage } from '@/features/workspace/rooms/room-page';

/** /projects/[id]/rooms/[roomId] — one conversation (the layout gates the flag). */
export default function ProjectRoomPage() {
  const { id, roomId } = useParams<{ id: string; roomId: string }>();
  return <RoomPage key={roomId} projectId={id} roomId={roomId} />;
}
