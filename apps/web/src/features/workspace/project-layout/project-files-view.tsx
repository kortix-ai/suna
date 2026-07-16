'use client';

/**
 * Standalone project Files view — the Google-Drive-style browser over the
 * project repo. Rendered by the /projects/[id]/files page inside the regular
 * ProjectShell (NOT the Customize overlay — Files is a top-level surface any
 * member can open, so it lives outside customization entirely).
 */

import { Skeleton } from '@/components/ui/skeleton';
import {
  FileExplorerPage,
  FileExplorerSourceProvider,
  FilesStoreProvider,
  gitRefExplorerSource,
  ProjectFilesProvider,
  useSelectedVersion,
} from '@/features/project-files';
import { getProject } from '@kortix/sdk/projects-client';
import { useQuery } from '@tanstack/react-query';

export function ProjectFilesView({ projectId }: { projectId: string }) {
  const projectQuery = useQuery({
    queryKey: ['projects', projectId, 'meta'],
    queryFn: () => getProject(projectId),
    staleTime: 60_000,
  });

  const selectedVersion = useSelectedVersion(projectId);

  if (projectQuery.isLoading || !projectQuery.data) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-border/40 h-12 border-b" />
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
      <FileExplorerSourceProvider value={gitRefExplorerSource}>
        <FilesStoreProvider>
          <FileExplorerPage />
        </FilesStoreProvider>
      </FileExplorerSourceProvider>
    </ProjectFilesProvider>
  );
}
