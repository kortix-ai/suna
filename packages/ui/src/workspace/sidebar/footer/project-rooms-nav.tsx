'use client';

import { uiRoutes } from '../../../lib/routes';
import { ProjectNavRow } from '../../../internal/layout/project-nav-row';
import { CountBadge } from '../../../primitives/count-badge';
import { useTranslations } from '../../../i18n';
import { PROJECT_ACTIONS } from '../../../internal/lib/project-actions';
import { useProjectCan } from '../../../internal/lib/use-project-can';
import { useFeatureFlag, useRoomConversations } from '@kortix/sdk/react';
import { ChatsTeardropIcon } from '@phosphor-icons/react';
import { useUiPathname } from '../../../providers/ui-provider';

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

export function ProjectRoomsNavItem({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const pathname = useUiPathname();
  const visible = useRoomsRowVisible(projectId);
  const conversations = useRoomConversations(visible ? projectId : null);
  const unread = (conversations.data ?? []).reduce((sum, c) => sum + c.unread, 0);

  const href = projectId ? uiRoutes().rooms(projectId) : null;
  if (!href || !visible) return null;
  return (
    <ProjectNavRow active={pathname?.startsWith(href) === true} label={t('rooms')} href={href} prefetch>
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
