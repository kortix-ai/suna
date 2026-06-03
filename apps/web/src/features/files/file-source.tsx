'use client';

import type { FileSource } from '@/features/file-viewer';
import { useFileContent } from './hooks/use-file-content';
import { useBinaryBlob } from './hooks/use-binary-blob';
import { downloadFile, uploadFile } from './api/opencode-files';
import { FilePathBreadcrumbs } from './components/file-breadcrumbs';

/**
 * Live-workspace data source for the shared file viewer/modal. The hooks are
 * module-stable and read the active sandbox, so this is a module constant.
 */
export const workspaceFileSource: FileSource = {
  useFileContent,
  useBinaryBlob,
  download: downloadFile,
  upload: uploadFile,
  Breadcrumbs: FilePathBreadcrumbs,
};
