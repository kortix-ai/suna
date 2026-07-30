'use client';

/**
 * Standalone project Files view — the Google-Drive-style browser over the
 * project repo. Rendered by the /projects/[id]/files page inside the regular
 * ProjectShell (NOT the Customize overlay — Files is a top-level surface any
 * member can open, so it lives outside customization entirely).
 */

import { ErrorState } from '@/features/layout/section/error-state';
import {
  FileExplorerPage,
  FileExplorerSourceProvider,
  FilesStoreProvider,
  gitRefExplorerSource,
  ProjectFilesProvider,
  useSelectedVersion,
} from '@/features/project-files';
import { getProject } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

import { ProjectFilesSkeleton } from './project-files-skeleton';
import { resolveFilesRef } from './resolve-files-ref';

export function ProjectFilesView({ projectId }: { projectId: string }) {
  // `['project', id]` is the canonical getProject cache slot — the same one
  // `useProjectCan` reads (lib/use-project-can.ts:55). The sidebar's Files
  // entry calls that hook to decide whether to render itself, so this slot is
  // already populated before the user can click through: first render reads it
  // synchronously instead of paying a second round trip for identical data.
  // This view used to own a private `['projects', id, 'meta']` key, which made
  // that duplicate fetch unavoidable and blocked the whole page behind it.
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  const selectedVersion = useSelectedVersion(projectId);
  const { ref, defaultBranch, ready } = resolveFilesRef({
    selectedVersion,
    project: projectQuery.data,
  });

  // Only the ref is a hard prerequisite (useFileList gates on `enabled: !!ref`).
  // Everything else the explorer needs it fetches itself, and it renders its own
  // inner list skeleton, so there is no reason to withhold the Drive chrome.
  //
  // But `!ready` is not always "still loading": with no persisted version
  // selection, `ref` depends entirely on `getProject` resolving. If that query
  // errors (network failure, 403, ...), `ready` stays false forever with no way
  // out — the skeleton above would spin indefinitely. Surface the error instead
  // once there is no usable ref to fall back on.
  if (!ready) {
    if (projectQuery.isError) {
      return (
        <ErrorState
          title="Failed to load project"
          description={
            projectQuery.error instanceof Error ? projectQuery.error.message : undefined
          }
        />
      );
    }
    return <ProjectFilesSkeleton />;
  }

  return (
    <ProjectFilesProvider value={{ projectId, ref, defaultBranch }}>
      <FileExplorerSourceProvider value={gitRefExplorerSource}>
        <FilesStoreProvider>
          <FileExplorerPage />
        </FilesStoreProvider>
      </FileExplorerSourceProvider>
    </ProjectFilesProvider>
  );
}
