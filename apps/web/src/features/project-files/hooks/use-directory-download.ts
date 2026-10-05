'use client';

import { errorToast, loadingToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { useCallback, useRef, useState } from 'react';
import { downloadDirectory } from '../api/runtime-files';
import { useProjectContext } from '../context';

/**
 * Download a project-files directory as a zip. The backend streams a
 * `git archive` zip — the client only triggers the request, awaits the blob,
 * and saves it. Concurrent downloads for distinct paths are allowed.
 */
export function useDirectoryDownload() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const ctx = useProjectContext();
  const projectId = ctx?.projectId ?? '';
  const ref = ctx?.ref ?? '';

  const activeRef = useRef<Set<string>>(new Set());
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((t) => t + 1), []);

  const downloadDir = useCallback(
    async (dirPath: string, dirName: string) => {
      if (!projectId || !ref) {
        errorToast(tI18nComplete.raw('text5294a47839ac'));
        return;
      }
      if (activeRef.current.has(dirPath)) return;
      activeRef.current.add(dirPath);
      rerender();

      try {
        await loadingToast(
          tI18nComplete('texta6879661926e', { value0: dirName }),
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
    [projectId, ref, rerender, tI18nComplete],
  );

  const isDownloading = useCallback((path: string) => activeRef.current.has(path), []);

  return { downloadDir, isDownloading, downloadingPaths: activeRef.current };
}
