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
let waiters: Array<(client: QueryClient) => void> = [];

export function registerQueryClient(client: QueryClient): void {
  sharedQueryClient = client;
  // AuthProvider sits ABOVE ReactQueryProvider, and #10344 mounts the app
  // shell one auth round trip sooner, so `adoptDeviceCaches` can run before
  // this registers. Flush anyone who asked for the client before it existed.
  const pending = waiters;
  waiters = [];
  for (const run of pending) run(client);
}

export function getSharedQueryClient(): QueryClient | null {
  return sharedQueryClient;
}

/**
 * Run `run` with the shared client — now if it is registered, else as soon as
 * it registers. A one-shot: it fires once and is forgotten.
 */
export function whenQueryClientReady(run: (client: QueryClient) => void): void {
  if (sharedQueryClient) run(sharedQueryClient);
  else waiters.push(run);
}
