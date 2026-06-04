/**
 * React Query hooks for API Keys management.
 * Mirrors the frontend's api-keys.ts against the backend /platform/api-keys endpoints.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_URL, getAuthToken } from '@/api/config';
import { useSandboxContext } from '@/contexts/SandboxContext';

// ─── Types ──────────────────────────────────────────────────────────────────

export type APIKeyType = 'user' | 'sandbox';
export type APIKeyStatus = 'active' | 'revoked' | 'expired';

export interface APIKeyResponse {
  key_id: string;
  public_key: string;
  sandbox_id: string;
  title: string;
  description?: string;
  type: APIKeyType;
  status: APIKeyStatus;
  expires_at?: string;
  last_used_at?: string;
  created_at: string;
}

export interface APIKeyCreateRequest {
  sandbox_id: string;
  title: string;
  description?: string;
  expires_in_days?: number;
}

export interface APIKeyCreateResponse {
  key_id: string;
  public_key: string;
  secret_key: string;
  sandbox_id: string;
  title: string;
  description?: string;
  type: APIKeyType;
  status: APIKeyStatus;
  expires_at?: string;
  created_at: string;
}

export interface APIKeyRegenerateResponse {
  key_id: string;
  public_key: string;
  secret_key: string;
  sandbox_id: string;
  title: string;
  type: APIKeyType;
  status: APIKeyStatus;
  created_at: string;
}

// ─── API Helpers ─────────────────────────────────────────────────────────────

async function authFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers as Record<string, string>),
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error?.message || body?.message || `Request failed (${res.status})`);
  }
  return body;
}

// ─── API Functions ───────────────────────────────────────────────────────────

async function listApiKeys(sandboxId: string): Promise<APIKeyResponse[]> {
  const envelope = await authFetch<{ success: boolean; data: APIKeyResponse[] }>(
    `/platform/api-keys?sandbox_id=${encodeURIComponent(sandboxId)}`,
  );
  return envelope.data || [];
}

async function createApiKey(data: APIKeyCreateRequest): Promise<APIKeyCreateResponse> {
  const envelope = await authFetch<{ success: boolean; data: APIKeyCreateResponse }>(
    '/platform/api-keys',
    { method: 'POST', body: JSON.stringify(data) },
  );
  return envelope.data;
}

async function revokeApiKey(keyId: string): Promise<void> {
  await authFetch(`/platform/api-keys/${keyId}/revoke`, { method: 'PATCH', body: JSON.stringify({}) });
}

async function deleteApiKey(keyId: string): Promise<void> {
  await authFetch(`/platform/api-keys/${keyId}`, { method: 'DELETE' });
}

async function regenerateApiKey(keyId: string): Promise<APIKeyRegenerateResponse> {
  const envelope = await authFetch<{ success: boolean; data: APIKeyRegenerateResponse }>(
    `/platform/api-keys/${keyId}/regenerate`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return envelope.data;
}

// ─── Query Keys ──────────────────────────────────────────────────────────────

export const apiKeyKeys = {
  all: ['api-keys'] as const,
  list: (sandboxId: string) => [...apiKeyKeys.all, sandboxId] as const,
};

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useApiKeys() {
  const { sandboxUuid } = useSandboxContext();
  return useQuery({
    queryKey: apiKeyKeys.list(sandboxUuid!),
    queryFn: () => listApiKeys(sandboxUuid!),
    enabled: !!sandboxUuid,
    staleTime: 60 * 1000,
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createApiKey,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: apiKeyKeys.all });
    },
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: revokeApiKey,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: apiKeyKeys.all });
    },
  });
}

export function useDeleteApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteApiKey,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: apiKeyKeys.all });
    },
  });
}

export function useRegenerateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: regenerateApiKey,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: apiKeyKeys.all });
    },
  });
}

// ─── Utilities ───────────────────────────────────────────────────────────────

export function isKeyExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
}

export function formatKeyDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
