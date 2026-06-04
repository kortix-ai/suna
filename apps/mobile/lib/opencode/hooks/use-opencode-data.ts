/**
 * Data hooks for fetching agents, providers, and models from the OpenCode server.
 *
 * Mirrors the frontend's use-opencode-sessions.ts agent/provider fetching.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getAuthToken } from '@/api/config';
import { log } from '@/lib/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Agent {
  name: string;
  description?: string;
  mode: 'subagent' | 'primary' | 'all';
  native?: boolean;
  hidden?: boolean;
  model?: { modelID: string; providerID: string };
  variant?: string;
  prompt?: string;
  color?: string;
  steps?: number;
  options: Record<string, unknown>;
}

export interface ModelInfo {
  id: string;
  name: string;
  family?: string;
  release_date?: string;
  attachment: boolean;
  reasoning: boolean;
  temperature: boolean;
  tool_call: boolean;
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
  limit: { context: number; input?: number; output: number };
  variants?: Record<string, Record<string, unknown>>;
  experimental?: boolean;
  status?: 'alpha' | 'beta' | 'deprecated';
}

export interface ProviderInfo {
  id: string;
  name: string;
  models: Record<string, ModelInfo>;
}

export interface ProviderListResponse {
  all: ProviderInfo[];
  default: Record<string, string>;
  connected: string[];
}

export interface FlatModel {
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  variants?: Record<string, Record<string, unknown>>;
  reasoning: boolean;
  contextWindow?: number;
  family?: string;
  releaseDate?: string;
  cost?: { input: number; output: number };
}

export interface OpenCodeConfig {
  model?: string; // "provider/modelId"
  agent?: string;
  [key: string]: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export async function opencodeFetch<T>(sandboxUrl: string, path: string, init?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const res = await fetch(`${sandboxUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenCode ${path}: ${res.status} ${body}`);
  }
  return res.json();
}

export function flattenModels(providers: ProviderListResponse): FlatModel[] {
  const models: FlatModel[] = [];
  const connectedSet = new Set(providers.connected);

  for (const provider of providers.all) {
    if (!connectedSet.has(provider.id)) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      models.push({
        providerID: provider.id,
        providerName: provider.name,
        modelID: modelId,
        modelName: model.name,
        variants: model.variants,
        reasoning: model.reasoning,
        contextWindow: model.limit?.context,
        family: model.family,
        releaseDate: model.release_date,
        cost: model.cost ? { input: model.cost.input, output: model.cost.output } : undefined,
      });
    }
  }

  return models;
}

/**
 * Compute the "latest" set — only the newest model per family per provider
 * released within the last 6 months. Matches the frontend's computeLatestSet.
 */
