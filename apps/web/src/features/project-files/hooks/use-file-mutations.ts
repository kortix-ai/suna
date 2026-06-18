'use client';

import { errorToast } from '@/components/ui/toast';
import { useMutation } from '@tanstack/react-query';
import type { UploadResult } from '../api/opencode-files';

/**
 * File mutations — read-only stubs for project-files.
 *
 * The page hides every UI surface that calls these (Upload / New folder
 * / New file / Rename / Delete / Cut+Paste). They remain wired so the
 * copied components keep the same prop shape, but every invocation toasts
 * "Project files are read-only in this view" and refuses.
 */

const READ_ONLY_MSG = 'Project files are read-only in this view';

function rejectReadOnly(): Promise<never> {
  errorToast(READ_ONLY_MSG);
  return Promise.reject(new Error(READ_ONLY_MSG));
}

export function useFileUpload() {
  return useMutation<UploadResult[], Error, { file: File | Blob; targetPath?: string }>({
    mutationFn: () => rejectReadOnly() as unknown as Promise<UploadResult[]>,
  });
}

export function useFileDelete() {
  return useMutation<boolean, Error, { filePath: string }>({
    mutationFn: () => rejectReadOnly() as unknown as Promise<boolean>,
  });
}

export function useFileMkdir() {
  return useMutation<boolean, Error, { dirPath: string }>({
    mutationFn: () => rejectReadOnly() as unknown as Promise<boolean>,
  });
}

export function useFileRename() {
  return useMutation<boolean, Error, { from: string; to: string }>({
    mutationFn: () => rejectReadOnly() as unknown as Promise<boolean>,
  });
}

export function useFileCreate() {
  return useMutation<UploadResult[], Error, { filePath: string }>({
    mutationFn: () => rejectReadOnly() as unknown as Promise<UploadResult[]>,
  });
}

export function useFileCopy() {
  return useMutation<UploadResult[], Error, { sourcePath: string; destPath: string }>({
    mutationFn: () => rejectReadOnly() as unknown as Promise<UploadResult[]>,
  });
}
