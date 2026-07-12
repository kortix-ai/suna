import { useCallback, useEffect, useMemo, useState } from 'react';
import { createAcpClient, type AcpContentBlock, type AcpEnvelope, type AcpInitializeResult, type AcpJsonRpcId, type AcpSessionConfigOption } from '../acp';
import { projectAcpEndpoint } from '../acp/project-session';
import { clearStartStash, readStartStash } from './session-start-stash';

export type AcpStoredSessionEnvelope = {
  ordinal: number;
  direction: 'client_to_agent' | 'agent_to_client';
  streamEventId: number | null;
  envelope: AcpEnvelope;
  createdAt?: string;
};

export function useAcpSession({ projectId, sessionId, runtimeSessionId, enabled = true, replayStartStash = true }: {
  projectId: string;
  sessionId: string;
  runtimeSessionId?: string | null;
  enabled?: boolean;
  replayStartStash?: boolean;
}) {
  const client = useMemo(() => createAcpClient({
    endpoint: projectAcpEndpoint(projectId, sessionId),
  }), [projectId, sessionId]);
  const [envelopes, setEnvelopes] = useState<AcpStoredSessionEnvelope[]>([]);
  const [nativeId, setNativeId] = useState(runtimeSessionId ?? null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initializeResult, setInitializeResult] = useState<AcpInitializeResult | null>(null);
  const [configOptions, setConfigOptions] = useState<AcpSessionConfigOption[]>([]);
  const addEnvelope = useCallback((next: AcpStoredSessionEnvelope) => setEnvelopes((current) => {
    if (next.streamEventId !== null && current.some((row) => row.streamEventId === next.streamEventId && row.direction === next.direction)) return current;
    return [...current, next].sort((a, b) => a.ordinal - b.ordinal);
  }), []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const stream = client.connect({
      onEvent: (event) => addEnvelope({ ordinal: Date.now() * 1000 + event.id, direction: 'agent_to_client', streamEventId: event.id, envelope: event.envelope }),
      onError: (reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); },
    });
    void (async () => {
      try {
        const history = await client.transcript();
        if (active) setEnvelopes((current) => {
          const replayIds = new Set(history.envelopes.map((row) => `${row.direction}:${row.streamEventId}`));
          return [...history.envelopes, ...current.filter((row) => row.streamEventId === null || !replayIds.has(`${row.direction}:${row.streamEventId}`))].sort((a, b) => a.ordinal - b.ordinal);
        });
        const initialized = await client.initialize({
          protocolVersion: 1,
          clientCapabilities: { auth: { _meta: { gateway: true } } },
          clientInfo: { name: '@kortix/sdk', title: 'Kortix SDK', version: '0.2.0' },
        });
        if (active) setInitializeResult(initialized);
        let id = runtimeSessionId;
        if (id) {
          const loaded = await client.loadSession({ sessionId: id, cwd: '/workspace', mcpServers: [] });
          if (active) setConfigOptions(loaded.configOptions ?? []);
        } else {
          const created = await client.newSession({ cwd: '/workspace', mcpServers: [] });
          if (!created.sessionId) throw new Error('ACP session/new returned no sessionId');
          id = created.sessionId;
          if (active) setConfigOptions(created.configOptions ?? []);
        }
        if (!active) return;
        setNativeId(id);
        setReady(true);
        const stash = replayStartStash === false ? null : readStartStash(sessionId);
        if (stash?.prompt) {
          clearStartStash(sessionId);
          setBusy(true);
          try {
            await client.prompt(id, [{ type: 'text', text: stash.prompt }]);
          } finally {
            if (active) setBusy(false);
          }
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => { active = false; stream.close(); };
  }, [addEnvelope, client, enabled, replayStartStash, runtimeSessionId, sessionId]);

  const send = useCallback(async (prompt: AcpContentBlock[]) => {
    if (!nativeId || busy) return false;
    setError(null);
    setBusy(true);
    addEnvelope({ ordinal: Date.now() * 1000, direction: 'client_to_agent', streamEventId: null, envelope: { jsonrpc: '2.0', id: `local-${Date.now()}`, method: 'session/prompt', params: { sessionId: nativeId, prompt } } });
    try { await client.prompt(nativeId, prompt); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false; }
    finally { setBusy(false); }
  }, [addEnvelope, busy, client, nativeId]);

  const respondPermission = useCallback((id: AcpJsonRpcId, optionId?: string) => client.respond(id, { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } }), [client]);
  const respondQuestion = useCallback((id: AcpJsonRpcId, content: Record<string, unknown>) => client.respond(id, { action: 'accept', content }), [client]);
  const rejectQuestion = useCallback((id: AcpJsonRpcId) => client.respond(id, { action: 'decline' }), [client]);
  const cancel = useCallback(() => nativeId ? client.cancel(nativeId) : Promise.resolve(), [client, nativeId]);
  return {
    ready, busy, error, envelopes, runtimeSessionId: nativeId,
    capabilities: initializeResult?.agentCapabilities ?? {},
    agentInfo: initializeResult?.agentInfo ?? null,
    authMethods: initializeResult?.authMethods ?? [],
    configOptions,
    send, cancel, respondPermission, respondQuestion, rejectQuestion,
  };
}
