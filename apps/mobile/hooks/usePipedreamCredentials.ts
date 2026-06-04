/**
 * React Query hooks for Pipedream credential management.
 * Mirrors web's use-pipedream-credentials.ts.
 *
 * 3-tier credential resolution: request headers > per-account DB > API env defaults.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/api/supabase';
import { API_URL } from '@/api/config';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PipedreamCredentialStatus {
  configured: boolean;
  source: 'account' | 'default';
  provider: string;
}

// ─── Keys ───────────────────────────────────────────────────────────────────

export const pipedreamCredentialKeys = {
  status: ['pipedream-credentials'] as const,
};

// ─── Auth Helper ────────────────────────────────────────────────────────────

async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');
  return session;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

export function usePipedreamCredentialStatus() {
  return useQuery({
    queryKey: pipedreamCredentialKeys.status,
    queryFn: async (): Promise<PipedreamCredentialStatus> => {
      const session = await getSession();
      const res = await fetch(`${API_URL}/pipedream/credentials`, {
        headers: authHeaders(session.access_token),
      });
      if (!res.ok) throw new Error('Failed to fetch credential status');
      return res.json();
    },
    staleTime: 30_000,
  });
}

export function useSavePipedreamCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (creds: {
      client_id: string;
      client_secret: string;
      project_id: string;
      environment?: string;
    }) => {
      const session = await getSession();
      const res = await fetch(`${API_URL}/pipedream/credentials`, {
        method: 'PUT',
        headers: authHeaders(session.access_token),
        body: JSON.stringify(creds),
      });
      if (!res.ok) throw new Error('Failed to save credentials');
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pipedreamCredentialKeys.status });
      qc.invalidateQueries({ queryKey: ['integration-apps'] });
      qc.invalidateQueries({ queryKey: ['integration-connections'] });
    },
  });
}

export function useDeletePipedreamCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const session = await getSession();
      const res = await fetch(`${API_URL}/pipedream/credentials`, {
        method: 'DELETE',
        headers: authHeaders(session.access_token),
      });
      if (!res.ok) throw new Error('Failed to delete credentials');
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pipedreamCredentialKeys.status });
      qc.invalidateQueries({ queryKey: ['integration-apps'] });
    },
  });
}
