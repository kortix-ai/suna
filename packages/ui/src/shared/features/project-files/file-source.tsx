'use client';

import type { FileSource } from '../file-viewer';
import { useMemo } from 'react';
import { downloadFile, uploadFile } from './api/runtime-files';
import { FilePathBreadcrumbs } from './components/file-breadcrumbs';
import { useProjectContext } from './context';
import { useFileContent } from './hooks';
import { useBinaryBlob } from './hooks/use-binary-blob';

/**
 * Project git-ref data source for the shared file viewer/modal. Downloads are
 * ref-scoped (need projectId/ref from <ProjectFilesProvider>); binary blobs
 * come from `GET /files/raw`, so the same previews render here as in a live
 * session workspace. The adapter is built per-render.
 *
 * `bytesOnly`: no session runtime is behind a git ref (the Repo page, a parked
 * session), so the spreadsheet and SQLite previewers read these bytes too.
 */
export function useProjectFileSource(): FileSource {
  const ctx = useProjectContext();
  return useMemo<FileSource>(
    () => ({
      id: 'project-ref',
      useFileContent,
      useBinaryBlob,
      bytesOnly: true,
      download: (filePath, fileName) =>
        ctx
          ? downloadFile(ctx.projectId, ctx.ref, filePath, fileName)
          : Promise.reject(new Error('No project context for download')),
      upload: uploadFile,
      Breadcrumbs: FilePathBreadcrumbs,
    }),
    [ctx],
  );
}
