'use client';

import { TrayIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { CountBadge } from '@/components/ui/count-badge';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import { reviewHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { useIsMobile } from '@/hooks/utils';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import type { SidebarNavVisibility } from '@/stores/sidebar-nav-store';

/**
 * The sidebar's "Review" row: the one entry point into the Review Center, a
 * project page of its own (`reviewHref`). Change requests, approvals and agent
 * outputs all live there. It is one of the customizable nav rows at the top
 * of the panel (`sidebar-nav-store.ts`). By default it is always listed for a
 * person who may read reviews — an empty inbox is still a place to go — and
 * `visibility="active"` lists it only while the count is above zero, or while
 * the inbox is open. Its badge counts the SAME unified `needs_you` set the
 * per-session row dots read, so the row and the dots agree on one number.
 */
export function ProjectChangeRequestsNavItem({
  projectId,
  visibility = 'always',
}: {
  projectId: string;
  visibility?: SidebarNavVisibility;
}) {
  const t = useTranslations('sidebar');
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const canRead = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_REVIEW_READ).allowed === true;
  const count = useReviewSessionSummary(projectId).totalNeedsYou;

  const href = reviewHref(projectId);
  const isActive = pathname?.startsWith(href) === true;

  if (!canRead || visibility === 'never') return null;
  if (visibility === 'active' && count === 0 && !isActive) return null;

  // This row NAVIGATES, and it navigates through an anchor, not a handler. It
  // is permanently mounted in the sidebar, and `router.push` would run the RSC
  // fetch cold on every click; that fetch degrades into a full document load
  // whenever it answers wrong — an auth bounce, a build-id skew mid-deploy, a
  // network blip.
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={t('review')}
        className="group/menu-button text-sidebar-foreground relative"
      >
        <Link
          href={href}
          prefetch
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          <span className="shrink-0">
            <TrayIcon />
          </span>
          {/* `truncate` sits on the label, not on the trailing group: the
              sidebar's base recipe truncates the last child, which used to be
              the count. */}
          <span className="truncate">{t('review')}</span>
          {count > 0 ? (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {/* Pending, not done. An amber count says "N waiting" without
                  claiming the green this system uses for "finished". */}
              <CountBadge count={count} tone="waiting" />
            </span>
          ) : null}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
