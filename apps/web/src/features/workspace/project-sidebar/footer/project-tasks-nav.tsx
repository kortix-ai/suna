'use client';

import { Badge } from '@/components/ui/badge';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useFeatureFlag } from '@kortix/sdk/react';
import { TrayIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

export function ProjectTasksNavItem() {
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const gate = useFeatureFlag(projectId, 'agi');
  const canReadTasks = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_TASK_READ);
  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!projectId || !gate.enabled) return null;
  if (!canReadTasks.allowed && !canReadTasks.isLoading) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={pathname?.startsWith(`/projects/${projectId}/tasks`) === true}
        tooltip="Tasks"
        className="flex items-center gap-2 text-sm! font-medium [&_svg]:size-4!"
      >
        <Link href={`/projects/${projectId}/tasks`} prefetch onClick={handleClick}>
          <TrayIcon />
          Tasks
          <Badge aria-hidden size="xs" variant="beta" className="ml-auto">
            AGI
          </Badge>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
