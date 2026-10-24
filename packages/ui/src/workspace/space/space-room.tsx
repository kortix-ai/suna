'use client';

import { useFeatureFlag } from '@kortix/sdk/react';
import { HashIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../i18n';
import { uiRoutes } from '../../lib/routes';
import { UiLink as Link, useUiComponents } from '../../providers/ui-provider';

/**
 * A room inside a space: the space's own room (the project room named like
 * the space's slug, the space page's first tab) or the room a board `chat`
 * block names. The host renders the conversation through
 * `UiHostComponents.RoomPanel`; a host without it links to its rooms page.
 * Nothing here creates a room: the first post does. With the `agent_rooms`
 * flag off it renders nothing.
 */
export function SpaceRoom({
  projectId,
  roomName,
  topic,
  fill = false,
  className,
}: {
  projectId: string;
  roomName: string;
  /** The topic a room gets when the first post creates it. */
  topic?: string | null;
  /** Fill the container with no frame and no header: the space page's room tab. */
  fill?: boolean;
  className?: string;
}) {
  const { RoomPanel } = useUiComponents();
  const rooms = useFeatureFlag(projectId, 'agent_rooms');
  const t = useTranslations('spaces');
  const roomsHref = uiRoutes().rooms(projectId);

  if (rooms.isLoading || !rooms.enabled) return null;
  if (RoomPanel) {
    return (
      <div className={className}>
        <RoomPanel projectId={projectId} roomName={roomName} emptyTopic={topic ?? undefined} fill={fill} />
      </div>
    );
  }
  return (
    <div className={className}>
      <div className="bg-popover flex flex-col gap-1.5 rounded-md border px-4 py-3">
        <span className="text-foreground flex min-w-0 items-center gap-1 text-sm font-medium">
          <HashIcon className="size-4 shrink-0" />
          <span className="truncate">{roomName}</span>
        </span>
        <span className="text-muted-foreground text-xs">
          {roomsHref ? (
            <Link href={roomsHref} className="text-foreground underline-offset-4 hover:underline">
              {t('openRooms')}
            </Link>
          ) : (
            t('roomHint')
          )}
        </span>
      </div>
    </div>
  );
}
