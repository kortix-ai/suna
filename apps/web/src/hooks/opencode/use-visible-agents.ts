'use client';

import { useMemo } from 'react';
import type { Agent } from '@opencode-ai/sdk/v2/client';
import { useOpenCodeAgents } from './use-opencode-sessions';
import { featureFlags } from '@/lib/feature-flags';

/**
 * Project-only agents — surfaced only when the multi-project paradigm is on.
 * These agents' bodies still contain project/ticket workflow knowledge; the
 * runtime gates the project tools they reference (project_*, ticket_*, etc.)
 * separately via KORTIX_PROJECTS_ENABLED on the sandbox. Hiding them in the
 * UI matches what the sandbox would refuse to do anyway, and keeps the
 * picker simple in default mode (general agent only).
 */
const PROJECT_ONLY_AGENTS = new Set(['orchestrator', 'project-maintainer', 'worker']);

function hideProjectOnly(a: Agent): boolean {
  if (featureFlags.enableMultiProject) return false;
  return PROJECT_ONLY_AGENTS.has(a.name);
}

/**
 * Returns only visible agents (non-hidden, non-subagent).
 * Use this for agent selectors in UI where users pick which agent to use.
 *
 * Pass `directory` to scope to a project — opencode then includes
 * `<directory>/.opencode/agent/*.md` (e.g. project-manager, engineer,
 * qa) on top of the global set.
 */
export function useVisibleAgents(options?: { directory?: string }): Agent[] {
  const { data: agents = [] } = useOpenCodeAgents(options);
  return useMemo(
    () => agents.filter((a) => !a.hidden && a.mode !== 'subagent' && !hideProjectOnly(a)),
    [agents]
  );
}

/**
 * Returns all visible agents including subagents.
 * Use this when you need to show subagents too (e.g., advanced mode).
 */
export function useAllVisibleAgents(options?: { directory?: string }): Agent[] {
  const { data: agents = [] } = useOpenCodeAgents(options);
  return useMemo(
    () => agents.filter((a) => !a.hidden && !hideProjectOnly(a)),
    [agents]
  );
}
