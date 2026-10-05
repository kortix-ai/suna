/**
 * The sandbox file tree, as data only.
 *
 * Every state transition the Files screen makes — load a directory, expand,
 * collapse, filter, flatten to rows — is a pure function here, so the whole
 * navigation model is covered by `file-tree.test.ts` with no renderer and no
 * SDK. `files-screen.tsx` holds one `FileTree` in state and calls these.
 *
 * Paths are the absolute sandbox paths the daemon returns (`/workspace/src`).
 * `listFiles` already normalizes every node's `path` to its `absolute`
 * (packages/sdk/src/core/files/client.ts:151), so one string identifies a node
 * everywhere: the map key, the row id, and what `y` copies.
 */

/** One node as the SDK's `FileNode` gives it, narrowed to what a row needs. */
export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  /** The daemon's gitignore verdict. Ignored nodes render dim. */
  ignored?: boolean;
}

/** How a directory's children are doing. Absent from the map = never asked. */
export type DirectoryLoad =
  | { state: 'loading' }
  | { state: 'loaded'; nodes: TreeNode[] }
  | { state: 'error'; message: string };

export interface FileTree {
  /** The directory the tree is rooted at. Never rendered as a row itself. */
  root: string;
  /** Children by directory path. */
  loads: ReadonlyMap<string, DirectoryLoad>;
  /** Directories the reader has opened. The root is always open. */
  expanded: ReadonlySet<string>;
}

/** A flattened, renderable row. `depth` is levels below the root. */
export interface TreeRow {
  /** The node's absolute path. Unique, so it is also the row id. */
  id: string;
  name: string;
  path: string;
  type: 'file' | 'directory';
  depth: number;
  ignored: boolean;
  /** Directories only: is it open right now. */
  expanded: boolean;
  /** Directories only: its children are in flight. */
  loading: boolean;
  /** Set when the directory's load failed. Rendered on the row. */
  error?: string;
}

export function createTree(root: string): FileTree {
  return { root, loads: new Map(), expanded: new Set([root]) };
}

/**
 * Directories first, then case-insensitive name, then the raw name as a
 * tie-break so the order is total and a re-list never reshuffles equal rows.
 */
export function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  const lower = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  if (lower !== 0) return lower;
  return a.name.localeCompare(b.name);
}

export function sortNodes(nodes: readonly TreeNode[]): TreeNode[] {
  return [...nodes].sort(compareNodes);
}

function withLoad(tree: FileTree, path: string, load: DirectoryLoad): FileTree {
  const loads = new Map(tree.loads);
  loads.set(path, load);
  return { ...tree, loads };
}

export function markLoading(tree: FileTree, path: string): FileTree {
  return withLoad(tree, path, { state: 'loading' });
}

export function setChildren(tree: FileTree, path: string, nodes: readonly TreeNode[]): FileTree {
  return withLoad(tree, path, { state: 'loaded', nodes: sortNodes(nodes) });
}

export function setError(tree: FileTree, path: string, message: string): FileTree {
  return withLoad(tree, path, { state: 'error', message });
}

export function isExpanded(tree: FileTree, path: string): boolean {
  return tree.expanded.has(path);
}

export function expand(tree: FileTree, path: string): FileTree {
  if (tree.expanded.has(path)) return tree;
  const expanded = new Set(tree.expanded);
  expanded.add(path);
  return { ...tree, expanded };
}

export function collapse(tree: FileTree, path: string): FileTree {
  if (!tree.expanded.has(path)) return tree;
  const expanded = new Set(tree.expanded);
  expanded.delete(path);
  return { ...tree, expanded };
}

/** Drop every loaded child list, keeping which directories are open. `r`. */
export function forgetLoads(tree: FileTree): FileTree {
  return { ...tree, loads: new Map() };
}

/** The directory a path sits in, or null at or above the root. */
export function parentOf(tree: FileTree, path: string): string | null {
  if (path === tree.root) return null;
  const cut = path.lastIndexOf('/');
  if (cut <= 0) return null;
  const parent = path.slice(0, cut);
  return parent.length >= tree.root.length ? parent : null;
}

/** Depth-first rows for every expanded directory, root children first. */
export function flatten(tree: FileTree): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number): void => {
    const load = tree.loads.get(dir);
    if (!load) return;
    if (load.state !== 'loaded') return;
    for (const node of load.nodes) {
      const childLoad = node.type === 'directory' ? tree.loads.get(node.path) : undefined;
      rows.push({
        id: node.path,
        name: node.name,
        path: node.path,
        type: node.type,
        depth,
        ignored: Boolean(node.ignored),
        expanded: node.type === 'directory' && tree.expanded.has(node.path),
        loading: childLoad?.state === 'loading',
        error: childLoad?.state === 'error' ? childLoad.message : undefined,
      });
      if (node.type === 'directory' && tree.expanded.has(node.path)) walk(node.path, depth + 1);
    }
  };
  walk(tree.root, 0);
  return rows;
}

/**
 * Keep the rows whose name contains `query`, plus every ancestor directory of
 * a kept row so the hit still reads in its place in the tree. Ancestors are
 * recognized by path prefix, which is exact here: `flatten` emits a parent
 * before its children, and every path is absolute.
 *
 * This filters LOADED nodes only — it is a narrowing of what is on screen, not
 * a search of the sandbox. `files-screen.tsx` says so in the hint line.
 */
export function filterRows(rows: readonly TreeRow[], query: string): TreeRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  const matched = rows.filter((row) => row.name.toLowerCase().includes(needle));
  const keep = new Set(matched.map((row) => row.id));
  for (const row of matched) {
    for (const candidate of rows) {
      if (candidate.type !== 'directory') continue;
      if (row.path.startsWith(`${candidate.path}/`)) keep.add(candidate.id);
    }
  }
  return rows.filter((row) => keep.has(row.id));
}

/**
 * Dot-prefixed names that are shown even when hidden entries are off.
 *
 * Same two `apps/web`'s explorer exempts (`use-file-list.ts`): they hold the
 * project's agents, skills and commands, so hiding them hides the product.
 */
export const ALWAYS_VISIBLE_DOTFILES: ReadonlySet<string> = new Set(['.kortix', '.opencode']);

/**
 * Drop dot-prefixed rows, and every row beneath a dropped directory.
 *
 * Without this the first thing a reader sees in a Kortix workspace is `.git`
 * with its 15 plumbing files — verified against the live sandbox. `apps/web`
 * hides the same names behind the same exemptions and offers the same toggle.
 */
export function hideDotfiles(rows: readonly TreeRow[]): TreeRow[] {
  const hiddenPrefixes: string[] = [];
  const kept: TreeRow[] = [];
  for (const row of rows) {
    if (hiddenPrefixes.some((prefix) => row.path.startsWith(prefix))) continue;
    if (row.name.startsWith('.') && !ALWAYS_VISIBLE_DOTFILES.has(row.name)) {
      if (row.type === 'directory') hiddenPrefixes.push(`${row.path}/`);
      continue;
    }
    kept.push(row);
  }
  return kept;
}

/** The load state of a directory, for a caller deciding whether to fetch. */
export function loadStateOf(tree: FileTree, path: string): DirectoryLoad | undefined {
  return tree.loads.get(path);
}
