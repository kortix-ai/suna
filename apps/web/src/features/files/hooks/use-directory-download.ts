'use client';

import { errorToast, progressToast, successToast } from '@/components/ui/toast';
import { useCallback, useRef, useState } from 'react';
import { downloadDirectory } from '../api/opencode-files';

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

      const toastId = progressToast(`Zipping ${dirName}…`);

      try {
        let lastPct = 0;

        await downloadDirectory(dirPath, dirName, (progress) => {
          const pct = Math.round(progress * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            progressToast(`Zipping ${dirName}… ${pct}%`, { id: toastId });
          }
        });

        successToast(`Downloaded ${dirName}.zip`, { id: toastId, duration: 3000 });
      } catch (err) {
        errorToast(
          `Failed to download ${dirName}: ${err instanceof Error ? err.message : 'Unknown error'}`,
          { id: toastId, duration: 5000 },
        );
      } finally {
        activeRef.current.delete(dirPath);
        rerender();
      }
    },
    [rerender],
  );

  const isDownloading = useCallback(
    (path: string) => activeRef.current.has(path),
    [], // stable — reads the ref directly at call time
  );

  return { downloadDir, isDownloading, downloadingPaths: activeRef.current };
}
