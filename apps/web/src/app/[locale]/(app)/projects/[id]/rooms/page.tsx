'use client';

import { useParams } from 'next/navigation';

import { RoomsPage } from '@/features/workspace/rooms/rooms-page';

/** /projects/[id]/rooms — the list, and no open conversation (the layout gates the flag). */
export default function ProjectRoomsPage() {
  const { id } = useParams<{ id: string }>();
  return <RoomsPage projectId={id} />;
}
