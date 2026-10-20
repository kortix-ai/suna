import { extractAgents } from '../agents';
import type { ParsedManifest } from '../triggers';

export function agentConfigCreateConflict(
  manifest: ParsedManifest,
  agentName: string,
  ifNoneMatch: string | undefined,
): boolean {
  if (ifNoneMatch !== '*') return false;
  const agents = extractAgents(manifest);
  return agents.specs.some((agent) => agent.name === agentName) ||
    agents.errors.some((agent) => agent.name === agentName);
}
