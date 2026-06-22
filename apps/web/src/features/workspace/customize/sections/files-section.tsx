'use client';

/**
 * Files section inside the Customize full-screen modal.
 *
 * Wraps the same `<FileExplorerPage />` used by the (now-deprecated)
 * `/projects/[id]/files` route. The page wires up the project's default
 * branch, the selected Version (Git branch override), and the per-project
 * files store so the explorer behaves exactly the same inside the modal as
 * it did on its own route.
 */

import { useQuery } from '@tanstack/react-query';

import { Skeleton } from '@/components/ui/skeleton';
import {
  FileExplorerPage,
  FilesStoreProvider,
  ProjectFilesProvider,
  useSelectedVersion,
} from '@/features/project-files';
import { getProject } from '@/lib/projects-client';

export function FilesSection({ projectId }: { projectId: string }) {
  const projectQuery = useQuery({
    queryKey: ['projects', projectId, 'meta'],
    queryFn: () => getProject(projectId),
    staleTime: 60_000,
  });

  const selectedVersion = useSelectedVersion(projectId);

  if (projectQuery.isLoading || !projectQuery.data) {
    return (
      <div className="flex h-full flex-col">
        <div className="h-12 border-b border-border/40" />
        <div className="space-y-2 p-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded" />
          ))}
        </div>
      </div>
    );
  }

  const defaultBranch = projectQuery.data.default_branch;
  const activeRef = selectedVersion ?? defaultBranch;

  return (
    <ProjectFilesProvider value={{ projectId, ref: activeRef, defaultBranch }}>
      <FilesStoreProvider>
        <FileExplorerPage />
      </FilesStoreProvider>
    </ProjectFilesProvider>
  );
}
