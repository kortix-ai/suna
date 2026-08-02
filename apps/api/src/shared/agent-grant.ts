import type { AgentGrant } from '@kortix/db';

/** Normalize grants loaded from JSON rows created before knowledge grants existed. */
export function normalizeAgentGrant(grant: AgentGrant | null | undefined): AgentGrant | null {
  if (!grant) return null;
  return { ...grant, knowledge: grant.knowledge ?? [] };
}
