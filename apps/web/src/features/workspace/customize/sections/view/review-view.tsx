'use client';

import { useOptionalSidebar } from '@/components/ui/sidebar';
import { ProjectFilesProvider } from '@/features/project-files';
import { ReviewCenterConnected } from '@/features/review-center/review-center-connected';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useProjectName } from '@kortix/sdk/react';

/**
 * `/projects/[id]/review` — the Review Center as a project page of its own,
 * outside Customize: the full window height, a title band like Reminders, and
 * the inbox below it. Agents send their approvals, change requests and outputs
 * here, so it is a primary surface, not a configuration tab.
 */
export function ReviewPage({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const sidebar = useOptionalSidebar();
  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <div
        className="kx-titlebar-row kx-titlebar-band-height relative flex shrink-0 items-center gap-1 border-b px-2"
        data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
      >
        <SidebarToggle />
        <h1 className="text-foreground min-w-0 truncate px-3 py-2 text-sm font-medium">
          {t('review')}
        </h1>
      </div>
      <div className="min-h-0 flex-1">
        <ReviewView projectId={projectId} />
      </div>
    </div>
  );
}

/**
 * The Review Center inbox — the per-project human-in-the-loop inbox wired
 * to live data. On for every project; acting is gated on `project.review.act`
 * (see project-actions.ts).
 */
export function ReviewView({ projectId }: { projectId: string }) {
  // One source for the project name — see `useProjectName`'s doc comment.
  // Reads the SAME qk.project.detail(projectId) entry the legacy panel
  // already mounts whenever the panel is open (this view only renders while
  // that panel is open), so this is a cache hit, not a second `getProject`
  // request for data the parent already holds.
  const projectName = useProjectName(projectId) ?? '';
  // Acting on a review item (approve/reject/request-changes, and the bulk act)
  // asserts project.review.act server-side. A read-only role (review.read only)
  // still SEES the inbox — ReviewCenterConnected withholds the act handlers so the
  // ReviewCenter's mutation UI disables itself. Fails safe: false until resolved.
  const canActReview =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_REVIEW_ACT).allowed === true;

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <ProjectFilesProvider value={{ projectId, ref: '', defaultBranch: '' }}>
        <ReviewCenterConnected projectName={projectName} canAct={canActReview} />
      </ProjectFilesProvider>
    </div>
  );
}
