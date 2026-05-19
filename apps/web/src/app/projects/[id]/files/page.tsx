'use client';

import { use } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  FileExplorerPage,
  FilesStoreProvider,
  ProjectFilesProvider,
  useSelectedVersion,
} from '@/features/project-files';
import { getProject } from '@/lib/projects-client';
import { Skeleton } from '@/components/ui/skeleton';
import { ProjectShell } from '@/components/projects/project-shell';

/**
 * Read-only project file browser. Reuses the exact components that power
 * the per-instance `/instances/:id/files` dashboard view — only the data
 * source is swapped (project git API instead of sandbox SDK).
 *
 * Layout, toolbar, grid/list/preview behaviour: identical to /instances/*.
 * Mutation surfaces (upload / new / rename / delete / paste / git status /
 * search / history) are hidden because the project view is read-only.
 */
export default function ProjectFilesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);

  // The file APIs need the project's default branch. Cached for the session.
  const projectQuery = useQuery({
    queryKey: ['projects', projectId, 'meta'],
    queryFn: () => getProject(projectId),
    staleTime: 60_000,
  });

  // Selected Version (Git branch) — persisted per project; falls back to the
  // project's default branch.
  const selectedVersion = useSelectedVersion(projectId);

  if (projectQuery.isLoading || !projectQuery.data) {
    return (
      <ProjectShell projectId={projectId}>
        <div className="flex h-full flex-col">
          <div className="h-12 border-b border-border/40" />
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded" />
            ))}
          </div>
        </div>
      </ProjectShell>
    );
  }

  const defaultBranch = projectQuery.data.default_branch;
  const activeRef = selectedVersion ?? defaultBranch;

  return (
    <ProjectShell projectId={projectId}>
      <ProjectFilesProvider value={{ projectId, ref: activeRef, defaultBranch }}>
        {/* Scoped FilesStore so this view's currentPath / view-mode / sort
            state doesn't leak into the instance dashboard's global store. */}
        <FilesStoreProvider>
          <FileExplorerPage />
        </FilesStoreProvider>
      </ProjectFilesProvider>
    </ProjectShell>
  );
}
