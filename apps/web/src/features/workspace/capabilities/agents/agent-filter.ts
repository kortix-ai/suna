import type { ProjectConfigSummary } from '@kortix/sdk';

type Agent = ProjectConfigSummary['agents'][number];

/** Search the manifest's agents by name or description. */
export function filterAgents(agents: readonly Agent[], opts: { query: string }): Agent[] {
  const q = opts.query.trim().toLowerCase();
  return agents.filter(
    (agent) =>
      !q ||
      agent.name.toLowerCase().includes(q) ||
      (agent.description ?? '').toLowerCase().includes(q),
  );
}
