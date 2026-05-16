'use client';

import { useCallback } from 'react';
import { toast as sonnerToast } from 'sonner';

/**
 * Directory download — stubbed for project-files (read-only).
 *
 * TODO: wire to project history/search once backend supports it
 */
export function useDirectoryDownload() {
  const downloadDir = useCallback(async (_dirPath: string, dirName: string) => {
    sonnerToast.error(`Directory download not available for "${dirName}" (project files are read-only).`);
  }, []);

  const isDownloading = useCallback((_path: string) => false, []);

  return {
    downloadDir,
    isDownloading,
    downloadingPaths: new Set<string>(),
  };
}
