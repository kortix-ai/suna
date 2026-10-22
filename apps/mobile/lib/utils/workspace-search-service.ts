/**
 * Workspace search service — combines backend API results with path traversal
 * and a cached workspace index for reliable deep-path resolution. One search
 * client per sandbox; the file reads are the `@kortix/sdk` file client's, each
 * naming its sandbox. A failed read counts as no entries.
 */

import { findFiles, listFiles } from '@kortix/sdk';
import { createWorkspaceSearchClient, type WorkspaceSearchFileClient, type WorkspaceSearchRuntimeOptions } from '@kortix/sdk/workspace-search';

const clients = new Map<string, ReturnType<typeof createWorkspaceSearchClient>>();

function clientFor(sandboxUrl: string) {
  let client = clients.get(sandboxUrl);
  if (!client) {
    const adapter: WorkspaceSearchFileClient = {
      findFiles: (query, options) => findFiles(query, options, sandboxUrl).catch(() => []),
      listFiles: (path) => listFiles(path, sandboxUrl).catch(() => []),
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
