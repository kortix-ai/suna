interface AgentSelectionScopeInput {
  sessionId?: string;
  boundAgentName?: string | null;
  projectId?: string | null;
}

export function createAgentSelectionScope({
  sessionId,
  boundAgentName,
  projectId,
}: AgentSelectionScopeInput): string {
  return `${sessionId ?? ''}\u0000${boundAgentName ?? ''}\u0000${projectId ?? ''}`;
}
