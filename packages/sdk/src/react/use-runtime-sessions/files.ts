import { findFiles, listFiles } from '../../core/files/client';

let fileIndexCache: { files: string[]; fetchedAt: number } | undefined;

interface RuntimeFileSearchDependencies {
  findFiles: typeof findFiles;
  listFiles: typeof listFiles;
}

const defaultDependencies: RuntimeFileSearchDependencies = { findFiles, listFiles };

/** Harness-neutral file mention search over the Kortix daemon file API. */
export async function findRuntimeFiles(
  query: string,
  dependencies: RuntimeFileSearchDependencies = defaultDependencies,
): Promise<string[]> {
  const normalized = query.trim().toLowerCase();
  const rank = (filePath: string): number => {
    const lower = filePath.toLowerCase();
    const base = lower.split('/').pop() ?? lower;
    if (!normalized) return filePath.split('/').length;
    if (base === normalized) return 0;
    if (base.startsWith(normalized)) return 10;
    if (base.includes(normalized)) return 20;
    if (lower.includes(normalized)) return 30;
    return 1000;
  };

  let candidates = await dependencies.findFiles(query, { type: 'file', limit: 200 }).catch(() => []);
  if (candidates.length < 20) {
    const now = Date.now();
    if (!fileIndexCache || now - fileIndexCache.fetchedAt > 60_000) {
      const indexed = await dependencies.findFiles('', { type: 'file', limit: 2_000 }).catch(() => []);
      if (indexed.length) {
        fileIndexCache = { files: indexed, fetchedAt: now };
      } else {
        const root = await dependencies.listFiles('/workspace').catch(() => []);
        fileIndexCache = {
          files: root.filter((node) => node.type === 'file').map((node) => node.path),
          fetchedAt: now,
        };
      }
    }
    candidates = [...candidates, ...(fileIndexCache?.files ?? [])];
  }

  return Array.from(new Set(candidates))
    .filter((filePath) => !normalized || filePath.toLowerCase().includes(normalized))
    .sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))
    .slice(0, 20);
}
