/**
 * Data hooks for fetching agents, providers, and models from the OpenCode server.
 *
 * Mirrors the frontend's use-opencode-sessions.ts agent/provider fetching.
 */

import { useQuery } from '@tanstack/react-query';
import type { PickerProviderListInput, projectConfigAgentsToOpenCodeAgents } from '@kortix/sdk';
import { getAuthToken } from '@/api/config';
import { log } from '@/lib/logger';
import { featureNotSupportedError } from '@/lib/opencode/runtime-capabilities';

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
    throw featureNotSupportedError(res.status, body) ?? new Error(`OpenCode ${path}: ${res.status} ${body}`);
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

export const opencodeKeys = {
  providers: (url: string) => ['opencode', 'providers', url] as const,
  config: (url: string) => ['opencode', 'config', url] as const,
  commands: (url: string) => ['opencode', 'commands', url] as const,
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
