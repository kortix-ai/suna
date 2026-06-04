/**
 * Workspace search service — combines backend API results with path traversal
 * and a cached workspace index for reliable deep-path resolution.
 *
 * Ported from apps/web/src/features/files/search/workspace-search-service.ts
 * Adapted for mobile (uses direct fetch via ocFetch instead of web SDK client).
 */

import { getAuthToken } from '@/api/config';
import {
  type WorkspaceSearchEntry,
  type WorkspaceSearchOptions,
  dedupeWorkspaceSearchEntries,
  mergeWorkspaceSearchEntries,
  normalizeSearchQuery,
  parseWorkspacePaths,
  rankWorkspaceSearchEntry,
  searchIndexedWorkspaceEntries,
  toWorkspaceSearchEntry,
  workspaceQueryLooksPathLike,
} from './workspace-search-core';

// ── Types ────────────────────────────────────────────────────────────────

interface WorkspaceSearchRuntimeOptions extends WorkspaceSearchOptions {
  apiLimit?: number;
}

interface WorkspaceIndexCache {
  entries: WorkspaceSearchEntry[];
  fetchedAt: number;
  inFlight?: Promise<WorkspaceSearchEntry[]>;
}

// ── Constants ────────────────────────────────────────────────────────────

const INDEX_TTL_MS = 60_000;
const INDEX_MAX_ENTRIES = 5_000;
const INDEX_CONCURRENCY = 6;
const INDEX_SKIP_DIR_NAMES = new Set([
  '.git',
  '.next',
  '.pnpm',
  '.turbo',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

// ── Caches ───────────────────────────────────────────────────────────────

const workspaceIndexCaches = new Map<string, WorkspaceIndexCache>();

// ── Internal fetch helpers ───────────────────────────────────────────────

async function ocFetch<T>(sandboxUrl: string, path: string): Promise<T | null> {
  try {
    const token = await getAuthToken();
    const res = await fetch(`${sandboxUrl}${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function normalizeApiEntries(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const result: string[] = [];
  for (const entry of data) {
    if (typeof entry === 'string' && entry.length > 0) {
      result.push(entry);
    } else if (entry && typeof entry === 'object') {
      const p = (entry as any).path ?? (entry as any).absolute ?? '';
      const t = (entry as any).type;
      if (typeof p === 'string' && p.length > 0) {
        result.push(t === 'directory' && !p.endsWith('/') ? `${p}/` : p);
      }
    }
  }
  return result;
}

// ── Low-level API wrappers ───────────────────────────────────────────────

async function findFiles(
  sandboxUrl: string,
  query: string,
  options?: { type?: 'file' | 'directory'; limit?: number },
): Promise<string[]> {
  const params = new URLSearchParams({ query });
  if (options?.type) params.set('type', options.type);
  if (options?.limit) params.set('limit', String(options.limit));
  const data = await ocFetch<unknown>(sandboxUrl, `/find/file?${params}`);
  return normalizeApiEntries(data);
}

async function listDirectoryEntries(
  sandboxUrl: string,
  dirPath: string,
): Promise<WorkspaceSearchEntry[]> {
  try {
    const data = await ocFetch<unknown>(sandboxUrl, `/file?path=${encodeURIComponent(dirPath)}`);
    const entries = normalizeApiEntries(data);
    return dedupeWorkspaceSearchEntries(
      entries.map((p) => {
        const isDir = p.endsWith('/');
        const clean = isDir ? p.replace(/\/+$/, '') : p;
        return toWorkspaceSearchEntry(clean, isDir);
      }),
    );
  } catch {
    return [];
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function toDirectoryPath(path: string): string {
  return path.replace(/\/+$/, '');
}

function toResultPath(entry: WorkspaceSearchEntry): string {
  return entry.isDir ? `${entry.path}/` : entry.path;
}

function getCacheForServer(serverUrl: string): WorkspaceIndexCache | undefined {
  return workspaceIndexCaches.get(serverUrl);
}

function setCacheForServer(serverUrl: string, cache: WorkspaceIndexCache): void {
  workspaceIndexCaches.set(serverUrl, cache);
}

// ── Backend search ───────────────────────────────────────────────────────

async function getBackendEntries(
  sandboxUrl: string,
  query: string,
  options: WorkspaceSearchRuntimeOptions,
): Promise<WorkspaceSearchEntry[]> {
  const limit = options.apiLimit ?? Math.max(options.limit ?? 50, 100);

  if (options.type === 'file') {
    const fileOnly = await findFiles(sandboxUrl, query, { type: 'file', limit });
    return parseWorkspacePaths(fileOnly);
  }

  if (options.type === 'directory') {
    const dirsOnly = await findFiles(sandboxUrl, query, { type: 'directory', limit });
    return parseWorkspacePaths(dirsOnly.map((path) => `${path.replace(/\/+$/, '')}/`));
  }

  const [fileOnly, broad, dirsOnly] = await Promise.all([
    findFiles(sandboxUrl, query, { type: 'file', limit }),
    findFiles(sandboxUrl, query, { limit }),
    findFiles(sandboxUrl, query, { type: 'directory', limit }),
  ]);

  const normalizedDirs = dirsOnly.map((path) => path.replace(/\/+$/, ''));
  return parseWorkspacePaths([...fileOnly, ...broad, ...dirsOnly], normalizedDirs);
}

// ── Segment matching (for path traversal) ────────────────────────────────

function rankSegmentName(name: string, segment: string): number {
  const lowerName = name.toLowerCase();
  const lowerSegment = segment.toLowerCase();
  if (!lowerSegment) return 0;
  if (lowerName === lowerSegment) return 0;
  if (lowerName.startsWith(lowerSegment)) return 10;
  if (lowerName.includes(lowerSegment)) return 20;

  let index = 0;
  for (let i = 0; i < lowerName.length && index < lowerSegment.length; i++) {
    if (lowerName[i] === lowerSegment[index]) index += 1;
  }
  return index === lowerSegment.length ? 30 : 1000;
}

function filterSegmentEntries(
  entries: WorkspaceSearchEntry[],
  segment: string,
  options?: WorkspaceSearchOptions,
): WorkspaceSearchEntry[] {
  return entries
    .filter((entry) => {
      if (options?.type === 'file' && entry.isDir) return false;
      if (options?.type === 'directory' && !entry.isDir) return false;
      return rankSegmentName(entry.name, segment) < 1000;
    })
    .sort((left, right) => {
      const leftRank = rankSegmentName(left.name, segment);
      const rightRank = rankSegmentName(right.name, segment);
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.path.localeCompare(right.path);
    });
}

// ── Path traversal search ────────────────────────────────────────────────

async function searchByPathTraversal(
  sandboxUrl: string,
  query: string,
  options: WorkspaceSearchRuntimeOptions,
): Promise<WorkspaceSearchEntry[]> {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!workspaceQueryLooksPathLike(normalizedQuery)) return [];

  const segments = normalizedQuery
    .replace(/^\/workspace\/?/i, '')
    .replace(/^workspace\/?/i, '')
    .split('/')
    .filter(Boolean);

  if (segments.length === 0) return [];

  const parentSegments = segments.slice(0, -1);
  const leafSegment = segments[segments.length - 1] || '';
  let candidateDirs: WorkspaceSearchEntry[] = [toWorkspaceSearchEntry('/workspace', true)];

  for (const segment of parentSegments) {
    const childLists = await Promise.all(
      candidateDirs.slice(0, INDEX_CONCURRENCY).map((dir) => listDirectoryEntries(sandboxUrl, dir.path)),
    );

    const matches = dedupeWorkspaceSearchEntries(
      childLists
        .flat()
        .filter((entry) => entry.isDir),
    );

    candidateDirs = filterSegmentEntries(matches, segment, { type: 'directory' }).slice(0, INDEX_CONCURRENCY);
    if (candidateDirs.length === 0) return [];
  }

  const leafLists = await Promise.all(
    candidateDirs.slice(0, INDEX_CONCURRENCY).map((dir) => listDirectoryEntries(sandboxUrl, toDirectoryPath(dir.path))),
  );

  const leafMatches = filterSegmentEntries(
    dedupeWorkspaceSearchEntries(leafLists.flat()),
    leafSegment,
    options,
  );

  return leafMatches
    .sort((left, right) => {
      const leftRank = rankWorkspaceSearchEntry(left, normalizedQuery);
      const rightRank = rankWorkspaceSearchEntry(right, normalizedQuery);
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.path.localeCompare(right.path);
    })
    .slice(0, options.limit ?? 50);
}

// ── Workspace index ──────────────────────────────────────────────────────

async function buildWorkspaceIndex(sandboxUrl: string): Promise<WorkspaceSearchEntry[]> {
  const queue = ['/workspace'];
  const seenDirs = new Set<string>(['/workspace']);
  const indexed = new Map<string, WorkspaceSearchEntry>();

  while (queue.length > 0 && indexed.size < INDEX_MAX_ENTRIES) {
    const batch = queue.splice(0, INDEX_CONCURRENCY);
    const listed = await Promise.all(batch.map((dir) => listDirectoryEntries(sandboxUrl, dir)));

    for (const entries of listed) {
      for (const entry of entries) {
        const key = `${entry.path}:${entry.isDir ? 'dir' : 'file'}`;
        if (!indexed.has(key)) indexed.set(key, entry);

        if (
          entry.isDir
          && !seenDirs.has(entry.path)
          && !INDEX_SKIP_DIR_NAMES.has(entry.name)
          && indexed.size < INDEX_MAX_ENTRIES
        ) {
          seenDirs.add(entry.path);
          queue.push(entry.path);
        }
      }
    }
  }

  return Array.from(indexed.values());
}

async function getWorkspaceIndexEntries(sandboxUrl: string): Promise<WorkspaceSearchEntry[]> {
  const current = getCacheForServer(sandboxUrl);
  const now = Date.now();

  if (current && current.entries.length > 0 && now - current.fetchedAt < INDEX_TTL_MS) {
    return current.entries;
  }

  if (current?.inFlight) {
    return current.inFlight;
  }

  const inFlight = buildWorkspaceIndex(sandboxUrl)
    .then((entries) => {
      setCacheForServer(sandboxUrl, {
        entries,
        fetchedAt: Date.now(),
      });
      return entries;
    })
    .catch(() => {
      const fallback = current?.entries ?? [];
      setCacheForServer(sandboxUrl, {
        entries: fallback,
        fetchedAt: current?.fetchedAt ?? 0,
      });
      return fallback;
    });

  setCacheForServer(sandboxUrl, {
    entries: current?.entries ?? [],
    fetchedAt: current?.fetchedAt ?? 0,
    inFlight,
  });

  return inFlight;
}

// ── Should we load the full index? ───────────────────────────────────────

function shouldLoadIndex(
  query: string,
  results: WorkspaceSearchEntry[],
  limit: number,
): boolean {
  if (workspaceQueryLooksPathLike(query)) {
    if (results.length === 0) return true;
    const bestRank = rankWorkspaceSearchEntry(results[0], query);
    return bestRank > 20 && results.length < Math.min(limit, 5);
  }
  return results.length < Math.min(limit, 10);
}

// ── Public API ───────────────────────────────────────────────────────────

export async function searchWorkspaceFileEntries(
  sandboxUrl: string,
  query: string,
  options?: WorkspaceSearchRuntimeOptions,
): Promise<WorkspaceSearchEntry[]> {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) return [];

  const resolvedOptions: WorkspaceSearchRuntimeOptions = {
    limit: options?.limit ?? 50,
    type: options?.type,
    apiLimit: options?.apiLimit,
  };

  const [backendEntries, traversedEntries] = await Promise.all([
    getBackendEntries(sandboxUrl, normalizedQuery, resolvedOptions),
    searchByPathTraversal(sandboxUrl, normalizedQuery, resolvedOptions),
  ]);

  let merged = mergeWorkspaceSearchEntries(
    backendEntries,
    traversedEntries,
    normalizedQuery,
    resolvedOptions,
  );

  if (!shouldLoadIndex(normalizedQuery, merged, resolvedOptions.limit ?? 50)) {
    return merged;
  }

  const indexEntries = await getWorkspaceIndexEntries(sandboxUrl);
  const indexedMatches = searchIndexedWorkspaceEntries(
    indexEntries,
    normalizedQuery,
    {
      limit: Math.max((resolvedOptions.limit ?? 50) * 4, 200),
      type: resolvedOptions.type,
    },
  );

  merged = mergeWorkspaceSearchEntries(
    merged,
    indexedMatches,
    normalizedQuery,
    resolvedOptions,
  );

  return merged;
}

export async function searchWorkspaceFilePaths(
  sandboxUrl: string,
  query: string,
  options?: WorkspaceSearchRuntimeOptions,
): Promise<string[]> {
  const entries = await searchWorkspaceFileEntries(sandboxUrl, query, options);
  return entries.map(toResultPath);
}
