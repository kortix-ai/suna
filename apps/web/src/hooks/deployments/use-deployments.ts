import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backendApi } from '@/lib/api-client';
import { shouldPollDeployments } from './deployment-status';

// ─── Types ──────────────────────────────────────────────────────────────────

export type DeploymentStatus = 'pending' | 'building' | 'deploying' | 'active' | 'failed' | 'stopped';
export type DeploymentSource = 'git' | 'code' | 'files' | 'tar';

export interface Deployment {
  deploymentId: string;
  accountId: string;
  sandboxId: string | null;
  freestyleId: string | null;
  status: DeploymentStatus;
  sourceType: DeploymentSource;
  sourceRef: string | null;
  framework: string | null;
  domains: string[] | null;
  liveUrl: string | null;
  envVars: Record<string, string> | null;
  buildConfig: Record<string, unknown> | null;
  entrypoint: string | null;
  error: string | null;
  version: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDeploymentData {
  source_type: DeploymentSource;
  domains: string[];

  // Git source
  source_ref?: string;
  branch?: string;
  root_path?: string;

  // Code source
  code?: string;

  // Files source
  files?: Array<{ path: string; content: string; encoding?: string }>;

  // Tar source
  tar_url?: string;

  // Config
  build?: boolean | { command?: string; outDir?: string; envVars?: Record<string, string> };
  env_vars?: Record<string, string>;
  node_modules?: Record<string, string>;
  entrypoint?: string;
  timeout_ms?: number;
  static_only?: boolean;
  public_dir?: string;
  clean_urls?: boolean;
  framework?: string;
}

// ─── API Response Types ─────────────────────────────────────────────────────

interface ApiListResponse {
  success: boolean;
  data: Deployment[];
  total: number;
  limit: number;
  offset: number;
}

interface ApiSingleResponse {
  success: boolean;
  data: Deployment;
}

interface ApiDeleteResponse {
  success: boolean;
  message: string;
}

interface ApiLogsResponse {
  success: boolean;
  data: {
    logs: Array<{
      timestamp?: string;
      message?: string;
      level?: string;
      [key: string]: unknown;
    }>;
    message?: string;
  };
}

// ─── API Functions ──────────────────────────────────────────────────────────

const fetchDeployments = async (
  status?: DeploymentStatus,
  limit = 50,
  offset = 0,
): Promise<{ deployments: Deployment[]; total: number }> => {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  const qs = params.toString() ? `?${params.toString()}` : '';
  const response = await backendApi.get<ApiListResponse>(`/deployments${qs}`);
  if (!response.success) {
    throw new Error(response.error?.message || 'Failed to fetch deployments');
  }
  return {
    deployments: response.data!.data,
    total: response.data!.total,
  };
};

const fetchDeployment = async (id: string): Promise<Deployment> => {
  const response = await backendApi.get<ApiSingleResponse>(`/deployments/${id}`);
  if (!response.success) {
    throw new Error(response.error?.message || 'Failed to fetch deployment');
  }
  return response.data!.data;
};

const createDeployment = async (data: CreateDeploymentData): Promise<Deployment> => {
  const response = await backendApi.post<ApiSingleResponse>('/deployments', data, {
    timeout: 330_000, // 5.5 min — builds (Go, Rust, etc.) can take a while
  });
  if (!response.success) {
    throw new Error(response.error?.message || 'Failed to create deployment');
  }
  return response.data!.data;
};

const stopDeployment = async (id: string): Promise<Deployment> => {
  const response = await backendApi.post<ApiSingleResponse>(`/deployments/${id}/stop`);
  if (!response.success) {
    throw new Error(response.error?.message || 'Failed to stop deployment');
  }
  return response.data!.data;
};

const redeployDeployment = async (id: string): Promise<Deployment> => {
  const response = await backendApi.post<ApiSingleResponse>(`/deployments/${id}/redeploy`, {}, {
    timeout: 330_000,
  });
  if (!response.success) {
    throw new Error(response.error?.message || 'Failed to redeploy');
  }
  return response.data!.data;
};

const deleteDeployment = async (id: string): Promise<void> => {
  const response = await backendApi.delete<ApiDeleteResponse>(`/deployments/${id}`);
  if (!response.success) {
    throw new Error(response.error?.message || 'Failed to delete deployment');
  }
};

const fetchDeploymentLogs = async (id: string): Promise<ApiLogsResponse['data']> => {
  const response = await backendApi.get<ApiLogsResponse>(`/deployments/${id}/logs`);
  if (!response.success) {
    throw new Error(response.error?.message || 'Failed to fetch deployment logs');
  }
  return response.data!.data;
};

// ─── Grouping ───────────────────────────────────────────────────────────────

export interface DeploymentGroup {
  /** Primary domain used as the group key, or deploymentId for ungrouped */
  domain: string;
  /** The most recent deployment in this group (highest version / latest createdAt) */
  latestDeployment: Deployment;
  /** All deployments in this group, sorted by version DESC then createdAt DESC */
  allVersions: Deployment[];
  /** Total number of versions */
  versionCount: number;
}

/**
 * Groups a flat list of deployments by their primary domain (domains[0]).
 * Deployments without a domain are treated as standalone groups keyed by deploymentId.
 * Within each group, deployments are sorted by version DESC, then createdAt DESC.
 * Groups themselves are sorted by the latest deployment's createdAt DESC.
 */
export function groupDeploymentsByDomain(deployments: Deployment[]): DeploymentGroup[] {
  const groupMap = new Map<string, Deployment[]>();

  for (const d of deployments) {
    const key = d.domains?.[0] || d.deploymentId;
    const existing = groupMap.get(key);
    if (existing) {
      existing.push(d);
    } else {
      groupMap.set(key, [d]);
    }
  }

  const groups: DeploymentGroup[] = [];

  for (const [domain, versions] of groupMap) {
    // Sort by version DESC, then createdAt DESC
    versions.sort((a, b) => {
      if (b.version !== a.version) return b.version - a.version;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    groups.push({
      domain,
      latestDeployment: versions[0],
      allVersions: versions,
      versionCount: versions.length,
    });
  }

  // Sort groups by latest deployment's createdAt DESC
  groups.sort(
    (a, b) =>
      new Date(b.latestDeployment.createdAt).getTime() -
      new Date(a.latestDeployment.createdAt).getTime(),
  );

  return groups;
}

// ─── Query Keys ─────────────────────────────────────────────────────────────

export const deploymentKeys = {
  all: ['deployments'] as const,
  list: (status?: DeploymentStatus) => ['deployments', 'list', status] as const,
  detail: (id: string) => ['deployments', 'detail', id] as const,
  logs: (id: string) => ['deployments', 'logs', id] as const,
};

// ─── Hooks ──────────────────────────────────────────────────────────────────

export const useDeployments = (status?: DeploymentStatus, limit = 50, offset = 0) => {
  return useQuery({
    queryKey: [...deploymentKeys.list(status), limit, offset],
    queryFn: () => fetchDeployments(status, limit, offset),
    staleTime: 30_000,
    // Only poll while a deployment is still in progress; stop once everything is
    // settled (a new deployment re-triggers a fetch via mutation invalidation or
    // window focus).
    refetchInterval: (query) =>
      shouldPollDeployments(query.state.data?.deployments) ? 15_000 : false,
    refetchOnWindowFocus: true,
  });
};

export const useDeployment = (id: string) => {
  return useQuery({
    queryKey: deploymentKeys.detail(id),
    queryFn: () => fetchDeployment(id),
    enabled: !!id,
    staleTime: 15_000,
  });
};

export const useCreateDeployment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createDeployment,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: deploymentKeys.all });
    },
  });
};

export const useStopDeployment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: stopDeployment,
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: deploymentKeys.all });
      queryClient.invalidateQueries({ queryKey: deploymentKeys.detail(updated.deploymentId) });
    },
  });
};

export const useRedeployDeployment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: redeployDeployment,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: deploymentKeys.all });
    },
  });
};

export const useDeleteDeployment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteDeployment,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: deploymentKeys.all });
    },
  });
};

export const useDeploymentLogs = (id: string, enabled = true, isActive = true) => {
  return useQuery({
    queryKey: deploymentKeys.logs(id),
    queryFn: () => fetchDeploymentLogs(id),
    enabled: !!id && enabled,
    staleTime: 10_000,
    // Fetch logs whenever the dialog is open, but only keep polling while the
    // deployment is still in progress — terminal deployments have final logs.
    refetchInterval: isActive ? 10_000 : false,
  });
};
