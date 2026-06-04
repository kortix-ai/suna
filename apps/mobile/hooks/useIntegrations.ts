/**
 * React Query hooks for Pipedream integrations API.
 * Follows the useComposio.ts pattern (supabase auth, API_URL).
 */

import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/api/supabase';
import { API_URL } from '@/api/config';
import { log } from '@/lib/logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IntegrationApp {
  slug: string;
  name: string;
  description?: string;
  imgSrc?: string;
  authType?: string;
  categories: string[];
}

export interface IntegrationConnection {
  integrationId: string;
  accountId: string;
  app: string;
  appName: string | null;
  label: string | null;
  providerName: string;
  providerAccountId: string;
  status: 'active' | 'revoked' | 'expired' | 'error';
  scopes: string[];
  metadata: Record<string, unknown>;
  connectedAt: string;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectTokenResult {
  token: string;
  expiresAt: string;
  connectUrl?: string;
}

export interface LinkedSandbox {
  sandboxId: string;
  name: string;
  status: string;
  grantedAt: string;
}

export interface AppSandboxLink {
  sandboxId: string;
  sandboxName: string;
  integrationId: string;
  label: string | null;
}

export interface IntegrationSandboxesResult {
  sandboxes: LinkedSandbox[];
  appSandboxLinks: AppSandboxLink[];
}

interface AppPageInfo {
  totalCount: number;
  count: number;
  endCursor?: string;
  hasMore: boolean;
}

interface AppsPage {
  apps: IntegrationApp[];
  pageInfo: AppPageInfo;
}

// ─── Query Keys ─────────────────────────────────────────────────────────────

export const integrationKeys = {
  all: ['integrations'] as const,
  apps: (query?: string) => [...integrationKeys.all, 'apps', query] as const,
  connections: () => [...integrationKeys.all, 'connections'] as const,
  sandboxes: (id: string) => [...integrationKeys.all, 'sandboxes', id] as const,
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

// ─── API Functions ──────────────────────────────────────────────────────────

async function fetchAppsPage(query?: string, cursor?: string): Promise<AppsPage> {
  const session = await getSession();
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();

  const res = await fetch(`${API_URL}/pipedream/apps${qs ? `?${qs}` : ''}`, {
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) throw new Error('Failed to fetch integration apps');
  return res.json();
}

async function fetchConnections(): Promise<IntegrationConnection[]> {
  const session = await getSession();
  const res = await fetch(`${API_URL}/pipedream/connections`, {
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) throw new Error('Failed to fetch connections');
  const data = await res.json();
  return data.connections ?? data;
}

async function createConnectToken(opts: { app?: string; successRedirectUri?: string; errorRedirectUri?: string }): Promise<ConnectTokenResult> {
  const session = await getSession();
  const body: Record<string, string> = {};
  if (opts.app) body.app = opts.app;
  if (opts.successRedirectUri) body.success_redirect_uri = opts.successRedirectUri;
  if (opts.errorRedirectUri) body.error_redirect_uri = opts.errorRedirectUri;
  const res = await fetch(`${API_URL}/pipedream/connect-token`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Failed to create connect token');
  return res.json();
}

export async function syncConnections(): Promise<{ connections: IntegrationConnection[]; synced: number }> {
  const session = await getSession();
  const res = await fetch(`${API_URL}/pipedream/connections/sync`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) throw new Error('Failed to sync connections');
  return res.json();
}

async function deleteConnection(integrationId: string): Promise<void> {
  const session = await getSession();
  const res = await fetch(`${API_URL}/pipedream/connections/${integrationId}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) throw new Error('Failed to disconnect integration');
}

async function saveConnection(data: {
  app: string;
  app_name?: string;
  provider_account_id: string;
  label?: string;
  sandbox_id?: string;
}): Promise<{ success: boolean; integration?: IntegrationConnection }> {
  const session = await getSession();
  const res = await fetch(`${API_URL}/pipedream/connections/save`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to save connection');
  return res.json();
}

async function renameIntegration({ integrationId, label }: { integrationId: string; label: string }): Promise<void> {
  const session = await getSession();
  const res = await fetch(`${API_URL}/pipedream/connections/${integrationId}/label`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new Error('Failed to rename integration');
}

async function fetchSandboxes(integrationId: string): Promise<IntegrationSandboxesResult> {
  const session = await getSession();
  const res = await fetch(`${API_URL}/pipedream/connections/${integrationId}/sandboxes`, {
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) throw new Error('Failed to fetch linked sandboxes');
  return res.json();
}

async function linkSandbox({ integrationId, sandboxId }: { integrationId: string; sandboxId: string }): Promise<void> {
  const session = await getSession();
  const url = `${API_URL}/pipedream/connections/${integrationId}/link`;
  console.log('[linkSandbox] POST', url, { sandbox_id: sandboxId });
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ sandbox_id: sandboxId }),
  });
  console.log('[linkSandbox] Response:', res.status, res.statusText);
  if (!res.ok) {
    const text = await res.text();
    console.error('[linkSandbox] Error body:', text);
    throw new Error(`Failed to link sandbox: ${res.status}`);
  }
}

async function unlinkSandbox({ integrationId, sandboxId }: { integrationId: string; sandboxId: string }): Promise<void> {
  const session = await getSession();
  const res = await fetch(`${API_URL}/pipedream/connections/${integrationId}/link/${sandboxId}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) throw new Error('Failed to unlink sandbox');
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

export function useIntegrationApps(query?: string) {
  return useInfiniteQuery({
    queryKey: integrationKeys.apps(query),
    queryFn: ({ pageParam }) => fetchAppsPage(query, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo?.hasMore ? lastPage.pageInfo.endCursor : undefined,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useIntegrationConnections(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: integrationKeys.connections(),
    queryFn: fetchConnections,
    staleTime: 60 * 1000,
    refetchInterval: 30 * 1000,
    retry: 1,
    enabled: options?.enabled !== false,
  });
}

export function useCreateConnectToken() {
  return useMutation({ mutationFn: createConnectToken });
}

export function useSaveConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveConnection,
    onSuccess: () => { qc.invalidateQueries({ queryKey: integrationKeys.connections() }); },
  });
}

export function useDisconnectIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteConnection,
    onSuccess: () => { qc.invalidateQueries({ queryKey: integrationKeys.connections() }); },
  });
}

export function useRenameIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: renameIntegration,
    onSuccess: () => { qc.invalidateQueries({ queryKey: integrationKeys.connections() }); },
  });
}

export function useIntegrationSandboxes(integrationId: string | null) {
  return useQuery({
    queryKey: integrationKeys.sandboxes(integrationId!),
    queryFn: () => fetchSandboxes(integrationId!),
    enabled: !!integrationId,
    staleTime: 30 * 1000,
  });
}

export function useLinkSandboxIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: linkSandbox,
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: integrationKeys.connections() });
      qc.invalidateQueries({ queryKey: integrationKeys.sandboxes(variables.integrationId) });
    },
  });
}

export function useUnlinkSandboxIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: unlinkSandbox,
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: integrationKeys.connections() });
      qc.invalidateQueries({ queryKey: integrationKeys.sandboxes(variables.integrationId) });
    },
  });
}
