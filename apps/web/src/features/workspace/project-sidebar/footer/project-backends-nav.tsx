'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useFeatureFlag } from '@kortix/sdk/react';
import { DatabaseIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

export function ProjectBackendsNavItem() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const backendsGate = useFeatureFlag(projectId, 'backends');
  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!projectId) return null;
  // Fail-closed like Apps: the entry exists once the project turns the
  // `backends` flag on. Loading counts as disabled.
  if (!backendsGate.enabled) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={pathname?.startsWith(`/projects/${projectId}/backends`) === true}
        tooltip={tI18nComplete.raw('text26cbb889e198')}
        className="group/menu-button text-sidebar-foreground relative"
      >
        <HoverPrefetchLink href={`/projects/${projectId}/backends`} prefetch onClick={handleClick}>
          <span className="shrink-0">
            <DatabaseIcon />
          </span>
          {tI18nComplete.raw('text26cbb889e198')}
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
