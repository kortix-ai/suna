import type { WorkspaceConfigSummary } from '@kortix/sdk';

export type AgentMode = 'primary' | 'subagent';
type Agent = WorkspaceConfigSummary['agents'][number];

/**
 * Whether an agent belongs in a mode filter.
 *
 * `mode` carries THREE values (`agent-editor-catalog.ts`: primary / subagent /
 * all) against two filter buckets, and the third is not a third bucket —
 * `'all'` means the agent is usable BOTH ways, so it has to match either
 * filter. Giving it a tab of its own would hide it from the two people looking
 * for it.
 *
 * An undeclared mode reads as `primary`: that is what the runtime assumes when
 * the frontmatter omits it, so filtering has to assume the same or the default
 * agent itself disappears under "Primary".
 */
export function agentInMode(agent: Agent, mode: AgentMode): boolean {
  const declared = (agent.mode ?? 'primary').toLowerCase();
  return declared === 'all' || declared === mode;
}

/**
 * The agent list a page shows: mode filter first, then the search box. Same
 * contract as `filterSkills` — `mode: null` means "All", and an empty query
 * matches everything rather than nothing.
 */
export function filterAgents(
  agents: readonly Agent[],
  opts: { mode: AgentMode | null; query: string },
): Agent[] {
  const q = opts.query.trim().toLowerCase();
  return agents.filter((agent) => {
    if (opts.mode && !agentInMode(agent, opts.mode)) return false;
    if (!q) return true;
    return (
      agent.name.toLowerCase().includes(q) || (agent.description ?? '').toLowerCase().includes(q)
    );
  });
}
