'use client';

import { ProjectFilesProvider } from '../../../files/project';
import { ReviewCenterConnected } from '../../../workspace/review/review-center-connected';
import { useProjectName } from '@kortix/sdk/react';

/**
 * The Review Center inbox — the per-project human-in-the-loop inbox wired
 * to live data. On for every project. Each verdict shows only for a viewer
 * who holds the leaves its route asserts (`ReviewCenterConnected`, KRTX-1720).
 */
export function ReviewView({ projectId }: { projectId: string }) {
  // One source for the project name — see `useProjectName`'s doc comment.
  // Reads the SAME qk.project.detail(projectId) entry the legacy panel
  // already mounts whenever the panel is open (this view only renders while
  // that panel is open), so this is a cache hit, not a second `getProject`
  // request for data the parent already holds.
  const projectName = useProjectName(projectId) ?? '';

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <ProjectFilesProvider value={{ projectId, ref: '', defaultBranch: '' }}>
        <ReviewCenterConnected projectName={projectName} />
      </ProjectFilesProvider>
    </div>
  );
}
