/**
 * Workspace search core — pure utility functions for normalizing paths,
 * ranking search entries, matching queries, and deduplication.
 *
 * Ported from apps/web/src/features/files/search/workspace-search-core.ts
 * No external dependencies — can be used in any JS/TS environment.
 */

export interface WorkspaceSearchEntry {
  path: string;
  name: string;
  isDir: boolean;
}

export interface WorkspaceSearchOptions {
  limit?: number;
  type?: 'file' | 'directory';
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function normalizeSearchQuery(query: string): string {
  const normalized = normalizeSlashes(query.trim());
  if (!normalized) return '';
  if (normalized === '/' || normalized === '/workspace/' || normalized === 'workspace/') {
    return '/workspace';
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

export function stripWorkspacePrefix(path: string): string {
  const normalized = normalizeSearchQuery(path);
  return normalized
    .replace(/^\/workspace\/?/i, '')
    .replace(/^workspace\/?/i, '')
    .replace(/^\/+/, '');
}

export function normalizeWorkspacePath(path: string): string {
  const normalized = normalizeSearchQuery(path);
  if (!normalized || normalized === '.' || normalized === './') return '/workspace';
  if (normalized === 'workspace') return '/workspace';
  if (normalized.startsWith('/workspace')) return normalized;
  if (normalized.startsWith('workspace/')) return `/${normalized}`;
  if (normalized === '/') return '/workspace';
  if (normalized.startsWith('/')) return normalized;
  return `/workspace/${normalized.replace(/^\/+/, '')}`;
}

export function getWorkspaceEntryName(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  return normalized.split('/').filter(Boolean).pop() || normalized;
}

export function toWorkspaceSearchEntry(
  path: string,
  isDir = false,
): WorkspaceSearchEntry {
  const normalized = normalizeWorkspacePath(path);
  return {
    path: normalized,
    name: getWorkspaceEntryName(normalized),
    isDir,
  };
}

export function parseWorkspacePaths(
  paths: string[],
  knownDirs?: Iterable<string>,
): WorkspaceSearchEntry[] {
  const directorySet = new Set<string>();
  if (knownDirs) {
    for (const path of knownDirs) {
      directorySet.add(normalizeWorkspacePath(path));
    }
  }

  return dedupeWorkspaceSearchEntries(
    paths.map((path) => {
      const isDir = path.endsWith('/') || directorySet.has(normalizeWorkspacePath(path));
      const cleanPath = isDir ? path.replace(/\/+$/, '') : path;
      return toWorkspaceSearchEntry(cleanPath, isDir);
    }),
  );
}

export function workspaceQueryLooksPathLike(query: string): boolean {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return false;
  return normalized.includes('/') || normalized.startsWith('.') || normalized.startsWith('workspace');
}

function isSubsequence(haystack: string, needle: string): boolean {
  if (!needle) return true;
  let index = 0;
  for (let i = 0; i < haystack.length && index < needle.length; i++) {
    if (haystack[i] === needle[index]) index += 1;
  }
  return index === needle.length;
}

function pathSegmentsMatch(path: string, query: string): boolean {
  const querySegments = stripWorkspacePrefix(query)
    .toLowerCase()
    .split('/')
    .filter(Boolean);
  if (querySegments.length < 2) return false;

  const pathSegments = stripWorkspacePrefix(path)
    .toLowerCase()
    .split('/')
    .filter(Boolean);

  let pathIndex = 0;
  for (const segment of querySegments) {
    let matched = false;
    while (pathIndex < pathSegments.length) {
      if (pathSegments[pathIndex].includes(segment)) {
        matched = true;
        pathIndex += 1;
        break;
      }
      pathIndex += 1;
    }
    if (!matched) return false;
  }

  return true;
}

function getQueryVariants(query: string) {
  const normalized = normalizeSearchQuery(query).toLowerCase();
  const relative = stripWorkspacePrefix(normalized).toLowerCase();
  const basename = relative.split('/').filter(Boolean).pop() || relative;
  return {
    normalized,
    relative,
    basename,
    pathLike: workspaceQueryLooksPathLike(query),
    looksFileLike: /\.[a-z0-9]{1,10}$/i.test(basename),
  };
}

function getEntryVariants(entry: WorkspaceSearchEntry) {
  const absolute = normalizeWorkspacePath(entry.path).toLowerCase();
  const relative = stripWorkspacePrefix(absolute).toLowerCase();
  const basename = entry.name.toLowerCase();
  const depth = relative.split('/').filter(Boolean).length;
  return { absolute, relative, basename, depth };
}

export function workspaceEntryMatchesQuery(
  entry: WorkspaceSearchEntry,
  query: string,
): boolean {
  const q = getQueryVariants(query);
  if (!q.normalized) return true;

  const entryVariants = getEntryVariants(entry);

  if (q.normalized && entryVariants.absolute.includes(q.normalized)) return true;
  if (q.relative && entryVariants.relative.includes(q.relative)) return true;
  if (q.basename && entryVariants.basename.includes(q.basename)) return true;
  if (q.pathLike && q.relative && pathSegmentsMatch(entryVariants.absolute, q.relative)) return true;
  if (q.basename.length >= 2 && isSubsequence(entryVariants.basename, q.basename)) return true;
  if (q.relative.length >= 3 && isSubsequence(entryVariants.relative, q.relative)) return true;

  return false;
}

export function rankWorkspaceSearchEntry(
  entry: WorkspaceSearchEntry,
  query: string,
): number {
  const q = getQueryVariants(query);
  const entryVariants = getEntryVariants(entry);
  const dirPenalty = q.looksFileLike && entry.isDir ? 25 : 0;
  const depthPenalty = entryVariants.depth * 0.001;

  if (!q.normalized) return depthPenalty + dirPenalty;
  if (entryVariants.absolute === q.normalized || entryVariants.relative === q.relative) {
    return 0 + dirPenalty + depthPenalty;
  }
  if (q.relative && entryVariants.relative.endsWith(q.relative)) {
    return 10 + dirPenalty + depthPenalty;
  }
  if (q.pathLike && q.relative && pathSegmentsMatch(entryVariants.absolute, q.relative)) {
    return 20 + dirPenalty + depthPenalty;
  }
  if (q.basename && entryVariants.basename === q.basename) {
    return 30 + dirPenalty + depthPenalty;
  }
  if (q.basename && entryVariants.basename.startsWith(q.basename)) {
    return 40 + dirPenalty + depthPenalty;
  }
  if (q.basename && entryVariants.basename.includes(q.basename)) {
    return 50 + dirPenalty + depthPenalty;
  }
  if (q.normalized && entryVariants.absolute.startsWith(q.normalized)) {
    return 60 + dirPenalty + depthPenalty;
  }
  if (q.relative && entryVariants.relative.startsWith(q.relative)) {
    return 70 + dirPenalty + depthPenalty;
  }
  if (q.normalized && entryVariants.absolute.includes(q.normalized)) {
    return 80 + dirPenalty + depthPenalty;
  }
  if (q.relative && entryVariants.relative.includes(q.relative)) {
    return 90 + dirPenalty + depthPenalty;
  }
  if (q.basename.length >= 2 && isSubsequence(entryVariants.basename, q.basename)) {
    return 100 + dirPenalty + depthPenalty;
  }
  if (q.relative.length >= 3 && isSubsequence(entryVariants.relative, q.relative)) {
    return 110 + dirPenalty + depthPenalty;
  }
  return 1000 + dirPenalty + entryVariants.depth;
}

export function dedupeWorkspaceSearchEntries(
  entries: WorkspaceSearchEntry[],
): WorkspaceSearchEntry[] {
  const seen = new Set<string>();
  const deduped: WorkspaceSearchEntry[] = [];

  for (const entry of entries) {
    const normalizedPath = normalizeWorkspacePath(entry.path);
    const key = `${normalizedPath}:${entry.isDir ? 'dir' : 'file'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      path: normalizedPath,
      name: entry.name || getWorkspaceEntryName(normalizedPath),
      isDir: entry.isDir,
    });
  }

  return deduped;
}

export function searchIndexedWorkspaceEntries(
  entries: WorkspaceSearchEntry[],
  query: string,
  options?: WorkspaceSearchOptions,
): WorkspaceSearchEntry[] {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) return [];

  const limit = options?.limit ?? 50;

  return dedupeWorkspaceSearchEntries(entries)
    .filter((entry) => {
      if (options?.type === 'file' && entry.isDir) return false;
      if (options?.type === 'directory' && !entry.isDir) return false;
      return workspaceEntryMatchesQuery(entry, normalizedQuery);
    })
    .sort((left, right) => {
      const leftRank = rankWorkspaceSearchEntry(left, normalizedQuery);
      const rightRank = rankWorkspaceSearchEntry(right, normalizedQuery);
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.path.localeCompare(right.path);
    })
    .slice(0, limit);
}

export function mergeWorkspaceSearchEntries(
  primary: WorkspaceSearchEntry[],
  fallback: WorkspaceSearchEntry[],
  query: string,
  options?: WorkspaceSearchOptions,
): WorkspaceSearchEntry[] {
  return searchIndexedWorkspaceEntries(
    [...primary, ...fallback],
    query,
    options,
  );
}
