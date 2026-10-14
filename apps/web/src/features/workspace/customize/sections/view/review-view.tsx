'use client';

import { ProjectFilesProvider } from '@/features/project-files';
import { ReviewCenterConnected } from '@/features/review-center/review-center-connected';
import { ProjectPageHeader } from '@/features/workspace/project-layout/project-page-header';
import { useTranslations } from '@/i18n/use-translations';
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
