'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { useTranslations } from '@/i18n/use-translations';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { CountBadge } from '@/components/ui/count-badge';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import { useIsMobile } from '@/hooks/utils';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectPageCans } from '@/lib/use-project-can';
import { getProject } from '@kortix/sdk';
import { contract, qk, useFeatureFlag } from '@kortix/sdk/react';
import { FoldersIcon, GitBranchIcon } from '@phosphor-icons/react';

import { repoNavLabel } from './files-nav-label';

/**
 * Top-level repo browser entry: Repo when the project has Volumes on (the
 * shared folders are then Files, a tab under Customize), Files otherwise.
 * It opens the merged Repo page (KRTX-2444): the file browser and, as its
 * review section, the Review Center inbox.
 *
 * The row lists when the caller may read files OR reviews. `project.file.read`
 * is editor-tier (IAM v1 moved the sensitive file/secret reads off the floor
 * `member` role), but Review merged into this page and its inbox is open to
 * plain members (`project.review.read` is floor-tier): hiding the row from
 * them would strand the inbox. A review-only viewer lands on the merged
 * page's review section (the repo section falls back for them there).
 * Optimistic while the files probe loads — the entry only disappears on an
 * explicit deny of both leaves.
 *
 * The badge counts the SAME unified `needs_you` set the per-session row dots
 * read (`use-review-session-summary.ts`), so the row and the dots agree on
 * one number — the badge the standalone Review row used to carry.
 *
 * A real `<Link prefetch>`, not `router.push`. The button form could not be
 * prefetched, so every click paid for the route's RSC payload AND its JS chunk
 * cold — the bulk of a 5-6s open. `prefetch` needs `files/loading.tsx` to have
 * something to cache, because the project layout awaits cookies() and the
 * route is therefore dynamic. Note this is production-only behaviour: Next
 * disables Link prefetching under `next dev`.
 *
 * `HoverPrefetchLink`, not a bare `<Link>`: prefetching on mount made every
 * session open pay a full dynamic render of /files (2 requests, ~26KB) that
 * nobody asked for. The prefetch now starts on hover/focus/touch, which still
 * lands well before the click.
 *
 * Connectors / Skills / Commands used to sit beside this entry, one row each,
 * plus a Customize row below them. They are tabs of one `(capabilities)`
 * layout, so four rows bought nothing over one: ProjectCustomizeNavItem
 * replaced them and moved to the top of the panel, under New session.
 */
export function ProjectFilesNavItem() {
  const t = useTranslations('sidebar');
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  // One batched permission read for both gates (the always-mounted project
  // contract: singular probes would double the request).
  const cans = useProjectPageCans(projectId);
  const canReadFiles = cans[PROJECT_ACTIONS.PROJECT_FILE_READ];
  const canReview = cans[PROJECT_ACTIONS.PROJECT_REVIEW_READ].allowed === true;
  const count = useReviewSessionSummary(projectId, { enabled: canReview }).totalNeedsYou;
  const isActive = !!pathname && /^\/projects\/[^/]+\/files(\/|$)/.test(pathname);
  const queryClient = useQueryClient();
  // Volumes on for the project (its derived `drives` flag).
  const volumes = useFeatureFlag(projectId, 'drives');
  const label = repoNavLabel(volumes.enabled);

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  // The Files view cannot pick a git ref (`resolveFilesRef`,
  // `project-layout/resolve-files-ref.ts`) until it knows the project's
  // default branch — one request, `qk.project.summary(id)` — unless a
  // per-project version selection is already persisted. Cold, that read
  // alone gates every other read on the page (branches, the file list,
  // change requests, file-content previews) behind ~1s nobody needed to
  // spend: this same intent signal already arms the ROUTE prefetch above
  // (`HoverPrefetchLink`), so arming the DATA prefetch alongside it means
  // `ref` is usually already resolvable by the time `ProjectFilesView`
  // mounts. Same key + same `contract('config')` options as that view's own
  // query, so this warms one cache slot rather than issuing a second fetch.
  const prefetchSummary = useCallback(() => {
    // A review-only viewer's hover should not warm the repo's ref resolution:
    // their body is the review section.
    if (!projectId || !(canReadFiles.allowed || canReadFiles.isLoading)) return;
    void queryClient.prefetchQuery({
      queryKey: qk.project.summary(projectId),
      queryFn: () => getProject(projectId),
      ...contract('config'),
    });
  }, [projectId, canReadFiles.allowed, canReadFiles.isLoading, queryClient]);

  if (!canReadFiles.allowed && !canReadFiles.isLoading && !canReview) return null;
  // No project id means no valid href. The old onClick already no-op'd in this
  // case, so rendering a dead button was never useful.
  if (!projectId) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={t(label)}
        className="group/menu-button text-sidebar-foreground relative"
      >
        <HoverPrefetchLink
          href={`/projects/${projectId}/files`}
          prefetch
          onClick={handleClick}
          onMouseEnter={prefetchSummary}
          onFocus={prefetchSummary}
          onTouchStart={prefetchSummary}
        >
          {label === 'repo' ? <GitBranchIcon /> : <FoldersIcon />}
          <span className="truncate">{t(label)}</span>
          {count > 0 ? (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {/* Pending, not done. An amber count says "N waiting" without
                  claiming the green this system uses for "finished". */}
              <CountBadge count={count} tone="waiting" />
            </span>
          ) : null}
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
