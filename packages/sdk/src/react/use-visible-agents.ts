'use client';

import { useMemo } from 'react';
import type { Agent } from '@opencode-ai/sdk/v2/client';
import { useOpenCodeAgents } from './use-opencode-sessions';
import { composerSelectableAgents } from '../core/agents/composer-agents';
import { featureFlags } from '../core/http/feature-flags';

/**
 * Returns only visible agents (non-hidden, non-subagent).
 * Use this for agent selectors in UI where users pick which agent to use.
 *
 * Pass `projectId` for a SERVER-SIDE fetch (the project config is source of
 * truth, works before any sandbox runtime exists) — preferred for selectors.
 * Pass `directory` to scope the sandbox-runtime fetch to a project instead.
 */
export function useVisibleAgents(options?: {
  directory?: string;
  projectId?: string | null;
}): Agent[] {
  const { data: agents = [] } = useOpenCodeAgents(options);
  return useMemo(
    () => composerSelectableAgents(agents, { enableProjects: featureFlags.enableProjects }),
    [agents]
  );
}

/**
 * Returns all visible agents including subagents.
 * Use this when you need to show subagents too (e.g., advanced mode).
 */
export function useAllVisibleAgents(options?: {
  directory?: string;
  projectId?: string | null;
}): Agent[] {
  const { data: agents = [] } = useOpenCodeAgents(options);
  return useMemo(
    () =>
      composerSelectableAgents(agents, {
        enableProjects: featureFlags.enableProjects,
        includeSubagents: true,
      }),
    [agents]
  );
}
