"use client";

import { useQuery } from "@tanstack/react-query";
import type { Agent } from "../../core/runtime/wire-types";
import { runtimeKeys } from "./keys";
import { useCurrentRuntime } from '../use-current-runtime';
import {
  getLSCache,
  setLSCache,
  LS_AGENTS,
  CACHE_SCOPE_GLOBAL,
} from "./shared";
import {
  getProjectDetail,
  type ProjectConfigSummary,
} from "../../core/rest/projects-client";

// Re-export filtered agents hook for UI agent selectors
export { useVisibleAgents } from "../use-visible-agents";

// ============================================================================
// Agent Hooks
// ============================================================================

/**
 * Load agents. With `projectId`, the server-side project config is source of
 * truth: it returns declarative `kortix.yaml` `agents:` entries for adopted
 * projects. When omitted, `projectId` is taken from the active Kortix session.
 * Agent discovery never calls a harness-specific daemon API.
 */
export function useRuntimeAgents(options?: {
  directory?: string;
  projectId?: string | null;
}) {
  const directory = options?.directory;
  const activeProjectId = useCurrentRuntime((state) => state.projectId);
  const projectId = options?.projectId ?? activeProjectId;
  const cacheScope = projectId
    ? `project:${projectId}`
    : directory
      ? `dir:${directory}`
      : CACHE_SCOPE_GLOBAL;
  return useQuery<Agent[]>({
    queryKey: projectId
      ? ["project-detail", projectId, "agents"]
      : directory
        ? [...runtimeKeys.agents(), "dir", directory]
        : runtimeKeys.agents(),
    queryFn: async () => {
      if (!projectId) return [];
      const detail = await getProjectDetail(projectId);
      const agents = projectConfigAgentsToRuntimeAgents(detail.config);
      setLSCache(LS_AGENTS, agents, cacheScope);
      return agents;
    },
    placeholderData: () => getLSCache<Agent[]>(LS_AGENTS, cacheScope),
    enabled: Boolean(projectId),
    staleTime: 30_000,
    gcTime: 10 * 60 * 1000,
  });
}

/**
 * Put the declared project default first so every consumer's ordinary
 * "first visible agent" fallback agrees with the project contract. Explicit
 * per-session/user picks still resolve by name and therefore keep precedence.
 */
export function projectConfigAgentsToRuntimeAgents(
  config: ProjectConfigSummary,
): Agent[] {
  const agents = config.agents.map(projectConfigAgentToRuntimeAgent);
  const defaultName = config.runtime_default_agent;
  if (!defaultName) return agents;
  return agents.sort((left, right) => {
    if (left.name === defaultName) return -1;
    if (right.name === defaultName) return 1;
    return 0;
  });
}

function projectConfigAgentToRuntimeAgent(
  agent: ProjectConfigSummary["agents"][number],
): Agent {
  return {
    name: agent.name,
    description: agent.description ?? undefined,
    mode: agent.mode ?? undefined,
    source: agent.source,
    hidden: agent.enabled === false,
    runtime: agent.runtime ?? undefined,
    harness: agent.harness ?? undefined,
  } as unknown as Agent;
}

export function useRuntimeAgent(agentName: string) {
  const projectId = useCurrentRuntime((state) => state.projectId);
  return useQuery<Agent | undefined>({
    queryKey: [...runtimeKeys.agents(), projectId, agentName],
    queryFn: async () => {
      if (!projectId) return undefined;
      const detail = await getProjectDetail(projectId);
      return projectConfigAgentsToRuntimeAgents(detail.config).find((agent) => agent.name === agentName);
    },
    enabled: Boolean(projectId && agentName),
    staleTime: 30_000,
  });
}
