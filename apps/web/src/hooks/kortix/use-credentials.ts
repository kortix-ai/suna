'use client';

/**
 * Project-scoped credentials — list, reveal, upsert, delete.
 *
 * The list endpoint never returns values (by design). A separate
 * `useRevealCredential` mutation fetches the decrypted value on explicit
 * user action — this keeps the page render path clean and makes "reveal"
 * an auditable event.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import { useServerStore } from '@/stores/server-store';
import {
  listCredentials,
  listCredentialEvents,
  upsertCredential,
  revealCredential,
  deleteCredential,
} from '@kortix/sdk/opencode-client';
import type { CredentialItem, CredentialWithValue, CredentialEvent } from '@kortix/sdk/opencode-client';

// The request/response shapes live in the SDK now (`@kortix/sdk/opencode-client`);
// re-exported here for existing importers.
export type { CredentialItem, CredentialWithValue, CredentialEvent };

export const credentialKeys = {
  list: (pid?: string) => ['kortix', 'credentials', pid ?? ''] as const,
  events: (pid: string, name: string) => ['kortix', 'credentials', pid, name, 'events'] as const,
};

// ── Queries ──────────────────────────────────────────────────────────────────

export function useCredentials(projectId?: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<CredentialItem[]>({
    queryKey: credentialKeys.list(projectId),
    queryFn: () => listCredentials(serverUrl, projectId!),
    enabled: !!projectId,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useCredentialEvents(projectId?: string, name?: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<CredentialEvent[]>({
    queryKey: credentialKeys.events(projectId ?? '', name ?? ''),
    queryFn: () => listCredentialEvents(serverUrl, projectId!, name!),
    enabled: !!projectId && !!name,
    refetchInterval: 10_000,
  });
}

// ── Mutations ────────────────────────────────────────────────────────────────

export function useUpsertCredential() {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const qc = useQueryClient();
  return useMutation<CredentialItem, Error, {
    projectId: string;
    name: string;
    value: string;
    description?: string | null;
  }>({
    mutationFn: ({ projectId, ...body }) => upsertCredential(serverUrl, projectId, body),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: credentialKeys.list(vars.projectId) });
    },
  });
}

/** Reveal returns the decrypted value. Each call is audit-logged as a read. */
export function useRevealCredential() {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const qc = useQueryClient();
  return useMutation<CredentialWithValue, Error, { projectId: string; name: string }>({
    mutationFn: ({ projectId, name }) => revealCredential(serverUrl, projectId, name),
    onSuccess: (_res, vars) => {
      // Refresh list so last_read_at updates on the card
      qc.invalidateQueries({ queryKey: credentialKeys.list(vars.projectId) });
      qc.invalidateQueries({ queryKey: credentialKeys.events(vars.projectId, vars.name) });
    },
  });
}

export function useDeleteCredential() {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, { projectId: string; name: string }>({
    mutationFn: ({ projectId, name }) => deleteCredential(serverUrl, projectId, name),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: credentialKeys.list(vars.projectId) });
    },
  });
}
