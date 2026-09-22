/**
 * Sandbox & instance hooks for Kortix Computer Mobile.
 *
 * The session half of this file is gone. Listing sessions, reading one, its
 * messages and statuses, creating / deleting / archiving / renaming it, sending
 * a prompt and aborting a turn were all keyed on a sandbox url and spoke to the
 * OpenCode daemon directly. A session is addressed as (projectId, sessionId)
 * now and `useSession` from `@kortix/sdk/react` owns all of it — which is what
 * lets a session that is not running still show its transcript.
 *
 * What remains is genuinely about the BOX: provisioning one, listing them, and
 * the instance controls in Settings.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { log } from '@/lib/logger';
import { getAuthToken } from '@/api/config';
import {
  ensureSandbox,
  getActiveSandbox,
  getSandboxUrl,
  listSandboxes,
  restartSandbox,
  stopSandbox,
  deleteSandbox,
  getProviders,
  type SandboxInfo,
} from './client';

// ─── Query Keys ──────────────────────────────────────────────────────────────

export const platformKeys = {
  all: ['platform'] as const,
  sandbox: () => [...platformKeys.all, 'sandbox'] as const,
  instances: () => [...platformKeys.all, 'instances'] as const,
  providers: () => [...platformKeys.all, 'providers'] as const,
};

// ─── Helper: Authenticated fetch to OpenCode server ──────────────────────────

async function opencodeFetch<T>(sandboxUrl: string, path: string, options?: RequestInit): Promise<T> {
  const token = await getAuthToken();

  const res = await fetch(`${sandboxUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers as Record<string, string>),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenCode ${path} failed: ${res.status} - ${body}`);
  }

  return res.json();
}

// ─── Sandbox Hook ────────────────────────────────────────────────────────────

/**
 * Ensures user has a sandbox. Returns sandbox info + derived OpenCode URL.
 * This is the first thing that should run after auth.
 */
export function useSandbox(enabled: boolean = true) {
  return useQuery({
    queryKey: platformKeys.sandbox(),
    queryFn: async () => {
      log.log('📦 [useSandbox] Checking sandbox...');

      // First try to get existing active sandbox
      let sandbox = await getActiveSandbox();

      // If no active sandbox, listSandboxes() retrieves all known sandboxes
      // from the platform API. We reuse ANY sandbox the list returns (active /
      // provisioning / stopped) so a cold app open never accidentally routes
      // through POST /platform/init just because the DB row momentarily says
      // 'stopped' — calling /init would trigger tryReactivateStaleSandbox →
      // provider.start(), which can surface to users as a spurious "restart on
      // every open".
      if (!sandbox) {
        log.log('📦 [useSandbox] No active sandbox, listing all sandboxes...');
        const allSandboxes = await listSandboxes();
        // Prefer active → provisioning → stopped → error.
        const priority = { active: 0, provisioning: 1, stopped: 2, error: 3 } as Record<string, number>;
        const best = [...allSandboxes].sort(
          (a, b) => (priority[a.status] ?? 99) - (priority[b.status] ?? 99),
        )[0];

        if (best) {
          log.log(`📦 [useSandbox] Reusing existing sandbox: ${best.external_id} (status=${best.status})`);
          return {
            sandbox: best,
            sandboxUrl: getSandboxUrl(best.external_id),
            sandboxId: best.external_id,
          };
        }

        // No sandbox at all anywhere — provision one.
        log.log('📦 [useSandbox] No sandbox found, provisioning...');
        const result = await ensureSandbox();
        sandbox = result.sandbox;
      }

      const sandboxUrl = getSandboxUrl(sandbox.external_id);
      log.log('✅ [useSandbox] Sandbox ready:', sandbox.external_id, '→', sandboxUrl);

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

export function useInstances(enabled: boolean = true) {
  return useQuery({
    queryKey: platformKeys.instances(),
    queryFn: () => listSandboxes(),
    enabled,
    staleTime: 30 * 1000,
  });
}

export function useRestartInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: restartSandbox,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformKeys.instances() });
      queryClient.invalidateQueries({ queryKey: platformKeys.sandbox() });
    },
  });
}

export function useStopInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: stopSandbox,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformKeys.instances() });
    },
  });
}

export function useDeleteInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteSandbox,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformKeys.instances() });
      queryClient.invalidateQueries({ queryKey: platformKeys.sandbox() });
    },
  });
}

export function useProviders() {
  return useQuery({
    queryKey: platformKeys.providers(),
    queryFn: getProviders,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateCloudInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: SandboxInfo['provider']) => ensureSandbox({ provider }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformKeys.instances() });
      queryClient.invalidateQueries({ queryKey: platformKeys.sandbox() });
    },
  });
}
