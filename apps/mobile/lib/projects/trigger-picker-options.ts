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

/**
 * Flatten + sort the project's model picker into options. A model the project
 * has switched off (`enabled: false`) is dropped: a trigger must not be pinned
 * to a model the project does not serve.
 */
export function flattenTriggerModelCatalog(
  models: ProjectLlmCatalogResponse['models'] | undefined,
): TriggerModelOption[] {
  return Object.entries(models ?? {})
    .filter(([, model]) => model.enabled !== false)
    .map(([modelID, model]) => ({ modelID, modelName: model.name || modelID }))
    .sort((a, b) => a.modelName.localeCompare(b.modelName));
}
