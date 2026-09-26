/**
 * Search over a project's whole file tree (COR-155). The `/files` endpoint
 * returns a flat recursive list of files, so the Files page already holds the
 * whole tree: search covers every folder, not only the one on screen. Folders
 * are derived from the file paths, the same way the page derives them.
 *
 * Pure: no React, no React Native.
 */

export interface TreeSearchEntry {
  path: string;
  size?: number | null;
}

export interface TreeSearchResult {
  /** Basename of the file or folder. */
  name: string;
  /** Full path from the repo root, no leading slash. */
  path: string;
  /** Path of the containing folder, '' for the root. */
  parent: string;
  type: 'file' | 'directory';
  size?: number;
}

const basename = (path: string) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
};
const parentOf = (path: string) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/**
 * 0: the name starts with the query. 1: the name contains it. 2: only the
 * full path contains it (`src/app` finds everything under `src/app`).
 * -1: no match.
 */
function rank(name: string, path: string, q: string): number {
  const n = name.toLowerCase();
  if (n.startsWith(q)) return 0;
  if (n.includes(q)) return 1;
  if (path.toLowerCase().includes(q)) return 2;
  return -1;
}

/**
 * Every file and folder in `entries` whose name or path contains `query`
 * (case-insensitive). Folders come first, then files; inside each, best rank
 * first, then shallower paths, then path order. An empty query returns [].
 */
export function searchFileTree(entries: readonly TreeSearchEntry[], query: string): TreeSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const ranked: { result: TreeSearchResult; rank: number; depth: number }[] = [];
  const seenDirs = new Set<string>();

  for (const entry of entries) {
    const path = entry.path.replace(/^\/+/, '');
    if (!path) continue;

    // Every ancestor folder of this file, once.
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      const name = parts[i - 1];
      const r = rank(name, dir, q);
      if (r >= 0) {
        ranked.push({ result: { name, path: dir, parent: parentOf(dir), type: 'directory' }, rank: r, depth: i });
      }
    }

    const name = basename(path);
    const r = rank(name, path, q);
    if (r >= 0) {
      ranked.push({
        result: { name, path, parent: parentOf(path), type: 'file', size: entry.size ?? undefined },
        rank: r,
        depth: parts.length,
      });
    }
  }

  ranked.sort((a, b) => {
    if (a.result.type !== b.result.type) return a.result.type === 'directory' ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.result.path.localeCompare(b.result.path);
  });
  return ranked.map((r) => r.result);
}

/** The folder line under a search result: "src/app", or "Files" at the root. */
export function searchResultLocation(result: { parent?: string }, rootLabel = 'Files'): string {
  return result.parent || rootLabel;
}
