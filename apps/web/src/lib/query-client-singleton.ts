import type { QueryClient } from '@tanstack/react-query';

/**
 * Module-level handle on the app's single QueryClient.
 *
 * AuthProvider is mounted ABOVE ReactQueryProvider in the tree, so it can't
 * reach the client via `useQueryClient()`. Auth-driven cache resets (logout,
 * cross-account sign-in) need to wipe the React Query cache from there, so we
 * register the instance here when the provider creates it and read it back
 * from the central reset helper.
 */
let sharedQueryClient: QueryClient | null = null;

export function registerQueryClient(client: QueryClient): void {
  sharedQueryClient = client;
}

export function getSharedQueryClient(): QueryClient | null {
  return sharedQueryClient;
}