function computeLatestSet(models: FlatModel[]): Set<string> {
  const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const latest = new Set<string>();

  // Filter to models with a recent release date
  const recent = models.filter((m) => {
    if (!m.releaseDate) return false;
    try {
      const d = new Date(m.releaseDate).getTime();
      if (isNaN(d)) return false;
      return now - d < SIX_MONTHS_MS;
    } catch {
      return false;
    }
  });

  // Group by provider → family
  const grouped: Record<string, FlatModel[]> = {};
  for (const m of recent) {
    const key = `${m.providerID}:${m.family || m.modelID}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(m);
  }

  // Pick newest per family
  for (const group of Object.values(grouped)) {
    group.sort((a, b) => {
      const da = new Date(a.releaseDate!).getTime();
      const db = new Date(b.releaseDate!).getTime();
      return db - da; // newest first
    });
    const newest = group[0];
    latest.add(`${newest.providerID}:${newest.modelID}`);
  }

  return latest;
}

/**
 * Filter models to only show "latest" ones (matching frontend behavior).
 * Models without a release date are always shown.
 * The newest model per family per provider (within 6 months) is shown.
 * Everything else is hidden by default.
 */
export function filterToLatestModels(models: FlatModel[]): FlatModel[] {
  const latestSet = computeLatestSet(models);

  return models.filter((m) => {
    const key = `${m.providerID}:${m.modelID}`;

    // In the latest set → show
    if (latestSet.has(key)) return true;

    // No release date or unparseable → show (benefit of the doubt)
    if (!m.releaseDate) return true;
    try {
      const d = new Date(m.releaseDate);
      if (isNaN(d.getTime())) return true;
    } catch {
      return true;
    }

    // Has valid release date but not in latest → hide
    return false;
  });
}

// ─── Query Keys ──────────────────────────────────────────────────────────────

export interface Command {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  source?: 'command' | 'mcp' | 'skill';
  template: string;
  subtask?: boolean;
  hints: string[];
}

export interface Skill {
  name: string;
  description?: string;
  location: string;
  content?: string;
  hidden?: boolean;
}

export interface Project {
  id: string;
  name?: string;
  worktree: string;
  vcs?: string;
  time?: { created?: number; updated?: number };
}

export interface McpStatus {
  status: 'connected' | 'failed' | 'needs_auth' | 'needs_client_registration' | 'disconnected' | 'disabled' | 'pending';
  tools?: string[];
  error?: string;
}

export const opencodeKeys = {
  agents: (url: string) => ['opencode', 'agents', url] as const,
  providers: (url: string) => ['opencode', 'providers', url] as const,
  config: (url: string) => ['opencode', 'config', url] as const,
  commands: (url: string) => ['opencode', 'commands', url] as const,
  skills: (url: string) => ['opencode', 'skills', url] as const,
  projects: (url: string) => ['opencode', 'projects', url] as const,
  toolIds: (url: string) => ['opencode', 'toolIds', url] as const,
  mcpStatus: (url: string) => ['opencode', 'mcpStatus', url] as const,
};

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useOpenCodeAgents(sandboxUrl: string | undefined) {
  return useQuery({
    queryKey: opencodeKeys.agents(sandboxUrl || ''),
    queryFn: async () => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      const agents = await opencodeFetch<Agent[]>(sandboxUrl, '/agent');
      return agents.filter((a) => !a.hidden);
    },
    enabled: !!sandboxUrl,
    staleTime: 60 * 1000,
  });
}

export function useOpenCodeProviders(sandboxUrl: string | undefined) {
  return useQuery({
    queryKey: opencodeKeys.providers(sandboxUrl || ''),
    queryFn: async () => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      return opencodeFetch<ProviderListResponse>(sandboxUrl, '/provider');
    },
    enabled: !!sandboxUrl,
    staleTime: 60 * 1000,
  });
}

export function useOpenCodeConfig(sandboxUrl: string | undefined) {
  return useQuery({
    queryKey: opencodeKeys.config(sandboxUrl || ''),
    queryFn: async () => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      // Use /global/config so provider/config changes persist across
      // sandbox dispose. Matches web aa7ed87.
      return opencodeFetch<OpenCodeConfig>(sandboxUrl, '/global/config');
    },
    enabled: !!sandboxUrl,
    staleTime: 60 * 1000,
  });
}

/**
 * Returns flattened models from connected providers, filtered to "latest" only.
 * This matches the frontend's default visibility behavior.
 *
 * `allModels` is the unfiltered list (for model resolution fallback).
 * `data` is the filtered list (for display in the selector).
 */
export function useOpenCodeCommands(sandboxUrl: string | undefined) {
  return useQuery({
    queryKey: opencodeKeys.commands(sandboxUrl || ''),
    queryFn: async () => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      return opencodeFetch<Command[]>(sandboxUrl, '/command');
    },
    enabled: !!sandboxUrl,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

export function useOpenCodeSkills(sandboxUrl: string | undefined) {
  return useQuery({
    queryKey: opencodeKeys.skills(sandboxUrl || ''),
    queryFn: async () => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      const skills = await opencodeFetch<Skill[]>(sandboxUrl, '/skill');
      return skills.filter((s) => !s.hidden);
    },
    enabled: !!sandboxUrl,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

export function useOpenCodeProjects(sandboxUrl: string | undefined) {
  return useQuery({
    queryKey: opencodeKeys.projects(sandboxUrl || ''),
    queryFn: async () => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      return opencodeFetch<Project[]>(sandboxUrl, '/project');
    },
    enabled: !!sandboxUrl,
    staleTime: 60 * 1000,
  });
}

export function useOpenCodeToolIds(sandboxUrl: string | undefined) {
  return useQuery({
    queryKey: opencodeKeys.toolIds(sandboxUrl || ''),
    queryFn: async () => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      return opencodeFetch<string[]>(sandboxUrl, '/experimental/tool/ids');
    },
    enabled: !!sandboxUrl,
    staleTime: 60 * 1000,
  });
}

export function useOpenCodeMcpStatus(sandboxUrl: string | undefined) {
  return useQuery({
    queryKey: opencodeKeys.mcpStatus(sandboxUrl || ''),
    queryFn: async () => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      return opencodeFetch<Record<string, McpStatus>>(sandboxUrl, '/mcp');
    },
    enabled: !!sandboxUrl,
    staleTime: 60 * 1000,
  });
}

export function useOpenCodeModels(sandboxUrl: string | undefined) {
  const { data: providers, ...rest } = useOpenCodeProviders(sandboxUrl);
  const allModels = providers ? flattenModels(providers) : [];
  const models = filterToLatestModels(allModels);
  const defaults = providers?.default || {};
  return { data: models, allModels, defaults, providers, ...rest };
}

// ─── Config Mutation ────────────────────────────────────────────────────────

export function useUpdateOpenCodeConfig(sandboxUrl: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (config: Partial<OpenCodeConfig>) => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      // Write to /global/config so it survives sandbox dispose.
      // Matches web aa7ed87.
      return opencodeFetch<OpenCodeConfig>(sandboxUrl, '/global/config', {
        method: 'PATCH',
        body: JSON.stringify({ config }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: opencodeKeys.config(sandboxUrl || '') });
    },
  });
}

// ─── MCP Mutations ──────────────────────────────────────────────────────────

export interface AddMcpServerParams {
  name: string;
  type: 'local' | 'remote';
  command?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export function useAddMcpServer(sandboxUrl: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: AddMcpServerParams) => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      const config: Record<string, unknown> = { type: params.type };
      if (params.type === 'local') {
        config.command = params.command;
        if (params.env && Object.keys(params.env).length > 0) config.environment = params.env;
      } else {
        config.url = params.url;
        if (params.headers && Object.keys(params.headers).length > 0) config.headers = params.headers;
      }
      return opencodeFetch<Record<string, McpStatus>>(sandboxUrl, '/mcp', {
        method: 'POST',
        body: JSON.stringify({ name: params.name, config }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: opencodeKeys.mcpStatus(sandboxUrl || '') });
    },
  });
}

export function useConnectMcpServer(sandboxUrl: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      return opencodeFetch(sandboxUrl, `/mcp/${encodeURIComponent(name)}/connect`, { method: 'POST' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: opencodeKeys.mcpStatus(sandboxUrl || '') });
    },
  });
}

export function useDisconnectMcpServer(sandboxUrl: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      return opencodeFetch(sandboxUrl, `/mcp/${encodeURIComponent(name)}/disconnect`, { method: 'POST' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: opencodeKeys.mcpStatus(sandboxUrl || '') });
    },
  });
}

export function useMcpAuthStart(sandboxUrl: string | undefined) {
  return useMutation({
    mutationFn: async (name: string) => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      return opencodeFetch<{ authorizationUrl: string }>(sandboxUrl, `/mcp/${encodeURIComponent(name)}/auth`, { method: 'POST' });
    },
  });
}

export function useMcpAuthCallback(sandboxUrl: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { name: string; code: string }) => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      return opencodeFetch<McpStatus>(sandboxUrl, `/mcp/${encodeURIComponent(params.name)}/auth/callback`, {
        method: 'POST',
        body: JSON.stringify({ code: params.code }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: opencodeKeys.mcpStatus(sandboxUrl || '') });
    },
  });
}
