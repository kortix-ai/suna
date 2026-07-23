export type AgentModelSelection = { providerID: string; modelID: string };

export function withoutAgentModel(
  models: Record<string, AgentModelSelection>,
  agentName: string,
): Record<string, AgentModelSelection> {
  const next = { ...models };
  delete next[agentName];
  return next;
}
