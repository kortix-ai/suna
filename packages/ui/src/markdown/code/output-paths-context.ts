'use client';

import { createContext, useContext } from 'react';

/**
 * The paths of the files this session produced: its Outputs.
 *
 * A reply names its deliverables by bare filename (`claims.md`), and a bare
 * name is not a path, so it never linked. Opening it took Expand pane →
 * Outputs → the file (KRTX-3023). Inline code that names exactly one of these
 * outputs now opens it.
 *
 * Provider: `SessionPanelProvider`. Empty outside a session: nothing extra links.
 */
export const OutputPathsContext = createContext<readonly string[]>([]);

export const useOutputPaths = (): readonly string[] => useContext(OutputPathsContext);

const BARE_FILENAME = /^[\w@][\w@.-]*\.[A-Za-z0-9]+$/;

/** `/workspace/a/b.md` and `a/b.md` are one file. */
const sameFileKey = (path: string) => path.replace(/^\/workspace\//, '');

/**
 * The output a bare filename names, or null: it is not a filename, no output
 * has that name, or two different outputs share it and the reply does not say
 * which.
 */
export function outputPathForName(text: string, paths: readonly string[]): string | null {
  if (!BARE_FILENAME.test(text)) return null;
  let found: string | null = null;
  for (const path of paths) {
    if (path.slice(path.lastIndexOf('/') + 1) !== text) continue;
    if (found !== null && sameFileKey(found) !== sameFileKey(path)) return null;
    found ??= path;
  }
  return found;
}
