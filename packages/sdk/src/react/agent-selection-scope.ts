interface AgentSelectionScopeInput {
  sessionId?: string;
  boundAgentName?: string | null;
  workspaceId?: string | null;
}

export function createAgentSelectionScope({
  sessionId,
  boundAgentName,
  workspaceId,
}: AgentSelectionScopeInput): string {
  return `${sessionId ?? ''}\u0000${boundAgentName ?? ''}\u0000${workspaceId ?? ''}`;
}
