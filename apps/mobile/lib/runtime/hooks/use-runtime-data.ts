/**
 * Mobile compatibility shims over the ACP-first @kortix/sdk React surface.
 *
 * The sandbox URL parameter is intentionally ignored: hosts never address a
 * harness HTTP API. The SDK resolves the active project/session and owns all
 * Kortix REST + ACP transport.
 */

import { useMutation } from '@tanstack/react-query';
import {
  flattenModels as flattenSdkModels,
  useRuntimeAgents as useSdkRuntimeAgents,
  useRuntimeCommands as useSdkRuntimeCommands,
  useRuntimeConfig as useSdkRuntimeConfig,
  useRuntimeMcpStatus as useSdkRuntimeMcpStatus,
  useRuntimeProjects as useSdkRuntimeProjects,
  useRuntimeProviders as useSdkRuntimeProviders,
  useRuntimeSkills as useSdkRuntimeSkills,
  useRuntimeToolIds as useSdkRuntimeToolIds,
  useUpdateRuntimeConfig as useSdkUpdateRuntimeConfig,
  type Agent,
  type Command,
  type Config as RuntimeConfig,
  type FlatModel as SdkFlatModel,
  type McpStatus,
  type Project,
  type ProviderListResponse as SdkProviderListResponse,
  type Skill,
} from '@kortix/sdk/react';

export type {
  Agent,
  Command,
  RuntimeConfig,
  McpStatus,
  Project,
  Skill,
};

export type ProviderListResponse = SdkProviderListResponse;
export type ModelInfo = NonNullable<ProviderListResponse['all']>[number]['models'][string];
export type ProviderInfo = NonNullable<ProviderListResponse['all']>[number];
export interface FlatModel extends SdkFlatModel {
  reasoning: boolean;
}

export const runtimeKeys = {
  agents: (_url = '') => ['runtime', 'agents'] as const,
  providers: (_url = '') => ['runtime', 'providers'] as const,
  config: (_url = '') => ['runtime', 'config'] as const,
  commands: (_url = '') => ['runtime', 'commands'] as const,
  skills: (_url = '') => ['runtime', 'skills'] as const,
  projects: (_url = '') => ['runtime', 'projects'] as const,
  toolIds: (_url = '') => ['runtime', 'tool-ids'] as const,
  mcpStatus: (_url = '') => ['runtime', 'mcp-status'] as const,
};

export function flattenModels(providers: ProviderListResponse): FlatModel[] {
  return flattenSdkModels(providers).map((model) => ({
    ...model,
    reasoning: model.capabilities?.reasoning ?? false,
  }));
}

/** Keep mobile's compact newest-model view as a presentation projection. */
export function filterToLatestModels(models: FlatModel[]): FlatModel[] {
  const sixMonths = 6 * 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const newest = new Map<string, FlatModel>();
  for (const model of models) {
    if (!model.releaseDate) continue;
    const released = Date.parse(model.releaseDate);
    if (!Number.isFinite(released) || now - released >= sixMonths) continue;
    const key = `${model.providerID}:${model.family || model.modelID}`;
    const previous = newest.get(key);
    if (!previous || Date.parse(previous.releaseDate || '') < released) newest.set(key, model);
  }
  const newestIds = new Set([...newest.values()].map((model) => `${model.providerID}:${model.modelID}`));
  return models.filter((model) => {
    if (!model.releaseDate || !Number.isFinite(Date.parse(model.releaseDate))) return true;
    return newestIds.has(`${model.providerID}:${model.modelID}`);
  });
}

export function useRuntimeAgents(_sandboxUrl?: string) {
  return useSdkRuntimeAgents();
}

export function useRuntimeProviders(_sandboxUrl?: string) {
  return useSdkRuntimeProviders();
}

export function useRuntimeConfig(_sandboxUrl?: string) {
  return useSdkRuntimeConfig();
}

export function useRuntimeCommands(_sandboxUrl?: string) {
  return useSdkRuntimeCommands();
}

export function useRuntimeSkills(_sandboxUrl?: string) {
  return useSdkRuntimeSkills();
}

export function useRuntimeProjects(_sandboxUrl?: string) {
  return useSdkRuntimeProjects();
}

export function useRuntimeToolIds(_sandboxUrl?: string) {
  return useSdkRuntimeToolIds();
}

export function useRuntimeMcpStatus(_sandboxUrl?: string) {
  return useSdkRuntimeMcpStatus();
}

export function useRuntimeModels(sandboxUrl?: string) {
  const { data: providers, ...rest } = useRuntimeProviders(sandboxUrl);
  const allModels = providers ? flattenModels(providers) : [];
  return {
    data: filterToLatestModels(allModels),
    allModels,
    defaults: providers?.default || {},
    providers,
    ...rest,
  };
}

export function useUpdateRuntimeConfig(_sandboxUrl?: string) {
  return useSdkUpdateRuntimeConfig();
}

export interface AddMcpServerParams {
  name: string;
  type: 'local' | 'remote';
  command?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

function declarativeMcpError(): never {
  throw new Error('MCP servers are declarative. Update the project connector/runtime configuration in Customize.');
}

export function useAddMcpServer(_sandboxUrl?: string) {
  return useMutation({ mutationFn: async (_params: AddMcpServerParams) => declarativeMcpError() });
}

export function useConnectMcpServer(_sandboxUrl?: string) {
  return useMutation({ mutationFn: async (_name: string) => declarativeMcpError() });
}

export function useDisconnectMcpServer(_sandboxUrl?: string) {
  return useMutation({ mutationFn: async (_name: string) => declarativeMcpError() });
}

export function useMcpAuthStart(_sandboxUrl?: string) {
  return useMutation<{ authorizationUrl: string }, Error, string>({
    mutationFn: async (_name: string) => declarativeMcpError(),
  });
}

export function useMcpAuthCallback(_sandboxUrl?: string) {
  return useMutation<McpStatus, Error, { name: string; code: string }>({
    mutationFn: async (_params) => declarativeMcpError(),
  });
}
