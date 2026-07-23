'use client';

import { useCallback } from 'react';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';

/**
 * File navigation for ACP tool locations.
 *
 * Every harness is launched with `/workspace` as its ACP cwd. Tool locations
 * beneath that root are displayed project-relative; the daemon file API also
 * accepts the other explicitly allowed absolute roots (`/home`, `/tmp`,
 * `/opt`), so those remain absolute instead of guessing an OpenCode worktree.
 */
export function useRuntimeFileOpen() {
  const openFileInComputer = useKortixComputerStore((state) => state.openFileInComputer);

  const toDisplayPath = useCallback((filePath: string): string => {
    if (filePath === '/workspace') return '';
    if (filePath.startsWith('/workspace/')) return filePath.slice('/workspace/'.length);
    return filePath;
  }, []);

  const openFile = useCallback((filePath: string) => {
    openFileInComputer(toDisplayPath(filePath));
  }, [openFileInComputer, toDisplayPath]);

  const openFileWithList = useCallback((filePath: string, allPaths: string[]) => {
    openFileInComputer(toDisplayPath(filePath), allPaths.map(toDisplayPath));
  }, [openFileInComputer, toDisplayPath]);

  return { openFile, openFileWithList, toDisplayPath };
}
