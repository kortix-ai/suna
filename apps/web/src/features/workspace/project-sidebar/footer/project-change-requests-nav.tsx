'use client';

import { TrayIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';

/**
 * The sidebar footer's "Review" row: the single entry point into the Review
 * Center inbox (Customize → Review) — change requests, approvals and agent
 * outputs all live in one place. Its badge counts the SAME unified `needs_you`
 * set the per-session row dots and the Customize rail read, so the row, the
 * dots, and the rail always agree on one number. Open change requests are a
 * subset of `needs_you`, so this never hides one.
 */
export function ProjectChangeRequestsNavItem({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const count = useReviewSessionSummary(projectId).totalNeedsYou;

  if (count === 0) return null;

  // The pill is one sidebar row: a three-digit count would push the label into
  // an ellipsis, so it clamps instead. The exact number lives in the inbox.
  const countLabel = count > 99 ? '99+' : String(count);

  // This row NAVIGATES, and it navigates through an anchor, not a handler. It
  // is permanently mounted in the sidebar footer, and `router.push` would run
  // the RSC fetch cold on every click; that fetch degrades into a full document
  // load whenever it answers wrong — an auth bounce, a build-id skew mid-deploy,
  // a network blip.
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild className="group/menu-button text-sidebar-foreground relative">
        <Link href={capabilityTabHref(projectId, 'review')} prefetch>
          <TrayIcon className="size-4" />
          {/* `truncate` sits on the label, not on the trailing group: the
              sidebar's base recipe truncates the last child, which used to be
              the count. */}
          <span className="truncate">{t('review')}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {/* Pending, not done. A plain row with an amber count says "N
                waiting" without claiming the green this system uses for
                "finished". */}
            <Badge variant="transparent" size="tabular" className="bg-kortix-yellow/15 text-current">
              {countLabel}
            </Badge>
          </span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
