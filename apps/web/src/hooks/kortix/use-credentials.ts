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
import { authenticatedFetch } from '@/lib/auth-token';
import { useServerStore } from '@/stores/server-store';

export interface CredentialItem {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  last_read_at: string | null;
}

export interface CredentialWithValue extends CredentialItem {
  value: string;
}

export interface CredentialEvent {
  id: string;
  project_id: string;
  credential_id: string | null;
  credential_name: string;
  actor_type: 'user' | 'agent' | 'system';
  actor_id: string | null;
  action: string;
  message: string | null;
  created_at: string;
}

async function kfetch<T>(serverUrl: string, apiPath: string, init?: RequestInit): Promise<T> {
  const url = `${serverUrl.replace(/\/+$/, '')}${apiPath}`;
  const res = await authenticatedFetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kortix API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export const credentialKeys = {
  list: (pid?: string) => ['kortix', 'credentials', pid ?? ''] as const,
  events: (pid: string, name: string) => ['kortix', 'credentials', pid, name, 'events'] as const,
};

// ── Queries ──────────────────────────────────────────────────────────────────

export function useCredentials(projectId?: string) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  return useQuery<CredentialItem[]>({
    queryKey: credentialKeys.list(projectId),
    queryFn: () =>
      kfetch<CredentialItem[]>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId!)}/credentials`),
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
    queryFn: () =>
      kfetch<CredentialEvent[]>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId!)}/credentials/${encodeURIComponent(name!)}/events`),
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
    mutationFn: ({ projectId, ...body }) =>
      kfetch<CredentialItem>(serverUrl, `/kortix/projects/${encodeURIComponent(projectId)}/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
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
    mutationFn: ({ projectId, name }) =>
      kfetch<CredentialWithValue>(
        serverUrl,
        `/kortix/projects/${encodeURIComponent(projectId)}/credentials/${encodeURIComponent(name)}`,
      ),
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
    mutationFn: ({ projectId, name }) =>
      kfetch<{ ok: boolean }>(
        serverUrl,
        `/kortix/projects/${encodeURIComponent(projectId)}/credentials/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: credentialKeys.list(vars.projectId) });
    },
  });
}
