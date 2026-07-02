/**
 * Pure transforms behind the Schedules/Webhooks Agent + Model pickers — split
 * out of hooks.ts so they're testable without pulling in React Native/Expo
 * (importing hooks.ts directly drags in the whole client + RN runtime).
 */

import type { ProjectAgentEntry, ProjectLlmCatalogResponse } from './projects-client';

export interface TriggerAgentOption {
  name: string;
  description: string | null;
}

/** Non-subagent roles a trigger can run as. */
export function filterTriggerAgents(agents: ProjectAgentEntry[] | undefined): TriggerAgentOption[] {
  return (agents ?? [])
    .filter((a) => a.mode !== 'subagent')
    .map((a) => ({ name: a.name, description: a.description }));
}

export interface TriggerModelOption {
  modelID: string;
  modelName: string;
}

/** Flatten + sort the gateway catalog into picker options. */
export function flattenTriggerModelCatalog(
  models: ProjectLlmCatalogResponse['models'] | undefined,
): TriggerModelOption[] {
  return Object.entries(models ?? {})
    .map(([modelID, model]) => ({ modelID, modelName: model.name || modelID }))
    .sort((a, b) => a.modelName.localeCompare(b.modelName));
}
