export type SessionRuntimeTransport = 'acp' | 'rest';
type SessionRuntimeHarness = 'claude' | 'codex' | 'opencode' | 'pi';

export function resolveSessionRuntimeTransport(
  value: SessionRuntimeTransport | undefined,
  override?: SessionRuntimeTransport,
): SessionRuntimeTransport {
  if (override) return override;
  return value === 'acp' ? 'acp' : 'rest';
}

export interface SessionRuntimePolicy {
  transport: SessionRuntimeTransport;
  useAcp: boolean;
  streamOpenCodeEvents: boolean;
  listOpenCodeSessions: boolean;
  syncOpenCodeMessages: boolean;
  sendWith: 'acp' | 'opencode-rest';
}

export function createSessionRuntimePolicy(
  value: SessionRuntimeTransport | undefined,
  override?: SessionRuntimeTransport,
): SessionRuntimePolicy {
  const transport = resolveSessionRuntimeTransport(value, override);
  const useAcp = transport === 'acp';
  return {
    transport,
    useAcp,
    streamOpenCodeEvents: !useAcp,
    listOpenCodeSessions: !useAcp,
    syncOpenCodeMessages: !useAcp,
    sendWith: useAcp ? 'acp' : 'opencode-rest',
  };
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

/** Build the authenticated, session-scoped ACP bridge endpoint.
 *  Hosts receive the completed URL through `useSession`; they never construct
 *  or import this runtime path. */
export function buildAcpBridgeEndpoint(
  runtimeUrl: string,
  acpServerId: string,
  runtimeHarness?: SessionRuntimeHarness,
): string {
  const endpoint = `${trimTrailingSlashes(runtimeUrl)}/kortix/acp/${encodeURIComponent(acpServerId)}`;
  return runtimeHarness ? `${endpoint}?agent=${encodeURIComponent(runtimeHarness)}` : endpoint;
}

/** Build the authenticated platform bridge that persists one project session. */
export function buildProjectAcpEndpoint(
  backendUrl: string,
  projectId: string,
  sessionId: string,
): string {
  return (
    `${trimTrailingSlashes(backendUrl)}/projects/${encodeURIComponent(projectId)}` +
    `/sessions/${encodeURIComponent(sessionId)}/acp`
  );
}
