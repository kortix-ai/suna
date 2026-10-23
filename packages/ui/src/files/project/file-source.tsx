'use client';

import type { FileSource } from '../viewer';
import { useQueryClient } from '@tanstack/react-query';
import { writeProjectFile } from '@kortix/sdk';
import { fileContentKeys } from './hooks/use-file-content';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
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
  const queryClient = useQueryClient();
  const canWrite = useProjectCan(ctx?.projectId ?? '', PROJECT_ACTIONS.PROJECT_FILE_WRITE).allowed === true;
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
      editablePreview: canWrite,
      save: ctx && canWrite ? async (filePath, file, revision) => {
        if (!revision) throw new Error('Reload the file before saving.');
        await writeProjectFile(ctx.projectId, {
          path: filePath.replace(/^\/workspace\//, '').replace(/^\//, ''), ref: ctx.ref,
          content: await file.text(), expected_revision: revision,
        });
        await queryClient.invalidateQueries({ queryKey: fileContentKeys.all });
      } : undefined,
      Breadcrumbs: FilePathBreadcrumbs,
    }),
    [ctx, canWrite, queryClient],
  );
}
