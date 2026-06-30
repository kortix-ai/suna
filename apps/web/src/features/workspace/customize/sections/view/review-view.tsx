'use client';

import { ProjectFilesProvider } from '@/features/project-files';
import { ReviewCenterConnected } from '@/features/review-center/review-center-connected';
import { getProject } from '@/lib/projects-client';
import { useQuery } from '@tanstack/react-query';

/**
 * Review Center customize section — the per-project human-in-the-loop inbox wired
 * to live data. Gated behind the `review_center` experimental flag (see
 * customize-panel.tsx + project-actions.ts). Mirrors changes-view.tsx.
 */
export function ReviewView({ projectId }: { projectId: string }) {
  const projectQuery = useQuery({
    queryKey: ['projects', projectId, 'meta'],
    queryFn: () => getProject(projectId),
    staleTime: 60_000,
  });
  const projectName = projectQuery.data?.name ?? '';

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <ProjectFilesProvider value={{ projectId, ref: '', defaultBranch: '' }}>
        <ReviewCenterConnected projectName={projectName} />
      </ProjectFilesProvider>
    </div>
  );
}
