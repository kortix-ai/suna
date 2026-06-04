/**
 * Agents Module
 * 
 * Agent management functionality
 */

export * from './api';
export * from './hooks';

export { agentKeys, useAgents, useAgent, useCreateAgent, useUpdateAgent, useDeleteAgent } from './hooks';

/**
 * Check if an agent is the default Kortix/SUNA agent
 * Uses metadata and name checks - no hardcoded IDs
 */
export const isKortixDefaultAgent = (agent?: { 
  agent_id?: string; 
  name?: string; 
  metadata?: { is_suna_default?: boolean } 
} | null): boolean => {
  if (!agent) return false;
  
  // Check metadata first (most reliable)
  if (agent.metadata?.is_suna_default) return true;
  
  // Fallback to name checks
  const name = agent.name?.toLowerCase();
  return name === 'kortix' ||
         name === 'suna' ||
         name === 'superworker' ||
         name === 'kortix super worker';
};

/**
 * Check if an agent ID represents the default Kortix agent
 * For cases where we only have an ID and need to check against a list of agents
 */
export const isKortixDefaultAgentId = (
  agentId: string | null | undefined, 
  agents: Array<{ agent_id?: string; name?: string; metadata?: { is_suna_default?: boolean } }>
): boolean => {
  if (!agentId) return true; // No agent ID = default Kortix
  const agent = agents.find(a => a.agent_id === agentId);
  return isKortixDefaultAgent(agent);
};

