'use client';

import type { FileSource } from '@/features/file-viewer';
import { downloadFile, uploadFile } from './api/runtime-files';
import { useFileContent } from './hooks';
import { useBinaryBlob } from './hooks/use-binary-blob';
import { useFileRefresh } from './hooks/use-file-refresh';
// Do not import this component through the project-files barrel. The barrel
// reaches useGitStatus through useChangeRequests and re-enters features/files.
// Webpack cannot evaluate that async cycle while building this module constant.
import { FilePathBreadcrumbs } from '@/features/project-files/components/file-breadcrumbs';

/**
 * Live-workspace data source for the shared file viewer/modal. The hooks are
 * module-stable and read the active sandbox, so this is a module constant.
 */
export const workspaceFileSource: FileSource = {
  id: 'sandbox-workspace',
  useFileContent,
  useBinaryBlob,
  download: downloadFile,
  upload: uploadFile,
  Breadcrumbs: FilePathBreadcrumbs,
  useRefresh: useFileRefresh,
};
