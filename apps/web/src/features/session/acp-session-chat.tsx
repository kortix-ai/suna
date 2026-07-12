'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Textarea } from '@/components/ui/textarea';
import { clearStartStash, readStartStash } from '@kortix/sdk/react';
import {
  createAcpClient,
  platformConfig,
  type AcpContentBlock,
  type AcpEnvelope,
  type AcpJsonRpcId,
} from '@kortix/sdk';
import { Bot, Brain, ShieldCheck, Square, Terminal, User } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type StoredEnvelope = {
  ordinal: number;
  direction: 'client_to_agent' | 'agent_to_client';
  streamEventId: number | null;
  envelope: AcpEnvelope;
  createdAt?: string;
};

type ViewItem =
  | { kind: 'message'; role: 'user' | 'assistant' | 'thought'; text: string }
  | { kind: 'tool'; title: string; data: unknown }
  | { kind: 'permission'; id: AcpJsonRpcId; method: string; params: Record<string, unknown> }
  | { kind: 'raw'; method: string; data: unknown };

function textBlocks(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .filter((block): block is Extract<AcpContentBlock, { type: 'text' }> =>
      !!block && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string')
    .map((block) => block.text)
    .join('\n');
}

export function projectAcpEnvelopes(envelopes: StoredEnvelope[]): ViewItem[] {
  const items: ViewItem[] = [];
  for (const row of envelopes) {
    const envelope = row.envelope as any;
    if (row.direction === 'client_to_agent' && envelope.method === 'session/prompt') {
      const text = textBlocks(envelope.params?.prompt);
      if (text) items.push({ kind: 'message', role: 'user', text });
      continue;
    }
    if (row.direction !== 'agent_to_client' || typeof envelope.method !== 'string') continue;
    if (envelope.method === 'session/update') {
      const update = envelope.params?.update ?? {};
      const updateKind = update.sessionUpdate ?? update.type;
      const text = update.content?.type === 'text' ? update.content.text : '';
      if ((updateKind === 'agent_message_chunk' || updateKind === 'agent_thought_chunk') && text) {
        const role = updateKind === 'agent_thought_chunk' ? 'thought' : 'assistant';
        const previous = items.at(-1);
        if (previous?.kind === 'message' && previous.role === role) previous.text += text;
        else items.push({ kind: 'message', role, text });
      } else if (updateKind === 'tool_call' || updateKind === 'tool_call_update' || updateKind === 'plan') {
        items.push({ kind: 'tool', title: String(update.title ?? updateKind), data: update });
      } else {
        items.push({ kind: 'raw', method: String(updateKind ?? envelope.method), data: update });
      }
      continue;
    }
    if ('id' in envelope && (envelope.method.includes('permission') || envelope.method.includes('request'))) {
      items.push({ kind: 'permission', id: envelope.id, method: envelope.method, params: envelope.params ?? {} });
      continue;
    }
    if ('method' in envelope) items.push({ kind: 'raw', method: envelope.method, data: envelope.params });
  }
  return items;
}

export function AcpSessionChat({
  projectId,
  sessionId,
  runtimeSessionId,
  onReady,
}: {
  projectId: string;
  sessionId: string;
  runtimeSessionId?: string | null;
  onReady?: () => void;
}) {
  const client = useMemo(() => createAcpClient({
    endpoint: `${platformConfig().backendUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/acp`,
  }), [projectId, sessionId]);
  const [envelopes, setEnvelopes] = useState<StoredEnvelope[]>([]);
  const [acpSessionId, setAcpSessionId] = useState(runtimeSessionId ?? null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef(false);
  const items = useMemo(() => projectAcpEnvelopes(envelopes), [envelopes]);

  const addEnvelope = useCallback((next: StoredEnvelope) => {
    setEnvelopes((current) => {
      if (next.streamEventId !== null && current.some((row) => row.streamEventId === next.streamEventId && row.direction === next.direction)) return current;
      return [...current, next].sort((a, b) => a.ordinal - b.ordinal);
    });
  }, []);

  useEffect(() => {
    let active = true;
    const stream = client.connect({
      onEvent(event) {
        addEnvelope({
          ordinal: Date.now() * 1000 + event.id,
          direction: 'agent_to_client',
          streamEventId: event.id,
          envelope: event.envelope,
        });
      },
      onError(reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      },
    });
    void (async () => {
      try {
        const history = await client.transcript();
        if (active) setEnvelopes((current) => {
          const replayIds = new Set(history.envelopes.map((row) => `${row.direction}:${row.streamEventId}`));
          return [...history.envelopes, ...current.filter((row) => row.streamEventId === null || !replayIds.has(`${row.direction}:${row.streamEventId}`))]
            .sort((a, b) => a.ordinal - b.ordinal);
        });
        await client.initialize({
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'kortix-web', title: 'Kortix Web', version: '3' },
        });
        let nativeId = runtimeSessionId;
        if (nativeId) await client.loadSession({ sessionId: nativeId, cwd: '/workspace', mcpServers: [] });
        else nativeId = (await client.newSession({ cwd: '/workspace', mcpServers: [] })).sessionId;
        if (!active) return;
        setAcpSessionId(nativeId);
        initialized.current = true;
        onReady?.();
        const stash = readStartStash(sessionId);
        if (stash?.prompt) {
          clearStartStash(sessionId);
          setBusy(true);
          await client.prompt(nativeId, [{ type: 'text', text: stash.prompt }]);
          setBusy(false);
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => {
      active = false;
      stream.close();
    };
  }, [addEnvelope, client, onReady, runtimeSessionId, sessionId]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !acpSessionId || busy) return;
    setDraft('');
    setError(null);
    setBusy(true);
    addEnvelope({
      ordinal: Date.now() * 1000,
      direction: 'client_to_agent',
      streamEventId: null,
      envelope: { jsonrpc: '2.0', id: `local-${Date.now()}`, method: 'session/prompt', params: { sessionId: acpSessionId, prompt: [{ type: 'text', text }] } },
    });
    try {
      await client.prompt(acpSessionId, [{ type: 'text', text }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const respondPermission = async (id: AcpJsonRpcId, optionId?: string) => {
    await client.respond(id, {
      outcome: optionId
        ? { outcome: 'selected', optionId }
        : { outcome: 'cancelled' },
    });
  };

  return (
    <div className="bg-background flex h-full min-h-0 flex-col" data-testid="acp-session-chat">
      <header className="border-border flex items-center gap-2 border-b px-4 py-3">
        <Bot className="size-4" />
        <span className="text-sm font-medium">Agent session</span>
        <Badge variant="kortix" size="xs">ACP</Badge>
        {acpSessionId ? <span className="text-muted-foreground ml-auto truncate font-mono text-xs">{acpSessionId}</span> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          {items.length === 0 ? (
            <div className="text-muted-foreground py-16 text-center text-sm">Start a conversation with the selected native harness.</div>
          ) : items.map((item, index) => {
            if (item.kind === 'message') {
              const Icon = item.role === 'user' ? User : item.role === 'thought' ? Brain : Bot;
              return (
                <div key={index} className="bg-popover rounded-md border px-4 py-3">
                  <div className="mb-2 flex items-center gap-2 text-xs font-medium capitalize"><Icon className="size-3.5" />{item.role}</div>
                  <div className="text-sm whitespace-pre-wrap text-pretty">{item.text}</div>
                </div>
              );
            }
            if (item.kind === 'permission') {
              const options = Array.isArray(item.params.options) ? item.params.options as Array<any> : [];
              return (
                <div key={index} className="bg-popover rounded-md border px-4 py-3">
                  <div className="mb-3 flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4" />Permission requested</div>
                  <pre className="text-muted-foreground mb-3 overflow-x-auto text-xs">{JSON.stringify(item.params, null, 2)}</pre>
                  <div className="flex flex-wrap gap-2">
                    {options.map((option) => <Button key={String(option.optionId ?? option.id)} size="sm" onClick={() => respondPermission(item.id, String(option.optionId ?? option.id))}>{String(option.name ?? option.title ?? option.optionId ?? option.id)}</Button>)}
                    <Button size="sm" variant="outline" onClick={() => respondPermission(item.id)}>Reject</Button>
                  </div>
                </div>
              );
            }
            return (
              <details key={index} className="bg-popover rounded-md border px-4 py-3">
                <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><Terminal className="size-4" />{item.kind === 'tool' ? item.title : item.method}</summary>
                <pre className="text-muted-foreground mt-3 overflow-x-auto text-xs">{JSON.stringify(item.data, null, 2)}</pre>
              </details>
            );
          })}
          {busy ? <div className="text-muted-foreground flex items-center gap-2 text-sm"><Loading className="size-4" />Agent is working</div> : null}
          {error ? <div className="text-kortix-red text-sm">{error}</div> : null}
        </div>
      </div>
      <div className="border-border border-t px-4 py-3">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Message the agent" className="min-h-12" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} />
          {busy ? <Button size="icon" variant="outline" onClick={() => acpSessionId && client.cancel(acpSessionId)} aria-label="Stop"><Square className="size-4" /></Button> : <Button onClick={() => void send()} disabled={!draft.trim() || !acpSessionId}>Send</Button>}
        </div>
      </div>
    </div>
  );
}
