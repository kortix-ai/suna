'use client';

import { useFeatureFlag } from '@kortix/sdk/react';
import { HashIcon } from '@phosphor-icons/react';

import { customizePath, uiRoutes } from '../../lib/routes';
import { useUiComponents, useUiLink } from '../../providers/ui-provider';

/**
 * A room inside a space: the space's own room (the project room named like
 * the space's slug) or the room a `chat` block names. The host renders the
 * conversation through `UiHostComponents.RoomPanel`; a host without it links
 * to its rooms page. Nothing here creates a room: the first post does.
 */
export function SpaceRoom({
  projectId,
  roomName,
  topic,
  className,
}: {
  projectId: string;
  roomName: string;
  /** The topic a room gets when the first post creates it. */
  topic?: string | null;
  className?: string;
}) {
  const { RoomPanel } = useUiComponents();
  const rooms = useFeatureFlag(projectId, 'agent_rooms');
  const Link = useUiLink();
  const roomsHref = uiRoutes().rooms(projectId);

  if (rooms.isLoading) return null;
  if (!rooms.enabled) {
    return (
      <RoomNotice className={className} roomName={roomName}>
        Rooms are off for this project.{' '}
        <Link href={customizePath(projectId, 'settings')} className="text-foreground underline-offset-4 hover:underline">
          Open settings
        </Link>
      </RoomNotice>
    );
  }
  if (RoomPanel) {
    return (
      <div className={className}>
        <RoomPanel projectId={projectId} roomName={roomName} emptyTopic={topic ?? undefined} />
      </div>
    );
  }
  return (
    <RoomNotice className={className} roomName={roomName}>
      {roomsHref ? (
        <Link href={roomsHref} className="text-foreground underline-offset-4 hover:underline">
          Open rooms
        </Link>
      ) : (
        'Agents and people post updates here.'
      )}
    </RoomNotice>
  );
}

function RoomNotice({
  roomName,
  className,
  children,
}: {
  roomName: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <div className="bg-popover flex flex-col gap-1.5 rounded-md border px-4 py-3">
        <span className="text-foreground flex min-w-0 items-center gap-1 text-sm font-medium">
          <HashIcon className="size-4 shrink-0" />
          <span className="truncate">{roomName}</span>
        </span>
        <span className="text-muted-foreground text-xs">{children}</span>
      </div>
    </div>
  );
}
