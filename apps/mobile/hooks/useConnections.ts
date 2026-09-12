/**
 * React Query hooks for Pipedream connector API.
 * Follows the useComposio.ts pattern (supabase auth, API_URL).
 */

import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/api/supabase';
import { API_URL } from '@/api/config';
import { log } from '@/lib/logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConnectorApp {
  slug: string;
  name: string;
  description?: string;
  imgSrc?: string;
  authType?: string;
  categories: string[];
}

export interface ConnectorConnection {
  connectionId: string;
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
  connectionId: string;
  label: string | null;
}

export interface ConnectionSandboxesResult {
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
  apps: ConnectorApp[];
  pageInfo: AppPageInfo;
}

type ConnectionWire = Omit<ConnectorConnection, 'connectionId'> & { connectionId?: string };

function normalizeConnection(value: ConnectionWire): ConnectorConnection {
  const connectionId = value.connectionId;
  if (!connectionId) throw new Error('Connection response has no connection id');
  return { ...value, connectionId };
}

// ─── Query Keys ─────────────────────────────────────────────────────────────

export const connectionKeys = {
  all: ['connections'] as const,
  apps: (query?: string) => [...connectionKeys.all, 'apps', query] as const,
  connections: () => [...connectionKeys.all, 'connections'] as const,
  sandboxes: (id: string) => [...connectionKeys.all, 'sandboxes', id] as const,
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
  if (!res.ok) throw new Error('Failed to fetch connector apps');
  return res.json();
}

async function fetchConnections(): Promise<ConnectorConnection[]> {
  const session = await getSession();
  const res = await fetch(`${API_URL}/pipedream/connections`, {
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) throw new Error('Failed to fetch connections');
  const data = await res.json();
  return (data.connections ?? data).map(normalizeConnection);
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

export async function syncConnections(): Promise<{ connections: ConnectorConnection[]; synced: number }> {
  const session = await getSession();
  const res = await fetch(`${API_URL}/pipedream/connections/sync`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) throw new Error('Failed to sync connections');
  const result = await res.json();
  return {
    ...result,
    connections: (result.connections ?? []).map(normalizeConnection),
  };
}

async function deleteConnection(connectionId: string): Promise<void> {
  const session = await getSession();
  const res = await fetch(`${API_URL}/pipedream/connections/${connectionId}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) throw new Error('Failed to disconnect connection');
}

async function saveConnection(data: {
  app: string;
  app_name?: string;
  provider_account_id: string;
  label?: string;
  sandbox_id?: string;
}): Promise<{ success: boolean; connection?: ConnectorConnection }> {
  const session = await getSession();
  const res = await fetch(`${API_URL}/pipedream/connections/save`, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to save connection');
  const result = await res.json();
  const connection = result.connection;
  return {
    success: result.success,
    connection: connection ? normalizeConnection(connection) : undefined,
  };
}

async function renameConnection({ connectionId, label }: { connectionId: string; label: string }): Promise<void> {
  const session = await getSession();
  const res = await fetch(`${API_URL}/pipedream/connections/${connectionId}/label`, {
    method: 'PATCH',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new Error('Failed to rename connection');
}

async function fetchSandboxes(connectionId: string): Promise<ConnectionSandboxesResult> {
  const session = await getSession();
  const res = await fetch(`${API_URL}/pipedream/connections/${connectionId}/sandboxes`, {
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) throw new Error('Failed to fetch linked sandboxes');
  const result = await res.json();
  return {
    ...result,
    appSandboxLinks: result.appSandboxLinks ?? [],
  };
}

async function linkSandbox({ connectionId, sandboxId }: { connectionId: string; sandboxId: string }): Promise<void> {
  const session = await getSession();
  const url = `${API_URL}/pipedream/connections/${connectionId}/link`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(session.access_token),
    body: JSON.stringify({ sandbox_id: sandboxId }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('[linkSandbox] Error body:', text);
    throw new Error(`Failed to link sandbox: ${res.status}`);
  }
}

async function unlinkSandbox({ connectionId, sandboxId }: { connectionId: string; sandboxId: string }): Promise<void> {
  const session = await getSession();
  const res = await fetch(`${API_URL}/pipedream/connections/${connectionId}/link/${sandboxId}`, {
    method: 'DELETE',
    headers: authHeaders(session.access_token),
  });
  if (!res.ok) throw new Error('Failed to unlink sandbox');
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

export function useConnectorApps(query?: string) {
  return useInfiniteQuery({
    queryKey: connectionKeys.apps(query),
    queryFn: ({ pageParam }) => fetchAppsPage(query, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo?.hasMore ? lastPage.pageInfo.endCursor : undefined,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useConnectorConnections(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: connectionKeys.connections(),
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: connectionKeys.connections() }); },
  });
}

export function useDisconnectConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteConnection,
    onSuccess: () => { qc.invalidateQueries({ queryKey: connectionKeys.connections() }); },
  });
}

export function useRenameConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: renameConnection,
    onSuccess: () => { qc.invalidateQueries({ queryKey: connectionKeys.connections() }); },
  });
}

export function useConnectionSandboxes(connectionId: string | null) {
  return useQuery({
    queryKey: connectionKeys.sandboxes(connectionId!),
    queryFn: () => fetchSandboxes(connectionId!),
    enabled: !!connectionId,
    staleTime: 30 * 1000,
  });
}

export function useLinkSandboxConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: linkSandbox,
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: connectionKeys.connections() });
      qc.invalidateQueries({ queryKey: connectionKeys.sandboxes(variables.connectionId) });
    },
  });
}

export function useUnlinkSandboxConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: unlinkSandbox,
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: connectionKeys.connections() });
      qc.invalidateQueries({ queryKey: connectionKeys.sandboxes(variables.connectionId) });
    },
  });
}
