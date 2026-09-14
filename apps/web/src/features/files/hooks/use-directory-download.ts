'use client';

import { errorToast, progressToast, successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { useCallback, useRef, useState } from 'react';
import { downloadDirectory } from '../api/runtime-files';

/**
 * Hook that manages downloading directories as zips with visible progress.
 *
 * Supports multiple concurrent downloads — each gets its own toast with
 * live progress, addressed by a stable toast id so updates replace in place.
 *
 * Returns:
 *  - `downloadDir(path, name)` — trigger a download (concurrent-safe)
 *  - `isDownloading(path)` — whether a specific path is currently downloading
 *  - `downloadingPaths` — Set of paths currently being downloaded
 */
export function useDirectoryDownload() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // Use a ref for the set so mutations don't cause re-renders,
  // and a counter to trigger re-renders only when the set changes size.
  const activeRef = useRef<Set<string>>(new Set());
  const [, setTick] = useState(0);

  const rerender = useCallback(() => setTick((t) => t + 1), []);

  const downloadDir = useCallback(
    async (dirPath: string, dirName: string) => {
      if (activeRef.current.has(dirPath)) return; // already in progress for this exact path

      activeRef.current.add(dirPath);
      rerender();

      const toastId = progressToast(tI18nComplete('texta236d1b1454f', { value0: dirName }));

      try {
        let lastPct = 0;

        await downloadDirectory(dirPath, dirName, (progress) => {
          const pct = Math.round(progress * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            progressToast(tI18nComplete('texte98258ade585', { value0: dirName, value1: pct }), {
              id: toastId,
            });
          }
        });

        successToast(tI18nComplete('textd8e4cc72a516', { value0: dirName }), {
          id: toastId,
          duration: 3000,
        });
      } catch (err) {
        errorToast(
          tI18nComplete('textf323a777d921', {
            value0: dirName,
            value1: err instanceof Error ? err.message : tI18nComplete.raw('text27c2ccd962c2'),
          }),
          { id: toastId, duration: 5000 },
        );
      } finally {
        activeRef.current.delete(dirPath);
        rerender();
      }
    },
    [rerender, tI18nComplete],
  );

  const isDownloading = useCallback(
    (path: string) => activeRef.current.has(path),
    [], // stable — reads the ref directly at call time
  );

  return { downloadDir, isDownloading, downloadingPaths: activeRef.current };
}
