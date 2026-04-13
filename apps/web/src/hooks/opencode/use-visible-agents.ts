'use client';

import { useMemo } from 'react';
import type { Agent } from '@opencode-ai/sdk/v2/client';
import { useOpenCodeAgents } from './use-opencode-sessions';

/**
 * Returns only visible agents (non-hidden, non-subagent).
 * Use this for agent selectors in UI where users pick which agent to use.
 */
export function useVisibleAgents(): Agent[] {
  const { data: agents = [] } = useOpenCodeAgents();
  return useMemo(
    () => agents.filter((a) => !a.hidden && a.mode !== 'subagent'),
    [agents]
  );
}

/**
 * Returns all visible agents including subagents.
 * Use this when you need to show subagents too (e.g., advanced mode).
 */
export function useAllVisibleAgents(): Agent[] {
  const { data: agents = [] } = useOpenCodeAgents();
  return useMemo(
    () => agents.filter((a) => !a.hidden),
    [agents]
  );
}
