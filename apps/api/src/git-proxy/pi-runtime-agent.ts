export class PiRuntimeAgentScopeError extends Error {}

export async function resolvePiRuntimeAgent(
  callerSessionId: string | null,
  requestedAgent: string | undefined,
  loadSessionAgent: (sessionId: string) => Promise<string>,
): Promise<string> {
  if (!callerSessionId) return requestedAgent ?? '';
  const selected = await loadSessionAgent(callerSessionId);
  if (!selected || (requestedAgent !== undefined && requestedAgent !== selected))
    throw new PiRuntimeAgentScopeError('The runtime must use the calling session agent');
  return selected;
}
