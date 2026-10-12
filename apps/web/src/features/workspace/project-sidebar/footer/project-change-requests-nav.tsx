'use client';

import { TrayIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import { reviewHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { useIsMobile } from '@/hooks/utils';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

/**
 * The sidebar's "Review" row: the one entry point into the Review Center, a
 * project page of its own (`reviewHref`). Change requests, approvals and agent
 * outputs all live there. It sits in the footer group, above Reminders and
 * Files, and is always listed for a person who may read reviews — an empty
 * inbox is still a place to go. Its badge counts the SAME unified `needs_you` set the
 * per-session row dots read, so the row and the dots agree on one number.
 */
export function ProjectChangeRequestsNavItem({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const canRead = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_REVIEW_READ).allowed === true;
  const count = useReviewSessionSummary(projectId).totalNeedsYou;

  if (!canRead) return null;

  // The pill is one sidebar row: a three-digit count would push the label into
  // an ellipsis, so it clamps instead. The exact number lives in the inbox.
  const countLabel = count > 99 ? '99+' : String(count);
  const href = reviewHref(projectId);

  // This row NAVIGATES, and it navigates through an anchor, not a handler. It
  // is permanently mounted in the sidebar, and `router.push` would run the RSC
  // fetch cold on every click; that fetch degrades into a full document load
  // whenever it answers wrong — an auth bounce, a build-id skew mid-deploy, a
  // network blip.
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={pathname?.startsWith(href) === true}
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
              <Badge
                variant="transparent"
                size="tabular"
                className="bg-kortix-yellow/15 text-current"
              >
                {countLabel}
              </Badge>
            </span>
          ) : null}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
