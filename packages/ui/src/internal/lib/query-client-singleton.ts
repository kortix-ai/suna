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
/** `onEachQueryClient` subscribers. replica-local: one tab's app. */
const followers = new Set<(client: QueryClient) => void>();

export function registerQueryClient(client: QueryClient): void {
  if (sharedQueryClient === client) return;
  sharedQueryClient = client;
  for (const run of [...followers]) run(client);
}

export function getSharedQueryClient(): QueryClient | null {
  return sharedQueryClient;
}

/**
 * Run `run` with the shared client now (if one is registered), and again with
 * every DIFFERENT client registered later. Returns the unsubscribe.
 *
 * AuthProvider sits ABOVE ReactQueryProvider, and #10344 mounts the app shell
 * one auth round trip sooner, so a caller can ask before any client exists.
 * `ReactQueryProvider` registers during render, and React can discard that
 * render (a hydration retry, a suspension, Strict Mode) and commit a second
 * client: a caller that ran once would hold a client the app no longer reads.
 */
export function onEachQueryClient(run: (client: QueryClient) => void): () => void {
  followers.add(run);
  if (sharedQueryClient) run(sharedQueryClient);
  return () => {
    followers.delete(run);
  };
}
