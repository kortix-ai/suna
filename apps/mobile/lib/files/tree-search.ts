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

/** One file or folder of the tree, with what the search compares precomputed. */
interface IndexedNode {
  result: TreeSearchResult;
  lowerName: string;
  lowerPath: string;
  depth: number;
  /** Position in `localeCompare` path order. */
  order: number;
}

/**
 * The index of one `entries` array, built on its first search. The files query
 * keeps the same array until it refetches, so each keystroke reuses it.
 */
const treeIndexes = new WeakMap<readonly TreeSearchEntry[], IndexedNode[]>();

function indexTree(entries: readonly TreeSearchEntry[]): IndexedNode[] {
  const cached = treeIndexes.get(entries);
  if (cached) return cached;

  const nodes: IndexedNode[] = [];
  const seenDirs = new Set<string>();
  const add = (result: TreeSearchResult, depth: number) =>
    nodes.push({ result, lowerName: result.name.toLowerCase(), lowerPath: result.path.toLowerCase(), depth, order: 0 });

  for (const entry of entries) {
    const path = entry.path.replace(/^\/+/, '');
    if (!path) continue;

    // Every ancestor folder of this file, once.
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      add({ name: parts[i - 1], path: dir, parent: parentOf(dir), type: 'directory' }, i);
    }

    add({ name: basename(path), path, parent: parentOf(path), type: 'file', size: entry.size ?? undefined }, parts.length);
  }

  // `localeCompare` is slow in Hermes. Sort by it once here, so a search
  // compares integers. This sort is stable, so paths `localeCompare` calls
  // equal keep entry order, as they did in the per-search sort.
  const byPath = [...nodes].sort((a, b) => a.result.path.localeCompare(b.result.path));
  byPath.forEach((node, i) => {
    node.order = i;
  });

  treeIndexes.set(entries, nodes);
  return nodes;
}

/**
 * 0: the name starts with the query. 1: the name contains it. 2: only the
 * full path contains it (`src/app` finds everything under `src/app`).
 * -1: no match. `name`, `path` and `q` are lowercase.
 */
function rank(name: string, path: string, q: string): number {
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  if (path.includes(q)) return 2;
  return -1;
}

/**
 * Every file and folder in `entries` whose name or path contains `query`
 * (case-insensitive). Folders come first, then files; inside each, best rank
 * first, then shallower paths, then path order. An empty query returns [].
 * Results are shared between searches of the same `entries`: do not mutate them.
 */
export function searchFileTree(entries: readonly TreeSearchEntry[], query: string): TreeSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const ranked: { node: IndexedNode; rank: number }[] = [];
  for (const node of indexTree(entries)) {
    const r = rank(node.lowerName, node.lowerPath, q);
    if (r >= 0) ranked.push({ node, rank: r });
  }

  ranked.sort((a, b) => {
    if (a.node.result.type !== b.node.result.type) return a.node.result.type === 'directory' ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.node.depth !== b.node.depth) return a.node.depth - b.node.depth;
    return a.node.order - b.node.order;
  });
  return ranked.map((r) => r.node.result);
}

/**
 * The immediate children of every folder of a flat file list, built in one
 * pass: `get(dir)` is what scanning every entry for `dir/` returned (`''` is
 * the root). A folder with no children has no key. Dirs and files keep entry
 * order.
 */
export function indexChildren<T extends { path: string }>(
  entries: readonly T[],
): Map<string, { dirs: string[]; files: T[] }> {
  const sets = new Map<string, { dirs: Set<string>; files: T[] }>();
  const at = (dir: string) => {
    let children = sets.get(dir);
    if (!children) sets.set(dir, (children = { dirs: new Set(), files: [] }));
    return children;
  };
  for (const entry of entries) {
    const p = entry.path;
    // `dir` is null after a leading slash: `''` is the root, not that folder.
    let dir: string | null = '';
    let start = 0;
    while (start < p.length) {
      const slash = p.indexOf('/', start);
      if (slash === -1) {
        if (dir !== null) at(dir).files.push(entry);
        break;
      }
      if (dir !== null) at(dir).dirs.add(p.slice(start, slash));
      dir = slash === 0 ? null : p.slice(0, slash);
      start = slash + 1;
    }
  }
  const out = new Map<string, { dirs: string[]; files: T[] }>();
  for (const [dir, { dirs, files }] of sets) out.set(dir, { dirs: [...dirs], files });
  return out;
}

/** The folder line under a search result: "src/app", or "Files" at the root. */
export function searchResultLocation(result: { parent?: string }, rootLabel = 'Files'): string {
  return result.parent || rootLabel;
}
