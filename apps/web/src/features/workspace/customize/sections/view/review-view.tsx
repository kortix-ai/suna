'use client';

import { ProjectFilesProvider } from '@/features/project-files';
import { ReviewCenterConnected } from '@/features/review-center/review-center-connected';
import { ProjectPageHeader } from '@/features/workspace/project-layout/project-page-header';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { type CanResult, useProjectCans } from '@/lib/use-project-can';
import { useProjectName } from '@kortix/sdk/react';

/**
 * `/projects/[id]/review` — the Review Center as a project page of its own,
 * outside Customize: the full window height, the Customize tab bar, and
 * the inbox below it. Agents send their approvals, change requests and outputs
 * here, so it is a primary surface, not a configuration tab.
 */
export function ReviewPage({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={t('review')} />
      <div className="min-h-0 flex-1">
        <ReviewView projectId={projectId} />
      </div>
    </div>
  );
}

/** The leaves the inbox's verdicts assert, in one batched probe. */
const REVIEW_CENTER_ACTIONS = [
  PROJECT_ACTIONS.PROJECT_REVIEW_ACT,
  PROJECT_ACTIONS.PROJECT_WRITE,
  PROJECT_ACTIONS.PROJECT_GITOPS_MERGE,
] as const;

/**
 * Which verdicts the viewer gets. Acting on a review item (approve, reject,
 * request changes, the bulk act) asserts `project.review.act`. "Ship it" on a
 * change request merges it, and the merge route asserts `project.write` and
 * `project.gitops.merge` instead (KRTX-1720). Only an explicit allow counts, so
 * an unresolved probe offers nothing.
 */
export function reviewCenterGates(cans: Partial<Record<string, Pick<CanResult, 'allowed'>>>): {
  canAct: boolean;
  canMerge: boolean;
} {
  const allowed = (action: string) => cans[action]?.allowed === true;
  return {
    canAct: allowed(PROJECT_ACTIONS.PROJECT_REVIEW_ACT),
    canMerge:
      allowed(PROJECT_ACTIONS.PROJECT_WRITE) && allowed(PROJECT_ACTIONS.PROJECT_GITOPS_MERGE),
  };
}

/**
 * The Review Center inbox — the per-project human-in-the-loop inbox wired
 * to live data. On for every project; acting is gated on `project.review.act`,
 * a change request's merge on `project.write` + `project.gitops.merge`.
 */
export function ReviewView({ projectId }: { projectId: string }) {
  // One source for the project name — see `useProjectName`'s doc comment.
  // Reads the SAME qk.project.detail(projectId) entry the legacy panel
  // already mounts whenever the panel is open (this view only renders while
  // that panel is open), so this is a cache hit, not a second `getProject`
  // request for data the parent already holds.
  const projectName = useProjectName(projectId) ?? '';
  // A read-only role (review.read only) still SEES the inbox:
  // ReviewCenterConnected withholds the act handlers. Fails safe: false until
  // the probe resolves.
  const { canAct, canMerge } = reviewCenterGates(
    useProjectCans(projectId, REVIEW_CENTER_ACTIONS),
  );

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <ProjectFilesProvider value={{ projectId, ref: '', defaultBranch: '' }}>
        <ReviewCenterConnected projectName={projectName} canAct={canAct} canMerge={canMerge} />
      </ProjectFilesProvider>
    </div>
  );
}
