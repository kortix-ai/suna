'use client';

import { useMemo } from 'react';
import type { FileSource } from '@/features/file-viewer';
import { useFileContent } from './hooks';
import { useBinaryBlob } from './hooks/use-binary-blob';
import { downloadFile, uploadFile } from './api/runtime-files';
import { useWorkspaceContext } from './context';
import { FilePathBreadcrumbs } from './components/file-breadcrumbs';

/**
 * Project git-ref data source for the shared file viewer/modal. Downloads are
 * ref-scoped (need workspaceId/ref from <WorkspaceFilesProvider>) and binary blobs
 * are stubbed (this view is read-only), so the adapter is built per-render.
 */
export function useWorkspaceFileSource(): FileSource {
  const ctx = useWorkspaceContext();
  return useMemo<FileSource>(
    () => ({
      useFileContent,
      useBinaryBlob,
      download: (filePath, fileName) =>
        ctx
          ? downloadFile(ctx.workspaceId, ctx.ref, filePath, fileName)
          : Promise.reject(new Error('No workspace context for download')),
      upload: uploadFile,
      Breadcrumbs: FilePathBreadcrumbs,
    }),
    [ctx],
  );
}
