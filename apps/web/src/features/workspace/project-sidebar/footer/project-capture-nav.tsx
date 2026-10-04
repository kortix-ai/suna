'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useTranslations } from '@/i18n/use-translations';
import { useFeatureFlag } from '@kortix/sdk/react';
import { MonitorPlayIcon } from '@phosphor-icons/react';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

import { CaptureDialogHost } from '@/features/capture/desktop/capture-dialog';
import { isDesktop } from '@/lib/desktop';

/**
 * The Capture entry: Kortix Capture's timeline, ranges and devices. Present
 * only while the project's `capture` feature flag is on (fail-closed: loading
 * counts as off). Same row contract as Apps in this group.
 */
export function ProjectCaptureNavItem() {
  const t = useTranslations('sidebar');
  const pathname = usePathname();
  const projectId = useParams<{ id: string }>()?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const gate = useFeatureFlag(projectId, 'capture');
  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!projectId || !gate.enabled) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={pathname?.startsWith(`/projects/${projectId}/capture`) === true}
        tooltip={t('capture')}
        className="group/menu-button text-sidebar-foreground relative"
      >
        <HoverPrefetchLink href={`/projects/${projectId}/capture`} prefetch onClick={handleClick}>
          <span className="shrink-0">
            <MonitorPlayIcon />
          </span>
          {t('capture')}
        </HoverPrefetchLink>
      </SidebarMenuButton>
      {/* The desktop tray's "Capture…" opens the Capture dialog here. */}
      {isDesktop() ? <CaptureDialogHost projectId={projectId} /> : null}
    </SidebarMenuItem>
  );
}
