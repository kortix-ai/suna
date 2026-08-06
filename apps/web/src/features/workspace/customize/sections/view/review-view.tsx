'use client';

import { ProjectFilesProvider } from '@/features/project-files';
import { ReviewCenterConnected } from '@/features/review-center/review-center-connected';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useProjectName } from '@kortix/sdk/react';

/**
 * Review Center customize section — the per-project human-in-the-loop inbox wired
 * to live data. Gated behind the `review_center` experimental flag (see
 * customize-panel.tsx + project-actions.ts). Mirrors changes-view.tsx.
 */
export function ReviewView({ projectId }: { projectId: string }) {
  // One source for the project name — see `useProjectName`'s doc comment.
  // Reads the SAME qk.project.detail(projectId) entry customize-panel.tsx
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
