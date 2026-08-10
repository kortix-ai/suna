'use client';

/**
 * Standalone project Files view — the Google-Drive-style browser over the
 * workspace repo. Rendered by the /workspaces/[id]/files page inside the regular
 * WorkspaceShell (NOT the Customize overlay — Files is a top-level surface any
 * member can open, so it lives outside customization entirely).
 */

import { ErrorState } from '@/features/layout/section/error-state';
import {
  FileExplorerPage,
  FileExplorerSourceProvider,
  FilesStoreProvider,
  gitRefExplorerSource,
  WorkspaceFilesProvider,
  useSelectedVersion,
} from '@/features/workspace-files';
import { getWorkspace } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import { WorkspaceFilesSkeleton } from './workspace-files-skeleton';
import { resolveFilesRef } from './resolve-files-ref';

export function WorkspaceFilesView({ workspaceId }: { workspaceId: string }) {
  // `qk.workspace.summary(id)` is the canonical getWorkspace cache slot — the
  // same one `useWorkspaceCan` reads (lib/use-workspace-can.ts:55). The sidebar's
  // Files entry calls that hook to decide whether to render itself, so this
  // slot is already populated before the user can click through: first
  // render reads it synchronously instead of paying a second round trip for
  // identical data. This view used to own a private projects/id/meta key,
  // which made that duplicate fetch unavoidable and blocked the whole page
  // behind it.
  const workspaceQuery = useQuery({
    queryKey: qk.workspace.summary(workspaceId),
    queryFn: () => getWorkspace(workspaceId),
    ...contract('config'),
    enabled: !!workspaceId,
  });

  const selectedVersion = useSelectedVersion(workspaceId);
  const { ref, defaultBranch, ready } = resolveFilesRef({
    selectedVersion,
    workspace: workspaceQuery.data,
  });

  // Only the ref is a hard prerequisite (useFileList gates on `enabled: !!ref`).
  // Everything else the explorer needs it fetches itself, and it renders its own
  // inner list skeleton, so there is no reason to withhold the Drive chrome.
  //
  // But `!ready` is not always "still loading": with no persisted version
  // selection, `ref` depends entirely on `getWorkspace` resolving. If that query
  // errors (network failure, 403, ...), `ready` stays false forever with no way
  // out — the skeleton above would spin indefinitely. Surface the error instead
  // once there is no usable ref to fall back on.
  if (!ready) {
    if (workspaceQuery.isError) {
      return (
        <ErrorState
          title="Failed to load workspace"
          description={
            workspaceQuery.error instanceof Error ? workspaceQuery.error.message : undefined
          }
        />
      );
    }
    return <WorkspaceFilesSkeleton />;
  }

  return (
    <WorkspaceFilesProvider value={{ workspaceId, ref, defaultBranch }}>
      <FileExplorerSourceProvider value={gitRefExplorerSource}>
        <FilesStoreProvider>
          <FileExplorerPage />
        </FilesStoreProvider>
      </FileExplorerSourceProvider>
    </WorkspaceFilesProvider>
  );
}
