import { resetIdentityState } from '@kortix/sdk/react';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Forget everything the previous host's identity left in this process.
 *
 * The TUI keeps one `QueryClient` for its whole life, and `App` remounting on a
 * new `key` tears down observers but not the cache. Project-scoped and
 * `['tui', …]` keys carry no user id, so without this the new host renders the
 * old host's sessions, boards and model picks. The SDK contract
 * (`resetIdentityState`) asks the host to clear React Query beside its own reset.
 * Never throws: a failed SDK reset must not block the sign-in.
 */
export function forgetHostIdentity(queryClient: QueryClient, reset: () => void = resetIdentityState): void {
  queryClient.clear();
  try {
    reset();
  } catch {
    // The query cache is already gone; the SDK reset logs its own failures.
  }
}
