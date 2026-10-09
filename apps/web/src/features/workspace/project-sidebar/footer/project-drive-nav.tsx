'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useProjectDrive } from '@/hooks/drives/use-drives';
import { useIsMobile } from '@/hooks/utils';
import { useTranslations } from '@/i18n/use-translations';
import { useFeatureFlag } from '@kortix/sdk/react';
import { FolderSimpleUserIcon } from '@phosphor-icons/react';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

/**
 * Files entry: the project's shared folders (its drive), with each person's
 * own folder in it. Same row contract as Repo beside it — a hover-prefetching
 * Link, never router.push. Shown only when the organization has Volumes on
 * (the project's derived `drives` flag); loading counts as off.
 */
export function ProjectDriveNavItem() {
  const t = useTranslations('sidebar');
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const drivesGate = useFeatureFlag(projectId, 'drives');
  const tDrives = useTranslations('drives');
  // Open conflict copies in folders the caller can see: the row's only badge.
  const drive = useProjectDrive(projectId, drivesGate.enabled);
  const conflicts = drive.data?.openConflicts ?? 0;
  const isActive = !!pathname && /^\/projects\/[^/]+\/drive(\/|$)/.test(pathname);

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!projectId || !drivesGate.enabled) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={t('files')}
        className="group/menu-button text-sidebar-foreground relative"
      >
        <HoverPrefetchLink href={`/projects/${projectId}/drive`} prefetch onClick={handleClick}>
          <FolderSimpleUserIcon />
          {t('files')}
          {conflicts > 0 ? (
            <span
              className="text-kortix-orange ml-auto text-xs font-medium tabular-nums"
              aria-label={tDrives('conflictCount', { count: conflicts })}
            >
              {conflicts}
            </span>
          ) : null}
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
