'use client';

import { notFound, useParams } from 'next/navigation';
import type { ReactNode } from 'react';

import { RoomsShell } from '@/features/workspace/rooms/rooms-shell';
import { useFeatureFlag } from '@kortix/sdk/react';

/**
 * /projects/[id]/rooms* — conversations between agent sessions and people, in
 * one two-pane shell that stays mounted while the open conversation changes.
 * It exists only with the project's `agent_rooms` flag on.
 */
export default function ProjectRoomsLayout({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const rooms = useFeatureFlag(id, 'agent_rooms');

  if (!rooms.isLoading && !rooms.enabled) notFound();
  if (!rooms.enabled) return null;
  // `absolute inset-0`: the project frame has no fixed height (`min-h-svh`), so
  // an in-flow pane would grow the frame by its content and push the composer
  // below the window (720 x 480). Out of flow, it takes exactly the frame's box.
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div className="absolute inset-0 flex flex-col">
        <RoomsShell projectId={id}>{children}</RoomsShell>
      </div>
    </div>
  );
}
