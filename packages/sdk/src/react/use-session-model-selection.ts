'use client';

import { useKortixRouteProjectId } from './route-project';
import { useModelDefaults, type UseModelDefaults } from './use-model-defaults';
import {
  useRuntimeLocal,
  type RuntimeLocal,
  type UseRuntimeLocalOptions,
} from './use-opencode-local';

export interface SessionModelSelection extends RuntimeLocal {
  model: RuntimeLocal['model'] & {
    defaults: UseModelDefaults;
  };
}

/**
 * Project-aware model and agent selection.
 *
 * The SDK owns the server default and free-tier resolution. Hosts supply only
 * the runtime capabilities and optional explicit overrides.
 */
export function useSessionModelSelection(options: UseRuntimeLocalOptions): SessionModelSelection {
  const projectId = useKortixRouteProjectId();
  const defaults = useModelDefaults(projectId);
  const base = useRuntimeLocal({
    ...options,
    agentDefaults: options.agentDefaults ?? true,
    freeTier: options.freeTier ?? defaults.freeTier,
    resolveServerDefault: options.resolveServerDefault ?? defaults.resolveDefaultFor,
  });

  return {
    ...base,
    model: {
      ...base.model,
      defaults,
    },
  };
}
