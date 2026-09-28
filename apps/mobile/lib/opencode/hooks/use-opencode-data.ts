/**
 * Data hooks for fetching agents, providers, and models from the OpenCode server.
 *
 * Mirrors the frontend's use-opencode-sessions.ts agent/provider fetching.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { PickerProviderListInput, projectConfigAgentsToOpenCodeAgents } from '@kortix/sdk';
import { getAuthToken } from '@/api/config';
import { log } from '@/lib/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

/** OpenCode's agent, the shape `@kortix/sdk` builds the composer roster in. */
export type Agent = ReturnType<typeof projectConfigAgentsToOpenCodeAgents>[number];
/** A picker model, as the SDK's `flattenModels` returns it. */
export type { FlatModel } from '@kortix/sdk';
/** OpenCode's `/provider` answer, the runtime input of `pickerProviderList`. */
export type ProviderListResponse = NonNullable<PickerProviderListInput['runtimeProviders']>;

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
  providers: (url: string) => ['opencode', 'providers', url] as const,
  config: (url: string) => ['opencode', 'config', url] as const,
  commands: (url: string) => ['opencode', 'commands', url] as const,
  skills: (url: string) => ['opencode', 'skills', url] as const,
  projects: (url: string) => ['opencode', 'projects', url] as const,
  toolIds: (url: string) => ['opencode', 'toolIds', url] as const,
  mcpStatus: (url: string) => ['opencode', 'mcpStatus', url] as const,
};

// ─── Hooks ───────────────────────────────────────────────────────────────────

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
