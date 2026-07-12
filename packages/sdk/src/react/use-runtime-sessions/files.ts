import { getClient } from '../../core/runtime/client';
import { unwrap } from './shared';

// ============================================================================
// File Search (direct SDK call, not a hook)
// ============================================================================

let mentionFileIndexCache:
  | {
      files: string[];
      fetchedAt: number;
    }
  | undefined;

let mentionDirScanCache:
  | {
      files: string[];
      fetchedAt: number;
    }
  | undefined;

export async function findRuntimeFiles(query: string): Promise<string[]> {
  const client = getClient();
  const normalizedQuery = query.trim();
  const ql = normalizedQuery.toLowerCase();

  const rankFile = (path: string): number => {
    const lower = path.toLowerCase();
    const base = lower.split('/').pop() ?? lower;
    const depth = path.split('/').length - 1;
    if (ql.length === 0) return depth;
    if (base === ql) return 0 + depth * 0.01;
    if (base.startsWith(ql)) return 10 + depth * 0.01;
    if (base.includes(ql)) return 20 + depth * 0.01;
    if (lower.startsWith(ql)) return 30 + depth * 0.01;
    if (lower.includes(ql)) return 40 + depth * 0.01;
    return 1000 + depth;
  };

  const fileMatchesQuery = (path: string): boolean => {
    if (ql.length === 0) return true;
    const lower = path.toLowerCase();
    if (lower.includes(ql)) return true;
    const base = lower.split('/').pop() ?? lower;
    return base.includes(ql);
  };

  const readEntries = async (request: Promise<{ data?: unknown; error?: unknown }>): Promise<string[]> => {
    try {
      const result = await request;
      const entries = unwrap(result);
      if (!Array.isArray(entries)) return [];
      const normalized: string[] = [];
      for (const entry of entries) {
        if (typeof entry === 'string' && entry.length > 0) {
          normalized.push(entry);
          continue;
        }

        if (entry && typeof entry === 'object') {
          const maybePath = (entry as { path?: unknown }).path;
          const maybeType = (entry as { type?: unknown }).type;
          if (typeof maybePath === 'string' && maybePath.length > 0) {
            if (maybeType === 'directory' && !maybePath.endsWith('/')) {
              normalized.push(`${maybePath}/`);
            } else {
              normalized.push(maybePath);
            }
          }
        }
      }
      return normalized;
    } catch {
      return [];
    }
  };

  const [strictFiles, broadResults] = await Promise.all([
    readEntries(client.find.files({ query: normalizedQuery, type: 'file', limit: 80 })),
    readEntries(client.find.files({ query: normalizedQuery, limit: 80 })),
  ]);

  const fileMatches = new Set<string>();
  const directoryMatches: string[] = [];

  for (const entry of [...strictFiles, ...broadResults]) {
    if (entry.endsWith('/')) {
      directoryMatches.push(entry);
      continue;
    }
    fileMatches.add(entry);
  }

  if (fileMatches.size < 20 && normalizedQuery.length > 0 && directoryMatches.length > 0) {
    const expandedDirs = directoryMatches.slice(0, 6);
    const dirChildren = await Promise.all(
      expandedDirs.map(async (dir) => {
        const path = dir.endsWith('/') ? dir.slice(0, -1) : dir;
        const children = await readEntries(client.file.list({ path }));
        return children
          .filter((child) => !child.endsWith('/'))
          .filter((child) => fileMatchesQuery(child));
      }),
    );

    for (const group of dirChildren) {
      for (const child of group) {
        fileMatches.add(child);
      }
    }
  }

  // Explicit root scan fallback for @mentions.
  // Some backends under-return root-level files via find.files(query).
  if (normalizedQuery.length > 0 && fileMatches.size < 20) {
    const [rootWorkspace, rootEmpty] = await Promise.all([
      readEntries(client.file.list({ path: '/workspace' })),
      readEntries(client.file.list({ path: '' })),
    ]);
    for (const entry of [...rootWorkspace, ...rootEmpty]) {
      if (entry.endsWith('/')) continue;
      if (fileMatchesQuery(entry)) fileMatches.add(entry);
    }
  }

  // Directory scan fallback for @mentions.
  // Builds a lightweight index from root + first-level directories (e.g.
  // /workspace/Desktop, /workspace/test) to catch substring matches that
  // find.files(query) may miss.
  if (normalizedQuery.length > 0 && fileMatches.size < 20) {
    const now = Date.now();
    const cacheFresh = mentionDirScanCache && now - mentionDirScanCache.fetchedAt < 60_000;

    if (!cacheFresh) {
      const roots = await Promise.all([
        readEntries(client.file.list({ path: '/workspace' })),
        readEntries(client.file.list({ path: '' })),
      ]);
      const rootEntries = Array.from(new Set([...roots[0], ...roots[1]]));

      const fileSet = new Set<string>();
      const firstLevelDirs = rootEntries
        .filter((entry) => entry.endsWith('/'))
        .map((entry) => (entry.endsWith('/') ? entry.slice(0, -1) : entry))
        .slice(0, 80);

      for (const entry of rootEntries) {
        if (!entry.endsWith('/')) fileSet.add(entry);
      }

      const childLists = await Promise.all(
        firstLevelDirs.map((dir) => readEntries(client.file.list({ path: dir }))),
      );

      for (const children of childLists) {
        for (const child of children) {
          if (!child.endsWith('/')) fileSet.add(child);
        }
      }

      mentionDirScanCache = {
        files: Array.from(fileSet),
        fetchedAt: now,
      };
    }

    for (const path of mentionDirScanCache?.files ?? []) {
      if (fileMatchesQuery(path)) fileMatches.add(path);
    }
  }

  // Fallback index for @mentions: some backends return sparse results for
  // incremental filename fragments. Build/cached a broad file index and filter
  // client-side to keep mention search responsive and tolerant.
  if (normalizedQuery.length > 0 && fileMatches.size < 10) {
    const now = Date.now();
    const cacheFresh =
      mentionFileIndexCache && now - mentionFileIndexCache.fetchedAt < 60_000;
    if (!cacheFresh) {
      const [indexStrict, indexBroad] = await Promise.all([
        readEntries(client.find.files({ query: '', type: 'file', limit: 2000 })),
        readEntries(client.find.files({ query: '', limit: 2000 })),
      ]);
      const indexSet = new Set<string>();
      for (const entry of [...indexStrict, ...indexBroad]) {
        if (!entry.endsWith('/')) indexSet.add(entry);
      }
      mentionFileIndexCache = {
        files: Array.from(indexSet),
        fetchedAt: now,
      };
    }

    for (const path of mentionFileIndexCache?.files ?? []) {
      if (fileMatchesQuery(path)) fileMatches.add(path);
    }
  }

  return Array.from(fileMatches)
    .sort((a, b) => rankFile(a) - rankFile(b) || a.localeCompare(b))
    .slice(0, 20);
}
