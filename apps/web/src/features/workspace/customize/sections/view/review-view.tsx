'use client';

import { WorkspaceFilesProvider } from '@/features/workspace-files';
import { ReviewCenterConnected } from '@/features/review-center/review-center-connected';
import { WORKSPACE_ACTIONS } from '@/lib/workspace-actions';
import { useWorkspaceCan } from '@/lib/use-workspace-can';
import { useWorkspaceName } from '@kortix/sdk/react';

/**
 * Review Center customize section — the per-workspace human-in-the-loop inbox wired
 * to live data. Gated behind the `review_center` experimental flag (see
 * customize-panel.tsx + workspace-actions.ts). Mirrors changes-view.tsx.
 */
export function ReviewView({ workspaceId }: { workspaceId: string }) {
  // One source for the workspace name — see `useWorkspaceName`'s doc comment.
  // Reads the SAME qk.workspace.detail(workspaceId) entry customize-panel.tsx
  // already mounts whenever the panel is open (this view only renders while
  // that panel is open), so this is a cache hit, not a second `getWorkspace`
  // request for data the parent already holds.
  const workspaceName = useWorkspaceName(workspaceId) ?? '';
  // Acting on a review item (approve/reject/request-changes, and the bulk act)
  // asserts project.review.act server-side. A read-only role (review.read only)
  // still SEES the inbox — ReviewCenterConnected withholds the act handlers so the
  // ReviewCenter's mutation UI disables itself. Fails safe: false until resolved.
  const canActReview =
    useWorkspaceCan(workspaceId, WORKSPACE_ACTIONS.WORKSPACE_REVIEW_ACT).allowed === true;

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <WorkspaceFilesProvider value={{ workspaceId, ref: '', defaultBranch: '' }}>
        <ReviewCenterConnected workspaceName={workspaceName} canAct={canActReview} />
      </WorkspaceFilesProvider>
    </div>
  );
}
