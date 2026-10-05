/**
 * Platform hooks for Kortix Computer Mobile: the user's current
 * project-session sandbox, and the instance list. A session's runtime
 * (transcript, sessions, replies) comes from `@kortix/sdk/react`.
 */

import { useQuery } from '@tanstack/react-query';
import { log } from '@/lib/logger';
import { getActiveSandbox, getSandboxUrl, listSandboxes } from './client';

// ─── Query Keys ──────────────────────────────────────────────────────────────

export const platformKeys = {
  all: ['platform'] as const,
  sandbox: () => [...platformKeys.all, 'sandbox'] as const,
  instances: () => [...platformKeys.all, 'instances'] as const,
};

// ─── Sandbox Hook ────────────────────────────────────────────────────────────

/**
 * The user's most relevant existing project-session sandbox (active →
 * provisioning → stopped → error), or `null` when there is none.
 *
 * Read-only: it never creates a session. Opening the app used to call
 * `ensureSandbox()` when no session existed, which provisioned a runtime
 * nobody asked for, and on a stack whose session create fails (e.g. a
 * loopback `KORTIX_URL`) it raised the same error on every app open.
 * Sessions start from the project composer.
 */
export function useSandbox(enabled: boolean = true) {
  return useQuery({
    queryKey: platformKeys.sandbox(),
    queryFn: async () => {
      // One listing: `getActiveSandbox` already returns the best row of every
      // project's sessions, in the priority order above.
      const sandbox = await getActiveSandbox();
      if (!sandbox) {
        log.log('📦 [useSandbox] No project-session sandbox yet');
        return null;
      }

      const sandboxUrl = getSandboxUrl(sandbox.external_id);
      log.log(`📦 [useSandbox] Using sandbox ${sandbox.external_id} (status=${sandbox.status})`);

      return {
        sandbox,
        sandboxUrl,
        sandboxId: sandbox.external_id,
      };
    },
    enabled,
    staleTime: 5 * 60 * 1000, // Sandbox doesn't change often
    retry: 2,
  });
}

// ─── Instance Management Hooks ──────────────────────────────────────────────

export function useInstances(enabled: boolean = true) {
  return useQuery({
    queryKey: platformKeys.instances(),
    queryFn: () => listSandboxes(),
    enabled,
    staleTime: 30 * 1000,
  });
}
