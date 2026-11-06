/** The file viewer: the open file, its scroll offset, and the read in flight. */

import { type RefObject, useCallback, useRef, useState } from 'react';

import { type ViewerState, toViewerState } from '../files/index.ts';
import { errorText, repoPath } from './repo-model.ts';
import type { RepoLoaders } from './repo-view.tsx';

export function useRepoViewer(
  loaders: RepoLoaders,
  ref: string | undefined,
  generation: RefObject<number>,
) {
  const [viewer, setViewer] = useState<ViewerState>({ kind: 'empty' });
  const [viewerOffset, setViewerOffset] = useState(0);
  const pendingRead = useRef<string | null>(null);

  const openFile = useCallback(
    async (path: string) => {
      const gen = generation.current;
      pendingRead.current = path;
      setViewer({ kind: 'loading', path });
      setViewerOffset(0);
      try {
        const result = await loaders.readFile(path, ref);
        if (gen !== generation.current || pendingRead.current !== path) return;
        setViewer(toViewerState(repoPath(path), result));
      } catch (error) {
        if (gen !== generation.current || pendingRead.current !== path) return;
        setViewer({ kind: 'error', path: repoPath(path), message: errorText(error) });
      }
    },
    [loaders, ref, generation],
  );

  /** Drops the read in flight and empties the viewer. */
  const reset = useCallback(() => {
    pendingRead.current = null;
    setViewer({ kind: 'empty' });
    setViewerOffset(0);
  }, []);

  return { viewer, viewerOffset, setViewerOffset, openFile, reset };
}
