/**
 * Platform hooks for Kortix Computer Mobile: the instance list. A session's
 * runtime (transcript, sessions, replies) comes from `@kortix/sdk/react`, and
 * an open session switches its own sandbox in (`SandboxContext`).
 */

import { useQuery } from '@tanstack/react-query';
import { listSandboxes } from './client';

// ─── Query Keys ──────────────────────────────────────────────────────────────

export const platformKeys = {
  all: ['platform'] as const,
  instances: () => [...platformKeys.all, 'instances'] as const,
};

// ─── Instance Management Hooks ──────────────────────────────────────────────

/**
 * Settings → Instances: every project's first sessions page, read when the
 * screen opens. ponytail: one request per project; an account-level session
 * list replaces it when that screen gets an entry point again.
 */
export function useInstances(enabled: boolean = true) {
  return useQuery({
    queryKey: platformKeys.instances(),
    queryFn: () => listSandboxes(),
    enabled,
    staleTime: 30 * 1000,
  });
}
