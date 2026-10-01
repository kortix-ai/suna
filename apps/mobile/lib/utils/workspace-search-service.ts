/**
 * Workspace search service — combines backend API results with path traversal
 * and a cached workspace index for reliable deep-path resolution.
 *
 * Uses direct fetch via ocFetch instead of the web SDK transport.
 */

import { getAuthToken } from '@/api/config';
import { createWorkspaceSearchClient, type WorkspaceSearchFileClient, type WorkspaceSearchRuntimeOptions } from '@kortix/sdk/workspace-search';

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

const clients = new Map<string, ReturnType<typeof createWorkspaceSearchClient>>();

function clientFor(sandboxUrl: string) {
  let client = clients.get(sandboxUrl);
  if (!client) {
    const adapter: WorkspaceSearchFileClient = {
      findFiles: (query, options) => findFiles(sandboxUrl, query, options),
      listFiles: async (path) => {
        const data = await ocFetch<unknown>(sandboxUrl, `/file?path=${encodeURIComponent(path)}`);
        return normalizeApiEntries(data).map((entry) => ({
          path: entry.replace(/\/+$/, ''),
          type: entry.endsWith('/') ? 'directory' : 'file',
        }));
      },
    };
    client = createWorkspaceSearchClient(adapter);
    clients.set(sandboxUrl, client);
  }
  return client;
}

export function searchWorkspaceFileEntries(sandboxUrl: string, query: string, options?: WorkspaceSearchRuntimeOptions) {
  return clientFor(sandboxUrl).searchWorkspaceFileEntries(query, options);
}

export function searchWorkspaceFilePaths(sandboxUrl: string, query: string, options?: WorkspaceSearchRuntimeOptions) {
  return clientFor(sandboxUrl).searchWorkspaceFilePaths(query, options);
}
