'use client';

import {
  useOpenCodeLocal,
  type OpenCodeLocal,
  type UseOpenCodeLocalOptions,
} from './use-opencode-local';
import {
  useModelDefaults,
  type UseModelDefaults,
} from './use-model-defaults';
import { useKortixRouteProjectId } from './route-project';
import { useSessionModelChange } from './use-session-model-change';
import { useProjectSession } from './use-project-session';
import { formatModelString, type ModelKey } from './use-opencode-local';
import type { SessionModelChangeResult } from '../core/rest/projects-client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCurrentRuntime } from './use-current-runtime';
import { configKeys } from './use-opencode-config';

export interface SessionModelSelection extends OpenCodeLocal {
  model: OpenCodeLocal['model'] & {
    defaults: UseModelDefaults;
    change: (model: ModelKey) => Promise<SessionModelChangeResult>;
    isChanging: boolean;
  };
}

/**
 * Project-aware model and agent selection.
 *
 * The SDK owns the server default and free-tier resolution. Hosts supply only
 * the runtime capabilities and optional explicit overrides.
 */
export function useSessionModelSelection(
  options: UseOpenCodeLocalOptions & { projectSessionId?: string },
): SessionModelSelection {
  const projectId = useKortixRouteProjectId();
  const defaults = useModelDefaults(projectId);
  const change = useSessionModelChange(projectId ?? undefined, options.projectSessionId);
  const session = useProjectSession(projectId ?? undefined, options.projectSessionId);
  const saved = session.data?.metadata?.opencode_model;
  const queryClient = useQueryClient();
  const runtimeUrl = useCurrentRuntime(state => state.url);
  useEffect(() => {
    if (options.runtime === 'pi-worker' && runtimeUrl && typeof saved === 'string' && options.config?.model !== saved) {
      void queryClient.invalidateQueries({ queryKey: [...configKeys.all, runtimeUrl] });
    }
  }, [options.runtime, options.config?.model, runtimeUrl, saved, queryClient]);
  const base = useOpenCodeLocal({
    ...options,
    config: options.runtime === 'pi-worker' && typeof saved === 'string'
      ? { ...options.config, model: saved } : options.config,
    freeTier: options.freeTier ?? defaults.freeTier,
    resolveServerDefault:
      options.resolveServerDefault ?? defaults.resolveDefaultFor,
  });

  return {
    ...base,
    model: {
      ...base.model,
      defaults,
      change: (model) => change.mutateAsync(formatModelString(model)),
      isChanging: change.isPending,
    },
  };
}
