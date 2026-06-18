'use client';

import { errorToast, loadingToast } from '@/components/ui/toast';
import { useCallback, useRef, useState } from 'react';
import { downloadDirectory } from '../api/opencode-files';
import { useProjectContext } from '../context';

/**
 * Download a project-files directory as a zip. The backend streams a
 * `git archive` zip — the client only triggers the request, awaits the blob,
 * and saves it. Concurrent downloads for distinct paths are allowed.
 */
export function useDirectoryDownload() {
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const ref = ctx?.ref ?? '';

  const activeRef = useRef<Set<string>>(new Set());
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((t) => t + 1), []);

  const downloadDir = useCallback(
    async (dirPath: string, dirName: string) => {
      if (!projectId || !ref) {
        errorToast('Project not ready');
        return;
      }
      if (activeRef.current.has(dirPath)) return;
      activeRef.current.add(dirPath);
      rerender();

      try {
        await loadingToast(
          `Downloading ${dirName}…`,
          () => downloadDirectory(projectId, ref, dirPath, dirName),
          {
            success: `Downloaded ${dirName}.zip`,
            showErrorToast: true,
            error: (err) =>
              `Failed to download ${dirName}: ${err instanceof Error ? err.message : 'Unknown error'}`,
          },
        );
      } catch {
        // loadingToast already surfaced the error toast
      } finally {
        activeRef.current.delete(dirPath);
        rerender();
      }
    },
    [projectId, ref, rerender],
  );

  const isDownloading = useCallback((path: string) => activeRef.current.has(path), []);

  return { downloadDir, isDownloading, downloadingPaths: activeRef.current };
}
