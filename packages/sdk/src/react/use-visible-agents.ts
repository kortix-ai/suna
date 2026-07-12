'use client';

import { useMemo } from 'react';
import type { Agent } from '../runtime/wire-types';
import { useOpenCodeAgents } from './use-opencode-sessions';
import { featureFlags } from '../core/http/feature-flags';

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
    () => agents.filter((a) => !a.hidden && a.mode !== 'subagent' && !hideProjectOnly(a)),
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
    () => agents.filter((a) => !a.hidden && !hideProjectOnly(a)),
    [agents]
  );
}
