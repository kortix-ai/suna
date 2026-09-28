/**
 * Data hooks for fetching agents, providers, and models from the OpenCode server.
 *
 * Mirrors the frontend's use-opencode-sessions.ts agent/provider fetching.
 */

import { useQuery } from '@tanstack/react-query';
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
  /**
   * The upstream provider that serves a gateway (`kortix`) model, e.g.
   * 'anthropic' or 'codex'. The model sheet groups by it. Stamped from the
   * project catalog (`lib/session/model-picker.ts`).
   */
  provider?: string;
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

export const opencodeKeys = {
  agents: (url: string) => ['opencode', 'agents', url] as const,
  providers: (url: string) => ['opencode', 'providers', url] as const,
  config: (url: string) => ['opencode', 'config', url] as const,
  commands: (url: string) => ['opencode', 'commands', url] as const,
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

/**
 * Returns flattened models from connected providers, filtered to "latest" only.
 * This matches the frontend's default visibility behavior.
 *
 * `allModels` is the unfiltered list (for model resolution fallback).
 * `data` is the filtered list (for display in the selector).
 */
export function useOpenCodeModels(sandboxUrl: string | undefined) {
  const { data: providers, ...rest } = useOpenCodeProviders(sandboxUrl);
  const allModels = providers ? flattenModels(providers) : [];
  const models = filterToLatestModels(allModels);
  const defaults = providers?.default || {};
  return { data: models, allModels, defaults, providers, ...rest };
}
