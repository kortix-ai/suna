'use client';

import { useMemo } from 'react';
import type { Agent } from '@opencode-ai/sdk/v2/client';
import { useOpenCodeAgents } from './use-opencode-sessions';
import { featureFlags } from '@/lib/feature-flags';

/**
 * Project-only agents — surfaced only when the project paradigm is on.
 *
 * Just `project-manager`. The other agents (orchestrator, worker,
 * project-maintainer) stay visible regardless of flag state — they're
 * useful general-purpose roles, even when their preferred tools (task_*)
 * aren't registered. The user reasons about the PM agent as the
 * project-paradigm gate.
 *
 * `project-manager` is the per-project PM slug seeded by seedV2Project at
 * /workspace/.opencode/agent/project-manager.md. The file persists on disk
 * after a flag-on cycle even when the flag flips back off, so this picker
 * filter is what keeps it out of the UI in default mode.
 */
const PROJECT_ONLY_AGENTS = new Set(['project-manager']);

function hideProjectOnly(a: Agent): boolean {
  if (featureFlags.enableProjects) return false;
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
