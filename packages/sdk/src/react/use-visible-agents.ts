'use client';

import { useMemo } from 'react';
import type { Agent } from '@opencode-ai/sdk/v2/client';
import { useRuntimeAgents } from './use-opencode-sessions';
import { isSelectableAgent } from '../core/rest/projects-client/project-agents';

/**
 * The agents a user can pick, filtered by `isSelectableAgent`.
 *
 * Pass `projectId`. It reads the Kortix project config, which lists only the
 * project's own agents and works before any sandbox exists. Without it the
 * hook reads the sandbox runtime's agent list, which also contains the
 * runtime's built-in agents (`build`, `plan`, …) that are not project agents.
 */
export function useVisibleAgents(options?: {
  directory?: string;
  projectId?: string | null;
}): Agent[] {
  const { data: agents = [] } = useRuntimeAgents(options);
  return useMemo(
    () => agents.filter(isSelectableAgent),
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
  const { data: agents = [] } = useRuntimeAgents(options);
  return useMemo(
    // The same rule with the subagent check lifted.
    () => agents.filter((a) => isSelectableAgent({ ...a, mode: null })),
    [agents]
  );
}
