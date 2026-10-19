'use client';

import { CountBadge } from '@/components/ui/count-badge';
import { ProjectNavRow } from '@/features/workspace/project-sidebar/project-nav-row';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useFeatureFlag, useRoomConversations } from '@kortix/sdk/react';
import { ChatsTeardropIcon } from '@phosphor-icons/react';
import { useParams, usePathname } from 'next/navigation';

/**
 * The Rooms row shows with the `agent_rooms` flag on and `project.room.read`
 * granted. Nothing shows until both answers land, so the row never appears
 * and then vanishes.
 */
export function useRoomsRowVisible(projectId: string | undefined): boolean {
  const flag = useFeatureFlag(projectId, 'agent_rooms');
  const canRead = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_ROOM_READ);
  return flag.enabled && canRead.allowed === true;
}

export function ProjectRoomsNavItem() {
  const t = useTranslations('sidebar');
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const visible = useRoomsRowVisible(projectId);
  const conversations = useRoomConversations(visible ? projectId : null);
  const unread = (conversations.data ?? []).reduce((sum, c) => sum + c.unread, 0);

  if (!projectId || !visible) return null;
  return (
    <ProjectNavRow
      active={pathname?.startsWith(`/projects/${projectId}/rooms`) === true}
      label={t('rooms')}
      href={`/projects/${projectId}/rooms`}
      prefetch
    >
      <span className="shrink-0">
        <ChatsTeardropIcon />
      </span>
      {t('rooms')}
      {unread > 0 ? (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <CountBadge count={unread} tone="waiting" />
        </span>
      ) : null}
    </ProjectNavRow>
  );
}
